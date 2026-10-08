import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CachedDownload {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  /** File name inside `<cacheDir>/<sha256>/`. */
  readonly fileName: string;
}

/**
 * Content-addressed download cache: `<cacheDir>/<sha256>/<fileName>`. A cached file is re-hashed before use; a
 * download streams to `.part` with size and sha256 checks and is renamed into place only when both match.
 * Returns the path and whether it was downloaded now.
 */
export async function ensureDownloaded(
  item: CachedDownload,
  cacheDir: string,
  options: { fetch?: FetchLike; userAgent?: string } = {},
): Promise<{ path: string; downloaded: boolean }> {
  const dir = join(cacheDir, item.sha256);
  const path = join(dir, item.fileName);
  try {
    if ((await stat(path)).size === item.size && (await sha256File(path)) === item.sha256) {
      return { path, downloaded: false };
    }
  } catch {
    // not cached
  }
  await mkdir(dir, { recursive: true });
  const part = `${path}.part`;
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(item.url, {
    headers: { 'user-agent': options.userAgent ?? 'MineVibe-packaging' },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`GET ${item.url}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > item.size) {
        callback(new Error(`${item.url}: more than the pinned ${item.size} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(part, { mode: 0o644 }),
    );
    if (bytes !== item.size) throw new Error(`${item.url}: got ${bytes} bytes, the lock pins ${item.size}`);
    const actual = hash.digest('hex');
    if (actual !== item.sha256)
      throw new Error(`${item.url}: sha256 ${actual} does not match the lock (${item.sha256})`);
    await rename(part, path);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return { path, downloaded: true };
}

export interface TreeEntry {
  /** Path relative to the root, with `/`. */
  readonly rel: string;
  readonly kind: 'file' | 'symlink' | 'dir';
  readonly mode: number;
  /** sha256 for files, the target for symlinks. */
  readonly content: string;
}

/** Every entry under `root` (symlinks are not followed), sorted by path. */
export async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join('/');
      const st = await lstat(path);
      if (st.isSymbolicLink()) out.push({ rel, kind: 'symlink', mode: 0, content: await readlink(path) });
      else if (st.isDirectory()) {
        out.push({ rel, kind: 'dir', mode: st.mode & 0o7777, content: '' });
        await walk(path);
      } else if (st.isFile())
        out.push({ rel, kind: 'file', mode: st.mode & 0o777, content: await sha256File(path) });
    }
  };
  await walk(root);
  return out;
}

/**
 * Checks that `copy` holds exactly the files, symlinks and modes of `original` with the same bytes (vendor code
 * must stay byte-identical, or its signature breaks). Returns the differences (empty = identical).
 */
export async function compareTrees(original: string, copy: string): Promise<string[]> {
  const [a, b] = await Promise.all([snapshotTree(original), snapshotTree(copy)]);
  const byRel = new Map(b.map((e) => [e.rel, e]));
  const problems: string[] = [];
  for (const e of a) {
    const other = byRel.get(e.rel);
    byRel.delete(e.rel);
    if (!other) problems.push(`${e.rel}: missing`);
    else if (other.kind !== e.kind) problems.push(`${e.rel}: ${e.kind} became ${other.kind}`);
    else if (other.content !== e.content) problems.push(`${e.rel}: content differs`);
    else if (e.kind === 'file' && other.mode !== e.mode) problems.push(`${e.rel}: mode differs`);
  }
  for (const rel of byRel.keys()) problems.push(`${rel}: extra`);
  return problems;
}

const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe]);

/** True for a Mach-O (thin or universal) file. */
export async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGICS.has(buf.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/** Total size of the regular files under `root`. */
export async function treeSize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    }
  };
  await walk(root);
  return total;
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
