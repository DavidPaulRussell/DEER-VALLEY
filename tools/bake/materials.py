#!/usr/bin/env python3
"""Bake the Deer Valley material library: 24 tileable material sets at 2048 x 2048 for close-up detail.

    python3 -B tools/bake/materials.py OUT_DIR [--only N,N] [--size 2048]

Each set is two PNG files:
  NN_name_ah.png   RGB albedo (sRGB) and A height (0..255 over the set's height range)
  NN_name_nr.png   RG tangent-space normal (x, y as 0.5 + 0.5 n), B roughness, A cavity occlusion
Each texture tiles seamlessly: every field is built periodic (Fourier-filtered noise, Voronoi cells on the
torus, shapes stamped with wrap-around). A set's physical tile size and height range are recorded in
materials.json together with its mean albedo, so the renderer can lay the detail over its own colours.
The generators are deterministic: the same seed gives the same bytes. Requires numpy, scipy and Pillow.
SPDX-License-Identifier: GPL-3.0-only
"""
from __future__ import annotations

import json, sys, time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
from scipy import ndimage

R = 2048


# ------------------------------------------------------------------ periodic building blocks
def rng_for(k: int) -> np.random.Generator:
    return np.random.default_rng(0x5EED_0000 + k)


def fbm(rng, beta=2.0, lo=1.0, hi=None, aniso=None, n=None):
    """Periodic fractal noise by Fourier filtering of white noise: amplitude ~ f^(-beta/2) between lo and hi
    cycles per tile; aniso = (angle, ratio) stretches it along a direction. Zero mean, unit deviation."""
    n = n or R
    w = rng.standard_normal((n, n)).astype(np.float32)
    F = np.fft.rfft2(w)
    fy = (np.fft.fftfreq(n) * n)[:, None]; fx = (np.fft.rfftfreq(n) * n)[None, :]
    if aniso:
        a, ratio = aniso; u = fx * np.cos(a) + fy * np.sin(a); v = -fx * np.sin(a) + fy * np.cos(a); f = np.sqrt(u * u + (v * ratio) ** 2)
    else:
        f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    amp = f ** (-beta / 2.0)
    amp[f < lo] = 0.0
    if hi: amp = amp * np.exp(-(f / hi) ** 2)
    out = np.fft.irfft2(F * amp, s=(n, n)).astype(np.float32)
    out -= out.mean(); out /= out.std() + 1e-9
    return out


def unit(x, lo=0.01, hi=0.99):
    a, b = np.quantile(x, [lo, hi]); return np.clip((x - a) / (b - a + 1e-9), 0, 1).astype(np.float32)


def grid(n=None):
    n = n or R
    c = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.stack(np.meshgrid(c, c, indexing="xy"), -1).reshape(-1, 2)


def voronoi(rng, count, n=None, k=2, warp=None):
    """Voronoi on the unit torus: (F1, F2, nearest index) per texel; warp = (dx, dy) fields in tile units."""
    n = n or R
    pts = rng.random((count, 2))
    tree = cKDTree(pts, boxsize=1.0)
    g = grid(n)
    if warp is not None: g = np.mod(g + np.stack([warp[0].ravel(), warp[1].ravel()], -1), 1.0)
    d, idx = tree.query(g, k=k, workers=-1)
    F1 = d[:, 0].reshape(n, n).astype(np.float32); F2 = d[:, 1].reshape(n, n).astype(np.float32) if k > 1 else None
    return F1, F2, idx[:, 0].reshape(n, n), pts


def cell_values(rng, count):
    return rng.random(count).astype(np.float32)


def blur(x, s):
    return ndimage.gaussian_filter(x, s, mode="wrap")


def ridged(x):
    return 1.0 - np.abs(x)


def mix(a, b, t):
    t = t[..., None] if t.ndim == 2 and a.ndim == 3 else t
    return a * (1 - t) + b * t


def col(rgb):
    return np.array(rgb, dtype=np.float32)[None, None, :]


def stamp_wrap(draw_fn, n=None, mode="L", bg=0):
    """Draw on a 3n canvas and fold it onto n x n, so shapes crossing an edge wrap around."""
    n = n or R
    big = Image.new(mode, (3 * n, 3 * n), bg); d = ImageDraw.Draw(big); draw_fn(d, n)
    a = np.asarray(big, dtype=np.float32)
    out = np.zeros((n, n) + a.shape[2:], dtype=np.float32)
    for j in range(3):
        for i in range(3):
            out = np.maximum(out, a[j * n:(j + 1) * n, i * n:(i + 1) * n])
    return out


# ------------------------------------------------------------------ normals, cavity, encoding
def normal_rough_ao(h, height_m, tile_m, rough):
    """Normal from the height field (metres), cavity occlusion from local relief."""
    hm = h * height_m; px = tile_m / h.shape[0]
    gx = (np.roll(hm, -1, 1) - np.roll(hm, 1, 1)) / (2 * px); gy = (np.roll(hm, -1, 0) - np.roll(hm, 1, 0)) / (2 * px)
    nz = 1.0 / np.sqrt(1 + gx * gx + gy * gy); nx = -gx * nz; ny = gy * nz        # +y up in texture space
    local = blur(h, 6) - h; ao = np.clip(1.0 - np.maximum(local, 0) * 3.0, 0.3, 1.0)
    return np.stack([nx * 0.5 + 0.5, ny * 0.5 + 0.5, np.clip(rough, 0, 1), ao], -1)


def to_srgb(lin):
    lin = np.clip(lin, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def save_rgba(path, rgba, srgb_rgb=False):
    a = rgba.copy()
    if srgb_rgb: a[..., :3] = to_srgb(a[..., :3])
    Image.fromarray(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8), "RGBA").save(path, optimize=False, compress_level=7)


# ------------------------------------------------------------------ the 24 materials
def m_meadow_soil(k):
    r = rng_for(k); base = unit(fbm(r, 1.7, 2)); grain = fbm(r, 0.6, 64, 900)
    albedo = mix(col([0.085, 0.064, 0.044]), col([0.19, 0.145, 0.095]), base)
    albedo *= (0.85 + 0.15 * unit(grain))[..., None]
    # thatch: dead blades at random angles
    th = np.zeros((R, R), np.float32)
    for a in r.random(5) * np.pi:
        th = np.maximum(th, unit(fbm(r, 1.2, 12, 700, aniso=(a, 9.0))) ** 6)
    albedo = mix(albedo, col([0.40, 0.33, 0.19]) * (0.75 + 0.5 * base[..., None]), np.clip(th * 1.3, 0, 1))
    # pebbles
    F1, F2, idx, _ = voronoi(r, 2600); cv = cell_values(r, 2600)
    rad = (0.25 + 0.6 * cv[idx]) * (0.6 / np.sqrt(2600)); peb = np.clip(1 - F1 / rad, 0, 1) * (cv[idx] < 0.22)
    pc = mix(col([0.30, 0.28, 0.25]), col([0.52, 0.47, 0.40]), cell_values(r, 2600)[idx])
    albedo = mix(albedo, pc, np.clip(peb * 6, 0, 1))
    roots = unit(ridged(fbm(r, 1.5, 6, 300))) ** 40
    albedo = mix(albedo, col([0.05, 0.035, 0.025]), roots * 0.7)
    h = 0.45 * unit(fbm(r, 2.0, 2)) + 0.25 * np.sqrt(peb) + 0.15 * th + 0.08 * unit(grain) - 0.1 * roots
    return albedo, unit(h), 0.9 - 0.15 * peb, dict(tile_m=1.0, height_m=0.014)


def m_dry_soil(k):
    r = rng_for(k); warp = (fbm(r, 2.2, 2) * 0.012, fbm(r, 2.2, 2) * 0.012)
    F1, F2, idx, _ = voronoi(r, 380, warp=warp); edge = F2 - F1
    crack = np.clip(1 - edge / 0.006, 0, 1) ** 1.5
    plate = np.clip(edge / 0.04, 0, 1)
    grit = unit(fbm(r, 0.4, 100, 1000))
    albedo = mix(col([0.30, 0.25, 0.17]), col([0.43, 0.37, 0.27]), unit(fbm(r, 1.6, 3)))
    albedo *= (0.88 + 0.24 * grit)[..., None]; albedo = mix(albedo, col([0.12, 0.09, 0.06]), crack)
    h = 0.55 * (0.4 + 0.6 * np.sqrt(plate)) + 0.1 * grit - 0.5 * crack + 0.1 * unit(fbm(r, 2, 2))
    return albedo, unit(h), 0.92 - 0.1 * crack, dict(tile_m=1.0, height_m=0.01)


def m_sand(k):
    r = rng_for(k); g = grid().reshape(R, R, 2); warp = fbm(r, 2.4, 1.5)
    rip = np.sin(2 * np.pi * (g[..., 1] * 26 + warp * 0.8 + 0.15 * np.sin(2 * np.pi * g[..., 0] * 3)))
    grains = fbm(r, 0.0, 300, 1100); sparkle = (unit(fbm(r, 0.0, 500, 1100)) > 0.985).astype(np.float32)
    albedo = mix(col([0.42, 0.37, 0.27]), col([0.60, 0.54, 0.41]), unit(fbm(r, 1.2, 4)))
    albedo *= (0.85 + 0.3 * unit(grains))[..., None]; albedo = mix(albedo, col([0.85, 0.83, 0.78]), sparkle * 0.7)
    dark = (unit(grains) < 0.06).astype(np.float32); albedo = mix(albedo, col([0.12, 0.11, 0.10]), dark * 0.6)
    h = 0.6 * (0.5 + 0.5 * rip) + 0.25 * unit(grains) + 0.15 * unit(fbm(r, 2, 2))
    return albedo, unit(h), 0.85 - 0.4 * sparkle, dict(tile_m=1.0, height_m=0.008)


def m_mud(k):
    r = rng_for(k); low = unit(fbm(r, 2.3, 1.5)); fine = unit(fbm(r, 0.8, 60, 800))
    pits = voronoi(r, 900)[0]; pit = np.clip(1 - pits / 0.006, 0, 1)
    wet = np.clip((0.42 - low) * 6, 0, 1)
    albedo = mix(col([0.10, 0.085, 0.065]), col([0.20, 0.16, 0.11]), low) * (0.9 + 0.2 * fine)[..., None]
    albedo = mix(albedo, albedo * 0.55, wet)
    h = 0.7 * low + 0.1 * fine - 0.2 * pit
    return albedo, unit(h), np.clip(0.65 - 0.5 * wet - 0.1 * pit, 0.08, 1), dict(tile_m=1.0, height_m=0.012)


def granite(r, count=42000):
    F1, F2, idx, _ = voronoi(r, count); t = cell_values(r, count)[idx]; shade = cell_values(r, count)[idx]
    quartz = col([0.50, 0.50, 0.50]) * (0.8 + 0.3 * shade[..., None]); feld = mix(col([0.80, 0.72, 0.64]), col([0.86, 0.84, 0.80]), shade)
    bio = col([0.05, 0.05, 0.05]) * (1 + shade[..., None])
    a = np.where((t < 0.33)[..., None], quartz, np.where((t < 0.86)[..., None], feld, bio))
    edge = np.clip(1 - (F2 - F1) / 0.0015, 0, 1)
    return a, edge, t


def m_rock(k):
    r = rng_for(k); a, edge, t = granite(r)
    stain = unit(fbm(r, 1.8, 2, aniso=(np.pi / 2, 3.0))); oxide = np.clip((stain - 0.62) * 3, 0, 1)
    albedo = a * (0.78 + 0.3 * unit(fbm(r, 1.4, 3)))[..., None]
    albedo = mix(albedo, col([0.42, 0.26, 0.14]), oxide * 0.55)
    # lichen: discs with rough rims, two species
    F1, _, idx, _ = voronoi(r, 260); cv = cell_values(r, 260)[idx]; rr = (0.3 + 0.7 * cell_values(r, 260)[idx]) * 0.03
    rim = F1 + 0.006 * fbm(r, 1.0, 40, 400)
    lichen = np.clip((rr - rim) / 0.002, 0, 1) * (cv < 0.45)
    lc = np.where((cv < 0.2)[..., None], col([0.66, 0.63, 0.30]), col([0.52, 0.56, 0.47])) * (0.85 + 0.3 * unit(fbm(r, 0.5, 120, 900)))[..., None]
    albedo = mix(albedo, lc, lichen)
    cracks = unit(ridged(fbm(r, 1.7, 3, 600))) ** 30
    albedo = mix(albedo, col([0.04, 0.04, 0.04]), cracks * 0.8)
    h = 0.5 * unit(fbm(r, 2.1, 2)) + 0.12 * (1 - edge) * (t > 0.33) + 0.12 * lichen - 0.35 * cracks
    return albedo, unit(h), 0.78 - 0.25 * (t < 0.33) * (1 - lichen) + 0.1 * lichen, dict(tile_m=1.0, height_m=0.025)


def m_scree(k):
    r = rng_for(k); F1, F2, idx, pts = voronoi(r, 520); n = len(pts)
    gx = (cell_values(r, n) - 0.5)[idx]; gy = (cell_values(r, n) - 0.5)[idx]; g = grid().reshape(R, R, 2)
    d = np.mod(g - pts[idx] + 0.5, 1.0) - 0.5
    facet = 0.5 + 1.6 * (gx * d[..., 0] + gy * d[..., 1]) / 0.05
    gap = np.clip(1 - (F2 - F1) / 0.006, 0, 1)
    stone = (cell_values(r, n)[idx])
    a, edge, _ = granite(r, 30000)
    albedo = a * (0.45 + 0.35 * stone)[..., None] + col([0.05, 0.05, 0.05])
    albedo = mix(albedo, col([0.05, 0.045, 0.04]), gap)
    h = np.clip(facet, 0, 1) * (1 - gap) * (0.6 + 0.4 * stone)
    return albedo, unit(h), 0.82 + 0.0 * h, dict(tile_m=1.0, height_m=0.07)


def pebbles(r, count, palette, wet=False):
    F1, F2, idx, pts = voronoi(r, count); cv = cell_values(r, count)[idx]; cs = cell_values(r, count)[idx]
    rad = 0.55 / np.sqrt(count) * (0.65 + 0.5 * cs)
    dome = np.sqrt(np.clip(1 - (F1 / rad) ** 2, 0, 1))
    pal = np.array(palette, np.float32); pc = pal[np.minimum((cv * len(pal)).astype(int), len(pal) - 1)]
    tex = (0.82 + 0.3 * unit(fbm(r, 0.6, 80, 900)))[..., None]
    return dome, pc * tex, cs


def m_gravel(k):
    r = rng_for(k); dome, pc, _ = pebbles(r, 1500, [[0.42, 0.40, 0.37], [0.50, 0.44, 0.36], [0.36, 0.30, 0.26], [0.62, 0.60, 0.56], [0.48, 0.33, 0.25], [0.30, 0.30, 0.31]])
    fill = mix(col([0.30, 0.26, 0.20]), col([0.45, 0.40, 0.31]), unit(fbm(r, 0.8, 50)))
    albedo = mix(fill, pc, np.clip(dome * 4, 0, 1))
    h = 0.75 * dome + 0.15 * unit(fbm(r, 0.6, 60))
    return albedo, unit(h), 0.75 - 0.2 * (dome > 0.5), dict(tile_m=1.0, height_m=0.045)


def m_stream_bed(k):
    r = rng_for(k); dome, pc, _ = pebbles(r, 900, [[0.34, 0.33, 0.30], [0.40, 0.36, 0.30], [0.28, 0.25, 0.22], [0.52, 0.50, 0.46]])
    algae = np.clip((unit(fbm(r, 1.8, 2)) - 0.45) * 2.5, 0, 1)
    albedo = mix(col([0.16, 0.14, 0.10]), pc, np.clip(dome * 4, 0, 1)) * 0.7
    albedo = mix(albedo, col([0.16, 0.20, 0.08]), algae * 0.6)
    h = 0.8 * dome + 0.1 * unit(fbm(r, 0.6, 60))
    return albedo, unit(h), 0.22 + 0.15 * (1 - dome) + 0.2 * algae, dict(tile_m=1.0, height_m=0.04)


def m_moss(k):
    r = rng_for(k); cushion = unit(fbm(r, 2.4, 2)); F1, F2, idx, _ = voronoi(r, 70000); leaflet = np.clip(1 - F1 / 0.0022, 0, 1)
    star = unit(fbm(r, 0.2, 400, 1100)); tone = cell_values(r, 70000)[idx]
    albedo = mix(col([0.10, 0.18, 0.04]), col([0.34, 0.48, 0.10]), tone * 0.6 + 0.4 * cushion) * (0.7 + 0.5 * leaflet)[..., None]
    capsules = (voronoi(r, 900)[0] < 0.0018).astype(np.float32)
    albedo = mix(albedo, col([0.50, 0.24, 0.10]), capsules)
    h = 0.6 * cushion + 0.25 * leaflet + 0.1 * star + 0.3 * capsules
    return albedo, unit(h), 0.8 + 0.0 * h, dict(tile_m=0.5, height_m=0.02)


def leaves_layer(r, n, shapes, palette):
    def draw(d, N):
        for _ in range(n):
            x, y = r.random(2) * N + N; a = r.random() * np.pi; L = shapes[0] * N * (0.6 + 0.8 * r.random()); W = L * shapes[1]
            c, s = np.cos(a), np.sin(a); pts = []
            for t in np.linspace(0, 1, 9):
                w = W * np.sin(np.pi * t); pts.append((x + c * (t - 0.5) * L - s * w, y + s * (t - 0.5) * L + c * w))
            for t in np.linspace(1, 0, 9):
                w = -W * np.sin(np.pi * t); pts.append((x + c * (t - 0.5) * L - s * w, y + s * (t - 0.5) * L + c * w))
            v = int(1 + r.random() * 254); d.polygon(pts, fill=v)
    lab = stamp_wrap(draw); pal = np.array(palette, np.float32)
    idx = np.minimum((lab / 255.0 * len(pal)).astype(int), len(pal) - 1)
    return (lab > 0).astype(np.float32), pal[idx]


def m_leaf_litter(k):
    r = rng_for(k)
    m1, c1 = leaves_layer(r, 900, (0.05, 0.18), [[0.36, 0.22, 0.10], [0.50, 0.36, 0.14], [0.62, 0.48, 0.18], [0.30, 0.20, 0.12], [0.44, 0.30, 0.16]])
    m2, c2 = leaves_layer(r, 2500, (0.03, 0.04), [[0.30, 0.22, 0.14], [0.40, 0.30, 0.18], [0.24, 0.18, 0.12]])
    soil = mix(col([0.07, 0.05, 0.035]), col([0.14, 0.10, 0.07]), unit(fbm(r, 1.5, 3)))
    albedo = mix(mix(soil, c2, m2), c1, m1) * (0.85 + 0.3 * unit(fbm(r, 0.6, 60, 900)))[..., None]
    h = 0.3 * unit(fbm(r, 2, 2)) + 0.35 * m2 + 0.5 * m1
    return albedo, unit(h), 0.85 + 0.0 * h, dict(tile_m=0.5, height_m=0.012)


def m_snow(k):
    r = rng_for(k); g = grid().reshape(R, R, 2); warp = fbm(r, 2.4, 1.5)
    drift = np.sin(2 * np.pi * (g[..., 0] * 7 + warp * 1.2)); grains = unit(fbm(r, 0.0, 400, 1100)); glint = (grains > 0.993).astype(np.float32)
    h = 0.6 * unit(fbm(r, 2.2, 2)) + 0.25 * (0.5 + 0.5 * drift) + 0.15 * grains
    albedo = mix(col([0.70, 0.76, 0.86]), col([0.93, 0.94, 0.96]), unit(h)) * (0.95 + 0.05 * grains)[..., None]
    return albedo, unit(h), 0.6 - 0.45 * glint, dict(tile_m=1.0, height_m=0.012)


def m_forest_duff(k):
    r = rng_for(k)
    def needles(d, N):
        for _ in range(9000):
            x, y = r.random(2) * N + N; a = r.random() * np.pi; L = N * (0.008 + 0.012 * r.random())
            d.line([(x - np.cos(a) * L, y - np.sin(a) * L), (x + np.cos(a) * L, y + np.sin(a) * L)], fill=int(60 + r.random() * 195), width=max(1, int(N / 900)))
    nd = stamp_wrap(needles) / 255.0
    soil = mix(col([0.04, 0.03, 0.02]), col([0.11, 0.08, 0.05]), unit(fbm(r, 1.6, 3)))
    albedo = mix(soil, mix(col([0.30, 0.20, 0.11]), col([0.45, 0.33, 0.18]), nd), (nd > 0).astype(np.float32))
    h = 0.4 * unit(fbm(r, 2.0, 2)) + 0.4 * (nd > 0) + 0.1 * nd
    return albedo, unit(h), 0.88 + 0.0 * h, dict(tile_m=0.5, height_m=0.01)


def bark(r, along_ratio, deep, colours, strips=True):
    fib = fbm(r, 1.4, 4, 900, aniso=(0.0, along_ratio)); fur = unit(ridged(fbm(r, 1.8, 3, 300, aniso=(0.0, along_ratio * 0.6))))
    furrow = fur ** (6 if strips else 14)
    tone = unit(fbm(r, 1.5, 2))
    albedo = mix(col(colours[0]), col(colours[1]), tone) * (0.8 + 0.35 * unit(fib))[..., None]
    albedo = mix(albedo, col(colours[2]), furrow * deep)
    h = 0.6 * (1 - furrow) * deep + 0.3 * unit(fib) + 0.1 * tone
    return albedo, unit(h), furrow, fib


def m_juniper_bark(k):
    r = rng_for(k); albedo, h, furrow, fib = bark(r, 14.0, 1.0, [[0.30, 0.18, 0.12], [0.46, 0.42, 0.38], [0.08, 0.05, 0.035]])
    shred = (unit(fbm(r, 0.8, 30, 900, aniso=(0.0, 20.0))) > 0.86).astype(np.float32)
    albedo = mix(albedo, col([0.55, 0.48, 0.40]), shred * 0.6)
    return albedo, unit(h + 0.15 * shred), 0.9 + 0.0 * h, dict(tile_m=0.5, height_m=0.02)


def m_willow_bark(k):
    r = rng_for(k); albedo, h, furrow, fib = bark(r, 6.0, 0.35, [[0.30, 0.30, 0.20], [0.42, 0.40, 0.30], [0.12, 0.10, 0.07]], strips=False)
    F1, _, idx, _ = voronoi(r, 1800); lent = np.clip(1 - F1 / 0.0025, 0, 1)
    g = grid().reshape(R, R, 2); dash = (np.abs(np.mod(g[..., 1] * 600, 1) - 0.5) < 0.18).astype(np.float32)
    albedo = mix(albedo, col([0.62, 0.56, 0.42]), np.clip(lent * 3, 0, 1) * dash)
    return albedo, unit(h + 0.2 * lent * dash), 0.7 + 0.0 * h, dict(tile_m=0.5, height_m=0.008)


def m_dead_wood(k):
    r = rng_for(k); g = grid().reshape(R, R, 2)
    grain = np.sin(2 * np.pi * (g[..., 0] * 160 + 2.5 * fbm(r, 2.5, 1, aniso=(0.0, 8.0))))
    cracks = unit(ridged(fbm(r, 1.4, 4, 500, aniso=(0.0, 20.0)))) ** 30
    albedo = mix(col([0.36, 0.34, 0.31]), col([0.62, 0.60, 0.56]), unit(fbm(r, 1.4, 2))) * (0.9 + 0.1 * grain)[..., None]
    albedo = mix(albedo, col([0.08, 0.07, 0.06]), cracks)
    h = 0.5 + 0.1 * grain - 0.6 * cracks + 0.2 * unit(fbm(r, 2, 2))
    return albedo, unit(h), 0.85 + 0.0 * h, dict(tile_m=0.5, height_m=0.012)


def m_leaf_blade(k):
    r = rng_for(k); g = grid().reshape(R, R, 2)
    veins = np.abs(np.mod(g[..., 0] * 40, 1.0) - 0.5) < 0.04; mid = np.abs(np.mod(g[..., 0] * 5, 1.0) - 0.5) < 0.03
    cross = (np.abs(np.mod(g[..., 1] * 300 + 0.3 * fbm(r, 2, 2), 1.0) - 0.5) < 0.03) & (unit(fbm(r, 1.0, 10)) > 0.4)
    stomata = (voronoi(r, 30000)[0] < 0.0009).astype(np.float32)
    albedo = mix(col([0.12, 0.26, 0.06]), col([0.24, 0.40, 0.10]), unit(fbm(r, 1.6, 2)))
    albedo = mix(albedo, col([0.34, 0.50, 0.16]), (veins | mid).astype(np.float32) * 0.6 + cross * 0.25)
    albedo = mix(albedo, col([0.10, 0.18, 0.05]), stomata * 0.5)
    h = 0.5 + 0.3 * (veins | mid) + 0.1 * cross - 0.2 * stomata
    return albedo, unit(h), 0.45 + 0.0 * h, dict(tile_m=0.1, height_m=0.0004)


def fur(r, length, clump_count, colours, band=False):
    """Hair: streaks along the strand direction (+y), clumped, with lighter tips."""
    warp = (fbm(r, 2.6, 2) * 0.01, fbm(r, 2.6, 2) * 0.004)
    F1, _, idx, _ = voronoi(r, clump_count, warp=warp); clump = np.clip(1 - F1 * np.sqrt(clump_count) * 1.2, 0, 1)
    strands = unit(fbm(r, 0.4, 60, 1000, aniso=(np.pi / 2, length)))
    tips = np.clip((strands - 0.6) * 2.5, 0, 1) * clump
    shade = 0.55 + 0.45 * clump
    lum = (0.25 + 0.75 * strands * shade)
    if band: lum = lum * (0.75 + 0.25 * np.sin(2 * np.pi * (strands * 3 + clump)))
    albedo = mix(col(colours[0]), col(colours[1]), lum)
    albedo = mix(albedo, col(colours[2]), tips * 0.6)
    h = 0.6 * strands * shade + 0.4 * clump
    return albedo, unit(h)


def m_deer_fur_summer(k):
    r = rng_for(k); a, h = fur(r, 22.0, 900, [[0.16, 0.09, 0.05], [0.52, 0.34, 0.20], [0.80, 0.66, 0.48]])
    return a, h, 0.62 + 0.0 * h, dict(tile_m=0.2, height_m=0.004, neutral=True)


def m_deer_fur_winter(k):
    r = rng_for(k); a, h = fur(r, 16.0, 700, [[0.14, 0.11, 0.09], [0.44, 0.38, 0.32], [0.74, 0.70, 0.64]], band=True)
    return a, h, 0.7 + 0.0 * h, dict(tile_m=0.2, height_m=0.006, neutral=True)


def m_wolf_fur(k):
    r = rng_for(k); a, h = fur(r, 28.0, 500, [[0.08, 0.075, 0.07], [0.46, 0.43, 0.40], [0.86, 0.84, 0.80]], band=True)
    return a, h, 0.7 + 0.0 * h, dict(tile_m=0.25, height_m=0.008, neutral=True)


def m_antler(k):
    r = rng_for(k); groove = unit(ridged(fbm(r, 1.6, 4, 400, aniso=(0.0, 10.0)))) ** 8
    pearls = np.clip(1 - voronoi(r, 2500)[0] / 0.004, 0, 1) * (unit(fbm(r, 2, 2)) > 0.55)
    albedo = mix(col([0.40, 0.31, 0.22]), col([0.80, 0.74, 0.62]), unit(fbm(r, 1.5, 2))) * (0.85 + 0.15 * (1 - groove))[..., None]
    h = 0.5 - 0.4 * groove + 0.3 * pearls + 0.1 * unit(fbm(r, 2, 2))
    return albedo, unit(h), 0.55 + 0.0 * h, dict(tile_m=0.1, height_m=0.002)


def m_nose(k):
    r = rng_for(k); F1, F2, idx, _ = voronoi(r, 5000); grooves = np.clip(1 - (F2 - F1) / 0.002, 0, 1)
    pores = (voronoi(r, 20000)[0] < 0.0008).astype(np.float32)
    albedo = col([0.035, 0.03, 0.03]) * (0.8 + 0.4 * unit(fbm(r, 1, 6)))[..., None]
    albedo = mix(albedo, col([0.01, 0.01, 0.01]), grooves)
    h = 0.6 - 0.5 * grooves - 0.2 * pores + 0.1 * unit(fbm(r, 2, 2))
    return albedo, unit(h), 0.18 + 0.2 * grooves, dict(tile_m=0.05, height_m=0.0006)


def m_canvas(k):
    r = rng_for(k); g = grid().reshape(R, R, 2); n = 160
    warp_t = 0.5 + 0.5 * np.sin(2 * np.pi * g[..., 0] * n) * np.sign(np.sin(np.pi * g[..., 1] * n))
    weft_t = 0.5 + 0.5 * np.sin(2 * np.pi * g[..., 1] * n) * np.sign(np.sin(np.pi * g[..., 0] * n + np.pi))
    weave = np.maximum(warp_t, weft_t); fuzz = unit(fbm(r, 0.3, 200, 1000))
    lum = 0.55 + 0.35 * weave + 0.1 * fuzz
    albedo = col([0.5, 0.5, 0.5]) * lum[..., None]
    return albedo, unit(weave + 0.2 * fuzz), 0.8 + 0.0 * lum, dict(tile_m=0.05, height_m=0.0005, neutral=True)


def m_leather(k):
    r = rng_for(k); F1, F2, idx, _ = voronoi(r, 9000); crease = np.clip(1 - (F2 - F1) / 0.0016, 0, 1)
    scuff = np.clip((unit(fbm(r, 1.2, 6)) - 0.7) * 3, 0, 1)
    albedo = col([0.5, 0.5, 0.5]) * (0.75 + 0.25 * unit(fbm(r, 1.5, 3)) - 0.25 * crease + 0.3 * scuff)[..., None]
    return albedo, unit(0.6 - 0.5 * crease + 0.1 * unit(fbm(r, 0.6, 80))), 0.5 + 0.3 * scuff, dict(tile_m=0.1, height_m=0.0008, neutral=True)


def m_iris(k):
    r = rng_for(k); g = grid().reshape(R, R, 2) - 0.5; rad = np.sqrt((g ** 2).sum(-1)); ang = np.arctan2(g[..., 1], g[..., 0])
    fibres = unit(fbm(r, 0.8, 30, 900, aniso=(0.0, 1.0)))
    radial = 0.5 + 0.5 * np.sin(ang * 90 + 6 * fibres)
    collarette = np.exp(-((rad - 0.22) / 0.02) ** 2); crypts = (voronoi(r, 600)[0] < 0.006) & (rad > 0.16) & (rad < 0.4)
    lum = 0.35 + 0.35 * radial * np.clip((rad - 0.12) / 0.3, 0, 1) + 0.25 * collarette - 0.25 * crypts
    lum = np.where(rad > 0.48, 0.1, lum); lum = np.where(rad < 0.1, 0.02, lum)
    albedo = col([0.5, 0.5, 0.5]) * lum[..., None] * 1.6
    return albedo, unit(lum), 0.1 + 0.0 * lum, dict(tile_m=0.02, height_m=0.0002, neutral=True)


MATERIALS = [
    ("meadow_soil", m_meadow_soil), ("dry_soil", m_dry_soil), ("sand", m_sand), ("mud", m_mud), ("rock", m_rock), ("scree", m_scree),
    ("gravel", m_gravel), ("stream_bed", m_stream_bed), ("moss", m_moss), ("leaf_litter", m_leaf_litter), ("snow", m_snow), ("forest_duff", m_forest_duff),
    ("juniper_bark", m_juniper_bark), ("willow_bark", m_willow_bark), ("dead_wood", m_dead_wood), ("leaf_blade", m_leaf_blade),
    ("deer_fur_summer", m_deer_fur_summer), ("deer_fur_winter", m_deer_fur_winter), ("wolf_fur", m_wolf_fur), ("antler", m_antler),
    ("nose_leather", m_nose), ("canvas", m_canvas), ("leather", m_leather), ("iris", m_iris),
]


def main(argv):
    global R
    out = Path(argv[0]); out.mkdir(parents=True, exist_ok=True)
    only = None
    if "--only" in argv: only = {int(x) for x in argv[argv.index("--only") + 1].split(",")}
    if "--size" in argv: R = int(argv[argv.index("--size") + 1])
    index_path = out / "materials.json"
    index = json.loads(index_path.read_text()) if index_path.is_file() else {"law": "deer.valley.materials/1", "size": R, "sets": []}
    sets = {s["index"]: s for s in index["sets"]}
    for k, (name, fn) in enumerate(MATERIALS):
        if only is not None and k not in only: continue
        t0 = time.time()
        albedo, h, rough, meta = fn(k)
        albedo = np.clip(albedo, 0, 1).astype(np.float32); h = np.clip(h, 0, 1).astype(np.float32)
        rough = np.broadcast_to(np.asarray(rough, np.float32), h.shape)
        ah = np.concatenate([albedo, h[..., None]], -1)
        nr = normal_rough_ao(h, meta["height_m"], meta["tile_m"], rough)
        base = f"{k:02d}_{name}"
        save_rgba(out / f"{base}_ah.png", ah, srgb_rgb=True); save_rgba(out / f"{base}_nr.png", nr)
        sets[k] = {"index": k, "name": name, "files": [f"{base}_ah.png", f"{base}_nr.png"], "tile_m": meta["tile_m"], "height_m": meta["height_m"],
                   "neutral": bool(meta.get("neutral", False)), "mean_albedo": [round(float(x), 5) for x in albedo.reshape(-1, 3).mean(0)],
                   "seconds": round(time.time() - t0, 1)}
        print(f"{base}: {time.time() - t0:.1f} s", flush=True)
        index["sets"] = [sets[i] for i in sorted(sets)]; index["size"] = R
        index_path.write_text(json.dumps(index, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
