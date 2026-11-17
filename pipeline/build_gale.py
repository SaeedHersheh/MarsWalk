"""Gale crater (Curiosity, Bradbury Landing) as a second detailed site, built like Jezero.

Sources (USGS Astrogeology, MSL mission products, streamed from the USGS cloud bucket):
  elevation  MSL Gale Merged DEM 1 m v3 (HiRISE stereo, Parker & Calef), read through its 4 m overview
             https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif
  image      MSL Gale Merged Orthophoto 25 cm v3 (HiRISE RED), read through its 8 m overview
             https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif

Same grids as Jezero: 20 m planning cells (mean of 5 x 5 cells of 4 m), slope hazard from 4 m
(steep end of each 20 m cell, like build_hirise.py), horizons for comms, shadows and sky view.
No heat model here (THEMIS/TES heat is Jezero only).

Output: data/sites/gale/{meta.json, elev.npy, valid.npy, horizon.npy, slope_hr.npy, slope10.npy}
        web/data/sites/gale.bin   web/img/sites/gale.jpg   web/img/sites/gale_2k.jpg

Run:  .venv/Scripts/python pipeline/build_gale.py
"""
import json, os, sys, time
import numpy as np
import rasterio
from rasterio.windows import Window, from_bounds
from rasterio.enums import Resampling
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from build_terrain import horizon_grid, R_MARS  # noqa: E402

SID = "gale"
BASE = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/"
DEM = BASE + "MSL_Gale_DEM_Mosaic_1m_v3.tif"
ORTHO = BASE + "MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif"
LANDING = {"name": SID, "lon_e": 137.4417, "lat": -4.5895, "elev_km": -4.5}   # Bradbury Landing (NASA/JPL)
CELL = 20.0              # planning cell, metres (same as Jezero)
FINE = 4.0               # DEM overview used, metres (1 m DEM, overview level 0 = x4)
F = int(CELL / FINE)     # 5 x 5 fine cells per planning cell
# Crop of the DEM (metres from its top-left corner): the full 33 km width, 36 km from 13.2 km below its top.
# That holds Bradbury Landing (14 km below the crop top) and Curiosity's climb into the Mount Sharp foothills.
ROW0_M, H_M = 13220, 36000
HORIZON_MAX_M = 20000.0  # the crater floor is wide open: let ridges further away block the sky too
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="YES", GDAL_HTTP_TIMEOUT="120", GDAL_HTTP_MAX_RETRY="4",
           CPL_VSIL_CURL_CHUNK_SIZE="4194304", GDAL_HTTP_MULTIRANGE="YES")

DDIR = os.path.join(ROOT, "data", "sites", SID)
for d in (DDIR, os.path.join(ROOT, "web/data/sites"), os.path.join(ROOT, "web/img/sites")):
    os.makedirs(d, exist_ok=True)


def read_fine():
    """The DEM crop at 4 m, cached. NaN = no data."""
    cache = os.path.join(DDIR, "raw_dem4.npy")
    with rasterio.Env(**ENV):
        with rasterio.open("/vsicurl/" + DEM) as d:
            left, top, nod, crs = d.bounds.left, d.bounds.top, d.nodata, d.crs
            W = int(d.width // CELL)
        if os.path.exists(cache):
            z4 = np.load(cache)
        else:
            t = time.time()
            with rasterio.open("/vsicurl/" + DEM, OVERVIEW_LEVEL=0) as d:
                assert abs(d.res[0] - FINE) < 1e-6
                r0, nrow, ncol = int(ROW0_M / FINE), int(H_M / FINE), W * F
                z4 = np.empty((nrow, ncol), "float32")
                for a in range(0, nrow, 500):                  # in strips, so progress shows
                    b = min(nrow, a + 500)
                    z4[a:b] = d.read(1, window=Window(0, r0 + a, ncol, b - a))
                    print(f"  DEM 4 m rows {b}/{nrow}  {time.time()-t:.0f}s", flush=True)
            z4[z4 <= nod + 1] = np.nan
            np.save(cache, z4)
    return z4, left, top - ROW0_M, crs


def basemap(left, top, W, H, valid):
    """HiRISE orthophoto at 8 m, warm-tinted like Jezero (the mosaic is greyscale, Mars is not)."""
    right, bottom = left + W * CELL, top - H * CELL
    out_w, out_h = int(W * CELL / 8), int(H * CELL / 8)
    with rasterio.Env(**ENV):
        with rasterio.open("/vsicurl/" + ORTHO, OVERVIEW_LEVEL=3) as d:        # 25 cm x 32 = 8 m
            o = d.read(1, window=from_bounds(left, bottom, right, top, d.transform), out_shape=(out_h, out_w),
                       resampling=Resampling.bilinear, boundless=True, fill_value=0).astype("float32")
    lo, hi = np.percentile(o[o > 0], (1, 99.5))
    g = np.clip((o - lo) / (hi - lo), 0, 1) ** 0.9
    rgb = np.stack([g * 1.00, g * 0.80, g * 0.66], -1)
    rgb = (np.clip(rgb, 0, 1) * 255).astype("uint8")
    rgb[o == 0] = (8, 8, 10)
    im = Image.fromarray(rgb)
    im.save(os.path.join(ROOT, "web/img/sites", SID + ".jpg"), quality=86)
    im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(os.path.join(ROOT, "web/img/sites", SID + "_2k.jpg"), quality=88)
    print("basemap", im.size)


def main():
    t0 = time.time()
    z4, left, top, _ = read_fine()
    H, W = z4.shape[0] // F, z4.shape[1] // F
    blocks = z4[:H * F, :W * F].reshape(H, F, W, F).transpose(0, 2, 1, 3).reshape(H, W, F * F)
    n_ok = np.isfinite(blocks).sum(-1)
    valid = n_ok >= (F * F) // 2 + 1                                   # most of the cell has data
    with np.errstate(all="ignore"):
        z = np.nanmean(blocks, -1).astype("float32")
    lat0 = float(np.degrees((top - H * CELL / 2) / R_MARS))
    DY, DX = CELL, float(CELL * np.cos(np.radians(lat0)))
    print(f"grid {W}x{H}, cell {DX:.2f} x {DY:.2f} m, valid {valid.mean()*100:.1f}%")
    idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    z = z[tuple(idx)]                                                  # holes: nearest value, still no-go via valid
    np.save(os.path.join(DDIR, "elev.npy"), z)
    np.save(os.path.join(DDIR, "valid.npy"), valid)
    np.save(os.path.join(DDIR, "horizon.npy"), horizon_grid(z, DX, DY, max_m=HORIZON_MAX_M))
    np.round(z / 0.2).astype("<i2").tofile(os.path.join(ROOT, "web/data/sites", SID + ".bin"))   # units of 20 cm (int16 holds +-6.5 km)

    # slope hazard at 4 m, as build_hirise.py does at 5 m for Jezero
    fy, fx = FINE, FINE * np.cos(np.radians(lat0))
    gr, gc = np.gradient(z4, fy, fx)
    s4 = np.degrees(np.arctan(np.hypot(gr, gc))).astype("float32")
    del gr, gc
    sb = s4[:H * F, :W * F].reshape(H, F, W, F).transpose(0, 2, 1, 3).reshape(H, W, F * F)
    full = np.isfinite(sb).sum(-1) >= F * F - 2
    with np.errstate(all="ignore"):
        hr = np.where(full, np.nanpercentile(sb, 88, axis=-1), np.nan).astype("float32")   # about the 3rd steepest of 25
    np.save(os.path.join(DDIR, "slope_hr.npy"), hr)
    # 10 m display slope: steepest 4 m slope within about 6 m of each 10 m cell centre; 20 m slope fills gaps
    with np.errstate(all="ignore"):
        smax = ndimage.maximum_filter(np.nan_to_num(s4, nan=-1), size=3)
    ri = np.minimum(((np.arange(2 * H) + 0.5) * 10 / FINE).astype(int), s4.shape[0] - 1)
    ci = np.minimum(((np.arange(2 * W) + 0.5) * 10 / FINE).astype(int), s4.shape[1] - 1)
    s10 = smax[np.ix_(ri, ci)]
    cr, cc = np.gradient(z, DY, DX)
    up = np.repeat(np.repeat(np.degrees(np.arctan(np.hypot(cr, cc))), 2, 0), 2, 1)
    s10 = np.where(s10 >= 0, s10, up)
    np.save(os.path.join(DDIR, "slope10.npy"), np.clip(np.round(s10 * 3), 0, 255).astype("uint8"))
    m = np.isfinite(hr)
    print("4 m slope over %.1f%% of the map; cells over 25 deg: 20 m %.2f%%, 4 m %.2f%%" % (
        m.mean() * 100, (up[::2, ::2][m] > 25).mean() * 100, (hr[m] > 25).mean() * 100))
    del s4, smax

    basemap(left, top, W, H, valid)
    meta = {
        "W": W, "H": H, "DX": DX, "DY": DY, "width_m": W * DX, "height_m": H * DY,
        "eqc_left": float(left), "eqc_top": float(top), "eqc_res": CELL, "R": R_MARS,
        "lat0": lat0, "n_az": 16, "zmin": float(z[valid].min()), "zmax": float(z[valid].max()),
        "source": "USGS Astrogeology MSL Gale merged DEM 1 m (HiRISE stereo) at 20 m + 4 m slope; "
                  "MSL Gale HiRISE orthophoto 25 cm",
        "id": SID, "kind": "detail", "label": "Gale crater", "res_label": "HiRISE DEM 20 m",
        "habitat_name": "Bradbury Landing", "site": LANDING,
        "elev_url": f"data/sites/{SID}.bin", "elev_scale": 0.2,
        "basemap": f"img/sites/{SID}.jpg", "basemap_3d": f"img/sites/{SID}_2k.jpg",
    }
    json.dump(meta, open(os.path.join(DDIR, "meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))
    print("Gale built in %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
