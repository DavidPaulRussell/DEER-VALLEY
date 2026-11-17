// Deer Valley in the third person: a WebGL2 renderer that only reads the simulation.
// SPDX-License-Identifier: GPL-3.0-only
//
// Terrain: six rings of 129 x 129 vertices around the camera, fed by the living map law's RUSSL-Zarr
// store at 0.25, 0.5, 1, 2, 4 and 16 m per sample (out to 1 km), rebuilt whenever the map's generation
// changes. The meadow: the XPU field as textures (species alive, cropped, their ages and each cell's
// generation stamp) and instanced clumps of grass and flowers placed by them. Junipers, willows,
// blueberries and boulders are generated in the vertex shader from each one's seed (valley3d_flora.js),
// so no two are alike. Animals: skinned meshes; gaits, leg IK on the terrain, head and tail poses from
// the epoch-to-epoch motion. Light: an analytic sky with a sun, a cloud deck and mountain ranges, two
// shadow cascades, height fog, water with depth absorption, bloom, ACES, seasonal grading and depth of
// field on the deer being followed. Close up, the camera goes down to half a millimetre: positions are kept
// relative to a render origin by the eye, depth is reversed and floating (EXT_clip_control), the baked
// material library adds octaves of detail to every surface, and the sky is a spectral atmosphere.
// Nothing here changes the simulation or its digests.
import { compilePrograms, ContextLost, noWebGL2Reason, gpuName, buffer, vao, texture, target, freeTarget, M4, Q as QT, V3 } from "./gl.js";
import { STRAND_VS, STRAND_FS, STRAND_SEG, SKY_VS, SKY_FS, TERRAIN_VS, TERRAIN_FS, WATER_VS, WATER_FS, GRASS_VS, GRASS_FS, GRASS_BLADES, GRASS_VPB, PLANT_VS, PLANT_FS, PLANT_DEPTH_FS, ROCK_VS, ROCK_FS, SKIN_VS, ANTLER_VS, FUR_FS, BIRD_VS, BIRD_FS, DEPTH_FS, MARK_VS, MARK_FS, FULL_VS, BRIGHT_FS, BLUR_FS, FINAL_FS, PROBE_FS } from "./valley3d_shaders.js";
import { MaterialLibrary } from "./valley3d_detail.js";
import { Atmosphere, ATMOS_PROGRAMS, sunColor, hazeExtinction, PLANET } from "./valley3d_atmos.js";
import { AnimalForms, deerContinuum, wolfContinuum, wardenContinuum, PLANT_FORMS, PLANT_DIM_ORDER, ROCK_FORM, ROCK_DIM_ORDER, formUniforms } from "./valley3d_forms.js";
const PLANT_U = ["juniper", "willow", "blueberry"].map((k) => formUniforms(PLANT_FORMS[k], PLANT_DIM_ORDER)), ROCK_U = formUniforms(ROCK_FORM, ROCK_DIM_ORDER);
import { fovAt, zoomOf, lodLevel, lensUniforms, radPerPixel } from "./valley3d_eye.js";
import { Strands, STRAND_MAX } from "./valley3d_strands.js";
import { Perf, TARGET_MS } from "./valley3d_perf.js";
import { STRIDE, quadrupedSkeleton, quadrupedMesh, QUADRUPEDS, humanSkeleton, humanMesh, QUAD_BONES, eyeAt, HUMAN } from "./valley3d_meshes.js";
const FORM_CLASS = { deer: "deer", wolf: "wolf", human: "warden" };   // the renderer's kinds and the classes baked for them
import { shapeSpace, deerMorph, wolfMorph, wardenMorph, attend, countenance } from "./valley3d_morph.js";
import { Birds, birdTemplate } from "./valley3d_birds.js";
import { KINDS, woodTemplate, cardTemplate, sphereTemplate, paintFoliageAtlas, floraInstances, rockInstances } from "./valley3d_flora.js";
import { cellOf, hash, SPECIES, NONE, YEAR, SEASON_LEN } from "./valley.js";
const h01 = (a, b) => { let x = Math.imul((a | 0) ^ 0x7feb352d, 0x846ca68b); x ^= x >>> 15; x = Math.imul(x ^ (b | 0), 0x2c1b3c6d); x ^= x >>> 12; x = Math.imul(x, 0x297a2d39); x ^= x >>> 15; return (x >>> 0) / 4294967296; };
// a bone-texture row: 21 skin matrices, then the 16 shape dimensions, then landmarks (head joint and skull half-width; eye)
const BONE_W = QUAD_BONES * 4 + 7, ROWF = BONE_W * 4;   // texel 90: the cross-fade fractions between meshes
import { spacing } from "./valleymap.js";

export const CELL_M = 4, WORLD = 512;
export const QUALITY = {
  low: { scale: 0.6, grassR: 16, grassD: 0.5, shadow: 0, dof: 0, animals: 60, plantsR: 80, rocksR: 50, detail: 0 },
  medium: { scale: 0.8, grassR: 22, grassD: 0.38, shadow: 1024, dof: 0, animals: 120, plantsR: 110, rocksR: 80, detail: 512 },
  high: { scale: 1.0, grassR: 30, grassD: 0.3, shadow: 2048, dof: 1, animals: 220, plantsR: 150, rocksR: 110, detail: 1024 },
  ultra: { scale: 1.0, grassR: 40, grassD: 0.24, shadow: 4096, dof: 1, animals: 400, plantsR: 200, rocksR: 150, detail: 2048 },
};
const RINGS = [{ level: 0, half: 16 }, { level: 1, half: 32 }, { level: 2, half: 64 }, { level: 3, half: 128 }, { level: 4, half: 256 }, { level: 6, half: 1024 }];
export const NEAR = 0.15, FAR = 2600, MACRO_MIN = 0.0005, MACRO_AT = 1.6;   // the closest the camera comes (0.5 mm), and where macro begins
const GRASS_H = [0.16, 0.42, 0.62, 0.48, 0.95, 0.30, 0.0, 0.0];     // clover, bluegrass, fescue, sedge, fireweed, blueberry (low leaves), willow and juniper are meshes
const wrapD = (d) => ((d % WORLD) + WORLD * 1.5) % WORLD - WORLD / 2;  // shortest signed distance on the torus
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// every program the renderer draws with: [vertex shader, fragment shader, label] (also compiled one by one by check3d)
export const PROGRAMS = {
  sky: [SKY_VS, SKY_FS, "sky"], terrain: [TERRAIN_VS, TERRAIN_FS, "terrain"], water: [WATER_VS, WATER_FS, "water"],
  grass: [GRASS_VS, GRASS_FS, "grass"], plant: [PLANT_VS, PLANT_FS, "plant"], skin: [SKIN_VS, FUR_FS, "skin"], rock: [ROCK_VS, ROCK_FS, "rock"],
  antler: [ANTLER_VS, FUR_FS, "antler"], antlerDepth: [ANTLER_VS, DEPTH_FS, "antler depth"], bird: [BIRD_VS, BIRD_FS, "bird"],
  terrainDepth: [TERRAIN_VS, DEPTH_FS, "terrain depth"], plantDepth: [PLANT_VS, PLANT_DEPTH_FS, "plant depth"], skinDepth: [SKIN_VS, DEPTH_FS, "skin depth"], rockDepth: [ROCK_VS, DEPTH_FS, "rock depth"],
  mark: [MARK_VS, MARK_FS, "markers"], bright: [FULL_VS, BRIGHT_FS, "bright"], blur: [FULL_VS, BLUR_FS, "blur"], final: [FULL_VS, FINAL_FS, "final"], probe: [FULL_VS, PROBE_FS, "probe"],
};

// the programs whose shaders use the material library (matDetail, triDetail): safe graphics compiles them without
export const DETAIL_PROGRAMS = Object.keys(PROGRAMS).filter((k) => /\b(matDetail|triDetail)\(/.test(PROGRAMS[k][1].replace(/\/\/[^\n]*/g, "").split("void main()")[1] ?? ""));

export class Valley3D {
  // The view is usable at once (attach, follow, setQuality...); it draws once its shaders are compiled, which
  // happens without blocking the GPU process (compilePrograms). whenReady settles when they are, or with why not.
  // gfx: "full"; "safe" ("safe graphics" for drivers that reset on the full shaders: no close-up material detail,
  // no strand fur, everything else alike); or "auto": full, except on Direct3D (Windows), where the view starts
  // safe and compiles the full shaders behind it, swapping them in when they are ready (upgrade). A driver that
  // resets on them takes the context with it, and the page restarts the view in safe graphics.
  // onStatus(text | null) reports the preparation; onUpgrade(state, error) the swap ("compiling", "done",
  // "failed"); onLost({ preparing, upgrading }) a lost WebGL context (the driver reset, or the browser restarted
  // its GPU process): the view stops, and the page decides whether to start a new one. (safe: true = gfx "safe".)
  constructor(canvas, { quality = "auto", onPick = null, onError = null, onQuality = null, quiet = null, onStatus = null, onLost = null, onUpgrade = null, gfx = null, safe = false } = {}) {
    this.canvas = canvas; this.onPick = onPick; this.onError = onError; this.onQuality = onQuality; this.quiet = quiet; this.onStatus = onStatus; this.onLost = onLost; this.onUpgrade = onUpgrade;
    this.autoQuality = quality === "auto"; if (quality === "auto") quality = "high";
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
    if (!gl) throw Object.assign(new Error(noWebGL2Reason()), { noContext: true });
    if (gl.isContextLost()) throw new ContextLost("starting the 3D view (this canvas's context is already lost)");
    this.gl = gl; this.lost = false; this.ready = false; this.failed = null; this.gpu = gpuName(gl); this.d3d = /Direct3D|D3D1\d|D3D9/i.test(this.gpu);
    gfx = gfx ?? (safe ? "safe" : "full"); if (gfx === "auto") gfx = this.d3d ? "progressive" : "full";
    this.gfx = gfx; this.safe = gfx !== "full"; this.upgradingNow = false;   // safe shaders until an upgrade has swapped the full ones in
    this.onContextLost = (e) => { e.preventDefault(); if (this.lost) return; this.lost = true; this.running = false; this.onLost?.({ preparing: !this.ready, upgrading: this.upgradingNow }); };
    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    this.hdr = !!gl.getExtension("EXT_color_buffer_float");
    this.half = this.hdr || !!gl.getExtension("EXT_color_buffer_half_float");    // RGBA16F renders (the colour targets)
    this.clip = gl.getExtension("EXT_clip_control"); this.rev = !!(this.clip && this.hdr);   // reversed floating depth: sub-millimetre near planes
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.mat = new MaterialLibrary(gl); this.atmos = null;   // the sky's tables are made with its programs (prepare)
    this.perf = new Perf(gl); this.scaleMul = 1;              // GPU time per pass and the 60 fps governor (valley3d_perf.js)
    this.ro = [0, 0, 0]; this.near = NEAR; this.zoomZ = zoomOf(0.9); this.fov = 0.9;   // the focal length's continuum (EYE-3): z in [0, 1], wide to telephoto
    this.macro = null; this.probeQ = null; this.probeWant = null; this.probeLast = null;
    this.q = QUALITY[quality] ?? QUALITY.high; this.qualityName = QUALITY[quality] ? quality : "high";
    this.cam = { yaw: 0, pitch: 0.28, dist: 6.5, orbitYaw: 0, pos: [256, 30, 256], target: [256, 20, 256], mode: "follow" };
    this.followId = null; this.anim = new Map(); this.timeOfDay = null; this.tod = 0.38; this.senses = false; this.cone = false;
    this.epochT0 = performance.now(); this.periodMs = 2000; this.frameNo = 0; this.lastT = performance.now(); this.running = false;
    this.emptyVao = gl.createVertexArray(); this.staticGeometry(); this.inputs();
    this.vegTex = texture(gl, 128, 128, { internal: gl.RGBA32UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_INT, filter: gl.NEAREST, wrap: gl.REPEAT });
    this.swardTex = texture(gl, 128, 128, { filter: gl.LINEAR, wrap: gl.REPEAT });
    this.wearTex = texture(gl, 128, 128, { filter: gl.LINEAR, wrap: gl.REPEAT });
    const atlas = paintFoliageAtlas(1024);
    this.leafTex = texture(gl, atlas.size, atlas.size, { data: atlas.data, mips: true, wrap: gl.CLAMP_TO_EDGE });
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic"); if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    this.boneTex = {}; for (const k of ["deer", "wolf", "human"]) this.boneTex[k] = texture(gl, BONE_W, 512, { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST });
    this.boneData = { deer: new Float32Array(ROWF * 512), wolf: new Float32Array(ROWF * 512), human: new Float32Array(ROWF * 512) };
    // the classes' baked extreme forms (shards/animals); until they arrive (or without them) the procedural template is drawn
    this.forms = new AnimalForms(gl); this.formGL = {};
    for (const k of ["deer", "wolf", "human"]) this.forms.load(FORM_CLASS[k]).then((c) => { if (c && !this.lost) this.formGL[k] = c.lods.map((L) => ({ ...this.meshVao({ vertices: L.vb, indices: L.ib }, this.instBuf[k], [[5, 4, 48, 0], [6, 4, 48, 16], [7, 4, 48, 32]]), dpos: L.dpos, dnrm: L.dnrm })); });
    this.lodCounts = { deer: [0, 0, 0, 0, 0], wolf: [0, 0, 0, 0, 0], human: [0, 0, 0, 0, 0] };   // rows per band: mesh 0, fade 0/1, mesh 1, fade 1/2, mesh 2
    this.strands = null; this.strandBudget = this.safe ? 0 : STRAND_MAX;   // strand fur's program arrives with the others (prepare)
    this.rings = RINGS.map((r) => ({ ...r, center: null, vao: null, buf: null, heights: null }));
    this.hgtTex = texture(gl, 129, 129, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, filter: gl.NEAREST });
    this.hgtTex2 = texture(gl, 129, 129, { internal: gl.R32F, format: gl.RED, type: gl.FLOAT, filter: gl.NEAREST });
    this.cpuRings = [];
    if (this.hdr) {
      this.probeT = target(gl, 1, 1, { color: [{ internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST }], depth: false });
      this.probeBuf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf); gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    this.resize();
    this.whenReady = this.prepare().then(() => {
      this.ready = true; this.onStatus?.(null); this.mat.load(this.detailSize());
      if (this.gfx === "progressive") this.upgrade().catch(() => {});   // a lost context is reported by onLost
      return this;
    }, (e) => {
      this.failed = e; this.running = false; this.onStatus?.(null);
      if (!(e?.lost && this.onLost)) this.onError?.(e);           // a lost context is reported once, by onLost
      throw e;
    });
    this.whenReady.catch(() => {});                                // the page listens; no unhandled rejection either way
  }
  /* ---------------- setup */
  // every program of the view, the sky's and strand fur's, compiled together and without blocking
  async prepare() {
    const gl = this.gl, specs = { ...PROGRAMS };
    for (const [k, v] of Object.entries(ATMOS_PROGRAMS)) specs["atmos." + k] = v;
    if (!this.safe) specs.strands = [STRAND_VS, STRAND_FS, "strands"];
    const n = Object.keys(specs).length, t0 = performance.now();
    this.onStatus?.(`Preparing the 3D view: compiling ${n} shader programs${this.safe ? " (safe graphics)" : ""}…`);
    const P = await compilePrograms(gl, specs, { defines: this.safe ? "#define PLUME_SAFE 1\n" : "",
      onProgress: (done, total) => this.onStatus?.(`Preparing the 3D view: ${done} of ${total} shader programs compiled${this.safe ? " (safe graphics)" : ""}…`) });
    if (this.lost || gl.isContextLost()) throw new ContextLost("preparing the 3D view");
    this.compileMs = performance.now() - t0;
    const A = {}; this.P = {};
    for (const [k, v] of Object.entries(P)) { if (k.startsWith("atmos.")) A[k.slice(6)] = v; else if (k !== "strands") this.P[k] = v; }
    this.atmos = new Atmosphere(gl, A);
    if (P.strands) this.strands = new Strands(gl, { program: P.strands });
  }
  // safe graphics now, the full shaders behind them: the programs that use the material library (and strand fur)
  // compiled in this context while the view draws, then swapped in. A compile error leaves the view safe; a driver
  // that resets on them loses the context (onLost with upgrading set).
  async upgrade() {
    if (!this.safe || this.upgradingNow || this.lost) return false;
    const gl = this.gl, specs = { strands: [STRAND_VS, STRAND_FS, "strands"] };
    for (const k of DETAIL_PROGRAMS) specs[k] = PROGRAMS[k];
    this.upgradingNow = true; this.onUpgrade?.("compiling");
    try {
      const P = await compilePrograms(gl, specs);
      if (this.disposed) return false;
      if (this.lost || gl.isContextLost()) throw new ContextLost("swapping in the full-detail shaders");
      for (const k of DETAIL_PROGRAMS) { gl.deleteProgram(this.P[k].p); this.P[k] = P[k]; }
      this.strands = new Strands(gl, { program: P.strands }); this.strandBudget = STRAND_MAX;
      this.safe = false; this.gfx = "full"; this.upgradingNow = false; this.mat.load(this.detailSize());
      this.onUpgrade?.("done");
      return true;
    } catch (e) {
      // a lost context: upgradingNow stays set, so the webglcontextlost event (which may come after this, as its
      // own task) is reported with upgrading set, and the page falls back to safe graphics at the first reset
      const lost = !!(e?.lost || this.lost || gl.isContextLost());
      this.upgradingNow = lost;
      if (!lost) this.onUpgrade?.("failed", e);
      throw e;
    }
  }
  // the material library's size for the quality level (none in safe graphics: its shaders are left out)
  detailSize() { return this.safe ? 0 : (this.q.detail ?? 0); }
  meshVao(mesh, instanceBuf, instanceLayout) {
    const gl = this.gl, vb = buffer(gl, mesh.vertices), ib = buffer(gl, mesh.indices, gl.ELEMENT_ARRAY_BUFFER), s = STRIDE * 4;
    const at = [[0, vb, 3, gl.FLOAT, false, s, 0], [1, vb, 3, gl.FLOAT, false, s, 12], [2, vb, 3, gl.FLOAT, false, s, 24], [3, vb, 2, gl.FLOAT, false, s, 36], [4, vb, 2, gl.FLOAT, false, s, 44]];
    for (const a of instanceLayout) at.push([a[0], instanceBuf, a[1], gl.FLOAT, false, a[2], a[3], 1]);
    return { vao: vao(gl, at, ib), count: mesh.indices.length, type: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }
  staticGeometry() {
    const gl = this.gl;
    // terrain ring index buffer (129 x 129 vertices)
    const n = 129, idx = new Uint16Array(128 * 128 * 6); let o = 0;
    for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx.set([a, c, b, b, c, d], o); o += 6; }
    this.ringIndex = buffer(gl, idx, gl.ELEMENT_ARRAY_BUFFER); this.ringCount = idx.length;
    // water: a 64 x 64 grid over +-1024 m (the surface is flat; the waves are in the shader)
    const wv = [], wi = []; const wn = 65;
    for (let j = 0; j < wn; j++) for (let i = 0; i < wn; i++) wv.push(-1024 + i * 32, -1024 + j * 32);
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) { const a = j * wn + i; wi.push(a, a + wn, a + 1, a + 1, a + wn, a + wn + 1); }
    this.waterVao = vao(gl, [[0, buffer(gl, new Float32Array(wv)), 2]], buffer(gl, new Uint16Array(wi), gl.ELEMENT_ARRAY_BUFFER)); this.waterCount = wi.length;
    // skeletons and meshes
    this.skel = { deer: quadrupedSkeleton(QUADRUPEDS.deer), wolf: quadrupedSkeleton(QUADRUPEDS.wolf), human: humanSkeleton() };
    this.instBuf = { deer: gl.createBuffer(), wolf: null, human: null };
    const skinLayout = [[5, 4, 48, 0], [6, 4, 48, 16], [7, 4, 48, 32]];   // row and tint, then eight numbers of coat and face
    this.deerMesh = this.meshVao(quadrupedMesh("deer"), this.instBuf.deer, skinLayout);
    const bt = birdTemplate(); this.birds = new Birds(); this.birdGL = { inst: gl.createBuffer(), n: 0, count: bt.indices.length };
    this.birdGL.vao = vao(gl, [[0, buffer(gl, bt.vertices), 3], [5, this.birdGL.inst, 4, gl.FLOAT, false, 48, 0, 1], [6, this.birdGL.inst, 4, gl.FLOAT, false, 48, 16, 1], [7, this.birdGL.inst, 4, gl.FLOAT, false, 48, 32, 1]], buffer(gl, bt.indices, gl.ELEMENT_ARRAY_BUFFER));
    const at = woodTemplate(12, 6, 6); this.antlers = { inst: gl.createBuffer(), n: 0, count: at.indices.length };
    this.antlers.vao = vao(gl, [[0, buffer(gl, at.vertices), 3], [5, this.antlers.inst, 4, gl.FLOAT, false, 32, 0, 1], [6, this.antlers.inst, 4, gl.FLOAT, false, 32, 16, 1]], buffer(gl, at.indices, gl.ELEMENT_ARRAY_BUFFER));
    this.instBuf.wolf = gl.createBuffer(); this.wolfMesh = this.meshVao(quadrupedMesh("wolf"), this.instBuf.wolf, skinLayout);
    this.instBuf.human = gl.createBuffer(); this.humanMesh = this.meshVao(humanMesh(), this.instBuf.human, skinLayout);
    // flora and boulders: topology templates only; the shaders compute every plant and stone from its seed
    const inst = (b) => [[5, b, 4, gl.FLOAT, false, 32, 0, 1], [6, b, 4, gl.FLOAT, false, 32, 16, 1]];
    this.flora = KINDS.map((K) => {
      const b = gl.createBuffer(), w = woodTemplate(K.branches, K.rings, K.sides), c = cardTemplate(K.cards);
      return { K, inst: b, n: 0, wood: { vao: vao(gl, [[0, buffer(gl, w.vertices), 3], ...inst(b)], buffer(gl, w.indices, gl.ELEMENT_ARRAY_BUFFER)), count: w.indices.length },
        leaves: { vao: vao(gl, [[0, buffer(gl, c.vertices), 3], ...inst(b)], buffer(gl, c.indices, gl.ELEMENT_ARRAY_BUFFER)), count: c.indices.length } };
    });
    const sph = sphereTemplate(); this.rocks = { inst: gl.createBuffer(), n: 0 };
    this.rocks.vao = vao(gl, [[0, buffer(gl, sph.vertices), 3], ...inst(this.rocks.inst)], buffer(gl, sph.indices, gl.ELEMENT_ARRAY_BUFFER)); this.rocks.count = sph.indices.length;
    this.blobBuf = gl.createBuffer(); this.blobVao = vao(gl, [[0, this.blobBuf, 3, gl.FLOAT, false, 28, 0], [1, this.blobBuf, 4, gl.FLOAT, false, 28, 12]]); this.blobCount = 0;
    this.markBuf = gl.createBuffer(); this.markVao = vao(gl, [[0, this.markBuf, 3, gl.FLOAT, false, 28, 0], [1, this.markBuf, 4, gl.FLOAT, false, 28, 12]]); this.markCount = 0;
  }
  inputs() {
    const c = this.canvas; let drag = null, moved = 0;
    c.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; moved = 0; c.setPointerCapture?.(e.pointerId); });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return; const dx = e.clientX - drag[0], dy = e.clientY - drag[1]; drag = [e.clientX, e.clientY]; moved += Math.abs(dx) + Math.abs(dy);
      this.cam.orbitYaw -= dx * 0.006; this.cam.pitch = Math.max(-0.05, Math.min(1.3, this.cam.pitch + dy * 0.005));
    });
    c.addEventListener("pointerup", (e) => {
      if (drag && moved < 6) { if (this.macro) this.probeAt(e.offsetX, e.offsetY, (r) => this.focusOn(r)); else this.pick(e.offsetX, e.offsetY); }
      drag = null;
    });
    c.addEventListener("wheel", (e) => { e.preventDefault(); if (e.shiftKey || e.altKey) this.setZoom(this.zoomZ - e.deltaY * 0.0006); else this.zoom(Math.exp(e.deltaY * 0.001)); }, { passive: false });
    this.onKey = (e) => { if (e.target?.tagName === "INPUT" || e.target?.tagName === "SELECT") return; if (e.key === "]") this.setZoom(this.zoomZ + 0.04); if (e.key === "[") this.setZoom(this.zoomZ - 0.04); };
    window.addEventListener("keydown", this.onKey);
  }
  // the lens: z in [0, 1] from 14 mm to 2300 mm (full-frame equivalent), geometric
  setZoom(z) { this.zoomZ = Math.max(0, Math.min(1, z)); this.fov = fovAt(this.zoomZ); }
  // zoom by a factor: below MACRO_AT the camera focuses on the surface under the screen's centre and closes on it,
  // down to half a millimetre (needs the G-buffer's probe; without it the camera stops at 2.2 m)
  zoom(k) {
    const c = this.cam, d = c.dist * k;
    if (!this.probeT) { c.dist = Math.max(2.2, Math.min(60, d)); return; }
    if (!this.macro && d < MACRO_AT) {
      if (this.focusing) return;
      this.focusing = true;
      this.probeAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, (r) => { this.focusing = false; if (r) { this.focusOn(r); this.cam.dist = Math.max(MACRO_MIN, Math.min(MACRO_AT, r.dist * k)); } else c.dist = Math.max(2.2, d); });
      return;
    }
    if (this.macro && d > MACRO_AT * 1.25) { this.macro = null; c.dist = Math.min(60, Math.max(2.2, d)); this.snap = true; return; }
    c.dist = Math.max(this.macro ? MACRO_MIN : 2.2, Math.min(60, d));
  }
  // focus the macro camera on a probed point: animals by their bone (it moves with them), anything else where it is
  focusOn(r) {
    if (!r) return;
    const c = this.cam, P = r.point, kind = r.kind;
    const pv = { kind, abs: [((P[0] % WORLD) + WORLD) % WORLD, P[1], ((P[2] % WORLD) + WORLD) % WORLD] };
    const k = kind === 5 ? "deer" : kind === 6 ? "wolf" : kind === 7 ? "human" : kind === 8 ? "deer" : null;
    const sn = r.snap;
    if (k && sn?.rowIds?.[k] && r.row < sn.rowIds[k].length) {
      const id = sn.rowIds[k][r.row], bone = kind === 8 ? 3 : r.bone, o = r.row * ROWF + bone * 16;
      const M = sn.bones[k].subarray(o, o + 16), inv = M4.invert(M), rel = [P[0] - sn.ro[0], P[1] - sn.ro[1], P[2] - sn.ro[2]];
      Object.assign(pv, { animal: k, id, bone, local: M4.apply(inv, rel) });
    }
    this.macro = pv; c.dist = Math.max(MACRO_MIN, Math.min(MACRO_AT, r.dist)); this.followId = pv.animal === "deer" ? pv.id : this.followId;
    const dx = this.eye[0] - P[0], dy = this.eye[1] - P[1], dz = this.eye[2] - P[2], h = Math.hypot(dx, dz);
    c.orbitYaw = Math.atan2(dz, dx) - c.yaw; c.pitch = Math.atan2(dy, Math.max(h, 1e-9));
  }
  // macro on a fixed point (x, y, z in metres) or an animal's bone; dist from it in metres
  macroAt(x, y, z, dist = 0.05, pitch = 0.5, yaw = 0) { this.macro = { kind: 1, abs: [x, y, z] }; this.cam.mode = "inspect"; this.inspectAt = [x, z]; this.cam.dist = dist; this.cam.pitch = pitch; this.cam.yaw = yaw; this.cam.orbitYaw = 0; this.snap = true; }
  // read what lies under a pixel (CSS px) after the next frame: { dist, kind, row, bone, point }
  probeAt(x, y, cb) { if (!this.probeT) { cb(null); return; } this.probeWant = { x: x * this.W / this.canvas.clientWidth, y: this.H - 1 - y * this.H / this.canvas.clientHeight, cb }; }
  // "auto" starts at high and steps down while quiet frames (no epoch being computed) run slower than ~22 fps
  setQuality(q) { if (q === "auto") { this.autoQuality = true; this.samples = []; return; } if (!QUALITY[q]) return; this.autoQuality = false; this.useQuality(q); }
  useQuality(q) { this.q = QUALITY[q]; this.qualityName = q; this.resize(true); if (this.ready) this.mat.load(this.detailSize()); }
  // "auto": the governor holds 60 fps (16.7 ms) by render scale, then quality level; GPU time when the timer extension is there
  govern(ms, quiet) {
    if (!this.autoQuality || !quiet) return;
    const step = this.perf.govern(ms, this.qualityName); if (!step) return;
    if (step.level) this.useQuality(step.level);
    if (step.scale) { this.scaleMul = step.scale; this.resize(true); }
    this.onQuality?.(this.qualityName, this.perf.gpuTotal || ms, this.scaleMul);
  }
  // a line of frame timing over the view (per-pass GPU milliseconds against the 16.7 ms budget)
  hudText() { return this.perf.text(` · ${this.W}x${this.H} ${this.qualityName}${this.safe ? " · safe graphics" : ""}${this.scaleMul < 1 ? " x" + this.scaleMul : ""} · target ${TARGET_MS.toFixed(1)} ms`); }
  resize(force = false) {
    if (this.lost) return;
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(64, Math.round(this.canvas.clientWidth * dpr * this.q.scale * this.scaleMul)), h = Math.max(64, Math.round(this.canvas.clientHeight * dpr * this.q.scale * this.scaleMul));
    if (!force && this.W === w && this.H === h) return;
    this.W = w; this.H = h; this.canvas.width = w; this.canvas.height = h;
    [this.sceneT, this.waterT, this.brightT, this.blurT].forEach((t) => freeTarget(gl, t));
    const col = this.half ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const nrm = this.half ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST };
    this.sceneT = target(gl, w, h, { color: [col, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }, nrm, { internal: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT, filter: gl.NEAREST }], depthTexture: true });
    this.waterT = target(gl, w, h, { color: [col], depth: false });
    const bw = Math.max(16, w >> 2), bh = Math.max(16, h >> 2);
    this.brightT = target(gl, bw, bh, { color: [col], depth: false }); this.blurT = target(gl, bw, bh, { color: [col], depth: false });
    if (this.shadowT) freeTarget(gl, this.shadowT); this.shadowT = null;
    const sh = Math.min(this.q.shadow, this.maxTex >> 1);               // two cascades side by side: twice as wide as tall
    if (sh) this.shadowT = target(gl, sh * 2, sh, { color: [{ internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE }], depthTexture: true });
  }
  /* ---------------- the world */
  attach(valley, map) { this.valley = valley; this.map = map; this.mapVersion = -1; this.space = null; this.spaceEpoch = -1; this.waterLevel = map.waterLevelMm / 1000 + 0.15; this.rings.forEach((r) => { r.center = null; }); this.anim.clear(); this.epochChanged(); }
  // a new epoch's state is in the valley: refresh meadow textures and plant instances; animals now
  // interpolate from their previous to their new cells over the next period
  epochChanged(periodMs = this.periodMs) {
    const v = this.valley; if (!v) return;
    this.epochT0 = performance.now(); this.periodMs = periodMs;
    const gl = this.gl, F = v.frame, veg = new Uint32Array(128 * 128 * 4), sward = new Uint8Array(128 * 128 * 4), wear = new Uint8Array(128 * 128 * 4);
    const e = v.epoch, seed = v.cfg.seed;
    for (let c = 0; c < 16384; c++) {
      let alive = 0, cropped = 0, r = 0, g = 0, b = 0, n = 0, ages = 0, stamp = 0x2545f491;
      for (let s = 0; s < 8; s++) {
        const k = c * 8 + s;
        if (F[k] & 1) { alive |= 1 << s; const col = SPECIES[s].color; r += col[0]; g += col[1]; b += col[2]; n++; ages |= Math.min(15, e - v.born[k]) << (4 * s); stamp = hash(stamp, s, v.born[k], seed); }
        else if (v.regrow[k] && e - v.regrow[k] < 6) cropped |= 1 << s;
      }
      veg[c * 4] = alive; veg[c * 4 + 1] = cropped; veg[c * 4 + 2] = ages >>> 0; veg[c * 4 + 3] = stamp >>> 0;
      // trampling (log of the E3 trail field), grazing lately, and the shrub canopy for the far ground
      const t = v.trail[c]; wear[c * 4] = t ? Math.min(255, Math.floor(Math.log2(1 + t / 48) * 40)) : 0;
      wear[c * 4 + 1] = v.scar[c] && e - v.scar[c] < 6 ? Math.floor(255 * (1 - (e - v.scar[c]) / 6)) : 0;
      wear[c * 4 + 2] = F[c * 8 + 7] & 1 ? 255 : F[c * 8 + 6] & 1 ? 170 : 0;
      // the sward colour: species colours pulled towards plant green
      const gr = [62, 92, 44];
      sward[c * 4] = n ? Math.round((r / n) * 0.25 + gr[0] * 0.75) : 0; sward[c * 4 + 1] = n ? Math.round((g / n) * 0.25 + gr[1] * 0.75) : 0; sward[c * 4 + 2] = n ? Math.round((b / n) * 0.25 + gr[2] * 0.75) : 0;
      sward[c * 4 + 3] = Math.min(255, n * 48);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.vegTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RGBA_INTEGER, gl.UNSIGNED_INT, veg);
    gl.bindTexture(gl.TEXTURE_2D, this.swardTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, sward);
    gl.bindTexture(gl.TEXTURE_2D, this.wearTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, wear);
    this.plantsDirty = true;
  }
  follow(id) { if (id !== this.followId) this.snap = true; this.followId = id; this.cam.mode = id ? "follow" : "overview"; }
  // look at a place: the camera orbits a fixed point (x, z in metres) at a distance and pitch
  inspect(x, z, dist = 14, pitch = 0.3, yaw = 0, height = 1.2) { this.followId = null; this.cam.mode = "inspect"; this.inspectAt = [x, z]; this.inspectH = height; this.cam.dist = dist; this.cam.pitch = pitch; this.cam.yaw = yaw; this.cam.orbitYaw = 0; this.snap = true; }
  setTimeOfDay(t) { this.timeOfDay = t; }
  /* ---------------- terrain rings */
  buildRing(r, cx, cz) {
    const m = this.map, l = r.level, sp = spacing(l), n = 129, half = 64;
    const ix0 = Math.round(cx / sp) - half, iz0 = Math.round(cz / sp) - half;
    r.center = [(ix0 + half) * sp, (iz0 + half) * sp];
    const H = new Float32Array((n + 2) * (n + 2));
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) H[(j + 1) * (n + 2) + (i + 1)] = m.sample(0, l, ix0 + i, iz0 + j) / 1000;
    const data = new Float32Array(n * n * 10), at = (i, j) => H[(j + 1) * (n + 2) + (i + 1)];
    const ox = r.center[0], oz = r.center[1];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 10, h = at(i, j);
      const nx = (at(i - 1, j) - at(i + 1, j)) / (2 * sp), nz = (at(i, j - 1) - at(i, j + 1)) / (2 * sp), nl = Math.hypot(nx, 1, nz);
      data[k] = (ix0 + i) * sp - ox; data[k + 1] = h; data[k + 2] = (iz0 + j) * sp - oz;
      data[k + 3] = nx / nl; data[k + 4] = 1 / nl; data[k + 5] = nz / nl;
      data[k + 6] = m.sample(1, l, ix0 + i, iz0 + j) / 255; data[k + 7] = m.sample(2, l, ix0 + i, iz0 + j) / 255; data[k + 8] = m.sample(3, l, ix0 + i, iz0 + j) / 7; data[k + 9] = m.sample(4, l, ix0 + i, iz0 + j) / 255;
    }
    const gl = this.gl;
    if (!r.buf) { r.buf = gl.createBuffer(); r.vao = vao(gl, [[0, r.buf, 3, gl.FLOAT, false, 40, 0], [1, r.buf, 3, gl.FLOAT, false, 40, 12], [2, r.buf, 4, gl.FLOAT, false, 40, 24]], this.ringIndex); }
    gl.bindBuffer(gl.ARRAY_BUFFER, r.buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const ri = this.rings.indexOf(r);
    if (ri <= 2) { // the three inner rings' heights: fast ground lookups on the CPU; rings 1 and 2 also place the grass
      const hg = new Float32Array(n * n); for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) hg[j * n + i] = at(i, j);
      this.cpuRings[ri] = { rect: [ix0 * sp, iz0 * sp, sp, n], h: hg };
      if (ri === 1) { gl.bindTexture(gl.TEXTURE_2D, this.hgtTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, gl.FLOAT, hg); this.hgtRect = [ix0 * sp, iz0 * sp, sp, n]; }
      if (ri === 2) { gl.bindTexture(gl.TEXTURE_2D, this.hgtTex2); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, gl.FLOAT, hg); this.hgtRect2 = [ix0 * sp, iz0 * sp, sp, n]; }
    }
  }
  updateRings(tx, tz) {
    if (this.mapVersion !== this.map.version) { this.mapVersion = this.map.version; this.rings.forEach((r) => { r.center = null; }); this.plantsDirty = true; }
    for (const r of this.rings) {
      const sp = spacing(r.level), step = sp * 8;
      if (!r.center || Math.abs(wrapD(tx - r.center[0])) > step || Math.abs(wrapD(tz - r.center[1])) > step) {
        // keep the ring centre near the camera on the torus
        const cx = r.center ? r.center[0] + wrapD(tx - r.center[0]) : tx, cz = r.center ? r.center[1] + wrapD(tz - r.center[1]) : tz;
        this.buildRing(r, cx, cz);
      }
    }
  }
  groundAt(x, z) {
    for (const cr of this.cpuRings) {
      if (!cr) continue; const r = cr.rect;
      const fx = wrapD(x - r[0]) / r[2], fz = wrapD(z - r[1]) / r[2];
      if (fx >= 0 && fz >= 0 && fx < r[3] - 1 && fz < r[3] - 1) {
        const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, n = r[3], h = cr.h;
        return (h[j * n + i] * (1 - tx) + h[j * n + i + 1] * tx) * (1 - tz) + (h[(j + 1) * n + i] * (1 - tx) + h[(j + 1) * n + i + 1] * tx) * tz;
      }
    }
    return this.map.heightAt(((x % WORLD) + WORLD) % WORLD, ((z % WORLD) + WORLD) % WORLD, 1);
  }
  /* ---------------- flora and boulders from the valley's state (each one from its own seed) */
  buildPlants(cx, cz) {
    const gl = this.gl, g = (x, z) => this.groundAt(x, z);
    const lists = floraInstances(this.valley, this.map, cx, cz, this.q.plantsR, this.origin, g);
    this.flora.forEach((f, k) => { gl.bindBuffer(gl.ARRAY_BUFFER, f.inst); gl.bufferData(gl.ARRAY_BUFFER, lists[k], gl.DYNAMIC_DRAW); f.n = lists[k].length / 8; });
    const rocks = rockInstances(this.valley, this.map, cx, cz, this.q.rocksR, this.origin, g);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rocks.inst); gl.bufferData(gl.ARRAY_BUFFER, rocks, gl.DYNAMIC_DRAW); this.rocks.n = rocks.length / 8;
    this.plantsAt = [cx, cz]; this.plantsOrigin = [...this.origin]; this.plantsDirty = false;
  }
  /* ---------------- animals: positions, gaits, IK */
  frac() { return Math.max(0, Math.min(1, (performance.now() - this.epochT0) / this.periodMs)); }
  // render position of a table row: eased motion from its previous cell to its current cell (cell centres + a stable offset)
  rowPos(T, i, f, jitterSeed) {
    const off = (q) => { let x = Math.imul(T.id[i] * 131 + q + jitterSeed, 0x9e3779b1); x ^= x >>> 15; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; return ((x >>> 0) / 4294967296 - 0.5) * CELL_M * 0.7; };
    const ex = f * f * (3 - 2 * f);
    const x0 = (T.px[i] + 0.5) * CELL_M + off(1), z0 = (T.py[i] + 0.5) * CELL_M + off(2);
    const x1 = (T.x[i] + 0.5) * CELL_M + off(1), z1 = (T.y[i] + 0.5) * CELL_M + off(2);
    return [x0 + wrapD(x1 - x0) * ex, z0 + wrapD(z1 - z0) * ex, Math.hypot(wrapD(x1 - x0), wrapD(z1 - z0))];
  }
  gait(speed) {
    if (speed < 0.15) return { name: "idle", f: 0, duty: 1, off: [0, 0, 0, 0], lift: 0 };
    if (speed < 2.4) return { name: "walk", f: 0.85 + 0.38 * speed, duty: 0.64, off: [0.25, 0.75, 0.0, 0.5], lift: 0.11 };
    if (speed < 5.0) return { name: "trot", f: 1.5 + 0.13 * speed, duty: 0.46, off: [0.5, 0.0, 0.0, 0.5], lift: 0.17 };
    return { name: "gallop", f: 2.25, duty: 0.33, off: [0.0, 0.12, 0.52, 0.62], lift: 0.28 };
  }
  // world skin matrices for a quadruped written into out at offset. Each animal has its own shape: a shape
  // matrix per bone takes the template's rest space to this animal's rest space (torso length and girth,
  // neck, muzzle, ears, tail; the legs stretch through the IK), rotations act about the shaped joints, and
  // the skin matrix is world x pose x shape. The countenance turns the ears and opens or closes the eyes.
  poseQuadruped(kind, st, out, o, scale) {
    const S = st.skel ?? this.skel[kind], P = st.P ?? QUADRUPEDS[kind], g = st.gait, t = st.phase, m = st.P ? UNIT : (st.morph ?? UNIT);
    const R = this.ro, X = st.x - R[0], Z = st.z - R[2], G = (x, z) => this.groundAt(x + R[0], z + R[2]) - R[1];   // relative to the render origin
    const fwd = [Math.cos(st.heading), 0, Math.sin(st.heading)];
    // body: height from the ground under the hips and the shoulders, raised by longer legs; pitch follows the slope
    const hx = X - fwd[0] * 0.42 * scale * m.body, hz = Z - fwd[2] * 0.42 * scale * m.body, sx = X + fwd[0] * 0.38 * scale * m.body, sz = Z + fwd[2] * 0.38 * scale * m.body;
    const gh = G(hx, hz), gs = G(sx, sz), pitch = Math.atan2(gs - gh, 0.8 * scale * m.body);
    const bob = g.f ? Math.sin(t * Math.PI * 4) * (g.name === "gallop" ? 0.06 : 0.018) * scale : Math.sin(performance.now() / 1300 + st.seed) * 0.004;
    const gallopPitch = g.name === "gallop" ? Math.sin(t * Math.PI * 2) * 0.12 : 0;
    const base = [X, (gh + gs) / 2 - (g.name === "gallop" ? 0.05 : 0) * scale + bob + (m.legs - 1) * P.hip[1] * scale, Z];
    const qBody = QT.mul(QT.axis([0, 1, 0], -st.heading), QT.axis([0, 0, 1], pitch + gallopPitch));
    const W = M4.mul(M4.fromQT(qBody, base), scaleM(scale));
    // shapes
    const J = (b) => S[b].head, Sh = new Array(S.length).fill(null);
    const c = [(P.root[0] + P.chest[0]) / 2, (P.root[1] + P.chest[1]) / 2, 0];
    Sh[0] = Sh[1] = aboutM(c, diagM(m.body, m.girth, m.girth));
    const pn = M4.apply(Sh[1], J(2)); Sh[2] = M4.mul(translM(pn), M4.mul(stretchM(V3.norm(V3.sub(J(3), J(2))), m.neck, m.neckGirth), translM(V3.scale(J(2), -1))));
    const ph = M4.apply(Sh[2], J(3)); Sh[3] = M4.mul(translM(ph), M4.mul(diagM(m.muzzle, 1, 1), translM(V3.scale(J(3), -1))));
    const pt = M4.apply(Sh[0], J(4)); Sh[4] = M4.mul(translM(pt), M4.mul(scaleM(m.tail), translM(V3.scale(J(4), -1))));
    for (const b of [17, 18]) { const pe = M4.apply(Sh[3], J(b)); Sh[b] = M4.mul(translM(pe), M4.mul(scaleM(m.ears), translM(V3.scale(J(b), -1)))); }
    for (const b of [19, 20]) { const pe = M4.apply(Sh[3], J(b)); Sh[b] = M4.mul(translM(pe), M4.mul(diagM(1, st.eyeOpen ?? 1, 1), translM(V3.scale(J(b), -1)))); }
    // FK about the shaped joints
    const Mb = new Array(S.length);
    const rot = (b, q) => { const pj = M4.apply(Sh[b] ?? M4.ident(), J(b)), L = M4.mul(translM(pj), M4.mul(M4.fromQT(q, [0, 0, 0]), translM(V3.scale(pj, -1)))); return S[b].parent < 0 ? L : M4.mul(Mb[S[b].parent], L); };
    const spineFlex = g.name === "gallop" ? Math.sin(t * Math.PI * 2 + 1.2) * 0.12 : 0;
    Mb[0] = rot(0, [0, 0, 0, 1]); Mb[1] = rot(1, QT.axis([0, 0, 1], spineFlex));
    const neckPitch = st.headPitch, headPitch = st.headPitch * 0.55;
    Mb[2] = rot(2, QT.mul(QT.axis([0, 1, 0], st.headYaw * 0.6), QT.axis([0, 0, 1], neckPitch)));
    Mb[3] = rot(3, QT.mul(QT.axis([0, 1, 0], st.headYaw * 0.4), QT.axis([0, 0, 1], headPitch + (st.chew ? Math.sin(performance.now() / 160) * 0.05 : 0))));
    Mb[4] = rot(4, QT.axis([0, 0, 1], st.P ? -st.tail * (kind === "deer" ? 1.65 : 0.9) : st.tail));   // the forms' tails hang down at rest
    const ef = st.earFwd ?? 0, ed = st.earDroop ?? 0.3, aim = st.earAim ?? 0;
    for (const [b, side] of [[17, 1], [18, -1]]) Mb[b] = rot(b, QT.mul(QT.axis([0, 1, 0], side * (0.35 - 0.55 * ef) + aim * 0.6), QT.mul(QT.axis([1, 0, 0], -side * ed), QT.axis([0, 0, 1], -0.35 * ef))));
    Mb[19] = rot(19, [0, 0, 0, 1]); Mb[20] = rot(20, [0, 0, 0, 1]);
    for (const b of [0, 1, 2, 3, 4, 17, 18, 19, 20]) { const K = M4.mul(W, M4.mul(Mb[b], Sh[b])); for (let k = 0; k < 16; k++) out[o + b * 16 + k] = K[k]; }
    // legs: foot targets from the gait, IK onto the ground; bones stretch to this animal's leg length
    const legs = [[5, true, 1], [8, true, -1], [11, false, 1], [14, false, -1]];
    legs.forEach(([b, front, side], li) => {
      const pb = front ? 1 : 0, parentM = M4.mul(W, M4.mul(Mb[pb], Sh[pb]));
      const j0 = M4.apply(parentM, S[b].head), j1r = S[b + 1].head, j2r = S[b + 2].head, j3r = S[b + 2].tail, ls = scale * m.legs;
      const L1 = dist3(S[b].head, j1r) * ls, L2 = dist3(j1r, j2r) * ls, L3 = dist3(j2r, j3r) * ls;
      let along = 0, lift = 0;
      if (g.f) {
        const stride = st.speed / g.f, ph2 = (t + g.off[li]) % 1;
        if (ph2 < g.duty) along = stride * (0.5 - ph2 / g.duty);
        else { const s2 = (ph2 - g.duty) / (1 - g.duty); along = stride * (-0.5 + s2); lift = Math.sin(s2 * Math.PI) * g.lift * scale; }
      }
      const restFoot = M4.apply(parentM, [j3r[0], 0, j3r[2]]);
      const fx = restFoot[0] + fwd[0] * along, fz = restFoot[2] + fwd[2] * along, fy = G(fx, fz) + lift;
      const ankle = [fx + fwd[0] * 0.02 * scale, fy + L3, fz + fwd[2] * 0.02 * scale];
      const pole = front ? [-fwd[0], -0.2, -fwd[2]] : [fwd[0], -0.2, fwd[2]];
      const knee = ik2(j0, ankle, L1, L2, pole);
      this.writeBone(out, o, b, S[b].head, j0, j1r, knee, scale, m.girth);
      this.writeBone(out, o, b + 1, j1r, knee, j2r, ankle, scale);
      this.writeBone(out, o, b + 2, j2r, ankle, j3r, [fx, fy, fz], scale);
    });
  }
  // skin matrix taking the rest bone (headRest -> tailRest) to the posed bone (head -> tail), stretched along
  // the bone to its posed length and scaled across it by girth
  writeBone(out, o, b, headRest, head, tailRest, tail, scale, girth = 1) {
    const rv = V3.sub(tailRest, headRest), nv = V3.sub(tail, head), rd = V3.norm(rv), nd = V3.norm(nv), q = QT.between(rd, nd);
    const k = Math.hypot(...nv) / Math.max(1e-6, Math.hypot(...rv) * scale);
    const m = M4.mul(M4.fromQT(q, head), M4.mul(scaleM(scale), M4.mul(stretchM(rd, k, girth), translM([-headRest[0], -headRest[1], -headRest[2]]))));
    for (let i = 0; i < 16; i++) out[o + b * 16 + i] = m[i];
  }
  poseHuman(st, out, o) {
    const S = st.skel ?? this.skel.human, t = st.phase, walk = st.speed > 0.15 ? Math.min(1, st.speed / 1.4) : 0, m = st.P ? { height: 1, girth: 1, hatBrim: 1, hatCrown: 1 } : (st.morph ?? { height: 1, girth: 1, hatBrim: 1, hatCrown: 1 });
    const R = this.ro, X0 = st.x - R[0], Z0 = st.z - R[2];
    const gy = this.groundAt(st.x, st.z) - R[1] + Math.abs(Math.sin(t * Math.PI * 2)) * 0.03 * walk;
    const W = M4.mul(M4.fromQT(QT.axis([0, 1, 0], -st.heading), [X0, gy, Z0]), scaleM(m.height));
    const J = (b) => S[b].head, Sh = new Array(S.length).fill(null);
    Sh[0] = Sh[1] = diagM(m.girth, 1, m.girth);                                        // build: around the body's axis
    Sh[13] = M4.mul(translM(J(13)), M4.mul(diagM(m.hatBrim, m.hatCrown, m.hatBrim), translM(V3.scale(J(13), -1))));
    const Mb = new Array(S.length);
    const rot = (b, q) => { const pj = M4.apply(Sh[b] ?? M4.ident(), J(b)), L = M4.mul(translM(pj), M4.mul(M4.fromQT(q, [0, 0, 0]), translM(V3.scale(pj, -1)))); return S[b].parent < 0 ? L : M4.mul(Mb[S[b].parent], L); };
    const sw = Math.sin(t * Math.PI * 2) * 0.55 * walk, kn = Math.max(0, Math.sin(t * Math.PI * 2 + 1.2)) * 0.9 * walk, kn2 = Math.max(0, Math.sin(t * Math.PI * 2 + 1.2 + Math.PI)) * 0.9 * walk;
    const Z = (a) => QT.axis([0, 0, 1], a);
    Mb[0] = rot(0, QT.axis([0, 1, 0], sw * 0.15)); Mb[1] = rot(1, QT.axis([0, 1, 0], -sw * 0.25)); Mb[2] = rot(2, QT.mul(QT.axis([0, 1, 0], st.headYaw), Z(st.headPitch * 0.3)));
    Mb[3] = rot(3, Z(-sw * 0.7)); Mb[4] = rot(4, Z(0.25 + Math.max(0, -sw) * 0.4)); Mb[5] = rot(5, Z(sw * 0.7)); Mb[6] = rot(6, Z(0.25 + Math.max(0, sw) * 0.4));
    Mb[7] = rot(7, Z(sw)); Mb[8] = rot(8, Z(-kn)); Mb[9] = rot(9, Z(kn * 0.3)); Mb[10] = rot(10, Z(-sw)); Mb[11] = rot(11, Z(-kn2)); Mb[12] = rot(12, Z(kn2 * 0.3)); Mb[13] = rot(13, [0, 0, 0, 1]);
    for (let b = 0; b < S.length; b++) { const K = M4.mul(W, M4.mul(Mb[b], Sh[b] ?? M4.ident())); for (let k = 0; k < 16; k++) out[o + b * 16 + k] = K[k]; }
  }
  // animation state of one animal, advanced by dt
  stateOf(kind, T, i, f, dt) {
    const id = kind + T.id[i]; let st = this.anim.get(id);
    const [x, z, moveDist] = this.rowPos(T, i, f, kind === "wolf" ? 7 : kind === "human" ? 13 : 0);
    if (!st) { st = { id: T.id[i], x, z, heading: (T.dir[i] * Math.PI) / 4 * -1 + Math.PI * 0, phase: Math.random(), speed: 0, headPitch: 0, headYaw: 0, tail: 0, seed: Math.random() * 100, chew: false, seen: 0, blob: kind === "deer" ? 0.8 : kind === "wolf" ? 0.62 : 0.42,
      earFwd: 0, earDroop: 0.3, earAim: 0, eyeOpen: 0.9, arousal: 0 }; this.anim.set(id, st); }
    attend(this.valley, kind, i, st); const now = performance.now(); countenance(st, kind, dt, now);
    const vx = wrapD(x - st.x), vz = wrapD(z - st.z), sp = Math.hypot(vx, vz) / Math.max(dt, 1e-3);
    st.speed += (Math.min(sp, 12) - st.speed) * Math.min(1, dt * 6);
    if (sp > 0.2) st.heading += angDiff(st.heading, Math.atan2(vz, vx)) * Math.min(1, dt * 5);
    st.x = x; st.z = z; st.seen = this.frameNo;
    st.gait = this.gait(st.speed); st.phase = (st.phase + dt * st.gait.f) % 1;
    const act = T.act[i];
    // head, tail and ears by behaviour: grazing, alert, fleeing, resting
    let hp = -0.08, tail = 0.15; st.chew = false;
    if (kind !== "human") {
      if ((act === 2 || act === 4 || act === 6) && st.speed < 1.2) { hp = -1.05 + Math.sin(performance.now() / 2700 + st.seed) * 0.12; st.chew = true; }
      if (act === 3) { hp = 0.32; tail = 1.35; }
      if (act === 5 || act === 10) { hp = 0.25; tail = 0.9; }
      if (act === 7) hp = -0.25;
      if (kind === "wolf") { tail = act === 13 ? 0.6 : -0.35; if (act === 12 || act === 16) hp = -0.15; }
      tail += Math.sin(performance.now() / 300 + st.seed * 3) * (kind === "deer" ? 0.15 : 0.08);
    }
    // E4: head and ears turn to what it attends; E13: it scans more when what it sees is uncertain; E6: trust carries the head
    let yawT = Math.sin(now / 2300 + st.seed) * (0.12 + 0.45 * (st.scan ?? 0));
    if (st.target && !st.chew) { yawT = Math.max(-1.1, Math.min(1.1, angDiff(st.heading, Math.atan2(wrapD(st.target.z - st.z), wrapD(st.target.x - st.x))))); }
    if (st.target?.threat || st.alert) hp = Math.max(hp, 0.28);
    if (kind === "deer" && !st.chew) hp += ((st.trust ?? 0.5) - 0.5) * 0.14;
    st.headPitch += (hp - st.headPitch) * Math.min(1, dt * 3); st.tail += (tail - st.tail) * Math.min(1, dt * 5);
    st.headYaw += (yawT - st.headYaw) * Math.min(1, dt * 2.5); st.earAim += (Math.max(-0.6, Math.min(0.6, yawT - st.headYaw * 0.9)) - st.earAim) * Math.min(1, dt * 6);
    if (this.debugPose) Object.assign(st, this.debugPose);   // tests: hold a pose (head up, still) for a portrait
    return st;
  }
  /* ---------------- picking */
  pick(px, py) {
    if (!this.lastVP || !this.valley) return;
    const D = this.valley.deer, f = this.frac(), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    let best = -1, bd = 40 * 40;
    for (let i = 0; i < D.n; i++) {
      const [x, z] = this.rowPos(D, i, f, 0), wx = this.origin[0] + wrapD(x - this.origin[0]), wz = this.origin[2] + wrapD(z - this.origin[2]);
      const p = M4.apply(this.lastVP, [wx, this.groundAt(x, z) + 0.9, wz]), cw = this.lastVP[3] * wx + this.lastVP[7] * (this.groundAt(x, z) + 0.9) + this.lastVP[11] * wz + this.lastVP[15];
      if (cw <= 0.1) continue;
      const sx = (p[0] / cw * 0.5 + 0.5) * w, sy = (1 - (p[1] / cw * 0.5 + 0.5)) * h, d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { this.follow(D.id[best]); this.onPick?.(D.id[best]); }
  }
  /* ---------------- light, season, camera */
  environment(now) {
    const v = this.valley, e = v ? v.epoch : 1, f = this.frac();
    const season = v && v.gates(Math.max(1, e)).seasons ? ((e - 1 + f) % YEAR) / SEASON_LEN : 1.0; // 0..4
    const w = [0, 0, 0, 0]; const s0 = Math.floor(season) % 4, sf = season - Math.floor(season), blend = smoothstep(0.75, 1.0, sf);
    w[s0] = 1 - blend; w[(s0 + 1) % 4] += blend;
    const snow = s0 === 3 ? smoothstep(0.05, 0.4, sf) * (1 - smoothstep(0.8, 1.0, sf)) : 0;
    if (this.timeOfDay === null) this.tod = (this.tod + (now - (this.lastEnvT ?? now)) / 1000 / 360) % 1; else this.tod = this.timeOfDay;
    this.lastEnvT = now;
    const maxEl = [0.95, 1.15, 0.85, 0.55][s0] * (1 - blend) + [0.95, 1.15, 0.85, 0.55][(s0 + 1) % 4] * blend;
    const ang = (this.tod - 0.25) * Math.PI * 2, el = Math.sin(ang) * maxEl, az = this.tod * Math.PI * 2 + 0.6;
    let sun = V3.norm([Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)]);
    const night = smoothstep(0.05, -0.12, sun[1]), lowSun = smoothstep(0.35, 0.0, sun[1]);
    // the sun through the atmosphere at the valley's altitude (eight wavelengths, valley3d_atmos.js); the ranges hide the lowest sun
    const sunCol = sunColor(sun[1], PLANET.valleyAlt, this.hazeK ?? 1.6).map((c) => c * smoothstep(-0.02, 0.07, sun[1]));
    const moonCol = [0.12, 0.14, 0.22];
    const lightDir = night > 0.5 ? V3.norm([-sun[0], Math.abs(sun[1]) + 0.35, -sun[2]]) : sun;
    const light = night > 0.5 ? moonCol : sunCol;
    const zen = V3.lerp(V3.lerp([0.16, 0.32, 0.64], [0.22, 0.28, 0.45], lowSun), [0.01, 0.015, 0.035], night);
    const hor = V3.lerp(V3.lerp([0.62, 0.72, 0.86], [0.85, 0.62, 0.45], lowSun), [0.03, 0.04, 0.07], night);
    const ground = V3.lerp(V3.scale([0.30, 0.27, 0.20], 0.9), [0.02, 0.02, 0.03], night);
    const vis = 9 / (1 + night * 0.6 + w[3] * 0.9 + w[2] * 0.3);                          // visibility in km: hazier in autumn and winter
    return { season: w, snow, sun: lightDir, sunCol: light, zen, hor, ground, night, sunEl: sun[1], s0, seasonPos: sf, trueSun: sun, fogExt: hazeExtinction(PLANET.valleyAlt, vis) };
  }
  // the macro pivot in the canonical torus coordinates: an animal's bone posed now, or a fixed point
  macroPivot() {
    const m = this.macro; if (!m) return null;
    if (!m.animal) return m.abs;
    const st = this.anim.get(m.animal + m.id); if (!st) return null;
    const save = this.ro, R = [Math.floor(st.x), Math.floor(this.groundAt(st.x, st.z)), Math.floor(st.z)], buf = (this.scratchBones ??= new Float32Array(ROWF));
    this.ro = R; if (m.animal === "human") this.poseHuman(st, buf, 0); else this.poseQuadruped(m.animal, st, buf, 0, st.morph?.size ?? 1); this.ro = save;
    const p = M4.apply(buf.subarray(m.bone * 16, m.bone * 16 + 16), m.local);
    m.turn = st.heading - (m.heading0 ??= st.heading);
    return [p[0] + R[0], p[1] + R[1], p[2] + R[2]];
  }
  updateCamera(dt) {
    const c = this.cam, v = this.valley;
    if (this.macro) {
      const mp = this.macroPivot();
      if (mp) {
        c.target = mp; this.snap = false;
        const yaw = c.yaw + c.orbitYaw - (this.macro.turn ?? 0), pitch = c.pitch, dist = c.dist;
        const eye = [mp[0] + Math.cos(yaw) * Math.cos(pitch) * dist, mp[1] + Math.sin(pitch) * dist, mp[2] + Math.sin(yaw) * Math.cos(pitch) * dist];
        if (!this.macro.animal) { const g = this.groundAt(eye[0], eye[2]) + Math.min(dist * 0.35, 0.3); if (eye[1] < g) eye[1] = g; }
        c.pos = eye; return;
      }
      this.macro = null; c.dist = Math.max(c.dist, 2.2); this.snap = true;
    }
    let tx = c.target[0], tz = c.target[2], heading = c.yaw;
    if (c.mode === "follow" && this.followId != null) {
      const i = v.deer.find(this.followId);
      if (i >= 0) { const st = this.anim.get("deer" + this.followId); if (st) { tx = st.x; tz = st.z; heading = st.heading; } else { const p = this.rowPos(v.deer, i, this.frac(), 0); tx = p[0]; tz = p[1]; } this.lastFollow = [tx, tz]; }
      else if (this.lastFollow) [tx, tz] = this.lastFollow;
    } else if (c.mode === "inspect") { [tx, tz] = this.inspectAt; heading = c.yaw - Math.PI; }
    else { const tt = performance.now() / 1000; tx = 256 + Math.cos(tt * 0.02) * 120; tz = 256 + Math.sin(tt * 0.02) * 120; heading = tt * 0.02 + Math.PI / 2; }
    const ty = this.groundAt(tx, tz) + (c.mode === "follow" ? 1.0 : c.mode === "inspect" ? (this.inspectH ?? 1.2) : 2);
    // critically damped follow of the target and of the yaw behind the deer
    const k = this.snap ? 1 : Math.min(1, dt * 4);
    const nt = [c.target[0] + wrapD(tx - c.target[0]) * k, c.target[1] + (ty - c.target[1]) * k, c.target[2] + wrapD(tz - c.target[2]) * k];
    if (Math.abs(wrapD(tx - c.target[0])) > 30 || Math.abs(wrapD(tz - c.target[2])) > 30) { nt[0] = tx; nt[1] = ty; nt[2] = tz; }
    if (this.snap) { nt[0] = tx; nt[1] = ty; nt[2] = tz; c.yaw = heading + Math.PI; this.snap = false; }
    c.target = nt; c.yaw += angDiff(c.yaw, heading + Math.PI) * Math.min(1, dt * 1.6);
    const dist = c.mode === "overview" ? 70 : c.dist, pitch = c.mode === "overview" ? 0.42 : c.pitch, yaw = c.yaw + c.orbitYaw;
    let eye = [c.target[0] + Math.cos(yaw) * Math.cos(pitch) * dist, c.target[1] + Math.sin(pitch) * dist, c.target[2] + Math.sin(yaw) * Math.cos(pitch) * dist];
    const gEye = this.groundAt(eye[0], eye[2]) + 0.7; if (eye[1] < gEye) eye[1] = gEye;
    c.pos = eye;
  }
  /* ---------------- the frame */
  start() {
    if (this.running) return; this.running = true; let prev = null, wasQuiet = false;
    const loop = (t) => {
      if (!this.running) return;
      if (!this.ready) { if (this.failed || this.lost) { this.running = false; return; } requestAnimationFrame(loop); return; }
      const quiet = this.quiet ? !!this.quiet() : true; if (prev != null && document.visibilityState === "visible") this.govern(t - prev, quiet && wasQuiet); prev = t; wasQuiet = quiet;
      try { this.frame(t); } catch (e) { this.running = false; if (this.lost || this.gl.isContextLost()) { if (!this.lost) this.onContextLost({ preventDefault() {} }); return; } this.onError?.(e); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() { this.running = false; }
  frame(now) {
    if (!this.valley) return;
    const gl = this.gl, dt = Math.min(0.1, Math.max(0.001, (now - this.lastT) / 1000)); this.lastT = now; this.frameNo++;
    this.resize(); this.readProbe(); this.perf.frameStart();
    const env = this.environment(now); this.env = env;
    this.perf.begin("sky"); this.atmos.update(env, PLANET.valleyAlt, this.hazeK ?? 1.6); this.perf.end();
    // animals: states first (the camera follows the animated deer)
    const f = this.frac(), v = this.valley, cam0 = this.cam.target, R2 = 150 * 150;
    const near = { deer: [], wolf: [], human: [] };
    const collect = (kind, T, lim) => {
      for (let i = 0; i < T.n; i++) {
        const [x, z] = this.rowPos(T, i, f, kind === "wolf" ? 7 : kind === "human" ? 13 : 0), dx = wrapD(x - cam0[0]), dz = wrapD(z - cam0[2]), d2 = dx * dx + dz * dz;
        if (d2 < R2 || (kind === "deer" && T.id[i] === this.followId)) near[kind].push([d2, i]);
      }
      near[kind].sort((a, b) => a[0] - b[0]);
      if (near[kind].length > lim) { const keep = kind === "deer" ? near[kind].find(([, i]) => T.id[i] === this.followId) : null; near[kind].length = lim; if (keep && !near[kind].includes(keep)) near[kind][lim - 1] = keep; }   // the followed deer always stays
    };
    collect("deer", v.deer, this.q.animals); collect("wolf", v.wolves, 160); collect("human", v.wardens, 64);
    const states = { deer: near.deer.map(([, i]) => [i, this.stateOf("deer", v.deer, i, f, dt)]), wolf: near.wolf.map(([, i]) => [i, this.stateOf("wolf", v.wolves, i, f, dt)]), human: near.human.map(([, i]) => [i, this.stateOf("human", v.wardens, i, f, dt)]) };
    if (this.frameNo % 120 === 0) for (const [k, st] of this.anim) if (this.frameNo - st.seen > 240) this.anim.delete(k);
    this.updateCamera(dt);
    const cam = this.cam, origin = [Math.round(cam.target[0] / 8) * 8, 0, Math.round(cam.target[2] / 8) * 8]; this.origin = origin;
    this.updateRings(cam.target[0], cam.target[2]);
    if (this.plantsDirty || !this.plantsAt || Math.hypot(wrapD(cam.target[0] - this.plantsAt[0]), wrapD(cam.target[2] - this.plantsAt[1])) > 16) this.buildPlants(cam.target[0], cam.target[2]);
    // instance data: positions relative to the origin's torus copy
    const place = (st) => { st.rx = origin[0] + wrapD(st.x - origin[0]); st.rz = origin[2] + wrapD(st.z - origin[2]); };
    // E12: the shape space of the herd's lineages, refreshed once a season
    if (!this.space || v.epoch - this.spaceEpoch >= 24) { this.space = shapeSpace(v); this.spaceEpoch = v.epoch; }
    const deerAll = [];
    for (const [i, st] of states.deer) {
      place(st);
      if (st.morphEpoch !== v.epoch || (this.formGL.deer && !st.P)) { st.morph = deerMorph(v, i, this.space, env.s0); this.formOf("deer", v.deer, i, st, env); st.morphEpoch = v.epoch; }
      deerAll.push([i, st, st.form && st.P ? st.form.size : st.morph.size]);
    }
    const eye = [origin[0] + wrapD(cam.pos[0] - origin[0]), cam.pos[1], origin[2] + wrapD(cam.pos[2] - origin[2])];
    const tgt = [origin[0] + wrapD(cam.target[0] - origin[0]), cam.target[1], origin[2] + wrapD(cam.target[2] - origin[2])];
    // the render origin: whole metres at the eye. Everything drawn is relative to it, so a surface half a millimetre
    // from the lens is still placed to well under a micrometre; the detail origin keeps the materials in phase
    const ro = [Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2])]; this.ro = ro; this.mat.origin(eye, ro);
    this.near = this.macro ? Math.max(this.rev ? 1e-4 : 2e-3, Math.min(NEAR, cam.dist * 0.25)) : NEAR;
    const proj = this.rev ? M4.perspRevInf(this.fov, this.W / this.H, this.near) : M4.persp(this.fov, this.W / this.H, this.near, FAR);
    const view = M4.lookAt(eye, tgt), VP = M4.mul(proj, view); this.lastVP = VP; this.eye = eye;
    const VPr = M4.mul(proj, M4.lookAt(V3.sub(eye, ro), V3.sub(tgt, ro))); this.VPr = VPr;
    this.lodSort("deer", deerAll);
    // bone textures: per row the skin matrices, the form's dimensions and its landmarks
    const writeRows = (kind, items, pose) => {
      const data = this.boneData[kind], inst = [];
      const ids = (this.rowIds ??= {})[kind] = [];
      items.forEach(([i, st, sc], row) => {
        st.x = st.rx; st.z = st.rz; const o = row * ROWF; pose(st, data, o, sc ?? 1); inst.push(row, ...this.coat(kind, i, st, env)); ids.push(st.id);
        if (st.form && st.P) { data.set(st.form.t, o + QUAD_BONES * 16); const h = st.P.head, e = st.P.eye, it = items[row]; data.set([h[0], h[1], h[2], st.P.skullW ?? 0.065, e[0], e[1], e[2], 0, it.f01 ?? 0, it.f12 ?? 0, 0, 0], o + QUAD_BONES * 16 + 16); }
      });
      gl.bindTexture(gl.TEXTURE_2D, this.boneTex[kind]); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BONE_W, Math.max(1, items.length), gl.RGBA, gl.FLOAT, data.subarray(0, Math.max(1, items.length) * ROWF));
      return { inst: new Float32Array(inst), n: items.length };
    };
    const dr = writeRows("deer", deerAll, (st, d, o, sc) => this.poseQuadruped("deer", st, d, o, sc));
    this.pickStrands("deer", deerAll, env);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf.deer); gl.bufferData(gl.ARRAY_BUFFER, dr.inst, gl.STREAM_DRAW); this.deerDraw = dr.n;
    // antlers: bucks only, grown through spring and summer (in velvet), polished for the rut, cast in late winter
    const sf = env.seasonPos ?? 0, ant = [];
    deerAll.forEach(([i, st], row) => {
      const a = st.morph.antler; if (!a || env.s0 === 3) return;
      const growth = env.s0 === 0 ? 0.25 + 0.75 * sf : 1, velvet = env.s0 === 2 ? 0 : 1;
      ant.push(row, a.seed, a.pts, a.size, velvet, a.spread, a.asym, growth);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.antlers.inst); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ant), gl.STREAM_DRAW); this.antlers.n = ant.length / 8;
    const wolves = states.wolf.map(([i, st]) => { place(st); if (!st.morph || st.morphEpoch !== v.epoch || (this.formGL.wolf && !st.P)) { st.morph = wolfMorph(v, i); this.formOf("wolf", v.wolves, i, st, env); st.morphEpoch = v.epoch; } return [i, st, st.form && st.P ? st.form.size : st.morph.size]; });
    this.lodSort("wolf", wolves);
    const wr = writeRows("wolf", wolves, (st, d, o, sc) => this.poseQuadruped("wolf", st, d, o, sc));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf.wolf); gl.bufferData(gl.ARRAY_BUFFER, wr.inst, gl.STREAM_DRAW); this.wolfDraw = wr.n;
    const humans = states.human.map(([i, st]) => { place(st); if (!st.morph || (this.formGL.human && !st.P)) { st.morph = wardenMorph(v, i); this.formOf("human", v.wardens, i, st, env); } return [i, st, 1]; });
    this.lodSort("human", humans);
    const hr = writeRows("human", humans, (st, d, o) => this.poseHuman(st, d, o));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf.human); gl.bufferData(gl.ARRAY_BUFFER, hr.inst, gl.STREAM_DRAW); this.humanDraw = hr.n;
    const bd = this.birds.update(this, dt, performance.now(), env); gl.bindBuffer(gl.ARRAY_BUFFER, this.birdGL.inst); gl.bufferData(gl.ARRAY_BUFFER, bd, gl.STREAM_DRAW); this.birdGL.n = bd.length / 12;
    this.buildMarkers(states.deer, env);
    this.buildBlobs([...states.deer, ...states.wolf, ...states.human].map(([, st]) => st), env);
    // two shadow cascades around the camera target: 24 m (sharp) and 130 m (the trees of the wider view)
    this.lightVP = [M4.ident(), M4.ident()];
    if (this.rev) this.clip.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.NEGATIVE_ONE_TO_ONE_EXT);
    gl.depthFunc(gl.LESS); gl.clearDepth(1); this.perf.begin("shadow");
    if (this.shadowT && env.sun[1] > 0.02) {
      const c = tgt, L = env.sun, S = this.shadowT.h;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowT.fb); gl.viewport(0, 0, this.shadowT.w, S);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT); gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
      const lview = M4.lookAt([L[0] * 200, L[1] * 200, L[2] * 200], [0, 0, 0], Math.abs(L[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]), o = M4.apply(lview, c);
      // the eye's law for shadows (EYE-1): the near cascade's texels follow the footprint at the focus
      const fd = this.macro ? this.cam.dist : this.cam.mode === "overview" ? 70 : Math.hypot(...V3.sub(eye, tgt));
      const R0 = Math.max(3, Math.min(24, fd * 2.5 * this.fov / 0.9)), R1 = Math.max(60, Math.min(130, R0 * 5));
      [[R0, 110], [R1, 230]].forEach(([R, depth], k) => {
        const step = (2 * R) / S, ox = Math.round(o[0] / step) * step, oy = Math.round(o[1] / step) * step, d = -o[2];   // the centre snapped to texels: no shimmer
        this.lightVP[k] = M4.mul(M4.ortho(ox - R, ox + R, oy - R, oy + R, d - depth, d + depth), lview);
        gl.viewport(k * S, 0, S, S); this.drawScene(M4.mul(this.lightVP[k], translM(ro)), env, origin, true, null, k);
      });
      gl.cullFace(gl.BACK); gl.disable(gl.CULL_FACE);
    }
    this.perf.end();
    // the opaque scene into four targets: colour, albedo, normal, identity (reversed floating depth when there is clip control)
    this.perf.begin("scene");
    if (this.rev) { this.clip.clipControlEXT(this.clip.LOWER_LEFT_EXT, this.clip.ZERO_TO_ONE_EXT); gl.depthFunc(gl.GEQUAL); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneT.fb); gl.viewport(0, 0, this.W, this.H); gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]); gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]); gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]); gl.clearBufferuiv(gl.COLOR, 3, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [this.rev ? 0 : 1]);
    this.drawSky(VP, env, eye);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    this.drawScene(VPr, env, origin, false, eye);
    this.perf.end(); this.runProbe(); this.perf.begin("water");
    // water: copy the scene, then draw the surface reading the scene's colour and depth
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneT.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.waterT.fb);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterT.fb); gl.disable(gl.DEPTH_TEST);
    this.drawWater(VPr, env, eye, origin);
    if (!this.macro) this.drawMarkers(VPr);
    this.perf.end();
    // bloom and the final grade
    this.perf.begin("post"); this.post(env); this.perf.end(); this.perf.frameEnd();
  }
  runProbe() {
    const w = this.probeWant; if (!w || this.probeQ || !this.probeT) return;
    this.probeWant = null;
    const gl = this.gl, p = this.P.probe, px = Math.max(0, Math.min(this.W - 1, Math.round(w.x))), py = Math.max(0, Math.min(this.H - 1, Math.round(w.y)));
    gl.disable(gl.DEPTH_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeT.fb); gl.viewport(0, 0, 1, 1); gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.depthTex); gl.uniform1i(p.u.u_depth, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.tex[3]); gl.uniform1i(p.u.u_id, 1);
    gl.uniform2i(p.u.u_px, px, py); gl.uniform2f(p.u.u_nearFar, this.near, FAR); gl.uniform1f(p.u.u_rev, this.rev ? 1 : 0);
    gl.bindVertexArray(this.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    // what the answer needs: the ray through the pixel, the render origin, and the bones as they were drawn
    const inv = M4.invert(this.VPr), nx = (px + 0.5) / this.W * 2 - 1, ny = (py + 0.5) / this.H * 2 - 1;
    const a = M4.apply(inv, [nx, ny, 0.5]), aw = inv[3] * nx + inv[7] * ny + inv[11] * 0.5 + inv[15];
    const er = V3.sub(this.eye, this.ro), dir = V3.norm(V3.sub(V3.scale(a, 1 / aw), er)), fwd = V3.norm(V3.sub(V3.sub(this.cam.target, this.ro), er));
    const bones = {}; for (const k of ["deer", "wolf", "human"]) bones[k] = this.boneData[k].slice(0, (this.rowIds?.[k]?.length ?? 0) * ROWF);
    this.probeQ = { sync, cb: w.cb, snap: { ro: [...this.ro], eyeRel: er, dir, fwd, bones, rowIds: { ...this.rowIds } } };
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneT.fb); gl.viewport(0, 0, this.W, this.H); gl.enable(gl.DEPTH_TEST);
  }
  readProbe() {
    const q = this.probeQ; if (!q) return;
    const gl = this.gl, st = gl.clientWaitSync(q.sync, 0, 0);
    if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return;
    gl.deleteSync(q.sync); this.probeQ = null;
    const f = new Float32Array(4); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, f); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (!(f[0] > 0) || f[1] === 0) { this.probeLast = null; q.cb?.(null); return; }
    const s = q.snap, t = f[0] / Math.max(1e-6, V3.dot(s.dir, s.fwd)), rel = V3.add(s.eyeRel, V3.scale(s.dir, t));
    const r = { dist: t, kind: f[1], row: f[2], bone: f[3], point: V3.add(rel, s.ro), snap: s };
    this.probeLast = r; q.cb?.(r);
  }
  // strand fur: the nearest animal on the finest mesh when it stands at least 300 px tall; the count grows with its size
  pickStrands(kind, items, env) {
    this.strandT = null; const F = this.formGL[kind], cls = this.forms.cls[kind];
    if (!F || !cls?.ready || !this.strandBudget || !items.length || items[0].band > 0.5) return;
    const it = items[0], st = it[1], px = (it[2] ?? 1) * 1.5 * this.H / (2 * Math.tan(this.fov / 2)) / it.d;
    if (px < 300 || !st.form) return;
    const L0 = cls.lods[0]; this.strands.roots(kind, L0);
    this.strands.restFor(kind + st.id + ":" + st.form.t.join(","), L0, L0.cpu.dpos, L0.cpu.dnrm, st.form.t);
    const n = Math.min(this.strandBudget, Math.round(STRAND_MAX * Math.min(1, (px / 1400) ** 2)));
    const c = this.coat(kind, it[0], st, env);
    this.strandT = { kind, row: 0, n, size: it[2] ?? 1, tint: c.slice(0, 3), c1: c.slice(3, 7), c2: c.slice(7, 11), winter: env.s0 === 3 };
  }
  // an individual's form: its continuum (state -> dimensions and size) and its own skeleton from the class's joints
  formOf(kind, T, i, st, env) {
    if (!this.formGL[kind]) return;
    if (kind === "human") {                                    // a warden: its continuum from its own numbers, its own skeleton
      const id = T.id[i]; st.form = wardenContinuum(st.morph, (k) => h01(id, 500 + k) - 0.5);
      const J = this.forms.joints("warden", st.form.t); if (!J) return;
      st.P = { ...HUMAN, ...J, eye: [J.head[0] + 0.095, J.head[1] + 0.072, 0.036], skullW: 0.09 }; st.skel = humanSkeleton(st.P); return;
    }
    const id = T.id[i], r = (k) => h01(id, 300 + k) - 0.5, cond = Math.max(0.5, Math.min(1.4, T.energy[i] / 700));
    const state = { age: T.age[i] / YEAR, male: kind === "deer" ? T.sex[i] === 0 : (id & 1) === 0, cond, rut: env.s0 === 2, winter: env.s0 === 3, genes: st.morph?.genes ?? [0, 0, 0], r };
    st.form = (kind === "deer" ? deerContinuum : wolfContinuum)(state);
    const J = this.forms.joints(kind, st.form.t); if (!J) return;
    const Q = QUADRUPEDS[kind], P = { ...Q, ...J, ears: { ...Q.ears, at: J.ears }, eye: J.eye, skullW: J.eye[2] / 0.95 };
    st.P = P; st.skel = quadrupedSkeleton(P);
  }
  // levels of detail by the eye's law: an animal's height on screen in pixels picks its mesh; rows are grouped
  // by level so each level draws one contiguous instance range
  lodSort(kind, items) {
    if (!this.formGL[kind]) { this.lodCounts[kind] = [0, 0, 0]; return; }
    const e = this.cam.pos, k = this.H / (2 * Math.tan(this.fov / 2));
    for (const it of items) { const st = it[1], d = Math.max(0.05, Math.hypot(wrapD(st.x - e[0]), this.groundAt(st.x, st.z) + 0.8 - e[1], wrapD(st.z - e[2]))), px = (it[2] ?? 1) * 1.5 * k / d; Object.assign(it, lodLevel(px), { d }); }
    items.sort((a, b) => a.band - b.band || a.d - b.d);
    // budget: at most 4 animals touching the finest mesh and 48 the middle one; the rest step down a band
    let fine = 0, mid = 0;
    for (const it of items) {
      if (it.band <= 0.5 && ++fine > 4) Object.assign(it, { band: 1, f01: 1, f12: 0 });
      if (it.band >= 1 && it.band <= 1.5 && ++mid > 48) Object.assign(it, { band: 2, f01: 1, f12: 1 });
    }
    items.sort((a, b) => a.band - b.band || a.d - b.d);
    const c = [0, 0, 0, 0, 0]; for (const it of items) c[it.band * 2]++;
    this.lodCounts[kind] = c;
  }
  // twelve numbers per agent for the skin shader: row is prepended; tint rgb, then c1 and c2 (see FUR_FS)
  coat(kind, i, st, env) {
    const m = st.morph;
    if (kind === "deer") return [...m.tint, m.dorsal, m.ring, m.throat, m.grey, m.spots, m.spotTh, m.spotPh[0], m.spotPh[1]];
    if (kind === "wolf") return [...m.tint, m.saddle, m.mask, m.black, m.cream, 0, 0, 0, 0];
    return [1, 1, 1, ...m.skin, m.beard, ...m.shirt.map((x) => x * (0.92 + 0.16 * m.trousers % 1)), m.plaid];
  }
  setCommon(p, env, eye) {
    const gl = this.gl, u = p.u;
    gl.uniform3fv(u.u_sunDir, env.sun); gl.uniform3fv(u.u_sunCol, env.sunCol); gl.uniform3fv(u.u_skyZenith, env.zen); gl.uniform3fv(u.u_skyHorizon, env.hor); gl.uniform3fv(u.u_groundCol, env.ground);
    gl.uniform4f(u.u_fog, 0.0016 + env.night * 0.0012 + env.season[3] * 0.0012, 0.012, 0.94, 25); gl.uniform3fv(u.u_camPos, eye ?? this.eye ?? [0, 0, 0]);
    gl.uniform1f(u.u_time, performance.now() / 1000); gl.uniform4fv(u.u_season, env.season); gl.uniform1f(u.u_snow, env.snow); gl.uniform1f(u.u_night, env.night);
    const e = eye ?? this.eye ?? [0, 0, 0]; gl.uniform3fv(u.u_ro, this.ro); gl.uniform3f(u.u_camRel, e[0] - this.ro[0], e[1] - this.ro[1], e[2] - this.ro[2]);
    gl.uniform3fv(u.u_fogExt, env.fogExt); gl.uniform1f(u.u_lens, this.macro ? 0 : 1);
    gl.uniform1f(u.u_pxScale, radPerPixel(this.fov, this.H) / radPerPixel(0.9, 1080));
    this.atmos.bind(p); this.mat.bind(p);
    if (u.u_shadowMap !== undefined) {
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.shadowT ? this.shadowT.depthTex : null); gl.uniform1i(u.u_shadowMap, 7);
      const lv = this.lightVP ?? [M4.ident(), M4.ident()]; gl.uniformMatrix4fv(u.u_lightVP0, false, lv[0]); gl.uniformMatrix4fv(u.u_lightVP1, false, lv[1]); gl.uniform1f(u.u_shadowOn, this.shadowT && env.sun[1] > 0.02 ? 1 : 0);
    }
  }
  drawSky(VP, env, eye) {
    const gl = this.gl, p = this.P.sky; gl.useProgram(p.p); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    this.setCommon(p, env, eye); gl.uniformMatrix4fv(p.u.u_invVP, false, M4.invert(VP));
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE, gl.NONE]);
    gl.bindVertexArray(this.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.depthMask(true);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
  }
  drawScene(VP, env, origin, depthOnly, eye, cascade = 0) {
    const gl = this.gl, ro = this.ro, camRel = V3.sub(this.eye ?? [0, 0, 0], ro);
    // terrain rings: far to near, each with a hole where the finer ring lies
    const tp = depthOnly ? this.P.terrainDepth : this.P.terrain; gl.useProgram(tp.p);
    if (!depthOnly) {
      this.setCommon(tp, env, eye); gl.uniform1f(tp.u.u_waterLevel, this.waterLevel); gl.uniform1f(tp.u.u_plantsR, this.q.plantsR); gl.uniform1f(tp.u.u_world, WORLD);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.swardTex); gl.uniform1i(tp.u.u_sward, 1);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.wearTex); gl.uniform1i(tp.u.u_wear, 3);
    }
    gl.uniformMatrix4fv(tp.u.u_vp, false, VP);
    for (let k = this.rings.length - 1; k >= 0; k--) {
      const r = this.rings[k]; if (!r.vao) continue; if (depthOnly && k >= (cascade ? 4 : 3)) continue;
      const rc = [origin[0] + wrapD(r.center[0] - origin[0]) - ro[0], -ro[1], origin[2] + wrapD(r.center[1] - origin[2]) - ro[2]];
      gl.uniform3fv(tp.u.u_origin, rc);
      if (!depthOnly) { const inner = this.rings[k - 1]; if (inner && inner.center) { const ic = [origin[0] + wrapD(inner.center[0] - origin[0]), origin[2] + wrapD(inner.center[1] - origin[2])]; gl.uniform4f(tp.u.u_hole, ic[0], ic[1], inner.half - spacing(r.level) * 1.5, 1); } else gl.uniform4f(tp.u.u_hole, 0, 0, 0, 0); }
      gl.bindVertexArray(r.vao); gl.drawElements(gl.TRIANGLES, this.ringCount, gl.UNSIGNED_SHORT, 0);
    }
    if (!depthOnly) this.drawBlobs(VP);
    // flora: wood and leaf cards, both computed in the vertex shader from each plant's seed
    const po = this.plantsOrigin ?? origin, plantOrigin = [origin[0] + wrapD(po[0] - origin[0]) - ro[0], -ro[1], origin[2] + wrapD(po[2] - origin[2]) - ro[2]];
    const pp = depthOnly ? this.P.plantDepth : this.P.plant; gl.useProgram(pp.p);
    if (!depthOnly) this.setCommon(pp, env, eye); else { gl.uniform3fv(pp.u.u_camPos, this.eye ?? [0, 0, 0]); gl.uniform3fv(pp.u.u_camRel, camRel); gl.uniform1f(pp.u.u_time, performance.now() / 1000); gl.uniform1f(pp.u.u_pxScale, 1); }
    gl.uniformMatrix4fv(pp.u.u_vp, false, VP); gl.uniform3fv(pp.u.u_origin, plantOrigin);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.leafTex); gl.uniform1i(pp.u.u_leaf, 4);
    const autumn = [[0, 0, 0, 0], [0.74, 0.6, 0.18, 0.85], [0.6, 0.1, 0.07, 1]], w = env.season;
    if (depthOnly) gl.disable(gl.CULL_FACE);
    this.flora.forEach((f, k) => {
      if (!f.n) return;
      gl.uniform1i(pp.u.u_kind, k); gl.uniform4fv(pp.u.u_autumn, autumn[k]); gl.uniform1f(pp.u.u_cards, f.K.cards); gl.uniform3fv(pp.u.u_form, PLANT_U[k]);
      gl.uniform1f(pp.u.u_leafLoss, k === 0 ? 0 : Math.min(0.95, w[2] * 0.25 + w[3] * 0.92));
      gl.uniform1i(pp.u.u_part, 0); gl.bindVertexArray(f.wood.vao); gl.drawElementsInstanced(gl.TRIANGLES, f.wood.count, gl.UNSIGNED_SHORT, 0, f.n);
      gl.uniform1i(pp.u.u_part, 1); gl.bindVertexArray(f.leaves.vao); gl.drawElementsInstanced(gl.TRIANGLES, f.leaves.count, gl.UNSIGNED_SHORT, 0, f.n);
    });
    if (depthOnly) gl.enable(gl.CULL_FACE);
    // boulders
    if (this.rocks.n) {
      const rp = depthOnly ? this.P.rockDepth : this.P.rock; gl.useProgram(rp.p);
      if (!depthOnly) this.setCommon(rp, env, eye);
      gl.uniformMatrix4fv(rp.u.u_vp, false, VP); gl.uniform3fv(rp.u.u_origin, plantOrigin); gl.uniform3fv(rp.u.u_rform, ROCK_U);
      gl.bindVertexArray(this.rocks.vao); gl.drawElementsInstanced(gl.TRIANGLES, this.rocks.count, gl.UNSIGNED_SHORT, 0, this.rocks.n);
    }
    // animals
    const sp = depthOnly ? this.P.skinDepth : this.P.skin; gl.useProgram(sp.p);
    if (!depthOnly) this.setCommon(sp, env, eye);
    gl.uniformMatrix4fv(sp.u.u_vp, false, VP);
    const P = QUADRUPEDS;
    const drawSkin = (kind, mesh, n, k) => {
      if (!n) return;
      const F = this.formGL[kind], J = F && this.forms.cls[FORM_CLASS[kind]]?.joints, Q = P[kind] ?? P.deer;
      if (!depthOnly) {
        gl.uniform1i(sp.u.u_kind, k);
        const human = kind === "human", eye = J ? (J.eye ?? J.head) : eyeAt(Q), head = J ? J.head : Q.head, nose = J ? (J.snout ?? J.head) : Q.snout;
        const land = J ? (human ? [J.chest[1], 0, 0, J.head[1]] : [J.shoulder[1] + 0.2, J.hip[0] - 0.12, J.shoulder[0] + 0.04, J.head[1] - 0.12]) : [Q.body.reduce((m, r) => Math.max(m, r[3] + r[1]), 0), Q.body[0][0] + 0.08, Q.body.at(-1)[0] - 0.08, Q.head[1] - 0.24];
        gl.uniform3fv(sp.u.u_eye, eye); gl.uniform3fv(sp.u.u_head, head); gl.uniform3fv(sp.u.u_nose, nose); gl.uniform4fv(sp.u.u_land, land);
      }
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.boneTex[kind]); gl.uniform1i(sp.u.u_bones, 2);
      if (!F) { gl.uniform1f(sp.u.u_forms, 0); if (!depthOnly) gl.uniform1i(sp.u.u_lod, -1); gl.bindVertexArray(mesh.vao); gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.type, 0, n); return; }
      // the class's forms: each mesh over its rows, the fade bands drawn by both neighbours (dithered); the shadow pass
      // takes each row once, with the coarser meshes
      gl.uniform1f(sp.u.u_forms, 1);
      const [c0, c01, c1, c12, c2] = this.lodCounts[kind];
      const draws = depthOnly ? [[1, 0, c0 + c01 + c1], [2, c0 + c01 + c1, c12 + c2]] : [[0, 0, c0 + c01], [1, c0, c01 + c1 + c12], [2, c0 + c01 + c1, c12 + c2]];
      for (const [L, start, cnt] of draws) {
        if (!cnt) continue; const lod = F[L];
        if (!depthOnly) gl.uniform1i(sp.u.u_lod, L);
        gl.activeTexture(gl.TEXTURE11); gl.bindTexture(gl.TEXTURE_2D, lod.dpos); gl.uniform1i(sp.u.u_dpos, 11);
        gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, lod.dnrm); gl.uniform1i(sp.u.u_dnrm, 12);
        gl.bindVertexArray(lod.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf[kind]);
        for (let a = 0; a < 3; a++) gl.vertexAttribPointer(5 + a, 4, gl.FLOAT, false, 48, start * 48 + a * 16);
        gl.drawElementsInstanced(gl.TRIANGLES, lod.count, lod.type, 0, cnt);
      }
      if (!depthOnly) gl.uniform1i(sp.u.u_lod, -1);
    };
    drawSkin("deer", this.deerMesh, this.deerDraw, 0); drawSkin("wolf", this.wolfMesh, this.wolfDraw, 1); drawSkin("human", this.humanMesh, this.humanDraw, 2);
    if (!depthOnly && this.strandT && this.strandT.n) {
      const T = this.strandT, sp2 = this.strands.P, J = this.forms.cls[T.kind].joints; gl.useProgram(sp2.p); this.setCommon(sp2, env, eye);
      gl.uniformMatrix4fv(sp2.u.u_vp, false, VP);
      gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, this.strands.cls[T.kind].tex); gl.uniform1i(sp2.u.u_roots, 13);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, this.strands.rest); gl.uniform1i(sp2.u.u_rest, 14);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.boneTex[T.kind]); gl.uniform1i(sp2.u.u_bones, 2);
      gl.uniform1i(sp2.u.u_row, T.row); gl.uniform1f(sp2.u.u_scale, T.size); gl.uniform1f(sp2.u.u_radPx, radPerPixel(this.fov, this.H)); gl.uniform1f(sp2.u.u_lenK, T.winter ? 1.45 : 1);
      gl.uniform1i(sp2.u.u_kind, T.kind === "deer" ? 0 : 1); gl.uniform4fv(sp2.u.u_c1, T.c1); gl.uniform4fv(sp2.u.u_c2, T.c2); gl.uniform3fv(sp2.u.u_tint, T.tint);
      gl.uniform3fv(sp2.u.u_eye, J.eye); gl.uniform3fv(sp2.u.u_head, J.head); gl.uniform3fv(sp2.u.u_nose, J.snout); gl.uniform4fv(sp2.u.u_land, [J.shoulder[1] + 0.2, J.hip[0] - 0.12, J.shoulder[0] + 0.04, J.head[1] - 0.12]);
      gl.bindVertexArray(this.strands.empty); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (STRAND_SEG + 1), T.n);
    }
    if (this.antlers.n) {
      const ap = depthOnly ? this.P.antlerDepth : this.P.antler; gl.useProgram(ap.p);
      if (!depthOnly) { this.setCommon(ap, env, eye); gl.uniform1i(ap.u.u_kind, 3); }
      gl.uniformMatrix4fv(ap.u.u_vp, false, VP); gl.uniform3fv(ap.u.u_head, P.deer.head); gl.uniform1f(ap.u.u_forms, this.formGL.deer ? 1 : 0);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.boneTex.deer); gl.uniform1i(ap.u.u_bones, 2);
      gl.disable(gl.CULL_FACE); gl.bindVertexArray(this.antlers.vao); gl.drawElementsInstanced(gl.TRIANGLES, this.antlers.count, gl.UNSIGNED_SHORT, 0, this.antlers.n); if (depthOnly) gl.enable(gl.CULL_FACE);
    }
    // birds (not in the shadow pass)
    if (!depthOnly && this.birdGL.n) { const bp = this.P.bird; gl.useProgram(bp.p); this.setCommon(bp, env, eye); gl.uniformMatrix4fv(bp.u.u_vp, false, VP); gl.uniform3fv(bp.u.u_origin, V3.sub(origin, ro));
      gl.bindVertexArray(this.birdGL.vao); gl.drawElementsInstanced(gl.TRIANGLES, this.birdGL.count, gl.UNSIGNED_SHORT, 0, this.birdGL.n); }
    // grass (not in the shadow pass): clumps of blades, one triangle strip each
    if (!depthOnly && this.hgtRect && this.hgtRect2) {
      const gp = this.P.grass; gl.useProgram(gp.p); this.setCommon(gp, env, eye);
      const spc = this.q.grassD, N = Math.round((2 * this.q.grassR) / spc);
      gl.uniformMatrix4fv(gp.u.u_vp, false, VP); gl.uniform4f(gp.u.u_grid, this.cam.target[0], this.cam.target[2], spc, N);
      gl.uniform1f(gp.u.u_radius, this.q.grassR); gl.uniform1f(gp.u.u_cellM, CELL_M); gl.uniform1f(gp.u.u_world, WORLD);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.vegTex); gl.uniform1i(gp.u.u_veg, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.hgtTex); gl.uniform1i(gp.u.u_hgt, 4);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.hgtTex2); gl.uniform1i(gp.u.u_hgt2, 5);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.wearTex); gl.uniform1i(gp.u.u_wear, 6);
      const rect = (hr) => [origin[0] + wrapD(hr[0] - origin[0]), origin[2] + wrapD(hr[1] - origin[2]), hr[2], hr[3]];
      gl.uniform4fv(gp.u.u_hgtRect, rect(this.hgtRect)); gl.uniform4fv(gp.u.u_hgtRect2, rect(this.hgtRect2));
      gl.uniform4fv(gp.u.u_spH, GRASS_H.slice(0, 4)); gl.uniform4fv(gp.u.u_spH2, GRASS_H.slice(4));
      gl.bindVertexArray(this.emptyVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, GRASS_BLADES * GRASS_VPB, N * N);
    }
  }
  // soft contact shadows under the animals: a fan of triangles on the ground, dark at the centre
  buildBlobs(states, env) {
    const out = [], a = 0.42 * (1 - env.night * 0.6);
    for (const st of states.slice(0, 200)) {
      const r = st.blob ?? 0.7, cx = st.rx ?? st.x, cz = st.rz ?? st.z, y0 = this.groundAt(cx, cz) + 0.03;
      for (let k = 0; k < 10; k++) {
        const a0 = (k / 10) * Math.PI * 2, a1 = ((k + 1) / 10) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * r, 0, cz + Math.sin(a0) * r * 0.75], p1 = [cx + Math.cos(a1) * r, 0, cz + Math.sin(a1) * r * 0.75];
        p0[1] = this.groundAt(p0[0], p0[2]) + 0.03; p1[1] = this.groundAt(p1[0], p1[2]) + 0.03;
        out.push(cx, y0, cz, 0, 0, 0, a, ...p0, 0, 0, 0, 0, ...p1, 0, 0, 0, 0);
      }
    }
    const gl = this.gl, data = new Float32Array(out); gl.bindBuffer(gl.ARRAY_BUFFER, this.blobBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW); this.blobCount = data.length / 7;
  }
  drawBlobs(VP) {
    if (!this.blobCount) return;
    const gl = this.gl, p = this.P.mark; gl.useProgram(p.p); gl.uniformMatrix4fv(p.u.u_vp, false, VP); gl.uniform3fv(p.u.u_ro, this.ro);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE, gl.NONE, gl.NONE]);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(this.rev ? 1 : -1, this.rev ? 2 : -2);
    gl.bindVertexArray(this.blobVao); gl.drawArrays(gl.TRIANGLES, 0, this.blobCount);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
  }
  drawWater(VP, env, eye, origin) {
    const gl = this.gl, p = this.P.water; gl.useProgram(p.p); this.setCommon(p, env, eye);
    gl.uniformMatrix4fv(p.u.u_vp, false, VP); gl.uniform3fv(p.u.u_origin, V3.sub(origin, this.ro)); gl.uniform1f(p.u.u_level, this.waterLevel - this.ro[1]);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.depthTex); gl.uniform1i(p.u.u_depth, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.tex[0]); gl.uniform1i(p.u.u_scene, 6);
    gl.uniform2f(p.u.u_viewport, this.W, this.H); gl.uniform2f(p.u.u_nearFar, this.near, FAR); gl.uniform1f(p.u.u_rev, this.rev ? 1 : 0);
    gl.bindVertexArray(this.waterVao); gl.drawElements(gl.TRIANGLES, this.waterCount, gl.UNSIGNED_SHORT, 0);
  }
  // a selection ring, the 5 x 5 cells the deer weighs (coloured by forage), and the causal cone of its last bite
  buildMarkers(deerStates, env) {
    const v = this.valley, out = [], gl = this.gl;
    const st = this.followId != null ? this.anim.get("deer" + this.followId) : null, i = this.followId != null ? v.deer.find(this.followId) : -1;
    if (st && i >= 0) {
      const ring = (cx, cz, r, col, seg = 40, w = 0.06) => { for (let k = 0; k < seg; k++) { const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2; const p = (a, rr) => { const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr; return [x, this.groundAt(x, z) + 0.06, z]; };
        const A = p(a0, r - w), B = p(a0, r + w), C = p(a1, r - w), D = p(a1, r + w); for (const q of [A, B, C, C, B, D]) out.push(...q, ...col); } };
      ring(st.x, st.z, 0.9, [1.0, 0.75, 0.25, 0.85]);
      if (this.senses) {
        const per = v.perception(i), mx = Math.max(1, ...per.cells.map((c) => c.forage));
        for (const c of per.cells) {
          const x0 = (v.deer.x[i] + c.dx) * CELL_M, z0 = (v.deer.y[i] + c.dx * 0 + c.dy) * CELL_M, t = c.forage / mx;
          const col = c.reserve !== NONE ? [0.55, 0.45, 1.0, 0.28] : c.water ? [0.2, 0.5, 1.0, 0.2] : [0.25 + 0.6 * (1 - t), 0.85 * t + 0.2, 0.2, 0.10 + 0.22 * t];
          const pts = [[x0 + 0.15, z0 + 0.15], [x0 + CELL_M - 0.15, z0 + 0.15], [x0 + 0.15, z0 + CELL_M - 0.15], [x0 + CELL_M - 0.15, z0 + CELL_M - 0.15]].map(([x, z]) => { const wx = this.origin[0] + wrapD(x - this.origin[0]), wz = this.origin[2] + wrapD(z - this.origin[2]); return [wx, this.groundAt(x, z) + 0.05, wz]; });
          for (const k of [0, 1, 2, 2, 1, 3]) out.push(...pts[k], ...col);
        }
      }
      if (this.cone && v.lastReport) { // the cone bound: an effect spreads at most one cell per XPU generation
        const gens = (v.lastReport.gens || 2) * Math.min(6, v.epoch - (this.lastBiteEpoch ?? v.epoch) + 1);
        if (v.deer.act[i] === 2 || v.deer.act[i] === 6 || v.deer.act[i] === 4) this.lastBiteEpoch = v.epoch;
        ring(st.x, st.z, gens * CELL_M, [0.95, 0.55, 0.15, 0.55], 64, 0.08);
      }
    }
    const data = new Float32Array(out); gl.bindBuffer(gl.ARRAY_BUFFER, this.markBuf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW); this.markCount = data.length / 7;
  }
  drawMarkers(VP) {
    if (!this.markCount) return;
    const gl = this.gl, p = this.P.mark; gl.useProgram(p.p); gl.uniformMatrix4fv(p.u.u_vp, false, VP); gl.uniform3fv(p.u.u_ro, this.ro);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.bindVertexArray(this.markVao); gl.drawArrays(gl.TRIANGLES, 0, this.markCount); gl.disable(gl.BLEND);
  }
  post(env) {
    const gl = this.gl; gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(this.emptyVao);
    const pass = (prog, tgt, setup) => { gl.bindFramebuffer(gl.FRAMEBUFFER, tgt ? tgt.fb : null); gl.viewport(0, 0, tgt ? tgt.w : this.W, tgt ? tgt.h : this.H); gl.useProgram(prog.p); setup(prog.u); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    pass(this.P.bright, this.brightT, (u) => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.waterT.tex[0]); gl.uniform1i(u.u_tex, 0); gl.uniform1f(u.u_thresh, 1.1); });
    for (let k = 0; k < 2; k++) {
      pass(this.P.blur, this.blurT, (u) => { gl.bindTexture(gl.TEXTURE_2D, this.brightT.tex[0]); gl.uniform1i(u.u_tex, 0); gl.uniform2f(u.u_dir, 1.5, 0); });
      pass(this.P.blur, this.brightT, (u) => { gl.bindTexture(gl.TEXTURE_2D, this.blurT.tex[0]); gl.uniform1i(u.u_tex, 0); gl.uniform2f(u.u_dir, 0, 1.5); });
    }
    const w = env.season, grade = [[1.0, 1.03, 0.98, 1.06], [1.05, 1.01, 0.93, 1.08], [1.07, 0.98, 0.86, 1.1], [0.93, 0.98, 1.07, 0.84]];
    const g = [0, 1, 2].map((k) => w.reduce((s, x, i) => s + x * grade[i][k], 0)), sat = w.reduce((s, x, i) => s + x * grade[i][3], 0) * (1 - env.night * 0.35);
    const exposure = 0.5 + env.night * 2.0 + (1 - Math.min(1, env.sunEl * 4 + 0.2)) * 0.2;
    const st = this.followId != null ? this.anim.get("deer" + this.followId) : null;
    const focus = st ? Math.hypot(this.eye[0] - (this.origin[0] + wrapD(st.x - this.origin[0])), this.eye[2] - (this.origin[2] + wrapD(st.z - this.origin[2]))) : 30;
    pass(this.P.final, null, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.waterT.tex[0]); gl.uniform1i(u.u_scene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.brightT.tex[0]); gl.uniform1i(u.u_bloom, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.depthTex); gl.uniform1i(u.u_depth, 2);
      gl.uniform1f(u.u_exposure, exposure); gl.uniform3f(u.u_lift, 0.004 * (1 + env.night), 0.004, 0.006 + env.night * 0.02); gl.uniform3fv(u.u_gain, g); gl.uniform1f(u.u_sat, sat);
      gl.uniform1f(u.u_time, (performance.now() % 10000) / 1000); gl.uniform1f(u.u_bloomAmt, 0.22);
      gl.uniform2f(u.u_nearFar, this.near, FAR); gl.uniform1f(u.u_rev, this.rev ? 1 : 0); gl.uniform1f(u.u_focus, this.macro ? Math.max(this.cam.dist, 1e-4) : focus);
      const zf = this.macro ? this.cam.dist : this.cam.mode === "overview" ? 70 : this.cam.mode === "inspect" ? this.cam.dist : focus;
      gl.uniform1f(u.u_dof, this.macro || this.q.dof ? 1 : 0); gl.uniform1f(u.u_macro, this.macro ? 1 : 0); gl.uniform4fv(u.u_lens, lensUniforms(this.fov, this.H, zf, !!this.macro));
    });
  }
  // stop, and let the GPU memory go now (a new view gets a new canvas and context)
  dispose() {
    this.stop(); this.disposed = true; this.onLost = null; this.onError = null; this.onStatus = null; this.onUpgrade = null;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost, false);
    if (this.onKey) window.removeEventListener("keydown", this.onKey);
    if (!this.lost) { this.lost = true; this.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
  }
}

const tmpM = new Float32Array(16);
const UNIT = { size: 1, girth: 1, legs: 1, body: 1, neck: 1, neckGirth: 1, muzzle: 1, ears: 1, tail: 1 };
const diagM = (x, y, z) => { const m = M4.ident(); m[0] = x; m[5] = y; m[10] = z; return m; };
const aboutM = (c, M) => M4.mul(translM(c), M4.mul(M, translM([-c[0], -c[1], -c[2]])));
// scale by k along the unit direction d and by g across it
const stretchM = (d, k, g) => { const m = M4.ident(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[j * 4 + i] = (i === j ? g : 0) + (k - g) * d[i] * d[j]; return m; };
const translM = (t) => { const m = M4.ident(); m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; return m; };
const scaleM = (s) => { const m = M4.ident(); m[0] = m[5] = m[10] = s; return m; };
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// two-bone IK: knee position for a chain root -> knee -> end with lengths L1, L2, bending towards pole
function ik2(a, t, L1, L2, pole) {
  let d = V3.sub(t, a), len = V3.len(d); const dir = V3.norm(d);
  len = Math.max(Math.abs(L1 - L2) + 1e-3, Math.min(L1 + L2 - 1e-3, len));
  const x = (L1 * L1 - L2 * L2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
  let p = V3.sub(pole, V3.scale(dir, V3.dot(pole, dir))); p = V3.norm(V3.len(p) < 1e-5 ? [0, 0, 1] : p);
  return V3.add(V3.add(a, V3.scale(dir, x)), V3.scale(p, h));
}
