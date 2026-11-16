<div align="center">

<img src="../web/img/brand/logo-512.png" alt="AirAwareNetwork logo" width="110">

# Marswalk — System Architecture

**How the parts fit together**

`Python 3.13` · `FastAPI` · `NumPy` · `PostgreSQL` · `Leaflet` · `three.js` · `Google Cloud Run`

</div>

---

```
        ╔═══════════════════════════════════════════════════════╗
        ║                                                       ║
        ║   One server, one browser app, no accounts.           ║
        ║                                                       ║
        ║   ─────────────────────────────────────────────────   ║
        ║                                                       ║
        ║   terrain     built once per site, kept on disk       ║
        ║   passes      JPL Horizons, refreshed every 6 hours   ║
        ║   routes      planned on request, under a second      ║
        ║   radio       held in memory, real light delay        ║
        ║                                                       ║
        ╚═══════════════════════════════════════════════════════╝
```

---

## Contents

| # | Section |
|---|---|
| 1 | [System Overview](#1--system-overview) |
| 2 | [Component Map](#2--component-map) |
| 3 | [Request Lifecycle](#3--request-lifecycle) |
| 4 | [Sites](#4--sites) |
| 5 | [The Route Planner](#5--the-route-planner) |
| 6 | [Navigation Without GPS](#6--navigation-without-gps) |
| 7 | [Communications](#7--communications) |
| 8 | [The Browser App](#8--the-browser-app) |
| 9 | [Storage and Scheduling](#9--storage-and-scheduling) |
| 10 | [Failure Behaviour](#10--failure-behaviour) |
| 11 | [Deployment](#11--deployment) |
| — | [Principles](#-principles) |

---

## 1 · System Overview

Marswalk has three parts:

| Part | Role |
|---|---|
| **Pipelines** | Turn NASA and USGS rasters into planning layers for a site, and fetch satellite passes from JPL Horizons. |
| **Server** | A FastAPI app that loads a site's layers into memory, plans routes, renders map layers, serves satellite passes and relays radio messages. |
| **Browser app** | Plain HTML, CSS and JavaScript: the globe, the 2D planner, true-scale 3D, phone VR, the guided tour, mission control and the PDF report. |

There is no build step, no front-end framework and no user account. Every page is a static file served by the same process that answers the API.

---

## 2 · Component Map

```
                         ┌──────────────────────────────┐
   NASA / USGS rasters ─▶│  pipeline/                    │
   (MOLA, CTX, HiRISE,   │  build_site · build_terrain   │──▶ data/  (per-site arrays)
    THEMIS, TES, Trek)   │  build_hirise · build_heat    │
                         └──────────────────────────────┘
                         ┌──────────────────────────────┐
   NASA JPL Horizons   ─▶│  pipeline/fetch_passes        │──▶ PostgreSQL + passes_cache.json
                         └──────────────────────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │  app/main.py   (FastAPI)      │
                         │  sites · layers · routes      │
                         │  passes · next pass · Doppler │
                         │  app/comms.py  (radio)        │
                         └──────────────┬───────────────┘
                                        │  JSON · PNG
                         ┌──────────────▼───────────────┐
                         │  web/                         │
                         │  globe · planner · 3D · VR    │
                         │  tour · control · report      │
                         └──────────────────────────────┘
```

---

## 3 · Request Lifecycle

A typical planning session, from the user's first click:

| Step | Request | What happens |
|---|---|---|
| 1 | `GET /api/sites` | Lists the built sites for the globe. |
| 2 | `POST /api/sites` | For a new point on Mars: builds a 178 km site from MOLA, then fetches its satellite passes. About a minute, once. |
| 3 | `GET /api/meta` | Site size, habitat position, basemap, sources and assumptions. |
| 4 | `GET /api/layer/{name}.png` | A map layer rendered from the site arrays, cached in memory. |
| 5 | `POST /api/route` | Plans the route between the stops for the chosen style and vehicle. |
| 6 | `GET /api/passes`, `/api/next` | Satellite passes over the site, with terrain blocking, closest approach and Doppler. |
| 7 | `/api/comms/*` | Sends and receives radio messages for the astronaut, the habitat and Earth. |

---

## 4 · Sites

| Site type | Resolution | Built from | Extras |
|---|---|---|---|
| **Detailed** (Jezero) | 20 m cells | MRO CTX DTM, HiRISE 1 m slopes | Ground temperature model |
| **Global** (anywhere) | 463 m cells, about 178 × 178 km | MOLA MEGDR | Built on demand |

Every site carries the same arrays: elevation, validity, slope, and horizon angles in 16 directions. Global sites take extra columns away from the equator so that they stay square on the ground.

---

## 5 · The Route Planner

The planner answers one question: what is the cheapest way between these stops?

| Element | Detail |
|---|---|
| **Grid** | One cell per terrain cell. |
| **Base cost** | Time to cross the cell: Tobler's hiking function at half pace for a suited walker; a slope-limited speed curve for the rover. |
| **Slope penalty** | Free under 3°, 2 at 8°, 8 at 12°, 24 at 16°, 60 at 20°. Cells beside a steep cell count as steep, so routes keep a margin from edges. |
| **Hazards** | Radiation, relay-satellite blind spots, shadow and cold ground, each scaled 0–1 and weighted by the route style, then multiplied by 6. |
| **Hard limit** | Cells steeper than the style's limit (18°, 22° or 25°) are blocked. If no way through exists, the limit is raised in steps and the route says so. |
| **Search** | `skimage.graph.MCP_Geometric`, a minimum-cost path over the cost grid. |

The response carries everything the browser needs: the path, distance, time, climb, dose, slope mix, satellite contacts with blocked minutes, the longest silence, Sun elevation, ground temperature and warnings.

---

## 6 · Navigation Without GPS

| Source | When it works | Accuracy |
|---|---|---|
| **Dead reckoning** | Always | Drifts by 2 % of the distance since the last fix |
| **Habitat radio mast** | While the mast has line of sight to the suit | ±5 m in range, ±1° in bearing |
| **Relay orbiter** | While MRO, Odyssey, TGO or Mars Express is in view above 10° | About ±5 m after a pass of at least a minute |

Line of sight is checked over the real terrain and the curve of Mars, for a mast and a suit antenna at fixed heights. Before the walk, the planner forecasts the uncertainty along the whole route; during the walk, each fix moves the estimate, and a fix from a satellite re-plans the rest of the route from the corrected position.

---

## 7 · Communications

```
   astronaut ──(habitat radio, ~1 s)──────────────────────────▶ habitat
   astronaut ──(only while a relay is in view)──▶ orbiter ──(light time)──▶ Earth
   Earth ──(light time)──▶ orbiter ──(waits for the next pass)──▶ astronaut
```

| Rule | Detail |
|---|---|
| **Light time** | One-way Mars–Earth light time from JPL Horizons, refreshed hourly. |
| **Store and forward** | Replies from Earth wait at the orbiter until the astronaut's next pass. |
| **Time scale** | Delays follow the simulation clock, so a ×30 walk compresses them by the same factor. |
| **Storage** | Messages and recorded voice clips are held in memory on the server; the newest 120 are kept. |

---

## 8 · The Browser App

| Page | Purpose |
|---|---|
| `home.html` | The homepage, with an interactive explanation of layers, routing and navigation |
| `globe.html` | The 3D globe of Mars and a flat map; any point opens as a site |
| `index.html` | The planner, 3D, first person, rover, VR and the radio |
| `tour.html` | A guided tour with voice-over, and a short demo |
| `control.html` | Mission control: Earth or the habitat station |
| `report.html` | The two-page mission report, saved as PDF by the browser |
| `slides.html` | Seven presentation slides |

3D runs on three.js with true-scale terrain. Phone VR renders two eye views from the device's motion sensor, with two screens beside the walker that are pressed by holding the gaze dot on a button for two seconds.

---

## 9 · Storage and Scheduling

| Store | Holds | Lifetime |
|---|---|---|
| `data/` | Site arrays, built by the pipelines | Until rebuilt |
| PostgreSQL | Satellite passes and Sun positions per site | Refreshed every 6 hours |
| `passes_cache.json` | A copy of the last passes per site | Used when the database is unavailable |
| Server memory | Rendered layers, sunlight and coverage caches, radio messages | Until restart |

A background task tops up the passes for every site in use every 6 hours. When stored passes run out, the server fetches new ones from Horizons on the next request.

---

## 10 · Failure Behaviour

| Failure | Behaviour |
|---|---|
| PostgreSQL unreachable | Passes are served from the per-site cache file. |
| JPL Horizons unreachable | The cached passes stay in use; the light time falls back to the 12.5-minute average. |
| NASA Mars Trek tiles unavailable | A new site is built with shaded relief only. |
| No route under the slope limit | The limit is raised step by step, and the route carries a warning. |
| No motion sensor in VR | VR waits, asks the user to move the phone, and exits with an explanation after seven seconds. |

---

## 11 · Deployment

| Item | Value |
|---|---|
| Host | Google Cloud Run, Europe West 1 |
| Container | `Dockerfile`, Python 3.13 slim, port 7860 |
| Scale | Zero to two instances, 2 vCPU, 2 GiB |
| Data | Site arrays ship inside the container; the database is optional |

---

## ◆ Principles

- **Real data first.** Terrain, orbits, the Sun and radiation come from NASA and USGS datasets.
- **Say what is assumed.** Every model and assumption is labelled in the app and in the report.
- **Plan before the walk.** Every risk the walk will meet is visible on the map before anyone leaves.
- **No build step.** Plain files, so anyone can read and change them.
