/**
 * The Codex export in every Linux PC (PLAN §6.6; DEBT "PCs have no /mnt/codex") and the PC instance registry
 * (DEBT "throwaway homes leak PC instances"), on the fake driver: the read-only bind, the `~/codex` link made in the
 * guest once spacesd serves, a refused (TCC-protected) export, the recreate of a container from before the mount, and
 * the registry record PcManager keeps.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import { PcGuestApi } from '../../src/pcs/GuestApi.js';
import { InputRouter } from '../../src/pcs/InputRouter.js';
import { readInstanceRecords } from '../../src/pcs/InstanceRegistry.js';
import { CODEX_GUEST_PATH, codexMountProblem, PcManager } from '../../src/pcs/PcManager.js';
import { SeatBook } from '../../src/pcs/SeatBook.js';
import { FakeDriver, type FakeHealth, fakePool, serving } from './fakes.js';

const INST = 'unit';
const cname = (id: string) => `mv-pc-${INST}-${id}`;

let dir: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-codexmount-')));
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(
  opts: {
    codexExport?: string | null;
    registry?: boolean;
    driver?: FakeDriver;
    health?: FakeHealth;
    instanceId?: string;
  } = {},
) {
  const driver = opts.driver ?? new FakeDriver();
  const health: FakeHealth = opts.health ?? { json: serving, runs: [] };
  const m = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches'), [], health),
    labelValue: 'pc-test',
    instanceId: opts.instanceId ?? INST,
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
    portProbe: { attempts: 2, intervalMs: 10 },
    ...(opts.codexExport !== undefined ? { codexExport: opts.codexExport } : {}),
    ...(opts.registry ? { registryDir: join(dir, 'registry') } : {}),
  });
  return { m, driver, health };
}

describe('the Codex export in every Linux PC (PLAN §6.6)', () => {
  it('mounts the export read-only at /mnt/codex, creating it first, and links ~/codex in the guest', async () => {
    const codex = join(dir, 'export', 'codex-export');
    const { m, driver, health } = manager({ codexExport: codex });
    await m.init();
    await m.start('linux-1');
    expect(m.status('linux-1').status).toBe('running');
    const spec = driver.containers.get(cname('linux-1'))?.spec;
    expect(spec?.binds).toEqual([{ source: codex, target: CODEX_GUEST_PATH, readonly: true }]);
    expect(existsSync(codex)).toBe(true);
    expect(m.codexExport).toBe(codex);
    expect(m.codexPathOf('linux-1')).toBe('/mnt/codex');
    // `~/codex` → /mnt/codex, made once as the guest user, never over a ~/codex of the user's own.
    const runs = health.runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ program: 'bash', user: 'cua' });
    expect(runs[0]?.env.get('HOME')).toBe('/home/cua');
    const script = runs[0]?.args[1] ?? '';
    expect(script).toContain('ln -s /mnt/codex "$HOME/codex"');
    expect(script).toContain('[ -e "$HOME/codex" ] || [ -L "$HOME/codex" ] ||');
  });

  it("the ~/codex script links an empty spot and never replaces what is there (a link of the user's own included)", async () => {
    const { m, health } = manager({ codexExport: join(dir, 'codex-export') });
    await m.init();
    await m.start('linux-1');
    // Run the guest script against a stand-in home, with a stand-in for /mnt/codex.
    const script = (health.runs?.[0]?.args[1] ?? '').replaceAll(CODEX_GUEST_PATH, join(dir, 'mnt-codex'));
    mkdirSync(join(dir, 'mnt-codex'));
    const run = (home: string) =>
      execFileSync('bash', ['-c', script], { env: { HOME: home, PATH: process.env.PATH } });
    const fresh = join(dir, 'fresh');
    mkdirSync(fresh);
    run(fresh);
    expect(readlinkSync(join(fresh, 'codex'))).toBe(join(dir, 'mnt-codex'));
    run(fresh); // a second boot: the link stays as it is
    expect(readlinkSync(join(fresh, 'codex'))).toBe(join(dir, 'mnt-codex'));
    const own = join(dir, 'own');
    mkdirSync(own);
    symlinkSync(join(dir, 'my-notes'), join(own, 'codex')); // dangling, and the user's
    run(own);
    expect(readlinkSync(join(own, 'codex'))).toBe(join(dir, 'my-notes'));
    const folder = join(dir, 'folder');
    mkdirSync(join(folder, 'codex'), { recursive: true });
    run(folder);
    expect(lstatSync(join(folder, 'codex')).isDirectory()).toBe(true);
    expect(existsSync(join(folder, 'codex', 'mnt-codex'))).toBe(false);
  });

  it('reuses a container that has the mount, and recreates one from before it (home volume kept)', async () => {
    const codex = join(dir, 'codex-export');
    const driver = new FakeDriver();
    const before = manager({ driver, codexExport: null });
    await before.m.init();
    await before.m.start('linux-1');
    await before.m.stop('linux-1');
    expect(driver.containers.get(cname('linux-1'))?.spec.binds).toEqual([]);

    const after = manager({ driver, codexExport: codex });
    await after.m.init();
    driver.log.length = 0;
    await after.m.start('linux-1');
    expect(driver.log).toContain(`rm ${cname('linux-1')}`);
    expect(driver.log).toContain(`create ${cname('linux-1')}`);
    expect(driver.volumes.has(after.m.homeVolumeOf('linux-1'))).toBe(true);
    expect(driver.containers.get(cname('linux-1'))?.spec.binds).toEqual([
      { source: codex, target: CODEX_GUEST_PATH, readonly: true },
    ]);

    await after.m.stop('linux-1');
    driver.log.length = 0;
    await after.m.start('linux-1');
    expect(driver.log).toEqual([`start ${cname('linux-1')}`]);
  });

  it('names why an export cannot be mounted', () => {
    const home = join(dir, 'home');
    const tcc = join(home, 'Documents', 'MineVibe', '.minevibe-dev', 'codex-export');
    const driver = new FakeDriver();
    expect(codexMountProblem(tcc, driver, { home, platform: 'darwin' })).toMatch(/inside ~\/Documents/);
    expect(codexMountProblem(tcc, driver, { home, platform: 'linux' })).toBeNull();
    expect(codexMountProblem(tcc, { kind: 'docker' }, { home, platform: 'darwin' })).toBeNull();
    expect(codexMountProblem('/x/a=b', driver, { home, platform: 'darwin' })).toMatch(/equals sign/);
    expect(codexMountProblem('relative', driver, { home })).toMatch(/absolute/);
  });

  // PcManager checks TCC against the host it runs on, and TCC only exists on macOS.
  it.runIf(process.platform === 'darwin')(
    'refuses an export the engine cannot mount: PCs run without it',
    async () => {
      const tcc = join(dir, 'home', 'Documents', 'MineVibe', '.minevibe-dev', 'codex-export');
      const driver = new FakeDriver();
      const { m, health } = manager({ driver, codexExport: tcc });
      await m.init();
      await m.start('linux-1');
      expect(m.codexExport).toBeNull();
      expect(m.codexPathOf('linux-1')).toBeNull();
      expect(driver.containers.get(cname('linux-1'))?.spec.binds).toEqual([]);
      expect(health.runs).toEqual([]);
    },
  );

  it('PcApi.info names /mnt/codex only when the PC has it', async () => {
    const { m } = manager({ codexExport: join(dir, 'codex-export') });
    await m.init();
    await m.start('linux-1');
    const router = new InputRouter({ getClient: async () => ({}) as never });
    const api = new PcGuestApi({
      pcs: m,
      client: async () => {
        throw new Error('no guest in this test');
      },
      router,
      seats: new SeatBook(),
      jpegFormat: () => 1,
    });
    expect((await api.info('linux-1')).codexPath).toBe('/mnt/codex');
    const bare = new PcGuestApi({
      pcs: { get: (id) => m.get(id), status: (id) => m.status(id) },
      client: async () => {
        throw new Error('no guest in this test');
      },
      router,
      seats: new SeatBook(),
      jpegFormat: () => 1,
    });
    expect((await bare.info('linux-1')).codexPath).toBeNull();
    api.dispose();
    bare.dispose();
  });
});

describe('the PC instance registry', () => {
  it('records the state dir and this process on init, and lets go of the process on shutdown', async () => {
    const id = '0badc0de';
    const { m } = manager({ registry: true, instanceId: id });
    await m.init();
    let rec = (await readInstanceRecords(join(dir, 'registry'))).get(id);
    expect(rec).toMatchObject({
      instance: id,
      stateDir: join(dir, 'state'),
      label: 'pc-test',
      pid: process.pid,
    });
    expect(rec?.started).not.toBeNull();
    const file = JSON.parse(readFileSync(join(dir, 'registry', `${id}.json`), 'utf8'));
    expect(file.v).toBe(1);
    await m.shutdown({ stopEngine: false });
    rec = (await readInstanceRecords(join(dir, 'registry'))).get(id);
    expect(rec).toMatchObject({ instance: id, stateDir: join(dir, 'state'), pid: null, started: null });
  });

  it('records the real path of a state dir reached through a symlink (the path the instance id hashes)', async () => {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const m = new PcManager({
      stateDir: join(dir, 'link', 'state'),
      driver: new FakeDriver(),
      pool: fakePool(join(dir, 'caches'), [], { json: serving }),
      labelValue: 'pc-test',
      hostFacts: async () => host,
      home: join(dir, 'home'),
      registryDir: join(dir, 'registry'),
    });
    await m.init({ createDefault: false });
    expect((await readInstanceRecords(join(dir, 'registry'))).get(m.instanceId)).toMatchObject({
      stateDir: join(dir, 'real', 'state'),
    });
    await m.shutdown({ stopEngine: false });
  });

  it('writes nothing without a registry folder', async () => {
    const { m } = manager();
    await m.init();
    await m.shutdown({ stopEngine: false });
    expect(existsSync(join(dir, 'registry'))).toBe(false);
  });
});
