/* Relay position fix: solve the astronaut's position from range and range-rate measurements to one orbiter.
   Orbiter state comes from JPL Horizons (az, el, range, range rate seen from the site point, one sample a minute).
   The measurements are simulated from the true position plus noise; the solver only sees the noisy numbers,
   so the error it reports is a real least-squares result and not a random number. */
(function (root) {
  const D = Math.PI / 180;
  const gauss = rng => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const enu = s => { const az = s[1] * D, el = s[2] * D, r = s[3] * 1000; return [r * Math.cos(el) * Math.sin(az), r * Math.cos(el) * Math.cos(az), r * Math.sin(el)]; };

  /* all: every sample of the pass. i0..i1: the samples used (inclusive).
     truth: {e, n, u} metres from the site point. guess: {e, n} where dead reckoning thinks we are (start of the solve).
     opt: { rangeSigma m, rateSigma m/s, rng } */
  function solve(all, i0, i1, truth, guess, opt = {}) {
    const sr = opt.rangeSigma ?? 6, sv = opt.rateSigma ?? 0.05, rng = opt.rng || Math.random;
    if (i1 - i0 + 1 < 3) return null;
    const pos = all.map(enu), vel = all.map((_, k) => {
      const a = Math.max(0, k - 1), b = Math.min(all.length - 1, k + 1), dt = (all[b][0] - all[a][0]) || 60;
      return [0, 1, 2].map(c => (pos[b][c] - pos[a][c]) / dt);
    });
    const u = truth.u, meas = [];
    for (let k = i0; k <= i1; k++) {                                   // what the radio would measure at the true position
      const d = [pos[k][0] - truth.e, pos[k][1] - truth.n, pos[k][2] - u], rho = Math.hypot(...d);
      meas.push({ k, rho: rho + sr * gauss(rng), rate: (d[0] * vel[k][0] + d[1] * vel[k][1] + d[2] * vel[k][2]) / rho + sv * gauss(rng) });
    }
    let e = guess.e, n = guess.n, N = [0, 0, 0], it = 0;
    for (; it < 8; it++) {
      N = [0, 0, 0]; const g = [0, 0];
      for (const m of meas) {
        const d = [pos[m.k][0] - e, pos[m.k][1] - n, pos[m.k][2] - u], rho = Math.hypot(...d), V = vel[m.k], dv = d[0] * V[0] + d[1] * V[1] + d[2] * V[2];
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
    return { e, n, sigma: Math.sqrt(cee + cnn), used: meas.length, iters: it + 1, err: Math.hypot(e - truth.e, n - truth.n) };
  }
  const api = { solve, enu };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RelayFix = api;
})(typeof window !== "undefined" ? window : globalThis);
