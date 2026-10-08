import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEV_BRIDGE_PORT } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { devHome, HOME_ENV, legacyDevTokenFile, type MineVibePaths, resolvePaths } from '../config/paths.js';
import type { CreateOrgModule, CreatePcModule } from './modules.js';
import { type CrewMode, envFlag, type Runtime, type RuntimeOptions, startRuntime } from './runtime.js';

export type { DevDebug } from './runtime.js';

/** Overrides the dev client's Minecraft `saves/` folder (default `<repo>/apps/mod/run/saves`). */
export const SAVES_DIR_ENV = 'MINEVIBE_SAVES_DIR';
/** `1`/`true` turns on E2E mode (the `debug.*` helpers). */
export const E2E_ENV = 'MINEVIBE_E2E';
/** `1`/`true` runs the scripted dev crew (same as `npm run dev -- --scripted-crew`). */
export const SCRIPTED_CREW_ENV = 'MINEVIBE_SCRIPTED_CREW';

export interface DevServerOptions {
  /** The monorepo checkout (holds, by default, `.minevibe-dev/`). */
  readonly repoRoot: string;
  readonly logger: Logger;
  /** Defaults to 47800 (`MINEVIBE_BRIDGE_PORT` overrides in `main`). 0 picks a random port. */
  readonly port?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Offline profile name until the mod reports one. */
  readonly playerName?: string;
  /** Heartbeat interval for the bridge (0 disables). */
  readonly heartbeatMs?: number;
  /**
   * The bridge token. Default: a fresh random one for every run. It is only ever written to `run/bridge.json`
   * (0600), which the mod re-reads before every connection attempt, so a running game reconnects to a restarted dev
   * server without a long-lived token on disk.
   */
  readonly token?: string;
  /** Data locations to use instead of resolving them from `env` and `repoRoot`. */
  readonly paths?: MineVibePaths;
  /**
   * The dev client's Minecraft `saves/` folder. Dead worlds move to `<savesDir>/_graveyard` once the mod
   * reports them closed. Default: `$MINEVIBE_SAVES_DIR`, else `<repoRoot>/apps/mod/run/saves`
   * (where `./gradlew runClient` keeps its saves).
   */
  readonly savesDir?: string;
  /** How many dead saves the graveyard keeps (default 5). */
  readonly graveyardKeep?: number;
  /** E2E mode: exposes {@link DevServer.debug}. Default: `$MINEVIBE_E2E` is `1` or `true`. */
  readonly e2e?: boolean;
  /**
   * Run the scripted crew (zero tokens, canned replies) behind the UiHub, so the in-game UI can be exercised without
   * Claude. Default: `$MINEVIBE_SCRIPTED_CREW` is `1` or `true`. Same as `crew: 'scripted'`.
   */
  readonly scriptedCrew?: boolean;
  /** Which crew runs (default `agents`, or `scripted` per {@link scriptedCrew}). */
  readonly crew?: CrewMode;
  /** Reply delay of the scripted crew (default 1200 ms). */
  readonly scriptedReplyDelayMs?: number;
  /** Module factories (default: factories.ts). */
  readonly modules?: { readonly pc?: CreatePcModule; readonly org?: CreateOrgModule };
  /** Agent runtime seams (tests). */
  readonly agents?: RuntimeOptions['agents'];
  /** `dev` (default) or `play` (`npm run play` / MineVibe.app start the same server). */
  readonly mode?: RuntimeOptions['mode'];
  /** How long a spawn waits for the office door. */
  readonly officeDoorWaitMs?: number;
}

/** The dev server is the composed runtime ({@link startRuntime}) with dev defaults. */
export type DevServer = Runtime;

/**
 * `npm run dev` (PLAN §9.4): {@link startRuntime} on 127.0.0.1:47800 with a fresh token per run, data under
 * `<repo>/.minevibe-dev` (unless MINEVIBE_HOME is set) and `run/bridge.json` (port, token, pid) for the mod's
 * `-Dminevibe.bridgeFile=…` (`./gradlew runClient` reads it). The mod never connects with a bridge file whose pid is
 * not running.
 *
 * The hardcore loop (PLAN §7.9) runs here too: the world record in `state/current-world.json` is marked
 * dead (and the next world allocated) durably before `player.died` is acknowledged, and once the mod
 * reports the dead world `closed`, its save moves to `saves/_graveyard/` (the last 5 are kept).
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const env = options.env ?? process.env;
  const paths =
    options.paths ??
    resolvePaths({
      env: { ...env, [HOME_ENV]: env[HOME_ENV]?.trim() || devHome(options.repoRoot) },
      cwd: options.repoRoot,
    });
  const savesDir = resolve(
    options.repoRoot,
    options.savesDir ?? (env[SAVES_DIR_ENV]?.trim() || join('apps', 'mod', 'run', 'saves')),
  );
  // Older versions kept a long-lived token in <repo>/.dev-token; it must not linger next to a fixed port.
  await rm(legacyDevTokenFile(options.repoRoot), { force: true });
  const scripted = options.scriptedCrew ?? envFlag(env[SCRIPTED_CREW_ENV]);
  return startRuntime({
    mode: options.mode ?? 'dev',
    paths,
    log: options.logger,
    savesDir,
    env,
    port: options.port ?? DEV_BRIDGE_PORT,
    crew: options.crew ?? (scripted ? 'scripted' : 'agents'),
    e2e: options.e2e ?? envFlag(env[E2E_ENV]),
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.playerName !== undefined ? { playerName: options.playerName } : {}),
    ...(options.graveyardKeep !== undefined ? { graveyardKeep: options.graveyardKeep } : {}),
    ...(options.scriptedReplyDelayMs !== undefined
      ? { scriptedReplyDelayMs: options.scriptedReplyDelayMs }
      : {}),
    ...(options.modules !== undefined ? { modules: options.modules } : {}),
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
    ...(options.officeDoorWaitMs !== undefined ? { officeDoorWaitMs: options.officeDoorWaitMs } : {}),
  });
}
