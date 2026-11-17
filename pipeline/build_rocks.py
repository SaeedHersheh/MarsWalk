"""Rocky ground: where boulders and bare rock are likely, from Mars Odyssey THEMIS night-time infrared.

Why it works: at night, loose dust and sand cool fast while rock and boulder fields hold the day's heat, so they stay
warmer (high thermal inertia). The THEMIS night-IR mosaic (100 m, controlled mosaics v2, served by NASA Mars Trek)
shows exactly that. We take the warmer-than-typical part of each map as "rocky", from 0 (typical ground) to 1 (the
warmest few percent). It is a proxy: it shows rock-rich areas, not single boulders. Coverage: 60 N to 60 S.

Output data/<site>/rock.npy  float16 0..1 on the site's grid (NaN where THEMIS has no data)
Run:   .venv/Scripts/python pipeline/build_rocks.py [site_id ... | all]
"""
import io, json, os, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import requests
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "data")
TILE = ("https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/"
        "default/default028mm/{z}/{r}/{c}.png")
Z = 9                       # 256 px tiles, 360 deg over 1024 tiles: about 81 m per pixel
SPAN = 180.0 / 2 ** Z


def site_dir(sid):
    return D if sid == "jezero" else os.path.join(D, "sites", sid)


def tile(rc):
    r, c = rc
    for _ in range(3):
        try:
            q = requests.get(TILE.format(z=Z, r=r, c=c), timeout=40)
            if q.status_code == 200:
                im = np.asarray(Image.open(io.BytesIO(q.content)).convert("LA")).astype("float32")
                return rc, im[..., 0], im[..., 1] > 0
            if q.status_code == 404:
                break
        except requests.RequestException:
            pass
    return rc, None, None


def build(sid, log=print):
    d = site_dir(sid); m = json.load(open(os.path.join(d, "meta.json")))
    W, H, res, R = m["W"], m["H"], m["eqc_res"], m["R"]
    lon = np.degrees((m["eqc_left"] + (np.arange(W) + 0.5) * res) / R)
    lat = np.degrees((m["eqc_top"] - (np.arange(H) + 0.5) * res) / R)
    lon = ((lon + 180) % 360) - 180
    if lat.min() > 60 or lat.max() < -60:
        log(f"{sid}: outside THEMIS night coverage (60N-60S)"); return False
    gx = (lon + 180) / SPAN * 256; gy = (90 - lat) / SPAN * 256          # global pixel coordinates at this zoom
    c0, c1 = int(gx.min() // 256), int(gx.max() // 256); r0, r1 = int(gy.min() // 256), int(gy.max() // 256)
    mos = np.zeros(((r1 - r0 + 1) * 256, (c1 - c0 + 1) * 256), "float32"); ok = np.zeros_like(mos, bool)
    jobs = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    with ThreadPoolExecutor(8) as ex:
        for (r, c), v, a in ex.map(tile, jobs):
            if v is not None:
                mos[(r - r0) * 256:(r - r0 + 1) * 256, (c - c0) * 256:(c - c0 + 1) * 256] = v
                ok[(r - r0) * 256:(r - r0 + 1) * 256, (c - c0) * 256:(c - c0 + 1) * 256] = a
    yy, xx = np.meshgrid(gy - r0 * 256 - 0.5, gx - c0 * 256 - 0.5, indexing="ij")
    v = ndimage.map_coordinates(mos, [yy, xx], order=1, mode="nearest")
    good = ndimage.map_coordinates(ok.astype("float32"), [yy, xx], order=0, mode="nearest") > 0.5
    if good.mean() < 0.2:
        log(f"{sid}: THEMIS night has too little data here"); return False
    p50, p98 = np.percentile(v[good], (50, 98))
    rock = np.clip((v - p50) / max(p98 - p50, 1e-6), 0, 1).astype("float32")
    rock = ndimage.gaussian_filter(rock, 0.8)                             # no single-pixel speckle
    rock[~good] = np.nan
    np.save(os.path.join(d, "rock.npy"), rock.astype("float16"))
    log(f"{sid}: rock layer {rock.shape}, {len(jobs)} tiles, rocky (>0.5) {np.nanmean(rock > 0.5) * 100:.1f}% of the map")
    return True


if __name__ == "__main__":
    ids = sys.argv[1:] or ["jezero"]
    if ids == ["all"]:
        ids = ["jezero"] + sorted(s for s in os.listdir(os.path.join(D, "sites")) if os.path.exists(os.path.join(D, "sites", s, "meta.json")))
    for s in ids:
        try:
            build(s)
        except Exception as e:
            print(s, "failed:", e)
