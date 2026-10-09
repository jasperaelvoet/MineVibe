import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, openSync, readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../../util/atomicFile.js';
import { devSupportDir, tccProtectedReason } from '../../util/hostPaths.js';
import { freeLoopbackPort } from '../host.js';
import { sha256File } from './ContainerRuntime.js';
import { EngineLeases } from './EngineLeases.js';
import { type ExecFn, execWithTimeout } from './exec.js';

/**
 * MineVibe's own Lume (PLAN §8.1, §8.7, spike S6): the notarized `lume.app`, provisioned for dev from the pinned release
 * (sha256, every file of the app, `codesign` and `spctl`; never re-signed) or run from MineVibe.app as it is, plus the
 * pinned ripgrep for macOS guests; and `lume serve` as MineVibe's child on a random loopback port, with its config,
 * caches, temp files and VM storage under MineVibe's Lume root and telemetry off.
 *
 * - **Shared by leases.** Processes that use one Lume root (a dev server and `npm run test:pcs`) share one serve, the
 *   way they share the `container` engine: each holds a lease (EngineLeases) in `<root>/minevibe-leases`; quitting drops
 *   it and stops the serve only when no other live lease remains. Starting and stopping run under the same lock.
 * - **Lifeline.** The serve runs under a small `sh` supervisor in its own process group (so a terminal Ctrl+C reaches
 *   only MineVibe, which stops its VMs gracefully first). The supervisor stops the serve, and with it every VM it runs,
 *   once no lease file has named a live process for about 10 s: VMs never outlive the MineVibe processes that use them,
 *   even after a `kill -9`.
 * - **Owners and the reaper.** Every start records its process (pid and start time) as the VM's owner in its sidecar.
 *   Under the lock, a process joining the serve (and every PcManager monitor about once a minute) claims its own
 *   instance's VMs and stops every other running MineVibe VM whose owner died, so a crashed process's VMs never live on
 *   in a serve that another MineVibe keeps running. A VM without an owner (made before owners) is stopped only when no
 *   other live lease exists.
 * - **A busy serve is not a dead one.** `GET` once took minutes after a guest shutdown (S6), so a serve whose process
 *   runs is never taken for gone because it answers slowly: joining waits for it, and it is replaced only when it stays
 *   silent and no other MineVibe uses it (its VMs would die with it).
 * - **The serve log is the truth** (S6): `GET` keeps saying `running` after a guest-side shutdown and never says why a
 *   start failed, so the serve writes to `<root>/serve/serve.log` (a file: a pipe Node stops draining blocks the serve)
 *   and this class reads the `VM lifecycle ended` and `Failed in VM.run` lines from it.
 * - Every API call has a deadline; the serve binds 127.0.0.1 only (measured).
 */

/** The `lume` entry of `packaging/vendor.lock.json`. */
export interface LumeLock {
  version: string;
  url: string;
  size: number;
  sha256: string;
  teamId: string;
  signer?: string;
  notarized?: boolean;
  /** Every file of `lume.app` (relative to the bundle) with its sha256. */
  appFiles: Record<string, string>;
}

/** The `ripgrep` entry: a static darwin-arm64 `rg`, installed into macOS guests. */
export interface RipgrepLock {
  version: string;
  url: string;
  size: number;
  sha256: string;
  /** The binary's path inside the archive. */
  extract: string;
  binarySha256: string;
}

/** `images.cua-macos`: the macOS image, by tag and manifest digest. */
export interface MacImageLock {
  ref: string;
  /** What `lume pull` takes (`macos:26-…`; registry ghcr.io, organization trycua). */
  lumeRef: string;
  digest: string;
  downloadBytes: number;
  diskBytes: number;
}

export interface LumeLocks {
  lume: LumeLock;
  ripgrep?: RipgrepLock;
  image: MacImageLock;
}

const SHA = /^[0-9a-f]{64}$/;

/** Reads the Lume pins from the first readable `vendor.lock.json` among `candidates` (null when none has them). */
export function loadLumeLocks(candidates: readonly string[]): LumeLocks | null {
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as {
        lume?: LumeLock;
        ripgrep?: RipgrepLock;
        images?: { 'cua-macos'?: MacImageLock };
      };
      const lume = json.lume;
      const image = json.images?.['cua-macos'];
      if (!lume || !SHA.test(lume.sha256 ?? '') || !lume.appFiles?.['Contents/MacOS/lume']) continue;
      if (!image || !/^sha256:[0-9a-f]{64}$/.test(image.digest ?? '') || !image.lumeRef) continue;
      const rg = json.ripgrep && SHA.test(json.ripgrep.sha256) ? json.ripgrep : undefined;
      return { lume, image, ...(rg ? { ripgrep: rg } : {}) };
    } catch {
      // try the next one
    }
  }
  return null;
}

/** `~/Library/Application Support/MineVibe-dev/lume`: outside `~/Documents` like the container roots (PLAN §8.6). */
export function devLumeRoot(home = homedir()): string {
  return join(devSupportDir(home), 'lume');
}

/** The storage location every MineVibe VM lives in (`vmLocations` of MineVibe's Lume config). */
export const LUME_STORAGE = 'minevibe';

/** MineVibe's labels next to a VM it made (`<vms>/<vm>/minevibe.json`): Lume has no labels of its own. */
export const VM_SIDECAR = 'minevibe.json';

/** What a VM's sidecar holds. */
export interface VmSidecar {
  labels?: Record<string, string>;
  createdAt?: number;
  /** The process that started (or adopted) the VM last: the reaper stops a running VM whose owner died. */
  owner?: { pid: number; started: string | null; at?: number };
}

/** The serve log line of a VM that stopped (guest shutdown, crash or stop). */
const ENDED_RE = /^\[([0-9T:.-]+Z)\] INFO: VM lifecycle ended\b(.*)$/;
/** The serve log line of a start that failed (Apple's VM limit among others). */
const FAILED_RE = /^\[([0-9T:.-]+Z)\] ERROR: Failed in VM\.run\b(.*)$/;
/** The message Virtualization gives when the host already runs two macOS VMs. */
export const VM_LIMIT_RE =
  /number of virtual machines exceeds the limit|maximum supported number of active virtual machines/i;

/** `key=value` fields of a Lume log line (values run until the next ` key=`). */
export function logFields(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
  const hits: { key: string; start: number; end: number }[] = [];
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    hits.push({ key: m[1] as string, start: m.index, end: m.index + m[0].length });
  }
  hits.forEach((h, i) => {
    const next = hits[i + 1];
    out[h.key] = rest.slice(h.end, next ? next.start : rest.length).trim();
  });
  return out;
}

export interface LumeLogEvents {
  /** When each VM was last logged as ended (epoch ms). */
  ended: Map<string, number>;
  /** The last start failure of each VM. */
  failed: Map<string, { at: number; message: string }>;
}

/** Parses serve log text (lines split on `\n` and `\r`: pulls draw progress bars) into the events that matter. */
export function parseLumeLog(
  text: string,
  into: LumeLogEvents = { ended: new Map(), failed: new Map() },
): LumeLogEvents {
  for (const line of text.split(/[\r\n]+/)) {
    if (line.length > 4000) continue;
    const e = ENDED_RE.exec(line);
    if (e) {
      const name = logFields(e[2] as string).name;
      const at = Date.parse(e[1] as string);
      if (name && Number.isFinite(at)) into.ended.set(name, at);
      continue;
    }
    const f = FAILED_RE.exec(line);
    if (f) {
      const fields = logFields(f[2] as string);
      const at = Date.parse(f[1] as string);
      if (fields.name && Number.isFinite(at)) {
        into.failed.set(fields.name, { at, message: (fields.error ?? 'the VM did not start').slice(0, 300) });
      }
    }
  }
  return into;
}

export class LumeError extends Error {
  readonly code: 'NOT_PROVISIONED' | 'VERIFY_FAILED' | 'SERVE_FAILED' | 'API' | 'TCC_PROTECTED';
  readonly status?: number;
  constructor(code: LumeError['code'], message: string, status?: number) {
    super(message);
    this.name = 'LumeError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface LumeApiResult {
  status: number;
  body: unknown;
}

/** What `<root>/serve/serve.json` records about the running serve. */
interface ServeRecord {
  /** The serve's supervisor: the leader of the process group the serve runs in. */
  pid: number;
  /** `ps -o lstart=` of the pid. */
  started: string | null;
  port: number;
  bin: string;
  at: number;
}

export interface LumeRuntimeTimeouts {
  /** Default deadline of one API call. */
  api: number;
  /** One "is this our serve" probe (`GET /lume/config/locations`). */
  answer: number;
  /** Until a fresh serve answers, and how long a joining process waits for a running one that is slow. */
  serveStart: number;
  /** SIGTERM → exit before SIGKILL. */
  serveStop: number;
  /** One VM stop during the reaper. */
  reapStop: number;
}

const DEFAULT_TIMEOUTS: LumeRuntimeTimeouts = {
  api: 15_000,
  answer: 5_000,
  serveStart: 20_000,
  serveStop: 10_000,
  reapStop: 60_000,
};

export interface LumeRuntimeOptions {
  /** MineVibe's Lume root (`install/`, `config/`, `vms/`, `shares/`, `serve/`, `tools/`). */
  root: string;
  locks: LumeLocks;
  /** Where downloaded archives are cached. */
  cacheDir: string;
  /** A notarized `lume.app` to run as it is (MineVibe.app): never provisioned, still verified. */
  bundledApp?: string;
  logger?: Logger;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  /** Who holds this process's lease (`minevibe-server dev`, `test:pcs`). */
  leaseHolder?: string;
  leases?: Partial<ConstructorParameters<typeof EngineLeases>[0]>;
  timeouts?: Partial<LumeRuntimeTimeouts>;
  /**
   * Starts the serve and returns the pid to record (tests); default: {@link spawnSupervisedServe}. `leaseDir` holds the
   * lease files.
   */
  spawnServe?: (
    bin: string,
    port: number,
    env: NodeJS.ProcessEnv,
    logPath: string,
    leaseDir: string,
  ) => Promise<number>;
  /** Talks to a serve already listening on this loopback port (tests): no lease and no serve lifecycle. */
  attachPort?: number;
}

export class LumeRuntime {
  readonly root: string;
  readonly locks: LumeLocks;
  readonly leases: EngineLeases;
  readonly #cacheDir: string;
  readonly #bundledApp: string | undefined;
  readonly #log: Logger | undefined;
  readonly #exec: ExecFn;
  readonly #fetch: typeof fetch;
  readonly #t: LumeRuntimeTimeouts;
  readonly #spawnServe: NonNullable<LumeRuntimeOptions['spawnServe']>;
  #port: number | null = null;
  /** The installed app passed the signature checks in this process. */
  #verified = false;
  #logOffset = 0;
  #events: LumeLogEvents = { ended: new Map(), failed: new Map() };

  constructor(options: LumeRuntimeOptions) {
    this.root = resolve(options.root);
    this.locks = options.locks;
    this.#cacheDir = options.cacheDir;
    this.#bundledApp = options.bundledApp;
    this.#log = options.logger;
    this.#exec = options.exec ?? execWithTimeout;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.#spawnServe = options.spawnServe ?? spawnSupervisedServe;
    if (options.attachPort !== undefined) this.#port = options.attachPort;
    this.leases = new EngineLeases({
      dir: join(this.root, 'minevibe-leases'),
      exec: this.#exec,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.leaseHolder ? { holder: options.leaseHolder } : {}),
      ...options.leases,
    });
  }

  // ---------------------------------------------------------------- layout

  /** The `lume.app` that runs: the bundle's, else the provisioned one. */
  get appPath(): string {
    return this.#bundledApp ?? join(this.root, 'install', this.locks.lume.version, 'lume.app');
  }

  get bin(): string {
    return join(this.appPath, 'Contents', 'MacOS', 'lume');
  }

  /** The VM storage location ({@link LUME_STORAGE}). */
  get vmsDir(): string {
    return join(this.root, 'vms');
  }

  /** Per-VM share folders (`<vm>/setup`, `<vm>/links/<share>`). */
  get sharesDir(): string {
    return join(this.root, 'shares');
  }

  /** The pinned ripgrep binary, once provisioned. */
  get ripgrepPath(): string | null {
    const rg = this.locks.ripgrep;
    return rg ? join(this.root, 'tools', `ripgrep-${rg.version}`, 'rg') : null;
  }

  get logPath(): string {
    return join(this.root, 'serve', 'serve.log');
  }

  get #servePath(): string {
    return join(this.root, 'serve', 'serve.json');
  }

  /** The serve's loopback port while this process uses it. */
  get port(): number | null {
    return this.#port;
  }

  /** The environment of every Lume process: telemetry off, config/cache/temp under the root (PLAN §8.5). */
  env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: process.env.HOME ?? homedir(),
      LANG: 'en_US.UTF-8',
      LUME_TELEMETRY_ENABLED: '0',
      LUME_UPDATE_CHECK: '0',
      DO_NOT_TRACK: '1',
      XDG_CONFIG_HOME: join(this.root, 'config'),
      XDG_CACHE_HOME: join(this.root, 'xdg-cache'),
      TMPDIR: `${join(this.root, 'tmp')}/`,
      // Lume's log lines reach the file at once (a crash or failed start shows up when it happens).
      NSUnbufferedIO: 'YES',
    };
  }

  /** Throws when the root sits in a TCC-protected folder (PLAN §8.6: keep it under Application Support). */
  assertRootUsable(home = homedir()): void {
    const why = tccProtectedReason(this.root, home);
    if (why) {
      throw new LumeError(
        'TCC_PROTECTED',
        `the Lume root ${this.root} is ${why}; keep it under ~/Library/Application Support (MineVibe-dev in dev)`,
      );
    }
  }

  // ---------------------------------------------------------------- provisioning

  /** True when the app's binary matches the lock (a quick check; {@link verifyApp} checks everything). */
  async isProvisioned(): Promise<boolean> {
    if (!existsSync(this.bin)) return false;
    return (await sha256File(this.bin)) === this.locks.lume.appFiles['Contents/MacOS/lume'];
  }

  /**
   * Checks a `lume.app` against the lock: every listed file's sha256 and nothing else, a valid signature by the pinned
   * team (`codesign --verify --deep --strict`), and Gatekeeper's verdict (`spctl`: Notarized Developer ID). Throws
   * VERIFY_FAILED.
   */
  async verifyApp(app: string): Promise<void> {
    const fail = (m: string) => {
      throw new LumeError('VERIFY_FAILED', `lume.app at ${app}: ${m}`);
    };
    const want = this.locks.lume.appFiles;
    const have = await listFiles(app);
    for (const [rel, sha] of Object.entries(want)) {
      const got = have.has(rel) ? await sha256File(join(app, rel)) : 'missing';
      if (got !== sha) fail(`${rel} sha256 ${got} != lock ${sha}`);
    }
    for (const rel of have) if (!(rel in want)) fail(`unexpected file ${rel}`);
    const v = await this.#exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {
      timeoutMs: 60_000,
    });
    if (v.code !== 0) fail(`codesign --verify failed: ${(v.stderr || v.stdout).trim().slice(0, 300)}`);
    const d = await this.#exec('/usr/bin/codesign', ['-dv', '--verbose=2', app], { timeoutMs: 30_000 });
    const team = /^TeamIdentifier=(\S+)/m.exec(`${d.stderr}\n${d.stdout}`)?.[1];
    if (team !== this.locks.lume.teamId)
      fail(`signed by team ${team ?? 'none'}, the lock pins ${this.locks.lume.teamId}`);
    if (this.locks.lume.notarized) {
      const s = await this.#exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app], {
        timeoutMs: 60_000,
      });
      const out = `${s.stdout}\n${s.stderr}`;
      if (s.code !== 0 || !/accepted/.test(out) || !/Notarized Developer ID/.test(out)) {
        fail(`Gatekeeper does not accept it as notarized: ${out.trim().slice(0, 300)}`);
      }
    }
  }

  /**
   * Makes sure the pinned `lume.app` is installed and verified (once per process). Dev provisions it from the release:
   * download (cached, size + sha256), extract into a temp folder next to the install, verify, then move it into place.
   * A bundled app is only verified. Idempotent.
   */
  async provision(onProgress?: (m: string) => void): Promise<void> {
    this.assertRootUsable();
    if (await this.isProvisioned()) {
      if (!this.#verified) {
        await this.verifyApp(this.appPath);
        this.#verified = true;
      }
      return;
    }
    if (this.#bundledApp) {
      throw new LumeError(
        'NOT_PROVISIONED',
        `the bundled lume.app at ${this.#bundledApp} is missing or modified; reinstall MineVibe`,
      );
    }
    const { url, sha256, size, version } = this.locks.lume;
    onProgress?.(`downloading Lume ${version}`);
    const archive = await this.#download(url, sha256, size);
    const installDir = dirname(this.appPath);
    await mkdir(dirname(installDir), { recursive: true });
    const work = await mkdtemp(join(dirname(installDir), '.lume-extract-'));
    try {
      const x = await this.#exec('/usr/bin/tar', ['-xzf', archive, '-C', work, 'lume.app'], {
        timeoutMs: 120_000,
      });
      if (x.code !== 0)
        throw new LumeError('VERIFY_FAILED', `extracting ${archive} failed: ${x.stderr.trim()}`);
      await this.verifyApp(join(work, 'lume.app'));
      await rm(installDir, { recursive: true, force: true });
      await mkdir(installDir, { recursive: true });
      await rename(join(work, 'lume.app'), this.appPath);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    this.#verified = true;
    onProgress?.(`Lume ${version} installed at ${this.appPath}`);
  }

  /** The pinned ripgrep for macOS guests (`tools/ripgrep-<v>/rg`), verified by sha256. Null when none is pinned. */
  async provisionRipgrep(onProgress?: (m: string) => void): Promise<string | null> {
    const rg = this.locks.ripgrep;
    const dest = this.ripgrepPath;
    if (!rg || !dest) return null;
    if (existsSync(dest) && (await sha256File(dest)) === rg.binarySha256) return dest;
    onProgress?.(`downloading ripgrep ${rg.version}`);
    const archive = await this.#download(rg.url, rg.sha256, rg.size);
    await mkdir(dirname(dest), { recursive: true });
    const work = await mkdtemp(join(dirname(dest), '.rg-extract-'));
    try {
      const x = await this.#exec('/usr/bin/tar', ['-xzf', archive, '-C', work, rg.extract], {
        timeoutMs: 60_000,
      });
      if (x.code !== 0) throw new LumeError('VERIFY_FAILED', `extracting ripgrep failed: ${x.stderr.trim()}`);
      const bin = join(work, rg.extract);
      const got = await sha256File(bin);
      if (got !== rg.binarySha256)
        throw new LumeError('VERIFY_FAILED', `rg sha256 ${got} != lock ${rg.binarySha256}`);
      await chmod(bin, 0o755);
      await rename(bin, dest);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return dest;
  }

  /** Downloads `url` into the cache (reusing a verified copy); throws on a size or sha256 mismatch. */
  async #download(url: string, sha256: string, size: number): Promise<string> {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'download');
    const dir = join(this.#cacheDir, sha256);
    const dest = join(dir, name);
    if (existsSync(dest) && (await stat(dest)).size === size && (await sha256File(dest)) === sha256)
      return dest;
    await mkdir(dir, { recursive: true });
    const tmp = `${dest}.part`;
    const res = await this.#fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) throw new LumeError('NOT_PROVISIONED', `download ${url}: HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      createWriteStream(tmp),
    );
    const got = await sha256File(tmp);
    const bytes = (await stat(tmp)).size;
    if (got !== sha256 || bytes !== size) {
      await rm(tmp, { force: true });
      throw new LumeError(
        'VERIFY_FAILED',
        `${name}: sha256 ${got} (${bytes} B) != lock ${sha256} (${size} B)`,
      );
    }
    await rename(tmp, dest);
    return dest;
  }

  /** MineVibe's Lume config: one storage location under the root, caching and telemetry off. */
  async writeConfig(): Promise<void> {
    for (const d of ['config/lume', 'vms', 'tmp', 'cache', 'xdg-cache', 'shares', 'serve']) {
      await mkdir(join(this.root, d), { recursive: true });
    }
    await chmod(this.sharesDir, 0o700);
    const q = (s: string) => JSON.stringify(s);
    await writeFileAtomic(
      join(this.root, 'config', 'lume', 'config.yaml'),
      [
        '# Written by MineVibe (PLAN §8.7): its own Lume, separate from any Lume of the user.',
        '',
        `defaultLocationName: ${q(LUME_STORAGE)}`,
        `cacheDirectory: ${q(join(this.root, 'cache'))}`,
        'cachingEnabled: false',
        'telemetryEnabled: false',
        '',
        'vmLocations:',
        `  - name: ${q(LUME_STORAGE)}`,
        `    path: ${q(this.vmsDir)}`,
        '',
      ].join('\n'),
      { mode: 0o644 },
    );
  }

  // ---------------------------------------------------------------- serve

  /**
   * Takes this process's lease and makes sure a serve of this root runs, under the lock (so a quitting process cannot
   * stop it in between). Then the reaper: the VMs `keep` names (the caller's own instance) are claimed for this process,
   * and every other running MineVibe VM whose owner died is stopped ({@link reapOrphans}).
   */
  startAndLease(
    options: { keep?: (vm: string) => boolean; onProgress?: (m: string) => void } = {},
  ): Promise<void> {
    return this.leases.withLock(async () => {
      await this.leases.acquire();
      await this.#ensureServe(options.onProgress);
      await this.#reap(options.keep ?? (() => false));
    });
  }

  /**
   * The reaper on its own (PcManager's monitor runs it about once a minute): claims the VMs `keep` names and stops every
   * other running MineVibe VM whose owner process died. Returns the VMs it stopped. Only while this process holds the
   * serve.
   */
  reapOrphans(keep: (vm: string) => boolean): Promise<string[]> {
    if (this.#port === null) return Promise.resolve([]);
    return this.leases.withLock(() => this.#reap(keep));
  }

  /** Drops this process's lease and stops the serve only when no other live MineVibe holds one. */
  releaseAndStopIfUnused(): Promise<boolean> {
    return this.leases.withLock(async () => {
      await this.leases.release();
      const others = await this.leases.others();
      this.#port = null;
      if (others.length > 0) {
        this.#log?.info(
          { others: others.map((o) => ({ pid: o.pid, holder: o.holder })) },
          'another MineVibe still uses lume serve; leaving it running',
        );
        return false;
      }
      return this.#stopServe();
    });
  }

  /**
   * Whether the serve this process uses still runs (its process; answering slowly does not make it dead, S6). True
   * while `ps` cannot tell: a serve is never given up on a guess, its VMs would be taken for crashed.
   */
  async serveRunning(): Promise<boolean> {
    const rec = await this.#readServe();
    return !!rec && rec.port === this.#port && (await this.#serveState(rec)) !== 'gone';
  }

  /**
   * Whether a serve of this root runs now, whoever started it (no lease taken): only then can a MineVibe VM be running
   * (VMs die with their serve).
   */
  async serveExists(): Promise<boolean> {
    const rec = await this.#readServe();
    return !!rec && (await this.#serveState(rec)) !== 'gone';
  }

  async #readServe(): Promise<ServeRecord | null> {
    try {
      const r = JSON.parse(await readFile(this.#servePath, 'utf8')) as ServeRecord;
      return Number.isInteger(r.pid) && Number.isInteger(r.port) ? r : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the recorded serve is the one still running: `ours` (same pid, start time and binary), `gone` (no such
   * process, or another one under a reused pid), or `unknown` (`ps` did not answer). Only `ours` may be signalled.
   */
  async #serveState(rec: ServeRecord): Promise<'ours' | 'gone' | 'unknown'> {
    try {
      process.kill(rec.pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    }
    const started = await this.leases.processStart(rec.pid);
    if (started === 'gone') return 'gone';
    if (started === null) return 'unknown';
    if (rec.started && started !== rec.started) return 'gone';
    const cmd = await this.#exec('/bin/ps', ['-o', 'command=', '-p', String(rec.pid)], { timeoutMs: 5000 });
    if (cmd.timedOut || cmd.error) return 'unknown';
    if (cmd.code !== 0) return cmd.stdout.trim() ? 'unknown' : 'gone';
    return cmd.stdout.includes(rec.bin) ? 'ours' : 'gone';
  }

  async #answers(port: number): Promise<boolean> {
    try {
      const r = await this.#apiOn(port, 'GET', '/lume/config/locations', undefined, this.#t.answer);
      if (r.status !== 200 || !Array.isArray(r.body)) return false;
      // The serve must be ours: its storage location points into this root.
      return (r.body as { name?: string; path?: string }[]).some(
        (l) => l.name === LUME_STORAGE && resolve(l.path ?? '') === this.vmsDir,
      );
    } catch {
      return false;
    }
  }

  async #ensureServe(onProgress?: (m: string) => void): Promise<void> {
    await this.writeConfig();
    const rec = await this.#readServe();
    const state = rec ? await this.#serveState(rec) : 'gone';
    if (rec && state !== 'gone') {
      // A running serve may just be busy (S6: a GET once took minutes): give it the start deadline to answer.
      const deadline = Date.now() + this.#t.serveStart;
      for (;;) {
        if (await this.#answers(rec.port)) {
          this.#port = rec.port;
          return;
        }
        if (Date.now() >= deadline || (await this.#serveState(rec)) === 'gone') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      const now = await this.#serveState(rec);
      if (now !== 'gone') {
        const others = await this.leases.others();
        if (now !== 'ours' || others.length > 0) {
          // Its VMs (another MineVibe's among them) would die with it: never replaced on a guess or under someone.
          throw new LumeError(
            'SERVE_FAILED',
            `lume serve (pid ${rec.pid}) runs but does not answer${others.length > 0 ? ' and another MineVibe uses it' : ''}; try again, or quit every MineVibe to restart it`,
          );
        }
        // Ours, wedged, and nobody else uses it: replace it (its VMs die with it).
        this.#log?.warn({ pid: rec.pid }, 'lume serve does not answer; restarting it');
        await this.#kill(rec);
      }
    }
    onProgress?.('starting lume serve');
    await this.#rotateLog();
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await freeLoopbackPort();
      const pid = await this.#spawnServe(this.bin, port, this.env(), this.logPath, this.leases.dir);
      const started = await this.leases.processStart(pid);
      const record: ServeRecord = {
        pid,
        started: started === 'gone' ? null : started,
        port,
        bin: this.bin,
        at: Date.now(),
      };
      const deadline = Date.now() + this.#t.serveStart;
      while (Date.now() < deadline) {
        if (await this.#answers(port)) {
          await writeFileAtomic(this.#servePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
          this.#port = port;
          this.#log?.info({ pid, port }, 'lume serve started');
          return;
        }
        try {
          process.kill(pid, 0);
        } catch {
          break; // exited (a port taken in between)
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      lastErr = `lume serve on port ${port} did not answer`;
      await this.#kill(record);
    }
    throw new LumeError('SERVE_FAILED', lastErr);
  }

  /** SIGTERM (then SIGKILL) the process group of a serve proven ours (supervisor and serve); its VMs die with it. */
  async #kill(rec: ServeRecord): Promise<void> {
    if ((await this.#serveState(rec)) !== 'ours') return;
    const signal = (sig: NodeJS.Signals | 0): boolean => {
      try {
        process.kill(-rec.pid, sig);
        return true;
      } catch {
        // Not a group leader any more: the process alone.
        try {
          process.kill(rec.pid, sig);
          return true;
        } catch {
          return false;
        }
      }
    };
    if (!signal('SIGTERM')) return;
    const deadline = Date.now() + this.#t.serveStop;
    while (Date.now() < deadline) {
      if (!signal(0)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    signal('SIGKILL');
  }

  async #stopServe(): Promise<boolean> {
    const rec = await this.#readServe();
    const state = rec ? await this.#serveState(rec) : 'gone';
    if (state === 'unknown') {
      // Not provably ours right now: left running (its supervisor stops it once no lease is left, the lifeline).
      this.#log?.warn(
        { pid: rec?.pid },
        'cannot tell whether lume serve is still ours; leaving it to its lifeline',
      );
      return false;
    }
    if (!rec || state === 'gone') {
      await rm(this.#servePath, { force: true });
      return false;
    }
    await this.#kill(rec);
    await rm(this.#servePath, { force: true });
    this.#log?.info({ pid: rec.pid }, 'lume serve stopped');
    return true;
  }

  async #rotateLog(): Promise<void> {
    try {
      const s = await stat(this.logPath);
      if (s.size > 64 * 1024 * 1024) {
        await rename(this.logPath, `${this.logPath}.1`);
        this.#logOffset = 0;
        this.#events = { ended: new Map(), failed: new Map() };
      }
    } catch {}
  }

  /**
   * Every VM in MineVibe's storage location, as Lume lists them. The list takes no `storage` query (0.6.1 answers 404 to
   * `/lume/vms?storage=…`) and spans every location of the config, so it is filtered by `locationName`. Throws LumeError.
   */
  async listVms(): Promise<Record<string, unknown>[]> {
    const r = await this.api('GET', '/lume/vms');
    if (r.status !== 200 || !Array.isArray(r.body)) {
      throw new LumeError('API', `lume list: HTTP ${r.status}`, r.status);
    }
    return (r.body as Record<string, unknown>[]).filter(
      (vm) => vm && typeof vm === 'object' && (vm.locationName ?? LUME_STORAGE) === LUME_STORAGE,
    );
  }

  /** A MineVibe VM's sidecar (`<vms>/<vm>/minevibe.json`), or null when the VM has none (not MineVibe's). */
  async #readSidecar(vm: string): Promise<VmSidecar | null> {
    try {
      const s = JSON.parse(await readFile(join(this.vmsDir, vm, VM_SIDECAR), 'utf8')) as VmSidecar;
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  /**
   * Records this process as the owner of a MineVibe VM (its sidecar's `owner`): before every start, and for the VMs a
   * joining process keeps. The reaper stops a running VM whose owner died. Throws when the VM has no sidecar.
   */
  async claimVm(vm: string): Promise<void> {
    const path = join(this.vmsDir, vm, VM_SIDECAR);
    const s = JSON.parse(await readFile(path, 'utf8')) as VmSidecar;
    const me = await this.leases.self();
    if (s.owner?.pid === me.pid && s.owner.started === me.started) return;
    await writeFileAtomic(path, `${JSON.stringify({ ...s, owner: { ...me, at: Date.now() } }, null, 2)}\n`, {
      mode: 0o644,
    });
  }

  /**
   * The reaper (under the lock): claims the running MineVibe VMs (`mv-pc-*` with a sidecar) that `keep` names, and stops
   * every other one whose owner process died; one with no owner recorded only when no other live lease exists. A VM
   * whose owner's liveness `ps` cannot tell is left alone. Returns the VMs it stopped.
   */
  async #reap(keep: (vm: string) => boolean): Promise<string[]> {
    let vms: { name?: string; status?: string }[];
    try {
      vms = (await this.listVms()) as typeof vms;
    } catch (err) {
      this.#log?.warn({ err: String(err) }, 'lume reaper: listing failed');
      return [];
    }
    const stopped: string[] = [];
    let othersLive: boolean | null = null;
    for (const vm of vms) {
      const name = vm.name ?? '';
      if (vm.status !== 'running' || !/^mv-pc-[a-z0-9-]+$/.test(name)) continue;
      // Only a VM MineVibe made (its sidecar, LumeMacDriver.create) is ever touched.
      const sidecar = await this.#readSidecar(name);
      if (!sidecar) continue;
      if (keep(name)) {
        await this.claimVm(name).catch((err: unknown) =>
          this.#log?.warn({ vm: name, err: String(err) }, 'lume reaper: could not claim a VM'),
        );
        continue;
      }
      const owner = sidecar.owner;
      let orphan: boolean;
      if (owner && Number.isInteger(owner.pid)) {
        orphan = (await this.leases.liveness({ pid: owner.pid, started: owner.started ?? null })) === 'dead';
      } else {
        othersLive ??= (await this.leases.others()).length > 0;
        orphan = !othersLive;
      }
      if (!orphan) continue;
      this.#log?.warn({ vm: name, owner: owner?.pid }, 'stopping a MineVibe VM whose process is gone');
      const r = await this.api(
        'POST',
        `/lume/vms/${encodeURIComponent(name)}/stop`,
        { storage: LUME_STORAGE },
        this.#t.reapStop,
      ).catch((err: unknown) => {
        this.#log?.warn({ vm: name, err: String(err) }, 'lume reaper: stop failed');
        return null;
      });
      if (r) stopped.push(name);
    }
    return stopped;
  }

  // ---------------------------------------------------------------- API

  /** One API call to the serve with a deadline. Network failures throw LumeError(API); HTTP errors are returned. */
  api(method: string, path: string, body?: unknown, timeoutMs = this.#t.api): Promise<LumeApiResult> {
    if (this.#port === null) return Promise.reject(new LumeError('API', 'lume serve is not running'));
    return this.#apiOn(this.#port, method, path, body, timeoutMs);
  }

  async #apiOn(
    port: number,
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<LumeApiResult> {
    let res: Response;
    try {
      res = await this.#fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why =
        err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : String(err);
      throw new LumeError('API', `lume ${method} ${path.split('?')[0]}: ${why}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // plain text
    }
    return { status: res.status, body: parsed };
  }

  // ---------------------------------------------------------------- log

  /** Reads what the serve logged since the last call and returns every event so far. */
  async logEvents(): Promise<LumeLogEvents> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.logPath, 'r');
      const size = (await fh.stat()).size;
      if (size < this.#logOffset) this.#logOffset = 0; // replaced
      const max = 8 * 1024 * 1024;
      const from = Math.max(this.#logOffset, size - max);
      if (size > from) {
        const buf = Buffer.alloc(size - from);
        await fh.read(buf, 0, buf.length, from);
        // A line cut by the read boundary is read again next time.
        const text = buf.toString('utf8');
        const lastNl = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
        const whole = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
        parseLumeLog(whole, this.#events);
        this.#logOffset = from + Buffer.byteLength(whole);
      }
    } catch {
      // no log yet
    } finally {
      await fh?.close();
    }
    return this.#events;
  }

  /** `sessions.json` of a running VM: the serve pid, when it started (epoch ms) and its shares. */
  async session(
    vm: string,
  ): Promise<{ pid: number; startedAt: number; shares: { hostPath: string; readOnly: boolean }[] } | null> {
    try {
      const s = JSON.parse(await readFile(join(this.vmsDir, vm, 'sessions.json'), 'utf8')) as {
        pid?: number;
        startedAt?: number;
        sharedDirectories?: { hostPath?: string; readOnly?: boolean }[];
      };
      return {
        pid: s.pid ?? 0,
        startedAt: Math.floor((s.startedAt ?? 0) * 1000),
        shares: (s.sharedDirectories ?? []).map((d) => ({
          hostPath: d.hostPath ?? '',
          readOnly: d.readOnly === true,
        })),
      };
    } catch {
      return null;
    }
  }

  /** Copies a file into a VM's setup share when it differs (the ripgrep binary). */
  async stageFile(src: string, dest: string, mode: number): Promise<void> {
    if (existsSync(dest) && (await sha256File(dest)) === (await sha256File(src))) return;
    await copyFile(src, `${dest}.tmp`);
    await chmod(`${dest}.tmp`, mode);
    await rename(`${dest}.tmp`, dest);
  }

  /** Writes a file 0600 in a 0700 folder (the token). */
  async writeSecret(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await writeFile(`${path}.tmp`, content, { mode: 0o600 });
    await chmod(`${path}.tmp`, 0o600);
    await rename(`${path}.tmp`, path);
  }
}

/** Every regular file and symlink under `dir`, relative, with `/`. */
async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.add(relative(dir, p).split('\\').join('/'));
    }
  };
  await walk(dir);
  return out;
}

/**
 * The serve's supervisor (`sh -c <this> mv-lume-serve <bin> <port> <lease dir>`): runs `lume serve`, passes a TERM on
 * (the serve powers its VMs off and exits within ~3 s, S6), and stops the serve itself once no lease file in
 * `<lease dir>` has named a live process for five checks in a row (about 10 s): the lifeline for when every MineVibe
 * using the serve died without stopping it.
 */
export const SERVE_SUPERVISOR = [
  'bin=$1; port=$2; leases=$3',
  '"$bin" serve --port "$port" </dev/null &',
  's=$!',
  `trap 'kill -TERM "$s" 2>/dev/null; wait "$s" 2>/dev/null; exit 0' TERM INT HUP`,
  'gone=0',
  'while kill -0 "$s" 2>/dev/null; do',
  '  sleep 2 &',
  '  wait $!',
  '  live=0',
  '  for f in "$leases"/*.json; do',
  '    [ -f "$f" ] || continue',
  `    p=$(sed -n 's/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$f" | head -n 1)`,
  '    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then live=1; break; fi',
  '  done',
  '  if [ "$live" = 1 ]; then gone=0; else gone=$((gone + 1)); fi',
  '  if [ "$gone" -ge 5 ]; then',
  '    echo "[minevibe] no MineVibe process uses this lume serve any more; stopping it" >&2',
  '    kill -TERM "$s" 2>/dev/null',
  '    wait "$s" 2>/dev/null',
  '    exit 0',
  '  fi',
  'done',
  'wait "$s"',
].join('\n');

/**
 * Spawns {@link SERVE_SUPERVISOR} running `lume serve --port <port>` in its own process group (a terminal Ctrl+C reaches
 * MineVibe only, which stops it in order), output appended to `logPath` through a file descriptor (a pipe Node stops
 * draining blocks the serve, S6). Returns the supervisor's pid, the group's leader.
 */
async function spawnSupervisedServe(
  bin: string,
  port: number,
  env: NodeJS.ProcessEnv,
  logPath: string,
  leaseDir: string,
): Promise<number> {
  await mkdir(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn('/bin/sh', ['-c', SERVE_SUPERVISOR, 'mv-lume-serve', bin, String(port), leaseDir], {
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    const pid = await new Promise<number>((resolvePid, reject) => {
      child.once('spawn', () => resolvePid(child.pid as number));
      child.once('error', reject);
    });
    child.unref();
    return pid;
  } finally {
    closeSync(fd);
  }
}
