import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ContainerRuntime } from './ContainerRuntime.js';
import { CliError, type ExecResult, parseCliJson } from './exec.js';
import {
  type AndroidDriverOps,
  assertRunSpec,
  type BindMount,
  type ContainerState,
  hasLabels,
  mountProblems,
  type NetworkInfo,
  type OneShotSpec,
  orderedMounts,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  type PhoneRunSpec,
  type Progress,
  portProblems,
  SPACESD_GUEST_PORT,
  tokenFingerprintFromEnv,
  type VolumeInfo,
  type VolumeMount,
} from './PcDriver.js';

/**
 * Linux PCs on Apple `container` 1.5.0 (PLAN §8.1, §8.6).
 *
 * - Vault binds use `--mount type=bind,source=P,target=P[,readonly]`, never `-v src:dst:ro` (which
 *   silently creates a writable mount at `dst`+"o" in 1.5.0).
 * - PCs are made with `create` → `inspect` (mounts, loopback port, network verified) → `start`, never
 *   `run -d`, so nothing boots with a mount or port that came out wrong (H1, L1).
 * - Every PC gets its own network (`--network`): 1.5.0 isolates networks from each other (M7).
 * - Named volumes are created up front with `volume create -s <cap>` (default would be 512 GiB sparse)
 *   and mounted with `--mount type=volume,…`.
 * - spacesd is published on loopback only: `-p 127.0.0.1:<port>:3211`.
 * - The token travels as `-e CUA_ENV_TOKEN` (name only) with the value in the CLI's environment.
 * - Nested virtualization is `--virtualization` plus `--kernel` (a kernel with KVM; the stock one has none). Neither
 *   flag is ever set engine-wide (`system kernel set` would change every container, the user's PCs included).
 * - The Android phone (PLAN §8.7) is its own container on the PC's network with MineVibe's Android kernel, all
 *   capabilities and no masked or read-only paths (Android init mounts its own); it publishes no port.
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

/** Arguments shared by `container run` and `container create` (pure; unit-tested). */
function commonArgs(spec: PcRunSpec): string[] {
  assertRunSpec(spec);
  const { binds, volumes } = orderedMounts(spec);
  const args = ['--name', spec.name, '--cpus', String(spec.cpus), '--memory', `${spec.memoryMiB}M`];
  if (spec.shmMiB > 0) args.push('--shm-size', `${spec.shmMiB}M`);
  if (spec.kernel) args.push('--kernel', spec.kernel);
  if (spec.virtualization) args.push('--virtualization');
  for (const k of Object.keys(spec.secretEnv)) args.push('-e', k);
  for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  if (spec.network) args.push('--network', spec.network);
  args.push('-p', `127.0.0.1:${spec.hostPort}:${SPACESD_GUEST_PORT}`);
  for (const b of binds) args.push('--mount', bindMountArg(b));
  for (const v of volumes) args.push('--mount', `type=volume,source=${v.name},target=${v.target}`);
  for (const [k, v] of Object.entries(spec.labels)) args.push('-l', `${k}=${v}`);
  args.push(spec.image);
  return args;
}

/** Builds `container run -d` arguments (pure; unit-tested). */
export function buildAppleRunArgs(spec: PcRunSpec): string[] {
  return ['run', '-d', ...commonArgs(spec)];
}

/** Builds `container create` arguments (pure; unit-tested). */
export function buildAppleCreateArgs(spec: PcRunSpec): string[] {
  return ['create', ...commonArgs(spec)];
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const pathOk = (p: string) => p.startsWith('/') && !/[,=:\n\r\0]/.test(p);

/** Builds the phone's `container create` arguments (pure; unit-tested). */
export function buildPhoneCreateArgs(spec: PhoneRunSpec): string[] {
  const fail = (m: string) => {
    throw new Error(`invalid phone spec: ${m}`);
  };
  if (!NAME_RE.test(spec.name)) fail(`name ${spec.name}`);
  if (!NAME_RE.test(spec.network)) fail(`network ${spec.network}`);
  if (!pathOk(spec.kernel)) fail(`kernel ${spec.kernel}`);
  if (!Number.isInteger(spec.cpus) || spec.cpus < 1) fail(`cpus ${spec.cpus}`);
  if (!Number.isInteger(spec.memoryMiB) || spec.memoryMiB < 1024) fail(`memoryMiB ${spec.memoryMiB}`);
  if (spec.data && !NAME_RE.test(spec.data.name)) fail(`volume ${spec.data.name}`);
  for (const a of spec.initArgs) if (!/^[a-z0-9_.]+=[A-Za-z0-9_.,-]+$/.test(a)) fail(`init arg ${a}`);
  const args = ['create', '--name', spec.name, '--cpus', String(spec.cpus), '--memory', `${spec.memoryMiB}M`];
  args.push('--network', spec.network, '--kernel', spec.kernel);
  // Android init mounts /proc, /sys and its cgroups itself; the default masks and read-only paths break it.
  args.push('--cap-add', 'ALL', '--masked-path', 'NONE', '--read-only-path', 'NONE');
  if (spec.data) args.push('--mount', `type=volume,source=${spec.data.name},target=/data`);
  for (const [k, v] of Object.entries(spec.labels)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(k) || /[\n\r\0=,]/.test(v)) fail(`label ${k}`);
    args.push('-l', `${k}=${v}`);
  }
  args.push(spec.image, ...spec.initArgs);
  return args;
}

/** Builds `container run --rm` arguments of a one-shot container (pure; unit-tested). */
export function buildOneShotArgs(spec: OneShotSpec): string[] {
  if (!NAME_RE.test(spec.name)) throw new Error(`invalid one-shot spec: name ${spec.name}`);
  const args = [
    'run',
    '--rm',
    '--name',
    spec.name,
    '--cpus',
    String(spec.cpus),
    '--memory',
    `${spec.memoryMiB}M`,
  ];
  args.push('--entrypoint', spec.entrypoint);
  for (const b of spec.binds) {
    if (!pathOk(b.source) || !pathOk(b.target)) throw new Error(`invalid one-shot spec: bind ${b.source}`);
    args.push('--mount', bindMountArg(b));
  }
  for (const [k, v] of Object.entries(spec.labels)) args.push('-l', `${k}=${v}`);
  args.push(spec.image, ...spec.args);
  return args;
}

/** `type=bind,source=…,target=…[,readonly]` */
export function bindMountArg(b: BindMount): string {
  return `type=bind,source=${b.source},target=${b.target}${b.readonly ? ',readonly' : ''}`;
}

/** `network create --label k=v <name>` */
export function buildNetworkCreateArgs(name: string, labels: Record<string, string>): string[] {
  const args = ['network', 'create'];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  args.push(name);
  return args;
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
    initProcess?: { environment?: unknown[] };
    mounts?: AppleMountJson[];
    publishedPorts?: { containerPort?: number; hostAddress?: string; hostPort?: number; proto?: string }[];
    resources?: { cpus?: number; cpuOverhead?: number; memoryInBytes?: number };
    shmSize?: number;
    networks?: { network?: string }[];
    virtualization?: boolean;
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
  const tokenSha256 = tokenFingerprintFromEnv(c.initProcess?.environment);
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
    ...(c.shmSize !== undefined ? { shmBytes: c.shmSize } : {}),
    ...(c.networks ? { networks: c.networks.map((n) => n.network ?? '').filter(Boolean) } : {}),
    ...(ip ? { ipv4: ip.split('/')[0] } : {}),
    ...(tokenSha256 ? { tokenSha256 } : {}),
    ...(typeof c.virtualization === 'boolean' ? { virtualization: c.virtualization } : {}),
  };
}

interface AppleVolumeJson {
  id?: string;
  configuration?: { name?: string; labels?: Record<string, string>; sizeInBytes?: number; source?: string };
}

interface AppleNetworkJson {
  id?: string;
  configuration?: { name?: string; labels?: Record<string, string> };
  status?: { ipv4Subnet?: string };
}

const isNotFound = (r: ExecResult) => r.code !== 0 && /not ?found/i.test(r.stderr + r.stdout);

/**
 * Splits a streamed output into whole, trimmed, non-empty lines: a line cut across two chunks is held back until its
 * end arrives (call with `flush` at the end).
 */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = '';
  const emit = (l: string) => {
    const t = l.trim();
    if (t) onLine(t);
  };
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/\r?\n|\r/);
      rest = parts.pop() ?? '';
      for (const l of parts) emit(l);
    },
    flush() {
      emit(rest);
      rest = '';
    },
  };
}

export class AppleContainerDriver implements PcDriver, AndroidDriverOps {
  readonly kind = 'apple-container' as const;
  readonly cpuOverhead = 1;
  readonly capsVolumes = true;
  readonly android: AndroidDriverOps = this;
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

  /** Provisions, takes this process's engine lease and starts our apiserver (N4). */
  async ensureEngine(onProgress?: Progress): Promise<void> {
    await this.runtime.provision(onProgress);
    await this.runtime.startAndLease(onProgress);
  }

  /** Drops the lease; stops our apiserver only when no other live MineVibe uses it (N4). */
  shutdownEngine(): Promise<boolean> {
    return this.runtime.releaseAndStopIfUnused();
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
    if (r.timedOut) throw new CliError('container volume inspect', r);
    if (r.code === 0) {
      const rows = parseCliJson<AppleVolumeJson[]>('container volume inspect', r.stdout.trim() || '[]');
      const got = rows[0]?.configuration?.labels ?? {};
      if (!hasLabels(got, labels)) {
        throw new Error(
          `volume ${volume.name} exists but belongs to someone else (labels differ); not reusing it`,
        );
      }
      return 'exists';
    }
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
    const rows = parseCliJson<AppleVolumeJson[]>('container volume list', out.trim() || '[]');
    return rows
      .map((v) => ({
        name: v.configuration?.name ?? v.id ?? '',
        labels: v.configuration?.labels ?? {},
        ...(v.configuration?.sizeInBytes !== undefined ? { sizeBytes: v.configuration.sizeInBytes } : {}),
        ...(v.configuration?.source ? { source: v.configuration.source } : {}),
      }))
      .filter((v) => hasLabels(v.labels, labels));
  }

  async ensureNetwork(name: string, labels: Record<string, string>): Promise<'created' | 'exists'> {
    const r = await this.runtime.exec(['network', 'inspect', name], { timeoutMs: this.#t.default });
    if (r.timedOut) throw new CliError('container network inspect', r);
    if (r.code === 0) {
      const rows = parseCliJson<AppleNetworkJson[]>('container network inspect', r.stdout.trim() || '[]');
      if (!hasLabels(rows[0]?.configuration?.labels ?? {}, labels)) {
        throw new Error(`network ${name} exists but belongs to someone else (labels differ); not using it`);
      }
      return 'exists';
    }
    await this.runtime.execOk(buildNetworkCreateArgs(name, labels), { timeoutMs: this.#t.default });
    return 'created';
  }

  async removeNetwork(name: string): Promise<void> {
    const r = await this.runtime.exec(['network', 'delete', name], { timeoutMs: this.#t.default });
    if (r.code !== 0 && !isNotFound(r)) throw new CliError('container network delete', r);
  }

  async listNetworks(labels: Record<string, string>): Promise<NetworkInfo[]> {
    const out = await this.runtime.execOk(['network', 'list', '--format', 'json'], {
      timeoutMs: this.#t.default,
    });
    return parseCliJson<AppleNetworkJson[]>('container network list', out.trim() || '[]')
      .map((n) => ({
        name: n.configuration?.name ?? n.id ?? '',
        labels: n.configuration?.labels ?? {},
        ...(n.status?.ipv4Subnet ? { subnet: n.status.ipv4Subnet } : {}),
      }))
      .filter((n) => hasLabels(n.labels, labels));
  }

  /**
   * `container create` (never `run -d`), then verify what came out: binds (source, target, read-only),
   * volumes, the loopback-only port and the network. Anything wrong deletes the container and throws.
   * A create the Node timeout killed is deleted too (the apiserver may still finish it; PcManager's
   * monitor stops any container that should not run).
   */
  async create(spec: PcRunSpec): Promise<PcContainerInfo> {
    const args = buildAppleCreateArgs(spec);
    const secrets = Object.values(spec.secretEnv);
    for (const v of spec.volumes) await this.ensureVolume(v, spec.ownerLabels ?? spec.labels);
    const r = await this.runtime.exec(args, { timeoutMs: this.#t.run, env: { ...spec.secretEnv } });
    if (r.code !== 0 || r.timedOut) {
      await this.remove(spec.name).catch(() => {});
      throw new CliError('container create', r, secrets);
    }
    const info = await this.inspect(spec.name);
    const problems = info
      ? [...mountProblems(spec, info), ...portProblems(spec, info)]
      : ['container vanished after create'];
    if (info && spec.network && !(info.networks ?? []).includes(spec.network)) {
      problems.push(`not attached to network ${spec.network}`);
    }
    if (!info || problems.length > 0) {
      await this.remove(spec.name).catch(() => {});
      throw new Error(`container create produced the wrong container: ${problems.join('; ')}`);
    }
    this.#log?.info({ name: spec.name, port: spec.hostPort, ms: r.ms }, 'pc container created');
    return info;
  }

  async run(spec: PcRunSpec): Promise<void> {
    await this.create(spec);
    try {
      await this.start(spec.name);
    } catch (err) {
      await this.remove(spec.name).catch(() => {});
      throw err;
    }
  }

  async start(name: string): Promise<void> {
    await this.runtime.execOk(['start', name], { timeoutMs: this.#t.start });
  }

  /**
   * Stops a container. One that is still running after a failed stop gets a second `stop`: after Docker ran inside a
   * PC, the first one fails with errno 95 on `cgroup.kill` and the second succeeds (spike S9-android).
   */
  async stop(name: string, timeoutSeconds = this.#t.stopGraceSeconds): Promise<void> {
    let r: ExecResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await this.runtime.exec(['stop', '-t', String(timeoutSeconds), name], {
        timeoutMs: (timeoutSeconds + 30) * 1000,
      });
      if (r.code === 0 && !r.timedOut) return;
      if (isNotFound(r)) return;
      // Already stopped containers report an error on stop; accept that.
      const info = await this.inspect(name);
      if (info?.state !== 'running') return;
      this.#log?.warn({ name, attempt, err: r.stderr.trim().slice(0, 300) }, 'container stop failed');
    }
    throw new CliError('container stop', r as ExecResult);
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
    const rows = parseCliJson<AppleContainerJson[]>('container inspect', r.stdout);
    const row = rows[0];
    return row ? parseAppleContainer(row) : null;
  }

  async list(labels: Record<string, string>): Promise<PcContainerInfo[]> {
    const out = await this.runtime.execOk(['list', '--all', '--format', 'json'], {
      timeoutMs: this.#t.default,
    });
    const rows = parseCliJson<AppleContainerJson[]>('container list', out.trim() || '[]');
    return rows.map(parseAppleContainer).filter((c) => hasLabels(c.labels, labels));
  }

  /** Allocated blocks of `<appRoot>/containers/<name>/rootfs.ext4` and of each volume's image. */
  async diskUsage(
    containers: readonly string[],
    volumes: readonly VolumeInfo[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const allocated = async (path: string) => {
      try {
        const st = await stat(path);
        return st.blocks * 512;
      } catch {
        return undefined;
      }
    };
    for (const name of containers) {
      const b = await allocated(join(this.runtime.appRoot, 'containers', name, 'rootfs.ext4'));
      if (b !== undefined) out.set(name, b);
    }
    for (const v of volumes) {
      const b = await allocated(v.source ?? join(this.runtime.appRoot, 'volumes', v.name, 'volume.img'));
      if (b !== undefined) out.set(v.name, b);
    }
    return out;
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

  // ------------------------------------------------------------------ Android phone, kernels (PLAN §8.7)

  async saveImage(ref: string, file: string): Promise<void> {
    await this.runtime.execOk(['image', 'save', '--platform', this.#platform, '-o', file, ref], {
      timeoutMs: this.#t.pull,
    });
  }

  async loadImage(file: string): Promise<void> {
    await this.runtime.execOk(['image', 'load', '-i', file], { timeoutMs: this.#t.pull });
  }

  async removeImage(ref: string): Promise<void> {
    const r = await this.runtime.exec(['image', 'delete', ref], { timeoutMs: this.#t.default });
    if (r.code !== 0 && !isNotFound(r)) throw new CliError('container image delete', r);
  }

  async imageDigest(ref: string): Promise<string | null> {
    const r = await this.runtime.exec(['image', 'inspect', ref], { timeoutMs: this.#t.default });
    if (r.code !== 0 || r.timedOut) return null;
    const rows = parseCliJson<{ id?: string; configuration?: { descriptor?: { digest?: string } } }[]>(
      'container image inspect',
      r.stdout.trim() || '[]',
    );
    const row = rows[0];
    const digest = row?.configuration?.descriptor?.digest ?? (row?.id ? `sha256:${row.id}` : undefined);
    return digest ?? null;
  }

  async runOnce(spec: OneShotSpec, onOutput?: Progress): Promise<void> {
    // One splitter per stream: their chunks interleave.
    const out = onOutput ? lineSplitter(onOutput) : null;
    const err = onOutput ? lineSplitter(onOutput) : null;
    const r = await this.runtime.exec(buildOneShotArgs(spec), {
      timeoutMs: spec.timeoutMs,
      ...(out && err ? { onStdout: (d: string) => out.push(d), onStderr: (d: string) => err.push(d) } : {}),
    });
    out?.flush();
    err?.flush();
    if (r.code === 0 && !r.timedOut) return;
    // A one-shot the timeout killed may still run in the engine.
    await this.remove(spec.name).catch(() => {});
    throw new CliError(`container run ${spec.name}`, r);
  }

  /** `container create` of the phone, then verify: on the PC's network, `/data` mounted, no published port. */
  async createPhone(spec: PhoneRunSpec): Promise<PcContainerInfo> {
    const args = buildPhoneCreateArgs(spec);
    if (spec.data) await this.ensureVolume(spec.data, spec.ownerLabels);
    const r = await this.runtime.exec(args, { timeoutMs: this.#t.run });
    if (r.code !== 0 || r.timedOut) {
      await this.remove(spec.name).catch(() => {});
      throw new CliError('container create (phone)', r);
    }
    const info = await this.inspect(spec.name);
    const problems: string[] = [];
    if (!info) problems.push('container vanished after create');
    else {
      if (!(info.networks ?? []).includes(spec.network))
        problems.push(`not attached to network ${spec.network}`);
      if (spec.data && !info.volumes.some((v) => v.name === spec.data?.name && v.target === '/data')) {
        problems.push('/data is not its volume');
      }
      if (info.hostPort !== undefined || info.binds.length > 0)
        problems.push('it publishes a port or binds a folder');
    }
    if (!info || problems.length > 0) {
      await this.remove(spec.name).catch(() => {});
      throw new Error(`phone create produced the wrong container: ${problems.join('; ')}`);
    }
    this.#log?.info({ name: spec.name, ms: r.ms }, 'phone container created');
    return info;
  }
}
