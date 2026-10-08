import { CliError, type ExecFn, type ExecResult, execWithTimeout, parseCliJson } from './exec.js';
import {
  assertRunSpec,
  type BindMount,
  type ContainerState,
  hasLabels,
  mountProblems,
  type NetworkInfo,
  orderedMounts,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  type Progress,
  portProblems,
  SPACESD_GUEST_PORT,
  tokenFingerprintFromEnv,
  type VolumeInfo,
  type VolumeMount,
} from './PcDriver.js';

/**
 * Minimal Docker CLI driver (OrbStack/Colima) for dev and CI (PLAN §8.1, `MINEVIBE_PC_RUNTIME=docker`).
 * Same interface as the Apple driver; volume size caps are not enforced by Docker's local driver.
 */

function dockerCommonArgs(spec: PcRunSpec): string[] {
  assertRunSpec(spec);
  const { binds, volumes } = orderedMounts(spec);
  const args = [
    '--name',
    spec.name,
    '--cpus',
    String(spec.cpus),
    '--memory',
    `${spec.memoryMiB}m`,
    '--memory-swap',
    `${spec.memoryMiB}m`,
  ];
  if (spec.shmMiB > 0) args.push('--shm-size', `${spec.shmMiB}m`);
  for (const k of Object.keys(spec.secretEnv)) args.push('-e', k);
  for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`);
  if (spec.network) args.push('--network', spec.network);
  args.push('-p', `127.0.0.1:${spec.hostPort}:${SPACESD_GUEST_PORT}`);
  for (const b of binds) {
    args.push('--mount', `type=bind,source=${b.source},target=${b.target}${b.readonly ? ',readonly' : ''}`);
  }
  for (const v of volumes) args.push('--mount', `type=volume,source=${v.name},target=${v.target}`);
  for (const [k, v] of Object.entries(spec.labels)) args.push('--label', `${k}=${v}`);
  args.push(spec.image);
  return args;
}

/** Builds `docker run -d` arguments (pure; unit-tested). */
export function buildDockerRunArgs(spec: PcRunSpec): string[] {
  return ['run', '-d', ...dockerCommonArgs(spec)];
}

/** Builds `docker create` arguments (pure; unit-tested). */
export function buildDockerCreateArgs(spec: PcRunSpec): string[] {
  return ['create', ...dockerCommonArgs(spec)];
}

interface DockerInspectJson {
  Name?: string;
  State?: { Status?: string };
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: unknown[] };
  Image?: string;
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }[];
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    IPAddress?: string;
    Networks?: Record<string, unknown>;
  };
  HostConfig?: {
    NetworkMode?: string;
    NanoCpus?: number;
    Memory?: number;
    ShmSize?: number;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
  };
}

export function parseDockerInspect(j: DockerInspectJson): PcContainerInfo {
  const status = j.State?.Status ?? 'unknown';
  const state: ContainerState =
    status === 'running'
      ? 'running'
      : status === 'exited' || status === 'dead'
        ? 'stopped'
        : status === 'created'
          ? 'created'
          : 'unknown';
  const binds: BindMount[] = [];
  const volumes: { name: string; target: string }[] = [];
  for (const m of j.Mounts ?? []) {
    if (!m.Destination) continue;
    if (m.Type === 'volume') volumes.push({ name: m.Name ?? '', target: m.Destination });
    else if (m.Type === 'bind')
      binds.push({ source: m.Source ?? '', target: m.Destination, readonly: m.RW === false });
  }
  // Ports are only in NetworkSettings while running; PortBindings holds what was asked for.
  const key = `${SPACESD_GUEST_PORT}/tcp`;
  const port = j.NetworkSettings?.Ports?.[key]?.[0] ?? j.HostConfig?.PortBindings?.[key]?.[0];
  // A created (never started) container may list no networks yet; its NetworkMode names the one asked for.
  const nets = Object.keys(j.NetworkSettings?.Networks ?? {});
  const mode = j.HostConfig?.NetworkMode;
  const networks = nets.length > 0 ? nets : mode && !/^(default|container:.*)$/.test(mode) ? [mode] : null;
  const tokenSha256 = tokenFingerprintFromEnv(j.Config?.Env);
  return {
    name: (j.Name ?? '').replace(/^\//, ''),
    state,
    ...(j.Config?.Image ? { image: j.Config.Image } : {}),
    ...(j.Image ? { imageDigest: j.Image } : {}),
    labels: j.Config?.Labels ?? {},
    ...(port?.HostPort ? { hostPort: Number(port.HostPort) } : {}),
    ...(port?.HostIp ? { hostAddress: port.HostIp } : {}),
    binds,
    volumes,
    ...(j.HostConfig?.NanoCpus ? { cpus: j.HostConfig.NanoCpus / 1e9, cpuOverhead: 0 } : {}),
    ...(j.HostConfig?.Memory ? { memoryBytes: j.HostConfig.Memory } : {}),
    ...(j.HostConfig?.ShmSize ? { shmBytes: j.HostConfig.ShmSize } : {}),
    ...(networks ? { networks } : {}),
    ...(tokenSha256 ? { tokenSha256 } : {}),
  };
}

export class DockerDriver implements PcDriver {
  readonly kind = 'docker' as const;
  readonly cpuOverhead = 0;
  readonly capsVolumes = false;
  readonly #bin: string;
  readonly #exec: ExecFn;
  readonly #timeoutMs: number;

  constructor(options: { bin?: string; exec?: ExecFn; timeoutMs?: number } = {}) {
    this.#bin = options.bin ?? 'docker';
    this.#exec = options.exec ?? execWithTimeout;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  #run(
    args: readonly string[],
    timeoutMs = this.#timeoutMs,
    env?: Record<string, string>,
  ): Promise<ExecResult> {
    return this.#exec(this.#bin, args, { timeoutMs, env: { ...process.env, ...env } });
  }

  async #ok(args: readonly string[], timeoutMs?: number, env?: Record<string, string>): Promise<string> {
    const r = await this.#run(args, timeoutMs, env);
    if (r.code !== 0 || r.timedOut) throw new CliError(`docker ${args[0]}`, r, Object.values(env ?? {}));
    return r.stdout;
  }

  async ensureEngine(): Promise<void> {
    await this.#ok(['info', '--format', '{{.ServerVersion}}'], 30_000);
  }

  async shutdownEngine(): Promise<boolean> {
    return false;
  }

  async imageExists(ref: string): Promise<boolean> {
    return (await this.#run(['image', 'inspect', ref])).code === 0;
  }

  async pullImage(ref: string, _onProgress?: Progress): Promise<void> {
    await this.#ok(['pull', '--platform', 'linux/arm64', ref], 1_200_000);
  }

  async buildImage(options: { contextDir: string; file: string; tag: string }): Promise<void> {
    await this.#ok(['build', '-t', options.tag, '-f', options.file, options.contextDir], 3_600_000);
  }

  async ensureVolume(volume: VolumeMount, labels: Record<string, string>): Promise<'created' | 'exists'> {
    const r = await this.#run(['volume', 'inspect', volume.name]);
    if (r.code === 0) {
      const rows = parseCliJson<{ Labels?: Record<string, string> | null }[]>(
        'docker volume inspect',
        r.stdout,
      );
      if (!hasLabels(rows[0]?.Labels ?? {}, labels)) {
        throw new Error(
          `volume ${volume.name} exists but belongs to someone else (labels differ); not reusing it`,
        );
      }
      return 'exists';
    }
    const args = ['volume', 'create'];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    args.push(volume.name);
    await this.#ok(args);
    return 'created';
  }

  async removeVolume(name: string): Promise<void> {
    const r = await this.#run(['volume', 'rm', name]);
    if (r.code !== 0 && !/no such volume/i.test(r.stderr)) throw new CliError('docker volume rm', r);
  }

  async listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]> {
    const args = ['volume', 'ls', '--format', '{{.Name}}'];
    for (const [k, v] of Object.entries(labels)) args.push('--filter', `label=${k}=${v}`);
    const out = await this.#ok(args);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, labels: { ...labels } }));
  }

  async ensureNetwork(name: string, labels: Record<string, string>): Promise<'created' | 'exists'> {
    const r = await this.#run(['network', 'inspect', name]);
    if (r.code === 0) {
      const rows = parseCliJson<{ Labels?: Record<string, string> | null }[]>(
        'docker network inspect',
        r.stdout,
      );
      if (!hasLabels(rows[0]?.Labels ?? {}, labels)) {
        throw new Error(`network ${name} exists but belongs to someone else (labels differ); not using it`);
      }
      return 'exists';
    }
    const args = ['network', 'create'];
    for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
    args.push(name);
    await this.#ok(args);
    return 'created';
  }

  async removeNetwork(name: string): Promise<void> {
    const r = await this.#run(['network', 'rm', name]);
    if (r.code !== 0 && !/not found|no such network/i.test(r.stderr))
      throw new CliError('docker network rm', r);
  }

  async listNetworks(labels: Record<string, string>): Promise<NetworkInfo[]> {
    const args = ['network', 'ls', '--format', '{{.Name}}'];
    for (const [k, v] of Object.entries(labels)) args.push('--filter', `label=${k}=${v}`);
    return (await this.#ok(args))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, labels: { ...labels } }));
  }

  async create(spec: PcRunSpec): Promise<PcContainerInfo> {
    for (const v of spec.volumes) await this.ensureVolume(v, spec.ownerLabels ?? spec.labels);
    const r = await this.#run(buildDockerCreateArgs(spec), 180_000, spec.secretEnv);
    if (r.code !== 0 || r.timedOut) {
      await this.remove(spec.name).catch(() => {});
      throw new CliError('docker create', r, Object.values(spec.secretEnv));
    }
    const info = await this.inspect(spec.name);
    const problems = info
      ? [...mountProblems(spec, info), ...portProblems(spec, info)]
      : ['container vanished after create'];
    // N8: the same network check as the Apple driver.
    if (info && spec.network && !(info.networks ?? []).includes(spec.network)) {
      problems.push(`not attached to network ${spec.network}`);
    }
    if (!info || problems.length > 0) {
      await this.remove(spec.name).catch(() => {});
      throw new Error(`docker create produced the wrong container: ${problems.join('; ')}`);
    }
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

  async diskUsage(): Promise<Map<string, number>> {
    return new Map();
  }

  async start(name: string): Promise<void> {
    await this.#ok(['start', name], 120_000);
  }

  async stop(name: string, timeoutSeconds = 10): Promise<void> {
    const r = await this.#run(['stop', '-t', String(timeoutSeconds), name], (timeoutSeconds + 30) * 1000);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new CliError('docker stop', r);
  }

  async remove(name: string): Promise<void> {
    const r = await this.#run(['rm', '-f', name]);
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new CliError('docker rm', r);
  }

  async inspect(name: string): Promise<PcContainerInfo | null> {
    const r = await this.#run(['inspect', '--type', 'container', name]);
    if (r.code !== 0 && /no such/i.test(r.stderr)) return null;
    if (r.code !== 0 || r.timedOut) throw new CliError('docker inspect', r);
    const rows = parseCliJson<DockerInspectJson[]>('docker inspect', r.stdout);
    return rows[0] ? parseDockerInspect(rows[0]) : null;
  }

  async list(labels: Record<string, string>): Promise<PcContainerInfo[]> {
    const args = ['ps', '-a', '-q'];
    for (const [k, v] of Object.entries(labels)) args.push('--filter', `label=${k}=${v}`);
    const ids = (await this.#ok(args))
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return [];
    const r = await this.#ok(['inspect', '--type', 'container', ...ids]);
    return parseCliJson<DockerInspectJson[]>('docker inspect', r)
      .map(parseDockerInspect)
      .filter((c) => hasLabels(c.labels, labels));
  }

  exec(
    name: string,
    argv: readonly string[],
    options: { user?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    const args = ['exec'];
    if (options.user) args.push('--user', options.user);
    args.push(name, ...argv);
    return this.#run(args, options.timeoutMs ?? this.#timeoutMs);
  }
}
