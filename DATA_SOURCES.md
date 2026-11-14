# Marswalk data sources

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

## Software
- QGIS, for the first manual prototype: clip, slope, least-cost path
- Python: rasterio, NumPy and scikit-image (MCP_Geometric least-cost path) for the pipelines, FastAPI for the server
- Leaflet for the map, three.js for the globe and the 3D walk
