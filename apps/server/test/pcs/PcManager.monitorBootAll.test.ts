/**
 * The "monitor vs. bootAll" race (fixed 2026-10-09; formerly in docs/design/DEBT.md): a monitor pass could stop a
 * container that still runs for an inactive PC just before `bootAll` would have adopted it, and `bootAll` then started
 * the very same container again (one wasted restart; nothing recreated). The monitor now leaves strays alone while a
 * `bootAll` runs. A pass that runs before any `bootAll` starts still stops the stray (it cannot know one is coming),
 * which costs that one restart and never a recreate.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import type { PcContainerInfo } from '../../src/pcs/drivers/PcDriver.js';
import { PcManager } from '../../src/pcs/PcManager.js';
import { FakeDriver, fakePool, serving } from './fakes.js';

const INST = 'unit';
const cname = (id: string) => `mv-pc-${INST}-${id}`;
const tiny = { homeGiB: 1, overlayGiB: 1, tmpGiB: 1, varTmpGiB: 1, rootfsGiB: 1 };

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-monboot-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mk(driver: FakeDriver): PcManager {
  return new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches'), [], { json: serving }, { healthTimeoutMs: 2000 }),
    labelValue: 'pc-test',
    instanceId: INST,
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
    portProbe: { attempts: 2, intervalMs: 10 },
  });
}

/** A container still runs for `a` (the last run did not stop it), and a new manager has not reconciled it yet. */
async function leftRunning(): Promise<{ m: PcManager; driver: FakeDriver }> {
  const driver = new FakeDriver();
  const first = mk(driver);
  await first.init({ createDefault: false });
  await first.create({ type: 'linux', id: 'a', boot: true, disk: tiny });
  const m = mk(driver);
  await m.init();
  driver.log.length = 0;
  return { m, driver };
}

describe('monitor vs. bootAll (DEBT: PC manager)', () => {
  it('a monitor pass that stops the stray first costs one restart, never a recreate', async () => {
    const { m, driver } = await leftRunning();
    expect(m.status('a').status).toBe('off');
    await m.monitorOnce(); // the pass that won the race: `a` is inactive, so its container is a stray
    expect(driver.containers.get(cname('a'))?.state).toBe('stopped');
    const r = await m.bootAll();
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    // The same container, started again: no rm, no create, so its rootfs and volumes survive.
    expect(driver.log.filter((l) => l.endsWith(cname('a')))).toEqual([
      `stop ${cname('a')}`,
      `start ${cname('a')}`,
    ]);
  });

  it('when bootAll gets there first it adopts the container and the monitor leaves it alone', async () => {
    const { m, driver } = await leftRunning();
    const r = await m.bootAll();
    await m.monitorOnce();
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    expect(driver.log).toEqual([]);
  });

  it('a monitor pass while bootAll runs leaves the stray to it: adopted, no stop, no restart', async () => {
    const { m, driver } = await leftRunning();
    // Hold bootAll at its first container list, so the monitor pass runs in the middle of it.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lists = 0;
    const list = driver.list.bind(driver);
    driver.list = async (labels): Promise<PcContainerInfo[]> => {
      if (lists++ === 0) await gate;
      return list(labels);
    };
    const booting = m.bootAll();
    await m.monitorOnce();
    expect(driver.containers.get(cname('a'))?.state).toBe('running');
    release();
    const r = await booting;
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    expect(driver.log).toEqual([]);
    // Once bootAll is done, the monitor is back to normal (nothing to do for a running, adopted PC).
    await m.monitorOnce();
    expect(driver.log).toEqual([]);
  });

  it('run concurrently, either order ends with the PC running on its original container', async () => {
    const { m, driver } = await leftRunning();
    const [, r] = await Promise.all([m.monitorOnce(), m.bootAll()]);
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    expect(driver.log.some((l) => l.startsWith('create ') || l.startsWith('rm '))).toBe(false);
  });
});
