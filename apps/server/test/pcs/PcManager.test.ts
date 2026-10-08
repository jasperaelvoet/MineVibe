import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts, MiB } from '../../src/pcs/Budget.js';
import { EngineError } from '../../src/pcs/drivers/ContainerRuntime.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import {
  hasLabels,
  type NetworkInfo,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  type VolumeInfo,
  type VolumeMount,
} from '../../src/pcs/drivers/PcDriver.js';
import {
  instanceIdFor,
  isPortConflictError,
  PcError,
  PcManager,
  type PcView,
} from '../../src/pcs/PcManager.js';
import { type CuaModule, SpacesdPool } from '../../src/pcs/SpacesdPool.js';

type FakeContainer = { spec: PcRunSpec; state: 'running' | 'stopped'; labels: Record<string, string> };

class FakeDriver implements PcDriver {
  readonly kind = 'apple-container' as const;
  readonly cpuOverhead = 1;
  readonly capsVolumes = true;
  containers = new Map<string, FakeContainer>();
  volumes = new Map<string, { labels: Record<string, string>; sizeGiB: number }>();
  networks = new Map<string, Record<string, string>>();
  log: string[] = [];
  engineError: Error | null = null;
  /** Errors the next `start` calls throw, one per call. */
  startErrors: string[] = [];
  stopError: string | null = null;
  publishAddress = '127.0.0.1';
  usage = new Map<string, number>();
  building = false;
  onBuild: (() => Promise<void>) | null = null;
  imagePresent = true;

  async ensureEngine() {
    if (this.engineError) throw this.engineError;
    this.log.push('engine');
  }
  async shutdownEngine() {
    this.log.push('engine-stop');
    return true;
  }
  async imageExists() {
    return this.imagePresent;
  }
  async pullImage(ref: string) {
    this.log.push(`pull ${ref}`);
  }
  async buildImage() {
    this.log.push('build');
    await this.onBuild?.();
    this.imagePresent = true;
  }
  async ensureVolume(v: VolumeMount, labels: Record<string, string>) {
    const cur = this.volumes.get(v.name);
    if (cur) {
      if (!hasLabels(cur.labels, labels)) throw new Error(`volume ${v.name} belongs to someone else`);
      return 'exists' as const;
    }
    this.volumes.set(v.name, { labels: { ...labels }, sizeGiB: v.sizeGiB });
    return 'created' as const;
  }
  async removeVolume(name: string) {
    this.log.push(`rmvol ${name}`);
    this.volumes.delete(name);
  }
  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    return [...this.volumes]
      .filter(([, v]) => hasLabels(v.labels, labels))
      .map(([name, v]) => ({ name, labels: v.labels, sizeBytes: v.sizeGiB * GiB }));
  }
  async ensureNetwork(name: string, labels: Record<string, string>) {
    const cur = this.networks.get(name);
    if (cur) {
      if (!hasLabels(cur, labels)) throw new Error(`network ${name} belongs to someone else`);
      return 'exists' as const;
    }
    this.log.push(`net ${name}`);
    this.networks.set(name, { ...labels });
    return 'created' as const;
  }
  async removeNetwork(name: string) {
    this.log.push(`rmnet ${name}`);
    this.networks.delete(name);
  }
  async listNetworks(labels: Record<string, string>): Promise<NetworkInfo[]> {
    return [...this.networks]
      .filter(([, l]) => hasLabels(l, labels))
      .map(([name, l]) => ({ name, labels: l }));
  }
  async create(spec: PcRunSpec) {
    this.log.push(`create ${spec.name}`);
    for (const v of spec.volumes) await this.ensureVolume(v, spec.ownerLabels ?? spec.labels);
    this.containers.set(spec.name, { spec, state: 'stopped', labels: spec.labels });
    return (await this.inspect(spec.name)) as PcContainerInfo;
  }
  async run(spec: PcRunSpec) {
    await this.create(spec);
    await this.start(spec.name);
  }
  async start(name: string) {
    this.log.push(`start ${name}`);
    const e = this.startErrors.shift();
    if (e) throw new Error(e);
    const c = this.containers.get(name);
    if (c) c.state = 'running';
  }
  async stop(name: string) {
    this.log.push(`stop ${name}`);
    if (this.stopError) throw new Error(this.stopError);
    const c = this.containers.get(name);
    if (c) c.state = 'stopped';
  }
  async remove(name: string) {
    this.log.push(`rm ${name}`);
    this.containers.delete(name);
  }
  async inspect(name: string): Promise<PcContainerInfo | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    return {
      name,
      state: c.state,
      image: c.spec.image,
      labels: c.labels,
      hostPort: c.spec.hostPort,
      hostAddress: this.publishAddress,
      binds: c.spec.binds,
      volumes: c.spec.volumes.map((v) => ({ name: v.name, target: v.target })),
      cpus: c.spec.cpus,
      memoryBytes: c.spec.memoryMiB * MiB,
      shmBytes: c.spec.shmMiB * MiB,
      ...(c.spec.network ? { networks: [c.spec.network] } : {}),
    };
  }
  async list(labels: Record<string, string>) {
    const out: PcContainerInfo[] = [];
    for (const name of this.containers.keys()) {
      const info = await this.inspect(name);
      if (info && hasLabels(info.labels, labels)) out.push(info);
    }
    return out;
  }
  async diskUsage() {
    return this.usage;
  }
  async exec(): Promise<ExecResult> {
    return { code: 0, signal: null, stdout: '', stderr: '', ms: 0, timedOut: false };
  }
}

const serving = JSON.stringify({
  status: 'HEALTH_STATUS_SERVING',
  components: [{ name: 'desktop', status: 'HEALTH_STATUS_SERVING' }],
});
const notServing = JSON.stringify({ status: 'HEALTH_STATUS_NOT_SERVING', components: [] });

function fakePool(
  cachesDir: string,
  connects: { url: string; token: string | undefined }[] = [],
  health: { json: string } = { json: serving },
) {
  const mod: CuaModule = {
    embedded: () => ({
      spacesd: async (url, token) => {
        connects.push({ url, token });
        return { health: async () => health.json } as never;
      },
    }),
    ImageFormat: { Png: 0, Jpeg: 1, Webp: 2 },
  };
  return new SpacesdPool({ cachesDir, loader: async () => mod, healthTimeoutMs: 200 });
}

const INST = 'unit';
const cname = (id: string) => `mv-pc-${INST}-${id}`;

let dir: string;
let vault: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcm-')));
  vault = join(dir, 'Code', 'foo');
  mkdirSync(join(vault, '.git'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(
  driver = new FakeDriver(),
  opts: {
    connects?: { url: string; token: string | undefined }[];
    health?: { json: string };
    stateDir?: string;
    instanceId?: string | null;
    bootTimeoutMs?: number;
  } = {},
) {
  const connects = opts.connects ?? [];
  const m = new PcManager({
    stateDir: opts.stateDir ?? join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches'), connects, opts.health),
    labelValue: 'pc-test',
    ...(opts.instanceId === null ? {} : { instanceId: opts.instanceId ?? INST }),
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: opts.bootTimeoutMs ?? 2000,
    imageBuild: { contextDir: dir, file: join(dir, 'Containerfile') },
  });
  return { m, driver, connects };
}

describe('PcManager persistence', () => {
  it('creates linux-1 on first init and persists pcs.json (0600)', async () => {
    const { m } = manager();
    const pcs = await m.init();
    expect(pcs.map((p) => [p.id, p.type, p.cpus, p.memMiB, p.slot])).toEqual([
      ['linux-1', 'linux', 2, 4096, 1],
    ]);
    expect(statSync(m.pcsFile).mode & 0o777).toBe(0o600);
    expect(statSync(m.tokensDir).mode & 0o777).toBe(0o700);
    const again = manager();
    expect((await again.m.init()).map((p) => p.id)).toEqual(['linux-1']);
  });

  it('refuses unavailable types', async () => {
    host.diskFreeBytes = 499 * GiB;
    const { m } = manager();
    await m.init();
    await expect(m.create({ type: 'windows' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const { pc } = await m.create({ type: 'macos' });
    expect(pc.id).toBe('mac-1');
    await expect(m.start('mac-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(m.status('mac-1').status).toBe('error');
  });

  it('M8: concurrent saves coalesce; the file ends with every change', async () => {
    host.diskFreeBytes = 999 * GiB;
    const { m } = manager();
    await m.init({ createDefault: false });
    for (const id of ['a', 'b', 'c', 'd']) await m.create({ type: 'linux', id });
    await Promise.all([
      m.setPinned('a', true),
      m.markUsed('b'),
      m.setPinned('c', true),
      m.setPlugged('d', false),
      m.setPinned('b', true),
    ]);
    const file = JSON.parse(readFileSync(m.pcsFile, 'utf8')) as {
      pcs: { id: string; pinned: boolean; plugged: boolean; lastUsedAt?: number }[];
    };
    const by = Object.fromEntries(file.pcs.map((p) => [p.id, p]));
    expect([by.a?.pinned, by.b?.pinned, by.c?.pinned, by.d?.plugged]).toEqual([true, true, true, false]);
    expect(by.b?.lastUsedAt).toBeGreaterThan(0);
  });

  it('M9: concurrent creates never get the same id', async () => {
    host.diskFreeBytes = 999 * GiB;
    const { m } = manager();
    await m.init({ createDefault: false });
    const made = await Promise.all([
      m.create({ type: 'linux', mounts: [{ host: vault, ro: true }] }),
      m.create({ type: 'linux' }),
      m.create({ type: 'linux' }),
    ]);
    expect(made.map((r) => r.pc.id).sort()).toEqual(['linux-1', 'linux-2', 'linux-3']);
    expect(new Set(made.map((r) => r.pc.slot)).size).toBe(3);
    const twice = await Promise.allSettled([
      m.create({ type: 'linux', id: 'x' }),
      m.create({ type: 'linux', id: 'x' }),
    ]);
    expect(twice.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((twice[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'BUSY' });
    expect(m.list().filter((p) => p.id === 'x')).toHaveLength(1);
  });

  it('L4: validates create inputs', async () => {
    const { m } = manager();
    await m.init({ createDefault: false });
    const bad = [
      { type: 'linux' as const, cpus: Number.NaN },
      { type: 'linux' as const, memMiB: -1 },
      { type: 'linux' as const, memMiB: 2048, shmMiB: 4096 },
      { type: 'linux' as const, disk: { rootfsGiB: -1 } },
      { type: 'linux' as const, disk: { homeGiB: 0 } },
      { type: 'linux' as const, image: 'evil/image:latest' },
      { type: 'linux' as const, id: 'Bad Id' },
      { type: 'nope' as never },
    ];
    for (const o of bad) await expect(m.create(o)).rejects.toMatchObject({ code: 'INVALID' });
    expect(m.list()).toEqual([]);
    const ok = await m.create({
      type: 'linux',
      image: 'ghcr.io/jasperaelvoet/minevibe-linux-pc:1.0.0',
      memMiB: 2048,
    });
    expect(ok.pc.shmMiB).toBeLessThanOrEqual(ok.pc.memMiB);
    expect(ok.pc.shmMiB).toBe(1024);
    await expect(m.resize(ok.pc.id, { memMiB: 2048, shmMiB: 3000 })).rejects.toMatchObject({
      code: 'INVALID',
    });
  });

  it('M1: the instance id comes from the state dir and scopes names and labels', async () => {
    const a = manager(new FakeDriver(), { instanceId: null, stateDir: join(dir, 'state-a') });
    const b = manager(a.driver, { instanceId: null, stateDir: join(dir, 'state-b') });
    expect(a.m.instanceId).toBe(instanceIdFor(join(dir, 'state-a')));
    expect(a.m.instanceId).not.toBe(b.m.instanceId);
    await a.m.init();
    await b.m.init();
    await a.m.bootAll();
    await b.m.bootAll();
    // Both have a linux-1, on one shared runtime, without clobbering each other.
    expect([...a.driver.containers.keys()].sort()).toEqual(
      [a.m.containerNameOf('linux-1'), b.m.containerNameOf('linux-1')].sort(),
    );
    await a.m.decommission('linux-1');
    expect(a.driver.containers.has(b.m.containerNameOf('linux-1'))).toBe(true);
    expect([...a.driver.volumes.keys()].every((v) => v.includes(b.m.instanceId))).toBe(true);
    expect(b.m.status('linux-1').status).toBe('running');
  });
});

describe('boot', () => {
  it('boots linux-1: create → start, capped volumes, own network, loopback port, token by env only', async () => {
    const { m, driver, connects } = manager();
    await m.init();
    const states: PcView[][] = [];
    m.on('pc.state', (v) => {
      states.push(v);
    });
    const r = await m.bootAll();
    expect(r.booted).toEqual(['linux-1']);
    expect(driver.log.filter((l) => !l.startsWith('engine'))).toEqual([
      `net ${cname('linux-1')}-net`,
      `create ${cname('linux-1')}`,
      `start ${cname('linux-1')}`,
    ]);
    const c = driver.containers.get(cname('linux-1'));
    expect(c?.spec).toMatchObject({
      image: 'minevibe/linux-pc:dev',
      cpus: 2,
      memoryMiB: 4096,
      shmMiB: 2048,
      network: `${cname('linux-1')}-net`,
      labels: {
        minevibe: 'pc-test',
        'minevibe.instance': INST,
        'minevibe.pc': 'linux-1',
        'minevibe.type': 'linux',
      },
      volumes: [
        { name: `${cname('linux-1')}-home`, target: '/home/cua', sizeGiB: 32 },
        { name: `${cname('linux-1')}-tmp`, target: '/tmp', sizeGiB: 8 },
        { name: `${cname('linux-1')}-vartmp`, target: '/var/tmp', sizeGiB: 4 },
      ],
      binds: [],
      env: {},
    });
    expect(driver.networks.get(`${cname('linux-1')}-net`)).toEqual({
      minevibe: 'pc-test',
      'minevibe.instance': INST,
      'minevibe.pc': 'linux-1',
    });
    const token = readFileSync(join(m.tokensDir, 'linux-1.token'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(m.tokensDir, 'linux-1.token')).mode & 0o777).toBe(0o600);
    expect(c?.spec.secretEnv).toEqual({ CUA_ENV_TOKEN: token });
    expect(readFileSync(m.pcsFile, 'utf8')).not.toContain(token);
    expect(connects[0]).toEqual({ url: `http://127.0.0.1:${c?.spec.hostPort}`, token });
    expect(m.status('linux-1').status).toBe('running');
    expect(states.some((s) => s[0]?.status === 'booting')).toBe(true);
    expect(states.at(-1)?.[0]).toMatchObject({ pcId: 'linux-1', status: 'running', display: [1280, 800] });
  });

  it('mounts the Vault path-identically with overlays (mountpoint pre-created, MV_CHOWN_PATHS)', async () => {
    const { m, driver } = manager();
    await m.init({ createDefault: false });
    await m.create({
      type: 'linux',
      id: 'dev-1',
      mounts: [{ host: vault, ro: true, overlays: ['node_modules'] }],
      boot: true,
    });
    const spec = driver.containers.get(cname('dev-1'))?.spec;
    expect(spec?.binds).toEqual([{ source: vault, target: vault, readonly: true }]);
    expect(spec?.volumes[3]).toMatchObject({ target: join(vault, 'node_modules'), sizeGiB: 16 });
    expect(spec?.env).toEqual({ MV_CHOWN_PATHS: join(vault, 'node_modules') });
    expect(existsSync(join(vault, 'node_modules'))).toBe(true);
  });

  it('refuses a Vault path that is not allowed', async () => {
    const { m } = manager();
    await m.init();
    await expect(m.setMounts('linux-1', [{ host: join(dir, 'state') }])).rejects.toMatchObject({
      code: 'PATH_REFUSED',
    });
  });

  it('marks PCs that do not fit as no_capacity', async () => {
    host = { cpus: 8, memBytes: 24 * GiB, diskFreeBytes: 199 * GiB }; // RAM pool 0.5 GiB
    const { m, driver } = manager();
    await m.init();
    const r = await m.bootAll();
    expect(r.refused).toEqual(['linux-1']);
    expect(m.status('linux-1')).toMatchObject({
      status: 'no_capacity',
      detail: expect.stringMatching(/RAM/),
    });
    expect(driver.containers.size).toBe(0);
  });

  it('boots pinned and recently used PCs first and skips unplugged ones', async () => {
    host = { cpus: 18, memBytes: 34 * GiB, diskFreeBytes: 499 * GiB }; // RAM pool 10.5 GiB: two 4 GiB PCs
    const { m, driver } = manager();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a' });
    await m.create({ type: 'linux', id: 'b' });
    await m.create({ type: 'linux', id: 'c' });
    await m.create({ type: 'linux', id: 'off', plugged: false });
    await m.setPinned('c', true);
    await m.markUsed('b');
    const r = await m.bootAll();
    expect(r.booted).toEqual(['c', 'b']);
    expect(m.status('a').status).toBe('no_capacity');
    expect(m.status('off').status).toBe('off');
    expect([...driver.containers.keys()].sort()).toEqual([cname('b'), cname('c')]);
  });

  it('shows engine_down when the engine is foreign or wedged', async () => {
    const driver = new FakeDriver();
    driver.engineError = new EngineError('ENGINE_FOREIGN', 'other');
    const { m } = manager(driver);
    await m.init();
    expect(await m.engineUp()).toBe(false);
    expect(m.status('linux-1')).toMatchObject({ status: 'engine_down', detail: /another container/ });
    await expect(m.start('linux-1')).rejects.toMatchObject({ code: 'ENGINE_DOWN' });
  });
});

describe('H1: the Vault is re-checked before every create and start', () => {
  it('refuses to start after the mount folder was swapped for a symlink to $HOME', async () => {
    const { m, driver } = manager();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'v', mounts: [{ host: vault }] });
    renameSync(vault, `${vault}-real`);
    symlinkSync(join(dir, 'home'), vault);
    const err = await m.start('v').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PATH_REFUSED', message: /symlink/ });
    expect(m.status('v')).toMatchObject({ status: 'error', reason: 'vault_refused' });
    expect(driver.containers.size).toBe(0);
  });

  it('refuses to restart an existing container after a swap (reuse path)', async () => {
    const { m, driver } = manager();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'v', mounts: [{ host: vault }], boot: true });
    await m.stop('v');
    driver.log.length = 0;
    renameSync(vault, `${vault}-real`);
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), vault);
    await expect(m.start('v')).rejects.toMatchObject({ code: 'PATH_REFUSED' });
    expect(driver.log.some((l) => l.startsWith('start') || l.startsWith('create'))).toBe(false);
    expect(driver.containers.get(cname('v'))?.state).toBe('stopped');
  });

  it('refuses cross-PC nesting under a read-write mount, allows it under a read-only one', async () => {
    host.diskFreeBytes = 999 * GiB;
    const { m } = manager();
    await m.init({ createDefault: false });
    const code = join(dir, 'Code');
    await m.create({ type: 'linux', id: 'outer', mounts: [{ host: code }] });
    await expect(m.create({ type: 'linux', id: 'inner', mounts: [{ host: vault }] })).rejects.toMatchObject({
      code: 'PATH_REFUSED',
      message: /outer mounts read-write/,
    });
    await m.setMounts('outer', [{ host: code, ro: true }]);
    await m.create({ type: 'linux', id: 'inner', mounts: [{ host: vault }] });
    // The same folder in two PCs is fine.
    await m.create({ type: 'linux', id: 'twin', mounts: [{ host: vault, ro: true }] });
    // Making the outer one writable again is refused now.
    await expect(m.setMounts('outer', [{ host: code }])).rejects.toMatchObject({ code: 'PATH_REFUSED' });
  });
});

describe('recreate, reimage, decommission', () => {
  it('resize = recreate keeping volumes; the token rotates', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    const tok1 = readFileSync(join(m.tokensDir, 'linux-1.token'), 'utf8');
    driver.log.length = 0;
    const res = await m.resize('linux-1', { cpus: 4, memMiB: 8192 });
    expect(res.restarted).toBe(true);
    expect(driver.log).toEqual([
      `stop ${cname('linux-1')}`,
      `rm ${cname('linux-1')}`,
      `create ${cname('linux-1')}`,
      `start ${cname('linux-1')}`,
    ]);
    expect(driver.containers.get(cname('linux-1'))?.spec).toMatchObject({ cpus: 4, memoryMiB: 8192 });
    expect(driver.volumes.has(`${cname('linux-1')}-home`)).toBe(true);
    expect(readFileSync(join(m.tokensDir, 'linux-1.token'), 'utf8')).not.toBe(tok1);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('an over-budget resize is refused and changes nothing', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.log.length = 0;
    const err = await m.resize('linux-1', { memMiB: 30 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PcError);
    expect(err).toMatchObject({ code: 'OVER_BUDGET', resource: 'memory' });
    expect(m.get('linux-1')?.memMiB).toBe(4096);
    expect(driver.log).toEqual([]);
  });

  it('H5: a CPU-only resize never fails on disk; growing the disk is charged only the growth', async () => {
    const { m } = manager();
    await m.init();
    await m.bootAll();
    // Free disk shrank (the PC's own volumes filled up): the caps no longer "fit" as a whole.
    host = { ...host, diskFreeBytes: 30 * GiB };
    await expect(m.resize('linux-1', { cpus: 3 })).resolves.toMatchObject({ restarted: true });
    const err = await m
      .setMounts('linux-1', [{ host: vault, overlays: ['node_modules'] }])
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'OVER_BUDGET', resource: 'disk', message: /16\.0 GiB more disk/ });
    host = { ...host, diskFreeBytes: 199 * GiB };
    await expect(m.setMounts('linux-1', [{ host: vault, overlays: ['node_modules'] }])).resolves.toBeTruthy();
  });

  it('H5: measured disk usage of PC volumes counts back into the pool', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    const before = await m.budget();
    driver.usage.set(`${cname('linux-1')}-home`, 10 * GiB);
    driver.usage.set(cname('linux-1'), 100 * GiB); // capped at the 24 GiB rootfs allowance
    const after = await m.budget();
    expect(after.host.diskUsedByPcsBytes).toBe(34 * GiB);
    expect(after.pool.diskBytes - before.pool.diskBytes).toBe(34 * GiB);
  });

  it('resizing a stopped PC deletes the container and leaves it off', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    await m.resize('linux-1', { cpus: 3 });
    expect(driver.containers.size).toBe(0);
    expect(m.status('linux-1').status).toBe('off');
    await m.start('linux-1');
    expect(driver.containers.get(cname('linux-1'))?.spec.cpus).toBe(3);
  });

  it('stop/start reuses the container and its token', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    expect(m.status('linux-1').status).toBe('off');
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log).toEqual([`start ${cname('linux-1')}`]);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('M10: a container that no longer matches its record is recreated, not reused', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    const c = driver.containers.get(cname('linux-1')) as FakeContainer;
    c.spec = { ...c.spec, memoryMiB: 2048 }; // e.g. a resize whose recreate failed half-way
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log).toEqual([
      `stop ${cname('linux-1')}`,
      `rm ${cname('linux-1')}`,
      `create ${cname('linux-1')}`,
      `start ${cname('linux-1')}`,
    ]);
    expect(driver.containers.get(cname('linux-1'))?.spec.memoryMiB).toBe(4096);
  });

  it('M2: only a port conflict recreates; any other start failure is an error and keeps the rootfs', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    driver.startErrors.push('kernel panic in vminitd');
    driver.log.length = 0;
    await expect(m.start('linux-1')).rejects.toThrow(/kernel panic/);
    expect(driver.log.filter((l) => l.startsWith('rm') || l.startsWith('create'))).toEqual([]);
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'boot_failed' });
    expect(driver.containers.has(cname('linux-1'))).toBe(true);

    driver.startErrors.push('bind: address already in use');
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log).toEqual([
      `start ${cname('linux-1')}`,
      `stop ${cname('linux-1')}`,
      `rm ${cname('linux-1')}`,
      `create ${cname('linux-1')}`,
      `start ${cname('linux-1')}`,
    ]);
    expect(driver.volumes.has(`${cname('linux-1')}-home`)).toBe(true);
    expect(m.status('linux-1').status).toBe('running');
    expect(isPortConflictError(new Error('Address already in use'))).toBe(true);
    expect(isPortConflictError(new Error('bind mount failed'))).toBe(false);
  });

  it('M1: never reuses or removes a same-named container of another instance', async () => {
    const { m, driver } = manager();
    await m.init();
    driver.containers.set(cname('linux-1'), {
      spec: { ...(await fakeSpec()), name: cname('linux-1') },
      state: 'stopped',
      labels: { minevibe: 'pc-test', 'minevibe.instance': 'other', 'minevibe.pc': 'linux-1' },
    });
    await expect(m.start('linux-1')).rejects.toMatchObject({ code: 'BUSY' });
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'not_ours' });
    expect(driver.log.filter((l) => /^(rm|stop|start|create)/.test(l))).toEqual([]);
    await expect(m.decommission('linux-1')).rejects.toMatchObject({ code: 'BUSY' });
    expect(driver.containers.has(cname('linux-1'))).toBe(true);
  });

  it('reimage drops the home volume; decommission removes container, volumes, network, token and record', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.volumes.set('hand-made', { labels: {}, sizeGiB: 1 });
    await m.reimage('linux-1');
    expect(driver.log).toContain(`rmvol ${cname('linux-1')}-home`);
    expect(m.status('linux-1').status).toBe('running');
    await m.decommission('linux-1');
    expect(driver.containers.size).toBe(0);
    expect([...driver.volumes.keys()]).toEqual(['hand-made']);
    expect(driver.networks.size).toBe(0);
    expect(existsSync(join(m.tokensDir, 'linux-1.token'))).toBe(false);
    expect(m.list()).toEqual([]);
  });

  it('L7: a failed reimage or decommission leaves error, never a stuck status', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.removeVolume = async () => {
      throw new Error('volume busy');
    };
    await expect(m.reimage('linux-1')).rejects.toThrow(/volume busy/);
    expect(m.status('linux-1').status).toBe('error');
    await expect(m.decommission('linux-1')).rejects.toThrow(/volume busy/);
    expect(m.status('linux-1').status).toBe('error');
    expect(m.get('linux-1')).toBeDefined();
  });
});

async function fakeSpec(): Promise<PcRunSpec> {
  return {
    name: 'x',
    image: 'minevibe/linux-pc:dev',
    cpus: 2,
    memoryMiB: 4096,
    shmMiB: 2048,
    hostPort: 45000,
    binds: [],
    volumes: [],
    labels: {},
    env: {},
    secretEnv: {},
  };
}

describe('H4: what actually runs is what the budget counts', () => {
  it('a boot that never reaches SERVING stops its container and shows error', async () => {
    const health = { json: notServing };
    const { m, driver } = manager(new FakeDriver(), { health, bootTimeoutMs: 300 });
    await m.init();
    await expect(m.start('linux-1')).rejects.toThrow(/not serving/);
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'boot_failed' });
    expect(driver.containers.get(cname('linux-1'))?.state).toBe('stopped');
  });

  it('a container that keeps running after a failed stop still counts', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.stopError = 'xpc timeout';
    await expect(m.stop('linux-1')).rejects.toThrow(/xpc timeout/);
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'stop_failed' });
    const b = await m.budget();
    expect(b.allocated.memBytes).toBe((4096 + 256) * MiB);
    expect(b.allocated.cpus).toBe(3);
    // Shutdown stops it too, although its status is `error`.
    driver.stopError = null;
    await m.shutdown();
    expect(driver.containers.get(cname('linux-1'))?.state).toBe('stopped');
  });

  it('the monitor marks a crashed PC and stops a container that should not run', async () => {
    const { m, driver } = manager();
    await m.init({ createDefault: false });
    await m.create({ type: 'linux', id: 'a', boot: true });
    await m.create({ type: 'linux', id: 'b', boot: true });
    (driver.containers.get(cname('a')) as FakeContainer).state = 'stopped'; // crashed behind our back
    await m.stop('b');
    (driver.containers.get(cname('b')) as FakeContainer).state = 'running'; // e.g. a late, timed-out create
    await m.monitorOnce();
    expect(m.status('a')).toMatchObject({ status: 'error', reason: 'crashed' });
    expect(driver.containers.get(cname('b'))?.state).toBe('stopped');
    expect(m.status('b').status).toBe('off');
  });

  it('the monitor marks a PC whose spacesd stops answering', async () => {
    const health = { json: serving };
    const { m } = manager(new FakeDriver(), { health });
    await m.init();
    await m.bootAll();
    health.json = notServing;
    for (let i = 0; i < 3; i++) await m.monitorOnce();
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'unresponsive' });
  });
});

describe('M6: free-disk watchdog', () => {
  it('warns below 20 GiB, stops PCs below 10 GiB with error/low_disk, and refuses to start them', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    const events: { level: string }[] = [];
    m.on('host.disk', (e) => {
      events.push(e);
    });
    host = { ...host, diskFreeBytes: 15 * GiB };
    await m.monitorOnce();
    expect(events.map((e) => e.level)).toEqual(['low']);
    expect(m.status('linux-1').status).toBe('running');
    host = { ...host, diskFreeBytes: 9 * GiB };
    await m.monitorOnce();
    expect(events.map((e) => e.level)).toEqual(['low', 'critical']);
    expect(m.status('linux-1')).toMatchObject({ status: 'error', reason: 'low_disk' });
    expect(driver.containers.get(cname('linux-1'))?.state).toBe('stopped');
    await expect(m.start('linux-1')).rejects.toMatchObject({ code: 'OVER_BUDGET', resource: 'disk' });
    expect(m.views()[0]).toMatchObject({ status: 'error', reason: 'low_disk' });
  });
});

describe('reconcile and shutdown', () => {
  it('adopts matching running containers, stops mismatched ones and orphans without deleting them', async () => {
    const first = manager();
    await first.m.init({ createDefault: false });
    await first.m.create({ type: 'linux', id: 'linux-1', boot: true });
    await first.m.create({ type: 'linux', id: 'linux-2', boot: true });
    const driver = first.driver;
    const base = driver.containers.get(cname('linux-1'))?.spec as PcRunSpec;
    // An orphan with our labels but no record, and a container of another instance.
    await driver.run({ ...base, name: cname('ghost'), labels: { ...base.labels, 'minevibe.pc': 'ghost' } });
    await driver.run({
      ...base,
      name: 'mv-pc-other-linux-1',
      labels: { ...base.labels, 'minevibe.instance': 'other' },
    });
    // linux-2 was resized behind our back.
    const two = driver.containers.get(cname('linux-2')) as FakeContainer;
    two.spec = { ...two.spec, cpus: 7 };
    const { m } = manager(driver);
    await m.init();
    const r = await m.reconcile();
    expect(r).toEqual({ adopted: ['linux-1'], orphans: [cname('ghost')], mismatched: ['linux-2'] });
    expect(driver.containers.get(cname('ghost'))?.state).toBe('stopped');
    expect(driver.containers.get('mv-pc-other-linux-1')?.state).toBe('running');
    expect(driver.containers.get(cname('linux-2'))?.state).toBe('stopped');
    expect(m.status('linux-1').status).toBe('booting');
    expect(m.status('linux-2').status).toBe('off');
    driver.log.length = 0;
    await m.bootAll();
    expect(m.status('linux-1').status).toBe('running');
    expect(m.status('linux-2').status).toBe('running');
    expect(driver.log.filter((l) => l.startsWith('create'))).toEqual([`create ${cname('linux-2')}`]);
  });

  it('L1: a container publishing spacesd beyond loopback is never adopted or started', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.publishAddress = '0.0.0.0';
    const again = manager(driver);
    await again.m.init();
    expect((await again.m.reconcile()).mismatched).toEqual(['linux-1']);
    driver.containers.clear();
    await expect(again.m.start('linux-1')).rejects.toThrow(/not 127\.0\.0\.1/);
    expect(again.m.status('linux-1').status).toBe('error');
  });

  it('shutdown stops active PCs and the engine', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.shutdown();
    expect(driver.containers.get(cname('linux-1'))?.state).toBe('stopped');
    expect(driver.log.at(-1)).toBe('engine-stop');
    expect(m.status('linux-1').status).toBe('off');
  });

  it('reports the budget with the cpu+1 overhead, the per-VM memory overhead and every disk cap', async () => {
    const { m } = manager();
    await m.init();
    await m.bootAll();
    const b = await m.budget();
    expect(b.allocated.cpus).toBe(3);
    expect(b.allocated.memBytes).toBe((4096 + 256) * MiB);
    expect(b.allocated.diskBytes).toBe(68 * GiB); // rootfs 24 + home 32 + tmp 8 + var/tmp 4
  });
});

describe('L11: budget details', () => {
  it('the crew-cap setter recomputes the claude reserve', async () => {
    const { m } = manager();
    await m.init();
    expect((await m.budget()).pool.memBytes).toBe(24.5 * GiB);
    expect((await m.setCrewCap(6)).pool.memBytes).toBe(22.5 * GiB);
    await expect(m.setCrewCap(-1)).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('reserves the builder VM while an image build runs', async () => {
    const driver = new FakeDriver();
    const { m } = manager(driver);
    await m.init();
    let during = 0;
    driver.onBuild = async () => {
      during = (await m.budget()).pool.memBytes;
    };
    await m.ensureImage('minevibe/linux-pc:dev').catch(() => {});
    driver.imagePresent = false;
    await m.ensureImage('minevibe/linux-pc:dev');
    expect(during).toBe(22.5 * GiB);
    expect((await m.budget()).pool.memBytes).toBe(24.5 * GiB);
    expect(m.building).toBe(false);
  });

  it('counts orphaned overlay volumes against the disk and can remove them', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.setMounts('linux-1', [{ host: vault, overlays: ['node_modules'] }]);
    await m.start('linux-1');
    const withOverlay = (await m.budget()).allocated.diskBytes;
    await m.setMounts('linux-1', []);
    // The old overlay volume stays on disk (it may hold a big node_modules) and stays counted.
    expect((await m.budget()).allocated.diskBytes).toBe(withOverlay);
    const orphans = await m.orphanVolumes({ remove: true });
    expect(orphans).toHaveLength(1);
    expect(driver.volumes.has(orphans[0] as string)).toBe(false);
    expect((await m.budget()).allocated.diskBytes).toBe(withOverlay - 16 * GiB);
  });
});
