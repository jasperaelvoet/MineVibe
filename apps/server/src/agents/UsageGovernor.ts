/**
 * UsageGovernor (PLAN §6.5): the crew's usage mode from the subscription's rate limits.
 *
 * - Utilization comes from `rate_limit_event.rate_limit_info.unifiedWindows.*.utilization` (a 0-1 fraction; S2: the
 *   top-level field is absent while `allowed`). The `usage_EXPERIMENTAL` poll reports percent, so values above 1 are
 *   divided by 100.
 * - **Tired** (utilization ≥ 0.75): work lane 1, interactive lane kept, no autonomous wakes, no hires, short
 *   meetings. An `allowed_warning` counts only when it carries no utilization at all: live data (T3 smoke, 2026-10-08)
 *   shows warnings at the 25% weekly milestone (`seven_day`, utilization 0.26), far from any limit.
 * - **Asleep** (`rejected`, or an auth failure): everyone pauses until `resetsAt` (plus a grace period); reflexes keep
 *   the crew alive.
 */

import type { BrainsSummary } from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { ASLEEP_GRACE_MS, TIRED_UTILIZATION } from './constants.js';

export type UsageMode = BrainsSummary['mode'];

export interface UsageState {
  readonly mode: UsageMode;
  /** Highest window utilization seen last (0-1), or null when unknown. */
  readonly utilization: number | null;
  /** Epoch ms when the limiting window resets, if known. */
  readonly resetsAt: number | null;
  /** Why the crew sleeps. */
  readonly reason: 'rate_limit' | 'auth' | null;
}

export type UsageEvents = { change: [state: UsageState] };

/** The rate-limit payload as it arrives on the wire (`unifiedWindows` is missing from the d.ts; S2). */
export interface RateLimitInfoLike {
  readonly status?: string;
  readonly resetsAt?: number;
  readonly utilization?: number;
  readonly rateLimitType?: string;
  readonly unifiedWindows?: Readonly<Record<string, { utilization?: number; resetsAt?: number } | undefined>>;
}

/** A 0-1 fraction from a fraction or a percent; null for nonsense. */
export function normalizeUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const v = value > 1 ? value / 100 : value;
  return Math.min(1, v);
}

/** Epoch ms from seconds or ms. */
export function normalizeEpoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

/** Sleep this long when a rejection carries no reset time. */
const UNKNOWN_RESET_SLEEP_MS = 15 * 60_000;

export class UsageGovernor extends TypedEmitter<UsageEvents> {
  #state: UsageState = { mode: 'normal', utilization: null, resetsAt: null, reason: null };
  readonly #now: () => number;
  readonly #graceMs: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: { now?: () => number; graceMs?: number } = {}) {
    super();
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? ASLEEP_GRACE_MS;
  }

  get state(): UsageState {
    return this.#state;
  }

  get mode(): UsageMode {
    return this.#state.mode;
  }

  /** A `rate_limit_event`. */
  onRateLimit(info: RateLimitInfoLike): void {
    let utilization: number | null = null;
    let resetsAt = normalizeEpoch(info.resetsAt);
    for (const window of Object.values(info.unifiedWindows ?? {})) {
      const u = normalizeUtilization(window?.utilization);
      if (u !== null && (utilization === null || u > utilization)) {
        utilization = u;
        resetsAt = normalizeEpoch(window?.resetsAt) ?? resetsAt;
      }
    }
    const top = normalizeUtilization(info.utilization);
    if (top !== null && (utilization === null || top > utilization)) utilization = top;

    if (info.status === 'rejected') {
      this.#sleep('rate_limit', normalizeEpoch(info.resetsAt) ?? resetsAt, utilization ?? 1);
      return;
    }
    const tired = utilization !== null ? utilization >= TIRED_UTILIZATION : info.status === 'allowed_warning';
    this.#set({ mode: tired ? 'tired' : 'normal', utilization, resetsAt, reason: null });
  }

  /** The optional `usage_EXPERIMENTAL` poll (`rate_limits.<window>.utilization` in percent). */
  onUsagePoll(
    rateLimits: Readonly<Record<string, { utilization?: number; resets_at?: number } | null | undefined>>,
  ): void {
    if (this.#state.mode === 'asleep') return;
    let utilization: number | null = null;
    let resetsAt: number | null = null;
    for (const window of Object.values(rateLimits)) {
      const u = normalizeUtilization(window?.utilization);
      if (u !== null && (utilization === null || u > utilization)) {
        utilization = u;
        resetsAt = normalizeEpoch(window?.resets_at);
      }
    }
    if (utilization === null) return;
    this.#set({
      mode: utilization >= TIRED_UTILIZATION ? 'tired' : 'normal',
      utilization,
      resetsAt: resetsAt ?? this.#state.resetsAt,
      reason: null,
    });
  }

  /** An assistant `rate_limit` error or an exhausted-usage result. */
  onRejected(resetsAt?: number | null): void {
    this.#sleep('rate_limit', normalizeEpoch(resetsAt) ?? this.#state.resetsAt, 1);
  }

  /** An authentication failure: Zz until someone retries. */
  onAuthFailure(): void {
    this.#sleep('auth', null, this.#state.utilization);
  }

  /** Retry after an auth failure (AgentScreen Retry). */
  wake(): void {
    if (this.#state.mode !== 'asleep') return;
    this.#set({ mode: 'normal', utilization: this.#state.utilization, resetsAt: null, reason: null });
  }

  /** The `brains.state` fields this governor owns. */
  summaryFields(): Pick<BrainsSummary, 'mode' | 'utilization' | 'resetsAt'> {
    return { mode: this.#state.mode, utilization: this.#state.utilization, resetsAt: this.#state.resetsAt };
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.removeAllListeners();
  }

  #sleep(reason: 'rate_limit' | 'auth', resetsAt: number | null, utilization: number | null): void {
    this.#set({ mode: 'asleep', utilization, resetsAt, reason });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (reason === 'auth') return;
    const wakeAt = resetsAt !== null ? resetsAt + this.#graceMs : this.#now() + UNKNOWN_RESET_SLEEP_MS;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#set({ mode: 'normal', utilization: null, resetsAt: null, reason: null });
      },
      Math.max(0, wakeAt - this.#now()),
    );
    this.#timer.unref?.();
  }

  #set(next: UsageState): void {
    const prev = this.#state;
    this.#state = next;
    if (
      prev.mode !== next.mode ||
      prev.utilization !== next.utilization ||
      prev.resetsAt !== next.resetsAt ||
      prev.reason !== next.reason
    ) {
      this.emit('change', next);
    }
  }
}
