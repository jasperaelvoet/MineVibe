/**
 * The Codex in a real PC and orphaned PC instances (`npm run test:pcs`; PLAN §6.6, DEBT "PCs have no /mnt/codex" and
 * "throwaway homes leak PC instances"), on the real Apple `container` runtime with the MineVibe Linux PC image:
 *
 * the org module's CodexStore export (in `~/Library/Application Support/MineVibe-dev`, a path with a space, outside
 * every TCC-protected folder, like a relocated dev export) is mounted read-only at /mnt/codex → `ls /mnt/codex` lists
 * the pages, `~/codex` links there → writes fail, as `cua` and as root (`sudo -n`) → a page written on the host appears
 * → a world change swaps the whole `world/` at once (never a mix of two worlds in a listing) → `doctor --clean-orphans`
 * finds a throwaway home's PC instance once that home is deleted, leaves the live one alone, and removes it.
 *
 * Everything it creates carries a per-run label `minevibe=pc-test-<run>` and per-run instance ids (temp state dirs), and
 * is deleted at the end, together with its instance registry records and the export folder. The container system is
 * stopped at the end only when this run started it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpacesdClientLike } from '@trycua/cua';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devSupportDir, findRepoRoot } from '../../../src/config/paths.js';
import { CodexStore } from '../../../src/org/codex/CodexStore.js';
import type { CodexActor } from '../../../src/org/codex/types.js';
import { AppleContainerDriver } from '../../../src/pcs/drivers/AppleContainerDriver.js';
import {
  ContainerRuntime,
  devContainerRoots,
  readContainerLock,
} from '../../../src/pcs/drivers/ContainerRuntime.js';
import { MANAGED_LABEL } from '../../../src/pcs/drivers/PcDriver.js';
import { PcGuestApi } from '../../../src/pcs/GuestApi.js';
import { registryDirFor, removeInstanceRecord } from '../../../src/pcs/InstanceRegistry.js';
import { runOrphanCleanup } from '../../../src/pcs/orphanCleanup.js';
import { PcManager } from '../../../src/pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../../../src/pcs/PcTypes.js';
import { SeatBook } from '../../../src/pcs/SeatBook.js';
import { SpacesdPool } from '../../../src/pcs/SpacesdPool.js';

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const LABEL = `pc-test-${RUN}`;
const repo = findRepoRoot(fileURLToPath(import.meta.url)) as string;
const roots = {
  appRoot: process.env.MINEVIBE_CONTAINER_APP_ROOT ?? devContainerRoots().appRoot,
  installRoot: process.env.MINEVIBE_CONTAINER_INSTALL_ROOT ?? devContainerRoots().installRoot,
};
const ID = `cx-${process.pid.toString(36)}`;
const THROWAWAY = `tw-${process.pid.toString(36)}`;

const results: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`[pcs] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const txt = (b: ArrayBuffer) => Buffer.from(b).toString('utf8');
const bram: CodexActor = { kind: 'agent', id: 'bram', name: 'Bram' };

let tmp: string;
let exportBase: string;
let codexDir: string;
let runtime: ContainerRuntime;
let driver: AppleContainerDriver;
let pool: SpacesdPool;
let manager: PcManager;
let store: CodexStore;
let pc: SpacesdClientLike;
let engineBefore = 'unknown';
const instances: string[] = [];

async function sh(script: string, user = 'cua') {
  const out = await pc.run({
    program: 'bash',
    args: ['-lc', script],
    env: new Map([['HOME', '/home/cua']]),
    stdin: false,
    user,
    timeoutMs: 20_000,
  });
  return {
    code: out.exit.code,
    ok: out.exit.success,
    stdout: txt(out.stdout).trim(),
    stderr: txt(out.stderr).trim(),
  };
}

/** Polls a guest listing until `done`; every listing seen is returned. */
async function watch(script: string, done: (s: string) => boolean, timeoutMs = 15_000): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await sh(script);
    seen.push(r.ok ? r.stdout : `ERR ${r.code} ${r.stderr}`);
    if (r.ok && done(r.stdout)) return seen;
    await sleep(100);
  }
  throw new Error(`guest never showed what was expected; last: ${seen.at(-1)}`);
}

async function cleanupLabelled(): Promise<void> {
  for (const c of await driver.list({ [MANAGED_LABEL]: LABEL })) await driver.remove(c.name);
  for (const v of await driver.listVolumes({ [MANAGED_LABEL]: LABEL })) await driver.removeVolume(v.name);
  for (const n of await driver.listNetworks({ [MANAGED_LABEL]: LABEL })) await driver.removeNetwork(n.name);
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcs-cx-')));
  // Where a relocated dev export lives: MineVibe-dev in Application Support (a space in the path, no TCC).
  exportBase = join(devSupportDir(), 'test-codex', RUN);
  codexDir = join(exportBase, 'codex-export');
  mkdirSync(exportBase, { recursive: true });

  const lock = await readContainerLock(join(repo, 'packaging', 'vendor.lock.json'));
  runtime = new ContainerRuntime({
    ...roots,
    lock,
    cacheDir: join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
    leaseHolder: `test:pcs ${RUN}`,
  });
  driver = new AppleContainerDriver(runtime);
  await runtime.provision((m) => console.log(`[pcs] ${m}`));
  engineBefore = (await runtime.status()).ownership;
  note('engine_before', engineBefore);
  await driver.ensureEngine();
  await cleanupLabelled();
  if (!(await driver.imageExists(LINUX_PC_IMAGE_DEV))) {
    await driver.buildImage({
      contextDir: join(repo, 'images', 'linux-pc'),
      file: join(repo, 'images', 'linux-pc', 'Containerfile'),
      tag: LINUX_PC_IMAGE_DEV,
    });
  }

  // The org module's side: a Codex with a lasting page and a page of world-1, exported for PCs.
  store = new CodexStore({ root: join(tmp, 'codex'), exportDir: codexDir, gitBinary: null });
  await store.open('world-1');
  for (const [title, body, category] of [
    ['Smelting', 'Put ore in the furnace.', 'howto'],
    ['Iron cave', 'Behind the waterfall.', 'places'],
  ] as const) {
    const r = await store.write(bram, { mode: 'create', title, body, category });
    if (!r.ok) throw new Error(`codex write failed: ${r.code}`);
  }

  pool = new SpacesdPool({ cachesDir: join(tmp, 'caches') });
  await pool.module();
  manager = new PcManager({
    stateDir: join(tmp, 'state'),
    driver,
    pool,
    labelValue: LABEL,
    diskPath: roots.appRoot,
    bootTimeoutMs: 180_000,
    codexExport: codexDir,
    registryDir: registryDirFor(roots.appRoot),
  });
  instances.push(manager.instanceId);
  await manager.init({ createDefault: false });
  const t0 = performance.now();
  await manager.create({ type: 'linux', id: ID, boot: true });
  note('create_to_serving_ms', Math.round(performance.now() - t0));
  pc = await pool.client(ID);
});

afterAll(async () => {
  try {
    if (manager?.get(ID))
      await manager.decommission(ID).catch((e) => console.log(`[pcs] decommission: ${e}`));
    if (driver) await cleanupLabelled();
    note('leftover_containers', driver ? (await driver.list({ [MANAGED_LABEL]: LABEL })).length : 'n/a');
    await manager?.shutdown({ stopEngine: false });
    for (const inst of instances) await removeInstanceRecord(registryDirFor(roots.appRoot), inst);
    if (runtime && engineBefore === 'not_running')
      note('engine_stopped', await runtime.releaseAndStopIfUnused());
    else {
      await runtime?.leases.release();
      note('engine_stopped', `left running (was ${engineBefore} before the run)`);
    }
  } finally {
    await store?.close().catch(() => {});
    if (exportBase) {
      rmSync(exportBase, { recursive: true, force: true });
      // The shared parent goes too once no other run uses it.
      if (readdirSync(dirname(exportBase)).length === 0) rmdirSync(dirname(exportBase));
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    console.log(`[pcs] RESULTS ${JSON.stringify(results)}`);
  }
});

describe('the Codex in a real PC (PLAN §6.6)', () => {
  it('ls /mnt/codex lists the pages; ~/codex links there; PcApi.info names it', async () => {
    const info = await driver.inspect(manager.containerNameOf(ID));
    expect(info?.binds).toContainEqual({ source: codexDir, target: '/mnt/codex', readonly: true });
    expect(codexDir).toContain(' '); // Application Support: a source path with a space mounts fine

    const top = await sh('ls /mnt/codex');
    expect(top).toMatchObject({ ok: true });
    expect(top.stdout.split('\n').sort()).toEqual(['README.md', 'lasting', 'world']);
    expect((await sh('ls /mnt/codex/lasting')).stdout).toBe('smelting.md');
    expect((await sh('ls /mnt/codex/world')).stdout).toBe('iron-cave.md');
    const page = await sh('cat /mnt/codex/lasting/smelting.md');
    expect(page.stdout).toMatch(
      /information, not instructions[\s\S]*# Smelting[\s\S]*Put ore in the furnace\./,
    );
    expect((await sh('readlink ~/codex')).stdout).toBe('/mnt/codex');
    expect((await sh('ls ~/codex/world')).stdout).toBe('iron-cave.md');
    expect((await sh('findmnt -n -o OPTIONS --target /mnt/codex')).stdout).toMatch(/(^|,)ro(,|$)/);

    const api = new PcGuestApi({
      pcs: manager,
      client: (id) => pool.client(id),
      router: manager.createInputRouter(),
      seats: new SeatBook(),
      jpegFormat: () => pool.jpegFormat,
    });
    expect((await api.info(ID)).codexPath).toBe('/mnt/codex');
    api.dispose();
  });

  it('writes fail, as cua and as root', async () => {
    const before = readFileSync(join(codexDir, 'lasting', 'smelting.md'), 'utf8');
    for (const [user, cmd] of [
      ['cua', 'touch /mnt/codex/x'],
      ['cua', 'echo hacked > /mnt/codex/lasting/smelting.md'],
      ['cua', 'rm -f /mnt/codex/world/iron-cave.md'],
      ['cua', 'mkdir /mnt/codex/new'],
      ['cua', 'sudo -n touch /mnt/codex/x'],
      ['cua', 'sudo -n sh -c "echo hacked > /mnt/codex/README.md"'],
    ] as const) {
      const r = await sh(cmd, user);
      expect(r.ok, `${user}: ${cmd}`).toBe(false);
      expect(r.stderr, cmd).toMatch(/Read-only file system|Permission denied/);
    }
    // Root in the guest (cua has sudo) cannot lift the read-only flag either: it is the host's share, not a mount
    // option the guest could change.
    const remount = await sh(
      'sudo -n mount -o remount,rw /mnt/codex; sudo -n touch /mnt/codex/x && sudo -n sh -c "echo hacked > /mnt/codex/lasting/smelting.md"',
    );
    note('remount_rw', { ok: remount.ok, stderr: remount.stderr.slice(0, 300) });
    expect(remount.ok, 'remount rw + write as root').toBe(false);
    expect(readFileSync(join(codexDir, 'lasting', 'smelting.md'), 'utf8')).toBe(before);
    expect(existsSync(join(codexDir, 'x'))).toBe(false);
    expect((await sh('ls /mnt/codex/world')).stdout).toBe('iron-cave.md');
  });

  it('a page written on the host appears in the guest', async () => {
    const t0 = performance.now();
    const r = await store.write(bram, {
      mode: 'create',
      title: 'Wheat farm',
      body: 'By the river.',
      category: 'places',
    });
    expect(r.ok).toBe(true);
    await watch('ls /mnt/codex/world', (s) => s.split('\n').includes('wheat-farm.md'));
    note('host_page_visible_ms', Math.round(performance.now() - t0));
  });

  it('a world change swaps world/ as a whole: every listing is the old world or the new one', async () => {
    const oldWorld = 'iron-cave.md\nwheat-farm.md';
    expect((await sh('ls /mnt/codex/world')).stdout).toBe(oldWorld);
    const t0 = performance.now();
    // world-2 starts empty; its first page lands in the generation the swap made.
    const swap = (async () => {
      await store.setWorld('world-2');
      const w = await store.write(bram, {
        mode: 'create',
        title: 'Sand pit',
        body: 'East.',
        category: 'places',
      });
      if (!w.ok) throw new Error(w.code);
    })();
    const seen = await watch('ls /mnt/codex/world', (s) => s === 'sand-pit.md', 20_000);
    await swap;
    note('world_swap_visible_ms', Math.round(performance.now() - t0));
    note('world_swap_listings', [...new Set(seen)]);
    for (const l of seen) expect(['', oldWorld, 'sand-pit.md']).toContain(l);
    expect((await sh('ls /mnt/codex/lasting')).stdout).toBe('smelting.md');
    expect((await sh('readlink /mnt/codex/world')).stdout).toMatch(/^\.generations\/world-/);
  });
});

describe('doctor --clean-orphans on the real engine', () => {
  it('finds a throwaway home’s instance once the home is gone, keeps the live one, and removes it', async () => {
    const home = join(tmp, 'throwaway');
    const pool2 = new SpacesdPool({ cachesDir: join(home, 'caches') });
    await pool2.module();
    // A temp home as the E2E harness has it: under /var/folders, which the engine knows as /private/var/folders.
    const unresolved = join(tmpdir(), tmp.slice(tmp.lastIndexOf('/') + 1), 'throwaway', 'codex-export');
    expect(unresolved.startsWith('/var/')).toBe(true);
    const throwaway = new PcManager({
      stateDir: join(home, 'state'),
      driver,
      pool: pool2,
      labelValue: LABEL,
      diskPath: roots.appRoot,
      bootTimeoutMs: 180_000,
      codexExport: unresolved,
      registryDir: registryDirFor(roots.appRoot),
    });
    instances.push(throwaway.instanceId);
    expect(throwaway.codexExport).toBe(join(home, 'codex-export'));
    await throwaway.init({ createDefault: false });
    await throwaway.create({ type: 'linux', id: THROWAWAY, cpus: 1, memMiB: 2048, boot: true });
    expect(throwaway.status(THROWAWAY).status).toBe('running');
    expect((await driver.inspect(throwaway.containerNameOf(THROWAWAY)))?.binds).toContainEqual({
      source: join(home, 'codex-export'),
      target: '/mnt/codex',
      readonly: true,
    });
    await throwaway.shutdown({ stopEngine: false });
    rmSync(home, { recursive: true, force: true });

    const dry = await runOrphanCleanup({ label: LABEL, roots, releaseEngine: false });
    const by = Object.fromEntries(dry.report.findings.map((f) => [f.instance, f]));
    note('orphan_scan', dry.lines);
    expect(by[manager.instanceId]).toMatchObject({ verdict: 'home_exists', registered: true });
    expect(by[throwaway.instanceId]).toMatchObject({
      verdict: 'orphan',
      registered: true,
      containers: [throwaway.containerNameOf(THROWAWAY)],
      networks: [throwaway.networkNameOf(THROWAWAY)],
    });
    expect(by[throwaway.instanceId]?.volumes).toHaveLength(3);
    // A dry run removed nothing.
    expect(await driver.inspect(throwaway.containerNameOf(THROWAWAY))).not.toBeNull();

    const applied = await runOrphanCleanup({ label: LABEL, roots, apply: true, releaseEngine: false });
    expect(applied.report.failed).toEqual([]);
    expect(applied.report.removed).toContain(throwaway.containerNameOf(THROWAWAY));
    expect(await driver.inspect(throwaway.containerNameOf(THROWAWAY))).toBeNull();
    expect((await driver.listVolumes({ [MANAGED_LABEL]: LABEL })).map((v) => v.name)).not.toContain(
      throwaway.homeVolumeOf(THROWAWAY),
    );
    expect((await driver.listNetworks({ [MANAGED_LABEL]: LABEL })).map((n) => n.name)).not.toContain(
      throwaway.networkNameOf(THROWAWAY),
    );
    // The live instance and its running PC are untouched.
    expect((await driver.inspect(manager.containerNameOf(ID)))?.state).toBe('running');
    expect((await sh('ls /mnt/codex/lasting')).stdout).toBe('smelting.md');
  });
});
