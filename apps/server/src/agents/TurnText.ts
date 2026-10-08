/**
 * What the agent last said in the current turn: its main-thread text since its latest tool call (consecutive text
 * blocks joined). The plan card falls back to it when a plan-first agent states its plan in prose and calls
 * `ExitPlanMode` without writing `~/.claude/plans/*.md` (PLAN §6.4; DEBT "a plan card without a plan").
 */

/** Longest text kept (the plan card's limit). */
export const TURN_TEXT_MAX_CHARS = 32_000;

export interface SpokenText {
  readonly text: string;
  /** When its last block arrived. */
  readonly at: number;
}

export class TurnText {
  readonly #now: () => number;
  #parts: string[] = [];
  #at = 0;
  /** A tool call came after the current parts: the next text starts a new segment. */
  #sealed = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** One main-thread text block. */
  text(text: string): void {
    const t = text.trim();
    if (t.length === 0) return;
    if (this.#sealed) {
      this.#parts = [];
      this.#sealed = false;
    }
    this.#parts.push(t);
    let total = this.#parts.reduce((n, p) => n + p.length + 2, 0);
    while (total > TURN_TEXT_MAX_CHARS && this.#parts.length > 1)
      total -= (this.#parts.shift() as string).length + 2;
    this.#at = this.#now();
  }

  /** A tool call: the text so far stays the latest until new text arrives. */
  toolUse(): void {
    this.#sealed = true;
  }

  /** The turn ended (or the session closed): nothing said in it counts any more. */
  reset(): void {
    this.#parts = [];
    this.#sealed = false;
    this.#at = 0;
  }

  /** The latest text of this turn, or null. */
  latest(): SpokenText | null {
    if (this.#parts.length === 0) return null;
    return { text: this.#parts.join('\n\n').slice(0, TURN_TEXT_MAX_CHARS), at: this.#at };
  }
}
