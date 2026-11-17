#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Deer Valley animal forms: anatomy sculpted as a signed distance field, a class's every shape dimension
baked as a pair of extremes over one shared mesh.

A class (deer, wolf) is a list of anatomical primitives - ribcage barrel, brisket, scapula and triceps,
haunch and ham, abdomen, neck, skull, muzzle, jaw, legs joint by joint, hooves or paws, tail - placed on
the skeleton's joints and fused with smooth unions into one surface. Sixteen shape dimensions each have a
minimum and a maximum extreme (barrel, brisket, shoulder mass, haunch mass, flank tuck, neck base girth,
throat-latch girth, neck length, leg length, body length, head length, skull breadth, ears, tail, withers,
croup). The base form (every dimension at its middle) is polygonised by surface nets at three levels of
detail; each extreme is reached from it by carrying every vertex with the primitives that hold it (each
primitive's own affine map, blended by influence) and settling it onto the extreme's surface by Newton
steps. So all extremes share the base's topology, and an individual is

    P(t) = P_base + sum_k (t_k - 1/2) (P_k,max - P_k,min)        (and the same for normals and joints)

with t_k in [0, 1] from its continuum equations (src/valley3d_forms.js). Skinning weights come from the
primitives' bones, blended by the same influences. Ears and eyes are parametric parts regenerated at
every extreme.

Output (shards/animals): <class>.json (joints, landmarks, dimensions, files, sha-256) and binary files,
each well under GitHub's 25 MB limit:
  <class>.lod<L>.mesh.bin   vertices (13 float32: position, normal, colour, bones, weights) + uint32 indices
  <class>.lod<L>.dpos.bin   per vertex, per dimension: float32 x, y, z
  <class>.lod<L>.dnrm.bin   per vertex, per dimension: float16 x, y, z, 0

usage: animals.py OUTDIR [--only deer,wolf] [--lods 0,1,2]
"""
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

DIMS = ["barrel", "brisket", "shoulder", "haunch", "tuck", "neckBase", "throat", "neckLen",
        "legs", "body", "head", "skull", "ears", "tail", "withers", "croup"]
NDIM = len(DIMS)
LODS = [0.0065, 0.013, 0.028]          # surface-net cell size per level of detail (metres)
PART = 20_000_000                      # no file larger than this (GitHub refuses files over 25 MB)


def V(*a):
    return np.array(a, dtype=np.float64)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def lerp(a, b, t):
    return a + (b - a) * t


def frame(u, up=(0.0, 0.0, 1.0)):
    """Columns: u (primary axis), v, w with w close to `up` (the lateral axis)."""
    u = unit(u); w = np.asarray(up, float) - u * np.dot(up, u)
    if np.linalg.norm(w) < 1e-6:
        w = np.array([0.0, 1.0, 0.0]) - u * u[1]
    w = unit(w); v = np.cross(w, u)
    return np.stack([u, v, w], axis=1)


# ------------------------------------------------------------------ primitives
class Prim:
    """A signed-distance primitive with its bones (for skinning) and region (for colour)."""

    def __init__(self, kind, region, bones, k, **p):
        self.kind, self.region, self.bones, self.k, self.p = kind, region, bones, k, p

    def sdf(self, P, inflate=0.0):
        p = self.p
        if self.kind == "ell":
            q = (P - p["c"]) @ p["R"]
            r = np.maximum(p["r"], inflate)
            k0 = np.linalg.norm(q / r, axis=1); k1 = np.linalg.norm(q / (r * r), axis=1)
            d = k0 * (k0 - 1.0) / np.maximum(k1, 1e-12)
        else:                                                   # a round cone a -> b, radii r1, r2, lateral squash
            a, b = p["a"], p["b"]; L = np.linalg.norm(b - a); F = frame(b - a, p.get("up", (0.0, 0.0, 1.0)))
            q = (P - a) @ F; sq = p.get("sq", 1.0)
            r1, r2 = max(p["r1"], inflate), max(p["r2"], inflate)
            rho = np.sqrt(q[:, 1] ** 2 + (q[:, 2] / sq) ** 2); y = q[:, 0]
            bb = (r1 - r2) / L; aa = np.sqrt(max(1.0 - bb * bb, 1e-9))
            kk = -bb * rho + aa * y
            d = np.where(kk < 0, np.hypot(rho, y) - r1, np.where(kk > aa * L, np.hypot(rho, y - L) - r2, aa * rho + bb * y - r1))
            d = d * min(1.0, sq)
        if "cut" in p:                                          # keep the half-space n . (x - x0) <= 0 (a hoof's sole)
            n, x0 = p["cut"]; d = smax(d, (P - x0) @ n, 0.004)
        return d

    def bone_weights(self, P):
        """[(bone, weight array)] for points P; a bone spec is an int, or (b0, b1, t0, t1) blending along a->b."""
        out = []
        for spec in self.bones:
            if isinstance(spec, int):
                out.append((spec, np.ones(len(P))))
            else:
                b0, b1, t0, t1 = spec; a, b = self.p.get("a"), self.p.get("b")
                if a is None:
                    a, b = self.p["c"] - self.p["R"][:, 0] * self.p["r"][0], self.p["c"] + self.p["R"][:, 0] * self.p["r"][0]
                t = np.clip(((P - a) @ (b - a)) / np.dot(b - a, b - a), 0, 1)
                s = np.clip((t - t0) / max(t1 - t0, 1e-6), 0, 1); s = s * s * (3 - 2 * s)
                out.append((b0, 1 - s)); out.append((b1, s))
        return out

    def affine(self, other, P):
        """Carry points P from this primitive's frame to `other` (the same primitive at another extreme)."""
        p, o = self.p, other.p
        if self.kind == "ell":
            q = (P - p["c"]) @ p["R"]
            return o["c"] + ((q / p["r"]) * o["r"]) @ o["R"].T
        a, b, a2, b2 = p["a"], p["b"], o["a"], o["b"]
        F, F2 = frame(b - a, p.get("up", (0, 0, 1))), frame(b2 - a2, o.get("up", (0, 0, 1)))
        L, L2 = np.linalg.norm(b - a), np.linalg.norm(b2 - a2)
        q = (P - a) @ F; t = q[:, 0] / L
        r = np.maximum(lerp(p["r1"], p["r2"], np.clip(t, 0, 1)), 1e-4); r2 = lerp(o["r1"], o["r2"], np.clip(t, 0, 1))
        lat = q[:, 1:] * (r2 / r)[:, None] * np.array([1.0, o.get("sq", 1.0) / p.get("sq", 1.0)])
        ax = np.where(t < 0, q[:, 0] * (r2 / r), np.where(t > 1, L2 + (q[:, 0] - L) * (r2 / r), t * L2))
        return a2 + np.stack([ax, lat[:, 0], lat[:, 1]], axis=1) @ F2.T


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def field(prims, P, inflate=0.0, each=False):
    d = None; ds = []
    for pr in prims:
        di = pr.sdf(P, inflate)
        if each:
            ds.append(di)
        if pr.kind == "sub":
            continue
        d = di if d is None else smin(d, di, pr.k)
    return (d, ds) if each else d


# ------------------------------------------------------------------ anatomy
def ell(region, bones, k, c, r, R=None, **kw):
    return Prim("ell", region, bones, k, c=np.asarray(c, float), r=np.asarray(r, float), R=np.eye(3) if R is None else R, **kw)


def cone(region, bones, k, a, b, r1, r2, sq=1.0, **kw):
    return Prim("cone", region, bones, k, a=np.asarray(a, float), b=np.asarray(b, float), r1=r1, r2=r2, sq=sq, **kw)


def mz(p, s):
    return np.array([p[0], p[1], p[2] * s])


SPECIES = {
    # extremes for a white-tailed deer, metres, at adult scale (the overall size multiplies everything)
    "deer": dict(
        hoof=True, shoulderH=1.0,
        legs=(0.86, 1.18), body=(0.9, 1.12), neckLen=(0.31, 0.47), head=(0.25, 0.35), skull=(0.052, 0.078),
        ears=(0.13, 0.2), tail=(0.15, 0.30), withers=(0.0, 0.055), croup=(0.03, 0.27),
        barrel=((0.17, 0.125), (0.235, 0.185)), brisket=(0.155, 0.225), shoulder=(0.6, 1.25), haunch=(0.65, 1.25),
        tuck=(0.0, 1.0), neckBase=(0.125, 0.195), throat=(0.05, 0.085),
        legR=dict(upF=0.066, upH=0.078, fore=0.045, gask=0.052, cannon=0.0175, pastern=0.015),
        coat=dict(back=(0.21, 0.13, 0.075), flank=(0.33, 0.20, 0.11), belly=(0.80, 0.77, 0.71), leg=(0.34, 0.235, 0.15),
                  face=(0.29, 0.21, 0.145), hoof=(0.05, 0.042, 0.038), nose=(0.025, 0.022, 0.022), inner=(0.72, 0.66, 0.58)),
    ),
    # a grey wolf: deep narrow chest, long legs, big paws, a ruff, a bushy tail
    "wolf": dict(
        hoof=False, shoulderH=0.8,
        legs=(0.88, 1.16), body=(0.9, 1.1), neckLen=(0.2, 0.3), head=(0.24, 0.32), skull=(0.06, 0.085),
        ears=(0.085, 0.13), tail=(0.36, 0.5), withers=(0.0, 0.03), croup=(0.02, 0.14),
        barrel=((0.13, 0.1), (0.165, 0.13)), brisket=(0.11, 0.15), shoulder=(0.6, 1.2), haunch=(0.6, 1.15),
        tuck=(0.2, 1.0), neckBase=(0.12, 0.19), throat=(0.075, 0.11),
        legR=dict(upF=0.058, upH=0.07, fore=0.04, gask=0.045, cannon=0.02, pastern=0.019),
        # agouti grey: a dark saddle, buff flanks, cream underparts and legs (linear albedo of the hair)
        coat=dict(back=(0.11, 0.10, 0.09), flank=(0.26, 0.23, 0.19), belly=(0.58, 0.53, 0.45), leg=(0.36, 0.30, 0.23),
                  face=(0.30, 0.27, 0.23), hoof=(0.05, 0.045, 0.04), nose=(0.03, 0.03, 0.03), inner=(0.60, 0.55, 0.48)),
    ),
}


def joints(spec, t):
    """The skeleton's rest joints for dimension values t (dict), in the template frame (x forward, y up, z left)."""
    S = spec; T = lambda k: t[k]
    deer = S["hoof"]
    legs = lerp(*S["legs"], T("legs")); body = lerp(*S["body"], T("body"))
    H = S["shoulderH"]
    # leg segment lengths (fore: humerus, radius, metacarpal; hind: femur, tibia, metatarsal) scaled by the leg dimension
    if deer:
        fl = np.array([0.255, 0.265, 0.205, 0.075]) * legs; hl = np.array([0.29, 0.30, 0.355, 0.075]) * legs
    else:   # a wolf stands on its toes: humerus, radius and ulna, metacarpus; femur, tibia, metatarsus
        fl = np.array([0.19, 0.25, 0.115, 0.055]) * legs; hl = np.array([0.215, 0.235, 0.18, 0.055]) * legs
    lift = (legs - 1.0) * (0.78 if deer else 0.75) * H / 1.0
    y0 = (0.80 if deer else 0.72) * H + lift                   # shoulder-joint height (a wolf's chest is half its height)
    xs, xh = 0.40 * body if deer else 0.35 * body, -0.40 * body if deer else -0.36 * body
    sh = V(xs, y0, 0.115 if deer else 0.1)
    if deer:
        el = sh + V(-0.095, -fl[0] * 0.93, 0.008); ca = el + V(0.03, -fl[1], -0.008); ff = ca + V(0.01, -fl[2], -0.003)
    else:   # the humerus slopes back, the forearm stands upright, the metacarpus leans a little forward
        el = sh + V(-0.07, -fl[0] * 0.86, 0.008); ca = el + V(0.012, -fl[1], -0.006); ff = ca + V(0.022, -fl[2] * 0.95, -0.002)
    ff[1] = max(ff[1], 0.085 if deer else 0.05)
    hp = V(xh, y0 + (0.05 if deer else 0.03), 0.115 if deer else 0.1)
    if deer:
        st = hp + V(0.11, -hl[0] * 0.86, 0.015); ho = st + V(-0.25, -hl[1] * 0.6, -0.022); hf = ho + V(0.03, -hl[2] * 0.995, 0.0)
    else:   # femur forward, tibia back to a hock a quarter of the height up, metatarsus near upright
        st = hp + V(0.12, -hl[0] * 0.86, 0.015); ho = st + V(-0.15, -hl[1] * 0.8, -0.02); hf = ho + V(0.025, -hl[2] * 0.97, 0.0)
    hf[1] = max(hf[1], 0.09 if deer else 0.05)
    root = V(xh + 0.04, y0 + (0.12 if deer else 0.1), 0); chest = V(xs - 0.14, y0 + (0.13 if deer else 0.12), 0)
    nb = V(xs + 0.0, y0 + (0.18 if deer else 0.15), 0)
    nl = lerp(*S["neckLen"], T("neckLen")); na = np.radians(47 if deer else 24)   # a wolf carries its head near the withers
    head = nb + V(np.cos(na), np.sin(na), 0) * nl
    hl_ = lerp(*S["head"], T("head")); ha = np.radians(-37 if deer else -17)
    snout = head + V(np.cos(ha), np.sin(ha), 0) * hl_
    tail = V(xh - (0.175 if deer else 0.16), y0 + (0.10 if deer else 0.09) - 0.6 * lerp(*S["croup"], T("croup")) * 0.25, 0)
    hu = unit(snout - head); hv = np.array([-hu[1], hu[0], 0.0])
    eye = head + hu * (0.105 if deer else 0.1) * hl_ / (0.3 if deer else 0.28) + hv * (-0.015 if deer else 0.01)
    eye[2] = lerp(*S["skull"], T("skull")) * (0.95 if deer else 0.75)
    ears = head + hu * (0.005 if deer else 0.03) + hv * (0.045 if deer else 0.06); ears[2] = lerp(*S["skull"], T("skull")) * (0.75 if deer else 0.85)
    return dict(root=root, chest=chest, neck=nb, head=head, snout=snout, tail=tail, shoulder=sh, elbow=el, carpus=ca, ffet=ff,
                hip=hp, stifle=st, hock=ho, hfet=hf, ears=ears, eye=eye)


def anatomy(spec, t, J=None):
    """The class's primitives for dimension values t."""
    S = spec; J = J or joints(spec, t); T = lambda k: t[k]; deer = S["hoof"]
    P = []
    add = P.append
    B_R, B_C, B_N, B_H, B_T = 0, 1, 2, 3, 4
    body = lerp(*S["body"], T("body"))
    sh, hp = J["shoulder"], J["hip"]
    y0 = sh[1]; xm = (sh[0] + hp[0]) / 2
    # ---- the torso
    bry, brz = lerp(np.array(S["barrel"][0]), np.array(S["barrel"][1]), T("barrel"))
    rib_c = V(xm + 0.06 * body, y0 - 0.02, 0)
    add(ell("torso", [(B_R, B_C, 0.25, 0.75)], 0.07, rib_c, V(0.33 * body, bry, brz)))
    bk = lerp(*S["brisket"], T("brisket"))
    R = frame(V(np.cos(np.radians(-14)), np.sin(np.radians(-14)), 0))
    add(ell("chest", [B_C], 0.06, V(sh[0] - 0.11, y0 - 0.06 - 0.25 * (bk - 0.19), 0), V(0.17, bk, 0.12 if deer else 0.105), R))
    wi = lerp(*S["withers"], T("withers"))
    add(ell("torso", [B_C], 0.05, V(sh[0] - 0.16, y0 + 0.15 + wi * 0.5, 0), V(0.18, 0.05 + wi, 0.05), frame(V(1.0, 0.12, 0))))
    abd_ry = lerp(0.205 if deer else 0.13, 0.145 if deer else 0.08, lerp(*S["tuck"], T("tuck")))   # a wolf's belly line rises to the flank
    add(ell("belly", [(B_R, B_C, 0.3, 0.7)], 0.08, V(xm - 0.12 * body, y0 - 0.06 + (0.2 - abd_ry) * 0.6, 0), V(0.3 * body, abd_ry, brz * 0.95)))
    add(ell("torso", [(B_R, B_C, 0.4, 0.8)], 0.06, V(xm - 0.15 * body, y0 + 0.085, 0), V(0.27 * body, 0.085, brz * 0.72)))   # the loin
    cr = lerp(*S["croup"], T("croup"))
    add(ell("rump", [B_R], 0.075, V(hp[0] - 0.03, hp[1] + 0.0, 0), V(0.2, 0.11, 0.12 if deer else 0.105), frame(V(np.cos(cr), np.sin(cr), 0))))
    # ---- shoulders: scapula plate and the triceps mass behind the arm (both sides)
    sm = lerp(*S["shoulder"], T("shoulder"))
    for s, bu in ((1, 5), (-1, 8)):
        top = V(sh[0] - 0.16, y0 + 0.17 + wi * 0.4, 0.06 * s); bot = mz(sh, s)
        u = bot - top; c = (top + bot) / 2 + V(0, 0, 0.025 * s * sm)
        add(ell("shoulder", [B_C], 0.045, c, V(np.linalg.norm(u) * 0.62, 0.105 * (0.8 + 0.2 * sm), 0.034 * sm + 0.012), frame(u, (0, 0, s))))
        el = mz(J["elbow"], s)
        add(ell("shoulder", [(B_C, bu, 0.2, 0.8)], 0.04, (bot * 0.45 + el * 0.55) + V(-0.045, 0.01, 0.012 * s), V(0.075 * sm + 0.02, 0.105 * (0.75 + 0.25 * sm), 0.036 * sm + 0.016), frame(el - bot, (0, 0, s))))
    # ---- hindquarters: haunch (quadriceps, gluteals) and ham (hamstrings) on each side
    hm = lerp(*S["haunch"], T("haunch"))
    for s, bu in ((1, 11), (-1, 14)):
        h_, k_ = mz(hp, s), mz(J["stifle"], s)
        fold_a = V(hp[0] + 0.2, y0 - 0.15, 0.1 * s); fold_b = k_ + V(0.01, 0.03, -0.015 * s)       # the flank fold: belly skin to the stifle
        add(ell("belly", [(B_R, bu, 0.5, 1.0)], 0.06, (fold_a + fold_b) / 2, V(np.linalg.norm(fold_b - fold_a) * 0.55, 0.05, 0.035), frame(fold_b - fold_a, (0, 0, s))))
        add(ell("haunch", [(B_R, bu, 0.35, 0.95)], 0.075, (h_ * 0.6 + k_ * 0.4) + V(-0.01, 0.02, 0.012 * s * hm), V(0.175 * (0.85 + 0.15 * hm), 0.13 * (0.85 + 0.15 * hm), 0.045 * hm + 0.035), frame(k_ - h_, (0, 0, s))))
        add(ell("haunch", [(B_R, bu, 0.3, 0.9)], 0.06, h_ + V(-0.095, -0.16, 0) + V(0, 0, -0.022 * s), V(0.2 * (0.88 + 0.12 * hm), 0.035 * hm + 0.025, 0.042 * hm + 0.032), frame(V(-0.05, -1, 0), (0, 0, s))))   # the ham, down to the gaskin
    # ---- neck: from the shoulders to the throat-latch, deep and narrow, with a crest
    nb, hd = J["neck"], J["head"]; nbR = lerp(*S["neckBase"], T("neckBase")); thR = lerp(*S["throat"], T("throat"))
    a = nb + V(-0.01, -0.17 if deer else -0.1, 0); b = hd + (unit(J["snout"] - hd) * 0.03) + V(0, -0.045 if deer else -0.03, 0)
    add(cone("neck", [(B_C, B_N, 0.0, 0.35)], 0.075, a, b, nbR, thR, sq=0.64 if deer else 0.78))
    add(ell("neck", [B_N], 0.05, (nb + hd) / 2 + V(-0.035, 0.035, 0), V(np.linalg.norm(hd - nb) * 0.5, 0.045, 0.045 if deer else 0.06), frame(hd - nb)))
    if not deer:                                                # the wolf's ruff
        add(ell("neck", [(B_C, B_N, 0.2, 0.6)], 0.07, nb + (hd - nb) * 0.3 + V(0.0, -0.02, 0), V(0.12, 0.105, 0.1), frame(hd - nb)))
    # ---- head: cranium, nasal bridge, muzzle, rhinarium, jaw and jowls, brows
    sn = J["snout"]; hu = unit(sn - hd); hv = np.array([-hu[1], hu[0], 0.0]); hlen = np.linalg.norm(sn - hd)
    skw = lerp(*S["skull"], T("skull")); Rh = frame(hu)
    at = lambda f, g, z=0.0: hd + hu * hlen * f + hv * g + V(0, 0, z)
    add(ell("head", [B_H], 0.03, at(0.17, 0.0), V(0.29 * hlen, 0.07 if deer else 0.075, skw * 1.05), Rh))
    add(ell("head", [B_H], 0.025, at(0.33, 0.025 if deer else 0.04), V(0.2 * hlen, 0.04, skw * 0.85), Rh))          # brow and forehead
    mz0, mz1 = at(0.36, -0.012), at(0.93, -0.004)
    add(cone("muzzle", [B_H], 0.03, mz0, mz1, 0.052 if deer else 0.055, 0.028 if deer else 0.028, sq=0.74 if deer else 0.82, up=(0, 0, 1)))
    add(ell("muzzle", [B_H], 0.02, at(0.62, 0.032 if deer else 0.028), V(0.3 * hlen, 0.024, 0.032 if deer else 0.036), Rh))   # nasal bridge
    add(ell("nose", [B_H], 0.012, at(0.97, 0.0), V(0.024, 0.026, 0.026 if deer else 0.03), Rh))
    add(ell("muzzle", [B_H], 0.015, at(0.9, -0.028), V(0.035, 0.02, 0.026), Rh))                                          # upper lip
    for s in (1, -1):
        add(cone("jaw", [B_H], 0.02, at(0.12, -0.07 if deer else -0.065, 0.034 * s * skw / 0.065), at(0.86, -0.045 if deer else -0.04, 0.013 * s), 0.032, 0.014, sq=0.8))
        add(ell("jaw", [B_H], 0.03, at(0.15, -0.045, 0.045 * s * skw / 0.065), V(0.055, 0.045, 0.026), Rh))                # the jowl
        e = mz(J["eye"], s)
        add(ell("head", [B_H], 0.012, e + hv * 0.016 + hu * -0.004, V(0.026, 0.011, 0.012), Rh))                          # supraorbital ridge
    add(ell("jaw", [B_H], 0.012, at(0.86, -0.06 if deer else -0.055), V(0.022, 0.016, 0.018), Rh))                         # chin
    # ---- legs
    lr = S["legR"]
    for s, (bu, bl, bc), (hu_, hl2, hc) in ((1, (5, 6, 7), (11, 12, 13)), (-1, (8, 9, 10), (14, 15, 16))):
        shs, els, cas, ffs = (mz(J[k], s) for k in ("shoulder", "elbow", "carpus", "ffet"))
        add(cone("leg", [(B_C, bu, 0.0, 0.3)], 0.035, shs, els, lr["upF"], lr["upF"] * 0.75, sq=0.78))
        add(ell("leg", [bl], 0.02, els + V(-0.04, 0.0, 0.0), V(0.032, 0.034, 0.028)))                                      # olecranon
        add(cone("leg", [(bu, bl, 0.0, 0.25)], 0.025, els + V(0.0, -0.01, 0), cas, lr["fore"], lr["fore"] * 0.55, sq=0.8))
        add(ell("leg", [bl], 0.02, els * 0.65 + cas * 0.35 + V(0.017, 0, 0), V(0.032, 0.085, 0.03), frame(cas - els, (0, 0, s))))   # forearm muscles
        add(ell("leg", [(bl, bc, 0.0, 1.0)], 0.02, cas, V(0.02, 0.026, 0.018)))                                             # the knee
        add(cone("leg", [bc], 0.012, cas + V(0, -0.012, 0), ffs, lr["cannon"], lr["cannon"] * 0.88, sq=0.82))
        add(ell("leg", [bc], 0.01, ffs + V(0.002, 0, 0), V(0.024, 0.026, 0.019)))                                           # fetlock
        hps, sts, hos, hfs = (mz(J[k], s) for k in ("hip", "stifle", "hock", "hfet"))
        add(cone("leg", [(0, hu_, 0.0, 0.25)], 0.05, hps, sts, lr["upH"], lr["upH"] * 0.78, sq=0.75))
        add(ell("leg", [(hu_, hl2, 0.3, 0.7)], 0.045, sts + V(0.005, 0, -0.008 * s), V(0.032, 0.04, 0.034)))                   # stifle
        add(cone("leg", [(hu_, hl2, 0.0, 0.2)], 0.04, sts + V(-0.02, -0.01, 0), hos, lr["gask"] * 1.3, lr["gask"] * 0.5, sq=0.7))
        pa, pb = hps + V(-0.1, -0.27, -0.012 * s), hos + V(-0.025, 0.07, 0)                   # the back of the thigh and gaskin down to the hock
        add(ell("haunch", [(hu_, hl2, 0.2, 0.8)], 0.05, (pa + pb) / 2, V(np.linalg.norm(pb - pa) * 0.56, 0.045, 0.036), frame(pb - pa, (0, 0, s))))
        add(ell("leg", [hl2], 0.035, sts * 0.62 + hos * 0.38 + V(-0.05, 0.005, 0), V(0.095, 0.05, 0.042), frame(hos - sts, (0, 0, s))))  # gastrocnemius
        add(cone("leg", [hl2], 0.01, sts * 0.55 + hos * 0.45 + V(-0.075, 0.0, 0), hos + V(-0.035, 0.02, 0), 0.017, 0.013, sq=0.7))  # Achilles
        add(ell("leg", [(hl2, hc, 0.0, 1.0)], 0.015, hos, V(0.032, 0.036, 0.024)))                                          # hock
        add(ell("leg", [hl2], 0.008, hos + V(-0.035, 0.02, 0), V(0.018, 0.02, 0.015)))                                      # point of hock
        add(cone("leg", [hc], 0.012, hos + V(0, -0.015, 0), hfs, lr["cannon"] * 1.05, lr["cannon"] * 0.9, sq=0.82))
        add(ell("leg", [hc], 0.01, hfs + V(0.002, 0, 0), V(0.024, 0.026, 0.019)))
        for f, bc_ in ((ffs, bc), (hfs, hc)):
            toe = f + V(0.035 if deer else 0.04, -f[1] + (0.024 if deer else 0.02), 0)
            add(cone("leg", [bc_], 0.01, f + V(0.002, -0.004, 0), toe + V(-0.012, 0.014, 0), lr["pastern"], lr["pastern"] * 1.05, sq=0.85))
            if deer:                                            # a cloven hoof: two toes, the sole flat, dewclaws behind
                for z in (0.0105, -0.0105):
                    add(ell("hoof", [bc_], 0.003, toe + V(0.004, -0.003, z), V(0.037, 0.026, 0.0115), frame(V(1, -0.18, 0)), cut=(V(0, -1, 0), V(0, 0.0005, 0))))
                for z in (0.012, -0.012):
                    add(ell("hoof", [bc_], 0.006, f + V(-0.028, -0.03, z), V(0.012, 0.016, 0.008), frame(V(-0.4, -1, 0))))
            else:                                               # a paw: the pad mass and four toes
                add(ell("hoof", [bc_], 0.012, toe + V(-0.005, 0.0, 0), V(0.05, 0.026, 0.042), cut=(V(0, -1, 0), V(0, 0.0005, 0))))
                for dz, dx in ((0.026, 0.01), (0.009, 0.03), (-0.009, 0.03), (-0.026, 0.01)):
                    add(ell("hoof", [bc_], 0.008, toe + V(0.03 + dx * 0.4, 0.004, dz), V(0.018, 0.017, 0.013), cut=(V(0, -1, 0), V(0, 0.0005, 0))))
    # ---- tail
    tl = lerp(*S["tail"], T("tail")); tb = J["tail"]
    if deer:                                                    # broad, flat, hanging over the rump
        d = unit(V(-0.12, -1.0, 0)); Rt = frame(d, (0, 0, 1)); tb = tb + V(0.03, 0.0, 0)
        add(ell("tail", [(B_R, B_T, 0.0, 0.3)], 0.04, tb + d * tl * 0.28, V(tl * 0.34, 0.02, 0.035 + 0.1 * tl), Rt))
        add(ell("tail", [B_T], 0.035, tb + d * tl * 0.66, V(tl * 0.3, 0.018, 0.03 + 0.11 * tl), Rt))
    else:                                                       # bushy, hanging down and back
        d = unit(V(-0.45, -1.0, 0))
        add(cone("tail", [(B_R, B_T, 0.0, 0.2)], 0.035, tb, tb + d * tl * 0.55, 0.035, 0.055, sq=1.0))
        add(cone("tail", [B_T], 0.03, tb + d * tl * 0.5, tb + d * tl, 0.055, 0.03, sq=1.0))
    return P


# ------------------------------------------------------------------ the warden (a clothed ranger)
HUMAN_DIMS = ["height", "build", "shoulders", "belly", "legs", "arms", "head", "neck", "hatBrim", "hatCrown", "jacket", "boots", "-", "--", "---", "----"]
WARDEN = dict(kind="human", dims=HUMAN_DIMS, bones=14,
              cloth=dict(jacket=(0.55, 0.50, 0.36), trousers=(0.26, 0.30, 0.20), boots=(0.20, 0.13, 0.08), skin=(0.78, 0.60, 0.47), hat=(0.36, 0.26, 0.16),
                         badge=(0.85, 0.72, 0.25), belt=(0.09, 0.07, 0.05), eye=(0.03, 0.025, 0.02), brow=(0.20, 0.14, 0.09), hair=(0.12, 0.09, 0.07)))


SPECIES["warden"] = WARDEN


def human_joints(t):
    hs = lerp(0.9, 1.11, t["height"]); lr = lerp(0.94, 1.06, t["legs"]); ar = lerp(0.94, 1.06, t["arms"]); sw = lerp(0.175, 0.225, t["shoulders"])
    ank = V(0, 0.09, 0.1); kn = V(0.02, 0.09 + 0.43 * lr * hs, 0.1); hip = V(0, kn[1] + 0.43 * lr * hs, 0.1)
    pel = V(0, hip[1] + 0.03 * hs, 0); ch = V(0, pel[1] + 0.32 * hs, 0); nk = V(0, ch[1] + 0.25 * hs, 0); hd = V(0, nk[1] + 0.11 * hs, 0)
    sh = V(0, ch[1] + 0.16 * hs, sw); el = sh + V(0, -0.29 * ar * hs, 0.03); wr = el + V(0, -0.25 * ar * hs, 0.01)
    return dict(pelvis=pel, chest=ch, neck=nk, head=hd, shoulder=sh, elbow=el, wrist=wr, hip=hip, knee=kn, ankle=ank, toe=ank + V(0.16, -0.06, 0), hat=V(0, hd[1] + 0.12, 0))


def human_anatomy(spec, t, J=None):
    J = J or human_joints(t); T = lambda k: t[k]; P = []; add = P.append
    bld = lerp(0.85, 1.25, T("build")); bel = lerp(0.0, 0.8, T("belly")); hdS = lerp(0.93, 1.08, T("head")); nkS = lerp(0.85, 1.25, T("neck"))
    pel, ch, nk, hd = J["pelvis"], J["chest"], J["neck"], J["head"]
    add(ell("trousers", [0], 0.05, pel + V(0, -0.02, 0), V(0.11 * bld, 0.12, 0.165 * bld)))                                  # hips
    add(ell("jacket", [(0, 1, 0.3, 0.8)], 0.06, pel + V(0.015 + 0.04 * bel, 0.15, 0), V((0.105 + 0.07 * bel) * bld, 0.14, 0.15 * bld)))   # belly
    add(ell("jacket", [1], 0.06, ch + V(0.0, 0.07, 0), V(0.115 * bld, 0.18, (0.13 + J["shoulder"][2] * 0.3) * bld)))      # chest
    jl = lerp(0.0, 0.16, T("jacket"))
    add(ell("jacket", [0], 0.05, pel + V(0, 0.02 - jl * 0.5, 0), V(0.12 * bld, 0.06 + jl * 0.5, 0.17 * bld)))               # the jacket's hem
    for s, ua, th in ((1, 3, 7), (-1, 5, 10)):
        shs, els, wrs = mz(J["shoulder"], s), mz(J["elbow"], s), mz(J["wrist"], s)
        add(cone("jacket", [(1, ua, 0.0, 0.6)], 0.05, V(0, ch[1] + 0.17, 0.06 * s), shs + V(0, 0.01, 0), 0.07 * bld, 0.06 * bld))   # shoulder
        add(cone("jacket", [ua], 0.03, shs, els, 0.058 * bld, 0.047 * bld, sq=0.92))
        add(cone("jacket", [(ua, ua + 1, 0.0, 0.25)], 0.025, els, wrs + V(0, 0.03, 0), 0.046 * bld, 0.038 * bld, sq=0.9))
        add(ell("skin", [ua + 1], 0.012, wrs + V(0.008, -0.075, -0.004 * s), V(0.075, 0.042, 0.02), frame(V(0.1, -1, 0), (0, 0, s))))   # a hand, hanging
        hps, kns, ans, tos = mz(J["hip"], s), mz(J["knee"], s), mz(J["ankle"], s), mz(J["toe"], s)
        add(cone("trousers", [(0, th, 0.0, 0.3)], 0.04, hps + V(0, 0.02, 0), kns, 0.088 * bld, 0.062 * bld, sq=0.95))
        add(cone("trousers", [(th, th + 1, 0.0, 0.2)], 0.025, kns, ans + V(0, 0.12, 0), 0.06 * bld, 0.048 * bld))
        bh = lerp(0.1, 0.24, T("boots"))
        add(cone("boots", [th + 1], 0.012, ans + V(0, bh, 0), ans, 0.054 * bld, 0.05 * bld))
        add(ell("boots", [th + 2], 0.02, (ans + tos) / 2 + V(0.0, -0.01, 0), V(0.135, 0.05, 0.052), frame(tos - ans + V(0, 0.02, 0)), cut=(V(0, -1, 0), V(0, 0.0005, 0))))
    add(cone("skin", [(1, 2, 0.2, 0.8)], 0.03, nk + V(0, -0.07, 0), hd + V(0.01, -0.03, 0), 0.058 * nkS, 0.05 * nkS))       # the neck
    add(ell("skin", [2], 0.03, hd + V(-0.005, 0.07, 0), V(0.1, 0.115, 0.082) * hdS))                                        # cranium
    add(ell("skin", [2], 0.025, hd + V(0.035, 0.0, 0), V(0.075, 0.075, 0.068) * hdS))                                       # face and jaw
    add(ell("skin", [2], 0.008, hd + V(0.105 * hdS, 0.035, 0), V(0.02, 0.026, 0.013)))                                      # nose
    for s in (1, -1):
        add(ell("skin", [2], 0.008, hd + V(0.0, 0.045, 0.085 * s * hdS), V(0.018, 0.03, 0.01)))                             # ears
        add(ell("eye", [2], 0.004, hd + V(0.095 * hdS, 0.072, 0.036 * s), V(0.007, 0.009, 0.012)))                          # eyes
        add(ell("brow", [2], 0.006, hd + V(0.098 * hdS, 0.098, 0.037 * s), V(0.008, 0.005, 0.022)))                         # brows
    br, cr = lerp(0.15, 0.24, T("hatBrim")), lerp(0.06, 0.1, T("hatCrown"))
    add(ell("hat", [13], 0.01, J["hat"] + V(0, 0.005, 0), V(br, 0.012, br * 0.95)))                                         # brim
    add(ell("hat", [13], 0.015, J["hat"] + V(-0.005, cr * 0.85, 0), V(0.105, cr, 0.095)))                                  # crown
    add(ell("badge", [1], 0.005, ch + V(0.11 * bld, 0.1, 0.075), V(0.012, 0.022, 0.018)))
    add(ell("belt", [0], 0.01, pel + V(0.0, 0.06, 0), V(0.115 * bld + 0.04 * bel * bld, 0.022, 0.155 * bld)))
    return P


def human_colour(spec, region, P, N, J):
    C = spec["cloth"]; out = np.zeros((len(P), 3))
    for r, mask in region.items():
        out[mask] = C.get(r, C["jacket"])
    return out


def colour(spec, region, P, N, J):
    """Vertex coats: dark back, paler flanks, white belly and inner legs (the shader adds the per-animal marks)."""
    C = {k: np.array(v) for k, v in spec["coat"].items()}; deer = spec["hoof"]
    y = P[:, 1]; n = len(P); out = np.zeros((n, 3))
    sh = J["shoulder"]; top = sh[1] + 0.2
    up = np.clip((y - (sh[1] - 0.14)) / 0.3, 0, 1)
    base = C["flank"][None] * (1 - up[:, None]) + C["back"][None] * up[:, None]
    belly = np.clip((-N[:, 1] - 0.35) / 0.4, 0, 1) * np.clip((sh[1] - 0.05 - y) / 0.12, 0, 1)
    inner = np.clip((0.06 - np.abs(P[:, 2])) / 0.05, 0, 1) * (y < sh[1] - 0.1)
    for r, mask in region.items():
        if r in ("torso", "chest", "belly", "rump", "shoulder", "haunch"):
            c = base * (1 - belly[:, None]) + C["belly"][None] * belly[:, None]
            c = c * (1 - 0.6 * inner[:, None]) + C["belly"][None] * 0.6 * inner[:, None]
            if deer and r == "rump":                            # the white patch under the tail
                rp = np.clip((J["hip"][0] - 0.13 - P[:, 0]) / 0.05, 0, 1) * np.clip((J["tail"][1] - y) / 0.1, 0, 1)
                c = c * (1 - rp[:, None]) + C["belly"][None] * rp[:, None]
        elif r == "neck":
            c = C["flank"][None] * np.ones((n, 1)) * 0.95
        elif r in ("head", "jaw"):
            c = C["face"][None] * np.ones((n, 1))
        elif r == "muzzle":
            c = C["face"][None] * 0.85 * np.ones((n, 1))
        elif r == "nose":
            c = C["nose"][None] * np.ones((n, 1))
        elif r == "leg":
            c = C["leg"][None] * np.ones((n, 1)); c = c * (1 - 0.65 * inner[:, None]) + C["inner"][None] * 0.65 * inner[:, None]
        elif r == "hoof":
            c = C["hoof"][None] * np.ones((n, 1))
        elif r == "tail":
            under = np.clip((-N[:, 0] * -1 + 0.2), 0, 1) if not deer else np.clip((N[:, 0] + 0.3) / 0.5, 0, 1)
            c = C["back"][None] * (1 - under[:, None]) + (C["belly"] if deer else C["flank"])[None] * under[:, None]
            if not deer:
                c = c * (1 - (y < J["tail"][1] - 0.35)[:, None] * 0.75)            # the wolf's dark tail tip
        else:
            c = C["flank"][None] * np.ones((n, 1))
        out[mask] = c[mask]
    return out


# ------------------------------------------------------------------ surface nets
CORNERS = [(i, j, k) for k in (0, 1) for j in (0, 1) for i in (0, 1)]
EDGES = [(a, b) for a in range(8) for b in range(a + 1, 8) if sum(abs(np.subtract(CORNERS[a], CORNERS[b]))) == 1]


def evaluate_grid(prims, lo, h, shape, inflate, band=3):
    """The field on a grid, exactly within a band around the surface (found on a coarse grid four times larger)."""
    r = 4; hc = h * r; cs = tuple(int(np.ceil((s - 1) / r)) + 1 for s in shape)
    gi = [lo[a] + hc * np.arange(cs[a]) for a in range(3)]
    Pc = np.stack(np.meshgrid(*gi, indexing="ij"), -1).reshape(-1, 3)
    Dc = np.concatenate([field(prims, Pc[i:i + 400000], inflate) for i in range(0, len(Pc), 400000)]).reshape(cs)
    idx = [np.clip(np.round(np.arange(shape[a]) / r).astype(int), 0, cs[a] - 1) for a in range(3)]
    D = Dc[idx[0]][:, idx[1]][:, :, idx[2]].astype(np.float32)
    near_c = np.abs(Dc) < band * hc
    ci = [np.clip(np.arange(shape[a]) // r, 0, cs[a] - 1) for a in range(3)]
    near = near_c[ci[0]][:, ci[1]][:, :, ci[2]]
    for a in range(3):                                          # widen by one coarse cell along each axis (both neighbours)
        cj = np.clip(np.arange(shape[a]) // r + 1, 0, cs[a] - 1); sl = [slice(None)] * 3
        n2 = near_c[(cj if a == 0 else ci[0])][:, (cj if a == 1 else ci[1])][:, :, (cj if a == 2 else ci[2])]
        near |= n2
    pts = np.argwhere(near)
    for i in range(0, len(pts), 300000):
        q = pts[i:i + 300000]
        D[q[:, 0], q[:, 1], q[:, 2]] = field(prims, lo + h * q, inflate)
    return D


def surface_nets(D, lo, h):
    inside = D < 0; nx, ny, nz = D.shape
    c = [inside[i:nx - 1 + i, j:ny - 1 + j, k:nz - 1 + k] for (i, j, k) in CORNERS]
    anyin = np.zeros_like(c[0]); allin = np.ones_like(c[0])
    for x in c:
        anyin |= x; allin &= x
    active = anyin & ~allin
    cells = np.argwhere(active); idx = -np.ones(active.shape, np.int64); idx[active] = np.arange(len(cells))
    acc = np.zeros((len(cells), 3)); cnt = np.zeros(len(cells))
    for a, b in EDGES:
        oa, ob = np.array(CORNERS[a]), np.array(CORNERS[b]); pa, pb = cells + oa, cells + ob
        da = D[pa[:, 0], pa[:, 1], pa[:, 2]].astype(float); db = D[pb[:, 0], pb[:, 1], pb[:, 2]].astype(float)
        x = (da < 0) != (db < 0); t = np.where(x, da / np.where(x, da - db, 1), 0)
        acc[x] += pa[x] + t[x, None] * (ob - oa); cnt[x] += 1
    verts = lo + h * acc / np.maximum(cnt, 1)[:, None]
    quads = []
    for ax in range(3):
        o1, o2 = (ax + 1) % 3, (ax + 2) % 3
        n_ = (nx, ny, nz)
        g = [slice(0, n_[a] - 1) if a == ax else slice(1, n_[a] - 1) for a in range(3)]          # an edge's lower end
        g2 = [slice(1, n_[a]) if a == ax else slice(1, n_[a] - 1) for a in range(3)]             # and its upper end
        A = inside[tuple(g)]; Bv = inside[tuple(g2)]
        e = np.argwhere(A != Bv); e += np.array([g[0].start, g[1].start, g[2].start])
        flip = inside[e[:, 0], e[:, 1], e[:, 2]]
        def cell(d1, d2):
            q = e.copy(); q[:, o1] -= d1; q[:, o2] -= d2; return idx[q[:, 0], q[:, 1], q[:, 2]]
        q0, q1, q2, q3 = cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)
        Q = np.stack([q0, q1, q2, q3], 1); Q[~flip] = Q[~flip][:, ::-1]
        quads.append(Q[(Q >= 0).all(1)])
    Q = np.concatenate(quads)
    # split each quad along its shorter diagonal
    d02 = np.linalg.norm(verts[Q[:, 0]] - verts[Q[:, 2]], axis=1); d13 = np.linalg.norm(verts[Q[:, 1]] - verts[Q[:, 3]], axis=1)
    t1 = np.where((d02 <= d13)[:, None], Q[:, [0, 1, 2]], Q[:, [0, 1, 3]]); t2 = np.where((d02 <= d13)[:, None], Q[:, [0, 2, 3]], Q[:, [1, 2, 3]])
    return verts, np.concatenate([t1, t2]).astype(np.uint32)


def grad(prims, P, inflate, e=2e-4):
    g = np.zeros_like(P)
    for a in range(3):
        d = np.zeros(3); d[a] = e
        g[:, a] = (field(prims, P + d, inflate) - field(prims, P - d, inflate)) / (2 * e)
    return g


def settle(prims, P, inflate, steps=3, h=0.01):
    for _ in range(steps):
        d = field(prims, P, inflate); g = grad(prims, P, inflate)
        P = P - (np.clip(d, -h, h) / np.maximum((g * g).sum(1), 1e-6))[:, None] * g
    return P


# ------------------------------------------------------------------ parametric parts: ears and eyes
def ear(spec, t, J, s, nt=14, ns=8):
    """A cupped leaf with a thin rim: front (cupped) and back surfaces. Returns verts, tris, normals, colours, uv."""
    deer = spec["hoof"]; L = lerp(*spec["ears"], t["ears"]); W = L * (0.62 if deer else 0.62)
    base = J["ears"] * np.array([1, 1, s]); d = unit(V(-0.28, 0.66 if deer else 1.0, 0.72 * s if deer else 0.35 * s))
    side = unit(np.cross(d, V(0, 0, s) if not deer else V(0.3, 0.2, s))); nrm = unit(np.cross(side, d)) * (1 if s > 0 else -1)
    if np.dot(nrm, V(0.4, 0, s)) < 0: nrm = -nrm
    vs, ns_, cs = [], [], []
    for face in (0, 1):
        for i in range(nt + 1):
            u = i / nt; w = W * 0.5 * np.sin(np.pi * u ** 0.8) ** 0.75 * (1 - 0.15 * u) if deer else W * 0.5 * (1 - u) ** 0.9
            for j in range(ns + 1):
                v = (j / ns) * 2 - 1; cup = (1 - v * v) * w * 0.45
                p = base + d * L * u + side * v * w + nrm * (-cup if face == 0 else -cup - 0.0025)
                vs.append(p); ns_.append(nrm if face == 0 else -nrm)
                edge = abs(v) > 0.82
                if face == 0: cs.append((0.80, 0.72, 0.66) if deer else (0.78, 0.74, 0.68))
                else: cs.append((0.12, 0.09, 0.07) if edge or u > 0.86 else ((0.40, 0.30, 0.21) if deer else (0.36, 0.33, 0.30)))
    tris = []; row = ns + 1; off = (nt + 1) * row
    for f in (0, 1):
        for i in range(nt):
            for j in range(ns):
                a = f * off + i * row + j; b = a + 1; c = a + row; dd = c + 1
                tris += [(a, c, b), (b, c, dd)] if f == 0 else [(a, b, c), (b, dd, c)]
    return np.array(vs), np.array(tris, np.uint32), np.array(ns_), np.array(cs)


def eyeball(spec, t, J, s, seg=7):
    e = J["eye"] * np.array([1, 1, s]); ax = unit(V(0.35, 0.05, s)); F = frame(ax, (0, 1, 0)); r = np.array([0.0115, 0.017, 0.015]) * (1.0 if spec["hoof"] else 0.8)
    vs, ns_ = [], []
    for a in range(seg + 1):
        th = a / seg * np.pi
        for b in range(seg * 2 + 1):
            ph = b / (seg * 2) * 2 * np.pi; n = np.array([np.cos(th), np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph)])
            vs.append(e + F @ (n * r)); ns_.append(unit(F @ (n / r)))
    tris = []; row = seg * 2 + 1
    for a in range(seg):
        for b in range(seg * 2):
            i = a * row + b; tris += [(i, i + row, i + 1), (i + 1, i + row, i + row + 1)]
    return np.array(vs), np.array(tris, np.uint32), np.array(ns_), np.tile([0.02, 0.016, 0.014], (len(vs), 1))


# ------------------------------------------------------------------ one class at one level of detail
def mid():
    return {k: 0.5 for k in DIMS}


def build(name, lod, log=lambda *a: print(*a, flush=True)):
    spec = SPECIES[name]; h = LODS[lod]; infl = 0.6 * h if lod > 0 else 0.0
    human = spec.get("kind") == "human"; dims = spec.get("dims", DIMS)
    jf = (lambda sp, t: human_joints(t)) if human else joints; af = human_anatomy if human else anatomy; cf = human_colour if human else colour
    t0 = {k: 0.5 for k in dims}; J0 = jf(spec, t0); prims = af(spec, t0, J0)
    lo = np.array([-0.85, -0.01, -0.26]) if not human else np.array([-0.32, -0.01, -0.36]); hi = np.array([1.12, 1.9 if name == "deer" else 1.25, 0.26]) if not human else np.array([0.36, 2.2, 0.36])
    shape = tuple(int(np.ceil((hi[a] - lo[a]) / h)) + 1 for a in range(3))
    tm = time.time(); D = evaluate_grid(prims, lo, h, shape, infl); log(f"  {name} lod{lod}: grid {shape} in {time.time() - tm:.1f} s")
    verts, tris = surface_nets(D, lo, h); del D
    verts = settle(prims, verts, infl, 2, h)
    _, ds = field(prims, verts, infl, each=True); ds = np.stack(ds, 1)
    dmin = ds.min(1, keepdims=True); infl_w = np.exp(-np.clip(ds - dmin, 0, None) / (0.012 + h))
    region_of = np.argmin(ds, 1)
    N0 = grad(prims, verts, infl); N0 /= np.linalg.norm(N0, axis=1, keepdims=True) + 1e-12
    # bones: blended over the primitives by influence, two strongest kept
    W = np.zeros((len(verts), 21 if not human else 14))
    for i, pr in enumerate(prims):
        for b, w in pr.bone_weights(verts):
            W[:, b] += infl_w[:, i] * w
    top = np.argsort(-W, 1)[:, :2]; tw = np.take_along_axis(W, top, 1); tw /= tw.sum(1, keepdims=True) + 1e-12
    names = sorted({pr.region for pr in prims}); allv = np.ones(len(verts), bool)
    rc = {r: cf(spec, {r: allv}, verts, N0, J0) for r in names}
    rw = {r: np.zeros(len(verts)) for r in names}
    for i, pr in enumerate(prims):
        rw[pr.region] += infl_w[:, i] ** 3                    # sharpened, so marks stay crisp but borders blend over a few millimetres
    tot = sum(rw.values()) + 1e-12
    col = sum(rc[r] * (rw[r] / tot)[:, None] for r in names)
    log(f"  {name} lod{lod}: {len(verts)} vertices, {len(tris)} triangles")
    # each dimension's two extremes: carry every vertex with its primitives, then settle onto the extreme's surface
    dpos = np.zeros((len(verts), NDIM, 3), np.float32); dnrm = np.zeros((len(verts), NDIM, 3), np.float32)
    wsum = infl_w.sum(1, keepdims=True)
    parts_base = parts(spec, t0, J0, lod) if not human else None
    dparts = []
    for k, dim in enumerate(dims):
        if dim.startswith("-"):                                  # an unused slot: no change
            dparts.append((None, None, {j: [0.0, 0.0, 0.0] for j in J0})); continue
        ext = []
        for v in (0.0, 1.0):
            t = dict(t0); t[dim] = v; Jt = jf(spec, t); pt = af(spec, t, Jt)
            Pm = np.zeros_like(verts)
            for i, (a, b) in enumerate(zip(prims, pt)):
                Pm += infl_w[:, i:i + 1] * a.affine(b, verts)
            Pm /= wsum
            Pm = settle(pt, Pm, infl, 3, h)
            Nm = grad(pt, Pm, infl); Nm /= np.linalg.norm(Nm, axis=1, keepdims=True) + 1e-12
            ext.append((Pm, Nm, Jt, parts(spec, t, Jt, lod) if not human else None))
        dpos[:, k] = ext[1][0] - ext[0][0]; dnrm[:, k] = ext[1][1] - ext[0][1]
        dparts.append((ext[1][3][0] - ext[0][3][0] if not human else None, ext[1][3][2] - ext[0][3][2] if not human else None, {j: (ext[1][2][j] - ext[0][2][j]).tolist() for j in J0}))
        log(f"    {dim}: max |dP| {np.abs(dpos[:, k]).max():.3f} m")
    joint_d = {j: [d[2][j] for d in dparts] for j in J0}
    if human:
        return dict(verts=verts, tris=tris, nrm=N0, col=col, bones=top, w=tw, dpos=dpos, dnrm=dnrm, J0={j: v.tolist() for j, v in J0.items()}, dJ=joint_d, dims=dims)
    # append ears and eyes (their own extremes regenerated)
    pv, pt_, pn, pc, pb = parts_base
    nb = len(verts)
    verts = np.concatenate([verts, pv]); tris = np.concatenate([tris, pt_ + nb]); N0 = np.concatenate([N0, pn]); col = np.concatenate([col, pc])
    top = np.concatenate([top, pb[:, :2].astype(int)]); tw = np.concatenate([tw, np.stack([pb[:, 2], 1 - pb[:, 2]], 1)])
    dpos = np.concatenate([dpos, np.stack([d[0] for d in dparts], 1).astype(np.float32)])
    dnrm = np.concatenate([dnrm, np.stack([d[1] for d in dparts], 1).astype(np.float32)])
    joint_d = {j: [d[2][j] for d in dparts] for j in J0}
    return dict(verts=verts, tris=tris, nrm=N0, col=col, bones=top, w=tw, dpos=dpos, dnrm=dnrm, J0={j: v.tolist() for j, v in J0.items()}, dJ=joint_d)


def parts(spec, t, J, lod):
    """Ears (bones 17, 18, blended into the head at the base) and eyes (19, 20) at dimension values t."""
    nt, ns = (14, 8) if lod == 0 else (8, 5) if lod == 1 else (4, 3)
    vs, ts, ns_, cs, bs = [], [], [], [], []; off = 0
    for s, eb, bb in ((1, 17, 19), (-1, 18, 20)):
        v, tr, n, c = ear(spec, t, J, s, nt, ns)
        u = np.clip(((v - J["ears"] * np.array([1, 1, s])) @ unit(V(-0.3, 0.8, 0.62 * s))) / 0.03, 0, 1)
        vs.append(v); ts.append(tr + off); ns_.append(n); cs.append(c); bs.append(np.stack([np.full(len(v), eb), np.full(len(v), 3), u], 1)); off += len(v)
        v, tr, n, c = eyeball(spec, t, J, s, 7 if lod == 0 else 5 if lod == 1 else 3)
        vs.append(v); ts.append(tr + off); ns_.append(n); cs.append(c); bs.append(np.stack([np.full(len(v), bb), np.full(len(v), bb), np.ones(len(v))], 1)); off += len(v)
    return np.concatenate(vs), np.concatenate(ts), np.concatenate(ns_), np.concatenate(cs), np.concatenate(bs)


def write(name, outs, outdir):
    outdir.mkdir(parents=True, exist_ok=True); index = {"law": "deer.valley.forms/1", "class": name, "dims": outs[0].get("dims", DIMS), "lods": []}
    for lod, m in enumerate(outs):
        nv = len(m["verts"])
        vb = np.zeros((nv, 13), np.float32)
        vb[:, 0:3] = m["verts"]; vb[:, 3:6] = m["nrm"]; vb[:, 6:9] = m["col"]; vb[:, 9:11] = m["bones"]; vb[:, 11:13] = m["w"]
        files = {}
        blobs = {"mesh": vb.tobytes() + m["tris"].astype(np.uint32).tobytes(),
                 "dpos": m["dpos"].astype(np.float32).tobytes(),
                 "dnrm": np.concatenate([m["dnrm"], np.zeros((nv, NDIM, 1), np.float32)], 2).astype(np.float16).tobytes()}
        for key, blob in blobs.items():
            parts = [blob[i:i + PART] for i in range(0, len(blob), PART)]
            names = [f"{name}.lod{lod}.{key}.bin" if len(parts) == 1 else f"{name}.lod{lod}.{key}.part{j}.bin" for j in range(len(parts))]
            for fn, part in zip(names, parts):
                (outdir / fn).write_bytes(part)
            files[key] = {"file": names[0], "parts": names, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}
        index["lods"].append({"cell_m": LODS[lod], "vertices": nv, "triangles": len(m["tris"]), "files": files})
    index["joints"] = outs[0]["J0"]; index["djoints"] = outs[0]["dJ"]
    (outdir / f"{name}.json").write_text(json.dumps(index, indent=1) + "\n")


def main(argv):
    out = Path(argv[0]); only = ["deer", "wolf"]; lods = [0, 1, 2]
    if "--only" in argv: only = argv[argv.index("--only") + 1].split(",")
    if "--lods" in argv: lods = [int(x) for x in argv[argv.index("--lods") + 1].split(",")]
    for name in only:
        t0 = time.time(); outs = [build(name, lod) for lod in lods]
        if lods == [0, 1, 2]:
            write(name, outs, out)
        else:
            write(name + "_test", outs, out)
        print(f"{name}: {time.time() - t0:.0f} s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
