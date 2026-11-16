# Marswalk

**Walk Mars before anyone does.** Marswalk plans safe walking and driving routes on real NASA terrain, and keeps an astronaut found and in touch where there is no GPS. Then it lets you rehearse the route in true-scale 3D or phone VR.

Built for the NASA Space Apps Challenge 2026 by **Saeed Hersheh** (team lead, AirAwareNetwork).

- Live app: https://marswalk-266019376344.europe-west1.run.app/
- Guided tour (about five minutes, with voice-over): https://marswalk-266019376344.europe-west1.run.app/tour.html
- Short demo: https://marswalk-266019376344.europe-west1.run.app/tour.html?short=1
- Slides: https://marswalk-266019376344.europe-west1.run.app/slides.html

## What it does

- **Pick anywhere on Mars.** A 3D globe; click a point and the server builds a 178 km site from NASA MOLA elevation in about a minute. Jezero crater is a detailed site (MRO CTX 20 m, HiRISE 1 m slopes).
- **Read the ground.** Eight layers: elevation, slope, radiation, relay-satellite blind spots, habitat radio coverage, sunlight and shadow, ground temperature, and the planner's cost.
- **Plan the safest route.** The map is cut into 20 m cells; each cell's cost is walking time × (1 + slope penalty + 6 × weighted hazards), and a least-cost path search finds the route. Safest, Balanced and Fastest styles; a crew rover option.
- **Navigate without GPS.** The suit's step counting drifts; the habitat's radio mast fixes the position while it can see the crew; real relay orbiters (MRO, Mars Odyssey, TGO, Mars Express, orbits from NASA JPL Horizons) fix it when they pass overhead. The planner forecasts the position uncertainty along the route.
- **Talk home.** A radio to the habitat and to Earth mission control, with the real light delay; replies wait at the orbiter for the next pass. Mission control runs in its own page (`control.html`).
- **Rehearse it.** True-scale 3D, first person, the crew rover, and phone VR with gaze buttons and two side screens.
- **Report it.** Every plan exports a two-page PDF mission report with figures, tables and a go / no-go check.

## Data

All terrain, orbit, Sun and radiation data come from NASA and USGS sources; see [DATA_SOURCES.md](DATA_SOURCES.md) for every source with links. Anything that is a model or an assumption (suit speed, position drift, radio accuracy, rover speed) is labelled as one in the app.

## Built with

QGIS (first prototype) · Python: FastAPI, rasterio, NumPy, SciPy, scikit-image · PostgreSQL · Leaflet · three.js · Google Cloud Run.

Built with help from AI assistants (Claude and Gemini). The voice-over uses the browser's text-to-speech.

## Test

With the server running:

```bash
.venv/Scripts/python tests/smoke_test.py http://127.0.0.1:8077
```

It loads every page and, for several sites, every layer, the satellite passes, and a walking and a rover route.

## Run

```bash
.venv/Scripts/python -m uvicorn app.main:app --port 8077
```

Open http://localhost:8077

## Whole Mars

Open http://localhost:8077/globe.html for the globe and flat map of the whole planet. Click anywhere, then "Plan a walk here". The API builds that area (about 178 km across) from MOLA 463 m elevation and Viking colour tiles, fetches its orbiter passes from Horizons, and opens the planner on it. Takes about a minute the first time; after that the site is saved under `data/sites/`.

These region sites are coarse (463 m cells): good for comparing places, not for placing footsteps. They have no heat layer and no HiRISE slopes. Jezero stays the detailed site (20 m).

From the command line:

```bash
.venv/Scripts/python pipeline/build_site.py -4.59 137.44 "Gale crater"
```

## Rebuild data

```bash
.venv/Scripts/python pipeline/build_terrain.py
```

Downloads the Jezero CTX DTM (20 m) and orthomosaic (6 m) from USGS, computes horizon angles. About 2.5 minutes.

```bash
.venv/Scripts/python pipeline/build_hirise.py
```

Optional. Reads the local HiRISE 1 m DTM and replaces the hazard slope inside its footprint (31 % of the map). The API uses it automatically when `data/slope_hr.npy` exists.

```bash
.venv/Scripts/python pipeline/build_heat.py
```

Ground temperature through one Mars day at 40 m: THEMIS night IR + TES albedo + Horizons Sun + CTX shadows through a 1-D ground heat model. About 10 minutes. Rerun every few weeks, since the Sun's path shifts with the season.

```bash
.venv/Scripts/python pipeline/build_heat.py
```

Ground temperature through one Mars day on a 40 m grid. Reads THEMIS night IR (100 m) and TES albedo from USGS, the Sun from Horizons, and runs a ground heat model. About 10 minutes. Re-run it every week or so, because it is built for the current season.

```bash
.venv/Scripts/python pipeline/fetch_passes.py 72
```

Pulls 72 h of orbiter passes and Sun position from JPL Horizons into Postgres. This is the cron job. The API also runs it by itself when stored passes run out.

## Layout

- `pipeline/` offline data steps
- `app/main.py` FastAPI: layers, passes, route planning
- `web/` Leaflet + three.js frontend
- `.env` Postgres connection (database `marswalk` in WSL, separate from the AirAware databases)

## What is real and what is assumed

Real: elevation, slope, orbital image, orbiter pass times and angles, Sun position, terrain line of sight.

Model on real inputs: ground temperature (THEMIS night IR pattern stretched onto the 180 to 605 thermal inertia range MEDA measured at Jezero, TES albedo, real Sun and shadows; dust opacity 0.5 and emissivity 0.95 assumed). Its afternoon pattern correlates r = 0.54 with the independent THEMIS day IR mosaic.

Radiation: anchored on a measurement (Curiosity RAD, 0.67 mSv/day at Gale under about 22 g/cm2 of air). Other places are scaled by the air above them (MOLA elevation; 11.1 km scale height is an assumption) with a published sensitivity of 10 to 20 % per 10 g/cm2 (e-folding 60 g/cm2), then by how much sky the terrain leaves open (horizon angles, slant-path weighted). Inside one crater the spread is small (a few % from elevation, up to about 20 % in sheltered spots); across Mars it is large (Hellas floor about 0.58, Olympus Mons about 0.93 mSv/day). Solar particle events are not modelled.

Model or assumption: suit speed (half of Tobler), position drift (2 % of distance since last fix), Doppler fix (simulated as a reset at pass start).

Ground temperature is a model on real inputs: thermal inertia range (180 to 605) and dust opacity (0.5) are assumptions; it matches the independent THEMIS day image only moderately (r = 0.54).

Not built: dust storms, orbiter angle variation across the map (it matters more on the 178 km region sites), heat and fine slopes outside Jezero.

## Alerts and Doppler

- The API tops up passes from Horizons every 6 hours while it runs (`_scheduler` in `app/main.py`).
- `GET /api/next?x=&y=&t=` answers "what's next for this spot": passes with terrain blocking, closest approach and Doppler shift. No x/y means the habitat.
- The page alerts 10 minutes before each pass and when it rises, with a sound per orbiter ("Pass alerts sound") and optional desktop notifications.
- Click any pass in the Relay network list for the Doppler demo. Shift = -f0 x range-rate / c at 437.1 MHz, the orbiter-to-surface UHF link. The audio is that curve scaled into hearing range.

## Postgres asleep

Postgres runs in WSL, and WSL stops when idle. The API then serves the last passes it saved in `data/passes_cache.json`. To refresh passes, wake WSL first (open an Ubuntu terminal).

## How the route is chosen

The planner does not take the shortest path. Every cell has a cost: Tobler walking time times a slope penalty that is free under 3 degrees, 2x at 8, 9x at 12, 25x at 16 and 60x at 20 (see `SLOPE_COST` in `app/main.py`). Cells next to a steep cell count as steep, so the route keeps a margin from edges. Anything over the no-go limit is blocked; if there is no way through, the limit is relaxed in steps of 4 degrees and the route says so.

Three styles set the weights: Safest (slope weight 1, limit 18 degrees), Balanced (0.4, 22), Fastest (0.08, 25). The route is drawn green where flat (under 8 degrees), amber on moderate slope (8 to 15), red where steep (over 15).

## Phones

The planner is built phone first below 980 px: the map fills the screen, the plan, layers and relay panels are bottom sheets behind a tab bar, and Start walk is a floating button. Above 980 px it is the desktop layout.

## Radio messages

The Relay sheet has a Radio messages section. Record a voice message or type one and choose Earth or the pod. It waits until a relay orbiter is overhead and the link is open, then leaves. Earth gets it after the real one-way light time (from Horizons, 11.1 min on 12 Nov 2026) divided by the demo speed (x30, x120, x600); the pod gets it in about a second. Replies from Earth cross the light delay, wait at the orbiter, and come down on the walker's next pass.

Open http://localhost:8077/control.html on the laptop (or any device) as Earth mission control or as the pod. Press Start listening once so the browser allows sound. Content stays hidden until the signal has really arrived.

Walkie-talkie: a beep and vibration tell you when a relay orbiter comes overhead, and only then does the mic open. Hold the big talk button (or the space bar) while you speak; it sends when you let go. Outside a pass the button is locked; you can still record a message to send on the next pass.

The microphone needs https or localhost. For a phone, run `serve_https.cmd` (https on port 8443), open `https://<PC Wi-Fi address>:8443` on the phone and the laptop (both must use the same server), and accept the one-time certificate warning. The certificate in `certs/` was made for 192.168.1.156; if the PC gets a new address, make a new one (in Git Bash): `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout certs/key.pem -out certs/cert.pem -subj "/CN=marswalk.local" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<new address>"`.
