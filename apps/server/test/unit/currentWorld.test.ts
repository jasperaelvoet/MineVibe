import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CurrentWorldStore, worldIdForGen } from '../../src/world/currentWorld.js';

const tmpDirs: string[] = [];
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-world-'));
  tmpDirs.push(dir);
  return join(dir, 'state', 'current-world.json');
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const death = { cause: 'Jasper fell from a high place', day: 3, ticksAlive: 5000 };

describe('CurrentWorldStore', () => {
  it('creates World #1 on first load, privately', async () => {
    const path = storePath();
    const rec = await new CurrentWorldStore(path).load();
    expect(rec).toEqual({ v: 1, worldId: 'world-1', gen: 1, status: 'alive', created: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(worldIdForGen(7)).toBe('world-7');
  });

  it('persists created, death and the allocated next world durably', async () => {
    const path = storePath();
    const store = new CurrentWorldStore(path);
    await store.load();
    expect(await store.markCreated('world-1')).toBe(true);
    expect(await store.markCreated('world-1')).toBe(false);
    const dead = await store.markDead('world-1', death, new Date('2026-10-08T12:00:00Z'));
    expect(dead).toMatchObject({ status: 'dead', next: { worldId: 'world-2', gen: 2 } });
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.death).toEqual({ ...death, at: '2026-10-08T12:00:00.000Z' });

    const reloaded = new CurrentWorldStore(path);
    expect((await reloaded.load()).status).toBe('dead');
  });

  it('markDead is idempotent and ignores other worlds', async () => {
    const store = new CurrentWorldStore(storePath());
    await store.load();
    const a = await store.markDead('world-1', death);
    const b = await store.markDead('world-1', { ...death, cause: 'again' });
    expect(b).toEqual(a);
    expect(await store.markDead('world-9', death)).toBeNull();
  });

  it('advanceFrom moves to the next world once', async () => {
    const store = new CurrentWorldStore(storePath());
    await store.load();
    expect(await store.advanceFrom('world-1')).toBeNull(); // still alive
    await store.markDead('world-1', death);
    const next = await store.advanceFrom('world-1');
    expect(next).toEqual({ v: 1, worldId: 'world-2', gen: 2, status: 'alive', created: false });
    expect(await store.advanceFrom('world-1')).toBeNull();
  });

  it('serialises concurrent operations', async () => {
    const store = new CurrentWorldStore(storePath());
    await store.load();
    const [created, dead] = await Promise.all([
      store.markCreated('world-1'),
      store.markDead('world-1', death),
    ]);
    expect(created).toBe(true);
    expect(dead).toMatchObject({ created: true, status: 'dead' });
  });

  it('throws before load', () => {
    expect(() => new CurrentWorldStore(storePath()).current).toThrow(/load/);
  });
});
