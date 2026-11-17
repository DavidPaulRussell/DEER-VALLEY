# Plume XPU Console 1.4.0

ByteFoundry as a virtual XPU, in the pipeline

```
R0 (.russl + .russ) → ByteFoundry 1 (Z/2^20) → R1 (.russl + .russ) → ByteFoundry 2 (Z/5^8) → R2 (.russl + .russ)
```

Both XPU stages are written in **LCUF-A/0.3**, an array profile of LCUF that plays the part of
NumPy/PyTorch. The same LCUF-A program runs on three backends that give bit-identical results:
single-thread Wasm, multi-threaded Wasm (all CPU cores over one shared memory) and WebGPU.

## Run it

Double-click **`Start Plume.cmd`** on Windows, or run **`./start.sh`** on Linux or macOS. It opens Deer
Valley, and every page links to the others. It needs Node.js or Python 3, whichever you have:
- **With Node.js**, it serves `web/` on `http://127.0.0.1:8788` (already in JA21 Blank Console's
  `local_origins`) with cross-origin isolation headers, so Wasm threads are available. It opens JA21
  Blank Console if you have it, and your default browser otherwise.
- **With Python only**, the Python host (`host/plume_photon.py`) serves the same pages with the same
  isolation. It opens them in VEC1 Design Photon's verified window if Photon is found, and in your default
  browser otherwise. If Photon is found but fails its own release check, it refuses to run.

Other pages:
- **The console:** `"Start Plume.cmd" index.html`, or double-click `Start Plume XPU Console.cmd`.
- **The live presentation:** `"Start Plume.cmd" show.html`, or double-click `Start Plume XPU Live.cmd`.
  Run locally, it can use all CPU threads and your GPU; ← → or space moves between slides.
- **Also:** `simmy.html` and `verify.html`. Add `photon` after the page to use Design Photon even when
  Node.js is installed.
- **Verify R files:** drag `.russ` files onto `Verify R files.cmd` (or `node tools/verify_r.mjs
  file.russ …`), or drop them on the Verify R files page.
- **From disk:** opening `web/index.html`, or any page in `dist/`, works too, but only on one thread
  (browsers allow shared memory only on isolated pages). Without the shards, the 3D view falls back to
  procedural surfaces and template animals.
- **Stop** ends a long run on any CPU engine. Both CPU engines run off the page's main thread, so the
  console stays responsive.

To put it on GitHub as one repository:

    git init
    git config core.hooksPath tools/git-hooks      # the size gatekeeper runs before every commit
    git add -A
    git commit -m "Plume XPU Console 1.4.0"

One commit packs to about 663 MiB, under GitHub's 1 GB. `docs/SHARDS.md` explains the budget.

## Deer Valley

`web/valley.html` (or `dist/plume-deer-valley.html` as one file) runs a deterministic valley of deer,
wolves and wardens on the XPU, with a third-person 3D view. Save files replay to the same digests.

In the 3D view:
- Drag to orbit, scroll to zoom, and click a deer to follow it.
- Below 1.6 m the scroll wheel focuses on what lies under the centre and closes in to 0.5 mm.
- Shift + scroll, the `[` and `]` keys, or the lens menu change the focal length (14–2300 mm).
- The corner shows the frame time against the 60 fps budget.

The baked shards (`shards/materials`, `shards/animals`) are loaded when the page is served (by
`Start Plume.cmd`, `node serve.mjs` or the Python host). Without them the view falls back to procedural surfaces and
template animals. See `docs/FORMS_AND_EYE.md` for the animal, plant and stone forms, their continuum
equations, and the camera's eye law on four rails. See `docs/SHARDS.md` for what each shard holds, the
reference valley (six years of the default world as a sharded Zarr v3 store, checked by
`tools/verify_reference.mjs` and `tools/verify_reference.py`), and the GitHub size budget.

## R files: a 20-layer .russl program plus a .russ container

Each R is a RUSS 1.3 tuple-executable (`.russ`) holding 8 records:

| Record | Contents |
| --- | --- |
| `language/main.russl` | RUSSL/1.0 program: field definition, a 20-level `PYRAMID_DEFINE`, 20 `FIELD_SLICE` layers (`selector=mod2pow:j`), coupling, MSSL evaluation, admission, receipt |
| `language/main.russir.json` | its canonical IR, produced by `src/russl.js` (byte-identical to `russl_reference.lower_russl`) |
| `state/field.u32le` | the field, shape (1, 1, 8, 128, 128): c6 = lane, c7 = row, c8 = column; u32 words holding 20 bits |
| `state/field_descriptor.json` | RUSS.PenteractField/1.0 descriptor, `levels: 20` |
| `state/pyramid.json` | SHA-256 of the field mod 2^j for j = 1…20 |
| `evidence/provenance.json` | stage, XPU, law, steps, input tuple id, SHA-256 of the LCUF-A program |
| `mssl/master_coupled_mechanics.mssl`, `mssl/final_admission.mssl` | the digest-bound MSSL modules from the RUSSL corpus |

Every R chains to the one before it through `input_tuple_id`. Containers written by the console pass
`russ_container.verify_file` with the corpus schemas, and every `.russl` passes `parse_russl`.

### Verification without Python

`src/russl.js` ports RUSSL source canonicalization, parsing and lowering rule for rule, with the
same error codes, and `src/schema.js` ports the corpus schema subset with the three corpus schemas
embedded. Loading a `.russ` makes every check of `russ_container.verify_file(…, schemas)`:
structure, digests, payload root and tuple id; identity, authorization and allow-list boundaries;
MSSL bindings and admission policy; field binding; strict JSON (no duplicate keys, well-formed
Unicode, resource limits); and the three schemas. It then **re-lowers the .russl source and
requires the stored IR to be exactly that lowering**. Python is used only in the test suite, to show
the two implementations agree.

## The two XPU laws

| Stage | Ring | Step |
| --- | --- | --- |
| ByteFoundry 1 | Z/2^20 | P' = Life(P) + 2·((P + (P² ∨ 5)) ⊕ S), S = Moore sum of the next lane |
| ByteFoundry 2 | Z/5^8 | P' = Life(P) + 5·((P + 5P² + 1) ⊞ S), ⊞ = digit-wise addition mod 5 |

`x + 5x² + 1` is single-cycle on Z/5^8 (period 390,625, checked) and 1-Lipschitz in the 5-adic
metric, so BF2 keeps the hologram and cone properties of BF1 with 5-adic digits in place of bits.
There is no ring map between Z_2 and Z_5, so BF2 re-encodes its input (`from2`: digit 0 = bit 0,
digits 1–7 = (x >> 1) mod 5^7) and decodes its output (`to2`). The re-encoding drops the bits of
x >> 1 above 5^7; that loss is a property of crossing between the two rings, not an error.

## LCUF-A/0.3

```
LCUF-A/0.3
module <name>
ring p=<prime> n=<digits>          # p^n ≤ 2^21; p = 2 requires n = 20
frame lanes=8 height=128 width=128
phase | id | op | inputs | output | arg
init  | … one-time rows …
step  | … rows repeated for each step …
final | … one-time rows …
end
```

`in` is the input frame and the program must write `out`. Constant arguments act in the ring
(they are reduced mod p^n). Every operation is 1-Lipschitz in the p-adic metric, so any LCUF-A
program keeps the hologram property: layer j of the output depends only on layer j of the input.
The console's **Check hologram** button tests this across R0 → R1. Rows are checked statically: known op,
arity, names written before they are read, a row's output differs from its inputs, at most 16 frame
registers. Operations: `copy life rot nsum sq mul mulc add addc orc dadd shift from2 to2 modj`
(the console's operation list describes each).

Backends: `src/xpu.c` (compiled to `web/xpu.wasm` and the threaded `web/xpu-mt.wasm`) runs each row
as a whole-frame native loop, with workers splitting the rows and meeting at a barrier after each
row. The single-thread build runs in its own worker in the browser. The threaded build has a
progress watchdog: worker 0 counts completed rows in shared memory, and a run stops only when that
count has not moved for 30 s. The WGSL kernel in `src/lcufa.js` runs one compute dispatch per row.
`referenceRun` in the same file is an independent JS interpreter used for cross-checks.

## Verified

| Suite | Cases | What it shows |
| --- | --- | --- |
| `node test/xpu.test.mjs` | 36 | BF1, BF2 and BF1→BF2 bit-exact against NumPy on 1 thread, threads and the worker engine; JS reference = native; compiler diagnostics; engine refusals; overlapping runs; a worker killed mid-run; a silent worker caught by the watchdog; a long run not cut off; Stop on both CPU engines |
| `node test/russ.test.mjs` | 13 | R0/R1/R2 round-trip and rebuild reproducibly; truncated, oversized, trailing and path-escaping containers refused |
| `node test/russl.test.mjs <corpus>` | 28 | JS lowering = Python lowering: byte-identical IR on 12 corpus sources and 3 templates, same error code on 6 invalid vectors and 7 mutations |
| `node test/hostile.test.mjs <corpus>` | 15 | crafted containers (ids recomputed) refused by both JS and Python, including an edited IR only re-lowering can catch and four schema-only cases |
| `node test/page.test.cjs` (with `node serve.mjs`) | 13 | the built console in Chromium: controls locked during start-up; **WebGPU bit-identical to both CPU engines** and the hologram holds on it; Stop; recovery; tampered IR refused |

Run `python3 test/ref_numpy.py` and `node test/russ.test.mjs` first: they write the reference frames
and the R files (`test/out/`) the other suites read.

WebGPU was verified on Chromium's software adapter (SwiftShader), so results are exact but its
timings are not representative of a real GPU. `./build.sh` ends with a smoke test of the built page.

## Build

`./build.sh` (clang 18 with wasm32/wasm-ld, Node 22, Python 3 for the bundling step, Playwright for
the smoke test; `SKIP_SMOKE=1` skips it). `node tools/make_r_templates.mjs` regenerates the three
.russl programs and their IR with `src/russl.js`. `python3 test/ref_numpy.py` writes the NumPy
reference frames the tests use.
