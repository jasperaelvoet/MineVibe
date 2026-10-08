import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { type ExecFn, execWithTimeout } from './exec.js';

/**
 * Engine leases (N4/M1). Every MineVibe process that uses a `container` app root holds a lease file in it
 * (`<appRoot>/minevibe-leases/<pid>-<nonce>.json`: pid, process start time, holder). On quit a process
 * drops its lease and stops the engine only when no other live lease remains, so two dev servers (or a dev
 * server and `npm run test:pcs`) sharing the fixed dev roots never stop each other's PCs.
 *
 * - A lease is live while its pid exists and that pid's process start time (`ps -o lstart=`) still equals
 *   the one recorded, so a reused pid does not keep a dead lease alive. Dead leases are deleted.
 * - When liveness cannot be told (ps timed out), the lease counts as live: the safe mistake is leaving
 *   the engine running, never stopping it under someone else's PCs.
 * - Taking a lease + starting the engine, and dropping a lease + stopping the engine, run under an
 *   exclusive lock file (`engine.lock`, broken when its holder is dead), so a quitting process cannot stop
 *   the engine while another one is just starting to use it.
 */

export interface LeaseRecord {
  pid: number;
  /** `ps -o lstart=` of the pid when the lease was taken (null when ps could not tell). */
  started: string | null;
  /** Free-form: who holds it (`minevibe-server`, `test:pcs`). */
  holder: string;
  /** Epoch ms when the lease was taken. */
  at: number;
}

export type Liveness = 'alive' | 'dead' | 'unknown';

export interface EngineLeasesOptions {
  /** Directory of lease files (created on demand). */
  dir: string;
  holder?: string;
  /** This process's pid (tests). */
  pid?: number;
  /** Runs `ps` (default: a real, timeout-wrapped exec). */
  exec?: ExecFn;
  logger?: Logger;
  /** How long `withLock` waits for another live holder (default 6 min: a cold `system start` is slow). */
  lockTimeoutMs?: number;
  /** Liveness of a lease (tests); default: `kill(pid, 0)` plus the process start time. */
  liveness?: (rec: LeaseRecord) => Promise<Liveness>;
}

const LOCK = 'engine.lock';
const PS_TIMEOUT_MS = 5000;

export class EngineLeases {
  readonly dir: string;
  readonly #holder: string;
  readonly #pid: number;
  readonly #exec: ExecFn;
  readonly #log: Logger | undefined;
  readonly #lockTimeoutMs: number;
  readonly #liveness: (rec: LeaseRecord) => Promise<Liveness>;
  /** Our lease file name (null while we hold none). */
  #file: string | null = null;
  /** Depth of `withLock` held by this object (re-entrant). */
  #lockDepth = 0;

  constructor(options: EngineLeasesOptions) {
    this.dir = options.dir;
    this.#holder = options.holder ?? 'minevibe';
    this.#pid = options.pid ?? process.pid;
    this.#exec = options.exec ?? execWithTimeout;
    this.#log = options.logger;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 360_000;
    this.#liveness = options.liveness ?? ((rec) => this.#defaultLiveness(rec));
  }

  /** Whether this object holds a lease. */
  get held(): boolean {
    return this.#file !== null;
  }

  /** `ps -o lstart=` of a pid: the string, `gone` when no such process, null when ps could not tell. */
  async processStart(pid: number): Promise<string | 'gone' | null> {
    const r = await this.#exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeoutMs: PS_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (r.timedOut || r.error) return null;
    const out = r.stdout.trim();
    if (r.code === 0) return out || null;
    return out ? null : 'gone';
  }

  async #defaultLiveness(rec: LeaseRecord): Promise<Liveness> {
    if (!Number.isInteger(rec.pid) || rec.pid <= 0) return 'dead';
    try {
      process.kill(rec.pid, 0);
    } catch (err) {
      // EPERM: the pid exists (another user's process); only ESRCH means gone.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
    }
    if (!rec.started) return 'unknown';
    const now = await this.processStart(rec.pid);
    if (now === 'gone') return 'dead';
    if (now === null) return 'unknown';
    return now === rec.started ? 'alive' : 'dead';
  }

  /** Takes this process's lease (idempotent). */
  async acquire(): Promise<void> {
    if (this.#file) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const started = await this.processStart(this.#pid);
    const rec: LeaseRecord = {
      pid: this.#pid,
      started: started === 'gone' ? null : started,
      holder: this.#holder,
      at: Date.now(),
    };
    const name = `${this.#pid}-${randomBytes(4).toString('hex')}.json`;
    const tmp = join(this.dir, `.${name}.tmp`);
    await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
    this.#file = name;
  }

  /** Drops this process's lease (idempotent). */
  async release(): Promise<void> {
    const f = this.#file;
    this.#file = null;
    if (f) await rm(join(this.dir, f), { force: true });
  }

  /** Every lease file other than ours: live or undecidable ones are returned, dead ones deleted. */
  async others(): Promise<LeaseRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: LeaseRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.') || name === this.#file) continue;
      const path = join(this.dir, name);
      let rec: LeaseRecord;
      try {
        rec = JSON.parse(await readFile(path, 'utf8')) as LeaseRecord;
      } catch {
        // Written with tmp + rename, so an unparsable lease is garbage.
        await rm(path, { force: true });
        continue;
      }
      const live = await this.#liveness(rec);
      if (live === 'dead') {
        this.#log?.info({ pid: rec.pid, holder: rec.holder }, 'removing a stale engine lease');
        await rm(path, { force: true });
        continue;
      }
      out.push(rec);
    }
    return out;
  }

  /** Runs `fn` holding the exclusive engine lock (re-entrant within this object). */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#lockDepth > 0) return fn();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, LOCK);
    const t0 = Date.now();
    for (;;) {
      try {
        const fh = await open(path, 'wx', 0o600);
        try {
          const started = await this.processStart(this.#pid);
          const rec: LeaseRecord = {
            pid: this.#pid,
            started: started === 'gone' ? null : started,
            holder: this.#holder,
            at: Date.now(),
          };
          await fh.writeFile(`${JSON.stringify(rec)}\n`);
        } finally {
          await fh.close();
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      let holder: LeaseRecord | null = null;
      try {
        holder = JSON.parse(await readFile(path, 'utf8')) as LeaseRecord;
      } catch {
        // Being written right now, or garbage: give a writer a moment, then break it.
        const age = await stat(path).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age > 10_000) await rm(path, { force: true });
      }
      if (holder && (await this.#liveness(holder)) === 'dead') {
        this.#log?.info({ pid: holder.pid }, 'breaking a stale engine lock');
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() - t0 > this.#lockTimeoutMs) {
        throw new Error(
          `another MineVibe (pid ${holder?.pid ?? '?'}) is starting or stopping the container system; gave up after ${this.#lockTimeoutMs} ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.#lockDepth++;
    try {
      return await fn();
    } finally {
      this.#lockDepth--;
      await rm(path, { force: true });
    }
  }
}
