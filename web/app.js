/* Marswalk frontend: Leaflet map (metres, CRS.Simple) + three.js terrain + walk simulation. */
(async () => {
  const $ = id => document.getElementById(id);
  const SITE = new URLSearchParams(location.search).get("site") || "jezero";
  const MODE = ["plan", "explore"].includes(new URLSearchParams(location.search).get("mode")) ? new URLSearchParams(location.search).get("mode") : "full";
  document.body.classList.add("mode-" + MODE);
  const Q = u => u.startsWith("/api/") ? u + (u.includes("?") ? "&" : "?") + "site=" + SITE : u;   // every API call names its site
  const J = (u, o) => fetch(Q(u), o).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); });
  const ORB = {
    "MRO": { c: "#5BC8F5", f: [660, 880], w: "sine" },
    "Mars Odyssey": { c: "#F5B85B", f: [440, 330], w: "triangle" },
    "TGO": { c: "#B48CFF", f: [523, 659, 784], w: "square" },
    "Mars Express": { c: "#6EE7A8", f: [294, 392], w: "sine" },
  };
  const ONAMES = Object.keys(ORB);

  /* ---------- data ---------- */
  const M = await J("/api/meta");
  const [W, H, DX, DY] = [M.W, M.H, M.DX, M.DY];
  const ELEV = new Int16Array(await (await fetch(M.elev_url)).arrayBuffer());
  let DB = await J("/api/passes?hours=50");
  const HAB = M.habitat;
  {
    const [la, lo] = [M.site.lat, M.site.lon_e];
    $("siteName").textContent = M.label; $("siteRes").textContent = `${Math.abs(la).toFixed(2)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? "E" : "W"} · ${M.kind === "region" ? "MOLA " + Math.round(M.DY) + " m" : "CTX 20 m"}`;
    document.title = "Marswalk · " + M.label;
    if (M.kind === "region") document.querySelector(".credits").textContent = `Terrain: ${M.source}. Orbiters and Sun: JPL Horizons. Radiation is a model on the Curiosity RAD average (0.67 mSv/day). Suit speed (half Tobler) and drift (2 % of distance) are assumptions. This is a coarse site: use it to compare places, not to place footsteps.`;
    if (!M.heat) { document.querySelector('[data-l="heat"]').hidden = true; document.getElementById("w-cold").closest("label").hidden = true; }
  }
  const DRIFT = M.assumptions.drift_fraction;
  const cosLat = Math.cos(M.lat0 * Math.PI / 180);
  const lonLat = (x, y) => [(M.eqc_left + x / cosLat) / M.R * 180 / Math.PI, (M.eqc_bottom + y) / M.R * 180 / Math.PI];
  const elevAt = (x, y) => {
    const c = Math.floor(x / DX), r = H - 1 - Math.floor(y / DY);
    return (c < 0 || r < 0 || c >= W || r >= H) ? null : ELEV[r * W + c] * M.elev_scale;
  };
  const slopeAt = (x, y) => {
    const a = elevAt(x - DX, y), b = elevAt(x + DX, y), c = elevAt(x, y - DY), d = elevAt(x, y + DY);
    if ([a, b, c, d].includes(null)) return null;
    return Math.atan(Math.hypot((b - a) / (2 * DX), (d - c) / (2 * DY))) * 180 / Math.PI;
  };

  /* ---------- habitat radio: a direct line between the mast on the habitat and the suit ----------
     The link holds wherever the ground does not rise above the straight line between the two antennas (the curve of Mars included).
     Antenna heights are assumptions: 8 m mast, 1.8 m suit. No power limit inside the mapped area. */
  const HAB_MAST = 8, SUIT_ANT = 1.8, R_MARS = 3389500;
  const elevBil = (x, y) => {                            // ground height between cell centres, so a line of sight is not broken by the steps of the grid
    const cf = Math.min(W - 1.001, Math.max(0, x / DX - 0.5)), rf = Math.min(H - 1.001, Math.max(0, H - 0.5 - y / DY));
    if (x < 0 || y < 0 || x > M.width_m || y > M.height_m) return null;
    const c0 = Math.floor(cf), r0 = Math.floor(rf), u = cf - c0, v = rf - r0, i = r0 * W + c0;
    return (ELEV[i] * (1 - u) * (1 - v) + ELEV[i + 1] * u * (1 - v) + ELEV[i + W] * (1 - u) * v + ELEV[i + W + 1] * u * v) * M.elev_scale;
  };
  function habLinkAt(x, y) {
    const dx = x - HAB[0], dy = y - HAB[1], d = Math.hypot(dx, dy);
    if (d < 40) return { ok: true, d };
    const z0 = (elevBil(HAB[0], HAB[1]) ?? 0) + HAB_MAST, z1 = (elevBil(x, y) ?? 0) + SUIT_ANT, n = Math.min(600, Math.max(6, Math.ceil(d / (DX * 0.75))));
    for (let i = 1; i < n; i++) {
      const f = i / n, zt = elevBil(HAB[0] + dx * f, HAB[1] + dy * f); if (zt == null) continue;
      if (zt > z0 + (z1 - z0) * f - (d * f) * (d * (1 - f)) / (2 * R_MARS)) return { ok: false, d };
    }
    return { ok: true, d };
  }
  const HL = { t: 0, v: { ok: true, d: 0 }, n: 0 };
  function habNow() {                                    // the astronaut's own link, checked a few times a second; it has to change for about a second before it counts
    const now = performance.now(); if (now - HL.t < 350) return HL.v; HL.t = now;
    const raw = walk.on && T3.walker ? habLinkAt(T3.walker.x, T3.walker.y) : { ok: true, d: 0 };
    if (raw.ok === HL.v.ok || !walk.on) { HL.n = 0; HL.v = raw; } else if (++HL.n >= 3) { HL.n = 0; HL.v = raw; } else HL.v = { ok: HL.v.ok, d: raw.d };
    return HL.v;
  }
  // map layer: everywhere the habitat link reaches. Rays go out from the mast; a spot is covered if an antenna held there clears all the ground before it.
  let HABCOV = null;
  function habCoverUrl() {
    if (HABCOV) return HABCOV;
    const CW = Math.min(1024, W), CH = Math.max(1, Math.round(CW * H / W)), vis = new Uint8Array(CW * CH), NR = 8192;
    const z0 = (elevBil(HAB[0], HAB[1]) ?? 0) + HAB_MAST, step = Math.min(DX, DY), maxD = Math.hypot(M.width_m, M.height_m);
    for (let a = 0; a < NR; a++) {
      const th = a / NR * 2 * Math.PI, ux = Math.sin(th), uy = Math.cos(th); let mx = -Infinity;
      for (let d = step; d < maxD; d += step) {
        const x = HAB[0] + ux * d, y = HAB[1] + uy * d, z = elevBil(x, y); if (z == null) break;
        const drop = d * d / (2 * R_MARS), k = Math.min(CH - 1, Math.floor((1 - y / M.height_m) * CH)) * CW + Math.min(CW - 1, Math.floor(x / M.width_m * CW));
        if ((z + SUIT_ANT - drop - z0) / d >= mx) vis[k] = 2; else if (!vis[k]) vis[k] = 1;
        const sT = (z - drop - z0) / d; if (sT > mx) mx = sT;
      }
    }
    const c = document.createElement("canvas"); c.width = CW; c.height = CH; const x2 = c.getContext("2d"), im = x2.createImageData(CW, CH), dd = im.data;
    for (let i = 0; i < CW * CH; i++) { const v = vis[i]; if (v === 2) { dd[i * 4] = 61; dd[i * 4 + 1] = 220; dd[i * 4 + 2] = 151; dd[i * 4 + 3] = 105; } else if (v === 1) { dd[i * 4] = 6; dd[i * 4 + 1] = 8; dd[i * 4 + 2] = 14; dd[i * 4 + 3] = 165; } }
    x2.putImageData(im, 0, 0); HABCOV = c.toDataURL("image/png"); return HABCOV;
  }

  /* ---------- state ---------- */
  const S = {
    stops: (() => {                                                     // science stops (x east, y north, metres): from the link if it carries a route, else Jezero's demo stops
      const q = new URLSearchParams(location.search).get("stops"), mode = new URLSearchParams(location.search).get("mode");
      const st = q && mode !== "explore" ? q.split(";").map(v => v.split(",").map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite)) : [];
      return st.length ? st : SITE === "jezero" ? [[15100, 16000], [12700, 16300]] : [];
    })(),
    roundTrip: true, vehicle: "foot", style: "safe", weights: { slope: 1, radiation: 0.3, comms: 0.3, shadow: 0.2, cold: 0.2 }, maxSlope: 18,
    departOff: 0,                                 // minutes after "now"
    base: "ortho", layers: new Set(), opacity: 0.8,
    route: null, view: "2d", speed: 120, sound: false, doppler: false, truth: true,
    now0: Date.now() / 1000,
  };
  const walk = { on: false };
  const departT = () => S.now0 + S.departOff * 60;
  const clockT = () => walk.on ? walk.simT : S.departOff === 0 ? Date.now() / 1000 : departT();

  const SLCOL = s => s >= 15 ? "#F0616B" : s >= 8 ? "#F5B85B" : "#6EE7A8";   // steep / moderate / flat

  /* ---------- formatting ---------- */
  const pad = n => String(n).padStart(2, "0");
  const fUTC = t => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fDay = t => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const fDur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${pad(m)} m` : `${m} min`; };
  const fCD = s => { s = Math.max(0, Math.floor(s)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`; };
  const fKm = m => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  const sunAt = t => {
    const s = DB.sun; if (!s.length) return { az: 0, el: -90 };
    let i = s.findIndex(r => r[0] >= t); if (i < 0) i = s.length - 1; if (i === 0) i = 1;
    const a = s[i - 1], b = s[i], k = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0] || 1)));
    return { az: b[1], el: a[2] + (b[2] - a[2]) * k };
  };

  /* ---------- map ---------- */
  const bounds = [[0, 0], [M.height_m, M.width_m]];
  const map = L.map("map", { crs: L.CRS.Simple, minZoom: -10, maxZoom: 1.5, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, zoomControl: false, maxBounds: [[-8000, -12000], [M.height_m + 8000, M.width_m + 12000]] });
  L.control.scale({ imperial: false, position: "bottomleft", maxWidth: 160 }).addTo(map);
  const baseOrtho = L.imageOverlay(M.basemap, bounds).addTo(map);
  const baseElev = L.imageOverlay(Q("/api/layer/elevation.png"), bounds);
  const overlays = {};
  const ll = (x, y) => [y, x];
  if (SITE === "jezero") map.setView(ll(HAB[0] - 1800, HAB[1] + 900), -2.5); else map.fitBounds(bounds, { padding: [-120, -120] });
  baseOrtho.once("load", () => $("loader").hidden = true);

  // where the slope comes from the HiRISE 1 m DTM instead of CTX 20 m
  const hiBox = M.hirise && L.rectangle([[M.hirise.box[2], M.hirise.box[0]], [M.hirise.box[3], M.hirise.box[1]]],
    { color: "#93B7E6", weight: 1, dashArray: "6 6", fill: false, interactive: false });
  const layerUrl = n => {
    if (n === "hab") return habCoverUrl();
    const t = Math.floor((n === "sun" || n === "heat" ? clockT() : departT()) / 600) * 600;
    return Q(`/api/layer/${n}.png?t=${t}` + (n === "cost" ? `&w=${encodeURIComponent(JSON.stringify(S.weights))}` : ""));
  };
  function syncLayers() {
    for (const n of ["slope", "radiation", "comms", "hab", "sun", "heat", "cost"]) {
      const on = S.layers.has(n);
      if (on) {
        const u = layerUrl(n);
        if (!overlays[n]) overlays[n] = L.imageOverlay(u, bounds, { opacity: S.opacity, zIndex: 300 }).addTo(map);
        else { if (overlays[n]._url !== u) overlays[n].setUrl(u); overlays[n].setOpacity(S.opacity); if (!map.hasLayer(overlays[n])) overlays[n].addTo(map); }
      } else if (overlays[n] && map.hasLayer(overlays[n])) map.removeLayer(overlays[n]);
    }
    if (S.base === "elevation") { baseElev.addTo(map); baseElev.bringToBack(); map.removeLayer(baseOrtho); }
    else { baseOrtho.addTo(map); baseOrtho.bringToBack(); map.removeLayer(baseElev); }
    if (hiBox) S.layers.has("slope") ? hiBox.addTo(map) : map.removeLayer(hiBox);
    drawLegend(); T3.dirty = true;
  }
  const LEG = {
    slope: ["linear-gradient(90deg,#3cc878 0%,#ebdc50 25%,#f59632 45%,#eb5a28 62%,#d71e2d 63%,#780a28 100%)", "0°", "40°", M.hirise ? "Dashed box: slopes from HiRISE 1 m." : ""],
    radiation: ["linear-gradient(90deg,#2878dc,#6e3caa,#dc506e,#ffc85a)", "", "", ""],
    comms: ["linear-gradient(90deg,#3cdceb,#f0be46,#e6323c)", "", "", ""],
    hab: ["linear-gradient(90deg,#3ddc97 0%,#3ddc97 50%,#1b2330 50%,#1b2330 100%)", "link holds", "hidden", "Line of sight from an 8 m mast on the habitat to a suit antenna (heights are assumptions)."],
    sun: ["linear-gradient(90deg,#0e1646 0%,#0e1646 30%,#ffe1aa 100%)", "shadow", "full sun", ""],
    heat: ["linear-gradient(90deg,#140e46,#283caa,#4696d2,#9664be,#e1506e,#fa963c,#fff096)", "", "", ""],
    cost: ["linear-gradient(90deg,#1ea078,#dcd250,#f07832,#c8283c,#19050f)", "easy", "no-go", "what the planner sees with your weights"],
    elevation: ["linear-gradient(90deg,#261860,#2446aa,#2096c8,#46be78,#c8dc5a,#f0b43c,#e16e2d,#faf4ec)", "", "", ""],
  };
  const NOTE = {
    slope: "Green is easy walking. Amber is a moderate slope. Red is steep. The planner avoids red unless there is no other way.",
    radiation: "Darker blue = more shielded. Cliff bases and valley floors hide part of the sky, so they get less. Higher ground has thinner air above it, so it gets more. Inside one crater the spread is small: the big differences are between places on Mars (see the globe).",
    comms: "Red = places where hills hide the relay orbiters for much of the day.",
    hab: "Green = the habitat's radio mast can see you there, so voice and messages to the habitat go straight through. Dark = the ground is in the way.",
    sun: "Dark blue = night, or shadow cast by the terrain right now.",
    heat: "Ground temperature at the clock time. Cold ground drains suit power.",
    cost: "What the planner sees with your settings: green is cheap to cross, dark red is avoided.",
    elevation: "Height above the Mars datum. Brighter = higher.",
  };
  const LNAME = { slope: "Slope", radiation: "Radiation", comms: "Relay blind spots", hab: "Habitat radio", sun: "Sun & shadow", heat: "Ground temp", cost: "Planner cost", elevation: "Elevation" };
  async function drawLegend() {
    const act = [...S.layers].pop() || (S.base === "elevation" ? "elevation" : null);
    const el = $("legend"); $("layerNote").textContent = act ? NOTE[act] : "Select a layer to display it on the map.";
    if (!act) { el.innerHTML = ""; $("mapLegend").hidden = true; return; }
    let [bar, lo, hi, unit] = LEG[act];
    if (["radiation", "comms", "elevation", "sun", "heat"].includes(act)) {
      try {
        const g = await J(`/api/legend/${act}?t=${Math.floor((act === "sun" || act === "heat" ? clockT() : departT()) / 600) * 600}`);
        if (act === "sun") unit = g.el > 0 ? `Sun ${g.el}° up, bearing ${g.az}°. Blue = cast shadow.` : "Sun is below the horizon: night.";
        else if (act === "heat") { lo = g.lo + " °C"; hi = g.hi + " °C"; unit = "Ground temperature at the clock time. THEMIS night IR + TES albedo + Sun, through a heat model."; }
        else { lo = g.lo; hi = g.hi; unit = g.unit; }
      } catch (e) { /* legend is optional */ }
    }
    el.innerHTML = `<div class="bar" style="background:${bar}"></div><div class="ends"><span>${lo}</span><span>${hi}</span></div><div class="unit">${unit}</div>`;
    $("mapLegend").innerHTML = `<b>${LNAME[act]}</b><div class="bar" style="background:${bar}"></div><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
    $("mapLegend").hidden = false;
  }

  /* ---------- stops + route drawing ---------- */
  const g = L.layerGroup().addTo(map);
  map.createPane("route").style.zIndex = 450;           // above every colour layer, so the route never looks washed out
  const routeCase = L.polyline([], { color: "#05060A", weight: 8, opacity: 0.8, interactive: false, pane: "route" }).addTo(map);
  const routeDone = L.polyline([], { color: "#EDE7DF", weight: 2, opacity: 0.35, dashArray: "4 6", interactive: false, pane: "route" }).addTo(map);
  const routeLine = L.layerGroup().addTo(map);
  map.createPane("nav").style.zIndex = 445;             // just under the route: a glowing band coloured by how sure the position is
  const navLine = L.layerGroup().addTo(map);
  // draw the route green where it is flat, amber on moderate slope, red where steep. `from` = first node still ahead; `head` = walker position.
  function paintRoute(r, from = 0, head = null) {
    const pts = head ? [ll(head[0], head[1])] : [];
    for (let i = from; i < r.x.length; i++) pts.push(ll(r.x[i], r.y[i]));
    routeCase.setLatLngs(pts); routeLine.clearLayers();
    const nodeOf = k => head ? from + k - 1 : from + k;
    let start = 0, col = null;
    for (let k = 1; k < pts.length; k++) {
      const c = SLCOL(r.slope[Math.min(nodeOf(k), r.slope.length - 1)]);
      if (col === null) col = c;
      else if (c !== col) { routeLine.addLayer(L.polyline(pts.slice(start, k), { color: col, weight: 4.5, interactive: false, pane: "route" })); start = k - 1; col = c; }
    }
    if (pts.length > 1) routeLine.addLayer(L.polyline(pts.slice(start), { color: col || "#6EE7A8", weight: 4.5, interactive: false, pane: "route" }));
  }
  const icon = (cls, txt) => L.divIcon({ className: "", html: `<div class="${cls}">${txt}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  function drawStops() {
    T3.dirty = true;
    g.clearLayers();
    L.marker(ll(...HAB), { icon: icon("mk hab", "H"), interactive: true }).bindTooltip("Habitat · " + M.habitat_name).addTo(g);
    S.stops.forEach((s, i) => {
      const m = L.marker(ll(...s), { icon: icon("mk", i + 1), draggable: !walk.on }).addTo(g);
      m.on("dragend", () => { const p = m.getLatLng(); S.stops[i] = [p.lng, p.lat]; plan(); });
    });
    $("stops").innerHTML = `<div class="stop hab"><i>H</i><span>Habitat</span><small>${fmtLL(...HAB)}</small><span></span></div>` +
      S.stops.map((s, i) => `<div class="stop"><i>${i + 1}</i><span>Waypoint ${i + 1}</span><small>${Math.round(elevAt(...s) ?? 0)} m</small><button data-i="${i}" title="Remove">×</button></div>`).join("");
    $("stops").querySelectorAll("button").forEach(b => b.onclick = () => { if (walk.on) return; S.stops.splice(+b.dataset.i, 1); plan(); });
  }
  const fmtLL = (x, y) => { const [lo, la] = lonLat(x, y); return `${la.toFixed(3)}°N ${lo.toFixed(3)}°E`; };
  map.on("click", e => {
    if (walk.on) return;
    if (MODE === "explore") { const { lng: x0, lat: y0 } = e.latlng; if (T3.exPick && x0 > 0 && y0 > 0 && x0 < M.width_m && y0 < M.height_m) T3.exPick([x0, y0]); return; }   // Experience: a tap picks the destination, nothing else
    dismissCoach(); if (mq.matches) closeSheet();
    const { lng: x, lat: y } = e.latlng;
    if (x < 0 || y < 0 || x > M.width_m || y > M.height_m) return;
    S.stops.push([x, y]); plan();
  });
  map.on("mousemove", e => {
    const { lng: x, lat: y } = e.latlng, z = elevAt(x, y);
    if (z == null) { ["rLat", "rLon", "rEl", "rSl"].forEach(i => $(i).textContent = "—"); return; }
    const [lo, la] = lonLat(x, y), s = slopeAt(x, y);
    $("rLat").textContent = la.toFixed(4) + "° N"; $("rLon").textContent = lo.toFixed(4) + "° E";
    $("rEl").textContent = Math.round(z) + " m"; $("rSl").textContent = s == null ? "—" : s.toFixed(1) + "°";
  });

  /* ---------- planning ---------- */
  let planSeq = 0, planTimer = null;
  function plan(delay = 0) { clearTimeout(planTimer); planTimer = setTimeout(doPlan, delay); }
  async function requestRoute(stops, depart) {
    return J("/api/route", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: SITE, stops, weights: S.weights, depart, max_slope: S.maxSlope, round_trip: false, vehicle: S.vehicle }) });
  }
  async function doPlan() {
    drawStops();
    if (!S.stops.length) { S.route = null; showRoute(); return; }
    const seq = ++planSeq; $("planState").textContent = "planning…";
    const stops = [HAB, ...S.stops, ...(S.roundTrip ? [HAB] : [])];
    try {
      const r = await requestRoute(stops, departT());
      if (seq !== planSeq) return;
      r.stopsReq = stops; S.route = r; $("planState").textContent = "";
    } catch (e) {
      if (seq !== planSeq) return;
      S.route = null; $("planState").textContent = ""; toast("No route", e.message, "#F0616B");
    }
    showRoute();
  }
  function showRoute() {
    const r = S.route;
    if (r) paintRoute(r); else { routeCase.setLatLngs([]); routeLine.clearLayers(); }
    syncWalk();
    if (!r) { drawNav(); if (T3.syncFlow) T3.syncFlow(); $("verdict").innerHTML = ""; $("mix").innerHTML = ""; $("stats").innerHTML = ""; $("moreStats").innerHTML = ""; $("warns").innerHTML = ""; $("contacts").innerHTML = ""; drawProfile(); drawTimeline(); return; }
    const mx = r.slope_mix || { green: 100, yellow: 0, steep: 0 }, f0 = v => Math.round(v);
    $("verdict").className = "verdict " + (mx.steep > 0.5 ? "bad" : mx.yellow > 3 ? "warn" : "ok");
    $("verdict").textContent = mx.steep > 0.5 ? `${f0(mx.steep)} % of this route is steep (over 15°). Steepest ${r.max_slope.toFixed(0)}°.`
      : mx.yellow > 3 ? `${f0(mx.green)} % flat ground, ${f0(mx.yellow)} % moderate slope. Steepest ${r.max_slope.toFixed(0)}°.`
      : `${f0(mx.green)} % flat ground. Steepest step ${r.max_slope.toFixed(0)}°.`;
    $("mix").innerHTML = `<div class="bar"><i style="width:${mx.green}%;background:#6EE7A8"></i><i style="width:${mx.yellow}%;background:#F5B85B"></i><i style="width:${mx.steep}%;background:#F0616B"></i></div>` +
      `<div class="key"><span><i style="background:#6EE7A8"></i>Flat under 8°</span><span><i style="background:#F5B85B"></i>Slope 8–15°</span><span><i style="background:#F0616B"></i>Steep over 15°</span></div>`;
    const st = (k, v, u, cls = "") => `<div class="stat ${cls}"><span>${k}</span><b>${v}<small>${u}</small></b></div>`;
    $("stats").innerHTML =
      st("Distance", (r.distance_m / 1000).toFixed(1), "km") +
      st(S.vehicle === "rover" ? "Driving time" : "Walking time", (r.time_s / 3600).toFixed(1), "h", r.time_s > 8 * 3600 ? "bad" : "") +
      st("Radiation", (r.dose_msv * 1000).toFixed(0), "µSv") +
      st("Radio contact", r.contact_min, "min", r.contact_min ? "ok" : "bad");
    $("moreStats").innerHTML =
      st("Climb", Math.round(r.climb_m), "m") +
      (r.ground_c ? st("Ground", `${Math.round(r.ground_min_c)}…${Math.round(r.ground_max_c)}`, "°C", r.ground_min_c < -80 ? "bad" : "") : "") +
      st("Longest silence", (r.longest_gap_s / 3600).toFixed(1), "h", r.longest_gap_s > 4 * 3600 ? "bad" : "");
    $("warns").innerHTML = r.warnings.map(w => `<div class="warn">${w}</div>`).join("") +
      `<p class="note">Radiation on this walk: ${(r.dose_msv * 1000).toFixed(0)} µSv (${r.career_pct.toFixed(3)} % of the ${M.rad ? M.rad.career : 600} mSv career limit). Standing still in the open here costs about ${r.rad_day_avg.toFixed(2)} mSv a day.</p>`;
    $("contacts").innerHTML = r.contacts.map(c => `<div><i class="dot" style="background:${ORB[c.orbiter].c}"></i><span>${c.orbiter} ${c.start ? fUTC(c.start) + " UTC" : "blocked"}</span><span>${c.minutes} min · ${c.max_el}°${c.blocked_min ? ` · ${c.blocked_min} blocked` : ""}</span></div>`).join("");
    drawProfile(); drawTimeline(); drawNav(); T3.dirty = true; if (T3.syncFlow) T3.syncFlow();
  }

  /* ---------- navigation forecast ----------
     Mars has no GPS. Along the planned route this works out, point by point, how well the astronaut will know where they are:
     the suit's own estimate (dead reckoning) loses about DRIFT of the distance walked; the habitat mast, while it can see the suit,
     measures range (5 m) and bearing (1 degree); a relay pass that stays in view for a minute fixes the position to about 5 m.
     Pass times come from the route's contact list (terrain blocking included). Accuracy figures are assumptions, as in the walk. */
  const NAVC = e => e <= 12 ? "#3ddc97" : e <= 30 ? "#8ab8ff" : e <= 60 ? "#f2b84b" : "#ff6b55";
  function navForecast(r) {
    const n = r.x.length, out = { err: new Float32Array(n), src: new Array(n), fixes: [] };
    const wins = (r.contacts || []).filter(c => c.start && c.minutes >= 1).map(c => ({ ...c, a: c.start + 60, b: c.end })).sort((a, b) => a.a - b.a);
    let e = 1.5, wi = 0, hk = 0, hOk = true;
    for (let i = 0; i < n; i++) {
      if (i) e += DRIFT * (r.d[i] - r.d[i - 1]);
      const t = r.depart + r.t[i]; let src = "suit";
      if (i % 3 === 0 || i === n - 1) { hOk = habLinkAt(r.x[i], r.y[i]).ok; hk = Math.hypot(r.x[i] - HAB[0], r.y[i] - HAB[1]); }
      if (hOk) { e = Math.min(e, 2 * Math.hypot(5, hk * Math.PI / 180)); src = "hab"; }      // in sight of the mast: it keeps the estimate in check
      while (wi < wins.length && wins[wi].b < t) wi++;
      const w = wins[wi];
      if (w && t >= w.a && t <= w.b) { if (e > 5) { if (!w.used) { w.used = true; out.fixes.push({ i, orbiter: w.orbiter, t, before: e }); } e = 5; } src = "sat"; }
      out.err[i] = e; out.src[i] = src;
    }
    let worst = 0; for (let i = 1; i < n; i++) if (out.err[i] > out.err[worst]) worst = i;
    out.worst = worst;
    const habEnd = out.src.findIndex(v => v !== "hab" && v !== "sat"); out.habKm = habEnd > 0 ? r.d[habEnd] / 1000 : 0;
    return out;
  }
  function drawNav() {
    navLine.clearLayers(); const r = S.route, box = $("navBox");
    if (!r || walk.on) { if (box) box.hidden = !r; return; }
    const F = navForecast(r); S.nav = F;
    let start = 0, col = NAVC(F.err[0]);
    for (let i = 1; i < r.x.length; i++) {
      const c = NAVC(F.err[i]);
      if (c !== col || i === r.x.length - 1) { navLine.addLayer(L.polyline(r.x.slice(start, i + 1).map((x, k) => ll(x, r.y[start + k])), { color: col, weight: 20, opacity: 0.6, lineCap: "round", interactive: false, pane: "nav" })); start = i; col = c; }
    }
    F.fixes.forEach(f => {
      const o = ORB[f.orbiter] || { c: "#8ab8ff" };
      L.marker(ll(r.x[f.i], r.y[f.i]), { icon: L.divIcon({ className: "", html: `<div class="navfix" style="--c:${o.c}"><i></i><span>${shortOrb(f.orbiter)} fix · ${fUTC(f.t)}</span></div>`, iconSize: [0, 0], iconAnchor: [0, 0] }), interactive: false, pane: "route" }).addTo(navLine);
    });
    if (box) { box.hidden = false; drawNavChart(r, F); }
  }
  function drawNavChart(r, F) {
    const cv = $("navChart"); if (!cv || !cv.clientWidth) return;
    const W2 = cv.clientWidth, H2 = cv.clientHeight, dpr = devicePixelRatio || 1; cv.width = W2 * dpr; cv.height = H2 * dpr;
    const c = cv.getContext("2d"); c.scale(dpr, dpr); c.clearRect(0, 0, W2, H2);
    const L0 = 34, B = H2 - 18, T = 8, D = r.d.at(-1) || 1, emax = Math.max(30, ...F.err) * 1.1, X = d => L0 + (W2 - L0 - 6) * d / D, Y = e => B - (B - T) * e / emax;
    c.strokeStyle = "#1a2230"; c.lineWidth = 1; c.fillStyle = "#627087"; c.font = "11px IBM Plex Mono, monospace";
    for (const v of [0, Math.round(emax / 2 / 10) * 10, Math.floor(emax / 10) * 10]) { c.beginPath(); c.moveTo(L0, Y(v)); c.lineTo(W2 - 6, Y(v)); c.stroke(); c.fillText(v + " m", 0, Y(v) + 4); }
    c.fillText("0 km", L0, H2 - 3); const km = (D / 1000).toFixed(1) + " km"; c.fillText(km, W2 - 6 - c.measureText(km).width, H2 - 3);
    for (let i = 1; i < r.x.length; i++) {
      c.fillStyle = NAVC(F.err[i]); c.globalAlpha = 0.85; const x0 = X(r.d[i - 1]), x1 = X(r.d[i]);
      c.beginPath(); c.moveTo(x0, B); c.lineTo(x0, Y(F.err[i - 1])); c.lineTo(x1, Y(F.err[i])); c.lineTo(x1, B); c.fill();
    }
    c.globalAlpha = 1;
    F.fixes.forEach(f => { const x = X(r.d[f.i]); c.strokeStyle = (ORB[f.orbiter] || { c: "#fff" }).c; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x, T); c.lineTo(x, B); c.stroke(); c.setLineDash([]); });
    const w = F.worst, nf = F.fixes.length;
    $("navSum").innerHTML = (nf ? `<b>${nf} satellite fix${nf > 1 ? "es" : ""}</b> on this walk: ${F.fixes.map(f => `${f.orbiter} at ${fUTC(f.t)}`).join(", ")}. ` : `<b>No satellite pass</b> during this walk, so nothing corrects the suit's estimate away from the habitat. `)
      + (F.habKm > 0.05 ? `The habitat radio places you for the first ${F.habKm.toFixed(1)} km. ` : "")
      + `Least sure: <b>±${Math.round(F.err[w])} m</b> at km ${(r.d[w] / 1000).toFixed(1)}.`;
  }

  /* ---------- relay panel ---------- */
  function currentPass(t) { return DB.passes.find(p => p.start <= t && t < p.end); }
  function sampleAt(p, t) { let b = p.samples[0]; for (const s of p.samples) { if (s[0] <= t) b = s; else break; } return b; }
  let NXT = { passes: [], horizon: [] };                 // "what's next for the habitat", terrain-aware
  const loadNext = async () => { try { NXT = await J("/api/next?hours=50&t=" + Math.floor(Date.now() / 1000 - 1800)); } catch (e) { /* keep old */ } };
  await loadNext();
  let relayRows = [];
  function drawRelay() {
    const t = clockT(), cur = NXT.passes.find(p => p.start <= t && t < p.end);
    const up = NXT.passes.filter(p => p.end > t).slice(0, 7);
    relayRows = [cur || up[0], ...up.filter(p => p !== (cur || up[0])).slice(0, 5)];
    const n = cur || up[0], box = $("nextPass");
    if (!n) { box.innerHTML = `<div class="det">No passes loaded</div>`; return; }
    box.classList.toggle("live", !!cur);
    box.innerHTML = cur
      ? `<div class="who"><i class="dot" style="background:${ORB[n.orbiter].c}"></i>${n.orbiter} overhead</div><div class="cd" style="color:var(--ok)">${fCD(n.end - t)} left</div><div class="det">now ${sampleAt(n, t)[2].toFixed(0)}° up · peak ${n.max_el}°</div>`
      : `<div class="who"><i class="dot" style="background:${ORB[n.orbiter].c}"></i>${n.orbiter}</div><div class="cd">in ${fCD(n.start - t)}</div><div class="det">${fUTC(n.start)} UTC · ${Math.round((n.end - n.start) / 60)} min long · ${n.max_el}° max</div>`;
    $("passList").innerHTML = up.filter(p => p !== n).slice(0, 5).map(p =>
      `<div data-i="${relayRows.indexOf(p)}"><i class="dot" style="background:${ORB[p.orbiter].c}"></i><b>${p.orbiter}</b><span>${fUTC(p.start)}</span><span${p.blocked_min ? ' class="blk"' : ""}>${p.vis_min}m ${Math.round(p.max_el)}°</span></div>`).join("");
  }
  $("passList").addEventListener("pointerdown", e => { const d = e.target.closest("[data-i]"); if (d && relayRows[+d.dataset.i]) openDop(relayRows[+d.dataset.i]); });
  $("nextPass").addEventListener("pointerdown", () => relayRows[0] && openDop(relayRows[0]));

  /* ---------- live alerts (real time, when not in a simulated walk) ---------- */
  const liveAlerted = new Set();
  function notify(title, body) { if (S.notify && window.Notification && Notification.permission === "granted") new Notification(title, { body }); }
  function liveAlerts() {
    if (walk.on) return;
    const t = Date.now() / 1000;
    for (const q of NXT.passes) {
      if (q.end < t || q.start > t + 620) continue;
      const a = q.orbiter + q.start + "a", b = q.orbiter + q.start + "b";
      const seen = q.vis_min ? `${q.vis_min} min of link, ${q.max_el}° max` : "terrain blocks this pass from the habitat";
      if (t >= q.start - 600 && t < q.start && !liveAlerted.has(a)) { liveAlerted.add(a); chime(q.orbiter); const m = `${q.orbiter} in ${Math.max(1, Math.round((q.start - t) / 60))} min`; toast(m, seen + ".", ORB[q.orbiter].c); notify(m, seen); }
      if (t >= q.start && !liveAlerted.has(b)) { liveAlerted.add(b); if (t < q.start + 120) { chime(q.orbiter, true); toast(`${q.orbiter} is up`, `Link open for ${Math.round((q.end - t) / 60)} min.`, ORB[q.orbiter].c); notify(`${q.orbiter} is up`, seen); } }
    }
  }

  /* ---------- Doppler demo ---------- */
  const DP = { p: null, k: -1, raf: 0, osc: null };
  function openDop(p) { DP.p = p; DP.k = -1; $("dopPanel").hidden = false; drawDop(); }
  function closeDop() { stopDop(); $("dopPanel").hidden = true; DP.p = null; }
  function stopDop() { cancelAnimationFrame(DP.raf); if (DP.osc) { DP.osc.g.gain.setTargetAtTime(0, audio().currentTime, 0.03); const o = DP.osc.o; setTimeout(() => o.stop(), 200); DP.osc = null; } DP.k = -1; $("dopPlay").textContent = "Play pass"; }
  function drawDop() {
    const p = DP.p; if (!p) return;
    const sm = p.samples, t0 = sm[0][0], t1 = sm.at(-1)[0], mx = p.doppler_max_hz || 1, col = ORB[p.orbiter].c;
    $("dopTitle").textContent = p.orbiter; $("dopTitle").style.color = col;
    $("dopWhen").textContent = `${fDay(p.start)} ${fUTC(p.start)} to ${fUTC(p.end)} UTC`;
    $("dopBand").textContent = `${(NXT.uhf_hz / 1e6).toFixed(1)} MHz UHF link`;
    $("dopFacts").innerHTML = `Pitch swings <b>±${(mx / 1000).toFixed(1)} kHz</b>. It crosses zero at <b>${fUTC(p.closest_t)} UTC</b>: that instant is closest approach, <b>${Math.round(p.closest_km)} km</b> away. ` +
      `The drop there is <b>${Math.abs(p.doppler_rate_hz_s)} Hz per second</b>: the steeper it is, the closer the orbiter's ground track. ` +
      (p.blocked_min ? `<b>Terrain hides ${p.blocked_min} min</b> of this pass from the habitat. ` : "") + `One pass cannot tell left of the track from right.`;
    // curve
    let [c, w, h] = fit($("dopCurve"));
    const X = t => 40 + (t - t0) / (t1 - t0 || 1) * (w - 48), Y = f => h / 2 - f / mx * (h / 2 - 16);
    c.font = "12px 'IBM Plex Mono', monospace";
    for (let i = 1; i < sm.length; i++) if (!sm[i][5]) { c.fillStyle = "rgba(255,255,255,0.05)"; c.fillRect(X(sm[i - 1][0]), 4, X(sm[i][0]) - X(sm[i - 1][0]), h - 18); }
    c.strokeStyle = "#272930"; c.beginPath(); c.moveTo(40, Y(0)); c.lineTo(w - 8, Y(0)); c.stroke();
    c.fillStyle = "#9AA8CC"; c.fillText(`+${(mx / 1000).toFixed(1)}k`, 2, Y(mx) + 4); c.fillText("0 Hz", 2, Y(0) + 3); c.fillText(`−${(mx / 1000).toFixed(1)}k`, 2, Y(-mx) + 4);
    c.fillText(fUTC(t0), 40, h - 3); c.fillText(fUTC(t1), w - 40, h - 3); c.fillText("coming", 44, 14); c.fillText("going", w - 44, h - 20);
    for (let i = 1; i < sm.length; i++) {
      c.strokeStyle = col; c.globalAlpha = sm[i][5] ? 1 : 0.3; c.lineWidth = sm[i][5] ? 2.4 : 1.4;
      c.beginPath(); c.moveTo(X(sm[i - 1][0]), Y(sm[i - 1][4])); c.lineTo(X(sm[i][0]), Y(sm[i][4])); c.stroke();
    }
    c.globalAlpha = 1; c.fillStyle = "#fff"; c.fillRect(X(p.closest_t), 6, 1, h - 22); c.fillText("closest", X(p.closest_t) + 4, 14);
    const cur = DP.k >= 0 ? sm[Math.min(sm.length - 1, Math.floor(DP.k))] : null;
    if (cur) { c.fillStyle = col; c.beginPath(); c.arc(X(cur[0]), Y(cur[4]), 5, 0, 7); c.fill(); c.fillStyle = "#EDE7DF"; c.fillText(`${cur[4] > 0 ? "+" : ""}${cur[4]} Hz`, Math.min(w - 70, X(cur[0]) + 8), Y(cur[4]) - 8); }
    // sky: zenith in the middle, north up, east right
    [c, w, h] = fit($("dopSky"));
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 12;
    const P = (az, el) => { const r = (90 - el) / 90 * R, a = az * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    c.fillStyle = "#0b0f24"; c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill();
    c.fillStyle = "rgba(156,150,143,0.55)"; c.beginPath();                       // terrain horizon, drawn as the band it hides
    c.arc(cx, cy, R, 0, 7); const n = NXT.horizon.length;
    for (let i = n; i >= 0; i--) { const [x, y] = P(i % n * 360 / n, NXT.horizon[i % n]); i === n ? c.moveTo(x, y) : c.lineTo(x, y); }
    c.fill("evenodd");
    c.strokeStyle = "#272930"; c.lineWidth = 1; for (const e of [30, 60]) { c.beginPath(); c.arc(cx, cy, (90 - e) / 90 * R, 0, 7); c.stroke(); }
    c.setLineDash([3, 4]); c.strokeStyle = "#9AA8CC"; c.beginPath(); c.arc(cx, cy, (90 - NXT.min_el) / 90 * R, 0, 7); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#9AA8CC"; c.font = "12px 'IBM Plex Mono', monospace"; c.fillText("N", cx - 3, 9); c.fillText("E", w - 9, cy + 3); c.fillText("S", cx - 3, h - 2); c.fillText("W", 1, cy + 3);
    for (let i = 1; i < sm.length; i++) {
      const [x0, y0] = P(sm[i - 1][1], sm[i - 1][2]), [x1, y1] = P(sm[i][1], sm[i][2]);
      c.strokeStyle = col; c.globalAlpha = sm[i][5] ? 1 : 0.3; c.lineWidth = sm[i][5] ? 2.4 : 1.4; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    }
    c.globalAlpha = 1;
    if (cur) { const [x, y] = P(cur[1], cur[2]); c.fillStyle = "#fff"; c.beginPath(); c.arc(x, y, 4.5, 0, 7); c.fill(); }
  }
  function playDop() {
    if (DP.osc) return stopDop();
    const p = DP.p, a = audio(), n = p.samples.length, dur = Math.min(14, Math.max(7, n / 3)) * 1000, T0 = performance.now(); a.resume();
    DP.osc = { o: a.createOscillator(), g: a.createGain() }; DP.osc.o.type = "sine"; DP.osc.g.gain.value = 0; DP.osc.o.connect(DP.osc.g).connect(a.destination); DP.osc.o.start();
    $("dopPlay").textContent = "Stop";
    const step = now => {
      const k = Math.max(0, (now - T0) / dur * (n - 1)); if (k >= n - 1 || !DP.osc) { stopDop(); drawDop(); return; }
      DP.k = k; const i = Math.floor(k), f = k - i, hz = p.samples[i][4] + (p.samples[i + 1][4] - p.samples[i][4]) * f;
      // real shift is a few kHz on a 437 MHz carrier; mapped to +/- a fifth around 600 Hz so you can hear it
      DP.osc.o.frequency.setTargetAtTime(600 * Math.pow(2, hz / (p.doppler_max_hz || 1) * 0.58), a.currentTime, 0.03);
      DP.osc.g.gain.setTargetAtTime(p.samples[i][5] ? 0.09 : 0.015, a.currentTime, 0.05);
      drawDop(); DP.raf = requestAnimationFrame(step);
    };
    DP.raf = requestAnimationFrame(step);
  }
  $("dopPlay").onclick = playDop; $("dopClose").onclick = closeDop;

  /* ---------- canvases ---------- */
  function fit(cv) { const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); cv.width = r.width * d; cv.height = r.height * d; const c = cv.getContext("2d"); c.setTransform(d, 0, 0, d, 0, 0); return [c, r.width, r.height]; }
  const TL = { t0: 0, span: 26 * 3600, gut: 112 };
  function drawTimeline() {
    const [c, w, h] = fit($("timeline")); if (!w || !h) return;
    TL.gut = 4; TL.t0 = Math.floor(S.now0 / 3600) * 3600 - 3600;
    const pw = w - TL.gut - 4, X = t => TL.gut + (t - TL.t0) / TL.span * pw;
    const top = 4, band = 8, axis = 15, rows0 = top + band + 5, rowH = Math.max(5, (h - rows0 - axis) / ONAMES.length);
    c.clearRect(0, 0, w, h);
    for (let px = TL.gut; px < w - 4; px += 2) {                                   // daylight band
      const t = TL.t0 + (px - TL.gut) / pw * TL.span, el = sunAt(t).el, k = Math.max(0, Math.min(1, el / 40));
      c.fillStyle = el <= 0 ? "#0b1220" : `rgb(${40 + 215 * k},${32 + 160 * k},${40 + 80 * k})`;
      c.fillRect(px, top, 2, band);
    }
    ONAMES.forEach((n, i) => {                                                      // one row per relay orbiter
      const y = rows0 + i * rowH;
      c.fillStyle = "rgba(255,255,255,0.045)"; c.fillRect(TL.gut, y, pw, rowH - 2);
      c.fillStyle = ORB[n].c;
      for (const p of DB.passes) if (p.orbiter === n) { c.globalAlpha = 0.4 + 0.6 * Math.min(1, p.max_el / 60); c.fillRect(X(p.start), y, Math.max(2, X(p.end) - X(p.start)), rowH - 2); }
      c.globalAlpha = 1;
    });
    c.font = "11px 'IBM Plex Mono', monospace"; c.fillStyle = "#97adba";           // hour axis
    const hs = pw < 300 ? 21600 : pw < 560 ? 14400 : 7200; for (let t = Math.ceil(TL.t0 / hs) * hs; t < TL.t0 + TL.span; t += hs) { c.fillRect(X(t), h - axis + 1, 1, 4); c.fillText(fUTC(t).slice(0, 2), X(t) - 5, h - 2); }
    const r = walk.on ? walk.route : S.route, a = walk.on ? walk.t0 : departT();    // the planned EVA window
    if (r) {
      const x0 = X(a), x1 = X(a + r.time_s);
      c.fillStyle = "rgba(59,130,246,0.22)"; c.fillRect(x0, top - 1, x1 - x0, h - axis); c.strokeStyle = "#8ab8ff"; c.lineWidth = 1; c.strokeRect(x0 + 0.5, top - 0.5, x1 - x0, h - axis - 1);
      c.fillStyle = "#6EE7A8"; for (const k of r.contacts) if (k.start) c.fillRect(X(k.start), h - axis - 3, Math.max(2, X(k.end) - X(k.start)), 3);
    }
    const cx = X(clockT()); c.fillStyle = "#fff"; c.fillRect(cx, 0, 1.5, h - axis + 2);   // now
  }
  $("timeline").addEventListener("click", e => {
    if (walk.on) return;
    const r = $("timeline").getBoundingClientRect(), w = r.width;
    const t = TL.t0 + (e.clientX - r.left - TL.gut) / (w - TL.gut - 6) * TL.span;
    setDepart(Math.round((t - S.now0) / 300) * 5);
  });
  function drawProfile() {
    const [c, w, h] = fit($("profile")); if (!w) return; c.clearRect(0, 0, w, h);
    const r = walk.on ? walk.route : S.route;
    c.font = "12px 'IBM Plex Mono', monospace";
    if (!r) { c.fillStyle = "#9AA8CC"; c.fillText("No route yet", 8, h / 2); $("profSub").textContent = ""; return; }
    const lo = Math.min(...r.z) - 5, hi = Math.max(...r.z) + 5, D = r.distance_m || 1;
    const X = d => 34 + d / D * (w - 42), Y = z => h - 14 - (z - lo) / (hi - lo) * (h - 26);
    $("profSub").textContent = `${Math.round(lo + 5)} to ${Math.round(hi - 5)} m`;
    c.beginPath(); c.moveTo(X(0), h - 14); r.d.forEach((d, i) => c.lineTo(X(d), Y(r.z[i]))); c.lineTo(X(D), h - 14); c.closePath();
    const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "rgba(168,201,215,0.45)"); gr.addColorStop(1, "rgba(168,201,215,0.03)");
    c.fillStyle = gr; c.fill();
    for (let i = 1; i < r.d.length; i++) {
      const s = r.slope[i];
      c.strokeStyle = SLCOL(s); c.lineWidth = s >= 8 ? 2.4 : 1.8;
      c.beginPath(); c.moveTo(X(r.d[i - 1]), Y(r.z[i - 1])); c.lineTo(X(r.d[i]), Y(r.z[i])); c.stroke();
    }
    c.fillStyle = "#93B7E6";
    r.stop_idx.slice(1, -1).forEach((i, k) => { c.fillRect(X(r.d[i]), 4, 1, h - 18); c.fillText(String(k + 1), X(r.d[i]) + 3, 12); });
    c.fillStyle = "#9AA8CC"; c.fillText(Math.round(hi - 5), 2, 14); c.fillText(Math.round(lo + 5), 2, h - 16);
    c.fillText("0", 34, h - 3); c.fillText(fKm(D), w - 50, h - 3);
    if (walk.on) { const d = walk.dAlong; c.fillStyle = "#fff"; c.beginPath(); c.arc(X(d), Y(walk.zNow), 4, 0, 7); c.fill(); }
  }

  /* ---------- sound ---------- */
  let AC = null, dop = null;
  const audio = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());
  function chime(name, twice, force) {
    if (!S.sound && !force) return;
    const a = audio(), o = ORB[name]; let t = a.currentTime;
    for (let rep = 0; rep < (twice ? 2 : 1); rep++) for (const f of o.f) {
      const osc = a.createOscillator(), gn = a.createGain();
      osc.type = o.w; osc.frequency.value = f; gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(0.12, t + 0.02); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.connect(gn).connect(a.destination); osc.start(t); osc.stop(t + 0.3); t += 0.2;
    }
  }
  function dopplerTone(p, t) {
    if (!S.doppler || !p || !walk.on) { if (dop) { dop.g.gain.setTargetAtTime(0, audio().currentTime, 0.05); } return; }
    const a = audio();
    if (!dop) { dop = { o: a.createOscillator(), g: a.createGain() }; dop.o.type = "sine"; dop.g.gain.value = 0; dop.o.connect(dop.g).connect(a.destination); dop.o.start(); }
    // range-rate (km/s) from Horizons: approaching = higher pitch. Audible exaggeration of the real kHz shift.
    const rr = sampleAt(p, t)[4];
    dop.o.frequency.setTargetAtTime(520 * Math.pow(2, -rr / 3.4 * 0.6), a.currentTime, 0.1);
    dop.g.gain.setTargetAtTime(0.05, a.currentTime, 0.1);
  }
  // One quiet notification on screen at a time. Everything is kept in the log behind the bell.
  const LOG = []; let logNew = 0;
  function renderLog() {
    $("logCount").textContent = logNew ? String(Math.min(logNew, 99)) : "";
    if ($("logPanel").hidden) return;
    $("logPanel").innerHTML = "<h3>Notifications</h3>" + (LOG.length ? LOG.map(e => `<div class="logrow"><i style="background:${e.color}"></i><b>${e.title}</b><time>${fUTC(e.t)}</time><span>${e.msg}</span></div>`).join("") : "<p>Nothing yet. Satellite passes, position fixes and route changes show up here.</p>");
  }
  function toast(title, msg, color = "#8ab8ff") {
    LOG.unshift({ title, msg, color, t: clockT() }); if (LOG.length > 40) LOG.pop();
    if ($("logPanel").hidden) logNew++; renderLog();
    const d = document.createElement("div"); d.className = "toast";
    d.innerHTML = `<i style="background:${color}"></i><div><b>${title}</b><span>${msg}</span></div>`;
    $("toasts").replaceChildren(d);
    clearTimeout(toast.h); toast.h = setTimeout(() => d.remove(), 5200);
  }
  /* ---------- the guide: says in plain words what just happened, on screen and out loud ---------- */
  const VOICE = { on: true }; try { const v0 = localStorage.getItem("mw_voice"); if (v0 !== null) VOICE.on = v0 === "1"; } catch (e) { /* private mode */ }
  const BOT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8.5" width="14" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.5V5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="4.3" r="1.4" fill="currentColor"/><circle cx="9.2" cy="13.3" r="1.35" fill="currentColor"/><circle cx="14.8" cy="13.3" r="1.35" fill="currentColor"/></svg>';
  const SPK = on => on ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z" fill="currentColor"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4Z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const wDur = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.round(sec % 3600 / 60); return h ? `${h} hour${h > 1 ? "s" : ""}${m ? ` ${m} minutes` : ""}` : m < 1 ? "under a minute" : `${m} minute${m > 1 ? "s" : ""}`; };
  const wKm = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : m >= 100 ? `${Math.round(m / 10) * 10} m` : `${Math.max(1, Math.round(m))} m`;
  const compass = (dx, dy) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 / 45) % 8];
  const speakable = t => t.replace(/±\s?/g, "plus or minus ").replace(/(\d)\s?km\b/g, "$1 kilometres").replace(/(\d)\s?m\b/g, "$1 metres").replace(/°/g, " degrees").replace(/µSv/g, "microsieverts").replace(/×/g, "times ").replace(/\bMRO\b/g, "M R O").replace(/\bTGO\b/g, "T G O");
  function speak(text) {
    if (!VOICE.on || !window.speechSynthesis) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(speakable(text)); u.lang = "en-US"; u.rate = 1.03; speechSynthesis.speak(u); } catch (e) { /* no voice on this device */ }
  }
  function setVoice(on) {
    VOICE.on = on; try { localStorage.setItem("mw_voice", on ? "1" : "0"); } catch (e) { /* private mode */ }
    if (!on && window.speechSynthesis) speechSynthesis.cancel();
    document.querySelectorAll(".vox").forEach(b => { b.innerHTML = SPK(on); b.setAttribute("aria-pressed", String(on)); b.title = on ? "Voice on. Tap to mute." : "Voice off. Tap to turn on."; });
    $("voiceLay").setAttribute("aria-pressed", String(on));
  }
  // title: a few words. text: what happened, in plain words (this is what is read out). logText: extra detail kept in the log only.
  function guide(title, text, color = "#8ab8ff", logText) {
    LOG.unshift({ title, msg: logText ? `${text} ${logText}` : text, color, t: clockT() }); if (LOG.length > 40) LOG.pop();
    if ($("logPanel").hidden) logNew++; renderLog();
    const d = document.createElement("div"); d.className = "toast guide"; d.style.setProperty("--c", color);
    d.innerHTML = `<i class="bot">${BOT_SVG}</i><div><b>${title}</b><span>${text}</span></div><button type="button" class="vox" aria-label="Guide voice" aria-pressed="${VOICE.on}" title="${VOICE.on ? "Voice on. Tap to mute." : "Voice off. Tap to turn on."}">${SPK(VOICE.on)}</button>`;
    d.querySelector(".vox").onclick = e => { e.stopPropagation(); setVoice(!VOICE.on); };
    d.onclick = () => d.remove();
    $("toasts").replaceChildren(d);
    clearTimeout(toast.h); toast.h = setTimeout(() => d.remove(), Math.min(18000, 6000 + text.length * 55));
    speak(text);
  }
  $("voiceLay").onclick = () => setVoice(!VOICE.on); $("voiceLay").setAttribute("aria-pressed", String(VOICE.on));
  // "you were this far off": a red dashed line from where the suit thought you were to where you really are, for a few seconds
  let missLayer = null;
  function showMiss(ox, oy, nx, ny) {
    const d = Math.hypot(nx - ox, ny - oy); if (d < 3) return;
    if (missLayer) map.removeLayer(missLayer);
    const line = L.polyline([ll(ox, oy), ll(nx, ny)], { color: "#fc3d21", weight: 3, dashArray: "6 6", interactive: false });
    missLayer = L.layerGroup([line, L.circleMarker(ll(ox, oy), { radius: 6, color: "#fc3d21", weight: 2, fill: false, interactive: false })]).addTo(map);
    line.bindTooltip(`${Math.round(d)} m off`, { permanent: true, direction: "center", className: "misstip" }).openTooltip();
    const mine = missLayer; setTimeout(() => { if (missLayer === mine) { map.removeLayer(mine); missLayer = null; } }, 14000);
    T3.miss = { ox, oy, nx, ny, d, until: performance.now() + 14000, id: (T3.miss ? T3.miss.id : 0) + 1 };
  }
  // the new route in one or two sentences: how far to the next stop, how much in all, how it compares, what the ground is like
  function routeWords(r, oldRem) {
    const i1 = r.stop_idx[1] ?? r.x.length - 1, tgt = r.stopsReq[1], left = r.stopsReq.slice(1).filter(w => w !== HAB).length;
    const name = tgt === HAB ? "the habitat" : `waypoint ${Math.max(1, S.stops.length - left + 1)}`, one = r.stopsReq.length <= 2;
    const diff = oldRem == null ? null : r.distance_m - oldRem;
    const cmp = diff == null ? "" : Math.abs(diff) < 30 ? ", about the same length as before" : diff > 0 ? `, ${wKm(diff)} longer than before` : `, ${wKm(-diff)} shorter than before`;
    const mx = r.slope_mix || {}, ground = mx.steep > 0.5 ? `Careful: part of it is steep, up to ${r.max_slope.toFixed(0)}°.` : mx.yellow > 3 ? `Mostly flat, with slopes up to ${r.max_slope.toFixed(0)}°.` : "It stays on flat ground.";
    return `New ${POLICY()} route: ${wKm(r.d[i1])} to ${name}, about ${wDur(r.t[i1])}${one ? cmp : `. ${wKm(r.distance_m)} left in all${cmp}`}. ${ground}`;
  }
  $("logBtn").onclick = e => { e.stopPropagation(); const open = $("logPanel").hidden; $("logPanel").hidden = !open; $("logBtn").setAttribute("aria-expanded", String(open)); if (open) logNew = 0; renderLog(); };
  addEventListener("click", e => { if (!$("logPanel").hidden && !e.target.closest("#logPanel")) { $("logPanel").hidden = true; $("logBtn").setAttribute("aria-expanded", "false"); } });

  /* ---------- walk simulation ---------- */
  const me = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 900 });
  const ghost = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="ghost"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, zIndexOffset: 800 }).bindTooltip("true position", { permanent: false });
  const unc = L.circle(ll(...HAB), { radius: 3, color: "#93B7E6", weight: 1.5, fillColor: "#93B7E6", fillOpacity: 0.16, interactive: false });
  function startWalk() {
    if (!S.route || S.route.x.length < 2) return;
    Object.assign(walk, { on: true, route: S.route, t0: departT(), simT: departT(), odo: 0, odoFix: 0, theta: Math.random() * 6.28,
      drift: [0, 0], dAlong: 0, _i: 0, ri: 0, lock: "", lockKey: "", px: null, follow: true, busy: false, hzOn: false, zNow: S.route.z[0], inContact: false, alerted: new Set(), dose: 0, lastSun: 0, last: performance.now(), dwellSaid: -1 });
    Object.assign(walk, { manual: false, fixKey: null, fxN: "", sig: 1.5, rest: [], hd: 0, still: true, keys: {}, lastRe: 0, ri: 0, lock: "", lockKey: "", loose: false, habOk: undefined, hb: null, src: "suit", habPosSaid: false, habReSaid: false }); HL.t = 0; T3.pathHead = null; syncDrive();
    me.addTo(map); unc.addTo(map); if (S.truth) ghost.addTo(map);
    walk._painted = -1;
    camWalk();
    if (!mq.matches && !document.body.classList.contains("nopanel")) { UI.autoHid = true; showPanel(false); }      // the walk gets the whole screen; the panel button brings it back
    document.body.classList.remove("showui"); syncPanelTog();
    $("hud").hidden = false; $("homeBtn").disabled = false; syncWalk(); closeSheet(); navLine.clearLayers();
    $("depart").disabled = true; drawStops();
    { const np = DB.passes.find(q => q.end > walk.simT);
      guide(S.vehicle === "rover" ? "Drive started" : "Walk started", np && np.start <= walk.simT ? `${np.orbiter} is overhead right now. In a moment it will measure exactly where you are.`
        : `There is no GPS on Mars. ${S.vehicle === "rover" ? "The rover counts wheel turns" : "Your suit counts steps"} to estimate where you are, and that estimate slowly drifts.${np ? ` ${np.orbiter} comes overhead in ${wDur(np.start - walk.simT)} and will tell you exactly where you are.` : ""}`, "#8ab8ff"); }
    audio().resume();                                  // the Start press is the tap browsers need before any beep
  }
  const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5v15l12-7.5z" fill="currentColor"/></svg>', STOP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';
  function syncWalk() {
    const on = !!walk.on, r = S.route, b = $("walkBtn"), f = $("fab");
    b.innerHTML = on ? STOP_SVG : PLAY_SVG; b.setAttribute("aria-label", on ? "End simulation" : "Start simulation"); b.title = on ? "End simulation" : "Start simulation"; b.classList.toggle("halt", on); b.disabled = !r && !on;
    f.hidden = !(r || on); f.classList.toggle("halt", on);
    f.innerHTML = on ? "End simulation" : r ? `Start simulation<small>${(r.distance_m / 1000).toFixed(1)} km · ${(r.time_s / 3600).toFixed(1)} h</small>` : "";
    document.body.classList.toggle("walking", on);
  }
  function endWalk(msg) {
    walk.on = false; walk.manual = false; T3.pathHead = null; T3.dirty = true; syncDrive(); [me, unc, ghost].forEach(l => map.removeLayer(l));
    $("hud").hidden = true; $("homeBtn").disabled = true; syncWalk();
    $("radioDock").hidden = true;
    if (UI.autoHid && !mq.matches) showPanel(true); UI.autoHid = false; document.body.classList.remove("showui"); syncPanelTog();
    $("depart").disabled = false; dopplerTone(null);
    if (msg) guide("Walk complete", msg, "#6EE7A8");
    if (MODE === "explore" && $("explore")) { $("exGo").textContent = "Walk again"; $("exRover").textContent = "Drive again"; setTimeout(() => { $("explore").hidden = false; }, msg ? 2500 : 0); }
    drawStops(); showRoute();
  }
  function posOn(r, el) {
    let i = 1; const t = r.t; if (walk._i && t[walk._i - 1] <= el) i = walk._i;
    while (i < t.length - 1 && t[i] < el) i++;
    walk._i = i;
    const k = Math.min(1, Math.max(0, (el - t[i - 1]) / ((t[i] - t[i - 1]) || 1)));
    return { i, x: r.x[i - 1] + (r.x[i] - r.x[i - 1]) * k, y: r.y[i - 1] + (r.y[i] - r.y[i - 1]) * k,
      d: r.d[i - 1] + (r.d[i] - r.d[i - 1]) * k, z: r.z[i - 1] + (r.z[i] - r.z[i - 1]) * k };
  }
  // opt.soft: keep walking while the planner works (used while a satellite is tracking a hand-steered astronaut). opt.quiet: no notification.
  async function reroute(from, stops, why, color = "#6EE7A8", opt = {}) {
    if (walk.busy || walk.planning) return; if (opt.soft) walk.planning = true; else walk.busy = true;
    setTimeout(() => { if (walk.busy) { $("hudNext").textContent = "Planning the new route…"; $("hudSub").textContent = "The clock is paused for a moment"; } }, 0);    // say so instead of freezing
    try {
      const r = await requestRoute([from, ...stops], walk.simT);
      r.stopsReq = [from, ...stops]; walk.route = r; walk.t0 = walk.simT; walk._i = 0; walk._painted = -1; walk.dAlong = 0; walk.ri = 0; walk.px = null; walk.loose = false;
      if (!opt.quiet) { if (opt.lead != null) guide(opt.title || "Route updated", opt.words === false ? opt.lead : `${opt.lead} ${routeWords(r, opt.oldRem)}`.trim(), color, opt.log); else toast(opt.title || "Route updated", why, color); }
      T3.dirty = true;
    } catch (e) { if (!opt.soft) toast("Could not plan a route", e.message, "#F0616B"); }
    walk.busy = false; walk.planning = false;
  }
  /* Position from the relay link. The radio measures range and range rate (Doppler) to the orbiter once a minute;
     here those numbers are simulated from the true position with noise, then solved by least squares (relayfix.js).
     Orbiter geometry is the real JPL Horizons pass. Height comes from the terrain map. */
  const FIX_STEP = 10;                                   // seconds between radio measurements during a pass
  function relayFix(q, tx, ty, gx, gy) {
    if (!q || !window.RelayFix || q.samples.length < 2) return null;
    const t0 = Math.max(q.start, q.samples[0][0]), n = Math.min(120, Math.floor((walk.simT - t0) / FIX_STEP) + 1); if (n < 3) return null;
    const t1 = t0 + Math.floor((walk.simT - t0) / FIX_STEP) * FIX_STEP, ep = RelayFix.epochs(q.samples, t1 - (n - 1) * FIX_STEP, t1, FIX_STEP);
    const u = (elevAt(tx, ty) ?? 0) - (elevAt(...HAB) ?? 0);
    const fx = RelayFix.solve(ep, { e: tx - HAB[0], n: ty - HAB[1], u }, { e: gx - HAB[0], n: gy - HAB[1] }, { gauss: RelayFix.seeded(q.start) });
    if (!fx || !isFinite(fx.e) || !isFinite(fx.sigma)) return null;
    return { x: fx.e + HAB[0], y: fx.n + HAB[1], sigma: fx.sigma, err: fx.err, used: fx.used, orbiter: q.orbiter, key: q.orbiter + q.start, n: Math.round((t1 - t0) / FIX_STEP) };
  }
  /* The suit's own estimate (dead reckoning) is "believed"; walk.drift = believed minus true. It grows with every metre walked
     and a relay fix pulls it back. The uncertainty ring is drawn round the believed position. */
  function driftBy(step) {
    if (!(step > 0)) return;
    walk.theta += (Math.random() - 0.5) * 0.12 * Math.sqrt(step);               // the heading bias wanders slowly, so the error builds one way and then curves
    walk.drift[0] += Math.cos(walk.theta) * 0.7 * DRIFT * step; walk.drift[1] += Math.sin(walk.theta) * 0.7 * DRIFT * step;
  }
  /* Habitat radio positioning. While the mast can see the suit it measures how far away it is (two-way ranging)
     and in which direction (direction finding), a little like an airport beacon. Assumed accuracy, one sigma:
     5 m in range and 1 degree in bearing. So the fix is tight near the habitat and loose far away, and it is
     the range that is good, not the direction. The errors wander slowly instead of jumping at every measurement. */
  const HAB_SR = 5, HAB_SB = Math.PI / 180;
  function habFix(tx, ty) {                              // one new measurement every FIX_STEP seconds; null in between or when the mast cannot see you
    if (!habNow().ok) { walk.hb = null; return null; }
    const ep = Math.floor(walk.simT / FIX_STEP); if (walk.hb && walk.hb.ep === ep) return null;
    const o = walk.hb || { er: 0, eb: 0 }, n = walk.hb ? Math.max(1, ep - walk.hb.ep) : 60, rho = Math.exp(-n * FIX_STEP / 300), g = RelayFix.seeded((Math.imul(ep, 2654435761) >>> 0) || 7), q = Math.sqrt(1 - rho * rho);
    const er = o.er * rho + HAB_SR * q * g(), eb = o.eb * rho + HAB_SB * q * g();
    walk.hb = { ep, er, eb };
    const dx = tx - HAB[0], dy = ty - HAB[1], d = Math.hypot(dx, dy); if (d < 15) return null;
    const r = Math.max(1, d + er), b = Math.atan2(dx, dy) + eb;
    return { x: HAB[0] + Math.sin(b) * r, y: HAB[1] + Math.cos(b) * r, r, d, rad: 2 * Math.hypot(HAB_SR, r * HAB_SB) };      // rad: 95 % bound, like the ring
  }
  const habMsg = (f, jump) => `The habitat mast measured you ${fKm(f.r)} away and gave your position: ${fLL(f.x, f.y)}, good to ±${Math.round(f.rad)} m. The suit's own estimate was ${Math.round(jump)} m out. New ${POLICY()} route planned from there.`;
  // One step of the fix while pass q is in view. Returns the correction when the estimate was just updated, else null.
  function navFix(q, tx, ty, good) {
    const key = q.orbiter + q.start, bx = tx + walk.drift[0], by = ty + walk.drift[1];
    if (walk.lockKey !== key) {
      walk.lockKey = key; walk.lock = "search"; walk.fxN = ""; walk.lockDrift = null;
      guide(`${q.orbiter} is overhead`, `${q.orbiter} is above you now. It measures how far away you are every 10 seconds, and in about half a minute it will know where you are. You can also talk to Earth while it is up.`, ORB[q.orbiter].c);
    }
    const fx = relayFix(q, tx, ty, bx, by);
    if (!fx || walk.fxN === key + fx.n) return null;
    walk.fxN = key + fx.n;
    if (fx.sigma > good) return null;                                            // geometry still too weak: keep listening
    const first = walk.fixKey !== key; if (first) walk.lockDrift = [walk.drift[0], walk.drift[1]];      // how far out the suit was when this pass began
    walk.drift = [fx.x - tx, fx.y - ty]; walk.sig = Math.max(1.5, 2 * fx.sigma); walk.odoFix = walk.odo; walk.fixKey = key; walk.lock = "fix"; walk.src = "suit";
    return { ...fx, jump: Math.hypot(fx.x - bx, fx.y - by), first };
  }
  // dx, dy: from where the suit thought you were to where you really are
  const offWords = (who, dx, dy) => { const d = Math.hypot(dx, dy), me = S.vehicle === "rover" && walk.on ? "the rover" : "your suit"; return d < 3 ? `${who} has measured your position. ${me[0].toUpperCase() + me.slice(1)} had it right, to within ${Math.max(1, Math.round(d))} m.` : `${who} has measured your position. You were ${Math.round(d)} m ${compass(dx, dy)} of where ${me} thought.`; };
  const fixMsg = (orb, f) => `${orb} gave your position: ${fLL(f.x, f.y)}, good to ±${Math.max(2, Math.round(2 * f.sigma))} m. The suit's own estimate was ${Math.round(f.jump)} m out. New ${POLICY()} route planned from there.`;
  const shortOrb = n => n.split(" ").pop();              // "Mars Odyssey" -> "Odyssey": the HUD is narrow on a phone
  const fLL = (x, y) => { const [lo, la] = lonLat(x, y); return `${Math.abs(la).toFixed(4)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(4)}°${lo >= 0 ? "E" : "W"}`; };
  const POLICY = () => ({ safe: "Safest", balanced: "Balanced", fast: "Fastest" })[S.style] || "custom";
  function hudRelay(con, bx, by) {
    const np = DB.passes.find(q => q.start > walk.simT + 20), el = $("hudLink"), locked = con && walk.lock === "fix";
    el.textContent = con ? (locked ? `${shortOrb(con.orbiter)} fix ±${Math.round(walk.sig)} m` : `${shortOrb(con.orbiter)} locking on`) : np ? `${shortOrb(np.orbiter)} in ${fDur(np.start - walk.simT)}` : "none in view";
    el.style.color = con ? "var(--ok)" : "var(--ink)";
    $("skipPass").hidden = !!con || !np;
    const h = habNow(), hb = $("hudHab");
    hb.textContent = h.ok ? `linked · ${fKm(h.d)}` : "hidden by terrain"; hb.style.color = h.ok ? "var(--ok)" : "var(--warn)";
    if (walk.habOk !== undefined && walk.habOk !== h.ok && performance.now() - (walk.habSaid || 0) > 15000 && (walk.habSaid = performance.now())) guide(h.ok ? "Habitat link is back" : "Habitat link lost", h.ok ? "The habitat mast can see you again. You can talk to the habitat, and it can help place you." : `The ground between you and the habitat is in the way, ${wKm(h.d)} from home. Messages to the habitat wait until the link is back or a satellite passes.`, h.ok ? "#6EE7A8" : "#F5B85B");
    walk.habOk = h.ok;
    $("hudPosL").textContent = "Position · " + (locked ? "sat" : walk.src === "hab" ? "hab" : S.vehicle === "rover" ? "rover" : "suit"); $("hudPosL").title = locked ? "Position from the satellite fix" : walk.src === "hab" ? "Position from the habitat mast (range and bearing)" : "Position from the suit's own dead reckoning";
  }
  // "Wait here for the next satellite": jump the clock to just before the next pass. The astronaut stays where they are.
  function skipToPass() {
    if (!walk.on || walk.busy) return;
    const np = DB.passes.find(q => q.start > walk.simT + 20); if (!np) return toast("No pass coming", "No relay pass in the next two days of data.", "#F5B85B");
    const dt = np.start - 12 - walk.simT; if (dt <= 0) return;
    walk.simT += dt; walk.dose += (walk.route.dose_msv / (walk.route.time_s || 1)) * dt; walk.alerted.add(np.orbiter + np.start + "a"); warm(np.start); warm(np.start + 600);
    if (walk.manual) return guide("Skipped the wait", `You waited ${wDur(dt)}. ${np.orbiter} rises in a few seconds and will measure where you are.`, ORB[np.orbiter].c);
    walk.t0 += dt; walk.loose = true;                                // this route's contact list was worked out for the old clock: use the pass itself until the next replan
    guide("Skipped the wait", `You waited ${wDur(dt)}. ${np.orbiter} rises in a few seconds and will measure where you are.`, ORB[np.orbiter].c);
  }
  // The planner works out sunlight, cold and radio cover for the time asked. Doing that ahead of a pass makes the replan at the fix take a fraction of a second.
  const warm = t => { requestRoute([HAB, [Math.min(M.width_m - DX, HAB[0] + 3 * DX), Math.min(M.height_m - DY, HAB[1] + 3 * DY)]], t).catch(() => {}); };
  // nearest route node at or ahead of where we last were, and how far the point is from the route
  function nearAhead(r, x, y) {
    const j0 = Math.min(walk.ri || 0, r.x.length - 1); let best = j0, bd = 1e18;
    for (let j = j0; j < Math.min(r.x.length, j0 + 160); j++) { const d = (r.x[j] - x) ** 2 + (r.y[j] - y) ** 2; if (d < bd) { bd = d; best = j; } }
    walk.ri = best; return Math.sqrt(bd);
  }
  const REACH = 8, REACH_HOME = 5;                       // metres: you have to walk up to the marker, or back to the airlock
  function syncDrive() {
    const on = !!(walk.on && walk.manual); document.body.classList.toggle("driving", on);
    const b = $("t3drive"), c = $("driveBtn"); [b, c].forEach(x => { if (x) { x.setAttribute("aria-pressed", String(on)); x.textContent = on ? "Autopilot" : "Take control"; } });
    $("stick").hidden = !on;
  }
  function takeControl() {
    if (!walk.on) { if (!S.route) return; startWalk(); }
    if (walk.manual || walk.busy) return;
    const r = walk.route, q = posOn(r, walk.simT - walk.t0);
    const k = r.stop_idx.slice(1).filter(i => i <= q.i).length;
    walk.rest = r.stopsReq.slice(1 + k); if (!walk.rest.length) walk.rest = [HAB];
    walk.mx = q.x - walk.drift[0]; walk.my = q.y - walk.drift[1];           // the true position (believed = true + drift)
    const j = Math.min(r.x.length - 1, q.i + 3); walk.hd = Math.atan2(r.x[j] - q.x, r.y[j] - q.y) || 0;
    walk.manual = true; walk.still = true; walk.blocked = 0; walk.ri = Math.max(0, q.i - 1); syncDrive(); T3.dirty = true;
    if (S.speed > 30) { const b30 = document.querySelector('.spd[data-s="30"]'); if (b30) b30.click(); }
    camWalk();
    if (!T3.vr) toast("Manual control", matchMedia("(pointer: coarse)").matches ? "Use the stick: up to walk, sideways to turn." : "W / S walk, A / D turn (or the arrow keys).", "#8ab8ff");
  }
  async function releaseControl() {
    if (!walk.manual || walk.busy) return;
    const b = [walk.mx + walk.drift[0], walk.my + walk.drift[1]];
    await reroute(b, walk.rest, "", "#8ab8ff", { title: "Autopilot on", lead: "I will walk the rest from your estimated position." });
    walk.manual = false; T3.dirty = true; syncDrive();
  }
  const stick = { x: 0, y: 0 };
  function padAxes() {                                  // first connected gamepad's left stick, or null when it is centred
    const g = navigator.getGamepads ? [...navigator.getGamepads()].find(x => x && x.connected) : null; if (!g || g.axes.length < 2) return null;
    const x = g.axes[0], y = -g.axes[1]; return Math.abs(x) > 0.15 || Math.abs(y) > 0.15 ? [x, y] : null;
  }
  function padTick() {
    const g = navigator.getGamepads ? [...navigator.getGamepads()].find(x => x && x.connected) : null; if (!g) return;
    const a = !!(g.buttons[0] && g.buttons[0].pressed); if (a && !padTick.a) jump(); padTick.a = a;
    if (walk.on && !walk.manual && padAxes()) takeControl();
  }
  function driveInput() {
    if (T3.vr && T3.vrHold) return [0, 0];               // tour: standing still while looking round
    if (T3.vr && T3.vrHead) {                             // VR: walk where you look at a steady pace; look down at the panel to stop
      const h = T3.vrHead, gp = padAxes(); let e = h.hd - walk.hd; e = Math.atan2(Math.sin(e), Math.cos(e));
      const f = gp && Math.abs(gp[1]) > 0.15 ? gp[1] : h.atCard || h.pitch < -0.55 ? 0 : 1, t = h.atCard || Math.abs(e) > 0.32 ? 0 : Math.max(-1, Math.min(1, e * 3));      // small head turns steer; look further aside to look around without turning
      return [t * (f < 0 ? -1 : 1), f];
    }
    const k = walk.keys || {};
    let turn = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0), fwd = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
    if (Math.abs(stick.x) > 0.12 || Math.abs(stick.y) > 0.12) { turn = stick.x; fwd = stick.y; }
    const gp = padAxes(); if (gp) { turn = gp[0]; fwd = gp[1]; }
    return [turn, fwd];
  }
  function offRoute(r, x, y) { let m = 1e12; for (let i = 0; i < r.x.length; i += 2) { const d = (r.x[i] - x) ** 2 + (r.y[i] - y) ** 2; if (d < m) m = d; } return Math.sqrt(m); }
  function manualStep(dt, now) {
    const r = walk.route, [turn, fwd] = driveInput(), simDt = dt * S.speed;
    walk.hd += turn * (S.vehicle === "rover" ? 0.9 : 1.9) * dt * (fwd < 0 ? -1 : 1);
    const sl0 = slopeAt(walk.mx, walk.my) ?? 0, x0 = walk.mx, y0 = walk.my;
    let step = 0; walk.still = Math.abs(fwd) < 0.05;
    if (!walk.still) {
      const v = S.vehicle === "rover" ? 2.8 * (1 - 0.6 * Math.min(1, sl0 / 20)) * (fwd < 0 ? 0.4 : 1)        // rover: about 10 km/h on the flat (assumed)
        : 1.25 * (T3.vr ? 1.5 : 1) * Math.max(0.2, 1 - sl0 / 32) * (fwd < 0 ? 0.5 : 1);     // VR: a brisk 1.9 m/s on the flat                   // m/s in a suit, slower on slope
      step = v * Math.abs(fwd) * simDt;
      const sg = Math.sign(fwd), nx = walk.mx + Math.sin(walk.hd) * step * sg, ny = walk.my + Math.cos(walk.hd) * step * sg, sl = slopeAt(nx, ny);
      if (sl == null || nx < DX * 2 || ny < DY * 2 || nx > M.width_m - DX * 2 || ny > M.height_m - DY * 2) { step = 0; if (now - (walk.blocked || 0) > 4000) { walk.blocked = now; toast("Edge of the mapped area", "Turn back.", "#F5B85B"); } }
      else if (sl > (S.vehicle === "rover" ? 25 : 34) && sl > sl0) { step = 0; if (now - (walk.blocked || 0) > 4000) { walk.blocked = now; toast("Too steep", `${sl.toFixed(0)}° ahead. ${S.vehicle === "rover" ? "The rover cannot climb that" : "A suited astronaut cannot climb that"}. Go around.`, "#F0616B"); } }
      else { walk.mx = nx; walk.my = ny; }
      if (!step) walk.still = true;
    }
    walk.odo += step; walk.dose += (r.dose_msv / (r.time_s || 1)) * simDt;
    const z = elevAt(walk.mx, walk.my) ?? walk.zNow; walk.zNow = z;
    // relay: while a pass is up the radio measures every 10 s and the estimate tightens; between passes it drifts
    const q = currentPass(walk.simT), con = q ? { orbiter: q.orbiter, start: q.start, end: q.end } : null;
    const tracked = !!(q && walk.lock === "fix" && walk.lockKey === q.orbiter + q.start);
    if (!tracked) driftBy(step); else walk.odoFix = walk.odo;
    if (q) {
      const had = walk.fixKey === q.orbiter + q.start && walk.sig <= 24, fix = navFix(q, walk.mx, walk.my, 15);
      if (fix && !had && fix.sigma <= 12 && walk.rest.length) {                                // first solid fix of this pass: plan again from the real position
        chime(q.orbiter, true); walk.lastRe = now;
        const ld = walk.lockDrift || [0, 0];                                                 // suit's estimate minus the real position, before this pass corrected it
        showMiss(walk.mx + ld[0], walk.my + ld[1], walk.mx, walk.my);
        reroute([fix.x, fix.y], walk.rest, fixMsg(q.orbiter, fix), ORB[q.orbiter].c, { title: `${q.orbiter} found you`, lead: offWords(q.orbiter, -ld[0], -ld[1]), oldRem: r.d.at(-1) - r.d[Math.min(walk.ri, r.d.length - 1)],
          log: `Position ${fLL(fix.x, fix.y)}, good to ±${Math.max(2, Math.round(2 * fix.sigma))} m.` });
      }
    } else if (walk.lock) { walk.lock = ""; }
    if (walk.lock !== "fix") {                           // between satellite passes: use the habitat's measurement whenever it is tighter than the suit's own estimate
      const hf = habFix(walk.mx, walk.my), radNow = (walk.sig || 1.5) + DRIFT * (walk.odo - walk.odoFix);
      if (hf && hf.rad < radNow * (walk.src === "hab" ? 1 : 0.85)) {
        if (!walk.habPosSaid) { walk.habPosSaid = true; guide("The habitat can place you", `The habitat mast can see you, ${wKm(hf.r)} away, and knows where you are to within about ${Math.round(hf.rad)} m. It gets sharper the closer you are to the habitat.`, "#3ddc97", `Position ${fLL(hf.x, hf.y)}.`); }
        walk.drift = [hf.x - walk.mx, hf.y - walk.my]; walk.sig = hf.rad; walk.odoFix = walk.odo; walk.src = "hab";
      } else if (hf) {                                   // not tight enough to take over, but the distance is still good: keep the estimate at the measured range
        walk.src = "suit";
        const ex = walk.mx + walk.drift[0] - HAB[0], ey = walk.my + walk.drift[1] - HAB[1], L = Math.hypot(ex, ey);
        if (L > 20) walk.drift = [HAB[0] + ex / L * hf.r - walk.mx, HAB[1] + ey / L * hf.r - walk.my];
      } else if (!habNow().ok && walk.src === "hab") walk.src = "suit";
    }
    walk.inContact = !!con; walk.link = con ? { orbiter: con.orbiter, end: con.end } : null;
    for (const p2 of DB.passes) {
      if (p2.end < walk.simT || p2.start > walk.simT + 620) continue;
      const k10 = p2.orbiter + p2.start + "a";
      if (walk.simT >= p2.start - 600 && walk.simT < p2.start && !walk.alerted.has(k10)) { walk.alerted.add(k10); warm(p2.start); chime(p2.orbiter); guide(`${p2.orbiter} in ${Math.round((p2.start - walk.simT) / 60)} min`, `${p2.orbiter} comes overhead in ${wDur(p2.start - walk.simT)}. It will measure where you really are, and I will correct the route.`, ORB[p2.orbiter].c); }
    }
    dopplerTone(con ? q : null, walk.simT);
    const bx = walk.mx + walk.drift[0], by = walk.my + walk.drift[1], rad = (walk.sig || 1.5) + DRIFT * (walk.odo - walk.odoFix);
    // waypoints are reached with the feet, not with the estimate (closest approach during this step, so a fast clock cannot jump over one)
    if (walk.rest.length) {
      const w = walk.rest[0], home = w === HAB, ux = walk.mx - x0, uy = walk.my - y0, L2 = ux * ux + uy * uy, tt = L2 ? Math.max(0, Math.min(1, ((w[0] - x0) * ux + (w[1] - y0) * uy) / L2)) : 0;
      if (Math.hypot(w[0] - x0 - ux * tt, w[1] - y0 - uy * tt) < (home ? REACH_HOME : REACH)) {
        walk.rest.shift();
        if (!walk.rest.length) { T3.walker = null; endWalk(`${home ? "Back at the airlock" : "Final waypoint reached"} under manual control. Dose ${(walk.dose * 1000).toFixed(0)} µSv (model).`); return; }
        { const nx2 = walk.rest[0], sci = walk.rest.filter(w2 => w2 !== HAB).length; guide("Waypoint reached", nx2 === HAB ? `That was the last one. Head back to the habitat, ${wKm(Math.hypot(nx2[0] - walk.mx, nx2[1] - walk.my))} away.` : `${sci} more to visit. The next one is ${wKm(Math.hypot(nx2[0] - walk.mx, nx2[1] - walk.my))} away.`, "#6EE7A8"); } walk.lastRe = 0;
      }
    }
    // the route always starts at the estimated position. While a satellite is tracking you, leaving the line plans a new one straight away.
    const off = nearAhead(r, bx, by);
    if (tracked && walk.sig <= 24 && !walk.busy && !walk.planning && now - (walk.lastRe || 0) > 2000 && walk.rest.length && off > Math.max(25, 1.5 * DX)) {
      walk.lastRe = now; const tk = q.orbiter + q.start;                                      // say it once per pass, then just keep the route under your feet
      reroute([bx, by], walk.rest, "", ORB[q.orbiter].c, { soft: true, quiet: walk.trackSaid === tk, title: `${q.orbiter} is tracking you`, words: false, lead: `${q.orbiter} can see where you are while it is overhead, so the route now follows you wherever you walk.` });
      walk.trackSaid = tk;
    }
    if (walk.src === "hab" && walk.lock !== "fix" && !walk.busy && !walk.planning && now - (walk.lastRe || 0) > 6000 && walk.rest.length && off > Math.max(30, 1.5 * DX, rad)) {
      walk.lastRe = now;                                 // clearly off the line even allowing for the habitat's error: plan again from its fix
      reroute([bx, by], walk.rest, "", "#3ddc97", { soft: true, quiet: walk.habReSaid, title: "You left the route", lead: `The habitat radio places you ${wKm(off)} off the route.` });
      walk.habReSaid = true;
    }
    const from = Math.min(r.x.length - 1, walk.ri + 1);
    T3.pathHead = { i: from, x: bx, y: by };
    me.setLatLng(ll(bx, by)); unc.setLatLng(ll(bx, by)); unc.setRadius(rad); ghost.setLatLng(ll(walk.mx, walk.my));
    unc.setStyle({ color: tracked ? "#6EE7A8" : "#93B7E6", fillColor: tracked ? "#6EE7A8" : "#93B7E6" });
    if (walk._painted !== from || !walk.px || Math.hypot(bx - walk.px[0], by - walk.px[1]) > Math.max(2, DX * 0.1)) { walk._painted = from; walk.px = [bx, by]; paintRoute(r, from, [bx, by]); }
    const tgt = walk.rest[0], dist = tgt ? Math.hypot(tgt[0] - bx, tgt[1] - by) : 0, brg = tgt ? Math.atan2(tgt[0] - bx, tgt[1] - by) : 0;
    $("arrow").style.transform = `rotate(${(brg - walk.hd) * 180 / Math.PI - 90}deg)`;
    $("hudNext").textContent = `${tgt === HAB ? "Habitat" : `Waypoint ${Math.max(1, S.stops.length - walk.rest.filter(w2 => w2 !== HAB).length + 1)} of ${S.stops.length}`} · ${fKm(dist)}`;
    $("hudSub").textContent = off > Math.max(25, 1.5 * DX) ? `${Math.round(off)} m off the route${tracked || walk.src === "hab" ? "" : " · waiting for a fix to replan"}` : `${fLL(bx, by)} · slope ${sl0.toFixed(0)}°`;
    $("hudPos").textContent = `±${Math.round(rad)} m`; $("hudPos").style.color = rad > 60 ? "var(--bad)" : rad > 25 ? "var(--warn)" : "var(--ok)";
    hudRelay(con, bx, by);
    $("hudDose").textContent = `${(walk.dose * 1000).toFixed(0)} µSv`;
    if (S.view === "2d" && !map.getBounds().pad(-0.25).contains(ll(walk.mx, walk.my))) map.panTo(ll(walk.mx, walk.my), { animate: true, duration: 0.4 });
    T3.walker = { x: walk.mx, y: walk.my, z, rad, con, tracked, pass: con ? q : null, hdx: Math.sin(walk.hd), hdy: Math.cos(walk.hd), d: 0, still: walk.still, bx, by, manual: true, src: walk.src };
  }
  addEventListener("keydown", e => {
    const k = e.key.toLowerCase(); if (!["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) return;
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || !walk.on) return;
    e.preventDefault(); if (!walk.manual) takeControl(); walk.keys[k] = true; if (MODE === "explore") $("exKeys") && ($("exKeys").hidden = true);
  });
  addEventListener("keyup", e => { if (walk.keys) walk.keys[e.key.toLowerCase()] = false; });
  addEventListener("blur", () => { walk.keys = {}; });
  {
    const el = $("stick"), nub = el.firstElementChild; let id = null;
    const set = e => { const b = el.getBoundingClientRect(), R = b.width / 2; let x = (e.clientX - b.left - R) / R, y = (e.clientY - b.top - R) / R; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } stick.x = x; stick.y = -y; nub.style.transform = `translate(${x * R * 0.55}px, ${y * R * 0.55}px)`; };
    const end = () => { id = null; stick.x = stick.y = 0; nub.style.transform = ""; };
    el.addEventListener("pointerdown", e => { id = e.pointerId; el.setPointerCapture(id); set(e); e.preventDefault(); });
    el.addEventListener("pointermove", e => { if (e.pointerId === id) set(e); });
    el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  }
  function tick(now) {
    requestAnimationFrame(tick);
    const dtReal = Math.min(0.5, (now - (walk.last || now)) / 1000); walk.last = now; padTick();
    if (walk.on && !walk.busy) {
      walk.simT += dtReal * S.speed;
      if (walk.manual) manualStep(dtReal, now); else {
      const r = walk.route, el = walk.simT - walk.t0, p = posOn(r, el);
      const moved = Math.max(0, p.d - walk.dAlong); walk.odo += moved; walk.dAlong = p.d; walk.zNow = p.z;
      walk.dose += (r.dose_msv / (r.time_s || 1)) * dtReal * S.speed;
      // The astronaut steers by the suit's estimate, so the estimate rides the route and the real position slides off it.
      const pq = currentPass(walk.simT);
      const con = r.contacts.find(k => k.start && k.start <= walk.simT && walk.simT < k.end) || (pq && walk.loose ? { orbiter: pq.orbiter, start: pq.start, end: pq.end } : null), cq = con ? pq : null;
      const tracked = !!(pq && walk.lock === "fix" && walk.lockKey === pq.orbiter + pq.start);
      if (!tracked) driftBy(moved); else walk.odoFix = walk.odo;
      const tx = p.x - walk.drift[0], ty = p.y - walk.drift[1];
      if (cq && !tracked) {
        const fix = navFix(cq, tx, ty, 6);                                       // wait for a solid fix (about ±12 m or better), then plan again from the real position
        if (fix) {
          chime(con.orbiter, true);
          const k = r.stop_idx.slice(1).filter(i => i <= p.i).length, rest = r.stopsReq.slice(1 + k);
          const lead = offWords(cq.orbiter, fix.x - p.x, fix.y - p.y), detail = `Position ${fLL(fix.x, fix.y)}, good to ±${Math.max(2, Math.round(2 * fix.sigma))} m.`;
          showMiss(p.x, p.y, fix.x, fix.y);
          if (rest.length) reroute([fix.x, fix.y], rest, fixMsg(cq.orbiter, fix), ORB[cq.orbiter].c, { title: `${cq.orbiter} found you`, lead, oldRem: r.d.at(-1) - p.d, log: detail });
          else guide(`${cq.orbiter} found you`, lead, ORB[cq.orbiter].c, detail);
        }
      } else if (!pq && walk.lock) walk.lock = "";
      if (!tracked && walk.lock !== "fix" && !walk.busy) {
        const hf = habFix(tx, ty), radNow = (walk.sig || 1.5) + DRIFT * (walk.odo - walk.odoFix);
        if (hf && hf.rad < 0.5 * radNow) {                      // only when it halves the uncertainty, so a walk home is a few replans and not a dozen
          const jump = Math.hypot(hf.x - p.x, hf.y - p.y), k = r.stop_idx.slice(1).filter(i => i <= p.i).length, rest = r.stopsReq.slice(1 + k);
          walk.drift = [hf.x - tx, hf.y - ty]; walk.sig = hf.rad; walk.odoFix = walk.odo; walk.src = "hab";
          showMiss(p.x, p.y, hf.x, hf.y);
          if (rest.length) reroute([hf.x, hf.y], rest, habMsg(hf, jump), "#3ddc97", { title: "The habitat found you", quiet: walk.habReSaid, oldRem: r.d.at(-1) - p.d,
            lead: `${offWords("The habitat radio", hf.x - p.x, hf.y - p.y)} At ${wKm(hf.r)} from the mast it is good to about ${Math.round(hf.rad)} m, and it gets sharper as you come closer.`, log: `Position ${fLL(hf.x, hf.y)}.` });
          walk.habReSaid = true;
        } else if (walk.src === "hab" && walk.odo - walk.odoFix > 250) walk.src = "suit";
      }
      walk.inContact = !!con; walk.link = con ? { orbiter: con.orbiter, end: con.end } : null;
      // pass alerts: T-10 min and at rise
      for (const q of DB.passes) {
        if (q.end < walk.simT || q.start > walk.simT + 620) continue;
        const k10 = q.orbiter + q.start + "a", k0 = q.orbiter + q.start + "b";
        if (walk.simT >= q.start - 600 && walk.simT < q.start && !walk.alerted.has(k10)) { walk.alerted.add(k10); warm(q.start); chime(q.orbiter); guide(`${q.orbiter} in ${Math.round((q.start - walk.simT) / 60)} min`, `${q.orbiter} comes overhead in ${wDur(q.start - walk.simT)} and stays for ${wDur(q.end - q.start)}. It will measure where you really are, and I will correct the route.`, ORB[q.orbiter].c); }
        if (walk.simT >= q.start && !walk.alerted.has(k0)) { walk.alerted.add(k0); if (!con) { chime(q.orbiter, true); toast(`${q.orbiter} rising`, r.contacts.some(k => k.orbiter === q.orbiter && !k.start) ? "Terrain is blocking the link from here." : "Above 10°.", ORB[q.orbiter].c); } }
      }
      dopplerTone(con ? currentPass(walk.simT) : null, walk.simT);
      // draw
      const rad = (walk.sig || 1.5) + DRIFT * (walk.odo - walk.odoFix);
      T3.pathHead = { i: p.i, x: p.x, y: p.y };
      me.setLatLng(ll(p.x, p.y)); unc.setLatLng(ll(p.x, p.y)); unc.setRadius(rad); ghost.setLatLng(ll(tx, ty));
      unc.setStyle({ color: tracked ? "#6EE7A8" : "#93B7E6", fillColor: tracked ? "#6EE7A8" : "#93B7E6" });
      if (walk._painted !== p.i) { walk._painted = p.i; paintRoute(r, p.i, [p.x, p.y]); }
      // HUD
      const nxt = r.stop_idx.find(i => i >= p.i) ?? r.x.length - 1, last = nxt === r.x.length - 1;
      const k = r.stop_idx.slice(1).filter(i => i < p.i).length, total = r.stopsReq.length - 1;
      const j = Math.min(r.x.length - 1, p.i + 3), brg = Math.atan2(r.x[j] - p.x, r.y[j] - p.y) * 180 / Math.PI;
      $("arrow").style.transform = `rotate(${brg - 90}deg)`;
      const dw = r.dwell.find(d => el >= d.t && el < d.t + d.min * 60);
      if (dw && walk.dwellSaid !== dw.t) { walk.dwellSaid = dw.t; guide("Waypoint reached", `Collecting a sample here for ${wDur(dw.min * 60)}, then on to the next stop.`, "#6EE7A8"); }
      const home = last && r.stopsReq.at(-1) === HAB;
      const left = total - k - (r.stopsReq.at(-1) === HAB ? 1 : 0);                          // science waypoints still to visit, this one included
      $("hudNext").textContent = dw ? "Collecting a sample" : `${home ? "Habitat" : `Waypoint ${Math.max(1, S.stops.length - left + 1)} of ${S.stops.length}`} · ${fKm(r.d[nxt] - p.d)}`;
      $("hudSub").textContent = dw ? `${Math.ceil((dw.t + dw.min * 60 - el) / 60)} min of sampling left` : `${fLL(p.x, p.y)} · ${fDur(r.t[nxt] - el)} to go`;
      $("hudPos").textContent = `±${Math.round(rad)} m`; $("hudPos").style.color = rad > 60 ? "var(--bad)" : rad > 25 ? "var(--warn)" : "var(--ok)";
      hudRelay(con || (tracked ? { orbiter: pq.orbiter } : null), p.x, p.y);
      $("hudDose").textContent = `${(walk.dose * 1000).toFixed(0)} µSv`;
      if (r.ground_c) $("hudGround").textContent = `${Math.round(r.ground_c[Math.min(p.i, r.ground_c.length - 1)])} °C`;
      // hazard look-ahead (150 m)
      let hz = 0; for (let i = p.i; i < r.x.length && r.d[i] - p.d < 150; i++) hz = Math.max(hz, r.slope[i]);
      if (hz >= 15 && !walk.hzOn) { walk.hzOn = true; guide("Steep ground ahead", `There is a ${hz.toFixed(0)}° slope within the next 150 m. Slow down.`, "#F0616B"); } else if (hz < 10) walk.hzOn = false;
      if (S.view === "2d" && walk.follow !== false && !map.getBounds().pad(-0.25).contains(ll(p.x, p.y))) map.panTo(ll(p.x, p.y), { animate: true, duration: 0.6 });
      T3.walker = { x: tx, y: ty, z: p.z, rad, con, tracked, pass: con ? currentPass(walk.simT) : null, hdx: r.x[j] - p.x, hdy: r.y[j] - p.y, d: p.d, bx: p.x, by: p.y, still: !!dw, src: walk.src };
      if (el >= r.time_s) endWalk(`${Math.hypot(r.x.at(-1) - HAB[0], r.y.at(-1) - HAB[1]) < 6 ? "Back at the airlock" : "At the last waypoint"} after ${fDur(walk.simT - (S.route.depart))}. Dose ${(walk.dose * 1000).toFixed(0)} µSv (model).`);
      }
    }
    // 4 Hz UI refresh
    if (!tick.n || now - tick.n > 250) {
      tick.n = now;
      const t = clockT(), s = sunAt(t);
      $("clock").innerHTML = `<span class="dt">${fDay(t)} </span>${fUTC(t)}:${pad(Math.floor(t) % 60)} UTC`;
      { const st = $("simState"), mode = walk.on ? "SIMULATION" : S.departOff === 0 ? "LIVE" : "PLANNED"; st.textContent = mode; st.className = "tstate " + (walk.on ? "sim" : S.departOff === 0 ? "" : "plan"); }
      $("clockSub").textContent = (walk.on ? `EVA +${fCD(t - S.route.depart)} · ` : "") + (s.el > 0 ? `Sun ${s.el.toFixed(0)}° up` : "Night here");
      drawRelay(); drawTimeline(); if (walk.on) drawProfile(); liveAlerts(); commsTick();
      if ((S.layers.has("sun") || S.layers.has("heat")) && Math.floor(t / 600) !== walk.lastSun) { walk.lastSun = Math.floor(t / 600); syncLayers(); }
      T3.sun = s;
    }
    if (S.view === "3d") T3.render();
  }

  /* ---------- 3D terrain ---------- */
  const T3 = { dirty: true, ready: false, walker: null, sun: { az: 180, el: 45 } };
  T3.init = function () {
    const cv = $("view3d"), EX = 1, K = M.width_m / 30276;      // K: everything is sized for Jezero (30 km) and scaled to this map
    const small = innerWidth < 900;
    let lite = small; try { const v0 = localStorage.getItem("mw_lite"); if (v0 !== null) lite = v0 === "1"; } catch (e) { /* private mode */ }
    T3.lite = lite; let rocksRef = null, envTex = null;
    const rn = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); rn.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    rn.outputEncoding = THREE.sRGBEncoding; rn.toneMapping = THREE.ACESFilmicToneMapping; rn.toneMappingExposure = 1.0;
    rn.shadowMap.enabled = !lite; rn.shadowMap.type = THREE.PCFSoftShadowMap;
    const sc = new THREE.Scene(); sc.fog = new THREE.Fog(0x9a7b5f, 14000 * K, 54000 * K);
    const cam = new THREE.PerspectiveCamera(42, 1, 10 * K, 130000 * K); T3.cam = cam;
    const ctl = new THREE.OrbitControls(cam, cv); ctl.enableDamping = true; ctl.maxPolarAngle = Math.PI * 0.49; ctl.minDistance = 2.5; ctl.maxDistance = 45000 * K;
    ctl.addEventListener("start", () => { T3.drag = true; }); ctl.addEventListener("end", () => { T3.drag = false; if (T3.chase) T3.chaseK = Math.min(14, Math.max(0.35, cam.position.distanceTo(ctl.target) / chaseBase())); });
    // following distance: close in real time, further back the faster time runs, so the ground never streaks past
    function chaseBase() { return (S.vehicle === "rover" ? 1.4 : 1) * 6.5 * Math.pow(walk.on ? Math.max(1, S.speed) : 1, 0.55) * (cam.aspect < 1 ? 1.25 : 1); }
    const P = (x, y, z) => new THREE.Vector3(x - M.width_m / 2, (z - M.zmin) * EX, -(y - M.height_m / 2));
    const hz = elevAt(...HAB);
    const homeCam = () => { ctl.target.copy(P(HAB[0] - 500 * K, HAB[1] + 700 * K, hz)); cam.position.copy(P(HAB[0] + 2200 * K, HAB[1] - 3600 * K, hz + 1300 * K)); };
    homeCam();

    // ---- sky: Mars butterscotch by day, blue halo round the sun at dusk, near-black at night ----
    const SKY_FRAG = `precision highp float; varying vec3 vP; uniform vec3 sunDir; uniform float day;
      void main(){ vec3 d = normalize(vP); float h = clamp(d.y, 0.0, 1.0);
        vec3 hor = mix(vec3(0.020, 0.032, 0.050), vec3(0.80, 0.62, 0.45), day);
        vec3 zen = mix(vec3(0.004, 0.008, 0.016), vec3(0.50, 0.40, 0.32), day);
        vec3 col = mix(hor, zen, pow(h, 0.5));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        col += vec3(0.20, 0.34, 0.58) * pow(sd, 16.0) * (0.30 + 0.70 * (1.0 - day)) * step(-0.05, sunDir.y);
        col += vec3(1.0, 0.92, 0.78) * pow(sd, 800.0) * 4.0 * step(0.0, sunDir.y);
        if (d.y < 0.0) col = mix(col, hor * 0.7, clamp(-d.y * 4.0, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0); }`;
    const skyMat = (sunDir, day) => new THREE.ShaderMaterial({ uniforms: { sunDir: { value: sunDir }, day: { value: day } }, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: "varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }", fragmentShader: SKY_FRAG });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(95000 * K, 32, 16), skyMat(new THREE.Vector3(0, 1, 0), 1)); sky.renderOrder = -1; sc.add(sky);
    const skyU = sky.material.uniforms;
    {   // image-based lighting: reflect a daytime Mars sky in the metal and visor (skipped where float render targets are missing)
      const okEnv = rn.capabilities.isWebGL2 ? !!(rn.extensions.get("EXT_color_buffer_float") || rn.extensions.get("EXT_color_buffer_half_float")) : !!rn.extensions.get("EXT_color_buffer_half_float");
      if (okEnv) {
        try {
          const es = new THREE.Scene(); es.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat(new THREE.Vector3(0.45, 0.7, 0.4), 1)));
          const pm = new THREE.PMREMGenerator(rn); envTex = pm.fromScene(es, 0.02).texture; pm.dispose();
        } catch (e) { envTex = null; }
      }
      sc.environment = lite ? null : envTex;
    }
    const envMats = [];
    const pbr = o => { const m = new THREE.MeshStandardMaterial(o); m.userData.env0 = o.envMapIntensity == null ? 1 : o.envMapIntensity; envMats.push(m); return m; };

    // ---- terrain ----
    const nx = 532, ny = 504, geo = new THREE.PlaneGeometry(M.width_m, M.height_m, nx, ny); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let iy = 0; iy <= ny; iy++) for (let ix = 0; ix <= nx; ix++) {
      const c = Math.min(W - 1, Math.round(ix / nx * (W - 1))), r = Math.min(H - 1, Math.round(iy / ny * (H - 1)));
      pos.setY(iy * (nx + 1) + ix, (ELEV[r * W + c] * M.elev_scale - M.zmin) * EX);
    }
    geo.computeVertexNormals();
    // height of the drawn surface at a map point: the same triangles the mesh uses, so feet never sink or float
    const ground = (x, y) => {
      const fx = Math.min(nx - 1e-6, Math.max(0, x / M.width_m * nx)), fy = Math.min(ny - 1e-6, Math.max(0, (1 - y / M.height_m) * ny));
      const ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy, i0 = iy * (nx + 1) + ix;
      const ha = pos.getY(i0), hd = pos.getY(i0 + 1), hb = pos.getY(i0 + nx + 1), hc = pos.getY(i0 + nx + 2);
      return u + v <= 1 ? ha + u * (hd - ha) + v * (hb - ha) : hc + (1 - u) * (hb - hc) + (1 - v) * (hd - hc);
    };
    T3.ground = ground;
    const tc = document.createElement("canvas"); tc.width = 2660; tc.height = 2520;
    const tex = new THREE.CanvasTexture(tc); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = rn.capabilities.getMaxAnisotropy();
    const terrain = new THREE.Mesh(geo, pbr({ map: tex, color: 0xd0d0d0, roughness: 1, metalness: 0, envMapIntensity: 0.12 })); terrain.receiveShadow = true; terrain.castShadow = true; sc.add(terrain);
    const sun = new THREE.DirectionalLight(0xffe4c4, 2.4);
    sun.castShadow = !lite; sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    sun.shadow.camera.near = 10 * K; sun.shadow.camera.far = 16000 * K; sun.shadow.bias = -0.0006; sun.shadow.normalBias = 3 * K;
    let shNow = 1700 * K; Object.assign(sun.shadow.camera, { left: -shNow, right: shNow, top: shNow, bottom: -shNow });
    const hemi = new THREE.HemisphereLight(0xd9bb98, 0x6a5240, 0.45); sc.add(sun, sun.target, hemi);
    const baseImg = new Image(); baseImg.src = M.basemap_3d; baseImg.onload = () => T3.dirty = true;
    const imgs = {};

    // ---- procedural surface detail for the models ----
    const mkCanvas = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); return c; };
    const toTex = (c, rep, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (rep) t.repeat.set(rep[0], rep[1]); if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t; };
    const NOISE = toTex(mkCanvas(256, 256, (x, w, h) => { const im = x.createImageData(w, h); for (let i = 0; i < w * h; i++) { const v = 100 + Math.random() * 110; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; } x.putImageData(im, 0, 0); }));
    const FOIL = toTex(mkCanvas(256, 256, (x, w, h) => { x.fillStyle = "#808080"; x.fillRect(0, 0, w, h); for (let i = 0; i < 1400; i++) { const v = 60 + Math.random() * 140; x.fillStyle = `rgba(${v},${v},${v},0.35)`; x.beginPath(); const a = Math.random() * w, b = Math.random() * h; x.moveTo(a, b); x.lineTo(a + Math.random() * 40 - 20, b + Math.random() * 40 - 20); x.lineTo(a + Math.random() * 40 - 20, b + Math.random() * 40 - 20); x.fill(); } }), [2, 2]);
    const WEAVE = toTex(mkCanvas(64, 64, x => { x.fillStyle = "#909090"; x.fillRect(0, 0, 64, 64); x.lineWidth = 2; x.strokeStyle = "#c4c4c4"; for (let i = -64; i < 128; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 64, 64); x.stroke(); } x.strokeStyle = "#5e5e5e"; for (let i = -64; i < 128; i += 8) { x.beginPath(); x.moveTo(i + 64, 0); x.lineTo(i, 64); x.stroke(); } }), [7, 7]);
    const CELLS = toTex(mkCanvas(256, 128, (x, w, h) => {
      x.fillStyle = "#1c3a63"; x.fillRect(0, 0, w, h);
      for (let cx = 0; cx < 8; cx++) for (let cy = 0; cy < 4; cy++) { const g = x.createLinearGradient(0, cy * 32, 0, cy * 32 + 32); g.addColorStop(0, "#3a78c4"); g.addColorStop(1, "#1f4f8f"); x.fillStyle = g; x.fillRect(cx * 32 + 2, cy * 32 + 2, 28, 28); x.fillStyle = "rgba(190,205,225,0.5)"; x.fillRect(cx * 32 + 9, cy * 32 + 2, 1, 28); x.fillRect(cx * 32 + 21, cy * 32 + 2, 1, 28); }
    }), null, true);
    const DOMETEX = toTex(mkCanvas(512, 256, (x, w, h) => { x.fillStyle = "#f2f1ec"; x.fillRect(0, 0, w, h); x.strokeStyle = "rgba(60,64,70,0.55)"; x.lineWidth = 2; for (let i = 0; i <= w; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); } for (let j = 0; j <= h; j += 51) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); } x.fillStyle = "rgba(60,64,70,0.45)"; for (let i = 0; i <= w; i += 64) for (let j = 0; j <= h; j += 17) x.fillRect(i - 1.5, j, 3, 3); }), null, true);

    // ---- ground detail near the camera (the orbital image has one pixel per ~11 m; this adds grain, pebbles and blotches on top of its colour) ----
    const DETAIL = (() => {
      const n = 512, c = document.createElement("canvas"); c.width = c.height = n; const x = c.getContext("2d"), im = x.createImageData(n, n), d = im.data;
      const lat = sz => { const g = new Float32Array(sz * sz); for (let i = 0; i < g.length; i++) g[i] = Math.random(); return g; };
      const vn = (g, sz, u, v) => { const fx = u * sz, fy = v * sz, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty),
        a = g[(iy % sz) * sz + ix % sz], b = g[(iy % sz) * sz + (ix + 1) % sz], c2 = g[((iy + 1) % sz) * sz + ix % sz], e2 = g[((iy + 1) % sz) * sz + (ix + 1) % sz]; return a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + e2) * sx * sy; };
      const g1 = lat(8), g2 = lat(32), g3 = lat(128), g4 = lat(4), g5 = lat(16);
      const fine = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const u = i / n, v = j / n;
        fine[j * n + i] = 0.5 + (vn(g1, 8, u, v) - 0.5) * 0.3 + (vn(g2, 32, u, v) - 0.5) * 0.42 + (vn(g3, 128, u, v) - 0.5) * 0.38 + (Math.random() - 0.5) * 0.2;
        d[(j * n + i) * 4 + 1] = Math.max(0, Math.min(255, (0.5 + (vn(g4, 4, u, v) - 0.5) * 0.75 + (vn(g5, 16, u, v) - 0.5) * 0.4) * 255));
      }
      for (let q = 0; q < 90; q++) {                                             // pebbles: dark stones with a lit edge
        const cx = Math.random() * n, cy = Math.random() * n, r = 2 + Math.pow(Math.random(), 2.2) * 10, R = Math.ceil(r);
        for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
          const dd = Math.hypot(i, j * 1.25); if (dd > r) continue;
          const k = ((Math.round(cy + j) % n + n) % n) * n + (Math.round(cx + i) % n + n) % n;
          fine[k] = 0.3 + 0.28 * Math.max(0, (-i - j) / r) + (dd > r - 1.2 ? 0.06 : 0);
        }
      }
      for (let k = 0; k < n * n; k++) { d[k * 4] = Math.max(0, Math.min(255, fine[k] * 255)); d[k * 4 + 2] = 128; d[k * 4 + 3] = 255; }
      x.putImageData(im, 0, 0);
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = Math.min(8, rn.capabilities.getMaxAnisotropy()); return t;
    })();
    terrain.material.onBeforeCompile = sh => {
      sh.uniforms.mwDetail = { value: DETAIL };
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vMwPos;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvMwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D mwDetail;\nvarying vec3 vMwPos;").replace("#include <map_fragment>", `#include <map_fragment>
        float mwD = distance(cameraPosition, vMwPos);
        float mwF = 1.0 - smoothstep(90.0, 1100.0, mwD);
        float mwA = texture2D(mwDetail, vMwPos.xz * 0.43).r;
        float mwC = texture2D(mwDetail, vMwPos.xz * 0.083 + 0.11).r;
        float mwB = texture2D(mwDetail, vMwPos.xz * 0.019 + 0.37).g;
        diffuseColor.rgb *= mix(1.0, (0.4 + 1.2 * mwA) * (0.72 + 0.56 * mwC) * (0.62 + 0.76 * mwB), mwF);`);
    };
    terrain.material.customProgramCacheKey = () => "mw-terrain-detail";

    // ---- models ----
    const mk = (parent, geom, mat, x, y, z) => { const o = new THREE.Mesh(geom, mat); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; o.receiveShadow = true; parent.add(o); return o; };
    function makeAstronaut() {
      // A pressure suit, 1.88 m tall, built in metres: hard upper torso, life-support backpack, ribbed joints,
      // gold sun visor, helmet lights, chest controls, gloves and dusty boots. Arms stand away from the body the way pressurised arms do.
      const g = new THREE.Group(), ud = g.userData; g.rotation.order = "YXZ";
      const fabric = pbr({ color: 0xe9e7e2, roughness: 0.9, bumpMap: WEAVE, bumpScale: 0.003, envMapIntensity: 0.35 });
      const dusty = pbr({ color: 0xc8ae96, roughness: 0.96, bumpMap: WEAVE, bumpScale: 0.003, envMapIntensity: 0.2 });        // shins and boots carry the red dust
      const joint = pbr({ color: 0xb7b3ab, roughness: 0.88, envMapIntensity: 0.25 });
      const hard = pbr({ color: 0xf3f2ef, roughness: 0.5, envMapIntensity: 0.6, side: THREE.DoubleSide });
      const metal = pbr({ color: 0xaab2b9, roughness: 0.34, metalness: 0.9, envMapIntensity: 1.1 });
      const rubber = pbr({ color: 0x23262a, roughness: 0.95 });
      const glove = pbr({ color: 0x8a8e94, roughness: 0.82 });
      const stripe = pbr({ color: 0xb3261e, roughness: 0.8 });
      const visor = pbr({ color: 0xdba640, roughness: 0.05, metalness: 1, envMapIntensity: 1.9, emissive: 0x3d2807, emissiveIntensity: 0.7 });
      const glass = pbr({ color: 0x0a0d11, roughness: 0.18, metalness: 0.5 });
      const lamp = pbr({ color: 0xfff3d6, emissive: 0xffe2a8, emissiveIntensity: 1.2, roughness: 0.3 });
      const led = pbr({ color: 0x5fd0c0, emissive: 0x1f8d80, emissiveIntensity: 1.0, roughness: 0.4 });
      const cyl = (rt, rb, h, seg = 22) => new THREE.CylinderGeometry(rt, rb, h, seg);
      const ribs = (parent, r, y, n) => { for (let i = 0; i < n; i++) mk(parent, new THREE.TorusGeometry(r, 0.015, 8, 22), joint, 0, y + (i - (n - 1) / 2) * 0.03, 0).rotation.x = Math.PI / 2; };
      // legs: hip -> thigh (red stripe) -> ribbed knee -> shin -> boot
      const leg = (sx, name) => {
        const hip = new THREE.Group(); hip.position.set(sx * 0.105, 0.93, 0); g.add(hip);
        mk(hip, new THREE.SphereGeometry(0.115, 18, 12), fabric, 0, 0, 0).scale.set(1, 0.9, 1);
        mk(hip, cyl(0.108, 0.094, 0.36), fabric, 0, -0.2, 0);
        mk(hip, cyl(0.111, 0.107, 0.04), stripe, 0, -0.1, 0);
        const kn = new THREE.Group(); kn.position.y = -0.41; hip.add(kn);
        mk(kn, new THREE.SphereGeometry(0.095, 16, 12), joint, 0, 0, 0); ribs(kn, 0.093, 0, 3);
        mk(kn, cyl(0.09, 0.08, 0.34), dusty, 0, -0.19, 0);
        mk(kn, cyl(0.088, 0.094, 0.09), dusty, 0, -0.395, 0.005);
        mk(kn, new THREE.BoxGeometry(0.128, 0.1, 0.25), dusty, 0, -0.455, 0.04);
        mk(kn, new THREE.SphereGeometry(0.066, 14, 10), dusty, 0, -0.46, 0.16).scale.set(0.97, 0.76, 1.05);
        mk(kn, new THREE.BoxGeometry(0.138, 0.03, 0.31), rubber, 0, -0.505, 0.045);
        ud["leg" + name] = hip; ud["knee" + name] = kn;
      };
      leg(-1, "L"); leg(1, "R");
      // lower torso, waist bearing, hard upper torso, shoulder bearings, neck ring
      mk(g, new THREE.SphereGeometry(0.19, 22, 14), fabric, 0, 0.98, 0).scale.set(1.08, 0.72, 0.86);
      const waist = mk(g, new THREE.TorusGeometry(0.184, 0.02, 10, 30), metal, 0, 1.085, 0); waist.rotation.x = Math.PI / 2; waist.scale.set(1, 0.86, 1);
      mk(g, cyl(0.205, 0.186, 0.4, 30), hard, 0, 1.29, 0).scale.z = 0.84;
      mk(g, new THREE.SphereGeometry(0.205, 30, 12, 0, Math.PI * 2, 0, Math.PI / 2), hard, 0, 1.488, 0).scale.set(1, 0.4, 0.84);
      for (const sx of [-1, 1]) mk(g, new THREE.TorusGeometry(0.088, 0.016, 8, 22), metal, sx * 0.218, 1.45, 0).rotation.y = Math.PI / 2;
      mk(g, new THREE.TorusGeometry(0.124, 0.018, 10, 28), metal, 0, 1.56, 0).rotation.x = Math.PI / 2;
      // helmet: dark bubble, gold sun visor in front, white shell over the top, back and chin, lights and a camera
      const hy = 1.7, PH = Math.PI / 2;
      mk(g, new THREE.SphereGeometry(0.15, 26, 18), glass, 0, hy, 0);
      mk(g, new THREE.SphereGeometry(0.162, 34, 20, PH - 1.2, 2.4, 0.5, 1.3), visor, 0, hy, 0);
      mk(g, new THREE.SphereGeometry(0.168, 34, 20, PH + 1.2, Math.PI * 2 - 2.4), hard, 0, hy, 0);
      mk(g, new THREE.SphereGeometry(0.168, 34, 8, 0, Math.PI * 2, 0, 0.5), hard, 0, hy, 0);
      mk(g, new THREE.SphereGeometry(0.168, 34, 6, PH - 1.2, 2.4, 1.8, 0.75), hard, 0, hy, 0);
      for (const sx of [-1, 1]) { mk(g, new THREE.BoxGeometry(0.045, 0.06, 0.085), hard, sx * 0.178, hy + 0.055, 0.035); mk(g, new THREE.CircleGeometry(0.017, 14), lamp, sx * 0.178, hy + 0.055, 0.079); }
      mk(g, new THREE.BoxGeometry(0.04, 0.035, 0.06), rubber, 0.115, hy + 0.15, 0.045);
      // life-support backpack with its red stripe, oxygen pack underneath, and the radio whip
      mk(g, new THREE.BoxGeometry(0.5, 0.66, 0.19), hard, 0, 1.33, -0.225);
      mk(g, new THREE.BoxGeometry(0.44, 0.09, 0.15), hard, 0, 1.705, -0.225);
      mk(g, new THREE.BoxGeometry(0.46, 0.15, 0.17), hard, 0, 0.94, -0.215);
      mk(g, new THREE.BoxGeometry(0.503, 0.035, 0.193), stripe, 0, 1.6, -0.225);
      for (const sx of [-1, 1]) mk(g, new THREE.BoxGeometry(0.02, 0.5, 0.012), metal, sx * 0.13, 1.3, -0.325);
      mk(g, cyl(0.005, 0.005, 0.32, 6), metal, 0.2, 1.9, -0.25);
      // chest: display and control module, coloured knobs, tool bar
      mk(g, new THREE.BoxGeometry(0.25, 0.19, 0.09), hard, 0, 1.31, 0.205);
      mk(g, new THREE.BoxGeometry(0.12, 0.035, 0.006), led, -0.04, 1.36, 0.252);
      [0xc0392b, 0x2e6fd0, 0xd9b23a].forEach((c, i) => { mk(g, cyl(0.014, 0.014, 0.02, 12), pbr({ color: c, roughness: 0.6 }), 0.075, 1.365 - i * 0.05, 0.258).rotation.x = Math.PI / 2; });
      mk(g, cyl(0.011, 0.011, 0.3, 10), metal, 0, 1.185, 0.2).rotation.z = Math.PI / 2;
      { const patch = new THREE.TextureLoader().load("img/brand/logo-192.png?v=1794691885"); patch.encoding = THREE.sRGBEncoding;                 // team patch on the chest
        const pm = mk(g, new THREE.CircleGeometry(0.036, 24), new THREE.MeshStandardMaterial({ map: patch, roughness: 0.8 }), -0.115, 1.435, 0.179); pm.castShadow = false; }
      // arms: shoulder -> upper arm -> ribbed elbow -> forearm -> wrist ring -> glove
      const arm = (sx, name) => {
        const sh = new THREE.Group(); sh.position.set(sx * 0.255, 1.45, 0); g.add(sh);
        const ab = new THREE.Group(); ab.rotation.z = sx * 0.2; sh.add(ab);
        mk(ab, new THREE.SphereGeometry(0.098, 18, 12), fabric, 0, 0, 0); ribs(ab, 0.089, -0.075, 2);
        mk(ab, cyl(0.082, 0.072, 0.24), fabric, 0, -0.19, 0);
        mk(ab, cyl(0.084, 0.081, 0.03), stripe, 0, -0.15, 0);
        const el = new THREE.Group(); el.position.y = -0.32; ab.add(el);
        mk(el, new THREE.SphereGeometry(0.075, 16, 12), joint, 0, 0, 0); ribs(el, 0.073, 0, 3);
        mk(el, cyl(0.07, 0.06, 0.23), fabric, 0, -0.135, 0);
        mk(el, new THREE.TorusGeometry(0.058, 0.014, 8, 20), metal, 0, -0.255, 0).rotation.x = Math.PI / 2;
        mk(el, new THREE.BoxGeometry(0.085, 0.1, 0.055), glove, 0, -0.315, 0);
        mk(el, new THREE.BoxGeometry(0.08, 0.065, 0.05), glove, 0, -0.39, 0.008).rotation.x = -0.25;
        mk(el, new THREE.BoxGeometry(0.03, 0.06, 0.035), glove, -sx * 0.05, -0.33, 0.03);
        ud["arm" + name] = sh; ud["elbow" + name] = el;
      };
      arm(-1, "L"); arm(1, "R");
      return g;
    }
    /* A pressurised crew rover in the spirit of NASA's Space Exploration Vehicle: 4.6 m long, 2.7 m wide, six wheels of 1 m,
       a cabin with a wraparound windscreen, two suitports at the back (the crew climb into their suits from inside), solar panel,
       mast and high-gain dish on the roof. Built in metres, facing +Z. */
    function makeRover() {
      const g = new THREE.Group(), ud = g.userData; g.rotation.order = "YXZ";
      const shell = pbr({ color: 0xf2f1ec, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.6 });
      const frame = pbr({ color: 0x3a4048, roughness: 0.55, metalness: 0.6, envMapIntensity: 0.8 });
      const glass = pbr({ color: 0x0b1420, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.6 });
      const tyre = pbr({ color: 0x2a2724, roughness: 0.95, bumpMap: NOISE, bumpScale: 0.04 });
      const hub = pbr({ color: 0xb9bec4, roughness: 0.35, metalness: 0.85 });
      const red = pbr({ color: 0xfc3d21, roughness: 0.5 }), cells = pbr({ map: CELLS, roughness: 0.3, metalness: 0.5, envMapIntensity: 1.4 });
      const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4d6 });
      const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; g.add(o); return o; };
      box(2.3, 0.32, 4.4, frame, 0, 0.78, 0);                                         // chassis
      box(2.25, 1.55, 3.0, shell, 0, 1.75, -0.35);                                    // cabin
      const nose = box(2.25, 0.95, 1.1, shell, 0, 1.35, 1.6); nose.rotation.x = 0;    // lower front
      const ws = box(2.1, 0.9, 0.08, glass, 0, 2.05, 1.18); ws.rotation.x = -0.55;      // windscreen, raked back
      box(2.27, 0.42, 1.6, glass, 0, 2.05, 0.35);                                     // side windows (a band through the cabin)
      box(2.28, 0.09, 3.0, red, 0, 1.12, -0.35);                                      // stripe
      box(2.2, 0.05, 2.6, cells, 0, 2.6, -0.4);                                       // solar panel on the roof
      for (const x of [-0.55, 0.55]) { const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.12, 32), hub); sp.rotation.x = Math.PI / 2; sp.position.set(x, 1.75, -1.9); sp.castShadow = true; g.add(sp); }   // suitports
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 10), hub); mast.position.set(0.8, 3.05, -1.4); g.add(mast);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 12, 0, Math.PI * 2, 0, 0.9), shell); dish.material.side = THREE.DoubleSide; dish.rotation.x = -2.3; dish.position.set(0.8, 3.5, -1.4); g.add(dish);
      for (const x of [-0.75, 0.75]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.04), lamp); l.position.set(x, 1.55, 2.16); g.add(l); }
      ud.wheels = [];
      for (const z of [-1.5, 0, 1.5]) for (const x of [-1.32, 1.32]) {
        const w = new THREE.Group(); w.position.set(x, 0.5, z);
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.34, 28), tyre); t.rotation.z = Math.PI / 2; t.castShadow = true; w.add(t);
        const h = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 16), hub); h.rotation.z = Math.PI / 2; w.add(h);
        for (let k = 0; k < 4; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.85), hub); sp.rotation.x = k * Math.PI / 4; w.add(sp); }      // spokes, so the turning shows
        g.add(w); ud.wheels.push(w);
        box(0.42, 0.06, 1.15, frame, x, 1.06, z);                                     // fender
      }
      return g;
    }
    function makeHab() {
      const g = new THREE.Group();
      const shell = pbr({ color: 0xffffff, map: DOMETEX, bumpMap: DOMETEX, bumpScale: 0.015, roughness: 0.6, envMapIntensity: 0.6 });
      const metal = pbr({ color: 0x9ba6ae, roughness: 0.38, metalness: 0.85, envMapIntensity: 1.1 });
      const dark = pbr({ color: 0x1d2227, roughness: 0.55, metalness: 0.3 });
      const regolith = pbr({ color: 0x6f5642, roughness: 1, bumpMap: NOISE, bumpScale: 0.05 });
      const cells = pbr({ map: CELLS, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide, envMapIntensity: 1.4 });
      mk(g, new THREE.SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2), shell, 0, 0.1, 0);
      mk(g, new THREE.CylinderGeometry(1.03, 1.08, 0.14, 56), metal, 0, 0.07, 0);
      const berm = mk(g, new THREE.TorusGeometry(1.3, 0.24, 16, 56), regolith, 0, 0.12, 0); berm.rotation.x = Math.PI / 2; berm.scale.set(1, 1, 0.55);
      const lock = mk(g, new THREE.CylinderGeometry(0.27, 0.27, 0.75, 28), shell, 0, 0.36, 1.18); lock.rotation.x = Math.PI / 2;
      mk(g, new THREE.TorusGeometry(0.23, 0.035, 12, 28), metal, 0, 0.36, 1.56);
      mk(g, new THREE.CircleGeometry(0.21, 28), dark, 0, 0.36, 1.562);
      mk(g, new THREE.SphereGeometry(0.035, 10, 8), pbr({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 1.2 }), 0, 0.72, 1.25);
      for (const [i, a] of [[0, 0.5], [1, 2.2], [2, 3.7]]) { const r = mk(g, new THREE.BoxGeometry(0.34, 0.05, 0.22), metal, Math.sin(a) * 0.62, 0.84, Math.cos(a) * 0.62); r.rotation.y = a; }   // radiators
      mk(g, new THREE.CylinderGeometry(0.018, 0.03, 1.5, 10), metal, 0.45, 1.15, -0.25);
      const dish = mk(g, new THREE.SphereGeometry(0.27, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), metal, 0.45, 1.9, -0.25); dish.rotation.x = -0.65; dish.material.side = THREE.DoubleSide;
      for (let i = 0; i < 3; i++) {                                                   // solar field
        const x = -2.3 + i * 1.2;
        mk(g, new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), metal, x, 0.25, -2.0);
        const p = mk(g, new THREE.BoxGeometry(1.0, 0.035, 0.62), cells, x, 0.56, -2.05); p.rotation.x = -0.6;
      }
      return g;
    }
    function makeSat(hex) {
      const g = new THREE.Group();
      const mli = pbr({ color: 0xc99d3d, roughness: 0.36, metalness: 0.85, bumpMap: FOIL, bumpScale: 0.7, envMapIntensity: 1.4 });
      const silver = pbr({ color: 0xd0d7dd, roughness: 0.28, metalness: 0.92, envMapIntensity: 1.3 });
      const white = pbr({ color: 0xeceeef, roughness: 0.46, metalness: 0.2, side: THREE.DoubleSide, envMapIntensity: 1.0 });
      const black = pbr({ color: 0x14171a, roughness: 0.55, metalness: 0.35 });
      const cells = pbr({ map: CELLS, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide, envMapIntensity: 1.5, emissive: 0x1a4a86, emissiveMap: CELLS, emissiveIntensity: 0.55 });
      const decal = new THREE.MeshBasicMaterial({ color: hex });
      mk(g, new THREE.BoxGeometry(1.1, 1.0, 1.7), mli, 0, 0, 0);
      mk(g, new THREE.BoxGeometry(1.0, 0.04, 1.5), silver, 0, 0.52, 0);                          // radiator
      mk(g, new THREE.BoxGeometry(0.34, 0.02, 0.55), decal, 0.2, 0.545, 0.3);                    // orbiter marking
      for (const [x, z] of [[-0.45, 0.7], [0.45, 0.7], [-0.45, -0.7], [0.45, -0.7]]) mk(g, new THREE.CylinderGeometry(0.06, 0.09, 0.14, 12), black, x, -0.5, z);
      mk(g, new THREE.BoxGeometry(0.5, 0.3, 0.6), black, 0, -0.62, -0.2);                        // instrument deck
      for (const sx of [-1, 1]) {                                                                 // solar arrays on booms
        mk(g, new THREE.CylinderGeometry(0.035, 0.035, 0.9, 8), silver, sx * 0.95, 0.1, 0).rotation.z = Math.PI / 2;
        const arr = mk(g, new THREE.BoxGeometry(3.4, 0.035, 1.7), cells, sx * 2.55, 0.1, 0); arr.rotation.x = 0.12;
        mk(g, new THREE.BoxGeometry(3.46, 0.02, 0.05), silver, sx * 2.55, 0.1, 0.87).rotation.x = 0.12;
        mk(g, new THREE.BoxGeometry(3.46, 0.02, 0.05), silver, sx * 2.55, 0.1, -0.87).rotation.x = 0.12;
      }
      // high-gain antenna: parabolic dish on a boom, pointing at the planet, feed on three struts
      const prof = []; for (let i = 0; i <= 16; i++) { const r = i / 16 * 0.95; prof.push(new THREE.Vector2(r, r * r / (4 * 0.55))); }
      const dishG = new THREE.Group(); dishG.position.set(0, -1.05, 0); g.add(dishG);
      const dish = mk(dishG, new THREE.LatheGeometry(prof, 48), white, 0, 0, 0); dish.rotation.x = Math.PI;
      mk(g, new THREE.CylinderGeometry(0.03, 0.03, 0.55, 8), silver, 0, -0.78, 0);
      mk(dishG, new THREE.CylinderGeometry(0.06, 0.04, 0.16, 12), black, 0, -0.55, 0);
      for (let i = 0; i < 3; i++) { const a = i * 2.094, st = mk(dishG, new THREE.CylinderGeometry(0.008, 0.008, 0.78, 6), silver, Math.sin(a) * 0.4, -0.30, Math.cos(a) * 0.4); st.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55); }
      mk(g, new THREE.CylinderGeometry(0.012, 0.012, 0.9, 6), silver, 0.45, 0.95, -0.5);        // UHF whip
      return g;
    }
    function labelSprite(text, color) {
      const c = document.createElement("canvas"), x = c.getContext("2d"), H0 = 96; x.font = "600 44px 'Inter', sans-serif";
      const tw = Math.ceil(x.measureText(text).width), w = tw + 112; c.width = w; c.height = H0;
      const rr = (a, b, ww, hh, r) => { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + ww, b, a + ww, b + hh, r); x.arcTo(a + ww, b + hh, a, b + hh, r); x.arcTo(a, b + hh, a, b, r); x.arcTo(a, b, a + ww, b, r); x.closePath(); };
      rr(3, 3, w - 6, H0 - 6, (H0 - 6) / 2); x.fillStyle = "rgba(10,14,21,0.88)"; x.fill(); x.lineWidth = 3; x.strokeStyle = "rgba(255,255,255,0.3)"; x.stroke();
      x.fillStyle = color; x.beginPath(); x.arc(46, H0 / 2, 11, 0, 7); x.fill();
      x.fillStyle = "#ffffff"; x.font = "600 44px 'Inter', sans-serif"; x.textAlign = "left"; x.textBaseline = "middle"; x.fillText(text, 72, H0 / 2 + 2);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
      sp.scale.set(0.034 * w / H0, 0.034, 1); sp.center.set(0.5, 0); sp.renderOrder = 10; sp.userData.text = text; return sp;
    }
    function numSprite(n) {
      const c = document.createElement("canvas"); c.width = 128; c.height = 128; const x = c.getContext("2d");
      x.beginPath(); x.arc(64, 64, 52, 0, 7); x.fillStyle = "#1a66e8"; x.fill(); x.lineWidth = 8; x.strokeStyle = "#ffffff"; x.stroke();
      x.fillStyle = "#ffffff"; x.font = "600 60px 'IBM Plex Mono', monospace"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(n), 64, 68);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false, toneMapped: false })); sp.center.set(0.5, 0); sp.renderOrder = 9; return sp;
    }
    const skyDir = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); };

    // Real sizes. The suited astronaut is 1.9 m, the habitat dome 8.4 m across with a 2.3 m airlock.
    // From far away they are smaller than a pixel, so labels and the beacon mark where they are (the way NASA Eyes marks spacecraft).
    // The orbiter is the one exception: it is hundreds of km away, so it is drawn as a sky marker and its label gives the real range.
    const AS = 1, HS = 4.2, SSC = 430 * K, IDLE = HAB, HABM = [HAB[0], Math.min(M.height_m - 1, HAB[1] + 9.6)];   // the walk starts and ends at the habitat point, which is the ground in front of the airlock; the dome stands just north of it
    const astro = makeAstronaut(); astro.scale.setScalar(AS); sc.add(astro); T3.astro = astro;
    const astroTag = labelSprite("Astronaut", "#8ab8ff"); sc.add(astroTag);
    const rover = makeRover(); rover.visible = false; sc.add(rover); T3.rover = rover;
    const roverTag = labelSprite("Crew rover", "#8ab8ff"); roverTag.visible = false; sc.add(roverTag);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.5, 28), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.34, map: (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"), gr = x.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })() }));
    blob.rotation.x = -Math.PI / 2; blob.renderOrder = 2; sc.add(blob);
    let missLine = null, missTag = null, missId = 0;
    const hab = makeHab(); hab.scale.setScalar(HS); hab.position.copy(P(HABM[0], HABM[1], 0)); hab.position.y = ground(HABM[0], HABM[1]); sc.add(hab);
    // The dome stands 9.6 m from the start point with its airlock facing it, on the side the planned route does not use, so nobody walks through a wall.
    function placeHab() {
      const r = S.route; let hx = 0, hy = 1;
      if (r && r.x.length > 2) {
        const L = r.d.at(-1); let i1 = 0, i2 = r.x.length - 1;
        while (i1 < r.x.length - 1 && r.d[i1] < Math.min(70, L / 2)) i1++;
        while (i2 > 0 && L - r.d[i2] < Math.min(70, L / 2)) i2--;
        const un = (x, y) => { const n = Math.hypot(x, y) || 1; return [x / n, y / n]; };
        const a = un(r.x[i1] - HAB[0], r.y[i1] - HAB[1]), back = Math.hypot(r.x.at(-1) - HAB[0], r.y.at(-1) - HAB[1]) < 6, b = back ? un(r.x[i2] - HAB[0], r.y[i2] - HAB[1]) : a;
        const sx = a[0] + b[0], sy = a[1] + b[1];
        [hx, hy] = Math.hypot(sx, sy) > 0.35 ? un(-sx, -sy) : [-a[1], a[0]];
      }
      HABM[0] = Math.min(M.width_m - 1, Math.max(1, HAB[0] + hx * 9.6)); HABM[1] = Math.min(M.height_m - 1, Math.max(1, HAB[1] + hy * 9.6));
      hab.position.copy(P(HABM[0], HABM[1], 0)); hab.position.y = ground(HABM[0], HABM[1]); hab.rotation.y = Math.atan2(-hx, hy);
      habTag.position.copy(hab.position); habTag.position.y += 8.5; rockAt = null;
    }
    const habLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.5 })); habLine.visible = false; habLine.frustumCulled = false; sc.add(habLine);
    const estTag = labelSprite("Estimated position", "#93B7E6"); estTag.visible = false; sc.add(estTag);
    const habTag = labelSprite("Habitat", "#ffffff"); habTag.position.copy(hab.position); habTag.position.y += 8.5; sc.add(habTag);
    // rocks at their real size (about 10 cm to 1.4 m) wherever you look closely. Each one is placed by a hash of its ground cell, so it is always in the same spot.
    const RN = lite ? 280 : 720, RCELL = 6, v3 = new THREE.Vector3();
    const rocks = (() => {
      const rg = new THREE.IcosahedronGeometry(1, 1), rp = rg.attributes.position;
      for (let i = 0; i < rp.count; i++) { const f = 0.78 + Math.random() * 0.4; rp.setXYZ(i, rp.getX(i) * f, rp.getY(i) * f * 0.62, rp.getZ(i) * f); }
      rg.computeVertexNormals();
      const m = new THREE.InstancedMesh(rg, pbr({ color: 0xffffff, roughness: 0.96, envMapIntensity: 0.2 }), RN), cl = new THREE.Color(0x8a6f5a);
      for (let i = 0; i < RN; i++) m.setColorAt(i, cl);
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; sc.add(m); return m;
    })();
    rocksRef = rocks;
    const hsh = (i, j, k) => { let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k + 1, 1274126177); n = Math.imul(n ^ (n >>> 13), 1103515245); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
    let rockAt = null;
    function scatter(mx, my, cd) {                                               // wider field and only the bigger rocks as the camera pulls back
      const R = Math.min(lite ? 120 : 260, Math.max(lite ? 46 : 70, cd * 2.2)), minS = cd * 0.0035, c0 = Math.round(mx / RCELL), c1 = Math.round(my / RCELL), nc = Math.ceil(R / RCELL), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), cl = new THREE.Color(); let n = 0;
      for (let i = c0 - nc; i <= c0 + nc && n < RN; i++) for (let j = c1 - nc; j <= c1 + nc && n < RN; j++) {
        if (hsh(i, j, 0) > 0.5) continue;
        const x = (i + hsh(i, j, 1)) * RCELL, y = (j + hsh(i, j, 2)) * RCELL;
        if (x < 1 || y < 1 || x > M.width_m - 1 || y > M.height_m - 1 || Math.hypot(x - mx, y - my) > R || Math.hypot(x - HABM[0], y - HABM[1]) < 15 || Math.hypot(x - HAB[0], y - HAB[1]) < 3) continue;
        const sz = 0.05 + Math.pow(hsh(i, j, 3), 5) * 0.95; if (sz < minS) continue; e.set(hsh(i, j, 4) * 0.5, hsh(i, j, 5) * 6.28, hsh(i, j, 6) * 0.5); q.setFromEuler(e);
        m4.compose(v3.set(x - M.width_m / 2, ground(x, y) + sz * 0.16, -(y - M.height_m / 2)), q, new THREE.Vector3(sz, sz, sz)); rocks.setMatrixAt(n, m4);
        const t = 0.2 + hsh(i, j, 7) * 0.2; cl.setRGB(t * 0.98, t * 0.72, t * 0.54); rocks.setColorAt(n, cl); n++;
      }
      rocks.count = n; rocks.instanceMatrix.needsUpdate = true; rocks.instanceColor.needsUpdate = true; rockAt = [mx, my, cd];
    }
    const wk = new THREE.Group(); sc.add(wk); wk.visible = false;                         // uncertainty ring + beacon under the walker
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 72), new THREE.MeshBasicMaterial({ color: 0x93B7E6, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; wk.add(ring);
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(5 * K, 5 * K, 700 * K, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0x8ab8ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })); beacon.position.y = 350 * K; wk.add(beacon);
    const beamG = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    const beam = new THREE.Line(beamG, new THREE.LineBasicMaterial({ color: 0x6EE7A8 })); sc.add(beam); beam.visible = false;
    const satHolder = new THREE.Group(); sc.add(satHolder); satHolder.visible = false;
    const sats = {}; let satLabel = null, trailKey = "";
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })); sc.add(trail); trail.visible = false;
    const stopsG = new THREE.Group(); sc.add(stopsG);
    let tube = null;

    let pathW = 0, pathKey = "";
    function buildPath() {
      if (tube) { sc.remove(tube); tube.geometry.dispose(); tube = null; }
      const r = walk.on ? walk.route : S.route; if (!r || r.x.length < 2) return;
      const w = pathW || 22 * K, lift = 0.04 + w * 0.02, cw = M.width_m / nx, ch = M.height_m / ny, px = [], py = [], pn = [];
      // while walking, the line starts at the suit's estimated position and the part already walked is gone
      const hd = walk.on && T3.pathHead ? T3.pathHead : null, X = [], Y = [], Nn = [];
      if (hd) { X.push(hd.x); Y.push(hd.y); Nn.push(Math.min(hd.i, r.x.length - 1)); }
      for (let i = hd ? Math.min(hd.i, r.x.length - 1) : 0; i < r.x.length; i++) { X.push(r.x[i]); Y.push(r.y[i]); Nn.push(i); }
      if (X.length < 2) return;
      for (let i = 0; i < X.length - 1; i++) {                                   // a point wherever the route crosses an edge of the terrain mesh, so the ribbon never dips under it
        const ax = X[i] / cw, ay = (M.height_m - Y[i]) / ch, bx = X[i + 1] / cw, by = (M.height_m - Y[i + 1]) / ch, ts = [0];
        const cuts = (a, b) => { if (a === b) return; for (let k2 = Math.ceil(Math.min(a, b)); k2 <= Math.max(a, b); k2++) { const t = (k2 - a) / (b - a); if (t > 1e-4 && t < 1 - 1e-4) ts.push(t); } };
        cuts(ax, bx); cuts(ay, by); cuts(ax + ay, bx + by); ts.sort((u1, u2) => u1 - u2);
        for (const t of ts) { px.push(X[i] + (X[i + 1] - X[i]) * t); py.push(Y[i] + (Y[i + 1] - Y[i]) * t); pn.push(Nn[i + 1]); }
      }
      px.push(X.at(-1)); py.push(Y.at(-1)); pn.push(Nn.at(-1));
      const n = px.length, pa = new Float32Array(n * 6), ca = new Float32Array(n * 6), idx = [], cc = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); let dx = px[b] - px[a], dy = py[b] - py[a]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        cc.set(SLCOL(r.slope[Math.min(pn[i], r.slope.length - 1)]));
        for (let sd2 = 0; sd2 < 2; sd2++) {
          const sg = sd2 ? 1 : -1, x = Math.min(M.width_m, Math.max(0, px[i] - dy * sg * w / 2)), y = Math.min(M.height_m, Math.max(0, py[i] + dx * sg * w / 2)), o = (i * 2 + sd2) * 3;
          pa[o] = x - M.width_m / 2; pa[o + 1] = ground(x, y) + lift; pa[o + 2] = -(y - M.height_m / 2); ca[o] = cc.r; ca[o + 1] = cc.g; ca[o + 2] = cc.b;
        }
        if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      const g3 = new THREE.BufferGeometry(); g3.setAttribute("position", new THREE.BufferAttribute(pa, 3)); g3.setAttribute("color", new THREE.BufferAttribute(ca, 3)); g3.setIndex(idx);
      tube = new THREE.Mesh(g3, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 })); tube.renderOrder = 1; tube.frustumCulled = false; sc.add(tube);
    }

    function paint() {
      const c = tc.getContext("2d"); c.globalAlpha = 1;
      if (baseImg.complete && baseImg.naturalWidth) c.drawImage(baseImg, 0, 0, tc.width, tc.height);
      const want = [...(S.base === "elevation" ? ["elevation"] : []), ...S.layers];
      for (const n of want) {
        const u = n === "elevation" ? Q("/api/layer/elevation.png") : layerUrl(n);
        if (!imgs[n] || imgs[n].u !== u) { const im = new Image(); im.u = u; im.onload = () => T3.dirty = true; im.src = u; imgs[n] = im; }
        if (imgs[n].complete && imgs[n].naturalWidth) { c.globalAlpha = n === "elevation" ? 0.75 : S.opacity; c.drawImage(imgs[n], 0, 0, tc.width, tc.height); }
      }
      c.globalAlpha = 1; tex.needsUpdate = true;
      if (!walk.on) placeHab();
      buildPath();
      while (stopsG.children.length) { const o = stopsG.children[0]; stopsG.remove(o); if (o.material && o.material.map) o.material.map.dispose(); }
      S.stops.forEach((st, i) => {
        if (elevAt(st[0], st[1]) == null) return;
        const base = P(st[0], st[1], 0).setY(ground(st[0], st[1]));                      // a 2.4 m marker pole; the number floats above it at any distance
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.4, 8), pbr({ color: 0xdfe7ec, roughness: 0.4, metalness: 0.6 })); pole.position.copy(base); pole.position.y += 1.2; pole.castShadow = true; stopsG.add(pole);
        const sp = numSprite(i + 1); sp.scale.set(0.04, 0.04, 1); sp.position.copy(base); sp.position.y += 2.6; stopsG.add(sp);
      });
    }

    // ---- select the terrain to add a waypoint, hover for a readout ----
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null;
    function pickTerrain(e) {
      const rc = cv.getBoundingClientRect(); ndc.set((e.clientX - rc.left) / rc.width * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1); ray.setFromCamera(ndc, cam);
      const h = ray.intersectObject(terrain)[0];
      return h ? { x: h.point.x + M.width_m / 2, y: -h.point.z + M.height_m / 2 } : null;
    }
    cv.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; });
    cv.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) { down = null; return; }
      down = null; if (walk.on) return;
      const h = pickTerrain(e); if (!h) return;
      if (MODE === "explore") { if (T3.exPick) T3.exPick([h.x, h.y]); return; }
      dismissCoach(); S.stops.push([h.x, h.y]); plan(); toast("Waypoint added", `Waypoint ${S.stops.length} added. Select the terrain again to add another.`, "#8ab8ff");
    });
    cv.addEventListener("pointermove", e => {
      const now = performance.now(); if (now - (T3.hv || 0) < 120 || e.buttons) return; T3.hv = now;
      const h = pickTerrain(e); if (!h) return;
      const [lo, la] = lonLat(h.x, h.y), z = elevAt(h.x, h.y), sl = slopeAt(h.x, h.y);
      $("rLat").textContent = la.toFixed(4) + "° N"; $("rLon").textContent = lo.toFixed(4) + "° E"; $("rEl").textContent = z == null ? "—" : Math.round(z) + " m"; $("rSl").textContent = sl == null ? "—" : sl.toFixed(1) + "°";
    });

    {   // first person: drag to look around (grab the world, like Street View), wheel to zoom
      let lk = null;
      cv.addEventListener("pointerdown", e => { if (!T3.fp) return; lk = { id: e.pointerId, x: e.clientX, y: e.clientY }; T3.looking = true; });
      addEventListener("pointermove", e => { if (!T3.fp || !lk || lk.id !== e.pointerId) return; const L = T3.look; L.yaw += (e.clientX - lk.x) * 0.0045; L.pitch = Math.min(1.0, Math.max(-1.1, L.pitch + (e.clientY - lk.y) * 0.0045)); lk.x = e.clientX; lk.y = e.clientY; });
      const lend = e => { if (lk && lk.id === e.pointerId) { lk = null; T3.looking = false; } };
      addEventListener("pointerup", lend); addEventListener("pointercancel", lend);
      cv.addEventListener("wheel", e => { if (!T3.fp) return; e.preventDefault(); cam.fov = Math.min(80, Math.max(25, cam.fov * (e.deltaY > 0 ? 1.07 : 0.93))); cam.updateProjectionMatrix(); }, { passive: false });
    }
    const UP = new THREE.Vector3(0, 1, 0);
    /* Phone VR (Cardboard, Gear VR as a holder): the screen is split into a left and a right eye 6.4 cm apart,
       and the phone's gyroscope turns the view. The body still faces the way the astronaut walks; your head looks around from there.
       A panel below eye level carries the HUD: look down to read it. No lens distortion correction. */
    const camE = new THREE.PerspectiveCamera(80, 1, 0.1, 130000 * K), qF = new THREE.Quaternion(), qY = new THREE.Quaternion(), vF = new THREE.Vector3();
    /* The info card stands to your left, a little below eye level, 1.3 m away, and turns with the way you walk
       (like a screen beside a driver). Looking at it pauses the walk and holds your direction, so you can read in peace. */
    const hudC = document.createElement("canvas"); hudC.width = 1200; hudC.height = 1030;
    const hudT = new THREE.CanvasTexture(hudC); hudT.encoding = THREE.sRGBEncoding; hudT.anisotropy = Math.min(8, rn.capabilities.getMaxAnisotropy());
    const vrHud = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.90125), new THREE.MeshBasicMaterial({ map: hudT, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    vrHud.renderOrder = 20; vrHud.visible = false; sc.add(vrHud);
    const CARD_YAW = 0.75, CARD_D = 1.3, CARD_DY = -0.22, CARD_GAZE = Math.cos(0.3);
    // gaze buttons along the bottom of the card (canvas pixels); hold the reticle on one for 2 s
    const VR_BTNS = [["half", "Halfway", "teleport"], ["sat", "Satellite", "skip the wait"], ["home", "Habitat", "route home"], ["exit", "Exit VR", "back to the app"]]
      .map(([id, label, sub], i) => ({ id, label, sub, x: 60 + i * (258 + 16), y: 840, w: 258, h: 104 }));
    // a top row of two wide buttons: how fast time runs, and whether you steer or the autopilot walks the route while you look round
    VR_BTNS.unshift(
      { id: "speed", x: 60, y: 720, w: 532, h: 104, label: () => `Speed ×${S.speed}`, sub: () => "change how fast time runs" },
      { id: "auto", x: 608, y: 720, w: 532, h: 104, label: () => walk.manual ? "Autopilot" : "Walk myself", sub: () => walk.manual ? "follow the route, just look around" : "steer with your head again" });
    const gazeRay = new THREE.Raycaster();
    const retC = document.createElement("canvas"); retC.width = retC.height = 128;
    const retT = new THREE.CanvasTexture(retC);
    const reticle = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), new THREE.MeshBasicMaterial({ map: retT, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    reticle.renderOrder = 30; reticle.visible = false; sc.add(reticle);
    let retKey = "";
    function drawReticle(on, prog) {
      const key = (on ? 1 : 0) + ":" + Math.round(prog * 40); if (key === retKey) return; retKey = key;
      const x = retC.getContext("2d"); x.clearRect(0, 0, 128, 128); x.lineCap = "round";
      x.lineWidth = 14; x.strokeStyle = "rgba(0, 0, 0, 0.55)"; x.beginPath(); x.arc(64, 64, 38, 0, 7); x.stroke();
      x.lineWidth = 7; x.strokeStyle = on ? "#ffffff" : "rgba(255, 255, 255, 0.8)"; x.beginPath(); x.arc(64, 64, on ? 38 : 26, 0, 7); x.stroke();
      if (prog > 0) { x.lineWidth = 12; x.strokeStyle = "#3b82f6"; x.beginPath(); x.arc(64, 64, 38, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); x.stroke(); }
      x.fillStyle = "#ffffff"; x.beginPath(); x.arc(64, 64, 7, 0, 7); x.fill();
      retT.needsUpdate = true;
    }
    function drawVrHud(paused, hov) {
      const x = hudC.getContext("2d"), W = hudC.width, H = hudC.height, tx = id => ($(id) && $(id).textContent) || "", L = 60;
      const rr = (X, Y, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(X, Y, w, h, r); else x.rect(X, Y, w, h); };
      x.clearRect(0, 0, W, H);
      rr(6, 6, W - 12, H - 12, 44); x.fillStyle = "rgba(5, 8, 13, 0.9)"; x.fill(); x.lineWidth = 6; x.strokeStyle = paused ? "#f2b84b" : "rgba(138, 184, 255, 0.6)"; x.stroke();
      // header: what is happening right now
      x.font = "700 30px Inter, sans-serif"; x.fillStyle = "#8f9cb1"; x.fillText("MARSWALK", L, 72);
      const badge = !walk.on ? ["STARTING", "#8ab8ff"] : paused ? ["PAUSED", "#f2b84b"] : ["WALKING", "#3ddc97"];
      x.font = "700 30px Inter, sans-serif"; const bw = x.measureText(badge[0]).width + 48;
      rr(W - L - bw, 38, bw, 50, 25); x.fillStyle = badge[1]; x.fill(); x.fillStyle = "#04060a"; x.fillText(badge[0], W - L - bw + 24, 74);
      // where to go
      const nx = walk.on ? tx("hudNext").split(" · ") : ["Getting ready", ""];
      x.fillStyle = "#ffffff"; x.font = "600 58px Inter, sans-serif"; x.fillText(nx[0] || "", L, 168);
      x.fillStyle = "#8ab8ff"; x.font = "500 76px 'IBM Plex Mono', monospace"; x.fillText(nx[1] || "", L, 256);
      // three readings
      const pos = tx("hudPos"), pn = +pos.replace(/[^0-9]/g, "") || 0, hab = tx("hudHab"), sat = tx("hudLink");
      const tiles = [["Position", pos || "—", pn > 60 ? "#ff6b55" : pn > 25 ? "#f2b84b" : "#4fd1a1"], ["Habitat", hab.startsWith("linked") ? "linked" : hab ? "blocked" : "—", hab.startsWith("linked") ? "#4fd1a1" : "#f2b84b"], ["Satellite", (sat || "—").replace("none in view", "none"), sat && !/none|in /.test(sat) ? "#4fd1a1" : "#ffffff"]];
      const tw = (W - 2 * L - 2 * 24) / 3;
      tiles.forEach(([k, v, c], i) => {
        const X = L + i * (tw + 24); rr(X, 300, tw, 132, 22); x.fillStyle = "#111723"; x.fill();
        x.fillStyle = "#8f9cb1"; x.font = "500 30px Inter, sans-serif"; x.fillText(k, X + 24, 346);
        x.fillStyle = c; x.font = "600 40px 'IBM Plex Mono', monospace"; let t = v; while (x.measureText(t).width > tw - 44 && t.length > 3) t = t.slice(0, -2) + "…"; x.fillText(t, X + 24, 404);
      });
      // the guide's latest words
      const g = LOG[0];
      if (g) {
        x.fillStyle = g.color || "#8ab8ff"; x.font = "600 42px Inter, sans-serif"; x.fillText(g.title.slice(0, 44), L, 500);
        x.fillStyle = "#d6dce7"; x.font = "400 36px Inter, sans-serif";
        const words = String(g.msg).split(" "); let line = "", y = 552, n = 0;
        for (const w of words) { const t = line ? line + " " + w : w; if (x.measureText(t).width > W - 2 * L) { x.fillText(n === 2 ? line + " …" : line, L, y); y += 48; line = w; if (++n === 3) { line = ""; break; } } else line = t; }
        if (line) x.fillText(line, L, y);
      }
      VR_BTNS.forEach(b => {                                               // the gaze buttons
        const on = hov === b.id; rr(b.x, b.y, b.w, b.h, 20); x.fillStyle = on ? "#1a66e8" : "#19212f"; x.fill(); x.lineWidth = 4; x.strokeStyle = on ? "#8ab8ff" : "#2b3649"; x.stroke();
        x.fillStyle = "#ffffff"; x.font = "700 36px Inter, sans-serif"; x.fillText(typeof b.label === "function" ? b.label() : b.label, b.x + 22, b.y + 50);
        x.fillStyle = on ? "#dbe8ff" : "#8f9cb1"; x.font = "500 26px Inter, sans-serif"; x.fillText(typeof b.sub === "function" ? b.sub() : b.sub, b.x + 22, b.y + 86);
      });
      x.fillStyle = "#627087"; x.font = "500 28px Inter, sans-serif"; x.fillText(paused ? "Hold the dot on a button for 2 seconds · look away to walk on" : "Look at this card to pause", L, H - 30);
      hudT.needsUpdate = true;
    }
    /* The radio card stands on your right, the mirror of the info card: who you are talking to, the latest messages
       and quick replies. Same gaze buttons, same 2 s hold; it reuses the Radio tab's message queue. */
    const radC = document.createElement("canvas"); radC.width = 1200; radC.height = 1030;
    const radT = new THREE.CanvasTexture(radC); radT.encoding = THREE.sRGBEncoding; radT.anisotropy = hudT.anisotropy;
    const vrRad = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.90125), new THREE.MeshBasicMaterial({ map: radT, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    vrRad.renderOrder = 20; vrRad.visible = false; sc.add(vrRad);
    const RAD_BTNS = [
      { id: "r:earth", x: 60, y: 120, w: 532, h: 96, label: "Earth", sub: () => { const s = linkNow(); return s ? `via ${s.orbiter}` : "waits for a relay pass"; } },
      { id: "r:pod", x: 608, y: 120, w: 532, h: 96, label: "Habitat", sub: () => habNow().ok ? "direct radio" : "hidden by terrain" },
      ...QUICK.map((t, i) => ({ id: "r:q" + i, x: 60 + (i % 2) * 548, y: 720 + Math.floor(i / 2) * 120, w: 532, h: 104, label: t, sub: () => `send to ${COM.dest === "earth" ? "Earth" : "the habitat"}` }))];
    function drawVrRad(hov) {
      const x = radC.getContext("2d"), W = radC.width, H = radC.height, L = 60;
      const rr = (X, Y, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(X, Y, w, h, r); else x.rect(X, Y, w, h); };
      const fit = (t, w) => { t = String(t); while (x.measureText(t).width > w && t.length > 3) t = t.slice(0, -2) + "…"; return t; };
      x.clearRect(0, 0, W, H);
      rr(6, 6, W - 12, H - 12, 44); x.fillStyle = "rgba(5, 8, 13, 0.9)"; x.fill(); x.lineWidth = 6; x.strokeStyle = "rgba(138, 184, 255, 0.6)"; x.stroke();
      x.font = "700 30px Inter, sans-serif"; x.fillStyle = "#8f9cb1"; x.fillText("RADIO", L, 82);
      const lk = linkFor(COM.dest), st = lk ? [lk.hab ? "HABITAT LINK" : lk.orbiter + " OVERHEAD", "#3ddc97"] : ["LINK CLOSED", "#f2b84b"];
      const bw = x.measureText(st[0]).width + 48; rr(W - L - bw, 46, bw, 50, 25); x.fillStyle = st[1]; x.fill(); x.fillStyle = "#04060a"; x.fillText(st[0], W - L - bw + 24, 82);
      // the latest messages, newest first
      const nowS = Date.now() / 1000 + COM.off, who = r => r === "earth" ? "Earth" : r === "pod" ? "Habitat" : "you", rows = [];
      COM.q.slice().reverse().forEach(m => rows.push([`You → ${who(m.to)}`, msgLabel(m), "queued", "#f2b84b"]));
      [...COM.srv.values()].sort((a, b) => b.id - a.id).forEach(m => {
        if (m.sender === "astronaut") rows.push([`You → ${who(m.to)}`, msgLabel(m), m.status === "in_flight" ? "on its way" : "arrived", m.status === "in_flight" ? "#8ab8ff" : "#4fd1a1"]);
        else { const d = m.delivered; rows.push([`From ${who(m.sender)}`, d ? msgLabel(m) : "Incoming message", d ? "received" : nowS >= m.arrive ? "at the orbiter" : "in flight", d ? "#ff9a6b" : "#8f9cb1"]); }
      });
      if (!rows.length) { x.fillStyle = "#8f9cb1"; x.font = "400 36px Inter, sans-serif"; x.fillText("No messages yet. Pick who to talk to,", L, 320); x.fillText("then hold the dot on a quick reply.", L, 370); }
      rows.slice(0, 4).forEach(([t, body, s, c], i) => {
        const Y = 244 + i * 116; rr(L, Y, W - 2 * L, 104, 20); x.fillStyle = "#111723"; x.fill();
        x.fillStyle = c; x.fillRect(L, Y + 18, 6, 68);
        x.font = "600 30px Inter, sans-serif"; x.fillStyle = "#8f9cb1"; x.fillText(t, L + 30, Y + 40);
        x.font = "500 28px 'IBM Plex Mono', monospace"; x.fillStyle = c; const sw = x.measureText(s).width; x.fillText(s, W - L - 26 - sw, Y + 40);
        x.font = "500 36px Inter, sans-serif"; x.fillStyle = "#ffffff"; x.fillText(fit(body, W - 2 * L - 60), L + 30, Y + 86);
      });
      RAD_BTNS.forEach(b => {
        const sel = b.id === "r:" + COM.dest, on = hov === b.id;
        rr(b.x, b.y, b.w, b.h, 20); x.fillStyle = on ? "#1a66e8" : sel ? "#16305e" : "#19212f"; x.fill(); x.lineWidth = 4; x.strokeStyle = on || sel ? "#8ab8ff" : "#2b3649"; x.stroke();
        x.fillStyle = "#ffffff"; x.font = "700 34px Inter, sans-serif"; x.fillText(fit(b.label, b.w - 44), b.x + 22, b.y + 46);
        x.fillStyle = on ? "#dbe8ff" : "#8f9cb1"; x.font = "500 26px Inter, sans-serif"; x.fillText(fit(b.sub(), b.w - 44), b.x + 22, b.y + 80);
      });
      x.fillStyle = "#627087"; x.font = "500 28px Inter, sans-serif"; x.fillText("Hold the dot on a button for 2 seconds", L, H - 30);
      radT.needsUpdate = true;
    }
    // tour: the head angles (yaw, pitch) that put the dot on a card button
    T3.vrAimDir = dir => { const d = dir.clone().normalize().applyQuaternion(qY.clone().invert()); return [Math.atan2(-d.x, -d.z), Math.asin(Math.max(-1, Math.min(1, d.y)))]; };
    T3.vrAimCard = () => { vrHud.updateMatrixWorld(); const d = new THREE.Vector3(0, 0.18, 0).applyMatrix4(vrHud.matrixWorld).sub(cam.position).normalize().applyQuaternion(qY.clone().invert()); return [Math.atan2(-d.x, -d.z), Math.asin(d.y)]; };
    T3.vrAim = id => {
      const r = id.startsWith("r:"), b = (r ? RAD_BTNS : VR_BTNS).find(v => v.id === id), card = r ? vrRad : vrHud; card.updateMatrixWorld();
      const d = new THREE.Vector3(((b.x + b.w / 2) / hudC.width - 0.5) * 1.05, (0.5 - (b.y + b.h / 2) / hudC.height) * 0.90125, 0).applyMatrix4(card.matrixWorld).sub(cam.position).normalize().applyQuaternion(qY.clone().invert());
      return [Math.atan2(-d.x, -d.z), Math.asin(d.y)];
    };
    function vrDraw(here, jy) {
      const V = T3.vr, fd = T3.fpDir || new THREE.Vector3(0, 0, -1);
      if (V.yaw0 == null) { vF.set(0, 0, -1).applyQuaternion(V.q); V.yaw0 = Math.atan2(-vF.x, -vF.z); V.calib = Math.atan2(-fd.x, -fd.z) - V.yaw0; }   // recenter: straight ahead = the way you face now
      const gp = padAxes(); if (gp && Math.abs(gp[0]) > 0.15) V.calib -= gp[0] * 1.6 * (T3.vrDt || 0.016);
      qY.setFromAxisAngle(UP, V.calib); qF.copy(qY).multiply(V.q);
      cam.position.copy(here); cam.position.y = here.y + (S.vehicle === "rover" && walk.on ? 2.15 : 1.68) + jy; cam.quaternion.copy(qF);
      ctl.target.copy(cam.position).add(vF.set(0, 0, -3).applyQuaternion(qF));
      const hv = new THREE.Vector3(0, 0, -1).applyQuaternion(qF);
      const side = new THREE.Vector3(fd.x, 0, fd.z).normalize().applyAxisAngle(UP, CARD_YAW);
      vrHud.position.set(cam.position.x, here.y + 1.68 + CARD_DY, cam.position.z).addScaledVector(side, CARD_D); vrHud.lookAt(cam.position); vrHud.visible = true;
      const rside = new THREE.Vector3(fd.x, 0, fd.z).normalize().applyAxisAngle(UP, -CARD_YAW);
      vrRad.position.set(cam.position.x, here.y + 1.68 + CARD_DY, cam.position.z).addScaledVector(rside, CARD_D); vrRad.lookAt(cam.position); vrRad.visible = true;
      vrHud.updateMatrixWorld(); vrRad.updateMatrixWorld(); gazeRay.set(cam.position, hv);
      const gHit = gazeRay.intersectObject(vrHud)[0], rHit = gHit ? null : gazeRay.intersectObject(vrRad)[0];
      const atCard = !!gHit || !!rHit || hv.dot(vF.copy(vrHud.position).sub(cam.position).normalize()) > CARD_GAZE || hv.dot(vF.copy(vrRad.position).sub(cam.position).normalize()) > CARD_GAZE;
      T3.vrHead = { hd: Math.atan2(hv.x, -hv.z), pitch: Math.asin(Math.max(-1, Math.min(1, hv.y))), atCard };
      if (atCard !== V.paused) { V.paused = atCard; V.hudAt = 0; }
      let hov = null;
      const pick = (hit, list) => { if (!hit || !hit.uv) return null; const px = hit.uv.x * hudC.width, py = (1 - hit.uv.y) * hudC.height; return list.find(b2 => px >= b2.x && px <= b2.x + b2.w && py >= b2.y && py <= b2.y + b2.h) || null; };
      if (atCard) hov = pick(gHit, VR_BTNS) || pick(rHit, RAD_BTNS);
      const DW = V.dwell || (V.dwell = { id: null, t: 0, done: false });
      if ((hov && hov.id) !== DW.id) { DW.id = hov ? hov.id : null; DW.t = 0; DW.done = false; V.hudAt = 0; }
      else if (hov && !DW.done) { DW.t += T3.vrDt || 0.016; if (DW.t >= 2) { DW.done = true; V.hudAt = 0; setTimeout(() => vrAction(hov.id), 0); } }
      reticle.position.copy(cam.position).addScaledVector(hv, 1.2); reticle.quaternion.copy(qF); reticle.visible = true;
      drawReticle(!!hov, hov && !DW.done ? Math.min(1, DW.t / 2) : 0);
      const now = performance.now(); if (now - (V.hudAt || 0) > 500) { V.hudAt = now; const dh = V.dwell && !V.dwell.done ? V.dwell.id : null; drawVrHud(V.paused, dh); drawVrRad(dh); }
      const W = cv.clientWidth, H = cv.clientHeight, half = W / 2, rt = new THREE.Vector3(1, 0, 0).applyQuaternion(qF);
      camE.fov = 80; camE.aspect = half / H; camE.near = 0.1; camE.far = cam.far; camE.updateProjectionMatrix();
      rn.setScissorTest(true);
      for (const sd of [-1, 1]) {
        camE.position.copy(cam.position).addScaledVector(rt, sd * 0.032); camE.quaternion.copy(qF);
        const x0 = sd < 0 ? 0 : half; rn.setViewport(x0, 0, half, H); rn.setScissor(x0, 0, half, H); rn.render(sc, camE);
      }
      rn.setScissorTest(false); rn.setViewport(0, 0, W, H);
    }
    T3.api = {
      lookSat: (ms = 0) => { if (!T3.satDir) return; const p0 = cam.position.clone(), q0 = ctl.target.clone(); setCam("free", true); const h0 = T3.herePos, d = T3.satDir.clone(), flat = d.clone().setY(0); if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1); flat.normalize(); T3.skyLook = true;
        const p1 = h0.clone().addScaledVector(flat, -600 * K); p1.y += 250 * K; const q1 = p1.clone().addScaledVector(d, 2600 * K);
        if (ms) { cam.position.copy(p0); ctl.target.copy(q0); T3.fly = { p0, q0, p1, q1, t0: performance.now(), ms }; } else { cam.position.copy(p1); ctl.target.copy(q1); } },
      setLite: v => {
        lite = v; T3.lite = v; try { localStorage.setItem("mw_lite", v ? "1" : "0"); } catch (e) { /* ignore */ }
        rn.shadowMap.enabled = !v; sun.castShadow = !v; sc.environment = v ? null : envTex;
        sc.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
      },
      zoom: f => { if (T3.fp) { cam.fov = Math.min(80, Math.max(25, cam.fov * f)); cam.updateProjectionMatrix(); return; } if (T3.chase) { T3.chaseK = Math.min(14, Math.max(0.35, (T3.chaseK || 1) * f)); return; } const d = cam.position.clone().sub(ctl.target).multiplyScalar(f); cam.position.copy(ctl.target).add(d); },
      reset: () => { setCam("free", true); homeCam(); },
      flyTo: (tx, ty, back, up, ms, az = 0.6) => {                          // look at map point (tx, ty) from 'back' metres away (azimuth az from south) and 'up' metres higher
        setCam("free", true); const q1 = P(tx, ty, elevAt(tx, ty) ?? M.zmin), p1 = q1.clone().add(new THREE.Vector3(-Math.sin(az) * back, up, Math.cos(az) * back));
        T3.fly = { p0: cam.position.clone(), q0: ctl.target.clone(), p1, q1, t0: performance.now(), ms };
      },
      aerial: (d = 0.42, h = 0.2) => { setCam("free", true); const cx = M.width_m / 2, cy = M.height_m / 2; ctl.target.copy(P(cx, cy, elevAt(cx, cy) ?? M.zmin)); cam.position.copy(ctl.target).add(new THREE.Vector3(0, h * M.width_m, d * M.height_m)); },
      backOff: () => { const d = ctl.target.clone().sub(cam.position).setY(0); if (d.lengthSq() < 1e-6) d.set(0, 0, -1); d.normalize(); ctl.target.copy(cam.position).addScaledVector(d, 2); cam.position.addScaledVector(d, -10); cam.position.y += 4; },
      fov: v => { cam.fov = v; cam.updateProjectionMatrix(); },
      vrPixels: on => { rn.setPixelRatio(on ? Math.min(devicePixelRatio || 1, 1.5) : Math.min(devicePixelRatio || 1, 2)); }, top: () => { T3.skyLook = false; const t = ctl.target; cam.position.set(t.x, t.y + 14000 * K, t.z + 1); },
    };

    T3.render = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * rn.getPixelRatio())) { rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
      if (T3.dirty) { T3.dirty = false; paint(); }
      const now = performance.now(), dtr = Math.min(0.1, (now - (T3.t0 || now)) / 1000); T3.t0 = now;

      // sun, sky and fog follow the real Sun position at the site
      const SN = T3.testSun || T3.sun, a = SN.az * Math.PI / 180, e = Math.max(SN.el, 1.5) * Math.PI / 180, day = Math.max(0, Math.min(1, (SN.el + 2) / 14));
      const sd = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
      skyU.sunDir.value.set(sd.x, Math.sin(SN.el * Math.PI / 180), sd.z); skyU.day.value = day; sky.position.copy(cam.position);
      sun.intensity = 1.5 * day; hemi.intensity = 0.12 + 0.28 * day + (T3.lite ? 0.14 : 0);
      sc.fog.color.setRGB(0.04 + 0.56 * day, 0.05 + 0.42 * day, 0.07 + 0.30 * day);
      envMats.forEach(m => { m.envMapIntensity = m.userData.env0 * (0.12 + 0.88 * day); });
      sun.target.position.copy(ctl.target); sun.position.copy(ctl.target).addScaledVector(sd, 7000 * K); sun.target.updateMatrixWorld();
      rn.toneMappingExposure = 0.78 + 0.4 * (1 - day);

      // the astronaut: walks along the route; waits outside the airlock otherwise
      const k = T3.walker, walking = walk.on && !!k, u = astro.userData;
      const here = walking ? P(k.x, k.y, 0) : P(IDLE[0], IDLE[1], 0); here.y = ground(walking ? k.x : IDLE[0], walking ? k.y : IDLE[1]);
      astro.position.copy(here);
      blob.position.copy(here); blob.position.y += 0.035;
      if (walking) {
        if (Math.hypot(k.hdx, k.hdy) > 1e-6) astro.rotation.y = Math.atan2(k.hdx, -k.hdy);
        if (!walk.busy && !k.still) T3.phase = (T3.phase || 0) + dtr * 5.6;
        const sw = k.still ? 0 : Math.sin(T3.phase), go = k.still ? 0 : 1;            // a suited walk: short stride, bent arms held out, a slight lean
        u.legL.rotation.x = sw * 0.42; u.legR.rotation.x = -sw * 0.42;
        u.kneeL.rotation.x = Math.max(0, sw) * 0.75 + 0.06 * go; u.kneeR.rotation.x = Math.max(0, -sw) * 0.75 + 0.06 * go;
        u.armL.rotation.x = -sw * 0.26; u.armR.rotation.x = sw * 0.26; u.elbowL.rotation.x = -0.5 - Math.max(0, -sw) * 0.2; u.elbowR.rotation.x = -0.5 - Math.max(0, sw) * 0.2;
        astro.rotation.x = 0.07 * go; astro.rotation.z = Math.sin(T3.phase) * 0.025 * go;
        if (!k.still) astro.position.y += Math.abs(Math.cos(T3.phase)) * 0.035;
      } else {
        astro.rotation.set(0, hab.rotation.y + 0.35, 0);
        for (const n of ["legL", "legR", "kneeL", "kneeR"]) u[n].rotation.x = 0;
        u.armL.rotation.x = u.armR.rotation.x = 0.04; u.elbowL.rotation.x = u.elbowR.rotation.x = -0.32;
      }
      let jy = 0;                                                                // jump: crouch, push off, float in 0.38 g, soak up the landing
      if (T3.jmp) {
        const J = T3.jmp, C = 0.16, V0 = 1.7, G = 3.71, TF = 2 * V0 / G, LD = 0.24; J.t += dtr;
        let crouch = 0;
        if (J.t < C) crouch = Math.sin(J.t / C * Math.PI / 2);
        else if (J.t < C + TF) {
          const tt = J.t - C; jy = V0 * tt - G * tt * tt / 2;
          u.legL.rotation.x = 0.3; u.legR.rotation.x = 0.1; u.kneeL.rotation.x = 0.5; u.kneeR.rotation.x = 0.35;
          u.armL.rotation.x = u.armR.rotation.x = -0.5; u.elbowL.rotation.x = u.elbowR.rotation.x = -0.6;
        } else if (J.t < C + TF + LD) crouch = Math.sin((1 - (J.t - C - TF) / LD) * Math.PI / 2) * 0.8;
        else T3.jmp = null;
        if (crouch) { u.legL.rotation.x = u.legR.rotation.x = 0.55 * crouch; u.kneeL.rotation.x = u.kneeR.rotation.x = 1.05 * crouch; u.armL.rotation.x = u.armR.rotation.x = 0.3 * crouch; jy -= 0.12 * crouch; }
        astro.position.y += jy;
      }
      blob.material.opacity = 0.34 * Math.max(0.35, 1 - Math.max(0, jy) * 1.6);
      const RV = S.vehicle === "rover";
      rover.visible = RV && !(T3.fp && walking); roverTag.visible = false;
      if (RV) {
        // driving: the crew are inside. Parked: beside the airlock, nose out
        const hvx = hab.position.x + M.width_m / 2 - IDLE[0], hvy = M.height_m / 2 - hab.position.z - IDLE[1], hl = Math.hypot(hvx, hvy) || 1;   // from the airlock to the dome
        const hyT = walking && Math.hypot(k.hdx, k.hdy) > 1e-6 ? Math.atan2(k.hdx, k.hdy) : Math.atan2(-hvx, -hvy);                                   // parked nose away from the dome
        // a vehicle steers and rides on its suspension: ease the heading, height and tilt instead of snapping to every bend and bump
        const ez = r => 1 - Math.exp(-dtr * r);
        if (T3.rvHy == null || !walking) T3.rvHy = hyT; else T3.rvHy += Math.atan2(Math.sin(hyT - T3.rvHy), Math.cos(hyT - T3.rvHy)) * ez(2.2);
        const hy = T3.rvHy;
        const fx = Math.sin(hy), fy = Math.cos(hy), mx0 = walking ? k.x : IDLE[0] - hvy / hl * 7, my0 = walking ? k.y : IDLE[1] + hvx / hl * 7;       // 7 m to the side of the airlock
        const gz = (a, b) => ground(Math.min(M.width_m, Math.max(0, mx0 + a * fx - b * fy)), Math.min(M.height_m, Math.max(0, my0 + a * fy + b * fx)));
        const zf = gz(1.6, 0), zb = gz(-1.6, 0), zl = gz(0, 1.3), zr = gz(0, -1.3), yT = (zf + zb + zl + zr) / 4, pT = -Math.atan2(zf - zb, 3.2), rT = Math.atan2(zl - zr, 2.6);
        const S2 = T3.rvSus || (T3.rvSus = { y: yT, p: pT, r: rT }), big = Math.abs(S2.y - yT) > 30 || !walking;
        S2.y = big ? yT : S2.y + (yT - S2.y) * ez(6); S2.p = big ? pT : S2.p + (pT - S2.p) * ez(4); S2.r = big ? rT : S2.r + (rT - S2.r) * ez(4);
        rover.position.copy(P(mx0, my0, 0)); rover.position.y = S2.y;
        rover.rotation.set(S2.p, Math.atan2(fx, -fy), S2.r);
        const lp = T3.rvLast || [mx0, my0], dd = Math.hypot(mx0 - lp[0], my0 - lp[1]); T3.rvLast = [mx0, my0];
        if (dd < 50) { T3.rvRoll = (T3.rvRoll || 0) + dd / 0.5; rover.userData.wheels.forEach(w => { w.rotation.x = T3.rvRoll; }); }
        if (walking) { astro.visible = false; blob.visible = false; astroTag.visible = false; }
        const camR = cam.position.distanceTo(rover.position); roverTag.visible = camR > 60 && !T3.fp; roverTag.position.copy(rover.position); roverTag.position.y += 3.6;
      }
      // the miss: a red line from where the suit thought you were to where you really are
      const ms = T3.miss && now < T3.miss.until ? T3.miss : null;
      if (ms && ms.id !== missId) {
        missId = ms.id; if (missTag) { sc.remove(missTag); missTag.material.map.dispose(); }
        missTag = labelSprite(`${Math.round(ms.d)} m off`, "#fc3d21"); sc.add(missTag);
        if (!missLine) { missLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xfc3d21, depthTest: false, transparent: true })); missLine.renderOrder = 8; missLine.frustumCulled = false; sc.add(missLine); }
        const a = P(ms.ox, ms.oy, 0).setY(ground(ms.ox, ms.oy) + 0.3), b = P(ms.nx, ms.ny, 0).setY(ground(ms.nx, ms.ny) + 0.3);
        missLine.geometry.setFromPoints([a, b]); missTag.position.copy(a).lerp(b, 0.5); missTag.position.y += 1.2;
      }
      if (missLine) missLine.visible = !!ms; if (missTag) missTag.visible = !!ms;
      const camD = cam.position.distanceTo(here);
      const camH = cam.position.distanceTo(hab.position), nearHab = here.distanceTo(hab.position) < camH * 0.07;
      astroTag.position.copy(here); astroTag.position.y += 2.1; astroTag.visible = camD > 40 && !(nearHab && !walking);
      habTag.visible = camH > 110 && !(nearHab && walking);
      habLine.visible = walking && habNow().ok && here.distanceTo(hab.position) > 25;      // the habitat radio link, drawn from the top of the mast
      if (habLine.visible) habLine.geometry.setFromPoints([hab.localToWorld(new THREE.Vector3(0.45, 1.9, -0.25)), here.clone().setY(here.y + 1.75)]);
      wk.visible = walking;
      if (walking) {
        wk.position.copy(k.bx != null ? P(k.bx, k.by, 0).setY(ground(k.bx, k.by)) : here);
        const rr = Math.max(k.rad, 1.2); ring.scale.setScalar(rr); ring.position.y = 0.05 + rr * 0.012; ring.material.color.set(k.tracked ? 0x6EE7A8 : k.src === "hab" ? 0x3ddc97 : 0x93B7E6);
        beacon.visible = camD > 700;
        estTag.position.copy(wk.position); estTag.position.y += 0.4; estTag.visible = !k.tracked && wk.position.distanceTo(here) > Math.max(4, camD * 0.14) && camD < 900;
      } else {
        estTag.visible = false;                                                 // a locator beam, only from far away
      }
      // zoom-dependent detail: near plane, shadow box, rocks and the width of the painted route
      const cd = cam.position.distanceTo(ctl.target);
      const nr = Math.min(10 * K, Math.max(0.12, cd * 0.03)); if (Math.abs(nr - cam.near) > cam.near * 0.15) { cam.near = nr; cam.updateProjectionMatrix(); }
      const shW = Math.min(1700 * K, Math.max(16, cd * 1.5));
      if (Math.abs(shW - shNow) > shNow * 0.2) { shNow = shW; Object.assign(sun.shadow.camera, { left: -shW, right: shW, top: shW, bottom: -shW }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.normalBias = Math.max(0.02, 3 * shW / 1700); }
      if (cd < 700) { const mx = ctl.target.x + M.width_m / 2, my = M.height_m / 2 - ctl.target.z; if (!rockAt || Math.hypot(mx - rockAt[0], my - rockAt[1]) > Math.max(RCELL * 2, cd * 0.25) || cd > rockAt[2] * 1.3 || cd < rockAt[2] / 1.3) scatter(mx, my, cd); rocks.visible = true; } else rocks.visible = false;
      const pw = Math.min(40 * K, Math.max(0.22, cd * 0.012)), hq = Math.max(0.3, (pathW || 1) * 0.6), ph = walk.on && T3.pathHead ? T3.pathHead.i + ":" + Math.round(T3.pathHead.x / hq) + ":" + Math.round(T3.pathHead.y / hq) : "";
      if (!pathW || pw > pathW * 1.35 || pw < pathW / 1.35 || ph !== pathKey) { if (!pathW || pw > pathW * 1.35 || pw < pathW / 1.35) pathW = pw; pathKey = ph; buildPath(); }

      // a satellite appears in the sky while one is above the horizon from here
      const t = walk.on ? walk.simT : Date.now() / 1000;
      let sm = null, orb = null, ap = null;
      if (T3.testSat) { sm = [0, T3.testSat.az, T3.testSat.el]; orb = T3.testSat.orbiter; }
      else { ap = DB.passes.find(p => p.samples.length && t >= p.samples[0][0] && t <= p.samples[p.samples.length - 1][0]); if (ap) { sm = sampleAt(ap, t); orb = ap.orbiter; } }
      beam.visible = false;
      if (sm && sm[2] > 1 && ORB[orb]) {
        const far = 70000 * K, dir = skyDir(sm[1], sm[2]), spos = cam.position.clone().addScaledVector(dir, far); T3.satPos = spos; T3.satDir = dir; T3.herePos = here.clone();
        const mdl = sats[orb] || (sats[orb] = makeSat(parseInt(ORB[orb].c.slice(1), 16))); if (!mdl.userData.nofog) { mdl.userData.nofog = true; mdl.traverse(o2 => { if (o2.material) o2.material.fog = false; }); }
        if (mdl.parent !== satHolder) satHolder.add(mdl);
        Object.values(sats).forEach(m2 => { m2.visible = m2 === mdl; });
        mdl.scale.setScalar(SSC); mdl.position.copy(spos); mdl.rotation.y += dtr * 0.12;
        const txt = sm[3] ? `${orb} · ${Math.round(sm[3]).toLocaleString("en-US")} km away` : `${orb} · ${Math.round(sm[2])}°`;
        if (!satLabel || satLabel.userData.text !== txt) { if (satLabel) { satHolder.remove(satLabel); satLabel.material.map.dispose(); } satLabel = labelSprite(txt, ORB[orb].c); satLabel.material.fog = false; satHolder.add(satLabel); }
        satLabel.position.copy(spos); satLabel.position.y += 1100 * K;
        satHolder.visible = true;
        if (ap) {
          const key = ap.orbiter + ap.start;
          if (trailKey !== key) { trailKey = key; trail.geometry.setFromPoints(ap.samples.filter(s2 => s2[2] > 0).map(s2 => skyDir(s2[1], s2[2]).multiplyScalar(far))); trail.material.color.set(ORB[orb].c); }
          trail.material.fog = false; trail.position.copy(cam.position); trail.visible = true;
        } else trail.visible = false;
        if (walking && k.con) { beamG.setFromPoints([here.clone().setY(here.y + 1.8), spos]); beam.material.color.set(ORB[orb].c); beam.visible = true; }
      } else { satHolder.visible = false; trail.visible = false; T3.satPos = null; }
      const showFind = !!T3.satPos; if ($("t3sat").hidden === showFind) $("t3sat").hidden = !showFind;

      // camera: first person through the visor, free, or following from behind at a distance that suits the time rate
      const inRover = S.vehicle === "rover" && walking;
      astro.visible = !T3.fp && !inRover; blob.visible = !T3.fp && !inRover; if (T3.fp || inRover) astroTag.visible = false;
      if (T3.fp) {
        ctl.enabled = false;
        const d = walking ? new THREE.Vector3(k.hdx, 0, -k.hdy) : new THREE.Vector3(Math.sin(astro.rotation.y), 0, Math.cos(astro.rotation.y));
        if (d.lengthSq() > 1e-9) { d.normalize(); if (!T3.fpDir) T3.fpDir = d.clone(); else T3.fpDir.lerp(d, 1 - Math.exp(-dtr * (walking && k.manual ? 14 : 3.5))).normalize(); }
        const L = T3.look, moving = walking && !k.still && !walk.busy;
        if (moving && !T3.looking) L.yaw *= Math.exp(-dtr * 0.8);                // the head drifts back to face the way you walk
        const f = T3.fpDir.clone().applyAxisAngle(UP, L.yaw), right = new THREE.Vector3(-f.z, 0, f.x);
        const bob = moving ? Math.abs(Math.cos(T3.phase)) * 0.05 : 0, sway = moving ? Math.sin(T3.phase) * 0.03 : 0;
        if (inRover) { cam.position.copy(here).addScaledVector(T3.fpDir, 1.3).addScaledVector(right, 0.45); cam.position.y = rover.position.y + 2.15; }   // driver's seat, behind the windscreen
        else { cam.position.copy(here).addScaledVector(right, sway).addScaledVector(f, 0.12); cam.position.y = here.y + 1.68 + jy + bob; }
        ctl.target.copy(cam.position).addScaledVector(f, 3 * Math.cos(L.pitch)); ctl.target.y += 3 * Math.sin(L.pitch);
        if (T3.vr && T3.vr.q) { T3.vrDt = dtr; vrDraw(here, jy); return; }
        vrHud.visible = false; vrRad.visible = false; reticle.visible = false;
        cam.lookAt(ctl.target); cam.rotateZ(-sway * 0.5);
        rn.render(sc, cam);
        return;
      }
      ctl.enabled = true; vrHud.visible = false; vrRad.visible = false; reticle.visible = false;
      if (T3.chase && !T3.drag) {
        const dist = chaseBase() * (T3.chaseK || 1);
        if (walking) { const d = new THREE.Vector3(k.hdx, 0, -k.hdy); if (d.lengthSq() > 1e-9) { d.normalize(); if (!T3.dir) T3.dir = d; else T3.dir.lerp(d, 1 - Math.exp(-dtr * 1.6)).normalize(); } }   // the camera turns gently, not at every bend of the path
        const back = walking ? (T3.dir || new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(-Math.sin(hab.rotation.y + 0.35), 0, -Math.cos(hab.rotation.y + 0.35));   // idle: stand in front of the astronaut, habitat behind
        const want = here.clone().addScaledVector(back, -dist); want.y = here.y + 1.3 + dist * 0.36;
        const gy = ground(Math.min(M.width_m, Math.max(0, want.x + M.width_m / 2)), Math.min(M.height_m, Math.max(0, M.height_m / 2 - want.z))) + 0.7; if (want.y < gy) want.y = gy;
        cam.position.lerp(want, 1 - Math.exp(-dtr * (walking && k.manual ? 5 : 3.2)));
        ctl.target.lerp(here.clone().setY(here.y + 1.45), 1 - Math.exp(-dtr * 9));
      } else if (walking && walk.follow !== false && !T3.drag && !T3.skyLook) ctl.target.lerp(here, 0.05);
      ctl.maxPolarAngle = T3.skyLook ? Math.PI * 0.95 : Math.PI * 0.49;
      if (T3.fly && !T3.chase) {                                              // tour: a smooth camera flight
        const F = T3.fly, k = Math.min(1, (now - F.t0) / F.ms), e2 = k * k * (3 - 2 * k);
        cam.position.lerpVectors(F.p0, F.p1, e2); ctl.target.lerpVectors(F.q0, F.q1, e2); if (k >= 1) T3.fly = null;
      }
      if (T3.tourOrbit && !T3.fly && !T3.drag && !T3.chase && !T3.skyLook) { const o = cam.position.clone().sub(ctl.target); o.applyAxisAngle(UP, T3.tourOrbit * dtr); cam.position.copy(ctl.target).add(o); }
      ctl.update(); rn.render(sc, cam);
    };
    T3.ready = true;
  };
  function setView(v) {
    S.view = v; $("v-2d").setAttribute("aria-pressed", v === "2d"); $("v-3d").setAttribute("aria-pressed", v === "3d");
    $("view3d").hidden = v !== "3d"; $("map").style.visibility = v === "3d" ? "hidden" : "visible"; $("tools3d").hidden = v !== "3d";
    if (v === "3d") { if (!T3.ready) T3.init(); T3.dirty = true; $("t3lite").setAttribute("aria-pressed", String(!T3.lite)); if (walk.on) camWalk(); }
    document.body.classList.toggle("v3d", v === "3d"); document.body.classList.toggle("fp", v === "3d" && T3.cam3 === "fp"); syncJump();
  }
  T3.render = () => {};
  /* Camera: "free" (orbit with the mouse or fingers), "follow" (behind the astronaut) or "fp" (through the visor). */
  T3.cam3 = "free";
  function setCam(m, quiet) {
    const was = T3.cam3; T3.cam3 = m; T3.chase = m === "follow"; T3.fp = m === "fp"; T3.skyLook = false;
    document.querySelectorAll("[data-cam]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cam === m)));
    document.body.classList.toggle("fp", m === "fp" && S.view === "3d"); syncJump();
    if (m === "fp" && was !== "fp") { T3.look = { yaw: 0, pitch: -0.1 }; T3.fpDir = null; T3.api && T3.api.fov(62); }
    if (m !== "fp" && was === "fp") { T3.api && T3.api.fov(42); if (m === "free" && T3.api) T3.api.backOff(); }
    if (m === "fp" && was !== "fp" && !quiet) {
      const slow = walk.on && S.speed > 1; if (slow) { const b1 = document.querySelector('.spd[data-s="1"]'); if (b1) b1.click(); }
      toast("First person", (matchMedia("(pointer: coarse)").matches ? "Drag to look around. Use the stick to walk and the Jump button to jump." : "Drag to look around. W A S D to walk, Space to jump, C to change the camera.") + (slow ? " Time now runs at real speed." : ""), "#8ab8ff");
    }
  }
  function camWalk() { if (S.view === "3d" && T3.cam3 !== "fp") setCam("follow", true); }
  function syncJump() {
    const on = S.view === "3d" && T3.cam3 !== "free" && matchMedia("(pointer: coarse)").matches;
    $("jumpBtn").hidden = !on; document.body.classList.toggle("canjump", on);
  }
  /* ---------- phone VR ---------- */
  const vrCss = document.createElement("style");
  vrCss.textContent = `
    body.vr > *:not(#view3d):not(#vrBar) { display: none !important; }
    body.vr #view3d { position: fixed; inset: 0 !important; width: 100vw !important; height: 100vh !important; height: 100dvh !important; cursor: none; }
    body.vr::after { content: ""; position: fixed; z-index: 5; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: #000; pointer-events: none; }
    .vrbar { position: fixed; z-index: 900; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 12px; padding: 12px; border-radius: 999px; background: rgba(10, 14, 21, 0.94); border: 1px solid #2b3649; }
    .vrbar button { padding: 12px 20px; border-radius: 999px; border: 1px solid #2b3649; background: transparent; color: #fff; font: 600 15px Inter, sans-serif; }
    .vrbar button.x { background: #fc3d21; border-color: #fc3d21; }
    #t3vr svg { width: 18px; height: 18px; margin-right: 6px; }`;
  document.head.appendChild(vrCss);
  {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.id = "t3vr"; b.title = "Phone VR: put the phone in a Cardboard or Gear VR holder";
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v6a2.5 2.5 0 0 1-2.5 2.5h-3l-2-2.5h-3L8.5 17h-3A2.5 2.5 0 0 1 3 14.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="11.5" r="1.6" fill="currentColor"/><circle cx="16" cy="11.5" r="1.6" fill="currentColor"/></svg>VR';
    b.hidden = !matchMedia("(pointer: coarse)").matches; b.onclick = () => vrEnter();
    $("tools3d").appendChild(b);
    const bar = document.createElement("div"); bar.className = "vrbar"; bar.id = "vrBar"; bar.hidden = true;
    bar.innerHTML = '<button type="button" id="vrCenter">Recenter</button><button type="button" class="x" id="vrExit">Exit VR</button>';
    document.body.appendChild(bar);
  }
  const vrQ = new THREE.Quaternion(), vrE = new THREE.Euler(), vrZ = new THREE.Vector3(0, 0, 1), vrQ1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), vrQ2 = new THREE.Quaternion();
  function onOri(e) {                                     // the standard device-orientation to camera conversion (as three.js DeviceOrientationControls)
    if (!T3.vr || e.alpha == null) return;
    const D = Math.PI / 180, orient = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * D;
    vrE.set(e.beta * D, e.alpha * D, -e.gamma * D, "YXZ"); vrQ.setFromEuler(vrE).multiply(vrQ1).multiply(vrQ2.setFromAxisAngle(vrZ, -orient));
    if (!T3.vr.q) T3.vr.q = vrQ.clone(); else T3.vr.q.slerp(vrQ, 0.6);
  }
  async function vrEnter() {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
      await DeviceOrientationEvent.requestPermission().catch(() => "denied");      // iPhone asks here; elsewhere the 2 s check below says if no data comes
    }
    try { await document.documentElement.requestFullscreen({ navigationUI: "hide" }); } catch (e) { /* not allowed here */ }
    try { await screen.orientation.lock("landscape"); } catch (e) { /* turn the phone sideways yourself */ }
    try { T3.wake = navigator.wakeLock ? await navigator.wakeLock.request("screen") : null; } catch (e) { T3.wake = null; }
    if (S.view !== "3d") setView("3d");
    T3.vrLite = T3.lite; if (T3.api) { if (!T3.lite) T3.api.setLite(true); T3.api.vrPixels(true); }
    setCam("fp", true); if (walk.on && S.speed > 1) { const b1 = document.querySelector('.spd[data-s="1"]'); if (b1) b1.click(); }
    T3.vr = { q: null, yaw0: null }; addEventListener("deviceorientation", onOri);
    document.body.classList.add("vr"); T3.dirty = true;
    setTimeout(() => { if (T3.vr && !T3.vr.q) { vrExit(); toast("No gyroscope data", "This browser gave no motion data. Open the page over https (the 8443 server) in Chrome on the phone.", "#F0616B"); } }, 2000);
    if (S.route) guide("VR on", "Put the phone in the headset. In five seconds you start walking. You walk where you look: small head turns steer, and looking further to the side just looks around. Your info card is on your left and your radio is on your right: look at either to pause, look away to walk on.", "#8ab8ff");
    else toast("No route yet", "Plan a route first, then press VR.", "#F5B85B");
    T3.vr.go = setTimeout(() => { if (!T3.vr || !S.route) return; if (!walk.on) startWalk(); takeControl(); if (S.speed > 1) { const b1 = document.querySelector('.spd[data-s="1"]'); if (b1) b1.click(); } }, 5000);
  }
  // tour: VR without a phone, the head moved by a script
  function vrDemo(on) {
    if (!on) { if (T3.vr) { clearInterval(T3.vr.demo); T3.vr = null; T3.vrHead = null; } document.body.classList.remove("vr"); return; }
    setCam("fp", true); const q = new THREE.Quaternion(), e3 = new THREE.Euler(0, 0, 0, "YXZ");
    T3.vr = { q: q.clone(), yaw0: null, head: { yaw: 0, pitch: 0 } }; document.body.classList.add("vr");
    T3.vr.demo = setInterval(() => { if (!T3.vr) return; const h = T3.vr.head; e3.set(h.pitch, h.yaw, 0, "YXZ"); T3.vr.q.setFromEuler(e3); }, 16);
  }
  // the card's gaze buttons
  async function vrAction(id) {
    if (S.sound) chime("MRO");
    if (id === "exit") return vrExit();
    if (id === "r:earth" || id === "r:pod") { setDest(id.slice(2)); return toast(id === "r:earth" ? "Talking to Earth" : "Talking to the habitat", "Quick replies now go there.", "#8ab8ff"); }
    if (id.startsWith("r:q")) { const t = QUICK[+id.slice(3)]; if (t) { queueMsg({ kind: "text", text: t }); if (T3.vr) T3.vr.hudAt = 0; } return; }
    if (!walk.on) return;
    if (id === "sat") return skipToPass();
    if (id === "speed") {                                 // ×1 → ×5 → ×30 → ×1: real time, a brisk look, a quick crossing
      const R = [1, 5, 30]; S.speed = R[(R.indexOf(S.speed) + 1) % R.length] || 1;
      document.querySelectorAll(".spd").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.s === S.speed)));
      return toast(`Time ×${S.speed}`, S.speed === 1 ? "Real time." : `Time runs ${S.speed} times faster.`, "#8ab8ff");
    }
    if (id === "auto") return walk.manual ? releaseControl() : takeControl();
    if (!walk.manual) takeControl();
    if (walk.busy || walk.planning) return;
    const b = [walk.mx + walk.drift[0], walk.my + walk.drift[1]];
    if (id === "home") { walk.rest = [HAB]; return reroute(b, [HAB], "", "#8ab8ff", { title: "Heading home", lead: "New route straight back to the habitat." }); }
    if (id === "half") {
      const r = walk.route, i0 = Math.min(Math.max(0, walk.ri | 0), r.d.length - 1), goal = r.d[i0] + (r.d.at(-1) - r.d[i0]) / 2;
      let j = i0; while (j < r.d.length - 1 && r.d[j] < goal) j++;
      const k = r.stop_idx.slice(1).filter(i => i > i0 && i <= j).length;            // waypoints you jump past count as visited
      for (let n = 0; n < k && walk.rest.length > 1; n++) walk.rest.shift();
      const dt = Math.max(0, r.t[j] - r.t[i0]), dist = r.d[j] - r.d[i0];
      if (![r.x[j], r.y[j], r.t[j], r.t[i0]].every(Number.isFinite)) return;
      walk.mx = r.x[j] - walk.drift[0]; walk.my = r.y[j] - walk.drift[1]; walk.simT += dt; walk.dose += (r.dose_msv / (r.time_s || 1)) * dt; walk.ri = j;
      T3.dirty = true;
      return reroute([r.x[j], r.y[j]], walk.rest, "", "#8ab8ff", { title: "Teleported halfway", lead: `You skipped ${wKm(dist)} and about ${wDur(dt)} of walking.` });
    }
  }
  function vrExit() {
    if (!T3.vr) return;
    removeEventListener("deviceorientation", onOri); clearTimeout(T3.vr.go); T3.vr = null; T3.vrHead = null; document.body.classList.remove("vr"); $("vrBar").hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { screen.orientation.unlock(); } catch (e) { /* fine */ }
    if (T3.wake) { T3.wake.release().catch(() => {}); T3.wake = null; }
    if (T3.api) { T3.api.vrPixels(false); if (!T3.vrLite) T3.api.setLite(false); }
    T3.dirty = true;
  }
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && T3.vr && T3.vr.q) vrExit(); });
  $("view3d").addEventListener("pointerdown", () => { if (!T3.vr) return; const bar = $("vrBar"); bar.hidden = false; clearTimeout(bar.t); bar.t = setTimeout(() => { bar.hidden = true; }, 4000); });
  $("vrExit").onclick = vrExit;
  $("vrCenter").onclick = () => { if (T3.vr) T3.vr.yaw0 = null; $("vrBar").hidden = true; };
  // a standing jump in Mars gravity (3.71 m/s2): about 40 cm up and nearly a second in the air
  function jump() { if (S.view !== "3d" || T3.jmp || MODE === "plan" || (S.vehicle === "rover" && walk.on)) return; T3.jmp = { t: 0 }; }
  T3.vrTest = { enter: () => vrEnter(), exit: () => vrExit() };

  /* ---------- controls ---------- */
  $("v-2d").onclick = () => setView("2d"); $("v-3d").onclick = () => setView("3d");
  document.querySelectorAll("[data-cam]").forEach(b => b.onclick = () => { setCam(b.dataset.cam); b.blur(); });
  $("jumpBtn").addEventListener("pointerdown", e => { e.preventDefault(); jump(); });
  { let l0 = innerWidth < 900; try { const v0 = localStorage.getItem("mw_lite"); if (v0 !== null) l0 = v0 === "1"; } catch (e) { /* private mode */ } $("t3lite").setAttribute("aria-pressed", String(!l0)); }
  $("t3lite").onclick = e => {                                  // lives in Layers: it is a setting, not something you press while walking
    const hi = e.currentTarget.getAttribute("aria-pressed") !== "true";
    if (T3.api) T3.api.setLite(!hi); else { try { localStorage.setItem("mw_lite", hi ? "0" : "1"); } catch (e2) { /* private mode */ } }
    e.currentTarget.setAttribute("aria-pressed", String(hi));
  };
  $("t3sat").onclick = () => T3.api && T3.api.lookSat();
  $("t3top").onclick = () => T3.api && T3.api.top();
  $("t3reset").onclick = () => T3.api && T3.api.reset();
  for (const k of ["slope", "radiation", "comms", "shadow", "cold"]) {
    const el = $("w-" + k), o = $("o-" + k), show = () => o.textContent = (+el.value * 100).toFixed(0) + "%"; show();
    el.oninput = () => { S.weights[k] = +el.value; show(); markCustom(); if (!walk.on) plan(250); if (S.layers.has("cost")) syncLayers(); };
  }
  $("maxslope").oninput = e => { S.maxSlope = +e.target.value; $("o-maxslope").textContent = S.maxSlope + "°"; markCustom(); if (!walk.on) plan(250); };
  // route styles: one tap sets all the weights
  const STYLES = {
    safe: { w: { slope: 1, radiation: 0.3, comms: 0.3, shadow: 0.2, cold: 0.2 }, max: 18, hint: "Stays on flat green ground and detours round anything steeper, even when that makes the walk much longer. Goes onto amber only if there is no other way." },
    balanced: { w: { slope: 0.4, radiation: 0.3, comms: 0.3, shadow: 0.2, cold: 0.2 }, max: 22, hint: "Takes a moderate slope when it saves a lot of walking, but still avoids anything steep." },
    fast: { w: { slope: 0.08, radiation: 0.3, comms: 0.3, shadow: 0.2, cold: 0.2 }, max: 25, hint: "Shortest way. Expect slopes up to 25° and more risk of a fall." },
  };
  function markCustom() { S.style = "custom"; document.querySelectorAll(".style").forEach(b => b.setAttribute("aria-pressed", "false")); $("styleHint").textContent = "Custom settings."; }
  function applyStyle(id, replan = true) {
    const st = STYLES[id]; S.style = id; S.weights = { ...st.w }; S.maxSlope = st.max;
    for (const k of Object.keys(st.w)) { $("w-" + k).value = st.w[k]; $("o-" + k).textContent = Math.round(st.w[k] * 100) + "%"; }
    $("maxslope").value = st.max; $("o-maxslope").textContent = st.max + "°";
    document.querySelectorAll(".style").forEach(b => b.setAttribute("aria-pressed", b.dataset.s === id));
    $("styleHint").textContent = st.hint;
    if (S.layers.has("cost")) syncLayers();
    if (replan && !walk.on) plan(0);
    else if (replan && walk.on && !walk.busy && !walk.planning) {
      const r = walk.route, w = T3.walker, from = w && w.bx != null ? [w.bx, w.by] : null; if (!from) return;
      const rest = walk.manual ? walk.rest : (() => { const q = posOn(r, walk.simT - walk.t0), k = r.stop_idx.slice(1).filter(i => i <= q.i).length; return r.stopsReq.slice(1 + k); })();
      const oldRem = walk.manual ? r.d.at(-1) - r.d[Math.min(walk.ri, r.d.length - 1)] : r.d.at(-1) - posOn(r, walk.simT - walk.t0).d;
      if (rest.length) reroute(from, rest, "", "#8ab8ff", { title: `Switched to ${POLICY()}`, lead: `Planned again from your ${walk.lock === "fix" ? "satellite-fixed" : "estimated"} position.`, oldRem });
    }
  }
  document.querySelectorAll(".style").forEach(b => b.onclick = () => applyStyle(b.dataset.s));
  function setVehicle(v, replan = true) {
    S.vehicle = v === "rover" ? "rover" : "foot"; document.body.classList.toggle("veh-rover", S.vehicle === "rover");
    document.querySelectorAll(".veh").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === S.vehicle)));
    $("vehHint").textContent = S.vehicle === "rover" ? "The crew ride in a pressurised rover at about 10 km/h on flat ground, on slopes up to 20° (assumed), and suit up through the suitports at each stop." : "Two astronauts walk in suits at about 2 to 4 km/h, on slopes up to the policy's limit.";
    T3.dirty = true; if (replan && !walk.on) plan(0);
  }
  document.querySelectorAll(".veh").forEach(b => b.onclick = () => setVehicle(b.dataset.v));
  setVehicle(new URLSearchParams(location.search).get("vehicle") === "rover" ? "rover" : "foot", false);
  function setDepart(min) {
    S.departOff = Math.max(0, Math.min(1440, min)); $("depart").value = S.departOff;
    $("departTxt").textContent = S.departOff === 0 ? "Departure: now" : `Departure in ${fDur(S.departOff * 60)}`;
    $("o-depart").textContent = `${fUTC(departT())} UTC`;
    plan(200); if (S.layers.size) syncLayers();
  }
  $("depart").oninput = e => setDepart(+e.target.value);
  $("departNow").onclick = () => setDepart(0);
  $("departBest").onclick = () => {
    // scan the next 24 h: most relay minutes during the EVA, all of it in daylight
    const T = S.route ? S.route.time_s : 4 * 3600; let best = null;
    for (let m = 0; m <= 1440; m += 10) {
      const a = S.now0 + m * 60, b = a + T; let day = true;
      for (let t = a; t <= b; t += 900) if (sunAt(t).el < 8) { day = false; break; }
      if (!day) continue;
      let min = 0; for (const p of DB.passes) for (const s of p.samples) if (s[0] >= a && s[0] <= b && s[2] >= M.min_el) min++;
      if (!best || min > best.min) best = { m, min };
    }
    if (!best) return toast("No daylight window", "The EVA does not fit in daylight in the next 24 h.", "#F0616B");
    setDepart(best.m); toast("Best departure", `${fUTC(S.now0 + best.m * 60)} UTC: ${best.min} relay minutes in daylight.`, "#6EE7A8");
  };
  $("roundTrip").onclick = e => { S.roundTrip = !S.roundTrip; e.target.setAttribute("aria-pressed", S.roundTrip); if (!walk.on) plan(); };
  $("clearStops").onclick = () => { if (!walk.on) { S.stops = []; plan(); } };
  document.querySelectorAll(".base").forEach(b => b.onclick = () => { S.base = b.dataset.b; document.querySelectorAll(".base").forEach(x => x.setAttribute("aria-pressed", x === b)); syncLayers(); });
  document.querySelectorAll(".lay[data-l]").forEach(b => b.onclick = () => { const n = b.dataset.l; S.layers.has(n) ? S.layers.delete(n) : S.layers.add(n); b.setAttribute("aria-pressed", S.layers.has(n)); syncLayers(); });
  $("o-op").textContent = "80%";
  $("opacity").oninput = e => { S.opacity = +e.target.value; $("o-op").textContent = Math.round(S.opacity * 100) + "%"; syncLayers(); };
  { const spds = [...document.querySelectorAll(".spd")], setSpeed = b => { S.speed = +b.dataset.s; spds.forEach(x => x.setAttribute("aria-pressed", x === b)); };
    spds.forEach((b, i) => b.onclick = () => setSpeed(b.getAttribute("aria-pressed") === "true" && matchMedia("(max-width: 980px)").matches ? spds[(i + 1) % spds.length] : b)); }
  const tog = (id, key, fn) => $(id).onclick = e => { S[key] = !S[key]; e.target.setAttribute("aria-pressed", S[key]); fn && fn(); };
  tog("sound", "sound", () => { if (S.sound) { audio().resume(); chime("MRO"); } });
  tog("doppler", "doppler", () => { if (S.doppler) audio().resume(); });
  tog("truth", "truth", () => { if (walk.on) S.truth ? ghost.addTo(map) : map.removeLayer(ghost); });
  $("t3drive").onclick = () => walk.on && walk.manual ? releaseControl() : takeControl();
  $("skipPass").onclick = skipToPass;
  { const hint = $("hint"), bye = () => { hint.hidden = true; try { localStorage.setItem("mw_hint", "1"); } catch (e) { /* private mode */ } };
    let seen = false; try { seen = localStorage.getItem("mw_hint") === "1"; } catch (e) { /* private mode */ }
    hint.hidden = seen; $("walkBtn").addEventListener("click", bye); $("map").addEventListener("pointerdown", bye); $("view3d").addEventListener("pointerdown", bye); }
  $("walkBtn").onclick = () => walk.on ? endWalk() : MODE === "plan" ? null : startWalk();
  $("homeBtn").onclick = () => { if (!walk.on) return; const p = posOn(walk.route, walk.simT - walk.t0); reroute([p.x, p.y], [HAB], "Abort: shortest safe way back to the habitat."); };
  map.on("dragstart", () => walk.follow = false);
  addEventListener("resize", () => { drawTimeline(); drawProfile(); });
  setInterval(async () => { try { DB = await J("/api/passes?hours=50"); } catch (e) { /* keep old */ } loadNext(); }, 300000);
  $("notify").onclick = async e => {
    if (!window.Notification) return toast("Not supported", "This browser has no desktop notifications.", "#F0616B");
    S.notify = !S.notify && (await Notification.requestPermission()) === "granted";
    e.target.setAttribute("aria-pressed", !!S.notify);
    if (S.notify) notify("Marswalk alerts on", "You will be told 10 minutes before each pass and when it rises.");
  };

  /* ---------- radio messages: voice and text, relayed only while an orbiter is overhead ---------- */
  const COM = { dest: "earth", q: [], srv: new Map(), off: 0, cfg: null, rec: null, busy: new Set(), last: 0, polled: 0, lid: 0,
    mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext) };
  const QUICK = ["Sample collected", "Terrain is steep, slowing down", "All good, continuing", "Need help"];
  const comTime = () => walk.on ? walk.simT : Date.now() / 1000;                // the walker's clock (simulated during a walk)
  const mmss = s => { s = Math.max(0, Math.round(s)); return s >= 3600 ? fCD(s) : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
  window.MW = { COM, S, walk, T3, tick };                                                  // debug handle: MW.COM.force = {orbiter, end} holds the link open for testing
  const HABLK = { orbiter: "Habitat link", hab: true, end: Infinity };
  const linkFor = dest => dest === "pod" && habNow().ok ? HABLK : linkNow();     // messages to the habitat go straight over its own radio when the mast can see you
  const orbC = n => (ORB[n] || { c: "#6EE7A8" }).c;
  function linkNow() {                                                          // is a relay orbiter overhead right now?
    if (COM.practice) return { orbiter: "MRO", end: comTime() + 1800, practice: true };   // practice mode: the link is always open
    if (COM.force) return COM.force;
    if (walk.on) return walk.link || null;
    const t = Date.now() / 1000, q = (NXT.passes || []).find(p => p.vis_start && p.vis_start <= t && t < p.vis_end);
    return q ? { orbiter: q.orbiter, end: q.vis_end } : null;
  }
  function nextPassText() {
    const t = comTime(), p = (walk.on ? DB.passes : NXT.passes).find(q => q.start > t);
    return p ? `next: ${p.orbiter} in ${mmss(p.start - t)}` : "no pass in view";
  }
  function blip(force) {
    if (!S.sound && !force) return;
    const a = audio(), t = a.currentTime;
    [900, 600].forEach((f, i) => { const o = a.createOscillator(), g = a.createGain(), at = t + i * 0.09; o.type = "square"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.06, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
      o.connect(g).connect(a.destination); o.start(at); o.stop(at + 0.09); });
  }
  function queueMsg(m) {
    m.lid = ++COM.lid; m.to = COM.dest; m.status = "queued"; COM.q.push(m);
    if (!linkFor(m.to)) toast("Message queued", m.to === "pod" ? `The habitat is hidden by terrain and no satellite is overhead. It leaves when either link returns (${nextPassText().replace("next: ", "")}).` : `No relay orbiter overhead. It leaves on the next pass (${nextPassText().replace("next: ", "")}).`, "#93B7E6");
    commsTick(true);
  }
  async function uplink(m, lk) {
    m.status = "sending";
    try {
      const r = await fetch("/api/comms/send", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "astronaut", to: m.to, kind: m.kind, text: m.text || "", audio_b64: m.audio_b64 || null, mime: m.mime, via: lk.orbiter, speed: S.speed, secs: m.secs || null }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.detail || r.statusText);
      COM.q = COM.q.filter(x => x !== m); COM.srv.set(j.id, j); blip();
      toast(lk.hab ? "Sent to the habitat" : `Uplinked via ${lk.orbiter}`, m.to === "earth" ? `On its way to Earth: ${mmss(j.light_min * 60)} of light time (×${S.speed}).` : lk.hab ? "Straight over the habitat radio link. No satellite needed." : "Relayed to the habitat.", orbC(lk.orbiter));
    } catch (e) { m.status = "queued"; toast("Send failed", e.message, "#F0616B"); }
    renderMsgs();
  }
  async function pollComms() {
    try {
      const j = await (await fetch(`/api/comms/inbox?role=astronaut&speed=${S.speed}`)).json();
      COM.off = j.now - Date.now() / 1000; COM.cfg = j.config;
      for (const m of j.messages) COM.srv.set(m.id, { ...COM.srv.get(m.id), ...m });
    } catch (e) { /* server busy: keep what we have */ }
  }
  function playMsg(v) {
    if (v.has_audio) { const a = new Audio(`/api/comms/audio/${v.id}?role=astronaut`); a.play().catch(() => { /* needs a tap first */ }); }
    else if (v.text && window.speechSynthesis) { const u = new SpeechSynthesisUtterance(v.text); u.rate = 0.95; speechSynthesis.speak(u); }
  }
  async function deliverIncoming(m) {
    if (COM.busy.has(m.id)) return; COM.busy.add(m.id);
    try {
      const r = await fetch(`/api/comms/deliver/${m.id}`, { method: "POST" }); if (!r.ok) return;
      const v = await r.json(); COM.srv.set(v.id, { ...COM.srv.get(v.id), ...v }); blip();
      toast(`Message from ${v.sender === "earth" ? "Earth" : "the habitat"}`, v.text || "Voice message", "#6EE7A8"); playMsg(v);
    } finally { COM.busy.delete(m.id); renderMsgs(); }
  }
  function commsTick(force) {
    const now = performance.now(); if (!force && now - COM.last < 1000) return; COM.last = now;
    const lk = linkNow(), hb = habNow().ok, was = COM.wasOpen; COM.wasOpen = !!lk;
    if (lk && !was) {                                                           // a relay orbiter just came over: beep, buzz, open the mic
      if (!S.sound) chime(lk.orbiter, true, true);
      if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate([220, 110, 220]);
      if (!walk.on) toast(`${lk.orbiter} is overhead`, COM.mic ? "Link to Earth open. Hold the talk button in Radio to send a voice message." : "Link to Earth open: queued messages are going now.", orbC(lk.orbiter));   // during a walk the guide says it
      COM.wasOrb = lk.orbiter;
    }
    if (!lk && was) { if (!linkFor(COM.dest)) closeMic();
      const np = walk.on ? DB.passes.find(q => q.start > walk.simT) : null;
      if (walk.on) guide(`${COM.wasOrb || "The satellite"} has set`, `${COM.wasOrb || "The satellite"} has gone below the horizon. From here your suit estimates your position again, and the error grows by about 2 m for every 100 m you walk.${np ? ` Next satellite: ${np.orbiter} in ${wDur(np.start - walk.simT)}.` : ""}`, "#93B7E6");
      else toast("Satellite has set", "Messages to Earth now wait for the next pass.", "#93B7E6"); }
    COM.q.filter(x => x.status === "queued").forEach(m => { const l = m.to === "pod" && hb ? HABLK : lk; if (l) uplink(m, l); });      // leave as soon as a link is there
    [...COM.srv.values()].filter(m => m.to === "astronaut" && !m.delivered && Date.now() / 1000 + COM.off >= m.arrive && (lk || (hb && m.sender === "pod"))).forEach(deliverIncoming);   // replies come down
    if (now - COM.polled > 2000) { COM.polled = now; pollComms(); }
    renderMsgs(lk);
  }
  /* ---------- walkie-talkie: the mic only opens while a relay orbiter is overhead ---------- */
  COM.ptt = { stream: null, mr: null, chunks: [], t0: 0, t: 0 };
  const blobB64 = blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
  async function openMic() {
    if (!COM.mic || COM.ptt.stream) return;
    try { COM.ptt.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); COM.ptt.denied = false; }
    catch (e) { COM.ptt.denied = true; toast("Microphone blocked", "Allow the microphone for this page, then hold the talk button.", "#F0616B"); }
    if (COM.ptt.stream && !linkFor(COM.dest)) closeMic();                              // the link closed while the permission box was open
    renderTalk();
  }
  function closeMic() {
    if (COM.ptt.mr && COM.ptt.mr.state === "recording") COM.ptt.mr.stop();
    if (COM.ptt.stream) { COM.ptt.stream.getTracks().forEach(t => t.stop()); COM.ptt.stream = null; }
    renderTalk();
  }
  async function pttDown(e) {
    if (e && e.cancelable) e.preventDefault();
    if (!linkFor(COM.dest) || COM.ptt.mr) return;
    COM.ptt.held = true;
    if (!COM.ptt.stream) { await openMic(); if (COM.ptt.stream && !COM.ptt.held) return toast("Microphone ready", "Now hold the talk button and speak.", "#6EE7A8"); }
    if (!COM.ptt.stream || COM.ptt.mr) return;
    const mr = new MediaRecorder(COM.ptt.stream); COM.ptt.mr = mr; COM.ptt.chunks = []; COM.ptt.t0 = Date.now();
    mr.ondataavailable = ev => COM.ptt.chunks.push(ev.data);
    mr.onstop = async () => {
      const secs = (Date.now() - COM.ptt.t0) / 1000, blob = new Blob(COM.ptt.chunks, { type: mr.mimeType || "audio/webm" });
      COM.ptt.mr = null; clearTimeout(COM.ptt.t); renderTalk();
      if (secs < 0.4) return toast("Too short", "Hold the button the whole time you talk.", "#F5B85B");
      if (blob.size > 1.4e6) return toast("Too long", "Keep it under about 30 seconds.", "#F0616B");
      queueMsg({ kind: "voice", audio_b64: await blobB64(blob), mime: blob.type, secs });       // link is open, so this leaves at once
    };
    mr.start(); blip(true); renderTalk();
    COM.ptt.t = setTimeout(() => mr.state === "recording" && mr.stop(), 30000);
  }
  function pttUp() { COM.ptt.held = false; if (COM.ptt.mr && COM.ptt.mr.state === "recording") COM.ptt.mr.stop(); }
  function renderTalk() {
    const b = $("talkBtn"), lk = linkFor(COM.dest), rec = !!(COM.ptt.mr && COM.ptt.mr.state === "recording"), dest = COM.dest === "earth" ? "Earth" : "the habitat";
    b.classList.toggle("ready", !!lk && !rec && COM.mic); b.classList.toggle("live", rec);
    if (!COM.mic) { b.disabled = true; $("talkMain").textContent = "Mic unavailable"; $("talkSub").textContent = "Needs https or localhost (see below)"; return; }
    b.disabled = !lk;
    $("talkMain").textContent = rec ? "Release to send" : lk ? "Hold to transmit" : "Link closed";
    $("talkSub").textContent = rec ? `Sending to ${dest} via ${lk ? lk.orbiter : "the orbiter"}` : lk ? (lk.hab ? `Habitat link · ${fKm(habNow().d)} away · direct radio` : `${lk.orbiter} overhead · ${fDur(lk.end - comTime())} left`) : COM.dest === "pod" ? `Habitat hidden by terrain · ${nextPassText()}` : `No relay orbiter overhead · ${nextPassText()}`;
    renderDock(lk, rec);
  }
  /* ---------- the radio dock: the Radio tab's links and talk button, on screen while you walk in 3D ---------- */
  function renderDock(lk, rec) {
    const d = $("radioDock"), on = walk.on && S.view === "3d" && !T3.vr && !document.body.classList.contains("ex-picking");
    d.hidden = !on; if (!on) return;
    const hb = habNow(), sat = linkNow(), c = COM.cfg, lm = c ? c.effective_min : null;
    const row = (el, ok, name, txt) => { el.className = ok ? "ok" : "no"; el.innerHTML = `<i></i><b>${name}</b><span>${txt}</span>`; };
    row($("rdHab"), hb.ok, "Habitat", hb.ok ? `direct radio · ${fKm(hb.d)}` : "hidden by terrain");
    row($("rdSat"), !!sat, "Relay", sat ? `${sat.orbiter} · ${fDur(sat.end - comTime())} left` : nextPassText().replace("next: ", "next "));
    row($("rdEarth"), !!sat, "Earth", sat ? `via ${sat.orbiter}${lm ? ` · ${lm.toFixed(1)} light-min` : ""}` : "waits for a relay pass");
    document.querySelectorAll("[data-rd]").forEach(b => b.setAttribute("aria-pressed", b.dataset.rd === COM.dest));
    const t = $("rdTalk"), dest = COM.dest === "earth" ? "Earth" : "the habitat";
    t.classList.toggle("ready", !!lk && !rec && COM.mic); t.classList.toggle("live", rec); t.disabled = !COM.mic || !lk;
    $("rdMain").textContent = !COM.mic ? "Mic unavailable" : rec ? "Release to send" : lk ? `Hold to talk to ${dest}` : "Link closed";
    $("rdSub").textContent = !COM.mic ? "Use the quick messages" : rec ? `via ${lk ? (lk.hab ? "the habitat mast" : lk.orbiter) : "the orbiter"}` : lk ? (lk.hab ? "straight over the habitat mast" : COM.dest === "earth" && lm ? `arrives in ${lm.toFixed(1)} min` : `via ${lk.orbiter}`) : COM.dest === "earth" && hb.ok ? "switch to Habitat to talk now" : "messages queue until a link opens";
    const nowS = Date.now() / 1000 + COM.off, pend = COM.q.length + [...COM.srv.values()].filter(m => m.to === "astronaut" ? !m.delivered : m.status === "in_flight" && m.arrive > nowS).length;
    $("rdBadge").hidden = !pend; $("rdBadge").textContent = pend;
  }
  const setDest = d => { COM.dest = d; document.querySelectorAll(".dest").forEach(x => x.setAttribute("aria-pressed", x.dataset.d === d)); renderMsgs(); };
  document.querySelectorAll("[data-rd]").forEach(b => b.onclick = () => setDest(b.dataset.rd));
  $("rdQuick").innerHTML = QUICK.slice(0, 3).map(t => `<button type="button">${t}</button>`).join("");
  $("rdQuick").addEventListener("click", e => { const b = e.target.closest("button"); if (b) queueMsg({ kind: "text", text: b.textContent }); });
  $("rdOpen").onclick = () => { if (!mq.matches) showPanel(true); openSheet("relay"); setTimeout(() => $("radio").scrollIntoView({ block: "start", behavior: "smooth" }), 250); };
  { const t = $("rdTalk"); t.addEventListener("pointerdown", pttDown); ["pointerup", "pointercancel", "pointerleave"].forEach(ev => t.addEventListener(ev, pttUp)); t.addEventListener("contextmenu", e => e.preventDefault()); }
  const talk = $("talkBtn");
  talk.addEventListener("pointerdown", pttDown);
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => talk.addEventListener(ev, pttUp));
  talk.addEventListener("contextmenu", e => e.preventDefault());
  // keys: T talk (hold), Space jump, C camera, M panel
  addEventListener("keydown", e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(input|textarea|select)$/i.test(document.activeElement.tagName)) return;
    if (e.code === "KeyT" && !e.repeat) { e.preventDefault(); pttDown(); }
    else if (e.code === "KeyM" && !e.repeat) togglePanel();
    else if (e.code === "KeyC" && !e.repeat && S.view === "3d" && MODE !== "plan") { const o = ["free", "follow", "fp"]; setCam(o[(o.indexOf(T3.cam3) + 1) % 3]); }
    else if (e.code === "Space" && S.view === "3d") { e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); if (!e.repeat) jump(); }
  });
  addEventListener("keyup", e => { if (e.code === "KeyT") pttUp(); });

  const msgLabel = m => m.kind === "voice" ? `Voice message${m.secs ? ` (${Math.round(m.secs)} s)` : ""}` : (m.text || "");
  function renderMsgs(lk = linkNow()) {
    const nowS = Date.now() / 1000 + COM.off, who = r => r === "earth" ? "Earth" : r === "pod" ? "the habitat" : "you";
    const bar = $("linkBar"); bar.className = "linkbar " + (lk ? "open" : "closed");
    bar.innerHTML = lk ? `<i class="dot" style="background:${orbC(lk.orbiter)}"></i><b>${lk.orbiter} overhead</b><span>${lk.practice ? "Test link" : `Link open · ${fDur(lk.end - comTime())} left`}</span>`
      : `<i class="dot"></i><b>Link closed</b><span>${nextPassText()}</span>`;
    const c = COM.cfg;
    if (COM.dest === "pod") $("delayNote").textContent = "Direct radio to the habitat mast: instant, and always on while the ground does not block the line. If it is blocked, the message goes up through the next satellite.";
    else if (c) $("delayNote").textContent = `Earth is ${c.effective_min.toFixed(1)} light-minutes away (${c.override_min ? "demo setting" : c.source}). At ×${S.speed} the trip takes ${Math.max(1, Math.round(c.effective_min * 60 / S.speed))} s.`;
    $("delayDemo").setAttribute("aria-pressed", !!(c && c.override_min));
    const rows = COM.q.map(m => `<div class="msg out wait"><b>You to ${who(m.to)}</b><span>${msgLabel(m)}</span><em>${m.to === "pod" ? "Waiting for the habitat link or a satellite" : "Waiting for a relay pass"} · ${nextPassText()}</em><button type="button" data-cancel="${m.lid}" title="Cancel">×</button></div>`);
    [...COM.srv.values()].sort((a, b) => b.id - a.id).forEach(m => {
      const rem = Math.max(0, m.arrive - nowS), left = `${mmss(rem * m.speed)} of light time left (${Math.ceil(rem)} s real)`;
      if (m.sender === "astronaut") rows.push(`<div class="msg out ${m.status === "in_flight" ? "fly" : "ok"}"><b>You to ${who(m.to)}${m.via ? ` via ${m.via}` : ""}</b><span>${msgLabel(m)}</span><em>${m.status === "in_flight" ? "On its way · " + left : "✓ Arrived"}</em></div>`);
      else {
        const st = m.delivered ? "delivered" : nowS >= m.arrive ? "at_orbiter" : "in_flight";
        rows.push(`<div class="msg in ${st}"><b>From ${who(m.sender)}</b><span>${st === "delivered" ? msgLabel(m) : "Incoming message"}</span><em>${st === "in_flight" ? "Reply in flight to Mars orbit · " + left : st === "at_orbiter" ? "Waiting at the orbiter. It comes down on the next pass · " + nextPassText() : "✓ Received"}</em>${st === "delivered" ? `<button type="button" data-play="${m.id}" title="Play again">▶</button>` : ""}</div>`);
      }
    });
    renderTalk();
    $("msgs").innerHTML = rows.join("") || `<p class="hint">Messages to the habitat go straight over its radio link. Messages to Earth leave when a relay orbiter is overhead, and replies wait at the orbiter until your next pass.</p>`;
  }
  $("msgs").addEventListener("click", e => {
    const x = e.target.closest("[data-cancel]"), p = e.target.closest("[data-play]");
    if (x) { COM.q = COM.q.filter(m => m.lid !== +x.dataset.cancel); renderMsgs(); }
    if (p) { const v = COM.srv.get(+p.dataset.play); if (v) playMsg(v); }
  });
  $("quick").innerHTML = QUICK.map(t => `<button type="button" class="chip">${t}</button>`).join("");
  $("quick").addEventListener("click", e => { const b = e.target.closest("button"); if (b) queueMsg({ kind: "text", text: b.textContent }); });
  const sendTyped = () => { const t = $("msgText").value.trim(); if (!t) return; $("msgText").value = ""; queueMsg({ kind: "text", text: t }); };
  $("msgSend").onclick = sendTyped; $("msgText").addEventListener("keydown", e => { if (e.key === "Enter") sendTyped(); });
  document.querySelectorAll(".dest").forEach(b => b.onclick = () => setDest(b.dataset.d));
  $("practice").onclick = e => {
    COM.practice = !COM.practice; e.currentTarget.setAttribute("aria-pressed", COM.practice); $("practiceNote").hidden = !COM.practice;
    audio().resume(); commsTick(true);
  };
  $("delayDemo").onclick = async () => {
    const on = !(COM.cfg && COM.cfg.override_min);
    try { COM.cfg = await (await fetch("/api/comms/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ override_min: on ? 7 : null, set_override: true }) })).json(); } catch (e) { /* ignore */ }
    renderMsgs();
  };
  if (!COM.mic) {
    $("recBtn").hidden = true; $("micNote").hidden = false;
    $("micNote").textContent = window.isSecureContext ? "This browser cannot record audio. Use the quick buttons or type a message: it is read aloud on arrival."
      : "The microphone only works over https. Open this page at https://" + location.hostname + ":8443 (accept the one-time warning), or use the quick buttons and typed messages meanwhile.";
  }
  $("recBtn").onclick = async () => {
    if (COM.rec) { COM.rec.stop(); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return toast("Microphone blocked", "Allow the microphone for this page to record.", "#F0616B"); }
    const mr = new MediaRecorder(stream), chunks = [], t0 = Date.now();
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); clearTimeout(COM.recT); COM.rec = null; $("recBtn").classList.remove("on"); $("recBtn").textContent = "Record, send on next pass";
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      if (blob.size > 1.4e6) return toast("Too long", "Keep voice messages under about 30 seconds.", "#F0616B");
      const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
      queueMsg({ kind: "voice", audio_b64: b64, mime: blob.type, secs: (Date.now() - t0) / 1000 });
    };
    mr.start(); COM.rec = mr; $("recBtn").classList.add("on"); $("recBtn").textContent = "Stop and queue"; COM.recT = setTimeout(() => mr.state === "recording" && mr.stop(), 30000);
  };
  renderMsgs();

  /* ---------- phone layout ---------- */
  const mq = matchMedia("(max-width: 980px)");
  const sheet = { cur: "" };
  function openSheet(p) {
    if (!p && !mq.matches) p = sheet.cur || "mission";                        // on desktop one tab is always showing
    sheet.cur = p || ""; document.body.dataset.sheet = sheet.cur;
    document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-pressed", b.dataset.p === sheet.cur));
    if (p) requestAnimationFrame(() => { drawTimeline(); drawProfile(); });
  }
  function closeSheet() { openSheet(""); }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => openSheet(mq.matches && sheet.cur === b.dataset.p ? "" : b.dataset.p));
  document.querySelectorAll(".grab").forEach(g => g.onclick = closeSheet);
  $("fab").onclick = () => $("walkBtn").click();
  function layoutPhone() { if (mq.matches) closeSheet(); else openSheet(sheet.cur || "mission"); syncPanelTog(); syncJump(); map.invalidateSize(); drawTimeline(); drawProfile(); }
  mq.addEventListener("change", layoutPhone);
  if ($("tlDetails")) $("tlDetails").addEventListener("toggle", () => requestAnimationFrame(drawTimeline));
  $("tbNow").onclick = () => $("departNow").click(); $("tbBest").onclick = () => $("departBest").click();
  // Desktop: the panel docks on the left and hides itself while a walk plays. Phone: during a walk the tab bar hides too.
  const UI = { autoHid: false };
  function showPanel(open) { document.body.classList.toggle("nopanel", !open); syncPanelTog(); setTimeout(() => { map.invalidateSize(); T3.dirty = true; drawTimeline(); drawProfile(); }, 0); }
  function syncPanelTog() { const on = mq.matches ? document.body.classList.contains("showui") : !document.body.classList.contains("nopanel"); $("panelTog").setAttribute("aria-pressed", String(on)); $("panelTog").title = (on ? "Hide" : "Show") + " the panel (M)"; }
  function togglePanel() {
    UI.autoHid = false;
    if (!mq.matches) return showPanel(document.body.classList.contains("nopanel"));
    if (!walk.on) return;
    const on = !document.body.classList.contains("showui"); document.body.classList.toggle("showui", on); if (!on) closeSheet(); syncPanelTog();
  }
  $("panelTog").onclick = togglePanel;
  $("zin").onclick = () => S.view === "3d" ? T3.api && T3.api.zoom(0.75) : map.zoomIn(0.5);
  $("zout").onclick = () => S.view === "3d" ? T3.api && T3.api.zoom(1.33) : map.zoomOut(0.5);
  $("zhome").onclick = () => S.view === "3d" ? T3.api && T3.api.reset() : (SITE === "jezero" ? map.setView(ll(HAB[0] - 1800, HAB[1] + 900), -2.5) : map.fitBounds(bounds, { padding: [-120, -120] }));
  const coach = $("coach");
  function dismissCoach() { coach.hidden = true; try { localStorage.setItem("mw_coach", "1"); } catch (e) { /* private mode */ } }
  $("coachOk").onclick = dismissCoach;
  try { coach.hidden = !!localStorage.getItem("mw_coach") || SITE !== "jezero"; } catch (e) { coach.hidden = false; }
  if (mq.matches) $("stopHint").textContent = "Select a point on the map to add a waypoint. Drag a marker to move it.";

  applyStyle("safe", false);
  layoutPhone();
  setDepart(0); syncLayers(); drawRelay();
  requestAnimationFrame(tick);

  /* ---------- the two ways in: Plan a trip / Experience Mars ---------- */
  {
    // the route travels with you: Plan -> Experience opens with the same stops and the same way of travelling, ready to Start
    const other = MODE === "explore" ? "plan" : "explore";
    const linkFor = mode => { const st = S.stops.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";"); return `index.html?site=${encodeURIComponent(SITE)}&mode=${mode}${st ? "&stops=" + st : ""}${S.vehicle === "rover" ? "&vehicle=rover" : ""}`; };
    const glob = document.querySelector("a.back:not(.modelink)"); if (glob) glob.href = MODE === "full" ? "globe.html" : `globe.html?mode=${MODE}`;     // back to the globe, in the same mode
    $("brandLink").href = "/"; $("modeLink").hidden = MODE === "full";
    function syncFlow() {
      if (MODE === "full") return;
      const has = S.stops.length > 0 && !!S.route;
      $("modeLink").href = linkFor(other);
      $("modeLink").querySelector("span").textContent = MODE === "explore" ? "Plan a trip here" : has ? "Walk this route" : "Experience this place";
      if (MODE === "plan") {
        const ns = document.querySelector(".nextstep");
        ns.innerHTML = has ? `<a class="flowgo" href="${linkFor("explore")}"><b>Walk this route in first person</b><span>Same stops, ${S.vehicle === "rover" ? "by rover" : "on foot"}, in 3D or VR</span><i aria-hidden="true">→</i></a>` : "Tap the map to add your first stop. The route appears as soon as there is one.";
      }
    }
    T3.syncFlow = syncFlow; syncFlow();
    if (MODE === "plan") $("hint").textContent = "Tap the map to add a waypoint. The band under the route shows how sure your position will be.";
  }
  if (MODE === "explore") {
    /* Experience Mars: the panels go, the astronaut steps out of the airlock, and you are behind the visor.
       A lookout is chosen for you: the highest ground within 2.5 km of the habitat, so the first walk has a view. */
    document.body.classList.add("nopanel"); setView("3d"); setCam("fp", true); syncPanelTog();
    const ex = $("explore"), sunNow = sunAt(Date.now() / 1000), dark = sunNow.el < 6;
    if (dark) T3.testSun = { az: 200, el: 34 };
    const [lo, la] = lonLat(...HAB), z0 = elevAt(...HAB) ?? 0;
    $("exSite").textContent = M.label;
    $("exFacts").innerHTML = `<span>${Math.abs(la).toFixed(2)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? "E" : "W"}</span><span>${z0 >= 0 ? "+" : "−"}${Math.abs(z0 / 1000).toFixed(1)} km elevation</span><span>${dark ? "Night there now · shown in daylight" : `Sun ${Math.round(sunNow.el)}° up there now`}</span>`;
    const coarse = matchMedia("(pointer: coarse)").matches;
    $("exHow").innerHTML = coarse
      ? "<li><b>Stick</b> walk and turn</li><li><b>Drag</b> look around</li><li><b>Jump</b> in 0.38 g</li><li><b>VR</b> phone in a headset</li>"
      : "<li><b>W A S D</b> walk and turn</li><li><b>Drag</b> look around</li><li><b>Space</b> jump in 0.38 g</li><li><b>C</b> change camera</li>";
    function lookout() {
      let best = null, bz = -1e9; const R0 = 2500, st = Math.max(DX, 40);
      for (let dy = -R0; dy <= R0; dy += st) for (let dx = -R0; dx <= R0; dx += st) {
        const d = Math.hypot(dx, dy); if (d < 700 || d > R0) continue;
        const x = HAB[0] + dx, y = HAB[1] + dy, z = elevAt(x, y), sl = slopeAt(x, y); if (z == null || sl == null || sl > 22) continue;
        if (z > bz) { bz = z; best = [x, y]; }
      }
      return best || [HAB[0] + 1200, HAB[1] + 900];
    }
    // second step: choose where to go. The map opens round the habitat; tap a spot (or take the lookout).
    // second step: plan where to go. Tap the map to add stops (as many as you like); the route is drawn as you go.
    // Nothing starts until you press Start: then you are in first person at the airlock.
    function chooseDest() {
      return new Promise(res => {
        const R0 = S.vehicle === "rover" ? 8000 : 3500, bar = $("exPick"), go = $("exStart"), rv = S.vehicle === "rover";
        S.stops = T3.carried && T3.carried.length ? T3.carried : []; T3.carried = null; S.roundTrip = false; plan(0);
        setView("2d"); map.fitBounds(L.latLngBounds([ll(HAB[0] - R0, HAB[1] - R0), ll(HAB[0] + R0, HAB[1] + R0)]), { animate: false });
        const sync = () => {
          const n = S.stops.length, r = S.route && S.route.stop_idx.length === n + 1 ? S.route : null;
          $("exPickT").textContent = !n ? `Tap the map to add your stops` : r ? `${n} stop${n > 1 ? "s" : ""} · ${wKm(r.distance_m)} · about ${wDur(r.time_s)} ${rv ? "driving" : "walking"}` : `${n} stop${n > 1 ? "s" : ""} · planning the route…`;
          go.disabled = !r; $("exUndo").hidden = !n;
        };
        const timer = setInterval(sync, 300); sync();
        bar.hidden = false; document.body.classList.add("ex-picking");
        const done = ok => { clearInterval(timer); T3.exPick = null; bar.hidden = true; document.body.classList.remove("ex-picking"); res(ok); };
        T3.exPick = p => { S.stops.push(p); plan(0); sync(); };
        $("exUndo").onclick = () => { S.stops.pop(); plan(0); sync(); };
        $("exLook").onclick = () => { S.stops.push(lookout()); plan(0); sync(); };
        $("exStart").onclick = () => done(true);
        $("exBack").onclick = () => { S.stops = []; plan(0); done(false); };
      });
    }
    async function stepOut(veh) {
      ex.hidden = true; audio().resume();
      if (!walk.on) {
        setVehicle(veh === "rover" ? "rover" : "foot", false);
        if (!(await chooseDest())) { setView("3d"); setCam("fp", true); ex.hidden = false; return; }
        if (!S.route) return toast("No route yet", "Add a stop that can be reached.", "#F0616B");
        const b1 = document.querySelector('.spd[data-s="1"]'); if (b1) b1.click();
        setView("3d"); startWalk(); takeControl(); setCam("fp", true);
        const far = S.route.distance_m, rv = S.vehicle === "rover", n = S.stops.length;
        guide(rv ? "You are at the wheel" : "You are outside", `Your plan: ${n} stop${n > 1 ? "s" : ""}, ${wKm(far)} by the planned route, about ${wDur(S.route.time_s)}. ${rv ? "Drive" : "Walk"} it yourself; the green line shows the way. There is no GPS on Mars: watch how the habitat radio and the satellites keep track of you.${far > (rv ? 30000 : 8000) ? " It is a long way: the Speed buttons make time run faster." : ""}`, "#8ab8ff");
      }
      try { $("view3d").focus({ preventScroll: true }); } catch (e) { /* fine */ }
    }
    $("exGo").onclick = () => stepOut("foot"); $("exRover").onclick = () => stepOut("rover");
    {   // came from Plan a trip with a route: say so on the card, and keep the stops for the next step
      const q = new URLSearchParams(location.search).get("stops");
      const st = q ? q.split(";").map(v => v.split(",").map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite) && p[0] > 0 && p[1] > 0 && p[0] < M.width_m && p[1] < M.height_m) : [];
      if (st.length) {
        T3.carried = st;
        const rv = new URLSearchParams(location.search).get("vehicle") === "rover";
        ex.querySelector("p:not(.exfacts)").textContent = `Your planned route is ready: ${st.length} stop${st.length > 1 ? "s" : ""}. Choose how to travel; you can still add or remove stops before you press Start simulation.`;
        if (rv) { const a = $("exGo"), b = $("exRover"); b.after(a); }        // the way you planned comes first
      }
    }
    ex.hidden = false;
  }

  /* ---------- tutorial: a short guided look at each part of the page (the Tutorial button in the top bar) ---------- */
  {
    const T = { i: -1 }, phone = () => mq.matches;
    const panel = p => { if (!phone()) showPanel(true); openSheet(p); };
    const lay = n => { S.layers.clear(); if (n) S.layers.add(n); document.querySelectorAll(".lay[data-l]").forEach(b => b.setAttribute("aria-pressed", String(S.layers.has(b.dataset.l)))); syncLayers(); };
    const flat = () => { if (S.view !== "2d") setView("2d"); };
    const STEPS = [
      { t: "Welcome to the planner", pre: () => { flat(); lay(null); }, x: "This is the place you picked, as a working map on real NASA terrain. In about a minute you'll see how to plan a walk here, read the ground with the layers, and check how the astronaut will be tracked without GPS." },
      { sel: "#map", soft: true, pre: () => { setView("2d"); if (phone()) closeSheet(); }, t: "The map", x: "This is the ground around the habitat, marked H. Tap anywhere to add a waypoint, and drag a marker to move it. The route is planned again each time." },
      { sel: "#stops", pre: () => panel("mission"), t: "Plan: your waypoints", x: "Your stops are listed here in walking order. Remove one with the ×, or choose whether the walk ends back at the habitat." },
      { sel: "#styles", pre: () => panel("mission"), t: "Plan: how careful to be", x: "Safest keeps to flat ground even if it is longer. Fastest takes the short way over steeper ground. Balanced sits between the two." },
      { sel: ".veh", pre: () => panel("mission"), t: "Plan: on foot or by rover", x: "Two astronauts walking, or a pressurised crew rover at about 10 km/h. The route, its time and the slopes it will take change with the choice." },
      { sel: "#stats", alt: "#verdict", pre: () => panel("mission"), t: "Plan: check the walk", x: "Distance, time, climb, radiation dose and how steep it gets, with a plain-words verdict above." },
      { sel: "#navBox", pre: () => { panel("mission"); setTimeout(() => { const nb = $("navBox"); if (nb) nb.scrollIntoView({ block: "center" }); }, 60); }, t: "Plan: navigation without GPS", x: "How sure the astronaut's position will be along the route. The band under the route turns green near the habitat and at each satellite pass, and amber to red where the suit's own estimate has drifted. Pins mark each satellite fix." },
      { sel: "#layerChips", pre: () => { flat(); panel("layers"); lay(null); }, t: "Layers: read the ground", x: "Each layer colours the map with one thing that matters on a walk. One tap turns a layer on or off; the opacity slider lets the ground show through." },
      { sel: "#map", soft: true, pre: () => { flat(); panel("layers"); lay("slope"); }, t: "Slope, switched on", x: "This is the Slope layer, live: green is an easy walk, amber is tiring, red is too steep for a suit. The planner keeps the route off the red. The legend shows the scale." },
      { sel: "#map", soft: true, pre: () => { flat(); panel("layers"); lay("radiation"); }, t: "Radiation, switched on", x: "Daily dose on open ground, from Curiosity's measurement scaled by the air above and how much sky the terrain leaves open. Ground temperature, sunlight, relay obstruction, habitat radio and traversal cost work the same way." },
      { sel: "#nextPass", pre: () => { lay(null); panel("relay"); }, t: "Radio: satellites overhead", x: "Mars has no GPS. Relay orbiters pass overhead a few times a day. This shows the next pass. While one is up you can talk to Earth, and it measures where you really are." },
      { sel: "#timebar", pre: () => { if (phone()) closeSheet(); }, t: "Time bar", x: "Press play to walk the route. The clock is the time at the site, the strip shows daylight and satellite passes, and ×1 to ×600 sets how fast time runs." },
      { sel: ".viewbar .seg", pre: () => { lay(null); flat(); if (phone()) closeSheet(); }, t: "Map or 3D", x: "Switch between this map and the 3D view of the same place." },
      { sel: "#view3d", soft: true, pre: () => { if (phone()) closeSheet(); setView("3d"); }, t: "The ground in 3D", x: "Real terrain at true scale: a 1.9 m astronaut beside an 8.4 m habitat. Drag to turn the view, scroll or pinch to zoom. To walk it yourself in first person, or in VR, open Experience this place in the top bar." },
      { sel: "#logBtn", pre: () => flat(), t: "The guide and the bell", x: "During a walk a guide tells you in words what is happening: a satellite coming, how far off your position was, the new route. Every message is kept behind the bell." },
      { sel: "a.back", alt: ".brand", last: true, t: "Anywhere on Mars", x: "Tap Globe, or the Marswalk logo, to pick any other place on Mars and plan a walk there." },
    ];
    const root = document.createElement("div"); root.className = "tut"; root.hidden = true;
    root.innerHTML = '<div class="tutblock"></div><div class="tutspot"></div><div class="tutcard" role="dialog" aria-modal="true" aria-labelledby="tutT"><small id="tutN"></small><b id="tutT"></b><p id="tutX"></p>'
      + '<a class="tutlink" id="tutTour" href="tour.html" hidden>Watch the Pavonis Mons tour (3D, satellites and VR)</a>'
      + '<div class="tutbtns"><button type="button" class="chip" id="tutSkip">Skip</button><span></span><button type="button" class="chip" id="tutBack">Back</button><button type="button" class="go" id="tutNext">Next</button></div></div>';
    document.body.appendChild(root);
    const spot = root.querySelector(".tutspot"), card = root.querySelector(".tutcard");
    const seen = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 4;
    function place() {
      if (T.i < 0) return;
      const st = STEPS[T.i]; let el = st.sel ? document.querySelector(st.sel) : null; if (!seen(el) && st.alt) el = document.querySelector(st.alt); if (!seen(el)) el = null;
      const W = innerWidth, H = innerHeight, cw = Math.min(380, W - 24), pad = 8;
      let r = el && !st.soft ? el.getBoundingClientRect() : null;
      if (r && phone() && r.height > H * 0.4) r = { left: r.left, right: r.right, top: r.top, width: r.width, height: H * 0.4, bottom: r.top + H * 0.4 };   // a long list: light up the top of it, leave room for the card
      card.style.width = cw + "px"; root.classList.toggle("dim", !r && !st.soft); spot.style.display = r ? "block" : "none";      // a "soft" step shows the map itself, undimmed
      if (r) Object.assign(spot.style, { left: Math.max(4, r.left - pad) + "px", top: Math.max(4, r.top - pad) + "px", width: Math.min(W - 8, r.width + 2 * pad) + "px", height: Math.min(H - Math.max(4, r.top - pad) - 4, r.height + 2 * pad) + "px" });
      const ch = card.offsetHeight; let x, y;
      if (!r && st.soft) { x = phone() ? 12 : W - cw - 28; y = phone() ? Math.max(8, H - ch - 150) : Math.max(70, H - ch - 130); }      // out of the way, so the layer or the 3D view can be seen
      else if (!r) { x = (W - cw) / 2; y = phone() ? H * 0.2 : (H - ch) / 2; }
      else if (!phone() && r.right + cw + 36 < W && r.height > 110) { x = r.right + 24; y = Math.min(H - ch - 16, Math.max(16, r.top - pad)); }
      else { x = Math.min(W - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2)); y = r.bottom + 20 + ch < H - 8 ? r.bottom + 20 : r.top - ch - 20; if (y < 8) y = 8; }
      card.style.left = Math.round(x) + "px"; card.style.top = Math.round(y) + "px";
    }
    function show(i) {
      T.i = i; const st = STEPS[i]; if (st.pre) st.pre();
      $("tutN").textContent = `Step ${i + 1} of ${STEPS.length} · the planner`; $("tutT").textContent = st.t; $("tutX").textContent = st.x;
      $("tutBack").hidden = i === 0; $("tutSkip").hidden = !!st.last; $("tutNext").textContent = st.last ? "Done" : "Next"; $("tutTour").hidden = !st.last;
      root.hidden = false;
      const el = st.sel && !st.soft ? document.querySelector(st.sel) : null; if (seen(el)) el.scrollIntoView({ block: "center" });
      place(); setTimeout(place, 80); setTimeout(place, 340);            // again once the panel or sheet has finished moving
      $("tutNext").focus({ preventScroll: true });
    }
    function end() { root.hidden = true; T.i = -1; lay(null); flat(); if (phone()) closeSheet(); else openSheet("mission"); $("helpBtn").focus({ preventScroll: true }); }
    $("helpBtn").onclick = () => { if (walk.on) return toast("End the walk first", "The tutorial shows the planning screens. Press stop, then open it again.", "#F5B85B"); show(0); };
    $("tutNext").onclick = () => T.i >= STEPS.length - 1 ? end() : show(T.i + 1);
    $("tutBack").onclick = () => T.i > 0 && show(T.i - 1);
    $("tutSkip").onclick = end;
    addEventListener("resize", place);
    addEventListener("keydown", e => { if (T.i < 0) return; if (e.key === "Escape") end(); else if (e.key === "ArrowRight") $("tutNext").click(); else if (e.key === "ArrowLeft") $("tutBack").click(); else return; e.stopPropagation(); }, true);
    MW.tut = { show, end, STEPS };
    if (MODE === "plan") STEPS.find(v => v.sel === "#timebar").x = "The clock is the time at the site and the strip shows daylight and satellite passes. Drag along it to choose when you leave: the navigation band changes with the passes.";
    if (MODE === "explore") $("helpBtn").hidden = true;
    if (new URLSearchParams(location.search).get("tutorial") === "1" && MODE !== "explore") setTimeout(() => show(0), 900);
  }

  /* ---------- presentation tour: tour.html loads this page in a frame with ?tour=pavonis (or orbit|slope|sat) ----------
     The page clears its controls, sets up, says "ready", then plays each scene the tour page names. */
  const TOUR = new URLSearchParams(location.search).get("tour");
  if (TOUR) {
    const wait = ms => new Promise(r => setTimeout(r, ms)), tell = m => parent !== window && parent.postMessage({ marswalkTour: m }, location.origin);
    const ease = (from, to, ms) => new Promise(res => { const t0 = performance.now(), st = () => { const k = Math.min(1, (performance.now() - t0) / ms), e2 = k * k * (3 - 2 * k); const h = T3.vr && T3.vr.head; if (h) { h.yaw = from[0] + (to[0] - from[0]) * e2; h.pitch = from[1] + (to[1] - from[1]) * e2; } k < 1 ? setTimeout(st, 16) : res(); }; st(); });
    VOICE.on = false; document.body.classList.add("tour", "nopanel"); if (!["sat", "pavonis"].includes(TOUR)) document.body.classList.add("tour-quiet");
    if (TOUR === "lab") S.stops = [];                                  // the layers chapter: a clean map, no route on top
    $("hint").hidden = true; $("coach").hidden = true; map.invalidateSize();
    T3.testSun = { az: 165, el: 48 };                                  // the tour is filmed in daylight, whatever the clock says
    setView("3d"); await wait(400);
    // Pavonis Mons has two calderas side by side. The habitat (site centre) stands on the floor of the large shallow one, at the rim of the small deep one.
    // PITS[0]: a science stop on the floor of the large caldera. PITS[1]: the floor of the deep caldera, 3 km lower.
    const PITS = [[HAB[0] + 1500, HAB[1] + 4500], [HAB[0], HAB[1] - 11000]];
    const SCENES = {
      async aerial() { T3.api.aerial(0.5, 0.26); T3.tourOrbit = 0.07; },
      async pits() { T3.tourOrbit = 0; T3.api.flyTo(HAB[0], HAB[1] - 9000, 52000, 30000, 4200, 2.6); },
      async plan() {
        T3.tourOrbit = 0; setView("2d"); S.layers.add("slope"); S.opacity = 0.75; syncLayers();
        map.fitBounds(L.latLngBounds([ll(HAB[0] - 24000, HAB[1] + 9000), ll(HAB[0] + 24000, HAB[1] - 26000)]), { animate: false });
        S.stops = []; plan(0); await wait(700); S.stops = [PITS[0]]; plan(0); await wait(1500); S.stops = [PITS[0], PITS[1]]; plan(0);
      },
      async walk() {
        for (let i = 0; i < 60 && (!S.route || S.route.stop_idx.length < 3); i++) await wait(100);
        S.layers.delete("slope"); syncLayers(); setView("3d"); tourSpeed(8);                 // slow enough to watch the steps
        startWalk(); setCam("follow", true); T3.chaseK = 0.6;
      },
      async sat() {
        // show a pass by one of the low orbiters (MRO, Odyssey, TGO): they cross the sky in minutes, so the geometry is good for a fix within seconds.
        // Mars Express is high and slow; it does fix you, but over a much longer pass than a tour chapter.
        tourSpeed(20);
        for (let n = 0; n < 8; n++) { const np = DB.passes.find(q => q.start > walk.simT + 20); if (!np || np.orbiter !== "Mars Express") break; const dt = np.end + 30 - walk.simT; walk.simT += dt; if (!walk.manual) walk.t0 += dt; }     // wait in place, the way Skip does
        skipToPass(); await wait(1200); if (T3.api) T3.api.lookSat(2600);                    // a slow camera rise to the satellite and its radio link
        await wait(5200); setCam("follow", true); T3.chaseK = 0.6;                           // then glide back behind the astronaut
      },
      async vr() {
        // stand on the floor of the deep caldera, facing the 3 km wall you came down, and look round through the headset
        if (!walk.on) {                                                     // jumped straight here: get a route and a walk going first
          for (let i = 0; i < 80 && !S.route; i++) await wait(100);
          if (!S.route) return; setView("3d"); startWalk(); setCam("fp", true); await wait(400);
        }
        if (!walk.manual) takeControl();
        const vx = PITS[1][0] + 600, vy = PITS[1][1] - 1500;                // well out on the floor, so the wall stands in front of you with sky above it
        walk.mx = vx - walk.drift[0]; walk.my = vy - walk.drift[1]; walk.hd = 0.2; walk.rest = [PITS[1], HAB]; walk.ri = 0;
        reroute([vx, vy], walk.rest, "", "#8ab8ff", { soft: true, quiet: true });
        vrDemo(true); await wait(300);
        await ease([0, 0.02], [0.28, 0.06], 1300); await ease([0.28, 0.06], [-0.3, 0.04], 1700);
        await ease([-0.3, 0.04], [0, 0.02], 900);
        // turn to the card and hold the dot on "Satellite" until it fires; the target is re-read every frame because the card turns with the body
        await new Promise(res => { const t0 = performance.now(), st = () => { const h = T3.vr && T3.vr.head; if (!h) return res(); const a2 = T3.vrAim("sat"), k = Math.min(1, (performance.now() - t0) / 900);
          h.yaw += (a2[0] - h.yaw) * (0.06 + 0.3 * k); h.pitch += (a2[1] - h.pitch) * (0.06 + 0.3 * k); performance.now() - t0 < 3700 ? setTimeout(st, 16) : res(); }; st(); });
        // then the radio card on the right: hold the dot on a quick reply to Earth
        await new Promise(res => { const t0 = performance.now(), st = () => { const h = T3.vr && T3.vr.head; if (!h) return res(); const a2 = T3.vrAim("r:q0"), k = Math.min(1, (performance.now() - t0) / 1200);
          h.yaw += (a2[0] - h.yaw) * (0.04 + 0.2 * k); h.pitch += (a2[1] - h.pitch) * (0.04 + 0.2 * k); performance.now() - t0 < 3600 ? setTimeout(st, 16) : res(); }; st(); });
        await ease([T3.vr.head.yaw, T3.vr.head.pitch], [0, 0.03], 1200);
      },
      async end() { vrDemo(false); T3.vrHold = false; },
      // ---- the short demo: 2 read the ground, 3 plan in 3D, 4 stand there in VR while a satellite fixes you ----
      async layers() {
        ui(); T3.tourOrbit = 0; T3.fly = null; setView("2d"); document.body.classList.add("tour-legend");
        if (S.stops.length) { S.stops = []; plan(0); }
        map.fitBounds(L.latLngBounds([ll(HAB[0] - 26000, HAB[1] + 14000), ll(HAB[0] + 26000, HAB[1] - 30000)]), { animate: false });
        for (const n of ["slope", "radiation", "comms", "hab"]) { S.layers.clear(); S.layers.add(n); S.opacity = 0.8; syncLayers(); await wait(1950); }
      },
      async plan3d() {
        ui(); S.layers.clear(); S.layers.add("slope"); S.opacity = 0.55; syncLayers();
        setView("3d"); setCam("free", true); T3.api.flyTo(HAB[0] + 2000, HAB[1] - 7000, 34000, 19000, 10, 2.5); T3.tourOrbit = 0.035;
        S.stops = []; plan(0); await wait(700); S.stops = [PITS[0]]; plan(0); await wait(1700); S.stops = [PITS[0], PITS[1]]; plan(0);
      },
      async vrsat() {
        ui(); T3.tourOrbit = 0; S.layers.clear(); syncLayers();
        for (let i = 0; i < 60 && !(S.route && S.route.stop_idx.length >= 3); i++) await wait(100);
        setView("3d"); if (!walk.on) startWalk(); if (!walk.manual) takeControl();
        const vx = PITS[1][0] + 600, vy = PITS[1][1] - 1500;                    // out on the floor of the deep caldera
        walk.mx = vx - walk.drift[0]; walk.my = vy - walk.drift[1]; walk.hd = 0.2; walk.rest = [PITS[1], HAB]; walk.ri = 0;
        reroute([vx, vy], walk.rest, "", "#8ab8ff", { soft: true, quiet: true });
        T3.vrHold = true; walk.fixKey = null; walk.lockKey = "";
        { const b = document.querySelector('.spd[data-s="30"]'); if (b) b.click(); }      // ×30: the satellite stays up for the whole chapter
        for (let n = 0; n < 8; n++) { const np = DB.passes.find(q => q.start > walk.simT + 20); if (!np || np.orbiter !== "Mars Express") break; walk.simT += np.end + 30 - walk.simT; }
        skipToPass(); vrDemo(true); await wait(500);
        const track = (fn, ms) => new Promise(res => { const t0 = performance.now(), st = () => { const h = T3.vr && T3.vr.head; if (!h) return res(); const a = fn(); if (a) { const k = Math.min(1, (performance.now() - t0) / 700); h.yaw += (a[0] - h.yaw) * (0.05 + 0.25 * k); h.pitch += (a[1] - h.pitch) * (0.05 + 0.25 * k); } performance.now() - t0 < ms ? setTimeout(st, 16) : res(); }; st(); });
        await track(() => T3.satDir ? T3.vrAimDir(T3.satDir) : [0.2, 0.5], 4600);          // look up: the satellite crossing the sky, the radio link drawn to it
        await track(() => T3.vrAimCard(), 3000);                                            // then the card: what the satellite found
        await track(() => T3.vrAim("r:q0"), 2700);                                          // then the radio on the right: hold the dot on a quick reply to Earth
      },
      async walksat() { await SCENES.walk(); await wait(1600); await SCENES.sat(); },      // the 30-second cut: walk, then a relay pass fixes the position
      // ---- chapters for the full tour (tour.html) ----
      async layer(n) {                                                  // one data layer on the map, with its legend
        ui(); T3.tourOrbit = 0; setView("2d"); document.body.classList.add("tour-legend");
        S.layers.clear(); if (n) S.layers.add(n); S.opacity = 0.85; S.base = "ortho"; syncLayers();
        if (TOUR === "pavonis" && !T3.layerFit) { T3.layerFit = true; if (S.stops.length) { S.stops = []; plan(0); } map.fitBounds(L.latLngBounds([ll(HAB[0] - 26000, HAB[1] + 14000), ll(HAB[0] + 26000, HAB[1] - 30000)]), { animate: false }); }
        if (n === "hab") map.setView(ll(HAB[0], HAB[1] + 1500), -3.2, { animate: false });
      },
      async radio() {                                                   // the Radio tab and the time bar: passes forecast for this site
        ui(); S.layers.clear(); syncLayers(); setView("2d"); document.body.classList.add("tour-panel"); showPanel(true); openSheet("relay"); map.invalidateSize();
      },
      async navplan() {                                                 // plan a trip: the route, its navigation forecast band and chart
        ui(); S.layers.clear(); syncLayers(); setView("2d"); document.body.classList.add("tour-panel"); showPanel(true); openSheet("mission");
        map.fitBounds(L.latLngBounds([ll(HAB[0] - 9000, HAB[1] + 6000), ll(HAB[0] + 9000, HAB[1] - 14000)]), { animate: false });
        await wait(400); const nb = $("navBox"); if (nb) nb.scrollIntoView({ block: "center" });
      },
      async rover() {                                                   // the crew rover leaves the habitat
        ui(); if (walk.on) endWalk(); setVehicle("rover", false); plan(0);
        for (let i = 0; i < 60 && !(S.route && S.route.vehicle === "rover"); i++) await wait(100);
        setView("3d"); tourSpeed(6);                                       // a rover at ×6: clearly faster than the walk, still smooth
        startWalk(); setCam("follow", true); T3.chaseK = 0.6;
      },
      async explore() {                                                 // Experience Mars: first person, walk, jump
        ui(); if (walk.on) endWalk(); setVehicle("foot", false); plan(0);
        for (let i = 0; i < 60 && !(S.route && S.route.vehicle === "foot"); i++) await wait(100);
        setView("3d"); { const b1 = document.querySelector('.spd[data-s="1"]'); if (b1) b1.click(); }
        startWalk(); takeControl(); setCam("fp", true);
        walk.keys = { w: true }; await wait(2600); jump(); await wait(1700); walk.keys = { w: true, a: true }; await wait(900); walk.keys = { w: true }; await wait(1200); walk.keys = {};
      },
    };
    function tourSpeed(v) { S.speed = v; document.querySelectorAll(".spd").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.s === v))); }
    function ui() { document.body.classList.remove("tour-panel", "tour-legend"); if (!document.body.classList.contains("nopanel")) showPanel(false); }
    if (S.stops.length) for (let i = 0; i < 80 && !S.route; i++) await wait(100);
    if (TOUR === "slope") { S.layers.add("slope"); S.opacity = 0.85; syncLayers(); T3.dirty = true; }
    if (TOUR === "pavonis") { T3.api.aerial(0.5, 0.26); await wait(2500); }
    else if (TOUR === "lab") { setView("2d"); await wait(1200); }
    else if (TOUR === "sat") { startWalk(); setCam("follow", true); T3.chaseK = 0.55; await wait(1800); }
    else { if (M.kind === "region") T3.api.aerial(); else T3.api.reset(); T3.tourOrbit = 0.09; await wait(2200); }
    addEventListener("message", async e => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.marswalkTour === "pause") {                          // the tour's pause button freezes the clock, the walk and the camera turn
        if (e.data.on && S.speed) { T3.tourHold = { speed: S.speed, orbit: T3.tourOrbit }; S.speed = 0; T3.tourOrbit = 0; }
        else if (!e.data.on && T3.tourHold) { S.speed = T3.tourHold.speed; T3.tourOrbit = T3.tourHold.orbit; T3.tourHold = null; }
        return;
      }
      if (e.data.marswalkTour === "scene" && SCENES[e.data.name]) return SCENES[e.data.name](e.data.arg);
      if (e.data.marswalkTour === "go" && TOUR === "sat") return SCENES.sat();
    });
    MW.scene = (n, a) => SCENES[n] && SCENES[n](a);
    tell("ready");
  }
})().catch(e => { document.getElementById("loader").textContent = "Failed to load: " + e.message; console.error(e); });
