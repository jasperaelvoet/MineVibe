import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CurrentWorldStore, UNBURIED_KEEP, worldIdForGen } from '../../src/world/currentWorld.js';

const tmpDirs: string[] = [];
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mv-world-'));
  tmpDirs.push(dir);
  return join(dir, 'state', 'current-world.json');
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const death = { cause: 'Jordan fell from a high place', day: 3, ticksAlive: 5000 };

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
    expect(next).toMatchObject({ v: 1, worldId: 'world-2', gen: 2, status: 'alive', created: false });
    expect(await store.advanceFrom('world-1')).toBeNull();
  });

  it('lists the dead world as unburied in the same write as the advance, until markBuried', async () => {
    const path = storePath();
    const store = new CurrentWorldStore(path);
    await store.load();
    await store.markDead('world-1', death, new Date('2026-10-08T12:00:00Z'));
    await store.advanceFrom('world-1');
    const deadRecord = {
      v: 1,
      worldId: 'world-1',
      gen: 1,
      status: 'dead',
      created: false,
      death: { ...death, at: '2026-10-08T12:00:00.000Z' },
      next: { worldId: 'world-2', gen: 2 },
    };
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      v: 1,
      worldId: 'world-2',
      gen: 2,
      status: 'alive',
      created: false,
      unburied: [deadRecord],
    });
    // It survives a restart, and travels along with later changes.
    const reloaded = new CurrentWorldStore(path);
    await reloaded.load();
    expect(reloaded.unburied).toEqual([deadRecord]);
    await reloaded.markCreated('world-2');
    await reloaded.markDead('world-2', death);
    await reloaded.advanceFrom('world-2');
    expect(reloaded.unburied.map((w) => w.worldId)).toEqual(['world-1', 'world-2']);

    expect(await reloaded.markBuried('world-1')).toBe(true);
    expect(await reloaded.markBuried('world-1')).toBe(false);
    expect(reloaded.unburied.map((w) => w.worldId)).toEqual(['world-2']);
    expect(await reloaded.markBuried('world-2')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      v: 1,
      worldId: 'world-3',
      gen: 3,
      status: 'alive',
      created: false,
    });
  });

  it('keeps at most UNBURIED_KEEP unfinished endings', async () => {
    const store = new CurrentWorldStore(storePath());
    await store.load();
    for (let gen = 1; gen <= UNBURIED_KEEP + 3; gen++) {
      await store.markDead(`world-${gen}`, death);
      await store.advanceFrom(`world-${gen}`);
    }
    expect(store.unburied).toHaveLength(UNBURIED_KEEP);
    expect(store.unburied[0]?.worldId).toBe('world-4');
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
