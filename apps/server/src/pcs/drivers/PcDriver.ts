import type { ExecResult } from './exec.js';

/** spacesd's port inside every Linux PC. */
export const SPACESD_GUEST_PORT = 3211;

/** Label key every MineVibe container and volume carries; the value scopes it (`pc`, `pc-test`). */
export const MANAGED_LABEL = 'minevibe';
/** Label carrying the PC id. */
export const PC_ID_LABEL = 'minevibe.pc';

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
  binds: BindMount[];
  volumes: VolumeMount[];
  labels: Record<string, string>;
  /** Plain env (`-e K=V`); never secrets. */
  env: Record<string, string>;
  /**
   * Secret env: only the name goes into argv (`-e NAME`, inherited); the value is placed in the CLI's
   * own environment, so it never appears in a process listing.
   */
  secretEnv: Record<string, string>;
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
  ipv4?: string;
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
  sizeBytes?: number;
}

export type Progress = (message: string) => void;

/** The container-engine side of a Linux PC (Apple `container` or Docker). */
export interface PcDriver {
  readonly kind: 'apple-container' | 'docker';
  /** vCPUs the engine adds on top of `--cpus` (Apple `container`: 1). */
  readonly cpuOverhead: number;
  /** Whether volume size caps are enforced. */
  readonly capsVolumes: boolean;

  /** Provisions/starts the engine (or verifies it is reachable). Throws when it is down or foreign. */
  ensureEngine(onProgress?: Progress): Promise<void>;
  /** Stops the engine on quit, only when this process owns it. Returns whether it stopped. */
  shutdownEngine(): Promise<boolean>;

  imageExists(ref: string): Promise<boolean>;
  pullImage(ref: string, onProgress?: Progress): Promise<void>;
  buildImage(
    options: { contextDir: string; file: string; tag: string },
    onProgress?: Progress,
  ): Promise<void>;

  ensureVolume(volume: VolumeMount, labels: Record<string, string>): Promise<'created' | 'exists'>;
  removeVolume(name: string): Promise<void>;
  listVolumes(labels: Record<string, string>): Promise<VolumeInfo[]>;

  /** Creates and starts a container (`run -d`). Verifies the mounts that actually came up. */
  run(spec: PcRunSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutSeconds?: number): Promise<void>;
  /** Deletes the container (stopping it first); its named volumes are kept. */
  remove(name: string): Promise<void>;
  inspect(name: string): Promise<PcContainerInfo | null>;
  /** Containers (running or not) carrying every given label. */
  list(labels: Record<string, string>): Promise<PcContainerInfo[]>;
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
  if (!Number.isInteger(spec.shmMiB) || spec.shmMiB < 0) fail(`shmMiB ${spec.shmMiB}`);
  if (!Number.isInteger(spec.hostPort) || spec.hostPort < 1024 || spec.hostPort > 65535) {
    fail(`hostPort ${spec.hostPort}`);
  }
  const pathOk = (p: string) => p.startsWith('/') && !/[,\n\r\0]/.test(p) && !p.includes(':');
  for (const b of spec.binds) {
    if (!pathOk(b.source) || !pathOk(b.target)) fail(`bind ${b.source} -> ${b.target}`);
  }
  for (const v of spec.volumes) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(v.name)) fail(`volume name ${v.name}`);
    if (!pathOk(v.target)) fail(`volume target ${v.target}`);
    if (!(v.sizeGiB > 0)) fail(`volume size ${v.sizeGiB}`);
  }
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
