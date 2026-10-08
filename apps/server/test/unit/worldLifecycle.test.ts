import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeServer } from '../../src/bridge/BridgeServer.js';
import { silentLogger } from '../../src/log.js';
import { type CurrentWorldRecord, CurrentWorldStore } from '../../src/world/currentWorld.js';
import { buryWorldSave } from '../../src/world/graveyard.js';
import { WorldLifecycle, type WorldLifecycleOptions } from '../../src/world/WorldLifecycle.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mv-lifecycle-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Handler = (msg: Record<string, unknown>) => unknown;

/** Just enough of BridgeServer for WorldLifecycle: handlers can be invoked, sends are recorded. */
function fakeBridge() {
  const handlers = new Map<string, Handler>();
  const sent: Array<{ t: string; payload: Record<string, unknown> }> = [];
  const bridge = {
    on: (t: string, fn: Handler) => {
      handlers.set(t, fn);
      return () => handlers.delete(t);
    },
    handle: (t: string, fn: Handler) => {
      handlers.set(t, fn);
      return () => handlers.delete(t);
    },
    send: (t: string, payload: Record<string, unknown>) => {
      sent.push({ t, payload });
      return true;
    },
  };
  const call = (t: string, payload: Record<string, unknown>) =>
    Promise.resolve((handlers.get(t) as Handler)({ t, v: 1, ...payload }));
  return { bridge: bridge as unknown as BridgeServer, call, sent };
}

const death = { cause: 'fell', day: 2, ticksAlive: 100 };

/** A store whose world-1 died (world-2 allocated). */
async function deadStore(path: string): Promise<CurrentWorldStore> {
  const store = new CurrentWorldStore(path);
  await store.load();
  await store.markCreated('world-1');
  await store.markDead('world-1', death);
  return store;
}

function lifecycle(store: CurrentWorldStore, onWorldEnded?: WorldLifecycleOptions['onWorldEnded']) {
  const fake = fakeBridge();
  const lc = new WorldLifecycle({
    bridge: fake.bridge,
    store,
    logger: silentLogger(),
    serverVersion: 'test',
    playerName: 'Jasper',
    ...(onWorldEnded ? { onWorldEnded } : {}),
  });
  return { lc, ...fake };
}

const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as CurrentWorldRecord;

describe('WorldLifecycle: durable world endings (DEBT N3)', () => {
  it('saves the advance with the dead world listed as unburied, and clears it once the hook is done', async () => {
    const path = join(tmp(), 'state', 'current-world.json');
    const store = await deadStore(path);
    const seenDuringHook: CurrentWorldRecord[] = [];
    const ended: string[] = [];
    const { lc, call } = lifecycle(store, (dead, next) => {
      seenDuringHook.push(onDisk(path));
      ended.push(`${dead.worldId}->${next.worldId}`);
    });
    await lc.whenRecovered();

    expect(await call('world.state', { worldId: 'world-1', phase: 'closed' })).toEqual({});
    expect(ended).toEqual(['world-1->world-2']);
    // While the hook ran, the move was already durable and the dead world was listed.
    expect(seenDuringHook[0]).toMatchObject({
      worldId: 'world-2',
      status: 'alive',
      unburied: [{ worldId: 'world-1', status: 'dead', next: { worldId: 'world-2' } }],
    });
    expect(onDisk(path)).toEqual({ v: 1, worldId: 'world-2', gen: 2, status: 'alive', created: false });
    expect(store.unburied).toEqual([]);
  });

  it('runs the hook again at the next start when the last run stopped before it finished', async () => {
    const root = tmp();
    const path = join(root, 'state', 'current-world.json');
    const saves = join(root, 'saves');
    mkdirSync(join(saves, 'world-1'), { recursive: true });
    writeFileSync(join(saves, 'world-1', 'level.dat'), 'x');
    // The last run saved the advance, then died before it buried world-1's save.
    const crashed = await deadStore(path);
    await crashed.advanceFrom('world-1');
    expect(onDisk(path).unburied?.map((w) => w.worldId)).toEqual(['world-1']);

    const store = new CurrentWorldStore(path);
    await store.load();
    const calls: Array<[string, string]> = [];
    const { lc } = lifecycle(store, async (dead, next) => {
      calls.push([dead.worldId, next.worldId]);
      await buryWorldSave(saves, dead.worldId);
    });
    await lc.whenRecovered();
    expect(calls).toEqual([['world-1', 'world-2']]);
    expect(existsSync(join(saves, 'world-1'))).toBe(false);
    expect(readFileSync(join(saves, '_graveyard', 'world-1', 'level.dat'), 'utf8')).toBe('x');
    expect(onDisk(path).unburied).toBeUndefined();

    // Nothing is left to retry after that.
    const again = new CurrentWorldStore(path);
    await again.load();
    const later: string[] = [];
    await lifecycle(again, (dead) => {
      later.push(dead.worldId);
    }).lc.whenRecovered();
    expect(later).toEqual([]);
  });

  it('keeps a world listed while its hook fails, and retries it on the next start', async () => {
    const path = join(tmp(), 'state', 'current-world.json');
    const store = await deadStore(path);
    const failing = lifecycle(store, () => {
      throw new Error('saves folder is busy');
    });
    await failing.call('world.state', { worldId: 'world-1', phase: 'closed' });
    expect(store.current).toMatchObject({ worldId: 'world-2', unburied: [{ worldId: 'world-1' }] });
    expect(onDisk(path).unburied?.map((w) => w.worldId)).toEqual(['world-1']);
    failing.lc.dispose();

    const next = new CurrentWorldStore(path);
    await next.load();
    const ended: string[] = [];
    await lifecycle(next, (dead) => {
      ended.push(dead.worldId);
    }).lc.whenRecovered();
    expect(ended).toEqual(['world-1']);
    expect(next.unburied).toEqual([]);
  });

  it('retries several unfinished endings oldest first, before a new ending', async () => {
    const path = join(tmp(), 'state', 'current-world.json');
    const crashed = await deadStore(path);
    await crashed.advanceFrom('world-1');
    await crashed.markDead('world-2', death);
    await crashed.advanceFrom('world-2');
    await crashed.markDead('world-3', death);
    expect(crashed.unburied.map((w) => w.worldId)).toEqual(['world-1', 'world-2']);

    const store = new CurrentWorldStore(path);
    await store.load();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { lc, call } = lifecycle(store, async (dead, next) => {
      order.push(`start ${dead.worldId}->${next.worldId}:${next.status}`);
      if (dead.worldId === 'world-1') await gate;
      order.push(`end ${dead.worldId}`);
    });
    // world-3 closes while the retry of world-1 is still running: its ending waits its turn.
    const closed = call('world.state', { worldId: 'world-3', phase: 'closed' });
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([lc.whenRecovered(), closed]);
    expect(order).toEqual([
      'start world-1->world-2:dead', // world-2 died too, Node moved past it
      'end world-1',
      'start world-2->world-3:dead', // world-3 was current (and dead) when this run started
      'end world-2',
      'start world-3->world-4:alive',
      'end world-3',
    ]);
    expect(store.current).toMatchObject({ worldId: 'world-4', status: 'alive' });
    expect(store.unburied).toEqual([]);
  });

  it('refuses an unloaded store at construction, instead of an unobserved rejection later', () => {
    const store = new CurrentWorldStore(join(tmp(), 'state', 'current-world.json'));
    expect(() => lifecycle(store)).toThrow(/load\(\) first/);
  });

  it('clears an ending at once when there is no hook', async () => {
    const path = join(tmp(), 'state', 'current-world.json');
    const store = await deadStore(path);
    const { call } = lifecycle(store);
    await call('world.state', { worldId: 'world-1', phase: 'closed' });
    expect(store.current).toEqual({ v: 1, worldId: 'world-2', gen: 2, status: 'alive', created: false });
  });
});
