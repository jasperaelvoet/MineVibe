/**
 * `doctor --clean-orphans` (pcs/orphans.ts; DEBT "throwaway homes leak PC instances") on the fake driver: real
 * PcManager instances leave containers, networks and volumes behind, and only the ones whose home is gone and that no
 * process uses are removed. Homes that exist, live processes, unmounted volumes and instances without a record of
 * their home are never touched (unless named).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB } from '../../src/pcs/Budget.js';
import { MANAGED_LABEL, PC_INSTANCE_LABEL } from '../../src/pcs/drivers/PcDriver.js';
import {
  type ProcessProbe,
  readInstanceRecords,
  recordLiveness,
  writeInstanceRecord,
} from '../../src/pcs/InstanceRegistry.js';
import { knownHomes } from '../../src/pcs/orphanCleanup.js';
import {
  cleanOrphans,
  formatOrphanReport,
  type OrphanDeps,
  pathExists,
  scanOrphans,
} from '../../src/pcs/orphans.js';
import { PcManager } from '../../src/pcs/PcManager.js';
import { instanceIdFor } from '../../src/util/hostPaths.js';
import { FakeDriver, fakePool, serving } from './fakes.js';

let dir: string;
let driver: FakeDriver;
let registryDir: string;
let exportsRoot: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-orphans-')));
  driver = new FakeDriver();
  registryDir = join(dir, 'container', 'minevibe-instances');
  exportsRoot = join(dir, 'codex-export');
  mkdirSync(join(dir, 'home'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A home with linux-1 booted once; `shutdown` lets go of it like a quitting MineVibe. */
async function home(
  name: string,
  instance: string,
  opts: { shutdown?: boolean; register?: boolean } = {},
): Promise<string> {
  const state = join(dir, name, 'state');
  const m = new PcManager({
    stateDir: state,
    driver,
    pool: fakePool(join(dir, name, 'caches'), [], { json: serving }),
    labelValue: 'pc',
    instanceId: instance,
    hostFacts: async () => ({ cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB }),
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    portProbe: { attempts: 2, intervalMs: 10 },
    ...(opts.register === false ? {} : { registryDir }),
  });
  await m.init();
  await m.start('linux-1');
  if (opts.shutdown !== false) await m.shutdown({ stopEngine: false });
  return state;
}

function deps(over: Partial<OrphanDeps> = {}): OrphanDeps {
  return {
    driver,
    registryDir,
    codexExportsRoot: exportsRoot,
    otherEngineUsers: async () => 0,
    ...over,
  };
}

const names = (inst: string) => ({
  containers: [`mv-pc-${inst}-linux-1`],
  networks: [`mv-pc-${inst}-linux-1-net`],
  volumes: [`mv-pc-${inst}-linux-1-home`, `mv-pc-${inst}-linux-1-tmp`, `mv-pc-${inst}-linux-1-vartmp`],
});

describe('orphaned PC instances', () => {
  it('removes only the instance whose home is gone and that nothing uses; dry run by default', async () => {
    const kept = await home('kept', 'aaaa0001');
    const gone = await home('gone', 'aaaa0002');
    const live = await home('live', 'aaaa0003', { shutdown: false });
    rmSync(join(dir, 'gone'), { recursive: true, force: true });
    rmSync(join(dir, 'live'), { recursive: true, force: true });

    const dry = await cleanOrphans(deps());
    expect(dry.applied).toBe(false);
    expect(dry.removed).toEqual([]);
    const by = Object.fromEntries(dry.findings.map((f) => [f.instance, f]));
    expect(by.aaaa0001).toMatchObject({ verdict: 'home_exists', stateDir: kept, registered: true });
    expect(by.aaaa0002).toMatchObject({ verdict: 'orphan', stateDir: gone, ...names('aaaa0002') });
    // Its home is gone, but this process still runs it (no shutdown): never touched.
    expect(by.aaaa0003).toMatchObject({ verdict: 'live', stateDir: live });
    expect(driver.containers.size).toBe(3);
    expect(formatOrphanReport(dry).join('\n')).toMatch(/Dry run: 1 orphaned instance\(s\) would be removed/);

    const applied = await cleanOrphans(deps(), { apply: true });
    expect([...applied.removed].sort()).toEqual(
      [...Object.values(names('aaaa0002')).flat(), 'registry aaaa0002'].sort(),
    );
    expect(applied.failed).toEqual([]);
    expect([...driver.containers.keys()].sort()).toEqual([
      'mv-pc-aaaa0001-linux-1',
      'mv-pc-aaaa0003-linux-1',
    ]);
    expect([...driver.networks.keys()].some((n) => n.includes('aaaa0002'))).toBe(false);
    expect([...driver.volumes.keys()].some((n) => n.includes('aaaa0002'))).toBe(false);
    expect([...(await readInstanceRecords(registryDir)).keys()].sort()).toEqual(['aaaa0001', 'aaaa0003']);
  });

  it('a dead process counts as gone; ps trouble or an unmounted volume keeps the instance', async () => {
    await home('crashed', 'bbbb0001', { shutdown: false });
    rmSync(join(dir, 'crashed'), { recursive: true, force: true });
    const dead: ProcessProbe = { pidExists: () => false, startTime: async () => null };
    expect((await scanOrphans(deps({ probe: dead })))[0]).toMatchObject({ verdict: 'orphan' });
    const reused: ProcessProbe = { pidExists: () => true, startTime: async () => '2001-01-01T00:00:00.000Z' };
    expect((await scanOrphans(deps({ probe: reused })))[0]).toMatchObject({ verdict: 'orphan' });
    const blind: ProcessProbe = { pidExists: () => true, startTime: async () => null };
    expect((await scanOrphans(deps({ probe: blind })))[0]).toMatchObject({ verdict: 'unknown' });

    await writeInstanceRecord(registryDir, {
      v: 1,
      instance: 'bbbb0002',
      stateDir: '/Volumes/MineVibeTestNoSuchVolume/home/state',
      label: 'pc',
      pid: null,
      started: null,
      updatedAt: 1,
    });
    const f = (await scanOrphans(deps(), { instances: ['bbbb0002'] }))[0];
    expect(f).toMatchObject({ verdict: 'unknown', why: expect.stringMatching(/not mounted/) });
  });

  it('a home this process may not read is unknown, never gone (TCC denial, permissions)', async () => {
    // A registered home whose MineVibe quit cleanly, in a folder doctor cannot look into: `existsSync` says false for
    // EACCES/EPERM, which once made it an orphan and let `--apply` delete PCs that were still in use.
    const state = await home(join('locked', 'h'), 'dddd0009');
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      const f = (await scanOrphans(deps()))[0];
      expect(f).toMatchObject({ instance: 'dddd0009', verdict: 'unknown', stateDir: state });
      expect(f?.why).toMatch(/cannot tell whether/);
      expect((await cleanOrphans(deps(), { apply: true })).removed).toEqual([]);
      expect(driver.containers.has('mv-pc-dddd0009-linux-1')).toBe(true);
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
    }
    expect(pathExists(state)).toBe(true);
    expect(pathExists(join(dir, 'no-such-home', 'state'))).toBe(false);
    expect(pathExists(join(state, 'pcs.json', 'below-a-file'))).toBe(false);
    // A caller's own check may say "unknown" too.
    expect((await scanOrphans(deps({ exists: () => 'unknown' })))[0]).toMatchObject({ verdict: 'unknown' });
  });

  it('leaves instances without a record of their home alone unless named, and then only when no one else runs', async () => {
    await home('old', 'cccc0001', { register: false });
    rmSync(join(dir, 'old'), { recursive: true, force: true });
    expect((await scanOrphans(deps()))[0]).toMatchObject({ verdict: 'unregistered', registered: false });
    expect((await cleanOrphans(deps(), { apply: true })).removed).toEqual([]);
    expect(driver.containers.size).toBe(1);

    const busy = deps({ otherEngineUsers: async () => 1 });
    expect((await scanOrphans(busy, { instances: ['cccc0001'] }))[0]).toMatchObject({ verdict: 'unknown' });
    const named = await cleanOrphans(deps(), { apply: true, instances: ['cccc0001'] });
    expect(named.findings.map((f) => [f.instance, f.verdict])).toEqual([['cccc0001', 'orphan']]);
    expect(driver.containers.size).toBe(0);
    expect(driver.volumes.size).toBe(0);
    expect(driver.networks.size).toBe(0);
  });

  it('a known home stands in for a missing record: an existing one is never removed, even when named', async () => {
    const state = await home('play', 'dddd0001', { register: false });
    const known = new Map([['dddd0001', state]]);
    const f = (await scanOrphans(deps(), { instances: ['dddd0001'], knownHomes: known }))[0];
    expect(f).toMatchObject({ verdict: 'home_exists', stateDir: state });
    expect(
      (await cleanOrphans(deps(), { apply: true, instances: ['dddd0001'], knownHomes: known })).removed,
    ).toEqual([]);
    // The known homes of a checkout and a Mac are keyed by their instance ids.
    const homes = knownHomes({ MINEVIBE_HOME: join(dir, 'x') }, process.cwd(), join(dir, 'home'));
    expect(homes.get(instanceIdFor(join(dir, 'x', 'state')))).toBe(join(dir, 'x', 'state'));
    expect([...homes.values()].some((s) => s.endsWith(join('.minevibe-dev', 'play', 'state')))).toBe(true);
  });

  it('removes a relocated Codex export with its owner file once the home is gone', async () => {
    const state = join(dir, 'Documents-home', 'state');
    mkdirSync(state, { recursive: true });
    mkdirSync(join(exportsRoot, 'eeee0001', '.generations'), { recursive: true });
    writeFileSync(join(exportsRoot, 'eeee0001.json'), JSON.stringify({ v: 1, appSupport: dir, state }));
    expect((await scanOrphans(deps()))[0]).toMatchObject({
      instance: 'eeee0001',
      verdict: 'home_exists',
      codexExport: join(exportsRoot, 'eeee0001'),
    });
    rmSync(join(dir, 'Documents-home'), { recursive: true, force: true });
    const r = await cleanOrphans(deps(), { apply: true });
    expect([...r.removed].sort()).toEqual([
      join(exportsRoot, 'eeee0001'),
      join(exportsRoot, 'eeee0001.json'),
    ]);
    expect(existsSync(join(exportsRoot, 'eeee0001'))).toBe(false);
  });

  it('never removes a resource whose name and label disagree, or another label value', async () => {
    await home('gone', 'ffff0001');
    rmSync(join(dir, 'gone'), { recursive: true, force: true });
    driver.networks.set('someone-elses-net', { [MANAGED_LABEL]: 'pc', [PC_INSTANCE_LABEL]: 'ffff0001' });
    expect((await scanOrphans(deps(), { label: 'pc-test-run' })).map((f) => f.instance)).toEqual([]);
    await cleanOrphans(deps(), { apply: true });
    expect([...driver.networks.keys()]).toEqual(['someone-elses-net']);
  });

  it('re-checks each orphan right before removing it', async () => {
    await home('gone', '99990001');
    rmSync(join(dir, 'gone'), { recursive: true, force: true });
    let scans = 0;
    // The home reappears between the scan and the removal (a restore, a new run with the same folder).
    const r = await cleanOrphans(
      deps({
        exists: (p) => {
          if (p.endsWith(join('gone', 'state'))) return scans++ > 0;
          return existsSync(p);
        },
      }),
      { apply: true },
    );
    expect(r.findings[0]?.verdict).toBe('orphan');
    expect(r.removed).toEqual([]);
    expect(driver.containers.size).toBe(1);
  });

  it('liveness of a record: no pid means let go', async () => {
    expect(await recordLiveness({ pid: null, started: null })).toBe('dead');
    expect(await recordLiveness({ pid: process.pid, started: null })).toBe('unknown');
  });
});
