import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEV_BRIDGE_PORT, DebugStateResult } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { ChatRouter } from '../agents/chat/ChatRouter.js';
import { createChatSendHandler } from '../agents/chat/chatSend.js';
import { BridgeServer } from '../bridge/BridgeServer.js';
import { generateToken, removeBridgeFile, writeBridgeFile } from '../bridge/bridgeFile.js';
import {
  devHome,
  ensureBaseDirs,
  HOME_ENV,
  legacyDevTokenFile,
  type MineVibePaths,
  resolvePaths,
} from '../config/paths.js';
import { SERVER_VERSION } from '../version.js';
import { CurrentWorldStore } from '../world/currentWorld.js';
import { buryWorldSave, GRAVEYARD_KEEP } from '../world/graveyard.js';
import { WorldLifecycle } from '../world/WorldLifecycle.js';

/** Overrides the dev client's Minecraft `saves/` folder (default `<repo>/apps/mod/run/saves`). */
export const SAVES_DIR_ENV = 'MINEVIBE_SAVES_DIR';
/** `1`/`true` turns on E2E mode (the `debug.*` helpers). */
export const E2E_ENV = 'MINEVIBE_E2E';

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
}

/** E2E helpers that drive the mod's `debug.*` handlers (the game must run with `-Dminevibe.e2e=true`). */
export interface DevDebug {
  state(timeoutMs?: number): Promise<DebugStateResult>;
  killPlayer(): Promise<void>;
  openMenu(): Promise<{ screen: string | null }>;
  clickBegin(): Promise<void>;
}

export interface DevServer {
  readonly bridge: BridgeServer;
  readonly paths: MineVibePaths;
  readonly port: number;
  readonly lifecycle: WorldLifecycle;
  readonly store: CurrentWorldStore;
  /** Where the dev client keeps its saves (and the `_graveyard`). */
  readonly savesDir: string;
  /** Non-null in E2E mode. */
  readonly debug: DevDebug | null;
  stop(reason?: string): Promise<void>;
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function createDebug(bridge: BridgeServer): DevDebug {
  return {
    async state(timeoutMs) {
      const reply = await bridge.request('debug.state', {}, timeoutMs !== undefined ? { timeoutMs } : {});
      const { t: _t, v: _v, re: _re, ...payload } = reply;
      return DebugStateResult.parse(payload);
    },
    async killPlayer() {
      await bridge.request('debug.kill_player', {});
    },
    async openMenu() {
      const reply = await bridge.request('debug.open_menu', {});
      return { screen: typeof reply.screen === 'string' ? reply.screen : null };
    },
    async clickBegin() {
      await bridge.request('debug.click_begin', {});
    },
  };
}

/**
 * `npm run dev` (PLAN §9.4): the bridge on 127.0.0.1:47800 with a fresh token per run, data under
 * `<repo>/.minevibe-dev` (unless MINEVIBE_HOME is set) and `run/bridge.json` (port, token, pid) for the mod's
 * `-Dminevibe.bridgeFile=…`. The mod never connects with a bridge file whose pid is not running.
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
  await ensureBaseDirs(paths);
  const log = options.logger;
  const savesDir = resolve(
    options.repoRoot,
    options.savesDir ?? (env[SAVES_DIR_ENV]?.trim() || join('apps', 'mod', 'run', 'saves')),
  );
  const graveyardKeep = options.graveyardKeep ?? GRAVEYARD_KEEP;
  const e2e = options.e2e ?? envFlag(env[E2E_ENV]);

  const token = options.token ?? generateToken();
  // Older versions kept a long-lived token in <repo>/.dev-token; it must not linger next to a fixed port.
  await rm(legacyDevTokenFile(options.repoRoot), { force: true });

  const store = new CurrentWorldStore(join(paths.state, 'current-world.json'));
  await store.load();

  const bridge = new BridgeServer({
    token,
    port: options.port ?? DEV_BRIDGE_PORT,
    logger: log.child({ component: 'bridge' }),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  const worldLog = log.child({ component: 'world' });
  const lifecycle = new WorldLifecycle({
    bridge,
    store,
    logger: worldLog,
    serverVersion: SERVER_VERSION,
    playerName: options.playerName ?? 'Jasper',
    onWorldEnded: async (dead) => {
      const result = await buryWorldSave(savesDir, dead.worldId, { keep: graveyardKeep });
      worldLog.info(
        { worldId: dead.worldId, movedTo: result.movedTo, pruned: result.pruned.length },
        result.movedTo ? 'dead world moved to the graveyard' : 'dead world has no save to bury',
      );
    },
  });

  // M1 has no crew yet: chat is routed (and validated) against an empty roster, and nothing is delivered.
  const chatLog = log.child({ component: 'chat' });
  bridge.handle(
    'chat.send',
    createChatSendHandler(
      new ChatRouter(),
      () => ({ playerName: lifecycle.playerName, crew: [], cards: new Map(), meeting: null }),
      (route) => chatLog.info({ scope: route.scope, deliveries: route.deliveries.length }, route.echo),
    ),
  );

  const port = await bridge.start();
  await writeBridgeFile(paths.bridgeFile, { port, token, pid: process.pid });
  log.info(
    {
      port,
      bridgeFile: paths.bridgeFile,
      home: paths.appSupport,
      savesDir,
      e2e,
      world: store.current.worldId,
    },
    'dev server ready',
  );

  let stopping: Promise<void> | null = null;
  return {
    bridge,
    paths,
    port,
    lifecycle,
    store,
    savesDir,
    debug: e2e ? createDebug(bridge) : null,
    stop(reason = 'quit') {
      stopping ??= (async () => {
        lifecycle.dispose();
        await bridge.close(reason);
        await removeBridgeFile(paths.bridgeFile, process.pid);
      })();
      return stopping;
    },
  };
}
