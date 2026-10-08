import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { findRepoRoot, resolvePaths } from '../config/paths.js';
import { type FetchLike, launcherFetch } from '../launcher/download.js';
import { type Logger, REDACT_PATHS } from '../log.js';
import { createNullPcModule } from '../orchestrator/placeholderModules.js';
import {
  MOD_JAR_ENV,
  type PlayControl,
  type PlayHooks,
  type PlayOptions,
  play,
  RESOURCES_ENV,
} from '../orchestrator/play.js';
import { AlreadyRunningError } from '../orchestrator/runLock.js';
import { SERVER_VERSION } from '../version.js';
import { type AppBundleLayout, appBundleLayout, findBundledModJar, readBuildInfo } from './appLayout.js';
import { type AppPcs, type AppPcsOptions, createAppPcs, type PcPrepOutcome } from './appPcs.js';
import { countingFetch, LaunchProgress } from './launchProgress.js';
import {
  checkPrerequisites,
  describePrerequisites,
  type PrereqOptions,
  type PrereqReport,
} from './prerequisites.js';
import { reapStaleRunFiles } from './reaper.js';
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
  /** First-run prerequisites (default {@link checkPrerequisites}). */
  readonly prerequisites?: (options: PrereqOptions) => Promise<PrereqReport>;
  /** The Linux PCs (default {@link createAppPcs}); null runs without PCs. */
  readonly pcs?: ((options: AppPcsOptions) => Promise<AppPcs | null>) | null;
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

/** The dialog for a stub that speaks another protocol version than this Node. */
function stubMismatch(v: number): { message: string; detail: string } {
  return {
    message: 'MineVibe is damaged',
    detail: `Its launcher speaks protocol v${v}, its server v${STUB_PROTOCOL_VERSION}. Download MineVibe again and replace the app.`,
  };
}

/**
 * How long a launch without first-run PC work (no kernel download, no image build) holds the game for the PC setup.
 * A warm engine start takes about a second; one that hangs (a wedged apiserver, apple/container#2275) must not keep
 * the game away with no window on screen. The setup then goes on in the background, and the PCs boot after it.
 */
export const WARM_PC_WAIT_MS = 30_000;

/**
 * The app's {@link PlayHooks} (until the shared runtime takes them over):
 * - afterLock: the startup reaper's file part, then the PC setup starts in the background (engine from the bundle,
 *   this instance's orphaned containers, `linux-1`, the image), alongside the game install. A PC setup that cannot
 *   even be created leaves the session without PCs; it never fails the launch;
 * - beforeLaunch: the game waits for the PC setup while it does first-run work (the window shows the kernel download
 *   and the image build), else at most {@link WARM_PC_WAIT_MS}, and never past a quit; then the PCs boot in the
 *   background (never after a quit);
 * - beforeTeardown: the PCs and the engine are stopped.
 */
export function appHooks(options: {
  layout: AppBundleLayout | null;
  repoRoot: string | null;
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  progress: LaunchProgress;
  createPcs: ((options: AppPcsOptions) => Promise<AppPcs | null>) | null;
  /** Default {@link WARM_PC_WAIT_MS}. */
  warmWaitMs?: number;
}): PlayHooks {
  const { log, progress } = options;
  let pcs: AppPcs | null = null;
  let prepared: Promise<PcPrepOutcome> | null = null;
  let settled = false;
  /** The PC setup is downloading the kernel or building the image (shown in the window). */
  let firstRunWork = false;
  const report = (outcome: PcPrepOutcome) =>
    log.info(
      {
        engine: outcome.engine,
        image: outcome.image,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      },
      'Linux PCs prepared',
    );
  return {
    async afterLock({ paths, signal }) {
      await reapStaleRunFiles(paths, { logger: log });
      if (!options.createPcs) return;
      try {
        pcs = await options.createPcs({
          paths,
          layout: options.layout,
          repoRoot: options.repoRoot,
          env: options.env,
          logger: log,
          onProgress: (event) => {
            if (event.step === 'image' || (event.step === 'engine' && event.firstRun)) firstRunWork = true;
            progress.onPcs(event);
          },
        });
      } catch (err) {
        log.error({ err }, 'Linux PCs unavailable: the PC setup could not be created');
        pcs = null;
        return;
      }
      prepared =
        pcs?.prepare(signal).finally(() => {
          settled = true;
        }) ?? null;
    },
    async beforeLaunch({ signal }) {
      const setup = prepared;
      if (!setup || !pcs) return;
      const appPcs = pcs;
      if (!settled) progress.waitForPcs();
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const quit = new Promise<'quit'>((resolvePromise) => {
        onAbort = () => resolvePromise('quit');
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const slow = new Promise<'slow'>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise('slow'), options.warmWaitMs ?? WARM_PC_WAIT_MS);
      });
      try {
        let outcome = await Promise.race([setup, quit, slow]);
        // First-run work is on screen (with a Quit button): the game waits for it.
        if (outcome === 'slow' && firstRunWork) outcome = await Promise.race([setup, quit]);
        // A quit: the teardown stops the PC setup (bounded); nothing boots.
        if (outcome === 'quit') return;
        if (outcome === 'slow') {
          log.warn(
            { waitedMs: options.warmWaitMs ?? WARM_PC_WAIT_MS },
            'the Linux PC setup is slow; launching the game, the PCs follow in the background',
          );
          void setup.then((late) => {
            report(late);
            if (!signal.aborted) void appPcs.boot();
          });
          return;
        }
        report(outcome);
        if (!signal.aborted) void appPcs.boot();
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
    async beforeTeardown() {
      await pcs?.shutdown();
    },
  };
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
  channel.on('hello', (hello) =>
    log.info({ stub: hello.stub, stubPid: hello.pid, v: hello.v }, 'stub connected'),
  );
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
    // A stub from another build would misread what Node sends: say so and stop (the stub checks Node's too).
    channel.on('hello', (hello) => {
      if (hello.v === STUB_PROTOCOL_VERSION) return;
      log.error({ stubV: hello.v, nodeV: STUB_PROTOCOL_VERSION }, 'stub protocol mismatch');
      void channel.send({ t: 'error', ...stubMismatch(hello.v) });
      requestStop('stub-protocol');
    });
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
      const hello = await channel.waitForHello(options.helloTimeoutMs ?? 10_000);
      const checks = await (options.selftest ?? runSelftestChecks)({ layout, repoRoot, env });
      if (hello.v !== STUB_PROTOCOL_VERSION) {
        checks.unshift({ name: 'stub protocol', ok: false, detail: stubMismatch(hello.v).detail });
      }
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
    // PLAN §9.3 step 1: nothing is installed or started while a prerequisite is missing.
    const buildInfo = layout ? await readBuildInfo(layout.buildInfo) : null;
    const report = await (options.prerequisites ?? checkPrerequisites)({
      env,
      // Dev builds (and a checkout) may run the SDK's own claude; a release build never does.
      allowBundled: layout ? buildInfo?.channel === 'dev' : true,
    });
    log.info(
      {
        ok: report.ok,
        macos: report.macos,
        claude: report.claude ? { source: report.claude.source, version: report.claude.version } : null,
        loggedIn: report.loggedIn,
        problems: report.problems.map((p) => p.id),
        channel: buildInfo?.channel ?? (layout ? 'unknown' : 'checkout'),
      },
      'prerequisites',
    );
    if (!report.ok) {
      await channel.send({ t: 'error', ...describePrerequisites(report) });
      await channel.send({ t: 'exit', code: 1 });
      return 1;
    }

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
      mode: 'app',
      // AppPcs (appPcs.ts) owns the app's container engine, PcManager and linux-1 here. The runtime's own PC module
      // stays the null one, so one state directory never gets two PcManagers or two engine leases. When the real PC
      // module (pcs/module.ts) is wired into factories.ts, it must take AppPcs's manager and driver instead.
      runtime: { modules: { pc: createNullPcModule } },
      hooks: appHooks({
        layout,
        repoRoot,
        env: playEnv,
        log,
        progress,
        createPcs: options.pcs === undefined ? createAppPcs : options.pcs,
      }),
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
