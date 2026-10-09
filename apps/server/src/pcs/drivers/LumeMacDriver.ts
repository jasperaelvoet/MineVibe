import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, readlink, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../../util/atomicFile.js';
import { freeDiskBytes } from '../host.js';
import {
  LUME_STORAGE,
  type LumeApiResult,
  LumeError,
  type LumeRuntime,
  VM_LIMIT_RE,
  VM_SIDECAR,
} from './LumeRuntime.js';
import {
  type MacBaseImage,
  type MacImageInfo,
  type MacPcDriver,
  type MacShare,
  MacStartError,
  type MacStartSpec,
  type MacVmInfo,
  type MacVmSpec,
  type MacVmState,
} from './MacPcDriver.js';
import { hasLabels, tokenFingerprint } from './PcDriver.js';

/**
 * macOS PCs on MineVibe's `lume serve` (PLAN §8.1, §8.7; spike S6).
 *
 * - **Base image.** `images.cua-macos` is pulled once (`POST /lume/pull/start`, progress from `GET`) into the VM
 *   `mv-base-<tag>`, never run, and accepted only when Lume's recorded manifest digest equals the pinned one.
 * - **Create.** An APFS clone of the base (< 1 s), then CPUs, memory and display (`PATCH`), then a sidecar
 *   (`minevibe.json` in the VM folder) with MineVibe's labels: Lume has none, and nothing is touched without them.
 * - **Start.** The token goes to `<shares>/<vm>/setup/env-token` (0600; the guest's spacesd reads it at every start),
 *   every other share is a symlink `<shares>/<vm>/links/<name>` to its folder (Lume names a share after the last path
 *   component it is given, so the names are ours and unique), and the VM starts through the serve API with VNC off.
 *   The address comes from `GET`; a start that fails is read from the serve log (Apple's two-VM limit →
 *   {@link MacStartError} `MACOS_SLOTS`).
 * - **Stop.** Graceful when the caller can ask the guest to shut down (the VM ends ~12 s later), else (and after the
 *   timeout) a power-off. Either way a final `POST …/stop` resets Lume's status, which stays `running` after a
 *   guest-side shutdown until then.
 */

const SHARE_ROOT = '/Volumes/My Shared Files';
const SHARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const VM_NAME_RE = /^mv-[a-z0-9][a-z0-9-]{1,62}$/;
const GiB = 1024 ** 3;

export interface LumeMacDriverOptions {
  logger?: Logger;
  /** How long a start waits for the VM's address (default 120 s). */
  startTimeoutMs?: number;
  /** Pull poll interval (default 1 s). */
  pollMs?: number;
  /** A pull that makes no progress this long is cancelled (default 15 min). */
  pullStallMs?: number;
  /** Free disk a pull needs beyond the image's disk size (default 10 GiB). */
  pullDiskMarginBytes?: number;
  /** Free disk on the volume of the Lume root (tests). */
  freeDisk?: () => Promise<number>;
}

/** The base VM's name for an image (`macos:26-20261003-a7b1e34` → `mv-base-macos-26-20261003-a7b1e34`). */
export function baseVmName(lumeRef: string): string {
  return `mv-base-${lumeRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')}`.slice(0, 63);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bodyMessage(r: LumeApiResult): string {
  const b = r.body as { message?: string; error?: string } | string | null;
  if (typeof b === 'string') return b.slice(0, 300);
  return (b?.message ?? b?.error ?? JSON.stringify(b ?? '')).slice(0, 300);
}

export class LumeMacDriver implements MacPcDriver {
  readonly kind = 'lume' as const;
  readonly shareRoot = SHARE_ROOT;
  readonly image: MacImageInfo;
  readonly runtime: LumeRuntime;
  readonly baseName: string;
  readonly #log: Logger | undefined;
  readonly #o: LumeMacDriverOptions;
  #engineHeld = false;
  #pull: Promise<void> | null = null;
  readonly #pullListeners = new Set<(p: { fraction: number; bytes: number; total: number }) => void>();

  constructor(runtime: LumeRuntime, options: LumeMacDriverOptions = {}) {
    this.runtime = runtime;
    this.#o = options;
    this.#log = options.logger;
    const img = runtime.locks.image;
    this.baseName = baseVmName(img.lumeRef);
    this.image = {
      what: `macOS 26 image (${img.ref})`,
      downloadBytes: img.downloadBytes,
      diskBytes: img.diskBytes,
      digest: img.digest,
    };
  }

  get engineHeld(): boolean {
    return this.#engineHeld;
  }

  get guestRipgrep(): string | null {
    return this.runtime.ripgrepPath ? `${SHARE_ROOT}/setup/rg` : null;
  }

  // ---------------------------------------------------------------- engine

  async ensureEngine(
    options: { keep?: (vm: string) => boolean; onProgress?: (m: string) => void } = {},
  ): Promise<void> {
    await this.runtime.provision(options.onProgress);
    try {
      await this.runtime.provisionRipgrep(options.onProgress);
    } catch (err) {
      // Agents lose glob and grep on macOS without it, nothing else.
      this.#log?.warn({ err: String(err) }, 'ripgrep for macOS PCs could not be provisioned');
    }
    await this.runtime.startAndLease({
      ...(options.keep ? { keep: options.keep } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    this.#engineHeld = true;
  }

  async engineAlive(): Promise<boolean> {
    return this.#engineHeld && (await this.runtime.serveAlive());
  }

  async shutdownEngine(): Promise<boolean> {
    if (!this.#engineHeld) return false;
    this.#engineHeld = false;
    return this.runtime.releaseAndStopIfUnused();
  }

  #vmPath(name: string): string {
    return `/lume/vms/${encodeURIComponent(name)}`;
  }

  #get(name: string, timeoutMs = 10_000): Promise<LumeApiResult> {
    return this.runtime.api('GET', `${this.#vmPath(name)}?storage=${LUME_STORAGE}`, undefined, timeoutMs);
  }

  // ---------------------------------------------------------------- base image

  async #digestOf(name: string): Promise<string | null> {
    try {
      return (await readFile(join(this.runtime.vmsDir, name, '.manifest-digest'), 'utf8')).trim();
    } catch {
      return null;
    }
  }

  async baseImage(): Promise<MacBaseImage> {
    const r = await this.#get(this.baseName);
    if (r.status === 404 || (r.status === 400 && /not found/i.test(bodyMessage(r))))
      return { present: false };
    if (r.status !== 200) {
      throw new LumeError('API', `lume get ${this.baseName}: HTTP ${r.status}: ${bodyMessage(r)}`, r.status);
    }
    const b = r.body as {
      status?: string;
      downloadProgress?: number;
      downloadedBytes?: number;
      totalBytes?: number;
      diskSize?: { allocated?: number };
    };
    if (b.status === 'pulling') {
      return {
        present: false,
        pulling: {
          fraction: Math.min(1, Math.max(0, (b.downloadProgress ?? 0) / 100)),
          bytes: b.downloadedBytes ?? 0,
          total: b.totalBytes ?? this.image.downloadBytes,
        },
      };
    }
    const digest = await this.#digestOf(this.baseName);
    if (digest !== this.image.digest) {
      return {
        present: false,
        problem: `the base image has digest ${digest ?? 'none'}, not the pinned ${this.image.digest}`,
      };
    }
    return { present: true, ...(b.diskSize?.allocated ? { allocatedBytes: b.diskSize.allocated } : {}) };
  }

  /** Pulls the base once; concurrent callers share the pull and all get its progress. */
  pullBase(onProgress?: (p: { fraction: number; bytes: number; total: number }) => void): Promise<void> {
    if (onProgress) this.#pullListeners.add(onProgress);
    this.#pull ??= this.#doPull().finally(() => {
      this.#pull = null;
      this.#pullListeners.clear();
    });
    return this.#pull;
  }

  #progress(p: { fraction: number; bytes: number; total: number }): void {
    for (const l of this.#pullListeners) {
      try {
        l(p);
      } catch {}
    }
  }

  async #doPull(): Promise<void> {
    const before = await this.baseImage();
    if (before.present) return;
    if (before.problem) {
      this.#log?.warn({ problem: before.problem }, 'replacing the macOS base image');
      await this.runtime.api(
        'DELETE',
        `${this.#vmPath(this.baseName)}?storage=${LUME_STORAGE}`,
        undefined,
        120_000,
      );
    }
    if (!before.pulling) {
      const free = this.#o.freeDisk ? await this.#o.freeDisk() : await freeDiskBytes(this.runtime.root);
      // The download unpacks into a sparse 150 GiB disk of which about 29 GiB get allocated (S6).
      const need =
        Math.max(this.image.downloadBytes * 1.35, 30 * GiB) + (this.#o.pullDiskMarginBytes ?? 10 * GiB);
      if (free < need) {
        throw new LumeError(
          'API',
          `the macOS image needs about ${Math.ceil(need / GiB)} GiB of free disk, ${Math.floor(free / GiB)} GiB free`,
        );
      }
      const img = this.runtime.locks.image;
      const r = await this.runtime.api('POST', '/lume/pull/start', {
        image: img.lumeRef,
        name: this.baseName,
        registry: 'ghcr.io',
        organization: 'trycua',
        storage: LUME_STORAGE,
      });
      if (r.status !== 202 && r.status !== 200) {
        throw new LumeError('API', `lume pull: HTTP ${r.status}: ${bodyMessage(r)}`, r.status);
      }
      this.#log?.info({ image: img.ref }, 'pulling the macOS image');
    }
    const stall = this.#o.pullStallMs ?? 15 * 60_000;
    let lastBytes = -1;
    let lastMove = Date.now();
    let seenPulling = false;
    for (;;) {
      await sleep(this.#o.pollMs ?? 1000);
      let r: LumeApiResult;
      try {
        r = await this.#get(this.baseName, 15_000);
      } catch {
        continue; // a slow GET while the disk is reassembled
      }
      const b = r.body as {
        status?: string;
        downloadProgress?: number;
        downloadedBytes?: number;
        totalBytes?: number;
      };
      if (r.status === 200 && b.status === 'pulling') {
        seenPulling = true;
        const bytes = b.downloadedBytes ?? 0;
        if (bytes !== lastBytes) {
          lastBytes = bytes;
          lastMove = Date.now();
        }
        this.#progress({
          fraction: Math.min(1, Math.max(0, (b.downloadProgress ?? 0) / 100)),
          bytes,
          total: b.totalBytes ?? this.image.downloadBytes,
        });
        if (Date.now() - lastMove > stall) {
          await this.runtime
            .api('POST', '/lume/pull/cancel', { name: this.baseName }, 60_000)
            .catch(() => {});
          throw new LumeError(
            'API',
            `the macOS image download made no progress for ${Math.round(stall / 60_000)} min`,
          );
        }
        continue;
      }
      if (r.status === 200) {
        const digest = await this.#digestOf(this.baseName);
        if (digest === this.image.digest) {
          this.#progress({ fraction: 1, bytes: this.image.downloadBytes, total: this.image.downloadBytes });
          return;
        }
        if (digest !== null) {
          throw new LumeError(
            'VERIFY_FAILED',
            `the pulled macOS image has digest ${digest}, not the pinned ${this.image.digest}`,
          );
        }
        // Reassembling the disk: the digest file comes last.
        if (Date.now() - lastMove > stall) throw new LumeError('API', 'the macOS image pull did not finish');
        continue;
      }
      // Right after the start the VM may not be listed yet ("not found"); anything else is the pull's failure.
      const notYet = !seenPulling && /not found/i.test(bodyMessage(r)) && Date.now() - lastMove < 30_000;
      if (!notYet) {
        throw new LumeError('API', `the macOS image download failed: ${bodyMessage(r)}`, r.status);
      }
    }
  }

  // ---------------------------------------------------------------- VMs

  #assertName(name: string): void {
    if (!VM_NAME_RE.test(name) || name === this.baseName) throw new Error(`invalid macOS VM name ${name}`);
  }

  async #labelsOf(name: string): Promise<Record<string, string> | null> {
    try {
      const s = JSON.parse(await readFile(join(this.runtime.vmsDir, name, VM_SIDECAR), 'utf8')) as {
        labels?: Record<string, string>;
      };
      return s.labels ?? {};
    } catch {
      return null;
    }
  }

  async create(spec: MacVmSpec): Promise<MacVmInfo> {
    this.#assertName(spec.name);
    const base = await this.baseImage();
    if (!base.present) throw new LumeError('NOT_PROVISIONED', 'the macOS base image is not downloaded');
    const existing = await this.inspect(spec.name);
    if (existing) {
      if (!hasLabels(existing.labels, spec.labels)) {
        throw new LumeError('API', `a VM named ${spec.name} exists and is not this PC's; leaving it alone`);
      }
      return existing;
    }
    const c = await this.runtime.api(
      'POST',
      '/lume/vms/clone',
      { name: this.baseName, newName: spec.name, sourceLocation: LUME_STORAGE, destLocation: LUME_STORAGE },
      600_000,
    );
    if (c.status !== 200)
      throw new LumeError('API', `lume clone: HTTP ${c.status}: ${bodyMessage(c)}`, c.status);
    try {
      await writeFileAtomic(
        join(this.runtime.vmsDir, spec.name, VM_SIDECAR),
        `${JSON.stringify({ labels: spec.labels, createdAt: Date.now() }, null, 2)}\n`,
        { mode: 0o644 },
      );
      await this.configure(spec.name, spec);
    } catch (err) {
      await this.runtime
        .api('DELETE', `${this.#vmPath(spec.name)}?storage=${LUME_STORAGE}`, undefined, 120_000)
        .catch(() => {});
      throw err;
    }
    return (await this.inspect(spec.name)) as MacVmInfo;
  }

  async configure(
    name: string,
    r: { cpus: number; memoryMiB: number; display: readonly [number, number] },
  ): Promise<void> {
    this.#assertName(name);
    const p = await this.runtime.api('PATCH', this.#vmPath(name), {
      cpu: r.cpus,
      memory: `${r.memoryMiB}MB`,
      display: `${r.display[0]}x${r.display[1]}`,
      storage: LUME_STORAGE,
    });
    if (p.status !== 200)
      throw new LumeError('API', `lume set ${name}: HTTP ${p.status}: ${bodyMessage(p)}`, p.status);
  }

  /** `<shares>/<vm>`: the setup share and the share links (0700). */
  #shareDir(name: string): string {
    return join(this.runtime.sharesDir, name);
  }

  async #prepareShares(
    name: string,
    token: string,
    shares: readonly MacShare[],
  ): Promise<{ hostPath: string; readOnly: boolean }[]> {
    const dir = this.#shareDir(name);
    const setup = join(dir, 'setup');
    const links = join(dir, 'links');
    await mkdir(setup, { recursive: true, mode: 0o700 });
    await mkdir(links, { recursive: true, mode: 0o700 });
    await this.runtime.writeSecret(join(setup, 'env-token'), token);
    const rg = this.runtime.ripgrepPath;
    if (rg && existsSync(rg)) await this.runtime.stageFile(rg, join(setup, 'rg'), 0o755);
    const want = new Map<string, MacShare>();
    for (const s of shares) {
      if (!SHARE_NAME_RE.test(s.name) || s.name === 'setup' || want.has(s.name)) {
        throw new Error(`invalid or duplicate share name ${s.name}`);
      }
      if (!s.hostPath.startsWith('/')) throw new Error(`share ${s.name}: not an absolute path`);
      want.set(s.name, s);
    }
    for (const entry of await readdir(links)) {
      const p = join(links, entry);
      const s = want.get(entry);
      const target = await readlink(p).catch(() => null);
      if (!s || target !== s.hostPath) await unlink(p).catch(() => rm(p, { recursive: true, force: true }));
    }
    for (const s of want.values()) {
      const p = join(links, s.name);
      if ((await readlink(p).catch(() => null)) !== s.hostPath) await symlink(s.hostPath, p);
    }
    return [
      { hostPath: setup, readOnly: true },
      ...[...want.values()].map((s) => ({ hostPath: join(links, s.name), readOnly: s.readOnly })),
    ];
  }

  async start(spec: MacStartSpec): Promise<{ ip: string }> {
    this.#assertName(spec.name);
    const labels = await this.#labelsOf(spec.name);
    if (labels === null) throw new LumeError('API', `${spec.name} has no MineVibe sidecar; not starting it`);
    const sharedDirectories = await this.#prepareShares(spec.name, spec.token, spec.shares);
    await this.runtime.logEvents();
    const requested = Date.now();
    const r = await this.runtime.api('POST', `${this.#vmPath(spec.name)}/run`, {
      noDisplay: true,
      vnc: 'disabled',
      sharedDirectories,
      storage: LUME_STORAGE,
    });
    if (r.status !== 202 && r.status !== 200) {
      throw new MacStartError('START_FAILED', `lume run ${spec.name}: HTTP ${r.status}: ${bodyMessage(r)}`);
    }
    const timeout = spec.timeoutMs ?? this.#o.startTimeoutMs ?? 120_000;
    let stoppedSince: number | null = null;
    for (;;) {
      const failure = (await this.runtime.logEvents()).failed.get(spec.name);
      if (failure && failure.at >= requested - 1500) {
        throw VM_LIMIT_RE.test(failure.message)
          ? new MacStartError(
              'MACOS_SLOTS',
              'Apple allows two macOS VMs at a time and another app (or MineVibe instance) runs one',
            )
          : new MacStartError('START_FAILED', `the VM did not start: ${failure.message}`);
      }
      let g: LumeApiResult | null = null;
      try {
        g = await this.#get(spec.name, 10_000);
      } catch {
        g = null;
      }
      const b = (g?.body ?? {}) as { status?: string; ipAddress?: string | null };
      if (g?.status === 200 && b.status === 'running' && b.ipAddress) return { ip: b.ipAddress };
      if (g?.status === 200 && b.status === 'stopped') {
        stoppedSince ??= Date.now();
        // The failure line comes with the stop; give the log a moment.
        if (Date.now() - stoppedSince > 3000) {
          throw new MacStartError('START_FAILED', `${spec.name} stopped right after its start`);
        }
      } else stoppedSince = null;
      if (Date.now() - requested > timeout) {
        await this.stop(spec.name).catch(() => {});
        throw new MacStartError(
          'NO_ADDRESS',
          `${spec.name} got no network address in ${Math.round(timeout / 1000)} s`,
        );
      }
      await sleep(500);
    }
  }

  /** Whether the serve logged the VM's end after its current run began. */
  async #endedSinceStart(name: string): Promise<boolean> {
    const ended = (await this.runtime.logEvents()).ended.get(name);
    if (ended === undefined) return false;
    const session = await this.runtime.session(name);
    // Log times have one-second resolution.
    return session ? ended >= session.startedAt - 999 : true;
  }

  async stop(
    name: string,
    options: { graceful?: () => Promise<void>; timeoutMs?: number } = {},
  ): Promise<void> {
    this.#assertName(name);
    const info = await this.inspect(name);
    if (!info) return;
    if (info.state === 'running' && options.graceful) {
      const deadline = Date.now() + (options.timeoutMs ?? 30_000);
      try {
        await options.graceful();
        while (Date.now() < deadline) {
          if (await this.#endedSinceStart(name)) break;
          await sleep(500);
        }
      } catch (err) {
        this.#log?.debug({ vm: name, err: String(err) }, 'graceful shutdown request failed; powering off');
      }
    }
    // Powers off what still runs, and resets the status of a VM that ended inside (400 "not running").
    const r = await this.runtime.api(
      'POST',
      `${this.#vmPath(name)}/stop`,
      { storage: LUME_STORAGE },
      120_000,
    );
    if (r.status !== 200 && !/not running/i.test(bodyMessage(r))) {
      throw new LumeError('API', `lume stop ${name}: HTTP ${r.status}: ${bodyMessage(r)}`, r.status);
    }
  }

  async remove(name: string): Promise<void> {
    this.#assertName(name);
    const info = await this.inspect(name);
    if (info) {
      if (info.state !== 'stopped') await this.stop(name);
      const d = await this.runtime.api(
        'DELETE',
        `${this.#vmPath(name)}?storage=${LUME_STORAGE}`,
        undefined,
        120_000,
      );
      if (d.status !== 200)
        throw new LumeError('API', `lume delete ${name}: HTTP ${d.status}: ${bodyMessage(d)}`, d.status);
    }
    await rm(this.#shareDir(name), { recursive: true, force: true });
  }

  #toInfo(name: string, b: Record<string, unknown>, labels: Record<string, string>): MacVmInfo {
    const st = String(b.status ?? 'unknown');
    const state: MacVmState =
      st === 'running'
        ? 'running'
        : st === 'stopped'
          ? 'stopped'
          : st === 'starting'
            ? 'starting'
            : 'unknown';
    const disk = b.diskSize as { allocated?: number } | undefined;
    return {
      name,
      state,
      ...(typeof b.ipAddress === 'string' && b.ipAddress ? { ip: b.ipAddress } : {}),
      ...(typeof b.cpuCount === 'number' ? { cpus: b.cpuCount } : {}),
      ...(typeof b.memorySize === 'number' ? { memoryBytes: b.memorySize } : {}),
      ...(typeof b.display === 'string' ? { display: b.display } : {}),
      ...(disk?.allocated !== undefined ? { diskAllocatedBytes: disk.allocated } : {}),
      labels,
    };
  }

  /** {@link #toInfo} plus what MineVibe knows beside Lume: the serve log's end of the run, its shares, the token. */
  async #fullInfo(
    name: string,
    body: Record<string, unknown>,
    labels: Record<string, string>,
  ): Promise<MacVmInfo> {
    const info = this.#toInfo(name, body, labels);
    if (info.state === 'running' && (await this.#endedSinceStart(name))) {
      info.state = 'stopped';
      info.ended = true;
    }
    if (info.state === 'running') {
      const session = await this.runtime.session(name);
      if (session) info.shares = session.shares;
    }
    try {
      const token = (await readFile(join(this.#shareDir(name), 'setup', 'env-token'), 'utf8')).trim();
      if (token) info.tokenSha256 = tokenFingerprint(token);
    } catch {}
    return info;
  }

  async inspect(name: string): Promise<MacVmInfo | null> {
    const r = await this.#get(name);
    if (r.status === 404 || (r.status === 400 && /not found/i.test(bodyMessage(r)))) return null;
    if (r.status !== 200) {
      throw new LumeError('API', `lume get ${name}: HTTP ${r.status}: ${bodyMessage(r)}`, r.status);
    }
    return this.#fullInfo(
      name,
      (r.body ?? {}) as Record<string, unknown>,
      (await this.#labelsOf(name)) ?? {},
    );
  }

  /** MineVibe's VMs (never the base) whose labels carry every given label. Throws when Lume cannot list them. */
  async list(labels: Record<string, string>): Promise<MacVmInfo[]> {
    const out: MacVmInfo[] = [];
    for (const vm of await this.runtime.listVms()) {
      const name = typeof vm.name === 'string' ? vm.name : '';
      if (!VM_NAME_RE.test(name) || name === this.baseName) continue;
      const l = await this.#labelsOf(name);
      if (!l || !hasLabels(l, labels)) continue;
      out.push(await this.#fullInfo(name, vm, l));
    }
    return out;
  }
}
