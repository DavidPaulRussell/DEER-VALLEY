// Procedural anatomy for the Deer Valley renderer: skeletons and skinned meshes for deer, wolves and
// wardens, and static meshes for juniper, willow and blueberry. Everything is generated from
// measured proportions in code; there are no model files.
// SPDX-License-Identifier: GPL-3.0-only
//
// Vertex layout (13 floats): position xyz, normal xyz, colour rgb, bone indices (2), bone weights (2).
// Model space: +x forward, +y up, +z left. Bones have identity rest rotations; a bone's rest frame is
// a translation to its head, so a skin matrix is T(newHead) · R · T(-restHead).

export const STRIDE = 13;
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const hashf = (i) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

class MeshBuilder {
  constructor() { this.v = []; this.i = []; }
  vert(p, n, c, b0, b1 = b0, w = 1) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], b0, b1, w, 1 - w); return this.v.length / STRIDE - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  // a lofted tube: rings[k] = { c: centre, x: ring x axis, y: ring y axis, rx, ry, col(theta)->rgb, bones: [b0, b1, w] }
  loft(rings, sides, capStart = true, capEnd = true) {
    const base = this.v.length / STRIDE;
    rings.forEach((r) => {
      for (let s = 0; s < sides; s++) {
        const th = (s / sides) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const p = [0, 1, 2].map((k) => r.c[k] + r.x[k] * cs * r.rx + r.y[k] * sn * r.ry);
        const nn = [0, 1, 2].map((k) => r.x[k] * cs / r.rx + r.y[k] * sn / r.ry), l = Math.hypot(...nn) || 1;
        this.vert(p, nn.map((x) => x / l), r.col(th, s), r.bones[0], r.bones[1], r.bones[2]);
      }
    });
    for (let k = 0; k + 1 < rings.length; k++) for (let s = 0; s < sides; s++) {
      const a = base + k * sides + s, b = base + k * sides + ((s + 1) % sides), c = a + sides, d = b + sides;
      this.tri(a, c, b); this.tri(b, c, d);
    }
    const cap = (r, k, flip) => {
      const ax = [0, 1, 2].map((q) => r.x[(q + 1) % 3] * r.y[(q + 2) % 3] - r.x[(q + 2) % 3] * r.y[(q + 1) % 3]);
      const n = flip ? ax.map((x) => -x) : ax, ctr = this.vert(r.c, n, r.col(0, 0), r.bones[0], r.bones[1], r.bones[2]);
      for (let s = 0; s < sides; s++) { const a = base + k * sides + s, b = base + k * sides + ((s + 1) % sides); flip ? this.tri(ctr, b, a) : this.tri(ctr, a, b); }
    };
    if (capStart) cap(rings[0], 0, true);
    if (capEnd) cap(rings.at(-1), rings.length - 1, false);
  }
  // a tube along a polyline of points with radii; frames by parallel transport
  tube(pts, radii, sides, col, bonesAt, opts = {}) {
    const rings = [];
    let up = opts.up ?? [0, 1, 0];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...t) || 1; t = t.map((x) => x / l);
      let x = [up[1] * t[2] - up[2] * t[1], up[2] * t[0] - up[0] * t[2], up[0] * t[1] - up[1] * t[0]];
      if (Math.hypot(...x) < 1e-4) x = [0, 0, 1]; const lx = Math.hypot(...x); x = x.map((q) => q / lx);
      const y = [t[1] * x[2] - t[2] * x[1], t[2] * x[0] - t[0] * x[2], t[0] * x[1] - t[1] * x[0]];
      up = y;
      const r = radii[k], f = opts.flat ?? 1;
      rings.push({ c: pts[k], x, y, rx: r, ry: r * f, col: (th, s) => col(k / (pts.length - 1), th, s), bones: bonesAt(k / (pts.length - 1)) });
    }
    this.loft(rings, sides, opts.capStart ?? true, opts.capEnd ?? true);
  }
  ellipsoid(c, r, seg, col, bones, rot = null) {
    const base = this.v.length / STRIDE;
    for (let a = 0; a <= seg; a++) for (let b = 0; b <= seg * 2; b++) {
      const th = (a / seg) * Math.PI, ph = (b / (seg * 2)) * Math.PI * 2;
      let n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      let p = [n[0] * r[0], n[1] * r[1], n[2] * r[2]];
      let nn = [n[0] / r[0], n[1] / r[1], n[2] / r[2]];
      if (rot) { p = rot(p); nn = rot(nn); }
      const l = Math.hypot(...nn);
      this.vert([c[0] + p[0], c[1] + p[1], c[2] + p[2]], nn.map((x) => x / l), col(n), bones[0], bones[1], bones[2]);
    }
    const row = seg * 2 + 1;
    for (let a = 0; a < seg; a++) for (let b = 0; b < seg * 2; b++) { const i = base + a * row + b; this.tri(i, i + row, i + 1); this.tri(i + 1, i + row, i + row + 1); }
  }
  quad2(p, u, v, col, bones, n) { // a two-sided flat leaf (ears, leaves)
    for (const s of [1, -1]) {
      const nn = n.map((x) => x * s), a = this.vert(p, nn, col, bones[0], bones[1], bones[2]);
      const b = this.vert([p[0] + u[0], p[1] + u[1], p[2] + u[2]], nn, col, bones[0], bones[1], bones[2]);
      const c = this.vert([p[0] + u[0] + v[0], p[1] + u[1] + v[1], p[2] + u[2] + v[2]], nn, col, bones[0], bones[1], bones[2]);
      const d = this.vert([p[0] + v[0], p[1] + v[1], p[2] + v[2]], nn, col, bones[0], bones[1], bones[2]);
      if (s > 0) { this.tri(a, b, c); this.tri(a, c, d); } else { this.tri(a, c, b); this.tri(a, d, c); }
    }
  }
  done() { return { vertices: new Float32Array(this.v), indices: this.v.length / STRIDE > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i) }; }
}

/* ------------------------------------------------------------------ quadrupeds (deer and wolf) */
// Joint positions in metres for a white-tailed deer (shoulder ~1.0 m) and a grey wolf (~0.8 m).
export const QUADRUPEDS = {
  deer: {
    root: [-0.42, 0.95, 0], chest: [0.38, 1.0, 0], neck: [0.45, 1.08, 0], head: [0.74, 1.46, 0], snout: [1.05, 1.31, 0], tail: [-0.66, 1.0, 0],
    shoulder: [0.38, 0.93, 0.12], elbow: [0.35, 0.62, 0.12], carpus: [0.37, 0.31, 0.12], ffet: [0.38, 0.07, 0.12],
    hip: [-0.42, 0.93, 0.12], stifle: [-0.30, 0.63, 0.12], hock: [-0.50, 0.40, 0.12], hfet: [-0.48, 0.07, 0.12],
    body: [[-0.70, 0.05, 0.05, 0.98], [-0.62, 0.20, 0.15, 0.98], [-0.45, 0.27, 0.19, 0.96], [-0.2, 0.28, 0.2, 0.94], [0.05, 0.28, 0.2, 0.94], [0.3, 0.29, 0.19, 0.98], [0.48, 0.24, 0.16, 1.03], [0.58, 0.12, 0.1, 1.06]],
    neckR: [0.13, 0.085], headR: [0.088, 0.04], legR: { upperF: [0.075, 0.05], upperH: [0.11, 0.06], lower: [0.045, 0.03], cannon: [0.026, 0.022] },
    coat: { back: [0.40, 0.29, 0.19], flank: [0.55, 0.40, 0.27], belly: [0.90, 0.86, 0.78], leg: [0.62, 0.48, 0.34], hoof: [0.09, 0.08, 0.07], nose: [0.05, 0.05, 0.05] },
    ears: { at: [0.78, 1.55, 0.06], len: 0.17, wid: 0.08 }, tailLen: 0.17, tailWide: 0.09, tailWhite: true,
  },
  wolf: {
    root: [-0.36, 0.78, 0], chest: [0.32, 0.80, 0], neck: [0.40, 0.84, 0], head: [0.62, 0.98, 0], snout: [0.92, 0.90, 0], tail: [-0.58, 0.80, 0],
    shoulder: [0.32, 0.74, 0.11], elbow: [0.30, 0.48, 0.11], carpus: [0.33, 0.25, 0.11], ffet: [0.35, 0.06, 0.11],
    hip: [-0.36, 0.74, 0.11], stifle: [-0.24, 0.50, 0.11], hock: [-0.42, 0.30, 0.11], hfet: [-0.40, 0.06, 0.11],
    body: [[-0.62, 0.06, 0.06, 0.80], [-0.55, 0.17, 0.14, 0.80], [-0.40, 0.21, 0.17, 0.79], [-0.1, 0.22, 0.18, 0.78], [0.15, 0.25, 0.2, 0.80], [0.35, 0.27, 0.2, 0.83], [0.46, 0.22, 0.16, 0.86], [0.52, 0.12, 0.1, 0.88]],
    neckR: [0.16, 0.11], headR: [0.11, 0.035], legR: { upperF: [0.07, 0.05], upperH: [0.1, 0.055], lower: [0.042, 0.032], cannon: [0.03, 0.026] },
    coat: { back: [0.26, 0.25, 0.24], flank: [0.50, 0.47, 0.43], belly: [0.80, 0.77, 0.72], leg: [0.55, 0.50, 0.44], hoof: [0.1, 0.1, 0.1], nose: [0.03, 0.03, 0.03] },
    ears: { at: [0.64, 1.08, 0.06], len: 0.11, wid: 0.07 }, tailLen: 0.42, tailWide: 0.11, tailWhite: false,
  },
};
// bones: 0 root, 1 chest, 2 neck, 3 head, 4 tail, 5-7 front-left upper/lower/cannon, 8-10 front-right,
// 11-13 hind-left, 14-16 hind-right, 17-18 left and right ear, 19-20 left and right eye (the countenance)
export const QUAD_BONES = 21, HUMAN_BONES = 14;
export function quadrupedSkeleton(P) {
  const L = (p) => [p[0], p[1], p[2]], R = (p) => [p[0], p[1], -p[2]];
  return [
    { name: "root", parent: -1, head: P.root }, { name: "chest", parent: 0, head: P.chest }, { name: "neck", parent: 1, head: P.neck },
    { name: "head", parent: 2, head: P.head }, { name: "tail", parent: 0, head: P.tail },
    { name: "fl.upper", parent: 1, head: L(P.shoulder) }, { name: "fl.lower", parent: 5, head: L(P.elbow) }, { name: "fl.cannon", parent: 6, head: L(P.carpus), tail: L(P.ffet) },
    { name: "fr.upper", parent: 1, head: R(P.shoulder) }, { name: "fr.lower", parent: 8, head: R(P.elbow) }, { name: "fr.cannon", parent: 9, head: R(P.carpus), tail: R(P.ffet) },
    { name: "hl.upper", parent: 0, head: L(P.hip) }, { name: "hl.lower", parent: 11, head: L(P.stifle) }, { name: "hl.cannon", parent: 12, head: L(P.hock), tail: L(P.hfet) },
    { name: "hr.upper", parent: 0, head: R(P.hip) }, { name: "hr.lower", parent: 14, head: R(P.stifle) }, { name: "hr.cannon", parent: 15, head: R(P.hock), tail: R(P.hfet) },
    { name: "l.ear", parent: 3, head: L(P.ears.at) }, { name: "r.ear", parent: 3, head: R(P.ears.at) },
    { name: "l.eye", parent: 3, head: L(eyeAt(P)) }, { name: "r.eye", parent: 3, head: R(eyeAt(P)) },
  ];
}
export const eyeAt = (P) => P.eye ?? [P.head[0] + 0.07, P.head[1] + 0.03, P.headR[0] * 0.78];

export function quadrupedMesh(kind) {
  const P = QUADRUPEDS[kind], C = P.coat, m = new MeshBuilder();
  const rootX = P.root[0], chestX = P.chest[0];
  // coat colour by height above the body centre line (dorsal dark, ventral pale) and fine banding
  const coat = (yrel, k = 0) => { const t = clamp01((yrel + 1) / 2); const base = t > 0.5 ? mix3(C.flank, C.back, (t - 0.5) * 2) : mix3(C.belly, C.flank, clamp01(t * 2.2 - 0.1)); const j = 0.94 + 0.08 * hashf(k); return base.map((x) => x * j); };
  // torso: ellipse rings along x, blended pelvis -> chest
  const body = P.body.map(([x, ry, rz, cy]) => ({ c: [x, cy, 0], x: [0, 1, 0], y: [0, 0, 1], rx: ry, ry: rz,
    col: (th, s) => coat(Math.cos(th), s + Math.round(x * 100)), bones: [0, 1, 1 - clamp01((x - rootX) / (chestX - rootX))] }));
  m.loft(body, 18);
  // neck and head
  const nk = [P.neck, [lerp(P.neck[0], P.head[0], 0.5), lerp(P.neck[1], P.head[1], 0.55), 0], P.head];
  m.tube([[P.chest[0] + 0.04, P.chest[1] + 0.02, 0], ...nk], [P.neckR[0] * 1.05, P.neckR[0], lerp(P.neckR[0], P.neckR[1], 0.6), P.neckR[1]], 12,
    (t, th) => coat(Math.sin(th) * 0.9 + (t > 0.85 ? 0.2 : 0)), (t) => (t < 0.35 ? [1, 2, 1 - t / 0.35] : t > 0.85 ? [2, 3, 1 - (t - 0.85) / 0.15] : [2, 2, 1]));
  const hd = [[P.head[0] - 0.05, P.head[1] + 0.03, 0], P.head, [lerp(P.head[0], P.snout[0], 0.5), lerp(P.head[1], P.snout[1], 0.45), 0], P.snout];
  m.tube(hd, [P.headR[0] * 0.8, P.headR[0], lerp(P.headR[0], P.headR[1], 0.55), P.headR[1]], 12,
    (t, th) => (t > 0.9 ? C.nose : coat(Math.sin(th) * 0.7 + 0.3)), () => [3, 3, 1], { flat: 0.82 });
  // eyes and ears
  for (const z of [1, -1]) {
    const ea = eyeAt(P), eb = z > 0 ? 19 : 20, ear = z > 0 ? 17 : 18;
    m.ellipsoid([ea[0], ea[1], z * ea[2]], [0.019, 0.017, 0.012], 5, () => [0.025, 0.02, 0.018], [eb, eb, 1]);
    const e = P.ears, base = [e.at[0], e.at[1], z * e.at[2]];
    // an ear: a cupped leaf of three quads, pale inside
    const cup = (u, v, col, sh) => m.quad2([base[0] + sh[0], base[1] + sh[1], base[2] + z * sh[2]], u, v, col, [ear, ear, 1], [0.15, 0.2, z]);
    cup([-0.02, e.len, z * e.len * 0.35], [-e.wid * 0.5, 0.01, z * 0.004], kind === "deer" ? [0.62, 0.48, 0.36] : [0.30, 0.28, 0.26], [0, 0, 0]);
    cup([-0.02, e.len * 0.92, z * e.len * 0.3], [-e.wid * 0.5, 0.01, z * 0.02], kind === "deer" ? [0.55, 0.42, 0.32] : [0.26, 0.24, 0.22], [-e.wid * 0.5, 0, 0.004]);
    cup([-0.015, e.len * 0.8, z * e.len * 0.26], [-e.wid * 0.62, 0.008, z * 0.0], kind === "deer" ? [0.86, 0.78, 0.70] : [0.62, 0.58, 0.54], [-e.wid * 0.18, 0.02, -0.006]);
  }
  // tail: brown on top, white beneath (white-tailed deer); bushy for the wolf
  const tl = [P.tail, [P.tail[0] - P.tailLen * 0.5, P.tail[1] - P.tailLen * 0.25, 0], [P.tail[0] - P.tailLen, P.tail[1] - P.tailLen * 0.75, 0]];
  m.tube(tl, [P.tailWide * 0.6, P.tailWide, P.tailWide * 0.3], 10, (t, th) => (P.tailWhite && Math.sin(th) < 0 ? [0.95, 0.94, 0.9] : coat(0.7)), () => [4, 4, 1], { flat: 0.55 });
  // legs: upper, lower, cannon, hoof
  const leg = (side, front) => {
    const z = side, j = front ? [P.shoulder, P.elbow, P.carpus, P.ffet] : [P.hip, P.stifle, P.hock, P.hfet];
    const b = front ? (side > 0 ? 5 : 8) : (side > 0 ? 11 : 14), pt = (p) => [p[0], p[1], z * p[2]];
    const up = front ? P.legR.upperF : P.legR.upperH;
    m.tube([pt([j[0][0], j[0][1] + 0.06, j[0][2]]), pt(j[0]), pt(j[1])], [up[0] * 1.1, up[0], up[1]], 10, (t) => mix3(coat(0.2), C.leg, t), (t) => (t < 0.3 ? [front ? 1 : 0, b, 0.5 - t] : [b, b, 1]));
    m.tube([pt(j[1]), pt(j[2])], P.legR.lower, 8, () => C.leg, () => [b + 1, b + 1, 1]);
    m.tube([pt(j[2]), pt(j[3]), [j[3][0] + 0.02, 0.02, z * j[3][2]]], [P.legR.cannon[0], P.legR.cannon[1], P.legR.cannon[1] * 1.15], 8,
      (t) => (t > 0.6 ? C.hoof : C.leg), () => [b + 2, b + 2, 1]);
  };
  leg(1, true); leg(-1, true); leg(1, false); leg(-1, false);
  return m.done();
}

/* ------------------------------------------------------------------ the warden (a ranger) */
export const HUMAN = {
  pelvis: [0, 0.98, 0], chest: [0, 1.3, 0], neck: [0, 1.55, 0], head: [0, 1.66, 0],
  shoulder: [0, 1.46, 0.2], elbow: [0, 1.17, 0.23], wrist: [0, 0.92, 0.24], hip: [0, 0.95, 0.1], knee: [0.02, 0.52, 0.1], ankle: [0, 0.09, 0.1], toe: [0.16, 0.03, 0.1],
};
// bones: 0 pelvis, 1 chest, 2 head, 3 l.upperarm, 4 l.forearm, 5 r.upperarm, 6 r.forearm, 7 l.thigh, 8 l.shin, 9 l.foot, 10 r.thigh, 11 r.shin, 12 r.foot,
// 13 hat (its brim and crown are each warden's own)
export function humanSkeleton(H = HUMAN) {
  const L = (p) => [p[0], p[1], p[2]], R = (p) => [p[0], p[1], -p[2]];
  return [
    { name: "pelvis", parent: -1, head: H.pelvis }, { name: "chest", parent: 0, head: H.chest }, { name: "head", parent: 1, head: H.neck },
    { name: "l.upperarm", parent: 1, head: L(H.shoulder) }, { name: "l.forearm", parent: 3, head: L(H.elbow) },
    { name: "r.upperarm", parent: 1, head: R(H.shoulder) }, { name: "r.forearm", parent: 5, head: R(H.elbow) },
    { name: "l.thigh", parent: 0, head: L(H.hip) }, { name: "l.shin", parent: 7, head: L(H.knee) }, { name: "l.foot", parent: 8, head: L(H.ankle) },
    { name: "r.thigh", parent: 0, head: R(H.hip) }, { name: "r.shin", parent: 10, head: R(H.knee) }, { name: "r.foot", parent: 11, head: R(H.ankle) },
    { name: "hat", parent: 2, head: [0, H.head[1] + 0.12, 0] },
  ];
}
export function humanMesh() {
  const H = HUMAN, m = new MeshBuilder();
  const shirt = [0.55, 0.50, 0.36], trousers = [0.26, 0.30, 0.20], boots = [0.20, 0.13, 0.08], skin = [0.78, 0.60, 0.47], hat = [0.36, 0.26, 0.16], badge = [0.85, 0.72, 0.25];
  m.tube([[0, 0.92, 0], [0, 1.08, 0], [0, 1.3, 0], [0, 1.46, 0]], [0.16, 0.15, 0.17, 0.13], 14, (t) => (t < 0.18 ? trousers : shirt), (t) => [0, 1, 1 - clamp01((t - 0.2) / 0.5)], { flat: 0.72 });
  m.ellipsoid([0.1, 1.38, 0.08], [0.02, 0.025, 0.012], 3, () => badge, [1, 1, 1]);
  m.tube([[0, 1.46, 0], H.neck], [0.06, 0.055], 8, () => skin, () => [1, 2, 0.5]);
  m.ellipsoid([0.02, H.head[1] + 0.05, 0], [0.1, 0.12, 0.09], 8, () => skin, [2, 2, 1]);
  // a face: eyes, brows, a nose (the countenance reads at a few metres)
  for (const z of [1, -1]) {
    m.ellipsoid([0.105, H.head[1] + 0.07, z * 0.035], [0.008, 0.009, 0.012], 4, () => [0.03, 0.025, 0.02], [2, 2, 1]);
    m.ellipsoid([0.1, H.head[1] + 0.1, z * 0.037], [0.008, 0.005, 0.022], 3, () => [0.2, 0.14, 0.09], [2, 2, 1]);
  }
  m.ellipsoid([0.12, H.head[1] + 0.035, 0], [0.018, 0.022, 0.014], 4, () => skin, [2, 2, 1]);
  // wide-brim ranger hat (bone 13)
  m.tube([[0, H.head[1] + 0.12, 0], [0, H.head[1] + 0.13, 0]], [0.2, 0.2], 18, () => hat, () => [13, 13, 1], { capStart: true, capEnd: true });
  m.tube([[0, H.head[1] + 0.13, 0], [0, H.head[1] + 0.25, 0]], [0.11, 0.09], 14, () => hat, () => [13, 13, 1]);
  for (const z of [1, -1]) {
    const pt = (p) => [p[0], p[1], z * p[2]], ua = z > 0 ? 3 : 5, th = z > 0 ? 7 : 10;
    m.tube([pt(H.shoulder), pt(H.elbow)], [0.055, 0.045], 8, () => shirt, () => [ua, ua, 1]);
    m.tube([pt(H.elbow), pt(H.wrist), pt([0.03, 0.84, 0.245])], [0.043, 0.035, 0.04], 8, (t) => (t > 0.7 ? skin : shirt), () => [ua + 1, ua + 1, 1]);
    m.tube([pt([0, 1.0, 0.1]), pt(H.hip), pt(H.knee)], [0.085, 0.08, 0.065], 10, () => trousers, (t) => (t < 0.3 ? [0, th, 0.5] : [th, th, 1]));
    m.tube([pt(H.knee), pt(H.ankle)], [0.06, 0.05], 10, (t) => (t > 0.75 ? boots : trousers), () => [th + 1, th + 1, 1]);
    m.tube([pt([-0.04, 0.1, 0.1]), pt(H.ankle), pt(H.toe)], [0.055, 0.06, 0.045], 8, () => boots, () => [th + 2, th + 2, 1], { flat: 0.6 });
  }
  return m.done();
}
