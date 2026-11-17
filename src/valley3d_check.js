// What this browser and GPU offer the Deer Valley renderer, and why it does or does not start.
// SPDX-License-Identifier: GPL-3.0-only
//
// glEnvironment() reports the WebGL 2 context (or why there is none), the GPU, the extensions the renderer
// uses and the limits it relies on. checkRenderer() then compiles every program on its own and without
// blocking (so one failure does not hide the next, and a program the driver stalls on is named), times each,
// reads the Direct3D HLSL that ANGLE makes of each shader where the browser shows it (gradient operations
// inside loops are what made 1.4.0's terrain hang Direct3D's compiler), builds every kind of render target the
// view uses, and finally starts the whole renderer. The valley page explains its own failures the same way.
import { compilePrograms, target, freeTarget, gpuName, noWebGL2Reason } from "./gl.js";
import { Valley3D, PROGRAMS, DETAIL_PROGRAMS } from "./valley3d.js";
import { ATMOS_PROGRAMS } from "./valley3d_atmos.js";
import { STRAND_VS, STRAND_FS } from "./valley3d_shaders.js";

export const GL_EXTENSIONS = ["EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_float_blend", "OES_texture_float_linear",
  "EXT_clip_control", "EXT_texture_filter_anisotropic", "EXT_disjoint_timer_query_webgl2", "KHR_parallel_shader_compile", "WEBGL_debug_renderer_info", "WEBGL_debug_shaders"];
const LIMITS = ["MAX_TEXTURE_SIZE", "MAX_ARRAY_TEXTURE_LAYERS", "MAX_RENDERBUFFER_SIZE", "MAX_DRAW_BUFFERS", "MAX_COLOR_ATTACHMENTS", "MAX_TEXTURE_IMAGE_UNITS",
  "MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_UNIFORM_VECTORS", "MAX_FRAGMENT_UNIFORM_VECTORS", "MAX_VARYING_VECTORS", "MAX_SAMPLES"];
const ALL = () => ({ ...PROGRAMS, ...Object.fromEntries(Object.entries(ATMOS_PROGRAMS).map(([k, v]) => ["atmos." + k, v])), strands: [STRAND_VS, STRAND_FS, "strands"] });

export function glEnvironment() {
  const lines = []; let gl = null;
  try { gl = document.createElement("canvas").getContext("webgl2", { antialias: false, alpha: false, depth: true, powerPreference: "high-performance" }); } catch (e) { lines.push("webgl2 threw: " + e.message); }
  if (!gl) { const reason = noWebGL2Reason(); lines.push("webgl2: unavailable: " + reason); return { ok: false, reason, lines }; }
  lines.push(`webgl2: ${gl.getParameter(gl.VERSION)} · ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`);
  const gpu = gpuName(gl); lines.push(`gpu: ${gpu}`);
  const have = new Set(gl.getSupportedExtensions() ?? []);
  lines.push("extensions: " + GL_EXTENSIONS.map((e) => `${e} ${have.has(e) ? "yes" : "NO"}`).join(" · "));
  lines.push("limits: " + LIMITS.map((k) => `${k} ${gl.getParameter(gl[k])}`).join(" · "));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { ok: true, lines, extensions: have, gpu, d3d: /Direct3D|D3D11|D3D9/i.test(gpu) };
}

// Where ANGLE turns WebGL into HLSL (Windows), it marks each loop holding a gradient operation (texture() with
// implicit derivatives, dFdx, fwidth) LOOP, and each branch around such a loop FLATTEN. Under divergent flow
// those are errors for FXC, which ANGLE then retries with other settings; each retry is a full, slow compile.
// The renderer has none; a count above zero means a regression. Compiles only (no link): quick, and safe.
export function shaderAudit(gl, specs = ALL()) {
  const dbg = gl.getExtension("WEBGL_debug_shaders"); if (!dbg) return null;
  const out = [];
  for (const [vs, fs, label] of Object.values(specs)) for (const [type, src, kind] of [[gl.VERTEX_SHADER, vs, "vertex"], [gl.FRAGMENT_SHADER, fs, "fragment"]]) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    const h = dbg.getTranslatedShaderSource(s) || "", uses = h.split("\n").filter((l) => /\b(LOOP|FLATTEN)\b/.test(l) && !/#define/.test(l)).length;
    out.push({ label, kind, hlsl: /\bfloat4\b|\bSV_|register\(/.test(h), uses, dyn: (h.match(/dyn_index_\w+\(/g) || []).length, bytes: h.length });
    gl.deleteShader(s);
  }
  return out;
}

// Compile every program alone (the safe variants first, then the full-detail ones, which are the ones a driver
// may reset on: so the report holds everything that works before it stops), audit the HLSL, build each kind of
// render target, then start the renderer as the valley page does; say(line) reports.
export async function checkRenderer(canvas, say, { safe = false } = {}) {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return { ok: false, reason: noWebGL2Reason() };
  const specs = ALL(); let failed = null, fullOk = !safe;
  if (!gl.getExtension("KHR_parallel_shader_compile")) say("  (no KHR_parallel_shader_compile: each compile blocks the GPU process until it is done)");
  const steps = [...Object.keys(specs).filter((k) => k !== "strands").map((k) => [k, "#define PLUME_SAFE 1\n", DETAIL_PROGRAMS.includes(k) ? " (safe)" : ""])];
  if (!safe) steps.push(...[...DETAIL_PROGRAMS, "strands"].map((k) => [k, "", " (full detail)"]));
  for (const [k, defines, tag] of steps) {
    const t0 = performance.now(), label = specs[k][2] + tag;
    try { const P = await compilePrograms(gl, { [k]: specs[k] }, { defines, timeoutMs: 120000 }); gl.deleteProgram(P[k].p); say(`  program ${label}: ok (${(performance.now() - t0).toFixed(0)} ms)`); }
    catch (e) {
      say(`  program ${label}: FAILED after ${(performance.now() - t0).toFixed(0)} ms\n${String(e.message).split("\n").slice(0, 12).map((l) => "      " + l).join("\n")}`);
      if (e.lost || gl.isContextLost()) {
        say("  the graphics driver reset while compiling it (the context was lost); the check stops here, so as not to reset it again");
        return { ok: false, lost: true, safeOk: !!tag.includes("full"), reason: `the graphics driver reset while compiling the ${label} shaders` };
      }
      if (tag.includes("full")) fullOk = false; else failed ??= `the ${label} shaders do not compile on this GPU`;
    }
  }
  const audit = shaderAudit(gl, specs);
  if (!audit) say("  shader audit: the browser does not show translated shaders here (WEBGL_debug_shaders)");
  else if (!audit.some((a) => a.hlsl)) say(`  shader audit: ${audit.length} shaders translated; not HLSL (this browser does not run WebGL on Direct3D), nothing to check`);
  else {
    const bad = audit.filter((a) => a.uses);
    say(`  shader audit (Direct3D HLSL): ${audit.length} shaders, ${bad.length ? `${bad.length} with gradient operations inside loops: ${bad.map((a) => `${a.label} ${a.kind} (${a.uses})`).join(", ")}` : "no gradient operation inside a loop"}`);
    const dyn = audit.filter((a) => a.dyn); if (dyn.length) say(`    emulated dynamic indexing: ${dyn.map((a) => `${a.label} ${a.kind} (${a.dyn})`).join(", ")}`);
  }
  const half = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float")), full = !!gl.getExtension("EXT_color_buffer_float");
  const f16 = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }, u8 = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const sh = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) >> 1);
  const targets = [
    ["scene (four colour targets and a float depth)", true, () => target(gl, 640, 360, { color: [half ? f16 : u8, { ...u8, filter: gl.NEAREST }, half ? { ...f16, filter: gl.NEAREST } : { ...u8, filter: gl.NEAREST }, { internal: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT, filter: gl.NEAREST }], depthTexture: true })],
    [`shadow map ${sh * 2} x ${sh}`, true, () => target(gl, sh * 2, sh, { color: [{ internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE }], depthTexture: true })],
    [`sky tables (${half ? "half float" : "8-bit: no float rendering here"})`, true, () => target(gl, 256, 64, { color: half ? [f16, f16] : [u8, u8], depth: false })],
    ["depth probe (float; macro focus)", full, () => target(gl, 1, 1, { color: [{ internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST }], depth: false })],
  ];
  for (const [name, needed, make] of targets) {
    if (!needed) { say(`  render target ${name}: not renderable here (the view goes without it)`); continue; }
    try { freeTarget(gl, make()); say(`  render target ${name}: ok`); }
    catch (e) { say(`  render target ${name}: FAILED: ${e.message}`); failed ??= `the ${name} render target is not supported (${e.message})`; }
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  say(""); say(`the whole renderer${safe || !fullOk ? " (safe graphics)" : ""}:`);
  let view = null;
  try {
    const t0 = performance.now(); view = new Valley3D(canvas, { quality: "high", gfx: safe || !fullOk ? "safe" : "full", onStatus: () => {} });
    await view.whenReady;
    say(`  ready at quality ${view.qualityName} in ${(performance.now() - t0).toFixed(0)} ms (shaders ${view.compileMs.toFixed(0)} ms)${view.safe ? ", safe graphics" : ""}; GL error 0x${view.gl.getError().toString(16)}`);
    return failed ? { ok: false, reason: failed } : { ok: true, mode: view.safe ? "safe graphics" + (safe ? "" : ": the full-detail shaders do not compile here") : "full quality" };
  } catch (e) {
    say(`  FAILED: ${String(e.message).split("\n").slice(0, 14).join("\n      ")}`);
    return { ok: false, lost: !!e.lost, reason: failed ?? e.message.split("\n")[0] };
  } finally { view?.dispose?.(); }
}
