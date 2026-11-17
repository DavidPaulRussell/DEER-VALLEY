// Each agent's own body, coat and face, and its expression, as functions of the simulation's state.
// SPDX-License-Identifier: GPL-3.0-only
//
// Equations from "Equations for sentient computing on the four rails", used here as generators. They make
// the variety lawful and traceable to the simulation; they do not make any agent sentient.
//   E5   copy: a fawn's genome is copied from its parents in the simulation (crossover and mutation), and its
//        body is a function of that genome, so kin resemble each other
//   E12  classical scaling: the founder lineages' mean genomes give a Gram matrix; its leading eigenvectors
//        are the axes of a shape space, and each deer's genome is placed on them (bulk, legs, head)
//   E21  grid codes: a fawn's spots are the peaks of a hexagonal grid code (three plane waves 60 degrees
//        apart) with its own spacing, orientation and phase
//   E6   Beta evidence: a deer's trust posterior mean sets how high it carries its head
//   E4   attention schema: head, eyes and ears turn to what the agent attends: the nearest wolf in view,
//        otherwise the best forage it can see (the cells the simulation lets it weigh)
//   E7   predictive coding: surprise is the gap between the forage it expected (an E3 running estimate)
//        and the forage it found; with a wolf's nearness it raises arousal
//   E3   forgetting: arousal and the expectation decay geometrically
//   E2   hysteresis (with E15 margins): calm and alert switch at different arousal levels, so faces hold
//   E13  expected free energy: its epistemic part (how uncertain the visible forage is) sets how much it scans
//   E20  latch: an injured deer keeps a wary face until the simulation heals it
import { gene, YEAR } from "./valley.js";

const h01 = (a, b) => { let x = Math.imul((a | 0) ^ 0x7feb352d, 0x846ca68b); x ^= x >>> 15; x = Math.imul(x ^ (b | 0), 0x2c1b3c6d); x ^= x >>> 12; x = Math.imul(x, 0x297a2d39); x ^= x >>> 15; return (x >>> 0) / 4294967296; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const genome = (D, i) => { const g = new Float64Array(13); for (let k = 0; k < 8; k++) g[k] = gene(D.prefs[i], k); for (let k = 0; k < 5; k++) g[8 + k] = gene(D.traits[i], k); return g; };

// E12: classical scaling of the lineages' mean genomes (Jacobi eigenvalues of the centred Gram matrix)
export function shapeSpace(valley) {
  const D = valley.deer, sums = new Map();
  for (let i = 0; i < D.n; i++) { const l = D.lineage[i], g = genome(D, i); if (!sums.has(l)) sums.set(l, { g: new Float64Array(13), n: 0 }); const s = sums.get(l); for (let k = 0; k < 13; k++) s.g[k] += g[k]; s.n++; }
  const M = [...sums.values()].filter((s) => s.n >= 3).map((s) => s.g.map((x) => x / s.n));
  const n = M.length; if (n < 4) return null;
  const mu = new Float64Array(13); for (const m of M) for (let k = 0; k < 13; k++) mu[k] += m[k] / n;
  const X = M.map((m) => m.map((x, k) => x - mu[k]));
  const B = X.map((a) => X.map((b) => a.reduce((s, x, k) => s + x * b[k], 0)));          // Gram matrix = -1/2 J D2 J
  const V = B.map((_, i) => B.map((__, j) => (i === j ? 1 : 0))), A = B.map((r) => r.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] ** 2; if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]).slice(0, 3);
  const axes = order.map((j) => { const lam = Math.max(A[j][j], 1e-9), ax = new Float64Array(13); for (let l = 0; l < n; l++) for (let k = 0; k < 13; k++) ax[k] += (V[l][j] * X[l][k]) / Math.sqrt(lam); return { ax, sd: Math.sqrt(lam / n) || 1, lam }; });
  return { mu, axes, lineages: n, eigenvalues: axes.map((a) => a.lam) };
}

// a deer: proportions, coat and face (all multipliers around 1 unless noted)
export function deerMorph(valley, i, space, season) {
  const D = valley.deer, id = D.id[i], g = genome(D, i), ageY = D.age[i] / YEAR, buck = D.sex[i] === 0;
  const s = [0, 0, 0];
  if (space) space.axes.forEach((a, k) => { let v = 0; for (let q = 0; q < 13; q++) v += (g[q] - space.mu[q]) * a.ax[q]; s[k] = clamp(v / a.sd, -2.5, 2.5); });
  const r = (k) => h01(id, k) - 0.5, tr = (k) => g[8 + k] - 7.5;
  const grow = 0.5 + 0.5 * (1 - Math.exp(-ageY / 0.9));
  const cond = clamp(D.energy[i] / 700, 0.5, 1.4);
  const m = {
    genes: s.slice(),                                                                              // E12 axes (bulk, legs, head) for the form's continuum
    size: grow * (1 + 0.035 * s[0] + 0.05 * r(1)) * (buck ? 1.06 : 0.97),
    girth: (1 + 0.05 * s[0] + 0.04 * r(2)) * (0.9 + 0.1 * cond) * (buck && season === 2 ? 1.06 : 1),
    legs: 1 + 0.045 * s[1] + 0.006 * tr(3) + 0.03 * r(3) + (ageY < 0.4 ? 0.1 : 0),               // fawns are leggy
    body: 1 - 0.025 * s[1] + 0.03 * r(4),
    neck: (1 + 0.04 * s[2] + 0.04 * r(5)) * (buck && season === 2 ? 1.08 : 1),                     // the rut thickens bucks' necks
    neckGirth: (1 + 0.004 * tr(1) + 0.04 * r(6)) * (buck ? (season === 2 ? 1.22 : 1.08) : 1),
    muzzle: 1 + 0.05 * s[2] + 0.04 * r(7),
    ears: (1 - 0.05 * s[2] + 0.06 * r(8)) * (ageY < 0.4 ? 1.18 : 1),
    tail: 1 + 0.1 * r(9),
    // coat: rgb multipliers (lineage and individual), dorsal stripe, eye ring, throat patch, age greying
    tint: [1 + 0.06 * r(10) + 0.04 * ((D.lineage[i] * 37) % 11 / 11 - 0.5), 1 + 0.035 * r(11), 1 - 0.05 * r(10)],
    dorsal: clamp(0.35 + 0.4 * h01(D.lineage[i], 12) + 0.2 * r(12), 0, 1),
    ring: clamp(0.5 + 0.5 * h01(D.lineage[i], 13) + 0.3 * r(13), 0, 1),
    throat: clamp(0.7 + 0.4 * h01(D.lineage[i], 14) + 0.3 * r(14), 0.3, 1.3),
    grey: clamp((ageY - 4.5) / 4, 0, 1),
    // E21: fawn spots while young: spacing (m), orientation, phase
    spots: ageY < 0.42 ? clamp(0.075 + 0.02 * r(15), 0.05, 0.1) : 0, spotTh: h01(id, 16) * Math.PI / 3, spotPh: [h01(id, 17), h01(id, 18)],
    // antlers: tines per side and size by age, genes and vigour; their shape from their own seed
    antler: buck && ageY >= 0.9 ? { pts: ageY < 1.6 ? 0 : ageY < 2.6 ? 2 : ageY < 4 ? 3 : 4 + (tr(1) + tr(4) > 2 ? 1 : 0), size: clamp((0.55 + 0.25 * Math.min(ageY, 5) / 5 + 0.2 * (cond - 1)) * (1 + 0.05 * s[0]), 0.4, 1.15),
      seed: h01(id, 19), spread: 0.85 + 0.35 * h01(id, 20), asym: 0.12 * r(21) } : null,
  };
  return m;
}
// a wolf: pack and individual; coat phase grey (agouti), black or cream
export function wolfMorph(valley, i) {
  const W = valley.wolves, id = W.id[i], pk = W.pack[i], r = (k) => h01(id, k) - 0.5, pr = h01(pk + 977, 1);
  const black = pr < 0.14 ? 0.85 + 0.1 * r(1) : h01(id, 2) < 0.06 ? 0.8 : 0, cream = !black && (pr > 0.9 || h01(id, 3) < 0.05) ? 0.75 + 0.2 * r(4) : 0;
  return { size: 0.94 + 0.12 * h01(id, 5) + 0.04 * (h01(pk, 6) - 0.5), girth: 0.95 + 0.1 * h01(id, 7), legs: 0.97 + 0.07 * h01(id, 8), body: 0.97 + 0.06 * h01(id, 9),
    neck: 1, neckGirth: 1 + 0.08 * r(10), muzzle: 0.96 + 0.08 * h01(id, 11), ears: 0.92 + 0.15 * h01(id, 12), tail: 0.9 + 0.2 * h01(id, 13),
    tint: [1 + 0.05 * r(14), 1 + 0.03 * r(15), 1 - 0.04 * r(14)], saddle: 0.4 + 0.5 * h01(pk, 16), mask: 0.3 + 0.6 * h01(id, 17), black, cream };
}
// a warden: height, build, skin and hair, clothes and hat
const SKIN = [[0.86, 0.68, 0.56], [0.78, 0.58, 0.45], [0.68, 0.48, 0.34], [0.55, 0.37, 0.25], [0.42, 0.28, 0.19], [0.32, 0.21, 0.15]];
const HAIR = [[0.08, 0.06, 0.05], [0.22, 0.14, 0.08], [0.42, 0.28, 0.15], [0.55, 0.4, 0.24], [0.5, 0.5, 0.5]];
const SHIRT = [[0.55, 0.5, 0.36], [0.38, 0.42, 0.28], [0.36, 0.38, 0.4], [0.55, 0.22, 0.16], [0.24, 0.3, 0.42]];
export function wardenMorph(valley, i) {
  const WD = valley.wardens, id = WD.id[i], r = (k) => h01(id, k), skin = SKIN[Math.floor(r(1) * SKIN.length)], hair = HAIR[Math.floor(r(2) * HAIR.length)];
  return { height: 0.93 + 0.17 * r(3), girth: 0.9 + 0.28 * r(4), skin: skin.map((x) => x * (0.95 + 0.1 * r(5))), hair, beard: r(6) < 0.35 ? 1 : 0,
    shirt: SHIRT[Math.floor(r(7) * SHIRT.length)], plaid: r(8) < 0.3 ? 1 : 0, trousers: 0.7 + 0.6 * r(9), hatBrim: 0.85 + 0.35 * r(10), hatCrown: 0.8 + 0.45 * r(11), hatTone: 0.75 + 0.5 * r(12) };
}

// once an epoch: what the agent attends (E4), what it expected and found (E7, E3), how uncertain its view is (E13)
export function attend(valley, kind, i, st) {
  const e = valley.epoch; if (st.attnEpoch === e) return; st.attnEpoch = e;
  if (kind === "deer") {
    const per = valley.perception(i); if (!per) return;
    const here = per.cells.find((c) => c.dx === 0 && c.dy === 0)?.forage ?? 0;
    st.expect = st.expect === undefined ? here : st.expect;
    const err = Math.abs(here - st.expect) / (st.expect + 16);           // E7: the prediction error
    st.expect += (here - st.expect) / 4;                                  // E3: the running expectation
    let best = null; for (const c of per.cells) if (!c.water && (!best || c.forage > best.forage)) best = c;
    const mean = per.cells.reduce((s, c) => s + c.forage, 0) / per.cells.length, sd = Math.sqrt(per.cells.reduce((s, c) => s + (c.forage - mean) ** 2, 0) / per.cells.length);
    st.scan = clamp(sd / (mean + 8), 0, 1);                               // E13: the epistemic drive
    const wolf = per.wolves.length ? per.wolves.reduce((a, b) => (a.d <= b.d ? a : b)) : null;
    st.arousal = (st.arousal ?? 0) + err * 0.5 + (wolf ? (7 - wolf.d) / 7 : 0);
    st.target = wolf ? { x: (valley.wolves.x[wolf.w] + 0.5) * 4, z: (valley.wolves.y[wolf.w] + 0.5) * 4, threat: true } : best ? { x: (valley.deer.x[i] + best.dx + 0.5) * 4, z: (valley.deer.y[i] + best.dy + 0.5) * 4, threat: false } : null;
    st.trust = valley.deer.alpha[i] / Math.max(1, valley.deer.alpha[i] + valley.deer.beta[i]);   // E6: posterior mean
    st.injured = valley.deer.injured[i] > 0;                              // E20: latched while it heals
  } else if (kind === "wolf") {
    const W = valley.wolves, D = valley.deer; let best = -1, bd = 1e9;
    for (let j = 0; j < D.n; j += Math.max(1, Math.floor(D.n / 600))) { const dx = D.x[j] - W.x[i], dy = D.y[j] - W.y[i], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = j; } }
    st.target = best >= 0 && bd < 100 ? { x: (D.x[best] + 0.5) * 4, z: (D.y[best] + 0.5) * 4, threat: false } : null;
    st.arousal = (st.arousal ?? 0) + (st.target ? 0.4 : 0); st.scan = 0.3;
  } else {
    const WD = valley.wardens, D = valley.deer; let best = -1, bd = 1e9;
    for (let j = 0; j < D.n; j += Math.max(1, Math.floor(D.n / 600))) { const dx = D.x[j] - WD.x[i], dy = D.y[j] - WD.y[i], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = j; } }
    st.target = best >= 0 && bd < 64 ? { x: (D.x[best] + 0.5) * 4, z: (D.y[best] + 0.5) * 4, threat: false } : null; st.scan = 0.5; st.arousal = 0;
  }
}
// every frame: the face follows the arousal state with hysteresis (E2), arousal forgets (E3)
export function countenance(st, kind, dt, now) {
  st.arousal = (st.arousal ?? 0) * Math.exp(-dt / 5);
  if (!st.alert && st.arousal > 0.6) st.alert = true; else if (st.alert && st.arousal < 0.25) st.alert = false;   // E2: two thresholds
  st.margin = st.alert ? st.arousal - 0.25 : 0.6 - st.arousal;                                                      // E15: the distance to the switch
  const blink = (now / 1000 + st.seed * 3.1) % (3.2 + (st.seed % 2.5)) < 0.13;
  const wary = st.injured, target = st.alert ? 1 : 0;
  st.earFwd += ((wary ? -1 : st.alert ? 1 : 0.15) - (st.earFwd ?? 0)) * Math.min(1, dt * 6);
  st.earDroop += ((wary ? 0.5 : st.alert ? -0.15 : 0.3) - (st.earDroop ?? 0)) * Math.min(1, dt * 4);
  st.eyeOpen = blink ? 0.08 : wary ? 0.6 : st.alert ? 1.15 : 0.88;
  st.attnYaw = st.attnYaw ?? 0;
  return target;
}
