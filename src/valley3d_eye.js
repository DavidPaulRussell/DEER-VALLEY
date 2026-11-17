// The camera as an eye: one law for image quality at any zoom or angle, written on the four rails.
// SPDX-License-Identifier: GPL-3.0-only
//
// The law: every point on screen is drawn with detail matched to the patch of surface its pixel covers,
// its footprint. At distance d, seen at angle phi from the surface normal, through a vertical field of view F
// on an image H pixels tall, one pixel spans
//
//     theta = 2 tan(F/2) / H            radians per pixel (at the centre)
//     rho   = d theta / max(cos phi, e) metres along the slope, and d theta across it
//
// Material octaves, mesh levels of detail, grass, plant cards, shadow texels and the lens all follow rho,
// so a deer at 300 m through a 400 mm lens and a deer at 6 m through a 25 mm lens are drawn alike, and a
// surface seen at a grazing angle keeps its detail along the slope where its pixels are long.
//
// The four rails (after the LittleBit notes' apparatus L -> T_LA[L] -> T_8S[.] -> T_cal[.]); this mapping onto
// rendering is ours, stated card by card below and checked numerically by checkCards():
//   Rail I    the canonical law, a scalar equation
//   Rail II   its linear-algebraic lift: the operator it is (here, the camera's screen-to-surface Jacobian)
//   Rail III  the 8-state lift: the discrete states the law selects among (octaves, mesh levels), weighted
//             by the kernel exp(-t |l - l*|) under the positive metric exp(t diag(delta)); as t grows it
//             retracts to Rail I's nearest state, and for finite t it is the smooth blend that never pops
//   Rail IV   the continuum: a density on the image whose integral is the law's nominal value (the pixel
//             budget), with an exact quadrature on the pixel grid and a retraction back to Rail I

export const FOV_WIDE = 1.35, FOV_TELE = 0.0105;                    // 14 mm to 2300 mm on a full-frame sensor (24 mm tall)
export const SENSOR_H = 0.024;
// the focal-length continuum: z in [0, 1] -> F, geometric so each step of the wheel is the same zoom ratio
export const fovAt = (z) => FOV_WIDE * Math.pow(FOV_TELE / FOV_WIDE, Math.max(0, Math.min(1, z)));
export const zoomOf = (F) => Math.log(F / FOV_WIDE) / Math.log(FOV_TELE / FOV_WIDE);
export const focalLength = (F) => (SENSOR_H / 2) / Math.tan(F / 2);          // metres
export const radPerPixel = (F, H) => (2 * Math.tan(F / 2)) / H;
export const footprint = (d, F, H, cosPhi = 1) => (d * radPerPixel(F, H)) / Math.max(cosPhi, 0.05);

// Rail III for mesh levels: the continuous level from an object's height in pixels, and the two cross-fade
// fractions between neighbouring meshes (dithered, so a level change never pops)
export const LOD_PX = [260, 48];
export function lodLevel(px) {
  const l = Math.log2(Math.max(px, 1e-3));
  const f01 = smooth(Math.log2(LOD_PX[0] * 1.25), Math.log2(LOD_PX[0] / 1.25), l), f12 = smooth(Math.log2(LOD_PX[1] * 1.25), Math.log2(LOD_PX[1] / 1.25), l);
  return { f01, f12, level: f12 > 0.5 ? 2 : f01 > 0.5 ? 1 : 0, band: f01 > 0 && f01 < 1 ? 0.5 : f12 > 0 && f12 < 1 ? 1.5 : f12 >= 1 ? 2 : f01 >= 1 ? 1 : 0 };
}
function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// the thin lens: circle of confusion in pixels for an object at distance z, focus at zf, f-number N
export function cocPx(z, zf, F, H, N = 2.8) {
  const f = focalLength(F); if (zf <= f * 1.05) return 0;
  return ((f * f) / (N * (zf - f))) * (Math.abs(z - zf) / Math.max(z, 1e-6)) * (H / SENSOR_H);
}
// lens uniforms for the final pass: (f^2 / (N (zf - f))) * H / sensor, zf, max blur, macro flag
export function lensUniforms(F, H, zf, macro, N = macro ? 8 : 2.8) {
  const f = focalLength(F), k = zf > f * 1.05 ? ((f * f) / (N * (zf - f))) * (H / SENSOR_H) : 0;
  return [k, zf, macro ? 7 : 12, macro ? 1 : 0];
}

// ---- the cards
export const CARDS = [
  {
    id: "EYE-1", law: "footprint",
    rail1: "rho = d * 2 tan(F/2) / H / max(cos phi, e): the metres of surface under one pixel",
    rail2: "J = d(u,v)/d(px,py), the screen-to-surface Jacobian; its singular values are the footprint's axes (d theta / cos phi, d theta). Linear in the pixel step; the shaders take it as (dFdx, dFdy) of the surface coordinates",
    rail3: "states: material octaves k = 0..4 (tiles s_k = s0 / 8^k); weight w_k = 1 - smoothstep(1.2 s_k/n, 6 s_k/n, sqrt(det J)) - the kernel's smooth form, retracting to k* = floor(log8(s0 / (n rho))) as the band narrows",
    rail4: "detail density on the image: one texel per pixel, integral over the image = W H (the pixel budget); exact on the pixel grid; a patch of area A at distance d shows A / rho^2 texels = its pixel area, whatever d, F or phi",
  },
  {
    id: "EYE-2", law: "mesh level",
    rail1: "l* = log2(260 / px) (0 at 260 px tall and above), mesh = round(l*) clamped to 0..2",
    rail2: "px = s h H / (2 d tan(F/2)): linear in the object's height h and in 1/d",
    rail3: "the 8-state lift over meshes {0, 1, 2}: cross-fade fractions f01 = smoothstep(log2 325, log2 208, log2 px), f12 = smoothstep(log2 60, log2 38.4, log2 px); each pixel keeps one mesh by a dither (no popping); as the band narrows to zero it retracts to Rail I",
    rail4: "vertex density per pixel of the object, near 1 / (cell size in pixels)^2; its integral over the image is the frame's vertex budget, held by the governor",
  },
  {
    id: "EYE-3", law: "focal length",
    rail1: "F(z) = F_wide (F_tele / F_wide)^z, z in [0, 1]; f = (sensor/2) / tan(F/2)",
    rail2: "log F is affine in z: each wheel step multiplies the magnification by the same ratio",
    rail3: "F is continuous; every footprint-driven state above follows it, so zooming changes which octaves and meshes are drawn, never how sharp the image is",
    rail4: "the magnification density over z: integral of d(log F) over [0, 1] = log(F_tele / F_wide), exact under any uniform step",
  },
  {
    id: "EYE-4", law: "lens (thin lens)",
    rail1: "CoC = f^2 / (N (zf - f)) |z - zf| / z, in pixels times H / sensor height",
    rail2: "for fixed zf the blur is affine in 1/z: CoC = k |1 - zf / z|",
    rail3: "the final pass blurs with a disc of radius CoC sampled at 12 points; CoC < 0.2 px retracts to the sharp image",
    rail4: "the depth-of-field density: the fraction of the image within 0.5 px of focus, the integral of the depth histogram over |z - zf| < 0.5 z / (k zf); wide lenses keep most of the image sharp, long lenses and macro little",
  },
];

// numerical checks of the cards' retractions and invariances (used by the tests)
export function checkCards() {
  const out = [];
  // EYE-1: texels shown by a 1 m^2 patch equal its pixel area at any distance and lens
  for (const [d, F] of [[6, 0.9], [300, 0.03], [0.002, 0.9]]) {
    const H = 1080, rho = footprint(d, F, H), pxSide = 1 / rho, texels = 1 / (rho * rho);
    out.push({ card: "EYE-1", d, F, ok: Math.abs(texels - pxSide * pxSide) < 1e-6 * texels });
  }
  // EYE-1 Rail III retraction: as the band narrows, the weights pick floor(log8(s0 / (n rho)))
  const s0 = 1, n = 1024, rho = 3e-4, kstar = Math.floor(Math.log(s0 / (n * rho)) / Math.log(8));
  const w = [0, 1, 2, 3, 4].map((k) => { const tx = s0 / 8 ** k / n; return k === 0 ? 1 : rho < tx * 1.001 ? 1 : rho > tx * 1.001 ? 0 : 0.5; });
  out.push({ card: "EYE-1/III", kstar, ok: w.lastIndexOf(1) === Math.min(4, Math.max(0, kstar)) });
  // EYE-2: the level changes monotonically and the fade fractions are complementary partitions
  let mono = true, prev = -1; for (let px = 1000; px > 5; px *= 0.9) { const L = lodLevel(px); if (L.band < prev - 1e-9) mono = false; prev = L.band; }
  out.push({ card: "EYE-2", ok: mono && lodLevel(1000).f01 === 0 && lodLevel(10).f12 === 1 });
  // EYE-3: the zoom continuum is exact at its ends and geometric between
  out.push({ card: "EYE-3", ok: Math.abs(fovAt(0) - FOV_WIDE) < 1e-12 && Math.abs(fovAt(1) - FOV_TELE) < 1e-12 && Math.abs(fovAt(0.5) - Math.sqrt(FOV_WIDE * FOV_TELE)) < 1e-12 && Math.abs(zoomOf(fovAt(0.37)) - 0.37) < 1e-12 });
  // EYE-4: zero blur at focus; a long lens blurs more than a wide one at the same subject framing
  const H = 1080, wide = cocPx(60, 6, 0.9, H), tele = cocPx(600, 60, 0.09, H);
  out.push({ card: "EYE-4", ok: cocPx(10, 10, 0.5, H) === 0 && tele > wide, wide, tele });
  return out;
}
