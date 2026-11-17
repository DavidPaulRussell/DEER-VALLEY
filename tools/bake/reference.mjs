// SPDX-License-Identifier: GPL-3.0-only
// The reference valley: the default world (seed 20261117, Simmy boot, no interventions) run for six years,
// written as one Zarr v3 store that standard Zarr readers open (zarr-python 3, tensorstore, napari):
//
//   deer-valley-reference.zarr/
//     zarr.json                     the group; attributes.russl says what is here and how it was made
//     map/epoch-0000/ ...           the living map at genesis: six channels x eight levels (0.25 m .. 32 m),
//     map/epoch-0576/ ...           and after six years (576 epochs), as OME-NGFF 0.5 multiscale images
//     byte20/0                      the byte20 frame of every epoch 1..576: int32 (t, c, y, x) = (576, 5, 128, 128)
//
// Every array is sharded (codec sharding_indexed): chunks are the console's own 128 x 128 map chunks and
// single-epoch byte20 frames (each under 1 MB); shards hold one whole map level or 64 epochs, so every file
// is under 22.5 MB. Chunk bytes are exactly what the console writes: a map chunk is MapStore.chunkBytes and an
// epoch's byte20 chunk is that epoch's .b20 download, so a fresh replay must reproduce every byte
// (tools/verify_reference.mjs checks this).
//
//   node tools/bake/reference.mjs OUTDIR.zarr [--epochs 576]      (a multiple of 64; 576 epochs are six years)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { createWasm1T } = await import(join(ROOT, "src/engines.js"));
const { Valley, simmyBoot, YEAR, CELLS, N } = await import(join(ROOT, "src/valley.js"));
const { MapStore, CHANNELS, MAP_LEVELS, MAP_LAW, MAP_PROFILE, levelSize, spacing } = await import(join(ROOT, "src/valleymap.js"));
const { Byte20, BYTE20_LAW, B20_WORDS } = await import(join(ROOT, "src/byte20.js"));
const { sha256Hex, pyDumps, SIMMY_REPLAY_SHA256 } = await import(join(ROOT, "src/simmy.js"));

export const REF_SCHEMA = "RUSSL.ValleyReference/1", SHARD_EPOCHS = 64;
// CRC-32C (Castagnoli), the checksum the sharding index carries (codec crc32c)
const CRC32C = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export const crc32c = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC32C[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export const shardingCodec = (inner) => [{ name: "sharding_indexed", configuration: { chunk_shape: inner,
  codecs: [{ name: "bytes", configuration: { endian: "little" } }],
  index_codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "crc32c" }], index_location: "end" } }];
// one shard: the chunks in C order, then the index (offset, nbytes as little-endian uint64 pairs) and its CRC-32C
export function shardBytes(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0), n = chunks.length, out = new Uint8Array(total + n * 16 + 4), dv = new DataView(out.buffer);
  let off = 0; chunks.forEach((c, i) => { out.set(c, off); dv.setBigUint64(total + i * 16, BigInt(off), true); dv.setBigUint64(total + i * 16 + 8, BigInt(c.length), true); off += c.length; });
  dv.setUint32(total + n * 16, crc32c(out.subarray(total, total + n * 16)), true);
  return out;
}
const json = (o) => JSON.stringify(o, null, 1) + "\n";
const put = (base, rel, data) => { const p = join(base, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); return data.length; };

function writeMap(base, rel, store, epoch) {
  let bytes = 0; const roots = {};
  for (const [ch, c] of CHANNELS.entries()) {
    for (let l = 0; l < MAP_LEVELS; l++) {
      const S = levelSize(l), cs = store.chunkShape(l), n = store.chunksPerSide(l), chunks = [], digests = [];
      for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) { const b = store.chunkBytes(ch, l, cx, cy); chunks.push(b); digests.push(sha256Hex(b)); }
      roots[`${c.name}/${l}`] = sha256Hex(pyDumps({ channel: c.name, level: l, chunks: digests }));
      bytes += put(base, `${rel}/${c.name}/${l}/zarr.json`, json({ zarr_format: 3, node_type: "array", shape: [S, S], data_type: c.dtype,
        chunk_grid: { name: "regular", configuration: { chunk_shape: [S, S] } }, chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: 0, codecs: shardingCodec([cs, cs]), dimension_names: ["y", "x"], attributes: { russl: { unit: c.unit, root: roots[`${c.name}/${l}`] } } }));
      bytes += put(base, `${rel}/${c.name}/${l}/c/0/0`, shardBytes(chunks));
    }
    bytes += put(base, `${rel}/${c.name}/zarr.json`, json({ zarr_format: 3, node_type: "group", attributes: { ome: { version: "0.5", multiscales: [{ name: `deer-valley-${c.name}-e${epoch}`,
      axes: [{ name: "y", type: "space", unit: "meter" }, { name: "x", type: "space", unit: "meter" }],
      datasets: Array.from({ length: MAP_LEVELS }, (_, l) => ({ path: String(l), coordinateTransformations: [{ type: "scale", scale: [spacing(l), spacing(l)] }] })),
      metadata: { method: MAP_LAW, description: c.name === "terrain" ? "the simulation terrain: exact at level 4, nearest below, decimate2 above" : "level 2 the living relief, levels 0-1 refine/2, levels 3-7 decimate2" } }] },
      russl: { channel: ch, axis_map: { y: "c7", x: "c8", channel: "c6" } } } }));
  }
  const desc = store.descriptor(false);
  desc.levels = desc.levels.map((L) => ({ ...L, roots: Object.fromEntries(CHANNELS.map((c) => [c.name, roots[`${c.name}/${L.level}`]])) }));
  desc.report = store.report; desc.epoch = epoch;
  bytes += put(base, `${rel}/zarr.json`, json({ zarr_format: 3, node_type: "group", attributes: { russl: desc } }));
  return { bytes, roots };
}

export async function bake(out, T = 6 * 96) {
  const rd = (f) => readFileSync(join(ROOT, f));
  const boot = simmyBoot(JSON.parse(rd("data/simmy/cells.json")), JSON.parse(rd("data/simmy/authority_workload_rails.json")));
  if (boot.sha256 !== SIMMY_REPLAY_SHA256) throw new Error("the Simmy replay did not reproduce its release digest");
  const engine = await createWasm1T(rd("web/xpu.wasm"));
  if (!(T > 0 && T % SHARD_EPOCHS === 0)) throw new Error(`epochs (${T}) must be a positive multiple of ${SHARD_EPOCHS}`);
  const years = T / YEAR;
  // replace only a store this tool made: OUTDIR must end in .zarr and, if it exists, hold our root zarr.json
  if (!out.endsWith(".zarr")) throw new Error("OUTDIR must end in .zarr");
  if (existsSync(out)) {
    let ours = false; try { ours = JSON.parse(readFileSync(join(out, "zarr.json"), "utf8")).attributes?.russl?.schema === REF_SCHEMA; } catch {}
    if (!ours) throw new Error(`${out} exists and is not a reference store made by this tool; remove it yourself`);
    rmSync(out, { recursive: true });
  }
  const t0 = Date.now(), v = new Valley({}, boot), map = new MapStore(v.cfg.seed, v), b20 = new Byte20(v, map);
  const genesis = { valley: v.digest, chain: b20.chain };
  let bytes = 0; const m0 = writeMap(out, "map/epoch-0000", map, 0); bytes += m0.bytes;
  console.log(`genesis map: ${(m0.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const epochs = [], pending = []; let shard = 0;
  for (let e = 1; e <= T; e++) {
    const r = await v.step(engine); map.weather(v); b20.compute(v, map);
    pending.push(new Uint8Array(b20.planes().buffer));
    epochs.push({ epoch: r.epoch, valley: v.digest, frame_sha256: b20.stats.frame_sha256, root: b20.stats.root, chain: b20.chain,
      striking: b20.stats.striking, latched: b20.stats.latched, deer: r.counts.deer, wolves: r.counts.wolves, wardens: r.counts.wardens });
    if (pending.length === SHARD_EPOCHS) { bytes += put(out, `byte20/0/c/${shard++}/0/0/0`, shardBytes(pending.splice(0))); }
    if (e % 48 === 0) console.log(`epoch ${e}: deer ${r.counts.deer}, wolves ${r.counts.wolves}, wardens ${r.counts.wardens}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const mT = writeMap(out, `map/epoch-${String(T).padStart(4, "0")}`, map, T); bytes += mT.bytes;
  bytes += put(out, "byte20/0/zarr.json", json({ zarr_format: 3, node_type: "array", shape: [T, B20_WORDS, N, N], data_type: "int32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [SHARD_EPOCHS, B20_WORDS, N, N] } }, chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0, codecs: shardingCodec([1, B20_WORDS, N, N]), dimension_names: ["t", "c", "y", "x"] }));
  bytes += put(out, "byte20/zarr.json", json({ zarr_format: 3, node_type: "group", attributes: {
    ome: { version: "0.5", multiscales: [{ name: "deer-valley-byte20", axes: [{ name: "t", type: "time" }, { name: "c", type: "channel" }, { name: "y", type: "space", unit: "meter" }, { name: "x", type: "space", unit: "meter" }],
      datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 4, 4] }] }], metadata: { method: BYTE20_LAW, description: "t = epoch - 1; c = words W0..W4; one 4 m block per sample" } }] },
    russl: { law: BYTE20_LAW, epoch_offset: 1, words: ["W0 geo/hydro", "W1 botany", "W2 fauna", "W3 look/sound", "W4 seal"], axis_map: { t: "c4", c: "c6", y: "c7", x: "c8" },
      chunk: "one epoch's .b20 frame: five little-endian int32 word planes of 128 x 128 blocks", genesis_chain: genesis.chain,
      chain: "D_e = SHA-256(pyDumps({law, previous, epoch, valley, frame})), frame = SHA-256 of the block-major frame (the planes transposed)",
      three_metric: { nominal_words: T * CELLS * B20_WORDS, true_stored_bits: T * CELLS * B20_WORDS * 32, rank_bound_per_plane: N }, epochs } } }));
  const last = epochs[epochs.length - 1];
  bytes += put(out, "zarr.json", json({ zarr_format: 3, node_type: "group", attributes: { russl: {
    schema: REF_SCHEMA, made_by: "tools/bake/reference.mjs", verify: "node tools/verify_reference.mjs [STORE] [--replay N|all]",
    profile: MAP_PROFILE, map_law: MAP_LAW, byte20_law: BYTE20_LAW, config: v.cfg, simmy_replay_sha256: boot.sha256,
    genesis: { valley: genesis.valley, chain: genesis.chain }, epochs: T, years, final: { epoch: last.epoch, valley: last.valley, chain: last.chain },
    contents: { "map/epoch-0000": "the living map at genesis", [`map/epoch-${String(T).padStart(4, "0")}`]: `the living map after ${T} epochs (${years} years)`, byte20: `the byte20 frame of every epoch 1..${T}` },
    codecs: { allowed: ["sharding_indexed", "bytes", "crc32c"], specification: "Zarr v3 core 3.1 and the sharding_indexed 1.0 codec; OME-NGFF 0.5" } } } }));
  console.log(`${T} epochs and two maps: ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s; final chain ${last.chain.slice(0, 16)}`);
  return { bytes, final: last };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), ei = a.indexOf("--epochs"), out = a.find((x, i) => !x.startsWith("--") && (ei < 0 || i !== ei + 1));
  if (!out) { console.error("usage: node tools/bake/reference.mjs OUTDIR.zarr [--epochs 576]"); process.exit(2); }
  await bake(resolve(out), ei >= 0 ? Number(a[ei + 1]) : 6 * YEAR);
}
