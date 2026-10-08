import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../util/atomicFile.js';
import { instanceIdFor, mountSourceProblem, realpathLoose, tccProtectedReason } from '../util/hostPaths.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import {
  admit,
  type BootCandidate,
  type BudgetSettings,
  type BudgetState,
  computeBudget,
  defaultBudgetSettings,
  GiB,
  type HostFacts,
  type PcAllocation,
  planBoot,
} from './Budget.js';
import { settleWithin } from './deadline.js';
import { EngineError } from './drivers/ContainerRuntime.js';
import {
  hasLabels,
  MANAGED_LABEL,
  PC_ID_LABEL,
  PC_INSTANCE_LABEL,
  type PcContainerInfo,
  type PcDriver,
  type PcRunSpec,
  portProblems,
  specProblems,
  tokenFingerprint,
  type VolumeInfo,
  type VolumeMount,
} from './drivers/PcDriver.js';
import { FrameService, type FrameServiceOptions, type FrameSink } from './FrameService.js';
import { GUEST_HOME, GUEST_USER } from './guest.js';
import { freeDiskBytes, freeLoopbackPort, isLoopbackPortFree, readHostFacts } from './host.js';
import { InputRouter, type InputRouterOptions } from './InputRouter.js';
import { currentRecord, writeInstanceRecord } from './InstanceRegistry.js';
import {
  assertPcId,
  clampResources,
  containerName,
  diskCapsProblem,
  homeVolumeName,
  isAllowedImage,
  isPcType,
  legacyContainerName,
  networkName,
  PC_ID_RE,
  PC_TYPE_SPECS,
  type PcDiskCaps,
  type PcStatus,
  type PcType,
  resourceProblem,
  sanitizeDiskCaps,
  tmpVolumeName,
} from './PcTypes.js';
import type { SpacesdPool } from './SpacesdPool.js';
import {
  crossPcNestingProblem,
  type OtherPcMounts,
  overlayTarget,
  overlayVolumeName,
  prepareOverlayMountpoints,
  recheckMount,
  type VaultMount,
  validateMounts,
} from './Vault.js';

/**
 * PcManager (PLAN §8): `pcs.json`, per-PC tokens, statuses, budget admission, boot order, the
 * container lifecycle (create, start, stop, recreate on resize/type/mount change, reimage,
 * decommission), reconcile by label on start, a monitor (container health, free-disk watchdog) and
 * shutdown.
 *
 * - Every container, volume and network name and label carries this instance's id (a hash of the state
 *   dir), and nothing is reused, stopped or removed without checking its labels first (M1).
 * - The Vault is re-checked (lstat, realpath, refusals, cross-PC nesting) right before every create and
 *   every start (H1). Containers are made with create → verify → start.
 * - A container is reused or adopted only when it matches the record (image, resources, mounts,
 *   volumes, network, loopback port); otherwise it is recreated (M10). A failed plain start recreates
 *   only on a recognized port conflict (M2).
 * - A failed boot stops the container, and the budget counts every container that actually runs, whatever
 *   the PC's status says (H4).
 * - Admission is atomic (N3): one admission at a time, and an admitted start, boot or edit holds a
 *   reservation until it ends, so concurrent operations never overrun the budget between their awaits.
 * - The monitor acts only on what a fresh `inspect` under the PC's lock shows, never on a list taken
 *   before a concurrent start finished (N1). An unresponsive spacesd degrades a PC, never stops it (N2).
 */

export interface PcRecord {
  id: string;
  /** Stable MVF1 `pcSlot`. */
  slot: number;
  type: PcType;
  cpus: number;
  memMiB: number;
  shmMiB: number;
  disk: PcDiskCaps;
  mounts: VaultMount[];
  /** Boot first. */
  pinned: boolean;
  /** Placed in the world (a workstation exists). Unplugged PCs keep their disks but don't boot. */
  plugged: boolean;
  /** Last loopback port used for spacesd. */
  hostPort?: number;
  /** Image override (defaults to the type's image; must pass the allowlist). */
  image?: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Display name (`pc.config{name}`); the id when unset. */
  name?: string;
  /** Reimage this PC when the world ends (PLAN §8.1 "World reset"). */
  wipeOnDeath?: boolean;
}

/** A display name: one line of 1–32 printable characters, or null. */
export function cleanPcName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
  const n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return n.length >= 1 && [...n].length <= 32 ? n : null;
}

interface PcsFile {
  version: 1;
  nextSlot: number;
  pcs: PcRecord[];
}

/** Machine-readable cause of an `error` (or other) status. */
export type PcStatusReason =
  | 'low_disk'
  | 'crashed'
  /** On a `running` PC: spacesd fails its health checks (degraded; the PC is not stopped for it, N2). */
  | 'unresponsive'
  /** On a `running` PC: its loopback port was taken, so the container was recreated on a new one. */
  | 'port_conflict'
  | 'boot_failed'
  | 'stop_failed'
  | 'vault_refused'
  | 'not_ours';

export interface PcStatusInfo {
  status: PcStatus;
  /** 0–100 for `downloading` and `booting`. */
  progress?: number;
  detail?: string;
  reason?: PcStatusReason;
}

/** One row of `pc.state`. */
export interface PcView {
  pcId: string;
  slot: number;
  type: PcType;
  status: PcStatus;
  progress?: number;
  detail?: string;
  reason?: PcStatusReason;
  cpus: number;
  memMb: number;
  mounts: { host: string; ro: boolean }[];
  plugged: boolean;
  pinned: boolean;
  display: [number, number];
}

export type DiskLevel = 'ok' | 'low' | 'critical';

export type PcManagerEvents = {
  'pc.state': [PcView[]];
  'pc.status': [string, PcStatusInfo];
  'budget.state': [BudgetState];
  /** The free-disk watchdog crossed a threshold (M6). */
  'host.disk': [{ freeBytes: number; level: DiskLevel }];
};

export interface PcManagerOptions {
  /** `state/` (pcs.json, tokens). */
  stateDir: string;
  driver: PcDriver;
  pool: SpacesdPool;
  logger?: Logger;
  budget?: Partial<BudgetSettings>;
  /** Host facts provider (defaults to os + statfs of `diskPath`). */
  hostFacts?: () => Promise<HostFacts>;
  /** Path whose volume holds PC disks (the container app root). */
  diskPath?: string;
  /** Value of the `minevibe` label (`pc`; tests use `pc-test-<run>`). */
  labelValue?: string;
  /** Instance id in names and labels (default: a hash of the resolved state dir). */
  instanceId?: string;
  /** Build context for a missing local image (dev fallback, PLAN §9.3). */
  imageBuild?: { contextDir: string; file: string };
  /**
   * The Codex export (PLAN §6.6): mounted read-only at {@link CODEX_GUEST_PATH} in every Linux PC, with a
   * `~/codex` symlink. Null (default) mounts nothing. A folder `container` cannot mount (TCC-protected, or a path
   * `--mount` cannot carry; `config/paths.ts` relocates such exports) is refused with a warning, and PCs run without it.
   */
  codexExport?: string | null;
  /**
   * The instance registry folder (`<appRoot>/minevibe-instances`, InstanceRegistry.ts): `init` records which state dir
   * this instance id belongs to and that this process uses it; `shutdown` clears the process. Null (default): none.
   */
  registryDir?: string | null;
  /** Folders a Vault may never touch (MineVibe's own data). */
  vaultForbidden?: string[];
  home?: string;
  bootTimeoutMs?: number;
  /** Stop all PCs within this on shutdown. */
  shutdownTimeoutMs?: number;
  /** Free-disk watchdog thresholds (M6): warn below 20 GiB, stop PCs below 10 GiB. */
  diskWatch?: { warnBelowGiB?: number; stopBelowGiB?: number };
  /** Monitor period for {@link PcManager.startMonitor} (default 10 s). */
  monitorIntervalMs?: number;
  /**
   * Consecutive failed spacesd health probes before a running PC is marked `unresponsive` (default 3).
   * It stays `running` (degraded) and is probed less and less often; it is never stopped for it (N2).
   */
  unresponsiveAfter?: number;
  /**
   * Probing the stored loopback port before reusing a container: it counts as taken only when every one
   * of `attempts` probes `intervalMs` apart finds it taken (default 6 × 250 ms), so a port the engine
   * releases a moment after a stop never makes us recreate (and reset the rootfs).
   */
  portProbe?: { attempts?: number; intervalMs?: number };
  now?: () => number;
}

export class PcError extends Error {
  readonly code:
    | 'OVER_BUDGET'
    | 'MACOS_SLOTS'
    | 'PATH_REFUSED'
    | 'UNKNOWN_PC'
    | 'UNAVAILABLE'
    | 'ENGINE_DOWN'
    | 'BUSY'
    | 'INVALID';
  readonly resource?: string;
  constructor(code: PcError['code'], message: string, resource?: string) {
    super(message);
    this.name = 'PcError';
    this.code = code;
    if (resource !== undefined) this.resource = resource;
  }
}

/** Where the Codex export is mounted in a Linux PC (PLAN §6.6), read-only. */
export const CODEX_GUEST_PATH = '/mnt/codex';

/** Why the Codex export cannot be bind-mounted into a PC by this driver (or null). */
export function codexMountProblem(
  dir: string,
  driver: Pick<PcDriver, 'kind'>,
  options: { home?: string; platform?: NodeJS.Platform } = {},
): string | null {
  const bad = mountSourceProblem(dir);
  if (bad) return bad;
  if (driver.kind === 'apple-container' && (options.platform ?? process.platform) === 'darwin') {
    const tcc = tccProtectedReason(dir, options.home ?? homedir());
    if (tcc) return `${tcc} (TCC-protected: the container engine cannot read it)`;
  }
  return null;
}

/** Statuses during which a PC holds (or is about to hold) CPU and RAM. */
const ACTIVE: ReadonlySet<PcStatus> = new Set([
  'downloading',
  'booting',
  'running',
  'stopping',
  'remounting',
  'reimaging',
]);

/** Errors from `container start` that mean "the loopback port is taken" (the one case that recreates). */
export function isPortConflictError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /address already in use|EADDRINUSE|port \d* ?(?:is )?(?:already )?(?:in use|allocated|taken)/i.test(
    msg,
  );
}

/** The instance id for a state dir: 8 hex chars of sha256(realpath) (util/hostPaths.ts). */
export { instanceIdFor };

const MAX_MOUNTS = 16;
const MAX_OVERLAYS_PER_MOUNT = 16;
const ORPHANS_ID = '#orphaned-volumes';
const fmtGiB = (b: number) => `${(b / GiB).toFixed(1)} GiB`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Same folders, modes and overlays, in the same order. */
export function sameMounts(a: readonly VaultMount[], b: readonly VaultMount[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const o = b[i] as VaultMount;
      return (
        m.host === o.host &&
        m.ro === o.ro &&
        m.overlays.length === o.overlays.length &&
        m.overlays.every((x, j) => x === o.overlays[j])
      );
    })
  );
}

interface Inventory {
  /** Containers of this instance, by PC id. */
  live: Map<string, PcContainerInfo>;
  /** Volumes of this instance (null when the engine could not be asked). */
  volumes: VolumeInfo[] | null;
}

export class PcManager extends TypedEmitter<PcManagerEvents> {
  readonly driver: PcDriver;
  readonly pool: SpacesdPool;
  readonly instanceId: string;
  readonly #o: PcManagerOptions;
  readonly #log: Logger | undefined;
  readonly #budget: BudgetSettings;
  readonly #label: string;
  readonly #now: () => number;
  #file: PcsFile = { version: 1, nextSlot: 1, pcs: [] };
  readonly #status = new Map<string, PcStatusInfo>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Ids handed out by `create` but not yet in `#file` (M9). */
  readonly #reservedIds = new Set<string>();
  #engineDown: string | null = null;
  /** Set when `shutdown` begins: nothing starts any more (a `bootAll` still going stops planning starts). */
  #closing = false;
  #frames: FrameService | null = null;
  #input: InputRouter | null = null;
  /** Coalescing save queue (M8). */
  #saving: Promise<void> | null = null;
  #saveDirty = false;
  /** Last known containers of this instance (H4: what actually runs). */
  #live = new Map<string, PcContainerInfo>();
  #builds = 0;
  /** Admitted activations that may build their image: the builder VM's RAM stays reserved for them. */
  #builderHolds = 0;
  #monitorTimer: NodeJS.Timeout | null = null;
  #monitoring = false;
  /** `bootAll` calls in progress: the monitor leaves strays to them (they adopt or stop them, N7). */
  #bootAlls = 0;
  readonly #healthFails = new Map<string, number>();
  /** Monitor pass before which a degraded PC is not probed again (N2 backoff). */
  readonly #healthNext = new Map<string, number>();
  #pass = 0;
  #diskLevel: DiskLevel = 'ok';
  /** Bumped on every status change of a PC; work started under an older epoch is stale (N1). */
  readonly #epochs = new Map<string, number>();
  /** Admitted activations still in progress, by PC (refcounted, N3). */
  readonly #reservations = new Map<string, number>();
  /** Tail of the global admission queue (N3). */
  #admissionTail: Promise<void> = Promise.resolve();
  /** A note shown with the next `running` status (why the container was recreated). */
  readonly #notes = new Map<string, { reason: PcStatusReason; detail: string }>();
  /** The Codex export bind-mounted at {@link CODEX_GUEST_PATH}, or null. */
  readonly #codex: string | null;

  constructor(options: PcManagerOptions) {
    super();
    this.#o = options;
    this.driver = options.driver;
    this.pool = options.pool;
    this.#log = options.logger;
    this.#budget = defaultBudgetSettings(options.budget);
    this.#label = options.labelValue ?? 'pc';
    this.#now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? instanceIdFor(options.stateDir);
    this.#codex = this.#codexSource(options.codexExport ?? null);
  }

  #codexSource(dir: string | null): string | null {
    if (!dir) return null;
    // The real path, like a Vault folder's: what the engine reports for the bind must match the record exactly
    // (a temp home under /var/folders is /private/var/folders to the engine).
    const real = realpathLoose(resolve(dir));
    const why = codexMountProblem(real, this.driver, this.#o.home ? { home: this.#o.home } : {});
    if (why) {
      this.#log?.warn(
        { dir, why },
        'the Codex export cannot be mounted into PCs; they run without /mnt/codex',
      );
      return null;
    }
    return real;
  }

  /** The host folder mounted at {@link CODEX_GUEST_PATH}, or null when PCs get no Codex. */
  get codexExport(): string | null {
    return this.#codex;
  }

  /** Where a PC sees the Codex (`/mnt/codex`), or null when it has none (no export, or not a Linux PC). */
  codexPathOf(id: string): string | null {
    const p = this.#file.pcs.find((x) => x.id === id);
    return this.#codex && p && PC_TYPE_SPECS[p.type].family === 'linux' ? CODEX_GUEST_PATH : null;
  }

  protected override onListenerError(event: string, error: unknown): void {
    this.#log?.warn({ event, err: String(error) }, 'pc manager listener failed');
  }

  get pcsFile(): string {
    return join(this.#o.stateDir, 'pcs.json');
  }

  get tokensDir(): string {
    return join(this.#o.stateDir, 'pc-tokens');
  }

  /** Labels every container, volume and network of this instance carries. */
  get labels(): Record<string, string> {
    return { [MANAGED_LABEL]: this.#label, [PC_INSTANCE_LABEL]: this.instanceId };
  }

  #ownerLabels(id: string): Record<string, string> {
    return { ...this.labels, [PC_ID_LABEL]: id };
  }

  /** Container name of a PC of this instance. */
  containerNameOf(id: string): string {
    return containerName(id, this.instanceId);
  }

  /** Network name of a PC of this instance. */
  networkNameOf(id: string): string {
    return networkName(id, this.instanceId);
  }

  /** Home volume name of a PC of this instance. */
  homeVolumeOf(id: string): string {
    return homeVolumeName(id, this.instanceId);
  }

  // ------------------------------------------------------------------ persistence

  /** Loads `pcs.json`; creates `linux-1` when there are no PCs yet (`createDefault`, default true). */
  async init(options: { createDefault?: boolean } = {}): Promise<PcRecord[]> {
    await mkdir(this.#o.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tokensDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.pcsFile)) {
      const raw = JSON.parse(await readFile(this.pcsFile, 'utf8')) as Partial<PcsFile>;
      const pcs = (raw.pcs ?? [])
        .filter((p) => isPcType(p.type) && typeof p.id === 'string' && PC_ID_RE.test(p.id))
        .map((p) => {
          const rec: PcRecord = { ...p, disk: sanitizeDiskCaps(p.type, p.disk) };
          const name = cleanPcName(p.name);
          if (name) rec.name = name;
          else delete rec.name;
          if (typeof p.wipeOnDeath !== 'boolean') delete rec.wipeOnDeath;
          return rec;
        });
      const maxSlot = pcs.reduce((n, p) => Math.max(n, p.slot ?? 0), 0);
      this.#file = { version: 1, nextSlot: Math.max(raw.nextSlot ?? 1, maxSlot + 1), pcs };
    }
    if (this.#file.pcs.length === 0 && (options.createDefault ?? true)) {
      await this.#addRecord(this.#newRecord('linux-1', 'linux', {}));
    }
    for (const p of this.#file.pcs) if (!this.#status.has(p.id)) this.#status.set(p.id, { status: 'off' });
    await this.#register(true);
    return this.list();
  }

  /**
   * Records this instance in the registry (InstanceRegistry.ts): its state dir, and whether this process uses it
   * (`using`) or let go of it. Best effort: a registry that cannot be written only costs `doctor --clean-orphans` its
   * knowledge of this home.
   */
  async #register(using: boolean): Promise<void> {
    const dir = this.#o.registryDir;
    if (!dir) return;
    try {
      const rec = await currentRecord(this.instanceId, resolve(this.#o.stateDir), this.#label);
      await writeInstanceRecord(dir, using ? rec : { ...rec, pid: null, started: null });
    } catch (err) {
      this.#log?.warn({ err: errText(err), dir }, 'could not write the PC instance registry');
    }
  }

  /**
   * Writes `pcs.json` (M8): one write at a time, and a save requested while a write runs is folded into
   * one more write of the then-current state, so a slow earlier write can never land last with older data.
   * Resolves once a write that started after the call has finished.
   */
  #save(): Promise<void> {
    this.#saveDirty = true;
    this.#saving ??= (async () => {
      try {
        while (this.#saveDirty) {
          this.#saveDirty = false;
          await writeFileAtomic(this.pcsFile, `${JSON.stringify(this.#file, null, 2)}\n`, {
            mode: 0o600,
            dirMode: 0o700,
          });
        }
      } finally {
        this.#saving = null;
      }
    })();
    return this.#saving;
  }

  #newRecord(
    id: string,
    type: PcType,
    r: Partial<Pick<PcRecord, 'cpus' | 'memMiB' | 'shmMiB' | 'pinned' | 'plugged' | 'image'>>,
  ): PcRecord {
    const spec = PC_TYPE_SPECS[type];
    const res = clampResources(type, r);
    return {
      id: assertPcId(id),
      slot: 0,
      type,
      ...res,
      disk: { ...spec.disk },
      mounts: [],
      pinned: r.pinned ?? false,
      plugged: r.plugged ?? true,
      ...(r.image ? { image: r.image } : {}),
      createdAt: this.#now(),
    };
  }

  async #addRecord(rec: PcRecord): Promise<PcRecord> {
    this.#pushRecord(rec);
    await this.#save();
    return rec;
  }

  /** Adds a record in memory (synchronous: runs inside the admission critical section). */
  #pushRecord(rec: PcRecord): void {
    rec.slot = this.#file.nextSlot++;
    this.#file.pcs.push(rec);
    this.#status.set(rec.id, { status: 'off' });
  }

  list(): PcRecord[] {
    return this.#file.pcs.map((p) => structuredClone(p));
  }

  get(id: string): PcRecord | undefined {
    const p = this.#file.pcs.find((r) => r.id === id);
    return p ? structuredClone(p) : undefined;
  }

  #rec(id: string): PcRecord {
    const p = this.#file.pcs.find((r) => r.id === id);
    if (!p) throw new PcError('UNKNOWN_PC', `no PC ${id}`);
    return p;
  }

  slotOf(id: string): number | undefined {
    return this.#file.pcs.find((r) => r.id === id)?.slot;
  }

  idOfSlot(slot: number): string | undefined {
    return this.#file.pcs.find((r) => r.slot === slot)?.id;
  }

  // ------------------------------------------------------------------ tokens (0600, never logged)

  #tokenPath(id: string): string {
    return join(this.tokensDir, `${assertPcId(id)}.token`);
  }

  async #rotateToken(id: string): Promise<string> {
    const token = randomBytes(24).toString('hex');
    await writeFileAtomic(this.#tokenPath(id), `${token}\n`, { mode: 0o600, dirMode: 0o700 });
    await chmod(this.#tokenPath(id), 0o600);
    return token;
  }

  async #readToken(id: string): Promise<string | null> {
    try {
      const t = (await readFile(this.#tokenPath(id), 'utf8')).trim();
      return t || null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ status

  status(id: string): PcStatusInfo {
    return this.#status.get(id) ?? { status: 'off' };
  }

  #setStatus(id: string, info: PcStatusInfo): void {
    const prev = this.#status.get(id);
    if (
      prev &&
      prev.status === info.status &&
      prev.progress === info.progress &&
      prev.detail === info.detail &&
      prev.reason === info.reason
    )
      return;
    this.#status.set(id, info);
    if (prev?.status !== info.status) this.#epochs.set(id, this.#epochOf(id) + 1);
    if (info.status === 'running' && prev?.status !== 'running') {
      this.#healthFails.delete(id);
      this.#healthNext.delete(id);
      this.#frames?.wake(id);
    }
    this.emit('pc.status', id, info);
    this.emit('pc.state', this.views());
  }

  #epochOf(id: string): number {
    return this.#epochs.get(id) ?? 0;
  }

  #setError(id: string, err: unknown, reason: PcStatusReason): void {
    const r: PcStatusReason =
      err instanceof PcError && err.code === 'PATH_REFUSED'
        ? 'vault_refused'
        : err instanceof PcError && err.code === 'BUSY'
          ? 'not_ours'
          : reason;
    this.#setStatus(id, { status: 'error', detail: errText(err), reason: r });
  }

  views(): PcView[] {
    return this.#file.pcs.map((p) => {
      const s = this.status(p.id);
      return {
        pcId: p.id,
        slot: p.slot,
        type: p.type,
        status: s.status,
        ...(s.progress !== undefined ? { progress: s.progress } : {}),
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
        ...(s.reason !== undefined ? { reason: s.reason } : {}),
        cpus: p.cpus,
        memMb: p.memMiB,
        mounts: p.mounts.map((m) => ({ host: m.host, ro: m.ro })),
        plugged: p.plugged,
        pinned: p.pinned,
        display: PC_TYPE_SPECS[p.type].display,
      };
    });
  }

  // ------------------------------------------------------------------ budget

  #settings(): BudgetSettings {
    return { ...this.#budget, builderActive: this.#builds > 0 || this.#builderHolds > 0 };
  }

  /** Reserves the builder VM's RAM until the returned release runs (idempotent). */
  #holdBuilder(): () => void {
    this.#builderHolds++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#builderHolds--;
    };
  }

  /** The image a start of `p` would build locally when it is missing (dev fallback, PLAN §9.3), else null. */
  #localBuildImage(p: PcRecord): string | null {
    if (!this.#o.imageBuild) return null;
    const img = p.image && isAllowedImage(p.type, p.image) ? p.image : PC_TYPE_SPECS[p.type].image;
    return img?.startsWith('minevibe/') ? img : null;
  }

  /** Ids among `pcs` whose start may build an image locally (its image is missing now). */
  async #mayBuild(pcs: readonly PcRecord[]): Promise<Set<string>> {
    const missing = new Map<string, Promise<boolean>>();
    const out = new Set<string>();
    for (const p of pcs) {
      const img = this.#localBuildImage(p);
      if (!img) continue;
      let m = missing.get(img);
      if (!m) {
        m = this.driver.imageExists(img).then(
          (exists) => !exists,
          () => true,
        );
        missing.set(img, m);
      }
      if (await m) out.add(p.id);
    }
    return out;
  }

  /** Crew cap for the claude reserve (L11): the RAM pool is recomputed and broadcast. */
  async setCrewCap(crewCap: number): Promise<BudgetState> {
    if (!Number.isInteger(crewCap) || crewCap < 0 || crewCap > 64) {
      throw new PcError('INVALID', 'crew cap must be an integer between 0 and 64');
    }
    this.#budget.crewCap = crewCap;
    return this.budget();
  }

  /** Containers and volumes of this instance, as the engine reports them now. */
  async #inventory(): Promise<Inventory> {
    let volumes: VolumeInfo[] | null = null;
    try {
      const cs = await this.driver.list(this.labels);
      const live = new Map<string, PcContainerInfo>();
      for (const c of cs) {
        const id = c.labels[PC_ID_LABEL];
        if (id) live.set(id, c);
      }
      this.#live = live;
    } catch (err) {
      this.#log?.debug({ err: errText(err) }, 'container list failed; using the last known');
    }
    try {
      volumes = await this.driver.listVolumes(this.labels);
    } catch {
      volumes = null;
    }
    return { live: this.#live, volumes };
  }

  /** Whether a PC's container actually runs (H4), whatever its status says. */
  #liveActive(id: string): boolean {
    const st = this.#live.get(id)?.state;
    return st === 'running' || st === 'stopping';
  }

  /** Records what a fresh inspect of one PC's container showed. */
  #noteLive(id: string, info: PcContainerInfo | null): void {
    if (info) this.#live.set(id, info);
    else this.#live.delete(id);
  }

  /** Active status, or an admitted operation in progress (N3). */
  #isActive(id: string): boolean {
    return ACTIVE.has(this.status(id).status) || this.#reservations.has(id);
  }

  /** Every volume name a record expects (home, tmp, var/tmp, every configured overlay). */
  #expectedVolumes(p: PcRecord): Set<string> {
    const names = new Set([
      homeVolumeName(p.id, this.instanceId),
      tmpVolumeName(p.id, this.instanceId, 'tmp'),
      tmpVolumeName(p.id, this.instanceId, 'vartmp'),
    ]);
    for (const m of p.mounts) {
      for (const o of m.overlays) names.add(overlayVolumeName(p.id, this.instanceId, m.host, o));
    }
    return names;
  }

  /** Volumes of this instance that no record expects (left by a mount change or a failed removal). */
  #orphanVolumes(volumes: readonly VolumeInfo[]): VolumeInfo[] {
    const expected = new Set<string>();
    for (const p of this.#file.pcs) for (const n of this.#expectedVolumes(p)) expected.add(n);
    return volumes.filter((v) => !expected.has(v.name));
  }

  /**
   * Host facts plus the bytes PC disks already occupy (H5): allocated blocks of each rootfs (at most its
   * allowance) and of each volume (at most its cap), counted back into the disk pool.
   */
  async #hostFactsWith(inv: Inventory | null): Promise<HostFacts> {
    const base = this.#o.hostFacts
      ? await this.#o.hostFacts()
      : await readHostFacts(this.#o.diskPath ?? this.#o.stateDir);
    if (base.diskUsedByPcsBytes !== undefined || !inv) return base;
    try {
      const volumes = inv.volumes ?? [];
      const containers = this.#file.pcs.map((p) => this.containerNameOf(p.id));
      const usage = await this.driver.diskUsage(containers, volumes);
      let used = 0;
      for (const p of this.#file.pcs) {
        used += Math.min(usage.get(this.containerNameOf(p.id)) ?? 0, p.disk.rootfsGiB * GiB);
      }
      for (const v of volumes)
        used += Math.min(usage.get(v.name) ?? 0, v.sizeBytes ?? Number.POSITIVE_INFINITY);
      return { ...base, diskUsedByPcsBytes: used };
    } catch (err) {
      this.#log?.debug({ err: errText(err) }, 'disk usage measurement failed');
      return base;
    }
  }

  async hostFacts(): Promise<HostFacts> {
    return this.#hostFactsWith(await this.#inventory());
  }

  #diskGiB(p: Pick<PcRecord, 'disk' | 'mounts' | 'type'>): number {
    const overlays = p.mounts.reduce((n, m) => n + m.overlays.length, 0);
    return (
      p.disk.rootfsGiB +
      p.disk.homeGiB +
      (p.disk.tmpGiB ?? 0) +
      (p.disk.varTmpGiB ?? 0) +
      overlays * p.disk.overlayGiB
    );
  }

  #alloc(p: PcRecord, active?: boolean): PcAllocation {
    const family = PC_TYPE_SPECS[p.type].family;
    return {
      id: p.id,
      family,
      cpus: p.cpus,
      memMiB: p.memMiB,
      cpuOverhead: family === 'linux' ? this.driver.cpuOverhead : 0,
      active: active ?? (this.#isActive(p.id) || this.#liveActive(p.id)),
      diskGiB: this.#diskGiB(p),
    };
  }

  /** Every PC's allocation plus orphaned volumes' caps (L11). */
  #allocations(inv: Inventory): PcAllocation[] {
    const out = this.#file.pcs.map((p) => this.#alloc(p));
    const orphans = inv.volumes ? this.#orphanVolumes(inv.volumes) : [];
    const bytes = orphans.reduce((n, v) => n + (v.sizeBytes ?? 0), 0);
    if (bytes > 0) {
      out.push({
        id: ORPHANS_ID,
        family: 'linux',
        cpus: 0,
        memMiB: 0,
        cpuOverhead: 0,
        active: false,
        diskGiB: bytes / GiB,
      });
    }
    return out;
  }

  async budget(): Promise<BudgetState> {
    const inv = await this.#inventory();
    const state = computeBudget(await this.#hostFactsWith(inv), this.#settings(), this.#allocations(inv));
    this.emit('budget.state', state);
    return state;
  }

  /** Runs `fn` alone in the global admission queue (N3). */
  #withAdmission<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#admissionTail.then(fn);
    this.#admissionTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Counts a PC as active until the returned release runs (idempotent). */
  #reserve(id: string): () => void {
    this.#reservations.set(id, (this.#reservations.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.#reservations.get(id) ?? 1) - 1;
      if (n > 0) this.#reservations.set(id, n);
      else this.#reservations.delete(id);
    };
  }

  /**
   * Admission (N3): the check and the reservation are one critical section of the global admission
   * queue, so two starts (or a start and an edit, or `bootAll`) can never both be admitted against the
   * same free RAM. An activation (`active`) holds a reservation until `release()`: it counts while the PC
   * downloads, boots or sits between awaits, whatever its status says. `apply` runs inside the critical
   * section right after a successful check (the record change of an edit or a create). An activation
   * that may build its image locally runs the builder VM too: it is admitted only with the builder's RAM
   * reserved, and that reservation is held until `release()` as well.
   */
  async #admit(
    kind: 'create' | 'start' | 'edit',
    p: PcRecord,
    opts: { active: boolean; apply?: () => void },
  ): Promise<{ warnings: string[]; release: () => void }> {
    return this.#withAdmission(async () => {
      const inv = await this.#inventory();
      const host = await this.#hostFactsWith(inv);
      const builder = opts.active && (await this.#mayBuild([p])).has(p.id);
      const settings = builder ? { ...this.#settings(), builderActive: true } : this.#settings();
      const res = admit(host, settings, this.#allocations(inv), {
        kind,
        pc: this.#alloc(p, opts.active),
      });
      if (!res.ok) throw new PcError(res.reason, res.detail, res.resource);
      opts.apply?.();
      if (!opts.active) return { warnings: res.warnings, release: () => {} };
      const releasePc = this.#reserve(p.id);
      const releaseBuilder = builder ? this.#holdBuilder() : () => {};
      return {
        warnings: res.warnings,
        release: () => {
          releasePc();
          releaseBuilder();
        },
      };
    });
  }

  /** Volumes of this instance no PC expects; `remove` deletes them (they hold only build output). */
  async orphanVolumes(options: { remove?: boolean } = {}): Promise<string[]> {
    const orphans = this.#orphanVolumes(await this.driver.listVolumes(this.labels));
    if (options.remove) for (const v of orphans) await this.driver.removeVolume(v.name);
    return orphans.map((v) => v.name);
  }

  // ------------------------------------------------------------------ helpers wired to this manager

  /** A FrameService whose clients and slots come from this manager. */
  createFrameService(
    sink: FrameSink,
    options: Partial<Omit<FrameServiceOptions, 'sink' | 'getClient' | 'slotOf'>> = {},
  ): FrameService {
    this.#frames = new FrameService({
      sink,
      getClient: (id) => this.pool.client(id),
      slotOf: (id) => (this.status(id).status === 'running' ? this.slotOf(id) : undefined),
      jpegFormat: options.jpegFormat ?? this.pool.jpegFormat,
      ...options,
      ...(this.#log ? { logger: this.#log } : {}),
    });
    return this.#frames;
  }

  /** An InputRouter whose clients come from this manager. */
  createInputRouter(options: Partial<Omit<InputRouterOptions, 'getClient'>> = {}): InputRouter {
    this.#input = new InputRouter({
      getClient: (id) => this.pool.client(id),
      ...(this.#log ? { logger: this.#log } : {}),
      ...options,
    });
    return this.#input;
  }

  #serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.#locks.set(id, tail);
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return next;
  }

  /** Viewers let go of the PC; bounded (InputRouter waits at most 2 s for releases, H3). */
  async #detachViewers(id: string): Promise<void> {
    this.#frames?.removePc(id);
    await this.#input?.removePc(id);
    this.pool.unregister(id);
  }

  // ------------------------------------------------------------------ engine

  /** Starts the engine; on failure every Linux PC shows `engine_down`. */
  async engineUp(onProgress?: (m: string) => void): Promise<boolean> {
    try {
      await this.driver.ensureEngine(onProgress);
      this.#engineDown = null;
      for (const p of this.#file.pcs) {
        if (this.status(p.id).status === 'engine_down') this.#setStatus(p.id, { status: 'off' });
      }
      return true;
    } catch (err) {
      const detail =
        err instanceof EngineError && err.code === 'ENGINE_FOREIGN'
          ? 'another container install is running'
          : errText(err);
      this.#engineDown = detail;
      this.#log?.error({ err: detail }, 'PC engine down');
      for (const p of this.#file.pcs) {
        if (PC_TYPE_SPECS[p.type].family === 'linux')
          this.#setStatus(p.id, { status: 'engine_down', detail });
      }
      return false;
    }
  }

  /**
   * Makes sure a PC type's image exists locally (build from the local Containerfile or pull). While a
   * build runs, the builder VM's memory is reserved in the budget (L11).
   */
  async ensureImage(image: string, onProgress?: (m: string) => void): Promise<void> {
    if (await this.driver.imageExists(image)) return;
    if (this.#o.imageBuild && image.startsWith('minevibe/')) {
      this.#builds++;
      try {
        await this.driver.buildImage({ ...this.#o.imageBuild, tag: image }, onProgress);
      } finally {
        this.#builds--;
      }
    } else {
      await this.driver.pullImage(image, onProgress);
    }
  }

  /** Whether an image build (builder VM) is running. */
  get building(): boolean {
    return this.#builds > 0;
  }

  #imageOf(p: PcRecord): string {
    const img = p.image ?? PC_TYPE_SPECS[p.type].image;
    if (!img) throw new PcError('UNAVAILABLE', `${p.type} PCs have no image`);
    if (!isAllowedImage(p.type, img)) throw new PcError('INVALID', `image ${img} is not allowed`);
    return img;
  }

  // ------------------------------------------------------------------ containers (owned only)

  #owns(info: PcContainerInfo, id: string): boolean {
    return hasLabels(info.labels, this.#ownerLabels(id));
  }

  /** Inspects the PC's container; throws when a container of that name is not this instance's (M1). */
  async #inspectOwned(p: PcRecord): Promise<PcContainerInfo | null> {
    const info = await this.driver.inspect(this.containerNameOf(p.id));
    if (info && !this.#owns(info, p.id)) {
      throw new PcError(
        'BUSY',
        `container ${info.name} does not carry this MineVibe's labels; leaving it alone`,
      );
    }
    return info;
  }

  async #stopContainer(p: PcRecord, timeoutSeconds?: number): Promise<void> {
    const info = await this.#inspectOwned(p);
    if (info && info.state !== 'stopped') await this.driver.stop(info.name, timeoutSeconds);
  }

  async #removeContainer(p: PcRecord): Promise<void> {
    const info = await this.#inspectOwned(p);
    if (info) await this.driver.remove(info.name);
  }

  #vaultOptions() {
    return {
      ...(this.#o.home ? { home: this.#o.home } : {}),
      forbidden: [this.#o.stateDir, ...(this.#o.vaultForbidden ?? [])],
    };
  }

  #otherMounts(id: string): OtherPcMounts[] {
    return this.#file.pcs.filter((p) => p.id !== id).map((p) => ({ pcId: p.id, mounts: p.mounts }));
  }

  /** H1: every stored mount must still be exactly what was validated, right before create and start. */
  async #recheckVault(p: PcRecord): Promise<void> {
    for (const m of p.mounts) {
      const why = await recheckMount(m, this.#vaultOptions());
      if (why) throw new PcError('PATH_REFUSED', `${m.host}: ${why}`);
    }
    const nested = crossPcNestingProblem(p.mounts, this.#otherMounts(p.id));
    if (nested) throw new PcError('PATH_REFUSED', nested);
  }

  /** Volumes of a PC: home, /tmp, /var/tmp, plus one per overlay. */
  #volumes(p: PcRecord, overlays: { mount: VaultMount; overlay: string }[]): VolumeMount[] {
    const vols: VolumeMount[] = [
      { name: homeVolumeName(p.id, this.instanceId), target: '/home/cua', sizeGiB: p.disk.homeGiB },
    ];
    if (p.disk.tmpGiB > 0) {
      vols.push({
        name: tmpVolumeName(p.id, this.instanceId, 'tmp'),
        target: '/tmp',
        sizeGiB: p.disk.tmpGiB,
      });
    }
    if (p.disk.varTmpGiB > 0) {
      vols.push({
        name: tmpVolumeName(p.id, this.instanceId, 'vartmp'),
        target: '/var/tmp',
        sizeGiB: p.disk.varTmpGiB,
      });
    }
    for (const { mount, overlay } of overlays) {
      vols.push({
        name: overlayVolumeName(p.id, this.instanceId, mount.host, overlay),
        target: overlayTarget(mount.host, overlay),
        sizeGiB: p.disk.overlayGiB,
      });
    }
    return vols;
  }

  /**
   * The run spec a PC's container must have. Overlay mountpoints are prepared on the host (idempotent;
   * planted symlinks are skipped), so call this only after {@link #recheckVault}.
   */
  async #buildSpec(p: PcRecord, hostPort: number, token?: string): Promise<PcRunSpec> {
    const overlays: { mount: VaultMount; overlay: string }[] = [];
    for (const m of p.mounts) {
      const { ready, skipped } = await prepareOverlayMountpoints(m);
      for (const o of ready) overlays.push({ mount: m, overlay: o });
      if (skipped.length)
        this.#log?.warn({ pcId: p.id, mount: m.host, skipped }, 'overlay mountpoints skipped');
    }
    const env: Record<string, string> = {};
    if (overlays.length)
      env.MV_CHOWN_PATHS = overlays.map((o) => overlayTarget(o.mount.host, o.overlay)).join(':');
    const binds = p.mounts.map((m) => ({ source: m.host, target: m.host, readonly: m.ro }));
    if (this.#codex && PC_TYPE_SPECS[p.type].family === 'linux') {
      // The org module may not have written its first export yet: the source must exist for `container create`.
      await mkdir(this.#codex, { recursive: true });
      binds.push({ source: this.#codex, target: CODEX_GUEST_PATH, readonly: true });
    }
    return {
      name: this.containerNameOf(p.id),
      image: this.#imageOf(p),
      cpus: p.cpus,
      memoryMiB: p.memMiB,
      shmMiB: p.shmMiB,
      hostPort,
      network: this.networkNameOf(p.id),
      binds,
      volumes: this.#volumes(p, overlays),
      labels: { ...this.#ownerLabels(p.id), 'minevibe.type': p.type },
      ownerLabels: this.#ownerLabels(p.id),
      env,
      secretEnv: token ? { CUA_ENV_TOKEN: token } : {},
    };
  }

  // ------------------------------------------------------------------ reconcile + boot

  /**
   * Why an existing container cannot serve as this PC's (M10, L1 strict), or [] when it can: image,
   * resources, mounts, volumes, labels, network, a 127.0.0.1-only port, and the token it was created with
   * (when the engine shows it) must all match.
   */
  async #containerProblems(p: PcRecord, c: PcContainerInfo, token: string | null): Promise<string[]> {
    if (!token) return ['no token for it'];
    const want = await this.#buildSpec(p, c.hostPort ?? 0);
    const problems = specProblems(want, c);
    if (c.tokenSha256 !== undefined && c.tokenSha256 !== tokenFingerprint(token)) {
      problems.push("it was created with another token than this PC's");
    }
    return problems;
  }

  /**
   * Adopts a running container of this PC (under its lock): the Vault is re-checked and the container
   * must match the record; then its endpoint is registered and the PC is `booting` until SERVING. Returns
   * the problems that prevented adoption ([] = adopted).
   */
  async #tryAdoptLocked(rec: PcRecord, c: PcContainerInfo): Promise<string[]> {
    const token = await this.#readToken(rec.id);
    await this.#recheckVault(rec);
    const problems = await this.#containerProblems(rec, c, token);
    if (problems.length) return problems;
    rec.hostPort = c.hostPort as number;
    this.pool.register(rec.id, { url: `http://127.0.0.1:${c.hostPort}`, token: token as string });
    this.#setStatus(rec.id, { status: 'booting', progress: 50 });
    return [];
  }

  /**
   * Matches this instance's containers to records (PLAN §8.1). A running one is adopted only when it
   * matches the record (M10) and publishes on loopback (L1): it registers its endpoint and waits for
   * SERVING in `bootAll`. A mismatched one is stopped (the next start recreates it). Containers without a
   * record are orphans: stopped (never deleted) and returned. Containers from before instance scoping
   * (`mv-pc-<id>`) are reported, and stopped only when provably this instance's (see {@link #reconcileLegacy}).
   */
  async reconcile(): Promise<{
    adopted: string[];
    orphans: string[];
    mismatched: string[];
    legacy: { stopped: string[]; left: string[] };
  }> {
    const containers = await this.driver.list(this.labels);
    const adopted: string[] = [];
    const orphans: string[] = [];
    const mismatched: string[] = [];
    for (const c of containers) {
      const id = c.labels[PC_ID_LABEL];
      const rec = id ? this.#file.pcs.find((p) => p.id === id) : undefined;
      if (!rec || !this.#owns(c, rec.id) || c.name !== this.containerNameOf(rec.id)) {
        orphans.push(c.name);
        if (c.state === 'running') await this.driver.stop(c.name).catch(() => {});
        continue;
      }
      if (c.state !== 'running') {
        this.#setStatus(rec.id, { status: 'off' });
        continue;
      }
      await this.#serialize(rec.id, async () => {
        try {
          const problems = await this.#tryAdoptLocked(rec, c);
          if (problems.length === 0) {
            adopted.push(rec.id);
            return;
          }
          mismatched.push(rec.id);
          this.#log?.warn({ pcId: rec.id, problems }, 'running container does not match its PC; stopping it');
          await this.driver.stop(c.name).catch(() => {});
          this.#setStatus(rec.id, { status: 'off' });
        } catch (err) {
          await this.driver.stop(c.name).catch(() => {});
          this.#setError(rec.id, err, 'boot_failed');
        }
      });
    }
    const legacy = await this.#reconcileLegacy();
    await this.#save();
    await this.#inventory();
    if (orphans.length) this.#log?.warn({ orphans }, 'stopped orphaned PC containers (not deleted)');
    return { adopted, orphans, mismatched, legacy };
  }

  /**
   * M1/N4: containers from before instance scoping are named `mv-pc-<id>` and carry `minevibe=<label>`
   * but no `minevibe.instance`, so the labelled reconcile never sees them and one left running would hold
   * RAM unseen. Several instances may share the engine, so one is stopped (never deleted) only when it is
   * provably ours: a record with that id, the legacy name, the PC label, and the token we hold for that PC
   * (its fingerprint, as `inspect` shows it). Every other one is left alone and reported.
   */
  async #reconcileLegacy(): Promise<{ stopped: string[]; left: string[] }> {
    const stopped: string[] = [];
    const left: string[] = [];
    let cs: PcContainerInfo[];
    try {
      cs = await this.driver.list({ [MANAGED_LABEL]: this.#label });
    } catch (err) {
      this.#log?.debug({ err: errText(err) }, 'legacy container scan failed');
      return { stopped, left };
    }
    for (const c of cs) {
      if (c.labels[PC_INSTANCE_LABEL] !== undefined || !c.name.startsWith('mv-pc-')) continue;
      const id = c.labels[PC_ID_LABEL];
      const rec = id && PC_ID_RE.test(id) ? this.#file.pcs.find((p) => p.id === id) : undefined;
      let ours = false;
      if (rec && c.name === legacyContainerName(rec.id) && c.tokenSha256) {
        const token = await this.#readToken(rec.id);
        ours = !!token && tokenFingerprint(token) === c.tokenSha256;
      }
      if (ours && (c.state === 'running' || c.state === 'stopping')) {
        try {
          await this.driver.stop(c.name);
          stopped.push(c.name);
          continue;
        } catch (err) {
          this.#log?.warn({ name: c.name, err: errText(err) }, 'could not stop a legacy PC container');
        }
      }
      left.push(c.name);
    }
    if (stopped.length)
      this.#log?.warn({ stopped }, 'stopped legacy PC containers of this instance (not deleted)');
    if (left.length) {
      this.#log?.warn(
        { legacy: left },
        "legacy PC containers (no instance label) left alone: not provably this instance's; delete them with `container delete` when unused",
      );
    }
    return { stopped, left };
  }

  /**
   * N7: a PC whose container runs although its status is not active (a failed stop, a create the Node
   * timeout killed, a status reset): adopt it when it is plugged, bootable and matches its record, else
   * stop it. Runs under the PC's lock, so the decision is deterministic before `bootAll` plans.
   */
  async #reconcileStrayLocked(p: PcRecord): Promise<void> {
    if (this.#isActive(p.id)) return;
    const c = await this.#inspectOwned(p);
    this.#noteLive(p.id, c);
    if (!c || (c.state !== 'running' && c.state !== 'stopping')) return;
    const spec = PC_TYPE_SPECS[p.type];
    if (p.plugged && spec.available && !spec.driverStub && !this.#engineDown && c.state === 'running') {
      try {
        const problems = await this.#tryAdoptLocked(p, c);
        if (problems.length === 0) {
          this.#log?.info({ pcId: p.id }, 'adopted a PC container that was still running');
          return;
        }
        this.#log?.warn({ pcId: p.id, problems }, 'a still-running PC container does not match; stopping it');
      } catch (err) {
        this.#log?.warn(
          { pcId: p.id, err: errText(err) },
          'cannot adopt a still-running PC container; stopping it',
        );
      }
    }
    await this.driver.stop(c.name, 5);
    this.#noteLive(p.id, await this.driver.inspect(c.name).catch(() => null));
    this.pool.unregister(p.id);
    this.#setStatus(p.id, { status: 'off' });
  }

  /**
   * Boots every plugged PC in boot-priority order (pinned, then most recently used) with budget
   * admission; PCs that don't fit become `no_capacity` / `macos_slots_full`. Containers that still run
   * for an inactive PC are adopted or stopped first (N7), and the plan is made and reserved in one
   * admission critical section (N3). When a planned start may build its image, the plan counts the
   * builder VM and keeps it reserved until the last such start ends. A PC unplugged after planning is
   * not started (checked under its lock).
   */
  async bootAll(): Promise<{ booted: string[]; refused: string[]; failed: string[] }> {
    this.#bootAlls++;
    try {
      return await this.#bootAll();
    } finally {
      this.#bootAlls--;
    }
  }

  async #bootAll(): Promise<{ booted: string[]; refused: string[]; failed: string[] }> {
    const booted: string[] = [];
    const failed: string[] = [];
    await this.#inventory();
    for (const p of [...this.#file.pcs]) {
      if (this.#isActive(p.id) || !this.#liveActive(p.id)) continue;
      await this.#serialize(p.id, () => this.#reconcileStrayLocked(p)).catch((err: unknown) => {
        this.#log?.warn(
          { pcId: p.id, err: errText(err) },
          'could not reconcile a still-running PC container',
        );
      });
    }
    const { plan, lowDisk, releases, waitFor } = await this.#withAdmission(async () => {
      const inv = await this.#inventory();
      const host = await this.#hostFactsWith(inv);
      const alreadyActive = this.#file.pcs
        .filter((p) => this.#isActive(p.id))
        .map((p) => this.#alloc(p, true));
      const candidates: BootCandidate[] = this.#file.pcs
        .filter((p) => p.plugged && PC_TYPE_SPECS[p.type].available && !PC_TYPE_SPECS[p.type].driverStub)
        .filter((p) => !this.#isActive(p.id) && !this.#liveActive(p.id))
        .map((p) => ({
          ...this.#alloc(p, false),
          pinned: p.pinned,
          ...(p.lastUsedAt !== undefined ? { lastUsedAt: p.lastUsedAt } : {}),
          createdAt: p.createdAt,
        }));
      // Containers that still run for an inactive PC (a stop that failed above) hold their share.
      const strays = this.#file.pcs
        .filter((p) => !this.#isActive(p.id) && this.#liveActive(p.id))
        .map((p) => this.#alloc(p, true));
      const orphanAlloc = this.#allocations(inv).filter((a) => a.id === ORPHANS_ID);
      const mayBuild = await this.#mayBuild(candidates.map((c) => this.#rec(c.id)));
      const settings = this.#settings();
      if (mayBuild.size > 0) settings.builderActive = true;
      const plan = planBoot(host, settings, candidates, [...alreadyActive, ...strays, ...orphanAlloc]);
      const lowDisk = this.#diskFloorProblem(host.diskFreeBytes);
      const releases = new Map<string, () => void>();
      if (!lowDisk) for (const id of plan.boot) releases.set(id, this.#reserve(id));
      // The builder VM stays reserved until the last planned start that may build has ended.
      const lastBuild = plan.boot.findLastIndex((id) => mayBuild.has(id));
      if (!lowDisk && lastBuild >= 0) {
        const releaseBuilder = this.#holdBuilder();
        const lastId = plan.boot[lastBuild] as string;
        const releasePc = releases.get(lastId) ?? (() => {});
        releases.set(lastId, () => {
          releasePc();
          releaseBuilder();
        });
      }
      // Adopted PCs (booting, no operation of their own) only need readiness.
      const waitFor = alreadyActive
        .map((a) => a.id)
        .filter((id) => this.status(id).status === 'booting' && !this.#reservations.has(id));
      return { plan, lowDisk, releases, waitFor };
    });
    try {
      for (const r of plan.refused) {
        this.#setStatus(r.id, {
          status: r.reason === 'MACOS_SLOTS' ? 'macos_slots_full' : 'no_capacity',
          detail: r.detail,
        });
      }
      // PCs that were already running (adopted) only need readiness; a failure stops them (L7, H4).
      for (const id of waitFor) {
        try {
          await this.#serialize(id, async () => {
            if (this.status(id).status !== 'booting') return;
            const p = this.#rec(id);
            try {
              await this.#waitReady(p);
            } catch (err) {
              await this.#failBoot(p, err);
              throw err;
            }
          });
          if (this.status(id).status === 'running') booted.push(id);
        } catch {
          failed.push(id);
        }
      }
      for (const id of plan.boot) {
        // Shutdown began while earlier PCs booted: the rest stay off (their reservations are released below).
        if (this.#closing) break;
        if (lowDisk) {
          this.#setStatus(id, { status: 'error', reason: 'low_disk', detail: lowDisk });
          failed.push(id);
          continue;
        }
        try {
          // Re-checked under the PC's lock: an unplug since planning wins (its stop queues behind this).
          const started = await this.#serialize(id, async () => {
            const p = this.get(id);
            if (!p?.plugged) return false;
            await this.#startLocked(p, { admitted: true });
            return true;
          });
          if (started) booted.push(id);
        } catch (err) {
          failed.push(id);
          this.#log?.warn({ pcId: id, err: errText(err) }, 'PC failed to boot');
        } finally {
          releases.get(id)?.();
        }
      }
    } finally {
      // Idempotent; nothing reserved for this plan outlives it, whatever went wrong above.
      for (const release of releases.values()) release();
    }
    await this.budget();
    return { booted, refused: plan.refused.map((r) => r.id), failed };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Creates a PC record (and boots it when `boot`). Inputs are validated (L4); the id is reserved at once (M9). */
  async create(options: {
    type: PcType;
    id?: string;
    cpus?: number;
    memMiB?: number;
    shmMiB?: number;
    mounts?: { host: string; ro?: boolean; overlays?: string[] }[];
    pinned?: boolean;
    plugged?: boolean;
    image?: string;
    disk?: Partial<PcDiskCaps>;
    boot?: boolean;
  }): Promise<{ pc: PcRecord; warnings: string[] }> {
    if (!isPcType(options.type)) throw new PcError('INVALID', `unknown PC type ${String(options.type)}`);
    const spec = PC_TYPE_SPECS[options.type];
    if (!spec.available)
      throw new PcError('UNAVAILABLE', spec.unavailableReason ?? `${options.type} is unavailable`);
    if (options.id !== undefined && !PC_ID_RE.test(options.id)) {
      throw new PcError('INVALID', `invalid PC id "${options.id}"`);
    }
    const resProblem = resourceProblem({
      ...(options.cpus !== undefined ? { cpus: options.cpus } : {}),
      ...(options.memMiB !== undefined ? { memMiB: options.memMiB } : {}),
      ...(options.shmMiB !== undefined ? { shmMiB: options.shmMiB } : {}),
    });
    if (resProblem) throw new PcError('INVALID', resProblem);
    if (options.disk) {
      const d = diskCapsProblem(options.type, options.disk);
      if (d) throw new PcError('INVALID', d);
    }
    if (options.image !== undefined && !isAllowedImage(options.type, options.image)) {
      throw new PcError('INVALID', `image ${options.image} is not allowed`);
    }
    if ((options.mounts?.length ?? 0) > MAX_MOUNTS)
      throw new PcError('INVALID', `at most ${MAX_MOUNTS} mounts`);
    if (options.mounts?.some((m) => (m.overlays?.length ?? 0) > MAX_OVERLAYS_PER_MOUNT)) {
      throw new PcError('INVALID', `at most ${MAX_OVERLAYS_PER_MOUNT} overlays per mount`);
    }
    // M9: pick and reserve the id synchronously, before the first await.
    const id = options.id ?? this.#nextId(options.type);
    if (this.#file.pcs.some((p) => p.id === id) || this.#reservedIds.has(id)) {
      throw new PcError('BUSY', `PC ${id} already exists`);
    }
    this.#reservedIds.add(id);
    let rec: PcRecord;
    const warnings: string[] = [];
    // With `boot`, the admitted RAM stays reserved until that first start ends (N3).
    let release = () => {};
    try {
      rec = this.#newRecord(id, options.type, options);
      if (options.shmMiB !== undefined && options.shmMiB > rec.memMiB) {
        throw new PcError(
          'INVALID',
          `/dev/shm (${options.shmMiB} MiB) cannot exceed the memory (${rec.memMiB} MiB)`,
        );
      }
      if (options.disk) rec.disk = { ...rec.disk, ...options.disk };
      if (options.mounts?.length) {
        const v = await validateMounts(options.mounts, this.#vaultOptions());
        if (!v.ok) throw new PcError('PATH_REFUSED', v.reason);
        const nested = crossPcNestingProblem(v.mounts, this.#otherMounts(id));
        if (nested) throw new PcError('PATH_REFUSED', nested);
        rec.mounts = v.mounts;
        warnings.push(...v.warnings);
      }
      const made = rec;
      const adm = await this.#admit('create', made, {
        active: !!options.boot,
        apply: () => this.#pushRecord(made),
      });
      release = adm.release;
      warnings.push(...adm.warnings);
      await this.#save();
    } catch (err) {
      release();
      throw err;
    } finally {
      this.#reservedIds.delete(id);
    }
    try {
      if (options.boot) await this.start(rec.id);
    } finally {
      release();
    }
    return { pc: this.get(rec.id) as PcRecord, warnings };
  }

  #nextId(type: PcType): string {
    const prefix = PC_TYPE_SPECS[type].family === 'macos' ? 'mac' : 'linux';
    for (let n = 1; ; n++) {
      const id = `${prefix}-${n}`;
      if (!this.#file.pcs.some((p) => p.id === id) && !this.#reservedIds.has(id)) return id;
    }
  }

  #diskWatch(): { warn: number; stop: number } {
    return {
      warn: (this.#o.diskWatch?.warnBelowGiB ?? 20) * GiB,
      stop: (this.#o.diskWatch?.stopBelowGiB ?? 10) * GiB,
    };
  }

  #diskFloorProblem(freeBytes: number): string | null {
    const { stop } = this.#diskWatch();
    return freeBytes < stop
      ? `only ${fmtGiB(freeBytes)} of disk free (PCs stop below ${fmtGiB(stop)}); free some space first`
      : null;
  }

  async #freeDisk(): Promise<number> {
    if (this.#o.hostFacts) return (await this.#o.hostFacts()).diskFreeBytes;
    return freeDiskBytes(this.#o.diskPath ?? this.#o.stateDir);
  }

  /** Starts a PC (create the container when missing or different) and waits for SERVING. */
  start(id: string): Promise<void> {
    return this.#serialize(id, () => this.#startLocked(this.#rec(id), { admitted: false }));
  }

  async #startLocked(p: PcRecord, opts: { admitted: boolean }): Promise<void> {
    if (this.#closing) throw new PcError('ENGINE_DOWN', 'MineVibe is quitting; no PC starts now');
    const spec = PC_TYPE_SPECS[p.type];
    if (!spec.available) throw new PcError('UNAVAILABLE', spec.unavailableReason ?? 'unavailable');
    if (spec.driverStub) {
      this.#setStatus(p.id, { status: 'error', detail: 'macOS PCs arrive with the Lume driver (M9)' });
      throw new PcError('UNAVAILABLE', 'macOS driver not implemented yet');
    }
    if (this.#engineDown) {
      this.#setStatus(p.id, { status: 'engine_down', detail: this.#engineDown });
      throw new PcError('ENGINE_DOWN', this.#engineDown);
    }
    if (this.status(p.id).status === 'running') return;
    const lowDisk = this.#diskFloorProblem(await this.#freeDisk());
    if (lowDisk) {
      this.#setStatus(p.id, { status: 'error', reason: 'low_disk', detail: lowDisk });
      throw new PcError('OVER_BUDGET', lowDisk, 'disk');
    }
    let release = () => {};
    if (!opts.admitted) {
      try {
        ({ release } = await this.#admit('start', p, { active: true }));
      } catch (err) {
        if (err instanceof PcError) {
          this.#setStatus(p.id, {
            status: err.code === 'MACOS_SLOTS' ? 'macos_slots_full' : 'no_capacity',
            detail: err.message,
          });
        }
        throw err;
      }
    }
    try {
      this.#setStatus(p.id, { status: 'booting', progress: 0 });
      await this.#bootContainer(p);
      await this.#save();
      await this.#waitReady(p);
    } catch (err) {
      await this.#failBoot(p, err);
      throw err;
    } finally {
      release();
    }
  }

  /**
   * H4: a boot that failed anywhere (create, start, SERVING timeout) leaves the PC in `error` with its
   * container stopped, so it holds no RAM the budget doesn't see. A foreign container is never touched.
   */
  async #failBoot(p: PcRecord, err: unknown): Promise<void> {
    this.#notes.delete(p.id);
    this.#setError(p.id, err, 'boot_failed');
    this.pool.unregister(p.id);
    if (err instanceof PcError && err.code === 'BUSY') return;
    try {
      await this.#stopContainer(p, 5);
    } catch (stopErr) {
      this.#log?.warn(
        { pcId: p.id, err: errText(stopErr) },
        'could not stop the container after a failed boot',
      );
    }
    await this.#inventory();
  }

  /** Reuses the PC's container when it matches the record, else (re)creates it. */
  async #bootContainer(p: PcRecord): Promise<void> {
    await this.#recheckVault(p);
    const info = await this.#inspectOwned(p);
    const token = await this.#readToken(p.id);
    if (info && token && info.hostPort) {
      const problems = await this.#containerProblems(p, info, token);
      if (problems.length === 0) {
        const r = await this.#reuse(p, info, token);
        if (r.kind === 'started') return;
        // Visible, not silent: a recreate resets everything outside /home/cua and the Vault.
        const detail = `${r.why}; the container was recreated on a new port (changes outside /home/cua and the Vault were reset)`;
        this.#log?.warn(
          { pcId: p.id, port: info.hostPort, why: r.why },
          'recreating the PC container on a new port',
        );
        this.#notes.set(p.id, { reason: 'port_conflict', detail });
        this.#setStatus(p.id, { status: 'booting', progress: 1, reason: 'port_conflict', detail });
      } else {
        this.#log?.info({ pcId: p.id, problems }, 'container differs from its PC record; recreating it');
      }
    }
    if (info) {
      await this.driver.stop(info.name).catch(() => {});
      await this.driver.remove(info.name);
    }
    await this.#createAndStart(p);
  }

  /**
   * Starts an existing, matching container. Only a recognized port conflict (the stored loopback port is
   * taken now) returns `port_conflict`, which recreates on a fresh port (M2); every other failure throws
   * (the PC goes to `error`; its root filesystem is never wiped silently).
   */
  async #reuse(
    p: PcRecord,
    info: PcContainerInfo,
    token: string,
  ): Promise<{ kind: 'started' } | { kind: 'port_conflict'; why: string }> {
    const port = info.hostPort as number;
    if (info.state !== 'running') {
      if (await this.#portTaken(port)) {
        return { kind: 'port_conflict', why: `loopback port ${port} is in use by another program` };
      }
      await this.#recheckVault(p);
      try {
        await this.driver.start(info.name);
      } catch (err) {
        if (isPortConflictError(err)) {
          return { kind: 'port_conflict', why: `starting on port ${port} failed: ${errText(err)}` };
        }
        throw err;
      }
    }
    await this.#verifyStarted(p, { hostPort: port });
    p.hostPort = port;
    this.pool.register(p.id, { url: `http://127.0.0.1:${port}`, token });
    return { kind: 'started' };
  }

  /**
   * Whether the stored loopback port is really taken: only when every probe of a short series finds it
   * bound, so a port the engine frees a moment after a stop (stop then start, `restart`) is not
   * mistaken for a conflict that would recreate the container.
   */
  async #portTaken(port: number): Promise<boolean> {
    const attempts = Math.max(1, this.#o.portProbe?.attempts ?? 6);
    const interval = this.#o.portProbe?.intervalMs ?? 250;
    for (let i = 0; i < attempts; i++) {
      if (await isLoopbackPortFree(port)) return false;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, interval));
    }
    return true;
  }

  /** L1: after a start the container runs and publishes spacesd on 127.0.0.1:<port> only. */
  async #verifyStarted(p: PcRecord, want: { hostPort: number }): Promise<void> {
    const after = await this.driver.inspect(this.containerNameOf(p.id));
    const problems = after ? portProblems(want, after) : ['the container vanished after start'];
    if (after?.state === 'stopped') problems.push('the container stopped right after start');
    if (problems.length) {
      await this.driver.stop(this.containerNameOf(p.id)).catch(() => {});
      throw new Error(`container start: ${problems.join('; ')}`);
    }
  }

  /** Rotates the token, creates (verified), re-checks the Vault, starts (verified) and registers. */
  async #createAndStart(p: PcRecord): Promise<void> {
    const image = this.#imageOf(p);
    this.#setStatus(p.id, { status: 'booting', progress: 2 });
    if (!(await this.driver.imageExists(image))) {
      this.#setStatus(p.id, { status: 'downloading', progress: 0 });
      await this.ensureImage(image);
      this.#setStatus(p.id, { status: 'booting', progress: 5 });
    }
    await this.#recheckVault(p);
    const hostPort = await freeLoopbackPort(p.hostPort);
    const token = await this.#rotateToken(p.id);
    await this.driver.ensureNetwork(this.networkNameOf(p.id), this.#ownerLabels(p.id));
    const spec = await this.#buildSpec(p, hostPort, token);
    await this.driver.create(spec);
    try {
      // H1: the last check before the folders are shared with the guest.
      await this.#recheckVault(p);
      await this.driver.start(spec.name);
      await this.#verifyStarted(p, { hostPort });
    } catch (err) {
      await this.driver.remove(spec.name).catch(() => {});
      throw err;
    }
    p.hostPort = hostPort;
    this.pool.register(p.id, { url: `http://127.0.0.1:${hostPort}`, token });
  }

  /** Waits for SERVING; a recreate note (port conflict) stays visible through boot and on `running`. */
  async #waitReady(p: PcRecord): Promise<void> {
    const note = this.#notes.get(p.id);
    const booting = (progress: number) =>
      this.#setStatus(p.id, { status: 'booting', progress, ...(note ? { ...note } : {}) });
    booting(this.status(p.id).progress ?? 10);
    await this.pool.waitServing(p.id, {
      timeoutMs: this.#o.bootTimeoutMs ?? 120_000,
      onProgress: (pct) => booting(pct),
    });
    await this.#linkCodex(p);
    this.#notes.delete(p.id);
    this.#setStatus(p.id, { status: 'running', ...(note ? { ...note } : {}) });
  }

  /**
   * `~/codex` → `/mnt/codex` in the guest (PLAN §6.6), made as the guest user once spacesd serves. The home volume
   * keeps it; a `~/codex` the user replaced with a file or folder of their own is left alone. Best effort: a PC whose
   * link failed still runs, and the Codex stays at `/mnt/codex`.
   */
  async #linkCodex(p: PcRecord): Promise<void> {
    if (!this.codexPathOf(p.id)) return;
    const script = `[ -d ${CODEX_GUEST_PATH} ] || exit 0
if [ -L "$HOME/codex" ] || [ ! -e "$HOME/codex" ]; then ln -sfn ${CODEX_GUEST_PATH} "$HOME/codex"; fi`;
    try {
      const out = await this.pool.call(
        p.id,
        (c, signal) =>
          c.run(
            {
              program: 'bash',
              args: ['-c', script],
              env: new Map([['HOME', GUEST_HOME]]),
              user: GUEST_USER,
              stdin: false,
              timeoutMs: 5_000,
            },
            { signal },
          ),
        { retry: false, timeoutMs: 8_000 },
      );
      if (!out.exit.success) {
        this.#log?.warn({ pcId: p.id, code: out.exit.code }, 'could not link ~/codex in the PC');
      }
    } catch (err) {
      this.#log?.debug({ pcId: p.id, err: errText(err) }, 'could not link ~/codex in the PC');
    }
  }

  /** Stops a PC (its container and volumes stay). A failure leaves `error`; the budget still counts a running container. */
  stop(id: string, options: { timeoutSeconds?: number } = {}): Promise<void> {
    return this.#serialize(id, () => this.#stopLocked(this.#rec(id), options));
  }

  async #stopLocked(p: PcRecord, options: { timeoutSeconds?: number } = {}): Promise<void> {
    this.#setStatus(p.id, { status: 'stopping' });
    try {
      await this.#detachViewers(p.id);
      await this.#stopContainer(p, options.timeoutSeconds);
      this.#setStatus(p.id, { status: 'off' });
    } catch (err) {
      this.#setError(p.id, err, 'stop_failed');
      throw err;
    } finally {
      // H4: the budget learns whether the container really stopped.
      await this.#inventory();
    }
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  /**
   * Recreates the container (delete + create) keeping the home volume, overlays and the Vault. Used for
   * resize, type change and mount changes (`container` 1.5.0 has no `update`). Boots it again when it
   * was running.
   */
  recreate(id: string, status: 'booting' | 'remounting' = 'booting'): Promise<void> {
    return this.#serialize(id, () => this.#recreateLocked(this.#rec(id), status));
  }

  async #recreateLocked(p: PcRecord, status: 'booting' | 'remounting'): Promise<void> {
    const wasActive = ACTIVE.has(this.status(p.id).status);
    try {
      if (wasActive) this.#setStatus(p.id, { status, progress: 0 });
      await this.#detachViewers(p.id);
      await this.#stopContainer(p).catch((err: unknown) => {
        if (err instanceof PcError) throw err;
      });
      await this.#removeContainer(p);
      if (!wasActive) {
        this.#setStatus(p.id, { status: 'off' });
        await this.#save();
        return;
      }
      await this.#createAndStart(p);
      await this.#save();
      await this.#waitReady(p);
    } catch (err) {
      await this.#failBoot(p, err);
      throw err;
    }
  }

  /** Resize (cpus/memory/shm) with admission, under the PC's lock (M10); a running PC is recreated (PLAN §8.1). */
  resize(
    id: string,
    r: { cpus?: number; memMiB?: number; shmMiB?: number },
  ): Promise<{ restarted: boolean; warnings: string[] }> {
    const bad = resourceProblem(r);
    if (bad) return Promise.reject(new PcError('INVALID', bad));
    return this.#serialize(id, async () => {
      const cur = this.#rec(id);
      const memMiB = r.memMiB ?? cur.memMiB;
      if (r.shmMiB !== undefined && r.shmMiB > clampResources(cur.type, { memMiB }).memMiB) {
        throw new PcError('INVALID', `/dev/shm (${r.shmMiB} MiB) cannot exceed the memory`);
      }
      const res = clampResources(cur.type, {
        cpus: r.cpus ?? cur.cpus,
        memMiB,
        shmMiB: r.shmMiB ?? cur.shmMiB,
      });
      const next: PcRecord = { ...cur, ...res };
      const active = ACTIVE.has(this.status(id).status);
      const { warnings, release } = await this.#admit('edit', next, {
        active,
        apply: () => Object.assign(cur, res),
      });
      try {
        await this.#save();
        await this.#recreateLocked(cur, 'booting');
      } finally {
        release();
      }
      return { restarted: active, warnings };
    });
  }

  /** Type change (linux ⇄ linux-slim) = recreate with the new type's image. */
  setType(id: string, type: PcType): Promise<void> {
    return this.#serialize(id, async () => {
      const cur = this.#rec(id);
      if (!isPcType(type) || PC_TYPE_SPECS[type].family !== PC_TYPE_SPECS[cur.type].family) {
        throw new PcError('UNAVAILABLE', 'only Linux ⇄ Linux slim changes are possible in place');
      }
      const next: PcRecord = { ...cur, type, ...clampResources(type, cur) };
      const { release } = await this.#admit('edit', next, {
        active: ACTIVE.has(this.status(id).status),
        apply: () => {
          Object.assign(cur, { type, cpus: next.cpus, memMiB: next.memMiB, shmMiB: next.shmMiB });
          if (cur.image && !isAllowedImage(type, cur.image)) delete cur.image;
        },
      });
      try {
        await this.#save();
        await this.#recreateLocked(cur, 'booting');
      } finally {
        release();
      }
    });
  }

  /** Replaces the Vault mounts (validated, no cross-PC nesting) and recreates the container (`remounting`). */
  async setMounts(
    id: string,
    mounts: { host: string; ro?: boolean; overlays?: string[] }[],
  ): Promise<{ warnings: string[] }> {
    if (mounts.length > MAX_MOUNTS) throw new PcError('INVALID', `at most ${MAX_MOUNTS} mounts`);
    const v = await validateMounts(mounts, this.#vaultOptions());
    if (!v.ok) throw new PcError('PATH_REFUSED', v.reason);
    return this.#serialize(id, async () => {
      const cur = this.#rec(id);
      const nested = crossPcNestingProblem(v.mounts, this.#otherMounts(id));
      if (nested) throw new PcError('PATH_REFUSED', nested);
      const next: PcRecord = { ...cur, mounts: v.mounts };
      const adm = await this.#admit('edit', next, {
        active: ACTIVE.has(this.status(id).status),
        apply: () => {
          cur.mounts = v.mounts;
        },
      });
      try {
        await this.#save();
        await this.#recreateLocked(cur, 'remounting');
      } finally {
        adm.release();
      }
      return { warnings: [...v.warnings, ...adm.warnings] };
    });
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.#rec(id).pinned = pinned;
    await this.#save();
  }

  /** Renames a PC (display only; ids never change). */
  async setName(id: string, name: string): Promise<void> {
    const clean = cleanPcName(name);
    if (!clean) throw new PcError('INVALID', 'a PC name is 1–32 characters on one line');
    const p = this.#rec(id);
    if (clean === p.id) delete p.name;
    else p.name = clean;
    await this.#save();
    this.emit('pc.state', this.views());
  }

  /** Whether the PC is reimaged when the world ends. */
  async setWipeOnDeath(id: string, on: boolean): Promise<void> {
    const p = this.#rec(id);
    if (on) p.wipeOnDeath = true;
    else delete p.wipeOnDeath;
    await this.#save();
    this.emit('pc.state', this.views());
  }

  /**
   * One edit of what defines a PC's container (PcConfigScreen "Apply"): its type (Linux ⇄ Linux slim), CPUs,
   * memory and Vault mounts. The edit is admitted once and applied with a single recreate (`remounting` when only
   * the mounts change), instead of one recreate per setting. Nothing changes when nothing differs.
   */
  async reconfigure(
    id: string,
    change: {
      type?: PcType;
      cpus?: number;
      memMiB?: number;
      mounts?: { host: string; ro?: boolean; overlays?: string[] }[];
    },
  ): Promise<{ recreated: boolean; restarted: boolean; warnings: string[] }> {
    const bad = resourceProblem({
      ...(change.cpus !== undefined ? { cpus: change.cpus } : {}),
      ...(change.memMiB !== undefined ? { memMiB: change.memMiB } : {}),
    });
    if (bad) throw new PcError('INVALID', bad);
    if (change.mounts && change.mounts.length > MAX_MOUNTS)
      throw new PcError('INVALID', `at most ${MAX_MOUNTS} mounts`);
    if (change.mounts?.some((m) => (m.overlays?.length ?? 0) > MAX_OVERLAYS_PER_MOUNT)) {
      throw new PcError('INVALID', `at most ${MAX_OVERLAYS_PER_MOUNT} overlays per mount`);
    }
    const v = change.mounts ? await validateMounts(change.mounts, this.#vaultOptions()) : null;
    if (v && !v.ok) throw new PcError('PATH_REFUSED', v.reason);
    const validated = v?.ok ? v : null;
    return this.#serialize(id, async () => {
      const cur = this.#rec(id);
      const type = change.type ?? cur.type;
      if (!isPcType(type) || PC_TYPE_SPECS[type].family !== PC_TYPE_SPECS[cur.type].family) {
        throw new PcError('UNAVAILABLE', 'only Linux ⇄ Linux slim changes are possible in place');
      }
      const res = clampResources(type, {
        cpus: change.cpus ?? cur.cpus,
        memMiB: change.memMiB ?? cur.memMiB,
        shmMiB: cur.shmMiB,
      });
      const mounts = validated ? validated.mounts : cur.mounts;
      if (validated) {
        const nested = crossPcNestingProblem(validated.mounts, this.#otherMounts(id));
        if (nested) throw new PcError('PATH_REFUSED', nested);
      }
      const typeChanged = type !== cur.type;
      const resChanged = res.cpus !== cur.cpus || res.memMiB !== cur.memMiB || res.shmMiB !== cur.shmMiB;
      const mountsChanged = validated !== null && !sameMounts(cur.mounts, validated.mounts);
      const warnings = [...(validated?.warnings ?? [])];
      if (!typeChanged && !resChanged && !mountsChanged)
        return { recreated: false, restarted: false, warnings };
      const next: PcRecord = { ...cur, type, ...res, mounts };
      const active = ACTIVE.has(this.status(id).status);
      const adm = await this.#admit('edit', next, {
        active,
        apply: () => {
          Object.assign(cur, { type, ...res, mounts });
          if (cur.image && !isAllowedImage(type, cur.image)) delete cur.image;
        },
      });
      try {
        await this.#save();
        await this.#recreateLocked(cur, typeChanged || resChanged ? 'booting' : 'remounting');
      } finally {
        adm.release();
      }
      return { recreated: true, restarted: active, warnings: [...warnings, ...adm.warnings] };
    });
  }

  /** The crew cap the claude reserve is computed from. */
  get crewCap(): number {
    return this.#budget.crewCap;
  }

  /** The CPU overcommit factor of the soft CPU limit. */
  get cpuOvercommit(): number {
    return this.#budget.cpuOvercommit;
  }

  /** Sum of a PC's disk caps in GiB (rootfs allowance, home, /tmp, /var/tmp and overlays). */
  diskGiBOf(id: string): number {
    return this.#diskGiB(this.#rec(id));
  }

  /**
   * Plugged = placed in the world. Unplugging stops the PC (disks persist). The flag changes at once, so
   * a start still queued (bootAll) sees it under the PC's lock and skips; the stop decision is made under
   * that lock too, after a start already in flight.
   */
  async setPlugged(id: string, plugged: boolean): Promise<void> {
    const p = this.#rec(id);
    p.plugged = plugged;
    await this.#save();
    if (plugged) return;
    await this.#serialize(id, async () => {
      const cur = this.get(id);
      if (cur && !cur.plugged && ACTIVE.has(this.status(id).status)) await this.#stopLocked(cur);
    });
  }

  /** Records use (seat, input) for boot priority. */
  async markUsed(id: string): Promise<void> {
    this.#rec(id).lastUsedAt = this.#now();
    await this.#save();
  }

  /** Deletes the container and its home/overlay volumes, then (when it was running) runs it fresh. */
  reimage(id: string): Promise<void> {
    return this.#serialize(id, async () => {
      const p = this.#rec(id);
      const wasActive = ACTIVE.has(this.status(id).status);
      try {
        this.#setStatus(id, { status: 'reimaging' });
        await this.#detachViewers(id);
        await this.#destroyContainerAndVolumes(p);
        if (!wasActive) {
          this.#setStatus(id, { status: 'off' });
          return;
        }
        await this.#createAndStart(p);
        await this.#save();
        await this.#waitReady(p);
      } catch (err) {
        await this.#failBoot(p, err);
        throw err;
      }
    });
  }

  /** Removes the PC entirely: container, volumes, network, token and record. Vault folders are untouched. */
  decommission(id: string): Promise<void> {
    return this.#serialize(id, async () => {
      const p = this.#rec(id);
      try {
        this.#setStatus(id, { status: 'stopping' });
        await this.#detachViewers(id);
        await this.#destroyContainerAndVolumes(p);
        for (const n of await this.driver.listNetworks(this.#ownerLabels(id))) {
          await this.driver.removeNetwork(n.name);
        }
      } catch (err) {
        this.#setError(id, err, 'stop_failed');
        throw err;
      }
      await rm(this.#tokenPath(id), { force: true });
      this.#file.pcs = this.#file.pcs.filter((r) => r.id !== id);
      this.#status.delete(id);
      this.#healthFails.delete(id);
      this.#healthNext.delete(id);
      this.#notes.delete(id);
      this.#live.delete(id);
      await this.#save();
      this.emit('pc.state', this.views());
    });
  }

  async #destroyContainerAndVolumes(p: PcRecord): Promise<void> {
    await this.#stopContainer(p).catch((err: unknown) => {
      if (err instanceof PcError) throw err;
    });
    await this.#removeContainer(p);
    // Every volume labelled with this instance and PC (home, tmp, current and earlier overlays); never
    // an unlabelled one or another instance's.
    for (const v of await this.driver.listVolumes(this.#ownerLabels(p.id))) {
      await this.driver.removeVolume(v.name);
    }
  }

  // ------------------------------------------------------------------ monitor (H4, M6)

  /** Runs {@link monitorOnce} every `intervalMs` (default 10 s) until {@link stopMonitor} or shutdown. */
  startMonitor(intervalMs = this.#o.monitorIntervalMs ?? 10_000): void {
    if (this.#monitorTimer) return;
    this.#monitorTimer = setInterval(() => {
      void this.monitorOnce().catch((err: unknown) =>
        this.#log?.warn({ err: errText(err) }, 'pc monitor tick failed'),
      );
    }, intervalMs);
    this.#monitorTimer.unref?.();
  }

  stopMonitor(): void {
    if (this.#monitorTimer) clearInterval(this.#monitorTimer);
    this.#monitorTimer = null;
  }

  /**
   * One monitor pass:
   * - a `running` PC whose container is gone or stopped becomes `error`/`crashed`;
   * - a `running` PC whose spacesd fails `unresponsiveAfter` health probes in a row stays `running` with
   *   reason `unresponsive` (degraded: never stopped for it, N2) and is probed less often (every 1, 2,
   *   4 … 16 passes) until it answers again;
   * - a container that runs although its PC is not active (failed boot or stop, a create the Node
   *   timeout killed) is stopped, unless a `bootAll` runs (it adopts such a container, or stops it, itself);
   * - the free-disk watchdog (M6): below 20 GiB a `host.disk` warning, below 10 GiB every active PC is
   *   stopped with `error`/`low_disk` (the rootfs is an uncapped 512 GiB sparse image).
   * N1: the container list is only a hint. PCs with an operation in progress, or whose status changed
   * since the list was taken, are skipped, and every action re-inspects that PC's container under its
   * lock first, so a PC that finished booting during the pass is never marked crashed or stopped.
   */
  async monitorOnce(): Promise<void> {
    if (this.#monitoring) return;
    this.#monitoring = true;
    try {
      await this.#checkContainers();
      await this.#checkDisk();
    } finally {
      this.#monitoring = false;
    }
  }

  /** A fresh inspect of one PC's container under its lock (null = gone); throws when it cannot tell. */
  async #freshInspect(p: PcRecord): Promise<PcContainerInfo | null> {
    const info = await this.#inspectOwned(p);
    this.#noteLive(p.id, info);
    return info;
  }

  async #checkContainers(): Promise<void> {
    if (this.#engineDown) return;
    this.#pass++;
    const pass = this.#pass;
    // Status epochs as of before the list: a PC whose status moves on meanwhile is not judged by it.
    const epochs = new Map(this.#file.pcs.map((p) => [p.id, this.#epochOf(p.id)]));
    let live: Map<string, PcContainerInfo>;
    try {
      const cs = await this.driver.list(this.labels);
      live = new Map();
      for (const c of cs) {
        const id = c.labels[PC_ID_LABEL];
        if (id) live.set(id, c);
      }
      this.#live = live;
    } catch (err) {
      this.#log?.debug({ err: errText(err) }, 'monitor: container list failed');
      return;
    }
    const limit = this.#o.unresponsiveAfter ?? 3;
    for (const p of [...this.#file.pcs]) {
      const epoch = epochs.get(p.id);
      const unchanged = () => this.#epochOf(p.id) === epoch;
      if (this.#locks.has(p.id) || !unchanged()) continue;
      const st = this.status(p.id).status;
      const c = live.get(p.id);
      const running = c?.state === 'running';
      if (st === 'running' && !running) {
        await this.#serialize(p.id, async () => {
          if (this.status(p.id).status !== 'running' || !unchanged()) return;
          let fresh: PcContainerInfo | null;
          try {
            fresh = await this.#freshInspect(p);
          } catch (err) {
            this.#log?.debug({ pcId: p.id, err: errText(err) }, 'monitor: inspect failed; next pass');
            return;
          }
          if (fresh?.state === 'running' || !unchanged()) return;
          this.#log?.warn({ pcId: p.id, state: fresh?.state ?? 'gone' }, 'PC container stopped unexpectedly');
          await this.#detachViewers(p.id);
          this.#setStatus(p.id, {
            status: 'error',
            reason: 'crashed',
            detail: `the PC's container ${fresh ? `is ${fresh.state}` : 'is gone'}`,
          });
        });
      } else if (st === 'running') {
        if (pass < (this.#healthNext.get(p.id) ?? 0)) continue;
        try {
          const h = await this.pool.health(p.id);
          if (!h.serving) throw new Error(h.status);
          if (!unchanged()) continue;
          this.#healthFails.delete(p.id);
          this.#healthNext.delete(p.id);
          const cur = this.status(p.id);
          if (cur.status === 'running' && cur.reason === 'unresponsive') {
            this.#log?.info({ pcId: p.id }, 'spacesd answers again');
            this.#setStatus(p.id, { status: 'running' });
            this.#frames?.wake(p.id);
          }
        } catch (err) {
          if (!unchanged() || this.status(p.id).status !== 'running') continue;
          const n = (this.#healthFails.get(p.id) ?? 0) + 1;
          this.#healthFails.set(p.id, n);
          if (n >= limit) {
            // N2: degraded, not dead. Only a crash or the user stops it; probe less and less often.
            this.#healthNext.set(p.id, pass + Math.min(16, 2 ** (n - limit)));
            if (this.status(p.id).reason !== 'unresponsive') {
              this.#log?.warn({ pcId: p.id, fails: n, err: errText(err) }, 'PC spacesd is unresponsive');
            }
            this.#setStatus(p.id, {
              status: 'running',
              reason: 'unresponsive',
              detail: `spacesd did not answer ${n} health checks in a row: ${errText(err)}`,
            });
          }
        }
      } else if (!ACTIVE.has(st) && running && c && this.#owns(c, p.id) && this.#bootAlls === 0) {
        // A `bootAll` in progress adopts or stops strays itself: stopping one now would only cost it a restart.
        await this.#serialize(p.id, async () => {
          if (this.#isActive(p.id) || !unchanged() || this.#bootAlls > 0) return;
          let fresh: PcContainerInfo | null;
          try {
            fresh = await this.#freshInspect(p);
          } catch (err) {
            this.#log?.debug({ pcId: p.id, err: errText(err) }, 'monitor: inspect failed; next pass');
            return;
          }
          // Never stop a container whose PC is (or just became) active.
          if (fresh?.state !== 'running' || this.#isActive(p.id) || !unchanged()) return;
          this.#log?.warn({ pcId: p.id, status: st }, 'stopping a PC container that should not run');
          try {
            await this.driver.stop(fresh.name);
            this.#noteLive(p.id, await this.driver.inspect(fresh.name).catch(() => fresh));
          } catch (err) {
            this.#log?.warn({ pcId: p.id, err: errText(err) }, 'could not stop a stray PC container');
          }
        });
      }
    }
  }

  async #checkDisk(): Promise<void> {
    const free = await this.#freeDisk();
    const { warn, stop } = this.#diskWatch();
    const level: DiskLevel = free < stop ? 'critical' : free < warn ? 'low' : 'ok';
    if (level !== this.#diskLevel) {
      this.#diskLevel = level;
      if (level !== 'ok') this.#log?.warn({ freeGiB: +(free / GiB).toFixed(1), level }, 'host disk is low');
      this.emit('host.disk', { freeBytes: free, level });
    }
    if (level !== 'critical') return;
    const detail = `only ${fmtGiB(free)} of disk free; stopped to protect the Mac (PCs stop below ${fmtGiB(stop)})`;
    for (const p of [...this.#file.pcs]) {
      if (!ACTIVE.has(this.status(p.id).status)) continue;
      await this.#serialize(p.id, async () => {
        if (!ACTIVE.has(this.status(p.id).status)) return;
        this.#setStatus(p.id, { status: 'stopping', detail });
        try {
          await this.#detachViewers(p.id);
          await this.#stopContainer(p, 5);
        } catch (err) {
          this.#log?.warn({ pcId: p.id, err: errText(err) }, 'low disk: stop failed');
        }
        this.#setStatus(p.id, { status: 'error', reason: 'low_disk', detail });
      });
    }
  }

  /** Last free-disk level the watchdog saw. */
  get diskLevel(): DiskLevel {
    return this.#diskLevel;
  }

  // ------------------------------------------------------------------ shutdown

  /**
   * Stops every active PC in parallel within `shutdownTimeoutMs` (20 s), then lets go of the engine
   * (`stopEngine`, default true) within the same bound (N5): the driver stops it only when it is ours and
   * no other live MineVibe process holds a lease on it (N4). An engine release that does not finish in
   * time (a wedged `system stop`, another MineVibe holding the engine lock) leaves the engine running.
   */
  async shutdown(options: { stopEngine?: boolean } = {}): Promise<void> {
    this.#closing = true;
    this.stopMonitor();
    const budgetMs = this.#o.shutdownTimeoutMs ?? 20_000;
    if (!this.#engineDown) await this.#inventory();
    // Every PC whose container runs, whatever its status says (an `error` PC may still run, H4).
    const active = this.#file.pcs.filter(
      (p) => ACTIVE.has(this.status(p.id).status) || this.#liveActive(p.id),
    );
    const grace = Math.max(1, Math.floor(budgetMs / 1000) - 8);
    const all = Promise.allSettled(active.map((p) => this.stop(p.id, { timeoutSeconds: grace })));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
    if (timer) clearTimeout(timer);
    // N5: viewers are bounded too (FrameService.close waits at most 2 s per its own deadline).
    if (this.#frames) await settleWithin(this.#frames.close(), 3000);
    this.pool.close();
    // This process no longer uses the instance (its home may be thrown away now; `doctor --clean-orphans`).
    await settleWithin(this.#register(false), 2000);
    if (options.stopEngine ?? true) {
      const release = Promise.resolve()
        .then(() => this.driver.shutdownEngine())
        .catch((err: unknown) => {
          this.#log?.warn({ err: errText(err) }, 'engine stop failed');
        });
      if ((await settleWithin(release, budgetMs)) === 'timeout') {
        this.#log?.warn({ timeoutMs: budgetMs }, 'letting go of the engine timed out; leaving it running');
      }
    }
  }
}
