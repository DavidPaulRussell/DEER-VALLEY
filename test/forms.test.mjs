// SPDX-License-Identifier: GPL-3.0-only
// Deer Valley forms and the eye: continuum equations stay in range and move the right way, the eye law's
// four-rail cards retract and stay invariant, the spectral sun behaves, the detail grid keeps every octave in
// phase, and the baked shards are whole (sha-256) and under GitHub's per-file limit.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deerContinuum, wolfContinuum, wardenContinuum, ANIMAL_DIMS, WARDEN_DIMS, PLANT_FORMS, PLANT_DIM_ORDER, ROCK_FORM, ROCK_DIM_ORDER, formUniforms, plantMaturity, growth } from '../src/valley3d_forms.js';
import { checkCards, fovAt, focalLength } from '../src/valley3d_eye.js';
import { sunColor, BIN_RGB, hazeExtinction } from '../src/valley3d_atmos.js';
import { T_MIN } from '../src/valley3d_detail.js';

let pass = 0, fail = 0; const check = (n, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n} ${info}`); };
const r0 = () => 0, inRange = (t) => t.every((x) => x >= 0 && x <= 1);
const at = (dims, t, k) => t[dims.indexOf(k)];

// ---- continuum equations
const deer = (age, male, extra = {}) => deerContinuum({ age, male, cond: 1, rut: false, winter: false, genes: [0, 0, 0], r: r0, ...extra });
const fawn = deer(0.08, false), doe = deer(4, false), buck = deer(4, true), rutBuck = deer(4, true, { rut: true }), old = deer(9, true);
check('deer: every dimension in [0, 1] at every age, sex and season', [fawn, doe, buck, rutBuck, old, deer(2, true, { winter: true, cond: 0.5 })].every((f) => inRange(f.t) && f.t.length === 16));
check('deer: size grows with age (von Bertalanffy) and bucks outgrow does', fawn.size < deer(0.5, false).size && deer(0.5, false).size < doe.size && doe.size < buck.size, `${fawn.size.toFixed(2)} < ${doe.size.toFixed(2)} < ${buck.size.toFixed(2)}`);
check('deer: fawns are leggy with big ears and short faces', at(ANIMAL_DIMS, fawn.t, 'legs') > at(ANIMAL_DIMS, doe.t, 'legs') && at(ANIMAL_DIMS, fawn.t, 'ears') > at(ANIMAL_DIMS, doe.t, 'ears') && at(ANIMAL_DIMS, fawn.t, 'head') < at(ANIMAL_DIMS, doe.t, 'head'));
check('deer: the rut swells a buck\'s neck and tucks his flank', at(ANIMAL_DIMS, rutBuck.t, 'neckBase') > at(ANIMAL_DIMS, buck.t, 'neckBase') && at(ANIMAL_DIMS, rutBuck.t, 'tuck') > at(ANIMAL_DIMS, buck.t, 'tuck'));
check('deer: hunger tucks the flank, plenty fills the haunch', at(ANIMAL_DIMS, deer(4, false, { cond: 0.6 }).t, 'tuck') > at(ANIMAL_DIMS, deer(4, false, { cond: 1.3 }).t, 'tuck') && at(ANIMAL_DIMS, deer(4, false, { cond: 1.3 }).t, 'haunch') > at(ANIMAL_DIMS, deer(4, false, { cond: 0.6 }).t, 'haunch'));
const pup = wolfContinuum({ age: 0.2, male: true, cond: 1, r: r0 }), wolf = wolfContinuum({ age: 4, male: true, cond: 1, r: r0 });
check('wolf: in range; a pup is smaller and leggier than a grown male', inRange(pup.t) && inRange(wolf.t) && pup.size < wolf.size && at(ANIMAL_DIMS, pup.t, 'legs') > at(ANIMAL_DIMS, wolf.t, 'legs'));
const wd = wardenContinuum({ height: 1.1, girth: 1.18, hatBrim: 1.2, hatCrown: 1.25 }, r0), ws = wardenContinuum({ height: 0.93, girth: 0.9, hatBrim: 0.85, hatCrown: 0.8 }, r0);
check('warden: in range; the tall heavy warden is taller and broader', inRange(wd.t) && at(WARDEN_DIMS, wd.t, 'height') > at(WARDEN_DIMS, ws.t, 'height') && at(WARDEN_DIMS, wd.t, 'build') > at(WARDEN_DIMS, ws.t, 'build'));
check('plants and stones: each class gives seven (plants) or six (stones) [min, max, exponent] triples', Object.values(PLANT_FORMS).every((F) => formUniforms(F, PLANT_DIM_ORDER).length === 21) && formUniforms(ROCK_FORM, ROCK_DIM_ORDER).length === 18);
check('plants: maturity never falls with age and stays in [0, 1]', ['juniper', 'willow', 'blueberry'].every((k) => { let p = -1; for (let a = 0; a < 2000; a += 7) { const m = plantMaturity(k, a); if (m < p - 1e-12 || m < 0 || m > 1) return false; p = m; } return true; }));
check('growth curve: 0 at birth, rising, below 1', growth(0, 1) === 0 && growth(1, 1) > growth(0.5, 1) && growth(50, 1) < 1 + 1e-12);

// ---- the eye's four-rail cards
const cards = checkCards();
check('eye: every card\'s check holds (footprint invariance, retraction, zoom continuum, thin lens)', cards.every((c) => c.ok), cards.filter((c) => !c.ok).map((c) => c.card).join(' '));
check('eye: the lens runs 14 mm to ~2300 mm', Math.abs(focalLength(fovAt(0)) * 1000 - 14.9) < 1 && Math.abs(focalLength(fovAt(1)) - 2.29) < 0.05);

// ---- the spectral sun and haze
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const noon = sunColor(0.95), low = sunColor(0.05), set = sunColor(-0.2);
check('sun: brighter high than low, redder low, gone below the horizon', lum(noon) > lum(low) && low[0] / low[2] > noon[0] / noon[2] && lum(set) === 0, `noon ${noon.map((x) => x.toFixed(2))} low ${low.map((x) => x.toFixed(2))}`);
check('sun: above the atmosphere its luminance is 3.45 units', Math.abs(BIN_RGB.reduce((s, c) => s + lum(c), 0) - 3.45) < 3.45e-3, BIN_RGB.reduce((s, c) => s + lum(c), 0).toFixed(4));
const hz = hazeExtinction(2050, 9);
check('haze: Rayleigh makes blue extinguish faster than red', hz[2] > hz[1] && hz[1] > hz[0]);

// ---- the detail grid: every octave of every tile is a whole number of T_MIN steps
const tiles = [1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.02];
check('detail: all octaves of all tiles are whole multiples of T_MIN (patterns hold their phase)', tiles.every((t) => [0, 1, 2, 3, 4].every((k) => { const q = t / 8 ** k / T_MIN; return Math.abs(q - Math.round(q)) < 1e-6; })));

// ---- the shards
const sh = new URL('../shards/', import.meta.url);
if (existsSync(new URL('animals/deer.json', sh))) {
  let whole = true, under = true, files = 0;
  for (const cls of ['deer', 'wolf', 'warden']) {
    const jf = new URL(`animals/${cls}.json`, sh); if (!existsSync(jf)) { whole = false; continue; }
    const J = JSON.parse(readFileSync(jf));
    for (const L of J.lods) for (const f of Object.values(L.files)) {
      const parts = (f.parts ?? [f.file]).map((n) => readFileSync(new URL(`animals/${n}`, sh))); files += parts.length;
      parts.forEach((b) => { if (b.length >= 25_000_000) under = false; });
      if (createHash('sha256').update(Buffer.concat(parts)).digest('hex') !== f.sha256) whole = false;
    }
  }
  check('shards: the three classes\' forms are whole (sha-256) and every file is under 25 MB', whole && under, `${files} files`);
} else console.log('SKIP  shards/animals not present');
if (existsSync(new URL('materials/materials.json', sh))) {
  const M = JSON.parse(readFileSync(new URL('materials/materials.json', sh)));
  check('shards: 24 material sets, every file present and under 25 MB', M.sets.length === 24 && M.sets.every((s) => s.files.every((f) => { const p = new URL(`materials/${f}`, sh); return existsSync(p) && statSync(p).size < 25_000_000; })));
} else console.log('SKIP  shards/materials not present');
if (existsSync(new URL('zarr/deer-valley-reference.zarr/zarr.json', sh))) {
  const { verify } = await import('../tools/verify_reference.mjs'), r = await verify(fileURLToPath(new URL('zarr/deer-valley-reference.zarr', sh)), { replay: 8 });
  check('shards: the reference valley (Zarr v3, sharded) is whole, its 576-epoch byte20 chain holds, and a fresh replay reproduces it', r.ok,
    r.ok ? `${r.stats.shards} shards, ${r.stats.epochs} epochs, ${r.stats.levels} map levels; replayed 8 epochs and the genesis map` : r.problems.slice(0, 3).join('; '));
} else console.log('SKIP  shards/zarr not present');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
