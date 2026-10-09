/**
 * Shared fakes for the PcManager unit tests: an in-memory container driver and a spacesd pool whose
 * health answers (and latency) the test controls.
 */
import { GiB, MiB } from '../../src/pcs/Budget.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import {
  type AndroidDriverOps,
  hasLabels,
  type NetworkInfo,
  type OneShotSpec,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  type PhoneRunSpec,
  TOKEN_ENV,
  tokenFingerprint,
  type VolumeInfo,
  type VolumeMount,
} from '../../src/pcs/drivers/PcDriver.js';
import { type CuaModule, SpacesdPool } from '../../src/pcs/SpacesdPool.js';

export type FakeContainer = {
  spec: PcRunSpec;
  state: 'running' | 'stopped';
  labels: Record<string, string>;
};

export class FakeDriver implements PcDriver {
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
  /** Host address `inspect` reports for the spacesd port (undefined = none reported). */
  publishAddress: string | undefined = '127.0.0.1';
  usage = new Map<string, number>();
  building = false;
  onBuild: (() => Promise<void>) | null = null;
  imagePresent = true;
  inspects = 0;

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
    this.inspects++;
    const c = this.containers.get(name);
    if (!c) return null;
    const token = c.spec.secretEnv[TOKEN_ENV];
    return {
      name,
      state: c.state,
      image: c.spec.image,
      labels: c.labels,
      hostPort: c.spec.hostPort,
      ...(this.publishAddress !== undefined ? { hostAddress: this.publishAddress } : {}),
      binds: c.spec.binds,
      volumes: c.spec.volumes.map((v) => ({ name: v.name, target: v.target })),
      cpus: c.spec.cpus,
      memoryBytes: c.spec.memoryMiB * MiB,
      shmBytes: c.spec.shmMiB * MiB,
      ...(c.spec.network ? { networks: [c.spec.network] } : {}),
      ...(token ? { tokenSha256: tokenFingerprint(token) } : {}),
      virtualization: c.spec.virtualization ?? false,
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
  async exec(
    _name: string,
    _argv: readonly string[],
    _options: { user?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return { code: 0, signal: null, stdout: '', stderr: '', ms: 0, timedOut: false };
  }
}

export const serving = JSON.stringify({
  status: 'HEALTH_STATUS_SERVING',
  components: [{ name: 'desktop', status: 'HEALTH_STATUS_SERVING' }],
});
export const notServing = JSON.stringify({ status: 'HEALTH_STATUS_NOT_SERVING', components: [] });

/** What the fake spacesd answers: health JSON, an optional delay for one URL, and a probe count. */
export interface FakeHealth {
  json: string;
  /** Health of this URL takes `slowMs` (a PC under load). */
  slowUrl?: string | null;
  slowMs?: number;
  /** Health probes answered so far, by URL. */
  probes?: Map<string, number>;
  /** Guest commands (`run`) received, with the URL of the PC; absent: the fake has no `run`. */
  runs?: { url: string; program: string; args: string[]; user?: string; env: Map<string, string> }[];
  /** What a `run` prints (default: nothing). */
  runStdout?: (cmd: { program: string; args: string[] }) => string;
  /** spacesd `displays()` JSON (absent: the fake has no `displays`). */
  displays?: string;
  /** Keyboard and pointer JSON received (absent: the fake has no input calls). */
  input?: string[];
}

export function fakePool(
  cachesDir: string,
  connects: { url: string; token: string | undefined }[] = [],
  health: FakeHealth = { json: serving },
  options: { healthTimeoutMs?: number } = {},
) {
  const mod: CuaModule = {
    embedded: () => ({
      spacesd: async (url, token) => {
        connects.push({ url, token });
        return {
          health: async () => {
            health.probes?.set(url, (health.probes.get(url) ?? 0) + 1);
            if (health.slowUrl && url === health.slowUrl) {
              await new Promise((r) => setTimeout(r, health.slowMs ?? 400));
            }
            return health.json;
          },
          ...(health.runs
            ? {
                run: async (cmd: {
                  program: string;
                  args: string[];
                  user?: string;
                  env: Map<string, string>;
                }) => {
                  health.runs?.push({ url, ...cmd });
                  const out = new TextEncoder().encode(health.runStdout?.(cmd) ?? '');
                  return {
                    exit: { success: true, code: 0 },
                    stdout: out.buffer,
                    stderr: new ArrayBuffer(0),
                  };
                },
              }
            : {}),
          ...(health.displays !== undefined ? { displays: async () => health.displays } : {}),
          ...(health.input
            ? {
                keyboardJson: async (j: string) => {
                  health.input?.push(`keyboard ${j}`);
                  return '{}';
                },
                pointerJson: async (j: string) => {
                  health.input?.push(`pointer ${j}`);
                  return '{}';
                },
              }
            : {}),
        } as never;
      },
    }),
    ImageFormat: { Png: 0, Jpeg: 1, Webp: 2 },
  };
  return new SpacesdPool({
    cachesDir,
    loader: async () => mod,
    healthTimeoutMs: options.healthTimeoutMs ?? 200,
  });
}

/** One phone container of {@link FakeAndroidDriver}. */
export type FakePhone = { spec: PhoneRunSpec; state: 'running' | 'stopped'; ip: string };

/**
 * A {@link FakeDriver} with the Android ops (PLAN §8.8): phones are kept apart from PC containers, boot at once
 * (`getprop sys.boot_completed` answers 1 while running) and get the next address of 192.168.64.x.
 */
export class FakeAndroidDriver extends FakeDriver implements AndroidDriverOps {
  readonly android: AndroidDriverOps = this;
  phones = new Map<string, FakePhone>();
  /** `exec` calls: container, argv and user. */
  execs: { name: string; argv: readonly string[]; user?: string }[] = [];
  /** Answer of `getprop sys.boot_completed` (a phone that never boots: '0'). */
  bootCompleted = '1';
  images = new Map<string, string>();
  oneShots: OneShotSpec[] = [];
  #nextIp = 10;

  async saveImage(ref: string, file: string) {
    this.log.push(`save ${ref} ${file}`);
  }
  async loadImage(file: string) {
    this.log.push(`load ${file}`);
  }
  async removeImage(ref: string) {
    this.images.delete(ref);
  }
  async imageDigest(ref: string) {
    return this.images.get(ref) ?? null;
  }
  async runOnce(spec: OneShotSpec, _onOutput?: (line: string) => void) {
    this.oneShots.push(spec);
  }
  async createPhone(spec: PhoneRunSpec) {
    this.log.push(`create-phone ${spec.name}`);
    if (spec.data) await this.ensureVolume(spec.data, spec.ownerLabels);
    this.phones.set(spec.name, { spec, state: 'stopped', ip: `192.168.64.${this.#nextIp++}` });
    return (await this.inspect(spec.name)) as PcContainerInfo;
  }
  override async start(name: string) {
    const ph = this.phones.get(name);
    if (!ph) return super.start(name);
    this.log.push(`start ${name}`);
    ph.state = 'running';
  }
  override async stop(name: string) {
    const ph = this.phones.get(name);
    if (!ph) return super.stop(name);
    this.log.push(`stop ${name}`);
    ph.state = 'stopped';
  }
  override async remove(name: string) {
    if (!this.phones.has(name)) return super.remove(name);
    this.log.push(`rm ${name}`);
    this.phones.delete(name);
  }
  override async inspect(name: string): Promise<PcContainerInfo | null> {
    const ph = this.phones.get(name);
    if (!ph) return super.inspect(name);
    return {
      name,
      state: ph.state,
      image: ph.spec.image,
      labels: ph.spec.labels,
      binds: [],
      volumes: ph.spec.data ? [{ name: ph.spec.data.name, target: '/data' }] : [],
      cpus: ph.spec.cpus,
      memoryBytes: ph.spec.memoryMiB * MiB,
      networks: [ph.spec.network],
      ...(ph.state === 'running' ? { ipv4: ph.ip } : {}),
    };
  }
  override async list(labels: Record<string, string>) {
    const out = await super.list(labels);
    for (const name of this.phones.keys()) {
      const info = await this.inspect(name);
      if (info && hasLabels(info.labels, labels)) out.push(info);
    }
    return out;
  }
  override async exec(
    name: string,
    argv: readonly string[],
    options: { user?: string } = {},
  ): Promise<ExecResult> {
    this.execs.push({ name, argv, ...(options.user ? { user: options.user } : {}) });
    const ph = this.phones.get(name);
    if (ph) {
      const booted = ph.state === 'running' && argv.includes('sys.boot_completed');
      return {
        code: booted ? 0 : 1,
        signal: null,
        stdout: booted ? `${this.bootCompleted}\n` : '',
        stderr: '',
        ms: 0,
        timedOut: false,
      };
    }
    return { code: 0, signal: null, stdout: '', stderr: '', ms: 0, timedOut: false };
  }
}
