"""Spectral layer: the minerals CRISM sees at Jezero, on the planner's 20 m grid.

Input  data/raw/jezeroFinal.tif  Mineral map of the Mars 2020 landing area from MRO CRISM (observations HRL000040FF,
       FRT000047A3, FRT00005C5E, FRS00031442), by Parente, Saranathan and Itoh (UMass Amherst), Zenodo record 5575824,
       CC BY 4.0. Co-registered to the USGS Mars 2020 CTX/HiRISE products, 36 m pixels, equirectangular (same frame as
       our Jezero grid). Each RGB code is one mineral class at high or medium confidence (key in the record's readme).
Output data/minerals.npy  uint8 per cell: class 1..10, +16 when the detection is high confidence, 0 = nothing identified.

Run:  .venv/Scripts/python pipeline/build_minerals.py
"""
import json, os
import numpy as np
import rasterio

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "data")
SRC = os.path.join(D, "raw", "jezeroFinal.tif")

# class id: name, high-confidence RGB, medium-confidence RGB (from the record's readme, "Key for Mineral Detections")
KEY = {
    1: ("Olivine", (255, 0, 0), (153, 0, 0)),
    2: ("Mg-carbonate", (0, 255, 0), (0, 153, 0)),
    3: ("Fe/Mg-smectite clay", (0, 255, 255), (0, 153, 153)),
    4: ("Olivine + smectite", (255, 128, 114), (153, 77, 68)),
    5: ("Olivine, smectite + 2.2 µm phase", (128, 128, 0), (77, 77, 0)),
    6: ("Carbonate + 2.2 µm phase", (255, 215, 0), (153, 129, 0)),
    7: ("High-calcium pyroxene", (255, 128, 0), (153, 77, 0)),
    8: ("Low-calcium pyroxene", (218, 165, 32), (130, 99, 19)),
    9: ("Kaolinite clay", (139, 69, 19), (83, 41, 11)),
    10: ("Mg-smectite clay", (0, 0, 255), (0, 0, 153)),
}


def main():
    m = json.load(open(os.path.join(D, "meta.json")))
    with rasterio.open(SRC) as d:
        rgb = d.read().transpose(1, 2, 0).astype("int16"); tr = d.transform
    # every pixel to its class: nearest key colour, only when it really matches (the map holds exact codes)
    cls = np.zeros(rgb.shape[:2], "uint8")
    for k, (_, hi, md) in KEY.items():
        for code, add in ((hi, 16), (md, 0)):
            hit = (np.abs(rgb - np.array(code)).sum(-1) <= 6)
            cls[hit] = k + add
    # onto our grid: cell centres in the shared equirectangular frame, nearest mineral pixel
    W, H, res = m["W"], m["H"], m["eqc_res"]
    E = m["eqc_left"] + (np.arange(W) + 0.5) * res
    N = m["eqc_top"] - (np.arange(H) + 0.5) * res
    col = np.floor((E - tr.c) / tr.a).astype(int); row = np.floor((N - tr.f) / tr.e).astype(int)
    rr, cc = np.meshgrid(row, col, indexing="ij")
    ok = (rr >= 0) & (rr < cls.shape[0]) & (cc >= 0) & (cc < cls.shape[1])
    out = np.zeros((H, W), "uint8"); out[ok] = cls[rr[ok], cc[ok]]
    np.save(os.path.join(D, "minerals.npy"), out)
    json.dump({"source": "MRO CRISM mineral map of Jezero (Parente, Saranathan, Itoh; UMass Amherst; Zenodo 5575824; CC BY 4.0)",
               "classes": {str(k): {"name": v[0], "hi": v[1], "md": v[2]} for k, v in KEY.items()}},
              open(os.path.join(D, "minerals_meta.json"), "w"), indent=1)
    have = {KEY[k][0]: int(((out % 16) == k).sum()) for k in KEY}
    print("cells mapped:", int(ok.sum()), "with a mineral:", int((out > 0).sum()), have)


if __name__ == "__main__":
    main()
