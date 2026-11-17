// Classes, extreme forms and continuum equations for everything alive or lying in the valley.
// SPDX-License-Identifier: GPL-3.0-only
//
// Every agent, plant and stone belongs to a class. A class has named shape dimensions; each dimension has a
// minimum and a maximum form, and an individual is a point t in [0, 1]^n between them. Continuum equations
// give t from the simulation's state: age through a von Bertalanffy growth curve, sex, condition (energy),
// season (the rut), the E12 genetic shape axes, and the individual's own variation. Nothing here changes the
// simulation or its digests.
//
// Animals (deer, wolf): the extremes are sculpted anatomy baked by tools/bake/animals.py into one mesh per
// class with a delta per dimension (shards/animals). The renderer draws P = P_base + sum_k (t_k - 1/2) dP_k
// and moves the skeleton's joints by the same equation, so gaits and foot IK fit every body.
// Plants and stones are generated in their vertex shaders; their dimensions' extremes are uniforms here
// (see PLANT_FORMS, ROCK_FORM) and the continuum is evaluated per instance on the GPU.

export const ANIMAL_DIMS = ["barrel", "brisket", "shoulder", "haunch", "tuck", "neckBase", "throat", "neckLen",
  "legs", "body", "head", "skull", "ears", "tail", "withers", "croup"];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sig = (x) => 1 / (1 + Math.exp(-x));
// von Bertalanffy: the fraction of adult length at age a (years), rate k, and of mass (its cube)
export const growth = (a, k) => 1 - Math.exp(-k * Math.max(0, a));

// The classes. For each: what it is, its dimensions with the meaning of their minimum and maximum, and the
// continuum (a function of a plain state object). Units: metres, years.
export const CLASSES = {
  deer: {
    kind: "animal", what: "white-tailed deer (Odocoileus virginianus); fawn to mature buck",
    size: { min: 0.42, max: 1.08, note: "overall scale: a newborn fawn to a heavy buck (shoulder 0.42 to 1.08 m)" },
    dims: {
      barrel: ["slab-sided ribs", "barrel-chested"], brisket: ["shallow chest", "deep brisket"], shoulder: ["light scapula and triceps", "heavy shoulder"],
      haunch: ["light haunch and ham", "heavy hindquarters"], tuck: ["full belly", "tucked flank"], neckBase: ["slender neck base", "swollen (rut) neck base"],
      throat: ["fine throat-latch", "thick throat-latch"], neckLen: ["short neck", "long neck"], legs: ["short legs", "long legs (fawns)"],
      body: ["short-coupled", "long-backed"], head: ["short face (fawn)", "long Roman face (old buck)"], skull: ["narrow skull", "broad skull and jowls"],
      ears: ["small ears", "large ears (fawns)"], tail: ["short tail", "long broad tail"], withers: ["flat withers", "high withers"], croup: ["level croup", "steep croup"],
    },
  },
  wolf: {
    kind: "animal", what: "grey wolf (Canis lupus); pup to large male",
    size: { min: 0.45, max: 1.08, note: "overall scale: a three-month pup to a big male (shoulder 0.36 to 0.86 m)" },
    dims: {
      barrel: ["narrow ribs", "broad ribs"], brisket: ["shallow chest", "deep keel"], shoulder: ["light shoulder", "heavy shoulder"], haunch: ["light hindquarters", "heavy hindquarters"],
      tuck: ["full belly (fed)", "tucked (hungry)"], neckBase: ["thin neck", "heavy ruff"], throat: ["fine throat", "thick throat"], neckLen: ["short neck", "long neck"],
      legs: ["short legs", "long legs (pups)"], body: ["short body", "long body"], head: ["short muzzle (pup)", "long muzzle"], skull: ["narrow skull", "broad skull"],
      ears: ["small ears", "large ears (pups)"], tail: ["short tail", "long brush"], withers: ["flat withers", "high withers"], croup: ["level", "sloping"],
    },
  },
  warden: { kind: "agent", what: "valley warden; slight to large adult", size: { min: 0.9, max: 1.12, note: "height 1.58 to 1.95 m" }, dims: { girth: ["slim", "heavy"], hatBrim: ["narrow brim", "wide brim"], hatCrown: ["low crown", "tall crown"] } },
  swallow: { kind: "bird", what: "barn swallow", dims: { span: [0.29, 0.35], tail: ["short streamers", "long streamers"] } },
  raven: { kind: "bird", what: "common raven", dims: { span: [1.0, 1.5], aspect: [0.9, 1.15] } },
  hawk: { kind: "bird", what: "red-tailed hawk", dims: { span: [1.1, 1.45], aspect: [0.95, 1.1] } },
  juniper: { kind: "plant", what: "Rocky Mountain juniper; seedling to ancient tree", dims: PLANT_DIMS() },
  willow: { kind: "plant", what: "willow; a single whip to a dense clump", dims: PLANT_DIMS() },
  blueberry: { kind: "plant", what: "blueberry; a sprig to a full bush", dims: PLANT_DIMS() },
  rock: { kind: "stone", what: "granite; river pebble to fractured boulder", dims: { radius: [0.04, 2.6], lumps: ["smooth", "lumpy"], fracture: ["rounded", "faceted and broken"], flat: ["round", "slabby"], moss: ["bare", "mossed"], sunk: ["sitting", "half buried"] } },
};
function PLANT_DIMS() { return { height: ["seedling", "old growth"], trunk: ["thin stem", "massive trunk"], crown: ["narrow crown", "spreading crown"], limbs: ["few limbs", "many limbs"], lean: ["upright", "wind-leaned"], foliage: ["sparse sprays", "dense foliage"], deadwood: ["no dead wood", "silvered dead limbs"] }; }

// ---- continuum equations for the animals: state -> t (one value per dimension) and the overall size
// state: { age (years), male (bool), cond (energy relative to normal, ~0.5..1.4), rut (bool), winter (bool),
//          genes [bulk, legs, head] (E12 axes in standard deviations), r(k) (the individual's own -0.5..0.5) }
export function deerContinuum(s) {
  const a = s.age, G = growth(a, 1.6), G2 = growth(a, 0.75), young = Math.exp(-a / 0.55), old = clamp01((a - 5) / 4), m = s.male ? 1 : 0, rut = s.rut && s.male ? 1 : 0;
  const g = s.genes ?? [0, 0, 0], r = s.r, c = (s.cond ?? 1) - 1;
  const t = {
    barrel: 0.22 + 0.5 * G2 + 0.12 * m + 0.25 * c + 0.06 * g[0] + 0.08 * r(1),
    brisket: 0.25 + 0.45 * G2 + 0.15 * m + 0.05 * g[0] + 0.08 * r(2),
    shoulder: 0.25 + 0.4 * G2 + 0.2 * m + 0.25 * c + 0.06 * g[0] + 0.08 * r(3),
    haunch: 0.25 + 0.45 * G2 + 0.08 * m + 0.3 * c + 0.06 * g[0] + 0.08 * r(4),
    tuck: 0.45 - 0.45 * c + 0.3 * rut + (s.winter ? 0.12 : 0) + 0.08 * r(5),
    neckBase: 0.3 + 0.3 * G2 + 0.12 * m + 0.35 * rut + 0.06 * r(6),
    throat: 0.35 + 0.25 * G2 + 0.25 * rut + 0.06 * r(7),
    neckLen: 0.5 - 0.3 * young + 0.08 * g[2] + 0.08 * r(8),
    legs: 0.42 + 0.4 * young + 0.1 * g[1] + 0.08 * r(9),
    body: 0.5 + 0.12 * (G - 0.8) - 0.06 * g[1] + 0.08 * r(10),
    head: 0.45 - 0.35 * young + 0.15 * old + 0.06 * m + 0.08 * g[2] + 0.06 * r(11),
    skull: 0.4 + 0.18 * m + 0.12 * G2 + 0.06 * r(12),
    ears: 0.45 + 0.4 * young + 0.08 * r(13),
    tail: 0.45 + 0.15 * G + 0.12 * r(14),
    withers: 0.35 + 0.3 * G2 + 0.12 * m + 0.06 * r(15),
    croup: 0.45 + 0.2 * old + 0.12 * r(16),
  };
  const size = (0.42 + 0.58 * G) * (s.male ? 1.04 + 0.04 * G2 : 0.96) * (1 + 0.035 * g[0] + 0.05 * r(0));
  return { t: ANIMAL_DIMS.map((k) => clamp01(t[k])), size };
}
export function wolfContinuum(s) {
  const a = s.age, G = growth(a, 2.2), G2 = growth(a, 0.9), young = Math.exp(-a / 0.35), m = s.male ? 1 : 0, r = s.r, c = (s.cond ?? 1) - 1;
  const t = {
    barrel: 0.25 + 0.45 * G2 + 0.1 * m + 0.25 * c + 0.08 * r(1), brisket: 0.25 + 0.5 * G2 + 0.1 * m + 0.08 * r(2), shoulder: 0.25 + 0.4 * G2 + 0.15 * m + 0.2 * c + 0.08 * r(3),
    haunch: 0.3 + 0.4 * G2 + 0.25 * c + 0.08 * r(4), tuck: 0.5 - 0.6 * c + 0.08 * r(5), neckBase: 0.3 + 0.35 * G2 + 0.15 * m + (s.winter ? 0.15 : 0) + 0.06 * r(6),
    throat: 0.35 + 0.3 * G2 + (s.winter ? 0.1 : 0) + 0.06 * r(7), neckLen: 0.5 - 0.3 * young + 0.08 * r(8), legs: 0.45 + 0.4 * young + 0.08 * r(9),
    body: 0.5 + 0.1 * (G - 0.8) + 0.08 * r(10), head: 0.45 - 0.4 * young + 0.06 * m + 0.08 * r(11), skull: 0.4 + 0.2 * m + 0.15 * G2 + 0.06 * r(12),
    ears: 0.45 + 0.45 * young + 0.08 * r(13), tail: 0.4 + 0.25 * G + (s.winter ? 0.1 : 0) + 0.08 * r(14), withers: 0.4 + 0.25 * G2 + 0.06 * r(15), croup: 0.45 + 0.12 * r(16),
  };
  const size = (0.45 + 0.55 * G) * (s.male ? 1.05 : 0.95) * (1 + 0.05 * r(0));
  return { t: ANIMAL_DIMS.map((k) => clamp01(t[k])), size };
}

// the warden: height, build and the rest from the warden's own numbers (valley3d_morph.js); sixteen slots, twelve used
export const WARDEN_DIMS = ["height", "build", "shoulders", "belly", "legs", "arms", "head", "neck", "hatBrim", "hatCrown", "jacket", "boots"];
export function wardenContinuum(m, r) {
  const t = { height: (m.height - 0.92) / 0.2, build: (m.girth - 0.9) / 0.25, shoulders: 0.5 + 0.5 * (m.girth - 1) + 0.25 * r(1), belly: 0.35 + 0.5 * (m.girth - 1) + 0.25 * r(2),
    legs: 0.5 + 0.3 * r(3), arms: 0.5 + 0.3 * r(4), head: 0.5 + 0.3 * r(5), neck: 0.45 + 0.4 * (m.girth - 1) + 0.2 * r(6),
    hatBrim: (m.hatBrim - 0.85) / 0.35, hatCrown: (m.hatCrown - 0.8) / 0.45, jacket: 0.5 + 0.4 * r(7), boots: 0.5 + 0.4 * r(8) };
  return { t: [...WARDEN_DIMS.map((k) => clamp01(t[k])), 0.5, 0.5, 0.5, 0.5], size: 1 };
}

// ---- plants and stones: each dimension's extremes (min, max) and its exponent in the continuum
// value(s) = min + (max - min) * s^e, with s the plant's maturity (its age against the class's span, through
// growth()) or the stone's size; the shaders receive [min, max, e] per dimension as uniform vec3 arrays.
export const PLANT_FORMS = {
  //            height m      trunk r m         crown/height    limbs (whorls/stems)   lean        foliage (card x)   dead wood
  juniper: { height: [0.25, 7.5, 1.0], trunk: [0.008, 0.32, 1.5], crown: [0.22, 0.42, 0.8], limbs: [4, 16, 0.7], lean: [0.02, 0.14, 1.2], foliage: [0.6, 1.35, 0.6], deadwood: [0, 0.35, 3.0], span: 180 },
  willow: { height: [0.35, 4.2, 1.0], trunk: [0.005, 0.06, 1.3], crown: [0.25, 0.55, 0.8], limbs: [2, 9, 0.8], lean: [0.15, 0.55, 1.0], foliage: [0.6, 1.25, 0.7], deadwood: [0, 0.2, 3.0], span: 60 },
  blueberry: { height: [0.06, 0.65, 1.0], trunk: [0.002, 0.012, 1.2], crown: [0.4, 0.75, 0.8], limbs: [2, 12, 0.8], lean: [0.2, 0.6, 1.0], foliage: [0.5, 1.2, 0.7], deadwood: [0, 0.15, 3.0], span: 24 },
};
export const PLANT_DIM_ORDER = ["height", "trunk", "crown", "limbs", "lean", "foliage", "deadwood"];
export const ROCK_FORM = { radius: [0.04, 2.6, 1.0], lumps: [0.12, 0.42, 0.7], fracture: [0.0, 1.0, 0.8], flat: [0.85, 0.5, 1.0], moss: [0.0, 1.0, 1.5], sunk: [0.05, 0.35, 1.0] };
export const ROCK_DIM_ORDER = ["radius", "lumps", "fracture", "flat", "moss", "sunk"];
export const formUniforms = (F, order) => new Float32Array(order.flatMap((k) => F[k]));
// maturity of a plant from its age in epochs (the flora ledger's born) through the class's span
export const plantMaturity = (kind, ageEpochs) => growth(ageEpochs / (PLANT_FORMS[kind]?.span ?? 60), 2.2);

// ---- the baked animal forms (shards/animals)
export class AnimalForms {
  constructor(gl) { this.gl = gl; this.cls = {}; }
  load(name, base = "shards/animals/") {
    if (this.cls[name]?.loading) return this.cls[name].loading;
    const rec = (this.cls[name] = { ready: false });
    rec.loading = (async () => {
      try {
        const j = await (await fetch(base + name + ".json", { cache: "force-cache" })).json();
        const gl = this.gl, one = async (fn) => { const r = await fetch(base + fn, { cache: "force-cache" }); if (!r.ok) throw new Error(fn); return new Uint8Array(await r.arrayBuffer()); };
        const bin = async (f) => { const ps = await Promise.all((f.parts ?? [f.file]).map(one)); if (ps.length === 1) return ps[0]; const o = new Uint8Array(f.bytes); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; };
        rec.lods = [];
        for (const L of j.lods) {
          const [mesh, dpos, dnrm] = await Promise.all([bin(L.files.mesh), bin(L.files.dpos), bin(L.files.dnrm)]);
          const nv = L.vertices, vb = new Float32Array(mesh.buffer, 0, nv * 13), ib = new Uint32Array(mesh.buffer, nv * 52, L.triangles * 3);
          const W = 4096, rows = Math.ceil((nv * 16) / W);
          const pp = new Float32Array(W * rows * 3); pp.set(new Float32Array(dpos.buffer, 0, nv * 16 * 3));
          const nn = new Uint16Array(W * rows * 4); nn.set(new Uint16Array(dnrm.buffer, 0, nv * 16 * 4));
          const tex = (internal, format, type, data) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, internal, W, rows, 0, format, type, data); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); return t; };
          rec.lods.push({ nv, count: L.triangles * 3, vb, ib, dpos: tex(gl.RGB32F, gl.RGB, gl.FLOAT, pp), dnrm: tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, nn), cpu: rec.lods.length === 0 ? { dpos: pp, dnrm: nn } : null });
        }
        rec.joints = j.joints; rec.djoints = j.djoints; rec.dims = j.dims; rec.ready = true;
        return rec;
      } catch (e) { rec.failed = String(e); return null; }
    })();
    return rec.loading;
  }
  // the class's joints for dimension values t (array in ANIMAL_DIMS order)
  joints(name, t) {
    const c = this.cls[name]; if (!c?.ready) return null;
    const out = {};
    for (const [k, v] of Object.entries(c.joints)) { const d = c.djoints[k], p = v.slice(); for (let i = 0; i < t.length; i++) { const w = t[i] - 0.5; if (w) { p[0] += w * d[i][0]; p[1] += w * d[i][1]; p[2] += w * d[i][2]; } } out[k] = p; }
    return out;
  }
}
