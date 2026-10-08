import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { findRepoRoot, resolvePaths } from '../config/paths.js';
import { type FetchLike, launcherFetch } from '../launcher/download.js';
import { type Logger, REDACT_PATHS } from '../log.js';
import {
  MOD_JAR_ENV,
  type PlayControl,
  type PlayOptions,
  play,
  RESOURCES_ENV,
} from '../orchestrator/play.js';
import { AlreadyRunningError } from '../orchestrator/runLock.js';
import { SERVER_VERSION } from '../version.js';
import { type AppBundleLayout, appBundleLayout, findBundledModJar } from './appLayout.js';
import { countingFetch, LaunchProgress } from './launchProgress.js';
import { type LineWriter, StubChannel } from './StubChannel.js';
import { runSelftestChecks, type SelftestOptions } from './selftest.js';
import { type SelftestCheck, STUB_PROTOCOL_VERSION } from './stubProtocol.js';

export interface RunAppOptions {
  /** Arguments after `app` (`--selftest`). */
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default: process.stdin. */
  readonly stdin?: Readable;
  /** Default: the real stdout (and every other stdout write is sent to stderr). */
  readonly writeLine?: LineWriter;
  readonly logger?: Logger;
  /** Default: from process.execPath. */
  readonly layout?: AppBundleLayout | null;
  readonly repoRoot?: string | null;
  /** Base fetch for the installers (tests). */
  readonly fetch?: FetchLike;
  /** How long `--selftest` waits for the stub's hello (default 10 s). */
  readonly helloTimeoutMs?: number;
  /** Install SIGINT/SIGTERM/SIGHUP handlers (default true). */
  readonly handleSignals?: boolean;
  /** Test seams. */
  readonly play?: (options: PlayOptions) => Promise<number>;
  readonly selftest?: (options: SelftestOptions) => Promise<SelftestCheck[]>;
}

/** Makes stdout the stub channel: the returned writer owns it, and any other stdout write goes to stderr. */
function takeOverStdout(): LineWriter {
  const out = process.stdout;
  const write = out.write.bind(out) as (chunk: string, cb: (err?: Error | null) => void) => boolean;
  out.on('error', () => {}); // EPIPE once the stub is gone
  out.write = ((...args: Parameters<typeof process.stderr.write>) =>
    process.stderr.write(...args)) as typeof out.write;
  return (line, done) => {
    write(line, done);
  };
}

function appLogger(env: Readonly<Record<string, string | undefined>>, selftest: boolean): Logger {
  const base = {
    name: 'minevibe',
    level: env.MINEVIBE_LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  // The self-test is short and runs in CI: its log goes to stderr, which the stub shows.
  if (selftest) return pino(base, pino.destination({ dest: 2, sync: true }));
  const logs = resolvePaths({ env }).logs;
  mkdirSync(logs, { recursive: true });
  return pino(base, pino.destination({ dest: join(logs, 'server.log'), append: true, sync: true }));
}

/** A message for the stub's dialog (the detail carries the raw error). */
export function describeFailure(err: unknown): { message: string; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof AlreadyRunningError) return { message: 'MineVibe is already running', detail };
  if (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP \d{3}|no response from|stalled/i.test(
      detail,
    )
  ) {
    return {
      message: 'MineVibe could not download the game files',
      detail: `${detail}\n\nCheck the internet connection and open MineVibe again.`,
    };
  }
  if (/sha1|sha512|IntegrityError|mismatch|expected \d+ bytes/i.test(detail)) {
    return { message: 'A downloaded file failed its checksum', detail };
  }
  return { message: 'MineVibe could not start the game', detail };
}

/**
 * `minevibe-server app [--selftest]`: Node's side of MineVibe.app (PLAN §9.2). Says hello on stdout, then
 * - app: runs {@link play} from the bundle (its JRE, mod jar, mods.lock and seed configs), streaming `progress`
 *   (with `work: true` only while something is downloaded), `ready` once the game connects, and `error` before a
 *   failing exit. A `shutdown` command, EOF on stdin (the stub died) or a signal stops the game gracefully.
 * - selftest: waits for the stub's hello, reports {@link runSelftestChecks}, and exits on `shutdown` (CI).
 */
export async function runApp(options: RunAppOptions): Promise<number> {
  const env = options.env ?? process.env;
  const selftest = options.argv.includes('--selftest');
  const writeLine = options.writeLine ?? takeOverStdout();
  const log = options.logger ?? appLogger(env, selftest);
  const layout = options.layout !== undefined ? options.layout : appBundleLayout();
  const repoRoot =
    options.repoRoot !== undefined
      ? options.repoRoot
      : layout
        ? null
        : (findRepoRoot(process.cwd()) ?? findRepoRoot(fileURLToPath(new URL('.', import.meta.url))));
  const channel = new StubChannel(options.stdin ?? process.stdin, writeLine);
  channel.on('invalid', (line) => log.warn({ line }, 'ignored a line from the stub'));
  channel.on('hello', (hello) => log.info({ stub: hello.stub, stubPid: hello.pid }, 'stub connected'));
  // Listen before saying hello: the stub may answer (or quit) at once.
  const stopped = new Promise<void>((resolvePromise) => {
    channel.once('shutdown', () => resolvePromise());
    channel.once('eof', () => resolvePromise());
  });

  // Stop requests can arrive before play() installs its handler: they are replayed the moment it does.
  let stopHandler: ((reason: string) => void) | null = null;
  let stopReason: string | null = null;
  const control: PlayControl = {
    get onStopRequest() {
      return stopHandler;
    },
    set onStopRequest(handler) {
      stopHandler = handler;
      if (handler && stopReason !== null) handler(stopReason);
    },
  };
  const requestStop = (reason: string) => {
    log.info({ reason }, 'stop requested');
    stopReason ??= reason;
    stopHandler?.(reason);
  };
  if (!selftest) {
    channel.on('shutdown', (reason) => requestStop(`stub:${reason}`));
    channel.on('eof', () => requestStop('stub-gone'));
  }

  await channel.send({
    t: 'hello',
    v: STUB_PROTOCOL_VERSION,
    mode: selftest ? 'selftest' : 'app',
    server: SERVER_VERSION,
    node: process.version,
    pid: process.pid,
  });

  if (selftest) {
    try {
      await channel.waitForHello(options.helloTimeoutMs ?? 10_000);
      const checks = await (options.selftest ?? runSelftestChecks)({ layout, repoRoot, env });
      const ok = checks.every((c) => c.ok);
      await channel.send({ t: 'selftest', ok, checks });
      log.info({ ok, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, 'self-test done');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([stopped, new Promise<void>((r) => (timer = setTimeout(r, 30_000)))]);
      clearTimeout(timer);
      return ok ? 0 : 1;
    } catch (err) {
      log.error({ err }, 'self-test failed');
      return 1;
    } finally {
      channel.close();
    }
  }

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (signal: NodeJS.Signals) => requestStop(signal);
  if (options.handleSignals !== false) for (const s of signals) process.on(s, onSignal);

  const progress = new LaunchProgress((message) => void channel.send(message));
  try {
    const playEnv: Record<string, string | undefined> = { ...env };
    if (layout) {
      // Inside the bundle, the bundle's own resources always win over the environment.
      const jar = await findBundledModJar(layout.modResources);
      if (!jar) throw new Error(`no MineVibe mod jar in ${layout.modResources}`);
      playEnv[RESOURCES_ENV] = layout.modResources;
      playEnv[MOD_JAR_ENV] = jar;
    }
    const fetch = countingFetch(
      options.fetch ?? launcherFetch(),
      (url) => progress.request(url),
      (bytes) => progress.received(bytes),
    );
    log.info({ bundle: layout?.bundle ?? null, repoRoot, server: SERVER_VERSION }, 'MineVibe.app starting');
    const code = await (options.play ?? play)({
      repoRoot,
      logger: log,
      control,
      env: playEnv,
      fetch,
      onProgress: (event) => progress.onPlay(event),
    });
    if (code !== 0 && stopReason === null) {
      // The game itself failed (a crash, or killed): say so, or the stub can only report "exit code N".
      const consoleLog = join(resolvePaths({ env }).logs, 'minecraft-console.log');
      await channel.send({
        t: 'error',
        message: 'Minecraft quit unexpectedly',
        detail: `The game exited with code ${code}. Its output is in ${consoleLog}.`,
      });
    }
    await channel.send({ t: 'exit', code });
    return code;
  } catch (err) {
    log.error({ err }, 'MineVibe.app failed');
    const failure = describeFailure(err);
    await channel.send({ t: 'error', ...failure });
    await channel.send({ t: 'exit', code: 1 });
    return 1;
  } finally {
    progress.dispose();
    if (options.handleSignals !== false) for (const s of signals) process.removeListener(s, onSignal);
    channel.close();
  }
}
