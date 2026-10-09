import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GuestViewSync } from '../../src/pcs/GuestViewSync.js';

/** A watch the test fires by hand: `fire(folder, path?)` reports a change of `path` (default: the folder). */
function fakeWatch() {
  const watchers = new Map<string, ((p: string | null) => void)[]>();
  const closed: string[] = [];
  return {
    watch: (path: string, onChange: (p: string | null) => void) => {
      watchers.set(path, [...(watchers.get(path) ?? []), onChange]);
      return { close: () => closed.push(path) };
    },
    fire: (folder: string, path: string | null = folder) => {
      for (const f of watchers.get(folder) ?? []) f(path);
    },
    closed,
  };
}

describe('GuestViewSync', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('refreshes before the next call after any change; only the files a write names are its own', async () => {
    const w = fakeWatch();
    const refreshed: string[] = [];
    let now = 1_000;
    const s = new GuestViewSync({
      refresh: async (id) => void refreshed.push(id),
      watch: w.watch,
      now: () => now,
    });
    s.track('mac-1', ['/v/a', '/v/b']);
    (await s.enter('mac-1'))();
    expect(refreshed).toEqual([]);
    w.fire('/v/b', '/v/b/x.txt');
    expect(s.isDirty('mac-1')).toBe(true);
    // A write of /v/a/src/app.ts: its own events (and its new folder's) are not host edits, while it runs and a moment
    // after.
    const done = await s.enter('mac-1', ['/v/a/src/app.ts']);
    expect(refreshed).toEqual(['mac-1']);
    w.fire('/v/a', '/v/a/src/app.ts');
    w.fire('/v/a', '/v/a/src');
    done();
    now += 2_000;
    w.fire('/v/a', '/v/a/src/app.ts');
    expect(s.isDirty('mac-1')).toBe(false);
    // Another file changed during the write: a host edit.
    const d2 = await s.enter('mac-1', ['/v/a/src/app.ts']);
    w.fire('/v/a', '/v/a/src/other.ts');
    d2();
    expect(s.isDirty('mac-1')).toBe(true);
    (await s.enter('mac-1'))();
    expect(refreshed).toEqual(['mac-1', 'mac-1']);
    // After the grace period the same file is a host edit again; so is a change during a shell call (no names).
    now += 10_000;
    w.fire('/v/a', '/v/a/src/app.ts');
    expect(s.isDirty('mac-1')).toBe(true);
    const sh = await s.enter('mac-1');
    expect(refreshed).toHaveLength(3);
    w.fire('/v/b', '/v/b/build/out.js');
    sh();
    expect(s.isDirty('mac-1')).toBe(true);
    // A watcher that does not say what changed: dirty.
    (await s.enter('mac-1'))();
    w.fire('/v/a', null);
    expect(s.isDirty('mac-1')).toBe(true);
    // Untracked PCs (Linux, stopped) never refresh.
    (await s.enter('linux-1'))();
    s.untrack('mac-1');
    expect(w.closed.sort()).toEqual(['/v/a', '/v/b']);
    expect(s.isTracked('mac-1')).toBe(false);
    expect(s.isDirty('mac-1')).toBe(false);
  });

  it('concurrent calls share one refresh; a failed refresh stays dirty', async () => {
    const w = fakeWatch();
    let n = 0;
    let fail = true;
    const s = new GuestViewSync({
      refresh: async () => {
        n++;
        await new Promise((r) => setTimeout(r, 20));
        if (fail) throw new Error('spacesd down');
      },
      watch: w.watch,
    });
    s.track('mac-1', ['/v']);
    w.fire('/v');
    const [a, b] = await Promise.all([s.enter('mac-1'), s.enter('mac-1')]);
    a();
    b();
    expect(n).toBe(1);
    expect(s.isDirty('mac-1')).toBe(true);
    fail = false;
    (await s.enter('mac-1'))();
    expect(n).toBe(2);
    expect(s.isDirty('mac-1')).toBe(false);
  });

  it('watches real folders recursively (FSEvents)', async () => {
    // A real path (Vault folders are stored resolved); an FSEvents stream only reports what happens after it runs, which
    // can take a moment on a busy host, so the write repeats until an event arrives.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-gvs-')));
    const s = new GuestViewSync({ refresh: async () => {} });
    s.track('mac-1', [dir]);
    for (let i = 0; i < 100 && !s.isDirty('mac-1'); i++) {
      if (i % 10 === 0) writeFileSync(join(dir, 'x.txt'), `x${i}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(s.isDirty('mac-1')).toBe(true);
    s.closeAll();
  });
});
