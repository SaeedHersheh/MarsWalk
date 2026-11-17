<div align="center">

<img src="../web/img/brand/logo-512.png" alt="AirAwareNetwork logo" width="110">

# Marswalk — Data Pipelines

**From NASA rasters and orbits to planning layers**

`Python 3.13` · `rasterio` · `NumPy` · `SciPy` · `scikit-image` · `JPL Horizons API`

</div>

---

```
        ╔═══════════════════════════════════════════════════════╗
        ║                                                       ║
        ║   Five pipelines, all reading public NASA and USGS    ║
        ║   data straight from the source.                      ║
        ║                                                       ║
        ║   global site   ▸  MOLA         ▸  about 1 minute     ║
        ║   Jezero        ▸  CTX + HiRISE ▸  about 3 minutes    ║
        ║   ground heat   ▸  THEMIS + TES ▸  about 10 minutes   ║
        ║   passes        ▸  JPL Horizons ▸  every 6 hours      ║
        ║                                                       ║
        ╚═══════════════════════════════════════════════════════╝
```

---

## Contents

| # | Section |
|---|---|
| 1 | [Overview](#1--overview) |
| 2 | [From QGIS to Python](#2--from-qgis-to-python) |
| 3 | [Global Sites — build_site](#3--global-sites--build_site) |
| 4 | [Jezero Terrain — build_terrain](#4--jezero-terrain--build_terrain) |
| 5 | [HiRISE Slopes — build_hirise](#5--hirise-slopes--build_hirise) |
| 6 | [Ground Temperature — build_heat](#6--ground-temperature--build_heat) |
| 7 | [Satellite Passes — fetch_passes](#7--satellite-passes--fetch_passes) |
| 8 | [Layers Derived at Load Time](#8--layers-derived-at-load-time) |
| 9 | [Known Behaviours](#9--known-behaviours) |
| 10 | [Sources](#10--sources) |

---

## 1 · Overview

| Pipeline | Input | Output | Runs |
|---|---|---|---|
| `build_site.py` | MOLA 463 m, Viking colour tiles | A 178 km site: elevation, horizons, basemap | On demand, from the globe |
| `build_terrain.py` | CTX DTM 20 m, CTX ortho 6 m | The Jezero site: elevation, horizons, basemap | Once |
| `build_hirise.py` | HiRISE DTM 1 m | Sharper slopes for Jezero | Once, optional |
| `build_heat.py` | THEMIS IR, TES albedo, the Sun | Ground temperature through one Mars day | About weekly |
| `fetch_passes.py` | JPL Horizons | Satellite passes and Sun positions per site | Every 6 hours |

Each pipeline reads the remote files directly (cloud-optimised GeoTIFFs over HTTP where available), so nothing large is downloaded that is not needed.

---

## 2 · From QGIS to Python

The first version was done by hand in QGIS. Each manual step became a script.

| QGIS step | Pipeline equivalent |
|---|---|
| Clip raster by extent | A windowed read of only the needed cells |
| Reproject | Equal-area cells in the product's own projection, with the cell width corrected for latitude |
| Slope | Gradient of the elevation, steepest step per cell |
| Raster calculator | The cost grid, built from slope and hazard layers |
| Least-cost path | `MCP_Geometric` minimum-cost search |
| Viewshed | Horizon angles in 16 directions, and ray casting from the habitat mast |

---

## 3 · Global Sites — build_site

| Stage | Detail |
|---|---|
| **Window** | A block of the MOLA grid centred on the chosen point: 384 rows north to south (about 178 km) and enough columns to stay square on the ground at that latitude. |
| **Fill** | Missing cells take the value of their nearest valid neighbour. |
| **Horizons** | For each cell, the highest angle to the terrain in 16 directions, out to 40 km, allowing for the curve of Mars. |
| **Basemap** | Viking MDIM 2.1 colour tiles from NASA Mars Trek, shaded with MOLA relief. If the tiles cannot be reached, relief only. |
| **Metadata** | Size, cell spacing, latitude, sources and a label. |

Sites are kept in `data/sites/<id>/` and reused. A site is roughly 1 MB of arrays plus its basemap.

---

## 4 · Jezero Terrain — build_terrain

| Stage | Detail |
|---|---|
| **Read** | The Mars 2020 landing CTX DTM (20 m, tied to MOLA) and the 6 m orthomosaic, from USGS. |
| **Horizons** | 16 directions, out to 8 km, on the 20 m grid. |
| **Basemap** | The orthomosaic, resampled for the map and for 3D. |
| **Output** | `data/` arrays and `web/` images for the detailed site. |

---

## 5 · HiRISE Slopes — build_hirise

The 20 m CTX grid smooths away small scarps and boulder fields. This pipeline averages the 1 m HiRISE DTM to 5 m, measures slope at 5 m, and gives each 20 m planning cell the steepest of its sixteen 5 m slopes. Outside HiRISE coverage, the CTX slope is kept.

---

## 6 · Ground Temperature — build_heat

| Stage | Detail |
|---|---|
| **Thermal inertia** | The THEMIS night-IR pattern, stretched onto the 180–605 range measured at Jezero by Perseverance's MEDA. Ground that stays warm at night is rocky. |
| **Albedo** | TES albedo: how much sunlight the ground absorbs. |
| **Sun** | Azimuth, elevation and distance for the current sol from JPL Horizons; terrain shadows from the horizon angles. |
| **Model** | A one-dimensional ground heat model on a 40 m grid, in 5-minute steps through one Mars day, floored at the CO₂ frost point. |
| **Check** | The afternoon result is compared with the independent THEMIS day-IR mosaic (correlation r ≈ 0.54). |

Assumed values: dust optical depth 0.5, ground emissivity 0.95. The result is labelled as a model in the app.

---

## 6b · Minerals — build_minerals

The spectral layer. The CRISM mineral map of Jezero (UMass Amherst, Zenodo 5575824) is a georeferenced RGB image where each colour is one mineral class at high or medium confidence. The pipeline turns colours back into classes (olivine, Mg-carbonate, smectite clays, pyroxenes and mixtures) and lays them on the 20 m Jezero grid in the same equirectangular frame. The server uses it for the Minerals layer, for the mineral at each stop, and to pick science stops: dense, high-confidence patches within reach, on safe slopes, at least 600 m apart.

## 6c · Rocky Ground — build_rocks

THEMIS night infrared tiles (Mars Odyssey, 100 m, from NASA Mars Trek) for any site between 60°N and 60°S. Rock holds the day's heat and stays warm at night; dust and sand cool fast. The warmer-than-median half of the site is stretched from 0 to 1 and lightly smoothed. The server adds it to the route cost with the Rocky ground weight and warns when over a quarter of a route crosses rock-rich ground. `build_site` runs it for every new site.

---

## 7 · Satellite Passes — fetch_passes

| Stage | Detail |
|---|---|
| **Request** | Observer ephemerides from the JPL Horizons API, from the site's position on Mars, every minute, for MRO, Mars Odyssey, TGO and Mars Express, the Sun and the Earth. |
| **Passes** | Contiguous minutes above 10° elevation, with range and range rate for Doppler. |
| **Terrain** | Each pass minute is later compared with the horizon angle in that direction, so a satellite behind a crater wall counts as blocked. |
| **Store** | PostgreSQL, plus a JSON cache per site so the app keeps working without the database. |

Horizons IDs: MRO −74, Mars Odyssey −53, TGO −143, Mars Express −41, Sun 10, Earth 399.

---

## 8 · Layers Derived at Load Time

The server derives these from the stored arrays when a site loads, so they always match the current time and settings.

| Layer | Derived from |
|---|---|
| **Slope** | Elevation gradient (HiRISE where available) |
| **Radiation** | Curiosity RAD's 0.67 mSv/day at Gale, scaled by the air column above each cell (from MOLA elevation, 11.1 km scale height) and by the open sky left by the horizons |
| **Relay blind spots** | Minutes per day each orbiter is in view above the local horizon |
| **Sunlight and shadow** | The Sun's position at the chosen time against the horizons |
| **Cost** | Walking time, slope penalty and weighted hazards, as the planner sees them |

The habitat radio coverage is drawn in the browser: rays cast from the mast across the elevation model, for a mast and a suit antenna at fixed heights.

---

## 9 · Known Behaviours

| Behaviour | Reason |
|---|---|
| Global sites near the poles are narrower than 178 km | Columns are capped at three times the row count to keep the site fast to build and draw. |
| Global sites hide small hazards | 463 m cells cannot show rocks, scarps or small craters; the route carries a warning. |
| Ground temperature only at Jezero | The heat model needs the detailed grid and the MEDA calibration. |
| Passes expire after a few days | They are forecasts; the scheduler refreshes them. |

---

## 10 · Sources

Every input above, with its direct link, is listed in [DATA_SOURCES.md](../DATA_SOURCES.md).

| Provider | Datasets |
|---|---|
| [USGS Astrogeology](https://astrogeology.usgs.gov) | MOLA, CTX, HiRISE, THEMIS and TES mosaics |
| [NASA JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) | Orbits, the Sun, the Earth |
| [NASA Mars Trek](https://trek.nasa.gov/mars/) | Viking MDIM 2.1 colour mosaic |
| [Curiosity RAD](https://doi.org/10.1126/science.1244797) | Surface radiation dose |
