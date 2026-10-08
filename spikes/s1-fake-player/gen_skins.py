#!/usr/bin/env python3
"""Generates the placeholder agent role skins (64x64, classic wide-arm layout).

Writes apps/mod/src/main/resources/assets/minevibe/textures/entity/agent/<role>.png.
Standard library only (zlib + struct), so it runs anywhere:  python3 spikes/s1-fake-player/gen_skins.py
"""

import os
import struct
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "apps", "mod", "src", "main", "resources", "assets", "minevibe", "textures", "entity", "agent")

SKIN = (224, 172, 135, 255)
SKIN_SHADE = (198, 147, 112, 255)
EYE_WHITE = (245, 245, 245, 255)
EYE = (40, 60, 110, 255)
MOUTH = (150, 80, 70, 255)
SHOE = (45, 35, 30, 255)

# role: (hair/hat, shirt, shirt accent, pants)
ROLES = {
    "ceo": ((60, 40, 30, 255), (31, 42, 68, 255), (190, 30, 40, 255), (25, 30, 45, 255)),
    "engineer": ((90, 60, 35, 255), (47, 111, 214, 255), (220, 220, 230, 255), (55, 60, 75, 255)),
    "miner": ((235, 190, 30, 255), (217, 130, 43, 255), (60, 60, 60, 255), (70, 55, 40, 255)),
    "farmer": ((216, 194, 122, 255), (76, 154, 42, 255), (140, 100, 60, 255), (60, 80, 140, 255)),
    "guard": ((122, 122, 122, 255), (176, 58, 46, 255), (160, 160, 165, 255), (70, 70, 75, 255)),
    "builder": ((240, 150, 20, 255), (232, 193, 28, 255), (90, 90, 90, 255), (80, 70, 55, 255)),
}


def png(width, height, pixels):
    raw = b"".join(b"\x00" + bytes(c for px in pixels[y * width:(y + 1) * width] for c in px) for y in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def skin(hair, shirt, accent, pants):
    w = h = 64
    px = [(0, 0, 0, 0)] * (w * h)

    def fill(x0, y0, x1, y1, color):
        for y in range(y0, y1):
            for x in range(x0, x1):
                px[y * w + x] = color

    # Head (base layer): x 0..32, y 0..16
    fill(0, 0, 32, 16, SKIN)
    fill(8, 0, 16, 8, hair)            # top
    fill(16, 0, 24, 8, SKIN_SHADE)     # bottom
    fill(24, 8, 32, 16, hair)          # back
    fill(0, 8, 8, 11, hair)            # right side, top rows
    fill(16, 8, 24, 11, hair)          # left side, top rows
    fill(8, 8, 16, 10, hair)           # fringe on the face
    fill(9, 12, 11, 13, EYE_WHITE)
    fill(10, 12, 11, 13, EYE)
    fill(13, 12, 15, 13, EYE_WHITE)
    fill(13, 12, 14, 13, EYE)
    fill(11, 14, 13, 15, MOUTH)

    # Body: x 16..40, y 16..32
    fill(16, 16, 40, 32, shirt)
    fill(23, 20, 25, 27, accent)       # tie / stripe on the front
    fill(20, 30, 28, 32, pants)        # belt line
    # Right arm: x 40..56, y 16..32 (sleeve then hand)
    fill(40, 16, 56, 32, shirt)
    fill(40, 28, 56, 32, SKIN)
    fill(48, 16, 52, 20, SKIN)         # bottom of the hand
    # Left arm: x 32..48, y 48..64
    fill(32, 48, 48, 64, shirt)
    fill(32, 60, 48, 64, SKIN)
    fill(40, 48, 44, 52, SKIN)
    # Right leg: x 0..16, y 16..32
    fill(0, 16, 16, 32, pants)
    fill(0, 30, 16, 32, SHOE)
    fill(8, 16, 12, 20, SHOE)          # sole
    # Left leg: x 16..32, y 48..64
    fill(16, 48, 32, 64, pants)
    fill(16, 62, 32, 64, SHOE)
    fill(24, 48, 28, 52, SHOE)
    return px


def main():
    os.makedirs(OUT, exist_ok=True)
    for role, colors in ROLES.items():
        path = os.path.join(OUT, role + ".png")
        with open(path, "wb") as f:
            f.write(png(64, 64, skin(*colors)))
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
