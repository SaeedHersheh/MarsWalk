"""Marswalk API: layers, orbiter passes, and route planning over real Mars terrain.

Sites:  "jezero" = the first detailed one (CTX 20 m, HiRISE slopes, heat model, CRISM minerals), data in data/.
        "gale"   = Curiosity's site, detailed from the USGS MSL HiRISE DEM (pipeline/build_gale.py), data in data/sites/gale/.
        anything else = a region built on demand from global MOLA 463 m (pipeline/build_site.py).
Every endpoint takes ?site=<id> (default jezero).

Run:  .venv/Scripts/python -m uvicorn app.main:app --port 8077
"""
import io, json, os, sys, threading, time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import numpy as np
import psycopg
from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
import requests
from scipy.ndimage import maximum_filter, uniform_filter
from skimage.graph import MCP_Geometric

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
import fetch_passes  # noqa: E402
import build_site    # noqa: E402
from . import comms    # noqa: E402

D = os.path.join(ROOT, "data")
MIN_EL = fetch_passes.MIN_EL
SUIT = 0.5          # ASSUMPTION: a suited walker moves at half Tobler speed
WALK_DRIFT = 0.02   # ASSUMPTION: dead-reckoning error = 2 % of distance since last fix
LOAD_PER_KG = 0.006  # ASSUMPTION: each kg carried (tools, samples, drill) slows a suited walker by 0.6 % (40 kg -> 24 % slower)
UHF_HZ = 437.1e6    # orbiter -> surface UHF relay link (Odyssey/MER value; MRO Electra tunes 435-450 MHz)
C_KMS = 299792.458
REFRESH_S = 6 * 3600


# ---- Radiation: anchored on real measurements, scaled by physics we can compute per cell ----
# Measured: Curiosity RAD at Gale crater, GCR dose equivalent 0.67 mSv/day (Hassler et al. 2014, Aug 2012 - Jun 2013),
#           under a ~22 g/cm2 atmosphere column (Gale average, +-25 %).
# Published sensitivity: absorbed dose changes 10-20 % for a column change of 15 -> 25 g/cm2
#           (Wang & Wimmer-Schweingruber 2022), i.e. an e-folding column of about 60 g/cm2 (range 47-95).
# Our assumptions (not measured): atmospheric scale height 11.1 km to turn MOLA elevation into column depth;
#           dose arriving from a direction falls with its slant path through the air (path = column / sin(elevation)).
RAD_BASE = 0.67        # mSv/day measured at Gale
COL_BASE = 22.0        # g/cm2 above Gale
Z_BASE = -4400.0       # m, Gale landing elevation (MOLA datum)
H_ATM = 11100.0        # m, ASSUMPTION
LAMBDA = 60.0          # g/cm2, from the published 10-20 % per 10 g/cm2
CAREER_MSV = 600.0     # NASA career limit used for context

# Slope cost: green is free, yellow gets expensive, orange/red are used only when there is no other way.
SLOPE_COST = [(0, 0), (3, 0), (5, .4), (8, 2), (12, 8), (16, 24), (20, 60), (25, 160), (45, 400)]


def slope_pen(s):
    return np.interp(s, [a for a, _ in SLOPE_COST], [b for _, b in SLOPE_COST]).astype("float32")


# ASSUMPTIONS for the crew rover (a pressurised rover in the class of NASA's Space Exploration Vehicle / Lunar Terrain Vehicle studies):
ROVER_V = 2.8        # cruise on flat ground, m/s (about 10 km/h)
ROVER_MAX = 20.0     # steepest slope it is planned over, degrees
ROVER_SLOW = 0.6     # at the slope limit it runs at 40 % of cruise


def rover_ms(s):
    """Rover speed, m/s, s = signed slope (rise/run): slower the steeper it is, up or down."""
    deg = np.degrees(np.arctan(np.abs(s)))
    return (ROVER_V * (1 - ROVER_SLOW * np.clip(deg / ROVER_MAX, 0, 1))).astype("float32")


def tobler_ms(s):
    """Tobler hiking function, m/s, s = signed slope (rise/run)."""
    return 6.0 * np.exp(-3.5 * np.abs(s + 0.05)) / 3.6 * SUIT


# ---------- colour ----------
def ramp(v, stops):
    v = np.clip(v, 0, 1)
    xs = [s[0] for s in stops]
    return np.stack([np.interp(v, xs, [s[1][i] for s in stops]) for i in range(4)], -1).astype("uint8")


def png(rgba):
    b = io.BytesIO(); Image.fromarray(rgba, "RGBA").save(b, "PNG", compress_level=3)
    return Response(b.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=300"})


ELEV_STOPS = [(0, (38, 24, 96, 255)), (.14, (36, 70, 170, 255)), (.3, (32, 150, 200, 255)), (.46, (70, 190, 120, 255)),
              (.6, (200, 220, 90, 255)), (.74, (240, 180, 60, 255)), (.87, (225, 110, 45, 255)), (1, (250, 244, 236, 255))]
HEAT_STOPS = [(0, (20, 14, 70, 215)), (.2, (40, 60, 170, 215)), (.4, (70, 150, 210, 210)), (.55, (150, 100, 190, 205)),
              (.7, (225, 80, 110, 210)), (.85, (250, 150, 60, 215)), (1, (255, 240, 150, 225))]


class Site:
    """Everything the planner knows about one map area."""

    def __init__(self, sid):
        self.id = sid
        self.dir = d = D if sid == "jezero" else os.path.join(D, "sites", sid)
        if not os.path.exists(os.path.join(d, "meta.json")):
            raise HTTPException(404, f"unknown site {sid}")
        self.meta = M = json.load(open(os.path.join(d, "meta.json")))
        self.W, self.H, self.DX, self.DY = M["W"], M["H"], M["DX"], M["DY"]
        H, W, DX, DY = self.H, self.W, self.DX, self.DY
        self.Z = Z = np.load(os.path.join(d, "elev.npy"))
        self.VALID = np.load(os.path.join(d, "valid.npy"))
        self.HOR = np.load(os.path.join(d, "horizon.npy"))          # (16, H, W) uint8, degrees*2
        self.N_AZ = self.HOR.shape[0]
        self.info = M.get("site") or fetch_passes.SITE              # name, lon_e, lat, elev_km

        # ---- derived terrain ----
        gr, gc = np.gradient(Z, DY, DX)
        GE, GN = gc, -gr                                            # dz/d(east), dz/d(north)
        self.SLOPE = np.degrees(np.arctan(np.hypot(GE, GN))).astype("float32")
        nn = np.sqrt(GE**2 + GN**2 + 1)
        self.NX, self.NY, self.NZ = -GE / nn, -GN / nn, 1 / nn      # surface normal (east, north, up)
        # Hazard slope: HiRISE 1 m (taken at 5 m) where it exists, the base DTM elsewhere.
        # The base DTM still sets walking pace (the overall climb); HAZ decides what is unsafe.
        self.HAZ, self.SLOPE10, self.HIRISE = self.SLOPE, None, None
        if os.path.exists(os.path.join(d, "slope_hr.npy")):
            hr = np.load(os.path.join(d, "slope_hr.npy"))
            self.HIRISE = np.isfinite(hr)
            self.HAZ = np.where(self.HIRISE, np.maximum(self.SLOPE, np.nan_to_num(hr)), self.SLOPE).astype("float32")
            self.SLOPE10 = np.load(os.path.join(d, "slope10.npy"))
        self.SVF = (1 - np.sin(np.radians(self.HOR.astype("float32") / 2)).mean(0)).astype("float32")  # sky fraction seen

        # Slope margin: a cell next to a steep cell counts as steep, so the route keeps a ~20 m margin from edges.
        self.HAZB = maximum_filter(self.HAZ, size=3).astype("float32")

        # Radiation, see the constants at the top. dose = measured baseline x air column x how much sky the terrain leaves.
        col = COL_BASE * np.exp(-(Z - Z_BASE) / H_ATM)             # g/cm2 of CO2 overhead, from MOLA elevation
        self.COL = col.astype("float32")
        x = float(col.mean()) / LAMBDA
        el = np.radians(np.arange(0.5, 90, 1.0))
        w = np.exp(-x * (1 / np.sin(el) - 1)) * np.cos(el)         # dose from each elevation band, per unit solid angle
        cum = np.cumsum(w) / w.sum()                               # share of the dose that comes from BELOW a given horizon angle
        el_deg = np.degrees(el)
        vis = np.zeros((H, W), "float32")
        for k in range(self.N_AZ):                                 # visible share of the sky dose, averaged over 16 directions
            vis += 1 - np.interp(self.HOR[k].astype("float32") / 2, el_deg, cum, left=0.0)
        self.SKY = (vis / self.N_AZ).astype("float32")
        self.RAD = (RAD_BASE * np.exp(-(col - COL_BASE) / LAMBDA) * self.SKY).astype("float32")   # mSv/day

        # Ground temperature: 24 slots through one sol, from pipeline/build_heat.py (Jezero only for now)
        self.HEAT, self.HEAT_META = None, None
        if os.path.exists(os.path.join(d, "heat.npy")):
            self.HEAT = np.load(os.path.join(d, "heat.npy"))
            self.HEAT_META = json.load(open(os.path.join(d, "heat_meta.json")))

        # Rocky ground from THEMIS night IR (pipeline/build_rocks.py), minerals from CRISM (pipeline/build_minerals.py, Jezero)
        self.ROCK = None
        if os.path.exists(os.path.join(d, "rock.npy")):
            self.ROCK = np.nan_to_num(np.load(os.path.join(d, "rock.npy")).astype("float32"), nan=0.0)
        self.MIN, self.MIN_META = None, None
        if os.path.exists(os.path.join(d, "minerals.npy")):
            self.MIN = np.load(os.path.join(d, "minerals.npy")); self.MIN_META = json.load(open(os.path.join(d, "minerals_meta.json")))

        self.PACE_ISO = (1.0 / tobler_ms(np.tan(np.radians(self.SLOPE)))).astype("float32")   # s per metre
        self.PACE_ROVER = (1.0 / rover_ms(np.tan(np.radians(self.SLOPE)))).astype("float32")
        self.bottom = M["eqc_top"] - H * M["eqc_res"]
        self.HAB = (float(np.clip((M["R"] * np.radians(self.info["lon_e"]) - M["eqc_left"]) * np.cos(np.radians(M["lat0"])), 0, W * DX - 1)),
                    float(np.clip(M["R"] * np.radians(self.info["lat"]) - self.bottom, 0, H * DY - 1)))

        self.pass_file = os.path.join(d, "passes_cache.json")       # so the demo survives Postgres being asleep
        self.cache = {"t": 0, "passes": [], "sun": np.zeros((0, 3))}
        self.lock = threading.Lock()
        self.legends = {}
        self.ground_c = lru_cache(maxsize=6)(self._ground_c)
        self.comms_minutes = lru_cache(maxsize=8)(self._comms_minutes)
        self.sunlight = lru_cache(maxsize=32)(self._sunlight)
        self.layer_png = lru_cache(maxsize=64)(self._layer_png)

    # ---- grid helpers ----
    def rc(self, x, y):
        return int(np.clip(self.H - 1 - y / self.DY, 0, self.H - 1)), int(np.clip(x / self.DX, 0, self.W - 1))

    def az_bin(self, az):
        return int(round(az / (360.0 / self.N_AZ))) % self.N_AZ

    # ---- passes: Postgres first, last good copy on disk second ----
    def _set(self, passes, sun):
        self.cache["passes"] = passes
        self.cache["sun"] = np.array(sun, dtype="float64").reshape(-1, 3)
        json.dump({"passes": passes, "sun": self.cache["sun"].tolist()}, open(self.pass_file, "w"))

    def load_db(self, force=False):
        with self.lock:
            c = self.cache
            if not force and time.time() - c["t"] < 120:
                return c
            c["t"] = time.time()
            ps = None
            try:
                with psycopg.connect(fetch_passes.db_url(), connect_timeout=4) as con:
                    con.execute(fetch_passes.SCHEMA)
                    ps = con.execute("select orbiter, start_utc, end_utc, max_el, samples from passes "
                                     "where site=%s order by start_utc", (self.info["name"],)).fetchall()
                    sn = con.execute("select t, az, el from sun where site=%s order by t", (self.info["name"],)).fetchall()
            except psycopg.OperationalError as e:       # Postgres down (WSL asleep): keep serving what we have
                print("database unreachable, using cached passes:", str(e).strip()[:80])
                c["t"] = time.time() - 90               # try again in 30 s
            if ps:
                self._set([{"orbiter": o, "start": int(a.timestamp()), "end": int(b.timestamp()) + 60,
                            "max_el": round(m, 1), "samples": s} for o, a, b, m, s in ps],
                          [[t.timestamp(), az, el] for t, az, el in sn])
            elif not c["passes"] and os.path.exists(self.pass_file):
                f = json.load(open(self.pass_file))
                c["passes"] = f["passes"]; c["sun"] = np.array(f["sun"], dtype="float64").reshape(-1, 3)
            return c

    def refresh(self):
        """Pull passes + Sun for this site from JPL Horizons; store in Postgres when it is up."""
        data = fetch_passes.fetch(self.info)
        if not data["passes"] and not data["sun"]:
            raise RuntimeError("Horizons returned nothing for this site")
        with self.lock:
            self._set(sorted([{"orbiter": p["orbiter"], "start": int(p["start"].timestamp()),
                               "end": int(p["end"].timestamp()) + 60, "max_el": round(p["max_el"], 1),
                               "samples": p["samples"]} for p in data["passes"]], key=lambda p: p["start"]),
                      [[t.timestamp(), az, el] for t, az, el in data["sun"]])
            self.cache["t"] = time.time()
        try:
            fetch_passes.store(data, self.info)
        except psycopg.OperationalError:
            print("Postgres is down: passes kept on disk only")
        self.comms_minutes.cache_clear(); self.sunlight.cache_clear(); self.layer_png.cache_clear()

    def ensure_fresh(self):
        """Refetch from Horizons when the stored passes run out (the cron job, lazily)."""
        try:
            last = max([p["end"] for p in self.load_db(True)["passes"]], default=0)
            if last < time.time() + 30 * 3600:
                print(f"{self.id}: passes are stale -> fetching from JPL Horizons")
                self.refresh()
        except Exception as e:  # keep serving the map even if Horizons is down
            print("pass refresh failed:", e)

    def sun_at(self, t):
        s = self.load_db()["sun"]
        if len(s) == 0:
            return 0.0, -90.0
        el = float(np.interp(t, s[:, 0], s[:, 2]))
        i = int(np.clip(np.searchsorted(s[:, 0], t), 0, len(s) - 1))
        return float(s[i, 1]), el

    # ---- time-dependent layers ----
    def heat_phase(self, t):
        """unix time(s) -> (slot index, fraction to the next slot). Works on arrays."""
        hm = self.HEAT_META
        ph = ((np.asarray(t, "float64") - hm["t_ref"]) % hm["sol_s"]) / hm["sol_s"] * 24
        k = np.floor(ph).astype(int) % 24
        return k, (ph - np.floor(ph)).astype("float32")

    def _ground_c(self, t_bucket):
        """Ground temperature in deg C over the whole map at a 10-minute bucket."""
        k, f = self.heat_phase(t_bucket * 600)
        a = (self.HEAT[k] * (1 - f) + self.HEAT[(k + 1) % 24] * f) / 10.0 - 273.15
        s = self.HEAT_META["step"]
        return np.repeat(np.repeat(a.astype("float32"), s, 0), s, 1)[:self.H, :self.W]

    def _comms_minutes(self, t0_hour):
        """Minutes of relay contact in the next 24 h per cell, with terrain blocking."""
        t0, t1 = t0_hour * 3600, t0_hour * 3600 + 86400
        out = np.zeros((self.H, self.W), "float32"); total = 0
        for p in self.load_db()["passes"]:
            for ts, az, el, *_ in p["samples"]:
                if t0 <= ts < t1 and el >= MIN_EL:
                    out += (el * 2 > self.HOR[self.az_bin(az)])
                    total += 1
        return out, total

    def _sunlight(self, t_bucket):
        """0 = shadow or night, up to 1 = sun square-on to the ground."""
        az, el = self.sun_at(t_bucket * 600)
        if el <= 0:
            return np.zeros((self.H, self.W), "float32"), az, el
        a, e = np.radians(az), np.radians(el)
        sx, sy, sz = np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)
        lit = el * 2 > self.HOR[self.az_bin(az)]
        return (np.clip(self.NX * sx + self.NY * sy + self.NZ * sz, 0, 1) * lit).astype("float32"), az, el

    def penalties(self, t):
        cm, total = self.comms_minutes(int(t // 3600))
        sun, _, sun_el = self.sunlight(int(t // 600))
        lo, hi = np.percentile(self.RAD[::4, ::4], (2, 98))
        cold = np.zeros((self.H, self.W), "float32")
        if self.HEAT is not None:                             # colder than the rest of the map right now = worse
            g = self.ground_c(int(t // 600))
            glo, ghi = np.percentile(g[::4, ::4], (2, 98))
            cold = np.clip((ghi - g) / max(ghi - glo, 1e-6), 0, 1)
        return {
            "rocks": self.ROCK if self.ROCK is not None else np.zeros((self.H, self.W), "float32"),
            "cold": cold,
            "slope": slope_pen(self.HAZB),
            "radiation": np.clip((self.RAD - lo) / max(hi - lo, 1e-9), 0, 1),
            "comms": 1 - cm / max(total, 1),
            "shadow": (sun < 0.05).astype("float32") if sun_el > 0 else np.zeros((self.H, self.W), "float32"),
        }

    def cost_grid(self, weights, t, max_slope, vehicle="foot"):
        mult = np.ones((self.H, self.W), "float32")
        for k, p in self.penalties(t).items():
            mult += (1.0 if k == "slope" else 6.0) * float(weights.get(k, 0)) * p
        return (self.PACE_ROVER if vehicle == "rover" else self.PACE_ISO) * mult, self.nogo(max_slope)

    def nogo(self, max_slope):
        return (self.HAZ > max_slope) | ~self.VALID

    def _layer_png(self, name, t, wkey):
        L = self.legends
        if name == "elevation":
            lo, hi = np.percentile(self.Z[self.VALID][::7], (1, 99))
            rgba = ramp((self.Z - lo) / max(hi - lo, 1e-6), ELEV_STOPS)
            shade = np.clip((self.NX * -0.5 + self.NY * 0.5 + self.NZ * 0.707) / 0.707, 0.25, 1.25)[..., None]
            rgba[..., :3] = np.clip(rgba[..., :3] * shade, 0, 255)
            L[name] = {"lo": round(float(lo)), "hi": round(float(hi)), "unit": "m (MOLA datum)"}
        elif name == "slope":
            rgba = ramp((self.SLOPE10 / 3.0 if self.SLOPE10 is not None else self.SLOPE) / 40.0,
                        [(0, (40, 200, 120, 0)), (.12, (60, 200, 120, 70)), (.25, (235, 220, 80, 170)),
                         (.45, (245, 150, 50, 215)), (.624, (235, 90, 40, 235)), (.626, (215, 30, 45, 250)),
                         (1, (120, 10, 40, 255))])
        elif name == "radiation":
            lo, hi = np.percentile(self.RAD[::4, ::4], (1, 99))
            rgba = ramp((self.RAD - lo) / max(hi - lo, 1e-9), [(0, (40, 120, 220, 225)), (.5, (110, 60, 170, 200)),
                                                               (.8, (220, 80, 110, 215)), (1, (255, 200, 90, 230))])
            L[name] = {"lo": round(float(lo), 3), "hi": round(float(hi), 3),
                       "unit": "mSv/day. Measured at Gale (0.67), scaled by this ground's air column and open sky"}
        elif name == "comms":
            cm, total = self.comms_minutes(t // 3600)
            lost = total - cm
            hi = max(float(np.percentile(lost[::4, ::4], 99.9)), 1.0)
            rgba = ramp(lost / hi, [(0, (60, 220, 235, 0)), (.03, (90, 200, 230, 90)), (.1, (120, 200, 200, 130)),
                                    (.4, (240, 190, 70, 200)), (1, (230, 50, 60, 245))])
            L[name] = {"lo": 0, "hi": round(hi), "unit": f"min of contact lost to terrain, of {total} min in 24 h"}
        elif name == "sun":
            s, az, el = self.sunlight(t // 600)
            rgba = ramp(s, [(0, (14, 22, 70, 190)), (.04, (14, 22, 70, 185)), (.06, (255, 190, 110, 0)),
                            (1, (255, 225, 170, 90))])
            L[name] = {"az": round(az), "el": round(el, 1), "unit": "sun and cast shadow"}
        elif name == "heat":
            if self.HEAT is None:
                raise HTTPException(404, "no heat model for this site")
            g = self.ground_c(t // 600)
            lo, hi = np.percentile(g[::4, ::4], (1, 99))       # stretch over what the map holds right now
            rgba = ramp((g - lo) / max(hi - lo, 1e-6), HEAT_STOPS)
            L[name] = {"lo": round(float(lo)), "hi": round(float(hi)),
                       "unit": "ground °C at this moment (THEMIS + TES + Sun, heat model)",
                       "check": self.HEAT_META.get("check_day_ir_r")}
        elif name == "rocks":
            if self.ROCK is None:
                raise HTTPException(404, "no THEMIS night data here")
            rgba = ramp(self.ROCK, [(0, (150, 110, 70, 0)), (.25, (170, 120, 80, 60)), (.5, (205, 125, 70, 150)), (.8, (230, 90, 55, 210)), (1, (245, 60, 50, 235))])
            L[name] = {"lo": "typical ground", "hi": "rock-rich", "unit": "rocky ground: warm at night in THEMIS infrared (Mars Odyssey)"}
        elif name == "minerals":
            if self.MIN is None:
                raise HTTPException(404, "no mineral map here")
            rgba = np.zeros((self.H, self.W, 4), "uint8")
            present = []
            for k, v in self.MIN_META["classes"].items():
                k = int(k); hi, md = self.MIN == k + 16, self.MIN == k
                if hi.any() or md.any():
                    rgba[hi] = (*v["hi"], 235); rgba[md] = (*v["md"], 190)
                    present.append({"name": v["name"], "color": "rgb(%d,%d,%d)" % tuple(v["hi"]), "cells": int(hi.sum() + md.sum())})
            L[name] = {"classes": sorted(present, key=lambda p: -p["cells"]), "unit": "minerals seen by MRO CRISM (bright = high confidence)", "source": self.MIN_META["source"]}
        elif name == "cost":
            cost, nogo = self.cost_grid(json.loads(wkey), t, 25.0)
            v = np.log(cost / self.PACE_ISO.min())
            rgba = ramp(v / np.log(12), [(0, (30, 160, 120, 40)), (.3, (220, 210, 80, 150)), (.65, (240, 120, 50, 210)),
                                         (1, (200, 40, 60, 240))])
            rgba[nogo] = (25, 5, 15, 235)
        else:
            raise HTTPException(404)
        if rgba.shape[:2] == self.VALID.shape:
            rgba[~self.VALID] = (0, 0, 0, 0)
        return png(rgba)

    # ---- routing ----
    def leg(self, cost, nogo, a, b):
        H, W = self.H, self.W
        (r0, c0), (r1, c1) = self.rc(*a), self.rc(*b)
        span = max(abs(r1 - r0), abs(c1 - c0))
        for margin in (250 + span // 2, None):   # a generous window (room to detour round steep ground), then the whole map
            if margin is None:
                ra, rb, ca, cb = 0, H, 0, W
            else:
                m = margin
                ra, rb = max(0, min(r0, r1) - m), min(H, max(r0, r1) + m + 1)
                ca, cb = max(0, min(c0, c1) - m), min(W, max(c0, c1) + m + 1)
            c = cost[ra:rb, ca:cb].copy()
            ng = nogo[ra:rb, ca:cb].copy()
            yy, xx = np.ogrid[ra:rb, ca:cb]
            for (r, cc) in ((r0, c0), (r1, c1)):  # a stop on a steep cell must still be reachable
                ng[(yy - r) ** 2 + (xx - cc) ** 2 <= 16] = False
            c[ng] = -1
            mcp = MCP_Geometric(c, sampling=(self.DY, self.DX), fully_connected=True)
            costs, _ = mcp.find_costs([(r0 - ra, c0 - ca)], [(r1 - ra, c1 - ca)])
            if np.isfinite(costs[r1 - ra, c1 - ca]):
                tb = mcp.traceback((r1 - ra, c1 - ca))
                return [(r + ra, cc + ca) for r, cc in tb]
        return None


# ---------- site registry ----------
SITES, _sites_lock = {}, threading.Lock()


def get_site(sid="jezero") -> Site:
    sid = "".join(ch for ch in sid if ch.isalnum() or ch == "_")[:40] or "jezero"
    with _sites_lock:
        if sid not in SITES:
            SITES[sid] = Site(sid)
            threading.Thread(target=SITES[sid].ensure_fresh, daemon=True).start()   # top up its passes in the background
        return SITES[sid]


class RouteReq(BaseModel):
    site: str = "jezero"
    stops: list[list[float]]                 # [[x, y], ...] metres; first = start
    weights: dict[str, float] = {}
    depart: float | None = None              # unix seconds
    max_slope: float = 25.0
    dwell_min: float = 15.0                  # science time at each intermediate stop
    round_trip: bool = True
    vehicle: str = "foot"                    # "foot" (suited walk) or "rover" (crew rover)
    load_kg: float = 0.0                     # what the walker carries besides the suit (tools, samples)


class SiteReq(BaseModel):
    lat: float
    lon: float                               # east longitude, any range
    name: str | None = None


app = FastAPI(title="Marswalk")
app.include_router(comms.router)


def _scheduler():
    """The cron job, inside the app: top up passes from Horizons every 6 hours, for every site in use."""
    get_site("jezero")
    while True:
        for s in list(SITES.values()):
            s.ensure_fresh()
            s.comms_minutes.cache_clear()
        time.sleep(REFRESH_S)


@app.on_event("startup")
def _startup():
    threading.Thread(target=_scheduler, daemon=True).start()


@app.get("/api/sites")
def sites():
    """Every site that has been built: the detailed one plus regions made from the globe."""
    out = []
    ids = ["jezero"] + (sorted(os.listdir(os.path.join(D, "sites"))) if os.path.isdir(os.path.join(D, "sites")) else [])
    for sid in ids:
        p = os.path.join(D if sid == "jezero" else os.path.join(D, "sites", sid), "meta.json")
        if os.path.exists(p):
            m = json.load(open(p)); info = m.get("site") or fetch_passes.SITE
            out.append({"id": sid, "label": m.get("label", "Jezero crater"), "kind": m.get("kind", "detail"),
                        "lat": info["lat"], "lon_e": info["lon_e"], "elev_km": info["elev_km"],
                        "cell_m": round(m["DY"]), "size_km": round(m["height_m"] / 1000)})
    return sorted(out, key=lambda s: s["kind"] != "detail")     # detailed sites first


@app.post("/api/sites")
def make_site(q: SiteReq):
    """Plan anywhere: build a region around (lat, lon) from global MOLA, then fetch its orbiter passes."""
    if not (-90 <= q.lat <= 90):
        raise HTTPException(400, "latitude out of range")
    lon = ((q.lon + 180) % 360) - 180
    for dd in (s for s in sites() if s["kind"] == "detail"):   # inside a detailed map (Jezero, Gale): use it
        m = get_site(dd["id"]).meta
        x = (m["R"] * np.radians(lon) - m["eqc_left"]) / m["eqc_res"]; y = (m["eqc_top"] - m["R"] * np.radians(q.lat)) / m["eqc_res"]
        if 0 <= x < m["W"] and 0 <= y < m["H"]:
            return {"id": dd["id"], "label": dd["label"], "kind": "detail"}
    try:
        sid = build_site.build(q.lat, lon, q.name)
    except Exception as e:
        raise HTTPException(502, f"could not read global terrain: {e}")
    s = get_site(sid)
    s.ensure_fresh()
    return {"id": sid, "label": s.meta.get("label"), "kind": "region", "passes": len(s.cache["passes"])}


@app.get("/api/next")
def next_passes(x: float | None = None, y: float | None = None, t: float | None = None, hours: float = 24,
                site: str = "jezero"):
    """What's next for this spot? Passes as seen from (x, y), with terrain blocking and Doppler."""
    S = get_site(site)
    t0 = t or time.time()
    x, y = (S.HAB if x is None or y is None else (x, y))
    r, c = S.rc(x, y)
    hor = (S.HOR[:, r, c] / 2.0).tolist()
    out = []
    for p in S.load_db()["passes"]:
        if p["end"] <= t0 or p["start"] > t0 + hours * 3600:
            continue
        smp = []
        for ts, az, el, rng, rdot in p["samples"]:
            vis = el >= MIN_EL and el > hor[S.az_bin(az)]
            smp.append([ts, az, el, rng, round(-UHF_HZ * rdot / C_KMS), int(vis)])   # Doppler shift in Hz
        seen = [q for q in smp if q[5]]
        up = [q for q in smp if q[2] >= MIN_EL]
        ca = min(smp, key=lambda q: q[3])                    # closest approach
        i = smp.index(ca)
        a, b = smp[max(i - 1, 0)], smp[min(i + 1, len(smp) - 1)]
        out.append({
            "orbiter": p["orbiter"], "start": p["start"], "end": p["end"], "max_el": p["max_el"],
            "vis_start": seen[0][0] if seen else None, "vis_end": seen[-1][0] + 60 if seen else None,
            "vis_min": len(seen), "blocked_min": len(up) - len(seen),
            "closest_t": ca[0], "closest_km": ca[3],
            "doppler_max_hz": max(abs(q[4]) for q in smp),
            "doppler_rate_hz_s": round((b[4] - a[4]) / max(b[0] - a[0], 1), 1),   # steepness at the crossing
            "samples": smp,
        })
    return {"x": x, "y": y, "t": t0, "horizon": hor, "uhf_hz": UHF_HZ, "min_el": MIN_EL, "passes": out}


@app.get("/api/meta")
def meta(site: str = "jezero"):
    S = get_site(site)
    jz = S.id == "jezero"
    return {"id": S.id, "kind": "detail", "label": "Jezero crater",
            "basemap": "img/basemap.jpg", "basemap_3d": "img/basemap_2k.jpg",
            "elev_url": "data/elev_i16.bin", "elev_scale": 0.1,
            **S.meta, "habitat": S.HAB, "site": S.info, "min_el": MIN_EL, "now": time.time(), "uhf_hz": UHF_HZ,
            "assumptions": {"suit_speed_factor": SUIT, "drift_fraction": WALK_DRIFT,
                            "radiation": "Curiosity RAD 0.67 mSv/day at Gale (22 g/cm2), scaled by air column from MOLA elevation and by visible sky"},
            "rad": {"base": RAD_BASE, "column": COL_BASE, "lambda": LAMBDA, "career": CAREER_MSV,
                    "min": float(S.RAD.min()), "max": float(S.RAD.max())},
            "eqc_bottom": S.bottom, "heat": S.HEAT_META,
            "habitat_name": S.meta.get("habitat_name") or ("Octavia E. Butler Landing" if jz else "chosen point"),
            "layers_extra": {"rocks": S.ROCK is not None, "minerals": S.MIN is not None},
            "hirise": None if S.HIRISE is None else {
                "coverage": float(S.HIRISE.mean()),
                "box": [float(v) for v in (np.where(S.HIRISE.any(0))[0][[0, -1]] * S.DX).tolist()
                        + ((S.H - 1 - np.where(S.HIRISE.any(1))[0][[-1, 0]]) * S.DY).tolist()]}}


@app.get("/api/passes")
def passes(frm: float | None = None, hours: float = 48, site: str = "jezero"):
    t0 = frm or time.time()
    c = get_site(site).load_db()
    ps = [p for p in c["passes"] if p["end"] > t0 - 3600 and p["start"] < t0 + hours * 3600]
    s = c["sun"]
    sun = s[(s[:, 0] > t0 - 3600) & (s[:, 0] < t0 + hours * 3600)].round(2).tolist() if len(s) else []
    return {"passes": ps, "sun": sun}


@app.post("/api/refresh")
def refresh(site: str = "jezero"):
    S = get_site(site)
    S.refresh()
    return {"passes": len(S.cache["passes"])}


@app.get("/api/layer/{name}.png")
def layer(name: str, t: float | None = None, w: str = "{}", site: str = "jezero"):
    return get_site(site).layer_png(name, int(t or time.time()) // 600 * 600, w)


@app.get("/api/legend/{name}")
def legend(name: str, t: float | None = None, site: str = "jezero"):
    S = get_site(site)
    S.layer_png(name, int(t or time.time()) // 600 * 600, "{}")
    return S.legends.get(name, {})


@app.post("/api/route")
def route(q: RouteReq):
    S = get_site(q.site)
    H, DX, DY, HOR, HAZ = S.H, S.DX, S.DY, S.HOR, S.HAZ
    if len(q.stops) < 2 and not (q.round_trip and len(q.stops) == 1):
        raise HTTPException(400, "need at least two stops")
    t_dep = q.depart or time.time()
    rover = q.vehicle == "rover"
    if rover:
        q.max_slope = min(q.max_slope, ROVER_MAX)
    cost, _ = S.cost_grid(q.weights, t_dep, q.max_slope, q.vehicle)
    stops = [tuple(s) for s in q.stops]
    seq = stops + ([stops[0]] if q.round_trip and len(stops) > 1 else [])
    for used in (q.max_slope, q.max_slope + 4, q.max_slope + 8):      # strict first; relax only if there is no way through
        nogo = S.nogo(used)
        cells, stop_idx, ok = [], [0], True
        for a, b in zip(seq[:-1], seq[1:]):
            p = S.leg(cost, nogo, a, b)
            if p is None:
                ok = False
                break
            if len(p) == 1:                               # both ends in the same cell: still a leg, just a short one
                p = [p[0], p[0]]
            cells += p if not cells else p[1:]
            stop_idx.append(len(cells) - 1)
        if ok:
            break
    else:
        raise HTTPException(422, f"no {'drivable' if rover else 'walkable'} path between two of the stops (terrain too steep)")
    rr = np.array([c[0] for c in cells]); cc = np.array([c[1] for c in cells])
    x = (cc + 0.5) * DX; y = (H - 1 - rr + 0.5) * DY
    for i, sxy in zip(stop_idx, seq):                     # start, waypoints and end sit on the exact point asked for, not the middle of its cell
        if abs(sxy[0] - x[i]) <= DX and abs(sxy[1] - y[i]) <= DY:
            x[i], y[i] = sxy[0], sxy[1]
    # the grid search gives a staircase of 45 degree steps. Ease it into a walking line: each node moves toward its neighbours
    # but never leaves its own cell, so the path stays on the ground the search approved. Stops do not move.
    x0, y0 = (cc + 0.5) * DX, (H - 1 - rr + 0.5) * DY
    keep = np.zeros(len(x), bool); keep[stop_idx] = True
    for _ in range(4):
        xs, ys = x.copy(), y.copy()
        xs[1:-1] = 0.25 * x[:-2] + 0.5 * x[1:-1] + 0.25 * x[2:]; ys[1:-1] = 0.25 * y[:-2] + 0.5 * y[1:-1] + 0.25 * y[2:]
        x = np.where(keep, x, np.clip(xs, x0 - 0.45 * DX, x0 + 0.45 * DX)); y = np.where(keep, y, np.clip(ys, y0 - 0.45 * DY, y0 + 0.45 * DY))
    z = S.Z[rr, cc].astype("float64")
    seg = np.hypot(np.diff(x), np.diff(y))
    s = np.divide(np.diff(z), seg, out=np.zeros_like(seg), where=seg > 0)
    lf = 1.0 if rover else max(0.5, 1 - LOAD_PER_KG * max(0.0, q.load_kg))     # a heavy load slows the walk
    dt = seg / ((rover_ms(s) if rover else tobler_ms(s)) * lf)   # rover speed, or real direction-aware Tobler time on foot
    d = np.concatenate([[0], np.cumsum(seg)])
    t = np.concatenate([[0], np.cumsum(dt)])
    dwell = []
    for i in stop_idx[1:-1]:                              # pause at each science stop
        t[i + 1:] += q.dwell_min * 60
        dwell.append({"i": int(i), "t": float(t[i]), "min": q.dwell_min})
    total_t = float(t[-1])
    # dose along the way (walking + dwell), model
    tt = np.diff(t)
    dose = float((S.RAD[rr[:-1], cc[:-1]] * tt).sum() / 86400.0)
    # relay contact along the route: where am I at each pass minute, and can I see the orbiter from there?
    contacts, in_contact = [], []
    for p in S.load_db()["passes"]:
        if p["end"] < t_dep or p["start"] > t_dep + total_t:
            continue
        seen, blocked, mx = [], 0, 0
        for ts, az, el, *_ in p["samples"]:
            if not (t_dep <= ts <= t_dep + total_t) or el < MIN_EL:
                continue
            i = int(np.clip(np.searchsorted(t, ts - t_dep), 0, len(t) - 1))
            if el * 2 > HOR[S.az_bin(az), rr[i], cc[i]]:
                seen.append(ts); mx = max(mx, el)
            else:
                blocked += 1
        if seen or blocked:
            contacts.append({"orbiter": p["orbiter"], "start": seen[0] if seen else None,
                             "end": (seen[-1] + 60) if seen else None, "minutes": len(seen),
                             "blocked_min": blocked, "max_el": round(mx, 1)})
            in_contact += seen
    in_contact.sort()
    edges = [t_dep] + in_contact + [t_dep + total_t]
    gap = max(np.diff(edges)) if len(edges) > 1 else total_t
    # sun during the walk
    sun_el = [S.sun_at(t_dep + k)[1] for k in np.linspace(0, total_t, 12)]
    warn = []
    if total_t > 8 * 3600:
        warn.append(f"EVA is {total_t/3600:.1f} h, over the 8 h {'shift' if rover else 'suit'} limit")
    if min(sun_el) <= 0:
        warn.append("part of this EVA is in darkness")
    if not in_contact:
        warn.append("no relay contact during this EVA: no position fix, no link")
    if used > q.max_slope:
        warn.append(f"no way through under {q.max_slope:.0f}°: the limit was relaxed to {used:.0f}° for this route")
    sl = HAZ[rr, cc]
    wgt = np.append(seg, seg[-1] if len(seg) else 1.0)             # metres each path cell stands for
    tot = float(wgt.sum()) or 1.0
    mix = {"green": float(wgt[sl < 8].sum() / tot * 100), "yellow": float(wgt[(sl >= 8) & (sl < 15)].sum() / tot * 100),
           "steep": float(wgt[sl >= 15].sum() / tot * 100)}
    if S.meta.get("kind") == "region":
        warn.append(f"coarse terrain: {DY:.0f} m cells hide rocks, scarps and small craters")
    rocky = float(wgt[S.ROCK[rr, cc] > 0.5].sum() / tot * 100) if S.ROCK is not None else None
    if rocky is not None and rocky > 25:
        warn.append(f"{rocky:.0f}% of the route crosses rock-rich ground (THEMIS night infrared): expect boulders")
    stop_min, route_min = None, None
    if S.MIN is not None:                                  # which minerals CRISM sees at each stop and along the way
        names = {int(k): v["name"] for k, v in S.MIN_META["classes"].items()}
        def at(r0, c0):
            w = S.MIN[max(0, r0 - 2):r0 + 3, max(0, c0 - 2):c0 + 3] % 16; w = w[w > 0]
            return names[int(np.bincount(w).argmax())] if w.size else None
        stop_min = [at(int(rr[i]), int(cc[i])) for i in stop_idx]
        k = S.MIN[rr, cc] % 16; route_min = {names[int(c)]: round(float(wgt[k == c].sum()), 1) for c in np.unique(k) if c > 0}
    sw = space_weather()
    for c_ in sw.get("cme", []):                           # a coronal mass ejection reaching Mars during (or 12 h around) the EVA
        if t_dep - 12 * 3600 <= c_["arrival"] <= t_dep + total_t + 12 * 3600:
            warn.append(f"space weather: a coronal mass ejection is forecast to reach Mars around {datetime.fromtimestamp(c_['arrival'], timezone.utc):%d %b %H:%M} UTC (NASA DONKI). Stay close to shelter")
    if sw.get("sep_recent"):
        warn.append("space weather: a solar energetic particle event was detected in the last two days (NASA DONKI)")
    # ground temperature under the walker, at the moment they are there
    ground = None
    if S.HEAT is not None:
        k, f = S.heat_phase(t_dep + t)
        s_ = S.HEAT_META["step"]
        r2, c2 = np.minimum(rr // s_, S.HEAT.shape[1] - 1), np.minimum(cc // s_, S.HEAT.shape[2] - 1)
        ground = (S.HEAT[k, r2, c2] * (1 - f) + S.HEAT[(k + 1) % 24, r2, c2] * f) / 10.0 - 273.15
        if ground.min() < -80:
            warn.append(f"ground as cold as {ground.min():.0f} °C on this EVA")
    return {
        "ground_c": None if ground is None else ground.round(1).tolist(),
        "ground_min_c": None if ground is None else float(ground.min()),
        "ground_max_c": None if ground is None else float(ground.max()),
        "x": x.round(1).tolist(), "y": y.round(1).tolist(), "z": z.round(1).tolist(),
        "d": d.round(1).tolist(), "t": t.round(1).tolist(),
        "slope": HAZ[rr, cc].round(1).tolist(),
        "stop_idx": [int(i) for i in stop_idx], "dwell": dwell,
        "distance_m": float(d[-1]), "time_s": total_t,
        "climb_m": float(np.clip(np.diff(z), 0, None).sum()),
        "dose_msv": dose, "max_slope": float(HAZ[rr, cc].max()), "slope_mix": mix, "slope_limit_used": used,
        "career_pct": dose / CAREER_MSV * 100, "rad_day_avg": float(S.RAD[rr, cc].mean()),
        "contacts": contacts, "contact_min": len(in_contact), "longest_gap_s": float(gap),
        "sun_el": [round(v, 1) for v in sun_el], "depart": t_dep, "warnings": warn, "vehicle": q.vehicle,
        "load_kg": 0.0 if rover else q.load_kg, "rocky_pct": rocky, "stop_minerals": stop_min, "route_minerals": route_min,
        "space_weather": {k: sw.get(k) for k in ("status", "summary", "checked")},
    }


# ---------- space weather at Mars: NASA DONKI (Space Weather Database Of Notifications, Knowledge, Information) ----------
# CME arrival forecasts at Mars come from the WSA-Enlil runs CCMC posts to DONKI; SEP events are detected particle storms.
SW = {"t": 0.0, "data": {"status": "unknown", "summary": "Space weather not checked yet.", "cme": [], "sep": []}}


def _ts(s):
    return datetime.strptime(s[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp()


def space_weather():
    if time.time() - SW["t"] < (3 * 3600 if SW["data"].get("ok") else 600):
        return SW["data"]
    key = os.environ.get("NASA_API_KEY", "DEMO_KEY"); now = datetime.now(timezone.utc); nowt = now.timestamp()
    s, e = (now - timedelta(days=14)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")
    out = {"checked": nowt, "source": "NASA DONKI (CCMC WSA-Enlil CME forecasts, SEP events)", "cme": [], "sep": [], "ok": True}
    try:
        sims = requests.get(f"https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate={s}&endDate={e}&api_key={key}", timeout=20).json() or []
        hits = []
        for sim in sorted(sims, key=lambda q: q.get("modelCompletionTime") or ""):
            for i in sim.get("impactList") or []:
                if i.get("location") == "Mars" and i.get("arrivalTime"):
                    hits.append({"arrival": _ts(i["arrivalTime"]), "glancing": bool(i.get("isGlancingBlow")), "minor": bool(i.get("isMinorImpact")),
                                 "link": sim.get("link"), "run": sim.get("modelCompletionTime")})
        merged = []                                     # the same CME is modelled several times: keep the newest run of each
        for h in sorted(hits, key=lambda q: q["arrival"]):
            if merged and h["arrival"] - merged[-1]["arrival"] < 18 * 3600:
                if (h["run"] or "") >= (merged[-1]["run"] or ""): merged[-1] = h
            else:
                merged.append(h)
        out["cme"] = [h for h in merged if h["arrival"] > nowt - 2 * 86400]
        seps = requests.get(f"https://api.nasa.gov/DONKI/SEP?startDate={s}&endDate={e}&api_key={key}", timeout=20).json() or []
        out["sep"] = [{"t": _ts(q["eventTime"]), "link": q.get("link"), "instruments": [i.get("displayName") for i in q.get("instruments") or []]} for q in seps]
    except Exception as ex:
        out["ok"] = False; out["error"] = str(ex)[:160]
    out["sep_recent"] = any(q["t"] > nowt - 2 * 86400 for q in out["sep"])
    soon = [c for c in out["cme"] if nowt - 86400 <= c["arrival"] <= nowt + 7 * 86400]
    now_hit = [c for c in out["cme"] if abs(c["arrival"] - nowt) <= 86400]
    fmt = lambda t_: datetime.fromtimestamp(t_, timezone.utc).strftime("%a %d %b, %H:%M UTC")
    if not out["ok"]:
        out["status"], out["summary"] = "unknown", "Space weather could not be checked just now (NASA DONKI did not answer). Plan with the usual margins."
    elif now_hit or out["sep_recent"]:
        out["status"] = "storm"
        out["summary"] = ("A coronal mass ejection is arriving at Mars around " + fmt(now_hit[0]["arrival"]) + ". " if now_hit else "") + \
                         ("Energetic particles were detected in the last two days. " if out["sep_recent"] else "") + \
                         "Keep EVAs short and close to the habitat until it passes."
    elif soon:
        c = soon[0]
        out["status"] = "watch"
        out["summary"] = (f"A coronal mass ejection is forecast to reach Mars around {fmt(c['arrival'])}"
                          f"{' (a glancing blow)' if c['glancing'] else ''}. Plan EVAs to be back inside before then.")
    else:
        out["status"], out["summary"] = "quiet", "No coronal mass ejection is forecast to reach Mars in the next 7 days, and no particle storm in the last 2 days."
    SW["t"], SW["data"] = time.time(), out
    return out


@app.get("/api/spaceweather")
def get_space_weather():
    return space_weather()


# ---------- science goals: where to go and why, picked from the data ----------
RAW = os.path.join(D, "raw")
_TRAV = {}


def traverse(name):
    """NASA's published rover traverse (end-of-drive positions): MSL (Curiosity) or M20 (Perseverance)."""
    if name not in _TRAV:
        p = os.path.join(RAW, f"{name}_waypoints.json")
        _TRAV[name] = [f["properties"] for f in json.load(open(p))["features"]] if os.path.exists(p) else []
    return _TRAV[name]


def _xy(S, lon, lat):
    m = S.meta
    return ((m["R"] * np.radians(lon) - m["eqc_left"]) * np.cos(np.radians(m["lat0"])), m["R"] * np.radians(lat) - S.bottom)


def _order(S, pts):
    """Visit nearest-first from the habitat."""
    out, cur, rest = [], S.HAB, list(pts)
    while rest:
        j = min(range(len(rest)), key=lambda i: (rest[i]["x"] - cur[0]) ** 2 + (rest[i]["y"] - cur[1]) ** 2)
        cur = (rest[j]["x"], rest[j]["y"]); out.append(rest.pop(j))
    return out


def mineral_targets(S, classes, reach, n=3, sep_m=600):
    cls, hi = S.MIN % 16, S.MIN >= 16
    mask = np.isin(cls, classes) & hi
    if mask.sum() < 30:
        mask = np.isin(cls, classes)
    dens = uniform_filter(mask.astype("float32"), size=9)            # how much of the 180 m around is this mineral
    yy, xx = np.ogrid[:S.H, :S.W]
    dist = np.hypot((xx + 0.5) * S.DX - S.HAB[0], (S.H - 1 - yy + 0.5) * S.DY - S.HAB[1])
    names = {int(k): v["name"] for k, v in S.MIN_META["classes"].items()}
    for r_ in (reach, reach * 2.5):
        score = np.where(mask & (dist <= r_) & (dist > 150) & (S.HAZ < 15) & S.VALID, dens, 0)
        picks = []
        while len(picks) < n and score.max() > 0.15:
            i = int(score.argmax()); r0, c0 = divmod(i, S.W)
            x, y = (c0 + 0.5) * S.DX, (S.H - 1 - r0 + 0.5) * S.DY
            picks.append({"x": float(x), "y": float(y), "label": f"{names[int(cls[r0, c0])]}{', high confidence' if hi[r0, c0] else ''}"})
            score[(np.hypot((xx + 0.5) * S.DX - x, (S.H - 1 - yy + 0.5) * S.DY - y) < sep_m)] = 0
        if picks:
            return _order(S, picks), r_ > reach
    return [], False


def traverse_targets(S, name, reach, sol_lo=0, sol_hi=10 ** 6, n=4):
    pts = []
    for f in traverse(name):
        if not (sol_lo <= f["sol"] <= sol_hi):
            continue
        x, y = _xy(S, f["lon"], f["lat"])
        if 0 < x < S.W * S.DX and 0 < y < S.H * S.DY and S.VALID[S.rc(x, y)]:
            pts.append({"x": float(x), "y": float(y), "sol": f["sol"], "d": float(np.hypot(x - S.HAB[0], y - S.HAB[1]))})
    if not pts:
        return [], False
    near = [p for p in pts if p["d"] <= reach]
    far = not near
    use = near or sorted(pts, key=lambda p: p["d"])[:max(n * 3, 8)]
    use = sorted(use, key=lambda p: p["sol"])
    pick = [use[round(i * (len(use) - 1) / max(n - 1, 1))] for i in range(min(n, len(use)))]
    seen, out = set(), []
    for p in pick:
        if p["sol"] not in seen:
            seen.add(p["sol"]); out.append({"x": p["x"], "y": p["y"], "label": f"{'Curiosity' if name == 'MSL' else 'Perseverance'} stopped here on sol {p['sol']}"})
    return out, far


@app.get("/api/science")
def science(site: str = "jezero", vehicle: str = "foot"):
    S = get_site(site); reach = 12000.0 if vehicle == "rover" else 4500.0
    objs = []
    def add(oid, title, why, data, stops_far):
        stops, far = stops_far
        if stops:
            objs.append({"id": oid, "title": title, "why": why, "data": data, "stops": stops, "far": far})
    if S.MIN is not None:
        crism = "MRO CRISM mineral map (UMass Amherst, Zenodo 5575824)"
        add("carbonate", "Carbonates: where life could leave a trace",
            "Carbonates form in water, and on Earth they can trap and keep signs of ancient life. That is why Perseverance is sampling them. CRISM sees magnesium carbonate at these spots.",
            crism, mineral_targets(S, [2, 6], reach))
        add("olivine", "Olivine: the crater floor's volcanic rock",
            "Olivine-rich rock covers much of Jezero's floor. Where water has started to change it, it shows how long the lake lasted.",
            crism, mineral_targets(S, [1, 4, 5], reach))
        add("clay", "Clays: rock changed by water",
            "Smectite clays form when rock sits in water for a long time, and they are good at preserving organic molecules.",
            crism, mineral_targets(S, [3, 10, 9], reach))
    if S.id == "jezero":
        add("perseverance", "Follow Perseverance",
            "Walk where NASA's rover drove: its own end-of-drive positions, from the published traverse.",
            "NASA Mars 2020 traverse (mars.nasa.gov)", traverse_targets(S, "M20", reach))
    if S.id == "gale":
        add("boxwork", "Boxwork on Mount Sharp (Curiosity, 2025)",
            "Boxwork is a web of low ridges left where groundwater filled cracks with minerals that later outlasted the rock around them. Curiosity drove into this area in 2025 to study it. These stops are Curiosity's own end-of-drive positions from that year.",
            "NASA MSL traverse (mars.nasa.gov)", traverse_targets(S, "MSL", reach, 4410, 4755))
    return {"objectives": objs, "reach_m": reach,
            "note": None if objs else "Science goals use detailed orbital data. Jezero (CRISM minerals) and Gale (Curiosity's boxwork drive) have it."}


@app.get("/", include_in_schema=False)
def home(site: str | None = None):
    """The homepage, unless an old link asks for a site straight away (/?site=...): then the planner."""
    from fastapi.responses import FileResponse
    return FileResponse(os.path.join(ROOT, "web", "index.html" if site else "home.html"), headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=os.path.join(ROOT, "web"), html=True), name="web")
