import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  /** The owner's start time as `ps -o lstart=` prints it; null for a lock written by an older version. */
  readonly started: string | null;
  /** Random per acquisition, so release never removes a lock someone else took over. */
  readonly nonce: string | null;
}

export interface RunLock {
  release(): Promise<void>;
}

export interface RunLockDeps {
  /** Start time of a running process (`ps -o lstart=`), or null when it is not running or cannot be read. */
  startTime(pid: number): Promise<string | null>;
  /** Whether a process with this pid exists (`kill(pid, 0)`; EPERM counts as existing). */
  pidExists(pid: number): boolean;
}

/** `ps -o lstart= -p <pid>` with whitespace collapsed, e.g. `Thu Oct 8 19:08:12 2026`. */
export function processStartTime(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000 },
      (err, stdout) => {
        const value = err ? '' : String(stdout).trim().replace(/\s+/g, ' ');
        resolvePromise(value === '' ? null : value);
      },
    );
  });
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
 * Whether the lock's owner is still running. A pid alone is not enough: after a reboot (or simply later) the pid
 * can belong to an unrelated process, and `kill(pid, 0)` then says "alive" (or EPERM) forever. So the owner's start
 * time is compared too: recorded in the lock, or for an old-style lock, the process must have started before the
 * lock file was written. When the start time cannot be read, a live pid counts as the owner (the safe side).
 */
async function ownerAlive(owner: LockOwner, path: string, deps: RunLockDeps): Promise<boolean> {
  if (!deps.pidExists(owner.pid)) return false;
  const started = await deps.startTime(owner.pid);
  if (started === null) return true;
  if (owner.started !== null) return started === owner.started;
  const startedMs = Date.parse(started);
  if (Number.isNaN(startedMs)) return true;
  const lockMtime = await stat(path).then(
    (s) => s.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );
  // `lstart` has one-second resolution.
  return startedMs <= lockMtime + 1000;
}

/** A takeover guard older than this was left by a starter that died inside it. */
const GUARD_STALE_MS = 10_000;

/**
 * Single-instance lock (PLAN §9.2): `run/lock` holds `{pid, started, nonce}`, created with O_EXCL. A lock whose owner
 * is gone (dead pid, or a pid that now belongs to a process started later) is stale and taken over, verified: only
 * the holder of a short takeover guard (`run/lock.takeover`, an atomic `mkdir`) may remove a lock, and only after
 * re-reading it and finding exactly the content it judged stale. Creating never removes anything, so two starters can
 * never both end up holding the lock, and a live lock is never deleted.
 */
export async function acquireRunLock(
  path: string,
  pid: number = process.pid,
  deps: RunLockDeps = defaultDeps,
): Promise<RunLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(8).toString('hex');
  const body = `${JSON.stringify({ pid, started: await deps.startTime(pid), nonce })}\n`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) continue; // released in between: try again
    const owner = parseLockOwner(raw);
    if (owner !== null && owner.pid !== pid && (await ownerAlive(owner, path, deps))) {
      throw new AlreadyRunningError(owner.pid);
    }
    // Stale (or unreadable): remove it under the guard, if it is still the very lock judged stale.
    const took = await underTakeoverGuard(`${path}.takeover`, async () => {
      const again = await readFile(path, 'utf8').catch(() => null);
      if (again === raw) await rm(path, { force: true });
    });
    if (!took) await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
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
