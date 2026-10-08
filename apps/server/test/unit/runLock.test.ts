import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlreadyRunningError,
  acquireRunLock,
  parseLockOwner,
  parseLstart,
  processStartTime,
  type RunLockDeps,
  sameStartTime,
  startTimeMs,
  YOUNG_LOCK_MS,
} from '../../src/orchestrator/runLock.js';

const dirs: string[] = [];
function lockPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-lock-'));
  dirs.push(d);
  mkdirSync(join(d, 'run'), { recursive: true });
  return join(d, 'run', 'lock');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Makes the lock look written long ago (it is no longer young). */
function age(path: string, ms = 30 * 24 * 3600 * 1000): void {
  const past = new Date(Date.now() - ms);
  utimesSync(path, past, past);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
/** `ps -o lstart=` text in this process's local time zone, as versions before the UTC change recorded it. */
function localLstart(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

describe('run lock', () => {
  it('is exclusive while the owner lives and taken over when stale', async () => {
    const path = lockPath();
    const lock = await acquireRunLock(path, process.pid);
    const owner = parseLockOwner(readFileSync(path, 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, started: await processStartTime(process.pid) });
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
    await lock.release();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '999999\n'); // a pid that does not exist
    const taken = await acquireRunLock(path, process.pid);
    await taken.release();
  });

  it('takes over a lock whose pid now belongs to a newer process (pid reuse after a reboot)', async () => {
    const path = lockPath();
    // This test process is alive, but it is not the process that wrote the lock: different start time.
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, started: '2024-01-01T00:00:00.000Z', nonce: 'x' })}\n`,
    );
    age(path);
    const lock = await acquireRunLock(path, process.pid + 1);
    expect(parseLockOwner(readFileSync(path, 'utf8'))?.pid).toBe(process.pid + 1);
    await lock.release();
  });

  it('handles old pid-only locks by comparing the start time with the lock file', async () => {
    const path = lockPath();
    writeFileSync(path, `${process.pid}\n`);
    // Written now, by a process that started earlier: that owner is plausible.
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
    // Written long before this process started: the pid was reused, the lock is stale.
    age(path);
    const lock = await acquireRunLock(path, process.pid + 1);
    await lock.release();
  });

  it('keeps a live pid as the owner when its start time cannot be read', async () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify({ pid: 4242, started: 'then', nonce: 'x' })}\n`);
    age(path);
    const deps = { pidExists: () => true, startTime: async () => null };
    await expect(acquireRunLock(path, 1, deps)).rejects.toMatchObject({ pid: 4242 });
  });

  it('lets exactly one of several racing starters take over a stale lock', async () => {
    const deps = {
      pidExists: (pid: number) => pid >= 1000,
      startTime: async (pid: number) => `start-${pid}`,
    };
    for (let round = 0; round < 25; round++) {
      const path = lockPath();
      writeFileSync(path, `${JSON.stringify({ pid: 7, started: 'start-7', nonce: 'dead' })}\n`); // owner gone
      const results = await Promise.allSettled(
        [1001, 1002, 1003, 1004].map((pid) => acquireRunLock(path, pid, deps)),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(AlreadyRunningError);
      }
      const holder = parseLockOwner(readFileSync(path, 'utf8'));
      expect(holder?.pid).toBeGreaterThanOrEqual(1001);
      expect(readdirSync(join(path, '..')).filter((f) => f !== 'lock')).toEqual([]);
    }
  });

  it('never releases a lock that someone else holds now', async () => {
    const path = lockPath();
    const lock = await acquireRunLock(path, process.pid);
    writeFileSync(path, `${JSON.stringify({ pid: 5, started: 'x', nonce: 'theirs' })}\n`);
    await lock.release();
    expect(parseLockOwner(readFileSync(path, 'utf8'))?.nonce).toBe('theirs');
  });
});

describe('run lock: the empty-file window (DEBT N2)', () => {
  it('never shows a reader an empty or partial lock', async () => {
    const path = lockPath();
    const deps: RunLockDeps = { pidExists: () => true, startTime: async (pid) => `start-${pid}` };
    const bad: string[] = [];
    let done = false;
    const reader = (async () => {
      while (!done) {
        const raw = await readFile(path, 'utf8').catch(() => null);
        if (raw !== null && parseLockOwner(raw) === null) bad.push(raw);
      }
    })();
    for (let i = 0; i < 150; i++) {
      const lock = await acquireRunLock(path, 2000 + i, deps);
      await lock.release();
    }
    done = true;
    await reader;
    expect(bad).toEqual([]);
  });

  it('waits on an empty lock while it is young: its writer fills it in, and it refuses', async () => {
    const path = lockPath();
    writeFileSync(path, ''); // created, not yet written (an older version, or no hard links)
    const deps: RunLockDeps = { pidExists: (pid) => pid === 4321, startTime: async (pid) => `start-${pid}` };
    const starting = acquireRunLock(path, 1, deps);
    starting.catch(() => {}); // asserted below
    await sleep(100);
    writeFileSync(path, `${JSON.stringify({ pid: 4321, started: 'start-4321', nonce: 'n' })}\n`);
    await expect(starting).rejects.toMatchObject({ pid: 4321 });
  });

  it('takes over an empty lock once it is old (its writer died before filling it in)', async () => {
    const path = lockPath();
    writeFileSync(path, '');
    const deps: RunLockDeps = { pidExists: () => true, startTime: async (pid) => `start-${pid}` };
    let settled = false;
    const starting = acquireRunLock(path, 77, deps).finally(() => {
      settled = true;
    });
    await sleep(100);
    expect(settled, 'still waiting while the empty lock is young').toBe(false);
    age(path, YOUNG_LOCK_MS + 1000);
    const lock = await starting;
    expect(parseLockOwner(readFileSync(path, 'utf8'))?.pid).toBe(77);
    await lock.release();
  });

  it('treats a young lock whose pid exists as live, even when its start time reads differently', async () => {
    const path = lockPath();
    writeFileSync(path, `${JSON.stringify({ pid: 4242, started: 'some other clock', nonce: 'x' })}\n`);
    const deps: RunLockDeps = { pidExists: () => true, startTime: async () => 'Thu Oct 8 19:08:12 2026' };
    await expect(acquireRunLock(path, 1, deps)).rejects.toMatchObject({ pid: 4242 });
    age(path); // later on, the start time decides: a different process now
    const lock = await acquireRunLock(path, 1, deps);
    await lock.release();
  });

  it('removes temp files left by a starter that died mid-acquire, and only old ones', async () => {
    const path = lockPath();
    const stale = `${path}.deadbeefdeadbeef.tmp`;
    const fresh = `${path}.0123456789abcdef.tmp`;
    writeFileSync(stale, 'x');
    age(stale, 5 * 60_000);
    writeFileSync(fresh, 'y');
    const lock = await acquireRunLock(path, process.pid);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await lock.release();
  });
});

describe('run lock: start times do not depend on the time zone (DEBT N2)', () => {
  it('records the start time as a UTC instant, whatever TZ the asking process has', async () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = await processStartTime(process.pid);
      process.env.TZ = 'America/Los_Angeles';
      const la = await processStartTime(process.pid);
      expect(tokyo).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(la).toBe(tokyo);
      // It is this process's start, to the second.
      const startedMs = startTimeMs(tokyo as string) as number;
      expect(Math.abs(Date.now() - process.uptime() * 1000 - startedMs)).toBeLessThan(3000);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('parses lstart text in UTC or local time', () => {
    expect(parseLstart('Thu Oct  8 17:08:12 2026', 'utc')).toBe(Date.UTC(2026, 9, 8, 17, 8, 12));
    expect(parseLstart('Thu Oct 8 17:08:12 2026', 'local')).toBe(new Date(2026, 9, 8, 17, 8, 12).getTime());
    expect(parseLstart('start-7', 'utc')).toBeNull();
    expect(parseLstart('Thu Foo 8 17:08:12 2026', 'utc')).toBeNull();
  });

  it('matches a lock from an older version (local lstart text) against the UTC instant', () => {
    const ms = Date.UTC(2026, 9, 8, 17, 8, 12);
    const iso = new Date(ms).toISOString();
    expect(sameStartTime(localLstart(ms), iso)).toBe(true);
    expect(sameStartTime(localLstart(ms + 1000), iso)).toBe(false);
    expect(sameStartTime(iso, iso)).toBe(true);
    expect(sameStartTime('start-1', 'start-1')).toBe(true);
    expect(sameStartTime('start-1', 'start-2')).toBe(false);
  });

  it('keeps the owner of an older-format lock that is still running', async () => {
    const path = lockPath();
    const started = startTimeMs((await processStartTime(process.pid)) as string) as number;
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, started: localLstart(started), nonce: 'old' })}\n`,
    );
    age(path);
    await expect(acquireRunLock(path, process.pid + 1)).rejects.toBeInstanceOf(AlreadyRunningError);
  });
});
