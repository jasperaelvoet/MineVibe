/**
 * BrainSupervisor (PLAN §6.5): restarts a crashed `claude` with exponential backoff, at most N times per 10 minutes;
 * after that the agent shows "brain offline" with a Retry button (`agent.cmd{retry_brain}`). Authentication failures
 * (401, expired login) are not retried automatically: they put the crew to sleep (Zz) until a retry.
 */

import { SUPERVISOR_BACKOFF_MS, SUPERVISOR_MAX_RESTARTS, SUPERVISOR_WINDOW_MS } from './constants.js';

export type SupervisorVerdict =
  | { readonly action: 'restart'; readonly delayMs: number; readonly attempt: number }
  | { readonly action: 'offline'; readonly reason: string }
  | { readonly action: 'auth'; readonly reason: string };

const AUTH_RE =
  /\b401\b|unauthori[sz]ed|authentication|oauth|not logged in|log ?in again|invalid api key|expired token/i;

export function isAuthError(error: Error): boolean {
  return AUTH_RE.test(error.message);
}

export interface SupervisorOptions {
  readonly now?: () => number;
  readonly maxRestarts?: number;
  readonly windowMs?: number;
  readonly backoff?: { readonly base: number; readonly max: number };
}

export class BrainSupervisor {
  readonly #now: () => number;
  readonly #max: number;
  readonly #window: number;
  readonly #backoff: { base: number; max: number };
  readonly #history = new Map<string, number[]>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: SupervisorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#max = options.maxRestarts ?? SUPERVISOR_MAX_RESTARTS;
    this.#window = options.windowMs ?? SUPERVISOR_WINDOW_MS;
    this.#backoff = options.backoff ?? SUPERVISOR_BACKOFF_MS;
  }

  /** What to do about a crashed session. */
  verdict(agentId: string, error: Error): SupervisorVerdict {
    if (isAuthError(error)) return { action: 'auth', reason: error.message };
    const now = this.#now();
    const recent = (this.#history.get(agentId) ?? []).filter((t) => now - t < this.#window);
    if (recent.length >= this.#max) {
      this.#history.set(agentId, recent);
      return {
        action: 'offline',
        reason: `${recent.length} restarts in ${Math.round(this.#window / 60_000)} min`,
      };
    }
    recent.push(now);
    this.#history.set(agentId, recent);
    const attempt = recent.length;
    const delayMs = Math.min(this.#backoff.max, this.#backoff.base * 2 ** (attempt - 1));
    return { action: 'restart', delayMs, attempt };
  }

  /** Handles a crash: schedules `restart`, or calls `offline` / `auth`. */
  onCrash(
    agentId: string,
    error: Error,
    handlers: { restart: () => void; offline: (reason: string) => void; auth: (reason: string) => void },
  ): SupervisorVerdict {
    const v = this.verdict(agentId, error);
    if (v.action === 'restart') {
      this.cancel(agentId);
      const timer = setTimeout(() => {
        this.#timers.delete(agentId);
        handlers.restart();
      }, v.delayMs);
      timer.unref?.();
      this.#timers.set(agentId, timer);
    } else if (v.action === 'offline') {
      handlers.offline(v.reason);
    } else {
      handlers.auth(v.reason);
    }
    return v;
  }

  /** Retry button: forget the history. */
  reset(agentId: string): void {
    this.cancel(agentId);
    this.#history.delete(agentId);
  }

  cancel(agentId: string): void {
    const t = this.#timers.get(agentId);
    if (t) clearTimeout(t);
    this.#timers.delete(agentId);
  }

  dispose(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }
}
