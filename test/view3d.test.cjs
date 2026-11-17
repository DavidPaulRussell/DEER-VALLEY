// The Deer Valley 3D view's life in Chromium (software WebGL): it starts, swaps in the full shaders when it
// started safe, rebuilds itself after a lost context, and falls back to safe graphics, remembered, when the
// context is lost while the full shaders compile. usage: node serve.mjs & node test/view3d.test.cjs
// SPDX-License-Identifier: GPL-3.0-only
const { chromium } = require('playwright');
const URL0 = process.env.PLUME_URL || 'http://127.0.0.1:8788/valley.html';
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  const errs = []; let pass = 0, fail = 0;
  const check = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`); };
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_|lost|reset|WebGL/.test(m.text()) && errs.push(m.text()));
  const view = () => p.evaluate(() => { const v = window.__valley?.view; return v ? { ready: v.ready, safe: v.safe, gfx: v.gfx, lost: v.lost, upgrading: v.upgradingNow, failed: v.failed ? String(v.failed.message) : null, frames: v.frameNo, P: v.P ? Object.keys(v.P).length : 0 } : null; });
  const waitView = (fn, t = 600000) => p.waitForFunction(fn, null, { timeout: t, polling: 500 });
  const nogl = () => p.evaluate(() => ({ shown: !document.getElementById('nogl').hidden, why: document.getElementById('nogl-why').textContent }));
  // 1. full graphics on a GPU that is not Direct3D ("auto" is full here)
  await p.goto(URL0 + '?q=low', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__valley && /Ready|failed/.test(document.getElementById('msg').textContent), null, { timeout: 300000 });
  await waitView(() => window.__valley.view?.ready === true);
  let v = await view();
  check('the view starts in full graphics where the GPU is not Direct3D', v.ready && !v.safe && v.gfx === 'full', JSON.stringify(v));
  await waitView(() => window.__valley.view.frameNo > 2);
  check('it draws frames', (await view()).frames > 2);
  check('the failure panel is hidden', !(await nogl()).shown);
  // 2. a lost context while drawing: a new view on a fresh canvas, same graphics
  await p.evaluate(() => window.__valley.view.gl.getExtension('WEBGL_lose_context').loseContext());
  await p.waitForTimeout(300);
  check('a lost context is explained over the view', /driver reset/.test((await nogl()).why), (await nogl()).why);
  await waitView(() => { const v = window.__valley.view; return v && !v.lost && v.ready === true && v.frameNo > 1; });
  v = await view();
  check('the view rebuilds itself after a lost context, still in full graphics', v.ready && !v.safe && !(await nogl()).shown, JSON.stringify(v));
  // 3. progressive: safe first, then the full shaders compiled behind it and swapped in
  await p.evaluate(() => localStorage.removeItem('plume.valley.gfx'));
  await p.goto(URL0 + '?q=low&gfx=progressive', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__valley?.view, null, { timeout: 300000 });
  await waitView(() => window.__valley.view.gfx === 'full');
  v = await view(); let st = await p.evaluate(() => window.__valleyGfx.state());
  check('progressive: the view starts safe, compiles the full shaders behind it and swaps them in', !v.safe && v.gfx === 'full' && st.events.join() === 'compiling,done', `${JSON.stringify(v)} events ${st.events}`);
  check('progressive: the browser remembers that full graphics work', st.memo?.mode === 'full', JSON.stringify(st.memo));
  // 4. the context lost while the full shaders compile (a safe view upgrading): safe graphics, remembered
  await p.evaluate(() => localStorage.removeItem('plume.valley.gfx'));
  await p.goto(URL0 + '?q=low&gfx=safe', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__valley?.view?.ready === true, null, { timeout: 300000 });
  check('?gfx=safe starts in safe graphics', (await view()).gfx === 'safe');
  await p.evaluate(() => { const v = window.__valley.view; v.upgrade().catch(() => {}); v.gl.getExtension('WEBGL_lose_context').loseContext(); });
  await p.waitForTimeout(300);
  check('a reset during the upgrade is explained', /safe graphics/.test((await nogl()).why), (await nogl()).why);
  await waitView(() => { const v = window.__valley.view; return v && !v.lost && v.ready === true; });
  v = await view(); st = await p.evaluate(() => window.__valleyGfx.state());
  check('after it, the view restarts in safe graphics and stays there', v.safe && v.gfx === 'safe' && !v.upgrading && st.events.includes('lost upgrading'), `${JSON.stringify(v)} events ${st.events}`);
  check('the browser remembers safe graphics for this version', st.memo?.mode === 'safe', JSON.stringify(st.memo));
  await p.goto(URL0 + '?q=low', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__valley?.view?.ready === true, null, { timeout: 300000 });
  check('the next visit starts in safe graphics straight away (no second reset)', (await view()).gfx === 'safe' && (await p.evaluate(() => !document.getElementById('gfx-safe').hidden)));
  // 5. "try full" forgets it
  await p.click('#gfx-safe');
  await waitView(() => window.__valley.view.gfx === 'full');
  check('"try full" compiles the full shaders again and switches', (await view()).gfx === 'full');
  check('and the browser forgets safe graphics', (await p.evaluate(() => window.__valleyGfx.state().memo?.mode ?? null)) !== 'safe');
  check('no page errors', errs.length === 0, errs.slice(0, 4).join('; '));
  await b.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
