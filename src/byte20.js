// The byte20 pixel: each 4 m block of Deer Valley as 160 bits (five 32-bit words), every epoch.
// SPDX-License-Identifier: GPL-3.0-only
//
// Law deer.valley.byte20/1. The five words follow the RUSSL-Zarr byte20 layout of the valley workflow,
// using the integer methods of the LittleBit .cmd notes (TN-2026-CMD-LB-5DLLM-8S, TN-2026-LB-CMD-WEIGHTS-
// 5DLLM-8S and its revision 2). Everything is integer arithmetic, so a history gives the same words, roots
// and chain on every machine; the frame is computed after each epoch from the valley and the living map.
//
//   W0 geo/hydro    [0..15]  Z_DELTA_Q16  the block's height change this epoch, int16 in 2^-16 m ticks (the
//                                         Q16.16 cure of the bfloat16 dead zone, C037: 50 um is 3 ticks)
//                   [16..23] STRAT8       which of eight horizons show in the block (bedrock, regolith, talus,
//                                         cobble, till, sand and silt, loam, peat), one bit each
//                   [24..31] GAMMA_Q4_4   the spread of its 1 m heights, metres in Q4.4
//   W1 botany       [0..23]  8 x 3 bits   per species: 0 absent, 1 cropped and regrowing, 2..7 alive by age
//                   [24..31] VIGOUR_Q4_4  mean E6 vigour of the species alive, x16
//   W2 fauna        [0..5]   deer (0..63)   [6..9] mean energy class   [10..11] mean trust level
//                   [12] a fawn   [13] a buck with antlers
//                   [14..16] wolves (0..7)  [17..21] first pack   [22] hunting   [23] a warden here
//                   [24..31] GLA_TRACE_U8  S' = (S (4096 - k) + v k) >> 12, k = 512: the tied-gate recurrence
//                                          of the SpikingBrain GLA, here a geometric trace of the herd (E3)
//   W3 look/sound   [0..11]  LOOK12        material (3) | flora class (3) | season (2) | snow | water | rock (2)
//                   [12..19] ASPECT8       downslope direction, integer octant angle (256 to the turn)
//                   [20..25] GAIT6         the commonest act of the animals here (5) | moving (1)
//                   [26..31] ACOUSTIC6     enclosure: rising directions within 24 m (x7) | water
//   W4 seal         [0..15]  SEAL16        a keyed hash of the block's W0..W3 with the frame root
//                   [16..27] D2_LOG12      the exact squared distance sum_m (W_m - W_m')^2 to its previous
//                                          epoch, as a 12-bit integer log (bit length << 5 | next 5 bits)
//                   [28..29] strikes  [30] latch (E20)  [31] parity of W0 ^ W1 ^ W2 ^ W3 (SWAR popcount)
//   A strike is a D2 above the frame's mean + 1.87 SD (7660 in Q12); three strikes latch.
// The frame chain: D_e = SHA-256 of {previous, epoch, valley digest, frame SHA-256}.
// Three-metric report: 16,384 blocks x 5 words = 81,920 nominal words; 2,621,440 true stored bits
// (327,680 bytes raw); each word plane is a 128 x 128 integer matrix, rank <= 128. Detail finer than a block
// is generated from these bits and the laws, never stored, so it adds no information.
import { CELLS, N, cellOf, hash, YEAR, SEASON_LEN } from "./valley.js";
import { sha256Hex, pyDumps } from "./simmy.js";

export const BYTE20_LAW = "deer.valley.byte20/1";
export const B20_WORDS = 5, STRATA = ["bedrock", "regolith", "talus", "cobble", "till", "sand and silt", "loam", "peat"];
const GLA_K = 512, STRIKE_SD_Q12 = 7660;

// Theorem 2.1 of the .cmd notes: a SWAR popcount that stays exact under arithmetic right shifts, because
// bit 31 of 0x55555555, 0x33333333 and 0x0F0F0F0F is 0. JavaScript's >> is arithmetic, like set /a.
export function popcnt32(x) {
  let v = (x | 0) - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >> 24) & 0x3f;
}
// the 32-way bipolar inner product <p, q> = 2 popcnt(~(p ^ q)) - 32
export const xnorDot32 = (p, q) => (popcnt32(~(p ^ q)) << 1) - 32;
// field access that never sign-extends: (x >> k) & mask
export const bits = (x, lo, n) => (x >> lo) & ((1 << n) - 1);
const put = (lo, n, v) => ((v & ((1 << n) - 1)) << lo) | 0;
// Q16.16 ticks for a height change in millimetres: round(mm / 1000 * 65536) = round(mm * 8192 / 125)
export const mmToQ16 = (mm) => { const t = mm * 8192, q = Math.floor(t / 125), r = t - q * 125; return q + (2 * r >= 125 ? 1 : 0); };
const bitLength = (b) => (b === 0n ? 0 : b.toString(2).length);
export function log12(d2) { const e = bitLength(d2); if (e <= 5) return Number(d2); const m = Number((d2 >> BigInt(e - 6)) & 31n); return Math.min(4095, (e << 5) | m); }
const isqrtN = (n) => { if (n <= 0) return 0; let r = Math.floor(Math.sqrt(n)); while (r * r > n) r--; while ((r + 1) * (r + 1) <= n) r++; return r; };

export function decode(w) {
  const [W0, W1, W2, W3, W4] = w;
  const z = bits(W0, 0, 16), species = Array.from({ length: 8 }, (_, k) => bits(W1, 3 * k, 3));
  return {
    W0: { z_delta_q16: z >= 32768 ? z - 65536 : z, strata: STRATA.filter((_, k) => bits(W0, 16 + k, 1)), gamma_m: bits(W0, 24, 8) / 16 },
    W1: { species, vigour: bits(W1, 24, 8) / 16 },
    W2: { deer: bits(W2, 0, 6), energy_class: bits(W2, 6, 4), trust_level: bits(W2, 10, 2), fawn: bits(W2, 12, 1), buck: bits(W2, 13, 1),
      wolves: bits(W2, 14, 3), pack: bits(W2, 17, 5), hunting: bits(W2, 22, 1), warden: bits(W2, 23, 1), gla_trace: bits(W2, 24, 8) },
    W3: { material: bits(W3, 0, 3), flora: bits(W3, 3, 3), season: bits(W3, 6, 2), snow: bits(W3, 8, 1), water: bits(W3, 9, 1), rock: bits(W3, 10, 2),
      aspect: bits(W3, 12, 8), act: bits(W3, 20, 5), moving: bits(W3, 25, 1), enclosure: bits(W3, 26, 5), water_near: bits(W3, 31, 1) },
    W4: { seal16: bits(W4, 0, 16), d2_log12: bits(W4, 16, 12), strikes: bits(W4, 28, 2), latch: bits(W4, 30, 1), parity: bits(W4, 31, 1) },
  };
}
// integer octant angle of a vector (no trigonometry): 256 to the turn
function angle8(dx, dy) {
  if (!dx && !dy) return 0;
  const ax = Math.abs(dx), ay = Math.abs(dy), t = ax >= ay ? Math.floor((ay * 32) / ax) : 64 - Math.floor((ax * 32) / ay);   // 0..64 within the quadrant
  const a = dx >= 0 ? (dy >= 0 ? t : 256 - t) : dy >= 0 ? 128 - t : 128 + t;
  return a & 255;
}

export class Byte20 {
  constructor(valley, map) {
    this.frame = new Int32Array(CELLS * B20_WORDS); this.prev = new Int32Array(CELLS * B20_WORDS);
    this.meanH = new Int32Array(CELLS); this.epoch = -1;
    this.chain = sha256Hex(pyDumps({ law: BYTE20_LAW, seed: valley.cfg.seed, genesis: valley.genesisDigest ?? valley.digest }));
    this.compute(valley, map, true);
  }
  snapshot() { return { frame: this.frame.slice(), prev: this.prev.slice(), meanH: this.meanH.slice(), epoch: this.epoch, chain: this.chain, root: this.root, stats: this.stats }; }
  restore(s) { this.frame = s.frame.slice(); this.prev = s.prev.slice(); this.meanH = s.meanH.slice(); this.epoch = s.epoch; this.chain = s.chain; this.root = s.root; this.stats = s.stats; }
  // one epoch's frame (call after the valley's step and the map's weathering)
  compute(valley, map, genesis = false) {
    const v = valley, e = v.epoch, F = v.frame, D = v.deer, Wl = v.wolves, WD = v.wardens, out = new Int32Array(CELLS * B20_WORDS);
    const G = 512, rel = map.relief, comp = (x, y) => map.compAt(x, y);
    const season = Math.floor(((Math.max(1, e) - 1) % YEAR) / SEASON_LEN), snow = season === 3 && ((Math.max(1, e) - 1) % SEASON_LEN) >= 3 ? 1 : 0;
    // fauna per block
    const nd = new Uint8Array(CELLS), en = new Int32Array(CELLS), tl = new Int32Array(CELLS), fawn = new Uint8Array(CELLS), buck = new Uint8Array(CELLS);
    const acts = new Uint8Array(CELLS * 17), moving = new Uint8Array(CELLS);
    for (let i = 0; i < D.n; i++) {
      const c = cellOf(D.x[i], D.y[i]); if (nd[c] < 63) nd[c]++; en[c] += D.energy[i]; tl[c] += D.level[i];
      const age = D.age[i]; if (age < 40) fawn[c] = 1; if (D.sex[i] === 0 && age >= 90) buck[c] = 1;
      if (acts[c * 17 + D.act[i]] < 255) acts[c * 17 + D.act[i]]++; if (D.x[i] !== D.px[i] || D.y[i] !== D.py[i]) moving[c] = 1;
    }
    const nw = new Uint8Array(CELLS), pack = new Uint8Array(CELLS).fill(255), hunt = new Uint8Array(CELLS), ward = new Uint8Array(CELLS);
    for (let i = 0; i < Wl.n; i++) { const c = cellOf(Wl.x[i], Wl.y[i]); if (nw[c] < 7) nw[c]++; if (pack[c] === 255) pack[c] = Wl.pack[i] & 31; if (Wl.act[i] === 12 || Wl.act[i] === 13 || Wl.act[i] === 16) hunt[c] = 1; if (acts[c * 17 + Wl.act[i]] < 255) acts[c * 17 + Wl.act[i]]++; }
    for (let i = 0; i < WD.n; i++) { const c = cellOf(WD.x[i], WD.y[i]); ward[c] = 1; if (acts[c * 17 + WD.act[i]] < 255) acts[c * 17 + WD.act[i]]++; }
    const meanH = new Int32Array(CELLS);
    for (let c = 0; c < CELLS; c++) {
      const bx = c & 127, by = c >> 7, o = c * B20_WORDS;
      // W0: height change, strata, spread
      let sum = 0, sq = 0, matCount = new Uint8Array(8), rock = 0, slopeMax = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const x = bx * 4 + i, y = by * 4 + j, s = (y << 9) | x, h = rel[s] - comp(x, y);
        sum += h; sq += h * h; matCount[map.mat1[s]]++; rock += map.rock1[s];
      }
      const mean = Math.floor(sum / 16); meanH[c] = mean;
      const varMm2 = Math.max(0, Math.floor(sq / 16) - mean * mean), sd = isqrtN(varMm2);
      const dz = genesis ? 0 : Math.max(-32768, Math.min(32767, mmToQ16(mean - this.meanH[c])));
      const ero = map.base[(by * 4 << 9) | (bx * 4)] - rel[(by * 4 << 9) | (bx * 4)];
      const strat = (matCount[4] ? 1 : 0) | (matCount[1] && rock > 1600 ? 2 : 0) | (matCount[5] ? 4 : 0) | (matCount[6] || matCount[7] ? 8 : 0)
        | (ero < -60 && !matCount[7] ? 16 : 0) | (matCount[2] ? 32 : 0) | (matCount[0] || matCount[1] ? 64 : 0) | (matCount[3] ? 128 : 0);
      out[o] = put(0, 16, dz) | put(16, 8, strat) | put(24, 8, Math.min(255, Math.floor((sd * 16) / 1000)));
      // W1: species codes and vigour
      let w1 = 0, vs = 0, vn = 0, alive = 0;
      for (let s = 0; s < 8; s++) {
        const k = c * 8 + s; let code = 0;
        if (F[k] & 1) { code = 2 + Math.min(5, (e - v.born[k]) >> 1); vs += Math.floor((v.vigA[k] * 256) / Math.max(1, v.vigA[k] + v.vigB[k])); vn++; alive |= 1 << s; }
        else if (v.regrow[k] && e - v.regrow[k] < 6) code = 1;
        w1 |= put(3 * s, 3, code);
      }
      out[o + 1] = w1 | put(24, 8, vn ? Math.min(255, Math.floor(vs / (vn * 16))) : 0);
      // W2: fauna and the tied-gate trace
      const d = nd[c], eClass = d ? Math.min(15, Math.floor(en[c] / d / 64)) : 0, tLevel = d ? Math.min(3, Math.floor(tl[c] / d)) : 0;
      const vTrace = Math.min(255, d * 64 + nw[c] * 128), sPrev = genesis ? 0 : bits(this.frame[o + 2], 24, 8);
      const sNew = (sPrev * (4096 - GLA_K) + vTrace * GLA_K) >> 12;
      out[o + 2] = put(0, 6, d) | put(6, 4, eClass) | put(10, 2, tLevel) | put(12, 1, fawn[c]) | put(13, 1, buck[c]) | put(14, 3, nw[c]) | put(17, 5, pack[c] === 255 ? 0 : pack[c])
        | put(22, 1, hunt[c]) | put(23, 1, ward[c]) | put(24, 8, sNew);
      // W3: look code, aspect, gait, enclosure
      let mat = 0; for (let k = 1; k < 8; k++) if (matCount[k] > matCount[mat]) mat = k;
      const flora = alive & 128 ? 5 : alive & 64 ? 4 : alive & 32 ? 3 : alive & 17 ? 2 : alive & 14 ? 1 : 0;
      const water = v.water[c], rockQ = Math.min(3, Math.floor(rock / 16 / 64));
      const look = put(0, 3, mat) | put(3, 3, flora) | put(6, 2, season) | put(8, 1, snow) | put(9, 1, water) | put(10, 2, rockQ);
      const hx = rel[((by * 4 + 2) << 9) | ((bx * 4 + 4) & (G - 1))] - rel[((by * 4 + 2) << 9) | ((bx * 4 - 1) & (G - 1))];
      const hy = rel[(((by * 4 + 4) & (G - 1)) << 9) | (bx * 4 + 2)] - rel[(((by * 4 - 1) & (G - 1)) << 9) | (bx * 4 + 2)];
      const aspect = angle8(-hx, -hy);
      let act = 0, best = 0; for (let a = 0; a < 17; a++) if (acts[c * 17 + a] > best) { best = acts[c * 17 + a]; act = a; }
      let enclosure = 0; const h0 = mean;
      for (let k = 0; k < 8; k++) { const dx = [1, 1, 0, -1, -1, -1, 0, 1][k], dy = [0, 1, 1, 1, 0, -1, -1, -1][k]; let rise = false;
        for (let r = 4; r <= 24 && !rise; r += 4) { const x = (bx * 4 + 2 + dx * r) & (G - 1), y = (by * 4 + 2 + dy * r) & (G - 1); if (rel[(y << 9) | x] - h0 > 3000) rise = true; } if (rise) enclosure++; }
      let wNear = 0; for (let k = 0; k < 8 && !wNear; k++) if (v.water[cellOf(bx + [1, 1, 0, -1, -1, -1, 0, 1][k], by + [0, 1, 1, 1, 0, -1, -1, -1][k])]) wNear = 1;
      out[o + 3] = look | put(12, 8, aspect) | put(20, 5, act) | put(25, 1, best ? moving[c] : 0) | put(26, 5, Math.min(31, enclosure * 3)) | put(31, 1, wNear | water);
    }
    // W4: the frame root over W0..W3, distances to the previous epoch, strikes and latch, parity
    const planes = new Int32Array(CELLS * 4); for (let c = 0; c < CELLS; c++) for (let m = 0; m < 4; m++) planes[m * CELLS + c] = out[c * B20_WORDS + m];
    const root = sha256Hex(new Uint8Array(planes.buffer));
    const rw = [0, 8, 16, 24].map((k) => parseInt(root.slice(k, k + 8), 16) | 0);
    const d2q = new Int32Array(CELLS); let s1 = 0, s2 = 0;
    for (let c = 0; c < CELLS; c++) {
      let d2 = 0n; if (!genesis) for (let m = 0; m < 4; m++) { const df = BigInt(out[c * B20_WORDS + m]) - BigInt(this.frame[c * B20_WORDS + m]); d2 += df * df; }   // >= 0, exact: no cancellation
      d2q[c] = log12(d2); s1 += d2q[c]; s2 += d2q[c] * d2q[c];
    }
    const meanQ = Math.floor(s1 / CELLS), sdQ = isqrtN(Math.max(0, Math.floor(s2 / CELLS) - meanQ * meanQ)), thr = meanQ + ((sdQ * STRIKE_SD_Q12) >> 12);
    let strikesN = 0, latched = 0;
    for (let c = 0; c < CELLS; c++) {
      const o = c * B20_WORDS, prevW4 = genesis ? 0 : this.frame[o + 4], ps = bits(prevW4, 28, 2), pl = bits(prevW4, 30, 1);
      const strikes = d2q[c] > thr && !genesis ? Math.min(3, ps + 1) : 0, latch = pl | (strikes === 3 ? 1 : 0);
      const parity = popcnt32(out[o] ^ out[o + 1] ^ out[o + 2] ^ out[o + 3]) & 1;
      const seal = hash(rw[0] ^ c, rw[1] ^ out[o], rw[2] ^ out[o + 1] ^ out[o + 2], rw[3] ^ out[o + 3]) & 0xffff;
      out[o + 4] = put(0, 16, seal) | put(16, 12, d2q[c]) | put(28, 2, strikes) | put(30, 1, latch) | put(31, 1, parity);
      if (strikes) strikesN++; if (latch) latched++;
    }
    this.prev = this.frame; this.frame = out; this.meanH = meanH; this.epoch = e; this.root = root;
    this.frameSha = sha256Hex(new Uint8Array(out.buffer));
    this.chain = sha256Hex(pyDumps({ law: BYTE20_LAW, previous: this.chain, epoch: e, valley: v.digest, frame: this.frameSha }));
    this.stats = { epoch: e, root, frame_sha256: this.frameSha, chain: this.chain, d2_mean: meanQ, d2_sd: sdQ, strike_threshold: thr, striking: strikesN, latched,
      three_metric: { nominal_words: CELLS * B20_WORDS, true_stored_bits: CELLS * B20_WORDS * 32, raw_bytes: CELLS * B20_WORDS * 4, rank_bound_per_plane: N } };
    return out;
  }
  pixel(c) { return Array.from(this.frame.subarray(c * B20_WORDS, c * B20_WORDS + B20_WORDS)); }
  // the frame as five word planes (the transposition the workflow asks for), little-endian
  planes() { const p = new Int32Array(CELLS * B20_WORDS); for (let c = 0; c < CELLS; c++) for (let m = 0; m < B20_WORDS; m++) p[m * CELLS + c] = this.frame[c * B20_WORDS + m]; return p; }
}
