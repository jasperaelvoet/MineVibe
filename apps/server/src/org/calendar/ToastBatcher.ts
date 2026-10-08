import type { OrgClock } from '../clock.js';

/**
 * Batches toasts to at most one per window (PLAN §6.6: "Toasts are batched to at most one per 30 s"). The first
 * line after a quiet window goes out at once; later lines collect and go out together when the window ends.
 */
export class ToastBatcher {
  readonly #clock: OrgClock;
  readonly #windowMs: number;
  readonly #flush: (text: string, lines: readonly string[]) => void;
  #lastAt = Number.NEGATIVE_INFINITY;
  #pending: string[] = [];
  #timer: unknown = null;

  constructor(clock: OrgClock, flush: (text: string, lines: readonly string[]) => void, windowMs = 30_000) {
    this.#clock = clock;
    this.#flush = flush;
    this.#windowMs = windowMs;
  }

  push(line: string): void {
    this.#pending.push(line);
    const now = this.#clock.now();
    if (this.#timer !== null) return;
    if (now - this.#lastAt >= this.#windowMs) {
      this.#emit();
      return;
    }
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timer = null;
        this.#emit();
      },
      this.#lastAt + this.#windowMs - now,
    );
  }

  get pending(): number {
    return this.#pending.length;
  }

  dispose(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = [];
  }

  #emit(): void {
    if (this.#pending.length === 0) return;
    const lines = this.#pending;
    this.#pending = [];
    this.#lastAt = this.#clock.now();
    const text =
      lines.length === 1 ? (lines[0] ?? '') : `${lines.length} calendar updates: ${lines.join(' · ')}`;
    this.#flush(text, lines);
  }
}
