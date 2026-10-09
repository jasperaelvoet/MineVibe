import { createHash } from 'node:crypto';
import type { ExecResult } from './exec.js';

/** spacesd's port inside every Linux PC. */
export const SPACESD_GUEST_PORT = 3211;

/** Label key every MineVibe container and volume carries; the value scopes it (`pc`, `pc-test`). */
export const MANAGED_LABEL = 'minevibe';
/** Label carrying the PC id. */
export const PC_ID_LABEL = 'minevibe.pc';
/** Label carrying the MineVibe instance id (hash of the state dir), so instances sharing an app root never touch each other's PCs. */
export const PC_INSTANCE_LABEL = 'minevibe.instance';
/**
 * Label of a container that belongs to a PC without being the PC itself (`phone`: its Android phone). PC scans skip
 * every container that carries it.
 */
export const ROLE_LABEL = 'minevibe.role';
/** Label carrying the id of the kernel a PC boots with `--kernel` (nested virtualization). */
export const KERNEL_LABEL = 'minevibe.kernel';

/** True when `labels` carries every key/value of `want`. */
export function hasLabels(
  labels: Readonly<Record<string, string>>,
  want: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(want).every(([k, v]) => labels[k] === v);
}

export interface BindMount {
  source: string;
  target: string;
  readonly: boolean;
}

export interface VolumeMount {
  name: string;
  target: string;
  /** Size cap; drivers that cannot cap (Docker) ignore it. */
  sizeGiB: number;
}

/** Everything needed to create one Linux PC container. */
export interface PcRunSpec {
  name: string;
  image: string;
  cpus: number;
  memoryMiB: number;
  shmMiB: number;
  /** Loopback host port published to spacesd :3211. */
  hostPort: number;
  /** The PC's own network (`--network`); omitted = the runtime's default network. */
  network?: string;
  binds: BindMount[];
  volumes: VolumeMount[];
  labels: Record<string, string>;
  /**
   * Labels that prove ownership of the PC's volumes and network (a subset of `labels` without values that
   * change over the PC's life, like its type). Defaults to `labels`.
   */
  ownerLabels?: Record<string, string>;
  /** Plain env (`-e K=V`); never secrets. */
  env: Record<string, string>;
  /**
   * Secret env: only the name goes into argv (`-e NAME`, inherited); the value is placed in the CLI's
   * own environment, so it never appears in a process listing.
   */
  secretEnv: Record<string, string>;
  /**
   * Nested virtualization (`--virtualization`, Apple `container` on M3 or newer): the guest's CPUs start at EL2. Only
   * useful with a {@link kernel} that has KVM; the stock kernel has none.
   */
  virtualization?: boolean;
  /** A kernel image this container boots instead of the engine's default (`--kernel`, copied at create). */
  kernel?: string;
}

/**
 * A PC's Android phone (PLAN §8.8): a Redroid container on the PC's network that boots MineVibe's Android kernel
 * (binder, PSI). It publishes no port: its adb (5555, unauthenticated) is reachable only from the PC.
 */
export interface PhoneRunSpec {
  name: string;
  image: string;
  /** The kernel with binder (never the engine default, which has none). */
  kernel: string;
  /** The PC's network. */
  network: string;
  cpus: number;
  memoryMiB: number;
  /** `/data` (apps and saves). */
  data: VolumeMount | null;
  labels: Record<string, string>;
  /** Labels proving ownership of the data volume. */
  ownerLabels: Record<string, string>;
  /** Android init arguments (`androidboot.redroid_fps=60`, …), appended to the image's entrypoint. */
  initArgs: string[];
}

/** A container that runs one command to completion and is removed (`run --rm`), e.g. the Android kernel build. */
export interface OneShotSpec {
  name: string;
  image: string;
  cpus: number;
  memoryMiB: number;
  /** Replaces the image's entrypoint. */
  entrypoint: string;
  args: string[];
  binds: BindMount[];
  labels: Record<string, string>;
  timeoutMs: number;
}

/**
 * What the Android phone and nested virtualization need from the engine (PLAN §8.8). Only Apple `container` has it:
 * per-container kernels (`--kernel`), image save/load and one-shot runs.
 */
export interface AndroidDriverOps {
  /** `image save` of one platform into an OCI tar. */
  saveImage(ref: string, file: string): Promise<void>;
  /** `image load` of an OCI tar. */
  loadImage(file: string): Promise<void>;
  /** `image delete` (a missing image is fine). */
  removeImage(ref: string): Promise<void>;
  /** The index digest of a local image, or null when it is missing. */
  imageDigest(ref: string): Promise<string | null>;
  /** Runs a one-shot container to completion; rejects when it fails. Output lines go to `onOutput`. */
  runOnce(spec: OneShotSpec, onOutput?: Progress): Promise<void>;
  /** Creates (never starts) the phone container, then verifies its network and `/data` volume. */
  createPhone(spec: PhoneRunSpec): Promise<PcContainerInfo>;
}

export type ContainerState = 'running' | 'stopped' | 'stopping' | 'created' | 'unknown';

export interface PcContainerInfo {
  name: string;
  state: ContainerState;
  image?: string;
  imageDigest?: string;
  labels: Record<string, string>;
  /** Host port published for spacesd (3211), when found. */
  hostPort?: number;
  hostAddress?: string;
  binds: BindMount[];
  volumes: { name: string; target: string }[];
  cpus?: number;
  cpuOverhead?: number;
  memoryBytes?: number;
  shmBytes?: number;
  /** Networks the container is attached to (configuration, known before start). */
  networks?: string[];
  ipv4?: string;
  /**
   * {@link tokenFingerprint} of the `CUA_ENV_TOKEN` the container was created with. Only the hash leaves
   * the parser; the token itself (plaintext in `inspect`) is never kept.
   */
  tokenSha256?: string;
  /** Whether the container was created with `--virtualization` (absent: the engine does not say). */
  virtualization?: boolean;
}

/** Name of the env var carrying a PC's spacesd token. */
export const TOKEN_ENV = 'CUA_ENV_TOKEN';

/** sha256 (hex) of a token, for comparing a container's token with ours without holding it. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The {@link tokenFingerprint} of `CUA_ENV_TOKEN` in a `K=V` env list, if present and non-empty. */
export function tokenFingerprintFromEnv(env: readonly unknown[] | undefined): string | undefined {
  for (const e of env ?? []) {
    if (typeof e !== 'string' || !e.startsWith(`${TOKEN_ENV}=`)) continue;
    const v = e.slice(TOKEN_ENV.length + 1);
    return v ? tokenFingerprint(v) : undefined;
  }
  return undefined;
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
  sizeBytes?: number;
  /** Backing file on the host (Apple: `<appRoot>/volumes/<name>/volume.img`). */
  source?: string;
}

export interface NetworkInfo {
  name: string;
  labels: Record<string, string>;
  subnet?: string;
}

export type Progress = (message: string) => void;

/** The container-engine side of a Linux PC (Apple `container` or Docker). */
export interface PcDriver {
  readonly kind: 'apple-container' | 'docker';
  /** vCPUs the engine adds on top of `--cpus` (Apple `container`: 1). */
  readonly cpuOverhead: number;
  /** Whether volume size caps are enforced. */
  readonly capsVolumes: boolean;
  /** Android phone and nested-virtualization support (Apple `container` only; absent: neither is possible). */
  readonly android?: AndroidDriverOps | undefined;

  /**
   * Provisions/starts the engine (or verifies it is reachable) and takes this process's hold on it.
   * Throws when it is down or foreign.
   */
  ensureEngine(onProgress?: Progress): Promise<void>;
  /**
   * Lets go of the engine on quit: stops it only when it is ours and no other live MineVibe process
   * still uses it (N4). Returns whether it stopped.
   */
  shutdownEngine(): Promise<boolean>;

  imageExists(ref: string): Promise<boolean>;
  pullImage(ref: string, onProgress?: Progress): Promise<void>;
  buildImage(
    options: { contextDir: string; file: string; tag: string },
    onProgress?: Progress,
  ): Promise<void>;

  /**
   * Creates a capped volume, or accepts an existing one only when it carries every given label (M1: a
   * volume of the same name owned by another instance is never reused). Throws otherwise.
   */
  ensureVolume(volume: VolumeMount, labels: Record<string, string>): Promise<'created' | 'exists'>;
  removeVolume(name: string): Promise<void>;
  listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]>;

  /** Creates a network, or accepts an existing one only when it carries every given label. */
  ensureNetwork(name: string, labels: Record<string, string>): Promise<'created' | 'exists'>;
  removeNetwork(name: string): Promise<void>;
  listNetworks(labels: Record<string, string>): Promise<NetworkInfo[]>;

  /**
   * Creates the container without starting it (`create`), then inspects it and verifies mounts, the
   * loopback port and the network (H1, L1). A container that came out wrong is deleted and this throws.
   */
  create(spec: PcRunSpec): Promise<PcContainerInfo>;
  /** `create` + `start` (tests and tools; PcManager re-checks the Vault in between). */
  run(spec: PcRunSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutSeconds?: number): Promise<void>;
  /** Deletes the container (stopping it first); its named volumes are kept. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<PcContainerInfo | null>;
  /** Containers (running or not) carrying every given label. */
  list(labels: Record<string, string>): Promise<PcContainerInfo[]>;
  /**
   * Bytes actually allocated on the host by the given containers' root filesystems and volumes (sparse
   * images: allocated blocks, not their nominal size). Unknown entries are left out (Docker: none).
   */
  diskUsage(containers: readonly string[], volumes: readonly VolumeInfo[]): Promise<Map<string, number>>;
  /** `exec` inside a running container (diagnostics and tests; agents use spacesd). */
  exec(
    name: string,
    argv: readonly string[],
    options?: { user?: string; timeoutMs?: number },
  ): Promise<ExecResult>;
}

/** Validation shared by the argument builders. */
export function assertRunSpec(spec: PcRunSpec): void {
  const fail = (m: string) => {
    throw new Error(`invalid PC run spec: ${m}`);
  };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(spec.name)) fail(`name ${spec.name}`);
  if (!Number.isInteger(spec.cpus) || spec.cpus < 1) fail(`cpus ${spec.cpus}`);
  if (!Number.isInteger(spec.memoryMiB) || spec.memoryMiB < 256) fail(`memoryMiB ${spec.memoryMiB}`);
  if (!Number.isInteger(spec.shmMiB) || spec.shmMiB < 0 || spec.shmMiB > spec.memoryMiB) {
    fail(`shmMiB ${spec.shmMiB}`);
  }
  if (!Number.isInteger(spec.hostPort) || spec.hostPort < 1024 || spec.hostPort > 65535) {
    fail(`hostPort ${spec.hostPort}`);
  }
  // `,` and `=` break `--mount` directives in 1.5.0; `:` breaks MV_CHOWN_PATHS.
  const pathOk = (p: string) => p.startsWith('/') && !/[,=:\n\r\0]/.test(p);
  for (const b of spec.binds) {
    if (!pathOk(b.source) || !pathOk(b.target)) fail(`bind ${b.source} -> ${b.target}`);
  }
  for (const v of spec.volumes) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(v.name)) fail(`volume name ${v.name}`);
    if (!pathOk(v.target)) fail(`volume target ${v.target}`);
    if (!(v.sizeGiB > 0)) fail(`volume size ${v.sizeGiB}`);
  }
  if (spec.network !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(spec.network))
    fail(`network ${spec.network}`);
  if (spec.kernel !== undefined && !pathOk(spec.kernel)) fail(`kernel ${spec.kernel}`);
  if (spec.virtualization && spec.kernel === undefined) fail('virtualization without a kernel');
  for (const [k, v] of Object.entries(spec.labels)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(k) || /[\n\r\0=,]/.test(v)) fail(`label ${k}`);
  }
  for (const [k, v] of Object.entries(spec.env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\n\r\0]/.test(v)) fail(`env ${k}`);
  }
  for (const k of Object.keys(spec.secretEnv)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) fail(`secret env ${k}`);
    if (k in spec.env) fail(`env ${k} given twice`);
  }
}

/** Binds before volumes, shallow before deep, so overlays land on top of their bind. */
export function orderedMounts(spec: PcRunSpec): { binds: BindMount[]; volumes: VolumeMount[] } {
  const depth = (p: string) => p.split('/').filter(Boolean).length;
  return {
    binds: [...spec.binds].sort((a, b) => depth(a.target) - depth(b.target)),
    volumes: [...spec.volumes].sort((a, b) => depth(a.target) - depth(b.target)),
  };
}

/**
 * Compares the mounts a container actually got with what was asked (S5: `-v …:ro` silently produced
 * a writable mount at a wrong path, so we never trust the CLI). Returns the problems found.
 */
export function mountProblems(spec: PcRunSpec, info: PcContainerInfo): string[] {
  const problems: string[] = [];
  for (const want of spec.binds) {
    const got = info.binds.find((b) => b.target === want.target);
    if (!got) problems.push(`bind ${want.target} missing`);
    else {
      if (got.source !== want.source) problems.push(`bind ${want.target} has source ${got.source}`);
      if (got.readonly !== want.readonly) {
        problems.push(`bind ${want.target} is ${got.readonly ? 'read-only' : 'read-write'}`);
      }
    }
  }
  for (const got of info.binds) {
    if (!spec.binds.some((b) => b.target === got.target)) problems.push(`unexpected bind at ${got.target}`);
  }
  for (const want of spec.volumes) {
    const got = info.volumes.find((v) => v.target === want.target);
    if (!got) problems.push(`volume ${want.name} at ${want.target} missing`);
    else if (got.name !== want.name) problems.push(`volume at ${want.target} is ${got.name}`);
  }
  return problems;
}

/** The spacesd port must be published on 127.0.0.1 only, on the port asked for (L1). */
export function portProblems(want: Pick<PcRunSpec, 'hostPort'>, info: PcContainerInfo): string[] {
  const problems: string[] = [];
  if (info.hostAddress !== '127.0.0.1') {
    problems.push(`spacesd is published on ${info.hostAddress ?? 'no address'}, not 127.0.0.1`);
  }
  if (info.hostPort !== want.hostPort)
    problems.push(`spacesd is published on port ${info.hostPort ?? 'none'}`);
  return problems;
}

/** `docker.io/library/x` and `x` name the same image. */
export function normalizeImageRef(ref: string): string {
  return ref.replace(/^docker\.io\//, '').replace(/^library\//, '');
}

/**
 * Everything about an existing container that must match the PC record before it is reused or adopted
 * (M10): image, resources, mounts, volumes, labels, network and a loopback-only port. The token and the
 * port number are not compared (the token is not visible; the port may differ).
 */
export function specProblems(want: PcRunSpec, info: PcContainerInfo): string[] {
  const problems: string[] = [];
  if (info.image !== undefined && normalizeImageRef(info.image) !== normalizeImageRef(want.image)) {
    problems.push(`image is ${info.image}, not ${want.image}`);
  }
  if (info.cpus !== undefined && info.cpus !== want.cpus) problems.push(`cpus ${info.cpus} != ${want.cpus}`);
  if (info.memoryBytes !== undefined && info.memoryBytes !== want.memoryMiB * 1024 * 1024) {
    problems.push(`memory ${info.memoryBytes} != ${want.memoryMiB} MiB`);
  }
  if (info.shmBytes !== undefined && want.shmMiB > 0 && info.shmBytes !== want.shmMiB * 1024 * 1024) {
    problems.push(`shm ${info.shmBytes} != ${want.shmMiB} MiB`);
  }
  problems.push(...mountProblems(want, info));
  for (const got of info.volumes) {
    if (!want.volumes.some((v) => v.target === got.target))
      problems.push(`unexpected volume at ${got.target}`);
  }
  if (!hasLabels(info.labels, want.labels)) problems.push('labels differ');
  if (want.network && info.networks && !info.networks.includes(want.network)) {
    problems.push(`not on network ${want.network}`);
  }
  if (info.virtualization !== undefined && info.virtualization !== (want.virtualization ?? false)) {
    problems.push(`virtualization is ${info.virtualization ? 'on' : 'off'}`);
  }
  // L1 (strict): a missing host address is as unacceptable as a wrong one.
  if (info.hostAddress !== '127.0.0.1') {
    problems.push(`spacesd is published on ${info.hostAddress ?? 'no host address'}, not 127.0.0.1`);
  }
  if (info.hostPort === undefined) problems.push('spacesd port is not published');
  return problems;
}
