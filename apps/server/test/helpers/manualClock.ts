import type { OrgClock } from '../../src/org/clock.js';

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** Lets pending promise callbacks and I/O callbacks run (several macrotask rounds, so chained awaits settle). */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Cheap flush between timers: promise jobs only (chained awaits on already-settled promises). */
async function flushPromiseJobs(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * A fake {@link OrgClock}: time only moves on {@link advance}, which runs due timers in order and lets
 * microtasks settle between them, so async state machines step exactly as they would in real time.
 */
export class ManualClock implements OrgClock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(start = Date.UTC(2026, 9, 8, 10, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: ++this.#seq, at: this.#now + Math.max(0, ms), fn };
    this.#timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Moves time forward by `ms`, running every timer that comes due (in time order). */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await flushMicrotasks();
    for (;;) {
      this.#timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.#timers[0];
      if (!next || next.at > target) break;
      this.#timers.shift();
      this.#now = Math.max(this.#now, next.at);
      next.fn();
      await flushPromiseJobs();
    }
    this.#now = target;
    await flushMicrotasks();
  }

  /** Sets the time without running timers (a jump while "the app was closed"). */
  set(ms: number): void {
    this.#now = ms;
  }
}
