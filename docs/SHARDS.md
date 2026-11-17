# Shards: what the repository carries, and the GitHub budget

The console's code is about 10 MB. Everything else under `shards/` is baked data, made by the tools in
`tools/bake/` and checked by `tools/check_github_limits.py` against GitHub's limits as this project
applies them: no file of 25,000,000 bytes or more (the target is 22,500,000) and no repository over
1,000,000,000 bytes (the target is 985,000,000).

| Group | Files | Bytes | What it is | Made by |
| --- | --- | --- | --- | --- |
| `shards/materials/` | 49 | 514.2 MB | 24 surface sets (soils, rock, scree, moss, litter, snow, bark, dead wood, leaf blade, deer and wolf fur, antler, nose leather, canvas, leather, iris): albedo and height-normal-roughness layers, up to five octaves of tiling detail | `tools/bake/materials.py` |
| `shards/animals/` | 30 | 113.6 MB | the deer, wolf and warden forms: three levels of detail, each a base mesh plus sixteen dimension deltas for positions and normals | `tools/bake/animals.py` |
| `shards/zarr/` | 218 | 323.4 MB | the reference valley: the living map at genesis and after six years, and the byte20 frame of every one of its 576 epochs | `tools/bake/reference.mjs` |
| **all shards** | 297 | **951.2 MB** | with the code, the tree is 957.0 MB, 95.7% of 1 GB | |

`shards/MANIFEST.json` lists every shard file with its size, SHA-256 and four metrics:
- `nominal_entries`: the values the file stands for;
- `true_stored_bits`: the bits it occupies;
- `rank_bound`: a bound on the rank of the matrix it holds;
- `deflate_bytes`: its size after zlib, an upper bound on the information it really carries.

The last one keeps the totals honest. The PNG material sets are already compressed. The float deltas of
the animal forms compress a little. The raw integer arrays of the reference valley compress a lot:
together, the shards deflate to 694.8 MB.

## The reference valley

`shards/zarr/deer-valley-reference.zarr` is the default world: seed 20261117, the Simmy boot, 4,096 deer at
the start, and no interventions. It is run for six years (576 epochs) and written as an ordinary Zarr v3
store:

    zarr.json                 the root group; attributes.russl records the config, the Simmy replay digest,
                              the genesis and final chain, and the codecs used
    map/epoch-0000/           the living map at genesis: six channels (height, rock, moisture, material,
    map/epoch-0576/           drainage, terrain) as OME-NGFF 0.5 multiscale images, eight levels each,
                              0.25 m to 32 m a sample; and the same map after six years of trails and rain
    byte20/0                  int32 (t, c, y, x) = (576, 5, 128, 128): every epoch's byte20 frame, the five
                              160-bit words of every 4 m block (attributes list each epoch's digests and chain)

Every array uses the `sharding_indexed` codec:
- A chunk is the console's own unit: a 128 × 128 map chunk, or one epoch's frame (327,680 bytes, exactly
  the `.b20` file the valley page downloads). Every chunk is under 1 MB.
- A shard is one whole map level, or 64 epochs. Every shard file is under 22.5 MB.

The index at the end of each shard carries a CRC-32C.

Two tools check it:
- `node tools/verify_reference.mjs [--replay N|all]` reads every shard, recomputes every map level's root
  and every epoch's frame digest and chain. With `--replay all`, it also runs the world again from the
  Simmy boot and compares all 576 frames and the final map byte for byte. This takes about a minute.
  `test/forms.test.mjs` replays the first eight epochs.
- `python -I -B tools/verify_reference.py` is an independent reader written from the Zarr v3 and
  sharding specifications. It uses only the standard library and shares no code with the console.

The store keeps to the Zarr v3 core and sharding specifications, and its sharding index uses
zarr-python's default codecs (bytes, then crc32c). So a Zarr v3 reader with sharding support, such as
zarr-python 3, should open it. zarr-python was not available where the store was made; the independent
reader above stands in for it. For example:

    import zarr
    g = zarr.open_group("shards/zarr/deer-valley-reference.zarr", mode="r")
    height = g["map/epoch-0576/height/0"][:]          # 2048 x 2048 int32, millimetres
    frames = g["byte20/0"][:64]                        # the first 64 epochs' frames

`serve.mjs` and the Photon host serve the store at `/shards/zarr/`, so browser Zarr readers can open it over
HTTP too.

## The GitHub budget

GitHub stores a repository as git objects, and that is what its size limit measures. The checked-out tree
is a second copy of the same content. The gatekeeper therefore checks the two separately:
- the payload (the tree outside `.git`) against 985 MB;
- `.git/objects` against 1 GB.

Before you commit:
- **Commit the shards once.** Every committed rebake of a binary shard adds a whole new copy to the
  history. If you rebake, squash it into the commit that added the shard, or start the history again.
- **Measure the real size** after a commit with `git gc` and `git count-objects -vH`.
- **Turn on the gatekeeper** for every commit: `git config core.hooksPath tools/git-hooks`.
- **Use `tools\check_github_limits.cmd`** on Windows without Python. It checks the sizes; with Python it
  also checks the manifest's seals.
