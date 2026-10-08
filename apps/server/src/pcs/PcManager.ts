import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../util/atomicFile.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import {
  admit,
  type BootCandidate,
  type BudgetSettings,
  type BudgetState,
  computeBudget,
  defaultBudgetSettings,
  type HostFacts,
  type PcAllocation,
  planBoot,
} from './Budget.js';
import { EngineError } from './drivers/ContainerRuntime.js';
import {
  MANAGED_LABEL,
  PC_ID_LABEL,
  type PcDriver,
  type PcRunSpec,
  type VolumeMount,
} from './drivers/PcDriver.js';
import { FrameService, type FrameServiceOptions, type FrameSink } from './FrameService.js';
import { freeLoopbackPort, readHostFacts } from './host.js';
import { InputRouter } from './InputRouter.js';
import {
  assertPcId,
  clampResources,
  containerName,
  homeVolumeName,
  isPcType,
  PC_TYPE_SPECS,
  type PcDiskCaps,
  type PcStatus,
  type PcType,
} from './PcTypes.js';
import type { SpacesdPool } from './SpacesdPool.js';
import {
  overlayTarget,
  overlayVolumeName,
  prepareOverlayMountpoints,
  type VaultMount,
  validateMounts,
} from './Vault.js';

/**
 * PcManager (PLAN §8): `pcs.json`, per-PC tokens, statuses, budget admission, boot order, the
 * container lifecycle (create, start, stop, recreate on resize/type/mount change, reimage,
 * decommission), reconcile by label on start, and shutdown.
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
  /** Image override (defaults to the type's image). */
  image?: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface PcsFile {
  version: 1;
  nextSlot: number;
  pcs: PcRecord[];
}

export interface PcStatusInfo {
  status: PcStatus;
  /** 0–100 for `downloading` and `booting`. */
  progress?: number;
  detail?: string;
}

/** One row of `pc.state`. */
export interface PcView {
  pcId: string;
  slot: number;
  type: PcType;
  status: PcStatus;
  progress?: number;
  detail?: string;
  cpus: number;
  memMb: number;
  mounts: { host: string; ro: boolean }[];
  plugged: boolean;
  pinned: boolean;
  display: [number, number];
}

export type PcManagerEvents = {
  'pc.state': [PcView[]];
  'pc.status': [string, PcStatusInfo];
  'budget.state': [BudgetState];
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
  /** Value of the `minevibe` label (`pc`; tests use `pc-test`). */
  labelValue?: string;
  /** Build context for a missing local image (dev fallback, PLAN §9.3). */
  imageBuild?: { contextDir: string; file: string };
  /** Folders a Vault may never touch (MineVibe's own data). */
  vaultForbidden?: string[];
  home?: string;
  bootTimeoutMs?: number;
  /** Stop all PCs within this on shutdown. */
  shutdownTimeoutMs?: number;
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
    | 'BUSY';
  readonly resource?: string;
  constructor(code: PcError['code'], message: string, resource?: string) {
    super(message);
    this.name = 'PcError';
    this.code = code;
    if (resource !== undefined) this.resource = resource;
  }
}

/** Statuses during which a PC holds CPU and RAM. */
const ACTIVE: ReadonlySet<PcStatus> = new Set(['booting', 'running', 'stopping', 'remounting', 'reimaging']);

export class PcManager extends TypedEmitter<PcManagerEvents> {
  readonly driver: PcDriver;
  readonly pool: SpacesdPool;
  readonly #o: PcManagerOptions;
  readonly #log: Logger | undefined;
  readonly #budget: BudgetSettings;
  readonly #label: string;
  readonly #now: () => number;
  #file: PcsFile = { version: 1, nextSlot: 1, pcs: [] };
  readonly #status = new Map<string, PcStatusInfo>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #engineDown: string | null = null;
  #frames: FrameService | null = null;
  #input: InputRouter | null = null;

  constructor(options: PcManagerOptions) {
    super();
    this.#o = options;
    this.driver = options.driver;
    this.pool = options.pool;
    this.#log = options.logger;
    this.#budget = defaultBudgetSettings(options.budget);
    this.#label = options.labelValue ?? 'pc';
    this.#now = options.now ?? Date.now;
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

  get labels(): Record<string, string> {
    return { [MANAGED_LABEL]: this.#label };
  }

  // ------------------------------------------------------------------ persistence

  /** Loads `pcs.json`; creates `linux-1` when there are no PCs yet (`createDefault`, default true). */
  async init(options: { createDefault?: boolean } = {}): Promise<PcRecord[]> {
    await mkdir(this.#o.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tokensDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.pcsFile)) {
      const raw = JSON.parse(await readFile(this.pcsFile, 'utf8')) as Partial<PcsFile>;
      this.#file = {
        version: 1,
        nextSlot: raw.nextSlot ?? 1,
        pcs: (raw.pcs ?? []).filter((p) => isPcType(p.type)),
      };
    }
    if (this.#file.pcs.length === 0 && (options.createDefault ?? true)) {
      await this.#addRecord(this.#newRecord('linux-1', 'linux', {}));
    }
    for (const p of this.#file.pcs) if (!this.#status.has(p.id)) this.#status.set(p.id, { status: 'off' });
    return this.list();
  }

  async #save(): Promise<void> {
    await writeFileAtomic(this.pcsFile, `${JSON.stringify(this.#file, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
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
    rec.slot = this.#file.nextSlot++;
    this.#file.pcs.push(rec);
    this.#status.set(rec.id, { status: 'off' });
    await this.#save();
    return rec;
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
    if (prev && prev.status === info.status && prev.progress === info.progress && prev.detail === info.detail)
      return;
    this.#status.set(id, info);
    this.emit('pc.status', id, info);
    this.emit('pc.state', this.views());
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

  async hostFacts(): Promise<HostFacts> {
    if (this.#o.hostFacts) return this.#o.hostFacts();
    return readHostFacts(this.#o.diskPath ?? this.#o.stateDir);
  }

  #diskGiB(p: Pick<PcRecord, 'disk' | 'mounts' | 'type'>): number {
    const overlays = p.mounts.reduce((n, m) => n + m.overlays.length, 0);
    return p.disk.rootfsGiB + p.disk.homeGiB + overlays * p.disk.overlayGiB;
  }

  #alloc(p: PcRecord, active?: boolean): PcAllocation {
    const family = PC_TYPE_SPECS[p.type].family;
    return {
      id: p.id,
      family,
      cpus: p.cpus,
      memMiB: p.memMiB,
      cpuOverhead: family === 'linux' ? this.driver.cpuOverhead : 0,
      active: active ?? ACTIVE.has(this.status(p.id).status),
      diskGiB: this.#diskGiB(p),
    };
  }

  async budget(): Promise<BudgetState> {
    const state = computeBudget(
      await this.hostFacts(),
      this.#budget,
      this.#file.pcs.map((p) => this.#alloc(p)),
    );
    this.emit('budget.state', state);
    return state;
  }

  async #admitOrThrow(kind: 'create' | 'start' | 'edit', p: PcRecord, active: boolean): Promise<string[]> {
    const host = await this.hostFacts();
    const res = admit(
      host,
      this.#budget,
      this.#file.pcs.map((r) => this.#alloc(r)),
      {
        kind,
        pc: this.#alloc(p, active),
      },
    );
    if (!res.ok) throw new PcError(res.reason, res.detail, res.resource);
    return res.warnings;
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
  createInputRouter(): InputRouter {
    this.#input = new InputRouter({
      getClient: (id) => this.pool.client(id),
      ...(this.#log ? { logger: this.#log } : {}),
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
          : err instanceof Error
            ? err.message.slice(0, 300)
            : String(err);
      this.#engineDown = detail;
      this.#log?.error({ err: detail }, 'PC engine down');
      for (const p of this.#file.pcs) {
        if (PC_TYPE_SPECS[p.type].family === 'linux')
          this.#setStatus(p.id, { status: 'engine_down', detail });
      }
      return false;
    }
  }

  /** Makes sure a PC type's image exists locally (build from the local Containerfile or pull). */
  async ensureImage(image: string, onProgress?: (m: string) => void): Promise<void> {
    if (await this.driver.imageExists(image)) return;
    if (this.#o.imageBuild && image.startsWith('minevibe/')) {
      await this.driver.buildImage({ ...this.#o.imageBuild, tag: image }, onProgress);
    } else {
      await this.driver.pullImage(image, onProgress);
    }
  }

  #imageOf(p: PcRecord): string {
    const img = p.image ?? PC_TYPE_SPECS[p.type].image;
    if (!img) throw new PcError('UNAVAILABLE', `${p.type} PCs have no image`);
    return img;
  }

  // ------------------------------------------------------------------ reconcile + boot

  /**
   * Matches containers labelled `minevibe=<label>` to records (PLAN §8.1): running ones register their
   * endpoint and wait for SERVING, stopped ones are `off`. Containers without a record are orphans:
   * they are stopped (never deleted) and returned.
   */
  async reconcile(): Promise<{ adopted: string[]; orphans: string[] }> {
    const containers = await this.driver.list(this.labels);
    const adopted: string[] = [];
    const orphans: string[] = [];
    for (const c of containers) {
      const id = c.labels[PC_ID_LABEL];
      const rec = id ? this.#file.pcs.find((p) => p.id === id) : undefined;
      if (!rec) {
        orphans.push(c.name);
        if (c.state === 'running') await this.driver.stop(c.name).catch(() => {});
        continue;
      }
      adopted.push(rec.id);
      if (c.state === 'running') {
        const token = await this.#readToken(rec.id);
        if (!token || !c.hostPort) {
          // We cannot talk to it: stop it; the next start recreates it with a fresh token.
          await this.driver.stop(c.name).catch(() => {});
          this.#setStatus(rec.id, { status: 'off' });
          continue;
        }
        rec.hostPort = c.hostPort;
        this.pool.register(rec.id, { url: `http://127.0.0.1:${c.hostPort}`, token });
        this.#setStatus(rec.id, { status: 'booting', progress: 50 });
      } else {
        this.#setStatus(rec.id, { status: 'off' });
      }
    }
    await this.#save();
    if (orphans.length) this.#log?.warn({ orphans }, 'stopped orphaned PC containers (not deleted)');
    return { adopted, orphans };
  }

  /**
   * Boots every plugged PC in boot-priority order (pinned, then most recently used) with budget
   * admission; PCs that don't fit become `no_capacity` / `macos_slots_full`.
   */
  async bootAll(): Promise<{ booted: string[]; refused: string[]; failed: string[] }> {
    const booted: string[] = [];
    const failed: string[] = [];
    const host = await this.hostFacts();
    const alreadyActive = this.#file.pcs
      .filter((p) => ACTIVE.has(this.status(p.id).status))
      .map((p) => this.#alloc(p, true));
    const candidates: BootCandidate[] = this.#file.pcs
      .filter((p) => p.plugged && PC_TYPE_SPECS[p.type].available && !PC_TYPE_SPECS[p.type].driverStub)
      .map((p) => ({
        ...this.#alloc(p, false),
        pinned: p.pinned,
        ...(p.lastUsedAt !== undefined ? { lastUsedAt: p.lastUsedAt } : {}),
        createdAt: p.createdAt,
      }));
    const plan = planBoot(host, this.#budget, candidates, alreadyActive);
    for (const r of plan.refused) {
      this.#setStatus(r.id, {
        status: r.reason === 'MACOS_SLOTS' ? 'macos_slots_full' : 'no_capacity',
        detail: r.detail,
      });
    }
    // PCs that were already running (adopted) only need readiness.
    for (const a of alreadyActive) {
      try {
        await this.#serialize(a.id, () => this.#waitReady(this.#rec(a.id)));
        booted.push(a.id);
      } catch {
        failed.push(a.id);
      }
    }
    for (const id of plan.boot) {
      try {
        await this.#serialize(id, () => this.#startLocked(this.#rec(id), { admitted: true }));
        booted.push(id);
      } catch (err) {
        failed.push(id);
        this.#log?.warn({ pcId: id, err: String(err) }, 'PC failed to boot');
      }
    }
    await this.budget();
    return { booted, refused: plan.refused.map((r) => r.id), failed };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Creates a PC record (and boots it when `boot`). */
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
    const spec = PC_TYPE_SPECS[options.type];
    if (!spec.available)
      throw new PcError('UNAVAILABLE', spec.unavailableReason ?? `${options.type} is unavailable`);
    const id = options.id ?? this.#nextId(options.type);
    if (this.#file.pcs.some((p) => p.id === id)) throw new PcError('BUSY', `PC ${id} already exists`);
    const rec = this.#newRecord(id, options.type, options);
    if (options.disk) rec.disk = { ...rec.disk, ...options.disk };
    const warnings: string[] = [];
    if (options.mounts?.length) {
      const v = await validateMounts(options.mounts, this.#vaultOptions());
      if (!v.ok) throw new PcError('PATH_REFUSED', v.reason);
      rec.mounts = v.mounts;
      warnings.push(...v.warnings);
    }
    warnings.push(...(await this.#admitOrThrow('create', rec, !!options.boot)));
    await this.#addRecord(rec);
    if (options.boot) await this.start(rec.id);
    return { pc: this.get(rec.id) as PcRecord, warnings };
  }

  #nextId(type: PcType): string {
    const prefix = PC_TYPE_SPECS[type].family === 'macos' ? 'mac' : 'linux';
    for (let n = 1; ; n++) {
      const id = `${prefix}-${n}`;
      if (!this.#file.pcs.some((p) => p.id === id)) return id;
    }
  }

  #vaultOptions() {
    return {
      ...(this.#o.home ? { home: this.#o.home } : {}),
      forbidden: [this.#o.stateDir, ...(this.#o.vaultForbidden ?? [])],
    };
  }

  /** Starts a PC (create the container when missing) and waits for SERVING. */
  start(id: string): Promise<void> {
    return this.#serialize(id, () => this.#startLocked(this.#rec(id), { admitted: false }));
  }

  async #startLocked(p: PcRecord, opts: { admitted: boolean }): Promise<void> {
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
    if (!opts.admitted) {
      try {
        await this.#admitOrThrow('start', p, true);
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
    this.#setStatus(p.id, { status: 'booting', progress: 0 });
    try {
      const info = await this.driver.inspect(containerName(p.id));
      const token = await this.#readToken(p.id);
      let reused = false;
      if (info && token && info.hostPort) {
        try {
          if (info.state !== 'running') await this.driver.start(info.name);
          const after = (await this.driver.inspect(info.name)) ?? info;
          p.hostPort = after.hostPort ?? info.hostPort;
          this.pool.register(p.id, { url: `http://127.0.0.1:${p.hostPort}`, token });
          reused = true;
        } catch (err) {
          // e.g. its loopback port is taken now: recreate (volumes and Vault are kept).
          this.#log?.warn({ pcId: p.id, err: String(err) }, 'start failed; recreating the container');
        }
      }
      if (!reused) {
        if (info) await this.driver.remove(info.name);
        await this.#runContainer(p);
      }
      await this.#save();
      await this.#waitReady(p);
    } catch (err) {
      this.#setStatus(p.id, {
        status: 'error',
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
      throw err;
    }
  }

  async #waitReady(p: PcRecord): Promise<void> {
    this.#setStatus(p.id, { status: 'booting', progress: this.status(p.id).progress ?? 10 });
    await this.pool.waitServing(p.id, {
      timeoutMs: this.#o.bootTimeoutMs ?? 120_000,
      onProgress: (pct) => this.#setStatus(p.id, { status: 'booting', progress: pct }),
    });
    this.#setStatus(p.id, { status: 'running' });
  }

  /** Volumes of a PC: home plus one per overlay. */
  #volumes(p: PcRecord, overlays: { mount: VaultMount; overlay: string }[]): VolumeMount[] {
    return [
      { name: homeVolumeName(p.id), target: '/home/cua', sizeGiB: p.disk.homeGiB },
      ...overlays.map(({ mount, overlay }) => ({
        name: overlayVolumeName(p.id, mount.host, overlay),
        target: overlayTarget(mount.host, overlay),
        sizeGiB: p.disk.overlayGiB,
      })),
    ];
  }

  /** Builds the run spec (rotates the token) and runs the container. */
  async #runContainer(p: PcRecord): Promise<void> {
    const image = this.#imageOf(p);
    this.#setStatus(p.id, { status: 'booting', progress: 2 });
    if (!(await this.driver.imageExists(image))) {
      this.#setStatus(p.id, { status: 'downloading', progress: 0 });
      await this.ensureImage(image);
      this.#setStatus(p.id, { status: 'booting', progress: 5 });
    }
    const overlays: { mount: VaultMount; overlay: string }[] = [];
    for (const m of p.mounts) {
      const { ready, skipped } = await prepareOverlayMountpoints(m);
      for (const o of ready) overlays.push({ mount: m, overlay: o });
      if (skipped.length)
        this.#log?.warn({ pcId: p.id, mount: m.host, skipped }, 'overlay mountpoints skipped');
    }
    const hostPort = await freeLoopbackPort(p.hostPort);
    const token = await this.#rotateToken(p.id);
    const env: Record<string, string> = {};
    if (overlays.length)
      env.MV_CHOWN_PATHS = overlays.map((o) => overlayTarget(o.mount.host, o.overlay)).join(':');
    const runSpec: PcRunSpec = {
      name: containerName(p.id),
      image,
      cpus: p.cpus,
      memoryMiB: p.memMiB,
      shmMiB: p.shmMiB,
      hostPort,
      binds: p.mounts.map((m) => ({ source: m.host, target: m.host, readonly: m.ro })),
      volumes: this.#volumes(p, overlays),
      labels: { ...this.labels, [PC_ID_LABEL]: p.id, 'minevibe.type': p.type },
      env,
      secretEnv: { CUA_ENV_TOKEN: token },
    };
    await this.driver.run(runSpec);
    p.hostPort = hostPort;
    this.pool.register(p.id, { url: `http://127.0.0.1:${hostPort}`, token });
  }

  /** Stops a PC (its container and volumes stay). */
  stop(id: string, options: { timeoutSeconds?: number } = {}): Promise<void> {
    return this.#serialize(id, async () => {
      const p = this.#rec(id);
      this.#setStatus(id, { status: 'stopping' });
      await this.#detachViewers(id);
      try {
        await this.driver.stop(containerName(p.id), options.timeoutSeconds);
        this.#setStatus(id, { status: 'off' });
      } catch (err) {
        this.#setStatus(id, { status: 'error', detail: String(err).slice(0, 300) });
        throw err;
      }
    });
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  /**
   * Recreates the container (delete + run) keeping the home volume, overlays and the Vault. Used for
   * resize, type change and mount changes (`container` 1.5.0 has no `update`). Boots it again when it
   * was running.
   */
  recreate(id: string, status: 'booting' | 'remounting' = 'booting'): Promise<void> {
    return this.#serialize(id, () => this.#recreateLocked(this.#rec(id), status));
  }

  async #recreateLocked(p: PcRecord, status: 'booting' | 'remounting'): Promise<void> {
    const wasActive = ACTIVE.has(this.status(p.id).status);
    const name = containerName(p.id);
    if (wasActive) this.#setStatus(p.id, { status, progress: 0 });
    await this.#detachViewers(p.id);
    await this.driver.stop(name).catch(() => {});
    await this.driver.remove(name);
    if (!wasActive) {
      this.#setStatus(p.id, { status: 'off' });
      await this.#save();
      return;
    }
    try {
      await this.#runContainer(p);
      await this.#save();
      await this.#waitReady(p);
    } catch (err) {
      this.#setStatus(p.id, { status: 'error', detail: String(err).slice(0, 300) });
      throw err;
    }
  }

  /** Resize (cpus/memory/shm) with admission; a running PC is recreated (PLAN §8.1). */
  async resize(
    id: string,
    r: { cpus?: number; memMiB?: number; shmMiB?: number },
  ): Promise<{ restarted: boolean; warnings: string[] }> {
    const cur = this.#rec(id);
    const next = {
      ...cur,
      ...clampResources(cur.type, {
        cpus: r.cpus ?? cur.cpus,
        memMiB: r.memMiB ?? cur.memMiB,
        shmMiB: r.shmMiB ?? cur.shmMiB,
      }),
    };
    const active = ACTIVE.has(this.status(id).status);
    const warnings = await this.#admitOrThrow('edit', next, active);
    Object.assign(cur, { cpus: next.cpus, memMiB: next.memMiB, shmMiB: next.shmMiB });
    await this.#save();
    await this.recreate(id);
    return { restarted: active, warnings };
  }

  /** Type change (linux ⇄ linux-slim) = recreate with the new type's image. */
  async setType(id: string, type: PcType): Promise<void> {
    const cur = this.#rec(id);
    if (PC_TYPE_SPECS[type].family !== PC_TYPE_SPECS[cur.type].family) {
      throw new PcError('UNAVAILABLE', 'only Linux ⇄ Linux slim changes are possible in place');
    }
    const next: PcRecord = { ...cur, type, ...clampResources(type, cur) };
    await this.#admitOrThrow('edit', next, ACTIVE.has(this.status(id).status));
    Object.assign(cur, { type, cpus: next.cpus, memMiB: next.memMiB, shmMiB: next.shmMiB });
    await this.#save();
    await this.recreate(id);
  }

  /** Replaces the Vault mounts (validated) and recreates the container (`remounting`). */
  async setMounts(
    id: string,
    mounts: { host: string; ro?: boolean; overlays?: string[] }[],
  ): Promise<{ warnings: string[] }> {
    const cur = this.#rec(id);
    const v = await validateMounts(mounts, this.#vaultOptions());
    if (!v.ok) throw new PcError('PATH_REFUSED', v.reason);
    const next: PcRecord = { ...cur, mounts: v.mounts };
    const warnings = [
      ...v.warnings,
      ...(await this.#admitOrThrow('edit', next, ACTIVE.has(this.status(id).status))),
    ];
    cur.mounts = v.mounts;
    await this.#save();
    await this.recreate(id, 'remounting');
    return { warnings };
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.#rec(id).pinned = pinned;
    await this.#save();
  }

  /** Plugged = placed in the world. Unplugging stops the PC (disks persist). */
  async setPlugged(id: string, plugged: boolean): Promise<void> {
    const p = this.#rec(id);
    p.plugged = plugged;
    await this.#save();
    if (!plugged && ACTIVE.has(this.status(id).status)) await this.stop(id);
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
      this.#setStatus(id, { status: 'reimaging' });
      await this.#detachViewers(id);
      await this.#destroyContainerAndVolumes(p);
      if (!wasActive) {
        this.#setStatus(id, { status: 'off' });
        return;
      }
      try {
        await this.#runContainer(p);
        await this.#save();
        await this.#waitReady(p);
      } catch (err) {
        this.#setStatus(id, { status: 'error', detail: String(err).slice(0, 300) });
        throw err;
      }
    });
  }

  /** Removes the PC entirely: container, volumes, token and record. Vault folders are untouched. */
  decommission(id: string): Promise<void> {
    return this.#serialize(id, async () => {
      const p = this.#rec(id);
      this.#setStatus(id, { status: 'stopping' });
      await this.#detachViewers(id);
      await this.#destroyContainerAndVolumes(p);
      await rm(this.#tokenPath(id), { force: true });
      this.#file.pcs = this.#file.pcs.filter((r) => r.id !== id);
      this.#status.delete(id);
      await this.#save();
      this.emit('pc.state', this.views());
    });
  }

  async #destroyContainerAndVolumes(p: PcRecord): Promise<void> {
    const name = containerName(p.id);
    await this.driver.stop(name).catch(() => {});
    await this.driver.remove(name);
    // Every volume labelled with this PC (home, current and earlier overlays); never an unlabelled one.
    for (const v of await this.driver.listVolumes({ ...this.labels, [PC_ID_LABEL]: p.id })) {
      await this.driver.removeVolume(v.name);
    }
  }

  /**
   * Stops every active PC in parallel within `shutdownTimeoutMs` (20 s), then stops the engine when it
   * is ours (`stopEngine`, default true).
   */
  async shutdown(options: { stopEngine?: boolean } = {}): Promise<void> {
    const budgetMs = this.#o.shutdownTimeoutMs ?? 20_000;
    const active = this.#file.pcs.filter((p) => ACTIVE.has(this.status(p.id).status));
    const grace = Math.max(1, Math.floor(budgetMs / 1000) - 8);
    const all = Promise.allSettled(active.map((p) => this.stop(p.id, { timeoutSeconds: grace })));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise((r) => (timer = setTimeout(r, budgetMs)))]);
    if (timer) clearTimeout(timer);
    await this.#frames?.close();
    this.pool.close();
    if (options.stopEngine ?? true) {
      try {
        await this.driver.shutdownEngine();
      } catch (err) {
        this.#log?.warn({ err: String(err) }, 'engine stop failed');
      }
    }
  }
}
