/**
 * Read-state (PC tools V2 §5.3, Claude Code's readFileState): what the agent has seen of each file in this seat, so
 * `write` never overwrites a file it never read (the player's Vault files) and `write`/`edit` refuse a file that
 * changed since (the player or a linter edited it), and an unchanged re-read costs a line instead of the file.
 * Keyed by PC and absolute path; cleared on seat change and on compaction (the agent no longer has the content).
 */

export interface FileView {
  readonly mtimeMs: number;
  readonly size: number;
  /** The range last read (offset 1-based, limit), when it came from a read. */
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

/** Most files remembered (the oldest are dropped). */
const KEEP = 500;

export class ReadState {
  readonly #files = new Map<string, FileView>();

  #key(pcId: string, path: string): string {
    return `${pcId}\n${path}`;
  }

  get(pcId: string, path: string): FileView | undefined {
    return this.#files.get(this.#key(pcId, path));
  }

  set(pcId: string, path: string, view: FileView): void {
    const key = this.#key(pcId, path);
    this.#files.delete(key);
    this.#files.set(key, view);
    while (this.#files.size > KEEP) {
      const oldest = this.#files.keys().next().value as string;
      this.#files.delete(oldest);
    }
  }

  delete(pcId: string, path: string): void {
    this.#files.delete(this.#key(pcId, path));
  }

  clear(): void {
    this.#files.clear();
  }

  get size(): number {
    return this.#files.size;
  }
}

/** Whether a file is as it was when last seen (same size and modification time). */
export function unchanged(view: FileView, now: { readonly mtimeMs: number; readonly size: number }): boolean {
  return view.size === now.size && Math.abs(view.mtimeMs - now.mtimeMs) < 1;
}
