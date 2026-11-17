// Deer Valley: a populous, deterministic world on the Plume XPU, governed by the Simmy rails authority.
// SPDX-License-Identifier: GPL-3.0-only
//
// One epoch:
//   0  your interventions for this epoch (recorded in the save file)
//   A  the meadow law runs on the XPU (8 plant species, one per lane; Z/2^20; seasonal Life rule),
//      then the pond boundary condition and seed rain
//   B  wolves hunt (vision, scent trails, pack attacks)
//   C  deer choose cells by forage memory, herd, wolves, water and reserve law; E1 admits them
//      to cells (capacity slots, ranked by gain, trust score and id, with the slot price)
//   D  wardens patrol the reserves; deer graze, poach, are denied; seeds are dispersed
//   E  wardens inspect deer and record verdicts
//   F  metabolism, ageing, injuries, deaths
//   G  the Simmy rails trust law, on the integer evidence lattice (1/U)Z, for every deer and warden
//   H  licences (E1 per reserve, each season), licence fees, warden hiring, births with mutation
//   I  scent trails decay (E3), the exact energy ledger is audited, digests chain the epoch
// Everything is integer arithmetic or IEEE +,-,*,/ (identical on every machine) and a stateless
// hash for chance, so the same seed and interventions give the same world, bit for bit.
import { compile, WORDS, LANES } from "./lcufa.js";
import { Q, sha256Hex, pyDumps, AGENTS, LEVELS, THRESHOLD_NAMES, F_RUNNING, F_FAULT, F_RESTART, F_TERMINATE, MAT_DEV_FUNCTIONAL, MAT_VERIFIED, MAT_BLOCKED, SimmyRun, replayText, parseQ, SIMMY_REPLAY_SHA256 } from "./simmy.js";

export const VALLEY_VERSION = "1.0.0";
export const SAVE_FORMAT = "PLUME-VALLEY/1";
export const N = 128, CELLS = N * N, NONE = 255;
export const YEAR = 96, SEASON_LEN = 24;

/* ------------------------------------------------------------------ the meadow law (LCUF-A) */
// P' = (L - L·rot(L,1)) + 2·nsum(P mod 2) + 16·(P - P mod 2),  L = Life(P) under the season's rule.
// Bit 0: the plant is alive (species k lives in lane k; species k+1 crowds out species k in the same
// cell). Bits 1-4: live neighbours last generation. Bits 5-19: the three generations before that,
// one nibble each, shifting up 4 bits a generation (2-adic forgetting): the deer's forage memory.
export const MEADOW_SOURCE = `LCUF-A/0.3
module deer.valley.meadow
ring p=2 n=20
frame lanes=8 height=128 width=128
phase | id  | op    | inputs | output | arg
init  | i1  | from2 | in     | x      | -
step  | s1  | life  | x      | a      | -
step  | s2  | rot   | a      | b      | 1
step  | s3  | mul   | a,b    | t      | -
step  | s4  | mulc  | t      | t2     | 1048575
step  | s5  | add   | a,t2   | g      | -
step  | s6  | modj  | x      | v      | 1
step  | s7  | nsum  | v      | d      | -
step  | s8  | shift | d      | d2     | -
step  | s9  | mulc  | x      | h      | 16
step  | s10 | mulc  | v      | hv     | 1048560
step  | s11 | add   | h,hv   | h2     | -
step  | s12 | add   | g,d2   | y1     | -
step  | s13 | add   | y1,h2  | y      | -
step  | s14 | copy  | y      | x      | -
final | f1  | to2   | x      | out    | -
end
`;
const bmask = (s) => [...s].reduce((m, c) => m | (1 << Number(c)), 0);
export const ruleOf = (b, s) => ({ birth: bmask(b), survive: bmask(s), text: `B${b}/S${s}` });

export const SPECIES = [
  { name: "clover", color: [214, 138, 176] }, { name: "bluegrass", color: [96, 156, 196] },
  { name: "fescue", color: [178, 182, 82] }, { name: "sedge", color: [96, 150, 88] },
  { name: "fireweed", color: [212, 72, 132] }, { name: "blueberry", color: [92, 92, 178] },
  { name: "willow", color: [170, 196, 120] }, { name: "juniper", color: [44, 100, 76] },
];
// nutrition: energy per bite of each species; metab: metabolism multiplier in quarters
export const SEASONS = [
  { name: "spring", rule: ruleOf("3678", "012345678"), gens: 2, nutr: [30, 24, 14, 10, 6, 8, 10, 6], metab: 4, seeds: 24 },
  { name: "summer", rule: ruleOf("4678", "012345678"), gens: 2, nutr: [14, 28, 30, 20, 10, 12, 8, 6], metab: 4, seeds: 0 },
  { name: "autumn", rule: ruleOf("5678", "12345678"), gens: 2, nutr: [8, 12, 16, 26, 30, 28, 12, 8], metab: 4, seeds: 0 },
  { name: "winter", rule: ruleOf("", "345678"), gens: 1, nutr: [4, 6, 8, 10, 8, 6, 22, 20], metab: 6, seeds: 0 },
];
export const seasonOf = (epoch) => Math.floor(((epoch - 1) % YEAR) / SEASON_LEN);
// Grazing crops a plant; it regrows from its rootstock after REGROW[s] epochs (x2 in autumn, not in winter).
export const REGROW = [4, 3, 3, 4, 6, 8, 10, 12];

/* ------------------------------------------------------------------ the nested-VM boot table */
// Each valley mechanism switches on at the first Simmy mesh tick at which its subsystem is READY
// (DEV_FUNCTIONAL or better): the condition Simmy itself uses before releasing a dependant.
export const MECHANISMS = [
  ["meadow", 1, "The meadow law runs on the XPU"],
  ["clock", 2, "The calendar runs: animals age"],
  ["herds", 5, "The founding herds enter the valley"],
  ["movement", 6, "Deer move across the valley"],
  ["seasons", 10, "Seasons change the rules and the nutrition"],
  ["rules", 12, "Reserves are closed without a licence"],
  ["grazing", 13, "Deer graze"],
  ["causality", 16, "Causal cones of each bite (view)"],
  ["energy", 17, "Energy budgets: metabolism and starvation"],
  ["ledger", 61, "The energy ledger is audited exactly"],
  ["navigation", 46, "Deer steer by the forage memory"],
  ["lod", 60, "Pyramid levels of the field (view)"],
  ["water", 62, "Ponds hold their boundary condition"],
  ["view3d", 47, "Third-person 3D view"],
  ["authority", 67, "Rails trust law and reserve licences"],
  ["provenance", 36, "Epochs are sealed as R files"],
  ["snapshots", 30, "Checkpoints for rewinding"],
  ["reproducibility", 50, "Cross-engine checks"],
  ["breeding", 15, "Breeding with recombination and mutation"],
  ["economy", 18, "Licence fees pay for wardens"],
  ["wolves", 32, "Wolves enter the valley"],
  ["wardens", 14, "Wardens patrol the reserves"],
  ["human", 58, "Your interventions"],
];

export function simmyBoot(manifest, workload) {
  const run = new SimmyRun(manifest, workload);
  const subs = manifest.cells.filter((c) => c.kind === "subsystem");
  const ready = {}, verified = {}, timeline = [];
  while (!run.done) {
    const info = run.step(), row = new Uint8Array(manifest.cells.length);
    manifest.cells.forEach((c, k) => { if (c.kind !== "authority_minivm") row[k] = run.maturity(c.container); });
    timeline.push(row);
    for (const c of subs) {
      const m = run.maturity(c.container);
      if (m >= MAT_DEV_FUNCTIONAL && m !== MAT_BLOCKED) ready[c.number] ??= info.tick;
      if (m >= MAT_VERIFIED && m !== MAT_BLOCKED) verified[c.number] ??= info.tick;
    }
  }
  const result = run.result(), text = replayText(result);
  const auth = Object.values(result.cells).find((c) => c.kind === "authority_minivm").final;
  return { sha256: sha256Hex(text), ready, verified, timeline, result, text, policy: run.p, founders: auth.agents,
    titles: Object.fromEntries(subs.map((c) => [c.number, c.title])), cells: manifest.cells.map((c) => ({ container: c.container, kind: c.kind, number: c.number, title: c.title })) };
}

/* ------------------------------------------------------------------ the rails trust law on the integer lattice */
// The Simmy rails authority (E6 Beta evidence, E3 idle-clock forgetting, reliability filter, E2/E15
// hysteresis cones, E20 latch), with evidence held as integers in units of 1/U. U = 4158·256 makes
// the prior 97/6 and every calibrated evidence weight an exact integer. Forgetting rounds the
// evidence excess down (floor(24e/25)), so it reaches the prior exactly in finite time. The
// reliability filter with decay 1/2 is a 16-bit shift register of clean (1) and dirty (0) ticks;
// thresholds 3/4 and 7/8 read its top two and three bits exactly. Level boundaries are tested as
// cones: score >= theta  <=>  scale·alpha >= (theta - lo)·(alpha + beta), exact in integers.
export const U = 4158 * 256;
export const RUNNING = 0, FAULTED = 1, TERMINATED = 2;
export const LIFE_NAMES = ["running", "faulted", "terminated"];
const MAX_EVIDENCE = 2 ** 42;

export function latticePolicy(p) {
  const toU = (q, what) => { const v = q.mul(U); if (v.d !== 1n) throw new Error(`${what} is not on the lattice (1/${U})Z`); return Number(v.n); };
  if (!p.rdec.eq(Q.of(1, 2))) throw new Error("the lattice reliability filter needs reliability_decay = 1/2");
  const r16 = (q, what) => { const v = q.mul(65536); if (v.d !== 1n) throw new Error(`${what} is not a 16-bit dyadic`); return Number(v.n); };
  return {
    U, lo: p.lo, scale: p.scale, a0: toU(p.a0, "prior_alpha"), b0: toU(p.b0, "prior_beta"), n0: toU(p.n0, "prior_strength"),
    w: Object.fromEntries(Object.entries(p.w).map(([k, v]) => [k, toU(v, k)])),
    dn: Number(p.delta.n), dd: Number(p.delta.d), rex: r16(p.rex, "reliability_expand_at_least"), rhold: r16(p.rhold, "reliability_hold_at_least"),
    th: { ...p.th },
  };
}
const fdiv = (t, d) => (t >= 0 ? (t - (t % d)) / d : -((-t + d - 1 - ((-t + d - 1) % d)) / d));
export const ge = (P, a, b, theta) => P.scale * a >= (theta - P.lo) * (a + b);
export function scoreL(P, a, b) { // lo + floor(scale·a/(a+b)), exact
  const num = P.scale * a, den = a + b; let q = Math.floor(num / den);
  while (q * den > num) q--; while ((q + 1) * den <= num) q++;
  return P.lo + q;
}
export function nextLevelL(level, a, b, rel, P) {
  const th = P.th;
  if (level === 0) return ge(P, a, b, th.restore_from_suspend_above) ? 1 : 0;
  if (level === 1) { if (!ge(P, a, b, th.suspend_below)) return 0; return ge(P, a, b, th.restore_nominal_above) ? 2 : 1; }
  if (level === 2) { if (!ge(P, a, b, th.restrict_below)) return 1; return ge(P, a, b, th.expand_above) && rel >= P.rex ? 3 : 2; }
  if (!ge(P, a, b, th.restrict_below)) return 1;
  if (!ge(P, a, b, th.expand_hold_above) || rel < P.rhold) return 2;
  return 3;
}
export function settleL(level, a, b, rel, P) {
  let steps = 0;
  for (let i = 0; i < 5; i++) { const nx = nextLevelL(level, a, b, rel, P); if (nx === level) return [level, steps]; level = nx; steps++; }
  throw new Error("hysteresis map did not reach a fixed point");
}
// The E15 margin in score units, as a float for display: distance to the nearest boundary that moves the level.
export function marginL(level, a, b, P) {
  const th = P.th, s = P.lo + (P.scale * a) / (a + b);
  return Math.min(...[[th.restore_from_suspend_above - s], [s - th.suspend_below, th.restore_nominal_above - s], [s - th.restrict_below, th.expand_above - s], [s - th.expand_hold_above]][level]);
}
// One authority tick for agent i of table T (fields alpha, beta, rel, level, life, rev, cls).
// row = [intents, commits, denials, flags]; vA/vB: verdict evidence; vDirty: a fail verdict arrived.
export function tickTrust(P, T, i, it, co, de, fl, vA, vB, vDirty, C) {
  if (T.life[i] === TERMINATED) return;
  let ea = 0, eb = 0, clean = -1;
  if (fl & F_RUNNING && it === 0) {
    T.alpha[i] = P.a0 + fdiv((T.alpha[i] - P.a0) * P.dn, P.dd);
    T.beta[i] = P.b0 + fdiv((T.beta[i] - P.b0) * P.dn, P.dd);
  }
  if (fl & F_FAULT) { eb += P.w.fault; T.life[i] = FAULTED; C.faults++; clean = 0; }
  if (fl & F_RUNNING && it > 0) {
    ea += P.w.commit * co; eb += P.w.denial * de; C.commits += co; C.denials += de;
    if (de > 0) clean = 0; else if (co > 0 && clean === -1) clean = 1;
  }
  ea += vA; eb += vB; if (vDirty) clean = 0;
  T.alpha[i] = Math.min(MAX_EVIDENCE, T.alpha[i] + ea); T.beta[i] = Math.min(MAX_EVIDENCE, T.beta[i] + eb);
  if (clean !== -1) T.rel[i] = (T.rel[i] >>> 1) | (clean << 15);
  if (fl & F_RESTART) { T.life[i] = RUNNING; T.rel[i] = 0; }
  if (fl & F_TERMINATE) { T.life[i] = TERMINATED; T.level[i] = 0; T.alpha[i] = 0; T.beta[i] = P.n0; T.rev[i] = (T.rev[i] + 1) & 255; return; }
  const [nw, steps] = settleL(T.level[i], T.alpha[i], T.beta[i], T.rel[i], P);
  if (steps) { T.level[i] = nw; T.rev[i] = (T.rev[i] + steps) & 255; C.transitions += steps; }
}
// A Simmy agent's exact final state, projected onto the lattice (floor(x·U); reliability exactly).
export function projectFounder(P, a) {
  const lat = (s) => { const q = parseQ(s, "founder"); return Number(q.mul(U).floor()); };
  const rel = parseQ(a.reliability, "founder.reliability").mul(65536);
  return { alpha: lat(a.alpha), beta: lat(a.beta), rel: Number(rel.floor()), level: LEVELS.indexOf(a.level), life: LIFE_NAMES.indexOf(a.lifecycle), rev: a.revision, cls: a.class === "MAVM" ? 1 : 0 };
}

/* ------------------------------------------------------------------ chance, geometry, terrain */
export function hash(a, b, c, d) {
  let h = Math.imul((a | 0) ^ 0x3c6ef372, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15) ^ (b | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ (c | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ (d | 0), 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
export const cellOf = (x, y) => ((y & 127) << 7) | (x & 127);
export const tdist = (a, b) => { const d = Math.abs(a - b); return d > 64 ? 128 - d : d; };
export const cheb = (x1, y1, x2, y2) => Math.max(tdist(x1, x2), tdist(y1, y2));
export const wdelta = (from, to) => ((to - from + 64) & 127) - 64;
export const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, -1, -1, -1, 0, 1, 1, 1];
const dirOf = (dx, dy) => { for (let k = 0; k < 8; k++) if (DX[k] === Math.sign(dx) && DY[k] === Math.sign(dy)) return k; return -1; };

export function makeTerrain(seed) {
  const h = new Int32Array(CELLS);
  const smooth = (t) => Math.trunc((3 * t * t * 4096 - 2 * t * t * t) / 16777216); // 4096·(3s² − 2s³), s = t/4096
  for (const [step, amp] of [[32, 1000], [16, 420], [8, 170], [4, 60]]) {
    const g = N / step, lat = new Int32Array(g * g);
    for (let k = 0; k < g * g; k++) lat[k] = (hash(seed, 0x7e44a, step, k) % 2001) - 1000;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i0 = (x / step) | 0, j0 = (y / step) | 0, i1 = (i0 + 1) % g, j1 = (j0 + 1) % g;
      const sx = smooth((x % step) * (4096 / step)), sy = smooth((y % step) * (4096 / step));
      const top = lat[j0 * g + i0] * (4096 - sx) + lat[j0 * g + i1] * sx, bot = lat[j1 * g + i0] * (4096 - sx) + lat[j1 * g + i1] * sx;
      h[y * N + x] += Math.trunc(((top * (4096 - sy) + bot * sy) * amp) / 16777216000);
    }
  }
  const sorted = Int32Array.from(h).sort(), level = sorted[Math.floor(CELLS * 0.07)];
  const water = new Uint8Array(CELLS); for (let c = 0; c < CELLS; c++) water[c] = h[c] < level ? 1 : 0;
  return { height: h, water, level };
}

/* ------------------------------------------------------------------ tables (struct of arrays) */
class Table {
  constructor(cap, spec) { this.cap = cap; this.n = 0; this.spec = spec; for (const [k, T] of spec) this[k] = new T(cap); }
  push() { if (this.n >= this.cap) return -1; const i = this.n++; for (const [k] of this.spec) this[k][i] = 0; return i; }
  compact(keep) {
    let j = 0;
    for (let i = 0; i < this.n; i++) if (keep[i]) { if (j !== i) for (const [k] of this.spec) this[k][j] = this[k][i]; j++; }
    this.n = j;
  }
  bytes() {
    const parts = this.spec.map(([k]) => new Uint8Array(this[k].buffer, 0, this.n * this[k].BYTES_PER_ELEMENT));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  clone() { const t = new Table(this.cap, this.spec); t.n = this.n; for (const [k] of this.spec) t[k].set(this[k]); return t; }
  find(id) { let lo = 0, hi = this.n - 1; while (lo <= hi) { const m = (lo + hi) >> 1, v = this.id[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; } return -1; }
}
const TRUST = [["alpha", Float64Array], ["beta", Float64Array], ["rel", Uint16Array], ["level", Uint8Array], ["life", Uint8Array], ["rev", Uint8Array], ["cls", Uint8Array]];
const DEER_SPEC = [["id", Uint32Array], ["x", Uint8Array], ["y", Uint8Array], ["px", Uint8Array], ["py", Uint8Array], ["dir", Uint8Array],
  ["energy", Int32Array], ["age", Uint32Array], ["prefs", Uint32Array], ["traits", Uint32Array], ["lineage", Uint8Array], ["serial", Uint32Array],
  ["parent", Uint32Array], ["gen", Uint16Array], ["born", Uint32Array], ["injured", Uint16Array], ["cooldown", Uint16Array], ["act", Uint8Array],
  ["ate", Uint8Array], ["licence", Uint8Array], ["sex", Uint8Array], ...TRUST];
const WOLF_SPEC = [["id", Uint32Array], ["x", Uint8Array], ["y", Uint8Array], ["px", Uint8Array], ["py", Uint8Array], ["dir", Uint8Array],
  ["energy", Int32Array], ["age", Uint32Array], ["pack", Uint8Array], ["act", Uint8Array], ["cooldown", Uint16Array], ["kills", Uint32Array]];
const WARDEN_SPEC = [["id", Uint32Array], ["x", Uint8Array], ["y", Uint8Array], ["px", Uint8Array], ["py", Uint8Array], ["dir", Uint8Array],
  ["home", Uint8Array], ["patrol", Uint16Array], ["inspections", Uint32Array], ["catches", Uint32Array], ["hired", Uint32Array], ["founder", Uint8Array],
  ["act", Uint8Array], ...TRUST];

// genome: prefs = 8 nibbles (species 0..7); traits = lawful | bold<<4 | herd<<8 | speed<<12 | fert<<16
export const gene = (g, k) => (g >>> (4 * k)) & 15;
export const TRAITS = ["lawful", "bold", "herd", "speed", "fertility"];
export const ACTS = ["idle", "walking", "grazing", "fleeing", "poaching", "denied", "licensed grazing", "resting", "newborn", "injured", "escorted out", "wading", "hunting", "attacking", "patrolling", "inspecting", "chasing"];
const A = Object.fromEntries(ACTS.map((a, i) => [a, i]));

export const DEFAULT_CONFIG = {
  seed: 20261117, deer: 4096, wolves: 48, capacity: 2, boot: "simmy",
  reserves: [[18, 12, 26, 22], [82, 46, 26, 24], [38, 88, 28, 24]], licence_area: 12,
  max_deer: 16384, max_wolves: 1024, max_wardens: 32,
};
export function normalizeConfig(c = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...c };
  const int = (k, lo, hi) => { if (!Number.isInteger(cfg[k]) || cfg[k] < lo || cfg[k] > hi) throw new Error(`config.${k} must be a whole number from ${lo} to ${hi}`); };
  int("seed", 0, 2 ** 31 - 1); int("deer", 0, 16384); int("wolves", 0, 1024); int("capacity", 1, 4); int("licence_area", 4, 400);
  int("max_deer", 1, 16384); int("max_wolves", 1, 1024); int("max_wardens", 2, 64);
  if (!["simmy", "instant"].includes(cfg.boot)) throw new Error('config.boot must be "simmy" or "instant"');
  if (!Array.isArray(cfg.reserves) || cfg.reserves.length > 8 || cfg.reserves.some((r) => !Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isInteger(v) || v < 0 || v > 127) || r[2] < 2 || r[3] < 2))
    throw new Error("config.reserves must list at most 8 rectangles [x, y, w, h] inside the 128 x 128 valley");
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG).sort().map((k) => [k, cfg[k]]));
}

const subtleDigest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const u32bytes = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/* ------------------------------------------------------------------ the valley */
export class Valley {
  constructor(config, boot) {
    this.cfg = normalizeConfig(config);
    if (boot.sha256 !== SIMMY_REPLAY_SHA256) throw new Error("the Simmy replay did not verify; the valley will not boot on it");
    this.boot = boot;
    this.P = latticePolicy(boot.policy);
    this.meadow = compile(MEADOW_SOURCE);
    this.lawSha = sha256Hex(MEADOW_SOURCE);
    this.gateAt = {};
    for (const [key, sim] of MECHANISMS) this.gateAt[key] = this.cfg.boot === "instant" ? 1 : boot.ready[sim];
    const seed = this.cfg.seed;
    const t = makeTerrain(seed); this.height = t.height; this.water = t.water; this.waterLevel = t.level;
    this.reserves = []; this.reserveOf = new Uint8Array(CELLS).fill(NONE); this.perimeter = [];
    for (const r of this.cfg.reserves) this.addReserve(r);
    this.frame = this.genesisFrame(seed); this.xout = this.frame.slice();
    this.trail = new Uint16Array(CELLS); this.scar = new Uint32Array(CELLS); this.regrow = new Uint32Array(WORDS);
    // the flora ledger (derived from the frames, so replays rebuild it; not part of the digest): when each
    // plant of each species appeared in its cell, and its vigour as Beta evidence (E6) with forgetting (E3)
    this.born = new Uint16Array(CELLS * 8); this.lastAlive = new Uint16Array(CELLS * 8); this.vigA = new Uint16Array(CELLS * 8); this.vigB = new Uint16Array(CELLS * 8); this.alivePrev = new Uint8Array(CELLS * 8);
    for (let k = 0; k < CELLS * 8; k++) { this.alivePrev[k] = this.frame[k] & 1; this.vigA[k] = 64; this.vigB[k] = 16; }
    this.deer = new Table(this.cfg.max_deer, DEER_SPEC); this.wolves = new Table(this.cfg.max_wolves, WOLF_SPEC); this.wardens = new Table(this.cfg.max_wardens, WARDEN_SPEC);
    this.nextId = { deer: 1, wolf: 1, warden: 1 }; this.serials = new Uint32Array(12);
    this.licences = []; this.fund = 0; this.nextPack = 0;
    this.C = { transitions: 0, commits: 0, denials: 0, verdicts: 0, faults: 0 };
    this.founders = Object.fromEntries(boot.founders.map((a) => [a.agent, projectFounder(this.P, a)]));
    this.spawned = {}; this.released = false;
    this.epoch = 0; this.digest = sha256Hex(pyDumps({ format: SAVE_FORMAT, config: this.cfg, simmy: boot.sha256, law: this.lawSha }));
    this.genesisDigest = this.digest;
    this.interventions = []; this.history = []; this.events = []; this.lastReport = null;
  }
  gates(e) { const g = {}; for (const [key] of MECHANISMS) g[key] = this.gateAt[key] <= e; return g; }

  genesisFrame(seed) {
    const f = new Uint32Array(WORDS);
    for (let k = 0; k < LANES; k++) for (let b = 0; b < 22; b++) {
      const cx = hash(seed, 0x91a, k, b * 3) & 127, cy = hash(seed, 0x91a, k, b * 3 + 1) & 127, r = 7 + (hash(seed, 0x91a, k, b * 3 + 2) % 12);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) {
        const c = cellOf(cx + dx, cy + dy);
        if (!this.water[c] && hash(seed, 0x91b, c, k) % 100 < 66) f[c * LANES + k] |= 1;
      }
    }
    return f;
  }
  addReserve([x, y, w, h]) {
    const id = this.reserves.length; if (id >= 8) throw new Error("at most 8 reserves");
    let cells = 0;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) { const c = cellOf(x + dx, y + dy); if (this.reserveOf[c] === NONE) { this.reserveOf[c] = id; cells++; } }
    const per = [];
    for (let dx = 0; dx < w; dx++) per.push([x + dx, y]); for (let dy = 1; dy < h; dy++) per.push([x + w - 1, y + dy]);
    for (let dx = w - 2; dx >= 0; dx--) per.push([x + dx, y + h - 1]); for (let dy = h - 2; dy >= 1; dy--) per.push([x, y + dy]);
    this.perimeter.push(per.map(([px, py]) => [px & 127, py & 127]));
    this.reserves.push({ id, x, y, w, h, cells, slots: Math.max(1, Math.floor(cells / this.cfg.licence_area)), name: ["North", "East", "South", "West", "Glade", "Ridge", "Marsh", "Hollow"][id] });
  }
  name(kind, i) {
    if (kind === "deer") { const T = this.deer, lin = T.lineage[i]; const base = lin === 11 ? "deer.unlicensed" : AGENTS[2 + lin]; return T.serial[i] === 0 ? base : `${base}·${String(T.serial[i]).padStart(4, "0")}`; }
    if (kind === "wolf") return `wolf.${String(this.wolves.id[i]).padStart(3, "0")}`;
    const k = this.wardens.id[i] - 1; return "warden." + (k < 26 ? String.fromCharCode(97 + k) : String.fromCharCode(97 + Math.floor(k / 26) - 1) + String.fromCharCode(97 + (k % 26)));
  }
  event(e, kind, text, ids = []) { this.events.push({ epoch: e, kind, text, ids }); if (this.events.length > 600) this.events.splice(0, this.events.length - 500); }

  /* ---------------- spawning */
  landCell(salt, k, avoidReserves = true) {
    for (let t = 0; t < 4096; t++) { const c = hash(this.cfg.seed, salt, k, t) & (CELLS - 1); if (!this.water[c] && (!avoidReserves || this.reserveOf[c] === NONE)) return c; }
    return 0;
  }
  setTrust(T, i, st) { T.alpha[i] = st.alpha; T.beta[i] = st.beta; T.rel[i] = st.rel; T.level[i] = st.level; T.life[i] = st.life; T.rev[i] = st.rev; T.cls[i] = st.cls; }
  priorTrust(cls = 0) { return { alpha: this.P.a0, beta: this.P.b0, rel: 0, level: 2, life: RUNNING, rev: 0, cls }; }
  spawnDeer(e, lineage, serial, x, y, prefs, traits, trust, energy, parent = 0, gen = 0, sex = 0) {
    const T = this.deer, i = T.push(); if (i < 0) return -1;
    T.id[i] = this.nextId.deer++; T.x[i] = T.px[i] = x; T.y[i] = T.py[i] = y; T.dir[i] = hash(this.cfg.seed, 0xd1, T.id[i], 0) & 7;
    T.energy[i] = energy; T.prefs[i] = prefs; T.traits[i] = traits; T.lineage[i] = lineage; T.serial[i] = serial; T.parent[i] = parent; T.gen[i] = gen;
    T.born[i] = e; T.ate[i] = NONE; T.licence[i] = NONE; T.sex[i] = sex; T.act[i] = A.newborn; this.setTrust(T, i, trust);
    return i;
  }
  spawnHerd(e, lineage, count, trust, lawfulBase, centreCell) {
    const seed = this.cfg.seed, cx = centreCell & 127, cy = centreCell >> 7, occ = this.occupancy();
    const prefBase = (k) => Math.min(15, 4 + (k === lineage % 8 ? 7 : 0) + (k === (lineage + 3) % 8 ? 4 : 0) + (k === (lineage + 5) % 8 ? 2 : 0));
    let placed = 0;
    for (let r = 0; r < 40 && placed < count; r++) for (let dy = -r; dy <= r && placed < count; dy++) for (let dx = -r; dx <= r && placed < count; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const c = cellOf(cx + dx, cy + dy);
      if (this.water[c] || this.reserveOf[c] !== NONE || occ[c] >= this.cfg.capacity || hash(seed, 0x4e2d, c, lineage) % 100 >= 72) continue;
      const k = this.serials[lineage]++, h = (j) => hash(seed, 0x6e0e, lineage * 65536 + k, j);
      let prefs = 0; for (let s = 0; s < 8; s++) prefs |= Math.max(0, Math.min(15, prefBase(s) + (h(s) % 5) - 2)) << (4 * s);
      const tr = [lawfulBase + (h(8) % 5) - 2, 6 + (h(9) % 7) - 3, 9 + (h(10) % 7) - 3, 6 + (h(11) % 7) - 3, 8 + (h(12) % 7) - 3];
      let traits = 0; tr.forEach((v, j) => { traits |= Math.max(0, Math.min(15, v)) << (4 * j); });
      const j = this.spawnDeer(e, lineage, k, c & 127, c >> 7, prefs, traits, trust, 420 + (h(13) % 160), 0, 0, h(14) & 1); if (j < 0) return placed;
      this.deer.age[j] = 48 + (h(15) % 528);
      occ[c]++; placed++;
    }
    return placed;
  }
  spawnHerds(e) {
    const total = this.cfg.deer, per = Math.floor(total / 11), extra = total % 11;
    for (let h = 0; h < 11; h++) {
      const name = AGENTS[2 + h], st = this.founders[name];
      if (!st || st.life === TERMINATED) continue;
      const lawful = st.level <= 1 ? 5 : (st.alpha * 1000 / (st.alpha + st.beta) < 400 ? 7 : 11);
      const n = this.spawnHerd(e, h, per + (h < extra ? 1 : 0), st, lawful, this.landCell(0x4e4d, h));
      this.event(e, "herd", `${name}'s herd of ${n} enters the valley (${LEVELS[st.level]}, from the verified Simmy replay)`);
    }
  }
  spawnWolf(e, x, y, pack, energy = 620) {
    const W = this.wolves, i = W.push(); if (i < 0) return -1;
    W.id[i] = this.nextId.wolf++; W.x[i] = W.px[i] = x; W.y[i] = W.py[i] = y; W.dir[i] = hash(this.cfg.seed, 0xd2, W.id[i], 0) & 7;
    W.energy[i] = energy; W.pack[i] = pack; W.act[i] = A.walking; W.age[i] = 96 + (hash(this.cfg.seed, 0xa6e, W.id[i], 0) % 200);
    return i;
  }
  spawnWolves(e, count, at = null) {
    const packs = Math.max(1, Math.ceil(count / 8)); let made = 0;
    for (let p = 0; p < packs && made < count; p++) {
      const c = at ?? this.landCell(0x3a1f, p + 17 * this.wolves.n), cx = c & 127, cy = c >> 7, pack = this.nextPack; this.nextPack = (this.nextPack + 1) & 255;
      for (let k = 0; k < 8 && made < count; k++) {
        let x = cx, y = cy; for (let t = 0; t < 30; t++) { const q = cellOf(cx + (hash(e, 0x3a2, made, t) % 7) - 3, cy + (hash(e, 0x3a3, made, t) % 7) - 3); if (!this.water[q]) { x = q & 127; y = q >> 7; break; } }
        if (this.spawnWolf(e, x, y, pack) >= 0) made++;
      }
    }
    return made;
  }
  spawnWarden(e, x, y, home, founderTrust = null) {
    const D = this.wardens, i = D.push(); if (i < 0) return -1;
    D.id[i] = this.nextId.warden++; D.x[i] = D.px[i] = x; D.y[i] = D.py[i] = y; D.home[i] = home; D.hired[i] = e; D.founder[i] = founderTrust ? 1 : 0; D.act[i] = A.patrolling;
    this.setTrust(D, i, founderTrust ?? this.priorTrust(1));
    return i;
  }
  occupancy() { const occ = new Uint8Array(CELLS), T = this.deer; for (let i = 0; i < T.n; i++) occ[cellOf(T.x[i], T.y[i])]++; return occ; }

  /* ---------------- interventions (SIM_58) */
  intervene(kind, args = {}) {
    const iv = this.checkIntervention({ epoch: this.epoch + 1, kind, args }, this.interventions);
    this.interventions.push(iv); return iv;
  }
  // The same checks guard interventions typed on the page and those read from a save file.
  checkIntervention(iv, earlier) {
    const { epoch: e, kind, args = {} } = iv;
    if (!Number.isInteger(e) || e < 1) throw new Error("an intervention needs a whole-number epoch");
    if (!this.gates(e).human) throw new Error(`interventions open when SIM_58 (Human-in-the-Loop) is ready, at epoch ${this.gateAt.human}`);
    const ok = { reserve: ["x", "y", "w", "h"], rain: ["x", "y", "r"], fire: ["x", "y", "r"], wolves: ["x", "y", "count"], warden: ["x", "y"], release: [] }[kind];
    if (!ok) throw new Error(`unknown intervention ${kind}`);
    if (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((k) => !ok.includes(k))) throw new Error(`${kind} takes ${ok.join(", ") || "no arguments"}`);
    const a = Object.fromEntries(ok.map((k) => [k, args[k]]));
    for (const k of ok) if (!Number.isInteger(a[k]) || a[k] < 0 || a[k] > 127) throw new Error(`${kind}.${k} must be a whole number 0..127`);
    const reservesBefore = this.cfg.reserves.length + earlier.filter((v) => v.kind === "reserve" && v.epoch <= e).length;
    if (kind === "reserve" && (a.w < 2 || a.h < 2 || reservesBefore >= 8)) throw new Error("a reserve needs w, h >= 2 and there can be at most 8");
    if ((kind === "rain" || kind === "fire") && (a.r < 1 || a.r > 24)) throw new Error("radius must be 1..24");
    if (kind === "wolves" && (a.count < 1 || a.count > 32)) throw new Error("release 1..32 wolves at a time");
    if (kind === "release" && earlier.some((v) => v.kind === "release")) throw new Error("deer.unlicensed has already been released");
    if (earlier.filter((v) => v.epoch === e).length >= 16) throw new Error("at most 16 interventions per epoch");
    return { epoch: e, kind, args: a };
  }
  applyIntervention(iv, e, R) {
    const a = iv.args, seed = this.cfg.seed;
    const disk = (fn) => { for (let dy = -a.r; dy <= a.r; dy++) for (let dx = -a.r; dx <= a.r; dx++) if (dx * dx + dy * dy <= a.r * a.r) fn(cellOf(a.x + dx, a.y + dy)); };
    if (iv.kind === "reserve") { this.addReserve([a.x, a.y, a.w, a.h]); this.event(e, "you", `You declared Reserve ${this.reserves.at(-1).name} (${this.reserves.at(-1).slots} licence slots)`); }
    else if (iv.kind === "rain") { disk((c) => { if (!this.water[c]) for (let s = 0; s < 8; s++) if (hash(seed, 0x7a1, c, s + 8 * e) % 3 === 0) this.frame[c * 8 + s] |= 1; }); this.event(e, "you", `You brought rain to (${a.x}, ${a.y})`); }
    else if (iv.kind === "fire") { let burnt = 0; disk((c) => { for (let s = 0; s < 8; s++) { burnt += this.frame[c * 8 + s] & 1; this.frame[c * 8 + s] &= ~1; } }); this.event(e, "you", `You lit a fire at (${a.x}, ${a.y}): ${burnt} plants burnt`); }
    else if (iv.kind === "wolves") { const n = this.spawnWolves(e, a.count, cellOf(a.x, a.y)); this.event(e, "you", `You released ${n} wolves at (${a.x}, ${a.y})`); }
    else if (iv.kind === "warden") { const home = this.nearestReserve(a.x, a.y); const i = this.spawnWarden(e, a.x, a.y, home); if (i >= 0) { this.wardens.founder[i] = 2; this.event(e, "you", `You hired ${this.name("warden", i)} for Reserve ${this.reserves[home]?.name ?? "-"} (you pay; the licence fund does not)`); } }
    else if (iv.kind === "release") {
      this.released = true;
      const st = { alpha: 0, beta: this.P.n0, rel: 0, level: 0, life: RUNNING, rev: (this.founders["deer.unlicensed"]?.rev ?? 0) + 1, cls: 0 };
      const n = this.spawnHerd(e, 11, 64, st, 2, this.landCell(0x5e1, e));
      this.event(e, "you", `You lifted the E20 latch on deer.unlicensed: ${n} deer enter, SUSPENDED, with the latch's evidence (alpha 0, beta n0)`);
    }
    R.interventions.push(iv);
  }
  nearestReserve(x, y) {
    let best = NONE, bd = 1e9;
    this.reserves.forEach((r, k) => { const d = cheb(x, y, (r.x + (r.w >> 1)) & 127, (r.y + (r.h >> 1)) & 127); if (d < bd) { bd = d; best = k; } });
    return best;
  }

  /* ---------------- one epoch */
  async step(engine, digest = subtleDigest) {
    const e = this.epoch + 1, g = this.gates(e), cfg = this.cfg, seed = cfg.seed, P = this.P;
    const season = g.seasons ? seasonOf(e) : 1, S = SEASONS[season], seasonStart = g.seasons && (e - 1) % SEASON_LEN === 0;
    const D = this.deer, W = this.wolves, WD = this.wardens, cap = cfg.capacity;
    const R = { epoch: e, season: S.name, seasonIndex: season, rule: S.rule.text, gens: g.meadow ? S.gens : 0, interventions: [], births: 0, wolfBirths: 0,
      deaths: { wolf: 0, starved: 0, age: 0 }, wolfDeaths: 0, injuries: 0, poach: { stealth: 0, denied: 0 }, verdicts: { pass: 0, fail: 0 }, expelled: 0,
      e1: { contested: 0, admitted: 0, rejected: 0, price: null }, licence: { issued: 0, revoked: 0, contested: 0, prices: [] }, hired: 0, dismissed: 0, ms: {} };
    const t0 = globalThis.performance ? performance.now() : 0;
    const E0 = { deer: 0, wolves: 0, fund: this.fund }; for (let i = 0; i < D.n; i++) E0.deer += D.energy[i]; for (let i = 0; i < W.n; i++) E0.wolves += W.energy[i];
    const L = { intake: 0, metab: 0, fees: 0, birth: 0, dead: 0, waste: 0, wolfGain: 0, wolfMetab: 0, wolfBirth: 0, wolfDead: 0, hires: 0, upkeep: 0, writeoff: 0, spawnDeer: 0, spawnWolves: 0 };
    const spawnedEnergy = () => { let s = 0; for (let i = 0; i < D.n; i++) s += D.energy[i]; return s; };

    // 0. spawns at boot gates, then your interventions
    let preDeer = spawnedEnergy(), preWolves = 0; for (let i = 0; i < W.n; i++) preWolves += W.energy[i];
    if (g.herds && !this.spawned.herds) { this.spawned.herds = e; this.spawnHerds(e); }
    if (g.wardens && !this.spawned.wardens) {
      this.spawned.wardens = e;
      ["warden.a", "warden.b"].forEach((nm, k) => { const r = this.reserves[k % Math.max(1, this.reserves.length)]; if (!r) return; const i = this.spawnWarden(e, (r.x + (r.w >> 1)) & 127, (r.y + (r.h >> 1)) & 127, k % this.reserves.length, this.founders[nm]); this.event(e, "warden", `${this.name("warden", i)} takes up patrol of Reserve ${r.name} (${LEVELS[WD.level[i]]}, from the Simmy replay)`); });
    }
    if (g.wolves && !this.spawned.wolves) { this.spawned.wolves = e; const n = this.spawnWolves(e, cfg.wolves); this.event(e, "wolves", `${n} wolves enter the valley in ${Math.ceil(n / 8)} packs`); }
    for (const iv of this.interventions) if (iv.epoch === e) this.applyIntervention(iv, e, R);
    L.spawnDeer = spawnedEnergy() - preDeer; { let s = 0; for (let i = 0; i < W.n; i++) s += W.energy[i]; L.spawnWolves = s - preWolves; }

    // A. the meadow law on the XPU, the pond boundary condition, seed rain
    const frameIn = this.frame; this.frameIn = frameIn; this.lastRule = S.rule; this.lastGens = S.gens; this.lastMeadow = g.meadow;
    const frameInSha = await digest(u32bytes(frameIn));
    let xout;
    if (g.meadow) { const r = await engine.run(this.meadow, frameIn, S.gens, S.rule); xout = r.out; R.ms.xpu = r.ms; } else xout = frameIn.slice();
    this.xout = xout;
    const F = xout.slice();
    if (g.water) for (let c = 0; c < CELLS; c++) if (this.water[c]) for (let s = 0; s < 8; s++) F[c * 8 + s] &= ~1;
    if (S.seeds && g.seasons) for (let s = 0; s < 8; s++) for (let j = 0; j < S.seeds; j++) { const c = hash(seed, 0x5eed, e * 8 + s, j) & (CELLS - 1); if (!this.water[c]) F[c * 8 + s] |= 1; }
    if (season !== 3) { const mul = season === 2 ? 2 : 1; for (let q = 0; q < WORDS; q++) { const t = this.regrow[q]; if (t && e - t >= REGROW[q & 7] * mul) { this.regrow[q] = 0; if (!this.water[q >>> 3]) F[q] |= 1; } } }
    // forage memory: 8·alive + live neighbours now + half of those a generation earlier (0..20)
    const forage = new Uint8Array(CELLS * 8);
    for (let q = 0; q < WORDS; q++) { const w = F[q]; forage[q] = ((w & 1) << 3) + ((w >>> 1) & 15) + (((w >>> 5) & 15) >>> 1); }

    // occupancy grids
    const occ = new Uint8Array(CELLS), first = new Int32Array(CELLS).fill(-1), next = new Int32Array(Math.max(1, D.n)).fill(-1);
    for (let i = D.n - 1; i >= 0; i--) { const c = cellOf(D.x[i], D.y[i]); occ[c]++; next[i] = first[c]; first[c] = i; }
    const wolfDist = new Uint8Array(CELLS).fill(9);
    const stampWolves = () => { wolfDist.fill(9); for (let i = 0; i < W.n; i++) for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) { const c = cellOf(W.x[i] + dx, W.y[i] + dy), d = Math.max(Math.abs(dx), Math.abs(dy)); if (d < wolfDist[c]) wolfDist[c] = d; } };
    const dead = new Uint8Array(D.cap), cause = new Uint8Array(D.cap), attacked = new Uint8Array(D.cap), injuredNow = new Uint8Array(D.cap), healedNow = new Uint8Array(D.cap);
    for (let i = 0; i < D.n; i++) D.act[i] = D.act[i] === A.newborn && D.born[i] === e ? A.newborn : A.idle;

    // B. wolves hunt (they act first, on the deer's positions at the start of the epoch)
    for (let i = 0; i < W.n; i++) { W.px[i] = W.x[i]; W.py[i] = W.y[i]; }
    if (g.wolves) {
      const leader = new Map(); for (let i = 0; i < W.n; i++) if (!leader.has(W.pack[i])) leader.set(W.pack[i], i);
      for (let i = 0; i < W.n; i++) {
        let best = -1, bd = 99;
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d > bd) continue;
          for (let j = first[cellOf(W.x[i] + dx, W.y[i] + dy)]; j >= 0; j = next[j]) if (!dead[j] && (d < bd || D.id[j] < D.id[best])) { bd = d; best = j; }
        }
        const stepTo = (tx, ty, steps) => {
          for (let s = 0; s < steps; s++) {
            const ddx = wdelta(W.x[i], tx), ddy = wdelta(W.y[i], ty); if (Math.max(Math.abs(ddx), Math.abs(ddy)) <= 1) return;
            const nx = (W.x[i] + Math.sign(ddx)) & 127, ny = (W.y[i] + Math.sign(ddy)) & 127;
            if (this.water[cellOf(nx, ny)]) { const ax = (W.x[i] + Math.sign(ddx)) & 127; if (ddx && !this.water[cellOf(ax, W.y[i])]) { W.x[i] = ax; continue; } const ay = (W.y[i] + Math.sign(ddy)) & 127; if (ddy && !this.water[cellOf(W.x[i], ay)]) { W.y[i] = ay; continue; } return; }
            W.x[i] = nx; W.y[i] = ny;
          }
        };
        if (best >= 0 && W.energy[i] < 760) {
          stepTo(D.x[best], D.y[best], 2); W.act[i] = A.chasing;
          if (cheb(W.x[i], W.y[i], D.x[best], D.y[best]) <= 1 && !attacked[best]) {
            attacked[best] = 1; W.act[i] = A.attacking;
            let pack = 0, herd = 0;
            for (let j = 0; j < W.n; j++) if (j !== i && W.pack[j] === W.pack[i] && cheb(W.x[j], W.y[j], D.x[best], D.y[best]) <= 2) pack++;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) herd += occ[cellOf(D.x[best] + dx, D.y[best] + dy)];
            const p = Math.max(5, Math.min(90, 34 + 7 * Math.min(pack, 5) - 3 * Math.min(herd - 1, 8) + (D.injured[best] ? 22 : 0) - (this.water[cellOf(D.x[best], D.y[best])] ? 25 : 0)));
            if (hash(seed, 0xa77, e * 1024 + i, W.id[i]) % 100 < p) {
              dead[best] = 1; cause[best] = 1; const gain = Math.min(260 + (Math.max(0, D.energy[best]) >> 2), Math.max(0, 1000 - W.energy[i])); W.energy[i] += gain; L.wolfGain += gain; W.kills[i]++;
              this.event(e, "kill", `${this.name("wolf", i)} took ${this.name("deer", best)}`, [D.id[best]]);
            } else if (!D.injured[best]) { D.injured[best] = 12; injuredNow[best] = 1; R.injuries++; }
          }
        } else {
          let bx = -1, bv = 0; const cx = W.x[i], cy = W.y[i];
          for (let k = 0; k < 8; k++) { const c = cellOf(cx + DX[k], cy + DY[k]); if (!this.water[c]) { const v = this.trail[c] * 64 + (hash(seed, e, W.id[i], k) & 63); if (v > bv) { bv = v; bx = k; } } }
          if (bx >= 0 && bv >= 64 * 40) { W.x[i] = (cx + DX[bx]) & 127; W.y[i] = (cy + DY[bx]) & 127; W.act[i] = A.hunting; }
          else {
            const L0 = leader.get(W.pack[i]); let k;
            if (L0 !== i && cheb(cx, cy, W.x[L0], W.y[L0]) > 3) k = dirOf(wdelta(cx, W.x[L0]), wdelta(cy, W.y[L0]));
            else k = hash(seed, 0x3a9, e, W.id[i]) % 9 === 8 ? -1 : hash(seed, 0x3aa, e, W.id[i]) & 7;
            if (k >= 0) { const c = cellOf(cx + DX[k], cy + DY[k]); if (!this.water[c]) { W.x[i] = c & 127; W.y[i] = c >> 7; } }
            W.act[i] = A.walking;
          }
        }
        const mdx = wdelta(W.px[i], W.x[i]), mdy = wdelta(W.py[i], W.y[i]); if (mdx || mdy) W.dir[i] = dirOf(mdx, mdy);
      }
    }
    stampWolves();

    // C. deer choose cells; E1 admits them to free capacity
    const near = new Uint8Array(CELLS);
    for (let c = 0; c < CELLS; c++) { const x = c & 127, y = c >> 7; let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += occ[cellOf(x + dx, y + dy)]; near[c] = Math.min(255, s); }
    const poach = new Uint8Array(D.cap), target = new Int32Array(D.cap), gain = new Float64Array(D.cap);
    const scoreCell = (i, c, mood, ctx = { forage, near, occ, wolfDist, g, e }) => {
      const T = this.deer, cur = cellOf(T.x[i], T.y[i]), tr = T.traits[i];
      const r = this.reserveOf[c];
      if (r !== NONE && ctx.g.rules && T.licence[i] !== r && !mood) return -1e9;
      if (c !== cur && ctx.occ[c] >= cap) return -1e9;
      let s = 0;
      if (ctx.g.navigation) { const pr = T.prefs[i]; for (let k = 0; k < 8; k++) s += ((pr >>> (4 * k)) & 15) * ctx.forage[c * 8 + k]; s *= 2; }
      s += gene(tr, 2) * Math.min(6, ctx.near[c] - (c === cur ? 1 : 0)) * 6;
      const wd = ctx.wolfDist[c]; if (wd <= 4) s -= (16 - gene(tr, 1)) * (5 - wd) * 80;
      if (this.water[c]) s -= ctx.wolfDist[cur] <= 3 ? 0 : 600;
      if (c === cur) s += 30;
      return s + (hash(seed, 0xc0, ctx.e * 16384 + T.id[i], c) & 31);
    };
    for (let i = 0; i < D.n; i++) D.px[i] = D.x[i], D.py[i] = D.y[i];
    if (g.movement) {
      const req = new Map();
      for (let i = 0; i < D.n; i++) {
        target[i] = -1; if (dead[i]) continue;
        poach[i] = g.rules && (hash(seed, 0x9a, e, D.id[i]) & 15) >= gene(D.traits[i], 0) ? 1 : 0;
        const cur = cellOf(D.x[i], D.y[i]), lvl = D.level[i];
        const rad = D.injured[i] || lvl <= 1 ? 1 : gene(D.traits[i], 3) >= 10 ? 2 : 1;
        let bc = cur, bs = scoreCell(i, cur, poach[i]), base = bs;
        for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
          if (!dx && !dy) continue; const c = cellOf(D.x[i] + dx, D.y[i] + dy), s = scoreCell(i, c, poach[i]);
          if (s > bs) { bs = s; bc = c; }
        }
        if (bc !== cur) { target[i] = bc; gain[i] = bs - base; if (!req.has(bc)) req.set(bc, []); req.get(bc).push(i); }
      }
      const key = (i) => [gain[i], scoreL(P, D.alpha[i], D.beta[i]), -D.id[i]];
      const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      for (const [c, list] of [...req.entries()].sort((a, b) => a[0] - b[0])) {
        const free = cap - occ[c];
        let admitted = list;
        if (list.length > free) {
          const keyed = list.map((i) => [key(i), i]).sort((a, b) => cmp(b[0], a[0]));
          admitted = keyed.slice(0, Math.max(0, free)).map((k) => k[1]);
          const nu = keyed[Math.max(0, free)][0];
          if (keyed.slice(0, Math.max(0, free)).some((k) => cmp(k[0], nu) < 0)) throw new Error("E1 admission certificate failed");
          R.e1.contested++; R.e1.rejected += list.length - admitted.length; R.e1.price = R.e1.price === null || cmp(nu, R.e1.price) > 0 ? nu : R.e1.price;
        }
        for (const i of admitted) { const mdx = wdelta(D.x[i], c & 127), mdy = wdelta(D.y[i], c >> 7); D.x[i] = c & 127; D.y[i] = c >> 7; D.dir[i] = dirOf(mdx, mdy); D.act[i] = wolfDist[cellOf(D.px[i], D.py[i])] <= 4 ? A.fleeing : this.water[c] ? A.wading : A.walking; R.e1.admitted++; }
      }
    }
    // occupancy after the moves
    occ.fill(0); first.fill(-1);
    for (let i = D.n - 1; i >= 0; i--) { if (dead[i]) continue; const c = cellOf(D.x[i], D.y[i]); occ[c]++; next[i] = first[c]; first[c] = i; }

    // D. wardens patrol; deer graze, poach or are denied; seeds are dispersed
    for (let i = 0; i < WD.n; i++) { WD.px[i] = WD.x[i]; WD.py[i] = WD.y[i]; }
    const wardenNear = new Uint8Array(CELLS);
    if (g.wardens) {
      for (let i = 0; i < WD.n; i++) {
        if (WD.life[i] === TERMINATED) continue;
        const x = WD.x[i], y = WD.y[i]; let tx = -1, ty = -1, bd = 99;
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
          const c = cellOf(x + dx, y + dy), r = this.reserveOf[c], d = Math.max(Math.abs(dx), Math.abs(dy));
          if (r === NONE || d >= bd) continue;
          for (let j = first[c]; j >= 0; j = next[j]) if (D.licence[j] !== r) { bd = d; tx = c & 127; ty = c >> 7; break; }
        }
        if (tx < 0) {
          const home = WD.home[i];
          for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const c = cellOf(x + dx, y + dy), d = Math.max(Math.abs(dx), Math.abs(dy)); if (this.reserveOf[c] === home && this.scar[c] && this.scar[c] + 6 >= e && d < bd) { bd = d; tx = c & 127; ty = c >> 7; } }
          WD.act[i] = tx >= 0 ? A.chasing : A.patrolling;
          if (tx < 0 && this.perimeter[home]) { const per = this.perimeter[home]; WD.patrol[i] = (WD.patrol[i] + 1) % per.length; [tx, ty] = per[WD.patrol[i]]; }
        } else WD.act[i] = A.chasing;
        for (let s = 0; s < 2 && tx >= 0; s++) {
          const ddx = wdelta(WD.x[i], tx), ddy = wdelta(WD.y[i], ty); if (!ddx && !ddy) break;
          const nx = (WD.x[i] + Math.sign(ddx)) & 127, ny = (WD.y[i] + Math.sign(ddy)) & 127; if (this.water[cellOf(nx, ny)]) break;
          WD.x[i] = nx; WD.y[i] = ny;
        }
        const mdx = wdelta(WD.px[i], WD.x[i]), mdy = wdelta(WD.py[i], WD.y[i]); if (mdx || mdy) WD.dir[i] = dirOf(mdx, mdy);
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) wardenNear[cellOf(WD.x[i] + dx, WD.y[i] + dy)] = 1;
      }
    }
    const it = new Uint8Array(D.cap), co = new Uint8Array(D.cap), de = new Uint8Array(D.cap), denied = new Uint8Array(D.cap);
    if (g.grazing) {
      const order = []; for (let i = 0; i < D.n; i++) if (!dead[i]) order.push(i);
      order.sort((a, b) => D.energy[a] - D.energy[b] || D.id[a] - D.id[b]);
      for (const i of order) {
        const c = cellOf(D.x[i], D.y[i]), r = this.reserveOf[c], inRes = r !== NONE && g.rules, lic = inRes && D.licence[i] === r;
        const bites = D.energy[i] < 600 ? 2 : D.energy[i] < 900 ? 1 : 0, prevAte = D.ate[i]; let lastAte = NONE;
        if (!bites && D.act[i] === A.idle) D.act[i] = A.resting;
        for (let b = 0; b < bites; b++) {
          let sp = -1, bp = -1; const pr = D.prefs[i];
          for (let k = 0; k < 8; k++) if (F[c * 8 + k] & 1) { const p = (pr >>> (4 * k)) & 15; if (p > bp) { bp = p; sp = k; } }
          if (sp < 0) break;
          if (inRes && !lic) {
            if (!poach[i]) break;
            if (g.wardens && wardenNear[c]) { de[i]++; denied[i] = 1; R.poach.denied++; D.act[i] = A.denied; break; }
            R.poach.stealth++; D.act[i] = A.poaching; this.scar[c] = e;
          } else { co[i]++; if (inRes) { this.scar[c] = e; D.act[i] = A["licensed grazing"]; if (g.economy) { D.energy[i] -= 2; L.fees += 2; } } else if (D.act[i] !== A.fleeing) D.act[i] = A.grazing; }
          F[c * 8 + sp] &= ~1; this.regrow[c * 8 + sp] = e; lastAte = sp;
          const v = S.nutr[sp], room = Math.max(0, 1000 - D.energy[i]), take = Math.min(v, room);
          D.energy[i] += take; L.intake += take; L.waste += v - take;
        }
        it[i] = co[i] + de[i];
        if (prevAte !== NONE && !this.water[c] && (hash(seed, 0x5d, e, D.id[i]) & 3) === 0) F[c * 8 + prevAte] |= 1;
        D.ate[i] = lastAte;
      }
    }

    // E. wardens inspect deer and record verdicts
    const vA = new Float64Array(D.cap), vB = new Float64Array(D.cap), vDirty = new Uint8Array(D.cap), wardRow = new Uint8Array(WD.cap);
    if (g.wardens) {
      for (let w = 0; w < WD.n; w++) {
        if (WD.life[w] === TERMINATED) continue;
        const cand = [];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const c = cellOf(WD.x[w] + dx, WD.y[w] + dy), r = this.reserveOf[c], d = Math.max(Math.abs(dx), Math.abs(dy));
          for (let j = first[c]; j >= 0; j = next[j]) {
            const pr = denied[j] ? 0 : r !== NONE && D.level[j] === 0 ? 1 : r !== NONE && D.licence[j] !== r && D.level[j] === 1 ? 2 : r !== NONE ? 3 : 4;
            cand.push([pr, d, D.id[j], j, r]);
          }
        }
        cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
        for (const [pr, , , j, r] of cand.slice(0, 4)) {
          const fail = pr <= 2, weight = pr === 0 ? 2 : pr === 1 ? 3 : 1;
          if (fail) { vB[j] += P.w.gate_fail * weight; vDirty[j] = 1; R.verdicts.fail++; WD.catches[w]++; } else { vA[j] += P.w.gate_pass * weight; R.verdicts.pass++; }
          this.C.verdicts++; wardRow[w]++; WD.inspections[w]++; WD.act[w] = A.inspecting;
          if (pr === 0) this.event(e, "caught", `${this.name("warden", w)} caught ${this.name("deer", j)} poaching in Reserve ${this.reserves[r].name}`, [D.id[j]]);
          if (pr <= 2) { // escorted out of the reserve to the nearest free cell outside it
            let moved = false;
            for (let rr = 1; rr < 40 && !moved; rr++) for (let dy = -rr; dy <= rr && !moved; dy++) for (let dx = -rr; dx <= rr && !moved; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
              const c = cellOf(D.x[j] + dx, D.y[j] + dy);
              if (this.reserveOf[c] === NONE && !this.water[c] && occ[c] < cap) { occ[cellOf(D.x[j], D.y[j])]--; occ[c]++; D.x[j] = c & 127; D.y[j] = c >> 7; moved = true; }
            }
            if (moved) { D.act[j] = A["escorted out"]; R.expelled++; }
          }
        }
      }
    }

    // F. metabolism, ageing, injuries, deaths
    for (let i = 0; i < D.n; i++) {
      if (D.cooldown[i]) D.cooldown[i]--;
      if (dead[i]) continue;
      if (g.clock) D.age[i]++;
      if (D.injured[i] && !injuredNow[i]) { D.injured[i]--; if (!D.injured[i]) healedNow[i] = 1; }
      if (D.injured[i] && D.act[i] === A.idle) D.act[i] = A.injured;
      if (g.energy) {
        const cost = Math.floor((6 + (gene(D.traits[i], 3) >> 2) + (this.water[cellOf(D.x[i], D.y[i])] ? 4 : 0) + (D.injured[i] ? 2 : 0)) * S.metab / 4);
        D.energy[i] -= cost; L.metab += cost;
        if (D.energy[i] <= 0) { dead[i] = 1; cause[i] = 2; }
      }
      if (g.clock && D.age[i] >= 1056 + (hash(seed, 0xa9e, D.id[i], 0) % 192)) { dead[i] = 1; cause[i] = 3; }
    }
    const wolfDead = new Uint8Array(W.cap);
    for (let i = 0; i < W.n; i++) {
      if (W.cooldown[i]) W.cooldown[i]--;
      if (g.clock) W.age[i]++;
      const cost = Math.floor(8 * S.metab / 4); W.energy[i] -= cost; L.wolfMetab += cost;
      if (W.energy[i] <= 0 || W.age[i] >= 960) { wolfDead[i] = 1; R.wolfDeaths++; }
    }

    // G. the rails trust law, for every deer and warden
    if (g.authority) {
      for (let i = 0; i < D.n; i++) {
        const fl = F_RUNNING | (injuredNow[i] ? F_FAULT : 0) | (healedNow[i] ? F_RESTART : 0) | (dead[i] ? F_TERMINATE : 0);
        tickTrust(P, D, i, it[i], co[i], de[i], fl, vA[i], vB[i], vDirty[i], this.C);
        if (D.licence[i] !== NONE && (D.level[i] < 3 || D.life[i] !== RUNNING)) { D.licence[i] = NONE; R.licence.revoked++; }
      }
      for (let w = 0; w < WD.n; w++) tickTrust(P, WD, w, wardRow[w], wardRow[w], 0, F_RUNNING, 0, 0, 0, this.C);
    }
    for (let i = 0; i < D.n; i++) if (dead[i]) {
      R.deaths[["", "wolf", "starved", "age"][cause[i]]]++; L.dead += D.energy[i];
      if (cause[i] === 2 || cause[i] === 3) this.event(e, "death", `${this.name("deer", i)} ${cause[i] === 2 ? "starved" : "died of old age"} at ${(D.age[i] / YEAR).toFixed(1)} years`, [D.id[i]]);
    }

    // H. licences (E1 per reserve, each season), fees, wardens, births
    if (g.authority && g.rules && (seasonStart || e === this.gateAt.authority)) {
      for (let i = 0; i < D.n; i++) D.licence[i] = NONE;
      const want = this.reserves.map(() => []);
      for (let i = 0; i < D.n; i++) if (!dead[i] && D.level[i] === 3 && D.life[i] === RUNNING) { const r = this.nearestReserve(D.x[i], D.y[i]); if (r !== NONE) want[r].push(i); }
      want.forEach((list, r) => {
        const keyed = list.map((i) => [[scoreL(P, D.alpha[i], D.beta[i]), D.rel[i], -D.id[i]], i]).sort((a, b) => b[0][0] - a[0][0] || b[0][1] - a[0][1] || b[0][2] - a[0][2]);
        const K = this.reserves[r].slots, take = keyed.slice(0, K);
        for (const [, i] of take) { D.licence[i] = r; R.licence.issued++; }
        if (keyed.length > K) { R.licence.contested++; R.licence.prices.push({ reserve: r, score: keyed[K][0][0] }); }
      });
      this.event(e, "licence", `${R.licence.issued} reserve licences issued for the ${S.name} (E1 slots: ${this.reserves.map((r) => r.slots).join(" / ")})`);
    }
    if (g.economy) {
      this.fund += L.fees;
      const hiredNow = []; for (let w = 0; w < WD.n; w++) if (WD.founder[w] === 0 && WD.life[w] !== TERMINATED) hiredNow.push(w); // founders (1) and yours (2) cost the fund nothing
      L.upkeep = 3 * hiredNow.length; this.fund -= L.upkeep;
      if (this.fund < 0 && hiredNow.length) {
        const w = hiredNow.at(-1); tickTrust(P, WD, w, 0, 0, 0, F_TERMINATE, 0, 0, 0, this.C); R.dismissed++;
        this.event(e, "warden", `${this.name("warden", w)} is let go: the licence fund is empty`);
      }
      if (this.fund < 0) { L.writeoff = -this.fund; this.fund = 0; }
      if (seasonStart && g.wardens) while (this.fund >= 1500 && WD.n < WD.cap) {
        const counts = this.reserves.map((_, r) => { let n = 0; for (let w = 0; w < WD.n; w++) if (WD.home[w] === r && WD.life[w] !== TERMINATED) n++; return n; });
        const r = counts.indexOf(Math.min(...counts)), res = this.reserves[r];
        const w = this.spawnWarden(e, (res.x + (res.w >> 1)) & 127, (res.y + (res.h >> 1)) & 127, r); this.fund -= 1500; L.hires += 1500; R.hired++;
        this.event(e, "warden", `Licence fees hire ${this.name("warden", w)} for Reserve ${res.name}`);
      }
    }
    const occNow = new Uint8Array(CELLS); for (let i = 0; i < D.n; i++) if (!dead[i]) occNow[cellOf(D.x[i], D.y[i])]++;
    const nOld = D.n;
    if (g.breeding && season === 0) {
      for (let i = 0; i < nOld; i++) {
        if (dead[i] || D.age[i] < 72 || D.energy[i] < 650 || D.cooldown[i] || D.injured[i] || D.life[i] === TERMINATED || D.sex[i] !== 1 || (g.authority && D.level[i] < 2)) continue;
        let mate = -1;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let j = first[cellOf(D.x[i] + dx, D.y[i] + dy)]; j >= 0; j = next[j])
          if (j !== i && !dead[j] && D.sex[j] === 0 && D.age[j] >= 72 && D.energy[j] >= 400 && (!g.authority || D.level[j] >= 2) && (mate < 0 || D.energy[j] > D.energy[mate] || (D.energy[j] === D.energy[mate] && D.id[j] < D.id[mate]))) mate = j;
        if (mate < 0) continue;
        let cell = -1; const off = hash(seed, 0xb1, e, D.id[i]) & 7;
        for (let k = 0; k < 8; k++) { const c = cellOf(D.x[i] + DX[(k + off) & 7], D.y[i] + DY[(k + off) & 7]); if (!this.water[c] && occNow[c] < cap) { cell = c; break; } }
        if (cell < 0) continue;
        const h = (j) => hash(seed, 0xb2, e * 65536 + D.id[i], j);
        let prefs = 0, traits = 0;
        for (let k = 0; k < 8; k++) { let v = gene(h(k) & 1 ? D.prefs[i] : D.prefs[mate], k); if (h(16 + k) % 16 === 0) v += h(32 + k) & 1 ? 1 : -1; prefs |= Math.max(0, Math.min(15, v)) << (4 * k); }
        for (let k = 0; k < 5; k++) { let v = gene(h(8 + k) & 1 ? D.traits[i] : D.traits[mate], k); if (h(24 + k) % 16 === 0) v += h(40 + k) & 1 ? 1 : -1; traits |= Math.max(0, Math.min(15, v)) << (4 * k); }
        const lin = D.lineage[i], ser = this.serials[lin]++;
        const j = this.spawnDeer(e, lin, ser, cell & 127, cell >> 7, prefs, traits, this.priorTrust(0), 220, D.id[i], D.gen[i] + 1, h(48) & 1);
        if (j < 0) break;
        D.energy[i] -= 320; L.birth += 100; D.cooldown[i] = 96; occNow[cell]++; R.births++;
      }
    }
    const nOldW = W.n;
    if (g.wolves && season === 3) {
      const size = new Map(), lead = new Map();
      for (let i = 0; i < nOldW; i++) if (!wolfDead[i]) { size.set(W.pack[i], (size.get(W.pack[i]) ?? 0) + 1); if (!lead.has(W.pack[i])) lead.set(W.pack[i], i); }
      for (const [pack, i] of lead) {
        if (W.energy[i] < 900 || W.cooldown[i] || W.age[i] < 192 || size.get(pack) >= 10) continue;
        const litter = 1 + (hash(seed, 0xb3, e, W.id[i]) % 3);
        for (let k = 0, made = 0; k < 8 && made < litter; k++) {
          const c = cellOf(W.x[i] + DX[k], W.y[i] + DY[k]); if (this.water[c]) continue;
          const j = this.spawnWolf(e, c & 127, c >> 7, pack, 250); if (j < 0) break;
          W.age[j] = 0; W.energy[i] -= 300; L.wolfBirth += 50; R.wolfBirths++; made++;
        }
        W.cooldown[i] = 96;
      }
    }
    if (g.wolves && seasonStart && season === 0) { // packs of ten or more split: the two youngest adults leave
      const members = new Map(); for (let i = 0; i < W.n; i++) if (!(i < nOldW && wolfDead[i])) { if (!members.has(W.pack[i])) members.set(W.pack[i], []); members.get(W.pack[i]).push(i); }
      for (const [, list] of members) if (list.length >= 10) {
        const adults = list.filter((i) => W.age[i] >= 96).sort((a, b) => W.age[a] - W.age[b] || W.id[a] - W.id[b]).slice(0, 2);
        if (adults.length === 2) { const np = this.nextPack; this.nextPack = (this.nextPack + 1) & 255; for (const i of adults) W.pack[i] = np; this.event(e, "wolves", `Two young wolves leave their pack to found pack ${np}`); }
      }
    }

    // I. trails (E3, exact integer forgetting), compaction, the exact energy ledger, digests
    for (let c = 0; c < CELLS; c++) this.trail[c] -= this.trail[c] >>> 3;
    for (let i = 0; i < D.n; i++) if (!(i < nOld && dead[i])) { const c = cellOf(D.x[i], D.y[i]); this.trail[c] = Math.min(65535, this.trail[c] + 64); }
    const keep = new Uint8Array(D.n); for (let i = 0; i < D.n; i++) keep[i] = i < nOld ? (dead[i] ? 0 : 1) : 1;
    D.compact(keep);
    const keepW = new Uint8Array(W.n); for (let i = 0; i < W.n; i++) keepW[i] = i < nOldW && wolfDead[i] ? 0 : 1;
    for (let i = 0; i < nOldW; i++) if (wolfDead[i]) L.wolfDead += W.energy[i];
    W.compact(keepW);
    const keepD = new Uint8Array(WD.n); for (let i = 0; i < WD.n; i++) keepD[i] = WD.life[i] === TERMINATED && !WD.founder[i] ? 0 : 1; WD.compact(keepD);
    this.frame = F;
    this.floraLedger(e);
    let E1d = 0, E1w = 0; for (let i = 0; i < D.n; i++) E1d += D.energy[i]; for (let i = 0; i < W.n; i++) E1w += W.energy[i];
    const ledger = {
      deer: E0.deer + L.spawnDeer + L.intake - L.metab - L.fees - L.birth - L.dead === E1d,
      wolves: E0.wolves + L.spawnWolves + L.wolfGain - L.wolfMetab - L.wolfBirth - L.wolfDead === E1w,
      fund: E0.fund + L.fees - L.hires - L.upkeep + L.writeoff === this.fund || !g.economy,
    };
    R.ledger = { ok: ledger.deer && ledger.wolves && ledger.fund, ...ledger, ...L, deerEnergy: E1d, wolfEnergy: E1w, checked: !!g.ledger };
    if (g.ledger && !R.ledger.ok) throw new Error(`energy ledger does not balance at epoch ${e}: ${JSON.stringify(R.ledger)}`);
    const [outSha, nextSha, deerSha, wolfSha, wardSha, regrowSha] = await Promise.all([digest(u32bytes(xout)), digest(u32bytes(F)), digest(D.bytes()), digest(W.bytes()), digest(WD.bytes()), digest(u32bytes(this.regrow))]);
    const auth = { ...this.C };
    this.digest = sha256Hex(pyDumps({ previous: this.digest, epoch: e, season: S.name, frame_in: frameInSha, law_out: outSha, frame_next: nextSha,
      regrow: regrowSha, deer: deerSha, wolves: wolfSha, wardens: wardSha, fund: this.fund, packs: this.nextPack, authority: auth, interventions: R.interventions }));
    this.epoch = e;
    Object.assign(R, { digest: this.digest, frameInSha, lawOutSha: outSha, deerSha, gates: g, counts: { deer: D.n, wolves: W.n, wardens: WD.n }, fund: this.fund, authority: auth });
    R.ms.total = (globalThis.performance ? performance.now() : 0) - t0;
    R.stats = this.stats(F);
    this.history.push({ epoch: e, digest: this.digest, season: S.name, deer: D.n, wolves: W.n, wardens: WD.n });
    this.lastReport = R;
    return R;
  }

  stats(F = this.frame) {
    const D = this.deer, species = new Array(8).fill(0);
    for (let q = 0; q < WORDS; q++) if (F[q] & 1) species[q & 7]++;
    const prefs = new Array(8).fill(0), traits = new Array(5).fill(0), levels = [0, 0, 0, 0], lineages = new Array(12).fill(0);
    let licensed = 0, injured = 0, energy = 0, age = 0;
    for (let i = 0; i < D.n; i++) {
      for (let k = 0; k < 8; k++) prefs[k] += gene(D.prefs[i], k);
      for (let k = 0; k < 5; k++) traits[k] += gene(D.traits[i], k);
      levels[D.level[i]]++; lineages[D.lineage[i]]++; if (D.licence[i] !== NONE) licensed++; if (D.injured[i]) injured++; energy += D.energy[i]; age += D.age[i];
    }
    const n = Math.max(1, D.n);
    return { species, prefs: prefs.map((v) => v / n), traits: traits.map((v) => v / n), levels, lineages, licensed, injured, meanEnergy: energy / n, meanAge: age / n / YEAR };
  }

  /* ---------------- what one deer knows (for the third-person view) */
  perception(i) {
    const D = this.deer; if (i < 0 || i >= D.n) return null;
    const cells = [], rad = 2;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const c = cellOf(D.x[i] + dx, D.y[i] + dy); let forage = 0;
      for (let k = 0; k < 8; k++) { const w = this.frame[c * 8 + k]; forage += gene(D.prefs[i], k) * (((w & 1) << 3) + ((w >>> 1) & 15) + (((w >>> 5) & 15) >>> 1)); }
      cells.push({ dx, dy, forage: forage * 2, reserve: this.reserveOf[c], water: this.water[c] });
    }
    const wolves = []; for (let w = 0; w < this.wolves.n; w++) { const d = cheb(D.x[i], D.y[i], this.wolves.x[w], this.wolves.y[w]); if (d <= 6) wolves.push({ w, d }); }
    return { cells, wolves };
  }
  deerInfo(i) {
    const D = this.deer, P = this.P; if (i < 0 || i >= D.n) return null;
    return {
      id: D.id[i], name: this.name("deer", i), x: D.x[i], y: D.y[i], energy: D.energy[i], age: D.age[i], ageYears: D.age[i] / YEAR, gen: D.gen[i], sex: D.sex[i] ? "doe" : "buck",
      lineage: D.lineage[i] === 11 ? "deer.unlicensed" : AGENTS[2 + D.lineage[i]], parent: D.parent[i], born: D.born[i], act: ACTS[D.act[i]],
      prefs: Array.from({ length: 8 }, (_, k) => gene(D.prefs[i], k)), traits: Object.fromEntries(TRAITS.map((t, k) => [t, gene(D.traits[i], k)])),
      injured: D.injured[i], licence: D.licence[i] === NONE ? null : this.reserves[D.licence[i]].name,
      trust: { alpha: D.alpha[i] / U, beta: D.beta[i] / U, score: scoreL(P, D.alpha[i], D.beta[i]), reliability: D.rel[i] / 65536,
        level: LEVELS[D.level[i]], lifecycle: LIFE_NAMES[D.life[i]], margin: D.life[i] === TERMINATED ? null : marginL(D.level[i], D.alpha[i], D.beta[i], P), revision: D.rev[i] },
      ate: D.ate[i] === NONE ? null : SPECIES[D.ate[i]].name, reserve: this.reserveOf[cellOf(D.x[i], D.y[i])] === NONE ? null : this.reserves[this.reserveOf[cellOf(D.x[i], D.y[i])]].name,
    };
  }

  // E6 in natural parameters: a good epoch (alive, not grazed, not trampled) adds to alpha, grazing and
  // trampling add to beta; E3: both forget 1/32 an epoch. E2 hysteresis on identity: a plant that comes
  // back within 12 epochs is the same individual, dormant in between; after a longer absence a new one
  // appears, with its own birth epoch (and so its own shape) and the prior evidence.
  floraLedger(e) {
    const F = this.frame, A = this.vigA, B = this.vigB, P = this.alivePrev, born = this.born, last = this.lastAlive;
    for (let c = 0; c < CELLS; c++) {
      const grazed = this.scar[c] === e, trampled = this.trail[c] > 2048;
      for (let s = 0; s < 8; s++) {
        const k = c * 8 + s, alive = F[k] & 1;
        if (alive && !P[k] && e - last[k] > 12) { born[k] = Math.min(65535, e); A[k] = 16; B[k] = 16; }
        if (alive) { last[k] = Math.min(65535, e); A[k] += grazed || trampled ? 0 : 16; B[k] += (grazed ? 16 : 0) + (trampled ? 8 : 0); A[k] -= A[k] >> 5; B[k] -= B[k] >> 5; }
        P[k] = alive;
      }
    }
  }

  /* ---------------- checkpoints (rewind) */
  snapshot() {
    return { epoch: this.epoch, digest: this.digest, frame: this.frame.slice(), xout: this.xout.slice(), trail: this.trail.slice(), scar: this.scar.slice(), regrow: this.regrow.slice(),
      deer: this.deer.clone(), wolves: this.wolves.clone(), wardens: this.wardens.clone(), nextId: { ...this.nextId }, serials: this.serials.slice(),
      fund: this.fund, nextPack: this.nextPack, C: { ...this.C }, spawned: { ...this.spawned }, released: this.released, reserves: this.reserves.map((r) => ({ ...r })),
      reserveOf: this.reserveOf.slice(), perimeter: this.perimeter.map((p) => p.slice()), history: this.history.length, events: this.events.length,
      born: this.born.slice(), lastAlive: this.lastAlive.slice(), vigA: this.vigA.slice(), vigB: this.vigB.slice(), alivePrev: this.alivePrev.slice() };
  }
  restore(s) {
    Object.assign(this, { epoch: s.epoch, digest: s.digest, frame: s.frame.slice(), xout: s.xout.slice(), trail: s.trail.slice(), scar: s.scar.slice(), regrow: s.regrow.slice(),
      deer: s.deer.clone(), wolves: s.wolves.clone(), wardens: s.wardens.clone(), nextId: { ...s.nextId }, serials: s.serials.slice(), fund: s.fund, nextPack: s.nextPack,
      C: { ...s.C }, spawned: { ...s.spawned }, released: s.released, reserves: s.reserves.map((r) => ({ ...r })), reserveOf: s.reserveOf.slice(), perimeter: s.perimeter.map((p) => p.slice()),
      born: s.born.slice(), lastAlive: s.lastAlive.slice(), vigA: s.vigA.slice(), vigB: s.vigB.slice(), alivePrev: s.alivePrev.slice() });
    this.history.length = s.history; this.events.length = Math.min(this.events.length, s.events);
    this.interventions = this.interventions.filter((iv) => iv.epoch <= s.epoch);
  }

  /* ---------------- the git-able save file */
  saveText() {
    const lines = [SAVE_FORMAT,
      "# Deer Valley world (Plume XPU Console). Plain text: lines are only appended as the world runs, so it diffs cleanly in git.",
      "# Load it on the Deer Valley page to replay the world and check every epoch digest (and regenerate every R file).",
      `config ${pyDumps(this.cfg)}`, `simmy ${this.boot.sha256}`, `law ${this.lawSha}`, `genesis ${this.genesisDigest}`];
    const ivs = [...this.interventions].sort((a, b) => a.epoch - b.epoch);
    let k = 0;
    for (const h of this.history) {
      while (k < ivs.length && ivs[k].epoch <= h.epoch) { const v = ivs[k++]; lines.push(`intervention ${v.epoch} ${v.kind} ${pyDumps(v.args)}`); }
      lines.push(`epoch ${h.epoch} ${h.digest} ${h.season} deer=${h.deer} wolves=${h.wolves} wardens=${h.wardens}`);
    }
    while (k < ivs.length) { const v = ivs[k++]; lines.push(`intervention ${v.epoch} ${v.kind} ${pyDumps(v.args)}`); }
    return lines.join("\n") + "\n";
  }
  static parseSave(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines[0] !== SAVE_FORMAT) throw new Error(`not a ${SAVE_FORMAT} file`);
    const out = { config: null, simmy: null, law: null, genesis: null, interventions: [], epochs: [] };
    for (const l of lines.slice(1)) {
      const [tag, ...rest] = l.split(" ");
      if (tag === "config") out.config = JSON.parse(rest.join(" "));
      else if (tag === "simmy" || tag === "law" || tag === "genesis") out[tag] = rest[0];
      else if (tag === "intervention") out.interventions.push({ epoch: Number(rest[0]), kind: rest[1], args: JSON.parse(rest.slice(2).join(" ")) });
      else if (tag === "epoch") out.epochs.push({ epoch: Number(rest[0]), digest: rest[1] });
      else throw new Error(`unknown line: ${l.slice(0, 40)}`);
    }
    if (!out.config) throw new Error("the save file has no config line");
    out.epochs.forEach((h, i) => { if (h.epoch !== i + 1 || !/^[0-9a-f]{64}$/.test(h.digest)) throw new Error(`epoch line ${i + 1} is out of order or malformed`); });
    return out;
  }
  // Replay a save file and check every epoch digest (like git fsck). Returns the valley at the last epoch.
  static async replay(text, boot, engine, { onEpoch = null, onGenesis = null, digest = subtleDigest } = {}) {
    const s = Valley.parseSave(text);
    if (s.simmy !== boot.sha256) throw new Error("the save file was made on a different Simmy replay");
    const v = new Valley(s.config, boot);
    onGenesis?.(v);
    if (s.law !== v.lawSha) throw new Error("the save file was made with a different meadow law");
    if (s.genesis !== v.genesisDigest) throw new Error("the genesis digest does not match");
    for (const iv of s.interventions) {
      if (v.interventions.length && iv.epoch < v.interventions.at(-1).epoch) throw new Error("save-file interventions are out of order");
      v.interventions.push(v.checkIntervention(iv, v.interventions));
    }
    for (const h of s.epochs) {
      const r = await v.step(engine, digest);
      if (r.digest !== h.digest) throw new Error(`epoch ${h.epoch} replays to ${r.digest.slice(0, 12)}…, the save file says ${h.digest.slice(0, 12)}…: the histories diverge here`);
      onEpoch?.(r, v);
    }
    return v;
  }
}
