// Browser test of the built console over the isolated local server, with software WebGPU.
// usage: node serve.mjs & node test/page.test.cjs
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] });
  const p = await b.newPage({ viewport: { width: 1360, height: 1100 } }); const errs = []; let pass = 0, fail = 0;
  const check = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`); };
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_/.test(m.text()) && errs.push(m.text()));
  const idle = (id) => p.waitForFunction((i) => !document.getElementById(i).disabled, id, { timeout: 120000 });
  await p.goto('http://127.0.0.1:8788/', { waitUntil: 'domcontentloaded' });
  check('controls are locked while engines start', await p.evaluate(() => document.getElementById('b-run').disabled && document.getElementById('b-compare').disabled));
  await p.waitForFunction(() => /done|stopped|failed/.test(document.getElementById('run-msg').textContent), null, { timeout: 120000 });
  const eng = await p.textContent('#engines');
  check('start-up pipeline finishes', /^done/.test(await p.textContent('#run-msg')), await p.textContent('#run-msg'));
  check('three engines available (1 thread, threads, WebGPU)', /1 thread/.test(eng) && /threads/.test(eng) && /WebGPU/.test(eng), eng);
  await p.click('#b-compare'); await idle('b-compare');
  const cmp = (await p.textContent('#cmp')).replace(/\s+/g, ' ');
  check('compare: every engine identical to the displayed R2, including WebGPU', (cmp.match(/identical/g) || []).length === 3 && !/DIFFERS/.test(cmp), cmp.slice(0, 200));
  await p.selectOption('#sel-engine', 'webgpu'); await p.click('#b-run'); await idle('b-run');
  check('pipeline runs on WebGPU', /^done.*WebGPU/.test(await p.textContent('#run-msg')), await p.textContent('#run-msg'));
  await p.click('#b-holo'); await idle('b-holo');
  check('hologram holds on WebGPU', /hologram holds/.test(await p.textContent('#run-msg')));
  // Stop a long run on the 1-thread worker engine, then run again
  await p.selectOption('#sel-engine', 'wasm-1t'); await p.fill('#st-2', '5000'); await p.dispatchEvent('#st-2', 'change');
  await p.click('#b-run'); await p.waitForTimeout(1500);
  check('page stays responsive during a long 1-thread run', await p.evaluate(() => { const t = performance.now(); return performance.now() - t < 50; }));
  await p.click('#b-stop'); await idle('b-run');
  const stopped = await p.textContent('#run-msg');
  check('Stop ends the run', /stopped at BF2: stopped/.test(stopped), stopped);
  check('R2 is cleared after a stopped stage, R1 kept', await p.evaluate(() => /not run/.test(document.getElementById('n-r2').textContent) && !/not run/.test(document.getElementById('n-r1').textContent)));
  await p.fill('#st-2', '40'); await p.dispatchEvent('#st-2', 'change'); await p.click('#b-run'); await idle('b-run');
  check('engine works again after Stop', /^done/.test(await p.textContent('#run-msg')), await p.textContent('#run-msg'));
  await p.setInputFiles('#in-file', 'test/out/hostile/IR_edited_ids_recomputed_needs_re_lowering_.russ'); await p.waitForFunction(() => /refused|loaded/.test(document.getElementById('r0-msg').textContent));
  check('a tampered IR is refused on load', /refused.*binding mismatch/.test(await p.textContent('#r0-msg')), await p.textContent('#r0-msg'));
  await p.setInputFiles('#in-file', 'test/out/r2.russ'); await p.waitForFunction(() => /loaded r2/.test(document.getElementById('r0-msg').textContent), null, { timeout: 30000 });
  check('a good R2 loads as R0 with full verification', /lowering/.test(await p.textContent('#r0-msg')));
  check('no page errors', errs.length === 0, errs.join('; '));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
