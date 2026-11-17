// GLSL ES 3.00 shaders for the Deer Valley renderer.
// SPDX-License-Identifier: GPL-3.0-only
import { DETAIL } from "./valley3d_detail.js";
import { SKY_LOOKUP } from "./valley3d_atmos.js";

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;
// lighting, atmosphere and noise shared by every pass
export const COMMON = `
uniform vec3 u_sunDir;      // towards the sun (the moon at night)
uniform vec3 u_sunCol;      // sun radiance (HDR)
uniform vec3 u_skyZenith;
uniform vec3 u_skyHorizon;
uniform vec3 u_groundCol;
uniform vec4 u_fog;         // density, height falloff, max opacity, start distance
uniform vec3 u_camPos;
uniform float u_time;
uniform vec4 u_season;      // spring, summer, autumn, winter weights
uniform float u_snow;       // 0..1 snow cover
uniform float u_night;      // 0 day .. 1 night
uniform vec3 u_ro;          // the render origin: whole metres by the eye; vertex positions are relative to it
uniform vec3 u_camRel;      // the eye relative to the render origin
uniform vec3 u_fogExt;      // the valley's haze: extinction per metre in r, g, b (Rayleigh's lambda^-4 and aerosol)
uniform float u_pxScale;    // the eye's law (valley3d_eye.js): radians per pixel now over those of the 25 mm lens at 1080 rows;
                            // a distance times this is the distance whose footprint is the same, so detail follows the footprint
` + SKY_LOOKUP + `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s; }
float fbm3(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s / 0.875; }
vec3 skyColor(vec3 d) {                       // the spectral panorama (valley3d_atmos.js), and the aureole sharper than it holds
  d = normalize(d); float mu = dot(d, u_sunDir);
  vec3 c = skyRadiance(vec3(d.x, max(d.y, -0.25), d.z), 0.0);
  c += u_sunCol * (0.02 * pow(max(mu, 0.0), 12.0) + 0.2 * pow(max(mu, 0.0), 260.0)) * (1.0 - u_night);
  if (d.y < 0.0) c = mix(c, u_groundCol * 0.7 + c * 0.3, clamp(-d.y * 5.0, 0.0, 1.0));
  return c;
}
vec3 g_fogT = vec3(1.0);    // the last applyFog's transmittance: the G-buffer weights the traced light by it
vec3 applyFog(vec3 col, vec3 wpos, vec3 view) {
  float dist = length(view), hf = u_fog.y * view.y; hf = abs(hf) < 1e-3 ? 1e-3 : hf;
  float k = exp(-u_fog.y * max(u_camPos.y - 20.0, 0.0)) * (1.0 - exp(-hf)) / hf;
  vec3 T = max(exp(-u_fogExt * k * max(dist - u_fog.w, 0.0)), vec3(1.0 - u_fog.z));
  vec3 vd = view / max(dist, 1e-6);
  vec3 fc = skyRadiance(vec3(vd.x, max(vd.y, 0.03), vd.z), 1.5) + u_sunCol * 0.06 * pow(max(dot(vd, u_sunDir), 0.0), 8.0) * (1.0 - u_night);
  g_fogT = T;
  return col * T + fc * (1.0 - T);
}
vec3 ambient(vec3 n) {                        // the sky around the normal, heavily blurred, and the ground's bounce below
  vec3 sky = skyRadiance(vec3(n.x * 0.55, max(n.y, 0.0) * 0.55 + 0.45, n.z * 0.55), 4.0);
  return mix(u_groundCol, sky, smoothstep(-0.7, 0.7, n.y) * 0.8 + 0.2);
}
`;
// two shadow cascades side by side in one depth texture: near (left half) and far (right half)
const SHADOW = `
uniform sampler2D u_shadowMap;
uniform mat4 u_lightVP0; uniform mat4 u_lightVP1;
uniform float u_shadowOn;
// nine taps at the base level (the map has no mipmaps): textureLod, because a gradient operation inside a loop
// under divergent flow is an error for D3D's compiler, and ANGLE's retries after it are what hung 1.4.0 on D3D11
float pcf(vec2 uv, float z, vec2 ts) { float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += z > textureLod(u_shadowMap, uv + vec2(x, y) * ts, 0.0).r ? 0.0 : 1.0;
  return s / 9.0; }
float shadowAt(vec3 wpos, vec3 n) {
  if (u_shadowOn < 0.5) return 1.0;
  vec2 ts = 1.0 / vec2(textureSize(u_shadowMap, 0));
  vec4 a = u_lightVP0 * vec4(wpos + n * 0.05, 1.0); vec3 p = a.xyz / a.w * 0.5 + 0.5;
  if (p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98 && p.z < 1.0) return pcf(vec2(p.x * 0.5, p.y), p.z - 0.0006, ts);
  vec4 b = u_lightVP1 * vec4(wpos + n * 0.2, 1.0); vec3 q = b.xyz / b.w * 0.5 + 0.5;
  if (q.x <= 0.0 || q.x >= 1.0 || q.y <= 0.0 || q.y >= 1.0 || q.z >= 1.0) return 1.0;
  float edge = smoothstep(0.0, 0.08, min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)));
  return mix(1.0, pcf(vec2(0.5 + q.x * 0.5, q.y), q.z - 0.0012, ts), edge);
}
`;

// every opaque scene shader writes four targets: colour, albedo (for the traced light), normal, and what it is
const SCENE_OUT = `
layout(location=0) out vec4 o;
layout(location=1) out vec4 o_alb;    // albedo times the fog's transmittance; a = the weight of its ambient term
layout(location=2) out vec4 o_nrm;    // octahedral normal (y the pole), roughness, 0
layout(location=3) out uint o_id;     // kind << 24 | row << 8 | bone
vec2 octEnc(vec3 v) { v /= abs(v.x) + abs(v.y) + abs(v.z); vec2 p = v.xz; if (v.y < 0.0) p = (1.0 - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0); return p; }
void gbuf(vec3 albedo, float ambK, vec3 n, float rough, uint id) { o_alb = vec4(albedo * g_fogT, ambK); o_nrm = vec4(octEnc(n), rough, 0.0); o_id = id; }
`;
// Marschner's three lobes for a hair along T: R off the cuticle, TT through the fibre, TRT back out after one
// inner reflection. Longitudinal Gaussians shifted by the cuticle's tilt; azimuthal terms after the fits of
// d'Eon et al. (2011) and Karis (2016); absorption from the coat's colour by the mapping of Chiang et al. (2016).
export const HAIR = `
float hGauss(float b, float x) { return exp(-0.5 * x * x / (b * b)) / (2.5066283 * b); }
float hFresnel(float c) { return 0.0465 + 0.9535 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }      // eta = 1.55
vec3 hairSigma(vec3 c, float bn) { float d = 5.969 - 0.215 * bn + 2.532 * bn * bn - 10.73 * bn * bn * bn + 5.574 * bn * bn * bn * bn + 0.245 * pow(bn, 5.0); vec3 l = log(clamp(c, vec3(0.002), vec3(0.999))) / d; return l * l; }
// returns R (x), and TT and TRT as colours; V and L point away from the hair
void marschner(vec3 T, vec3 V, vec3 L, vec3 sa, float rough, out float R, out vec3 TT, out vec3 TRT) {
  float sL = clamp(dot(T, L), -1.0, 1.0), sV = clamp(dot(T, V), -1.0, 1.0);
  float cD = cos(0.5 * abs(asin(sV) - asin(sL)));
  vec3 Lp = L - sL * T, Vp = V - sV * T;
  float cPhi = dot(Lp, Vp) * inversesqrt(dot(Lp, Lp) * dot(Vp, Vp) + 1e-4), cHalf = sqrt(clamp(0.5 + 0.5 * cPhi, 0.0, 1.0));
  const float alpha = 0.045; float b = rough * rough + 0.004, sh = sL + sV;
  R = hGauss(b * 1.4142 * max(cHalf, 0.15), sh + 2.0 * alpha) * 0.25 * cHalf * hFresnel(sqrt(clamp(0.5 + 0.5 * dot(L, V), 0.0, 1.0)));
  float etaP = 1.19 / cD + 0.36 * cD, a = 1.0 / etaP, h = cHalf * (1.0 + a * (0.6 - 0.8 * cPhi));
  float fT = hFresnel(cD * sqrt(clamp(1.0 - h * h, 0.0, 1.0)));
  TT = hGauss(b * 0.5, sh - alpha) * exp(-3.65 * cPhi - 3.98) * (1.0 - fT) * (1.0 - fT) * exp(-sa * 2.0 * sqrt(clamp(1.0 - h * h * a * a, 0.0, 1.0)) / cD);
  float fR = hFresnel(cD * 0.5);
  TRT = hGauss(b * 2.0, sh - 3.0 * alpha) * exp(17.0 * cPhi - 16.78) * (1.0 - fR) * (1.0 - fR) * fR * exp(-sa * 3.0 / cD);
}
`;

/* ------------------------------------------------------------------ sky, clouds and the mountains around the valley */
export const SKY_VS = HEADER + `
out vec2 v_ndc;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; v_ndc = p; gl_Position = vec4(p, 1.0, 1.0); }`;
export const SKY_FS = HEADER + COMMON + `
in vec2 v_ndc; out vec4 o;
uniform mat4 u_invVP;
float ridged(vec2 p) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); return n * n; }
// a ridge line over the azimuth (periodic): elevation of the skyline in radians
float skyline(float az, float seed, float freq) {
  vec2 p = vec2(cos(az), sin(az)) * freq + seed; float s = 0.0, a = 0.55, w = 0.0;
  for (int i = 0; i < 5; i++) { s += a * ridged(p); w += a; p = p * 2.11 + vec2(3.1, 1.7); a *= 0.42; }
  return s / w;
}
void main() {
  vec4 a = u_invVP * vec4(v_ndc, 1.0, 1.0); vec3 d = normalize(a.xyz / a.w - u_camPos);
  vec3 c = skyColor(d);
  float mu = dot(d, u_sunDir);
  c += u_sunCol * 40.0 * smoothstep(0.99965, 0.99985, mu) * (1.0 - u_night);           // sun disc
  if (u_night > 0.01) {                                                                   // stars and moon
    vec3 q = floor(d * 400.0); float s = step(0.9975, hash13(q)) * clamp(d.y * 3.0, 0.0, 1.0);
    c += vec3(0.9, 0.95, 1.0) * s * u_night * 1.6;
    vec3 moon = normalize(vec3(-u_sunDir.x, abs(u_sunDir.y) + 0.15, -u_sunDir.z));
    c += vec3(0.8, 0.85, 1.0) * smoothstep(0.9993, 0.9996, dot(d, moon)) * u_night * 3.0;
  }
  if (d.y > 0.0) {                                                                        // a cloud deck at 1.6 km
    vec2 uv = d.xz / (d.y + 0.08) * 1.6 + vec2(u_time * 0.004, u_time * 0.0015);
    float n = fbm(uv * 0.9) * 0.65 + fbm(uv * 2.7 + 3.1) * 0.35;
    float cov = mix(0.54, 0.42, u_season.w + u_season.x * 0.5);
    float dens = smoothstep(cov, cov + 0.22, n) * smoothstep(0.0, 0.18, d.y);
    vec3 lit = mix(vec3(0.62, 0.66, 0.74), vec3(1.0), clamp(u_sunDir.y * 3.0, 0.0, 1.0)) * (0.35 + 0.9 * max(u_sunCol.r, 0.0) / 3.0);
    vec3 cc = mix(lit * 0.5, lit, smoothstep(0.3, 1.0, n)) + u_sunCol * 0.14 * pow(max(mu, 0.0), 10.0);
    c = mix(c, cc * (1.0 - u_night * 0.85), dens * 0.9);
  }
  // three ranges around the valley, far to near: aerial perspective, sunlit faces, snow on the high peaks
  float az = atan(d.z, d.x), el = asin(clamp(d.y, -1.0, 1.0));
  vec3 horiz = normalize(vec3(d.x, 0.0, d.z) + 1e-5), tang = vec3(-horiz.z, 0.0, horiz.x);
  vec3 amb = ambient(vec3(0.0, 1.0, 0.0));
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float base = mix(0.03, -0.02, fk / 2.0), amp = mix(0.12, 0.045, fk / 2.0), freq = mix(2.2, 5.5, fk / 2.0), seed = 7.3 + fk * 19.1;
    float h = base + amp * skyline(az, seed, freq);
    if (el < h) {
      float dh = (base + amp * skyline(az + 0.012, seed, freq) - h) / 0.012;
      vec3 nrm = normalize(-horiz * 0.9 + vec3(0.0, 0.65, 0.0) - tang * clamp(dh * 4.0, -2.0, 2.0));
      float lit = 0.35 + 0.65 * max(dot(nrm, u_sunDir), 0.0);
      vec3 rockc = k == 0 ? vec3(0.22, 0.24, 0.28) : k == 1 ? vec3(0.14, 0.17, 0.16) : vec3(0.07, 0.10, 0.065);
      float depth = clamp((h - el) / amp, 0.0, 1.0);
      vec3 mc = rockc * (u_sunCol * lit * 0.55 + amb * 0.8) * mix(1.0, 0.8, depth);
      float snowLine = (k == 0 ? 0.52 : k == 1 ? 0.78 : 1.2) - u_season.w * 0.35 - u_snow * 0.3;
      float sn = smoothstep(snowLine, snowLine + 0.08, (h - base) / amp - depth * 0.6 + (vnoise(vec2(az * 60.0, el * 90.0)) - 0.5) * 0.12);
      mc = mix(mc, vec3(0.85, 0.88, 0.94) * (u_sunCol * (0.25 + lit * 0.5) + amb * 0.9), sn * (k == 2 ? u_snow : 1.0));
      float aerial = k == 0 ? 0.62 : k == 1 ? 0.42 : 0.22;
      c = mix(mc, skyColor(vec3(d.x, max(d.y, 0.0) + 0.01, d.z)), aerial * (1.0 - u_night * 0.4));
    }
  }
  o = vec4(c, 1.0);
}`;

/* ------------------------------------------------------------------ terrain */
export const TERRAIN_VS = HEADER + `
layout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_nrm; layout(location=2) in vec4 a_mat;
uniform mat4 u_vp; uniform vec3 u_origin; uniform vec3 u_ro;     // u_origin is relative to the render origin
out vec3 v_wpos; out vec3 v_rel; out vec3 v_nrm; out vec4 v_mat;
void main() { vec3 w = a_pos + u_origin; v_rel = w; v_wpos = w + u_ro; v_nrm = a_nrm; v_mat = a_mat; gl_Position = u_vp * vec4(w, 1.0); }`;
export const TERRAIN_FS = HEADER + COMMON + SHADOW + DETAIL + SCENE_OUT + `
in vec3 v_wpos; in vec3 v_rel; in vec3 v_nrm; in vec4 v_mat;
uniform vec4 u_hole;   // centre x, z, half-size, active
uniform float u_waterLevel; uniform float u_plantsR;
uniform sampler2D u_sward; uniform float u_world;   // the XPU's live meadow: rgb = mean species colour, a = cover
uniform sampler2D u_wear;                             // r = trampling by the herd, g = grazed lately, b = shrub canopy
// keeps the two strongest weights and their materials (no arrays indexed by variables: slow to compile on D3D)
void top2(float w, int i, inout float w1, inout int i1, inout float w2, inout int i2) { if (w > w1) { w2 = w1; i2 = i1; w1 = w; i1 = i; } else if (w > w2) { w2 = w; i2 = i; } }
// (the hole for the macro view is cut at the end of main: derivatives and loops after a discard are a pattern
// some Direct3D drivers handle badly, and here nothing is gained by leaving early)
void main() {
  vec3 n = normalize(v_nrm);
  vec2 p = v_wpos.xz;
  vec3 vrel = v_rel - u_camRel; float d = length(vrel), dEye = d * u_pxScale;
  vec2 mT = mDet(v_rel.xz), mgx = dFdx(mT), mgy = dFdy(mT);            // detail coordinates and their footprint (uniform control flow)
  // detail normal from noise, fading with the footprint
  float df = clamp(1.0 - dEye / 70.0, 0.0, 1.0);
  if (df > 0.0) { float e = 0.12, h0 = fbm3(p * 1.4), hx = fbm3((p + vec2(e, 0)) * 1.4), hz = fbm3((p + vec2(0, e)) * 1.4); n = normalize(n + vec3(h0 - hx, 0.0, h0 - hz) * 2.6 * df); }
  vec2 wuv = v_wpos.xz / u_world;
  vec4 sw = texture(u_sward, wuv), wr = texture(u_wear, wuv);
  float rock = v_mat.x, moist = v_mat.y;
  float slope = 1.0 - n.y, hw = v_wpos.y - u_waterLevel;
  float g1 = fbm(p * 0.31), g2 = fbm3(p * 2.9), macro = fbm3(p * 0.021);
  // materials as weights of continuous fields (no interpolated class indices, so no seams)
  vec3 soil = mix(vec3(0.14, 0.105, 0.075), vec3(0.22, 0.17, 0.115), g1) * (0.85 + 0.3 * g2);
  vec3 dry = mix(vec3(0.27, 0.23, 0.165), vec3(0.34, 0.29, 0.21), g2);
  vec3 sand = vec3(0.40, 0.36, 0.28) * (0.85 + 0.25 * fbm3(p * 5.0));
  vec3 mud = vec3(0.10, 0.085, 0.07);
  float strata = vnoise(vec2(v_wpos.y * 2.6, p.x * 0.05 + p.y * 0.05));
  vec3 rockc = mix(vec3(0.15, 0.145, 0.14), vec3(0.30, 0.285, 0.26), strata * 0.55 + g2 * 0.45);
  rockc *= 1.0 - 0.45 * df * (1.0 - smoothstep(0.3, 0.7, vnoise(vec2(v_wpos.y * 9.0, (p.x + p.y) * 0.4))));   // ledges and cracks along the strata, near by
  float wSand = smoothstep(0.85, 0.2, hw) * (1.0 - smoothstep(0.25, 0.5, slope));
  float wMud = smoothstep(0.80, 0.97, moist) * (1.0 - wSand);
  float wDry = smoothstep(0.42, 0.18, moist) * (1.0 - wSand);
  float wRock = smoothstep(0.40, 0.75, rock + slope * 0.75 + (g2 - 0.5) * 0.18);
  vec3 base = mix(soil, dry, wDry); base = mix(base, sand, wSand); base = mix(base, mud, wMud * 0.85);
  // turf under the live meadow: thatch and short green, tinted by the species alive in the cell
  float cover = smoothstep(0.03, 0.42, sw.a) * (1.0 - wSand * 0.9) * (1.0 - wRock);
  vec3 thatch = mix(vec3(0.13, 0.12, 0.06), vec3(0.22, 0.20, 0.10), g2);
  vec3 turf = mix(thatch, sw.rgb * vec3(0.5, 0.58, 0.42), 0.5 + 0.3 * g1);
  turf = mix(turf, vec3(0.30, 0.25, 0.13), u_season.z * 0.45 + u_season.w * 0.35);
  turf = mix(turf, turf * vec3(0.95, 0.86, 0.72), wr.g * 0.7);                       // grazed: shorter, browner
  base = mix(base, turf, cover);
  // the herd's trails (the valley's E3 trail field): trampled turf, then bare compacted soil
  float wear = clamp(wr.r + (fbm3(p * 0.8) - 0.5) * 0.3, 0.0, 1.0);
  vec3 path = mix(vec3(0.25, 0.20, 0.14), vec3(0.34, 0.28, 0.20), g2);
  base = mix(base, mix(base * vec3(0.9, 0.82, 0.7), path, smoothstep(0.55, 0.85, wear)), smoothstep(0.2, 0.55, wear) * (1.0 - wRock));
  // beyond the shrub radius, junipers and willows become a canopy tint
  base = mix(base, vec3(0.06, 0.10, 0.07) * (0.8 + 0.4 * g1), wr.b * 0.85 * smoothstep(u_plantsR * 0.75, u_plantsR, d));
  base = mix(base, rockc, wRock);
  base *= 0.86 + 0.28 * macro;
  // wet margins and snow
  base *= mix(1.0, 0.7, smoothstep(0.75, 1.0, moist) * (1.0 - wRock) * smoothstep(1.5, 0.2, hw));
  float snow = u_snow * smoothstep(0.55, 0.85, n.y + fbm3(p * 0.6) * 0.25) * smoothstep(-0.2, 0.4, hw);
  base = mix(base, vec3(0.80, 0.83, 0.88), snow);
  // close up: the baked material library, two strongest materials, up to five octaves, parallax near the lens
  float rough = 0.85, cav = 1.0;
  if (u_detail > 0.5 && dEye < 36.0) {
    float wNo = (1.0 - wRock) * (1.0 - snow);
    // meadow, dry, sand, mud, rock, snow, duff (under the shrubs), gravel (the trails): the library's layers 0 1 2 3 4 10 11 6
    float w1 = -1.0, w2 = -1.0; int i1 = 0, i2 = 1;
    top2(wNo * (1.0 - wDry) * (1.0 - wSand) * (1.0 - wMud) * (1.0 - wr.b * 0.6), 0, w1, i1, w2, i2); top2(wNo * wDry, 1, w1, i1, w2, i2);
    top2(wNo * wSand, 2, w1, i1, w2, i2); top2(wNo * wMud, 3, w1, i1, w2, i2); top2(wRock, 4, w1, i1, w2, i2); top2(snow, 10, w1, i1, w2, i2);
    top2(wNo * wr.b * 0.6, 11, w1, i1, w2, i2); top2(wNo * smoothstep(0.55, 0.85, wear), 6, w1, i1, w2, i2);
    float t = w2 / max(w1 + w2, 1e-4), fade = 1.0 - smoothstep(20.0, 36.0, dEye);
    vec2 m = mT; vec3 vdw = vrel / max(d, 1e-9);
    if (dEye < 4.0) m = parallax(i1, m, vdw, mgx, mgy, 5);
    Det A = matDetail(i1, m, mgx, mgy, 5, ivec2(0, 2)), B = matDetail(i2, m, mgx, mgy, 5, ivec2(0, 2));
    vec3 tint = mix(A.tint, B.tint, t); vec2 nxz = mix(A.nxz, B.nxz, t);
    base *= mix(vec3(1.0), clamp(tint, 0.0, 3.0), fade);
    n = normalize(n + vec3(nxz.x, 0.0, nxz.y) * fade);
    rough = mix(rough, mix(A.rough, B.rough, t), fade); cav = mix(1.0, mix(A.ao, B.ao, t), fade);
  }
  float sh = shadowAt(v_wpos, n);
  float ndl = max(dot(n, u_sunDir), 0.0);
  vec3 col = base * (u_sunCol * ndl * sh + ambient(n) * 0.62 * cav);
  vec3 vd = vrel / max(d, 1e-9), hlf = normalize(u_sunDir - vd);
  float wet = smoothstep(0.85, 1.0, moist) * smoothstep(1.0, 0.0, hw) + snow * 0.5;
  float gloss = max(wet, (1.0 - rough) * (1.0 - rough));
  col += u_sunCol * sh * pow(max(dot(n, hlf), 0.0), mix(12.0, 160.0, gloss)) * mix(0.015, 0.3, gloss);
  o = vec4(applyFog(col, v_wpos, vrel), 1.0);
  gbuf(base, 0.62 * cav, n, rough, 1u << 24);
  if (u_hole.w > 0.5 && abs(v_wpos.x - u_hole.x) < u_hole.z && abs(v_wpos.z - u_hole.y) < u_hole.z) discard;
}`;

/* ------------------------------------------------------------------ water */
export const WATER_VS = HEADER + `
layout(location=0) in vec2 a_xz; uniform mat4 u_vp; uniform vec3 u_origin; uniform float u_level; uniform vec3 u_ro; out vec3 v_wpos;
void main() { vec3 w = vec3(a_xz.x + u_origin.x, u_level, a_xz.y + u_origin.z); v_wpos = w + u_ro; gl_Position = u_vp * vec4(w, 1.0); }`;
export const WATER_FS = HEADER + COMMON + SHADOW + `
in vec3 v_wpos; out vec4 o;
uniform sampler2D u_depth; uniform vec2 u_viewport; uniform vec2 u_nearFar; uniform sampler2D u_scene; uniform float u_rev;
float linearDepth(float z) { float n = u_nearFar.x, f = u_nearFar.y; if (u_rev > 0.5) return n / max(z, 1e-30); return 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n)); }
void main() {
  vec2 uv = gl_FragCoord.xy / u_viewport;
  float sceneZ = linearDepth(texture(u_depth, uv).r), myZ = linearDepth(gl_FragCoord.z);
  if (sceneZ < myZ - 0.02) discard;                                            // the ground is in front of the water here
  float thick = max(sceneZ - myZ, 0.0);
  vec2 p = v_wpos.xz;
  float t = u_time;
  vec2 g = vec2(fbm(p * 0.35 + vec2(t * 0.05, t * 0.03)) - fbm(p * 0.35 + vec2(0.31, 0) + vec2(t * 0.05, t * 0.03)),
                fbm(p * 0.35 + vec2(t * 0.05, t * 0.03)) - fbm(p * 0.35 + vec2(0, 0.31) + vec2(t * 0.05, t * 0.03)));
  g += 0.5 * vec2(vnoise(p * 2.7 + t * 0.4) - vnoise(p * 2.7 + vec2(0.2, 0) + t * 0.4), vnoise(p * 2.7 - t * 0.35) - vnoise(p * 2.7 + vec2(0, 0.2) - t * 0.35));
  float far = clamp(length(v_wpos - u_camPos) / 220.0, 0.0, 1.0);
  vec3 n = normalize(vec3(g.x * mix(1.2, 0.35, far), 1.0, g.y * mix(1.2, 0.35, far)));
  vec3 vd = normalize(v_wpos - u_camPos);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-vd, n), 0.0), 5.0);
  vec3 refl = skyColor(reflect(vd, n));
  vec3 below = texture(u_scene, uv + n.xz * 0.012 * clamp(thick, 0.0, 1.0)).rgb;
  vec3 deep = vec3(0.015, 0.05, 0.06), shallow = vec3(0.08, 0.16, 0.13);
  vec3 absorb = mix(shallow, deep, clamp(thick / 4.0, 0.0, 1.0));
  vec3 under = mix(below, absorb * (ambient(vec3(0, 1, 0)) + u_sunCol * 0.12), clamp(thick / 2.5, 0.15, 0.92));
  float sh = shadowAt(v_wpos, vec3(0, 1, 0));
  vec3 col = mix(under, refl, fres) + u_sunCol * sh * pow(max(dot(reflect(vd, n), u_sunDir), 0.0), 220.0) * 1.5;
  col = mix(col, vec3(0.62, 0.66, 0.66) * (ambient(vec3(0, 1, 0)) + u_sunCol * 0.3), smoothstep(0.22, 0.0, thick) * 0.3 * (1.0 - far));  // shore foam
  o = vec4(applyFog(col, v_wpos, v_wpos - u_camPos), 1.0);
}`;

/* ------------------------------------------------------------------ grass and flowers: instanced clumps of blades */
// Each instance is a clump of up to six blades in one triangle strip (nine vertices per blade: a
// degenerate lead-in, three segments, the tip, a degenerate lead-out). Distant clumps keep fewer, wider
// blades. Species, stubble and trampling come from the XPU's cells.
export const GRASS_BLADES = 6, GRASS_VPB = 9;
export const GRASS_VS = HEADER + COMMON + `
uniform mat4 u_vp;
uniform vec4 u_grid;                         // centre x, z, clump spacing, clumps per side
uniform float u_radius; uniform float u_cellM; uniform float u_world;
uniform highp usampler2D u_veg;              // per cell: r alive, g cropped lately, b ages (4 bits a species), a generation stamp
uniform sampler2D u_wear;                    // per cell (filtered): r trampling
uniform sampler2D u_hgt; uniform vec4 u_hgtRect;   // fine ring heights: x0, z0, spacing, size
uniform sampler2D u_hgt2; uniform vec4 u_hgtRect2; // the next ring out
uniform vec4 u_spH; uniform vec4 u_spH2;     // blade heights for species 0..7
uniform float u_lens;                        // 1: no blades across the lens (third person); 0: macro, blades stay
out vec3 v_col; out vec3 v_nrm; out vec3 v_wpos; out vec3 v_rel; out float v_t; out vec2 v_bl; out vec3 v_side;
float ground(vec2 xz) {
  vec2 f = (xz - u_hgtRect.xy) / u_hgtRect.z; float s = u_hgtRect.w;
  if (f.x < 0.0 || f.y < 0.0 || f.x > s - 2.0 || f.y > s - 2.0) {
    vec2 f2 = (xz - u_hgtRect2.xy) / u_hgtRect2.z; vec2 i2 = floor(f2), t2 = f2 - i2; ivec2 b = clamp(ivec2(i2), ivec2(0), ivec2(int(u_hgtRect2.w) - 2));
    return mix(mix(texelFetch(u_hgt2, b, 0).r, texelFetch(u_hgt2, b + ivec2(1, 0), 0).r, t2.x), mix(texelFetch(u_hgt2, b + ivec2(0, 1), 0).r, texelFetch(u_hgt2, b + ivec2(1, 1), 0).r, t2.x), t2.y);
  }
  vec2 i = floor(f), t = f - i; ivec2 a = ivec2(i);
  float h00 = texelFetch(u_hgt, a, 0).r, h10 = texelFetch(u_hgt, a + ivec2(1, 0), 0).r, h01 = texelFetch(u_hgt, a + ivec2(0, 1), 0).r, h11 = texelFetch(u_hgt, a + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
}
const vec3 BASE[8] = vec3[8](vec3(0.13,0.22,0.07), vec3(0.11,0.20,0.10), vec3(0.20,0.21,0.09), vec3(0.11,0.19,0.08), vec3(0.13,0.20,0.08), vec3(0.10,0.18,0.08), vec3(0.15,0.22,0.10), vec3(0.08,0.15,0.09));
const vec3 TIP[8]  = vec3[8](vec3(0.30,0.44,0.16), vec3(0.30,0.44,0.29), vec3(0.52,0.49,0.25), vec3(0.28,0.40,0.18), vec3(0.28,0.38,0.16), vec3(0.22,0.36,0.16), vec3(0.42,0.50,0.26), vec3(0.18,0.32,0.22));
const vec3 FLOWER[8] = vec3[8](vec3(0.92,0.72,0.82), vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.78,0.16,0.48), vec3(0.16,0.20,0.55), vec3(0.0), vec3(0.0));
const float WIDTH[8] = float[8](0.030, 0.011, 0.010, 0.014, 0.020, 0.034, 0.012, 0.012);
void main() {
  int b = gl_VertexID / 9, k = clamp(gl_VertexID - b * 9 - 1, 0, 6);
  int N = int(u_grid.w), id = gl_InstanceID, gx = id % N, gz = id / N;
  vec2 cellIdx = vec2(gx, gz) - float(N / 2) + floor(u_grid.xy / u_grid.z);
  vec2 cxz = (cellIdx + vec2(hash12(cellIdx * 1.17 + 3.1), hash12(cellIdx * 0.73 + 11.7))) * u_grid.z;
  float dist = length(cxz - u_camPos.xz) * u_pxScale;
  ivec2 cell = ivec2(floor(cxz / u_cellM)) & 127;
  uvec4 vg = texelFetch(u_veg, cell, 0);
  uint mask = vg.r, cropped = vg.g;
  float gen = float(vg.a & 65535u) * 0.0137;                                  // the cell's generation: new plants, new shapes
  float r3 = hash12(cellIdx * 2.31 + 5.5);
  int sp = -1; float stub = 1.0;
  uint pool = mask != 0u ? mask : cropped;
  if (pool != 0u) {
    int cnt = 0; for (int q = 0; q < 8; q++) if ((pool & (1u << uint(q))) != 0u) cnt++;
    int pick = int(r3 * float(cnt)) % cnt, seen = 0;
    for (int q = 0; q < 8; q++) if ((pool & (1u << uint(q))) != 0u) { if (seen == pick) { sp = q; break; } seen++; }
    if (mask == 0u) stub = 0.2;                                               // cropped: stubble regrowing from the rootstock
  }
  float wear = texture(u_wear, cxz / u_world).r;
  float fade = 1.0 - smoothstep(u_radius * 0.72, u_radius, dist);
  int nb = dist < u_radius * 0.3 ? 6 : dist < u_radius * 0.55 ? 4 : 2;
  float hs = sp < 0 ? 0.0 : (sp < 4 ? u_spH[sp] : u_spH2[sp - 4]);
  float age = sp < 0 ? 15.0 : float((vg.b >> uint(4 * sp)) & 15u);
  hs *= min(1.0, (age + 1.5) / 5.0);                                          // a new generation sprouts and grows for a few epochs
  hs *= stub * fade * (1.0 - smoothstep(0.35, 0.9, wear) * 0.7) * (1.0 - u_snow * 0.65) * (1.0 - u_season.w * 0.35);
  // this blade
  float fb = float(b) + gen, hb = hash12(cellIdx * 3.7 + fb * 1.31), hb2 = hash12(cellIdx * 5.1 + fb * 2.77), hb3 = hash12(cellIdx * 9.3 + fb * 0.61);
  bool flower = b == 0 && (sp == 0 || sp == 4 || sp == 5) && hb > 0.25;
  float ang = hb * 6.2831, rad = (sp == 0 || sp == 5 ? 0.12 : 0.075) * sqrt(hb2) * (flower ? 0.3 : 1.0);
  vec2 bxz = cxz + vec2(cos(ang), sin(ang)) * rad;
  float hgt = hs * (0.55 + 0.6 * hb3) * (flower ? (sp == 4 ? 1.2 : 1.45) : 1.0);
  float yaw = hb2 * 6.2831 + hb3 * 2.0;
  vec2 dir = vec2(cos(yaw), sin(yaw)), side = vec2(-dir.y, dir.x);
  vec2 outw = rad > 0.002 ? (bxz - cxz) / rad : dir;
  float w = (sp < 0 ? 0.0 : WIDTH[sp]) * (0.75 + 0.5 * hb) * (nb == 6 ? 1.0 : nb == 4 ? 1.3 : 2.0) * (flower ? 0.7 : 1.0);
  float sd = k == 6 ? 0.0 : (k % 2 == 0 ? -1.0 : 1.0), t = k == 6 ? 1.0 : float(k / 2) / 3.0;
  float gust = sin(u_time * 1.7 + bxz.x * 0.23 + bxz.y * 0.19) * 0.45 + (vnoise(bxz * 0.06 + vec2(u_time * 0.21, u_time * 0.13)) - 0.5) * 1.7;
  float bend = (0.15 + 0.55 * hb) * (sp == 0 || sp == 5 ? 0.6 : 1.0) + smoothstep(0.3, 0.8, wear) * 0.8;
  vec2 lean = (outw * bend + vec2(0.8, 0.45) * gust * 0.35) * t * t * hgt;
  float droop = min(1.0, length(lean) / max(hgt, 1e-3));
  vec2 bR = bxz - u_ro.xz;                                                    // relative to the render origin: exact, then the blade's own offsets
  vec3 w3 = vec3(bR.x + side.x * sd * w * (1.0 - t * 0.9) + lean.x, ground(bxz) - u_ro.y + hgt * t * (1.0 - 0.3 * droop * droop), bR.y + side.y * sd * w * (1.0 - t * 0.9) + lean.y);
  float near = u_lens > 0.5 ? smoothstep(0.7, 2.4, length(bxz - u_camPos.xz) + max(u_camPos.y - ground(bxz) - 1.5, 0.0)) : 1.0;   // no blades across the lens
  if (hgt * near < 0.006 || b >= nb) w3 = vec3(0.0, -10000.0, 0.0);
  v_bl = vec2(sd * w * (1.0 - t * 0.9), hgt * t); v_side = vec3(side.x, 0.0, side.y);
  // colour: dark shaded base, lighter tip; some dry blades; flower heads on one stem
  vec3 tipc = sp < 0 ? vec3(0) : TIP[sp], basec = sp < 0 ? vec3(0) : BASE[sp];
  vec3 c = mix(basec, tipc, pow(t, 0.8)) * (0.82 + 0.36 * hb3);
  if (hb2 > 0.9) c = mix(c, vec3(0.42, 0.36, 0.22), 0.7 * t + 0.2);                             // a dead blade
  c = mix(c, vec3(0.58, 0.48, 0.27) * (0.8 + 0.4 * r3), u_season.z * 0.6 * (0.4 + 0.6 * t));   // autumn
  c = mix(c, vec3(0.40, 0.35, 0.26), u_season.w * 0.65);                                       // winter
  if (flower && u_season.w < 0.5) { float bloom = clamp(u_season.x + u_season.y * (sp == 4 ? 1.0 : 0.6) + u_season.z * (sp == 5 ? 1.0 : 0.0), 0.0, 1.0);
    c = mix(c, FLOWER[sp] * (0.8 + 0.3 * hb3), bloom * smoothstep(sp == 4 ? 0.72 : 0.8, sp == 4 ? 0.8 : 0.88, t)); }
  c = mix(c, vec3(0.86, 0.88, 0.93), u_snow * t);
  v_col = c; v_t = t; v_rel = w3; v_wpos = w3 + u_ro;
  v_nrm = normalize(vec3(dir.x, 0.0, dir.y) * (0.9 - 0.5 * t) + vec3(0.0, 0.7 + 0.3 * t, 0.0));
  gl_Position = u_vp * vec4(w3, 1.0);
}`;
export const GRASS_FS = HEADER + COMMON + SHADOW + DETAIL + SCENE_OUT + `
in vec3 v_col; in vec3 v_nrm; in vec3 v_wpos; in vec3 v_rel; in float v_t; in vec2 v_bl; in vec3 v_side;
void main() {
  vec3 n = normalize(v_nrm); vec2 bgx = dFdx(v_bl), bgy = dFdy(v_bl);
  vec3 vrel = v_rel - u_camRel; float dist = length(vrel);
  vec3 alb = v_col;
  if (dist < 2.0) {                                                              // close up: the blade's veins and cells
    Det D = matDetail(15, v_bl, bgx, bgy, 3, ivec2(-1)); float f = 1.0 - smoothstep(0.8, 2.0, dist);
    alb *= mix(vec3(1.0), clamp(D.tint, 0.4, 2.0), f); n = normalize(n + (v_side * D.nxz.x + vec3(0.0, D.nxz.y, 0.0)) * f);
  }
  float sh = shadowAt(v_wpos, vec3(0, 1, 0));
  vec3 vd = vrel / max(dist, 1e-9);
  float ndl = max(dot(n, u_sunDir), 0.0) * 0.75 + 0.25 * max(u_sunDir.y, 0.0);
  float trans = pow(max(dot(vd, u_sunDir), 0.0), 3.0) * v_t * 0.9;
  float ao = mix(0.3, 1.0, smoothstep(0.0, 0.75, v_t));
  float spec = pow(max(dot(n, normalize(u_sunDir - vd)), 0.0), 24.0) * 0.1 * v_t;
  vec3 col = alb * (u_sunCol * (ndl + trans) * sh + ambient(n) * 0.7) * ao + u_sunCol * sh * spec;
  o = vec4(applyFog(col, v_wpos, vrel), 1.0);
  gbuf(alb, 0.7 * ao, n, 0.6, 2u << 24);
}`;

/* ------------------------------------------------------------------ shrubs and trees, generated in the vertex shader */
// A plant is an instance: position and yaw, then (seed, height, vigour, canopy). The templates carry only
// topology: wood vertices are (branch, along, around), leaf vertices (card, corner). branch() turns the seed
// into each plant's own trunk and limbs, and the cards are placed on them, so every plant is unique.
export const PLANT_VS = HEADER + COMMON + `
layout(location=0) in vec3 a_t;
layout(location=5) in vec4 i_pos;   // x, y, z, yaw
layout(location=6) in vec4 i_shape; // seed 0..1, maturity 0..1 (the continuum's s), vigour 0..1, dormancy 0..1
uniform mat4 u_vp; uniform vec3 u_origin; uniform int u_kind; uniform int u_part; uniform vec4 u_autumn; uniform float u_cards;   // u_origin is relative to the render origin
out vec3 v_col; out vec3 v_nrm; out vec3 v_wpos; out vec3 v_rel; out vec2 v_uv; out float v_card; out float v_aut; out float v_snow;
out vec2 v_loc; out vec3 v_tan; flat out int v_inst;                   // bark or leaf coordinates in metres, and the direction along them
const vec3 UP = vec3(0.0, 1.0, 0.0);
float R(float k) { return hash12(vec2(i_shape.x * 811.31 + k * 0.7317, k * 1.2731 + i_shape.x * 97.13)); }
vec3 bez(vec3 a, vec3 b, vec3 c, float t) { float u = 1.0 - t; return u * u * a + 2.0 * u * t * b + t * t * c; }
vec3 bezd(vec3 a, vec3 b, vec3 c, float t) { return 2.0 * (1.0 - t) * (b - a) + 2.0 * t * (c - b); }
// the class's form (valley3d_forms.js): dimension k = mix(min, max, s^e) for this plant's maturity s
uniform vec3 u_form[7];   // height, trunk radius, crown/height, limbs, lean, foliage, dead wood
float formV(int k) { vec3 f = u_form[k]; return mix(f.x, f.y, pow(clamp(i_shape.y, 0.0, 1.0), f.z)); }
float plantH() { return formV(0) * (0.85 + 0.3 * R(77.0)); }
bool deadLimb(float k) { return k >= 0.0 && R(700.0 + k) < formV(6); }
void stem(float p, float H, out vec3 A, out vec3 B, out vec3 C) {     // willow stem p
  float az = p / 7.0 * 6.2832 + R(10.0 + p) * 0.8, lean = 0.22 + 0.32 * R(20.0 + p), h = H * (0.72 + 0.28 * R(30.0 + p));
  vec3 d = vec3(cos(az), 0.0, sin(az));
  A = d * 0.05; B = d * lean * h * 0.35 + UP * h * 0.55; C = d * lean * h * 0.95 + UP * h * (0.93 - 0.12 * R(40.0 + p));
}
void branch(int b, out vec3 A, out vec3 B, out vec3 C, out float r0, out float r1) {
  float H = plantH(), vg = i_shape.z, fb = float(b), nl = floor(formV(3) + 0.5);
  if (u_kind == 0) {                          // juniper: a leaning leader and upswept whorls, golden-angle spaced
    float la = R(1.0) * 6.2832, lean = formV(4) * (0.6 + 0.8 * R(2.0));
    vec3 tB = vec3(cos(la + 1.7) * 0.06 * H, 0.52 * H, sin(la + 1.7) * 0.06 * H), tC = vec3(cos(la) * lean * H, H, sin(la) * lean * H);
    float tr = formV(1) * (0.8 + 0.4 * vg);
    if (b == 0) { A = vec3(0.0); B = tB; C = tC; r0 = tr; r1 = 0.006 + 0.012 * i_shape.y; return; }
    float k = fb - 1.0, t = clamp(0.1 + 0.84 * (k + 0.55 * R(10.0 + fb)) / max(nl, 1.0), 0.05, 0.97);
    if (k >= nl) { A = B = C = vec3(0.0); r0 = r1 = 0.0; return; }
    vec3 at = bez(vec3(0.0), tB, tC, t);
    float az = k * 2.39996 + R(30.0 + fb) * 0.9, crown = H * formV(2) * (0.8 + 0.4 * R(3.0)) * pow(1.0 - t, 0.8) + 0.03 + 0.12 * i_shape.y;
    float len = crown * (0.75 + 0.5 * R(50.0 + fb)), lift = 0.25 + 0.45 * R(70.0 + fb);
    vec3 dir = vec3(cos(az), 0.0, sin(az));
    A = at; B = at + dir * len * 0.5 + UP * len * lift * 0.5; C = at + dir * len + UP * len * (lift - 0.15 * R(90.0 + fb));
    r0 = tr * (1.0 - t * 0.8) * 0.45; r1 = 0.006; return;
  }
  if (u_kind == 1) {                          // willow: arching stems from the base, twigs along the stems
    float ns = clamp(nl, 1.0, 7.0);
    if (b < 7) { if (fb >= ns) { A = B = C = vec3(0.0); r0 = r1 = 0.0; return; } stem(fb, H, A, B, C); r0 = formV(1) * (0.75 + 0.5 * vg); r1 = 0.004 + 0.003 * i_shape.y; return; }
    float p = mod(fb - 7.0, ns); vec3 sA, sB, sC; stem(p, H, sA, sB, sC);
    float t = 0.42 + 0.48 * R(60.0 + fb); vec3 at = bez(sA, sB, sC, t), tg = normalize(bezd(sA, sB, sC, t));
    float sa = R(65.0 + fb) * 6.2832; vec3 side = normalize(cross(tg, vec3(cos(sa), 0.3, sin(sa))) + 1e-4);
    float len = (0.3 + 0.45 * R(70.0 + fb)) * clamp(H / 3.0, 0.5, 1.4);
    A = at; B = at + normalize(tg + side) * len * 0.5 + UP * 0.08; C = at + normalize(tg * 0.6 + side) * len + UP * (0.12 - 0.25 * R(80.0 + fb));
    r0 = 0.012; r1 = 0.004; return;
  }
  float az = fb * 2.39996 + R(10.0 + fb), h = H * (0.6 + 0.4 * R(30.0 + fb)), lean = formV(4) * (0.6 + 0.8 * R(20.0 + fb));   // blueberry
  vec3 d = vec3(cos(az), 0.0, sin(az));
  if (fb >= nl) { A = B = C = vec3(0.0); r0 = r1 = 0.0; return; }
  A = d * 0.03; B = d * lean * h * 0.3 + UP * h * 0.6; C = d * lean * h + UP * h * (0.85 - 0.2 * R(40.0 + fb));
  r0 = formV(1); r1 = 0.002;
}
void main() {
  float H = plantH(), dist = length(i_pos.xz + u_origin.xz - u_camRel.xz) * u_pxScale, nl = floor(formV(3) + 0.5);
  vec3 A, B, C, p, nrm, tng; float r0, r1;
  if (u_part == 1) {                          // a leaf card
    float fk = a_t.x; int corner = int(a_t.y + 0.5), host; float t;
    float keep = clamp(1.25 - dist / 95.0, 0.3, 1.0);
    float young = 0.3 + 0.7 * smoothstep(0.0, 0.6, i_shape.y);                    // a young plant carries fewer sprays
    if (fk >= u_cards * keep * young) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); v_card = 1.0; return; }  // fewer, larger cards far away
    if (u_kind == 0) { host = R(200.0 + fk) < 0.12 ? 0 : 1 + int(mod(fk, max(nl, 1.0))); t = host == 0 ? 0.72 + 0.28 * R(210.0 + fk) : 0.3 + 0.7 * R(210.0 + fk); }
    else if (u_kind == 1) { float ns = clamp(nl, 1.0, 7.0); host = R(220.0 + fk) < 0.4 ? int(mod(fk, ns)) : 7 + int(mod(fk, 11.0)); t = host < 7 ? 0.4 + 0.6 * R(210.0 + fk) : 0.2 + 0.8 * R(210.0 + fk); }
    else { host = int(mod(fk, max(nl, 1.0))); t = 0.35 + 0.65 * R(210.0 + fk); }
    if (u_kind == 0 && host > 0 && deadLimb(float(host - 1))) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); v_card = 1.0; return; }   // dead limbs carry no foliage
    branch(host, A, B, C, r0, r1);
    vec3 ctr = bez(A, B, C, t) + (vec3(R(220.0 + fk), R(230.0 + fk), R(240.0 + fk)) - 0.5) * (u_kind == 2 ? 0.08 : 0.32);
    float size = (u_kind == 0 ? 0.55 + 0.4 * R(300.0 + fk) : u_kind == 1 ? 0.42 + 0.3 * R(300.0 + fk) : 0.15 + 0.1 * R(300.0 + fk))
               * formV(5) / sqrt(keep);
    vec3 crownC = vec3(0.0, H * 0.55, 0.0), rel = ctr - crownC;
    vec3 outw = normalize(vec3(rel.x, rel.y * 0.5 + 0.25, rel.z) + 1e-4);
    vec3 rnd = normalize(vec3(R(400.0 + fk), R(410.0 + fk), R(420.0 + fk)) - 0.5 + 1e-4);
    vec3 N = normalize(outw * 0.8 + rnd * 0.7 + (u_kind == 1 ? vec3(0.0, -0.35, 0.0) : vec3(0.0)));
    vec3 U = normalize(cross(N, abs(N.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : UP)), V = cross(N, U);
    vec2 cc = vec2(corner == 1 || corner == 2 ? 0.5 : -0.5, corner >= 2 ? 0.5 : -0.5);
    float flutter = sin(u_time * (5.0 + 3.0 * R(450.0 + fk)) + fk) * 0.03 * (cc.y + 0.5);
    p = ctr + (U * cc.x + V * (cc.y + flutter)) * size;
    nrm = normalize(mix(N, normalize(rel + vec3(0.0, 0.001, 0.0)), 0.65)); tng = V; v_loc = (cc + 0.5) * size;
    float tile = u_kind == 0 ? 1.0 : u_kind == 1 ? (R(500.0 + fk) < 0.5 ? 0.0 : 3.0) : 2.0;
    float fu = R(510.0 + fk) < 0.5 ? 0.5 - cc.x : cc.x + 0.5;
    v_uv = vec2(mod(tile, 2.0), floor(tile / 2.0)) * 0.5 + 0.004 + vec2(fu, 0.5 - cc.y) * 0.492;
    float crownR = H * (u_kind == 0 ? 0.3 : u_kind == 1 ? 0.45 : 0.6) + 0.2;
    float ao = clamp(0.45 + 0.6 * length(rel / vec3(crownR, H * 0.5 + 0.1, crownR)), 0.45, 1.0);
    v_col = vec3((0.86 + 0.28 * R(600.0 + fk)) * (1.0 - 0.35 * i_shape.w), max(R(610.0 + fk), i_shape.w > 0.0 ? 1.0 - i_shape.w * 0.9 : 0.0) * (i_shape.w > 0.0 ? -1.0 : 1.0), ao); v_card = 1.0;
    v_aut = u_season.z * u_autumn.a * (0.5 + 0.5 * R(620.0 + fk)); v_snow = u_snow * smoothstep(0.1, 0.9, N.y) * 0.7;
  } else {                                    // wood: a tube around the branch curve
    int b = int(a_t.x + 0.5); float s = a_t.y, th = a_t.z * 6.2832;
    branch(b, A, B, C, r0, r1);
    bool minor = (u_kind == 0 && b > 7) || (u_kind == 1 && b >= 7) || (u_kind == 2 && b > 4);
    if (minor && dist > 55.0) { r0 = 0.0; r1 = 0.0; }
    vec3 ctr = bez(A, B, C, s), tg = normalize(bezd(A, B, C, max(s, 0.001)) + 1e-5);
    vec3 n1 = normalize(cross(tg, abs(tg.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : UP)), n2 = cross(n1, tg);
    nrm = cos(th) * n1 + sin(th) * n2;
    float rad = mix(r0, r1, pow(s, 0.85));
    p = ctr + nrm * rad * (1.0 + 0.12 * sin(th * 3.0 + s * 9.0));
    tng = tg; v_loc = vec2(a_t.z * 6.2832 * rad, s * (length(B - A) + length(C - B)));
    vec3 bark = u_kind == 0 ? vec3(0.30, 0.21, 0.15) : u_kind == 1 ? mix(vec3(0.40, 0.31, 0.20), R(7.0) < 0.5 ? vec3(0.50, 0.44, 0.22) : vec3(0.44, 0.20, 0.12), s * 0.8) : vec3(0.36, 0.20, 0.13);
    if (u_kind == 0 && b > 0 && deadLimb(float(b - 1))) bark = vec3(0.56, 0.54, 0.50);                // weathered silver dead wood
    v_col = bark * (0.75 + 0.5 * vnoise(vec2(th * 1.6, s * 14.0 + float(b) * 3.1))); v_card = 0.0; v_uv = vec2(0.0); v_aut = 0.0; v_snow = u_snow * smoothstep(0.3, 0.9, nrm.y) * 0.6;
  }
  // wind: stiff junipers, supple willows; sway grows with the square of height
  float h01 = clamp(p.y / max(H, 0.1), 0.0, 1.2), amp = (u_kind == 0 ? 0.025 : u_kind == 1 ? 0.07 : 0.04) * H;
  vec2 gust = vec2(0.8, 0.45) * (sin(u_time * 1.2 + i_shape.x * 40.0) * 0.6 + (vnoise(i_pos.xz * 0.03 + u_time * 0.18) - 0.5) * 1.6);
  p.xz += gust * amp * h01 * h01;
  float c = cos(i_pos.w), sn = sin(i_pos.w);
  vec3 at = i_pos.xyz + u_origin, w = at + vec3(c * p.x - sn * p.z, p.y, sn * p.x + c * p.z);
  v_rel = w; v_wpos = w + u_ro; v_nrm = vec3(c * nrm.x - sn * nrm.z, nrm.y, sn * nrm.x + c * nrm.z);
  v_tan = vec3(c * tng.x - sn * tng.z, tng.y, sn * tng.x + c * tng.z); v_inst = gl_InstanceID;
  gl_Position = u_vp * vec4(w, 1.0);
}`;
export const PLANT_FS = HEADER + COMMON + SHADOW + DETAIL + SCENE_OUT + `
in vec3 v_col; in vec3 v_nrm; in vec3 v_wpos; in vec3 v_rel; in vec2 v_uv; in float v_card; in float v_aut; in float v_snow;
in vec2 v_loc; in vec3 v_tan; flat in int v_inst;
uniform sampler2D u_leaf; uniform float u_leafLoss; uniform vec4 u_autumn; uniform int u_kind;
void main() {
  vec3 n = normalize(v_nrm), albedo = v_col; float card = v_card, ao = 1.0;
  vec2 lgx = dFdx(v_loc), lgy = dFdy(v_loc); vec3 vrel = v_rel - u_camRel; float dist = length(vrel);
  if (card > 0.5) {
    vec4 t = texture(u_leaf, v_uv);
    vec2 sz = vec2(textureSize(u_leaf, 0)), dx = dFdx(v_uv * sz), dy = dFdy(v_uv * sz);
    float lod = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    float keep = abs(v_col.y);                                                   // a dormant plant's cards carry a negative mark and thin out
    if (t.a * (1.0 + lod * 0.3) < 0.5 || keep < u_leafLoss || (v_col.y < 0.0 && fract(keep * 7.31) < 0.6 * (1.0 - keep))) discard;
    albedo = t.rgb * v_col.x; ao = v_col.z;
    if (v_col.y < 0.0) albedo = mix(albedo, vec3(0.32, 0.24, 0.12), 0.6 * (1.0 - keep));
  } else if (!gl_FrontFacing) n = -n;
  if (dist < 6.0) {                                                              // close up: bark fissures, or a leaf's veins and cells
    int L = card > 0.5 ? 15 : u_kind == 0 ? 12 : u_kind == 1 ? 13 : 14;
    Det D = matDetail(L, v_loc, lgx, lgy, card > 0.5 ? 3 : 4, ivec2(-1)); float f = 1.0 - smoothstep(3.0, 6.0, dist);
    vec3 t = normalize(v_tan - n * dot(v_tan, n)), bt = cross(n, t);
    albedo *= mix(vec3(1.0), clamp(D.tint, 0.3, 2.5), f); n = normalize(n + (bt * D.nxz.x + t * D.nxz.y) * f); ao *= mix(1.0, D.ao, f);
  }
  albedo = mix(albedo, u_autumn.rgb * (0.55 + 1.3 * dot(albedo, vec3(0.3, 0.6, 0.1))), v_aut);
  albedo = mix(albedo, vec3(0.84, 0.86, 0.9), v_snow);
  float sh = shadowAt(v_wpos, n);
  vec3 vd = vrel / max(dist, 1e-9);
  float ndl = max(dot(n, u_sunDir), 0.0), wrap = max(dot(n, u_sunDir) * 0.55 + 0.45, 0.0);
  float back = card * pow(max(dot(vd, u_sunDir), 0.0), 4.0) * 0.55;                    // light through the leaves
  vec3 col = albedo * (u_sunCol * (mix(ndl, wrap, card * 0.7) + back) * sh * mix(0.6, 1.0, ao) + ambient(n) * 0.7 * ao);
  col += u_sunCol * sh * pow(max(dot(n, normalize(u_sunDir - vd)), 0.0), 30.0) * 0.04 * (1.0 - card);
  o = vec4(applyFog(col, v_wpos, vrel), 1.0);
  gbuf(albedo, 0.7 * ao, n, card > 0.5 ? 0.5 : 0.85, (3u << 24) | (uint(v_inst & 65535) << 8) | uint(u_kind));
}`;
export const PLANT_DEPTH_FS = HEADER + `
in vec3 v_col; in vec2 v_uv; in float v_card; out vec4 o; uniform sampler2D u_leaf; uniform float u_leafLoss;
void main() { if (v_card > 0.5 && (texture(u_leaf, v_uv).a < 0.5 || abs(v_col.y) < u_leafLoss)) discard; o = vec4(1.0); }`;

/* ------------------------------------------------------------------ boulders, displaced from a unit icosphere by each one's seed */
export const ROCK_VS = HEADER + COMMON + `
layout(location=0) in vec3 a_dir;
layout(location=5) in vec4 i_pos;   // x, y, z, yaw
layout(location=6) in vec4 i_shape; // seed, radius m, flatness, moss
uniform mat4 u_vp; uniform vec3 u_origin;   // relative to the render origin
uniform vec3 u_rform[6];                     // the class's form: radius, lumps, fracture, flatness, moss, burial (min, max, exponent)
out vec3 v_col; out vec3 v_nrm; out vec3 v_wpos; out vec3 v_rel; out vec3 v_lpos; out float v_moss;
float g_lumps, g_frac;
float rformV(int k, float s) { vec3 f = u_rform[k]; return mix(f.x, f.y, pow(clamp(s, 0.0, 1.0), f.z)); }
float shape(vec3 d) {                                   // radius along a direction: lumps, facets and breaks by size
  float s = i_shape.x * 57.3, r = 1.0;
  r += g_lumps * (vnoise(d.xy * 1.7 + s) + vnoise(d.yz * 1.7 - s) + vnoise(d.zx * 1.7 + s * 0.5) - 1.5);
  r += g_lumps * 0.36 * (vnoise(d.xy * 4.3 - s) + vnoise(d.zx * 4.3 + s) - 1.0);
  vec3 f = normalize(vec3(hash12(vec2(s, 1.0)), hash12(vec2(s, 2.0)), hash12(vec2(s, 3.0))) - 0.5 + 1e-4);
  vec3 f2 = normalize(vec3(hash12(vec2(s, 4.0)), hash12(vec2(s, 5.0)), hash12(vec2(s, 6.0))) - 0.5 + 1e-4);
  r = mix(r, min(r, 0.82 / max(dot(d, f), 0.2)), g_frac);                               // a broken face
  r = mix(r, min(r, 0.88 / max(dot(d, f2), 0.2)), smoothstep(0.5, 1.0, g_frac));        // and a second on big stones
  return r;
}
void main() {
  float sr = clamp(log(max(i_shape.y, 0.005) / 0.04) / log(65.0), 0.0, 1.0);     // the size continuum: 4 cm pebble 0 .. 2.6 m boulder 1
  g_lumps = rformV(1, sr); g_frac = rformV(2, sr);
  float flat_ = mix(rformV(3, sr), i_shape.z, 0.5);
  vec3 d = normalize(a_dir); float r = shape(d);
  vec3 p = d * r * vec3(1.0, flat_, 1.0 + 0.3 * hash12(vec2(i_shape.x, 9.0)));
  vec3 e1 = normalize(cross(d, abs(d.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0))), e2 = cross(d, e1);
  vec3 pa = normalize(d + e1 * 0.05), pb = normalize(d + e2 * 0.05);
  vec3 qa = pa * shape(pa) * vec3(1.0, flat_, 1.0), qb = pb * shape(pb) * vec3(1.0, flat_, 1.0);
  vec3 n = normalize(cross(qa - p, qb - p)); if (dot(n, d) < 0.0) n = -n;
  float c = cos(i_pos.w), sn = sin(i_pos.w);
  p *= i_shape.y; p.y -= rformV(5, sr) * i_shape.y * flat_;                          // half buried when large
  vec3 at = i_pos.xyz + u_origin, w = at + vec3(c * p.x - sn * p.z, p.y, sn * p.x + c * p.z);
  v_rel = w; v_wpos = w + u_ro; v_nrm = vec3(c * n.x - sn * n.z, n.y, sn * n.x + c * n.z); v_lpos = d * r * 3.0 + i_shape.x * 13.0; v_moss = i_shape.w * rformV(4, sr);
  v_col = mix(vec3(0.36, 0.35, 0.33), vec3(0.47, 0.44, 0.40), hash12(vec2(i_shape.x, 5.0)));
  gl_Position = u_vp * vec4(w, 1.0);
}`;
export const ROCK_FS = HEADER + COMMON + SHADOW + DETAIL + SCENE_OUT + `
in vec3 v_col; in vec3 v_nrm; in vec3 v_wpos; in vec3 v_rel; in vec3 v_lpos; in float v_moss;
void main() {
  vec3 n = normalize(v_nrm), q = mDet3(v_rel), qx = dFdx(q), qy = dFdy(q);
  vec3 vrel = v_rel - u_camRel; float d = length(vrel);
  float g = vnoise(v_lpos.xy * 6.0) * 0.5 + vnoise(v_lpos.yz * 13.0) * 0.3 + vnoise(v_lpos.zx * 29.0) * 0.2;
  vec3 albedo = v_col * (0.7 + 0.55 * g);
  float lichen = smoothstep(0.62, 0.7, vnoise(v_lpos.xz * 9.0 + 3.0)) * 0.8;
  albedo = mix(albedo, vec3(0.62, 0.58, 0.38), lichen * 0.6);
  float moss = smoothstep(0.35, 0.8, n.y + (vnoise(v_lpos.xy * 4.0) - 0.5) * 0.6) * v_moss;
  float cav = 1.0, rough = 0.7;
  if (u_detail > 0.5 && d < 30.0) {                                             // triplanar granite, the library's moss where it grows
    float f = 1.0 - smoothstep(10.0, 30.0, d);
    Tri G = triDetail(4, q, qx, qy, n, 5, true);
    albedo = mix(albedo, v_col * G.tint * 0.95 * (0.85 + 0.3 * g), f); n = normalize(mix(n, G.n, f)); cav = mix(1.0, G.ao, f); rough = mix(rough, G.rough, f);
    if (moss > 0.05) { Det M = matDetail(8, q.xz, qx.xz, qy.xz, 4, ivec2(0, 2)); albedo = mix(albedo, vec3(0.16, 0.22, 0.09) * M.tint, moss * 0.85); }
    else albedo = mix(albedo, vec3(0.16, 0.22, 0.09), moss * 0.85);
  } else albedo = mix(albedo, vec3(0.16, 0.22, 0.09), moss * 0.85);
  albedo = mix(albedo, vec3(0.82, 0.84, 0.88), u_snow * smoothstep(0.4, 0.9, n.y));
  float sh = shadowAt(v_wpos, n), ndl = max(dot(n, u_sunDir), 0.0);
  vec3 vd = vrel / max(d, 1e-9);
  float ak = 0.65 * mix(0.6, 1.0, smoothstep(-0.4, 0.6, n.y)) * cav;
  vec3 col = albedo * (u_sunCol * ndl * sh + ambient(n) * ak);
  col += u_sunCol * sh * pow(max(dot(n, normalize(u_sunDir - vd)), 0.0), mix(60.0, 18.0, rough)) * mix(0.12, 0.04, rough);
  o = vec4(applyFog(col, v_wpos, vrel), 1.0);
  gbuf(albedo, ak, n, rough, 4u << 24);
}`;

// the coat's comb direction by bone, in the template's frame (x forward, y up): back along the body, down the
// neck and legs, down the tail, up the ears; projected onto the surface
export const FLOW = `
vec3 combDir(int b, vec3 nrm) {
  vec3 f = b <= 1 ? vec3(-1.0, -0.3, 0.0) : b == 2 ? vec3(-0.55, -0.85, 0.0) : b == 3 ? vec3(-1.0, -0.1, 0.0) : b == 4 ? vec3(-0.35, -1.0, 0.0) : b <= 16 ? vec3(0.05, -1.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = f - nrm * dot(f, nrm); return dot(t, t) < 1e-5 ? normalize(cross(nrm, vec3(0.0, 0.0, 1.0)) + 1e-4) : normalize(t);
}
`;
/* ------------------------------------------------------------------ animals (skinned, instanced) */
// Each instance carries its bone-texture row, a coat tint and eight numbers of its own coat and face
// (valley3d_morph.js); the fragment shader paints the patterns from them in the template's own space.
export const SKIN_VS = HEADER + COMMON + `
layout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_nrm; layout(location=2) in vec3 a_col; layout(location=3) in vec2 a_bone; layout(location=4) in vec2 a_w;
layout(location=5) in vec4 i_row;  // bone-texture row, tint r, g, b
layout(location=6) in vec4 i_c1; layout(location=7) in vec4 i_c2;
uniform mat4 u_vp; uniform sampler2D u_bones;                // bone matrices are relative to the render origin
uniform highp sampler2D u_dpos; uniform mediump sampler2D u_dnrm; uniform float u_forms;   // per vertex, per dimension: the extremes' difference
out vec3 v_col; out vec3 v_nrm; out vec3 v_wpos; out vec3 v_rel; out vec3 v_lpos; out vec3 v_lnrm; out vec3 v_tan; out vec3 v_mx; out vec3 v_my; out vec3 v_mz;
flat out int v_bone; flat out int v_row; flat out vec4 v_c1; flat out vec4 v_c2; flat out vec2 v_fade;
mat4 boneMat(int row, int b) { int x = b * 4; return mat4(texelFetch(u_bones, ivec2(x, row), 0), texelFetch(u_bones, ivec2(x + 1, row), 0), texelFetch(u_bones, ivec2(x + 2, row), 0), texelFetch(u_bones, ivec2(x + 3, row), 0)); }
` + FLOW + `
void main() {
  int row = int(i_row.x), bn = int(a_bone.x + 0.5);
  vec3 pos = a_pos, nrm = a_nrm;
  if (u_forms > 0.5) {                                        // P = P_base + sum_k (t_k - 1/2) dP_k, the same for normals
    vec4 q0 = texelFetch(u_bones, ivec2(84, row), 0), q1 = texelFetch(u_bones, ivec2(85, row), 0), q2 = texelFetch(u_bones, ivec2(86, row), 0), q3 = texelFetch(u_bones, ivec2(87, row), 0);
    float t[16] = float[16](q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w, q2.x, q2.y, q2.z, q2.w, q3.x, q3.y, q3.z, q3.w);
    int base = gl_VertexID * 16;
    for (int k = 0; k < 16; k++) {
      float wk = t[k] - 0.5; if (abs(wk) < 0.003) continue;
      int i = base + k; ivec2 c = ivec2(i & 4095, i >> 12);
      pos += wk * texelFetch(u_dpos, c, 0).xyz; nrm += wk * texelFetch(u_dnrm, c, 0).xyz;
    }
    nrm = normalize(nrm);
  }
  mat4 m = boneMat(row, int(a_bone.x)) * a_w.x + boneMat(row, int(a_bone.y)) * a_w.y;
  vec4 w = m * vec4(pos, 1.0); mat3 r = mat3(m);
  v_rel = w.xyz; v_wpos = w.xyz + u_ro; v_nrm = normalize(r * nrm); v_lpos = a_pos; v_lnrm = a_nrm; v_bone = bn; v_row = row;
  v_tan = normalize(r * combDir(bn, a_nrm)); v_mx = r[0]; v_my = r[1]; v_mz = r[2];
  v_col = a_col * i_row.yzw; v_c1 = i_c1; v_c2 = i_c2; v_fade = u_forms > 0.5 ? texelFetch(u_bones, ivec2(90, row), 0).xy : vec2(0.0);
  gl_Position = u_vp * w;
}`;
// antlers: a beam and up to five tines a side, computed from each buck's seed and carried by its head bone
export const ANTLER_VS = HEADER + COMMON + `
layout(location=0) in vec3 a_t;   // branch (0 left beam, 1 right beam, 2-6 left tines, 7-11 right tines), along, around
layout(location=5) in vec4 i_a;   // bone-texture row, seed, tines a side, size
layout(location=6) in vec4 i_b;   // velvet 0..1, spread, asymmetry, growth 0..1
uniform mat4 u_vp; uniform sampler2D u_bones; uniform vec3 u_head; uniform float u_forms;
out vec3 v_col; out vec3 v_nrm; out vec3 v_wpos; out vec3 v_rel; out vec3 v_lpos; out vec3 v_lnrm; out vec3 v_tan; out vec3 v_mx; out vec3 v_my; out vec3 v_mz;
flat out int v_bone; flat out int v_row; flat out vec4 v_c1; flat out vec4 v_c2; flat out vec2 v_fade;
mat4 boneMat(int row, int b) { int x = b * 4; return mat4(texelFetch(u_bones, ivec2(x, row), 0), texelFetch(u_bones, ivec2(x + 1, row), 0), texelFetch(u_bones, ivec2(x + 2, row), 0), texelFetch(u_bones, ivec2(x + 3, row), 0)); }
float R(float k) { return hash12(vec2(i_a.y * 613.7 + k * 0.913, k * 1.37 + i_a.y * 41.1)); }
vec3 bez(vec3 a, vec3 b, vec3 c, float t) { float u = 1.0 - t; return u * u * a + 2.0 * u * t * b + t * t * c; }
vec3 bezd(vec3 a, vec3 b, vec3 c, float t) { return 2.0 * (1.0 - t) * (b - a) + 2.0 * t * (c - b); }
void main() {
  int b = int(a_t.x + 0.5); float t = a_t.y, th = a_t.z * 6.2832;
  float side = (b == 0 || (b >= 2 && b <= 6)) ? 1.0 : -1.0, sz = i_a.w * i_b.w, asym = 1.0 + side * i_b.z;
  vec4 hj = texelFetch(u_bones, ivec2(88, int(i_a.x)), 0);
  vec3 head = u_forms > 0.5 ? hj.xyz : u_head;
  vec3 base = head + (u_forms > 0.5 ? vec3(0.05, 0.035, side * hj.w * 0.62) : vec3(0.03, 0.085, side * 0.045));
  vec3 A = base, B = base + vec3(-0.11, 0.21, side * 0.15 * i_b.y) * sz * asym, C = base + vec3(0.13 + 0.04 * R(1.0 + side), 0.27, side * 0.19 * i_b.y) * sz * asym;
  vec3 P0 = A, P1 = B, P2 = C; float r0 = 0.014 + 0.01 * sz, r1 = 0.006;
  if (b > 1) {
    float k = float(b <= 6 ? b - 2 : b - 7);
    if (k >= i_a.z) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
    float at = k == 0.0 ? 0.13 : 0.34 + 0.17 * (k - 1.0) + 0.05 * (R(k + side * 3.0) - 0.5);
    vec3 root = bez(A, B, C, at);
    float len = (k == 0.0 ? 0.07 : 0.11 + 0.06 * R(10.0 + k + side)) * sz * (1.0 - 0.12 * k);
    vec3 up = normalize(vec3(k == 0.0 ? 0.5 : 0.1 + 0.1 * R(30.0 + k), 1.0, -side * (0.08 + 0.1 * R(40.0 + k))));
    P0 = root; P1 = root + up * len * 0.55; P2 = root + up * len + vec3(0.025 * R(20.0 + k), 0.0, -side * 0.015);
    r0 = 0.007 + 0.006 * sz; r1 = 0.0025;
  }
  vec3 ctr = bez(P0, P1, P2, t), tg = normalize(bezd(P0, P1, P2, max(t, 0.001)) + 1e-5);
  vec3 n1 = normalize(cross(tg, abs(tg.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0))), n2 = cross(n1, tg), nrm = cos(th) * n1 + sin(th) * n2;
  vec3 p = ctr + nrm * mix(r0, r1, t) * (1.0 + 0.15 * sin(th * 2.0 + t * 20.0));
  mat4 M = boneMat(int(i_a.x), 3); vec4 w = M * vec4(p, 1.0); mat3 r = mat3(M);
  v_rel = w.xyz; v_wpos = w.xyz + u_ro; v_nrm = normalize(r * nrm); v_lpos = p; v_lnrm = nrm; v_tan = normalize(r * tg); v_mx = r[0]; v_my = r[1]; v_mz = r[2];
  v_bone = 99; v_row = int(i_a.x); v_c1 = vec4(0.0); v_c2 = vec4(0.0); v_fade = vec2(0.0);
  vec3 bone = mix(vec3(0.36, 0.27, 0.19), vec3(0.80, 0.74, 0.62), clamp(t * 0.85 + (b > 1 ? 0.25 : 0.0), 0.0, 1.0));
  v_col = mix(bone, vec3(0.32, 0.24, 0.18), i_b.x);                                  // velvet in summer, polished in the rut
  gl_Position = u_vp * w;
}`;
// the coat's patterns in the template's own space (valley3d_morph.js gives c1, c2 per animal)
export const COAT = `
// E21: a hexagonal grid code, three plane waves 60 degrees apart; its peaks are the spots
float gridCode(vec2 u, float th, float lam, vec2 ph) { float s = 0.0; for (int k = 0; k < 3; k++) { float a = th + float(k) * 2.0944; s += cos(6.2832 / lam * dot(u, vec2(cos(a), sin(a))) + 6.2832 * (k == 0 ? ph.x : k == 1 ? ph.y : ph.x + ph.y)); } return s; }
bool part(vec3 a, vec3 b) { return all(lessThan(abs(a - b), vec3(0.012))); }
uniform vec3 u_eye; uniform vec3 u_head; uniform vec3 u_nose; uniform vec4 u_land;   // landmarks: back top y, torso x from, to, throat y
vec3 coatColor(int kind, vec3 base, vec3 L, int bone, vec4 c1, vec4 c2, inout float fur, inout float spec) {
  if (kind == 0) {                          // deer: c1 = (dorsal, eye ring, throat, grey), c2 = (spot spacing, orientation, phase x, phase y)
    if (bone == 3) {
      float ring = 1.0 - smoothstep(0.022, 0.036, length(vec3(L.x, L.y, abs(L.z)) - u_eye));
      base = mix(base, vec3(0.86, 0.82, 0.74), ring * c1.y * 0.85);
      vec3 hd = normalize(u_nose - u_head); float along = dot(L - u_nose, hd);                           // metres behind the nose tip
      float band = smoothstep(-0.075, -0.06, along) * (1.0 - smoothstep(-0.045, -0.032, along));
      base = mix(base, vec3(0.88, 0.85, 0.80), band * 0.8);
      base = mix(base, vec3(0.86, 0.83, 0.78), smoothstep(-0.08, -0.03, along) * smoothstep(0.0, -0.03, dot(L - u_nose, vec3(-hd.y, hd.x, 0.0))) * 0.7);   // the white chin
      base = mix(base, vec3(0.62, 0.6, 0.57), c1.w * smoothstep(-0.16, -0.04, along) * 0.7);           // a greying muzzle
    }
    if (bone == 2 || bone == 3) { float t = 1.0 - smoothstep(0.0, 0.05 * c1.z, length((L.xy - vec2(u_head.x + 0.01, u_land.w)) * vec2(0.9, 1.4)) - 0.015); base = mix(base, vec3(0.9, 0.88, 0.84), t * step(abs(L.z), 0.07)); }
    if (bone <= 1) {
      base *= 1.0 - c1.x * 0.32 * smoothstep(0.05, 0.0, abs(L.z)) * smoothstep(u_land.x - 0.08, u_land.x - 0.02, L.y);    // the dorsal stripe
      if (c2.x > 0.0 && L.y > u_land.x - 0.3 && L.x > u_land.y && L.x < u_land.z) {
        float g = gridCode(vec2(L.x, L.y * 1.3 + abs(L.z) * 0.9), c2.y, c2.x, c2.zw);
        base = mix(base, vec3(0.92, 0.88, 0.80), smoothstep(2.05, 2.4, g) * 0.9);
      }
    }
    base = mix(base, base * vec3(0.78, 0.8, 0.86) + 0.04, u_season.w * 0.6);                         // the grey-brown winter coat
  } else if (kind == 1) {                   // wolf: c1 = (saddle, mask, black, cream)
    float ag = vnoise(L.xy * 140.0 + L.z * 60.0); base *= 0.8 + 0.45 * ag;                          // agouti banding
    base *= 1.0 - c1.x * 0.35 * smoothstep(u_land.x - 0.14, u_land.x - 0.05, L.y) * (bone <= 1 ? 1.0 : 0.0);         // the saddle
    if (bone == 3) base = mix(base, vec3(0.86, 0.84, 0.8), c1.y * smoothstep(-0.02, 0.03, u_head.y - 0.03 - L.y + abs(L.z) * 0.6) * 0.8);   // the pale mask
    base = mix(base, vec3(0.06, 0.06, 0.065) * (0.8 + 0.4 * ag), c1.z);
    base = mix(base, vec3(0.86, 0.82, 0.74) * (0.85 + 0.2 * ag), c1.w);
  } else if (kind == 2) {                   // warden: c1 = (skin rgb, beard), c2 = (shirt rgb, plaid)
    fur = 1.0;
    if (part(base, vec3(0.78, 0.60, 0.47))) { base = c1.rgb; if (c1.w > 0.5 && L.y < u_land.w + 0.03 && L.y > u_land.w - 0.05 && L.x > 0.04) base = mix(base, vec3(0.12, 0.09, 0.07), 0.8); spec = 0.05; }   // a beard below the mouth
    else if (part(base, vec3(0.55, 0.50, 0.36))) { base = c2.rgb; if (c2.w > 0.5) { float pl = step(0.5, fract(L.y * 14.0)) + step(0.5, fract((L.x + L.z) * 14.0)); base *= 0.75 + 0.2 * pl; } }
  } else { fur = 1.0; spec = 0.12; }
  return base;
}
`;
export const FUR_FS = HEADER + COMMON + SHADOW + DETAIL + SCENE_OUT + HAIR + COAT + `
in vec3 v_col; in vec3 v_nrm; in vec3 v_wpos; in vec3 v_rel; in vec3 v_lpos; in vec3 v_lnrm; in vec3 v_tan; in vec3 v_mx; in vec3 v_my; in vec3 v_mz;
flat in int v_bone; flat in int v_row; flat in vec4 v_c1; flat in vec4 v_c2; flat in vec2 v_fade;
uniform int u_kind;   // 0 deer, 1 wolf, 2 warden, 3 antler
uniform int u_lod;    // which of the class's meshes this draw is (-1: no cross-fade)
void main() {
  bool keep = true;
  if (u_lod >= 0) {                                                              // EYE-2: each pixel keeps one of two neighbouring meshes (applied at the end)
    float hd = hash12(floor(gl_FragCoord.xy));
    keep = u_lod == 0 ? hd >= v_fade.x : u_lod == 1 ? (hd < v_fade.x && hd >= v_fade.y) : hd < v_fade.y;
  }
  vec3 n = normalize(v_nrm), L = v_lpos, lx = dFdx(L), ly = dFdy(L);              // the template frame's footprint (uniform control flow)
  vec3 vrel = v_rel - u_camRel; float dist = length(vrel); vec3 V = -vrel / max(dist, 1e-9);
  float fur = 0.84 + 0.3 * vnoise(L.xy * 90.0 + L.z * 40.0) * vnoise(L.zy * 31.0), spec = 0.0, rough = 0.6, cav = 1.0;
  vec3 base = coatColor(u_kind, v_col, L, v_bone, v_c1, v_c2, fur, spec);
  bool eye = u_kind < 2 && v_bone >= 19 && v_bone <= 20, nose = u_kind < 2 && v_bone == 3 && dot(v_col, vec3(0.333)) < 0.06;
  int M = u_kind == 0 ? (u_season.w > 0.5 ? 17 : 16) : u_kind == 1 ? 18 : u_kind == 3 ? 19 : (part(v_col, vec3(0.55, 0.50, 0.36)) ? 21 : -1);
  if (u_kind == 2 && M < 0 && dot(v_col, vec3(0.333)) < 0.3 && !part(v_col, vec3(0.78, 0.60, 0.47))) M = 22;   // hat, belt and boots: leather
  if (nose) M = 20; if (eye) M = 23;
  if (eye) {                                                                     // an eye: a dark iris, the deer's horizontal slot of a pupil, a wet cornea
    vec3 ec = vec3(u_eye.x, u_eye.y, v_bone == 19 ? u_eye.z : -u_eye.z), d = normalize(L - ec);
    vec3 ax = normalize(vec3(0.35, 0.05, v_bone == 19 ? 1.0 : -1.0)), e1 = normalize(cross(vec3(0.0, 1.0, 0.0), ax)), e2 = cross(ax, e1);
    vec2 q = vec2(dot(d, e1), dot(d, e2)) * (dot(d, ax) > 0.0 ? 1.0 : 3.0);
    float pupil = 1.0 - smoothstep(0.9, 1.0, length(q / vec2(0.46, 0.15))), limbus = smoothstep(0.82, 0.95, length(q));
    base = mix(vec3(0.13, 0.07, 0.035), vec3(0.025, 0.018, 0.014), limbus); base = mix(base, vec3(0.004), pupil); fur = 1.0; spec = 0.0; rough = 0.05;
  }
  bool hair = M >= 16 && M <= 18;
  float near_ = hair ? 1.0 - smoothstep(2.0, 4.5, dist * u_pxScale) : 1.0 - smoothstep(1.5, 3.0, dist * u_pxScale);   // the coat's hair texture out to a few metres
  if (M >= 0 && near_ > 0.0) {                                                   // close up: hair texture, iris fibres, nose leather, antler, canvas, leather
    float f = near_;
    Tri D = triDetail(M, L, lx, ly, normalize(v_lnrm), hair ? 2 : 4, false);
    base *= mix(vec3(1.0), clamp(D.tint, hair ? 0.7 : 0.3, hair ? 1.4 : 2.5), f * (eye ? 0.8 : hair ? 0.6 : 1.0)); cav = mix(1.0, D.ao, f * (hair ? 0.5 : 1.0));
    if (!eye) { rough = mix(rough, D.rough, f); n = normalize(mix(n, normalize(mat3(v_mx, v_my, v_mz) * D.n), f)); }
  }
  float sh = shadowAt(v_wpos, n);
  float ndl = max(dot(n, u_sunDir), 0.0), wrap = max(dot(n, u_sunDir) * 0.5 + 0.5, 0.0);
  float ao = mix(0.55, 1.0, smoothstep(-0.6, 0.4, n.y)) * cav;                   // underside and legs in their own shade
  base *= fur;
  vec3 col = base * (u_sunCol * mix(ndl, wrap, 0.3) * sh + ambient(n) * 0.6 * ao);
  if (u_kind < 2 && !eye && !nose) {                                             // fur: Marschner's R, TT and TRT on the comb direction
    vec3 T = normalize(v_tan - n * dot(v_tan, n) + 1e-5); float R; vec3 TT, TRT;
    marschner(T, V, u_sunDir, hairSigma(base, 0.35), 0.34, R, TT, TRT);
    float facing = smoothstep(-0.2, 0.35, dot(n, u_sunDir)), rimv = pow(1.0 - abs(dot(n, V)), 3.0);
    col += u_sunCol * sh * (vec3(R) * facing + TRT * facing * 0.7 + TT * rimv * 0.6) * mix(0.5, 1.0, ao);
  } else {
    float rim = pow(1.0 - max(dot(V, n), 0.0), 2.5);
    col += u_sunCol * sh * rim * 0.06 * base;
  }
  vec3 H = normalize(u_sunDir + V);
  col += u_sunCol * sh * pow(max(dot(n, H), 0.0), 40.0) * spec;
  if (eye) col += u_sunCol * pow(max(dot(n, H), 0.0), 600.0) * 2.5 + skyColor(reflect(-V, n)) * 0.06;   // the cornea: a sharp catchlight and the sky
  if (nose) col += u_sunCol * sh * pow(max(dot(n, H), 0.0), 120.0) * 0.6 * cav;                         // a wet nose
  o = vec4(applyFog(col, v_wpos, vrel), 1.0);
  gbuf(base, 0.6 * ao, n, rough, (uint(5 + u_kind) << 24) | (uint(v_row & 65535) << 8) | uint(v_bone & 255));
  if (!keep) discard;
}`;

/* ------------------------------------------------------------------ strand fur on the animal nearest the lens (valley3d_strands.js) */
export const STRAND_SEG = 5;
export const STRAND_VS = HEADER + COMMON + FLOW + `
uniform mat4 u_vp; uniform highp sampler2D u_roots; uniform highp sampler2D u_rest; uniform sampler2D u_bones;
uniform int u_row; uniform float u_scale; uniform float u_radPx; uniform float u_lenK;
out vec3 v_wpos; out vec3 v_rel; out vec3 v_tan; out vec3 v_nrm; out vec3 v_base; out vec3 v_col; out float v_t; out float v_cov; flat out int v_bone;
mat4 boneMat(int row, int b) { int x = b * 4; return mat4(texelFetch(u_bones, ivec2(x, row), 0), texelFetch(u_bones, ivec2(x + 1, row), 0), texelFetch(u_bones, ivec2(x + 2, row), 0), texelFetch(u_bones, ivec2(x + 3, row), 0)); }
vec4 tx(highp sampler2D s, int i) { return texelFetch(s, ivec2(i & 4095, i >> 12), 0); }
void main() {
  int sI = gl_InstanceID, seg = gl_VertexID >> 1; float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0, t = float(seg) / ${STRAND_SEG}.0;
  vec4 r0 = tx(u_roots, sI * 3), r1 = tx(u_roots, sI * 3 + 1), r2 = tx(u_roots, sI * 3 + 2);
  ivec3 tri = ivec3(r0.xyz + 0.5); float seed = r0.w, wa = r1.x, wb = r1.y, wc = 1.0 - wa - wb, L = r1.z * u_lenK; int bone = int(r1.w + 0.5);
  vec4 A = tx(u_rest, tri.x * 2), An = tx(u_rest, tri.x * 2 + 1), B = tx(u_rest, tri.y * 2), Bn = tx(u_rest, tri.y * 2 + 1), C = tx(u_rest, tri.z * 2), Cn = tx(u_rest, tri.z * 2 + 1);
  vec3 nsum = An.xyz * wa + Bn.xyz * wb + Cn.xyz * wc;
  vec3 p0 = A.xyz * wa + B.xyz * wb + C.xyz * wc, n0 = dot(nsum, nsum) > 1e-8 ? normalize(nsum) : normalize(An.xyz + vec3(0.0, 1e-3, 0.0));
  int b0 = int(floor(A.w)), b1 = int(An.w + 0.5); float w0 = fract(A.w) / 0.999;
  vec3 comb = combDir(bone, n0);
  float h1 = hash12(vec2(seed * 913.1, 3.7)), h2 = hash12(vec2(seed * 377.3, 9.1)), h3 = hash12(vec2(seed * 51.7, 1.3));
  vec3 d0 = normalize(n0 * (0.22 + 0.3 * h1) + comb * 0.95 + (vec3(h1, h2, h3) - 0.5) * 0.3), cr = normalize(cross(d0, n0) + 1e-4);
  vec3 g = vec3(0.0, -1.0, 0.0);                                               // the template frame's down
  float curl = sin(t * 3.0 + seed * 40.0) * 0.06, curlD = cos(t * 3.0 + seed * 40.0) * 0.18;
  vec3 p = p0 + d0 * L * t + g * L * t * t * 0.2 + cr * curl * L * t;
  vec3 tg = normalize(d0 + g * t * 0.4 + cr * curlD * t);
  mat4 M = boneMat(u_row, b0) * w0 + boneMat(u_row, b1) * (1.0 - w0);
  vec3 wp = (M * vec4(p, 1.0)).xyz, T = normalize(mat3(M) * tg), view = wp - u_camRel;
  float dist = length(view), w = mix(0.0001 + 0.0025 * L, 0.00003, t) * u_scale, wpx = dist * u_radPx, wd = max(w, 0.7 * wpx);
  v_cov = w / wd;
  wp += normalize(cross(T, view) + 1e-6) * side * wd * 0.5;
  v_rel = wp; v_wpos = wp + u_ro; v_tan = T; v_nrm = normalize(mat3(M) * n0); v_t = t; v_bone = bone; v_base = r2.xyz;
  float pk = r2.w; v_col = vec3(mod(pk, 256.0), mod(floor(pk / 256.0), 256.0), floor(pk / 65536.0)) / 255.0;
  gl_Position = u_vp * vec4(wp, 1.0);
}`;
export const STRAND_FS = HEADER + COMMON + SHADOW + SCENE_OUT + HAIR + COAT + `
in vec3 v_wpos; in vec3 v_rel; in vec3 v_tan; in vec3 v_nrm; in vec3 v_base; in vec3 v_col; in float v_t; in float v_cov; flat in int v_bone;
uniform int u_kind; uniform vec4 u_c1; uniform vec4 u_c2; uniform vec3 u_tint; uniform int u_row;
void main() {
  if (hash12(floor(gl_FragCoord.xy) + vec2(v_t * 13.0, 0.0)) > v_cov) discard;   // a hair thinner than a pixel: its coverage as a dither
  float fur = 1.0, spec = 0.0;
  vec3 base = coatColor(u_kind, v_col * u_tint, v_base, v_bone, u_c1, u_c2, fur, spec);
  if (u_kind == 0) base *= mix(0.75, 1.0, smoothstep(0.0, 0.45, v_t)) * (1.0 + 0.35 * smoothstep(0.55, 0.68, v_t) * (1.0 - smoothstep(0.76, 0.86, v_t))) * mix(1.0, 0.55, smoothstep(0.88, 1.0, v_t));   // agouti bands
  else base *= mix(0.6, 1.1, v_t) * (1.0 - 0.5 * smoothstep(0.85, 1.0, v_t));
  vec3 T = normalize(v_tan + 1e-6), n = normalize(v_nrm + 1e-6), V = -normalize(v_rel - u_camRel + 1e-9);
  float sh = shadowAt(v_wpos, n), ao = mix(0.55, 1.0, sqrt(max(v_t, 0.0)));
  float R; vec3 TT, TRT; marschner(T, V, u_sunDir, hairSigma(base, 0.35), 0.3, R, TT, TRT);
  float kk = sqrt(max(1.0 - dot(T, u_sunDir) * dot(T, u_sunDir), 0.0));            // Kajiya-Kay
  vec3 col = base * (u_sunCol * sh * (0.3 + 0.7 * kk) * mix(0.35, 1.0, max(dot(n, u_sunDir) * 0.5 + 0.5, 0.0)) + ambient(n) * 0.6) * ao;
  col += u_sunCol * sh * (vec3(R) + TT * 0.7 + TRT * 0.7) * ao;
  if (any(isnan(col)) || any(isinf(col))) discard;
  o = vec4(applyFog(col, v_wpos, v_rel - u_camRel), 1.0);
  gbuf(base, 0.6 * ao, n, 0.45, (uint(5 + u_kind) << 24) | (uint(u_row & 65535) << 8) | uint(v_bone & 255));
}`;

/* ------------------------------------------------------------------ birds (valley3d_birds.js): body, two wings and a tail from each bird's numbers */
export const BIRD_VS = HEADER + COMMON + `
layout(location=0) in vec3 a_t;   // part (0 body, 1 left wing, 2 right wing, 3 tail), u, v
layout(location=5) in vec4 i_p;   // x, y, z (relative to origin), heading
layout(location=6) in vec4 i_s;   // seed, wingspan m, flap phase, flapping 0..1
layout(location=7) in vec4 i_k;   // bank, species (0 swallow, 1 raven, 2 hawk), aspect, tail
uniform mat4 u_vp; uniform vec3 u_origin;   // relative to the render origin
out vec3 v_top; out vec3 v_bot; out vec3 v_nrm; out vec3 v_wpos;
void main() {
  int part = int(a_t.x + 0.5); float u = a_t.y, v = a_t.z, span = i_s.y, sp = i_k.y;
  float len = span * (sp < 0.5 ? 0.48 : 0.42), chord = span * (sp < 0.5 ? 0.15 : 0.21) / i_k.z, flap = sin(i_s.z * 6.2832) * i_s.w;
  vec3 p, n;
  if (part == 0) { float r = len * 0.1 * sin(3.1416 * clamp(u, 0.0, 1.0)) * (sp > 0.5 ? 1.25 : 1.0), a = v * 6.2832; p = vec3((u - 0.45) * len, sin(a) * r * 0.85, cos(a) * r); n = vec3(0.0, sin(a), cos(a)); }
  else if (part <= 2) {
    float side = part == 1 ? 1.0 : -1.0, zs = u * span * 0.5, outer = max(u - 0.5, 0.0) * 2.0;
    float ch = chord * (1.0 - 0.6 * u * u) * (sp > 1.5 ? 1.15 : 1.0), sweep = (sp < 0.5 ? 0.38 : 0.08) * zs;
    float y = sin(flap * 0.9) * zs + outer * flap * span * 0.1 + (sp > 1.5 ? zs * 0.12 : 0.0);   // a hawk soars with a dihedral
    p = vec3(0.04 * len - v * ch - sweep, y, side * (len * 0.06 + zs * cos(flap * 0.6))); n = vec3(0.0, 1.0, -side * flap * 0.6);
    if (sp > 1.5 && u > 0.85) p.x -= (v - 0.5) * ch * 0.3;                                     // slotted primaries
  } else {
    float w = (v - 0.5) * len * (sp < 0.5 ? 0.5 : 0.36), fork = sp < 0.5 ? abs(v - 0.5) * len * (0.6 + 0.5 * i_k.w) : sp < 1.5 ? -abs(v - 0.5) * len * 0.25 : 0.0;
    p = vec3(-0.42 * len - u * (len * 0.35 + fork), 0.0, w * (0.55 + u)); n = vec3(0.0, 1.0, 0.0);
  }
  float c = cos(i_k.x), s = sin(i_k.x); p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); n = vec3(n.x, c * n.y - s * n.z, s * n.y + c * n.z);
  float ch2 = cos(i_p.w), sh2 = sin(i_p.w);
  vec3 at = i_p.xyz + u_origin, w = at + vec3(ch2 * p.x - sh2 * p.z, p.y, sh2 * p.x + ch2 * p.z);
  v_wpos = w + u_ro; v_nrm = normalize(vec3(ch2 * n.x - sh2 * n.z, n.y, sh2 * n.x + ch2 * n.z));
  float j = 0.85 + 0.3 * hash12(vec2(i_s.x * 91.0, 3.0));
  v_top = (sp < 0.5 ? vec3(0.05, 0.07, 0.14) : sp < 1.5 ? vec3(0.035, 0.035, 0.045) : (part == 3 ? vec3(0.62, 0.27, 0.11) : vec3(0.36, 0.23, 0.13))) * j;
  v_bot = (sp < 0.5 ? (part == 0 && u > 0.7 ? vec3(0.55, 0.25, 0.12) : vec3(0.86, 0.80, 0.70)) : sp < 1.5 ? vec3(0.05, 0.05, 0.06) : vec3(0.84, 0.78, 0.66)) * j;
  gl_Position = u_vp * vec4(w, 1.0);
}`;
export const BIRD_FS = HEADER + COMMON + SCENE_OUT + `
in vec3 v_top; in vec3 v_bot; in vec3 v_nrm; in vec3 v_wpos;
void main() {
  vec3 n = normalize(v_nrm); if (!gl_FrontFacing) n = -n;
  vec3 albedo = n.y >= 0.0 ? v_top : v_bot;
  vec3 col = albedo * (u_sunCol * max(dot(n, u_sunDir), 0.0) + ambient(n) * 0.7) + u_sunCol * pow(max(dot(reflect(normalize(v_wpos - u_camPos), n), u_sunDir), 0.0), 20.0) * 0.05;
  o = vec4(applyFog(col, v_wpos, v_wpos - u_camPos), 1.0);
  gbuf(albedo, 0.7, n, 0.7, 9u << 24);
}`;

/* ------------------------------------------------------------------ shadow depth (any geometry) */
export const DEPTH_FS = HEADER + `out vec4 o; void main() { o = vec4(1.0); }`;

/* ------------------------------------------------------------------ markers and ground decals (selection ring, perception cells, cone, soft contact shadows) */
export const MARK_VS = HEADER + `
layout(location=0) in vec3 a_pos; layout(location=1) in vec4 a_col; uniform mat4 u_vp; uniform vec3 u_ro; out vec4 v_col;
void main() { v_col = a_col; gl_Position = u_vp * vec4(a_pos - u_ro, 1.0); }`;
export const MARK_FS = HEADER + `in vec4 v_col; out vec4 o; void main() { o = v_col; }`;

/* ------------------------------------------------------------------ the probe: distance and identity of what lies under one pixel (macro focus) */
export const PROBE_FS = HEADER + `out vec4 o; uniform sampler2D u_depth; uniform highp usampler2D u_id; uniform ivec2 u_px; uniform vec2 u_nearFar; uniform float u_rev;
void main() {
  float z = texelFetch(u_depth, u_px, 0).r, n = u_nearFar.x, f = u_nearFar.y; uint id = texelFetch(u_id, u_px, 0).r;
  float lin = u_rev > 0.5 ? (z > 0.0 ? n / z : -1.0) : (z < 1.0 ? 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n)) : -1.0);
  o = vec4(lin, float(id >> 24), float((id >> 8) & 65535u), float(id & 255u));
}`;

/* ------------------------------------------------------------------ post: bloom and the final grade */
export const FULL_VS = HEADER + `out vec2 v_uv; void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
export const BRIGHT_FS = HEADER + `in vec2 v_uv; out vec4 o; uniform sampler2D u_tex; uniform float u_thresh;
void main() { vec2 t = 1.0 / vec2(textureSize(u_tex, 0)); vec3 c = vec3(0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) c += textureLod(u_tex, v_uv + vec2(x, y) * t * 1.5, 0.0).rgb;
  c /= 9.0; if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0); c = min(c, vec3(64.0)); float l = max(max(c.r, c.g), c.b); o = vec4(c * smoothstep(u_thresh, u_thresh * 2.0, l), 1.0); }`;
export const BLUR_FS = HEADER + `in vec2 v_uv; out vec4 o; uniform sampler2D u_tex; uniform vec2 u_dir;
void main() { vec2 t = u_dir / vec2(textureSize(u_tex, 0)); vec3 c = texture(u_tex, v_uv).rgb * 0.227;
  c += (texture(u_tex, v_uv + t * 1.384).rgb + texture(u_tex, v_uv - t * 1.384).rgb) * 0.316;
  c += (texture(u_tex, v_uv + t * 3.230).rgb + texture(u_tex, v_uv - t * 3.230).rgb) * 0.070; o = vec4(c, 1.0); }`;
export const FINAL_FS = HEADER + `in vec2 v_uv; out vec4 o;
uniform sampler2D u_scene; uniform sampler2D u_bloom; uniform float u_exposure; uniform vec3 u_lift; uniform vec3 u_gain; uniform float u_sat; uniform float u_time; uniform float u_bloomAmt;
uniform sampler2D u_depth; uniform vec2 u_nearFar; uniform float u_focus; uniform float u_dof; uniform float u_rev; uniform float u_macro;
uniform vec4 u_lens;   // EYE-4, the thin lens: f^2 / (N (zf - f)) * H / sensor, focus distance, largest blur (px), macro
vec3 aces(vec3 x) { const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
float lin(float z) { float n = u_nearFar.x, f = u_nearFar.y; if (u_rev > 0.5) return n / max(z, 1e-30); return 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n)); }
void main() {
  vec3 c = texture(u_scene, v_uv).rgb;
  if (u_dof > 0.0) {                                                             // a shallow depth of field beyond the followed deer
    float z = lin(texture(u_depth, v_uv).r), coc = clamp(u_lens.x * abs(z - u_lens.y) / max(z, 1e-6), 0.0, u_lens.z);   // circle of confusion, pixels
    if (u_macro > 0.5) coc = clamp(abs(z - u_focus) / max(z, 1e-6) * 2.5 - 0.04, 0.0, 1.0) * 7.0;   // a macro lens: a few millimetres in focus
    if (coc > 0.2) { vec2 t = coc / vec2(textureSize(u_scene, 0)); vec3 s = vec3(0);
      for (int i = 0; i < 16; i++) { float a = float(i) * 2.39996; float r = sqrt((float(i) + 0.5) / 16.0); s += textureLod(u_scene, v_uv + vec2(cos(a), sin(a)) * r * t, 0.0).rgb; }
      c = mix(c, s / 16.0, clamp(coc / 1.5, 0.0, 1.0)); }
  }
  c += texture(u_bloom, v_uv).rgb * u_bloomAmt;
  c = aces(c * u_exposure);
  c = pow(c, vec3(1.0 / 2.2));
  c = c * u_gain + u_lift * (1.0 - c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, u_sat);
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.18);                                     // a gentle S-curve for filmic contrast
  vec2 q = v_uv - 0.5; c *= 1.0 - dot(q, q) * 0.6;                               // vignette
  c += (fract(sin(dot(v_uv * 1000.0 + u_time, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.01; // grain
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
