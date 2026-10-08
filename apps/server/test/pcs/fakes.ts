/**
 * Shared fakes for the PcManager unit tests: an in-memory container driver and a spacesd pool whose
 * health answers (and latency) the test controls.
 */
import { GiB, MiB } from '../../src/pcs/Budget.js';
import type { ExecResult } from '../../src/pcs/drivers/exec.js';
import {
  hasLabels,
  type NetworkInfo,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
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
                  return {
                    exit: { success: true, code: 0 },
                    stdout: new ArrayBuffer(0),
                    stderr: new ArrayBuffer(0),
                  };
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
