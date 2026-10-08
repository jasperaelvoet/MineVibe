/**
 * Regression tests for the second review round: monitor races (N1, N2), atomic admission (N3), stray
 * containers at boot (N7), legacy containers (M1/N4) and visible port-conflict recreates. The first two
 * started as the verifier's reproductions. The third round adds the builder VM in admission, unplugging
 * during bootAll and the bounded engine release on shutdown (N5).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import type { PcContainerInfo } from '../../src/pcs/drivers/PcDriver.js';
import { PcManager, type PcManagerOptions } from '../../src/pcs/PcManager.js';
import { type FakeContainer, FakeDriver, type FakeHealth, fakePool, serving } from './fakes.js';

const INST = 'unit';
const cname = (id: string) => `mv-pc-${INST}-${id}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tiny = { homeGiB: 1, overlayGiB: 1, tmpGiB: 1, varTmpGiB: 1, rootfsGiB: 1 };

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-races-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB }; // RAM pool 24.5 GiB
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mk(
  health: FakeHealth = { json: serving },
  driver = new FakeDriver(),
  opts: { portProbe?: { attempts?: number; intervalMs?: number }; extra?: Partial<PcManagerOptions> } = {},
) {
  const m = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches'), [], health, { healthTimeoutMs: 2000 }),
    labelValue: 'pc-test',
    instanceId: INST,
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
    portProbe: opts.portProbe ?? { attempts: 2, intervalMs: 10 },
    ...opts.extra,
  });
  return { m, driver };
}

describe('N1: the monitor never acts on a list older than a concurrent start', () => {
  it('a PC started while a pass runs is neither marked crashed nor stopped as a stray (repro)', async () => {
    const health: FakeHealth = { json: serving, slowUrl: null, slowMs: 400 };
    const { m, driver } = mk(health);
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    await m.create({ type: 'linux', id: 'b', boot: true, disk: tiny });
    await m.stop('b');
    // a's health is slow, so the pass is still running when b finishes starting.
    health.slowUrl = `http://127.0.0.1:${m.get('a')?.hostPort}`;
    const mon = m.monitorOnce();
    await sleep(30);
    await m.start('b');
    expect(m.status('b').status).toBe('running');
    expect(driver.containers.get(cname('b'))?.state).toBe('running');
    await mon;
    expect(m.status('b')).toEqual({ status: 'running' });
    health.slowUrl = null;
    await m.monitorOnce();
    expect(m.status('b')).toEqual({ status: 'running' });
    expect(driver.containers.get(cname('b'))?.state).toBe('running');
    // The only stop of b is the explicit one.
    expect(driver.log.filter((l) => l === `stop ${cname('b')}`)).toHaveLength(1);
  });

  it('a "crash" in a stale list is checked by a fresh inspect under the lock', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    // The list says stopped (stale), the container actually runs.
    const realList = driver.list.bind(driver);
    driver.list = async (labels) =>
      (await realList(labels)).map((c): PcContainerInfo => ({ ...c, state: 'stopped' }));
    await m.monitorOnce();
    expect(m.status('a')).toEqual({ status: 'running' });
    // A real crash is still caught.
    (driver.containers.get(cname('a')) as FakeContainer).state = 'stopped';
    await m.monitorOnce();
    expect(m.status('a')).toMatchObject({ status: 'error', reason: 'crashed' });
  });

  it('a "stray" in a stale list is only stopped when a fresh inspect still shows it running', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    await m.stop('a');
    const realList = driver.list.bind(driver);
    driver.list = async (labels) =>
      (await realList(labels)).map((c): PcContainerInfo => ({ ...c, state: 'running' }));
    driver.log.length = 0;
    await m.monitorOnce();
    expect(driver.log.filter((l) => l.startsWith('stop'))).toEqual([]);
  });
});

describe('N3: admission is one critical section with reservations', () => {
  const big = { type: 'linux' as const, memMiB: 10 * 1024, shmMiB: 1024, disk: tiny };

  it('concurrent starts are never admitted past the RAM pool (repro)', async () => {
    const { m } = mk();
    await m.init({ createDefault: false });
    for (const id of ['a', 'b', 'c']) await m.create({ ...big, id });
    const r = await Promise.allSettled(['a', 'b', 'c'].map((id) => m.start(id)));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    const refused = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    expect(['a', 'b', 'c'].map((id) => m.status(id).status).sort()).toEqual([
      'no_capacity',
      'running',
      'running',
    ]);
    const b = await m.budget();
    expect(b.allocated.memBytes).toBeLessThanOrEqual(b.pool.memBytes);
    // Sequential control: the same answer.
    const seq = mk(undefined, new FakeDriver());
    rmSync(join(dir, 'state'), { recursive: true, force: true });
    await seq.m.init({ createDefault: false });
    for (const id of ['a', 'b', 'c']) await seq.m.create({ ...big, id });
    const out: string[] = [];
    for (const id of ['a', 'b', 'c']) {
      out.push(
        await seq.m.start(id).then(
          () => 'ok',
          (e: { code?: string }) => e.code ?? 'error',
        ),
      );
    }
    expect(out).toEqual(['ok', 'ok', 'OVER_BUDGET']);
  });

  it('a PC that is still downloading its image holds its share', async () => {
    const driver = new FakeDriver();
    const { m } = mk(undefined, driver);
    await m.init({ createDefault: false });
    for (const id of ['a', 'b', 'c']) await m.create({ ...big, id });
    driver.imagePresent = false;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    driver.onBuild = () => gate;
    const a = m.start('a');
    while (m.status('a').status !== 'downloading') await sleep(5);
    // a only downloads, yet it holds its 10 GiB: one of b and c no longer fits.
    const later = Promise.allSettled([m.start('b'), m.start('c')]);
    while (![m.status('b').status, m.status('c').status].includes('no_capacity')) await sleep(5);
    expect((await m.budget()).allocated.memBytes).toBeLessThanOrEqual(24.5 * GiB);
    open();
    await a;
    expect((await later).map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(['a', 'b', 'c'].map((id) => m.status(id).status).sort()).toEqual([
      'no_capacity',
      'running',
      'running',
    ]);
  });

  it('a failed start releases its reservation', async () => {
    const driver = new FakeDriver();
    const { m } = mk(undefined, driver);
    await m.init({ createDefault: false });
    for (const id of ['a', 'b', 'c']) await m.create({ ...big, id });
    await m.start('a');
    await m.stop('a');
    driver.startErrors.push('kernel panic in vminitd');
    await expect(m.start('a')).rejects.toThrow(/kernel panic/);
    expect(m.status('a')).toMatchObject({ status: 'error', reason: 'boot_failed' });
    await Promise.all([m.start('b'), m.start('c')]);
    expect([m.status('b').status, m.status('c').status]).toEqual(['running', 'running']);
  });

  it('create+boot, start and resize are admitted against each other', async () => {
    const { m } = mk();
    await m.init({ createDefault: false });
    await m.create({ ...big, id: 'a' });
    await m.create({ type: 'linux', id: 'small', memMiB: 2048, shmMiB: 512, disk: tiny, boot: true });
    const r = await Promise.allSettled([
      m.create({ ...big, id: 'x', boot: true }),
      m.start('a'),
      m.resize('small', { memMiB: 10 * 1024 }),
    ]);
    // 24.5 GiB pool: at most two of the three 10 GiB activations fit next to each other.
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeLessThanOrEqual(2);
    const b = await m.budget();
    expect(b.allocated.memBytes).toBeLessThanOrEqual(b.pool.memBytes);
  });
});

describe('N7: bootAll reconciles containers that still run for an inactive PC', () => {
  async function leftRunning(mutate?: (c: FakeContainer) => void) {
    const driver = new FakeDriver();
    const first = mk(undefined, driver);
    await first.m.init({ createDefault: false });
    await first.m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    const c = driver.containers.get(cname('a')) as FakeContainer;
    mutate?.(c);
    // A new manager over the same state and engine that has not reconciled: `a` is `off`.
    const again = mk(undefined, driver);
    await again.m.init();
    driver.log.length = 0;
    return { m: again.m, driver };
  }

  it('adopts a matching one (no recreate) and the monitor leaves it alone', async () => {
    const { m, driver } = await leftRunning();
    expect(m.status('a').status).toBe('off');
    const r = await m.bootAll();
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    expect(driver.log).toEqual([]);
    await m.monitorOnce();
    expect(driver.containers.get(cname('a'))?.state).toBe('running');
    expect(driver.log).toEqual([]);
  });

  it('stops a mismatched one and boots it fresh', async () => {
    const { m, driver } = await leftRunning((c) => {
      c.spec = { ...c.spec, cpus: 7 };
    });
    await m.bootAll();
    expect(driver.log).toEqual([
      `stop ${cname('a')}`,
      `stop ${cname('a')}`,
      `rm ${cname('a')}`,
      `create ${cname('a')}`,
      `start ${cname('a')}`,
    ]);
    expect(driver.containers.get(cname('a'))?.spec.cpus).toBe(2);
    expect(m.status('a')).toEqual({ status: 'running' });
  });

  it('stops the container of an unplugged PC', async () => {
    const { m, driver } = await leftRunning();
    await m.setPlugged('a', false);
    const r = await m.bootAll();
    expect(r.booted).toEqual([]);
    expect(driver.containers.get(cname('a'))?.state).toBe('stopped');
    expect(m.status('a').status).toBe('off');
    expect((await m.budget()).allocated.memBytes).toBe(0);
  });
});

describe('M1/N4: legacy containers from before instance scoping', () => {
  it('stops one that provably is ours (name, labels, token) and leaves every other one alone', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'linux-1', boot: true, disk: tiny });
    await m.create({ type: 'linux', id: 'linux-2', disk: tiny });
    const base = (driver.containers.get(cname('linux-1')) as FakeContainer).spec;
    const legacy = (id: string, token: string, state: 'running' | 'stopped' = 'running'): FakeContainer => {
      const labels = { minevibe: 'pc-test', 'minevibe.pc': id, 'minevibe.type': 'linux' };
      return {
        spec: { ...base, name: `mv-pc-${id}`, labels, secretEnv: { CUA_ENV_TOKEN: token } },
        state,
        labels,
      };
    };
    const ourToken = readFileSync(join(dir, 'state', 'pc-tokens', 'linux-1.token'), 'utf8').trim();
    driver.containers.set('mv-pc-linux-1', legacy('linux-1', ourToken));
    // Same id, but another instance's token: not provably ours.
    driver.containers.set('mv-pc-linux-2', legacy('linux-2', 'f'.repeat(48)));
    // No record at all.
    driver.containers.set('mv-pc-ghost', legacy('ghost', ourToken));
    const r = await m.reconcile();
    expect(r.legacy).toEqual({ stopped: ['mv-pc-linux-1'], left: ['mv-pc-linux-2', 'mv-pc-ghost'] });
    expect(driver.containers.get('mv-pc-linux-1')?.state).toBe('stopped');
    expect(driver.containers.get('mv-pc-linux-2')?.state).toBe('running');
    expect(driver.containers.get('mv-pc-ghost')?.state).toBe('running');
    // Never deleted.
    expect(driver.log.filter((l) => l.startsWith('rm'))).toEqual([]);
    // The scoped container of linux-1 was adopted as usual.
    expect(r.adopted).toEqual(['linux-1']);
  });
});

describe('port conflicts: visible recreate, no recreate on a brief false positive', () => {
  const occupy = (port: number) =>
    new Promise<Server>((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(srv));
    });
  const close = (srv: Server) => new Promise<void>((r) => srv.close(() => r()));

  it('a port held by another program recreates on a new port and says so on the status', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    await m.stop('a');
    const port = m.get('a')?.hostPort as number;
    const srv = await occupy(port);
    try {
      driver.log.length = 0;
      await m.start('a');
    } finally {
      await close(srv);
    }
    expect(driver.log).toEqual([
      `stop ${cname('a')}`,
      `rm ${cname('a')}`,
      `create ${cname('a')}`,
      `start ${cname('a')}`,
    ]);
    expect(m.get('a')?.hostPort).not.toBe(port);
    expect(m.status('a')).toEqual({
      status: 'running',
      reason: 'port_conflict',
      detail: expect.stringMatching(new RegExp(`port ${port} is in use.*recreated on a new port.*reset`)),
    });
    expect(m.views()[0]).toMatchObject({ status: 'running', reason: 'port_conflict' });
    expect(driver.volumes.has(`${cname('a')}-home`)).toBe(true);
    // The note goes with the next status change.
    await m.stop('a');
    expect(m.status('a')).toEqual({ status: 'off' });
  });

  it('a port the engine frees a moment after a stop is not a conflict: the container is reused', async () => {
    const { m, driver } = mk(undefined, new FakeDriver(), { portProbe: { attempts: 8, intervalMs: 40 } });
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    await m.stop('a');
    const port = m.get('a')?.hostPort as number;
    const srv = await occupy(port);
    setTimeout(() => void close(srv), 100);
    driver.log.length = 0;
    await m.start('a');
    expect(driver.log).toEqual([`start ${cname('a')}`]);
    expect(m.get('a')?.hostPort).toBe(port);
    expect(m.status('a')).toEqual({ status: 'running' });
  });
});

describe('builder VM: a start that may build its image is admitted with the builder reserved', () => {
  // 11.5 GiB + 256 MiB VM overhead each: two fit the 24.5 GiB pool, but not with the 2 GiB builder.
  const mid = { type: 'linux' as const, memMiB: 11 * 1024 + 512, shmMiB: 1024, disk: tiny };
  /** Worst `allocated + reserves` any budget snapshot showed while a build ran. */
  function watchBuilds(m: PcManager, driver: FakeDriver) {
    let worst = 0;
    driver.onBuild = async () => {
      const s = await m.budget();
      worst = Math.max(worst, s.allocated.memBytes + s.reserve.memBytes);
    };
    return () => worst;
  }

  it('a start whose image must be built is refused when PCs + builder exceed the pool (repro)', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ ...mid, id: 'a', boot: true });
    await m.create({ ...mid, id: 'b' });
    driver.imagePresent = false;
    const worst = watchBuilds(m, driver);
    await expect(m.start('b')).rejects.toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    expect(m.status('b').status).toBe('no_capacity');
    expect(driver.log).not.toContain('build');
    expect(worst()).toBeLessThanOrEqual(host.memBytes);
    // Once the image exists no builder runs, and the same start fits.
    driver.imagePresent = true;
    await m.start('b');
    expect(m.status('b').status).toBe('running');
  });

  it('the builder stays reserved from admission to the end of the start, against other starts', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    for (const id of ['a', 'b']) await m.create({ ...mid, id });
    driver.imagePresent = false;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const worst = watchBuilds(m, driver);
    const onBuild = driver.onBuild;
    driver.onBuild = async () => {
      await onBuild?.();
      await gate;
    };
    const a = m.start('a');
    while (m.status('a').status !== 'downloading') await sleep(5);
    expect((await m.budget()).reserve.memBytes).toBe(25.5 * GiB);
    await expect(m.start('b')).rejects.toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    open();
    await a;
    expect(worst()).toBeLessThanOrEqual(host.memBytes);
    expect((await m.budget()).reserve.memBytes).toBe(23.5 * GiB);
    await m.start('b');
    expect(['a', 'b'].map((id) => m.status(id).status)).toEqual(['running', 'running']);
  });

  it('bootAll plans with the builder reserved when a planned start may build, and lets it go after', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ ...mid, id: 'a', pinned: true });
    await m.create({ ...mid, id: 'b' });
    driver.imagePresent = false;
    const worst = watchBuilds(m, driver);
    const r = await m.bootAll();
    expect(r).toEqual({ booted: ['a'], refused: ['b'], failed: [] });
    expect(worst()).toBeLessThanOrEqual(host.memBytes);
    expect((await m.budget()).reserve.memBytes).toBe(23.5 * GiB);
    // With the image there, both fit.
    await m.stop('a');
    const again = await m.bootAll();
    expect(again.booted.sort()).toEqual(['a', 'b']);
  });

  it('create + boot of a PC whose image must be built counts the builder too', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ ...mid, id: 'a', boot: true });
    driver.imagePresent = false;
    await expect(m.create({ ...mid, id: 'b', boot: true })).rejects.toMatchObject({ code: 'OVER_BUDGET' });
    expect(m.get('b')).toBeUndefined();
  });
});

describe('unplugging during bootAll', () => {
  it('a PC unplugged after bootAll planned it is not started (repro)', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', disk: tiny, pinned: true });
    await m.create({ type: 'linux', id: 'b', disk: tiny });
    // Hold a's start so bootAll has b planned but not yet started.
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const realStart = driver.start.bind(driver);
    driver.start = async (name: string) => {
      if (name === cname('a')) await gate;
      return realStart(name);
    };
    const boot = m.bootAll();
    while (m.status('a').status !== 'booting') await sleep(1);
    await m.setPlugged('b', false);
    open();
    const r = await boot;
    expect(r).toEqual({ booted: ['a'], refused: [], failed: [] });
    expect(m.get('b')?.plugged).toBe(false);
    expect(driver.log).not.toContain(`start ${cname('b')}`);
    expect(driver.containers.get(cname('b'))?.state).not.toBe('running');
    expect(m.status('b')).toEqual({ status: 'off' });
    expect((await m.budget()).allocated.memBytes).toBe((4096 + 256) * 1024 * 1024);
  });

  it('a PC unplugged while its start is in flight is stopped once that start ends', async () => {
    const { m, driver } = mk();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'b', disk: tiny });
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const realStart = driver.start.bind(driver);
    driver.start = async (name: string) => {
      await gate;
      return realStart(name);
    };
    const boot = m.bootAll();
    while (m.status('b').status !== 'booting') await sleep(1);
    const unplug = m.setPlugged('b', false);
    open();
    await Promise.all([boot, unplug]);
    expect(driver.containers.get(cname('b'))?.state).toBe('stopped');
    expect(m.status('b')).toEqual({ status: 'off' });
  });
});

describe('N5: shutdown is bounded', () => {
  it('an engine release that never returns does not hold up shutdown (repro)', async () => {
    const driver = new FakeDriver();
    driver.shutdownEngine = () => new Promise<boolean>(() => {});
    const { m } = mk(undefined, driver, { extra: { shutdownTimeoutMs: 200 } });
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
    const r = await Promise.race([m.shutdown().then(() => 'done'), sleep(3000).then(() => 'hung')]);
    expect(r).toBe('done');
    expect(driver.containers.get(cname('a'))?.state).toBe('stopped');
  });

  it('an engine release that fails is logged, not thrown', async () => {
    const driver = new FakeDriver();
    driver.shutdownEngine = async () => {
      throw new Error('system stop exploded');
    };
    const { m } = mk(undefined, driver, { extra: { shutdownTimeoutMs: 200 } });
    await m.init({ createDefault: false });
    await expect(m.shutdown()).resolves.toBeUndefined();
  });
});
