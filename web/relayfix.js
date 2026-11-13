/* Relay position fix: solve the astronaut's position from range and range-rate (Doppler) measurements to one orbiter.
   Orbiter geometry is the real JPL Horizons pass (azimuth, elevation, range seen from the site, one sample a minute).
   The radio measures every few seconds, so the orbiter track is interpolated between those samples.
   The measurements themselves are simulated from the true position plus noise; the solver only sees the noisy numbers,
   so the error it reports is a real least-squares result and not a random number. */
(function (root) {
  const D = Math.PI / 180;
  const enu = s => { const az = s[1] * D, el = s[2] * D, r = s[3] * 1000; return [r * Math.cos(el) * Math.sin(az), r * Math.cos(el) * Math.cos(az), r * Math.sin(el)]; };

  /* orbiter position (m, east-north-up from the site point) and velocity (m/s) every `step` seconds from t0 to t1 */
  function epochs(all, t0, t1, step) {
    const P = all.map(enu), out = []; let k = 0;
    for (let t = t0; t <= t1 + 1e-6; t += step) {
      while (k < all.length - 2 && all[k + 1][0] <= t) k++;
      const dt = (all[k + 1][0] - all[k][0]) || 60, f = (t - all[k][0]) / dt;
      out.push({ t, p: [0, 1, 2].map(c => P[k][c] + (P[k + 1][c] - P[k][c]) * f), v: [0, 1, 2].map(c => (P[k + 1][c] - P[k][c]) / dt) });
    }
    return out;
  }
  /* the same noise for the same measurement every time it is solved again, so the estimate settles instead of jumping about */
  function seeded(seed) {
    let a = (seed >>> 0) || 1;
    const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(1 - u() * 0.999999)) * Math.cos(2 * Math.PI * u());      // standard normal
  }

  /* ep: epochs(). truth: {e, n, u} metres from the site point. guess: {e, n} where the suit thinks it is (start of the solve).
     opt: { rangeSigma m, rateSigma m/s, gauss: () => standard normal }. Height is taken as known (from the terrain map). */
  function solve(ep, truth, guess, opt = {}) {
    const sr = opt.rangeSigma ?? 6, sv = opt.rateSigma ?? 0.05, gauss = opt.gauss || seeded(1);
    if (ep.length < 3) return null;
    const u = truth.u, meas = [];
    for (const q of ep) {                                              // what the radio would measure at the true position
      const d = [q.p[0] - truth.e, q.p[1] - truth.n, q.p[2] - u], rho = Math.hypot(...d);
      meas.push({ q, rho: rho + sr * gauss(), rate: (d[0] * q.v[0] + d[1] * q.v[1] + d[2] * q.v[2]) / rho + sv * gauss() });
    }
    let e = guess.e, n = guess.n, N = [0, 0, 0], it = 0;
    for (; it < 8; it++) {
      N = [0, 0, 0]; const g = [0, 0];
      for (const m of meas) {
        const P = m.q.p, V = m.q.v, d = [P[0] - e, P[1] - n, P[2] - u], rho = Math.hypot(...d), dv = d[0] * V[0] + d[1] * V[1] + d[2] * V[2];
        const Jr = [-d[0] / rho, -d[1] / rho], Jv = [-V[0] / rho + dv * d[0] / rho ** 3, -V[1] / rho + dv * d[1] / rho ** 3];
        const rr = (m.rho - rho) / sr, rv = (m.rate - dv / rho) / sv;
        for (const [J, res, s] of [[Jr, rr, sr], [Jv, rv, sv]]) {
          const a = J[0] / s, b = J[1] / s;
          N[0] += a * a; N[1] += a * b; N[2] += b * b; g[0] += a * res; g[1] += b * res;
        }
      }
      const det = N[0] * N[2] - N[1] * N[1]; if (!(Math.abs(det) > 1e-18)) return null;
      const de = (N[2] * g[0] - N[1] * g[1]) / det, dn = (N[0] * g[1] - N[1] * g[0]) / det;
      e += de; n += dn; if (Math.hypot(de, dn) < 0.01) break;
    }
    const det = N[0] * N[2] - N[1] * N[1], cee = N[2] / det, cnn = N[0] / det;
    return { e, n, sigma: Math.sqrt(cee + cnn), used: meas.length * 2, iters: it + 1, err: Math.hypot(e - truth.e, n - truth.n) };
  }
  const api = { solve, epochs, seeded, enu };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RelayFix = api;
})(typeof window !== "undefined" ? window : globalThis);
