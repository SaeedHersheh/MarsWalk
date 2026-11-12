"""Optional step: sharpen the slope layer with the HiRISE 1 m DTM.

The CTX grid is 20 m, which smooths away small scarps and boulders fields.
Here the 1 m HiRISE DTM is averaged to 5 m (kills 1 m noise), slope is taken
at 5 m, and each 20 m planner cell gets the steep end of its sixteen 5 m slopes.

Output (data/): slope_hr.npy   (H, W) float32, NaN outside HiRISE coverage
                slope10.npy    (2H, 2W) uint8 deg*3, for the map layer

Run:  .venv/Scripts/python pipeline/build_hirise.py [path-to-hirise-dtm.tif]
"""
import json, os, sys, time
import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import reproject, Resampling

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT = r"C:\Users\VICTUS\Documents\Layers\JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
F = 4            # 20 m cell = 4 x 4 cells of 5 m


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    meta = json.load(open(os.path.join(DATA, "meta.json")))
    W, H, res = meta["W"], meta["H"], meta["eqc_res"]
    fine = res / F
    t = time.time()
    with rasterio.open(path) as src:
        print("HiRISE", src.width, "x", src.height, "at", src.res[0], "m")
        z5 = np.full((H * F, W * F), np.nan, "float32")
        reproject(rasterio.band(src, 1), z5, src_nodata=src.nodata, dst_nodata=np.nan,
                  dst_transform=Affine(fine, 0, meta["eqc_left"], 0, -fine, meta["eqc_top"]),
                  dst_crs=src.crs, resampling=Resampling.average, num_threads=4, warp_mem_limit=1024)
    print("averaged to %.0f m in %.0fs, coverage %.1f%% of the map" % (fine, time.time() - t, np.isfinite(z5).mean() * 100))

    dy = fine
    dx = fine * np.cos(np.radians(meta["lat0"]))
    gr, gc = np.gradient(z5, dy, dx)
    s5 = np.degrees(np.arctan(np.hypot(gr, gc))).astype("float32")
    del z5, gr, gc

    # per 20 m cell: 3rd steepest of 16 (about the 85th percentile), robust to single-pixel DTM artefacts
    blocks = s5.reshape(H, F, W, F).transpose(0, 2, 1, 3).reshape(H, W, F * F)
    full = np.isfinite(blocks).all(-1)
    hr = np.where(full, np.sort(blocks, -1)[..., -3], np.nan).astype("float32")
    np.save(os.path.join(DATA, "slope_hr.npy"), hr)

    # 10 m slope for display: steepest of each 2 x 2, CTX fills the gaps
    ctx = np.load(os.path.join(DATA, "elev.npy"))
    cr, cc = np.gradient(ctx, meta["DY"], meta["DX"])
    ctx_s = np.degrees(np.arctan(np.hypot(cr, cc))).astype("float32")
    with np.errstate(all="ignore"):
        s10 = np.nanmax(s5.reshape(H * 2, 2, W * 2, 2).transpose(0, 2, 1, 3).reshape(H * 2, W * 2, 4), -1)
    up = np.repeat(np.repeat(ctx_s, 2, 0), 2, 1)
    s10 = np.where(np.isfinite(s10), s10, up)
    np.save(os.path.join(DATA, "slope10.npy"), np.clip(np.round(s10 * 3), 0, 255).astype("uint8"))

    m = np.isfinite(hr)
    print("inside HiRISE coverage (%d cells):" % m.sum())
    for lim in (15, 25):
        print("  cells steeper than %d deg:  CTX 20 m %.2f%%   HiRISE %.2f%%" % (lim, (ctx_s[m] > lim).mean() * 100, (hr[m] > lim).mean() * 100))
    print("  median slope: CTX %.1f deg, HiRISE %.1f deg" % (np.median(ctx_s[m]), np.median(hr[m])))


if __name__ == "__main__":
    main()
