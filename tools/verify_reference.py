#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""An independent reader of the reference valley store, written from the Zarr v3 and sharding_indexed specs.

    python -I -B tools/verify_reference.py [STORE.zarr]

It shares no code with the console. It reads every array's metadata and allows only the codec chain
sharding_indexed(bytes) with a bytes + crc32c index at the end. It decodes every shard index and checks its
CRC-32C, and checks that every chunk lies inside its file at its exact size. It then recomputes each map
level's SHA-256 root and every byte20 epoch's frame digest and chain from the stored bytes, and compares
them with the metadata. The standard library is enough.
"""
import hashlib, json, struct, sys
from array import array
from pathlib import Path

ALLOWED = {"sharding_indexed", "bytes", "crc32c"}
SIZE = {"int32": 4, "uint8": 1}
_T = []
for n in range(256):
    c = n
    for _ in range(8):
        c = (0x82F63B78 ^ (c >> 1)) if c & 1 else c >> 1
    _T.append(c)


def crc32c(b):
    c = 0xFFFFFFFF
    for x in b:
        c = _T[(c ^ x) & 255] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


def dumps(o):  # the console's pyDumps: sorted keys, no spaces, ASCII
    return json.dumps(o, sort_keys=True, separators=(",", ":"))


def meta(store, rel):
    m = json.loads((store / rel / "zarr.json").read_text(encoding="utf-8"))
    if m.get("zarr_format") != 3:
        raise ValueError(f"{rel}: zarr_format is not 3")
    return m


def chunks_of(store, rel, m):
    """the inner chunks of every shard of the array at rel, in C order, after checking the metadata."""
    c0 = m["codecs"]
    if len(c0) != 1 or c0[0]["name"] != "sharding_indexed":
        raise ValueError(f"{rel}: the codec chain is not one sharding_indexed codec")
    cfg = c0[0]["configuration"]
    names = {c["name"] for c in cfg["codecs"]} | {c["name"] for c in cfg["index_codecs"]}
    if not names <= ALLOWED or cfg.get("index_location", "end") != "end" or [c["name"] for c in cfg["index_codecs"]] != ["bytes", "crc32c"]:
        raise ValueError(f"{rel}: codecs {sorted(names)} are outside the allowlist")
    if m["chunk_key_encoding"] != {"name": "default", "configuration": {"separator": "/"}}:
        raise ValueError(f"{rel}: unexpected chunk key encoding")
    shape, shard, inner = m["shape"], m["chunk_grid"]["configuration"]["chunk_shape"], cfg["chunk_shape"]
    if any(s % h for s, h in zip(shape, shard)) or any(h % i for h, i in zip(shard, inner)):
        raise ValueError(f"{rel}: the shard grid does not tile the array")
    per = 1
    for h, i in zip(shard, inner):
        per *= h // i
    nbytes = SIZE[m["data_type"]]
    for i in inner:
        nbytes *= i
    grids = [range(s // h) for s, h in zip(shape, shard)]
    import itertools
    for key in itertools.product(*grids):
        b = (store / rel / "c" / "/".join(map(str, key))).read_bytes()
        ix = len(b) - (per * 16 + 4)
        if ix < 0 or crc32c(b[ix:ix + per * 16]) != struct.unpack_from("<I", b, ix + per * 16)[0]:
            raise ValueError(f"{rel}/c/{'/'.join(map(str, key))}: the shard index fails its CRC-32C")
        for k in range(per):
            off, n = struct.unpack_from("<QQ", b, ix + 16 * k)
            if n != nbytes or off + n > ix:
                raise ValueError(f"{rel}: chunk {k} is {n} bytes at {off}")
            yield b[off:off + n]


def main(argv):
    store = Path(argv[0] if argv else Path(__file__).resolve().parent.parent / "shards/zarr/deer-valley-reference.zarr")
    problems, levels, epochs = [], 0, 0
    root = meta(store, "")["attributes"]["russl"]
    if root.get("schema") != "RUSSL.ValleyReference/1":
        print(f"FAIL  {store}: not a reference store"); return 1
    for g in [k for k in root["contents"] if k.startswith("map/")]:
        desc = meta(store, g)["attributes"]["russl"]
        for c in desc["field"]["channels"]:
            for L in desc["levels"]:
                rel = f"{g}/{c['name']}/{L['level']}"
                try:
                    m = meta(store, rel)
                    digests = [hashlib.sha256(ch).hexdigest() for ch in chunks_of(store, rel, m)]
                except (ValueError, OSError) as e:
                    problems.append(str(e)); continue
                r = hashlib.sha256(dumps({"channel": c["name"], "level": L["level"], "chunks": digests}).encode()).hexdigest()
                if r != L["roots"][c["name"]] or r != m["attributes"]["russl"]["root"]:
                    problems.append(f"{rel}: root differs from the metadata")
                levels += 1
    bg = meta(store, "byte20")["attributes"]["russl"]
    m = meta(store, "byte20/0")
    T, W, H, X = m["shape"]
    chain = bg["genesis_chain"]
    try:
        for t, ch in enumerate(chunks_of(store, "byte20/0", m)):
            planes = array("i"); planes.frombytes(ch)
            if sys.byteorder != "little":
                planes.byteswap()
            frame = array("i", [0]) * (len(ch) // 4)
            for w in range(W):
                frame[w::W] = planes[w * H * X:(w + 1) * H * X]
            if sys.byteorder != "little":
                frame.byteswap()
            E = bg["epochs"][t]
            fs = hashlib.sha256(frame.tobytes()).hexdigest()
            chain = hashlib.sha256(dumps({"law": bg["law"], "previous": chain, "epoch": E["epoch"], "valley": E["valley"], "frame": fs}).encode()).hexdigest()
            if fs != E["frame_sha256"] or chain != E["chain"]:
                problems.append(f"byte20 epoch {E['epoch']}: the frame or chain differs"); break
            epochs += 1
    except (ValueError, OSError) as e:
        problems.append(str(e))
    if epochs == T and chain != root["final"]["chain"]:
        problems.append("the final chain differs from the root's record")
    for p in problems:
        print("FAIL ", p)
    print(f"{'PASS' if not problems else 'FAIL'}  {levels} map levels and {epochs} of {T} byte20 epochs read and checked independently")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
