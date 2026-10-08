#!/usr/bin/env python3
"""Generates the GameTest structures used by the S1 agent-body tests.

Writes apps/mod/src/gametest/resources/data/minevibe-gametest/gametest/structure/<name>.snbt:

- path_course (56 x 10 x 11): 50+ blocks of uneven terrain for agent_paths_50_blocks. Hills with
  1-block steps, a 2-high wall with a gap at one side (forces a detour), a log "tree" in the way, a
  2-deep water pool across the whole width (forces a swim), a 2-block drop, boulders.
- arena (16 x 6 x 16): flat, empty floor for the perf test.

Relative y=0 sits directly on the GameTest world's sandstone ground. A column of height h has solid
blocks at y=0..h-1 and you stand at y=h.

Standard library only:  python3 spikes/s1-fake-player/gen_structures.py
"""

import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "mod", "src", "gametest", "resources", "data", "minevibe-gametest", "gametest", "structure")
DATA_VERSION = 5023  # SharedConstants.WORLD_VERSION for 26.3

# Height profile along x (the walking direction). Adjacent steps are at most 1 block, except the
# deliberate 2-block drop at x=40 -> 41.
PROFILE = (
    [1, 1, 1, 1]                       # 0..3 start
    + [1, 2, 2, 3, 3, 3, 2, 2, 3, 4, 4, 3, 2, 2, 1, 1, 2]   # 4..20 hills
    + [2, 2, 2, 2, 2, 2]               # 21..26 plateau with the wall at 24
    + [2, 0, 0, 0, 0, 2]               # 27..32 pool (water at x=28..31)
    + [2, 3, 3, 4, 4, 5, 5, 5, 3, 3, 3, 2]   # 33..44 climb, then a 2-block drop at 40->41
    + [2] * 11                         # 45..55 flat finish
)
assert len(PROFILE) == 56, len(PROFILE)
SIZE_X, SIZE_Y, SIZE_Z = 56, 10, 11
WALL_X = 24
WALL_GAP_Z = range(8, 11)
POOL_X = range(28, 32)
TREE = (10, 5)  # log column
BOULDERS = [(6, 2), (14, 8), (17, 3), (36, 7), (47, 2), (50, 8)]


def path_course():
    blocks = {}
    for x in range(SIZE_X):
        for z in range(SIZE_Z):
            h = PROFILE[x]
            if (x, z) in BOULDERS:
                h += 1
            for y in range(h):
                blocks[(x, y, z)] = "minecraft:grass_block{snowy:false}" if y == h - 1 else "minecraft:dirt"
    # Water pool: 2 deep, the full width of the course.
    for x in POOL_X:
        for z in range(SIZE_Z):
            for y in range(2):
                blocks[(x, y, z)] = "minecraft:water{level:0}"
    # A 2-high stone wall across the plateau with a gap at high z.
    base = PROFILE[WALL_X]
    for z in range(SIZE_Z):
        if z in WALL_GAP_Z:
            continue
        for y in range(base, base + 2):
            blocks[(WALL_X, y, z)] = "minecraft:stone"
    # A tree trunk in the way.
    tx, tz = TREE
    for y in range(PROFILE[tx], PROFILE[tx] + 4):
        blocks[(tx, y, tz)] = "minecraft:oak_log{axis:y}"
    return (SIZE_X, SIZE_Y, SIZE_Z), blocks


def arena():
    size = (16, 6, 16)
    blocks = {}
    for x in range(16):
        for z in range(16):
            blocks[(x, 0, z)] = "minecraft:smooth_stone"
    return size, blocks


def snbt(size, blocks):
    palette = sorted(set(blocks.values()))
    lines = ["{", f"    DataVersion: {DATA_VERSION},", f"    size: [{size[0]}, {size[1]}, {size[2]}],", "    data: ["]
    entries = [f'        {{pos: [{x}, {y}, {z}], state: "{s}"}}' for (x, y, z), s in sorted(blocks.items())]
    lines.append(",\n".join(entries))
    lines.append("    ],")
    lines.append("    entities: [],")
    lines.append("    palette: [")
    lines.append(",\n".join(f'        "{p}"' for p in palette))
    lines.append("    ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (("path_course", path_course), ("arena", arena)):
        size, blocks = fn()
        path = os.path.join(OUT, name + ".snbt")
        with open(path, "w") as f:
            f.write(snbt(size, blocks))
        print("wrote", os.path.relpath(path, ROOT), len(blocks), "blocks")


if __name__ == "__main__":
    main()
