import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { MinecraftFolder } from '@xmcl/core';
import type { Logger } from 'pino';
import { generateToken } from '../bridge/bridgeFile.js';
import { ensureBaseDirs, HOME_ENV, type MineVibePaths, playHome, resolvePaths } from '../config/paths.js';
import { type FetchLike, formatBytes } from '../launcher/download.js';
import { installFabricLoader } from '../launcher/installFabric.js';
import { installMinecraft } from '../launcher/installMinecraft.js';
import { JAVA_FOR_26_3, type JavaRequirement, resolveJava } from '../launcher/javaRuntime.js';
import { buildLaunchCommand, spawnGame } from '../launcher/launchGame.js';
import { extraJarFor, findDevModJar, installMods, loadModsLock } from '../launcher/mods.js';
import { readDataVersion, seedOptionsTxt } from '../launcher/optionsTxt.js';
import { seedConfigs } from '../launcher/seedConfigs.js';
import { loadLauncherSettings } from '../launcher/settings.js';
import { E2E_ENV, SCRIPTED_CREW_ENV } from './devServer.js';
import { acquireRunLock } from './runLock.js';
import { envFlag, type Runtime, type RuntimeOptions, startRuntime } from './runtime.js';

/** Directory holding `mods.lock.json` and `seed-configs/` (dev: `<repo>/packaging`; app: `Resources/mod`). */
export const RESOURCES_ENV = 'MINEVIBE_RESOURCES';
/** Use this MineVibe mod jar instead of `apps/mod/build/libs/minevibe-*.jar`. */
export const MOD_JAR_ENV = 'MINEVIBE_MOD_JAR';

/** Grace period between SIGTERM and SIGKILL for the JVM (it saves the world in a shutdown hook). */
export const GAME_STOP_GRACE_MS = 30_000;

export interface PlayControl {
  /** Set by {@link play}; called by the signal handlers in `main`. */
  onStopRequest: ((reason: string) => void) | null;
}

/** Milestones of {@link play}, for MineVibe.app's first-run window (`npm run play` ignores them). */
export type PlayProgressEvent =
  | { readonly phase: 'install'; readonly state: 'start' | 'done' }
  | { readonly phase: 'seed' }
  | { readonly phase: 'launch' }
  | { readonly phase: 'launched'; readonly pid: number | undefined }
  /** The game connected to the bridge (its window is up). */
  | { readonly phase: 'connected' }
  | { readonly phase: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null };

export interface PlayOptions {
  readonly repoRoot: string | null;
  readonly logger: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly control?: PlayControl;
  /** Fetch for every installer (MineVibe.app counts the downloads with it). Default: each installer's own. */
  readonly fetch?: FetchLike;
  /** Called at each milestone. */
  readonly onProgress?: (event: PlayProgressEvent) => void;
  /** `play` (default, `npm run play`) or `app` (MineVibe.app): the runtime mode the server starts in. */
  readonly mode?: 'play' | 'app';
  /** Module factories and agent seams for the composed runtime (tests). */
  readonly runtime?: Pick<RuntimeOptions, 'modules' | 'agents' | 'crew'>;
}

export interface PlayTimings {
  [phase: string]: number;
}

function resolveResources(
  repoRoot: string | null,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const dir = env[RESOURCES_ENV]?.trim() || (repoRoot ? join(repoRoot, 'packaging') : null);
  if (!dir || !existsSync(join(dir, 'mods.lock.json'))) {
    throw new Error(`cannot find mods.lock.json (set ${RESOURCES_ENV} or run inside a MineVibe checkout)`);
  }
  return dir;
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? await newestMtime(p) : (await stat(p)).mtimeMs);
  }
  return newest;
}

async function resolveModJar(
  repoRoot: string | null,
  env: Readonly<Record<string, string | undefined>>,
  log: Logger,
): Promise<string> {
  const override = env[MOD_JAR_ENV]?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`${MOD_JAR_ENV} does not exist: ${override}`);
    return override;
  }
  const jar = repoRoot ? await findDevModJar(repoRoot) : null;
  if (!jar || !repoRoot) {
    throw new Error('MineVibe mod jar not found: build it first with `cd apps/mod && ./gradlew build`');
  }
  const [jarTime, srcTime] = await Promise.all([
    stat(jar).then((s) => s.mtimeMs),
    newestMtime(join(repoRoot, 'apps', 'mod', 'src')),
  ]);
  if (srcTime > jarTime)
    log.warn({ jar }, 'apps/mod/src is newer than the mod jar; rebuild with ./gradlew build');
  return jar;
}

/** Sends SIGTERM (the JVM's shutdown hook saves the world), then SIGKILL if it is still running after `graceMs`. */
export function stopGame(child: ChildProcess, graceMs: number = GAME_STOP_GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, graceMs);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

/**
 * `npm run play` (PLAN §9.3/§9.4, M1): one MineVibe session from the terminal.
 * 1. Data under the play home (`<repo>/.minevibe-dev/play`, or `MINEVIBE_HOME`), single-instance lock. `npm run dev`
 *    keeps its own home (`<repo>/.minevibe-dev`), so they never share `run/bridge.json` or the world record.
 * 2. The composed runtime ({@link startRuntime}: world loop, crew, PCs, org services) on a random loopback port with a
 *    fresh token; `run/bridge.json` for the mod.
 * 3. Java 25, Minecraft, Fabric and the locked mods, installed or verified in parallel (fast when present).
 * 4. options.txt and mod configs merged, the dev mod jar copied into `game/mods`.
 * 5. The game runs with cwd = game dir; when the JVM exits everything is torn down and the exit code returned.
 * A stop request (SIGINT/SIGTERM) aborts installs, or asks the JVM to quit (SIGTERM, then SIGKILL after a grace).
 */
export async function play(options: PlayOptions): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.logger;
  const repoRoot = options.repoRoot;
  const started = performance.now();
  const timings: PlayTimings = {};
  const progress = (event: PlayProgressEvent) => {
    try {
      options.onProgress?.(event);
    } catch (err) {
      log.warn({ err }, 'progress listener failed');
    }
  };
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const mark = (phase: string, since: number) => {
    timings[phase] = Math.round(performance.now() - since);
  };

  const home = env[HOME_ENV]?.trim() || (repoRoot ? playHome(repoRoot) : '');
  const paths: MineVibePaths = resolvePaths({
    env: { ...env, [HOME_ENV]: home },
    cwd: repoRoot ?? process.cwd(),
  });
  await ensureBaseDirs(paths);
  const runLock = await acquireRunLock(paths.lockFile);

  const abort = new AbortController();
  let child: ChildProcess | null = null;
  let stopReason: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let lastRequest = 0;
  const control = options.control ?? { onStopRequest: null };
  control.onStopRequest = (reason) => {
    const now = Date.now();
    // A terminal Ctrl+C can arrive twice (the process group, and npm forwarding it); only a later repeat escalates.
    if (stopReason !== null && now - lastRequest < 2000) return;
    lastRequest = now;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (stopReason === null) {
        log.info({ reason }, 'stopping the game (SIGTERM; it saves the world)');
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child?.kill('SIGKILL'), GAME_STOP_GRACE_MS);
        killTimer.unref();
      } else {
        log.warn('stop requested again: killing the game');
        child.kill('SIGKILL');
      }
    } else if (stopReason === null) {
      log.info({ reason }, 'stopping');
      abort.abort(new Error(`stopped (${reason})`));
    }
    stopReason ??= reason;
  };
  // Last resort against orphans: whatever ends Node, the JVM is told to quit. SIGTERM, not SIGKILL: its shutdown hook
  // saves the world. Should the JVM ignore it, the mod's parent watchdog notices that Node is gone and quits too.
  const stopOnExit = () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  process.once('exit', stopOnExit);

  let server: Runtime | null = null;
  try {
    const settings = await loadLauncherSettings(paths.state, env, (msg) => log.warn(msg));
    const resources = resolveResources(repoRoot, env);
    const lock = await loadModsLock(join(resources, 'mods.lock.json'));
    const modJar = await resolveModJar(repoRoot, env, log);
    log.info({ home: paths.appSupport, player: settings.playerName }, 'MineVibe play');

    let t = performance.now();
    // The composed server (crew, PCs, org services) on a random loopback port, as in `npm run dev`.
    server = await startRuntime({
      mode: options.mode ?? 'play',
      paths,
      log,
      env,
      port: 0,
      token: generateToken(),
      playerName: settings.playerName,
      // The launched game keeps its saves in the launcher's game dir, so dead worlds are buried there.
      savesDir: join(paths.game, 'saves'),
      crew: options.runtime?.crew ?? (envFlag(env[SCRIPTED_CREW_ENV]) ? 'scripted' : 'agents'),
      e2e: envFlag(env[E2E_ENV]),
      ...(options.runtime?.modules ? { modules: options.runtime.modules } : {}),
      ...(options.runtime?.agents ? { agents: options.runtime.agents } : {}),
    });
    mark('bridge', t);
    server.bridge.once('connected', () => progress({ phase: 'connected' }));

    // Installs run in parallel; the first failure aborts the rest.
    progress({ phase: 'install', state: 'start' });
    t = performance.now();
    const gameDir = paths.game;
    const runtimeRoot = join(paths.appSupport, 'runtime');
    const signal = abort.signal;
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const s = performance.now();
      try {
        return await fn();
      } catch (err) {
        if (!abort.signal.aborted) abort.abort(err);
        throw err;
      } finally {
        mark(name, s);
      }
    };
    const javaFor = (requirement: JavaRequirement) =>
      resolveJava({
        runtimeRoot,
        requirement,
        env,
        log: log.child({ component: 'java' }),
        signal,
        ...fetchOption,
      });
    const [java, game, mods] = await Promise.all([
      step('java', () => javaFor(JAVA_FOR_26_3)),
      step('minecraft+fabric', async () => {
        const mc = await installMinecraft({ gameDir, version: lock.minecraft, log, signal, ...fetchOption });
        const fabric = await installFabricLoader({
          gameDir,
          minecraftVersion: lock.minecraft,
          loaderVersion: lock.loader,
          libraries: lock.fabric.libraries,
          log,
          signal,
          ...fetchOption,
        });
        return { mc, fabric };
      }),
      step('mods', () =>
        installMods({
          lock,
          enabledOptional: settings.optionalMods,
          cacheDir: join(paths.caches, 'mods'),
          modsDir: join(gameDir, 'mods'),
          extraJars: [extraJarFor(modJar, 'minevibe')],
          log: log.child({ component: 'mods' }),
          signal,
          ...fetchOption,
        }),
      ),
    ]);
    signal.throwIfAborted();
    let javaResolved = java;
    const required = game.mc.javaRequirement;
    if (
      required &&
      (required.component !== JAVA_FOR_26_3.component || required.majorVersion !== JAVA_FOR_26_3.majorVersion)
    ) {
      log.warn({ required }, 'version JSON asks for a different Java; resolving again');
      javaResolved = await javaFor(required);
    }
    mark('install', t);
    progress({ phase: 'install', state: 'done' });

    progress({ phase: 'seed' });
    t = performance.now();
    const clientJar = MinecraftFolder.from(gameDir).getVersionJar(lock.minecraft);
    const optionsResult = await seedOptionsTxt(gameDir, { dataVersion: () => readDataVersion(clientJar) });
    const configs = await seedConfigs(gameDir, join(resources, 'seed-configs'));
    mark('seed', t);

    log.info(
      {
        java: {
          source: javaResolved.source,
          version: javaResolved.version,
          downloaded: formatBytes(javaResolved.downloadedBytes),
        },
        minecraft: {
          version: lock.minecraft,
          installed: game.mc.installed,
          downloaded: formatBytes(game.mc.bytes),
        },
        fabric: { version: game.fabric.versionId, installed: game.fabric.installed },
        mods: {
          count: mods.mods.length + 1,
          downloaded: mods.downloaded,
          bytes: formatBytes(mods.downloadedBytes),
          apiCalls: mods.apiCalls,
        },
        options: optionsResult.changed,
        configs: configs.map((c) => `${c.file}:${c.action}`),
        timingsMs: timings,
      },
      'game ready',
    );

    const command = await buildLaunchCommand({
      javaPath: javaResolved.path,
      gameDir,
      versionId: game.fabric.versionId,
      resolved: game.fabric.resolved,
      playerName: settings.playerName,
      bridgeFile: paths.bridgeFile,
      parentPid: process.pid,
      maxMemoryMb: settings.maxMemoryMb,
    });
    signal.throwIfAborted();
    if (process.platform === 'darwin' && !command.includes('-XstartOnFirstThread')) {
      throw new Error('launch command lacks -XstartOnFirstThread (the version JSON rule did not apply)');
    }
    const consoleLog = join(paths.logs, 'minecraft-console.log');
    progress({ phase: 'launch' });
    const spawned = await spawnGame({ command, gameDir, consoleLog });
    child = spawned;
    if (stopReason !== null) {
      // A stop arrived while the JVM was being spawned: it gets the same graceful quit.
      spawned.kill('SIGTERM');
      killTimer = setTimeout(() => spawned.kill('SIGKILL'), GAME_STOP_GRACE_MS);
      killTimer.unref();
    }
    timings.launch = Math.round(performance.now() - started);
    progress({ phase: 'launched', pid: spawned.pid });
    log.info(
      { pid: spawned.pid, consoleLog, latestLog: join(gameDir, 'logs', 'latest.log') },
      'game launched',
    );

    if (spawned.stdout) {
      const lines = createInterface({ input: spawned.stdout });
      lines.on('line', (line) => {
        const m = /Loading (\d+) mods/.exec(line);
        if (m) log.info({ mods: Number(m[1]) }, 'Fabric is loading mods');
      });
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      spawned.once('exit', (code, sig) => resolveExit({ code, signal: sig }));
      spawned.once('error', (err) => {
        log.error({ err }, 'game process error');
        resolveExit({ code: 1, signal: null });
      });
    });
    if (killTimer) clearTimeout(killTimer);
    log.info({ code: exit.code, signal: exit.signal }, 'game exited');
    progress({ phase: 'exited', code: exit.code, signal: exit.signal });
    if (stopReason !== null) return 130;
    return exit.code ?? 1;
  } catch (err) {
    if (abort.signal.aborted && stopReason !== null) {
      log.info('stopped before the game started');
      return 130;
    }
    throw err;
  } finally {
    // Only an error path gets here with the game still running: let it save, then make sure it is gone.
    if (child) await stopGame(child);
    process.removeListener('exit', stopOnExit);
    control.onStopRequest = null;
    if (server) await server.stop('quit').catch((err: unknown) => log.warn({ err }, 'bridge stop failed'));
    await runLock.release();
    log.info({ totalMs: Math.round(performance.now() - started) }, 'MineVibe play finished');
  }
}
