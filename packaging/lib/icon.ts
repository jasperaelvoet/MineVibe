import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/** An RGBA image. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** width * height * 4 bytes. */
  readonly data: Uint8Array;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes an 8-bit RGBA PNG (no filtering; small placeholder art compresses fine). */
export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) throw new Error('RGBA buffer size does not match the dimensions');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Deterministic 16x16 placeholder art: a grass block with a little monitor glow. */
function placeholderPixel(x: number, y: number): [number, number, number] {
  const noise = ((x * 73856093) ^ (y * 19349663)) & 7; // stable speckle
  if (y >= 5 && y <= 10 && x >= 4 && x <= 11) {
    // a small screen on the block's face
    if (y === 5 || y === 10 || x === 4 || x === 11) return [40, 44, 52];
    return noise < 3 ? [120, 220, 255] : [70, 170, 230];
  }
  if (y < 4 || (y === 4 && noise < 5)) return noise < 3 ? [88, 160, 56] : [108, 186, 70];
  return noise < 2 ? [110, 78, 52] : noise < 5 ? [134, 96, 64] : [150, 108, 72];
}

/** The placeholder icon at `size` px: nearest-neighbour pixel art inside a rounded square. */
export function placeholderIcon(size: number): Rgba {
  if (size % 16 !== 0) throw new Error('icon size must be a multiple of 16');
  const data = new Uint8Array(size * size * 4);
  const scale = size / 16;
  const radius = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = placeholderPixel(Math.floor(x / scale), Math.floor(y / scale));
      // rounded-corner mask with one pixel of antialiasing
      const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
      const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5));
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, data };
}

/** The files of a macOS `.iconset` folder: name → pixel size. */
export const ICONSET: ReadonlyArray<readonly [string, number]> = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** Writes `<dir>/MineVibe.iconset/*.png`; `iconutil -c icns` turns it into the .icns. Returns the folder. */
export async function writePlaceholderIconset(dir: string): Promise<string> {
  const iconset = join(dir, 'MineVibe.iconset');
  await mkdir(iconset, { recursive: true });
  const cache = new Map<number, Buffer>();
  for (const [name, size] of ICONSET) {
    let png = cache.get(size);
    if (!png) {
      png = encodePng(placeholderIcon(size));
      cache.set(size, png);
    }
    await writeFile(join(iconset, name), png);
  }
  return iconset;
}
