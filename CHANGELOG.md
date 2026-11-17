# Changelog

## 1.4.1 — 2026-11-17 (the 3D view on Windows, and a view that recovers)

### Fixed
- **`3D view unavailable: terrain link:`** with an empty log on Windows. Reproduced on an AMD Radeon
  (Renoir) under Chrome on Direct3D 11. Linking the terrain program made the browser restart its GPU
  process, which lost every WebGL and WebGPU context on the page.
  - Browsers on Windows run WebGL through ANGLE, which compiles HLSL with Direct3D's FXC when a program
    links.
  - The shadow PCF, the bloom bright pass and the depth of field read textures with implicit derivatives
    inside loops. ANGLE marks such loops `[loop]`/`[flatten]`, and FXC rejects them under divergent flow.
    ANGLE then retries with other settings, each one a full, slow compile of a large shader.
  - Those taps now use `textureLod` (the targets have no mipmaps, so the result is the same).
  - The material library's octave and parallax loops carry `u_keepLoops` in their bound, a uniform that is
    never set, so FXC cannot unroll them. The 2 × 2 corner taps are written out.
  - No vector is indexed by a variable, and the detail origin no longer divides integers. The CPU computes
    each material's quotient and remainder every frame. This is exact: checked equal to integer division
    over 8 million cases.
  - The terrain picks its two strongest materials without arrays.
  - The terrain's macro hole and the fur's level-of-detail dither discard at the end of the shader, after
    every derivative and loop.
  - The atmosphere's integration loops get the same treatment.
  - Translated on that machine, no shader has a gradient loop left, and no fragment shader an emulated
    dynamic index (the grass vertex shader keeps three, which are harmless). The sky, water, grass, plant,
    strand and post programs link there in 0.04–1.6 s. The terrain links in safe graphics (1.3 s).
- **Shards from `dist/` and `web/`**: pages served by any static server now find `../shards/` (before,
  only the Plume hosts served them).
- The sky's tables fall back to 8-bit targets where the context cannot render half float. Colour targets
  use half float with `EXT_color_buffer_half_float` alone. The shadow map is held within
  `MAX_TEXTURE_SIZE`.
- The view's overlays now hide: a CSS `display` rule had beaten `[hidden]`.
- The macro and probe state are initialised; the line that set them sat inside a comment.

### Added and hardened
- **Shaders compile without blocking the GPU process**: every compile and link is queued, then
  `KHR_parallel_shader_compile`'s completion status is polled between frames, with progress shown over
  the view. A slow driver no longer trips the browser's GPU watchdog.
- **A view that recovers**: a lost WebGL context (driver reset, GPU process restart) rebuilds the view on
  a fresh canvas and waits while the browser holds WebGL back. After three losses in two minutes it stops
  and explains why.
- **Safe graphics and a progressive start.** Safe graphics leaves out the close-up material detail and
  strand fur; nothing else changes.
  - On Direct3D the view starts in safe graphics and compiles the full-detail programs behind it, then
    swaps them in.
  - If the driver resets on them, the view restarts in safe graphics. The browser remembers what worked
    until the console is updated.
  - `?gfx=safe`, `?gfx=full`, `?gfx=auto` and `?gfx=progressive` (safe first, then full, on any GPU) choose
    the mode, and a chip over the view tries full again.
- **Failures explained**: the reason and the GPU's name, with buttons to try again, switch graphics mode,
  or open the new page below.
- **Check the 3D view** (`check3d.html`, `dist/plume-check-3d.html`).
  - It compiles every program on its own, safe variants first, timing each one and stopping at a reset.
  - It audits the Direct3D HLSL where the browser shows it and builds every kind of render target.
  - It starts the renderer and gives a copyable report.
  - The Python host opens it with `--page check3d.html`.
- `test/view3d.test.cjs`: the view's start, upgrade, recovery and fallback in Chromium (15 cases).
- `tools/check_shaders.mjs`: a static check that no fragment shader has a gradient operation inside a
  loop, directly or through a call, and no long loop of texture lookups that FXC could unroll. It flags all
  22 hazards in 1.4.0 and none now.

### Changed
- **The launchers run on VEC1 Design Photon, not Node.js.**
  - `Start Plume.cmd`, `start.sh` and `Verify R files.cmd` use the Python host and Design Photon by
    default. They need Python 3.10 or newer, found the way Photon's own launcher finds it (`py -3`, `python`,
    `python3`, version-checked).
  - Node.js is used only when asked for (`"Start Plume.cmd" valley.html node`). `start.sh` also falls
    back to it when there is no Python.
  - `PHOTON_HOME` defaults to `Desktop\Project12k\languages\Photon-main\Photon-main`.
  - The host also finds Photon's zip there, and names any extraction that lacks `VEC1\app.py`: one cut short
    by Windows' path length. It then extracts Photon to `C:\VEC1\DesignPhoton`, after asking.
  - `PLUME_NODE` and `PLUME_BLANK` name another Node.js or JA21 Blank Console for the Node.js route.

### Known
- On the AMD Radeon tested, the full-detail terrain still reset the driver in the tests made before the
  last two changes: no integer division, and the discard moved last. Those changes are untested on that
  GPU. Either way the view comes up there in safe graphics and stays usable.

## 1.4.0 — 2026-11-17 (Deer Valley: a living valley in the third person)

### Added
- **Deer Valley** (`web/valley.html`, `dist/plume-deer-valley.html`): a deterministic, git-able world of
  deer, wolves and wardens on the Plume XPU, booted from the verified Simmy replay.
  - The living map law `deer.valley.living/1` (genesis, five rain passes, settling, weathering) stores
    the valley as RUSSL-Zarr chunks.
  - The `deer.valley.byte20/1` chain records every epoch.
- **The third-person view** (WebGL2):
  - sixteen-dimension **animal forms** for deer and wolves and a twelve-dimension warden form. Each
    form is sculpted anatomy baked as minimum and maximum extremes over one shared mesh (three levels
    of detail), and is set by **continuum equations** from age, sex, condition, season and the E12
    genetic axes;
  - **strand fur** (up to 2¹⁹ hairs) on the nearest animal, with Marschner R/TT/TRT shading;
  - **plant and stone forms** (seedling to old growth, pebble to boulder);
  - a **spectral sky** (Rayleigh, Mie and ozone at eight wavelengths, Hillaire-style LUTs);
  - a **material library** of 24 sets with up to five octaves of stochastically tiled detail;
  - **macro** focus down to 0.5 mm, using camera-relative rendering and reversed floating depth;
  - a **focal-length zoom** (14–2300 mm) with a thin-lens depth of field;
  - the **eye law**: one footprint rule for all detail, with dithered level-of-detail fades and
    adaptive shadows. Its four-rail cards are in `docs/FORMS_AND_EYE.md`;
  - a **60 fps governor** with per-pass GPU timing.
- **Shards** (`shards/`, see `docs/SHARDS.md`): baked material sets, the animal forms and the reference
  valley. Every file is under 22.5 MB. `shards/MANIFEST.json` gives each file's SHA-256 and its metrics
  (nominal entries, true stored bits, rank bound, deflated size).
- **The reference valley** (`shards/zarr/deer-valley-reference.zarr`): the default world run for six
  years, as a sharded Zarr v3 / OME-NGFF 0.5 store. It holds the living map at genesis and at epoch 576,
  and all 576 byte20 frames with their chain. It is checked two ways:
  - `tools/verify_reference.mjs` re-runs the world and compares every byte;
  - `tools/verify_reference.py` reads it independently from the specifications.
- **Verify R files** (`web/verify.html`, `dist/plume-verify-r.html`): drop .russ files to check them in
  the page. It is also the page behind the Photon host's `--verify` mode, which now works end to end.
- **One way to start**: `Start Plume.cmd` on Windows and `start.sh` on Linux and macOS. Each opens
  Deer Valley with Node.js if it is installed, otherwise with Python. The Python host runs in Design
  Photon's window when Photon is found, and in the default browser otherwise (`--no-photon`).
  `Start Plume XPU Console.cmd` and `Start Plume XPU Live.cmd` now call it with their own pages.
- **Git files**: a `.gitignore` and a `.gitattributes` (batch files are checked out with CRLF).
- **Photon host** (`host/plume_photon.py`): serves the console with Host, Origin and token guards and
  a verification API.
- Tests: `test/forms.test.mjs` (continuum equations, the eye's cards, the spectral sun, the detail grid
  and shard integrity) and `test/valley.test.mjs`.

### Changed
- **The size gatekeeper** (`tools/check_github_limits.py`, `.cmd`) checks the payload (the tree outside
  .git) and `.git/objects` separately. Before, it added them together, but the tree is a checked-out copy
  of what .git holds, and GitHub measures the git objects.
- **The servers** (`serve.mjs`, the Photon host) serve Zarr chunk files, which have no extension, under
  `/shards/zarr/` only.
- **Pages in `dist/`** link to each other by their `dist/` names.
- **The wolf form** stands on its toes with a wolf's proportions: chest depth about half its height,
  upright forearms and a hock a quarter of the way up.

### Limits
- The animals are procedural sculpts. They are much closer to real deer and wolves than before, but
  they are not photographs.
- The screenshots were rendered headless in software. No GPU frame times were measured in the build
  environment.
- The hybrid traced lighting is not in this release. Its G-buffer (albedo, normal, identity) is.

## 1.3.0 — 2026-11-02 (faster CPU engine; live presentation)

### Added
- **Plume XPU Live** (`web/show.html`, published separately): an eight-slide presentation that runs the
  real engines on the viewer's own machine: hardware detection, a live Pixel160 cell, a plume cone,
  the R0 → R2 pipeline with verified files, an engine race (bar length = measured speed), all 20
  hologram layers, a tamper test, and a scoreboard with a Copy-as-CSV button.
- **A plain-JavaScript baseline** in the race: the BF1 law written as ordinary typed-array loops, so
  every speed claim is measured against what a programmer would write without the XPU. All engines,
  the baseline included, produce the same digest.

### Changed — CPU engine (LCUF-A compiler 0.3.2)
- **The Life rule is now vectorised.** It used a per-lane variable shift (`survive >> live`), which
  Wasm SIMD has to scalarise; it took 2.7 ms of a ~3.7 ms BF1 step. It is now nine
  compare-and-select steps, which are exact for any B/S rule. **BF1 on one thread: about 35 → 80 M
  lane-updates/s on the build machine**; plain JavaScript managed ~49 M/s there, so one Wasm thread
  now beats it by ~1.6× and two threads by ~2.2×.
- Ring parameters are copied into locals before each loop (globals in linear memory blocked
  vectorisation) and the 2-adic ring has mask-based loops.
- Row fusion: consecutive point-wise rows run block by block (64 cells) with one barrier per run.
- BF2: a two-digit table halves the divisions in base-5 digit addition (about 9 → 13 M/s on one
  thread). Division by the modulus still dominates BF2 on the CPU; the GPU is unaffected.

All results are unchanged: every suite still matches NumPy and Python bit for bit.

## 1.2.0 — 2026-11-02 (second audit; Python-free verification)

### Added
- **RUSSL lowering in the console's own toolchain** (`src/russl.js`): a port of
  `russl_reference.parse_russl` / `lower_russl`, rule for rule, with the same error codes. Loading a
  .russ now re-lowers its .russl source and refuses the file unless the stored IR is exactly that
  lowering. This closes the last check that only the Python tool could make.
- **No Python in the user-facing path.** `Verify R files.cmd` runs `tools/verify_r.mjs` on the
  portable Node from bytefoundry-0.99.2-win64, and `tools/make_r_templates.mjs` generates the
  R0/R1/R2 programs with `src/russl.js`. Python remains only in the test suite, as an independent
  cross-check (`test/verify_r_python.py`, `test/make_r_templates_python.py`, `test/ref_numpy.py`).
- `test/russl.test.mjs`: JS and Python lowering agree on 28 cases (12 corpus examples with
  byte-identical IR, 6 invalid vectors with the same error code, the 3 R templates, 7 mutations).
- Hostile tests: an edited IR with every id recomputed (only re-lowering can catch it) and six
  schema/strict-JSON cases; JS and Python refuse all 15 crafted containers.
- `test/page.test.cjs`: the built console in Chromium with software WebGPU. **The WebGPU backend is
  now verified**: bit-identical to both CPU engines, and the hologram holds on it.

### Fixed (second independent review)
- **The 1.2.0 build itself was broken during development**: the new scoped bundler dropped all but
  the first name of `export const A = …, B = …` lines, so the page failed at start-up. The bundler
  now takes each module's export list from Node's module loader, and `build.sh` ends with a browser
  smoke test of the built page.
- **Clicking Run or Compare while engines were still starting locked the console for good.** Controls
  stay locked until start-up finishes, every action guards a missing engine, and every busy section
  releases in `finally`.
- **The threaded engine's time limit killed long legitimate runs** (a 255-row, 80-step program in
  Z/3^13 was retired at 100 s). The limit is replaced by a progress watchdog: worker 0 counts finished
  rows in shared memory and a run stops only after 30 s with no progress.
- **Single-thread runs froze the page** (up to ~74 s at 5000 BF2 steps). The single-thread engine now
  runs in a worker in the browser. A new **Stop** button cancels a run on either CPU engine and
  leaves the engine usable. WebGPU read-back has a time limit and reports device loss as `broken`.
- **A stopped engine was not always retired** (the hologram check, and WebGPU after device loss). All
  engine calls go through one wrapper that retires stopped engines and falls back.
- **A pipeline that stopped part-way left misleading state** (fresh R1 shown stale, old R2 timing).
  The stage that did not finish and everything after it are cleared.
- **readRuss still accepted files the Python verifier refuses**: lone-surrogate strings, JSON with
  more than 100,000 values (only containers were counted), and schema violations (extra manifest
  keys, `hash: "md5"`, `container_mode`, descriptor `sparse: "yes"`). Every value is now counted,
  strings and keys must be well-formed Unicode, provenance must parse, and the corpus schemas are
  enforced (`src/schema.js`).
- **C engine:** `load_program` counts could wrap in u32 and `run(nt=0)` divided by zero; both refused.
- **Windows paths** in the tools and tests now use `fileURLToPath`.
- A replaced single-thread worker's late exit event could reject the next run (found while testing Stop).

### Changed
- The build gives every module its own scope (a small scoped bundler in `build.sh`), so modules can
  share helper names safely. Hashing and canonical JSON now live once, in `src/russl.js`.

## 1.1.0 — 2026-11-02 (audit and hardening)

LCUF-A compiler 0.3.1 (language LCUF-A/0.3 unchanged; every 1.0.0 program still compiles and gives the same results).

### Fixed
- **Engines disagreed on `addc` with a large constant in odd rings.** `a + c` wrapped at 2^32 in C and
  WGSL but not in the JS reference (131,070 of 131,072 words differed in Z/5^8). Constants for
  `addc`, `mulc` and `orc` are now reduced mod p^n by the compiler, and again inside each engine.
- **`ring p=5 n=0` was accepted** (a one-element ring). n must be at least 1.
- **The local server crashed on a malformed URL** (`/%E0%A4%A` threw an unhandled URIError and took
  the console down). It now answers 400; it also refuses sibling-folder escapes (`/../web-evil/…`),
  NUL bytes and methods other than GET/HEAD, and sends `nosniff` and `no-referrer`.
- **readRuss threw raw RangeError/TypeError on truncated or hostile files.** It now performs every
  structural check of `russ_container.verify_bytes` (size limits, manifest bounds, strict UTF-8 JSON,
  entry keys, safe and unique paths, record bounds, sorted records, no trailing data, tuple arity and
  order, identity/geometry/state profile, authorization and allow-list boundaries) and refuses with a
  clear `RussError`.
- **A worker that died left the threaded engine waiting forever.** Worker errors now reject the run
  and stop the engine; start-up has a 20 s limit.
- **Results could go stale silently.** Recompiling or restoring a program, or changing a step count,
  now marks R1 and R2 stale until the pipeline runs again.
- **Programs could change mid-run.** A run now snapshots both programs and step counts, and every
  control is disabled while a run, comparison or check is in progress.
- Engine and WGSL error text is escaped before it is shown.

- **The threaded engine could hang forever** (found by the independent review): a second run
  started while one was in flight, or a worker killed mid-run, left `run()` pending with every
  control disabled. Runs are now queued per engine, every run has a time limit, worker exits and
  unreadable messages count as failures, and a stopped engine is retired and the console falls back
  to one thread.
- **Seeding or loading R0 during a run could mislabel R1** (review): R1 could be computed from the old
  R0 while recording the new R0's tuple id. Seeding and loading now lock the controls, and a run
  snapshots R0 and refuses to finish if R0 changes underneath it.
- **readRuss accepted containers the Python verifier rejects** (review): identity profile,
  `arbitrary_code: true`, payload root, duplicate JSON keys, duplicated or unbound MSSL modules,
  geometry/descriptor axes, admission policy binding, a payload path named `constructor`, and a null
  FIELD_DEFINE argument. All are now refused, and JS and Python agree on every hostile test file.
  A file with any problem is no longer loaded as R0.
- **Engines disagreed on input words of 2^21 or more in odd rings** (review): all engines now refuse
  frames whose words exceed 20 bits.
- **canonicalJson sorted keys by UTF-16 unit, not code point, and accepted unsafe integers**
  (review): it now sorts by code point and refuses integers beyond 2^53.
- LCUF-A: `ring p=02` and register names such as `__proto__` or `undefined` are refused (review).
- Compare engines now checks every engine against the displayed R2 when it is current (review).
- The WebGPU wrapper releases its buffers when read-back fails (review).

### Hardened
- The C engine validates its own inputs: `configure` refuses non-prime p, n < 1, p^n > 2^21 and
  p = 2 with n ≠ 20; `load_program` refuses out-of-range ops, slots, `rot` and `modj` arguments and
  aliased outputs. Both return 0 and the JS wrapper reports the refusal.
- All engines refuse step counts outside 1…100,000 and inputs that are not 131,072 words.
- The parser caps source length (64 KB), argument digits and ring digits before testing primality.
- WebGPU runs inside validation and out-of-memory error scopes and stops cleanly when the device is lost.
- Loaded fields with bits above bit 19 are masked to 20 bits and the loss is reported.
- readRuss checks the IR's integrity without the Python tooling: `ir_id` and `source_sha256` must
  recompute, MSSL bindings must match their module digests, and the field must be 1,1,8,128,128 u32.

### Added
- **Check hologram:** for layers j = 1, 2, 4, 8, 12, 16, 20, runs BF1 on R0 reduced mod 2^j and
  compares the result's layer j with R1's stored layer j.
- Provenance in every R now records the console version and the LCUF-A compiler version.
- Version shown in the console header.
- New tests (31 engine and compiler, 13 container, 8 hostile-container parity): compiler diagnostics,
  constant reduction across all CPU engines, engine refusals, overlapping runs, a worker killed
  mid-run, truncated/oversized/trailing/escaping containers, and eight crafted containers that JS and
  the Python reference must both refuse.

## 1.0.0 — 2026-11-02
First release: R0 → BF1 (Z/2^20) → R1 → BF2 (Z/5^8) → R2, LCUF-A/0.3, Wasm 1-thread and
multi-thread engines, WebGPU kernel, RUSS 1.3 containers verified by the RUSSL reference tooling.
