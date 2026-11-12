/* Marswalk frontend: Leaflet map (metres, CRS.Simple) + three.js terrain + walk simulation. */
(async () => {
  const $ = id => document.getElementById(id);
  const SITE = new URLSearchParams(location.search).get("site") || "jezero";
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
    document.querySelector(".brand span").textContent = `${M.label.toUpperCase()} · ${Math.abs(la).toFixed(2)}°${la >= 0 ? "N" : "S"} ${Math.abs(lo).toFixed(2)}°${lo >= 0 ? "E" : "W"} · ${M.kind === "region" ? "MOLA " + Math.round(M.DY) + " m (coarse)" : "CTX 20 m"}`;
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

  /* ---------- state ---------- */
  const S = {
    stops: SITE === "jezero" ? [[15100, 16000], [12700, 16300]] : [],     // science stops (x east, y north, metres)
    roundTrip: true, style: "safe", weights: { slope: 1, radiation: 0.3, comms: 0.3, shadow: 0.2, cold: 0.2 }, maxSlope: 18,
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
  L.control.zoom({ position: "bottomleft" }).addTo(map);
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
    const t = Math.floor((n === "sun" || n === "heat" ? clockT() : departT()) / 600) * 600;
    return Q(`/api/layer/${n}.png?t=${t}` + (n === "cost" ? `&w=${encodeURIComponent(JSON.stringify(S.weights))}` : ""));
  };
  function syncLayers() {
    for (const n of ["slope", "radiation", "comms", "sun", "heat", "cost"]) {
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
    sun: ["linear-gradient(90deg,#0e1646 0%,#0e1646 30%,#ffe1aa 100%)", "shadow", "full sun", ""],
    heat: ["linear-gradient(90deg,#140e46,#283caa,#4696d2,#9664be,#e1506e,#fa963c,#fff096)", "", "", ""],
    cost: ["linear-gradient(90deg,#1ea078,#dcd250,#f07832,#c8283c,#19050f)", "easy", "no-go", "what the planner sees with your weights"],
    elevation: ["linear-gradient(90deg,#261860,#2446aa,#2096c8,#46be78,#c8dc5a,#f0b43c,#e16e2d,#faf4ec)", "", "", ""],
  };
  const NOTE = {
    slope: "Green is easy walking. Amber is a moderate slope. Red is steep. The planner avoids red unless there is no other way.",
    radiation: "Darker blue = more shielded. Cliff bases and valley floors hide part of the sky, so they get less. Higher ground has thinner air above it, so it gets more. Inside one crater the spread is small: the big differences are between places on Mars (see the globe).",
    comms: "Red = places where hills hide the relay orbiters for much of the day.",
    sun: "Dark blue = night, or shadow cast by the terrain right now.",
    heat: "Ground temperature at the clock time. Cold ground drains suit power.",
    cost: "What the planner sees with your settings: green is cheap to cross, dark red is avoided.",
    elevation: "Height above the Mars datum. Brighter = higher.",
  };
  const LNAME = { slope: "Slope", radiation: "Radiation", comms: "Relay blind spots", sun: "Sun & shadow", heat: "Ground temp", cost: "Planner cost", elevation: "Elevation" };
  async function drawLegend() {
    const act = [...S.layers].pop() || (S.base === "elevation" ? "elevation" : null);
    const el = $("legend"); $("layerNote").textContent = act ? NOTE[act] : "Pick a layer to colour the map.";
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
    g.clearLayers();
    L.marker(ll(...HAB), { icon: icon("mk hab", "H"), interactive: true }).bindTooltip("Habitat · " + M.habitat_name).addTo(g);
    S.stops.forEach((s, i) => {
      const m = L.marker(ll(...s), { icon: icon("mk", i + 1), draggable: !walk.on }).addTo(g);
      m.on("dragend", () => { const p = m.getLatLng(); S.stops[i] = [p.lng, p.lat]; plan(); });
    });
    $("stops").innerHTML = `<div class="stop hab"><i>H</i><span>Habitat</span><small>${fmtLL(...HAB)}</small><span></span></div>` +
      S.stops.map((s, i) => `<div class="stop"><i>${i + 1}</i><span>Science stop ${i + 1}</span><small>${Math.round(elevAt(...s) ?? 0)} m</small><button data-i="${i}" title="Remove">×</button></div>`).join("");
    $("stops").querySelectorAll("button").forEach(b => b.onclick = () => { if (walk.on) return; S.stops.splice(+b.dataset.i, 1); plan(); });
  }
  const fmtLL = (x, y) => { const [lo, la] = lonLat(x, y); return `${la.toFixed(3)}°N ${lo.toFixed(3)}°E`; };
  map.on("click", e => {
    if (walk.on) return;
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
      body: JSON.stringify({ site: SITE, stops, weights: S.weights, depart, max_slope: S.maxSlope, round_trip: false }) });
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
    if (!r) { $("verdict").innerHTML = ""; $("mix").innerHTML = ""; $("stats").innerHTML = ""; $("warns").innerHTML = ""; $("contacts").innerHTML = ""; drawProfile(); drawTimeline(); return; }
    const mx = r.slope_mix || { green: 100, yellow: 0, steep: 0 }, f0 = v => Math.round(v);
    $("verdict").className = "verdict " + (mx.steep > 0.5 ? "bad" : mx.yellow > 3 ? "warn" : "ok");
    $("verdict").textContent = mx.steep > 0.5 ? `${f0(mx.steep)} % of this route is steep (over 15°). Steepest ${r.max_slope.toFixed(0)}°.`
      : mx.yellow > 3 ? `${f0(mx.green)} % flat ground, ${f0(mx.yellow)} % moderate slope. Steepest ${r.max_slope.toFixed(0)}°.`
      : `${f0(mx.green)} % flat ground. Steepest step ${r.max_slope.toFixed(0)}°.`;
    $("mix").innerHTML = `<div class="bar"><i style="width:${mx.green}%;background:#6EE7A8"></i><i style="width:${mx.yellow}%;background:#F5B85B"></i><i style="width:${mx.steep}%;background:#F0616B"></i></div>` +
      `<div class="key"><span><i style="background:#6EE7A8"></i>Flat under 8°</span><span><i style="background:#F5B85B"></i>Slope 8–15°</span><span><i style="background:#F0616B"></i>Steep over 15°</span></div>`;
    const st = (k, v, u, cls = "") => `<div class="stat ${cls}"><span>${k}</span><b>${v}<small>${u}</small></b></div>`;
    $("stats").innerHTML =
      st("Distance", (r.distance_m / 1000).toFixed(2), "km") +
      st("EVA time", (r.time_s / 3600).toFixed(1), "h", r.time_s > 8 * 3600 ? "bad" : "") +
      st("Climb", Math.round(r.climb_m), "m") +
      st("Dose", (r.dose_msv * 1000).toFixed(0), "µSv") +
      (r.ground_c ? st("Ground", `${Math.round(r.ground_min_c)}…${Math.round(r.ground_max_c)}`, "°C", r.ground_min_c < -80 ? "bad" : "") : "") +
      st("Relay", r.contact_min, "min", r.contact_min ? "ok" : "bad") +
      st("Silent", (r.longest_gap_s / 3600).toFixed(1), "h", r.longest_gap_s > 4 * 3600 ? "bad" : "");
    $("warns").innerHTML = r.warnings.map(w => `<div class="warn">${w}</div>`).join("") +
      `<p class="note">Radiation on this walk: ${(r.dose_msv * 1000).toFixed(0)} µSv (${r.career_pct.toFixed(3)} % of the ${M.rad ? M.rad.career : 600} mSv career limit). Standing still in the open here costs about ${r.rad_day_avg.toFixed(2)} mSv a day.</p>`;
    $("contacts").innerHTML = r.contacts.map(c => `<div><i class="dot" style="background:${ORB[c.orbiter].c}"></i><span>${c.orbiter} ${c.start ? fUTC(c.start) + " UTC" : "blocked"}</span><span>${c.minutes} min · ${c.max_el}°${c.blocked_min ? ` · ${c.blocked_min} blocked` : ""}</span></div>`).join("");
    drawProfile(); drawTimeline(); T3.dirty = true;
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
  function stopDop() { cancelAnimationFrame(DP.raf); if (DP.osc) { DP.osc.g.gain.setTargetAtTime(0, audio().currentTime, 0.03); const o = DP.osc.o; setTimeout(() => o.stop(), 200); DP.osc = null; } DP.k = -1; $("dopPlay").textContent = "▶ Play pass"; }
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
    c.font = "10px 'IBM Plex Mono', monospace";
    for (let i = 1; i < sm.length; i++) if (!sm[i][5]) { c.fillStyle = "rgba(255,255,255,0.05)"; c.fillRect(X(sm[i - 1][0]), 4, X(sm[i][0]) - X(sm[i - 1][0]), h - 18); }
    c.strokeStyle = "#272930"; c.beginPath(); c.moveTo(40, Y(0)); c.lineTo(w - 8, Y(0)); c.stroke();
    c.fillStyle = "#615C58"; c.fillText(`+${(mx / 1000).toFixed(1)}k`, 2, Y(mx) + 4); c.fillText("0 Hz", 2, Y(0) + 3); c.fillText(`−${(mx / 1000).toFixed(1)}k`, 2, Y(-mx) + 4);
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
    c.setLineDash([3, 4]); c.strokeStyle = "#615C58"; c.beginPath(); c.arc(cx, cy, (90 - NXT.min_el) / 90 * R, 0, 7); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#615C58"; c.font = "10px 'IBM Plex Mono', monospace"; c.fillText("N", cx - 3, 9); c.fillText("E", w - 9, cy + 3); c.fillText("S", cx - 3, h - 2); c.fillText("W", 1, cy + 3);
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
    $("dopPlay").textContent = "■ Stop";
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
  const TL = { t0: 0, span: 26 * 3600, gut: 92 };
  function drawTimeline() {
    const [c, w, h] = fit($("timeline")); if (!w) return;
    TL.t0 = Math.floor(S.now0 / 3600) * 3600 - 3600;
    const X = t => TL.gut + (t - TL.t0) / TL.span * (w - TL.gut - 6);
    c.clearRect(0, 0, w, h);
    // daylight band
    for (let px = TL.gut; px < w - 6; px += 2) {
      const t = TL.t0 + (px - TL.gut) / (w - TL.gut - 6) * TL.span, el = sunAt(t).el;
      const k = Math.max(0, Math.min(1, el / 40));
      c.fillStyle = el <= 0 ? "#0b0f24" : `rgb(${40 + 215 * k},${32 + 160 * k},${40 + 80 * k})`;
      c.fillRect(px, 2, 2, 9);
    }
    c.font = "10px 'IBM Plex Mono', monospace"; c.fillStyle = "#615C58"; c.fillText("SUN", 4, 10);
    const rowH = (h - 34) / ONAMES.length;
    ONAMES.forEach((n, i) => {
      const y = 16 + i * rowH;
      c.fillStyle = "rgba(255,255,255,0.03)"; c.fillRect(TL.gut, y, w - TL.gut - 6, rowH - 3);
      c.fillStyle = ORB[n].c; c.fillText(n.toUpperCase(), 4, y + rowH / 2 + 2);
      for (const p of DB.passes) if (p.orbiter === n) {
        c.globalAlpha = 0.35 + 0.65 * Math.min(1, p.max_el / 60);
        c.fillRect(X(p.start), y, Math.max(2, X(p.end) - X(p.start)), rowH - 3);
      }
      c.globalAlpha = 1;
    });
    // hours
    c.fillStyle = "#615C58";
    for (let t = Math.ceil(TL.t0 / 7200) * 7200; t < TL.t0 + TL.span; t += 7200) {
      c.fillRect(X(t), h - 16, 1, 4); c.fillText(fUTC(t).slice(0, 2), X(t) - 6, h - 3);
    }
    c.fillText("UTC", 4, h - 3);
    // EVA window
    const r = walk.on ? walk.route : S.route, a = walk.on ? walk.t0 : departT();
    if (r) {
      c.fillStyle = "rgba(221,183,143,0.13)"; c.strokeStyle = "#DDB78F"; c.lineWidth = 1;
      c.fillRect(X(a), 13, X(a + r.time_s) - X(a), h - 30); c.strokeRect(X(a) + .5, 13.5, X(a + r.time_s) - X(a), h - 30);
      c.fillStyle = "#6EE7A8";
      for (const k of r.contacts) if (k.start) c.fillRect(X(k.start), h - 19, Math.max(2, X(k.end) - X(k.start)), 3);
    }
    const cx = X(clockT()); c.fillStyle = "#fff"; c.fillRect(cx, 0, 1.5, h - 14);
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
    c.font = "10px 'IBM Plex Mono', monospace";
    if (!r) { c.fillStyle = "#615C58"; c.fillText("No route yet", 8, h / 2); $("profSub").textContent = ""; return; }
    const lo = Math.min(...r.z) - 5, hi = Math.max(...r.z) + 5, D = r.distance_m || 1;
    const X = d => 34 + d / D * (w - 42), Y = z => h - 14 - (z - lo) / (hi - lo) * (h - 26);
    $("profSub").textContent = `${Math.round(lo + 5)} to ${Math.round(hi - 5)} m`;
    c.beginPath(); c.moveTo(X(0), h - 14); r.d.forEach((d, i) => c.lineTo(X(d), Y(r.z[i]))); c.lineTo(X(D), h - 14); c.closePath();
    const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "rgba(221,183,143,0.45)"); gr.addColorStop(1, "rgba(221,183,143,0.03)");
    c.fillStyle = gr; c.fill();
    for (let i = 1; i < r.d.length; i++) {
      const s = r.slope[i];
      c.strokeStyle = SLCOL(s); c.lineWidth = s >= 8 ? 2.4 : 1.8;
      c.beginPath(); c.moveTo(X(r.d[i - 1]), Y(r.z[i - 1])); c.lineTo(X(r.d[i]), Y(r.z[i])); c.stroke();
    }
    c.fillStyle = "#93B7E6";
    r.stop_idx.slice(1, -1).forEach((i, k) => { c.fillRect(X(r.d[i]), 4, 1, h - 18); c.fillText(String(k + 1), X(r.d[i]) + 3, 12); });
    c.fillStyle = "#615C58"; c.fillText(Math.round(hi - 5), 2, 14); c.fillText(Math.round(lo + 5), 2, h - 16);
    c.fillText("0", 34, h - 3); c.fillText(fKm(D), w - 50, h - 3);
    if (walk.on) { const d = walk.dAlong; c.fillStyle = "#fff"; c.beginPath(); c.arc(X(d), Y(walk.zNow), 4, 0, 7); c.fill(); }
  }

  /* ---------- sound ---------- */
  let AC = null, dop = null;
  const audio = () => AC || (AC = new (window.AudioContext || window.webkitAudioContext)());
  function chime(name, twice) {
    if (!S.sound) return;
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
  function toast(title, msg, color = "#93B7E6") {
    const d = document.createElement("div"); d.className = "toast"; d.style.borderLeftColor = color;
    d.innerHTML = `<b>${title}</b>${msg}`; $("toasts").prepend(d);
    while ($("toasts").children.length > 4) $("toasts").lastChild.remove();
    setTimeout(() => d.remove(), 9000);
  }

  /* ---------- walk simulation ---------- */
  const me = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 900 });
  const ghost = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="ghost"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, zIndexOffset: 800 }).bindTooltip("true position", { permanent: false });
  const unc = L.circle(ll(...HAB), { radius: 3, color: "#93B7E6", weight: 1.5, fillColor: "#93B7E6", fillOpacity: 0.16, interactive: false });
  function startWalk() {
    if (!S.route) return;
    Object.assign(walk, { on: true, route: S.route, t0: departT(), simT: departT(), odo: 0, odoFix: 0, theta: Math.random() * 6.28,
      drift: [0, 0], dAlong: 0, _i: 0, follow: true, busy: false, hzOn: false, zNow: S.route.z[0], inContact: false, alerted: new Set(), dose: 0, lastSun: 0, last: performance.now(), dwellSaid: -1 });
    me.addTo(map); unc.addTo(map); if (S.truth) ghost.addTo(map);
    walk._painted = -1;
    $("hud").hidden = false; $("homeBtn").disabled = false; syncWalk(); closeSheet();
    $("depart").disabled = true; drawStops();
    toast("EVA started", `Leaving habitat ${fUTC(walk.t0)} UTC. No GPS: dead reckoning until the next relay pass.`, "#DDB78F");
    if (S.sound) audio().resume();
  }
  function syncWalk() {
    const on = !!walk.on, r = S.route, b = $("walkBtn"), f = $("fab");
    b.textContent = on ? "■ End walk" : "▶ Start walk"; b.classList.toggle("halt", on); b.disabled = !r && !on;
    f.hidden = !(r || on); f.classList.toggle("halt", on);
    f.innerHTML = on ? "■ End walk" : r ? `▶ Start walk<small>${(r.distance_m / 1000).toFixed(1)} km · ${(r.time_s / 3600).toFixed(1)} h</small>` : "";
    document.body.classList.toggle("walking", on);
  }
  function endWalk(msg) {
    walk.on = false; [me, unc, ghost].forEach(l => map.removeLayer(l));
    $("hud").hidden = true; $("homeBtn").disabled = true; syncWalk();
    $("depart").disabled = false; dopplerTone(null);
    if (msg) toast("EVA complete", msg, "#6EE7A8");
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
  async function reroute(from, stops, why) {
    if (walk.busy) return; walk.busy = true;
    try {
      const r = await requestRoute([from, ...stops], walk.simT);
      r.stopsReq = [from, ...stops]; walk.route = r; walk.t0 = walk.simT; walk._i = 0; walk._painted = -1;
      toast("Rerouted", why, "#F5B85B"); T3.dirty = true;
    } catch (e) { toast("Reroute failed", e.message, "#F0616B"); }
    walk.busy = false;
  }
  function tick(now) {
    requestAnimationFrame(tick);
    const dtReal = Math.min(0.5, (now - (walk.last || now)) / 1000); walk.last = now;
    if (walk.on && !walk.busy) {
      walk.simT += dtReal * S.speed;
      const r = walk.route, el = walk.simT - walk.t0, p = posOn(r, el);
      const moved = Math.max(0, p.d - walk.dAlong); walk.odo += moved; walk.dAlong = p.d; walk.zNow = p.z;
      walk.dose += (r.dose_msv / r.time_s) * dtReal * S.speed;
      // drift: where the astronaut really is vs. where dead reckoning says
      const since = walk.odo - walk.odoFix;
      walk.theta += (Math.random() - 0.5) * 0.08;
      const mag = 0.8 * DRIFT * since;
      walk.drift = [Math.cos(walk.theta) * mag, Math.sin(walk.theta) * mag];
      const tx = p.x + walk.drift[0], ty = p.y + walk.drift[1];
      // relay contact along this route (terrain-aware, from the API)
      const con = r.contacts.find(k => k.start && k.start <= walk.simT && walk.simT < k.end);
      if (con && !walk.inContact) {
        const off = Math.hypot(...walk.drift);
        chime(con.orbiter, true);
        const k = r.stop_idx.slice(1).filter(i => i <= p.i).length, rest = r.stopsReq.slice(1 + k);
        if (off > 20 && rest.length) reroute([tx, ty], rest, `${con.orbiter} Doppler fix: you were ${Math.round(off)} m off the line. New route from your true position.`);
        else toast("Position fix", `${con.orbiter} Doppler fix. Drift was ${Math.round(off)} m. Uncertainty reset.`, ORB[con.orbiter].c);
        walk.odoFix = walk.odo; walk.drift = [0, 0];
      }
      if (con) walk.odoFix = walk.odo;
      walk.inContact = !!con;
      // pass alerts: T-10 min and at rise
      for (const q of DB.passes) {
        if (q.end < walk.simT || q.start > walk.simT + 620) continue;
        const k10 = q.orbiter + q.start + "a", k0 = q.orbiter + q.start + "b";
        if (walk.simT >= q.start - 600 && walk.simT < q.start && !walk.alerted.has(k10)) { walk.alerted.add(k10); chime(q.orbiter); toast(`${q.orbiter} in ${Math.round((q.start - walk.simT) / 60)} min`, `${Math.round((q.end - q.start) / 60)} min long, ${q.max_el}° max. Get clear of high ground.`, ORB[q.orbiter].c); }
        if (walk.simT >= q.start && !walk.alerted.has(k0)) { walk.alerted.add(k0); if (!con) { chime(q.orbiter, true); toast(`${q.orbiter} rising`, r.contacts.some(k => k.orbiter === q.orbiter && !k.start) ? "Terrain is blocking the link from here." : "Above 10°.", ORB[q.orbiter].c); } }
      }
      dopplerTone(con ? currentPass(walk.simT) : null, walk.simT);
      // draw
      const rad = 3 + DRIFT * (walk.odo - walk.odoFix);
      me.setLatLng(ll(p.x, p.y)); unc.setLatLng(ll(p.x, p.y)); unc.setRadius(rad); ghost.setLatLng(ll(tx, ty));
      unc.setStyle({ color: con ? "#6EE7A8" : "#93B7E6", fillColor: con ? "#6EE7A8" : "#93B7E6" });
      if (walk._painted !== p.i) { walk._painted = p.i; paintRoute(r, p.i, [p.x, p.y]); }
      // HUD
      const nxt = r.stop_idx.find(i => i >= p.i) ?? r.x.length - 1, last = nxt === r.x.length - 1;
      const k = r.stop_idx.slice(1).filter(i => i < p.i).length, total = r.stopsReq.length - 1;
      const j = Math.min(r.x.length - 1, p.i + 3), brg = Math.atan2(r.x[j] - p.x, r.y[j] - p.y) * 180 / Math.PI;
      $("arrow").style.transform = `rotate(${brg - 90}deg)`;
      const dw = r.dwell.find(d => el >= d.t && el < d.t + d.min * 60);
      const home = last && r.stopsReq.at(-1) === HAB;
      $("hudNext").textContent = dw ? "Science stop" : `${home ? "Habitat" : last ? "Last stop" : `Next stop (${total - k - (r.stopsReq.at(-1) === HAB ? 1 : 0)} left)`} · ${fKm(r.d[nxt] - p.d)}`;
      $("hudSub").textContent = dw ? `${Math.ceil((dw.t + dw.min * 60 - el) / 60)} min of sampling left` : `${fDur(r.t[nxt] - el)} to go · home in ${fDur(r.time_s - el)}`;
      $("hudPos").textContent = `±${Math.round(rad)} m`; $("hudPos").style.color = rad > 60 ? "var(--bad)" : rad > 25 ? "var(--warn)" : "var(--ok)";
      const np = DB.passes.find(q => q.start > walk.simT);
      $("hudLink").textContent = con ? `${con.orbiter} ✓` : np ? `${np.orbiter.split(" ").pop()} in ${Math.round((np.start - walk.simT) / 60)} m` : "none";
      $("hudLink").style.color = con ? "var(--ok)" : "var(--ink)";
      $("hudDose").textContent = `${(walk.dose * 1000).toFixed(0)} µSv`;
      if (r.ground_c) $("hudGround").textContent = `${Math.round(r.ground_c[Math.min(p.i, r.ground_c.length - 1)])} °C`;
      // hazard look-ahead (150 m)
      let hz = 0; for (let i = p.i; i < r.x.length && r.d[i] - p.d < 150; i++) hz = Math.max(hz, r.slope[i]);
      if (hz >= 15 && !walk.hzOn) { walk.hzOn = true; toast("Steep ground ahead", `${hz.toFixed(0)}° within 150 m. Slow down.`, "#F0616B"); } else if (hz < 10) walk.hzOn = false;
      if (S.view === "2d" && walk.follow !== false && !map.getBounds().pad(-0.25).contains(ll(p.x, p.y))) map.panTo(ll(p.x, p.y), { animate: true, duration: 0.6 });
      T3.walker = { x: p.x, y: p.y, z: p.z, rad, con, pass: con ? currentPass(walk.simT) : null };
      if (el >= r.time_s) endWalk(`Back at the habitat after ${fDur(walk.simT - (S.route.depart))}. Dose ${(walk.dose * 1000).toFixed(0)} µSv (model).`);
    }
    // 4 Hz UI refresh
    if (!tick.n || now - tick.n > 250) {
      tick.n = now;
      const t = clockT(), s = sunAt(t);
      $("clock").innerHTML = `<span class="dt">${fDay(t)} </span>${fUTC(t)}:${pad(Math.floor(t) % 60)} UTC`;
      $("clockSub").textContent = (walk.on ? `EVA +${fCD(t - S.route.depart)} · ` : "") + (s.el > 0 ? `Sun ${s.el.toFixed(0)}° up` : "Night here");
      drawRelay(); drawTimeline(); if (walk.on) drawProfile(); liveAlerts();
      if ((S.layers.has("sun") || S.layers.has("heat")) && Math.floor(t / 600) !== walk.lastSun) { walk.lastSun = Math.floor(t / 600); syncLayers(); }
      T3.sun = s;
    }
    if (S.view === "3d") T3.render();
  }

  /* ---------- 3D terrain ---------- */
  const T3 = { dirty: true, ready: false, walker: null, sun: { az: 180, el: 45 } };
  T3.init = function () {
    const cv = $("view3d"), EX = 2, K = M.width_m / 30276;      // K: everything sized for Jezero, scaled to this map
    const rn = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); rn.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); rn.outputEncoding = THREE.sRGBEncoding;
    const sc = new THREE.Scene(); sc.background = new THREE.Color(0x05060A); sc.fog = new THREE.Fog(0x1a120c, 22000 * K, 60000 * K);
    const cam = new THREE.PerspectiveCamera(42, 1, 10 * K, 120000 * K);
    const ctl = new THREE.OrbitControls(cam, cv); ctl.enableDamping = true; ctl.maxPolarAngle = Math.PI * 0.49; ctl.minDistance = 300 * K; ctl.maxDistance = 45000 * K;
    const P = (x, y, z) => new THREE.Vector3(x - M.width_m / 2, (z - M.zmin) * EX, -(y - M.height_m / 2));
    ctl.target.copy(P(HAB[0] - 1500 * K, HAB[1] + 800 * K, elevAt(...HAB))); cam.position.copy(P(HAB[0] + 3500 * K, HAB[1] - (K > 2 ? 9000 : 6500) * K, elevAt(...HAB) + (K > 2 ? 4500 : 1700) * K));   // big regions: start higher
    const nx = 532, ny = 504, geo = new THREE.PlaneGeometry(M.width_m, M.height_m, nx, ny); geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let iy = 0; iy <= ny; iy++) for (let ix = 0; ix <= nx; ix++) {
      const c = Math.min(W - 1, Math.round(ix / nx * (W - 1))), r = Math.min(H - 1, Math.round(iy / ny * (H - 1)));
      pos.setY(iy * (nx + 1) + ix, (ELEV[r * W + c] * M.elev_scale - M.zmin) * EX);
    }
    geo.computeVertexNormals();
    const tc = document.createElement("canvas"); tc.width = 2660; tc.height = 2520;
    const tex = new THREE.CanvasTexture(tc); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = rn.capabilities.getMaxAnisotropy();
    sc.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex })));
    const sun = new THREE.DirectionalLight(0xffe2c4, 1.1), amb = new THREE.AmbientLight(0xb0a8a0, 0.55); sc.add(sun, amb);
    const baseImg = new Image(); baseImg.src = M.basemap_3d; baseImg.onload = () => T3.dirty = true;
    const imgs = {};
    let tube = null;
    const wk = new THREE.Group(); sc.add(wk); wk.visible = false;
    const pin = new THREE.Mesh(new THREE.ConeGeometry(45 * K, 160 * K, 16), new THREE.MeshBasicMaterial({ color: 0xffffff })); pin.rotation.x = Math.PI; pin.position.y = 90 * K; wk.add(pin);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: 0x93B7E6, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 12; wk.add(ring);
    const beamG = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    const beam = new THREE.Line(beamG, new THREE.LineBasicMaterial({ color: 0x6EE7A8 })); sc.add(beam); beam.visible = false;
    const sat = new THREE.Mesh(new THREE.SphereGeometry(140 * K, 12, 12), new THREE.MeshBasicMaterial({ color: 0x6EE7A8 })); sc.add(sat); sat.visible = false;
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
      if (tube) { sc.remove(tube); tube.geometry.dispose(); tube = null; }
      const r = walk.on ? walk.route : S.route;
      if (r && r.x.length > 2) {
        const step = Math.max(1, Math.floor(r.x.length / 500)), pts = [];
        for (let i = 0; i < r.x.length; i += step) pts.push(P(r.x[i], r.y[i], r.z[i] + 14 * K));
        pts.push(P(r.x.at(-1), r.y.at(-1), r.z.at(-1) + 14 * K));
        tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 16 * K, 6), new THREE.MeshBasicMaterial({ color: 0xDDB78F }));
        sc.add(tube);
      }
    }
    T3.render = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * rn.getPixelRatio())) { rn.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
      if (T3.dirty) { T3.dirty = false; paint(); }
      const a = T3.sun.az * Math.PI / 180, e = Math.max(T3.sun.el, 2) * Math.PI / 180;
      sun.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).multiplyScalar(1000);
      const day = Math.max(0, Math.min(1, T3.sun.el / 15)); sun.intensity = 1.15 * day; amb.intensity = 0.22 + 0.4 * day;
      const k = T3.walker; wk.visible = walk.on && !!k; beam.visible = sat.visible = false;
      if (wk.visible) {
        const p = P(k.x, k.y, k.z); wk.position.copy(p); ring.scale.setScalar(Math.max(k.rad, 25 * K)); ring.material.color.set(k.con ? 0x6EE7A8 : 0x93B7E6);
        if (k.pass) {
          const s = sampleAt(k.pass, walk.simT), az = s[1] * Math.PI / 180, el = s[2] * Math.PI / 180, far = 9000 * K;
          const q = p.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(far));
          beamG.setFromPoints([p.clone().setY(p.y + 100 * K), q]); sat.position.copy(q);
          const col = new THREE.Color(ORB[k.pass.orbiter].c); beam.material.color = col; sat.material.color = col; beam.visible = sat.visible = true;
        }
        if (walk.follow !== false) ctl.target.lerp(p, 0.05);
      }
      ctl.update(); rn.render(sc, cam);
    };
    T3.ready = true;
  };
  function setView(v) {
    S.view = v; $("v-2d").setAttribute("aria-pressed", v === "2d"); $("v-3d").setAttribute("aria-pressed", v === "3d");
    $("view3d").hidden = v !== "3d"; $("map").style.visibility = v === "3d" ? "hidden" : "visible";
    if (v === "3d") { if (!T3.ready) T3.init(); T3.dirty = true; }
  }
  T3.render = () => {};

  /* ---------- controls ---------- */
  $("v-2d").onclick = () => setView("2d"); $("v-3d").onclick = () => setView("3d");
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
  }
  document.querySelectorAll(".style").forEach(b => b.onclick = () => applyStyle(b.dataset.s));
  function setDepart(min) {
    S.departOff = Math.max(0, Math.min(1440, min)); $("depart").value = S.departOff;
    $("departTxt").textContent = S.departOff === 0 ? "Leave now" : `Leave in ${fDur(S.departOff * 60)}`;
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
  document.querySelectorAll(".lay").forEach(b => b.onclick = () => { const n = b.dataset.l; S.layers.has(n) ? S.layers.delete(n) : S.layers.add(n); b.setAttribute("aria-pressed", S.layers.has(n)); syncLayers(); });
  $("o-op").textContent = "80%";
  $("opacity").oninput = e => { S.opacity = +e.target.value; $("o-op").textContent = Math.round(S.opacity * 100) + "%"; syncLayers(); };
  document.querySelectorAll(".spd").forEach(b => b.onclick = () => { S.speed = +b.dataset.s; document.querySelectorAll(".spd").forEach(x => x.setAttribute("aria-pressed", x === b)); });
  const tog = (id, key, fn) => $(id).onclick = e => { S[key] = !S[key]; e.target.setAttribute("aria-pressed", S[key]); fn && fn(); };
  tog("sound", "sound", () => { if (S.sound) { audio().resume(); chime("MRO"); } });
  tog("doppler", "doppler", () => { if (S.doppler) audio().resume(); });
  tog("truth", "truth", () => { if (walk.on) S.truth ? ghost.addTo(map) : map.removeLayer(ghost); });
  $("walkBtn").onclick = () => walk.on ? endWalk() : startWalk();
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

  /* ---------- phone layout ---------- */
  const mq = matchMedia("(max-width: 980px)");
  const sheet = { cur: "" };
  function openSheet(p) {
    sheet.cur = p || ""; document.body.dataset.sheet = sheet.cur;
    document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-pressed", b.dataset.p === sheet.cur));
    if (p) requestAnimationFrame(() => { drawTimeline(); drawProfile(); });
  }
  function closeSheet() { openSheet(""); }
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => openSheet(sheet.cur === b.dataset.p ? "" : b.dataset.p));
  document.querySelectorAll(".grab").forEach(g => g.onclick = closeSheet);
  $("fab").onclick = () => $("walkBtn").click();
  function layoutPhone() {
    if (mq.matches) { $("slotTimeline").append($("boxTimeline")); $("slotProfile").append($("boxProfile")); }
    else { $("strip").append($("boxTimeline"), $("boxProfile")); closeSheet(); }
    map.invalidateSize(); drawTimeline(); drawProfile();
  }
  mq.addEventListener("change", layoutPhone);
  const coach = $("coach");
  function dismissCoach() { coach.hidden = true; try { localStorage.setItem("mw_coach", "1"); } catch (e) { /* private mode */ } }
  $("coachOk").onclick = dismissCoach;
  try { coach.hidden = !!localStorage.getItem("mw_coach") || SITE !== "jezero"; } catch (e) { coach.hidden = false; }
  if (mq.matches) $("stopHint").textContent = "Tap the map to add a science stop. Drag a stop to move it.";

  applyStyle("safe", false);
  layoutPhone();
  setDepart(0); syncLayers(); drawRelay();
  requestAnimationFrame(tick);
})().catch(e => { document.getElementById("loader").textContent = "Failed to load: " + e.message; console.error(e); });
