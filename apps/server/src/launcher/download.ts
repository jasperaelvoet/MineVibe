import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { SERVER_VERSION } from '../version.js';

/** Descriptive User-Agent for every launcher request (Modrinth asks for one; Mojang and Fabric get it too). */
export const USER_AGENT = `MineVibe/${SERVER_VERSION} (+https://github.com/jasperaelvoet/MineVibe)`;

export type HashAlgorithm = 'sha1' | 'sha512';

export interface ExpectedHash {
  readonly algorithm: HashAlgorithm;
  /** Lowercase hex digest. */
  readonly value: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A downloaded or cached file failed its size or checksum check. */
export class IntegrityError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'IntegrityError';
    this.path = path;
  }
}

/**
 * `fetch` with the MineVibe User-Agent and a timeout on the response headers only (a long body is fine; the
 * downloader has its own stall timeout).
 */
export function launcherFetch(base: FetchLike = fetch, headerTimeoutMs = 30_000): FetchLike {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
    const headerTimeout = new AbortController();
    const timer = setTimeout(
      () => headerTimeout.abort(new Error(`no response from ${url} within ${headerTimeoutMs} ms`)),
      headerTimeoutMs,
    );
    const signal = init.signal ? AbortSignal.any([init.signal, headerTimeout.signal]) : headerTimeout.signal;
    try {
      return await base(url, { ...init, headers, signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** GET a JSON document; throws on a non-2xx status. */
export async function fetchJson<T = unknown>(
  url: string,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<T> {
  const doFetch = options.fetch ?? launcherFetch();
  const res = await doFetch(url, options.signal ? { signal: options.signal } : {});
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Hex digest of a file. */
export async function hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Size of a file, or null if it does not exist. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** True when `path` exists with the expected size and (if given) digest. */
export async function fileMatches(
  path: string,
  expected: { size?: number | undefined; hash?: ExpectedHash | undefined },
): Promise<boolean> {
  const size = await fileSize(path);
  if (size === null) return false;
  if (expected.size !== undefined && expected.size >= 0 && size !== expected.size) return false;
  if (
    expected.hash &&
    (await hashFile(path, expected.hash.algorithm)) !== expected.hash.value.toLowerCase()
  ) {
    return false;
  }
  return true;
}

export interface DownloadSpec {
  readonly url: string;
  readonly destination: string;
  /** Expected byte count; a response longer than this is cut off early. */
  readonly size?: number | undefined;
  readonly hash?: ExpectedHash | undefined;
  /** chmod 0755 after a successful download. */
  readonly executable?: boolean | undefined;
}

export interface DownloadOptions {
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  /** Attempts in total (network errors and integrity failures both retry). Default 3. */
  readonly attempts?: number;
  /** Abort a transfer when no bytes arrive for this long. Default 60 s. */
  readonly idleTimeoutMs?: number;
}

/**
 * Streams `spec.url` to `<destination>.part`, hashing and counting bytes on the way, then verifies size and
 * digest and renames it into place. A mismatch deletes the partial file and throws {@link IntegrityError}.
 * Returns the number of bytes written.
 */
export async function downloadVerified(spec: DownloadSpec, options: DownloadOptions = {}): Promise<number> {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await downloadOnce(spec, options);
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) throw err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function downloadOnce(spec: DownloadSpec, options: DownloadOptions): Promise<number> {
  const doFetch = options.fetch ?? launcherFetch();
  const part = `${spec.destination}.part`;
  await mkdir(dirname(spec.destination), { recursive: true });

  const idle = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
  const idleMs = options.idleTimeoutMs ?? 60_000;
  let timer = setTimeout(() => idle.abort(new Error(`download stalled: ${spec.url}`)), idleMs);
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error(`download stalled: ${spec.url}`)), idleMs);
  };

  try {
    const res = await doFetch(spec.url, { signal });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`GET ${spec.url} failed: HTTP ${res.status}`);
    }
    const hash = spec.hash ? createHash(spec.hash.algorithm) : null;
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        bump();
        bytes += chunk.length;
        if (spec.size !== undefined && spec.size >= 0 && bytes > spec.size) {
          callback(
            new IntegrityError(spec.destination, `${spec.url}: more than the expected ${spec.size} bytes`),
          );
          return;
        }
        hash?.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(part, { mode: 0o644 }),
      { signal },
    );
    if (spec.size !== undefined && spec.size >= 0 && bytes !== spec.size) {
      throw new IntegrityError(spec.destination, `${spec.url}: got ${bytes} bytes, expected ${spec.size}`);
    }
    if (hash && spec.hash) {
      const actual = hash.digest('hex');
      if (actual !== spec.hash.value.toLowerCase()) {
        throw new IntegrityError(
          spec.destination,
          `${spec.url}: ${spec.hash.algorithm} mismatch (got ${actual.slice(0, 16)}…, expected ${spec.hash.value.slice(0, 16)}…)`,
        );
      }
    }
    if (spec.executable) await chmod(part, 0o755);
    await rename(part, spec.destination);
    return bytes;
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; rejects with the first error after all settle. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown = null;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw firstError;
  return results;
}

/**
 * Makes every spec's destination match (size + digest): files that already match are skipped, the rest are
 * downloaded with {@link downloadVerified}. Returns how many files were fetched and their total size.
 */
export async function downloadAll(
  specs: readonly DownloadSpec[],
  options: DownloadOptions & { concurrency?: number } = {},
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  await mapLimit(specs, options.concurrency ?? 8, async (spec) => {
    if (await fileMatches(spec.destination, { size: spec.size, hash: spec.hash })) return;
    const n = await downloadVerified(spec, options);
    files++;
    bytes += n;
  });
  return { files, bytes };
}

/** Human-readable byte count (MiB with one decimal). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
