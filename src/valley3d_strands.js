// Strand fur for the animal nearest the lens: up to 2^19 hairs rooted on its own body.
// SPDX-License-Identifier: GPL-3.0-only
//
// Roots are sampled once per class on the finest baked mesh, area-weighted, with each root's triangle,
// barycentric weights, length (by region: body, neck, face, legs, tail, ears), its place in the base form
// (where the coat's marks are painted) and its colour. Each frame, for the one close animal, the strands are
// grown in the vertex shader from that animal's own blended rest surface (its form's dimensions applied on
// the CPU once an epoch), combed by bone, bent by gravity, curled by their seeds, skinned by the triangle's
// bones and drawn as camera-facing ribbons that taper from 0.15 mm at the root. A hair thinner than a pixel
// is widened to one and drawn with its coverage (a dither), so its brightness holds at any distance. Light
// is Marschner's (R, TT, TRT) on the strand's own tangent, shadowed by the shadow cascades, darker towards
// the root. The coat's marks come from the same function as the skin's (COAT).
import { compileProgram } from "./gl.js";

export const STRAND_MAX = 1 << 19, STRAND_SEG = 5;
const W = 4096;

// regions by bone: [length m (summer), width at the root m]
const REGION = (b) => b <= 1 ? [0.026, 0.00016] : b === 2 ? [0.032, 0.00016] : b === 3 ? [0.009, 0.00012] : b === 4 ? [0.07, 0.00014] : b <= 16 ? [0.011, 0.00013] : b <= 18 ? [0.013, 0.0001] : [0, 0];

export class Strands {
  // shaders: { program } already compiled (Valley3D compiles it with its others, without blocking), or { vs, fs }
  constructor(gl, shaders) {
    this.gl = gl; this.cls = {}; this.P = shaders.program ?? compileProgram(gl, shaders.vs, shaders.fs, "strands"); this.empty = gl.createVertexArray();
    this.rest = null; this.restKey = "";
  }
  // sample roots on a class's finest mesh (vb: 13 floats per vertex, ib: triangles)
  roots(name, lod) {
    if (this.cls[name]) return this.cls[name];
    const gl = this.gl, vb = lod.vb, ib = lod.ib, nt = ib.length / 3;
    const area = new Float64Array(nt + 1); let tot = 0;
    const P = (i, k) => vb[i * 13 + k];
    for (let t = 0; t < nt; t++) {
      const a = ib[t * 3], b = ib[t * 3 + 1], c = ib[t * 3 + 2], bone = Math.round(P(a, 9));
      const lum = (P(a, 6) + P(a, 7) + P(a, 8)) / 3;                     // no hair on hooves, the nose or the eyes
      let A = 0;
      if (lum > 0.075 && bone !== 19 && bone !== 20) {
        const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2), vx = P(c, 0) - P(a, 0), vy = P(c, 1) - P(a, 1), vz = P(c, 2) - P(a, 2);
        A = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      }
      tot += A; area[t + 1] = tot;
    }
    const n = STRAND_MAX, rows = Math.ceil((n * 3) / W), data = new Float32Array(W * rows * 4);
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    for (let k = 0; k < n; k++) {
      const x = rnd() * tot; let lo = 0, hi = nt;
      while (lo < hi) { const m = (lo + hi) >> 1; if (area[m + 1] < x) lo = m + 1; else hi = m; }
      const t = lo, a = ib[t * 3], b = ib[t * 3 + 1], c = ib[t * 3 + 2];
      let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w0 = 1 - u - v, bone = Math.round(P(a, 9)), [len] = REGION(bone);
      const base = [0, 1, 2].map((q) => P(a, q) * w0 + P(b, q) * u + P(c, q) * v), col = [6, 7, 8].map((q) => P(a, q) * w0 + P(b, q) * u + P(c, q) * v);
      const pack = Math.round(col[0] * 255) + Math.round(col[1] * 255) * 256 + Math.round(col[2] * 255) * 65536;
      const o = k * 12;
      data.set([a, b, c, rnd(), w0, u, len * (0.7 + 0.6 * rnd()), bone, base[0], base[1], base[2], pack], o);
    }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, rows, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return (this.cls[name] = { tex, n });
  }
  // the close animal's own rest surface: base + sum (t_k - 1/2) dP_k, with its normals and bones
  restFor(key, lod, dposF32, dnrmF16, t) {
    if (key === this.restKey) return;
    const gl = this.gl, vb = lod.vb, nv = vb.length / 13, rows = Math.ceil((nv * 2) / W), out = new Float32Array(W * rows * 4);
    const half = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 5.96e-8 : e === 31 ? 0 : s * (1 + f / 1024) * Math.pow(2, e - 15); };
    for (let i = 0; i < nv; i++) {
      let px = vb[i * 13], py = vb[i * 13 + 1], pz = vb[i * 13 + 2], nx = vb[i * 13 + 3], ny = vb[i * 13 + 4], nz = vb[i * 13 + 5];
      for (let k = 0; k < 16; k++) {
        const w = t[k] - 0.5; if (Math.abs(w) < 0.003) continue;
        const q = (i * 16 + k) * 3, r = (i * 16 + k) * 4;
        px += w * dposF32[q]; py += w * dposF32[q + 1]; pz += w * dposF32[q + 2];
        nx += w * half(dnrmF16[r]); ny += w * half(dnrmF16[r + 1]); nz += w * half(dnrmF16[r + 2]);
      }
      const l = Math.hypot(nx, ny, nz) || 1, b0 = vb[i * 13 + 9], b1 = vb[i * 13 + 10], w0 = vb[i * 13 + 11];
      out.set([px, py, pz, b0 + Math.min(0.999, w0) * 0.999, nx / l, ny / l, nz / l, b1], i * 8);
    }
    if (!this.rest) { this.rest = gl.createTexture(); }
    gl.bindTexture(gl.TEXTURE_2D, this.rest); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, rows, 0, gl.RGBA, gl.FLOAT, out);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.restKey = key;
  }
}
