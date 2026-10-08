import { fileURLToPath } from 'node:url';
import { DEV_BRIDGE_PORT } from '@minevibe/protocol';
import { runApp } from './app/runApp.js';
import { devHome, ensureBaseDirs, findRepoRoot, HOME_ENV, resolvePaths } from './config/paths.js';
import { doctorReport } from './doctor.js';
import { createLogger } from './log.js';
import { startDevServer } from './orchestrator/devServer.js';
import { type PlayControl, play } from './orchestrator/play.js';
import { AlreadyRunningError, acquireRunLock, type RunLock } from './orchestrator/runLock.js';
import { SERVER_VERSION } from './version.js';

const USAGE = `MineVibe server ${SERVER_VERSION}

Usage: minevibe-server <command>

Commands:
  app       Node's side of MineVibe.app: NDJSON with the Swift stub on stdin/stdout (started by the stub)
            (--selftest: handshake and bundle checks only, no game)
  dev       Start the MineVibe server (crew, PCs, org services) on 127.0.0.1:${DEV_BRIDGE_PORT} for ./gradlew runClient
            (data under MINEVIBE_HOME, default <repo>/.minevibe-dev; a fresh token in run/bridge.json every run)
            --scripted-crew  run a scripted, zero-token crew (Ada, Bram) to exercise the in-game UI
            --no-crew        no crew at all (chat is routed against an empty roster)
  doctor    Print versions and paths
  play      Install or verify Java, Minecraft, Fabric and the mods, start the same server, then launch the game
            (data under MINEVIBE_HOME, default <repo>/.minevibe-dev/play; bridge on a random port)
  help      Show this help

Environment:
  MINEVIBE_CLAUDE=bundled     dev and play: run the Agent SDK's own claude instead of yours
  MINEVIBE_PC_RUNTIME=docker  use Docker/OrbStack for PCs instead of Apple container
  MINEVIBE_PCS=off            no PCs (the container engine is never touched)
`;

/** A terminal Ctrl+C can reach Node twice (the process group, and npm forwarding it); only a later one escalates. */
const REPEAT_SIGNAL_MS = 2000;

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEV_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MINEVIBE_BRIDGE_PORT must be a port number, got "${value}"`);
  }
  return port;
}

async function runDev(args: readonly string[] = []): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
  if (!repoRoot) {
    process.stderr.write('dev must run inside a MineVibe checkout (no workspace root found)\n');
    return 1;
  }
  const log = createLogger({
    pretty: process.stdout.isTTY === true && process.env.MINEVIBE_LOG_JSON !== '1',
  });
  // Its own home and its own run lock: `npm run play` lives in <repo>/.minevibe-dev/play, so the two never share
  // run/bridge.json or the world record; with the same MINEVIBE_HOME the lock refuses the second one.
  const home = process.env[HOME_ENV]?.trim() || devHome(repoRoot);
  const paths = resolvePaths({ env: { ...process.env, [HOME_ENV]: home }, cwd: repoRoot });
  await ensureBaseDirs(paths);
  let lock: RunLock;
  try {
    lock = await acquireRunLock(paths.lockFile);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      log.error(`${err.message} with the data in ${paths.appSupport}`);
      return 1;
    }
    throw err;
  }
  let server: Awaited<ReturnType<typeof startDevServer>>;
  try {
    server = await startDevServer({
      repoRoot,
      paths,
      logger: log,
      port: parsePort(process.env.MINEVIBE_BRIDGE_PORT),
      ...(process.env.MINEVIBE_PLAYER_NAME ? { playerName: process.env.MINEVIBE_PLAYER_NAME } : {}),
      ...(args.includes('--scripted-crew') ? { scriptedCrew: true } : {}),
      ...(args.includes('--no-crew') ? { crew: 'none' as const } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.error('bridge port is already in use: is another dev server running?');
    } else {
      log.error({ err }, 'dev server failed to start');
    }
    await lock.release();
    return 1;
  }

  return new Promise<number>((resolveExit) => {
    let signalledAt = 0;
    const shutdown = (signal: NodeJS.Signals) => {
      const now = Date.now();
      if (signalledAt !== 0) {
        if (now - signalledAt < REPEAT_SIGNAL_MS) return; // the same Ctrl+C, delivered twice
        log.warn({ signal }, 'forced exit');
        resolveExit(130);
        return;
      }
      signalledAt = now;
      log.info({ signal }, 'shutting down');
      server
        .stop('quit')
        .then(() => lock.release())
        .then(
          () => resolveExit(0),
          (err: unknown) => {
            log.error({ err }, 'shutdown failed');
            resolveExit(1);
          },
        );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
  });
}

async function runPlay(): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
  const log = createLogger({
    pretty: process.stdout.isTTY === true && process.env.MINEVIBE_LOG_JSON !== '1',
  });
  const control: PlayControl = { onStopRequest: null };
  const onSignal = (signal: NodeJS.Signals) => {
    if (control.onStopRequest) control.onStopRequest(signal);
    else process.exit(130);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);
  try {
    return await play({ repoRoot, logger: log, control });
  } catch (err) {
    if (err instanceof AlreadyRunningError) log.error(err.message);
    else log.error({ err }, 'play failed');
    return 1;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(signal, onSignal);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command = 'help'] = argv;
  switch (command) {
    case 'app':
      return runApp({ argv: argv.slice(1) });
    case 'dev':
      return runDev(argv.slice(1));
    case 'doctor':
      process.stdout.write(`${(await doctorReport()).join('\n')}\n`);
      return 0;
    case 'play':
      return runPlay();
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // dev, play and app hold sockets and HTTP keep-alive pools open; exit explicitly once they are done.
    if (code !== 0 || ['dev', 'play', 'app'].includes(process.argv[2] ?? '')) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
