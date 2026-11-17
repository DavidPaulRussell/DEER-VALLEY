# Deer Valley: forms, continuum equations and the eye

This note describes how the 3D view gives every animal, warden, plant and stone its own shape, and
how the camera keeps the same image quality at any zoom or angle. The code is in `src/valley3d_forms.js`,
`tools/bake/animals.py`, `src/valley3d_eye.js` and the shaders in `src/valley3d_shaders.js`. The tests
are in `test/forms.test.mjs`. None of this changes the simulation or its digests.

## 1. Classes, dimensions and extremes

Each class has named shape dimensions. Each dimension has a **minimum form** and a **maximum form**.
An individual is a point `t ∈ [0, 1]^n` between them.

| Class | Dimensions (minimum → maximum) |
| --- | --- |
| deer | barrel (slab-sided → barrel-chested), brisket (shallow → deep), shoulder (light scapula and triceps → heavy), haunch (light haunch and ham → heavy), tuck (full belly → tucked flank), neckBase (slender → swollen), throat (fine → thick throat-latch), neckLen, legs, body (short-coupled → long-backed), head (short face → long Roman face), skull (narrow → broad with jowls), ears, tail, withers (flat → high), croup (level → steep) |
| wolf | the same sixteen, with wolf extremes (deep narrow keel, ruff, long brush, paws) |
| warden | height (1.58 → 1.95 m), build, shoulders, belly, legs, arms, head, neck, hatBrim, hatCrown, jacket length, boot height |
| juniper, willow, blueberry | height, trunk radius, crown/height, limbs, lean, foliage, dead wood (seedling → old growth) |
| rock | radius (4 cm pebble → 2.6 m boulder), lumps, fracture, flatness, moss, burial |

**Animals and wardens.** `tools/bake/animals.py` builds the anatomy as signed-distance primitives fused
with smooth unions. A deer is built from:
- the ribcage barrel, brisket, withers and loin;
- scapula and triceps masses;
- the haunch, ham and flank fold;
- the neck and its crest;
- the cranium, brow, muzzle, nasal bridge, rhinarium, jaw, jowls and supraorbital ridges;
- the legs joint by joint (olecranon, knee, cannon, fetlock, stifle, gastrocnemius, Achilles tendon,
  hock, point of hock);
- cloven hooves with dewclaws, and the tail.

The base form (every dimension at ½) is polygonised by surface nets at 6.5, 13 and 28 mm. Each extreme
is reached from the base mesh in two steps:
1. Every vertex is carried with the primitives that hold it: each primitive's own map from the base to
   the extreme, blended by influence.
2. The vertex is settled onto the extreme's surface by Newton steps.

All extremes therefore share one topology. The renderer draws

    P(t) = P_base + Σ_k (t_k − ½) · ΔP_k        (normals and skeleton joints the same way)

on the GPU: deltas live in textures and each animal's `t` lives in its bone-texture row. Skinning weights
come from the primitives' bones, blended by the same influences. Coat colours are blended across
regions by influence, so there are no seams. Ears and eyes are parametric parts, regenerated at every
extreme.

**Plants and stones.** These are generated in their vertex shaders from a seed, so their extremes are
uniforms, `[min, max, exponent]` per dimension:

    value(s) = min + (max − min) · s^e

For a plant, `s` is its maturity. For a stone, `s` is its size on a log scale:
`s = log(r / 0.04) / log(65)`.

## 2. Continuum equations (state → t)

Growth is von Bertalanffy, `G(a) = 1 − exp(−k a)`. The inputs are age in years, sex, condition
(energy relative to normal), season (rut, winter), the E12 genetic shape axes (bulk, legs, head) in
standard deviations, and the individual's own variation `r_k ∈ [−½, ½]`.

For deer, `G = G(a; 1.6)` and `G2 = G(a; 0.75)`; fawnhood is `exp(−a / 0.55)`. Some of the equations:

    barrel   = 0.22 + 0.50 G2 + 0.12 male + 0.25 (cond − 1) + 0.06 g_bulk + 0.08 r
    neckBase = 0.30 + 0.30 G2 + 0.12 male + 0.35 rut·male + 0.06 r
    tuck     = 0.45 − 0.45 (cond − 1) + 0.30 rut·male + 0.12 winter + 0.08 r
    legs     = 0.42 + 0.40 fawnhood + 0.10 g_legs + 0.08 r
    size     = (0.42 + 0.58 G) · (1.04 + 0.04 G2 if male else 0.96) · (1 + 0.035 g_bulk + 0.05 r)

Every value is clamped to [0, 1]. The full set is in `deerContinuum`, `wolfContinuum` and
`wardenContinuum`. Plant maturity is `G(age / span; 2.2)`. It is raised by vigour (E6) and held back
under the canopy (E1).

## 3. The eye: one law, four rails

The law: every point on screen is drawn with detail matched to the surface its pixel covers. At
distance `d`, angle `φ` from the surface normal, vertical field of view `F` and an image `H` pixels tall:

    θ = 2 tan(F/2) / H        ρ = d θ / max(cos φ, ε)

Everything follows `ρ`:
- material octaves;
- mesh level of detail;
- blade and card counts;
- the near shadow cascade's extent;
- the lens.

So the image keeps its sharpness and stays free of popping whether the camera is 0.5 mm from fur, at
6 m with a 25 mm lens, or at 300 m with a 1000 mm lens.

The four rails follow the apparatus of the LittleBit notes (`L → T_LA[L] → T_8S[·] → T_cal[·]`). The
mapping onto rendering is ours, and each card is checked numerically by `checkCards()`:

| Card | Rail I (law) | Rail II (operator) | Rail III (8-state lift) | Rail IV (continuum) |
| --- | --- | --- | --- | --- |
| EYE-1 footprint | `ρ = d θ / cos φ` | the screen-to-surface Jacobian (`dFdx`, `dFdy`); its singular values are the footprint's axes | octave weights `w_k = 1 − smoothstep(1.2 s_k/n, 6 s_k/n, √det J)`; retracts to `k* = ⌊log₈(s₀/(n ρ))⌋` | one texel per pixel: the integral over the image is W·H, whatever d, F or φ |
| EYE-2 mesh level | `l* = log₂(260 / px)` | `px = s h H / (2 d tan(F/2))` | dithered cross-fades `f01`, `f12` between neighbouring meshes; retracts to round(l*) | vertex density per pixel; its integral is the frame's vertex budget (the governor's) |
| EYE-3 focal length | `F(z) = F_wide (F_tele/F_wide)^z` | log F is affine in z | every footprint state follows F | `∫ d(log F) = log(F_tele/F_wide)` |
| EYE-4 lens | `CoC = f² / (N (z_f − f)) · |z − z_f| / z` | affine in 1/z | disc blur sampled 16 ways; CoC < 0.2 px retracts to the sharp image | the in-focus fraction of the depth histogram |

The lens runs from 14 mm to about 2300 mm (full-frame equivalent). Use Shift + wheel, the `[` and `]`
keys, or the lens menu. Below 1.6 m, the wheel switches to macro: it focuses on what lies under the
centre of the screen (a pixel probe read back without stalling) and closes in to half a millimetre.

## 4. Frame time

The governor (`src/valley3d_perf.js`) aims at 16.7 ms per frame:
- When frames take more than about 18 ms, it first lowers the render scale (1.0, 0.85, 0.72), then
  the quality level.
- When frames take less than about 11 ms for a few seconds, it steps back up.
- With `EXT_disjoint_timer_query_webgl2`, it uses GPU time per pass (sky, shadow, scene, water, post).
  These times are shown in the corner of the view.

The figures in this repository's screenshots come from a software renderer (SwiftShader) and are not
GPU frame times.

## 5. Limits

- The animals are procedural sculpts built from measured proportions. They are not scans, so they do
  not yet look like photographs.
- Strand fur is drawn only on the nearest animal. Up close it is dense; at mid distances the coat is a
  shaded surface with a hair texture.
- The hybrid traced lighting is not in this release. The G-buffer it needs (albedo, normal, identity)
  is in place.
