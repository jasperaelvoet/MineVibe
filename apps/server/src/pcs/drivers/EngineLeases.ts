import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
 *   the engine while another one is just starting to use it. Within one process the calls queue on an
 *   in-process mutex first, so two calls of one object never overlap either.
 * - A stale lock is broken by an atomic rename to a unique tombstone, then checked: only the contender
 *   whose tombstone holds the very record it judged dead goes on, so two processes breaking the same
 *   stale lock never both get in, and a fresh lock taken in between is never deleted.
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

/** What `engine.lock` holds: a lease record plus a nonce, so every acquisition's content is unique. */
interface LockRecord extends LeaseRecord {
  nonce: string;
}

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
  /** The `acquire()` in flight: concurrent callers share it instead of writing a second lease (B2). */
  #acquiring: Promise<void> | null = null;
  /** Tail of this object's in-process lock queue (B1). */
  #lockTail: Promise<void> = Promise.resolve();
  /** This process's start time (`ps -o lstart=`), once ps told it. */
  #ownStart: string | null = null;

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

  /** This process's start time, cached once known (null while ps cannot tell). */
  async #selfStart(): Promise<string | null> {
    if (this.#ownStart === null) {
      const s = await this.processStart(this.#pid);
      if (s !== null && s !== 'gone') this.#ownStart = s;
    }
    return this.#ownStart;
  }

  /** A record of this process now (for a lease or the lock). */
  async #record(): Promise<LeaseRecord> {
    return { pid: this.#pid, started: await this.#selfStart(), holder: this.#holder, at: Date.now() };
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

  /**
   * Takes this process's lease (idempotent). Concurrent calls share the one in flight, so a process
   * never writes two leases (B2).
   */
  acquire(): Promise<void> {
    if (this.#file) return Promise.resolve();
    if (!this.#acquiring) {
      this.#acquiring = this.#writeLease().finally(() => {
        this.#acquiring = null;
      });
    }
    return this.#acquiring;
  }

  async #writeLease(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const rec = await this.#record();
    const name = `${this.#pid}-${randomBytes(4).toString('hex')}.json`;
    const tmp = join(this.dir, `.${name}.tmp`);
    await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    await rename(tmp, join(this.dir, name));
    this.#file = name;
  }

  /** Drops this process's lease (idempotent); an acquire in flight lands first, so it is never left behind. */
  async release(): Promise<void> {
    if (this.#acquiring) await this.#acquiring.catch(() => {});
    const f = this.#file;
    this.#file = null;
    if (f) await rm(join(this.dir, f), { force: true });
  }

  /**
   * Every lease file other than ours: live or undecidable ones are returned, dead ones deleted. A lease of
   * this very process (our pid and start time) is never another user, whatever its file name (B2).
   */
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
      if (rec.pid === this.#pid && rec.started !== null && rec.started === (await this.#selfStart())) {
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

  /**
   * Runs `fn` holding the exclusive engine lock: first this object's in-process queue (B1: two calls never
   * overlap, whatever their timing), then the lock file shared with other processes. Not re-entrant: `fn`
   * must not call `withLock` itself (it would wait for itself).
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#lockTail;
    let done: () => void = () => {};
    this.#lockTail = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      await prev;
      const path = join(this.dir, LOCK);
      const mine = await this.#lockFile(path);
      try {
        return await fn();
      } finally {
        await this.#removeIf(path, mine);
      }
    } finally {
      done();
    }
  }

  /** Takes the lock file (waiting for a live holder, breaking a dead one); returns what we wrote. */
  async #lockFile(path: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const t0 = Date.now();
    for (;;) {
      const rec: LockRecord = { ...(await this.#record()), nonce: randomBytes(8).toString('hex') };
      const mine = `${JSON.stringify(rec)}\n`;
      if (await this.#createExclusive(path, mine)) return mine;
      let seen: string;
      try {
        seen = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // let go just now
        throw err;
      }
      let holder: LeaseRecord | null = null;
      try {
        holder = JSON.parse(seen) as LeaseRecord;
      } catch {
        // Garbage (a writer that died mid-write): give a writer a moment, then break it.
        const age = await stat(path).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age > 10_000 && (await this.#removeIf(path, seen))) continue;
      }
      if (holder && (await this.#liveness(holder)) === 'dead') {
        // B3: only the record judged dead is removed; whoever loses the race just tries again.
        if (await this.#removeIf(path, seen)) {
          this.#log?.info({ pid: holder.pid }, 'broke a stale engine lock');
        }
        continue;
      }
      if (Date.now() - t0 > this.#lockTimeoutMs) {
        throw new Error(
          `another MineVibe (pid ${holder?.pid ?? '?'}) is starting or stopping the container system; gave up after ${this.#lockTimeoutMs} ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Creates `path` holding `content` only when it does not exist: the content goes to a private temp file
   * that is then hard-linked into place, so the lock is never seen half-written. False when it exists.
   */
  async #createExclusive(path: string, content: string): Promise<boolean> {
    const tmp = join(this.dir, `.${LOCK}.${this.#pid}-${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Removes the lock file only while it still holds `expected` (B3). A read-then-remove would delete a
   * lock someone else took in between, so the file is renamed to a unique tombstone first (atomic: of
   * several contenders only one gets it) and the tombstone is checked: holding `expected`, it was the one
   * to remove; holding anything else, a lock was taken in between and is put back (`link` never replaces a
   * file). Returns whether this call removed `expected`.
   */
  async #removeIf(path: string, expected: string): Promise<boolean> {
    const now = await readFile(path, 'utf8').catch(() => null);
    if (now !== expected) return false;
    const tomb = join(this.dir, `.${LOCK}.${this.#pid}-${randomBytes(6).toString('hex')}.tomb`);
    try {
      await rename(path, tomb);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // someone else was faster
      throw err;
    }
    try {
      if ((await readFile(tomb, 'utf8')) === expected) return true;
      try {
        await link(tomb, path);
      } catch (err) {
        this.#log?.error(
          { err: (err as Error).message },
          'could not put back an engine lock taken while breaking a stale one',
        );
      }
      return false;
    } finally {
      await rm(tomb, { force: true });
    }
  }
}
