// SPDX-License-Identifier: GPL-3.0-only
// Verify the reference valley store (tools/bake/reference.mjs):
//   1. every shard: its index is whole (CRC-32C) and every chunk lies inside the file at its exact size;
//   2. every map level: the SHA-256 root of its chunks equals the root its metadata records;
//   3. every byte20 epoch: the frame digest and the chain D_e follow from the stored bytes alone;
//   4. with --replay N (or all): the world is run again from the Simmy boot and every frame, valley digest and
//      (for all) the final map must come out byte for byte the same.
//   node tools/verify_reference.mjs [STORE.zarr] [--replay N|all]
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_STORE = join(ROOT, "shards/zarr/deer-valley-reference.zarr");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const CRC32C = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32c = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC32C[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const SIZE = { int32: 4, uint8: 1 };

export function readShard(file, nChunks, chunkBytes) {
  const b = readFileSync(file), ix = b.length - (nChunks * 16 + 4); if (ix < 0) throw new Error(`${file}: too short for ${nChunks} chunks`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (crc32c(b.subarray(ix, ix + nChunks * 16)) !== dv.getUint32(ix + nChunks * 16, true)) throw new Error(`${file}: the shard index fails its CRC-32C`);
  const out = [];
  for (let i = 0; i < nChunks; i++) {
    const off = Number(dv.getBigUint64(ix + i * 16, true)), n = Number(dv.getBigUint64(ix + i * 16 + 8, true));
    if (n !== chunkBytes || off + n > ix) throw new Error(`${file}: chunk ${i} is ${n} bytes at ${off}, expected ${chunkBytes} inside ${ix}`);
    out.push(b.subarray(off, off + n));
  }
  return out;
}
const meta = (store, rel) => JSON.parse(readFileSync(join(store, rel, "zarr.json"), "utf8"));
const inner = (m) => m.codecs[0].configuration.chunk_shape;
const prod = (a) => a.reduce((x, y) => x * y, 1);

export async function verify(store = DEFAULT_STORE, { replay = 0, log = () => {} } = {}) {
  const { pyDumps } = await import(join(ROOT, "src/simmy.js"));
  const root = meta(store, "").attributes.russl, problems = [], stats = { shards: 0, chunks: 0, levels: 0, epochs: 0, bytes: 0 };
  if (root.schema !== "RUSSL.ValleyReference/1") throw new Error(`${store}: not a reference store`);
  const maps = Object.keys(root.contents).filter((k) => k.startsWith("map/"));
  const mapRoots = {}, shard = (file, n, bytes) => { try { return readShard(file, n, bytes); } catch (e) { problems.push(e.message); return null; } };
  for (const m of maps) {
    const desc = meta(store, m).attributes.russl; mapRoots[m] = {};
    for (const c of desc.field.channels) for (const L of desc.levels) {
      const rel = `${m}/${c.name}/${L.level}`, am = meta(store, rel), ic = inner(am), n = (am.shape[0] / ic[0]) * (am.shape[1] / ic[1]);
      const chunks = shard(join(store, rel, "c/0/0"), n, prod(ic) * SIZE[am.data_type]); stats.shards++; if (!chunks) continue;
      stats.chunks += n; stats.bytes += chunks.reduce((s, x) => s + x.length, 0);
      const r = sha(pyDumps({ channel: c.name, level: L.level, chunks: chunks.map(sha) }));
      if (r !== L.roots[c.name] || r !== am.attributes.russl.root) problems.push(`${rel}: root ${r.slice(0, 12)} differs from the metadata`);
      mapRoots[m][`${c.name}/${L.level}`] = r; stats.levels++;
    }
  }
  const bg = meta(store, "byte20").attributes.russl, ba = meta(store, "byte20/0"), [T, W, H, X] = ba.shape, per = ba.chunk_grid.configuration.chunk_shape[0];
  const frames = []; let chain = bg.genesis_chain;
  for (let s = 0; s < T / per; s++) {
    const chunks = shard(join(store, `byte20/0/c/${s}/0/0/0`), per, W * H * X * 4); stats.shards++;
    if (!chunks) { replay = 0; break; } stats.chunks += per;
    for (const [k, ch] of chunks.entries()) {
      const t = s * per + k, E = bg.epochs[t], p = new Int32Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.length)), f = new Int32Array(p.length);
      for (let c = 0; c < H * X; c++) for (let m = 0; m < W; m++) f[c * W + m] = p[m * H * X + c];
      const fs = sha(new Uint8Array(f.buffer)); chain = sha(pyDumps({ law: bg.law, previous: chain, epoch: E.epoch, valley: E.valley, frame: fs }));
      if (E.epoch !== t + bg.epoch_offset) problems.push(`byte20 t=${t}: epoch ${E.epoch}`);
      if (fs !== E.frame_sha256) problems.push(`byte20 epoch ${E.epoch}: frame digest differs`);
      if (chain !== E.chain) problems.push(`byte20 epoch ${E.epoch}: chain differs`);
      frames.push(ch); stats.epochs++; stats.bytes += ch.length;
    }
  }
  if (chain !== root.final.chain) problems.push("the final chain differs from the root's record");
  log(`read ${stats.shards} shards, ${stats.chunks} chunks (${(stats.bytes / 1e6).toFixed(1)} MB): ${stats.levels} map levels and ${stats.epochs} epochs check`);
  if (replay) {
    const { createWasm1T } = await import(join(ROOT, "src/engines.js"));
    const { Valley, simmyBoot } = await import(join(ROOT, "src/valley.js"));
    const { MapStore, CHANNELS, MAP_LEVELS } = await import(join(ROOT, "src/valleymap.js"));
    const { Byte20 } = await import(join(ROOT, "src/byte20.js"));
    const rd = (f) => readFileSync(join(ROOT, f)), n = replay === "all" ? T : Math.min(T, replay);
    const boot = simmyBoot(JSON.parse(rd("data/simmy/cells.json")), JSON.parse(rd("data/simmy/authority_workload_rails.json")));
    const engine = await createWasm1T(rd("web/xpu.wasm")), v = new Valley(root.config, boot), map = new MapStore(v.cfg.seed, v), b20 = new Byte20(v, map);
    const levelRoots = () => Object.fromEntries(CHANNELS.flatMap((c, k) => Array.from({ length: MAP_LEVELS }, (_, l) => [`${c.name}/${l}`, map.levelRoot(k, l)])));
    const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
    if (b20.chain !== bg.genesis_chain || v.digest !== root.genesis.valley) problems.push("replay: genesis differs");
    if (!same(levelRoots(), mapRoots["map/epoch-0000"])) problems.push("replay: the genesis map differs");
    for (let e = 1; e <= n; e++) {
      await v.step(engine); map.weather(v); b20.compute(v, map);
      const got = new Uint8Array(b20.planes().buffer), want = frames[e - 1];
      if (v.digest !== bg.epochs[e - 1].valley || got.length !== want.length || !got.every((x, i) => x === want[i])) { problems.push(`replay: epoch ${e} differs`); break; }
    }
    if (n === T && !same(levelRoots(), mapRoots[maps[maps.length - 1]])) problems.push("replay: the final map differs");
    log(`replayed ${n} epochs${n === T ? " and the final map" : ""}`);
  }
  return { ok: problems.length === 0, problems, stats };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), ri = a.indexOf("--replay"), store = a.find((x, i) => !x.startsWith("--") && (ri < 0 || i !== ri + 1)) ?? DEFAULT_STORE;
  const replay = ri < 0 ? 0 : a[ri + 1] === "all" ? "all" : Number(a[ri + 1]) || 0, t0 = Date.now();
  const r = await verify(resolve(store), { replay, log: (s) => console.log(s) });
  for (const p of r.problems) console.log("FAIL ", p);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${store} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(r.ok ? 0 : 1);
}
