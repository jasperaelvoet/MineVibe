import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GiB, type HostFacts } from '../../src/pcs/Budget.js';
import { EngineError } from '../../src/pcs/drivers/ContainerRuntime.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import type {
  PcContainerInfo,
  PcDriver,
  PcRunSpec,
  VolumeInfo,
  VolumeMount,
} from '../../src/pcs/drivers/PcDriver.js';
import { PcError, PcManager, type PcView } from '../../src/pcs/PcManager.js';
import { type CuaModule, SpacesdPool } from '../../src/pcs/SpacesdPool.js';

class FakeDriver implements PcDriver {
  readonly kind = 'apple-container' as const;
  readonly cpuOverhead = 1;
  readonly capsVolumes = true;
  containers = new Map<
    string,
    { spec: PcRunSpec; state: 'running' | 'stopped'; labels: Record<string, string> }
  >();
  volumes = new Map<string, { labels: Record<string, string>; sizeGiB: number }>();
  log: string[] = [];
  engineError: Error | null = null;
  failStart = false;

  async ensureEngine() {
    if (this.engineError) throw this.engineError;
    this.log.push('engine');
  }
  async shutdownEngine() {
    this.log.push('engine-stop');
    return true;
  }
  async imageExists() {
    return true;
  }
  async pullImage(ref: string) {
    this.log.push(`pull ${ref}`);
  }
  async buildImage() {}
  async ensureVolume(v: VolumeMount, labels: Record<string, string>) {
    if (this.volumes.has(v.name)) return 'exists' as const;
    this.volumes.set(v.name, { labels: { ...labels }, sizeGiB: v.sizeGiB });
    return 'created' as const;
  }
  async removeVolume(name: string) {
    this.log.push(`rmvol ${name}`);
    this.volumes.delete(name);
  }
  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    return [...this.volumes]
      .filter(([, v]) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
      .map(([name, v]) => ({ name, labels: v.labels }));
  }
  async run(spec: PcRunSpec) {
    this.log.push(`run ${spec.name}`);
    for (const v of spec.volumes) await this.ensureVolume(v, spec.labels);
    this.containers.set(spec.name, { spec, state: 'running', labels: spec.labels });
  }
  async start(name: string) {
    this.log.push(`start ${name}`);
    if (this.failStart) throw new Error('port already in use');
    const c = this.containers.get(name);
    if (c) c.state = 'running';
  }
  async stop(name: string) {
    this.log.push(`stop ${name}`);
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
      labels: c.labels,
      hostPort: c.spec.hostPort,
      binds: c.spec.binds,
      volumes: c.spec.volumes.map((v) => ({ name: v.name, target: v.target })),
    };
  }
  async list(labels: Record<string, string>) {
    const out: PcContainerInfo[] = [];
    for (const name of this.containers.keys()) {
      const info = await this.inspect(name);
      if (info && Object.entries(labels).every(([k, v]) => info.labels[k] === v)) out.push(info);
    }
    return out;
  }
  async exec(): Promise<ExecResult> {
    return { code: 0, signal: null, stdout: '', stderr: '', ms: 0, timedOut: false };
  }
}

const serving = JSON.stringify({
  status: 'HEALTH_STATUS_SERVING',
  components: [{ name: 'desktop', status: 'HEALTH_STATUS_SERVING' }],
});

function fakePool(cachesDir: string, connects: { url: string; token: string | undefined }[] = []) {
  const mod: CuaModule = {
    embedded: () => ({
      spacesd: async (url, token) => {
        connects.push({ url, token });
        return { health: async () => serving } as never;
      },
    }),
    ImageFormat: { Png: 0, Jpeg: 1, Webp: 2 },
  };
  return new SpacesdPool({ cachesDir, loader: async () => mod });
}

let dir: string;
let vault: string;
let host: HostFacts;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mv-pcm-')));
  vault = join(dir, 'Code', 'foo');
  mkdirSync(join(vault, '.git'), { recursive: true });
  host = { cpus: 18, memBytes: 48 * GiB, diskFreeBytes: 199 * GiB };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manager(driver = new FakeDriver(), connects: { url: string; token: string | undefined }[] = []) {
  const m = new PcManager({
    stateDir: join(dir, 'state'),
    driver,
    pool: fakePool(join(dir, 'caches'), connects),
    labelValue: 'pc-test',
    hostFacts: async () => host,
    home: join(dir, 'home'),
    bootTimeoutMs: 2000,
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
});

describe('boot', () => {
  it('boots linux-1: capped home volume, loopback port, token by env only (0600), SERVING → running', async () => {
    const { m, driver, connects } = manager();
    await m.init();
    const states: PcView[][] = [];
    m.on('pc.state', (v) => {
      states.push(v);
    });
    const r = await m.bootAll();
    expect(r.booted).toEqual(['linux-1']);
    const c = driver.containers.get('mv-pc-linux-1');
    expect(c?.spec).toMatchObject({
      image: 'minevibe/linux-pc:dev',
      cpus: 2,
      memoryMiB: 4096,
      shmMiB: 2048,
      labels: { minevibe: 'pc-test', 'minevibe.pc': 'linux-1', 'minevibe.type': 'linux' },
      volumes: [{ name: 'mv-pc-linux-1-home', target: '/home/cua', sizeGiB: 32 }],
      binds: [],
      env: {},
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
    const spec = driver.containers.get('mv-pc-dev-1')?.spec;
    expect(spec?.binds).toEqual([{ source: vault, target: vault, readonly: true }]);
    expect(spec?.volumes[1]).toMatchObject({ target: join(vault, 'node_modules'), sizeGiB: 16 });
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
    expect([...driver.containers.keys()].sort()).toEqual(['mv-pc-b', 'mv-pc-c']);
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

describe('recreate, reimage, decommission', () => {
  it('resize = recreate keeping volumes; the token rotates', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    const tok1 = readFileSync(join(m.tokensDir, 'linux-1.token'), 'utf8');
    driver.log.length = 0;
    const res = await m.resize('linux-1', { cpus: 4, memMiB: 8192 });
    expect(res.restarted).toBe(true);
    expect(driver.log).toEqual(['stop mv-pc-linux-1', 'rm mv-pc-linux-1', 'run mv-pc-linux-1']);
    expect(driver.containers.get('mv-pc-linux-1')?.spec).toMatchObject({ cpus: 4, memoryMiB: 8192 });
    expect(driver.volumes.has('mv-pc-linux-1-home')).toBe(true);
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

  it('resizing a stopped PC deletes the container and leaves it off', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    await m.resize('linux-1', { cpus: 3 });
    expect(driver.containers.size).toBe(0);
    expect(m.status('linux-1').status).toBe('off');
    await m.start('linux-1');
    expect(driver.containers.get('mv-pc-linux-1')?.spec.cpus).toBe(3);
  });

  it('stop/start reuses the container and its token', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    expect(m.status('linux-1').status).toBe('off');
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log).toEqual(['start mv-pc-linux-1']);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('recreates the container when a plain start fails (volumes kept)', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.stop('linux-1');
    driver.failStart = true;
    driver.log.length = 0;
    await m.start('linux-1');
    expect(driver.log).toEqual(['start mv-pc-linux-1', 'rm mv-pc-linux-1', 'run mv-pc-linux-1']);
    expect(driver.volumes.has('mv-pc-linux-1-home')).toBe(true);
    expect(m.status('linux-1').status).toBe('running');
  });

  it('reimage drops the home volume; decommission removes container, volumes, token and record', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    driver.volumes.set('hand-made', { labels: {}, sizeGiB: 1 });
    await m.reimage('linux-1');
    expect(driver.log).toContain('rmvol mv-pc-linux-1-home');
    expect(m.status('linux-1').status).toBe('running');
    await m.decommission('linux-1');
    expect(driver.containers.size).toBe(0);
    expect([...driver.volumes.keys()]).toEqual(['hand-made']);
    expect(existsSync(join(m.tokensDir, 'linux-1.token'))).toBe(false);
    expect(m.list()).toEqual([]);
  });
});

describe('reconcile and shutdown', () => {
  it('adopts running containers by label, stops orphans without deleting them', async () => {
    const first = manager();
    await first.m.init();
    await first.m.bootAll();
    const driver = first.driver;
    // An orphan with our label but no record, and a container of the real app (other label).
    await driver.run({
      ...(driver.containers.get('mv-pc-linux-1')?.spec as PcRunSpec),
      name: 'mv-pc-ghost',
      labels: { minevibe: 'pc-test', 'minevibe.pc': 'ghost' },
    });
    await driver.run({
      ...(driver.containers.get('mv-pc-linux-1')?.spec as PcRunSpec),
      name: 'mv-pc-real',
      labels: { minevibe: 'pc', 'minevibe.pc': 'linux-1' },
    });
    const { m } = manager(driver);
    await m.init();
    const r = await m.reconcile();
    expect(r).toEqual({ adopted: ['linux-1'], orphans: ['mv-pc-ghost'] });
    expect(driver.containers.get('mv-pc-ghost')?.state).toBe('stopped');
    expect(driver.containers.get('mv-pc-real')?.state).toBe('running');
    expect(m.status('linux-1').status).toBe('booting');
    driver.log.length = 0;
    await m.bootAll();
    expect(m.status('linux-1').status).toBe('running');
    expect(driver.log.filter((l) => l.startsWith('run'))).toEqual([]);
  });

  it('shutdown stops active PCs and the engine', async () => {
    const { m, driver } = manager();
    await m.init();
    await m.bootAll();
    await m.shutdown();
    expect(driver.containers.get('mv-pc-linux-1')?.state).toBe('stopped');
    expect(driver.log.at(-1)).toBe('engine-stop');
    expect(m.status('linux-1').status).toBe('off');
  });

  it('reports the budget with the cpu+1 overhead', async () => {
    const { m } = manager();
    await m.init();
    await m.bootAll();
    const b = await m.budget();
    expect(b.allocated.cpus).toBe(3);
    expect(b.allocated.memBytes).toBe(4 * GiB);
    expect(b.allocated.diskBytes).toBe(56 * GiB);
  });
});
