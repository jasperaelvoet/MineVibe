import { fileURLToPath } from 'node:url';
import { DEV_BRIDGE_PORT } from '@minevibe/protocol';
import { findRepoRoot } from './config/paths.js';
import { doctorReport } from './doctor.js';
import { createLogger } from './log.js';
import { startDevServer } from './orchestrator/devServer.js';
import { type PlayControl, play } from './orchestrator/play.js';
import { AlreadyRunningError } from './orchestrator/runLock.js';
import { SERVER_VERSION } from './version.js';

const USAGE = `MineVibe server ${SERVER_VERSION}

Usage: minevibe-server <command>

Commands:
  dev       Start the bridge on 127.0.0.1:${DEV_BRIDGE_PORT} for ./gradlew runClient (writes .dev-token)
  doctor    Print versions and paths
  play      Install or verify Java, Minecraft, Fabric and the mods, then launch the game
            (data under MINEVIBE_HOME, default <repo>/.minevibe-dev; bridge on a random port)
  help      Show this help
`;

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEV_BRIDGE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MINEVIBE_BRIDGE_PORT must be a port number, got "${value}"`);
  }
  return port;
}

async function runDev(): Promise<number> {
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
  if (!repoRoot) {
    process.stderr.write('dev must run inside a MineVibe checkout (no workspace root found)\n');
    return 1;
  }
  const log = createLogger({
    pretty: process.stdout.isTTY === true && process.env.MINEVIBE_LOG_JSON !== '1',
  });
  let server: Awaited<ReturnType<typeof startDevServer>>;
  try {
    server = await startDevServer({
      repoRoot,
      logger: log,
      port: parsePort(process.env.MINEVIBE_BRIDGE_PORT),
      ...(process.env.MINEVIBE_PLAYER_NAME ? { playerName: process.env.MINEVIBE_PLAYER_NAME } : {}),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.error('bridge port is already in use: is another dev server running?');
    } else {
      log.error({ err }, 'dev server failed to start');
    }
    return 1;
  }

  return new Promise<number>((resolveExit) => {
    let signalled = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (signalled) {
        log.warn({ signal }, 'forced exit');
        resolveExit(130);
        return;
      }
      signalled = true;
      log.info({ signal }, 'shutting down');
      server.stop('quit').then(
        () => resolveExit(0),
        (err: unknown) => {
          log.error({ err }, 'shutdown failed');
          resolveExit(1);
        },
      );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
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
    case 'dev':
      return runDev();
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
    // dev and play hold sockets and HTTP keep-alive pools open; exit explicitly once they are done.
    if (code !== 0 || process.argv[2] === 'dev' || process.argv[2] === 'play') process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
