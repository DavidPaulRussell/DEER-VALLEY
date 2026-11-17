// Close-up detail for the Deer Valley renderer: the baked material library as two texture arrays.
// SPDX-License-Identifier: GPL-3.0-only
//
// shards/materials holds 24 tileable material sets (tools/bake/materials.py): albedo with height, and
// normal, roughness and cavity, at 2048 x 2048. They load lazily, at a size set by the quality level,
// into two TEXTURE_2D_ARRAY textures. Shaders sample a material at up to five octaves (its tile, then
// 1/8, 1/64 ... of it), each faded in by the pixel's footprint, so a surface stays sharp from metres down
// to a tenth of a millimetre. The fine octaves are stochastically tiled (four taps, a random offset per
// cell corner) so the repetition never shows, and the cells are counted from a detail origin held in
// integers (MaterialLibrary.origin: per material, its quotient and remainder by the tile, u_detQ and u_detR) so
// the pattern is the same wherever the camera stands. Without the shards (a
// single-file page, or a repository without shards/) the surfaces stay procedural.
export const MAT = { meadow: 0, dry: 1, sand: 2, mud: 3, rock: 4, scree: 5, gravel: 6, stream: 7, moss: 8, litter: 9, snow: 10, duff: 11,
  juniperBark: 12, willowBark: 13, deadWood: 14, leaf: 15, deerSummer: 16, deerWinter: 17, wolf: 18, antler: 19, nose: 20, canvas: 21, leather: 22, iris: 23 };
export const MAT_LAYERS = 24;
// the finest step of the detail grid: every octave's tile (tile_m / 8^k, tile_m in 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.02 m)
// is a whole number of these, so the integer origin keeps every octave in phase
export const T_MIN = 0.01 / 4096;
const K_OFF = 409600 * 1000;                // a common multiple of every octave's steps: keeps the counts non-negative

// Where the baked shards are. A Plume host (serve.mjs, host/plume_photon.py) serves them at /shards/, beside the
// pages; the repository's own pages (dist/, web/) opened from any other static server find them one folder up.
// Asked once, with a small file; without an answer (file://, a page copied on its own) the first guess stays and
// every load fails quietly: the surfaces and animals stay procedural.
let shardsAt = null;
export function findShards(probe = "materials/materials.json") {
  if (shardsAt) return shardsAt;
  if (typeof location === "undefined" || typeof fetch === "undefined") return (shardsAt = Promise.resolve("shards/"));
  const tries = ["shards/", "../shards/"].map((c) => new URL(c, location.href).href);
  return (shardsAt = (async () => {
    for (const base of tries) {
      try { const r = await fetch(base + probe, { cache: "force-cache" }); if (r.ok && /json/.test(r.headers.get("content-type") || "json")) return base; } catch { /* the next place */ }
    }
    return tries[0];
  })());
}

export class MaterialLibrary {
  constructor(gl) {
    this.gl = gl; this.size = 0; this.ready = false; this.loading = null; this.loaded = 0; this.failed = false;
    this.meta = new Float32Array(MAT_LAYERS * 4); this.mean = new Float32Array(MAT_LAYERS * 3).fill(0.5);
    const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, MAT_LAYERS); return t; };
    this.ah = mk(); this.nr = mk(); this.detN = [0, 0, 0]; this.detO = [0, 0, 0];
    this.detQ = new Int32Array(MAT_LAYERS * 3); this.detR = new Int32Array(MAT_LAYERS * 3);
  }
  // (re)load at a size: 0 (none), 512, 1024 or 2048. Each image is decoded at its own size, mipmapped on the GPU
  // and the level of the wanted size blitted into the array, so the alpha (height) is never premultiplied.
  load(size, base = null) {
    if (size === this.size && (this.ready || this.loading)) return this.loading;
    this.size = size; this.ready = false; this.loaded = 0; this.meta.fill(0);
    if (!size) { this.token = null; this.loading = null; return null; }
    const gl = this.gl, mips = Math.floor(Math.log2(size)) + 1, token = {};
    this.token = token;
    this.loading = (async () => {
      base ??= (await findShards()) + "materials/";
      if (this.token !== token || gl.isContextLost()) return false;
      let index; try { const r = await fetch(base + "materials.json", { cache: "force-cache" }); if (!r.ok) throw 0; index = await r.json(); } catch { this.failed = true; return false; }
      const native = index.size || 2048, level = Math.max(0, Math.round(Math.log2(native / size)));
      const arr = [gl.createTexture(), gl.createTexture()], fmt = [gl.SRGB8_ALPHA8, gl.RGBA8];
      arr.forEach((t, i) => {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mips, fmt[i], size, size, MAT_LAYERS);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
        const an = gl.getExtension("EXT_texture_filter_anisotropic"); if (an) gl.texParameterf(gl.TEXTURE_2D_ARRAY, an.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      });
      const tmp = [gl.createTexture(), gl.createTexture()], nm = Math.floor(Math.log2(native)) + 1;
      tmp.forEach((t, i) => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, nm, fmt[i], native, native); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); });
      const rf = gl.createFramebuffer(), df = gl.createFramebuffer();
      const decode = async (url) => { const r = await fetch(url, { cache: "force-cache" }); if (!r.ok) throw new Error(url); return createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" }); };
      for (const set of index.sets) {
        if (this.token !== token) break;
        try {
          const imgs = await Promise.all(set.files.map((f) => decode(base + f)));
          if (this.token !== token) break;
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
          imgs.forEach((img, i) => {
            gl.bindTexture(gl.TEXTURE_2D, tmp[i]); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, native, native, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rf); gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmp[i], level);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, df); gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, arr[i], 0, set.index);
            gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            img.close?.();
          });
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          this.meta.set([set.tile_m, set.height_m, Math.round(set.tile_m / 0.01), 1], set.index * 4); this.mean.set(set.mean_albedo, set.index * 3); this.loaded++;
        } catch { /* a missing set stays procedural */ }
      }
      gl.deleteFramebuffer(rf); gl.deleteFramebuffer(df); tmp.forEach((t) => gl.deleteTexture(t));
      if (this.token !== token) { arr.forEach((t) => gl.deleteTexture(t)); return false; }
      for (const t of arr) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, t); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); }
      gl.deleteTexture(this.ah); gl.deleteTexture(this.nr); [this.ah, this.nr] = arr; this.ready = this.loaded > 0;
      return this.ready;
    })();
    return this.loading;
  }
  // per frame: the detail origin, a whole number of T_MIN steps nearest the eye (eye in the torus copy, ro the render origin)
  origin(eye, ro) {
    const n = [0, 1, 2].map((i) => Math.round(eye[i] / T_MIN));
    this.detN = n.map((x) => x + K_OFF); this.detO = n.map((x, i) => x * T_MIN - ro[i]);
    for (let L = 0; L < MAT_LAYERS; L++) {
      const t = Math.max(1, Math.round(this.meta[L * 4 + 2]) || 1);
      for (let a = 0; a < 3; a++) { const N = this.detN[a], q = Math.floor(N / t); this.detQ[L * 3 + a] = q; this.detR[L * 3 + a] = N - q * t; }
    }
  }
  bind(prog, unitA = 8, unitB = 9) {
    const gl = this.gl, u = prog.u; if (u.u_matAH === undefined) return;
    gl.activeTexture(gl.TEXTURE0 + unitA); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ah); gl.uniform1i(u.u_matAH, unitA);
    gl.activeTexture(gl.TEXTURE0 + unitB); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.nr); gl.uniform1i(u.u_matNR, unitB);
    gl.uniform4fv(u.u_matMeta, this.meta); gl.uniform3fv(u.u_matMean, this.mean); gl.uniform1f(u.u_detail, this.ready ? 1 : 0);
    gl.uniform1f(u.u_matSize, Math.max(1, this.size)); gl.uniform3iv(u.u_detQ, this.detQ); gl.uniform3iv(u.u_detR, this.detR); gl.uniform3fv(u.u_detO, this.detO);
  }
}

// GLSL: a material at up to five octaves. m is metres on the surface relative to the detail origin (mDet below),
// gx and gy its screen derivatives (taken in uniform control flow), kmax the octaves wanted.
//
// Written for Direct3D as well as for GL: on Windows, browsers run WebGL on D3D11 through ANGLE, whose HLSL is
// compiled by FXC when a program links. FXC unrolls every loop whose length it knows, and these loops (octaves,
// the parallax march, the 2 x 2 taps) nest inside functions called up to four times a shader; unrolled, the
// terrain, rock and fur shaders took it so long that the browser restarted its GPU process and the 3D view
// reported "terrain link:" with an empty log (1.4.0 on AMD Radeon/D3D11). So: the loops' bounds carry
// u_keepLoops, a uniform that is never set (0), which FXC cannot see through; the corner taps are written out;
// no vector is indexed by a variable (ANGLE emulates that with a switch); every sample has explicit derivatives
// or level, so nothing here needs gradients inside flow control. PLUME_SAFE (safe graphics) compiles stubs.
export const DETAIL = `
uniform mediump sampler2DArray u_matAH; uniform mediump sampler2DArray u_matNR;
uniform vec4 u_matMeta[24]; uniform vec3 u_matMean[24];   // tile m, relief m, tile in 1 cm units, loaded
uniform float u_detail; uniform float u_matSize;
uniform ivec3 u_detQ[24]; uniform ivec3 u_detR[24]; uniform vec3 u_detO;   // the detail origin in whole T_MIN steps, divided by each
                                                          // material's tile (1 cm units): quotient and remainder per axis; and where it is from the render origin
uniform int u_keepLoops;                                  // never set: 0. In a loop's bound it keeps D3D's compiler from unrolling it
struct Det { vec3 tint; vec2 nxz; float h; float rough; float ao; };
struct Tri { vec3 tint; vec3 n; float rough; float ao; };
vec2 mDet(vec2 relXZ) { return relXZ - u_detO.xz; }
vec3 mDet3(vec3 rel) { return rel - u_detO; }
#ifdef PLUME_SAFE
Det matDetail(int L, vec2 m, vec2 gx, vec2 gy, int kmax, ivec2 ax) { Det d; d.tint = vec3(1.0); d.nxz = vec2(0.0); d.h = 0.0; d.rough = 0.8; d.ao = 1.0; return d; }
vec2 parallax(int L, vec2 m, vec3 vd, vec2 gx, vec2 gy, int kmax) { return m; }
Tri triDetail(int L, vec3 p, vec3 dpx, vec3 dpy, vec3 n, int kmax, bool world) { Tri r; r.tint = vec3(1.0); r.n = n; r.rough = 0.8; r.ao = 1.0; return r; }
#else
vec2 cornerOff(ivec2 c, int k, int L) {
  uint n = uint(c.x) * 1597334677u ^ uint(c.y) * 3812015801u ^ uint(k * 31 + L) * 2654435761u;
  n ^= n >> 16; n *= 2246822519u; n ^= n >> 13; n *= 3266489917u; n ^= n >> 16;
  return vec2(float(n & 65535u), float(n >> 16)) / 65536.0;
}
int axisOf(ivec3 v, int a) { return a == 0 ? v.x : a == 1 ? v.y : v.z; }
// the octave's offset in tiles from the integer origin along the axes ax (x 0, y 1, z 2): whole cells and the
// remainder; ax.x < 0 for coordinates that carry no origin (a blade's, a branch's, an animal's own frame)
// An octave's tile is t << s T_MIN steps (t the tile in 1 cm units, s = 3 (4 - k)): with the origin's quotient q
// and remainder r by t (MaterialLibrary.origin), the cell is q >> s and the remainder (q mod 2^s) t + r, exactly.
void octOrigin(int L, int k, ivec2 ax, out ivec2 cell, out vec2 frac) {
  if (ax.x < 0) { cell = ivec2(0); frac = vec2(0.0); return; }
  int t = int(u_matMeta[L].z + 0.5), s = 3 * (4 - k);
  ivec2 q = ivec2(axisOf(u_detQ[L], ax.x), axisOf(u_detQ[L], ax.y)), r = ivec2(axisOf(u_detR[L], ax.x), axisOf(u_detR[L], ax.y));
  cell = q >> s; frac = vec2((q & ((1 << s) - 1)) * t + r) / float(t << s);
}
// the stochastic tiling's weights for the four corners of uv's cell (bilinear, sharpened to the fourth power)
vec4 cornerW(vec2 f) { vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y); w *= w; return w * w + 1e-6; }
// four taps, a random offset per cell corner, sharpened weights
void tap4(int L, int k, vec2 uv, vec2 dx, vec2 dy, ivec2 cell, out vec4 ah, out vec4 nr) {
  vec2 b = floor(uv); ivec2 c = ivec2(b) + cell; vec4 w = cornerW(uv - b); float layer = float(L);
  vec3 p0 = vec3(uv + cornerOff(c, k, L), layer), p1 = vec3(uv + cornerOff(c + ivec2(1, 0), k, L), layer);
  vec3 p2 = vec3(uv + cornerOff(c + ivec2(0, 1), k, L), layer), p3 = vec3(uv + cornerOff(c + ivec2(1, 1), k, L), layer);
  float ws = w.x + w.y + w.z + w.w;
  ah = (textureGrad(u_matAH, p0, dx, dy) * w.x + textureGrad(u_matAH, p1, dx, dy) * w.y + textureGrad(u_matAH, p2, dx, dy) * w.z + textureGrad(u_matAH, p3, dx, dy) * w.w) / ws;
  nr = (textureGrad(u_matNR, p0, dx, dy) * w.x + textureGrad(u_matNR, p1, dx, dy) * w.y + textureGrad(u_matNR, p2, dx, dy) * w.z + textureGrad(u_matNR, p3, dx, dy) * w.w) / ws;
}
Det matDetail(int L, vec2 m, vec2 gx, vec2 gy, int kmax, ivec2 ax) {
  Det d; d.tint = vec3(1.0); d.nxz = vec2(0.0); d.h = 0.0; d.rough = 0.8; d.ao = 1.0;
  vec4 meta = u_matMeta[L]; if (meta.w < 0.5 || u_detail < 0.5) return d;
  vec3 mean = max(u_matMean[L], vec3(0.02)); float foot = sqrt(max(length(gx) * length(gy), 1e-20)), layer = float(L);
  int kn = min(kmax, 5) + u_keepLoops;
  for (int k = 0; k < kn; k++) {
    float s = meta.x / float(1 << (3 * k)), tx = s / u_matSize;
    float w = k == 0 ? 1.0 : 1.0 - smoothstep(tx * 1.2, tx * 6.0, foot);
    if (w < 0.003) break;
    ivec2 cell; vec2 fr; octOrigin(L, k, ax, cell, fr);
    vec2 uv = m / s + fr, dx = gx / s, dy = gy / s;
    vec4 ah, nr;
    if (k < 2) { vec3 p = vec3(uv + cornerOff(ivec2(k, L), k, L), layer); ah = textureGrad(u_matAH, p, dx, dy); nr = textureGrad(u_matNR, p, dx, dy); }
    else tap4(L, k, uv, dx, dy, cell, ah, nr);
    float g = k == 0 ? 1.0 : 0.6;
    d.tint *= mix(vec3(1.0), ah.rgb / mean, w * g);
    vec2 t = nr.xy * 2.0 - 1.0; d.nxz += vec2(t.x, -t.y) * w;          // the bake stores +y towards the image top
    d.h += (ah.a - 0.5) * meta.y / float(1 << (3 * k)) * w;
    d.rough = mix(d.rough, nr.z, w); d.ao *= mix(1.0, nr.w, w * g);
  }
  return d;
}
// the relief of one octave at uv (in tiles), stochastically tiled like matDetail
float hTap(int L, int k, vec2 uv, ivec2 cell, float lod) {
  float layer = float(L);
  if (k < 2) return textureLod(u_matAH, vec3(uv + cornerOff(ivec2(k, L), k, L), layer), lod).a;
  vec2 b = floor(uv); ivec2 c = ivec2(b) + cell; vec4 w = cornerW(uv - b);
  float h = textureLod(u_matAH, vec3(uv + cornerOff(c, k, L), layer), lod).a * w.x + textureLod(u_matAH, vec3(uv + cornerOff(c + ivec2(1, 0), k, L), layer), lod).a * w.y
          + textureLod(u_matAH, vec3(uv + cornerOff(c + ivec2(0, 1), k, L), layer), lod).a * w.z + textureLod(u_matAH, vec3(uv + cornerOff(c + ivec2(1, 1), k, L), layer), lod).a * w.w;
  return h / (w.x + w.y + w.z + w.w);
}
// steep parallax at the octave whose texels match the pixels: march its relief along the view ray
// (vd from the eye to the surface, in the surface's frame: x, z across, y up); returns the shifted m
vec2 parallax(int L, vec2 m, vec3 vd, vec2 gx, vec2 gy, int kmax) {
  vec4 meta = u_matMeta[L]; if (meta.w < 0.5 || u_detail < 0.5) return m;
  float foot = sqrt(max(length(gx) * length(gy), 1e-20));
  int k = int(clamp(floor(log2(max(meta.x / (u_matSize * foot), 1.0)) / 3.0), 0.0, float(kmax - 1)));
  float s = meta.x / float(1 << (3 * k)), depth = meta.y / float(1 << (3 * k));
  ivec2 cell; vec2 fr; octOrigin(L, k, ivec2(0, 2), cell, fr);
  vec2 uv0 = m / s + fr, p = uv0, prev = uv0, stepUV = vd.xz / max(abs(vd.y), 0.35) * (depth / s) / 20.0;
  float layer = 1.0, lod = max(0.0, log2(foot / (s / u_matSize))), h = hTap(L, k, p, cell, lod), hPrev = h, lPrev = 1.0;
  for (int i = 0; i < 20 + u_keepLoops; i++) {
    if (h >= layer) break;
    prev = p; hPrev = h; lPrev = layer; p += stepUV; layer -= 1.0 / 20.0; h = hTap(L, k, p, cell, lod);
  }
  float after = h - layer, before = hPrev - lPrev, w = clamp(after / max(after - before, 1e-5), 0.0, 1.0);   // between the last two layers
  if (p != uv0) p = mix(p, prev, w);
  return m + (p - uv0) * s;
}
// triplanar detail on a curved surface: p in metres (any frame), dpx and dpy its derivatives, n the normal in that frame
Tri triDetail(int L, vec3 p, vec3 dpx, vec3 dpy, vec3 n, int kmax, bool world) {
  Tri r; r.tint = vec3(1.0); r.n = n; r.rough = 0.8; r.ao = 1.0;
  if (u_detail < 0.5 || u_matMeta[L].w < 0.5) return r;
  vec3 bw = pow(abs(n), vec3(4.0)); bw /= bw.x + bw.y + bw.z; vec3 sg = sign(n);
  ivec2 aX = world ? ivec2(2, 1) : ivec2(-1), aY = world ? ivec2(0, 2) : ivec2(-1), aZ = world ? ivec2(0, 1) : ivec2(-1);
  Det X = matDetail(L, p.zy, dpx.zy, dpy.zy, kmax, aX), Y = matDetail(L, p.xz, dpx.xz, dpy.xz, kmax, aY), Z = matDetail(L, p.xy, dpx.xy, dpy.xy, kmax, aZ);
  r.tint = X.tint * bw.x + Y.tint * bw.y + Z.tint * bw.z; r.rough = X.rough * bw.x + Y.rough * bw.y + Z.rough * bw.z; r.ao = X.ao * bw.x + Y.ao * bw.y + Z.ao * bw.z;
  r.n = normalize(n + vec3(0.0, X.nxz.y, X.nxz.x * sg.x) * bw.x + vec3(Y.nxz.x, 0.0, Y.nxz.y) * bw.y * sg.y + vec3(Z.nxz.x * sg.z, Z.nxz.y, 0.0) * bw.z);
  return r;
}
#endif
`;
