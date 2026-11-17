// Birds over Deer Valley: swallows, ravens and a hawk, each one its own size, wing shape and plumage.
// SPDX-License-Identifier: GPL-3.0-only
//
// The birds are not simulation agents (they have no table in the valley, no digest and no save file).
// They are a view of the valley's state, the way the grass is:
//   - swallows hunt the insects the herd stirs up: E1 admission gives the flock K slots, with K set by how
//     many deer graze near the camera; they fly as a flock (separation, alignment, cohesion)
//   - ravens follow the wolves, wheeling over the nearest pack
//   - a hawk soars in slow circles over open meadow
//   - E21 path integration: every bird integrates its own velocity into a home vector, and at dusk flies
//     that vector back to its roost; birds roost at night
// Each bird's seed gives its wingspan, aspect, tail and tint; the vertex shader builds it from them.
const h01 = (a, b) => { let x = Math.imul((a | 0) ^ 0x6c8e9cf5, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x ^ (b | 0), 0x846ca68b); x ^= x >>> 13; return (x >>> 0) / 4294967296; };
export const SPECIES = [
  { name: "swallow", span: 0.33, speed: 9.5, alt: [2.5, 9], flap: 9, glide: 0.35, color: 0 },
  { name: "raven", span: 1.2, speed: 7.5, alt: [14, 30], flap: 3.2, glide: 0.5, color: 1 },
  { name: "hawk", span: 1.25, speed: 6.5, alt: [45, 75], flap: 2.4, glide: 0.9, color: 2 },
];
// topology only: body (12 x 6), two wings and a tail as strips of quads; a vertex is (part, u, v)
export function birdTemplate() {
  const v = [], i = [], grid = (part, nu, nv) => { const o = v.length / 3; for (let a = 0; a <= nu; a++) for (let b = 0; b <= nv; b++) v.push(part, a / nu, b / nv);
    for (let a = 0; a < nu; a++) for (let b = 0; b < nv; b++) { const p = o + a * (nv + 1) + b; i.push(p, p + nv + 1, p + 1, p + 1, p + nv + 1, p + nv + 2); } };
  grid(0, 10, 6); grid(1, 6, 2); grid(2, 6, 2); grid(3, 3, 2);
  return { vertices: new Float32Array(v), indices: new Uint16Array(i) };
}
export class Birds {
  constructor() { this.birds = []; this.nextId = 1; }
  // one step of the flight model; returns instance data (12 floats a bird) relative to origin
  update(view, dt, now, env) {
    const v = view.valley; if (!v) return new Float32Array(0);
    const cx = view.cam.target[0], cz = view.cam.target[2], day = env.night < 0.5, dusk = env.sunEl < 0.12;
    // how many of each kind the valley calls for here
    let deer = 0; for (const st of view.anim.values()) if (st.seen === view.frameNo && st.blob === 0.8) deer++;
    const want = [day && env.s0 <= 1 ? Math.min(32, Math.floor(deer / 6)) : 0,            // E1: flock slots from the herd near by
      day ? Math.min(6, 2 + Math.floor((v.wolves.n > 0 ? 4 : 0))) * (v.wolves.n > 0 ? 1 : 0) : 0, day ? 1 + (env.s0 === 1 ? 1 : 0) : 0];
    const have = [0, 0, 0]; for (const b of this.birds) if (!b.leaving) have[b.k]++;
    for (let k = 0; k < 3; k++) for (let n = have[k]; n < want[k]; n++) this.spawn(k, cx, cz, view);
    for (let k = 0; k < 3; k++) { let extra = have[k] - want[k]; for (const b of this.birds) if (extra > 0 && b.k === k && !b.leaving) { b.leaving = true; extra--; } }
    // the nearest pack, for the ravens
    let pack = null, pd = 1e9; for (let i = 0; i < v.wolves.n; i++) { const x = (v.wolves.x[i] + 0.5) * 4, z = (v.wolves.y[i] + 0.5) * 4, d = Math.hypot(wrap(x - cx), wrap(z - cz)); if (d < pd) { pd = d; pack = [cx + wrap(x - cx), cz + wrap(z - cz)]; } }
    const out = [];
    for (const b of this.birds) {
      const S = SPECIES[b.k]; let tx = cx, tz = cz, ty;
      if (b.leaving || dusk) { tx = b.x - b.home[0]; tz = b.z - b.home[1]; ty = view.groundAt(tx, tz) + 3; }      // E21: fly the home vector back to the roost
      else if (b.k === 0) {                                                                                      // swallows: a flock over the grazing herd
        let ax = 0, az = 0, ay = 0, n = 0, sx = 0, sz = 0;
        for (const o of this.birds) { if (o === b || o.k !== 0) continue; const dx = o.x - b.x, dz = o.z - b.z, d2 = dx * dx + dz * dz; if (d2 > 400) continue; n++; ax += o.vx; az += o.vz; sx += dx; sz += dz; if (d2 < 2.5) { b.vx -= dx * 2 * dt; b.vz -= dz * 2 * dt; } }
        if (n) { b.vx += (ax / n - b.vx) * dt * 0.8; b.vz += (az / n - b.vz) * dt * 0.8; tx = b.x + sx / n; tz = b.z + sz / n; }
        tx = tx * 0.6 + (cx + Math.cos(now / 3000 + b.seed * 6) * 18) * 0.4; tz = tz * 0.6 + (cz + Math.sin(now / 2600 + b.seed * 5) * 18) * 0.4;
        ty = view.groundAt(b.x, b.z) + S.alt[0] + (S.alt[1] - S.alt[0]) * (0.5 + 0.5 * Math.sin(now / 900 + b.seed * 9)); ay = 0;
      } else if (b.k === 1) { const p = pack ?? [cx, cz], a = now / 4000 * (b.seed > 0.5 ? 1 : -1) + b.seed * 6.28; tx = p[0] + Math.cos(a) * (14 + 10 * b.seed); tz = p[1] + Math.sin(a) * (14 + 10 * b.seed); ty = view.groundAt(tx, tz) + S.alt[0] + (S.alt[1] - S.alt[0]) * b.seed; }
      else { const a = now / 9000 + b.seed * 6.28; tx = cx + 30 + Math.cos(a) * (35 + 20 * b.seed); tz = cz - 20 + Math.sin(a) * (35 + 20 * b.seed); ty = view.groundAt(cx, cz) + S.alt[0] + (S.alt[1] - S.alt[0]) * b.seed; }
      // steer towards the goal at the species' speed
      const dx = wrap(tx - b.x), dz = wrap(tz - b.z), dy = ty - b.y, d = Math.hypot(dx, dz) + 1e-3;
      const sp = S.speed * (0.85 + 0.3 * b.seed);
      b.vx += (dx / d * sp - b.vx) * Math.min(1, dt * (b.k === 0 ? 2.2 : 0.7)); b.vz += (dz / d * sp - b.vz) * Math.min(1, dt * (b.k === 0 ? 2.2 : 0.7)); b.vy += (Math.max(-3, Math.min(3, dy)) - b.vy) * Math.min(1, dt * 1.5);
      if (b.k === 0) { b.vx += (h01(b.id, Math.floor(now / 400)) - 0.5) * 30 * dt; b.vz += (h01(b.id + 7, Math.floor(now / 400)) - 0.5) * 30 * dt; }   // darting after insects
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      b.home[0] += b.vx * dt; b.home[1] += b.vz * dt;                                                           // E21: the integrated path
      const g = view.groundAt(b.x, b.z); if (b.y < g + 1.2) { b.y = g + 1.2; b.vy = Math.abs(b.vy); }
      const heading = Math.atan2(b.vz, b.vx), turn = angDiff(b.heading ?? heading, heading); b.heading = heading; b.bank += (Math.max(-0.9, Math.min(0.9, turn / Math.max(dt, 1e-3) * 0.25)) - b.bank) * Math.min(1, dt * 4);
      // flapping, with glides (the hawk mostly soars)
      const gliding = Math.sin(now / 1000 * 0.7 + b.seed * 20) > 1 - 2 * S.glide, f = gliding ? 0 : 1;
      b.flap = (b.flap + dt * S.flap * (0.9 + 0.2 * b.seed) * (0.3 + 0.7 * f)) % 1;
      if ((b.leaving || dusk) && Math.hypot(b.home[0], b.home[1]) < 3) b.gone = true;
      const o = view.origin;
      out.push(o[0] + wrap(b.x - o[0]) - o[0], b.y, o[2] + wrap(b.z - o[2]) - o[2], heading, b.seed, S.span * b.size, b.flap, f * (b.k === 2 ? 0.35 : 1), b.bank, b.k, b.aspect, b.tail);
    }
    this.birds = this.birds.filter((b) => !b.gone);
    return new Float32Array(out);
  }
  spawn(k, cx, cz, view) {
    const id = this.nextId++, seed = h01(id, 1), a = seed * 6.28, r = 60 + 40 * h01(id, 2), x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    this.birds.push({ id, k, seed, x, z, y: view.groundAt(x, z) + SPECIES[k].alt[1], vx: 0, vy: 0, vz: 0, home: [0, 0], bank: 0, flap: seed, size: 0.85 + 0.3 * h01(id, 3), aspect: 0.8 + 0.4 * h01(id, 4), tail: h01(id, 5), leaving: false });
  }
}
const wrap = (d) => ((d % 512) + 768) % 512 - 256;
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
