// Hostile containers: each one is internally consistent (digests, root and tuple id recomputed)
// so only the targeted rule can catch it. JS and the Python reference must both refuse.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRuss, RussError, canonicalJson, sha256, domainHash } from '../src/russ.js';
const enc = new TextEncoder();
const good = await readRuss(new Uint8Array(readFileSync(new URL('out/r1.russ', import.meta.url))));
async function pack(tuple, files, extra = {}) {
  const paths = [...files.keys()].sort(); const payload = [];
  for (const p of paths) payload.push({ path: p, sha256: await sha256(files.get(p)), size: files.get(p).length });
  const root = await domainHash('RUSS-PAYLOAD/1.0', enc.encode(canonicalJson(payload)));
  tuple = tuple.map(([n, c]) => [n, n === 'fabric' ? { ...c, payload_root_sha256: root } : c]);
  const tuple_id = 'russ:sha256:' + await domainHash('RUSS-TUPLE/1.0', enc.encode(canonicalJson(tuple)));
  const m = { ...good.manifest, ...extra, tuple, payload, payload_root_sha256: root, tuple_id };
  const raw = enc.encode(canonicalJson(m)); const head = new Uint8Array(24); const hv = new DataView(head.buffer);
  head.set([0x52, 0x55, 0x53, 0x53, 13, 10, 26, 10]); hv.setUint16(8, 1); hv.setUint16(10, 3); hv.setUint32(12, 1); hv.setBigUint64(16, BigInt(raw.length));
  const parts = [head, raw];
  for (const e of payload) { const p = enc.encode(e.path), r = new Uint8Array(44), rv = new DataView(r.buffer); rv.setUint32(0, p.length); rv.setBigUint64(4, BigInt(e.size)); r.set(e.sha256.match(/../g).map((h) => parseInt(h, 16)), 12); parts.push(r, p, files.get(e.path)); }
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out;
}
const T = () => JSON.parse(JSON.stringify(good.manifest.tuple));
const F = () => new Map(good.files);
const edit = (t, name, f) => t.map(([n, c]) => [n, n === name ? f(c) : c]);
const irText = new TextDecoder().decode(good.files.get('language/main.russir.json'));
const reIR = async (mut) => { const ir = JSON.parse(irText); mut(ir); delete ir.ir_id; const id = 'russir:sha256:' + await domainHash('RUSSIR/1.0', enc.encode(canonicalJson(ir))); ir.ir_id = id; return { bytes: enc.encode(canonicalJson(ir)), id }; };
const cases = [
  ['identity profile changed', async () => pack(edit(T(), 'identity', (c) => ({ ...c, profile: 'other' })), F())],
  ['arbitrary_code true', async () => pack(edit(T(), 'execution', (c) => ({ ...c, arbitrary_code: true })), F())],
  ['IR with a duplicate key', async () => { const f = F(); f.set('language/main.russir.json', enc.encode(irText.replace('{"defaults"', '{"defaults":{},"defaults"'))); return pack(T(), f); }],
  ['duplicated mechanics module', async () => pack(edit(T(), 'mechanics', (c) => ({ ...c, modules: [...c.modules, c.modules[0]] })), F())],
  ['geometry axes differ from descriptor', async () => pack(edit(T(), 'geometry', (c) => ({ ...c, axes: ['c4', 'c5', 'c6', 'c8', 'c7'] })), F())],
  ['language.source = "constructor"', async () => pack(edit(T(), 'language', (c) => ({ ...c, source: 'constructor' })), F())],
  ['FIELD_DEFINE arg null (IR ids recomputed)', async () => { const r = await reIR((ir) => { ir.program[0].arg = null; ir.frames[0].rows[0].arg = null; }); const f = F(); f.set('language/main.russir.json', r.bytes); return pack(edit(T(), 'language', (c) => ({ ...c, ir_id: r.id })), f); }],
  ['IR edited, ids recomputed (needs re-lowering)', async () => { const r = await reIR((ir) => { ir.program[2].lane = 'tampered'; ir.frames[0].rows[2].lane = 'tampered'; }); const f = F(); f.set('language/main.russir.json', r.bytes); return pack(edit(T(), 'language', (c) => ({ ...c, ir_id: r.id })), f); }],
  ['manifest extra key (schema)', async () => pack(T(), F(), { extra: 'x' })],
  ['manifest hash md5 (schema)', async () => pack(T(), F(), { hash: 'md5' })],
  ['manifest status lone surrogate', async () => pack(T(), F(), { status: '\ud800' })],
  ['provenance with a lone surrogate', async () => { const f = F(); f.set('evidence/provenance.json', enc.encode('{"note":"\\ud800"}')); return pack(T(), f); }],
  ['provenance with 100001 values', async () => { const f = F(); f.set('evidence/provenance.json', enc.encode('{"a":[' + Array(100001).fill(0).join(',') + ']}')); return pack(T(), f); }],
  ['field descriptor sparse "yes" (schema)', async () => { const f = F(); const fd = JSON.parse(new TextDecoder().decode(good.files.get('state/field_descriptor.json'))); fd.sparse = 'yes'; f.set('state/field_descriptor.json', enc.encode(canonicalJson(fd))); return pack(T(), f); }],
  ['admission policy not bound', async () => pack(edit(T(), 'admission', (c) => ({ ...c, policy: 'mssl/master_coupled_mechanics.mssl' })), F())],
];
mkdirSync(new URL('out/hostile/', import.meta.url), { recursive: true });
let ok = true; const corpus = process.argv[2];
for (const [name, make] of cases) {
  const bytes = await make(); const file = new URL(`out/hostile/${name.replace(/\W+/g, '_')}.russ`, import.meta.url); writeFileSync(file, bytes);
  let js; try { const r = await readRuss(bytes); js = r.problems.length ? 'reported' : 'ACCEPTED'; } catch (e) { js = e instanceof RussError ? 'refused: ' + e.message : 'CRASH ' + e.constructor.name + ': ' + e.message; }
  let py = 'not run';
  if (corpus) { try { execFileSync('python3', ['-B', '-c', `import sys;sys.path.insert(0,'${corpus}/tooling');import russ_container as rc;rc.verify_file(sys.argv[1],'${corpus}/machine/schemas')`, fileURLToPath(file)], { stdio: 'pipe' }); py = 'ACCEPTED'; } catch (e) { py = 'refused'; } }
  const pass = js.startsWith('refused') && py !== 'ACCEPTED'; ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: JS ${js} | Python ${py}`);
}
process.exit(ok ? 0 : 1);
