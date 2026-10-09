import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { join, sep } from 'node:path';
import type { Logger } from 'pino';

/**
 * Keeps a macOS guest's view of its Vault folders fresh (PLAN §8.7, spike S6). The guest's virtio-fs client caches host
 * files: after a host-side edit it reads the old bytes (in-place rewrites) or gets "No such file" (rename-replaces) until
 * MineVibe refreshes it (`purge`, then a remount when nothing holds the share busy).
 *
 * Each running macOS PC's Vault folders are watched on the host (FSEvents, recursive). Any change marks the PC dirty and
 * the next PcApi file or shell call refreshes the guest first. The guest's own writes come back as events too and
 * cannot be told apart from host edits, so a shell call that wrote files costs the next call a refresh (~0.3 s); only
 * the files a `write` or `edit` names are expected (their events, and those of their folders, are ignored while the
 * call runs and for {@link EXPECT_GRACE_MS} after it, the FSEvents latency). A host edit during a long shell call is
 * therefore never lost. Refreshes of one PC never overlap, and one that fails leaves the PC dirty.
 */

/** How long a `write`/`edit` call's own events may arrive after it ended. */
export const EXPECT_GRACE_MS = 3_000;

export interface GuestViewSyncOptions {
  /** Refreshes the guest (MAC_REFRESH_SCRIPT through spacesd). */
  readonly refresh: (pcId: string) => Promise<void>;
  readonly logger?: Logger;
  /** fs.watch (tests): `onChange` gets the changed path, absolute, or null when the watcher did not say. */
  readonly watch?: (path: string, onChange: (path: string | null) => void) => { close(): void };
  readonly now?: () => number;
}

const defaultWatch = (path: string, onChange: (p: string | null) => void): { close(): void } => {
  const w: FSWatcher = fsWatch(path, { recursive: true, persistent: false }, (_e, name) =>
    onChange(name ? join(path, name.toString()) : null),
  );
  w.on('error', () => onChange(null));
  return w;
};

export class GuestViewSync {
  readonly #o: GuestViewSyncOptions;
  readonly #watchers = new Map<string, { close(): void }[]>();
  readonly #dirty = new Set<string>();
  /** Paths a `write`/`edit` of the PC is writing (or wrote lately): path → calls holding it, and until when. */
  readonly #expected = new Map<string, Map<string, { calls: number; until: number }>>();
  readonly #refreshing = new Map<string, Promise<void>>();

  constructor(options: GuestViewSyncOptions) {
    this.#o = options;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Watches a PC's Vault folders (replacing earlier watches). Starts clean: the guest mounts them at its start. */
  track(pcId: string, folders: readonly string[]): void {
    this.untrack(pcId);
    const ws: { close(): void }[] = [];
    for (const f of folders) {
      try {
        ws.push((this.#o.watch ?? defaultWatch)(f, (p) => this.#changed(pcId, p)));
      } catch (err) {
        // Unwatched: host edits of this folder may stay invisible in the guest until its next boot.
        this.#o.logger?.warn({ pcId, folder: f, err: String(err) }, 'cannot watch a Vault folder');
      }
    }
    this.#watchers.set(pcId, ws);
  }

  untrack(pcId: string): void {
    for (const w of this.#watchers.get(pcId) ?? []) {
      try {
        w.close();
      } catch {}
    }
    this.#watchers.delete(pcId);
    this.#dirty.delete(pcId);
    this.#expected.delete(pcId);
  }

  closeAll(): void {
    for (const id of [...this.#watchers.keys()]) this.untrack(id);
  }

  isTracked(pcId: string): boolean {
    return this.#watchers.has(pcId);
  }

  isDirty(pcId: string): boolean {
    return this.#dirty.has(pcId);
  }

  /**
   * Whether `path` is a file a `write`/`edit` of this PC is writing or just wrote, or a folder on the way to one (the
   * folders `write` creates report events of their own).
   */
  #isExpected(pcId: string, path: string): boolean {
    const exp = this.#expected.get(pcId);
    if (!exp) return false;
    const now = this.#now();
    for (const [p, e] of exp) {
      if (e.calls === 0 && e.until < now) {
        exp.delete(p);
        continue;
      }
      if (p === path || p.startsWith(path.endsWith(sep) ? path : `${path}${sep}`)) return true;
    }
    return false;
  }

  #changed(pcId: string, path: string | null): void {
    if (!this.#watchers.has(pcId)) return;
    if (path !== null && this.#isExpected(pcId, path)) return;
    this.#dirty.add(pcId);
  }

  /** Marks a change by hand (tests, or a host-side write MineVibe itself made). */
  markDirty(pcId: string): void {
    if (this.#watchers.has(pcId)) this.#dirty.add(pcId);
  }

  /**
   * Before a PcApi call: refreshes the guest when the host changed its folders. `writes` names the files the call
   * writes (absolute; `write`/`edit`): their events are the call's own until {@link EXPECT_GRACE_MS} after the returned
   * function ran.
   */
  async enter(pcId: string, writes: readonly string[] = []): Promise<() => void> {
    if (!this.#watchers.has(pcId)) return () => {};
    await this.#sync(pcId);
    const exp = this.#expected.get(pcId) ?? new Map<string, { calls: number; until: number }>();
    this.#expected.set(pcId, exp);
    const held: { calls: number; until: number }[] = [];
    for (const w of new Set(writes)) {
      if (!w.startsWith('/')) continue;
      const e = exp.get(w) ?? { calls: 0, until: 0 };
      e.calls++;
      exp.set(w, e);
      held.push(e);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const until = this.#now() + EXPECT_GRACE_MS;
      for (const e of held) {
        e.calls = Math.max(0, e.calls - 1);
        e.until = Math.max(e.until, until);
      }
    };
  }

  async #sync(pcId: string): Promise<void> {
    const running = this.#refreshing.get(pcId);
    if (running) return running;
    if (!this.#dirty.has(pcId)) return;
    this.#dirty.delete(pcId);
    const p = this.#o
      .refresh(pcId)
      .catch((err: unknown) => {
        this.#dirty.add(pcId);
        this.#o.logger?.warn({ pcId, err: String(err) }, 'refreshing the guest view of the Vault failed');
      })
      .finally(() => this.#refreshing.delete(pcId));
    this.#refreshing.set(pcId, p);
    return p;
  }
}
