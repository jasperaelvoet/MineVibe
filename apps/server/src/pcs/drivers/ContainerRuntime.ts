import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { devSupportDir, isInside, realpathLoose, tccProtectedReason } from '../../util/hostPaths.js';
import { EngineLeases } from './EngineLeases.js';
import { CliError, type ExecFn, type ExecResult, execWithTimeout, redact } from './exec.js';

/**
 * Apple `container` runtime management (PLAN §8.1 + §8.6): provisioning a private install root from the
 * verified signed pkg, a timeout-wrapped CLI, `system status` ownership checks, and `system start`/`stop`
 * that never touch an apiserver someone else owns. Processes sharing an app root hold engine leases in it
 * (N4): the engine is stopped on quit only when no other live MineVibe still uses it.
 */

/** The launchd label every `container` install shares (PLAN §8.1). */
export const APISERVER_LABEL = 'com.apple.container.apiserver';

export interface ContainerLock {
  version: string;
  pkg: { name: string; url: string; size?: number; sha256: string };
  signer?: string;
  teamId?: string;
  exclude?: string[];
  installRootFiles?: Record<string, string>;
}

/** Reads the `container` entry of `packaging/vendor.lock.json`. */
export async function readContainerLock(vendorLockPath: string): Promise<ContainerLock> {
  const json = JSON.parse(await readFile(vendorLockPath, 'utf8')) as { container?: ContainerLock };
  if (!json.container?.pkg?.sha256) throw new Error(`${vendorLockPath}: no container.pkg.sha256`);
  return json.container;
}

export interface ContainerRoots {
  appRoot: string;
  installRoot: string;
}

/**
 * The dev roots: `~/Library/Application Support/MineVibe-dev/{container,container-root}` (PLAN §8.6:
 * they must live outside `~/Documents` even though the repo and `MINEVIBE_HOME` are inside it).
 */
export function devContainerRoots(home = homedir()): ContainerRoots {
  const base = devSupportDir(home);
  return { appRoot: join(base, 'container'), installRoot: join(base, 'container-root') };
}

/**
 * Picks the roots: explicit env overrides (`MINEVIBE_CONTAINER_APP_ROOT`, `MINEVIBE_CONTAINER_INSTALL_ROOT`),
 * else the app layout (`<appSupport>/container`, `<bundle>/Contents/Runtime/container` from
 * `appBundleLayout().containerInstallRoot`) when neither is TCC-protected, else the dev roots.
 */
export function resolveContainerRoots(options: {
  appSupportContainer: string;
  bundleInstallRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}): ContainerRoots {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const dev = devContainerRoots(home);
  let appRoot = env.MINEVIBE_CONTAINER_APP_ROOT?.trim() || options.appSupportContainer;
  if (!env.MINEVIBE_CONTAINER_APP_ROOT && tccProtectedReason(appRoot, home)) appRoot = dev.appRoot;
  let installRoot =
    env.MINEVIBE_CONTAINER_INSTALL_ROOT?.trim() || options.bundleInstallRoot || dev.installRoot;
  if (!env.MINEVIBE_CONTAINER_INSTALL_ROOT && tccProtectedReason(installRoot, home)) {
    installRoot = dev.installRoot;
  }
  return { appRoot: resolve(appRoot), installRoot: resolve(installRoot) };
}

// Moved to util/hostPaths.ts (config/paths.ts needs them too); re-exported for existing importers.
export { isInside, realpathLoose, tccProtectedReason };

/** Normalizes a root reported by `system status` (realpath, no trailing slash) for comparison. */
export function normalizeRoot(p: string): string {
  let r = realpathLoose(p);
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

export type Ownership = 'not_running' | 'ours' | 'ours_stale_install' | 'foreign' | 'unknown';

export interface SystemStatus {
  ownership: Ownership;
  /** Raw `status` field ("running", …) when the JSON parsed. */
  state?: string;
  appRoot?: string;
  installRoot?: string;
  serverVersion?: string;
  clientVersion?: string;
  /** True when `system status` itself timed out (wedged apiserver or apple/container#2275). */
  timedOut?: boolean;
  detail?: string;
}

/**
 * Classifies a `system status --format json` answer against our roots (PLAN §8.1):
 * our app root + our install root = ours; our app root + another install root = ours but stale (the app
 * moved or updated: stop and restart); anything else = foreign (never stopped). With `expectVersion`,
 * an apiserver of ours that reports another server version is stale too (M5: it still runs a binary
 * from before the install root was replaced).
 */
export function classifyStatus(
  r: Pick<ExecResult, 'code' | 'stdout' | 'stderr' | 'timedOut'>,
  ours: ContainerRoots,
  expectVersion?: string,
): SystemStatus {
  if (r.timedOut) return { ownership: 'unknown', timedOut: true, detail: 'system status timed out' };
  const text = r.stdout.trim();
  let json: {
    status?: string;
    paths?: { appRoot?: string; installRoot?: string };
    server?: { version?: string };
    client?: { version?: string };
  } | null = null;
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (!json) {
    if (/not running|not registered|unregistered/.test(combined)) return { ownership: 'not_running' };
    return { ownership: 'unknown', detail: redact(combined.trim()).slice(0, 300) };
  }
  const state = json.status;
  const base: SystemStatus = {
    ownership: 'unknown',
    ...(state !== undefined ? { state } : {}),
    ...(json.paths?.appRoot ? { appRoot: json.paths.appRoot } : {}),
    ...(json.paths?.installRoot ? { installRoot: json.paths.installRoot } : {}),
    ...(json.server?.version ? { serverVersion: json.server.version } : {}),
    ...(json.client?.version ? { clientVersion: json.client.version } : {}),
  };
  if (state !== 'running' || !json.paths?.appRoot) return { ...base, ownership: 'not_running' };
  const appOurs = normalizeRoot(json.paths.appRoot) === normalizeRoot(ours.appRoot);
  const installOurs =
    !!json.paths.installRoot && normalizeRoot(json.paths.installRoot) === normalizeRoot(ours.installRoot);
  if (appOurs && installOurs) {
    if (expectVersion && base.serverVersion && base.serverVersion !== expectVersion) {
      return {
        ...base,
        ownership: 'ours_stale_install',
        detail: `apiserver ${base.serverVersion} != locked ${expectVersion}`,
      };
    }
    return { ...base, ownership: 'ours' };
  }
  if (appOurs) return { ...base, ownership: 'ours_stale_install' };
  return { ...base, ownership: 'foreign' };
}

/** Extracts `program = …` (or the first `arguments` entry) from `launchctl print` output. */
export function parseLaunchctlProgram(text: string): string | null {
  const m = /^\s*program = (.+)$/m.exec(text);
  if (m?.[1]) return m[1].trim();
  const a = /^\s*arguments = \{\s*\n\s*(\S.*)$/m.exec(text);
  return a?.[1]?.trim() ?? null;
}

export class EngineError extends Error {
  readonly code:
    | 'ENGINE_FOREIGN'
    | 'ENGINE_IN_USE'
    | 'ENGINE_TIMEOUT'
    | 'ENGINE_START_FAILED'
    | 'TCC_PROTECTED'
    | 'NOT_PROVISIONED';
  constructor(code: EngineError['code'], message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export interface ContainerRuntimeTimeouts {
  /** Default per-call timeout. */
  call: number;
  status: number;
  /** `system start --timeout <s>`; the Node timeout adds a margin. */
  startSeconds: number;
  stop: number;
  launchctl: number;
}

const DEFAULT_TIMEOUTS: ContainerRuntimeTimeouts = {
  call: 60_000,
  status: 15_000,
  startSeconds: 180,
  stop: 60_000,
  launchctl: 10_000,
};

export interface ContainerRuntimeOptions extends ContainerRoots {
  lock: ContainerLock;
  /** Where the downloaded pkg is cached (e.g. `<Caches>/vendor`). */
  cacheDir: string;
  /** A local copy of the pkg to use instead of downloading (still sha256-verified). */
  pkgPath?: string;
  logger?: Logger;
  exec?: ExecFn;
  timeouts?: Partial<ContainerRuntimeTimeouts>;
  uid?: number;
  /** `fetch` used for the pkg download (tests). */
  fetchImpl?: typeof fetch;
  /** Engine lease options (tests); the directory defaults to `<appRoot>/minevibe-leases`. */
  leases?: Partial<ConstructorParameters<typeof EngineLeases>[0]>;
  /** Who holds this process's lease (`minevibe-server`, `test:pcs`). */
  leaseHolder?: string;
  /**
   * The install root is read-only (MineVibe.app's `Contents/Runtime/container`): {@link ContainerRuntime.provision}
   * only checks it and never downloads, expands or replaces anything there.
   */
  readOnlyInstall?: boolean;
}

/** Hashes a file with sha256 (streaming). */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

export class ContainerRuntime {
  readonly appRoot: string;
  readonly installRoot: string;
  readonly lock: ContainerLock;
  readonly #cacheDir: string;
  readonly #pkgPath: string | undefined;
  readonly #log: Logger | undefined;
  readonly #exec: ExecFn;
  readonly #t: ContainerRuntimeTimeouts;
  readonly #uid: number;
  readonly #fetch: typeof fetch;
  readonly #readOnlyInstall: boolean;
  /** Set once we started the apiserver (or found it ours) in this process. */
  #startedByUs = false;
  /** This process's hold on the engine (N4). */
  readonly leases: EngineLeases;

  constructor(options: ContainerRuntimeOptions) {
    this.appRoot = resolve(options.appRoot);
    this.installRoot = resolve(options.installRoot);
    this.lock = options.lock;
    this.#cacheDir = options.cacheDir;
    this.#pkgPath = options.pkgPath;
    this.#log = options.logger;
    this.#exec = options.exec ?? execWithTimeout;
    this.#t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#uid = options.uid ?? process.getuid?.() ?? 501;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#readOnlyInstall = options.readOnlyInstall ?? false;
    this.leases = new EngineLeases({
      dir: join(this.appRoot, 'minevibe-leases'),
      exec: this.#exec,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.leaseHolder ? { holder: options.leaseHolder } : {}),
      ...options.leases,
    });
  }

  /** `<installRoot>/bin/container`. */
  get bin(): string {
    return join(this.installRoot, 'bin', 'container');
  }

  get roots(): ContainerRoots {
    return { appRoot: this.appRoot, installRoot: this.installRoot };
  }

  /** The env every CLI call gets (PLAN §8.1). */
  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CONTAINER_APP_ROOT: this.appRoot,
      CONTAINER_INSTALL_ROOT: this.installRoot,
      ...extra,
    };
  }

  /** Throws when either root sits in a TCC-protected folder (PLAN §8.6). */
  assertRootsUsable(home = homedir()): void {
    for (const [name, p] of [
      ['app root', this.appRoot],
      ['install root', this.installRoot],
    ] as const) {
      const why = tccProtectedReason(p, home);
      if (why) {
        throw new EngineError(
          'TCC_PROTECTED',
          `container ${name} ${p} is ${why}; root daemons cannot read it there (vmnet error 1001). ` +
            'Use ~/Library/Application Support/MineVibe-dev (dev) or move the app to /Applications.',
        );
      }
    }
  }

  /** Runs `container <args>` with the roots in env and a hard timeout. Never rejects. */
  exec(
    args: readonly string[],
    options: {
      timeoutMs?: number;
      env?: NodeJS.ProcessEnv;
      input?: string;
      onStderr?: (s: string) => void;
      onStdout?: (s: string) => void;
    } = {},
  ): Promise<ExecResult> {
    return this.#exec(this.bin, args, {
      timeoutMs: options.timeoutMs ?? this.#t.call,
      env: this.env(options.env),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
    });
  }

  /** Like {@link exec} but throws a redacted {@link CliError} on failure; returns stdout. */
  async execOk(
    args: readonly string[],
    options: Parameters<ContainerRuntime['exec']>[1] & { secrets?: string[] } = {},
  ): Promise<string> {
    const r = await this.exec(args, options);
    if (r.code !== 0 || r.timedOut) {
      throw new CliError(`container ${args.slice(0, 2).join(' ')}`, r, options.secrets ?? []);
    }
    return r.stdout;
  }

  // ---------------------------------------------------------------- provisioning

  /** True when the install root holds `bin/container` whose hash matches the lock. */
  async isProvisioned(): Promise<boolean> {
    if (!existsSync(this.bin)) return false;
    const want = this.lock.installRootFiles?.['bin/container'];
    if (!want) return true;
    return (await sha256File(this.bin)) === want;
  }

  /**
   * Creates the install root from the signed pkg: obtain (local copy or download into the cache),
   * verify size + sha256, check the Apple signature, `pkgutil --expand-full`, verify every file against
   * the lock, drop the excluded scripts, and move the payload into place atomically. Idempotent.
   */
  async provision(onProgress?: (msg: string) => void): Promise<void> {
    this.assertRootsUsable();
    if (await this.isProvisioned()) return;
    if (this.#readOnlyInstall) {
      // Inside MineVibe.app the install root is part of the signed bundle: never write there (PLAN §9.1).
      throw new EngineError(
        'NOT_PROVISIONED',
        `the bundled container install at ${this.installRoot} is missing or modified; reinstall MineVibe`,
      );
    }
    const pkg = await this.#obtainPkg(onProgress);
    if (this.lock.signer) {
      const sig = await this.#exec('/usr/sbin/pkgutil', ['--check-signature', pkg], { timeoutMs: 60_000 });
      if (sig.code !== 0 || !sig.stdout.includes(this.lock.signer)) {
        throw new Error(`container pkg signature check failed (want "${this.lock.signer}")`);
      }
    }
    onProgress?.('expanding container pkg');
    await mkdir(dirname(this.installRoot), { recursive: true });
    const work = await mkdtemp(join(dirname(this.installRoot), '.container-expand-'));
    try {
      const expanded = join(work, 'pkg');
      const ex = await this.#exec('/usr/sbin/pkgutil', ['--expand-full', pkg, expanded], {
        timeoutMs: 300_000,
      });
      if (ex.code !== 0) throw new CliError('pkgutil --expand-full', ex);
      const payload = await findPayload(expanded);
      if (!payload) throw new Error('container pkg: no Payload/bin/container inside');
      // Entries may be folders (a whole plugin MineVibe does not ship, such as k8s).
      for (const rel of this.lock.exclude ?? [])
        await rm(join(payload, rel), { recursive: true, force: true });
      for (const [rel, want] of Object.entries(this.lock.installRootFiles ?? {})) {
        const got = await sha256File(join(payload, rel)).catch(() => 'missing');
        if (got !== want) throw new Error(`container pkg: ${rel} sha256 ${got} != lock ${want}`);
      }
      // M5: never pull the install root out from under a running apiserver of ours, and (N4) never
      // stop it while another live MineVibe still uses it.
      if (existsSync(this.installRoot)) {
        const others = await this.leases.others();
        if (others.length > 0) {
          throw new EngineError(
            'ENGINE_IN_USE',
            `the container install at ${this.installRoot} must be updated, but another MineVibe (pid ${others.map((o) => o.pid).join(', ')}) still uses it; quit it first`,
          );
        }
        const stopped = await this.stopIfOurs();
        if (stopped) onProgress?.('stopped the container system running from the old install root');
      }
      await rm(this.installRoot, { recursive: true, force: true });
      await rename(payload, this.installRoot);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    onProgress?.(`container ${this.lock.version} installed at ${this.installRoot}`);
  }

  async #obtainPkg(onProgress?: (msg: string) => void): Promise<string> {
    const { sha256, url, name, size } = this.lock.pkg;
    const candidates = [this.#pkgPath, join(this.#cacheDir, name)].filter((p): p is string => !!p);
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      if (size !== undefined && (await stat(p)).size !== size) continue;
      if ((await sha256File(p)) === sha256) return p;
      this.#log?.warn({ path: p }, 'container pkg sha256 mismatch; ignoring');
    }
    onProgress?.(`downloading ${name}`);
    await mkdir(this.#cacheDir, { recursive: true });
    const dest = join(this.#cacheDir, name);
    const tmp = `${dest}.part`;
    const res = await this.#fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      createWriteStream(tmp),
    );
    const got = await sha256File(tmp);
    if (got !== sha256) {
      await rm(tmp, { force: true });
      throw new Error(`container pkg sha256 ${got} != lock ${sha256}`);
    }
    await rename(tmp, dest);
    await chmod(dest, 0o644);
    return dest;
  }

  // ---------------------------------------------------------------- status / start / stop

  /** `system status --format json`, classified against our roots. */
  async status(): Promise<SystemStatus> {
    if (!existsSync(this.bin)) {
      // Without our binary we can still detect a registered apiserver through launchd.
      const prog = await this.apiserverProgram();
      if (!prog) return { ownership: 'not_running' };
      return {
        ownership: isInside(normalizeRoot(prog), normalizeRoot(this.installRoot)) ? 'ours' : 'foreign',
        detail: 'from launchctl',
      };
    }
    const r = await this.exec(['system', 'status', '--format', 'json'], { timeoutMs: this.#t.status });
    return classifyStatus(r, this.roots, this.lock.version);
  }

  /** The `program` of the registered apiserver launchd job (null when none is registered). */
  async apiserverProgram(label = APISERVER_LABEL): Promise<string | null> {
    const r = await this.#exec('/bin/launchctl', ['print', `gui/${this.#uid}/${label}`], {
      timeoutMs: this.#t.launchctl,
    });
    if (r.code !== 0) return null;
    return parseLaunchctlProgram(r.stdout);
  }

  /**
   * Starts the apiserver from our roots (`--app-root`, `--install-root`, `--enable-kernel-install`).
   * Ours and current: no-op. Ours but stale install root: stop, then start. Foreign: throws
   * ENGINE_FOREIGN and never touches it. A status/start timeout maps to ENGINE_TIMEOUT (engine_down).
   */
  async ensureStarted(onProgress?: (msg: string) => void): Promise<SystemStatus> {
    this.assertRootsUsable();
    if (!(await this.isProvisioned())) {
      throw new EngineError('NOT_PROVISIONED', `container is not installed at ${this.installRoot}`);
    }
    let st = await this.status();
    if (st.ownership === 'ours') {
      this.#startedByUs = true;
      return st;
    }
    if (st.ownership === 'foreign') {
      throw new EngineError(
        'ENGINE_FOREIGN',
        `another container install is running (app root ${st.appRoot ?? '?'}); MineVibe will not stop it`,
      );
    }
    if (st.ownership === 'unknown') {
      // A wedged apiserver: only recover it when launchd says the program is ours.
      const prog = await this.apiserverProgram();
      if (prog && !isInside(normalizeRoot(prog), normalizeRoot(this.installRoot))) {
        throw new EngineError('ENGINE_FOREIGN', `another container apiserver is registered (${prog})`);
      }
      if (prog) await this.bootoutOurs();
      else if (st.timedOut) throw new EngineError('ENGINE_TIMEOUT', 'container system status timed out');
    }
    if (st.ownership === 'not_running') {
      // L9: the launchd label is shared. A registered job whose program is not ours means another
      // install owns it, even when `system status` says it is not running: never replace it.
      const prog = await this.apiserverProgram();
      if (prog && !isInside(normalizeRoot(prog), normalizeRoot(this.installRoot))) {
        throw new EngineError('ENGINE_FOREIGN', `another container apiserver is registered (${prog})`);
      }
    }
    if (st.ownership === 'ours_stale_install') {
      onProgress?.(
        `restarting container system from the current install root${st.detail ? ` (${st.detail})` : ''}`,
      );
      await this.#stopOurs();
    }
    onProgress?.('starting container system');
    await mkdir(this.appRoot, { recursive: true });
    const s = this.#t.startSeconds;
    const r = await this.exec(
      [
        'system',
        'start',
        '--app-root',
        this.appRoot,
        '--install-root',
        this.installRoot,
        '--enable-kernel-install',
        '--timeout',
        String(s),
      ],
      { timeoutMs: (s + 60) * 1000, onStdout: (d) => onProgress?.(d.trim()) },
    );
    if (r.timedOut) {
      throw new EngineError('ENGINE_TIMEOUT', `container system start timed out after ${r.ms} ms`);
    }
    if (r.code !== 0) {
      throw new EngineError('ENGINE_START_FAILED', new CliError('container system start', r).message);
    }
    st = await this.status();
    if (st.ownership !== 'ours') {
      throw new EngineError('ENGINE_START_FAILED', `container system start: status is ${st.ownership}`);
    }
    this.#startedByUs = true;
    return st;
  }

  /** Whether this process started (or adopted) our apiserver. */
  get startedByUs(): boolean {
    return this.#startedByUs;
  }

  /**
   * Takes this process's engine lease and makes sure our apiserver runs (N4), under the engine lock so a
   * concurrent quit of another MineVibe cannot stop the engine in between.
   */
  startAndLease(onProgress?: (msg: string) => void): Promise<SystemStatus> {
    return this.leases.withLock(async () => {
      await this.leases.acquire();
      return this.ensureStarted(onProgress);
    });
  }

  /**
   * Drops this process's lease and stops our apiserver only when no other live MineVibe holds a lease on
   * this app root (N4). Returns whether it stopped the engine.
   */
  releaseAndStopIfUnused(): Promise<boolean> {
    return this.leases.withLock(async () => {
      await this.leases.release();
      const others = await this.leases.others();
      if (others.length > 0) {
        this.#log?.info(
          { others: others.map((o) => ({ pid: o.pid, holder: o.holder })) },
          'another MineVibe still uses the container system; leaving it running',
        );
        return false;
      }
      return this.stopIfOurs();
    });
  }

  /**
   * Stops the apiserver only when `system status` proves it is ours (PLAN §8.1). Returns whether it
   * stopped something. Falls back to `launchctl bootout` of our own labels when `system stop` hangs.
   */
  async stopIfOurs(): Promise<boolean> {
    if (!existsSync(this.bin)) {
      // No CLI to ask (mid-provision): launchd tells whether the job runs from our install root.
      const prog = await this.apiserverProgram();
      if (prog && isInside(normalizeRoot(prog), normalizeRoot(this.installRoot))) {
        await this.bootoutOurs();
        this.#startedByUs = false;
        return true;
      }
      return false;
    }
    const st = await this.status();
    if (st.ownership === 'ours' || st.ownership === 'ours_stale_install') {
      await this.#stopOurs();
      this.#startedByUs = false;
      return true;
    }
    if (st.ownership === 'unknown') {
      const prog = await this.apiserverProgram();
      if (prog && isInside(normalizeRoot(prog), normalizeRoot(this.installRoot))) {
        await this.bootoutOurs();
        return true;
      }
    }
    return false;
  }

  async #stopOurs(): Promise<void> {
    const r = await this.exec(['system', 'stop'], { timeoutMs: this.#t.stop });
    if (r.code === 0 && !r.timedOut) return;
    this.#log?.warn(
      { timedOut: r.timedOut, code: r.code },
      'container system stop failed; booting out our labels',
    );
    await this.bootoutOurs();
  }

  /**
   * `launchctl bootout` every `com.apple.container.*` job whose program lives under our install root.
   * A job whose program is elsewhere is never touched.
   */
  async bootoutOurs(): Promise<string[]> {
    const list = await this.#exec('/bin/launchctl', ['list'], { timeoutMs: this.#t.launchctl });
    const labels = list.stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[2])
      .filter((l): l is string => !!l && l.startsWith('com.apple.container.'));
    const booted: string[] = [];
    const ourRoot = normalizeRoot(this.installRoot);
    for (const label of labels) {
      const prog = await this.apiserverProgram(label);
      if (!prog || !isInside(normalizeRoot(prog), ourRoot)) continue;
      const r = await this.#exec('/bin/launchctl', ['bootout', `gui/${this.#uid}/${label}`], {
        timeoutMs: this.#t.launchctl,
      });
      if (r.code === 0) booted.push(label);
    }
    return booted;
  }
}

async function findPayload(expanded: string): Promise<string | null> {
  const direct = join(expanded, 'Payload');
  if (existsSync(join(direct, 'bin', 'container'))) return direct;
  for (const entry of await readdir(expanded)) {
    const p = join(expanded, entry, 'Payload');
    if (existsSync(join(p, 'bin', 'container'))) return p;
  }
  return null;
}
