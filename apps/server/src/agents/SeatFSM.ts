/**
 * SeatFSM (PLAN §6.3): where an agent sits, as Node sees it.
 *
 * PC seats: `wandering → walking_to_seat → seated_pending_swap → seated → standing_pending_swap → wandering`, plus
 * `seated ⇄ away_from_seat` (the agent walked over to ask the player something; the chair stays reserved). Meeting
 * seats (`kind: 'meeting'`) skip the swap states: they never change the model and never count toward `maxSeated`.
 *
 * Every edge that ends PC access increments a monotonic `epoch` (stand, kick, PC taken, death, …); `seated ⇄
 * away_from_seat` does not. Queued inbox items, pending cards and in-flight `pc` calls carry the epoch and are
 * dropped or denied when it changed. The machine itself is synchronous and pure (an injected clock); callers
 * serialize the effects of a transition per agent with {@link Mutex}.
 */

import type { UnseatReason } from '@minevibe/protocol';
import { AWAY_RESERVATION_MS, SWAP_DEBOUNCE_MS } from './constants.js';

export type SeatState =
  | 'wandering'
  | 'walking_to_seat'
  | 'seated_pending_swap'
  | 'seated'
  | 'away_from_seat'
  | 'standing_pending_swap';

export type SeatKind = 'pc' | 'meeting';

export type SeatTargetRef =
  | { readonly kind: 'pc'; readonly pcId: string }
  | { readonly kind: 'meeting'; readonly meetingId: string };

/** Edges that end a seat: the protocol's unseat reasons plus a failed sit job. */
export type SeatEndReason = UnseatReason | 'sit_failed';

/** Reasons that swap back to Haiku at the next boundary with no debounce (PLAN §6.3 "Kick, damage, …"). */
const NO_DEBOUNCE: ReadonlySet<SeatEndReason> = new Set([
  'kick',
  'damage',
  'survival',
  'death',
  'pc_down',
  'world_end',
  'dismiss',
  'app_restart',
  'worker_restart',
  'player_took',
  'reservation_expired',
]);

export interface SeatSnapshot {
  readonly state: SeatState;
  readonly kind: SeatKind | null;
  /** The PC sat at (or walked to, or away from). */
  readonly pcId: string | null;
  readonly meetingId: string | null;
  readonly epoch: number;
  /** When the current state began. */
  readonly since: number;
  /** `sit_at_pc{purpose}` (the kickoff task). */
  readonly purpose: string | null;
  /** The sit job. */
  readonly jobId: string | null;
  /** Until when the model stays on Opus after standing (debounce for a quick re-sit). */
  readonly debounceUntil: number;
  /** The PC the last stand left, for the debounce. */
  readonly lastPcId: string | null;
  /** When the away reservation expires (`away_from_seat` only). */
  readonly awayExpiresAt: number | null;
  /** Why the last seat ended. */
  readonly lastEnd: SeatEndReason | null;
}

export interface SeatTransition {
  readonly from: SeatState;
  readonly to: SeatState;
  readonly edge: string;
  readonly epochBefore: number;
  readonly epoch: number;
  readonly snapshot: SeatSnapshot;
}

export class SeatTransitionError extends Error {
  constructor(edge: string, state: SeatState) {
    super(`seat: ${edge} is not allowed from ${state}`);
    this.name = 'SeatTransitionError';
  }
}

export class SeatFSM {
  #s: SeatSnapshot;
  readonly #now: () => number;
  readonly #debounceMs: number;
  readonly #awayMs: number;

  constructor(options: { now?: () => number; epoch?: number; debounceMs?: number; awayMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#debounceMs = options.debounceMs ?? SWAP_DEBOUNCE_MS;
    this.#awayMs = options.awayMs ?? AWAY_RESERVATION_MS;
    this.#s = {
      state: 'wandering',
      kind: null,
      pcId: null,
      meetingId: null,
      epoch: options.epoch ?? 0,
      since: this.#now(),
      purpose: null,
      jobId: null,
      debounceUntil: 0,
      lastPcId: null,
      awayExpiresAt: null,
      lastEnd: null,
    };
  }

  get snapshot(): SeatSnapshot {
    return this.#s;
  }

  get state(): SeatState {
    return this.#s.state;
  }

  get epoch(): number {
    return this.#s.epoch;
  }

  /** At a PC with tool access: `seated` on a PC seat. */
  get hasPcAccess(): boolean {
    return this.#s.state === 'seated' && this.#s.kind === 'pc';
  }

  /** Counts toward `maxSeated` (a PC seat that is coming, pending, seated or away). */
  get holdsPcSeat(): boolean {
    return (
      this.#s.kind === 'pc' &&
      (this.#s.state === 'walking_to_seat' ||
        this.#s.state === 'seated_pending_swap' ||
        this.#s.state === 'seated' ||
        this.#s.state === 'away_from_seat')
    );
  }

  /** Whether the brain should run on Opus right now (seated at a PC, or within the stand debounce). */
  wantsOpus(now = this.#now()): boolean {
    const s = this.#s;
    if (
      s.kind === 'pc' &&
      (s.state === 'seated_pending_swap' || s.state === 'seated' || s.state === 'away_from_seat')
    ) {
      return true;
    }
    return now < s.debounceUntil;
  }

  /** `wandering → walking_to_seat` (also from `standing_pending_swap`: a quick re-sit in the same turn). */
  beginSit(
    target: SeatTargetRef,
    options: { purpose?: string | null; jobId?: string | null } = {},
  ): SeatTransition {
    const from = this.#s.state;
    if (from !== 'wandering' && from !== 'standing_pending_swap') throw new SeatTransitionError('sit', from);
    return this.#go('sit', {
      state: 'walking_to_seat',
      kind: target.kind,
      pcId: target.kind === 'pc' ? target.pcId : null,
      meetingId: target.kind === 'meeting' ? target.meetingId : null,
      purpose: options.purpose ?? null,
      jobId: options.jobId ?? null,
      awayExpiresAt: null,
    });
  }

  /** The sit job ended without a seat (`walking_to_seat → wandering`, epoch +1). */
  sitFailed(): SeatTransition {
    if (this.#s.state !== 'walking_to_seat') throw new SeatTransitionError('sit_failed', this.#s.state);
    return this.#go('sit_failed', this.#cleared('sit_failed'), true);
  }

  /** The body sat down: PC seats wait for the swap at the next turn boundary; meeting seats are seated at once. */
  arrived(): SeatTransition {
    if (this.#s.state !== 'walking_to_seat') throw new SeatTransitionError('arrived', this.#s.state);
    return this.#go('arrived', { state: this.#s.kind === 'pc' ? 'seated_pending_swap' : 'seated' });
  }

  /**
   * A turn boundary after any swap was applied: `seated_pending_swap → seated`, `standing_pending_swap → wandering`.
   * Returns null when nothing was pending.
   */
  boundary(): SeatTransition | null {
    if (this.#s.state === 'seated_pending_swap') return this.#go('boundary', { state: 'seated' });
    if (this.#s.state === 'standing_pending_swap') {
      return this.#go('boundary', { state: 'wandering', kind: null, pcId: null, meetingId: null });
    }
    return null;
  }

  /**
   * Leaves a seat for `reason` (stand, kick, damage, survival, pc_down, meeting, …). PC seats go through
   * `standing_pending_swap` (the model swaps back at the next boundary); a walk to a seat or a meeting seat ends at
   * `wandering`. The epoch always increments. `debounceMs` overrides the re-sit debounce (meetings stretch it to the
   * meeting length plus 2 min).
   */
  stand(reason: SeatEndReason, options: { debounceMs?: number } = {}): SeatTransition {
    const s = this.#s;
    if (s.state === 'wandering' || s.state === 'standing_pending_swap')
      throw new SeatTransitionError(reason, s.state);
    if (s.kind === 'pc' && s.state !== 'walking_to_seat') {
      const debounce = NO_DEBOUNCE.has(reason) ? 0 : (options.debounceMs ?? this.#debounceMs);
      return this.#go(
        reason,
        {
          state: 'standing_pending_swap',
          debounceUntil: debounce > 0 ? this.#now() + debounce : 0,
          lastPcId: s.pcId,
          awayExpiresAt: null,
          lastEnd: reason,
        },
        true,
      );
    }
    return this.#go(reason, this.#cleared(reason), true);
  }

  /** `seated → away_from_seat`: walking over to ask the player; the chair stays reserved (no epoch change). */
  goAway(): SeatTransition {
    if (this.#s.state !== 'seated' || this.#s.kind !== 'pc')
      throw new SeatTransitionError('away', this.#s.state);
    return this.#go('away', { state: 'away_from_seat', awayExpiresAt: this.#now() + this.#awayMs });
  }

  /** `away_from_seat → seated`: answered and sat back down; no swap, no epoch change. */
  comeBack(): SeatTransition {
    if (this.#s.state !== 'away_from_seat') throw new SeatTransitionError('back', this.#s.state);
    return this.#go('back', { state: 'seated', awayExpiresAt: null });
  }

  /** Whether the away reservation has expired. */
  awayExpired(now = this.#now()): boolean {
    return (
      this.#s.state === 'away_from_seat' && this.#s.awayExpiresAt !== null && now >= this.#s.awayExpiresAt
    );
  }

  /**
   * Everyone loads unseated after an app restart; death, dismissal and world end also land here. Any state →
   * `wandering`, epoch +1, no debounce.
   */
  reset(reason: SeatEndReason): SeatTransition {
    return this.#go(reason, { ...this.#cleared(reason), debounceUntil: 0 }, true);
  }

  /**
   * Worker restart: the mod's PcRegistry says the agent sits at `pcId`. Rebuilds `seated` with the reported epoch
   * (never lower than ours).
   */
  restoreSeated(pcId: string, epoch: number): SeatTransition {
    const next = Math.max(epoch, this.#s.epoch);
    const t = this.#go('restore', {
      state: 'seated',
      kind: 'pc',
      pcId,
      meetingId: null,
      awayExpiresAt: null,
    });
    this.#s = { ...this.#s, epoch: next };
    return { ...t, epoch: next, snapshot: this.#s };
  }

  #cleared(reason: SeatEndReason): Partial<SeatSnapshot> {
    return {
      state: 'wandering',
      kind: null,
      pcId: null,
      meetingId: null,
      purpose: null,
      jobId: null,
      awayExpiresAt: null,
      lastEnd: reason,
    };
  }

  #go(edge: string, patch: Partial<SeatSnapshot>, bumpEpoch = false): SeatTransition {
    const before = this.#s;
    const epoch = bumpEpoch ? before.epoch + 1 : before.epoch;
    this.#s = { ...before, ...patch, epoch, since: this.#now() };
    return {
      from: before.state,
      to: this.#s.state,
      edge,
      epochBefore: before.epoch,
      epoch,
      snapshot: this.#s,
    };
  }
}

/** A minimal async mutex: transitions and their effects are serialized per agent. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Runs `fn` after every earlier `run` finished (successfully or not). */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
