/**
 * SeatFSM (PLAN §6.3): where an agent sits, as Node sees it.
 *
 * PC seats: `wandering → walking_to_seat → seated_pending_handoff → seated → standing_pending_handoff → wandering`,
 * plus `seated ⇄ away_from_seat` (the agent walked over to ask the player something; the chair stays reserved). The
 * two `pending_handoff` states are the turn boundaries between the agent's two sessions (dual sessions, PLAN §6.1):
 * the body's sit turn ends before its desk session takes over, and the desk's last turn ends before the body gets the
 * DESK REPORT. Meeting seats (`kind: 'meeting'`) skip them: the body session sits at the meeting table itself, and
 * they never count toward `maxSeated`.
 *
 * Every edge that ends PC access increments a monotonic `epoch` (stand, kick, PC taken, death, …); `seated ⇄
 * away_from_seat` does not. Queued inbox items, pending cards and in-flight `pc` calls carry the epoch and are
 * dropped or denied when it changed. The machine itself is synchronous and pure (an injected clock); callers
 * serialize the effects of a transition per agent with {@link Mutex}.
 */

import type { UnseatReason } from '@minevibe/protocol';
import { AWAY_RESERVATION_MS } from './constants.js';

export type SeatState =
  | 'wandering'
  | 'walking_to_seat'
  | 'seated_pending_handoff'
  | 'seated'
  | 'away_from_seat'
  | 'standing_pending_handoff';

export type SeatKind = 'pc' | 'meeting';

export type SeatTargetRef =
  | { readonly kind: 'pc'; readonly pcId: string }
  | { readonly kind: 'meeting'; readonly meetingId: string };

/** Edges that end a seat: the protocol's unseat reasons plus a failed sit job. */
export type SeatEndReason = UnseatReason | 'sit_failed';

export interface SeatSnapshot {
  readonly state: SeatState;
  readonly kind: SeatKind | null;
  /** The PC sat at (or walked to, or away from, or just left while its desk session finishes). */
  readonly pcId: string | null;
  readonly meetingId: string | null;
  readonly epoch: number;
  /** When the current state began. */
  readonly since: number;
  /** `sit_at_pc{purpose}` (the handoff's task). */
  readonly purpose: string | null;
  /** The sit job. */
  readonly jobId: string | null;
  /** The PC the last stand left. */
  readonly lastPcId: string | null;
  /** When the away reservation expires (`away_from_seat` only). */
  readonly awayExpiresAt: number | null;
  /** Why the last seat ended. */
  readonly lastEnd: SeatEndReason | null;
  /**
   * Why the last PC seat a desk session owned ended (pending handoff, seated or away). Unlike {@link lastEnd} a later
   * seat leaves it alone (a meeting chair refused right after a meeting pull), so the desk's DESK REPORT names its
   * own end. Absent until a PC seat ended.
   */
  readonly lastPcEnd?: SeatEndReason | null | undefined;
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

/** The PC seat states in which the desk session owns the agent (the chair is held). */
const DESK_STATES: ReadonlySet<SeatState> = new Set(['seated_pending_handoff', 'seated', 'away_from_seat']);

export class SeatFSM {
  #s: SeatSnapshot;
  readonly #now: () => number;
  readonly #awayMs: number;

  constructor(options: { now?: () => number; epoch?: number; awayMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
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
    return this.#s.kind === 'pc' && (this.#s.state === 'walking_to_seat' || DESK_STATES.has(this.#s.state));
  }

  /**
   * The PC whose desk session should own the agent now: the body sat down there (pending handoff, seated, or away
   * asking the player), or null. A desk session whose PC is no longer this one hands back to the body.
   */
  get deskPc(): string | null {
    return this.#s.kind === 'pc' && DESK_STATES.has(this.#s.state) ? this.#s.pcId : null;
  }

  /** `wandering → walking_to_seat` (also from `standing_pending_handoff`: a re-sit before the boundary). */
  beginSit(
    target: SeatTargetRef,
    options: { purpose?: string | null; jobId?: string | null } = {},
  ): SeatTransition {
    const from = this.#s.state;
    if (from !== 'wandering' && from !== 'standing_pending_handoff')
      throw new SeatTransitionError('sit', from);
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

  /**
   * The body sat down: PC seats wait for the handoff to the desk session at the next turn boundary; meeting seats are
   * seated at once (the body session sits there itself).
   */
  arrived(): SeatTransition {
    if (this.#s.state !== 'walking_to_seat') throw new SeatTransitionError('arrived', this.#s.state);
    return this.#go('arrived', { state: this.#s.kind === 'pc' ? 'seated_pending_handoff' : 'seated' });
  }

  /**
   * A turn boundary after the handoff ran: `seated_pending_handoff → seated` (the desk session took over),
   * `standing_pending_handoff → wandering` (the body session took back). Returns null when nothing was pending.
   */
  boundary(): SeatTransition | null {
    if (this.#s.state === 'seated_pending_handoff') return this.#go('boundary', { state: 'seated' });
    if (this.#s.state === 'standing_pending_handoff') {
      return this.#go('boundary', { state: 'wandering', kind: null, pcId: null, meetingId: null });
    }
    return null;
  }

  /**
   * Leaves a seat for `reason` (stand, kick, damage, survival, pc_down, meeting, …). PC seats go through
   * `standing_pending_handoff` (the desk session's turn ends, then the body takes back at the boundary); a walk to a
   * seat or a meeting seat ends at `wandering`. The epoch always increments.
   */
  stand(reason: SeatEndReason): SeatTransition {
    const s = this.#s;
    if (s.state === 'wandering' || s.state === 'standing_pending_handoff')
      throw new SeatTransitionError(reason, s.state);
    if (s.kind === 'pc' && s.state !== 'walking_to_seat') {
      return this.#go(
        reason,
        {
          state: 'standing_pending_handoff',
          lastPcId: s.pcId,
          awayExpiresAt: null,
          lastEnd: reason,
          lastPcEnd: reason,
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

  /** `away_from_seat → seated`: answered and sat back down; no handoff, no epoch change. */
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
   * `wandering`, epoch +1.
   */
  reset(reason: SeatEndReason): SeatTransition {
    const desk = this.deskPc !== null;
    return this.#go(
      reason,
      {
        ...this.#cleared(reason),
        lastPcId: this.#s.pcId ?? this.#s.lastPcId,
        ...(desk ? { lastPcEnd: reason } : {}),
      },
      true,
    );
  }

  /**
   * Worker restart: the mod's PcRegistry says the agent sits at `pcId`. Rebuilds `seated_pending_handoff` with the
   * reported epoch (never lower than ours): the next boundary hands over to that PC's desk session.
   */
  restoreSeated(pcId: string, epoch: number): SeatTransition {
    const next = Math.max(epoch, this.#s.epoch);
    const t = this.#go('restore', {
      state: 'seated_pending_handoff',
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
