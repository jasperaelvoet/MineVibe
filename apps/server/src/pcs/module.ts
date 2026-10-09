import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { appBundleLayout } from '../app/appLayout.js';
import type { HostDialogs } from '../app/StubChannel.js';
import { findRepoRoot } from '../config/paths.js';
import type { CreatePcModule, PcModule, RuntimeContext } from '../orchestrator/modules.js';
import { androidKitFor, readAndroidHelper } from './android/index.js';
import { settleWithin } from './deadline.js';
import { AppleContainerDriver } from './drivers/AppleContainerDriver.js';
import {
  type ContainerLock,
  type ContainerRoots,
  ContainerRuntime,
  devContainerRoots,
  resolveContainerRoots,
} from './drivers/ContainerRuntime.js';
import { DockerDriver } from './drivers/DockerDriver.js';
import type { PcDriver } from './drivers/PcDriver.js';
import type { FrameService } from './FrameService.js';
import { createFolderPicker, type FolderPicker } from './folderPicker.js';
import { PcGuestApi } from './GuestApi.js';
import type { InputRouter } from './InputRouter.js';
import { registryDirFor } from './InstanceRegistry.js';
import { PcBridgeGlue } from './PcBridgeGlue.js';
import { PcManager } from './PcManager.js';
import { SeatBook } from './SeatBook.js';
import { ShellMirror } from './ShellMirror.js';
import { SpacesdPool } from './SpacesdPool.js';

/**
 * The PC module (PLAN §8): PcManager on Apple `container` (Docker in dev/CI with `runtime: 'docker'`), the bridge glue
 * of the PC group, the PcApi the agents' `pc` tools use, and ShellMirror.
 *
 * `start()` loads `@trycua/cua` (telemetry off), reads `pcs.json` (creating `linux-1` on the very first run, PLAN §7.5
 * "First PC"), attaches the bridge glue and then, in the background, starts the engine, reconciles, boots every
 * plugged PC in priority order and starts the monitor. `stop()` stops every PC and lets go of the engine (it stops only
 * when it is ours and no other MineVibe uses it).
 *
 * Container roots: MineVibe.app runs the bundle's read-only install root (`appBundleLayout().containerInstallRoot`,
 * never provisioned) with the app root in Application Support; `dev` and `play` use the MineVibe-dev roots
 * (`~/Library/Application Support/MineVibe-dev`), which must stay outside `~/Documents` (PLAN §8.6).
 *
 * Every Linux PC mounts the org module's Codex export (`ctx.paths.codexExport`, which CodexStore keeps) read-only at
 * `/mnt/codex` (PLAN §6.6), and PcManager records this home's instance in `<appRoot>/minevibe-instances/` for
 * `doctor --clean-orphans`.
 */

export interface PcModuleOptions {
  readonly runtime: 'container' | 'docker';
  /** MineVibe.app's `Contents/Runtime/container` (read-only). */
  readonly bundleInstallRoot?: string;
  /** The stub's native dialogs (MineVibe.app): `host.pick_folder` opens its NSOpenPanel. */
  readonly dialogs?: HostDialogs | null;
}

/** Everything the module runs on; `buildPcParts` makes the real ones, tests pass fakes. */
export interface PcModuleParts {
  readonly manager: PcManager;
  readonly pool: SpacesdPool;
  readonly pickFolder: FolderPicker;
  readonly log: Logger;
}

/** Tuning (tests). */
export interface PcModuleTuning {
  /** Start the engine and boot the PCs in `start()` (default true). */
  readonly boot?: boolean;
  /** Run the monitor after booting (default true). */
  readonly monitor?: boolean;
  /** Create `linux-1` when there is no `pcs.json` yet (default true). */
  readonly firstPc?: boolean;
  /** Passed to the bridge glue. */
  readonly settleMs?: number;
  readonly helloRepushMs?: number;
  readonly budgetDebounceMs?: number;
  /** Stop the engine on `stop()` when it is ours and unused (default true). */
  readonly stopEngine?: boolean;
}

/** The `container` lock of a dev checkout or of the bundle (sync: the module is built synchronously). */
export function loadContainerLock(candidates: readonly string[], fallbackVersion = '1.5.0'): ContainerLock {
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { container?: ContainerLock };
      if (json.container?.pkg?.sha256) return json.container;
    } catch {
      // try the next one
    }
  }
  // Inside a bundle without a lock: only the version matters (stale-engine detection); nothing is provisioned.
  return { version: fallbackVersion, pkg: { name: 'bundled', url: 'about:blank', sha256: '' } };
}

/** The container version the bundle was built with (`build-info.json`), if readable. */
function bundledContainerVersion(buildInfo: string | undefined): string | undefined {
  if (!buildInfo) return undefined;
  try {
    const info = JSON.parse(readFileSync(buildInfo, 'utf8')) as { vendors?: { container?: unknown } };
    return typeof info.vendors?.container === 'string' ? info.vendors.container : undefined;
  } catch {
    return undefined;
  }
}

/** The container roots for a mode (env overrides always win, PLAN §8.6). */
export function containerRootsFor(
  ctx: Pick<RuntimeContext, 'mode' | 'paths'>,
  bundleInstallRoot: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContainerRoots {
  if (ctx.mode === 'app') {
    return resolveContainerRoots({
      appSupportContainer: ctx.paths.container,
      ...(bundleInstallRoot ? { bundleInstallRoot } : {}),
      env,
    });
  }
  return resolveContainerRoots({ appSupportContainer: devContainerRoots().appRoot, env });
}

/** Builds the real PC stack for a runtime context. */
export function buildPcParts(ctx: RuntimeContext, opts: PcModuleOptions): PcModuleParts {
  const log = ctx.log.child({ component: 'pcs' });
  const pool = new SpacesdPool({ cachesDir: ctx.paths.caches, logger: log });
  const repo = findRepoRoot(fileURLToPath(new URL('.', import.meta.url))) ?? findRepoRoot(process.cwd());
  const layout = ctx.mode === 'app' ? appBundleLayout() : null;
  let driver: PcDriver;
  let diskPath: string;
  let registryDir: string | null = null;
  let appRoot: string | null = null;
  if (opts.runtime === 'docker') {
    driver = new DockerDriver();
    diskPath = ctx.paths.state;
  } else {
    const bundleInstallRoot = opts.bundleInstallRoot ?? layout?.containerInstallRoot;
    const roots = containerRootsFor(ctx, bundleInstallRoot);
    const bundled = bundleInstallRoot !== undefined && resolve(bundleInstallRoot) === roots.installRoot;
    const lock = loadContainerLock(
      [
        ...(layout ? [join(layout.bundle, 'Contents', 'Resources', 'vendor.lock.json')] : []),
        ...(repo ? [join(repo, 'packaging', 'vendor.lock.json')] : []),
      ],
      bundledContainerVersion(layout?.buildInfo),
    );
    const runtime = new ContainerRuntime({
      ...roots,
      lock,
      // Dev shares the pkg cache with build-app and `npm run test:pcs`.
      cacheDir:
        ctx.mode === 'app'
          ? join(ctx.paths.caches, 'vendor')
          : join(homedir(), 'Library', 'Caches', 'MineVibe-dev', 'vendor'),
      logger: log,
      leaseHolder: `minevibe-server ${ctx.mode}`,
      readOnlyInstall: bundled,
    });
    driver = new AppleContainerDriver(runtime, { logger: log });
    diskPath = roots.appRoot;
    registryDir = registryDirFor(roots.appRoot);
    appRoot = roots.appRoot;
  }
  const context = repo ? join(repo, 'images', 'linux-pc') : null;
  const imageBuild =
    context && existsSync(join(context, 'Containerfile'))
      ? { contextDir: context, file: join(context, 'Containerfile') }
      : undefined;
  // The Android phone and nested virtualization (PLAN §8.7): Apple container only.
  const android = appRoot
    ? androidKitFor({ appRoot, driver, stateDir: ctx.paths.state, manager: () => manager, logger: log })
    : null;
  const manager: PcManager = new PcManager({
    stateDir: ctx.paths.state,
    driver,
    pool,
    logger: log,
    diskPath,
    ...(imageBuild ? { imageBuild } : {}),
    android,
    androidHelper: readAndroidHelper(context),
    // The org module's Codex export (CodexStore), read-only at /mnt/codex (PLAN §6.6).
    codexExport: ctx.paths.codexExport,
    registryDir,
    // MineVibe's own data (tokens, worlds, caches, the Codex export) never goes into a PC through the Vault.
    vaultForbidden: [ctx.paths.appSupport, ctx.paths.caches, ctx.paths.logs, ctx.paths.codexExport],
  });
  const pickFolder = createFolderPicker({ mode: ctx.mode, dialogs: opts.dialogs ?? null, logger: log });
  return { manager, pool, pickFolder, log };
}

export class PcModuleImpl implements PcModule {
  readonly pcApi: PcGuestApi;
  readonly seats = new SeatBook();
  readonly manager: PcManager;
  readonly router: InputRouter;
  readonly mirror: ShellMirror;
  readonly #ctx: RuntimeContext;
  readonly #parts: PcModuleParts;
  readonly #tuning: PcModuleTuning;
  readonly #log: Logger;
  #frames: FrameService | null = null;
  #glue: PcBridgeGlue | null = null;
  #booting: Promise<void> | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<void> | null = null;

  constructor(ctx: RuntimeContext, parts: PcModuleParts, tuning: PcModuleTuning = {}) {
    this.#ctx = ctx;
    this.#parts = parts;
    this.#tuning = tuning;
    this.#log = parts.log;
    this.manager = parts.manager;
    this.router = parts.manager.createInputRouter({
      onPointer: (pcId, pos) => this.#glue?.onCursor(pcId, pos),
    });
    this.pcApi = new PcGuestApi({
      pcs: this.manager,
      client: (pcId) => parts.pool.client(pcId),
      router: this.router,
      seats: this.seats,
      jpegFormat: () => this.#jpegFormat(),
      pngFormat: () => {
        try {
          return parts.pool.pngFormat;
        } catch {
          return 0; // ImageFormat.Png
        }
      },
      logger: this.#log,
    });
    this.mirror = new ShellMirror({
      client: (pcId) => parts.pool.client(pcId),
      sweep: (pcId, name, value) => this.pcApi.sweep(pcId, name, value),
      logger: this.#log,
    });
  }

  /** The bridge glue (after `start()`). */
  get glue(): PcBridgeGlue | null {
    return this.#glue;
  }

  /** The background engine start and boot (after `start()`). */
  get booting(): Promise<void> | null {
    return this.#booting;
  }

  #jpegFormat(): number {
    try {
      return this.#parts.pool.jpegFormat;
    } catch {
      return 1; // ImageFormat.Jpeg
    }
  }

  start(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    const { manager, pool } = this.#parts;
    try {
      await pool.module();
    } catch (err) {
      this.#log.error({ err: String(err) }, '@trycua/cua could not be loaded; PCs cannot be reached');
    }
    const fresh = !existsSync(manager.pcsFile);
    await manager.init({ createDefault: fresh && this.#tuning.firstPc !== false });
    if (fresh) this.#log.info({ pcs: manager.list().map((p) => p.id) }, 'first run: PCs created');
    // `stop()` came while this was loading: attach nothing and boot nothing (stop waits for this to return).
    if (this.#stopping) return;
    this.#frames = manager.createFrameService(
      { sendFrame: (frame) => this.#ctx.bridge.sendFrame(frame) },
      { jpegFormat: this.#jpegFormat(), onCursor: (pcId, pos) => this.#glue?.onCursor(pcId, pos) },
    );
    this.#glue = new PcBridgeGlue({
      bridge: this.#ctx.bridge,
      manager,
      frames: this.#frames,
      router: this.router,
      seats: this.seats,
      guest: this.pcApi,
      mirror: this.mirror,
      pickFolder: this.#parts.pickFolder,
      logger: this.#log,
      ...(this.#tuning.settleMs !== undefined ? { settleMs: this.#tuning.settleMs } : {}),
      ...(this.#tuning.helloRepushMs !== undefined ? { helloRepushMs: this.#tuning.helloRepushMs } : {}),
      ...(this.#tuning.budgetDebounceMs !== undefined
        ? { budgetDebounceMs: this.#tuning.budgetDebounceMs }
        : {}),
    });
    this.#glue.attach();
    this.#glue.pushAll();
    if (this.#tuning.boot !== false) this.#booting = this.#boot();
  }

  /** Engine, reconcile, boot in priority order, monitor. Failures show as PC statuses; this never rejects. */
  async #boot(): Promise<void> {
    const { manager } = this.#parts;
    try {
      const up = await manager.engineUp((m) => this.#log.info({ engine: m }, 'PC engine'));
      if (!up || this.#stopping) return;
      const rec = await manager.reconcile();
      if (rec.orphans.length) this.#log.warn({ orphans: rec.orphans }, 'stopped orphaned PC containers');
      if (this.#stopping) return;
      const r = await manager.bootAll();
      this.#log.info(r, 'PCs booted');
      if (this.#tuning.monitor !== false && !this.#stopping) manager.startMonitor();
    } catch (err) {
      this.#log.error({ err: String(err) }, 'PC boot failed');
    }
  }

  onWorldOpen(): void {
    this.#glue?.pushAll();
  }

  /** The world ended: every seat is gone, and PCs set to wipe on death are reimaged. */
  onWorldEnded(worldId: string): void {
    this.#glue?.worldEnded();
    for (const p of this.manager.list()) {
      if (!p.wipeOnDeath) continue;
      this.#log.info({ pcId: p.id, worldId }, 'wiping a PC with the world');
      void this.manager.reimage(p.id).catch((err: unknown) => {
        this.#log.warn({ pcId: p.id, err: String(err) }, 'wipe on death failed');
      });
    }
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      const starting = this.#starting;
      if (!starting) return;
      await starting.catch(() => {});
      this.#glue?.detach();
      await settleWithin(this.mirror.closeAll(), 3000);
      this.pcApi.dispose();
      await this.manager.shutdown({ stopEngine: this.#tuning.stopEngine !== false });
    })();
    return this.#stopping;
  }
}

/** The PC module of the runtime (`orchestrator/modules.ts`). Pass {@link PcModuleOptions.dialogs} in MineVibe.app. */
export const createPcModule: CreatePcModule = (ctx, opts) =>
  new PcModuleImpl(ctx, buildPcParts(ctx, opts as PcModuleOptions));
