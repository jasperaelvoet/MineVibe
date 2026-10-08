/**
 * PlanCapture (PLAN §6.4, S2). In Claude Code 2.1.293 `ExitPlanMode` carries no plan text: the model writes the plan
 * with `Write` to `$HOME/.claude/plans/<slug>.md`, and the alias routes that write to `mcp__pc__write`. Writes, edits
 * and reads under that directory are handled here, in Node memory: they never reach the PC and never touch the host
 * disk. On `ExitPlanMode` the latest captured text becomes the plan card.
 */

import { posix } from 'node:path';

/** Largest plan kept (the plan card's limit). */
export const PLAN_MAX_CHARS = 32_000;

export interface PlanFile {
  readonly path: string;
  readonly text: string;
  readonly updatedAt: number;
}

export type PlanEditResult =
  | { readonly ok: true; readonly replacements: number }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'EDIT_NOT_FOUND' | 'EDIT_AMBIGUOUS';
      readonly message: string;
    };

export class PlanCapture {
  readonly #prefixes: readonly string[];
  readonly #files = new Map<string, PlanFile>();
  readonly #now: () => number;
  #latest: string | null = null;

  /**
   * @param homes The home directories the CLI may use for `~/.claude/plans/` (the agent env's `HOME`; the PC user's
   *   home as a courtesy).
   */
  constructor(homes: readonly string[], options: { now?: () => number } = {}) {
    const prefixes = new Set<string>(['~/.claude/plans/']);
    for (const home of homes) {
      if (!home.startsWith('/')) continue;
      prefixes.add(`${posix.normalize(home).replace(/\/+$/, '')}/.claude/plans/`);
    }
    this.#prefixes = [...prefixes];
    this.#now = options.now ?? Date.now;
  }

  /** Whether `path` names a file inside a plans directory (after normalizing `..` and `//`). */
  isPlanPath(path: unknown): path is string {
    if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.includes('\0'))
      return false;
    const normalized = path.startsWith('~/') ? `~/${posix.normalize(path.slice(2))}` : posix.normalize(path);
    if (normalized.split('/').includes('..')) return false;
    return this.#prefixes.some(
      (prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length,
    );
  }

  write(path: string, content: string): number {
    const text = content.length > PLAN_MAX_CHARS ? content.slice(0, PLAN_MAX_CHARS) : content;
    this.#files.set(this.#key(path), { path, text, updatedAt: this.#now() });
    this.#latest = this.#key(path);
    return Buffer.byteLength(text, 'utf8');
  }

  edit(path: string, oldString: string, newString: string, replaceAll = false): PlanEditResult {
    const file = this.#files.get(this.#key(path));
    if (!file) return { ok: false, code: 'NOT_FOUND', message: `File does not exist: ${path}` };
    const count = oldString.length === 0 ? 0 : file.text.split(oldString).length - 1;
    if (count === 0) {
      return { ok: false, code: 'EDIT_NOT_FOUND', message: `String to replace not found in file: ${path}` };
    }
    if (count > 1 && !replaceAll) {
      return {
        ok: false,
        code: 'EDIT_AMBIGUOUS',
        message: `Found ${count} matches of the string to replace; set replace_all or give more context`,
      };
    }
    const text = replaceAll
      ? file.text.split(oldString).join(newString)
      : file.text.replace(oldString, () => newString);
    this.write(path, text);
    return { ok: true, replacements: replaceAll ? count : 1 };
  }

  read(path: string): PlanFile | null {
    return this.#files.get(this.#key(path)) ?? null;
  }

  /** The most recently written plan, or null. */
  latest(): PlanFile | null {
    return this.#latest === null ? null : (this.#files.get(this.#latest) ?? null);
  }

  /** Forgets every captured plan (after approval, a stand-up or a kick). */
  clear(): void {
    this.#files.clear();
    this.#latest = null;
  }

  #key(path: string): string {
    return path.startsWith('~/') ? `~/${posix.normalize(path.slice(2))}` : posix.normalize(path);
  }
}
