"""Build a planning site ANYWHERE on Mars from global data (coarse: 463 m cells).

  elevation  MOLA MEGDR 463 m (Mars Global Surveyor), read as a window from the USGS cloud GeoTIFF
  image      Viking MDIM 2.1 colour mosaic 232 m, from NASA Mars Trek tiles, shaded with MOLA relief
  horizons   computed here (comms line of sight, shadows, sky view)

Output: data/sites/<id>/{meta.json, elev.npy, valid.npy, horizon.npy}
        web/data/sites/<id>.bin   web/img/sites/<id>.jpg

Run:  .venv/Scripts/python pipeline/build_site.py <lat> <lon_east> [name]
The API calls build() when someone clicks "Plan a walk here" on the globe.
"""
import io, json, os, sys, time
import numpy as np
import rasterio
import requests
from rasterio.windows import Window
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))
from build_terrain import shifted  # noqa: E402

MOLA = ("https://asc-pds-services.s3.us-west-2.amazonaws.com/wms_basemaps3/Mars/MOLA/"
        "mola128_mola64_merge_90Nto90S_SimpleC_clon0_cog.tif")
TREK = "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{r}/{c}.jpg"
N = 384                   # cells per side: about 178 km north-south
N_AZ = 16
HORIZON_MAX_M = 40000.0


def site_id(lat, lon):
    return f"{'n' if lat >= 0 else 's'}{abs(lat):05.2f}_{'e' if lon >= 0 else 'w'}{abs(lon):06.2f}".replace(".", "p")


def label(lat, lon):
    return f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'} {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"


def trek_image(lon0, lon1, lat0, lat1, z=7):
    """Stitch Trek tiles covering a lon/lat box (degrees, lon -180..180). Returns a PIL image of exactly that box."""
    span = 180.0 / 2 ** z
    c0, c1 = int((lon0 + 180) // span), int((lon1 + 180) // span)
    r0, r1 = int((90 - lat1) // span), int((90 - lat0) // span)
    mosaic = Image.new("RGB", ((c1 - c0 + 1) * 256, (r1 - r0 + 1) * 256))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            q = requests.get(TREK.format(z=z, r=r, c=c % (2 * 2 ** z)), timeout=30)
            q.raise_for_status()
            mosaic.paste(Image.open(io.BytesIO(q.content)).convert("RGB"), ((c - c0) * 256, (r - r0) * 256))
    px = 256 / span
    box = ((lon0 + 180) * px - c0 * 256, (90 - lat1) * px - r0 * 256, (lon1 + 180) * px - c0 * 256, (90 - lat0) * px - r0 * 256)
    return mosaic.crop(tuple(int(round(v)) for v in box))


def build(lat, lon, name=None, log=print):
    lon = ((lon + 180) % 360) - 180
    lat = float(np.clip(lat, -84, 84))
    sid = site_id(lat, lon)
    ddir = os.path.join(ROOT, "data", "sites", sid)
    if os.path.exists(os.path.join(ddir, "meta.json")):
        return sid
    for d in (ddir, os.path.join(ROOT, "web/data/sites"), os.path.join(ROOT, "web/img/sites")):
        os.makedirs(d, exist_ok=True)
    t0 = time.time()
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="60", GDAL_HTTP_MAX_RETRY="3"):
        with rasterio.open("/vsicurl/" + MOLA) as d:
            R, res = 3396190.0, d.res[0]
            left0, top0 = d.bounds.left, d.bounds.top
            # the MOLA grid is equal-angle, so a degree of longitude shrinks towards the poles: take more columns there so the site stays square on the ground
            NW = int(min(round(N / max(np.cos(np.radians(lat)), 0.2)), 3 * N))
            col = int(np.clip((R * np.radians(lon) - left0) / res - NW / 2, 0, d.width - NW))
            row = int(np.clip((top0 - R * np.radians(lat)) / res - N / 2, 0, d.height - N))
            z = d.read(1, window=Window(col, row, NW, N)).astype("float32")
            nodata = d.nodata
    log(f"MOLA window {z.shape} in {time.time()-t0:.0f}s")
    valid = z != nodata
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        z = z[tuple(idx)]
    left, top = left0 + col * res, top0 - row * res
    lat0 = float(np.degrees((top - N * res / 2) / R))
    DY, DX = float(res), float(res * np.cos(np.radians(lat0)))

    dists = np.unique(np.round(np.geomspace(DY, HORIZON_MAX_M, 30) / DY).astype(int)) * DY
    hor = np.zeros((N_AZ, N, NW), "uint8")
    for k in range(N_AZ):
        az = np.radians(k * 360.0 / N_AZ)
        best = np.zeros_like(z)
        for dd in dists:
            dcol, drow = int(round(dd * np.sin(az) / DX)), int(round(-dd * np.cos(az) / DY))
            if dcol == 0 and drow == 0:
                continue
            dist = np.hypot(dcol * DX, drow * DY)
            ang = np.degrees(np.arctan2(shifted(z, drow, dcol) - z - dist * dist / (2 * R), dist))
            np.fmax(best, ang, out=best)
        hor[k] = np.clip(np.round(best * 2), 0, 180).astype("uint8")
    np.save(os.path.join(ddir, "elev.npy"), z)
    np.save(os.path.join(ddir, "valid.npy"), valid)
    np.save(os.path.join(ddir, "horizon.npy"), hor)
    np.round(z).astype("<i2").tofile(os.path.join(ROOT, "web/data/sites", sid + ".bin"))   # metres

    # basemap: Viking colour x MOLA relief
    lon_a, lon_b = np.degrees(left / R), np.degrees((left + NW * res) / R)
    lat_b, lat_a = np.degrees(top / R), np.degrees((top - N * res) / R)
    out_h = 1536; out_w = int(round(out_h * NW * DX / (N * DY)))
    gr, gc = np.gradient(z, DY, DX)
    nn = np.sqrt(gc**2 + gr**2 + 1)
    shade = np.clip((gc * 0.5 + gr * 0.5 + 0.707) / nn / 0.707, 0.2, 1.5)      # light from the north-west
    shade = np.asarray(Image.fromarray(shade.astype("float32")).resize((out_w, out_h), Image.BICUBIC))
    try:
        img = np.asarray(trek_image(lon_a, lon_b, lat_a, lat_b).resize((out_w, out_h), Image.LANCZOS)).astype("float32")
        src = "Viking MDIM 2.1 colour mosaic 232 m (NASA Mars Trek) shaded with MOLA relief"
    except Exception as e:                                                      # tiles down: relief only
        log(f"Trek tiles failed ({e}); using relief only")
        img = np.full((out_h, out_w, 3), (190, 140, 105), "float32")
        src = "MOLA shaded relief"
    rgb = np.clip(img * (0.62 + 0.4 * np.clip(shade[..., None], 0.3, 1.15)), 0, 255).astype("uint8")
    Image.fromarray(rgb).save(os.path.join(ROOT, "web/img/sites", sid + ".jpg"), quality=88)

    cz = float(z[N // 2, NW // 2])
    meta = {
        "W": NW, "H": N, "DX": DX, "DY": DY, "width_m": NW * DX, "height_m": N * DY,
        "eqc_left": left, "eqc_top": top, "eqc_res": float(res), "R": R, "lat0": lat0, "n_az": N_AZ,
        "zmin": float(z.min()), "zmax": float(z.max()),
        "source": f"MOLA MEGDR 463 m elevation (Mars Global Surveyor); image: {src}",
        "id": sid, "kind": "region", "label": name or label(lat, lon),
        "site": {"name": sid, "lon_e": float(lon), "lat": float(lat), "elev_km": round(cz / 1000, 2)},
        "elev_url": f"data/sites/{sid}.bin", "elev_scale": 1.0,
        "basemap": f"img/sites/{sid}.jpg", "basemap_3d": f"img/sites/{sid}.jpg",
    }
    json.dump(meta, open(os.path.join(ddir, "meta.json"), "w"), indent=1)
    log(f"site {sid} built in {time.time()-t0:.0f}s, elevation {z.min():.0f}..{z.max():.0f} m")
    return sid


if __name__ == "__main__":
    print(build(float(sys.argv[1]), float(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None))
