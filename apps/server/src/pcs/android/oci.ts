import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

/**
 * OCI image tars for the Android phone image (PLAN §8.7, spike S9-android `oci/relsym.py`).
 *
 * Redroid's `/etc` is an absolute symlink to `/system/etc`. Apple `container`'s vminitd writes `/etc/hosts` and
 * `/etc/resolv.conf` through the container's root filesystem, follows that link out of it and bootstrap fails
 * (`configureDns` / `configureHosts`). {@link addRelativeEtcLayer} rewrites an `image save` tar into one whose image
 * has one more layer with `etc -> system/etc` (relative), ready for `image load`. Only the small JSON blobs are read
 * into memory; the big layer is copied through in chunks.
 */

const BLOCK = 512;
const COPY_CHUNK = 4 * 1024 * 1024;

export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export const OCI_LAYER_GZIP = 'application/vnd.oci.image.layer.v1.tar+gzip';

/** A fixed timestamp for the added layer and history entry, so the patched image's digests are reproducible. */
const PATCH_TIME = new Date('2026-10-09T00:00:00Z');

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { architecture?: string; os?: string; variant?: string };
  annotations?: Record<string, string>;
}

interface IndexJson {
  schemaVersion: number;
  mediaType?: string;
  manifests: Descriptor[];
}

interface ManifestJson {
  schemaVersion: number;
  mediaType?: string;
  config: Descriptor;
  layers: Descriptor[];
  annotations?: Record<string, string>;
}

interface ConfigJson {
  rootfs: { type: string; diff_ids: string[] };
  history?: { created?: string; created_by?: string; empty_layer?: boolean }[];
  [k: string]: unknown;
}

// ------------------------------------------------------------------------------------------------ tar

/** One entry of a tar: its name, data and where its bytes (headers included) sit in the file. */
export interface TarEntry {
  name: string;
  type: string;
  size: number;
  /** Offset of the entry's first header (a pax or GNU long-name header counts as part of it). */
  start: number;
  /** Offset of its data. */
  dataOffset: number;
  /** Offset just past its padded data. */
  end: number;
}

const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

function cString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length);
  // GNU base-256 for sizes ≥ 8 GiB: high bit set on the first byte.
  if ((raw[0] ?? 0) & 0x80) {
    let n = 0;
    for (let i = 1; i < raw.length; i++) n = n * 256 + (raw[i] ?? 0);
    return n;
  }
  const s = cString(buf, offset, length).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** `path` from a pax extended header's records (`<len> path=<value>\n`). */
function paxPath(data: Buffer): string | null {
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number.parseInt(data.subarray(i, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    i += len;
  }
  return null;
}

/** Lists the entries of a tar file (ustar, pax and GNU long names), without reading their data. */
export async function listTar(file: string): Promise<TarEntry[]> {
  const fh = await open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    const out: TarEntry[] = [];
    const header = Buffer.alloc(BLOCK);
    let pos = 0;
    let start: number | null = null;
    let longName: string | null = null;
    while (pos + BLOCK <= total) {
      await fh.read(header, 0, BLOCK, pos);
      if (header.every((b) => b === 0)) break;
      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0x30);
      const dataOffset = pos + BLOCK;
      const end = dataOffset + padded(size);
      if (end > total) throw new Error(`tar ${file} is truncated`);
      start ??= pos;
      if (type === 'x' || type === 'L') {
        const data = Buffer.alloc(size);
        await fh.read(data, 0, size, dataOffset);
        longName = type === 'x' ? paxPath(data) : cString(data, 0, size);
        pos = end;
        continue;
      }
      if (type === 'g') {
        // A global pax header belongs to no entry.
        pos = end;
        start = null;
        continue;
      }
      const prefix = cString(header, 345, 155);
      const short = cString(header, 0, 100);
      const name = longName ?? (prefix ? `${prefix}/${short}` : short);
      out.push({ name: name.replace(/^\.\//, ''), type, size, start, dataOffset, end });
      pos = end;
      start = null;
      longName = null;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** A ustar header for a regular file (`type` 0) or a symlink (`type` 2). Names must fit ustar's 100 bytes. */
export function tarHeader(
  name: string,
  size: number,
  options: { type?: '0' | '2' | '5'; mode?: number; linkName?: string; mtime?: Date } = {},
): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const put = (s: string, offset: number, length: number) => {
    h.write(s.slice(0, length), offset, length, 'utf8');
  };
  const num = (n: number, offset: number, length: number) => {
    put(`${n.toString(8).padStart(length - 1, '0')}\0`, offset, length);
  };
  put(name, 0, 100);
  num(options.mode ?? 0o644, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(size, 124, 12);
  num(Math.floor((options.mtime ?? PATCH_TIME).getTime() / 1000), 136, 12);
  h.fill(0x20, 148, 156);
  put(options.type ?? '0', 156, 1);
  if (options.linkName) put(options.linkName, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('root', 265, 32);
  put('root', 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** A whole tar (headers, padded data, end blocks) of small in-memory files. */
export function tarOf(files: readonly { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(tarHeader(f.name, f.data.length), f.data, Buffer.alloc(padded(f.data.length) - f.data.length));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------ the patch

export const sha256 = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The added layer: one relative symlink `etc -> system/etc` (uncompressed tar, and its gzip). */
export function relativeEtcLayer(): { tar: Buffer; gz: Buffer } {
  const tar = Buffer.concat([
    tarHeader('etc', 0, { type: '2', mode: 0o777, linkName: 'system/etc' }),
    Buffer.alloc(2 * BLOCK),
  ]);
  return { tar, gz: gzipSync(tar, { level: 9 }) };
}

export interface PatchResult {
  /** Digest of the new image index (what `image inspect` reports after the load). */
  indexDigest: string;
  manifestDigest: string;
  layerDigest: string;
}

/**
 * Reads `src` (an `image save` tar of one platform), checks that its arm64 manifest is `expectManifest`, and writes
 * `dst`: the same blobs plus the relative-`/etc` layer, a new config, manifest and index, and an `index.json` that
 * names the image `name`. Every small blob is checked against its digest.
 */
export async function addRelativeEtcLayer(
  src: string,
  dst: string,
  options: { name: string; expectManifest: string; history?: string },
): Promise<PatchResult> {
  const entries = await listTar(src);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const fh = await open(src, 'r');
  const readEntry = async (e: TarEntry, max = 4 * 1024 * 1024): Promise<Buffer> => {
    if (e.size > max) throw new Error(`${e.name} is too large to read (${e.size} bytes)`);
    const b = Buffer.alloc(e.size);
    await fh.read(b, 0, e.size, e.dataOffset);
    return b;
  };
  const blob = async (digest: string): Promise<Buffer> => {
    const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
    if (!m) throw new Error(`unsupported digest ${digest}`);
    const e = byName.get(`blobs/sha256/${m[1]}`);
    if (!e) throw new Error(`blob ${digest} is missing from the image tar`);
    const b = await readEntry(e);
    if (sha256(b) !== digest) throw new Error(`blob ${digest} does not match its digest`);
    return b;
  };
  let out: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const indexEntry = byName.get('index.json');
    if (!indexEntry) throw new Error('the image tar has no index.json');
    const top = JSON.parse((await readEntry(indexEntry)).toString('utf8')) as IndexJson;
    // index.json → (nested indexes) → the arm64 manifest.
    let manifestDesc: Descriptor | undefined;
    let level: Descriptor[] = top.manifests;
    for (let depth = 0; depth < 4 && !manifestDesc; depth++) {
      const arm = level.find((d) => d.mediaType === OCI_MANIFEST && d.platform?.architecture === 'arm64');
      const any = level.find((d) => d.mediaType === OCI_MANIFEST);
      if (arm || (any && level.length === 1)) {
        manifestDesc = arm ?? any;
        break;
      }
      const nested = level.find((d) => d.mediaType === OCI_INDEX);
      if (!nested) break;
      level = (JSON.parse((await blob(nested.digest)).toString('utf8')) as IndexJson).manifests;
    }
    if (!manifestDesc) throw new Error('no arm64 manifest in the image tar');
    if (manifestDesc.digest !== options.expectManifest) {
      throw new Error(
        `the image's arm64 manifest is ${manifestDesc.digest}, not the pinned ${options.expectManifest}`,
      );
    }
    const manifest = JSON.parse((await blob(manifestDesc.digest)).toString('utf8')) as ManifestJson;
    const config = JSON.parse((await blob(manifest.config.digest)).toString('utf8')) as ConfigJson;
    for (const l of manifest.layers) {
      const m = /^sha256:([0-9a-f]{64})$/.exec(l.digest);
      if (!m || !byName.has(`blobs/sha256/${m[1]}`)) throw new Error(`layer ${l.digest} is missing`);
    }

    const layer = relativeEtcLayer();
    const layerDigest = sha256(layer.gz);
    config.rootfs.diff_ids.push(sha256(layer.tar));
    config.history = [
      ...(config.history ?? []),
      {
        created: PATCH_TIME.toISOString(),
        created_by: options.history ?? 'minevibe: /etc -> system/etc (relative, for vminitd)',
      },
    ];
    const configBuf = Buffer.from(JSON.stringify(config));
    const newManifest: ManifestJson = {
      ...manifest,
      config: { ...manifest.config, digest: sha256(configBuf), size: configBuf.length },
      layers: [...manifest.layers, { mediaType: OCI_LAYER_GZIP, digest: layerDigest, size: layer.gz.length }],
    };
    const manifestBuf = Buffer.from(JSON.stringify(newManifest));
    const manifestDigest = sha256(manifestBuf);
    const inner: IndexJson = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: manifestDigest,
          size: manifestBuf.length,
          platform: manifestDesc.platform ?? { architecture: 'arm64', os: 'linux' },
        },
      ],
    };
    const innerBuf = Buffer.from(JSON.stringify(inner));
    const indexDigest = sha256(innerBuf);
    const annotations = {
      'com.apple.containerization.image.name': options.name,
      'org.opencontainers.image.ref.name': options.name,
      'io.containerd.image.name': options.name,
    };
    const topBuf = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [{ mediaType: OCI_INDEX, digest: indexDigest, size: innerBuf.length, annotations }],
      }),
    );

    // Copy every entry but index.json byte for byte, then add the new blobs and index.json.
    out = await open(dst, 'w', 0o600);
    let outPos = 0;
    const buf = Buffer.alloc(COPY_CHUNK);
    for (const e of entries) {
      if (e.name === 'index.json') continue;
      for (let at = e.start; at < e.end; ) {
        const n = Math.min(COPY_CHUNK, e.end - at);
        const { bytesRead } = await fh.read(buf, 0, n, at);
        if (bytesRead !== n) throw new Error('short read while copying the image tar');
        await out.write(buf, 0, n, outPos);
        outPos += n;
        at += n;
      }
    }
    const added = [
      { name: blobName(layerDigest), data: layer.gz },
      { name: blobName(sha256(configBuf)), data: configBuf },
      { name: blobName(manifestDigest), data: manifestBuf },
      { name: blobName(indexDigest), data: innerBuf },
    ].filter((f) => !byName.has(f.name));
    const tail = tarOf([...added, { name: 'index.json', data: topBuf }]);
    await out.write(tail, 0, tail.length, outPos);
    await out.sync();
    return { indexDigest, manifestDigest, layerDigest };
  } finally {
    await fh.close();
    await out?.close();
  }
}

function blobName(digest: string): string {
  return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}
