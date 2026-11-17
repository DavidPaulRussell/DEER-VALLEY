// Function-generated flora and rocks for the Deer Valley renderer.
// SPDX-License-Identifier: GPL-3.0-only
//
// No plant has a mesh of its own. A plant is a seed and a few numbers (height, vigour, canopy); the vertex
// shader computes every trunk, branch and leaf card from them, so no two plants are alike and the GPU holds
// only small topology templates. The CPU decides who grows where, from the valley's own state:
//   - each individual's seed is a hash of the world seed, its cell, its species, its slot and the epoch it
//     appeared (the valley's flora ledger), so a plant that dies and grows back is a new individual
//   - vigour is the plant's E6 Beta evidence (good epochs against grazing and trampling, with E3 forgetting)
//   - height follows its age; in each 16 m block only K plants of a kind are admitted to the canopy (E1,
//     ranked by age x vigour), the rest stay understory
//   - a plant that has died stays as a dormant, thinning shrub for up to 12 epochs (the ledger's E2 window):
//     if it comes back in that time it is the same individual
// Leaves are alpha-tested cards cut from a foliage atlas painted here at start-up from drawing functions.
import { CELLS, cellOf, hash } from "./valley.js";
import { plantMaturity } from "./valley3d_forms.js";

export const KINDS = [
  { name: "juniper", species: 7, branches: 15, rings: 5, sides: 6, cards: 120, hmax: 6.4, tau: 22, per: 2, keep: 0.42, K: 3 },
  { name: "willow", species: 6, branches: 18, rings: 5, sides: 5, cards: 110, hmax: 3.7, tau: 14, per: 2, keep: 0.42, K: 4 },
  { name: "blueberry", species: 5, branches: 9, rings: 4, sides: 4, cards: 30, hmax: 0.55, tau: 6, per: 2, keep: 0.7, K: 14, maxR: 70 },
];
export const ROCK_SEG = 3;   // icosphere subdivisions of the boulder template

/* ------------------------------------------------------------------ topology templates (no positions) */
// wood: per vertex (branch, along 0..1, around 0..1)
export function woodTemplate(nb, rings, sides) {
  const v = [], i = [], n = sides + 1;   // the seam's column is doubled (around = 0 and 1), so the bark's coordinates run unbroken
  for (let b = 0; b < nb; b++) for (let r = 0; r < rings; r++) for (let s = 0; s <= sides; s++) v.push(b, r / (rings - 1), s / sides);
  for (let b = 0; b < nb; b++) for (let r = 0; r + 1 < rings; r++) for (let s = 0; s < sides; s++) {
    const o = b * rings * n, a = o + r * n + s, c = a + 1, d = a + n, e = c + n;
    i.push(a, d, c, c, d, e);
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(i) };
}
// leaves: per vertex (card, corner 0..3, 0); corners (-,-) (+,-) (+,+) (-,+)
export function cardTemplate(n) {
  const v = [], i = [];
  for (let k = 0; k < n; k++) { for (let c = 0; c < 4; c++) v.push(k, c, 0); const o = k * 4; i.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  return { vertices: new Float32Array(v), indices: new Uint16Array(i) };
}
// a unit icosphere: per vertex its direction (the shader displaces it into a boulder)
export function sphereTemplate(seg = ROCK_SEG) {
  const t = (1 + Math.sqrt(5)) / 2;
  let P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((x) => x / l); });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < seg; s++) {
    const mid = new Map(), m = (a, b) => { const k = a < b ? a * 65536 + b : b * 65536 + a; if (mid.has(k)) return mid.get(k); const p = P[a].map((x, q) => x + P[b][q]), l = Math.hypot(...p); P.push(p.map((x) => x / l)); mid.set(k, P.length - 1); return P.length - 1; };
    F = F.flatMap(([a, b, c]) => { const ab = m(a, b), bc = m(b, c), ca = m(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  return { vertices: new Float32Array(P.flat()), indices: new Uint16Array(F.flat()) };
}

/* ------------------------------------------------------------------ the foliage atlas */
// Four 512 px tiles drawn by functions: willow sprays (0, 3), a juniper spray (1), a blueberry sprig (2).
// Transparent texels take their tile's mean leaf colour so mipmaps do not darken the edges.
export function paintFoliageAtlas(size = 1024) {
  const cv = document.createElement("canvas"); cv.width = cv.height = size;
  const g = cv.getContext("2d"), T = size / 2;
  let st = 0x9e3779b9; const rnd = () => { st = (st + 0x6d2b79f5) | 0; let t = Math.imul(st ^ (st >>> 15), 1 | st); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rgb = (r, gg, b, a = 1) => `rgba(${Math.round(r)},${Math.round(gg)},${Math.round(b)},${a})`;
  const leaf = (x, y, ang, len, wid, base, tip, rib, round = 0.35) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    const gr = g.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, base); gr.addColorStop(1, tip);
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(len * round, -wid, len * (0.55 + round * 0.4), -wid * 0.9, len, 0);
    g.bezierCurveTo(len * (0.55 + round * 0.4), wid * 0.9, len * round, wid, 0, 0); g.fill();
    if (rib) { g.strokeStyle = rib; g.lineWidth = Math.max(0.8, wid * 0.12); g.beginPath(); g.moveTo(len * 0.04, 0); g.quadraticCurveTo(len * 0.5, wid * 0.08, len * 0.92, 0); g.stroke(); }
    g.restore();
  };
  const twig = (pts, w0, w1, col) => { g.strokeStyle = col; g.lineCap = "round"; for (let k = 0; k + 1 < pts.length; k++) { g.lineWidth = w0 + (w1 - w0) * (k / (pts.length - 1)); g.beginPath(); g.moveTo(...pts[k]); g.lineTo(...pts[k + 1]); g.stroke(); } };
  const curve = (x0, y0, ang, len, bend, n = 10) => { const p = []; let x = x0, y = y0, a = ang; for (let k = 0; k <= n; k++) { p.push([x, y]); a += bend / n; x += Math.cos(a) * len / n; y += Math.sin(a) * len / n; } return p; };
  // willow sprays: arching twigs with long narrow leaves, grey-green above and silver beneath
  const willow = (ox, oy, dense) => {
    for (let s = 0; s < (dense ? 6 : 4); s++) {
      const p = curve(ox + T * (0.38 + 0.24 * rnd()), oy + T * 0.98, -Math.PI / 2 + (rnd() - 0.5) * 1.1, T * (0.62 + 0.3 * rnd()), (rnd() - 0.5) * 1.2, 14);
      twig(p, 4.5, 1.2, rgb(108, 86, 52));
      for (let k = 2; k < p.length; k++) for (const side of [-1, 1]) {
        if (rnd() < 0.18) continue;
        const [x, y] = p[k], [x1, y1] = p[Math.min(p.length - 1, k + 1)], a = Math.atan2(y1 - y, x1 - x) + side * (0.45 + 0.4 * rnd());
        const len = T * (0.13 + 0.07 * rnd()), wid = len * (0.13 + 0.05 * rnd()), under = rnd() < 0.22;
        const j = 0.85 + 0.3 * rnd(), base = under ? rgb(150 * j, 160 * j, 136 * j) : rgb(70 * j, 92 * j, 54 * j), tip = under ? rgb(176 * j, 182 * j, 160 * j) : rgb(104 * j, 126 * j, 76 * j);
        leaf(x, y, a, len, wid, base, tip, under ? rgb(196, 200, 182, 0.7) : rgb(140, 156, 104, 0.7), 0.3);
      }
    }
  };
  // a juniper spray: forked branchlets covered in overlapping scale leaves, a few dusty blue berries
  const juniper = (ox, oy) => {
    const branch = (x, y, a, len, depth) => {
      const p = curve(x, y, a, len, (rnd() - 0.5) * 0.5, 6);
      twig(p, 1.5 + depth * 1.6, 1 + depth * 0.8, rgb(96, 70, 50));
      if (depth > 0) { const n = 2 + (rnd() < 0.5 ? 1 : 0); for (let k = 0; k < n; k++) { const q = p[2 + Math.floor(rnd() * (p.length - 2))]; branch(q[0], q[1], a + (rnd() - 0.5) * 1.3, len * (0.55 + 0.2 * rnd()), depth - 1); } }
      else for (let k = 0; k < p.length - 1; k++) for (let m = 0; m < 4; m++) {
        const [x0, y0] = p[k], [x1, y1] = p[k + 1], t = m / 4, x2 = x0 + (x1 - x0) * t, y2 = y0 + (y1 - y0) * t, j = 0.8 + 0.4 * rnd(), r = T * (0.012 + 0.008 * rnd());
        g.fillStyle = rgb(50 * j, 84 * j, 64 * j); g.beginPath(); g.ellipse(x2 + (rnd() - 0.5) * r, y2 + (rnd() - 0.5) * r, r * 1.5, r, Math.atan2(y1 - y0, x1 - x0), 0, Math.PI * 2); g.fill();
        g.fillStyle = rgb(86 * j, 120 * j, 92 * j, 0.6); g.beginPath(); g.ellipse(x2, y2 - r * 0.3, r * 0.8, r * 0.45, Math.atan2(y1 - y0, x1 - x0), 0, Math.PI * 2); g.fill();
      }
    };
    for (let s = 0; s < 3; s++) branch(ox + T * (0.4 + 0.2 * rnd()), oy + T * 0.97, -Math.PI / 2 + (rnd() - 0.5) * 0.9, T * (0.42 + 0.12 * rnd()), 3);
    for (let k = 0; k < 18; k++) { const x = ox + T * (0.2 + 0.6 * rnd()), y = oy + T * (0.15 + 0.6 * rnd()), r = T * 0.011;
      const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; if (d[3] < 128) continue;
      g.fillStyle = rgb(92, 108, 140); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.fillStyle = rgb(170, 182, 206, 0.8); g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2); g.fill(); }
  };
  // a blueberry sprig: thin red-green stems, small glossy oval leaves, dark berries with a bloom
  const blueberry = (ox, oy) => {
    for (let s = 0; s < 5; s++) {
      const p = curve(ox + T * (0.3 + 0.4 * rnd()), oy + T * 0.98, -Math.PI / 2 + (rnd() - 0.5) * 1.4, T * (0.55 + 0.3 * rnd()), (rnd() - 0.5) * 1.6, 12);
      twig(p, 3, 1, rgb(120, 70, 50));
      for (let k = 2; k < p.length; k++) {
        const [x, y] = p[k], [x1, y1] = p[Math.min(p.length - 1, k + 1)], side = k % 2 ? 1 : -1, a = Math.atan2(y1 - y, x1 - x) + side * (0.7 + 0.4 * rnd());
        const len = T * (0.07 + 0.03 * rnd()), j = 0.85 + 0.3 * rnd(), young = rnd() < 0.15;
        leaf(x, y, a, len, len * 0.45, young ? rgb(130 * j, 82 * j, 52 * j) : rgb(46 * j, 92 * j, 40 * j), young ? rgb(160 * j, 110 * j, 60 * j) : rgb(84 * j, 136 * j, 62 * j), rgb(150, 190, 120, 0.5), 0.45);
        if (rnd() < 0.18) { const bx = x + Math.cos(a + side) * len * 0.3, by = y + Math.sin(a + side) * len * 0.3, r = T * 0.016;
          g.fillStyle = rgb(38, 46, 92); g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2); g.fill(); g.fillStyle = rgb(120, 134, 176, 0.7); g.beginPath(); g.arc(bx - r * 0.3, by - r * 0.3, r * 0.45, 0, Math.PI * 2); g.fill(); }
      }
    }
  };
  willow(0, 0, false); juniper(T, 0); blueberry(0, T); willow(T, T, true);
  const img = g.getImageData(0, 0, size, size), d = img.data;
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = ty * T; y < (ty + 1) * T; y++) for (let x = tx * T; x < (tx + 1) * T; x++) { const o = (y * size + x) * 4; if (d[o + 3] > 128) { r += d[o]; gg += d[o + 1]; b += d[o + 2]; n++; } }
    if (n) { r /= n; gg /= n; b /= n; }
    for (let y = ty * T; y < (ty + 1) * T; y++) for (let x = tx * T; x < (tx + 1) * T; x++) { const o = (y * size + x) * 4; if (d[o + 3] < 8) { d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 0; } }
  }
  return { data: new Uint8Array(d.buffer.slice(0)), size };
}

/* ------------------------------------------------------------------ who grows where (CPU) */
const u01 = (a, b, c, d) => (hash(a, b, c, d) >>> 0) / 4294967296;
// Plant instances around (cx, cz) within R metres: per kind a Float32Array of 8 floats per plant:
// x, y, z (relative to origin), yaw, seed, height m, vigour, dormancy (0 alive .. 1 twelve epochs gone)
export function floraInstances(valley, map, cx, cz, R, origin, groundAt) {
  const F = valley.frame, e = valley.epoch, born = valley.born, last = valley.lastAlive, VA = valley.vigA, VB = valley.vigB, seed = valley.cfg.seed;
  const rc = Math.ceil(R / 4), ccx = Math.floor(cx / 4), ccz = Math.floor(cz / 4), cand = [];
  for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
    const gx = ccx + dx, gz = ccz + dz, c = cellOf(gx, gz);
    if (valley.water[c]) continue;
    KINDS.forEach((K, kind) => {
      const k8 = c * 8 + K.species, alive = F[k8] & 1, gone = alive ? 0 : e - last[k8];
      if (!alive && (last[k8] === 0 && born[k8] === 0 ? true : gone > 12)) return;
      for (let slot = 0; slot < K.per; slot++) {
        const h = (q) => u01(seed ^ 0x5f10a, k8, slot * 65536 + born[k8], q);
        if (h(9) > K.keep) continue;
        const x = (gx + 0.08 + 0.84 * h(1)) * 4, z = (gz + 0.08 + 0.84 * h(2)) * 4;
        const ddx = x - cx, ddz = z - cz, Rk = Math.min(R, K.maxR ?? R); if (ddx * ddx + ddz * ddz > Rk * Rk) continue;
        const wx = ((x % 512) + 512) % 512, wz = ((z % 512) + 512) % 512, mat = map.field1("material", wx, wz), moist = map.field1("moisture", wx, wz);
        if (mat === 4 || mat === 7 || (kind === 1 && moist < 60 && h(10) < 0.6) || (kind === 0 && mat === 3)) continue;   // bare rock, stream beds; willows favour wet ground, junipers avoid mud
        const age = born[k8] === 0 ? 220 + Math.floor(h(3) * 520) : e - born[k8], vig = VA[k8] / Math.max(1, VA[k8] + VB[k8]);
        cand.push({ kind, x, z, age, vig, dorm: gone / 12, prio: age * (0.5 + vig) * (1 - gone / 13) + h(4), seed: h(5), yaw: h(6) * Math.PI * 2, size: h(7), block: ((Math.floor(gz / 4) & 31) * 32 + (Math.floor(gx / 4) & 31)) * 4 + kind });
      }
    });
  }
  // E1 admission: per 16 m block and kind, K canopy slots taken in order of age x vigour (ties by seed)
  const byBlock = new Map(); for (const p of cand) { if (!byBlock.has(p.block)) byBlock.set(p.block, []); byBlock.get(p.block).push(p); }
  for (const list of byBlock.values()) { list.sort((a, b) => b.prio - a.prio || a.seed - b.seed); list.forEach((p, i) => { p.canopy = i < KINDS[p.kind].K ? 1 : 0; }); }
  const out = KINDS.map(() => []);
  for (const p of cand) {
    // the continuum's maturity s: age through the class's growth span, raised by vigour, held back under the canopy
    const K = KINDS[p.kind], s = Math.max(0.02, Math.min(1, plantMaturity(K.name, p.age) * (0.75 + 0.35 * p.vig) * (p.canopy ? 1 : 0.72) * (0.85 + 0.3 * p.size)));
    out[p.kind].push(p.x - origin[0], groundAt(p.x, p.z) - 0.04, p.z - origin[2], p.yaw, p.seed, s, p.vig, p.dorm);
  }
  return out.map((a) => new Float32Array(a));
}
// Boulders: where the map's materials are rocky, plus a few erratics in the meadows; each from its own seed.
// x, y, z (relative to origin), yaw, seed, radius m, flatness, moss (0..1)
export function rockInstances(valley, map, cx, cz, R, origin, groundAt) {
  const seed = valley.cfg.seed, out = [], rc = Math.ceil(R / 4), ccx = Math.floor(cx / 4), ccz = Math.floor(cz / 4);
  const P = [0.025, 0.02, 0.05, 0.0, 0.55, 0.75, 0.3, 0.2];   // per material class
  for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
    const gx = ccx + dx, gz = ccz + dz, c = cellOf(gx, gz);
    if (valley.water[c]) continue;
    for (let slot = 0; slot < 3; slot++) {
      const h = (q) => u01(seed ^ 0x2b0c, c, slot, q);
      const x = (gx + h(1)) * 4, z = (gz + h(2)) * 4, ddx = x - cx, ddz = z - cz; if (ddx * ddx + ddz * ddz > R * R) continue;
      const wx = ((x % 512) + 512) % 512, wz = ((z % 512) + 512) % 512, mat = map.field1("material", wx, wz);
      if (h(3) > P[mat] * (slot === 0 ? 1 : 0.5)) continue;
      const big = mat === 4 ? 0.5 + 1.4 * h(4) ** 2 : mat === 5 ? 0.18 + 0.5 * h(4) ** 2 : 0.25 + 0.9 * h(4) ** 3;
      const moist = map.field1("moisture", wx, wz);
      out.push(x - origin[0], groundAt(x, z) - big * 0.35, z - origin[2], h(6) * Math.PI * 2, h(5), big, 0.45 + 0.4 * h(7), Math.min(1, moist / 255 + 0.2 * h(8)));
    }
  }
  return new Float32Array(out);
}
