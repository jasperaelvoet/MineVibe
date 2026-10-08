import { join } from 'node:path';
import { DEV_BRIDGE_PORT } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { ChatRouter } from '../agents/chat/ChatRouter.js';
import { createChatSendHandler } from '../agents/chat/chatSend.js';
import { BridgeServer } from '../bridge/BridgeServer.js';
import { loadOrCreateToken, removeBridgeFile, writeBridgeFile } from '../bridge/bridgeFile.js';
import {
  devHome,
  devTokenFile,
  ensureBaseDirs,
  HOME_ENV,
  type MineVibePaths,
  resolvePaths,
} from '../config/paths.js';
import { SERVER_VERSION } from '../version.js';
import { CurrentWorldStore } from '../world/currentWorld.js';
import { WorldLifecycle } from '../world/WorldLifecycle.js';

export interface DevServerOptions {
  /** The monorepo checkout (holds `.dev-token` and, by default, `.minevibe-dev/`). */
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
   * A per-run token (`npm run play`): used as-is and never written to `.dev-token`. Without it the token comes
   * from (or is created in) `<repo>/.dev-token`, so a restarted dev server keeps accepting a running game.
   */
  readonly token?: string;
  /** Data locations to use instead of resolving them from `env` and `repoRoot`. */
  readonly paths?: MineVibePaths;
}

export interface DevServer {
  readonly bridge: BridgeServer;
  readonly paths: MineVibePaths;
  readonly port: number;
  /** `.dev-token`, or null when a per-run token was passed in. */
  readonly tokenFile: string | null;
  readonly lifecycle: WorldLifecycle;
  stop(reason?: string): Promise<void>;
}

/**
 * `npm run dev` (PLAN §9.4): the bridge on 127.0.0.1:47800 with the token from `<repo>/.dev-token`, data
 * under `<repo>/.minevibe-dev` (unless MINEVIBE_HOME is set) and `run/bridge.json` for the mod's
 * `-Dminevibe.bridgeFile=…`.
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

  const tokenFile = options.token === undefined ? devTokenFile(options.repoRoot) : null;
  const token = tokenFile === null ? (options.token as string) : await loadOrCreateToken(tokenFile);

  const store = new CurrentWorldStore(join(paths.state, 'current-world.json'));
  await store.load();

  const bridge = new BridgeServer({
    token,
    port: options.port ?? DEV_BRIDGE_PORT,
    logger: log.child({ component: 'bridge' }),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  const lifecycle = new WorldLifecycle({
    bridge,
    store,
    logger: log.child({ component: 'world' }),
    serverVersion: SERVER_VERSION,
    playerName: options.playerName ?? 'Jasper',
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
    { port, bridgeFile: paths.bridgeFile, tokenFile, home: paths.appSupport, world: store.current.worldId },
    'dev server ready',
  );

  let stopping: Promise<void> | null = null;
  return {
    bridge,
    paths,
    port,
    tokenFile,
    lifecycle,
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
