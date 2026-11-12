"""Step 3 of the pipeline: ground temperature through one Mars day.

Real inputs
  - THEMIS night IR 100 m mosaic (Mars Odyssey): which ground stays warm at night = rocky
  - TES albedo (Mars Global Surveyor): how much sunlight the ground absorbs
  - Sun azimuth / elevation / distance for this site, this sol, from JPL Horizons
  - CTX slopes and cast shadows (from build_terrain.py)
Model
  - 1-D heat conduction into the ground + surface energy balance, solved per 40 m cell
Check
  - compared against the THEMIS day IR mosaic (an independent observation)

Output: data/heat.npy  (24 slots, kelvin*10, int16, 40 m grid), data/heat_meta.json
Run:    .venv/Scripts/python pipeline/build_heat.py
"""
import json, os, sys, time
from datetime import datetime, timedelta, timezone
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
import fetch_passes  # noqa: E402

D = os.path.join(ROOT, "data")
BUCKET = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
NIGHT = "Mars_MO_THEMIS-IR-Night_mosaic_60N60S_100m_v14.tif"
DAY = "Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif"
ALBEDO = "Mars_MGS_TES_Albedo_mosaic_global_7410m.tif"

# ---- assumptions (say these out loud in the pitch) ----
TI_LO, TI_HI = 180.0, 605.0   # thermal inertia range MEDA measured on the ground at Jezero (Martinez et al. 2023);
                              # the THEMIS night-IR pattern is stretched onto this range
TAU = 0.5                     # dust optical depth, a typical clear-season value
EMIS = 0.95                   # ground emissivity
SOL = 88775.0                 # seconds in a Mars day
DT = 300.0                    # model time step
SIGMA = 5.670374e-8
T_FROST = 148.0               # CO2 frost point: the ground cannot get colder
STEP = 2                      # model grid = every 2nd terrain cell = 40 m


def window(name, meta, lon0_deg, pad_m=3000):
    """Read our map area from a global eqc mosaic. Returns array + (left, top, res)."""
    cache = os.path.join(D, "raw_" + name.split("_mosaic")[0].lower().replace("-", "_") + ".npy")
    if os.path.exists(cache):
        return np.load(cache, allow_pickle=True).item()
    R = meta["R"]
    shift = np.radians(lon0_deg) * R                      # mosaic x = our x - shift
    l = meta["eqc_left"] - shift - pad_m
    r = meta["eqc_left"] + meta["W"] * meta["eqc_res"] - shift + pad_m
    t = meta["eqc_top"] + pad_m
    b = meta["eqc_top"] - meta["H"] * meta["eqc_res"] - pad_m
    print("reading", name, "(slow: the file is stored row by row)"); t0 = time.time()
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="120", GDAL_HTTP_MAX_RETRY="4"):
        with rasterio.open("/vsicurl/" + BUCKET + name) as d:
            w = from_bounds(l, b, r, t, d.transform).round_offsets().round_lengths()
            a = d.read(1, window=w)
            tr = d.window_transform(w)
    out = {"a": a, "left": tr.c + shift, "top": tr.f, "res": tr.a}   # left is back in our lon_0 = 0 frame
    np.save(cache, out, allow_pickle=True)
    print("  %s in %.0fs" % (a.shape, time.time() - t0))
    return out


def to_grid(src, meta, order=1):
    """Resample a mosaic window onto the 40 m model grid."""
    H2, W2 = meta["H"] // STEP, meta["W"] // STEP
    res = meta["eqc_res"] * STEP
    x = meta["eqc_left"] + (np.arange(W2) + 0.5) * res
    y = meta["eqc_top"] - (np.arange(H2) + 0.5) * res
    cols = (x - src["left"]) / src["res"] - 0.5
    rows = (src["top"] - y) / src["res"] - 0.5
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    return ndimage.map_coordinates(src["a"].astype("float32"), [rr, cc], order=order, mode="nearest")


def main():
    meta = json.load(open(os.path.join(D, "meta.json")))
    Z = np.load(os.path.join(D, "elev.npy"))
    HOR = np.load(os.path.join(D, "horizon.npy"))[:, ::STEP, ::STEP]
    n_az = HOR.shape[0]
    gr, gc = np.gradient(Z, meta["DY"], meta["DX"])
    ge, gn = gc[::STEP, ::STEP], -gr[::STEP, ::STEP]
    nn = np.sqrt(ge**2 + gn**2 + 1)
    NX, NY, NZ = (-ge / nn).astype("float32"), (-gn / nn).astype("float32"), (1 / nn).astype("float32")
    SVF = (1 - np.sin(np.radians(HOR.astype("float32") / 2)).mean(0)).astype("float32")
    H2, W2 = NZ.shape

    # ---- real maps ----
    night = to_grid(window(NIGHT, meta, 180.0), meta)
    day = to_grid(window(DAY, meta, 180.0), meta)
    alb_src = window(ALBEDO, meta, 0.0, pad_m=20000)
    alb = np.clip(to_grid(alb_src, meta), 0.08, 0.4).astype("float32")
    lo, hi = np.percentile(night, (2, 98))
    TI = (TI_LO + (TI_HI - TI_LO) * np.clip((night - lo) / (hi - lo), 0, 1)).astype("float32")
    print(f"THEMIS night IR DN {lo:.0f}..{hi:.0f} -> thermal inertia {TI.min():.0f}..{TI.max():.0f} (median {np.median(TI):.0f});"
          f" TES albedo {alb.min():.3f}..{alb.max():.3f}")

    # ---- the Sun over one sol, from Horizons ----
    t0 = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    t0 -= timedelta(minutes=t0.minute % 5)
    n_steps = int(round(SOL / DT))                         # 296
    rows = fetch_passes.horizons("10", t0, t0 + timedelta(seconds=n_steps * DT), "5 m", "4,20")
    if len(rows) < n_steps:
        raise SystemExit("Horizons did not return the Sun for a full sol")
    sun = np.array([r[1][-4:] for r in rows[:n_steps]])    # az, el, range_km, range_rate
    S0 = 1361.0 / (sun[:, 2].mean() / 1.495978707e8) ** 2  # W/m2 at Mars right now
    noon = int(sun[:, 1].argmax())
    print(f"Sun: {S0:.0f} W/m2 at Mars, noon elevation {sun[noon,1]:.0f} deg, {int((sun[:,1] > 0).sum()*DT/3600*10)/10} h of daylight")
    ir_down = 0.04 * S0 * np.sin(np.radians(sun[noon, 1]))  # thin-atmosphere back radiation (KRC-style 4 % of noon sun)

    # ---- ground model: depth measured in diurnal skin depths, so every cell shares one matrix ----
    N = 16
    h = 0.08 * 1.25 ** np.arange(N)                        # layer thickness, ~11 skin depths in total
    kap = np.pi / SOL
    g = np.zeros(N + 1); g[0] = 2 / h[0]; g[1:N] = 2 / (h[:-1] + h[1:])    # conductance above layer j; bottom is insulated
    lo_c = DT * kap * g[:N] / h
    up_c = DT * kap * g[1:] / h
    P = np.zeros(N); den = np.zeros(N)
    for j in range(N - 1, 0, -1):                          # eliminate upward from the bottom (scalars)
        den[j] = 1 + lo_c[j] + up_c[j] - (up_c[j] * P[j + 1] if j < N - 1 else 0)
        P[j] = lo_c[j] / den[j]
    cond = TI * np.sqrt(np.pi / SOL) * g[0]                # W/m2/K from surface to first layer centre
    T = np.full((N, H2, W2), 205.0, "float32")
    Ts = np.full((H2, W2), 205.0, "float32")
    Q = np.zeros((N, H2, W2), "float32")
    slots = np.zeros((24, H2, W2), "int16")
    slot_at = {int(round(k * n_steps / 24)) % n_steps: k for k in range(24)}
    N_SOLS = 6
    t_run = time.time()
    for sol in range(N_SOLS):
        for i in range(n_steps):
            az, el = sun[i, 0], sun[i, 1]
            absorbed = np.full((H2, W2), EMIS * ir_down, "float32") * SVF
            if el > 0:
                a, e = np.radians(az), np.radians(el)
                mu0 = max(np.sin(e), 0.03)
                direct = S0 * np.exp(-TAU / mu0)
                cosi = np.clip(NX * np.sin(a) * np.cos(e) + NY * np.cos(a) * np.cos(e) + NZ * np.sin(e), 0, 1)
                lit = el * 2 > HOR[int(round(az / (360.0 / n_az))) % n_az]
                diffuse = S0 * mu0 * (1 - np.exp(-TAU / mu0)) * 0.85          # dust scatters mostly forward, to the ground
                absorbed += (1 - alb) * (direct * cosi * lit + diffuse * SVF)
            # linearised emission, solved together with conduction (implicit, stable)
            em = EMIS * SIGMA * SVF
            beta = cond / (4 * em * Ts**3 + cond)
            alpha = (absorbed + 3 * em * Ts**4) / (4 * em * Ts**3 + cond)
            Q[N - 1] = T[N - 1] / den[N - 1]
            for j in range(N - 2, 0, -1):
                Q[j] = (T[j] + up_c[j] * Q[j + 1]) / den[j]
            T[0] = (T[0] + up_c[0] * Q[1] + lo_c[0] * alpha) / (1 + lo_c[0] + up_c[0] - up_c[0] * P[1] - lo_c[0] * beta)
            Ts = np.maximum(alpha + beta * T[0], T_FROST)
            for j in range(1, N):
                T[j] = P[j] * T[j - 1] + Q[j]
            if sol == N_SOLS - 1 and i in slot_at:
                slots[slot_at[i]] = np.round(Ts * 10).astype("int16")
        print(f"  sol {sol+1}/{N_SOLS}  ground {Ts.min():.0f}..{Ts.max():.0f} K  ({time.time()-t_run:.0f}s)", flush=True)

    K = slots.astype("float32") / 10
    # ---- check against an independent observation: THEMIS day IR (taken mid/late afternoon) ----
    best = max(((float(np.corrcoef(K[k].ravel()[::7], day.ravel()[::7])[0, 1]), k) for k in range(24)))
    k_night = (int(round(noon / n_steps * 24)) + 16) % 24                  # ~04:00 local
    r_night = float(np.corrcoef(K[k_night].ravel()[::7], night.ravel()[::7])[0, 1])
    hab = fetch_passes.SITE
    hx = (meta["R"] * np.radians(hab["lon_e"]) - meta["eqc_left"]) / (meta["eqc_res"] * STEP)
    hy = (meta["eqc_top"] - meta["R"] * np.radians(hab["lat"])) / (meta["eqc_res"] * STEP)
    site = K[:, int(hy), int(hx)]
    out = {
        "t_ref": t0.timestamp(), "sol_s": SOL, "slots": 24, "step": STEP, "noon_slot": noon / n_steps * 24,
        "k_min": float(K.min()), "k_max": float(K.max()),
        "site_min_k": float(site.min()), "site_max_k": float(site.max()),
        "solar_w_m2": float(S0), "ti_range": [TI_LO, TI_HI], "tau": TAU,
        "check_day_ir_r": round(best[0], 3), "check_day_ir_slot": best[1], "check_night_ir_r": round(r_night, 3),
        "source": "THEMIS night IR 100 m + TES albedo + Horizons Sun + CTX slopes/shadows, 1-D ground heat model",
    }
    np.save(os.path.join(D, "heat.npy"), slots)
    np.save(os.path.join(D, "thermal_inertia.npy"), TI)
    json.dump(out, open(os.path.join(D, "heat_meta.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))
    print(f"habitat ground: {site.min()-273.15:.0f} C before dawn to {site.max()-273.15:.0f} C after noon")


if __name__ == "__main__":
    main()
