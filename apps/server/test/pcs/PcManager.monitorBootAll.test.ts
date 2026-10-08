/**
 * The "monitor vs. bootAll" race from docs/design/DEBT.md, pinned down: a monitor pass can stop a container that
 * still runs for an inactive PC just before `bootAll` would have adopted it. `bootAll` then starts the very same
 * container again. That is wasteful (one restart) but benign: nothing is recreated, so the rootfs and the volumes
 * are kept, and the PC ends up running. These tests document that behaviour; a fix (for example, the monitor
 * leaving strays alone while a `bootAll` runs) would make the first one restart-free.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
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

  it('run concurrently, either order ends with the PC running on its original container', async () => {
    const { m, driver } = await leftRunning();
    const [, r] = await Promise.all([m.monitorOnce(), m.bootAll()]);
    expect(r.booted).toEqual(['a']);
    expect(m.status('a')).toEqual({ status: 'running' });
    expect(driver.log.some((l) => l.startsWith('create ') || l.startsWith('rm '))).toBe(false);
  });
});
