import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { MineVibePaths } from '../config/paths.js';
import { settleWithin } from '../pcs/deadline.js';
import { AppleContainerDriver } from '../pcs/drivers/AppleContainerDriver.js';
import {
  type ContainerLock,
  ContainerRuntime,
  EngineError,
  isInside,
  normalizeRoot,
  readContainerLock,
  resolveContainerRoots,
  sha256File,
} from '../pcs/drivers/ContainerRuntime.js';
import { type ExecFn, type ExecResult, execWithTimeout } from '../pcs/drivers/exec.js';
import type { PcDriver, Progress } from '../pcs/drivers/PcDriver.js';
import { registryDirFor } from '../pcs/InstanceRegistry.js';
import { PcManager } from '../pcs/PcManager.js';
import { LINUX_PC_IMAGE_DEV } from '../pcs/PcTypes.js';
import { SpacesdPool } from '../pcs/SpacesdPool.js';
import type { AppBundleLayout } from './appLayout.js';

/**
 * MineVibe.app's Linux PCs at launch (PLAN §8.1, §9.2, §9.3 step 3):
 * 1. Apple `container` runs from the bundle's install root (`appBundleLayout().containerInstallRoot`), which is
 *    checked against the bundled `vendor.lock.json` and never provisioned (the bundle is read-only).
 * 2. The engine is started (`system start --app-root … --install-root … --enable-kernel-install`; the first start
 *    downloads the kernel), and this process takes an engine lease. A stale apiserver of ours (another install root
 *    or version) is restarted, a wedged one booted out, a kernel-less one (an interrupted first start) restarted, but
 *    never under another live MineVibe's lease; one that belongs to another install is never touched.
 * 3. The startup reaper's container part: `PcManager.reconcile` stops this instance's orphaned containers (labels
 *    `minevibe=pc` + `minevibe.instance`) and adopts still-running ones that match their record.
 * 4. `linux-1` is created on first run, and the Linux PC image is built locally from the bundled `images/linux-pc`
 *    (`container build`, then `builder stop` + `builder delete`): the GHCR image is not published yet.
 * 5. After the game launched, {@link AppPcs.boot} boots the PCs in the background; quitting stops them (≤ 20 s) and
 *    the engine, if it is ours and no other MineVibe holds a lease on it.
 * Nothing here is fatal for the game: a failure leaves the PCs `engine_down` / `error`.
 *
 * Integration note (I1a/I1b): when the shared runtime owns the PcManager, hand it {@link AppPcs.manager} (built on
 * the app's driver) instead of making another one, and drop {@link AppPcs.boot} here.
 */

/** `MINEVIBE_PC_RUNTIME`: `container` (default) or `off` (no PCs at all; troubleshooting and tests). */
export const PC_RUNTIME_ENV = 'MINEVIBE_PC_RUNTIME';

/** The image the Linux PCs run (built locally until the GHCR image is published). */
export const APP_PC_IMAGE = LINUX_PC_IMAGE_DEV;

/** What PC preparation reports to the first-run window. */
export type PcPrepEvent =
  /** Starting the engine; `firstRun` when it has never run from this app root (the kernel downloads). */
  | { readonly step: 'engine'; readonly firstRun: boolean }
  /** Building the PC image (first run); `line` is the latest build output. */
  | { readonly step: 'image'; readonly line?: string }
  /** PCs are prepared (the game may launch). */
  | { readonly step: 'done' }
  /** PCs are unavailable this session; the game launches anyway. */
  | { readonly step: 'unavailable'; readonly reason: string };

export interface PcPrepOutcome {
  readonly engine: 'up' | 'down';
  readonly detail?: string;
  readonly image: 'present' | 'built' | 'failed' | 'skipped';
  readonly reaped?: Awaited<ReturnType<PcManager['reconcile']>>;
}

/**
 * Checks a read-only (bundled) install root against the lock without writing anything: every pinned file is a
 * regular file there, and `bin/container` matches its pin (what `ContainerRuntime.isProvisioned()` checks). The
 * full byte-for-byte comparison is the self-test's job (`--selftest`).
 */
export async function bundledInstallRootProblems(
  installRoot: string,
  lock: ContainerLock,
): Promise<string[]> {
  const files = lock.installRootFiles ?? {};
  const problems: string[] = [];
  await Promise.all(
    Object.keys(files).map(async (rel) => {
      const st = await lstat(join(installRoot, ...rel.split('/'))).catch(() => null);
      if (!st?.isFile()) problems.push(`${rel} is missing`);
    }),
  );
  const want = files['bin/container'];
  if (want && problems.length === 0) {
    const got = await sha256File(join(installRoot, 'bin', 'container')).catch(() => 'unreadable');
    if (got !== want) problems.push(`bin/container does not match vendor.lock.json (${got.slice(0, 12)})`);
  }
  return problems.sort();
}

/**
 * The full check (self-test): the install root holds exactly the lock's `installRootFiles`, byte for byte (sha256),
 * and nothing else (a dropped plugin, such as `k8s`, must really be gone). Returns the problems (empty = ok).
 */
export async function installRootMismatches(installRoot: string, lock: ContainerLock): Promise<string[]> {
  const want = lock.installRootFiles ?? {};
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      if (rel === '') problems.push(`${installRoot} is missing`);
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path, r);
      else if (!e.isFile()) problems.push(`${r}: not a regular file`);
      else {
        seen.add(r);
        const pin = want[r];
        if (pin === undefined) problems.push(`${r}: not in vendor.lock.json`);
        else if ((await sha256File(path)) !== pin)
          problems.push(`${r}: sha256 differs from vendor.lock.json`);
      }
    }
  };
  await walk(installRoot, '');
  for (const r of Object.keys(want)) if (!seen.has(r)) problems.push(`${r}: missing`);
  return problems.sort();
}

/** CLI calls that may take minutes (kernel download, base image pull, image build): a quit aborts them. */
export function isLongContainerCall(args: readonly string[]): boolean {
  const [a, b] = args;
  return a === 'build' || (a === 'image' && b === 'pull') || (a === 'system' && b === 'start');
}

/**
 * Wraps an exec so {@link isLongContainerCall}s are killed (process group) when `signal` aborts, and refused once it
 * has. Every other call (status, stop, builder cleanup, launchctl) is left alone, so teardown still works.
 */
export function abortableExec(signal: AbortSignal, base: ExecFn = execWithTimeout): ExecFn {
  return (file, args, options) => {
    if (!isLongContainerCall(args) || options.signal) return base(file, args, options);
    if (signal.aborted) {
      const aborted: ExecResult = {
        code: null,
        signal: null,
        stdout: '',
        stderr: 'aborted: MineVibe is quitting',
        ms: 0,
        timedOut: false,
        error: 'aborted',
      };
      return Promise.resolve(aborted);
    }
    return base(file, args, { ...options, signal });
  };
}

/**
 * Whether the engine's default kernel is installed in `appRoot` (`kernels/default.kernel-arm64`, a symlink to the
 * downloaded `vmlinux-*`). It is the last thing a first `system start --enable-kernel-install` installs, so a start
 * that was killed or crashed during the kernel download (or a cache cleaner that emptied the app root) leaves it
 * missing, even when the apiserver itself kept running.
 */
export function defaultKernelInstalled(appRoot: string): boolean {
  return existsSync(join(appRoot, 'kernels', 'default.kernel-arm64'));
}

/**
 * The app's `container` driver: like {@link AppleContainerDriver}, except that
 * - it never provisions an install root inside the bundle (it only checks it);
 * - it never stops our apiserver while another live MineVibe holds a lease on it: not to restart it from another
 *   install root (stale), and not to boot it out when it does not answer (wedged). That would pull the engine out
 *   from under the other MineVibe's PCs;
 * - it restarts our running apiserver when its kernel is missing (an interrupted first start), so the restart's
 *   `system start --enable-kernel-install` installs it; adopting it as is would fail every PC create and build.
 */
export class AppContainerDriver extends AppleContainerDriver {
  readonly #mayProvision: boolean;
  readonly #appLog: Logger | undefined;
  #lastError: string | null = null;

  constructor(
    runtime: ContainerRuntime,
    options: { mayProvision: boolean; logger?: Logger } = { mayProvision: false },
  ) {
    super(runtime, options.logger ? { logger: options.logger } : {});
    this.#mayProvision = options.mayProvision;
    this.#appLog = options.logger;
  }

  /** Why the engine last failed to start (null after a successful start). */
  get lastError(): string | null {
    return this.#lastError;
  }

  override async ensureEngine(onProgress?: Progress): Promise<void> {
    try {
      if (this.#mayProvision) {
        await this.runtime.provision(onProgress);
      } else {
        const problems = await bundledInstallRootProblems(this.runtime.installRoot, this.runtime.lock);
        if (problems.length > 0) {
          throw new EngineError(
            'NOT_PROVISIONED',
            `MineVibe's container files are damaged (${problems.slice(0, 3).join('; ')}); reinstall MineVibe`,
          );
        }
      }
      const runtime = this.runtime;
      await runtime.leases.withLock(async () => {
        await runtime.leases.acquire();
        const st = await runtime.status();
        const pids = async () => (await runtime.leases.others()).map((o) => o.pid).join(', ');
        if (st.ownership === 'ours_stale_install') {
          const others = await pids();
          if (others) {
            throw new EngineError(
              'ENGINE_IN_USE',
              `the container system runs from another install root (${st.installRoot ?? '?'}) for a MineVibe that is still running (pid ${others}); quit it first`,
            );
          }
        } else if (st.ownership === 'unknown') {
          // ensureStarted boots out a wedged apiserver whose launchd program is ours; not under a live MineVibe.
          const others = await pids();
          const prog = others ? await runtime.apiserverProgram() : null;
          if (prog && isInside(normalizeRoot(prog), normalizeRoot(runtime.installRoot))) {
            throw new EngineError(
              'ENGINE_IN_USE',
              `the container system does not answer (${st.detail ?? 'no status'}), and a MineVibe that is still running uses it (pid ${others}); quit it first`,
            );
          }
        } else if (st.ownership === 'ours' && !defaultKernelInstalled(runtime.appRoot)) {
          const others = await pids();
          if (others) {
            this.#appLog?.warn(
              { others },
              'the container system has no kernel, but another MineVibe uses it',
            );
          } else {
            this.#appLog?.warn(
              { appRoot: runtime.appRoot },
              'the container system runs without its kernel (an interrupted first start): restarting it',
            );
            onProgress?.('restarting the container system to install its kernel');
            await runtime.stopIfOurs();
          }
        }
        await runtime.ensureStarted(onProgress);
      });
      this.#lastError = null;
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}

export interface AppPcsOptions {
  readonly paths: MineVibePaths;
  /** The bundle (null in a checkout: the dev roots, provisioned from the repo's lock). */
  readonly layout: AppBundleLayout | null;
  readonly repoRoot: string | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly onProgress?: (event: PcPrepEvent) => void;
  /** Test seams. */
  readonly exec?: ExecFn;
  readonly pool?: SpacesdPool;
  readonly home?: string;
  readonly managerOptions?: Partial<ConstructorParameters<typeof PcManager>[0]>;
}

/** The newest non-empty line of a chunk of CLI output. */
function lastLine(chunk: string): string | undefined {
  const lines = chunk.split(/\r?\n|\r/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i];
  return undefined;
}

/** A driver that can say why its engine did not start ({@link AppContainerDriver}). */
export type AppPcDriver = PcDriver & { readonly lastError?: string | null };

export class AppPcs {
  /** The `container` runtime (null with a test driver). */
  readonly runtime: ContainerRuntime | null;
  readonly driver: AppPcDriver;
  readonly manager: PcManager;
  /** The engine's app root (its `kernels/` tells a first start). */
  readonly appRoot: string;
  /** The image build context (`Containerfile`, boot hook). */
  readonly imageContext: string;
  /** Where the image build's full output goes (`Logs/pc-image-build.log`); null keeps only the last lines. */
  readonly buildLog: string | null;
  readonly #log: Logger;
  readonly #onProgress: (event: PcPrepEvent) => void;
  /** Aborted on quit: long CLI calls (kernel download, image build) are killed. */
  readonly #abort: AbortController;
  #prepared: Promise<PcPrepOutcome> | null = null;
  #booting: Promise<void> | null = null;
  #shutdown: Promise<void> | null = null;
  #engineUp = false;
  #closed = false;

  constructor(options: {
    runtime: ContainerRuntime | null;
    driver: AppPcDriver;
    manager: PcManager;
    appRoot: string;
    imageContext: string;
    buildLog?: string | null;
    logger: Logger;
    onProgress?: (event: PcPrepEvent) => void;
    abort?: AbortController;
  }) {
    this.runtime = options.runtime;
    this.driver = options.driver;
    this.appRoot = options.appRoot;
    this.manager = options.manager;
    this.imageContext = options.imageContext;
    this.buildLog = options.buildLog ?? null;
    this.#log = options.logger;
    this.#onProgress = options.onProgress ?? (() => {});
    this.#abort = options.abort ?? new AbortController();
  }

  /** Whether the engine came up in {@link prepare}. */
  get engineUp(): boolean {
    return this.#engineUp;
  }

  #emit(event: PcPrepEvent): void {
    try {
      this.#onProgress(event);
    } catch (err) {
      this.#log.warn({ err }, 'PC progress listener failed');
    }
  }

  /**
   * Engine, reaper, `linux-1` and the image (once; later calls share the first). Never rejects: a failure is in the
   * outcome, and the PCs show it (`engine_down`, `error`). `signal` (a quit before the game runs) aborts the long
   * steps.
   */
  prepare(signal?: AbortSignal): Promise<PcPrepOutcome> {
    if (signal) {
      if (signal.aborted) this.#abort.abort(signal.reason);
      else signal.addEventListener('abort', () => this.#abort.abort(signal.reason), { once: true });
    }
    this.#prepared ??= this.#prepare();
    return this.#prepared;
  }

  async #prepare(): Promise<PcPrepOutcome> {
    const log = this.#log;
    const down = (detail: string): PcPrepOutcome => {
      this.#emit({ step: 'unavailable', reason: detail });
      return { engine: 'down', detail, image: 'skipped' };
    };
    try {
      // `linux-1` comes with the first run only (no pcs.json yet): a player who removed every PC keeps none.
      await this.manager.init({ createDefault: !existsSync(this.manager.pcsFile) });
      if (this.#abort.signal.aborted) return down('MineVibe is quitting');
      const firstRun = !defaultKernelInstalled(this.appRoot);
      this.#emit({ step: 'engine', firstRun });
      const t0 = performance.now();
      this.#engineUp = await this.manager.engineUp((m) => {
        if (m.trim()) log.info({ container: m.trim().slice(0, 300) }, 'container engine');
      });
      if (!this.#engineUp) {
        const detail = this.driver.lastError ?? 'the container engine did not start';
        log.error({ detail, appRoot: this.appRoot }, 'Linux PCs unavailable');
        return down(detail);
      }
      log.info(
        { ms: Math.round(performance.now() - t0), firstRun, appRoot: this.appRoot },
        'container engine up',
      );
      let reaped: PcPrepOutcome['reaped'];
      try {
        reaped = await this.manager.reconcile();
        const { adopted, orphans, mismatched, legacy } = reaped;
        if (
          adopted.length +
          orphans.length +
          mismatched.length +
          legacy.stopped.length +
          legacy.left.length
        ) {
          log.warn(
            { adopted, orphans, mismatched, legacy },
            'startup reaper: PC containers from an earlier run',
          );
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'startup reaper: reconcile failed');
      }
      if (this.#abort.signal.aborted)
        return { engine: 'up', image: 'skipped', ...(reaped ? { reaped } : {}) };
      let image: PcPrepOutcome['image'] = 'present';
      if (!(await this.driver.imageExists(APP_PC_IMAGE).catch(() => false))) {
        this.#emit({ step: 'image' });
        const t1 = performance.now();
        const recorder = await this.#buildRecorder();
        try {
          await this.manager.ensureImage(APP_PC_IMAGE, (chunk) => {
            recorder.record(chunk);
            const line = lastLine(chunk);
            if (line) this.#emit({ step: 'image', line });
          });
          image = 'built';
          log.info({ image: APP_PC_IMAGE, ms: Math.round(performance.now() - t1) }, 'Linux PC image built');
        } catch (err) {
          image = 'failed';
          log.warn(
            { image: APP_PC_IMAGE, err: String(err).slice(0, 2000), aborted: this.#abort.signal.aborted },
            'Linux PC image build failed (a PC start retries it)',
          );
        }
        await recorder.flushed();
      }
      this.#emit({ step: 'done' });
      return { engine: 'up', image, ...(reaped ? { reaped } : {}) };
    } catch (err) {
      log.error({ err }, 'Linux PC preparation failed');
      return down(err instanceof Error ? err.message : String(err));
    }
  }

  /** Appends build output to {@link buildLog} in order (a failed write only loses log lines). */
  async #buildRecorder(): Promise<{ record(chunk: string): void; flushed(): Promise<void> }> {
    const path = this.buildLog;
    if (!path) return { record: () => {}, flushed: async () => {} };
    await mkdir(dirname(path), { recursive: true }).catch(() => {});
    let tail = appendFile(path, `\n--- ${new Date().toISOString()} building ${APP_PC_IMAGE}\n`).catch(
      () => {},
    );
    return {
      record(chunk) {
        tail = tail.then(() => appendFile(path, chunk.endsWith('\n') ? chunk : `${chunk}\n`)).catch(() => {});
      },
      flushed: () => tail,
    };
  }

  /**
   * Boots the plugged PCs in the background (budget admission, boot order; a missing image is built first) and
   * starts the monitor. A no-op when the engine is down or the app is quitting (a quit during the PC setup must not
   * start PCs while the teardown stops them).
   */
  boot(): Promise<void> {
    if (!this.#engineUp || this.#closed || this.#abort.signal.aborted) return Promise.resolve();
    this.#booting ??= (async () => {
      try {
        const result = await this.manager.bootAll();
        this.#log.info(result, 'PCs booted');
        if (!this.#closed) this.manager.startMonitor();
      } catch (err) {
        this.#log.warn({ err: String(err) }, 'booting the PCs failed');
      }
    })();
    return this.#booting;
  }

  /**
   * Stops every PC (≤ 20 s) and lets go of the engine (stopped only when ours and no other live MineVibe holds a
   * lease on it). Long CLI calls still running (a first-run build) are killed first. Never rejects.
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= (async () => {
      this.#closed = true;
      this.#abort.abort(new Error('MineVibe is quitting'));
      if (!this.#prepared) return;
      await settleWithin(this.#prepared, 15_000);
      try {
        await this.manager.shutdown({ stopEngine: true });
      } catch (err) {
        this.#log.warn({ err: String(err) }, 'PC shutdown failed');
      }
      this.#log.info({ engineUp: this.#engineUp }, 'PCs stopped and the container engine let go');
    })();
    return this.#shutdown;
  }
}

/**
 * Builds the app's PCs from the bundle (or, in a checkout, from the repo), or returns null when PCs are switched off
 * (`MINEVIBE_PC_RUNTIME=off`) or this build cannot run them (the reason is logged).
 */
export async function createAppPcs(options: AppPcsOptions): Promise<AppPcs | null> {
  const env = options.env ?? process.env;
  const log = options.logger;
  const choice = env[PC_RUNTIME_ENV]?.trim() || 'container';
  if (choice !== 'container') {
    log.warn(
      { [PC_RUNTIME_ENV]: choice },
      'Linux PCs are off for this session (MineVibe.app runs only Apple container)',
    );
    return null;
  }
  if (process.platform !== 'darwin') {
    log.warn('Linux PCs need macOS (Apple container)');
    return null;
  }
  const { layout, repoRoot, paths } = options;
  const lockPath = layout
    ? layout.vendorLock
    : repoRoot
      ? join(repoRoot, 'packaging', 'vendor.lock.json')
      : null;
  const imageContext = layout
    ? layout.linuxPcContext
    : repoRoot
      ? join(repoRoot, 'images', 'linux-pc')
      : null;
  if (!lockPath || !imageContext) {
    log.warn('Linux PCs need the bundle or a checkout (no vendor.lock.json)');
    return null;
  }
  let lock: ContainerLock;
  try {
    lock = await readContainerLock(lockPath);
  } catch (err) {
    log.error({ err: String(err), lockPath }, 'Linux PCs unavailable: cannot read the container pin');
    return null;
  }
  if (!existsSync(join(imageContext, 'Containerfile'))) {
    log.error({ imageContext }, 'Linux PCs unavailable: the PC image build context is missing');
    return null;
  }

  const roots = resolveContainerRoots({
    appSupportContainer: paths.container,
    ...(layout ? { bundleInstallRoot: layout.containerInstallRoot } : {}),
    env,
    ...(options.home ? { home: options.home } : {}),
  });
  // The bundle is signed and read-only: an install root inside it is only ever checked, never written.
  const insideBundle =
    layout !== null && isInside(normalizeRoot(roots.installRoot), normalizeRoot(layout.bundle));
  const abort = new AbortController();
  const pcLog = log.child({ component: 'pcs' });
  const runtime = new ContainerRuntime({
    ...roots,
    lock,
    cacheDir: join(paths.caches, 'vendor'),
    logger: pcLog,
    leaseHolder: layout ? 'MineVibe.app' : 'minevibe-server app',
    exec: abortableExec(abort.signal, options.exec),
  });
  const driver = new AppContainerDriver(runtime, { mayProvision: !insideBundle, logger: pcLog });
  const pool = options.pool ?? new SpacesdPool({ cachesDir: paths.caches, logger: pcLog });
  const manager = new PcManager({
    stateDir: paths.state,
    driver,
    pool,
    logger: pcLog,
    diskPath: roots.appRoot,
    imageBuild: { contextDir: imageContext, file: join(imageContext, 'Containerfile') },
    // The org module's Codex export, read-only at /mnt/codex (PLAN §6.6), and the instance registry.
    codexExport: paths.codexExport,
    registryDir: registryDirFor(roots.appRoot),
    // A Vault folder may never expose MineVibe's own data, the engine's files or the app itself.
    vaultForbidden: [
      paths.appSupport,
      paths.caches,
      paths.logs,
      paths.codexExport,
      roots.appRoot,
      roots.installRoot,
      ...(layout ? [layout.bundle] : []),
    ],
    bootTimeoutMs: 180_000,
    ...(options.home ? { home: options.home } : {}),
    ...options.managerOptions,
  });
  log.info(
    {
      appRoot: roots.appRoot,
      installRoot: roots.installRoot,
      bundled: insideBundle,
      instance: manager.instanceId,
    },
    'Linux PCs: Apple container',
  );
  return new AppPcs({
    runtime,
    driver,
    manager,
    appRoot: roots.appRoot,
    imageContext,
    buildLog: join(paths.logs, 'pc-image-build.log'),
    logger: pcLog,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    abort,
  });
}
