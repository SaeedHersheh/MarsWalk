# Marswalk data sources

## For the Space Apps form

### NASA Data
| Link Text | Link Url |
|---|---|
| NASA JPL Horizons (orbits of MRO, Mars Odyssey, TGO, Mars Express, the Sun and Earth) | https://ssd.jpl.nasa.gov/horizons/ |
| NASA Mars Trek (Viking MDIM 2.1 colour mosaic) | https://trek.nasa.gov/mars/ |
| MOLA 463 m global elevation (Mars Global Surveyor) | https://asc-pds-services.s3.us-west-2.amazonaws.com/wms_basemaps3/Mars/MOLA/mola128_mola64_merge_90Nto90S_SimpleC_clon0_cog.tif |
| MRO CTX DTM 20 m, Jezero (Mars 2020 TRN) | https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif |
| MRO CTX orthomosaic 6 m, Jezero (Mars 2020 TRN) | https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif |
| MRO HiRISE DTM 1 m, Jezero (Mars 2020 TRN) | https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif |
| Mars Odyssey THEMIS night IR mosaic 100 m | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Night_mosaic_60N60S_100m_v14.tif |
| Mars Odyssey THEMIS day IR mosaic 100 m | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif |
| Mars Global Surveyor TES albedo mosaic | https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MGS_TES_Albedo_mosaic_global_7410m.tif |
| Curiosity RAD surface radiation (Hassler et al. 2014) | https://doi.org/10.1126/science.1244797 |
| NASA Mars Trek CTX global mosaic tiles (Murray Lab, Caltech; 3D ground near the camera) | https://trek.nasa.gov/tiles/Mars/EQ/CTX_beta01_uncontrolled_5m_Caltech/1.0.0/WMTSCapabilities.xml |
| HiRISE DTM catalogue (University of Arizona, for NASA MRO) | https://www.uahirise.org/dtm/ |
| MRO HiRISE merged DEM 1 m, Gale crater (USGS, MSL mission) | https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif |
| MRO HiRISE orthophoto mosaic 25 cm, Gale crater (USGS, MSL mission) | https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif |
| MRO CRISM mineral map of Jezero (spectral; built from CRISM observations HRL000040FF, FRT000047A3, FRT00005C5E, FRS00031442) | https://zenodo.org/records/5575824 |
| Mars Odyssey THEMIS night IR controlled mosaic 100 m, as Mars Trek tiles (rocky ground) | https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/WMTSCapabilities.xml |
| NASA DONKI space weather: CME arrival forecasts at Mars (CCMC WSA-Enlil) and SEP events | https://api.nasa.gov/ (DONKI) · https://kauai.ccmc.gsfc.nasa.gov/DONKI/ |
| NASA MSL (Curiosity) traverse, end-of-drive positions | https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json |
| NASA Mars 2020 (Perseverance) traverse, end-of-drive positions | https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json |

### Space Agency Partner & Other Data
| Link Text | Link Url |
|---|---|
| ESA Mars Express (relay orbiter; orbit via JPL Horizons) | https://www.esa.int/Science_Exploration/Space_Science/Mars_Express |
| ESA/Roscosmos ExoMars Trace Gas Orbiter (relay orbiter; orbit via JPL Horizons) | https://www.esa.int/Science_Exploration/Human_and_Robotic_Exploration/Exploration/ExoMars |
| USGS Astrogeology (hosts the MOLA, CTX, HiRISE, THEMIS and TES files) | https://astrogeology.usgs.gov |
| QGIS (first prototype) | https://qgis.org |
| rasterio | https://rasterio.readthedocs.io |
| NumPy | https://numpy.org |
| scikit-image (least-cost path search) | https://scikit-image.org |
| FastAPI | https://fastapi.tiangolo.com |
| PostgreSQL (stored satellite passes) | https://www.postgresql.org |
| Leaflet (map) | https://leafletjs.com |
| three.js (globe and 3D walk) | https://threejs.org |
| Google Fonts: Inter, IBM Plex Mono | https://fonts.google.com |
| Google Cloud Run (hosting) | https://cloud.google.com/run |


Every source below is read by Marswalk's code. The links are the exact files and services the code uses, plus each one's public home page.

## Satellites, orbits, the Sun and Earth
**NASA JPL Horizons**: real ephemerides, minute by minute, as seen from each site. Passes are refreshed every 6 hours.
- Home: https://ssd.jpl.nasa.gov/horizons/
- API used: https://ssd.jpl.nasa.gov/api/horizons.api

What Marswalk asks Horizons for:
- **Mars Reconnaissance Orbiter (MRO)**, ID -74. Relay passes.
- **2001 Mars Odyssey**, ID -53. Relay passes.
- **ExoMars Trace Gas Orbiter (TGO)**, ID -143. Relay passes.
- **Mars Express**, ID -41. Relay passes.
- **The Sun**, ID 10. Daylight, shadows and the heat model.
- **Earth**, ID 399. The real one-way light delay for messages.

## Terrain
**MOLA MEGDR, 463 m global elevation** (Mars Global Surveyor, MOLA), via USGS Astrogeology. Used for every site on the globe, for line of sight, and for the air column in the radiation model.
- File: https://asc-pds-services.s3.us-west-2.amazonaws.com/wms_basemaps3/Mars/MOLA/mola128_mola64_merge_90Nto90S_SimpleC_clon0_cog.tif

**Mars 2020 TRN CTX DTM, 20 m, and CTX orthomosaic, 6 m** (MRO Context Camera, tied to MOLA), from USGS Astrogeology. Covers Jezero crater.
- DTM: https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
- Orthomosaic: https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif

**HiRISE 1 m DTM of Jezero** (MRO HiRISE), from the Mars 2020 TRN set. It sharpens the slope map.
- File (about 1.8 GB): https://planetarymaps.usgs.gov/mosaic/mars2020_trn/HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif
- All HiRISE DTMs: https://www.uahirise.org/dtm/

## Ground temperature
All three are read straight from the USGS Astrogeology PDS mosaics:
- **THEMIS night IR, 100 m** (Mars Odyssey): https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Night_mosaic_60N60S_100m_v14.tif
- **THEMIS day IR, 100 m** (Mars Odyssey), used as an independent check: https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif
- **TES albedo, 7.4 km** (Mars Global Surveyor): https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars_MGS_TES_Albedo_mosaic_global_7410m.tif

## Radiation
**Curiosity RAD** (MSL Radiation Assessment Detector): 0.67 mSv/day measured on the surface at Gale crater, under about 22 g/cm² of air. Marswalk scales it by each site's air column (from MOLA) and by how much open sky the terrain leaves.
- Hassler et al. 2014, *Science* 343: https://doi.org/10.1126/science.1244797

## Imagery
**NASA Mars Trek**: Viking MDIM 2.1 colour mosaic, 232 m. This is the colour of every site built on the globe.
- Mars Trek: https://trek.nasa.gov/mars/
- Tiles used: https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{r}/{c}.jpg

**CTX orthomosaic, 6 m**: the ground at Jezero, in the map and in 3D (see Terrain).

**Global CTX mosaic, 5 m** (Murray Lab, Caltech; from MRO's Context Camera): laid over the ground within about 500 m of you in 3D, so close up you see real craters, dunes and boulders.
- About the mosaic: https://murray-lab.caltech.edu/CTX/
- Tiles used (listed by NASA Mars Trek): https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{row}/{col}

## Minerals (spectral)
**CRISM mineral map of Jezero**: Parente, Saranathan and Itoh (University of Massachusetts Amherst), from MRO CRISM data, co-registered to the USGS Mars 2020 CTX and HiRISE products, 36 m pixels, CC BY 4.0. Ten mineral classes (olivine, Mg-carbonate, smectite clays, pyroxenes, kaolinite and mixtures), each at high or medium confidence. `pipeline/build_minerals.py` puts it on the 20 m Jezero grid.
- Record: https://zenodo.org/records/5575824

## Rocky ground
**THEMIS night infrared** (Mars Odyssey), controlled mosaics v2, 100 m, as NASA Mars Trek tiles. Rock and boulder fields stay warm at night; dust and sand cool fast. `pipeline/build_rocks.py` marks the warmer-than-typical part of each site as rocky (0 to 1). A proxy for rock-rich ground, not single boulders; 60°N to 60°S.

## Space weather
**NASA DONKI** (Space Weather Database Of Notifications, Knowledge, Information): CME arrival forecasts at Mars from CCMC's WSA-Enlil runs, and solar energetic particle events. Checked by the server every 3 hours; shown in the planner, added to route warnings and to the report.
- API: https://api.nasa.gov/ · Database: https://kauai.ccmc.gsfc.nasa.gov/DONKI/

## Rover traverses (science goals)
**NASA MSL and Mars 2020 traverse files**: the end-of-drive positions of Curiosity and Perseverance. The Gale goal follows Curiosity's 2025 drive into the boxwork region of Mount Sharp; the Jezero goal follows Perseverance.
- https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json
- https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json

## 3D models

| Model | Source | Use in Marswalk |
|---|---|---|
| Spirit and Opportunity rover (`web/models/mer.glb`) | [NASA/JPL-Caltech, NASA Science 3D Resources](https://science.nasa.gov/resource/spirit-and-opportunity-rover-3d-model/) | The robotic rover, shown at Curiosity's size; its six wheels are cut out of the mesh so they roll and steer |
| Habitat Demonstration Unit (`web/models/hdu1.glb`, `hdu2.glb`) | [NASA 3D Resources on GitHub](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Habitat%20Demonstration%20Unit) | The surface habitat |

NASA 3D Resources are free to download and use under the [NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/).

## Software
- QGIS, for the first manual prototype: clip, slope, least-cost path
- Python: rasterio, NumPy and scikit-image (MCP_Geometric least-cost path) for the pipelines, FastAPI for the server
- Leaflet for the map, three.js for the globe and the 3D walk
