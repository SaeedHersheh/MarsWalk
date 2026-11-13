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
    if (!r) { $("verdict").innerHTML = ""; $("mix").innerHTML = ""; $("stats").innerHTML = ""; $("moreStats").innerHTML = ""; $("warns").innerHTML = ""; $("contacts").innerHTML = ""; drawProfile(); drawTimeline(); return; }
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
      st("Walking time", (r.time_s / 3600).toFixed(1), "h", r.time_s > 8 * 3600 ? "bad" : "") +
      st("Radiation", (r.dose_msv * 1000).toFixed(0), "µSv") +
      st("Radio contact", r.contact_min, "min", r.contact_min ? "ok" : "bad");
    $("moreStats").innerHTML =
      st("Climb", Math.round(r.climb_m), "m") +
      (r.ground_c ? st("Ground", `${Math.round(r.ground_min_c)}…${Math.round(r.ground_max_c)}`, "°C", r.ground_min_c < -80 ? "bad" : "") : "") +
      st("Longest silence", (r.longest_gap_s / 3600).toFixed(1), "h", r.longest_gap_s > 4 * 3600 ? "bad" : "");
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
  $("logBtn").onclick = e => { e.stopPropagation(); const open = $("logPanel").hidden; $("logPanel").hidden = !open; $("logBtn").setAttribute("aria-expanded", String(open)); if (open) logNew = 0; renderLog(); };
  addEventListener("click", e => { if (!$("logPanel").hidden && !e.target.closest("#logPanel")) { $("logPanel").hidden = true; $("logBtn").setAttribute("aria-expanded", "false"); } });

  /* ---------- walk simulation ---------- */
  const me = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 900 });
  const ghost = L.marker(ll(...HAB), { icon: L.divIcon({ className: "", html: '<div class="ghost"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }), interactive: false, zIndexOffset: 800 }).bindTooltip("true position", { permanent: false });
  const unc = L.circle(ll(...HAB), { radius: 3, color: "#93B7E6", weight: 1.5, fillColor: "#93B7E6", fillOpacity: 0.16, interactive: false });
  function startWalk() {
    if (!S.route) return;
    Object.assign(walk, { on: true, route: S.route, t0: departT(), simT: departT(), odo: 0, odoFix: 0, theta: Math.random() * 6.28,
      drift: [0, 0], dAlong: 0, _i: 0, follow: true, busy: false, hzOn: false, zNow: S.route.z[0], inContact: false, alerted: new Set(), dose: 0, lastSun: 0, last: performance.now(), dwellSaid: -1 });
    Object.assign(walk, { manual: false, fixKey: null, fxN: "", sig: 3, rest: [], hd: 0, still: true, keys: {}, lastRe: 0 }); syncDrive();
    me.addTo(map); unc.addTo(map); if (S.truth) ghost.addTo(map);
    walk._painted = -1;
    if (S.view === "3d") { T3.chase = true; $("t3follow").setAttribute("aria-pressed", "true"); }
    $("hud").hidden = false; $("homeBtn").disabled = false; syncWalk(); closeSheet();
    $("depart").disabled = true; drawStops();
    toast("EVA started", `Leaving habitat ${fUTC(walk.t0)} UTC. No GPS: dead reckoning until the next relay pass.`, "#8ab8ff");
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
    walk.on = false; walk.manual = false; syncDrive(); [me, unc, ghost].forEach(l => map.removeLayer(l));
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
  /* Position from the relay link. The radio measures range and range rate (Doppler) to the orbiter once a minute;
     here those numbers are simulated from the true position with noise, then solved by least squares (relayfix.js).
     Orbiter geometry is the real JPL Horizons pass. Height comes from the terrain map. */
  function relayFix(tx, ty, gx, gy) {
    const t = walk.simT, q = currentPass(t); if (!q || !window.RelayFix) return null;
    const sm = q.samples; let i0 = sm.findIndex(v => v[0] >= q.start), i1 = -1;
    for (let i = 0; i < sm.length; i++) if (sm[i][0] <= t) i1 = i;
    if (i0 < 0 || i1 - i0 < 2) return null;
    const u = (elevAt(tx, ty) ?? 0) - (elevAt(...HAB) ?? 0);
    const fx = RelayFix.solve(sm, i0, i1, { e: tx - HAB[0], n: ty - HAB[1], u }, { e: gx - HAB[0], n: gy - HAB[1] });
    if (!fx || !isFinite(fx.e) || !isFinite(fx.sigma)) return null;
    return { x: fx.e + HAB[0], y: fx.n + HAB[1], sigma: fx.sigma, err: fx.err, used: fx.used, orbiter: q.orbiter, key: q.orbiter + q.start, n: i1 };
  }
  const REACH = Math.max(12, 0.75 * DX);
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
    walk.mx = q.x + walk.drift[0]; walk.my = q.y + walk.drift[1];           // the true position
    walk.drift = [-walk.drift[0], -walk.drift[1]];                          // believed = true + drift
    const j = Math.min(r.x.length - 1, q.i + 3); walk.hd = Math.atan2(r.x[j] - q.x, r.y[j] - q.y) || 0;
    walk.manual = true; walk.still = true; walk.blocked = 0; syncDrive(); T3.dirty = true;
    if (S.speed > 30) { const b30 = document.querySelector('.spd[data-s="30"]'); if (b30) b30.click(); }
    if (S.view === "3d") { T3.chase = true; T3.skyLook = false; $("t3follow").setAttribute("aria-pressed", "true"); }
    toast("Manual control", matchMedia("(pointer: coarse)").matches ? "Use the stick: up to walk, sideways to turn." : "W / S walk, A / D turn (or the arrow keys).", "#8ab8ff");
  }
  async function releaseControl() {
    if (!walk.manual || walk.busy) return;
    const b = [walk.mx + walk.drift[0], walk.my + walk.drift[1]];
    await reroute(b, walk.rest, "Autopilot: route from your last known position.");
    walk.manual = false; T3.dirty = true; walk.dAlong = 0; walk.drift = [-walk.drift[0], -walk.drift[1]]; syncDrive();
  }
  const stick = { x: 0, y: 0 };
  function driveInput() {
    const k = walk.keys || {};
    let turn = (k.d || k.arrowright ? 1 : 0) - (k.a || k.arrowleft ? 1 : 0), fwd = (k.w || k.arrowup ? 1 : 0) - (k.s || k.arrowdown ? 1 : 0);
    if (Math.abs(stick.x) > 0.12 || Math.abs(stick.y) > 0.12) { turn = stick.x; fwd = stick.y; }
    return [turn, fwd];
  }
  function offRoute(r, x, y) { let m = 1e12; for (let i = 0; i < r.x.length; i += 2) { const d = (r.x[i] - x) ** 2 + (r.y[i] - y) ** 2; if (d < m) m = d; } return Math.sqrt(m); }
  function manualStep(dt, now) {
    const r = walk.route, [turn, fwd] = driveInput(), simDt = dt * S.speed;
    walk.hd += turn * 1.9 * dt * (fwd < 0 ? -1 : 1);
    const sl0 = slopeAt(walk.mx, walk.my) ?? 0;
    let step = 0; walk.still = Math.abs(fwd) < 0.05;
    if (!walk.still) {
      const v = 1.25 * Math.max(0.2, 1 - sl0 / 32) * (fwd < 0 ? 0.5 : 1);                   // m/s in a suit, slower on slope
      step = v * Math.abs(fwd) * simDt;
      const sg = Math.sign(fwd), nx = walk.mx + Math.sin(walk.hd) * step * sg, ny = walk.my + Math.cos(walk.hd) * step * sg, sl = slopeAt(nx, ny);
      if (sl == null || nx < DX * 2 || ny < DY * 2 || nx > M.width_m - DX * 2 || ny > M.height_m - DY * 2) { step = 0; if (now - (walk.blocked || 0) > 4000) { walk.blocked = now; toast("Edge of the mapped area", "Turn back.", "#F5B85B"); } }
      else if (sl > 34 && sl > sl0) { step = 0; if (now - (walk.blocked || 0) > 4000) { walk.blocked = now; toast("Too steep", `${sl.toFixed(0)}° ahead. A suited astronaut cannot climb that. Go around.`, "#F0616B"); } }
      else { walk.mx = nx; walk.my = ny; }
      if (!step) walk.still = true;
    }
    walk.odo += step; walk.dose += (r.dose_msv / r.time_s) * simDt;
    walk.theta += (Math.random() - 0.5) * 0.08;                                              // dead reckoning drifts 2 % of distance walked
    walk.drift[0] += Math.cos(walk.theta) * DRIFT * step; walk.drift[1] += Math.sin(walk.theta) * DRIFT * step;
    const z = elevAt(walk.mx, walk.my) ?? walk.zNow; walk.zNow = z;
    // relay: a new measurement every minute of the pass, solved together with the earlier ones
    const q = currentPass(walk.simT); let con = null;
    if (q) {
      con = { orbiter: q.orbiter, start: q.start, end: q.end };
      const fx = relayFix(walk.mx, walk.my, walk.mx + walk.drift[0], walk.my + walk.drift[1]);
      if (fx && walk.fxN !== fx.key + fx.n && fx.sigma < 60) {
        walk.fxN = fx.key + fx.n;
        const was = Math.hypot(...walk.drift);
        walk.drift = [fx.x - walk.mx, fx.y - walk.my]; walk.sig = Math.max(2, fx.sigma); walk.odoFix = walk.odo;
        if (walk.fixKey !== fx.key) {
          walk.fixKey = fx.key; chime(q.orbiter, true);
          reroute([fx.x, fx.y], walk.rest, `${q.orbiter} position fix (${fx.used} range and Doppler measurements, ±${fx.sigma.toFixed(0)} m). Dead reckoning was ${Math.round(was)} m out. New route from where you really are.`);
          walk.lastRe = now;
        }
      }
    }
    walk.inContact = !!con; walk.link = con ? { orbiter: con.orbiter, end: con.end } : null;
    for (const p2 of DB.passes) {
      if (p2.end < walk.simT || p2.start > walk.simT + 620) continue;
      const k10 = p2.orbiter + p2.start + "a";
      if (walk.simT >= p2.start - 600 && walk.simT < p2.start && !walk.alerted.has(k10)) { walk.alerted.add(k10); chime(p2.orbiter); toast(`${p2.orbiter} in ${Math.round((p2.start - walk.simT) / 60)} min`, "Position fix and radio when it rises.", ORB[p2.orbiter].c); }
    }
    dopplerTone(con ? q : null, walk.simT);
    const bx = walk.mx + walk.drift[0], by = walk.my + walk.drift[1], rad = (walk.sig || 3) + DRIFT * (walk.odo - walk.odoFix);
    // waypoints are reached with the feet, not with the estimate
    if (walk.rest.length && Math.hypot(walk.rest[0][0] - walk.mx, walk.rest[0][1] - walk.my) < REACH) {
      const home = walk.rest[0] === HAB; walk.rest.shift();
      if (!walk.rest.length) { T3.walker = null; endWalk(`${home ? "Back at the habitat" : "Final waypoint reached"} under manual control. Dose ${(walk.dose * 1000).toFixed(0)} µSv (model).`); return; }
      toast("Waypoint reached", `${walk.rest.length} to go.`, "#6EE7A8"); walk.lastRe = 0;
    }
    // newest best path: whenever the estimate has left the line, plan again from the estimate
    if (con && walk.fixKey === con.orbiter + con.start && !walk.busy && now - (walk.lastRe || 0) > 6000 && walk.rest.length && offRoute(r, bx, by) > Math.max(70, 3 * DX)) {
      walk.lastRe = now;
      reroute([bx, by], walk.rest, `${con.orbiter} fix: new best route from your position (±${Math.round(rad)} m).`);
    }
    me.setLatLng(ll(bx, by)); unc.setLatLng(ll(bx, by)); unc.setRadius(rad); ghost.setLatLng(ll(walk.mx, walk.my));
    unc.setStyle({ color: con ? "#6EE7A8" : "#93B7E6", fillColor: con ? "#6EE7A8" : "#93B7E6" });
    if (walk._painted !== -2) { walk._painted = -2; paintRoute(walk.route, 0); }
    const tgt = walk.rest[0], dist = tgt ? Math.hypot(tgt[0] - bx, tgt[1] - by) : 0, brg = tgt ? Math.atan2(tgt[0] - bx, tgt[1] - by) : 0;
    $("arrow").style.transform = `rotate(${(brg - walk.hd) * 180 / Math.PI - 90}deg)`;
    $("hudNext").textContent = `${tgt === HAB ? "Habitat" : "Waypoint"} · ${fKm(dist)}`;
    $("hudSub").textContent = `Slope here ${sl0.toFixed(0)}° · ${walk.rest.length} stop${walk.rest.length === 1 ? "" : "s"} left`;
    $("hudPos").textContent = `±${Math.round(rad)} m`; $("hudPos").style.color = rad > 60 ? "var(--bad)" : rad > 25 ? "var(--warn)" : "var(--ok)";
    const np = DB.passes.find(p2 => p2.start > walk.simT);
    $("hudLink").textContent = con ? `${con.orbiter} ✓` : np ? `${np.orbiter.split(" ").pop()} in ${Math.round((np.start - walk.simT) / 60)} m` : "none";
    $("hudLink").style.color = con ? "var(--ok)" : "var(--ink)";
    $("hudDose").textContent = `${(walk.dose * 1000).toFixed(0)} µSv`;
    if (S.view === "2d" && !map.getBounds().pad(-0.25).contains(ll(walk.mx, walk.my))) map.panTo(ll(walk.mx, walk.my), { animate: true, duration: 0.4 });
    T3.walker = { x: walk.mx, y: walk.my, z, rad, con, pass: con ? q : null, hdx: Math.sin(walk.hd), hdy: Math.cos(walk.hd), d: 0, still: walk.still, bx, by, manual: true };
  }
  addEventListener("keydown", e => {
    const k = e.key.toLowerCase(); if (!["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) return;
    if (/^(input|textarea|select)$/i.test(e.target.tagName) || !walk.on) return;
    e.preventDefault(); if (!walk.manual) takeControl(); walk.keys[k] = true;
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
    const dtReal = Math.min(0.5, (now - (walk.last || now)) / 1000); walk.last = now;
    if (walk.on && !walk.busy) {
      walk.simT += dtReal * S.speed;
      if (walk.manual) manualStep(dtReal, now); else {
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
      const pk = con ? con.orbiter + con.start : null;
      if (con && walk.fixKey !== pk) {
        const fx = relayFix(tx, ty, p.x, p.y);                 // least-squares fix from range + Doppler to the orbiter
        if (fx && fx.sigma < 40) {
          walk.fixKey = pk; const off = Math.hypot(...walk.drift);
          chime(con.orbiter, true);
          const k = r.stop_idx.slice(1).filter(i => i <= p.i).length, rest = r.stopsReq.slice(1 + k);
          if (off > 20 && rest.length) reroute([fx.x, fx.y], rest, `${con.orbiter} position fix (${fx.used} range and Doppler measurements, ±${fx.sigma.toFixed(0)} m): you were ${Math.round(off)} m off the line. New route from the fixed position.`);
          else toast("Position fix", `${con.orbiter}: ${fx.used} range and Doppler measurements, ±${fx.sigma.toFixed(0)} m. Drift was ${Math.round(off)} m.`, ORB[con.orbiter].c);
          walk.odoFix = walk.odo; walk.drift = [0, 0]; walk.sig = Math.max(2, fx.sigma);
        }
      }
      if (con && walk.fixKey === pk) walk.odoFix = walk.odo;
      walk.inContact = !!con; walk.link = con ? { orbiter: con.orbiter, end: con.end } : null;
      // pass alerts: T-10 min and at rise
      for (const q of DB.passes) {
        if (q.end < walk.simT || q.start > walk.simT + 620) continue;
        const k10 = q.orbiter + q.start + "a", k0 = q.orbiter + q.start + "b";
        if (walk.simT >= q.start - 600 && walk.simT < q.start && !walk.alerted.has(k10)) { walk.alerted.add(k10); chime(q.orbiter); toast(`${q.orbiter} in ${Math.round((q.start - walk.simT) / 60)} min`, `${Math.round((q.end - q.start) / 60)} min long, ${q.max_el}° max. Get clear of high ground.`, ORB[q.orbiter].c); }
        if (walk.simT >= q.start && !walk.alerted.has(k0)) { walk.alerted.add(k0); if (!con) { chime(q.orbiter, true); toast(`${q.orbiter} rising`, r.contacts.some(k => k.orbiter === q.orbiter && !k.start) ? "Terrain is blocking the link from here." : "Above 10°.", ORB[q.orbiter].c); } }
      }
      dopplerTone(con ? currentPass(walk.simT) : null, walk.simT);
      // draw
      const rad = (walk.sig || 3) + DRIFT * (walk.odo - walk.odoFix);
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
      $("hudNext").textContent = dw ? "Sampling" : `${home ? "Habitat" : last ? "Final waypoint" : `Next waypoint (${total - k - (r.stopsReq.at(-1) === HAB ? 1 : 0)} left)`} · ${fKm(r.d[nxt] - p.d)}`;
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
      T3.walker = { x: p.x, y: p.y, z: p.z, rad, con, pass: con ? currentPass(walk.simT) : null, hdx: r.x[j] - p.x, hdy: r.y[j] - p.y, d: p.d };
      if (el >= r.time_s) endWalk(`Back at the habitat after ${fDur(walk.simT - (S.route.depart))}. Dose ${(walk.dose * 1000).toFixed(0)} µSv (model).`);
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
    function chaseBase() { return 6.5 * Math.pow(walk.on ? Math.max(1, S.speed) : 1, 0.55) * (cam.aspect < 1 ? 1.25 : 1); }
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
      const g = new THREE.Group(), ud = g.userData;
      const suit = pbr({ color: 0xeceff2, roughness: 0.74, bumpMap: WEAVE, bumpScale: 0.004, envMapIntensity: 0.55 });
      const dusty = pbr({ color: 0xcfc3b4, roughness: 0.88, bumpMap: WEAVE, bumpScale: 0.004, envMapIntensity: 0.4 });
      const metal = pbr({ color: 0xb4bcc3, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 });
      const rubber = pbr({ color: 0x1d2024, roughness: 0.92 });
      const visorM = pbr({ color: 0xd9a63b, roughness: 0.04, metalness: 1.0, envMapIntensity: 1.8 });
      const led = pbr({ color: 0x5fb3a8, roughness: 0.4, emissive: 0x1f5a53, emissiveIntensity: 0.9 });
      // hard upper torso, waist bearing, shoulder dome
      mk(g, new THREE.CylinderGeometry(0.30, 0.265, 0.60, 32), suit, 0, 1.45, 0);
      const dome = mk(g, new THREE.SphereGeometry(0.30, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), suit, 0, 1.75, 0); dome.scale.set(1, 0.5, 0.9);
      mk(g, new THREE.CylinderGeometry(0.255, 0.24, 0.17, 28), suit, 0, 1.04, 0);
      mk(g, new THREE.TorusGeometry(0.255, 0.03, 10, 32), metal, 0, 1.14, 0).rotation.x = Math.PI / 2;
      mk(g, new THREE.TorusGeometry(0.195, 0.032, 10, 28), metal, 0, 1.89, 0).rotation.x = Math.PI / 2;
      // helmet: shell, gold visor, brow lamps, camera
      mk(g, new THREE.SphereGeometry(0.265, 40, 28), suit, 0, 2.08, 0);
      mk(g, new THREE.SphereGeometry(0.273, 40, 28, Math.PI / 2 - 0.95, 1.9, Math.PI * 0.30, Math.PI * 0.40), visorM, 0, 2.08, 0);
      for (const sx of [-1, 1]) mk(g, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), metal, sx * 0.17, 2.27, 0.15).rotation.x = Math.PI / 2.6;
      mk(g, new THREE.BoxGeometry(0.06, 0.05, 0.07), rubber, 0.21, 2.2, 0.08);
      // chest control unit and life-support backpack
      mk(g, new THREE.BoxGeometry(0.25, 0.17, 0.07), metal, 0, 1.52, 0.30);
      mk(g, new THREE.BoxGeometry(0.17, 0.04, 0.012), led, 0, 1.56, 0.337);
      mk(g, new THREE.BoxGeometry(0.46, 0.64, 0.25), suit, 0, 1.50, -0.33);
      mk(g, new THREE.BoxGeometry(0.40, 0.17, 0.05), metal, 0, 1.68, -0.47);
      for (const sx of [-1, 1]) mk(g, new THREE.CylinderGeometry(0.06, 0.06, 0.42, 16), metal, sx * 0.13, 1.40, -0.49);
      mk(g, new THREE.CylinderGeometry(0.008, 0.008, 0.46, 6), metal, 0.18, 1.98, -0.38);
      // arms: shoulder -> upper arm -> elbow -> forearm -> glove
      const arm = (sx, name) => {
        const sh = new THREE.Group(); sh.position.set(sx * 0.37, 1.70, 0); g.add(sh);
        mk(sh, new THREE.SphereGeometry(0.115, 18, 14), suit, 0, 0, 0);
        mk(sh, new THREE.CylinderGeometry(0.097, 0.083, 0.30, 18), suit, 0, -0.17, 0);
        const el = new THREE.Group(); el.position.y = -0.33; sh.add(el);
        mk(el, new THREE.SphereGeometry(0.088, 16, 12), metal, 0, 0, 0);
        mk(el, new THREE.CylinderGeometry(0.083, 0.072, 0.27, 18), suit, 0, -0.15, 0);
        mk(el, new THREE.TorusGeometry(0.075, 0.017, 8, 18), metal, 0, -0.29, 0).rotation.x = Math.PI / 2;
        mk(el, new THREE.BoxGeometry(0.11, 0.13, 0.08), rubber, 0, -0.38, 0);
        ud["arm" + name] = sh; ud["elbow" + name] = el;
      };
      arm(-1, "L"); arm(1, "R");
      // legs: hip -> thigh -> knee -> shin -> boot
      const leg = (sx, name) => {
        const hip = new THREE.Group(); hip.position.set(sx * 0.14, 0.96, 0); g.add(hip);
        mk(hip, new THREE.CylinderGeometry(0.138, 0.112, 0.43, 20), suit, 0, -0.215, 0);
        const kn = new THREE.Group(); kn.position.y = -0.43; hip.add(kn);
        mk(kn, new THREE.SphereGeometry(0.108, 16, 12), metal, 0, 0, 0);
        mk(kn, new THREE.CylinderGeometry(0.112, 0.097, 0.43, 20), dusty, 0, -0.215, 0);
        mk(kn, new THREE.BoxGeometry(0.165, 0.115, 0.32), dusty, 0, -0.475, 0.06);
        mk(kn, new THREE.BoxGeometry(0.17, 0.03, 0.33), rubber, 0, -0.53, 0.06);
        ud["leg" + name] = hip; ud["knee" + name] = kn;
      };
      leg(-1, "L"); leg(1, "R");
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
    const AS = 1.9 / 2.35, HS = 4.2, SSC = 430 * K, IDLE = [HAB[0] + 3.2, HAB[1] - 9.5];
    const astro = makeAstronaut(); astro.scale.setScalar(AS); sc.add(astro);
    const astroTag = labelSprite("Astronaut", "#8ab8ff"); sc.add(astroTag);
    const hab = makeHab(); hab.scale.setScalar(HS); hab.position.copy(P(HAB[0], HAB[1], 0)); hab.position.y = ground(HAB[0], HAB[1]); sc.add(hab);
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
        if (x < 1 || y < 1 || x > M.width_m - 1 || y > M.height_m - 1 || Math.hypot(x - mx, y - my) > R || Math.hypot(x - HAB[0], y - HAB[1]) < 14) continue;
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

    let pathW = 0;
    function buildPath() {
      if (tube) { sc.remove(tube); tube.geometry.dispose(); tube = null; }
      const r = walk.on ? walk.route : S.route; if (!r || r.x.length < 2) return;
      const w = pathW || 22 * K, lift = 0.04 + w * 0.02, cw = M.width_m / nx, ch = M.height_m / ny, px = [], py = [], pn = [];
      for (let i = 0; i < r.x.length - 1; i++) {                                 // a point wherever the route crosses an edge of the terrain mesh, so the ribbon never dips under it
        const ax = r.x[i] / cw, ay = (M.height_m - r.y[i]) / ch, bx = r.x[i + 1] / cw, by = (M.height_m - r.y[i + 1]) / ch, ts = [0];
        const cuts = (a, b) => { if (a === b) return; for (let k2 = Math.ceil(Math.min(a, b)); k2 <= Math.max(a, b); k2++) { const t = (k2 - a) / (b - a); if (t > 1e-4 && t < 1 - 1e-4) ts.push(t); } };
        cuts(ax, bx); cuts(ay, by); cuts(ax + ay, bx + by); ts.sort((u1, u2) => u1 - u2);
        for (const t of ts) { px.push(r.x[i] + (r.x[i + 1] - r.x[i]) * t); py.push(r.y[i] + (r.y[i + 1] - r.y[i]) * t); pn.push(i); }
      }
      px.push(r.x.at(-1)); py.push(r.y.at(-1)); pn.push(r.x.length - 1);
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
      dismissCoach(); S.stops.push([h.x, h.y]); plan(); toast("Waypoint added", `Waypoint ${S.stops.length} added. Select the terrain again to add another.`, "#8ab8ff");
    });
    cv.addEventListener("pointermove", e => {
      const now = performance.now(); if (now - (T3.hv || 0) < 120 || e.buttons) return; T3.hv = now;
      const h = pickTerrain(e); if (!h) return;
      const [lo, la] = lonLat(h.x, h.y), z = elevAt(h.x, h.y), sl = slopeAt(h.x, h.y);
      $("rLat").textContent = la.toFixed(4) + "° N"; $("rLon").textContent = lo.toFixed(4) + "° E"; $("rEl").textContent = z == null ? "—" : Math.round(z) + " m"; $("rSl").textContent = sl == null ? "—" : sl.toFixed(1) + "°";
    });

    T3.api = {
      lookSat: () => { if (!T3.satDir) return; T3.chase = false; $("t3follow").setAttribute("aria-pressed", "false"); const h0 = T3.herePos, d = T3.satDir.clone(), flat = d.clone().setY(0); if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1); flat.normalize(); T3.skyLook = true; cam.position.copy(h0).addScaledVector(flat, -600 * K); cam.position.y += 250 * K; ctl.target.copy(cam.position).addScaledVector(d, 2600 * K); },
      setLite: v => {
        lite = v; T3.lite = v; try { localStorage.setItem("mw_lite", v ? "1" : "0"); } catch (e) { /* ignore */ }
        rn.shadowMap.enabled = !v; sun.castShadow = !v; sc.environment = v ? null : envTex;
        sc.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
      },
      zoom: f => { if (T3.chase) { T3.chaseK = Math.min(14, Math.max(0.35, (T3.chaseK || 1) * f)); return; } const d = cam.position.clone().sub(ctl.target).multiplyScalar(f); cam.position.copy(ctl.target).add(d); },
      reset: () => { T3.skyLook = false; homeCam(); }, top: () => { T3.skyLook = false; const t = ctl.target; cam.position.set(t.x, t.y + 14000 * K, t.z + 1); },
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
      if (walking) {
        if (Math.hypot(k.hdx, k.hdy) > 1e-6) astro.rotation.y = Math.atan2(k.hdx, -k.hdy);
        if (!walk.busy && !k.still) T3.phase = (T3.phase || 0) + dtr * 6.2;
        const sw = k.still ? 0 : Math.sin(T3.phase);
        u.legL.rotation.x = sw * 0.62; u.legR.rotation.x = -sw * 0.62;
        u.kneeL.rotation.x = Math.max(0, sw) * 0.95; u.kneeR.rotation.x = Math.max(0, -sw) * 0.95;
        u.armL.rotation.x = -sw * 0.5; u.armR.rotation.x = sw * 0.5; u.elbowL.rotation.x = u.elbowR.rotation.x = -0.45;
        if (!k.still) astro.position.y += Math.abs(Math.cos(T3.phase)) * 0.04;
      } else { astro.rotation.y = 0.5; for (const n of ["legL", "legR", "kneeL", "kneeR", "armL", "armR"]) u[n].rotation.x = 0; u.elbowL.rotation.x = u.elbowR.rotation.x = -0.18; }
      const camD = cam.position.distanceTo(here);
      const camH = cam.position.distanceTo(hab.position), nearHab = here.distanceTo(hab.position) < camH * 0.07;
      astroTag.position.copy(here); astroTag.position.y += 2.25; astroTag.visible = camD > 40 && !(nearHab && !walking);
      habTag.visible = camH > 110 && !(nearHab && walking);
      wk.visible = walking;
      if (walking) {
        wk.position.copy(k.bx != null ? P(k.bx, k.by, 0).setY(ground(k.bx, k.by)) : here);
        const rr = Math.max(k.rad, 1.2); ring.scale.setScalar(rr); ring.position.y = 0.05 + rr * 0.012; ring.material.color.set(k.con ? 0x6EE7A8 : 0x93B7E6);
        beacon.visible = camD > 700;                                                 // a locator beam, only from far away
      }
      // zoom-dependent detail: near plane, shadow box, rocks and the width of the painted route
      const cd = cam.position.distanceTo(ctl.target);
      const nr = Math.min(10 * K, Math.max(0.12, cd * 0.03)); if (Math.abs(nr - cam.near) > cam.near * 0.15) { cam.near = nr; cam.updateProjectionMatrix(); }
      const shW = Math.min(1700 * K, Math.max(16, cd * 1.5));
      if (Math.abs(shW - shNow) > shNow * 0.2) { shNow = shW; Object.assign(sun.shadow.camera, { left: -shW, right: shW, top: shW, bottom: -shW }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.normalBias = Math.max(0.02, 3 * shW / 1700); }
      if (cd < 700) { const mx = ctl.target.x + M.width_m / 2, my = M.height_m / 2 - ctl.target.z; if (!rockAt || Math.hypot(mx - rockAt[0], my - rockAt[1]) > Math.max(RCELL * 2, cd * 0.25) || cd > rockAt[2] * 1.3 || cd < rockAt[2] / 1.3) scatter(mx, my, cd); rocks.visible = true; } else rocks.visible = false;
      const pw = Math.min(40 * K, Math.max(0.22, cd * 0.012)); if (!pathW || pw > pathW * 1.35 || pw < pathW / 1.35) { pathW = pw; buildPath(); }

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

      // camera: free, or following from behind at a distance that suits the time rate
      if (T3.chase && !T3.drag) {
        const dist = chaseBase() * (T3.chaseK || 1);
        if (walking) { const d = new THREE.Vector3(k.hdx, 0, -k.hdy); if (d.lengthSq() > 1e-9) { d.normalize(); T3.dir = d; } }
        const back = walking ? (T3.dir || new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(-Math.sin(0.5), 0, -Math.cos(0.5));   // idle: stand in front of the astronaut, habitat behind
        const want = here.clone().addScaledVector(back, -dist); want.y = here.y + 1.3 + dist * 0.36;
        const gy = ground(Math.min(M.width_m, Math.max(0, want.x + M.width_m / 2)), Math.min(M.height_m, Math.max(0, M.height_m / 2 - want.z))) + 0.7; if (want.y < gy) want.y = gy;
        cam.position.lerp(want, 1 - Math.exp(-dtr * (walking && k.manual ? 5 : 3.2)));
        ctl.target.lerp(here.clone().setY(here.y + 1.45), 1 - Math.exp(-dtr * 9));
      } else if (walking && walk.follow !== false && !T3.drag && !T3.skyLook) ctl.target.lerp(here, 0.05);
      ctl.maxPolarAngle = T3.skyLook ? Math.PI * 0.95 : Math.PI * 0.49;
      ctl.update(); rn.render(sc, cam);
    };
    T3.ready = true;
  };
  function setView(v) {
    S.view = v; $("v-2d").setAttribute("aria-pressed", v === "2d"); $("v-3d").setAttribute("aria-pressed", v === "3d");
    $("view3d").hidden = v !== "3d"; $("map").style.visibility = v === "3d" ? "hidden" : "visible"; $("tools3d").hidden = v !== "3d";
    if (v === "3d") { if (!T3.ready) T3.init(); T3.dirty = true; $("t3lite").setAttribute("aria-pressed", String(!T3.lite)); }
  }
  T3.render = () => {};

  /* ---------- controls ---------- */
  $("v-2d").onclick = () => setView("2d"); $("v-3d").onclick = () => setView("3d");
  $("t3follow").onclick = e => { T3.skyLook = false; T3.chase = !T3.chase; e.currentTarget.setAttribute("aria-pressed", String(!!T3.chase)); };
  $("t3lite").onclick = e => { if (!T3.api) return; T3.api.setLite(!T3.lite); e.currentTarget.setAttribute("aria-pressed", String(!T3.lite)); };
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
  }
  document.querySelectorAll(".style").forEach(b => b.onclick = () => applyStyle(b.dataset.s));
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
  document.querySelectorAll(".lay").forEach(b => b.onclick = () => { const n = b.dataset.l; S.layers.has(n) ? S.layers.delete(n) : S.layers.add(n); b.setAttribute("aria-pressed", S.layers.has(n)); syncLayers(); });
  $("o-op").textContent = "80%";
  $("opacity").oninput = e => { S.opacity = +e.target.value; $("o-op").textContent = Math.round(S.opacity * 100) + "%"; syncLayers(); };
  { const spds = [...document.querySelectorAll(".spd")], setSpeed = b => { S.speed = +b.dataset.s; spds.forEach(x => x.setAttribute("aria-pressed", x === b)); };
    spds.forEach((b, i) => b.onclick = () => setSpeed(b.getAttribute("aria-pressed") === "true" && matchMedia("(max-width: 980px)").matches ? spds[(i + 1) % spds.length] : b)); }
  const tog = (id, key, fn) => $(id).onclick = e => { S[key] = !S[key]; e.target.setAttribute("aria-pressed", S[key]); fn && fn(); };
  tog("sound", "sound", () => { if (S.sound) { audio().resume(); chime("MRO"); } });
  tog("doppler", "doppler", () => { if (S.doppler) audio().resume(); });
  tog("truth", "truth", () => { if (walk.on) S.truth ? ghost.addTo(map) : map.removeLayer(ghost); });
  $("t3drive").onclick = () => walk.on && walk.manual ? releaseControl() : takeControl();
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

  /* ---------- radio messages: voice and text, relayed only while an orbiter is overhead ---------- */
  const COM = { dest: "earth", q: [], srv: new Map(), off: 0, cfg: null, rec: null, busy: new Set(), last: 0, polled: 0, lid: 0,
    mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext) };
  const QUICK = ["Sample collected", "Terrain is steep, slowing down", "All good, continuing", "Need help"];
  const comTime = () => walk.on ? walk.simT : Date.now() / 1000;                // the walker's clock (simulated during a walk)
  const mmss = s => { s = Math.max(0, Math.round(s)); return s >= 3600 ? fCD(s) : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
  window.MW = { COM, S, walk, T3 };                                                  // debug handle: MW.COM.force = {orbiter, end} holds the link open for testing
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
    if (!linkNow()) toast("Message queued", `No relay orbiter overhead. It leaves on the next pass (${nextPassText().replace("next: ", "")}).`, "#93B7E6");
    commsTick(true);
  }
  async function uplink(m, lk) {
    m.status = "sending";
    try {
      const r = await fetch("/api/comms/send", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "astronaut", to: m.to, kind: m.kind, text: m.text || "", audio_b64: m.audio_b64 || null, mime: m.mime, via: lk.orbiter, speed: S.speed, secs: m.secs || null }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.detail || r.statusText);
      COM.q = COM.q.filter(x => x !== m); COM.srv.set(j.id, j); blip();
      toast(`Uplinked via ${lk.orbiter}`, m.to === "earth" ? `On its way to Earth: ${mmss(j.light_min * 60)} of light time (×${S.speed}).` : "Relayed to the pod.", ORB[lk.orbiter].c);
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
      toast(`Message from ${v.sender === "earth" ? "Earth" : "the pod"}`, v.text || "Voice message", "#6EE7A8"); playMsg(v);
    } finally { COM.busy.delete(m.id); renderMsgs(); }
  }
  function commsTick(force) {
    const now = performance.now(); if (!force && now - COM.last < 1000) return; COM.last = now;
    const lk = linkNow(), was = COM.wasOpen; COM.wasOpen = !!lk;
    if (lk && !was) {                                                           // a relay orbiter just came over: beep, buzz, open the mic
      if (!S.sound) chime(lk.orbiter, true, true);
      if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate([220, 110, 220]);
      toast(`${lk.orbiter} is overhead`, COM.mic ? "Mic is open. Hold the talk button to send a voice message." : "Link open: queued messages are going now.", ORB[lk.orbiter].c);
      openMic();
    }
    if (!lk && was) { closeMic(); toast("Link closed", "Messages now wait for the next pass.", "#93B7E6"); }
    if (lk) {
      COM.q.filter(x => x.status === "queued").forEach(m => uplink(m, lk));                                  // leave as soon as the link opens
      [...COM.srv.values()].filter(m => m.to === "astronaut" && !m.delivered && Date.now() / 1000 + COM.off >= m.arrive).forEach(deliverIncoming);   // replies come down
    }
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
    if (COM.ptt.stream && !linkNow()) closeMic();                              // the link closed while the permission box was open
    renderTalk();
  }
  function closeMic() {
    if (COM.ptt.mr && COM.ptt.mr.state === "recording") COM.ptt.mr.stop();
    if (COM.ptt.stream) { COM.ptt.stream.getTracks().forEach(t => t.stop()); COM.ptt.stream = null; }
    renderTalk();
  }
  async function pttDown(e) {
    if (e && e.cancelable) e.preventDefault();
    if (!linkNow() || COM.ptt.mr) return;
    if (!COM.ptt.stream) await openMic();
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
  function pttUp() { if (COM.ptt.mr && COM.ptt.mr.state === "recording") COM.ptt.mr.stop(); }
  function renderTalk() {
    const b = $("talkBtn"), lk = linkNow(), rec = !!(COM.ptt.mr && COM.ptt.mr.state === "recording"), dest = COM.dest === "earth" ? "Earth" : "the pod";
    b.classList.toggle("ready", !!lk && !rec && COM.mic); b.classList.toggle("live", rec);
    if (!COM.mic) { b.disabled = true; $("talkMain").textContent = "Mic unavailable"; $("talkSub").textContent = "Needs https or localhost (see below)"; return; }
    b.disabled = !lk;
    $("talkMain").textContent = rec ? "Release to send" : lk ? "Hold to transmit" : "Link closed";
    $("talkSub").textContent = rec ? `Sending to ${dest} via ${lk ? lk.orbiter : "the orbiter"}` : lk ? `${lk.orbiter} overhead · mic open · ${fDur(lk.end - comTime())} left` : `No relay orbiter overhead · ${nextPassText()}`;
  }
  const talk = $("talkBtn");
  talk.addEventListener("pointerdown", pttDown);
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => talk.addEventListener(ev, pttUp));
  talk.addEventListener("contextmenu", e => e.preventDefault());
  addEventListener("keydown", e => { if (e.code === "Space" && !e.repeat && !/^(input|textarea|select|button)$/i.test(document.activeElement.tagName)) { e.preventDefault(); pttDown(); } });
  addEventListener("keyup", e => { if (e.code === "Space") pttUp(); });

  const msgLabel = m => m.kind === "voice" ? `Voice message${m.secs ? ` (${Math.round(m.secs)} s)` : ""}` : (m.text || "");
  function renderMsgs(lk = linkNow()) {
    const nowS = Date.now() / 1000 + COM.off, who = r => r === "earth" ? "Earth" : r === "pod" ? "the pod" : "you";
    const bar = $("linkBar"); bar.className = "linkbar " + (lk ? "open" : "closed");
    bar.innerHTML = lk ? `<i class="dot" style="background:${ORB[lk.orbiter].c}"></i><b>${lk.orbiter} overhead</b><span>${lk.practice ? "Test link" : `Link open · ${fDur(lk.end - comTime())} left`}</span>`
      : `<i class="dot"></i><b>Link closed</b><span>${nextPassText()}</span>`;
    const c = COM.cfg;
    if (c) $("delayNote").textContent = `Earth is ${c.effective_min.toFixed(1)} light-minutes away (${c.override_min ? "demo setting" : c.source}). At ×${S.speed} the trip takes ${Math.max(1, Math.round(c.effective_min * 60 / S.speed))} s.`;
    $("delayDemo").setAttribute("aria-pressed", !!(c && c.override_min));
    const rows = COM.q.map(m => `<div class="msg out wait"><b>You to ${who(m.to)}</b><span>${msgLabel(m)}</span><em>Waiting for a relay pass · ${nextPassText()}</em><button type="button" data-cancel="${m.lid}" title="Cancel">×</button></div>`);
    [...COM.srv.values()].sort((a, b) => b.id - a.id).forEach(m => {
      const rem = Math.max(0, m.arrive - nowS), left = `${mmss(rem * m.speed)} of light time left (${Math.ceil(rem)} s real)`;
      if (m.sender === "astronaut") rows.push(`<div class="msg out ${m.status === "in_flight" ? "fly" : "ok"}"><b>You to ${who(m.to)}${m.via ? ` via ${m.via}` : ""}</b><span>${msgLabel(m)}</span><em>${m.status === "in_flight" ? "On its way · " + left : "✓ Arrived"}</em></div>`);
      else {
        const st = m.delivered ? "delivered" : nowS >= m.arrive ? "at_orbiter" : "in_flight";
        rows.push(`<div class="msg in ${st}"><b>From ${who(m.sender)}</b><span>${st === "delivered" ? msgLabel(m) : "Incoming message"}</span><em>${st === "in_flight" ? "Reply in flight to Mars orbit · " + left : st === "at_orbiter" ? "Waiting at the orbiter. It comes down on the next pass · " + nextPassText() : "✓ Received"}</em>${st === "delivered" ? `<button type="button" data-play="${m.id}" title="Play again">▶</button>` : ""}</div>`);
      }
    });
    renderTalk();
    $("msgs").innerHTML = rows.join("") || `<p class="hint">Messages you send leave when a relay orbiter is overhead. Replies from Earth wait at the orbiter until your next pass.</p>`;
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
  document.querySelectorAll(".dest").forEach(b => b.onclick = () => { COM.dest = b.dataset.d; document.querySelectorAll(".dest").forEach(x => x.setAttribute("aria-pressed", x === b)); });
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
  function layoutPhone() { if (mq.matches) closeSheet(); else openSheet(sheet.cur || "mission"); map.invalidateSize(); drawTimeline(); drawProfile(); }
  mq.addEventListener("change", layoutPhone);
  if ($("tlDetails")) $("tlDetails").addEventListener("toggle", () => requestAnimationFrame(drawTimeline));
  $("tbNow").onclick = () => $("departNow").click(); $("tbBest").onclick = () => $("departBest").click();
  const showPanel = open => { document.body.classList.toggle("nopanel", !open); $("expand").hidden = open; map.invalidateSize(); T3.dirty = true; requestAnimationFrame(() => { drawTimeline(); drawProfile(); }); };
  $("collapse").onclick = () => showPanel(false); $("expand").onclick = () => showPanel(true);
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
})().catch(e => { document.getElementById("loader").textContent = "Failed to load: " + e.message; console.error(e); });
