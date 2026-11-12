"""Step 1 of the pipeline: real Jezero terrain -> grids the API can load.

Source: USGS Astrogeology Mars 2020 terrain-relative-navigation products
  CTX DTM 20 m  + CTX orthomosaic 6 m  (MRO Context Camera, tied to MOLA)
Output (data/): elev.npy, horizon.npy, valid.npy, meta.json
Output (web/img/): basemap.jpg, basemap_2k.jpg
Output (web/data/): elev_i16.bin  (decimetres, for hover readout + 3D mesh)

Run:  .venv/Scripts/python pipeline/build_terrain.py
"""
import json, os, sys, time
import numpy as np
import rasterio
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA, IMG, WDATA = (os.path.join(ROOT, p) for p in ("data", "web/img", "web/data"))
for d in (DATA, IMG, WDATA):
    os.makedirs(d, exist_ok=True)

BASE = "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/"
DTM_URL = BASE + "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif"
ORTHO_URL = BASE + "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif"
R_MARS = 3396190.0          # sphere radius used by the product's projection
N_AZ = 16                   # horizon directions
HORIZON_MAX_M = 8000.0      # how far a ridge can be and still block the sky


def read_remote(url, cache):
    path = os.path.join(DATA, cache)
    if os.path.exists(path):
        return np.load(path, allow_pickle=True).item()
    print("downloading", url.rsplit("/", 1)[1]); t = time.time()
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="120",
                      GDAL_HTTP_MAX_RETRY="4", CPL_VSIL_CURL_CHUNK_SIZE="4194304"):
        with rasterio.open("/vsicurl/" + url) as d:
            out = {"a": d.read(1), "bounds": tuple(d.bounds), "res": d.res, "nodata": d.nodata}
    np.save(path, out, allow_pickle=True)
    print("  done in %.0fs" % (time.time() - t), out["a"].shape)
    return out


def shifted(z, drow, dcol):
    """z sampled at (row+drow, col+dcol); NaN outside the grid."""
    H, W = z.shape
    out = np.full_like(z, np.nan)
    r0, r1 = max(0, -drow), min(H, H - drow)
    c0, c1 = max(0, -dcol), min(W, W - dcol)
    if r0 < r1 and c0 < c1:
        out[r0:r1, c0:c1] = z[r0 + drow:r1 + drow, c0 + dcol:c1 + dcol]
    return out


def main():
    dtm = read_remote(DTM_URL, "raw_dtm.npy")
    z = dtm["a"].astype("float32")
    valid = z > -1e30
    left, bottom, right, top = dtm["bounds"]
    H, W = z.shape
    lat0 = np.degrees((top + bottom) / 2 / R_MARS)
    DY = float(dtm["res"][1])
    DX = float(dtm["res"][0] * np.cos(np.radians(lat0)))   # true metres east per column
    print(f"grid {W}x{H}, cell {DX:.2f} x {DY:.2f} m, valid {valid.mean()*100:.1f}%")

    # fill holes with nearest valid value so gradients behave; holes stay no-go via valid mask
    if not valid.all():
        from scipy import ndimage
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        z = z[tuple(idx)]
    np.save(os.path.join(DATA, "elev.npy"), z)
    np.save(os.path.join(DATA, "valid.npy"), valid)

    # horizon angle per azimuth (deg*2 in uint8). Used for: comms line of sight,
    # cast shadows, and sky-view factor for the radiation model.
    t = time.time()
    dists = np.unique(np.round(np.geomspace(DY, HORIZON_MAX_M, 44) / DY).astype(int)) * DY
    hor = np.zeros((N_AZ, H, W), dtype="uint8")
    for k in range(N_AZ):
        az = np.radians(k * 360.0 / N_AZ)             # clockwise from north
        best = np.zeros_like(z)
        for d in dists:
            dcol = int(round(d * np.sin(az) / DX))
            drow = int(round(-d * np.cos(az) / DY))    # row 0 is north
            if dcol == 0 and drow == 0:
                continue
            dist = np.hypot(dcol * DX, drow * DY)
            dz = shifted(z, drow, dcol) - z - dist * dist / (2 * R_MARS)   # planet curvature
            ang = np.degrees(np.arctan2(dz, dist))
            np.fmax(best, ang, out=best)
        hor[k] = np.clip(np.round(best * 2), 0, 180).astype("uint8")
        print(f"  horizon az {k*360//N_AZ:3d} deg  max {best.max():.1f}", flush=True)
    np.save(os.path.join(DATA, "horizon.npy"), hor)
    print("horizons in %.0fs" % (time.time() - t))

    # elevation for the browser: int16 decimetres, row 0 = north
    (np.round(z * 10)).astype("<i2").tofile(os.path.join(WDATA, "elev_i16.bin"))

    # basemap from the 6 m orthomosaic
    ortho = read_remote(ORTHO_URL, "raw_ortho.npy")
    o = ortho["a"]
    ncols = int(round((right - left) / ortho["res"][0]))
    o = o[:, :ncols]
    lo, hi = np.percentile(o[o > 0], (1, 99.5))
    g = np.clip((o.astype("float32") - lo) / (hi - lo), 0, 1) ** 0.9
    # warm tint: the mosaic is greyscale, Mars is not
    rgb = np.stack([g * 1.00, g * 0.80, g * 0.66], -1)
    rgb = (np.clip(rgb, 0, 1) * 255).astype("uint8")
    rgb[o == 0] = (8, 8, 10)
    im = Image.fromarray(rgb)
    im.save(os.path.join(IMG, "basemap.jpg"), quality=86)
    im.resize((im.width // 2, im.height // 2), Image.LANCZOS).save(os.path.join(IMG, "basemap_2k.jpg"), quality=88)
    print("basemap", im.size)

    meta = {
        "W": W, "H": H, "DX": DX, "DY": DY,
        "width_m": W * DX, "height_m": H * DY,
        "eqc_left": left, "eqc_top": top, "eqc_res": float(dtm["res"][0]), "R": R_MARS,
        "lat0": float(lat0), "n_az": N_AZ,
        "zmin": float(z[valid].min()), "zmax": float(z[valid].max()),
        "source": "USGS Astrogeology, Mars 2020 TRN CTX DTM 20 m + CTX orthomosaic 6 m (MRO CTX, MOLA-tied)",
    }
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    sys.exit(main())
