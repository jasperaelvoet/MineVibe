import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Another MineVibe instance holds `run/lock`. */
export class AlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`MineVibe is already running (pid ${pid})`);
    this.name = 'AlreadyRunningError';
    this.pid = pid;
  }
}

/** What `run/lock` records about its owner. */
export interface LockOwner {
  readonly pid: number;
  /**
   * The owner's start time: an ISO-8601 UTC instant ({@link processStartTime}), or, in a lock written by an older
   * version, `ps -o lstart=` text in that version's local time zone. Null for a bare-pid lock.
   */
  readonly started: string | null;
  /** Random per acquisition, so release never removes a lock someone else took over. */
  readonly nonce: string | null;
}

export interface RunLock {
  release(): Promise<void>;
}

export interface RunLockDeps {
  /** Start time of a running process ({@link processStartTime}), or null when it is not running or cannot be read. */
  startTime(pid: number): Promise<string | null>;
  /** Whether a process with this pid exists (`kill(pid, 0)`; EPERM counts as existing). */
  pidExists(pid: number): boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^[A-Za-z]{3} +([A-Za-z]{3}) +(\d{1,2}) +(\d{1,2}):(\d{2}):(\d{2}) +(\d{4})$/;

/**
 * Parses `ps -o lstart=` output in the C locale (`Thu Oct  8 17:08:12 2026`) as a wall-clock time in `zone`.
 * Returns epoch milliseconds, or null when `text` is not in that format.
 */
export function parseLstart(text: string, zone: 'utc' | 'local'): number | null {
  const m = LSTART.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] as string);
  if (month < 0) return null;
  const [day, hour, minute, second, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms =
    zone === 'utc'
      ? Date.UTC(year, month, day, hour, minute, second)
      : new Date(year, month, day, hour, minute, second).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a process started, as an ISO-8601 UTC instant (`2026-10-08T17:08:12.000Z`). `ps -o lstart=` prints local
 * time, so it runs with `TZ=UTC` (and `LC_ALL=C`): the value never depends on the time zone of the process that
 * asks, which can differ between an app started by launchd and a terminal. Unexpected `ps` output is returned as
 * is (whitespace collapsed); it still compares exactly. Null when the process is not running or ps cannot tell.
 */
export function processStartTime(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 },
      (err, stdout) => {
        const raw = err ? '' : String(stdout).trim().replace(/\s+/g, ' ');
        if (raw === '') {
          resolvePromise(null);
          return;
        }
        const ms = parseLstart(raw, 'utc');
        resolvePromise(ms === null ? raw : new Date(ms).toISOString());
      },
    );
  });
}

/**
 * A recorded start time in epoch milliseconds: an ISO-8601 instant, or the bare `ps -o lstart=` text that versions
 * before the UTC change recorded (in their local time zone, which is the best reading there is). Null otherwise.
 */
export function startTimeMs(text: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }
  return parseLstart(text, 'local');
}

/** Whether two recorded start times name the same second. Text that is not a time compares exactly. */
export function sameStartTime(a: string, b: string): boolean {
  if (a === b) return true;
  const am = startTimeMs(a);
  const bm = startTimeMs(b);
  return am !== null && bm !== null && Math.floor(am / 1000) === Math.floor(bm / 1000);
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultDeps: RunLockDeps = { startTime: processStartTime, pidExists };

/** Parses `run/lock`: the current JSON form, or the bare pid older versions wrote. */
export function parseLockOwner(raw: string): LockOwner | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return pid > 0 ? { pid, started: null, nonce: null } : null;
  }
  try {
    const v = JSON.parse(text) as { pid?: unknown; started?: unknown; nonce?: unknown };
    if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    return {
      pid: v.pid,
      started: typeof v.started === 'string' ? v.started : null,
      nonce: typeof v.nonce === 'string' ? v.nonce : null,
    };
  } catch {
    return null;
  }
}

/**
 * A lock written less than this long ago is live: its writer is still starting up. That covers an empty or
 * half-written lock (from an older version, or a file system without hard links, which create the file and fill it
 * in afterwards), and is a safety net for a start time that reads differently than its writer recorded it. A pid
 * is not reused within seconds of being alive, so a young lock whose pid exists is never a stale one.
 */
export const YOUNG_LOCK_MS = 2000;

/** How long a starter keeps trying when the lock is young or being taken over by someone else. */
const ACQUIRE_TIMEOUT_MS = YOUNG_LOCK_MS + 3000;

/** A takeover guard older than this was left by a starter that died inside it. */
const GUARD_STALE_MS = 10_000;

/** A `run/lock.<nonce>.tmp` older than this was left by a starter that died between writing and linking it. */
const TEMP_STALE_MS = 60_000;

/** File times and `Date.now()` come from different clocks: a file written just now can look a little in the future. */
const MTIME_SLACK_MS = 1000;

/**
 * The lock is young: written (by its mtime) within {@link YOUNG_LOCK_MS}. An mtime further in the future than the
 * clocks' slack (the clock went back since) is not young: such a lock is judged by its owner alone.
 */
function isYoung(mtimeMs: number, now = Date.now()): boolean {
  const age = now - mtimeMs;
  return age > -MTIME_SLACK_MS && age < YOUNG_LOCK_MS;
}

/**
 * Whether the lock's owner is still running. A pid alone is not enough: after a reboot (or simply later) the pid
 * can belong to an unrelated process, and `kill(pid, 0)` then says "alive" (or EPERM) forever. So the owner's start
 * time is compared too: recorded in the lock, or for an old-style lock, the process must have started before the
 * lock file was written. When the start time cannot be read, a live pid counts as the owner (the safe side), and so
 * does a live pid in a young lock.
 */
async function ownerAlive(owner: LockOwner, lockMtimeMs: number, deps: RunLockDeps): Promise<boolean> {
  if (!deps.pidExists(owner.pid)) return false;
  if (isYoung(lockMtimeMs)) return true;
  const started = await deps.startTime(owner.pid);
  if (started === null) return true;
  if (owner.started !== null) return sameStartTime(owner.started, started);
  const startedMs = startTimeMs(started);
  if (startedMs === null) return true;
  // `lstart` has one-second resolution.
  return startedMs <= lockMtimeMs + 1000;
}

/**
 * Creates the lock with its full content, atomically: the content goes into a private temp file that is then
 * hard-linked to `path` (`link` fails with EEXIST when a lock exists). Other starters therefore never see an empty
 * or half-written lock. Returns false when a lock exists. File systems without hard links fall back to an exclusive
 * create plus write, whose short empty window the young-lock rule covers.
 */
async function createLock(path: string, body: string, nonce: string): Promise<boolean> {
  const tmp = `${path}.${nonce}.tmp`;
  await writeFile(tmp, body, { mode: 0o600, flag: 'w' });
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err;
  } finally {
    await rm(tmp, { force: true });
  }
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** The lock's content and mtime, or null when there is no lock. */
async function readLock(path: string): Promise<{ raw: string; mtimeMs: number } | null> {
  try {
    const [raw, s] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { raw, mtimeMs: s.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Removes temp files that starters which died mid-acquire left next to the lock (best effort). */
async function sweepTemps(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const file = join(dir, name);
      const s = await stat(file).catch(() => null);
      if (s?.isFile() && Date.now() - s.mtimeMs > TEMP_STALE_MS) await rm(file, { force: true });
    }
  } catch {
    // best effort
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single-instance lock (PLAN §9.2): `run/lock` holds `{pid, started, nonce}`, created atomically with its content
 * (a temp file linked into place). A lock whose owner is gone (dead pid, or a pid that now belongs to a process
 * started later) is stale and taken over, verified: only the holder of a short takeover guard (`run/lock.takeover`,
 * an atomic `mkdir`) may remove a lock, and only after re-reading it and finding exactly the content it judged
 * stale. Creating never removes anything, so two starters can never both end up holding the lock, and a live lock
 * is never deleted. A young lock ({@link YOUNG_LOCK_MS}) counts as live: an unreadable one is waited on until its
 * writer fills it in (or it turns old), a readable one whose pid exists refuses.
 */
export async function acquireRunLock(
  path: string,
  pid: number = process.pid,
  deps: RunLockDeps = defaultDeps,
): Promise<RunLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(8).toString('hex');
  const body = `${JSON.stringify({ pid, started: await deps.startTime(pid), nonce })}\n`;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (let attempt = 0; attempt < 10 || Date.now() < deadline; attempt++) {
    if (await createLock(path, body, nonce)) {
      await sweepTemps(path);
      return {
        async release() {
          try {
            if (parseLockOwner(await readFile(path, 'utf8'))?.nonce === nonce)
              await rm(path, { force: true });
          } catch {
            // already gone
          }
        },
      };
    }

    const seen = await readLock(path);
    if (seen === null) continue; // released in between: try again
    const owner = parseLockOwner(seen.raw);
    if (owner === null && isYoung(seen.mtimeMs)) {
      // Being written right now (a starter that fills the file in after creating it): wait for its content.
      await sleep(10 + Math.floor(Math.random() * 20));
      continue;
    }
    if (owner !== null && owner.pid !== pid && (await ownerAlive(owner, seen.mtimeMs, deps))) {
      throw new AlreadyRunningError(owner.pid);
    }
    // Stale (or unreadable and old): remove it under the guard, if it is still the very lock judged stale.
    const took = await underTakeoverGuard(`${path}.takeover`, async () => {
      const again = await readFile(path, 'utf8').catch(() => null);
      if (again === seen.raw) await rm(path, { force: true });
    });
    if (!took) await sleep(10 + Math.floor(Math.random() * 20));
  }
  throw new Error(`could not take ${path}`);
}

/** Runs `fn` while holding the guard directory; returns false (without running it) when someone else holds it. */
async function underTakeoverGuard(guard: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const age = await stat(guard).then(
      (s) => Date.now() - s.mtimeMs,
      () => 0,
    );
    if (age > GUARD_STALE_MS) await rm(guard, { recursive: true, force: true });
    return false;
  }
  try {
    await fn();
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
  return true;
}
