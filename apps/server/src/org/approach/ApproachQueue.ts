/**
 * ApproachQueue (PLAN §6.4 "Agents come to the player").
 *
 * - One presenter at a time: the blocking card (question, plan) goes first, otherwise the oldest. The presenter gets
 *   `agent.approach` and the mod's ApproachPlayer reflex walks it to the player; queued agents wait silently behind
 *   the player showing "?". A presentation is never pre-empted.
 * - Hold: while the player is in combat (hostile within 12 blocks, or damage in the last 8 s) the card and chime
 *   are held.
 * - Ping instead of walking: night outside a lit area, a path over 48 blocks or one that needs digging, the player in
 *   another dimension, or the player inside a PC screen (the card shows in the border strip), or the agent's
 *   "Ping instead of walking over" setting.
 * - Later: `@ada later`, the Later key or walking away parks the card. It stays answerable; the agent returns after
 *   10 min, or when the player is idle within 16 blocks. A card auto-parks after 2 min without an answer or after
 *   2 min of player AFK.
 * - Seated agents ping by default ("? for Jasper" on the monitor). They walk over (`away_from_seat`) only when the
 *   player is within 24 blocks, not seated and not in combat; the chair stays reserved. After the answer they walk
 *   back and sit. The reservation expires after 3 min away; the card is kept.
 * - A running meeting wins: attendees do not approach; their cards are raised at the table during the floor.
 */

import type { OrgClock } from '../clock.js';
import { systemClock } from '../clock.js';

export type CardKind = 'question' | 'plan' | 'hire' | 'calendar';

export interface ApproachCard {
  readonly cardId: string;
  readonly agentId: string;
  readonly kind: CardKind;
  /** Epoch ms; older first. */
  readonly createdAt: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PlayerView {
  readonly pos: Vec3 | null;
  readonly dimension: string;
  /** A hostile mob within 12 blocks. */
  readonly hostileNearby: boolean;
  /** Epoch ms of the last damage taken. */
  readonly lastDamageAt: number | null;
  /** In PcControlScreen (or watching a PC). */
  readonly inPcScreen: boolean;
  /** Seated (at a PC or a meeting chair). */
  readonly seated: boolean;
  /** Epoch ms of the last player input. */
  readonly lastInputAt: number;
  /** Standing around, not busy (the mod's view); defaults to "no input for 10 s". */
  readonly idle?: boolean | undefined;
  readonly inLitArea?: boolean | undefined;
}

export interface AgentView {
  readonly pos: Vec3 | null;
  readonly dimension: string;
  /** Seated at a PC (meeting chairs do not count). */
  readonly seated: boolean;
  /** Path length to the player in blocks (null: unknown or no path). */
  readonly pathBlocks: number | null;
  readonly pathNeedsDigging: boolean;
  readonly inLitArea?: boolean | undefined;
}

export interface ApproachSnapshot {
  readonly player: PlayerView;
  readonly isNight: boolean;
  readonly agents: Readonly<Record<string, AgentView>>;
  /** Attendees of the running meeting (the meeting wins over approaching). */
  readonly meetingAttendees?: readonly string[] | undefined;
}

/** How the presenter brings its card. */
export type PresentMode =
  /** Walk to 2.5 blocks from the player, face, wave, chime once. */
  | 'approach'
  /** Seated agent walks over (away_from_seat); chair reserved. */
  | 'walk_from_seat'
  /** Toast, CrewHud "?" and an off-screen arrow (or the PC border strip). */
  | 'ping'
  /** Player in combat: card and chime held. */
  | 'hold'
  /** In a meeting: raised at the table during the floor. */
  | 'meeting';

export type PingReason =
  | 'night'
  | 'far'
  | 'digging'
  | 'dimension'
  | 'pc_screen'
  | 'setting'
  | 'seated'
  | 'no_path';

export interface Presentation {
  readonly agentId: string;
  readonly cardId: string;
  readonly mode: PresentMode;
  readonly reason?: PingReason | undefined;
}

export interface ApproachState {
  readonly presenter: Presentation | null;
  readonly queued: ReadonlyArray<{ agentId: string; cardId: string }>;
  readonly parked: ReadonlyArray<{ agentId: string; cardId: string; returnAt: number }>;
}

/** Effects; every method is optional. */
export interface ApproachEffects {
  /** `agent.approach{agentId, pendingId | null}`: walk to the player with this card, or stop. */
  approach?(agentId: string, cardId: string | null): void;
  /** Ping fallback (toast, CrewHud "?", off-screen arrow, or the PC border strip). */
  ping?(agentId: string, cardId: string, reason: PingReason): void;
  /** Seat actions for seated agents: reserve the chair and walk over, walk back and sit, or the reservation ended. */
  seat?(agentId: string, action: 'reserve_and_walk' | 'return' | 'expire'): void;
  parked?(agentId: string, cardId: string, returnAt: number): void;
  unparked?(agentId: string, cardId: string): void;
  state?(state: ApproachState): void;
}

export interface ApproachLimits {
  readonly combatDamageMs: number;
  readonly farPathBlocks: number;
  readonly autoParkMs: number;
  readonly afkParkMs: number;
  readonly parkReturnMs: number;
  readonly idleReturnBlocks: number;
  readonly seatedWalkBlocks: number;
  readonly awayReservationMs: number;
  /** The player "walked away" once this far from a presenter that had reached them. */
  readonly walkAwayBlocks: number;
  /** A presenter within this distance has reached the player. */
  readonly arrivedBlocks: number;
  readonly idleInputMs: number;
}

export const DEFAULT_APPROACH_LIMITS: ApproachLimits = {
  combatDamageMs: 8_000,
  farPathBlocks: 48,
  autoParkMs: 2 * 60_000,
  afkParkMs: 2 * 60_000,
  parkReturnMs: 10 * 60_000,
  idleReturnBlocks: 16,
  seatedWalkBlocks: 24,
  awayReservationMs: 3 * 60_000,
  walkAwayBlocks: 16,
  arrivedBlocks: 4,
  idleInputMs: 10_000,
};

interface CardEntry extends ApproachCard {
  parkedUntil: number | null;
}

interface Current {
  readonly agentId: string;
  readonly cardId: string;
  mode: PresentMode;
  reason?: PingReason | undefined;
  /** Time the card has been shown (excluding holds), for the 2-minute auto-park. */
  shownMs: number;
  lastTickAt: number;
  reachedPlayer: boolean;
  /** `agent.approach` with this card is in force. */
  approachSent: boolean;
}

const BLOCKING: ReadonlySet<CardKind> = new Set(['question', 'plan']);

function distance(a: Vec3 | null, b: Vec3 | null): number | null {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export class ApproachQueue {
  readonly #clock: OrgClock;
  readonly #fx: ApproachEffects;
  readonly #limits: ApproachLimits;
  readonly #cards = new Map<string, CardEntry>();
  readonly #pingPref = new Map<string, boolean>();
  /** Seated agents currently away from their seat to ask, with the time they left. */
  readonly #away = new Map<string, number>();
  #current: Current | null = null;
  #snapshot: ApproachSnapshot | null = null;
  #lastState = '';

  constructor(
    options: { clock?: OrgClock; effects?: ApproachEffects; limits?: Partial<ApproachLimits> } = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#fx = options.effects ?? {};
    this.#limits = { ...DEFAULT_APPROACH_LIMITS, ...options.limits };
  }

  // -------------------------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------------------------

  /** A new pending card (question, plan, hire or calendar approval). */
  enqueue(card: ApproachCard): void {
    this.#cards.set(card.cardId, { ...card, parkedUntil: null });
    this.#evaluate();
  }

  /** A card was answered, cancelled or denied (interrupt, kick, death, dismiss, world end). */
  resolve(cardId: string): void {
    const card = this.#cards.get(cardId);
    if (!card) return;
    this.#cards.delete(cardId);
    const cur = this.#current;
    if (cur && cur.cardId === cardId) {
      this.#current = null;
      this.#endPresentation(cur, 'answered');
    }
    this.#evaluate();
  }

  /** Drops every card of an agent (death, dismissal). */
  removeAgent(agentId: string): void {
    for (const c of [...this.#cards.values()]) if (c.agentId === agentId) this.#cards.delete(c.cardId);
    this.#away.delete(agentId);
    this.#pingPref.delete(agentId);
    if (this.#current?.agentId === agentId) {
      this.#fx.approach?.(agentId, null);
      this.#current = null;
    }
    this.#evaluate();
  }

  /**
   * `@ada later`, the Later key: parks the card the agent is presenting (else its front card). Returns false when
   * it had none.
   */
  later(agentId: string): boolean {
    const cur = this.#current;
    const presented = cur?.agentId === agentId ? this.#cards.get(cur.cardId) : undefined;
    const front = presented ?? this.#frontCard(agentId, false);
    if (!front) return false;
    this.#park(front);
    this.#evaluate();
    return true;
  }

  /**
   * Parks one card wherever it is in the queue (the player said "later" to that card in AgentScreen or chat). False
   * when the card is unknown or already parked.
   */
  park(cardId: string): boolean {
    const card = this.#cards.get(cardId);
    if (!card || (card.parkedUntil !== null && card.parkedUntil > this.#clock.now())) return false;
    this.#park(card);
    this.#evaluate();
    return true;
  }

  /**
   * Drops every card and the presentation without walking anyone anywhere (world end: the crew is gone; the caller
   * has already released the bodies). Ping settings are kept.
   */
  clear(): void {
    this.#cards.clear();
    this.#away.clear();
    this.#current = null;
    this.#pushState();
  }

  /** The cards known to the queue (for syncing with the card store). */
  get cardIds(): readonly string[] {
    return [...this.#cards.keys()];
  }

  /** The "Ping instead of walking over" setting. */
  setPingPreference(agentId: string, ping: boolean): void {
    this.#pingPref.set(agentId, ping);
    this.#evaluate();
  }

  /** The 1 Hz world view. Drives holds, fallbacks, parking and returns. */
  update(snapshot: ApproachSnapshot): void {
    this.#snapshot = snapshot;
    this.#evaluate();
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  get presenter(): Presentation | null {
    const c = this.#current;
    return c ? { agentId: c.agentId, cardId: c.cardId, mode: c.mode, reason: c.reason } : null;
  }

  state(): ApproachState {
    const now = this.#clock.now();
    const queued: Array<{ agentId: string; cardId: string }> = [];
    const parked: Array<{ agentId: string; cardId: string; returnAt: number }> = [];
    for (const agentId of this.#agentsWithCards()) {
      if (agentId === this.#current?.agentId) continue;
      const front = this.#frontCard(agentId, false);
      if (front) queued.push({ agentId, cardId: front.cardId });
    }
    for (const c of this.#cards.values()) {
      if (c.parkedUntil !== null && c.parkedUntil > now)
        parked.push({ agentId: c.agentId, cardId: c.cardId, returnAt: c.parkedUntil });
    }
    queued.sort((a, b) => this.#rank(a.agentId) - this.#rank(b.agentId));
    return { presenter: this.presenter, queued, parked };
  }

  isAway(agentId: string): boolean {
    return this.#away.has(agentId);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #agentsWithCards(): string[] {
    return [...new Set([...this.#cards.values()].map((c) => c.agentId))];
  }

  /** The agent's front card: blocking first, then oldest. Parked cards only when `includeParked`. */
  #frontCard(agentId: string, includeParked: boolean): CardEntry | null {
    const now = this.#clock.now();
    let best: CardEntry | null = null;
    for (const c of this.#cards.values()) {
      if (c.agentId !== agentId) continue;
      if (!includeParked && c.parkedUntil !== null && c.parkedUntil > now) continue;
      if (!best) {
        best = c;
        continue;
      }
      const cb = BLOCKING.has(c.kind);
      const bb = BLOCKING.has(best.kind);
      if (cb !== bb) {
        if (cb) best = c;
      } else if (c.createdAt < best.createdAt) {
        best = c;
      }
    }
    return best;
  }

  /** Lower is earlier: blocking cards first, then by age. */
  #rank(agentId: string): number {
    const front = this.#frontCard(agentId, false);
    if (!front) return Number.POSITIVE_INFINITY;
    return (BLOCKING.has(front.kind) ? 0 : 1e15) + front.createdAt;
  }

  #park(card: CardEntry): void {
    const returnAt = this.#clock.now() + this.#limits.parkReturnMs;
    card.parkedUntil = returnAt;
    this.#fx.parked?.(card.agentId, card.cardId, returnAt);
    const cur = this.#current;
    if (cur && cur.cardId === card.cardId) {
      this.#current = null;
      this.#endPresentation(cur, 'parked');
    }
  }

  #endPresentation(cur: Current, why: 'answered' | 'parked'): void {
    if (cur.approachSent) this.#fx.approach?.(cur.agentId, null);
    if (this.#away.has(cur.agentId)) {
      // An answered (or parked) seated agent walks back and sits, with no model swap.
      const more = why === 'answered' && this.#frontCard(cur.agentId, false);
      if (!more) {
        this.#away.delete(cur.agentId);
        this.#fx.seat?.(cur.agentId, 'return');
      }
    } else if (cur.mode === 'walk_from_seat') {
      this.#fx.seat?.(cur.agentId, 'return');
    }
  }

  #playerInCombat(p: PlayerView, now: number): boolean {
    return p.hostileNearby || (p.lastDamageAt !== null && now - p.lastDamageAt < this.#limits.combatDamageMs);
  }

  #playerIdle(p: PlayerView, now: number): boolean {
    return p.idle ?? now - p.lastInputAt >= this.#limits.idleInputMs;
  }

  /** How this agent should bring its card right now. */
  #modeFor(
    agentId: string,
    snap: ApproachSnapshot | null,
    now: number,
  ): { mode: PresentMode; reason?: PingReason } {
    if (!snap) return { mode: 'ping', reason: 'no_path' };
    if (snap.meetingAttendees?.includes(agentId)) return { mode: 'meeting' };
    const p = snap.player;
    const a = snap.agents[agentId];
    const combat = this.#playerInCombat(p, now);
    const pref = this.#pingPref.get(agentId) === true;
    if (a?.seated || this.#away.has(agentId)) {
      if (this.#away.has(agentId)) return combat ? { mode: 'hold' } : { mode: 'walk_from_seat' };
      const d = distance(a?.pos ?? null, p.pos);
      const sameDim = a?.dimension === p.dimension;
      if (
        !pref &&
        sameDim &&
        d !== null &&
        d <= this.#limits.seatedWalkBlocks &&
        !p.seated &&
        !combat &&
        !p.inPcScreen
      ) {
        return { mode: 'walk_from_seat' };
      }
      return { mode: 'ping', reason: p.inPcScreen ? 'pc_screen' : pref ? 'setting' : 'seated' };
    }
    if (combat) return { mode: 'hold' };
    if (pref) return { mode: 'ping', reason: 'setting' };
    if (!a || a.dimension !== p.dimension) return { mode: 'ping', reason: 'dimension' };
    if (p.inPcScreen) return { mode: 'ping', reason: 'pc_screen' };
    if (snap.isNight && !(a.inLitArea === true && p.inLitArea === true))
      return { mode: 'ping', reason: 'night' };
    if (a.pathNeedsDigging) return { mode: 'ping', reason: 'digging' };
    if (a.pathBlocks === null) return { mode: 'ping', reason: 'no_path' };
    if (a.pathBlocks > this.#limits.farPathBlocks) return { mode: 'ping', reason: 'far' };
    return { mode: 'approach' };
  }

  #evaluate(): void {
    const now = this.#clock.now();
    const snap = this.#snapshot;

    // Parked cards come back after 10 min, or when the player is idle within 16 blocks of the agent.
    for (const c of this.#cards.values()) {
      if (c.parkedUntil === null) continue;
      let back = c.parkedUntil <= now;
      if (!back && snap) {
        const a = snap.agents[c.agentId];
        const d = distance(a?.pos ?? null, snap.player.pos);
        back =
          d !== null &&
          a?.dimension === snap.player.dimension &&
          d <= this.#limits.idleReturnBlocks &&
          this.#playerIdle(snap.player, now) &&
          !this.#playerInCombat(snap.player, now);
      }
      if (back) {
        c.parkedUntil = null;
        this.#fx.unparked?.(c.agentId, c.cardId);
      }
    }

    // Reservation expiry for seated agents away asking.
    for (const [agentId, since] of [...this.#away]) {
      if (now - since >= this.#limits.awayReservationMs) {
        this.#away.delete(agentId);
        this.#fx.seat?.(agentId, 'expire');
        const cur = this.#current;
        if (cur?.agentId === agentId && cur.mode === 'walk_from_seat') cur.mode = 'approach';
      }
    }

    // The current presentation: auto-park and walk-away checks, then mode changes.
    const cur = this.#current;
    if (cur) {
      const card = this.#cards.get(cur.cardId);
      if (!card) {
        this.#current = null;
      } else {
        const elapsed = Math.max(0, now - cur.lastTickAt);
        cur.lastTickAt = now;
        if (cur.mode !== 'hold' && cur.mode !== 'meeting') cur.shownMs += elapsed;
        const p = snap?.player;
        const afk = p ? now - p.lastInputAt >= this.#limits.afkParkMs : false;
        let walkedAway = false;
        if (snap && p) {
          const d = distance(snap.agents[cur.agentId]?.pos ?? null, p.pos);
          if (d !== null && d <= this.#limits.arrivedBlocks) cur.reachedPlayer = true;
          walkedAway = cur.reachedPlayer && (d === null || d > this.#limits.walkAwayBlocks);
        }
        const next = this.#modeFor(cur.agentId, snap, now);
        if (next.mode === 'meeting') {
          // The meeting wins: the card is raised at the table instead, and the presenter slot goes to someone
          // else. The card stays queued (not parked) and is presented again after the meeting.
          this.#current = null;
          if (cur.approachSent) this.#fx.approach?.(cur.agentId, null);
        } else if (cur.shownMs >= this.#limits.autoParkMs || afk || walkedAway) {
          this.#park(card);
        } else if (next.mode !== cur.mode || next.reason !== cur.reason) {
          this.#apply(cur, next);
        }
      }
    }

    // Pick the next presenter. Nobody starts presenting to an AFK player (each card would be shown and auto-parked
    // a second later, one after another), and meeting attendees raise their cards at the table instead.
    const playerAfk = snap ? now - snap.player.lastInputAt >= this.#limits.afkParkMs : false;
    if (!this.#current && !playerAfk) {
      const attending = new Set(snap?.meetingAttendees ?? []);
      const candidates = this.#agentsWithCards()
        .filter((id) => !attending.has(id) && this.#frontCard(id, false) !== null)
        .sort((a, b) => this.#rank(a) - this.#rank(b));
      const agentId = candidates[0];
      if (agentId !== undefined) {
        const front = this.#frontCard(agentId, false) as CardEntry;
        const next: Current = {
          agentId,
          cardId: front.cardId,
          mode: 'ping',
          shownMs: 0,
          lastTickAt: now,
          reachedPlayer: false,
          approachSent: false,
        };
        this.#current = next;
        this.#apply(next, this.#modeFor(agentId, snap, now));
      }
    }
    this.#pushState();
  }

  #apply(cur: Current, next: { mode: PresentMode; reason?: PingReason }): void {
    cur.mode = next.mode;
    cur.reason = next.reason;
    switch (next.mode) {
      case 'approach':
      case 'walk_from_seat':
        if (next.mode === 'walk_from_seat' && !this.#away.has(cur.agentId)) {
          this.#away.set(cur.agentId, this.#clock.now());
          this.#fx.seat?.(cur.agentId, 'reserve_and_walk');
        }
        if (!cur.approachSent) {
          cur.approachSent = true;
          this.#fx.approach?.(cur.agentId, cur.cardId);
        }
        break;
      case 'ping':
      case 'meeting':
        if (cur.approachSent) {
          cur.approachSent = false;
          this.#fx.approach?.(cur.agentId, null);
        }
        if (next.mode === 'ping') this.#fx.ping?.(cur.agentId, cur.cardId, next.reason ?? 'far');
        break;
      case 'hold':
        // The mod's ApproachPlayer reflex holds by itself in combat; the card and chime wait.
        break;
    }
  }

  #pushState(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.#lastState) return;
    this.#lastState = key;
    this.#fx.state?.(state);
  }
}
