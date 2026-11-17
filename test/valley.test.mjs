// SPDX-License-Identifier: GPL-3.0-only
// Deer Valley: the integer-lattice trust law against the exact Simmy oracle; determinism, save-file
// replay (git-able world), tamper detection, rewind, and identical results on two XPU engines.
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { createWasm1T, createWasmMT } from '../src/engines.js';
import { Valley, simmyBoot, latticePolicy, tickTrust, scoreL, MECHANISMS, U, RUNNING } from '../src/valley.js';
import { AGENTS, LEVELS, ORACLE_FIELDS, SIMMY_REPLAY_SHA256, Q } from '../src/simmy.js';

let pass = 0, fail = 0; const check = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`); };
const rd = (f) => readFileSync(new URL(f, import.meta.url));
const manifest = JSON.parse(rd('../data/simmy/cells.json')), workload = JSON.parse(rd('../data/simmy/authority_workload_rails.json'));
const spawn = (src) => { const w = new Worker(src, { eval: true }); const hs = new Set(); w.on('message', (m) => hs.forEach((h) => h(m))); w.on('error', (e) => hs.forEach((h) => h({ type: 'error', message: String(e) })));
  return { post: (m) => w.postMessage(m), onMessage: (f) => hs.add(f), offMessage: (f) => hs.delete(f), terminate: () => w.terminate() }; };

const boot = simmyBoot(manifest, workload);
check('the valley boots on the verified Simmy replay', boot.sha256 === SIMMY_REPLAY_SHA256);
check('every mechanism has a ready tick in the replay', MECHANISMS.every(([, sim]) => Number.isInteger(boot.ready[sim])), MECHANISMS.map(([k, s]) => `${k}@${boot.ready[s]}`).join(' '));

// The lattice law on the Simmy workload: levels, lifecycles, scores and reliabilities agree with the
// exact rational oracle on every tick (alpha and beta differ only by the floor of forgetting).
{
  const P = latticePolicy(boot.policy), n = AGENTS.length;
  const T = { alpha: new Float64Array(n).fill(P.a0), beta: new Float64Array(n).fill(P.b0), rel: new Uint16Array(n), level: new Uint8Array(n).fill(2), life: new Uint8Array(n), rev: new Uint8Array(n), cls: new Uint8Array(n) };
  const C = { transitions: 0, commits: 0, denials: 0, verdicts: 0, faults: 0 }; let fields = 0, bad = [];
  for (const t of workload.ticks) {
    const vA = new Float64Array(n), vB = new Float64Array(n), vD = new Uint8Array(n);
    for (const [idx, res, w] of workload.verdicts[t]) { if (res === 1) vA[idx] += P.w.gate_pass * w; else { vB[idx] += P.w.gate_fail * w; vD[idx] = 1; } }
    workload.inputs[t].forEach(([it, co, de, fl], i) => tickTrust(P, T, i, it, co, de, fl, vA[i], vB[i], vD[i], C));
    AGENTS.forEach((name, i) => {
      const want = workload.oracle[t][name];
      const got = { score: scoreL(P, T.alpha[i], T.beta[i]), level: LEVELS[T.level[i]], lifecycle: ['running', 'faulted', 'terminated'][T.life[i]], reliability: Q.of(T.rel[i], 65536).toString() };
      for (const f of ['score', 'level', 'lifecycle', 'reliability']) { fields++; if (got[f] !== want[f]) bad.push(`${t}:${name}.${f} ${got[f]} vs ${want[f]}`); }
      const ea = Math.abs(T.alpha[i] - Number(Q.of(...want.alpha.split('/').map(BigInt).concat(want.alpha.includes('/') ? [] : [1n])).mul(U).floor()));
      if (ea > 30) bad.push(`${t}:${name}.alpha off by ${ea} lattice units`);
    });
  }
  check(`lattice trust law = exact Simmy oracle on ${fields} level/score/lifecycle/reliability fields`, bad.length === 0, bad.slice(0, 4).join('; '));
}

const engine = await createWasm1T(rd('../web/xpu.wasm'));
const run = async (v, epochs, plan = {}) => { const out = []; for (let k = 0; k < epochs; k++) { const e = v.epoch + 1; for (const [kind, args] of plan[e] ?? []) v.intervene(kind, args); out.push((await v.step(engine)).digest); } return out; };
const plan = { 3: [['rain', { x: 40, y: 40, r: 8 }]], 9: [['fire', { x: 90, y: 60, r: 6 }], ['reserve', { x: 60, y: 20, w: 10, h: 12 }]], 14: [['wolves', { x: 20, y: 100, count: 6 }]], 20: [['warden', { x: 70, y: 26 }], ['release', {}]] };
const cfg = { boot: 'instant', deer: 2048, wolves: 24 };

const v1 = new Valley(cfg, boot);
const t0 = performance.now();
const d1 = await run(v1, 48, plan);
check('48 instant-boot epochs with 2,048 deer run with a balanced energy ledger every epoch', d1.length === 48 && v1.lastReport.ledger.ok, `${((performance.now() - t0) / 48).toFixed(1)} ms/epoch, deer ${v1.deer.n}, wolves ${v1.wolves.n}, wardens ${v1.wardens.n}`);
const v2 = new Valley(cfg, boot), d2 = await run(v2, 48, plan);
check('the same seed and interventions give the same 48 digests', d1.every((d, i) => d === d2[i]));
const v3 = new Valley({ ...cfg, seed: cfg.seed ?? 20261117 + 1, ...{ seed: 7 } }, boot), d3 = await run(v3, 4, {});
check('a different seed gives a different world', d3[3] !== d1[3]);

const save = v1.saveText();
check('the save file is small, plain text, one line per epoch', save.length < 12000 && save.split('\n').filter((l) => l.startsWith('epoch ')).length === 48, `${save.length} bytes`);
const replayed = await Valley.replay(save, boot, engine);
check('replaying the save file reproduces every epoch digest (git fsck)', replayed.digest === v1.digest && replayed.epoch === 48);
{
  const lines = save.split('\n'); const k = lines.findIndex((l) => l.startsWith('epoch 30 '));
  lines[k] = lines[k].replace(/epoch 30 ([0-9a-f])/, (m, c) => `epoch 30 ${c === '0' ? '1' : '0'}`);
  let msg = ''; try { await Valley.replay(lines.join('\n'), boot, engine); } catch (e) { msg = e.message; }
  check('a tampered epoch digest is caught at that epoch', /epoch 30 /.test(msg), msg.slice(0, 80));
  const forged = save.replace('intervention 9 fire {"r":6,"x":90,"y":60}', 'intervention 9 fire {"r":7,"x":90,"y":60}');
  msg = ''; try { await Valley.replay(forged, boot, engine); } catch (e) { msg = e.message; }
  check('an edited intervention changes history from its epoch on', /epoch 9 /.test(msg), msg.slice(0, 80));
  msg = ''; try { await Valley.replay(save.replace('intervention 20 release {}', 'intervention 20 release {"n":1}'), boot, engine); } catch (e) { msg = e.message; }
  check('a malformed intervention in a save file is refused', /takes no arguments/.test(msg), msg);
}
{ // rewind (checkout) and run again: the same future
  const v = new Valley(cfg, boot); await run(v, 20, plan); const snap = v.snapshot(); const a = await run(v, 12, plan);
  v.restore(snap); const b = await run(v, 12, plan);
  check('rewinding to a checkpoint and running again gives the same 12 epochs', a.every((d, i) => d === b[i]));
}
{ // the boot gates of the Simmy replay
  const v = new Valley({ deer: 512, wolves: 8 }, boot); const seen = [];
  for (let k = 0; k < 72; k++) { const r = await v.step(engine); if (r.counts.deer && !seen.includes('deer')) seen.push('deer', r.epoch); if (r.counts.wolves && !seen.includes('wolves')) seen.push('wolves', r.epoch); if (r.counts.wardens && !seen.includes('wardens')) seen.push('wardens', r.epoch); }
  check('Simmy boot: herds at the ECS tick, wolves at the fault tick, wardens at the human-behaviour tick', seen.join(' ') === `deer ${boot.ready[5]} wolves ${boot.ready[32]} wardens ${boot.ready[14]}`, seen.join(' '));
  let msg = ''; try { v.intervene('rain', { x: 1, y: 1, r: 2 }); } catch (e) { msg = e.message; }
  check('interventions wait for SIM_58 (Human-in-the-Loop)', /SIM_58/.test(msg) === (v.epoch + 1 < boot.ready[58]), msg || 'open');
}
{ // two engines, one world
  const nt = Math.min(4, os.cpus().length);
  const mt = await createWasmMT(rd('../web/xpu-mt.wasm'), nt, spawn);
  const a = new Valley(cfg, boot), b = new Valley(cfg, boot);
  let same = true; for (let k = 0; k < 16; k++) { const ra = await a.step(engine), rb = await b.step(mt); same &&= ra.digest === rb.digest; }
  check(`wasm-1t and wasm-mt(${nt}) produce identical worlds for 16 epochs`, same);
  mt.terminate?.();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
