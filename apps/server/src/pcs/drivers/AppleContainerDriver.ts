import type { Logger } from 'pino';
import type { ContainerRuntime } from './ContainerRuntime.js';
import { CliError, type ExecResult, redact } from './exec.js';
import {
  assertRunSpec,
  type BindMount,
  type ContainerState,
  mountProblems,
  orderedMounts,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  type Progress,
  SPACESD_GUEST_PORT,
  type VolumeInfo,
  type VolumeMount,
} from './PcDriver.js';

/**
 * Linux PCs on Apple `container` 1.5.0 (PLAN §8.1, §8.6).
 *
 * - Vault binds use `--mount type=bind,source=P,target=P[,readonly]`, never `-v src:dst:ro` (which
 *   silently creates a writable mount at `dst`+"o" in 1.5.0). Mounts are re-checked after `run`.
 * - Named volumes are created up front with `volume create -s <cap>` (default would be 512 GiB sparse)
 *   and mounted with `--mount type=volume,…`.
 * - spacesd is published on loopback only: `-p 127.0.0.1:<port>:3211`.
 * - The token travels as `-e CUA_ENV_TOKEN` (name only) with the value in the CLI's environment.
 */

export interface AppleContainerTimeouts {
  /** `run`: the first run of a PC whose Vault is in ~/Documents waits on a TCC prompt (S5). */
  run: number;
  start: number;
  stopGraceSeconds: number;
  pull: number;
  build: number;
  default: number;
}

const DEFAULT_TIMEOUTS: AppleContainerTimeouts = {
  run: 180_000,
  start: 120_000,
  stopGraceSeconds: 10,
  pull: 1_200_000,
  build: 3_600_000,
  default: 60_000,
};

/** Builds `container run` arguments (pure; unit-tested). */
export function buildAppleRunArgs(spec: PcRunSpec): string[] {
  assertRunSpec(spec);
  const { binds, volumes } = orderedMounts(spec);
  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--cpus',
    String(spec.cpus),
    '--memory',
    `${spec.memoryMiB}M`,
  ];
  if (spec.shmMiB > 0) args.push('--shm-size', `${spec.shmMiB}M`);
  for (const k of Object.keys(spec.secretEnv)) args.push('-e', k);
  for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  args.push('-p', `127.0.0.1:${spec.hostPort}:${SPACESD_GUEST_PORT}`);
  for (const b of binds) args.push('--mount', bindMountArg(b));
  for (const v of volumes) args.push('--mount', `type=volume,source=${v.name},target=${v.target}`);
  for (const [k, v] of Object.entries(spec.labels)) args.push('-l', `${k}=${v}`);
  args.push(spec.image);
  return args;
}

/** `type=bind,source=…,target=…[,readonly]` */
export function bindMountArg(b: BindMount): string {
  return `type=bind,source=${b.source},target=${b.target}${b.readonly ? ',readonly' : ''}`;
}

/** `volume create -s <cap>G --label k=v <name>` */
export function buildVolumeCreateArgs(v: VolumeMount, labels: Record<string, string>): string[] {
  const args = ['volume', 'create', '-s', `${Math.ceil(v.sizeGiB)}G`];
  for (const [k, val] of Object.entries(labels)) args.push('--label', `${k}=${val}`);
  args.push(v.name);
  return args;
}

interface AppleMountJson {
  destination?: string;
  source?: string;
  options?: string[];
  type?: { virtiofs?: unknown; volume?: { name?: string } };
}

interface AppleContainerJson {
  configuration?: {
    id?: string;
    labels?: Record<string, string>;
    image?: { reference?: string; descriptor?: { digest?: string } };
    mounts?: AppleMountJson[];
    publishedPorts?: { containerPort?: number; hostAddress?: string; hostPort?: number; proto?: string }[];
    resources?: { cpus?: number; cpuOverhead?: number; memoryInBytes?: number };
  };
  status?: { state?: string; networks?: { ipv4Address?: string }[] } | string;
}

const STATES: ReadonlySet<string> = new Set(['running', 'stopped', 'stopping', 'created']);

/** Parses one entry of `container inspect` / `container list --format json`. */
export function parseAppleContainer(j: AppleContainerJson): PcContainerInfo {
  const c = j.configuration ?? {};
  const statusObj = typeof j.status === 'object' && j.status ? j.status : undefined;
  const rawState = typeof j.status === 'string' ? j.status : statusObj?.state;
  const state = (rawState && STATES.has(rawState) ? rawState : 'unknown') as ContainerState;
  const binds: BindMount[] = [];
  const volumes: { name: string; target: string }[] = [];
  for (const m of c.mounts ?? []) {
    if (!m.destination) continue;
    if (m.type?.volume) volumes.push({ name: m.type.volume.name ?? '', target: m.destination });
    else if (m.type?.virtiofs !== undefined) {
      binds.push({
        source: m.source ?? '',
        target: m.destination,
        readonly: (m.options ?? []).includes('ro') || (m.options ?? []).includes('readonly'),
      });
    }
  }
  const port = (c.publishedPorts ?? []).find((p) => p.containerPort === SPACESD_GUEST_PORT);
  const ip = statusObj?.networks?.[0]?.ipv4Address;
  return {
    name: c.id ?? '',
    state,
    ...(c.image?.reference ? { image: c.image.reference } : {}),
    ...(c.image?.descriptor?.digest ? { imageDigest: c.image.descriptor.digest } : {}),
    labels: c.labels ?? {},
    ...(port?.hostPort ? { hostPort: port.hostPort } : {}),
    ...(port?.hostAddress ? { hostAddress: port.hostAddress } : {}),
    binds,
    volumes,
    ...(c.resources?.cpus !== undefined ? { cpus: c.resources.cpus } : {}),
    ...(c.resources?.cpuOverhead !== undefined ? { cpuOverhead: c.resources.cpuOverhead } : {}),
    ...(c.resources?.memoryInBytes !== undefined ? { memoryBytes: c.resources.memoryInBytes } : {}),
    ...(ip ? { ipv4: ip.split('/')[0] } : {}),
  };
}

const isNotFound = (r: ExecResult) => r.code !== 0 && /not ?found/i.test(r.stderr + r.stdout);

export class AppleContainerDriver implements PcDriver {
  readonly kind = 'apple-container' as const;
  readonly cpuOverhead = 1;
  readonly capsVolumes = true;
  readonly runtime: ContainerRuntime;
  readonly #t: AppleContainerTimeouts;
  readonly #log: Logger | undefined;
  readonly #platform: string;

  constructor(
    runtime: ContainerRuntime,
    options: { timeouts?: Partial<AppleContainerTimeouts>; logger?: Logger; platform?: string } = {},
  ) {
    this.runtime = runtime;
    this.#t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#log = options.logger;
    this.#platform = options.platform ?? 'linux/arm64';
  }

  async ensureEngine(onProgress?: Progress): Promise<void> {
    await this.runtime.provision(onProgress);
    await this.runtime.ensureStarted(onProgress);
  }

  shutdownEngine(): Promise<boolean> {
    return this.runtime.stopIfOurs();
  }

  async imageExists(ref: string): Promise<boolean> {
    const r = await this.runtime.exec(['image', 'inspect', ref], { timeoutMs: this.#t.default });
    return r.code === 0 && !r.timedOut;
  }

  async pullImage(ref: string, onProgress?: Progress): Promise<void> {
    await this.runtime.execOk(['image', 'pull', '--platform', this.#platform, '--progress', 'plain', ref], {
      timeoutMs: this.#t.pull,
      ...(onProgress
        ? { onStdout: (d: string) => onProgress(d.trim()), onStderr: (d: string) => onProgress(d.trim()) }
        : {}),
    });
  }

  /** `container build`, then `builder stop` + `builder delete` so no builder VM keeps RAM (PLAN §9.3). */
  async buildImage(
    options: { contextDir: string; file: string; tag: string },
    onProgress?: Progress,
  ): Promise<void> {
    try {
      await this.runtime.execOk(
        [
          'build',
          '--progress',
          'plain',
          '--platform',
          this.#platform,
          '-t',
          options.tag,
          '-f',
          options.file,
          options.contextDir,
        ],
        {
          timeoutMs: this.#t.build,
          ...(onProgress
            ? { onStdout: (d: string) => onProgress(d.trim()), onStderr: (d: string) => onProgress(d.trim()) }
            : {}),
        },
      );
    } finally {
      await this.runtime.exec(['builder', 'stop'], { timeoutMs: this.#t.default });
      await this.runtime.exec(['builder', 'delete'], { timeoutMs: this.#t.default });
    }
  }

  async ensureVolume(volume: VolumeMount, labels: Record<string, string>): Promise<'created' | 'exists'> {
    const r = await this.runtime.exec(['volume', 'inspect', volume.name], { timeoutMs: this.#t.default });
    if (r.code === 0 && !r.timedOut) return 'exists';
    if (r.timedOut) throw new CliError('container volume inspect', r);
    await this.runtime.execOk(buildVolumeCreateArgs(volume, labels), { timeoutMs: this.#t.default });
    return 'created';
  }

  async removeVolume(name: string): Promise<void> {
    const r = await this.runtime.exec(['volume', 'delete', name], { timeoutMs: this.#t.default });
    if (r.code !== 0 && !isNotFound(r)) throw new CliError('container volume delete', r);
  }

  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    const out = await this.runtime.execOk(['volume', 'list', '--format', 'json'], {
      timeoutMs: this.#t.default,
    });
    const rows = JSON.parse(out.trim() || '[]') as {
      id?: string;
      configuration?: { name?: string; labels?: Record<string, string>; sizeInBytes?: number };
    }[];
    return rows
      .map((v) => ({
        name: v.configuration?.name ?? v.id ?? '',
        labels: v.configuration?.labels ?? {},
        ...(v.configuration?.sizeInBytes !== undefined ? { sizeBytes: v.configuration.sizeInBytes } : {}),
      }))
      .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  }

  async run(spec: PcRunSpec): Promise<void> {
    const args = buildAppleRunArgs(spec);
    const secrets = Object.values(spec.secretEnv);
    for (const v of spec.volumes) await this.ensureVolume(v, spec.labels);
    const r = await this.runtime.exec(args, { timeoutMs: this.#t.run, env: { ...spec.secretEnv } });
    if (r.code !== 0 || r.timedOut) {
      // A failed run can leave a stopped container behind; clean it so a retry is possible.
      await this.remove(spec.name).catch(() => {});
      throw new CliError('container run', r, secrets);
    }
    const info = await this.inspect(spec.name);
    const problems = info ? mountProblems(spec, info) : ['container vanished after run'];
    if (problems.length > 0) {
      await this.remove(spec.name).catch(() => {});
      throw new Error(`container run produced the wrong mounts: ${problems.join('; ')}`);
    }
    this.#log?.info({ name: spec.name, port: spec.hostPort, ms: r.ms }, 'pc container running');
  }

  async start(name: string): Promise<void> {
    await this.runtime.execOk(['start', name], { timeoutMs: this.#t.start });
  }

  async stop(name: string, timeoutSeconds = this.#t.stopGraceSeconds): Promise<void> {
    const r = await this.runtime.exec(['stop', '-t', String(timeoutSeconds), name], {
      timeoutMs: (timeoutSeconds + 30) * 1000,
    });
    if (r.code === 0 && !r.timedOut) return;
    if (isNotFound(r)) return;
    // Already stopped containers report an error on stop; accept that.
    const info = await this.inspect(name);
    if (info && info.state !== 'running') return;
    throw new CliError('container stop', r);
  }

  async remove(name: string): Promise<void> {
    const r = await this.runtime.exec(['delete', '--force', name], { timeoutMs: this.#t.default });
    if (r.code !== 0 && !isNotFound(r)) throw new CliError('container delete', r);
  }

  async inspect(name: string): Promise<PcContainerInfo | null> {
    const r = await this.runtime.exec(['inspect', name], { timeoutMs: this.#t.default });
    if (isNotFound(r)) return null;
    if (r.code !== 0 || r.timedOut) throw new CliError('container inspect', r);
    // Never let the raw output (it holds CUA_ENV_TOKEN in plaintext) reach a log.
    let rows: AppleContainerJson[];
    try {
      rows = JSON.parse(r.stdout) as AppleContainerJson[];
    } catch {
      throw new Error(`container inspect: unparsable output: ${redact(r.stdout).slice(0, 200)}`);
    }
    const row = rows[0];
    return row ? parseAppleContainer(row) : null;
  }

  async list(labels: Record<string, string>): Promise<PcContainerInfo[]> {
    const out = await this.runtime.execOk(['list', '--all', '--format', 'json'], {
      timeoutMs: this.#t.default,
    });
    const rows = JSON.parse(out.trim() || '[]') as AppleContainerJson[];
    return rows
      .map(parseAppleContainer)
      .filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v));
  }

  exec(
    name: string,
    argv: readonly string[],
    options: { user?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const args = ['exec'];
    if (options.user) args.push('--user', options.user);
    args.push(name, ...argv);
    return this.runtime.exec(args, { timeoutMs: options.timeoutMs ?? this.#t.default });
  }
}
