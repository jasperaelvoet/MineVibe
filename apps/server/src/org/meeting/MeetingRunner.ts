/**
 * MeetingRunner (PLAN §6.6 "Meetings"): one meeting at a time; later ones queue for up to 10 min, then are missed.
 *
 * 1. Who attends: player-created meetings invite everyone, seated agents included (interrupted at their next tool
 *    boundary with a handoff note, chair kept reserved, swap debounce stretched to the meeting plus 2 min).
 *    Agent-created meetings excuse seated agents.
 * 2. Gathering (≤ 120 s): path ETAs at fire time. ETA > 90 s, another dimension, or escorting a player > 64 blocks
 *    from the table → dial in; escorts within 32 blocks of the player stay with the player. Quorum is the CEO plus
 *    one (another attendee, or the player within 16 blocks); without it the meeting is postponed once, then missed.
 *    Scheduled meetings are postponed (up to 1 game hour, then missed) while the player is under 50% HP, in combat,
 *    or > 64 blocks from the table at night. Usage Asleep postpones until `resetsAt`; Tired uses a short format.
 * 3. Agenda, one speaker at a time through the brain (interactive lane):
 *    open (CEO states the agenda) → updates (≤ 3 sentences each, running minutes as context; "quick standup"
 *    renders updates at zero tokens and gives turns only to agents with blockers) → floor (an unmentioned player
 *    message wakes only the chair, which names ≤ 2 responders; skipped after 30 s without a message) → wrap-up
 *    (the CEO summarises; action items go to the calendar, minutes to the Codex).
 * 4. Caps: 10 real minutes; ended by the HUD End button or exactly `@meeting end`.
 * 5. Deaths: a dead attendee drops out; if the chair dies the player chairs when within 16 blocks, otherwise the
 *    meeting adjourns with partial minutes written by Node at zero tokens.
 * 6. Overlaps: attendees' pending cards are raised at the table during the floor; their tasks are deferred until
 *    dismissal. 7. Dismissal: agents resume; seated ones return to their reserved PC.
 *
 * Everything the runner needs from the world and the agent runtime comes through small injected interfaces, so the
 * whole flow runs in tests with a scripted brain and a manual clock.
 */

import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { CalendarAddInput, CalendarService } from '../calendar/CalendarService.js';
import type { OccurrenceStatus } from '../calendar/types.js';
import { type OrgClock, sleep, systemClock } from '../clock.js';
import type { CodexStore } from '../codex/CodexStore.js';
import { type ControlNonce, sanitizeTitle, singleLine, wrapNote } from '../envelope.js';

export type MeetingPhase = 'gathering' | 'open' | 'updates' | 'floor' | 'wrapup' | 'done';

export type AttendeeMode = 'walking' | 'present' | 'dial_in' | 'absent' | 'excused' | 'left';

export interface MeetingAttendee {
  readonly agentId: string;
  readonly name: string;
  mode: AttendeeMode;
  /** Why dialled in / absent / excused / left: eta, dimension, escort, late, dead, dismissed, seated, died. */
  reason?: string | undefined;
  etaSec?: number | null | undefined;
  /** Was seated at a PC when called (returns to it at dismissal). */
  wasSeated: boolean;
}

/** The `meeting.state` push. */
export interface MeetingState {
  readonly id: string;
  readonly title: string;
  readonly eventId?: string | undefined;
  readonly phase: MeetingPhase;
  readonly attendees: readonly MeetingAttendee[];
  readonly speaker: string | null;
  /** Agent id, `player`, or null before the meeting opens. */
  readonly chair: string | null;
  readonly format: MeetingFormat;
  readonly startedAt: number;
}

/** `full`; `short` (Tired: one round, no floor); `quick` (zero-token standup, blockers only). */
export type MeetingFormat = 'full' | 'short' | 'quick';

export interface MeetingCrewMember {
  readonly agentId: string;
  readonly name: string;
  readonly status: 'alive' | 'dead' | 'dismissed';
  readonly isCeo: boolean;
  /** Seated at a PC (meeting chairs do not count). */
  readonly seated: boolean;
  readonly dimension: string;
  readonly escortingPlayer: boolean;
  /** Blocks to the player (null: other dimension or unknown). */
  readonly distanceToPlayer: number | null;
}

export interface PlayerSnapshot {
  readonly hpFraction: number;
  readonly inCombat: boolean;
  /** Blocks to the meeting table (null: other dimension or no table). */
  readonly distanceToTable: number | null;
  readonly isNight: boolean;
}

export interface StatusLine {
  readonly todo: readonly string[];
  readonly lastActivity: string;
  readonly blocker?: string | undefined;
}

/** World and crew queries (from the mod's 1 Hz state and the agent runtime). */
export interface MeetingWorld {
  crew(): readonly MeetingCrewMember[];
  /** Path ETA to the meeting table in seconds; null when unreachable. */
  etaSeconds(agentId: string): number | null;
  tableDimension(): string;
  player(): PlayerSnapshot;
  usage(): { state: 'ok' | 'tired' | 'asleep'; resetsAt?: number | undefined };
  /** For the quick standup: the agent's todo list, last activity line and blocker, at zero tokens. */
  statusLine?(agentId: string): StatusLine;
}

/** Effects on the world and the crew. Every method is optional. */
export interface MeetingEffects {
  state?(state: MeetingState): void;
  /** Walk to the table and sit (reflex 38). */
  gather?(agentId: string, meetingId: string): void;
  /** Seated agent: interrupt at the next tool boundary, write a handoff note, keep the chair reserved. */
  interruptSeated?(agentId: string, meetingId: string): void;
  stretchSwapDebounce?(agentId: string, ms: number): void;
  dialIn?(agentId: string, meetingId: string, reason: string): void;
  dismiss?(agentId: string, info: { returnToPc: boolean }): void;
  toast?(text: string): void;
  /** Compass marker for the player (null clears it). */
  marker?(meetingId: string | null): void;
  /** Raise attendees' pending cards at the table (floor phase; the meeting wins over ApproachPlayer). */
  raiseCards?(agentIds: readonly string[]): void;
  /** Speech bubble. */
  say?(agentId: string, text: string): void;
}

export type MeetingTurnKind = 'open' | 'update' | 'floor_chair' | 'floor_reply' | 'wrapup';

export interface MeetingTurnRequest {
  readonly meetingId: string;
  readonly kind: MeetingTurnKind;
  readonly agentId: string;
  /** Node-made context: a nonce-tagged headline plus the running minutes in a data envelope. */
  readonly prompt: string;
  readonly maxSentences: number;
  readonly playerMessage?: string | undefined;
  /** floor_chair: who may be named as responders. */
  readonly candidates?: readonly string[] | undefined;
}

export interface MeetingActionItem {
  readonly title: string;
  readonly assignee: string;
  readonly task?: string | undefined;
  /** Calendar `when` (default "now": delivered at dismissal). */
  readonly when?: string | undefined;
}

export interface MeetingTurnResult {
  readonly text: string;
  /** floor_chair: at most 2 attendees to respond. */
  readonly responders?: readonly string[] | undefined;
  /** wrapup. */
  readonly summary?: string | undefined;
  readonly actionItems?: readonly MeetingActionItem[] | undefined;
}

/** Runs one meeting turn for an agent (through the interactive lane). Abort means: stop, the meeting moved on. */
export interface MeetingBrain {
  turn(request: MeetingTurnRequest, signal: AbortSignal): Promise<MeetingTurnResult>;
}

export interface MeetingRequest {
  readonly title: string;
  /** `all` or agent ids. */
  readonly attendees: readonly string[] | 'all';
  /** `player` or the creating agent's id. */
  readonly createdBy: string;
  /** From a calendar event (safety postponement applies); false for "Start meeting now". */
  readonly scheduled: boolean;
  readonly eventId?: string | undefined;
  readonly occurrence?: number | undefined;
  readonly quick?: boolean | undefined;
  /** "Start meeting now" with the player chairing. */
  readonly playerChairs?: boolean | undefined;
}

export interface MeetingLimits {
  readonly gatherMaxMs: number;
  readonly dialInEtaSec: number;
  readonly escortTableBlocks: number;
  readonly escortPlayerBlocks: number;
  readonly playerScopeBlocks: number;
  readonly safetyTableBlocks: number;
  readonly safetyMaxMs: number;
  readonly safetyRecheckMs: number;
  readonly quorumRetryMs: number;
  readonly maxDurationMs: number;
  readonly floorIdleMs: number;
  readonly turnTimeoutMs: number;
  readonly queueMaxMs: number;
  readonly asleepMaxMs: number;
  readonly wrapupReserveMs: number;
  readonly maxResponders: number;
}

export const DEFAULT_MEETING_LIMITS: MeetingLimits = {
  gatherMaxMs: 120_000,
  dialInEtaSec: 90,
  escortTableBlocks: 64,
  escortPlayerBlocks: 32,
  playerScopeBlocks: 16,
  safetyTableBlocks: 64,
  /** One game hour at 20 TPS. */
  safetyMaxMs: 50_000,
  safetyRecheckMs: 5_000,
  quorumRetryMs: 120_000,
  maxDurationMs: 10 * 60_000,
  floorIdleMs: 30_000,
  turnTimeoutMs: 90_000,
  queueMaxMs: 10 * 60_000,
  asleepMaxMs: 3 * 3_600_000,
  wrapupReserveMs: 90_000,
  maxResponders: 2,
};

export interface MeetingRunnerOptions {
  readonly world: MeetingWorld;
  readonly brain: MeetingBrain;
  readonly nonce: ControlNonce;
  readonly effects?: MeetingEffects | undefined;
  readonly codex?: Pick<CodexStore, 'write'> | undefined;
  readonly calendar?:
    | Pick<CalendarService, 'add' | 'recordOccurrence' | 'meetingEnded' | 'gameTicks'>
    | undefined;
  /** "Day 3 08:00" for minutes titles. */
  readonly formatNow?: (() => string) | undefined;
  readonly clock?: OrgClock | undefined;
  readonly playerName?: string | undefined;
  readonly limits?: Partial<MeetingLimits> | undefined;
  readonly logger?: Logger | undefined;
}

export type MeetingOutcome =
  | { readonly status: 'held'; readonly minutesId: string | null; readonly attended: readonly string[] }
  | { readonly status: 'adjourned'; readonly reason: string; readonly minutesId: string | null }
  | { readonly status: 'missed'; readonly reason: string };

interface Pending {
  readonly id: string;
  readonly request: MeetingRequest;
  readonly queuedAt: number;
}

interface Active {
  readonly id: string;
  readonly request: MeetingRequest;
  phase: MeetingPhase;
  attendees: Map<string, MeetingAttendee>;
  chair: string | null;
  speaker: string | null;
  format: MeetingFormat;
  startedAt: number;
  minutes: string[];
  readonly abort: AbortController;
  turnAbort: AbortController | null;
  floorQueue: string[];
  ended: string | null;
  waker: (() => void) | null;
  capTimer: unknown;
}

class EndMeeting extends Error {}

function clipSentences(text: string, max: number): string {
  const flat = singleLine(text, 1200);
  const parts = flat.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
  const out = parts.slice(0, max).join(' ');
  return out.length > 600 ? `${out.slice(0, 599)}…` : out;
}

const PRESENT_MODES: ReadonlySet<AttendeeMode> = new Set(['walking', 'present', 'dial_in']);

export class MeetingRunner {
  readonly #world: MeetingWorld;
  readonly #brain: MeetingBrain;
  readonly #nonce: ControlNonce;
  readonly #fx: MeetingEffects;
  readonly #codex: MeetingRunnerOptions['codex'];
  readonly #calendar: MeetingRunnerOptions['calendar'];
  readonly #formatNow: () => string;
  readonly #clock: OrgClock;
  readonly #player: string;
  readonly #limits: MeetingLimits;
  readonly #log: Logger | undefined;

  #active: Active | null = null;
  /** Aborts the waits before a meeting starts (usage asleep, safety postponement). */
  #preStart: AbortController | null = null;
  #queue: Pending[] = [];
  #running: Promise<void> | null = null;
  readonly #outcomes = new Map<string, MeetingOutcome>();
  readonly #waiters = new Map<string, Array<(o: MeetingOutcome) => void>>();

  constructor(options: MeetingRunnerOptions) {
    this.#world = options.world;
    this.#brain = options.brain;
    this.#nonce = options.nonce;
    this.#fx = options.effects ?? {};
    this.#codex = options.codex;
    this.#calendar = options.calendar;
    this.#formatNow = options.formatNow ?? (() => new Date(this.#clock.now()).toISOString().slice(0, 16));
    this.#clock = options.clock ?? systemClock;
    this.#player = options.playerName ?? 'the player';
    this.#limits = { ...DEFAULT_MEETING_LIMITS, ...options.limits };
    this.#log = options.logger;
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  get active(): MeetingState | null {
    return this.#active ? this.#snapshot(this.#active) : null;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** In the active meeting (walking, at the table or dialled in): tasks for them are deferred. */
  isAttending(agentId: string): boolean {
    const m = this.#active;
    if (!m || m.phase === 'done') return false;
    const a = m.attendees.get(agentId);
    return a !== undefined && PRESENT_MODES.has(a.mode);
  }

  /** Everyone attending the active meeting (walking, at the table or dialled in), from gathering to wrap-up. */
  attendeeIds(): string[] {
    const m = this.#active;
    if (!m || m.phase === 'done') return [];
    return [...m.attendees.values()].filter((a) => PRESENT_MODES.has(a.mode)).map((a) => a.agentId);
  }

  /** The ChatRouter's meeting scope (PLAN §6.5): unmentioned lines go to the meeting while the player is in scope. */
  chatScope(): {
    meetingId: string;
    attendees: string[];
    chairId: string | null;
    playerInScope: boolean;
  } | null {
    const m = this.#active;
    if (!m || m.phase === 'gathering' || m.phase === 'done') return null;
    const d = this.#world.player().distanceToTable;
    return {
      meetingId: m.id,
      attendees: [...m.attendees.values()].filter((a) => PRESENT_MODES.has(a.mode)).map((a) => a.agentId),
      chairId: m.chair === 'player' ? null : m.chair,
      playerInScope: m.chair === 'player' || (d !== null && d <= this.#limits.playerScopeBlocks),
    };
  }

  /** "Start meeting now" first lists each attendee's ETA. */
  previewEtas(): Array<{
    agentId: string;
    name: string;
    etaSec: number | null;
    mode: AttendeeMode;
    reason?: string;
  }> {
    return this.#plan({ title: 'preview', attendees: 'all', createdBy: 'player', scheduled: false }).map(
      (a) => ({
        agentId: a.agentId,
        name: a.name,
        etaSec: a.etaSec ?? null,
        mode: a.mode,
        reason: a.reason,
      }),
    );
  }

  /** Resolves with the outcome of a meeting (for tests and the calendar). */
  outcome(meetingId: string): Promise<MeetingOutcome> {
    const known = this.#outcomes.get(meetingId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = this.#waiters.get(meetingId) ?? [];
      list.push(resolve);
      this.#waiters.set(meetingId, list);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------------------------

  /** Queues a meeting (from a calendar firing or "Start meeting now"). Returns its id. */
  request(request: MeetingRequest): string {
    const id = `mt-${randomBytes(4).toString('hex')}`;
    this.#queue.push({ id, request, queuedAt: this.#clock.now() });
    if (this.#active || this.#running)
      this.#fx.toast?.(`Meeting "${sanitizeTitle(request.title)}" is queued behind the current one`);
    this.#pump();
    return id;
  }

  /** An unmentioned player message during the meeting. Returns false when it is not for the meeting. */
  playerMessage(text: string): boolean {
    const m = this.#active;
    if (!m || m.phase === 'gathering' || m.phase === 'done') return false;
    const line = singleLine(text, 600);
    if (!line) return false;
    m.minutes.push(`${this.#player}: ${line}`);
    if (m.phase === 'floor') {
      m.floorQueue.push(line);
      m.waker?.();
    }
    return true;
  }

  /** HUD End button or exactly `@meeting end`. */
  end(reason = 'ended by the player'): void {
    const m = this.#active;
    if (!m || m.ended) return;
    m.ended = reason;
    m.turnAbort?.abort(new EndMeeting(reason));
    m.abort.abort(new EndMeeting(reason));
    m.waker?.();
  }

  /**
   * Cancels everything: the active meeting adjourns, a meeting still waiting to start (usage asleep, safety
   * postponement) and every queued one are missed. For world death and shutdown, so nothing from a dead world
   * runs in the next one.
   */
  cancelAll(reason: string): void {
    for (const p of this.#queue.splice(0)) this.#finish(p, { status: 'missed', reason });
    this.#preStart?.abort(new EndMeeting(reason));
    this.end(reason);
  }

  /** An agent sat down at the table. */
  arrived(agentId: string): void {
    const a = this.#active?.attendees.get(agentId);
    if (a && a.mode === 'walking') {
      a.mode = 'present';
      this.#push();
      this.#active?.waker?.();
    }
  }

  /** An attendee died (or was dismissed): drops out of the speaker order; the chair is replaced or the meeting adjourns. */
  agentDied(agentId: string): void {
    const m = this.#active;
    if (!m) return;
    const a = m.attendees.get(agentId);
    if (a && a.mode !== 'absent') {
      a.mode = 'left';
      a.reason = 'died';
    }
    if (m.speaker === agentId) m.turnAbort?.abort(new Error('speaker died'));
    if (m.chair === agentId) {
      const d = this.#world.player().distanceToTable;
      if (d !== null && d <= this.#limits.playerScopeBlocks) {
        m.chair = 'player';
        m.minutes.push(`(${a?.name ?? agentId} died; ${this.#player} chairs.)`);
        this.#fx.toast?.(`${a?.name ?? 'The chair'} died. You chair the meeting.`);
      } else {
        m.minutes.push(`(${a?.name ?? agentId} died; the meeting adjourns.)`);
        this.end('the chair died');
      }
    }
    this.#push();
    m.waker?.();
  }

  // -------------------------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------------------------

  #pump(): void {
    if (this.#running) return;
    this.#running = (async () => {
      for (;;) {
        const next = this.#queue.shift();
        if (!next) break;
        if (this.#clock.now() - next.queuedAt > this.#limits.queueMaxMs) {
          this.#finish(next, { status: 'missed', reason: 'queued too long behind another meeting' });
          continue;
        }
        try {
          const outcome = await this.#run(next);
          this.#finish(next, outcome);
        } catch (e) {
          this.#log?.error({ err: e }, 'meeting failed');
          this.#finish(next, { status: 'missed', reason: 'internal error' });
        }
      }
      this.#running = null;
    })();
  }

  #finish(p: Pending, outcome: MeetingOutcome): void {
    const { eventId, occurrence } = p.request;
    if (eventId !== undefined && occurrence !== undefined) {
      const status: OccurrenceStatus = outcome.status === 'missed' ? 'missed' : 'done';
      const note =
        outcome.status === 'held'
          ? `held: ${outcome.attended.length} attended`
          : outcome.status === 'adjourned'
            ? `adjourned: ${outcome.reason}`
            : outcome.reason;
      this.#calendar?.recordOccurrence(eventId, occurrence, status, note);
    }
    if (outcome.status === 'missed')
      this.#fx.toast?.(`Meeting "${sanitizeTitle(p.request.title)}" missed: ${outcome.reason}`);
    this.#outcomes.set(p.id, outcome);
    for (const resolve of this.#waiters.get(p.id) ?? []) resolve(outcome);
    this.#waiters.delete(p.id);
  }

  /** Invitees and how each one attends. */
  #plan(request: MeetingRequest): MeetingAttendee[] {
    const tableDim = this.#world.tableDimension();
    const player = this.#world.player();
    const invited = request.attendees === 'all' ? null : new Set(request.attendees);
    const agentCreated = request.createdBy !== 'player';
    const out: MeetingAttendee[] = [];
    for (const c of this.#world.crew()) {
      if (invited && !invited.has(c.agentId)) continue;
      const a: MeetingAttendee = { agentId: c.agentId, name: c.name, mode: 'walking', wasSeated: c.seated };
      if (c.status !== 'alive') {
        a.mode = 'absent';
        a.reason = c.status;
      } else if (c.seated && agentCreated) {
        a.mode = 'excused';
        a.reason = 'seated';
      } else if (c.dimension !== tableDim) {
        a.mode = 'dial_in';
        a.reason = 'dimension';
      } else if (
        c.escortingPlayer &&
        ((player.distanceToTable ?? Number.POSITIVE_INFINITY) > this.#limits.escortTableBlocks ||
          (c.distanceToPlayer !== null && c.distanceToPlayer <= this.#limits.escortPlayerBlocks))
      ) {
        a.mode = 'dial_in';
        a.reason = 'escort';
      } else {
        const eta = this.#world.etaSeconds(c.agentId);
        a.etaSec = eta;
        if (eta === null || eta > this.#limits.dialInEtaSec) {
          a.mode = 'dial_in';
          a.reason = 'eta';
        }
      }
      out.push(a);
    }
    return out;
  }

  #ceoOf(attendees: Map<string, MeetingAttendee>): string | null {
    for (const c of this.#world.crew()) {
      if (c.isCeo && c.status === 'alive') {
        const a = attendees.get(c.agentId);
        return a && PRESENT_MODES.has(a.mode) ? c.agentId : null;
      }
    }
    return null;
  }

  #quorum(m: Active): boolean {
    const ceo = this.#ceoOf(m.attendees);
    if (!ceo && !m.request.playerChairs) return false;
    const others = [...m.attendees.values()].filter(
      (a) => PRESENT_MODES.has(a.mode) && a.agentId !== ceo,
    ).length;
    const d = this.#world.player().distanceToTable;
    const playerHere = d !== null && d <= this.#limits.playerScopeBlocks;
    if (m.request.playerChairs) return others + (ceo ? 1 : 0) >= 1;
    return others >= 1 || playerHere;
  }

  #unsafe(): string | null {
    const p = this.#world.player();
    if (p.hpFraction < 0.5) return `${this.#player} is hurt`;
    if (p.inCombat) return `${this.#player} is in combat`;
    if (p.isNight && (p.distanceToTable ?? Number.POSITIVE_INFINITY) > this.#limits.safetyTableBlocks) {
      return `${this.#player} is far from the table at night`;
    }
    return null;
  }

  /** Waits before a meeting starts (usage, safety). Returns an outcome when it will not start. Cancellable. */
  async #beforeStart(request: MeetingRequest): Promise<MeetingOutcome | null> {
    const pre = new AbortController();
    this.#preStart = pre;
    try {
      // Usage: Asleep postpones until resetsAt.
      const usage = this.#world.usage();
      if (usage.state === 'asleep') {
        const wait = (usage.resetsAt ?? Number.POSITIVE_INFINITY) - this.#clock.now();
        if (wait > this.#limits.asleepMaxMs) return { status: 'missed', reason: 'the crew is out of usage' };
        this.#fx.toast?.(`Meeting "${sanitizeTitle(request.title)}" waits until the crew has usage again`);
        await sleep(this.#clock, wait, pre.signal);
      }
      // Safety (scheduled meetings only).
      if (request.scheduled) {
        const deadline = this.#clock.now() + this.#limits.safetyMaxMs;
        let reason = this.#unsafe();
        if (reason) this.#fx.toast?.(`Meeting "${sanitizeTitle(request.title)}" postponed: ${reason}`);
        while (reason) {
          if (this.#clock.now() >= deadline)
            return { status: 'missed', reason: `postponed too long (${reason})` };
          await sleep(
            this.#clock,
            Math.min(this.#limits.safetyRecheckMs, deadline - this.#clock.now()),
            pre.signal,
          );
          reason = this.#unsafe();
        }
      }
      return null;
    } catch (e) {
      if (pre.signal.aborted) {
        const reason = pre.signal.reason instanceof Error ? pre.signal.reason.message : 'cancelled';
        return { status: 'missed', reason };
      }
      throw e;
    } finally {
      if (this.#preStart === pre) this.#preStart = null;
    }
  }

  async #run(p: Pending): Promise<MeetingOutcome> {
    const request = p.request;
    // Only yield when there is something to wait for, so an unhindered meeting becomes active synchronously.
    if (this.#world.usage().state === 'asleep' || (request.scheduled && this.#unsafe())) {
      const notStarted = await this.#beforeStart(request);
      if (notStarted) return notStarted;
    }

    const m: Active = {
      id: p.id,
      request,
      phase: 'gathering',
      attendees: new Map(),
      chair: null,
      speaker: null,
      format: request.quick ? 'quick' : this.#world.usage().state === 'tired' ? 'short' : 'full',
      startedAt: this.#clock.now(),
      minutes: [],
      abort: new AbortController(),
      turnAbort: null,
      floorQueue: [],
      ended: null,
      waker: null,
      capTimer: null,
    };
    this.#active = m;
    try {
      // Gathering, with one postponement for quorum.
      let gathered = await this.#gather(m);
      if (!gathered && !m.ended) {
        this.#fx.toast?.(
          `Meeting "${sanitizeTitle(request.title)}" has no quorum (the CEO plus one); trying again soon`,
        );
        this.#releaseAttendees(m);
        await this.#wait(m, this.#limits.quorumRetryMs, () => false);
        if (!m.ended) gathered = await this.#gather(m);
      }
      if (m.ended) return this.#adjourn(m, m.ended);
      if (!gathered) return { status: 'missed', reason: 'no quorum' };

      m.capTimer = this.#clock.setTimeout(
        () => this.end('the 10-minute cap'),
        this.#limits.maxDurationMs - (this.#clock.now() - m.startedAt),
      );
      const ceo = this.#ceoOf(m.attendees);
      m.chair = request.playerChairs || !ceo ? 'player' : ceo;

      await this.#phaseOpen(m);
      await this.#phaseUpdates(m);
      if (m.format === 'full') await this.#phaseFloor(m);
      return await this.#phaseWrapup(m);
    } catch (e) {
      if (m.ended) return this.#adjourn(m, m.ended);
      throw e;
    } finally {
      if (m.capTimer !== null) this.#clock.clearTimeout(m.capTimer);
      this.#dismiss(m);
      this.#active = null;
    }
  }

  async #gather(m: Active): Promise<boolean> {
    m.phase = 'gathering';
    m.startedAt = this.#clock.now();
    m.attendees = new Map(this.#plan(m.request).map((a) => [a.agentId, a]));
    const debounce = this.#limits.maxDurationMs + 2 * 60_000;
    for (const a of m.attendees.values()) {
      if (a.mode === 'walking') {
        if (a.wasSeated) {
          this.#fx.interruptSeated?.(a.agentId, m.id);
          this.#fx.stretchSwapDebounce?.(a.agentId, debounce);
        }
        this.#fx.gather?.(a.agentId, m.id);
      } else if (a.mode === 'dial_in') {
        if (a.wasSeated) {
          this.#fx.interruptSeated?.(a.agentId, m.id);
          this.#fx.stretchSwapDebounce?.(a.agentId, debounce);
        }
        this.#fx.dialIn?.(a.agentId, m.id, a.reason ?? 'eta');
      }
    }
    if (!this.#quorum(m)) return false;
    this.#fx.toast?.(`Meeting: ${sanitizeTitle(m.request.title)}. Head to the meeting table.`);
    this.#fx.marker?.(m.id);
    this.#push();
    const deadline = m.startedAt + this.#limits.gatherMaxMs;
    await this.#wait(m, Math.max(0, deadline - this.#clock.now()), () =>
      [...m.attendees.values()].every((a) => a.mode !== 'walking'),
    );
    for (const a of m.attendees.values()) {
      if (a.mode === 'walking') {
        a.mode = 'dial_in';
        a.reason = 'late';
        this.#fx.dialIn?.(a.agentId, m.id, 'late');
      }
    }
    this.#push();
    return this.#quorum(m);
  }

  async #phaseOpen(m: Active): Promise<void> {
    this.#enter(m, 'open');
    if (m.chair === 'player' || m.chair === null) {
      m.minutes.push(`(${this.#player} chairs.)`);
      return;
    }
    await this.#turn(m, {
      kind: 'open',
      agentId: m.chair,
      maxSentences: 3,
      headline: `You chair the meeting "${sanitizeTitle(m.request.title)}". State the agenda in at most 3 sentences.`,
    });
  }

  async #phaseUpdates(m: Active): Promise<void> {
    this.#enter(m, 'updates');
    const order = [...m.attendees.values()].filter((a) => PRESENT_MODES.has(a.mode) && a.agentId !== m.chair);
    for (const a of order) {
      if (m.ended) throw new EndMeeting(m.ended);
      if (!PRESENT_MODES.has(a.mode)) continue; // died meanwhile
      if (m.format === 'quick') {
        const s = this.#world.statusLine?.(a.agentId);
        const todo = s?.todo.length ? `todo: ${s.todo.slice(0, 3).join('; ')}` : 'no open todos';
        const last = s?.lastActivity ? `; last: ${s.lastActivity}` : '';
        m.minutes.push(`${a.name} (standup): ${singleLine(`${todo}${last}`, 240)}`);
        if (!s?.blocker) continue;
        m.minutes.push(`${a.name} is blocked: ${singleLine(s.blocker, 200)}`);
      }
      await this.#turn(m, {
        kind: 'update',
        agentId: a.agentId,
        maxSentences: 3,
        headline:
          m.format === 'quick'
            ? `Your turn in "${sanitizeTitle(m.request.title)}": explain your blocker in at most 3 sentences.`
            : `Your turn in "${sanitizeTitle(m.request.title)}": give your update in at most 3 sentences (done, next, blockers).`,
      });
    }
  }

  async #phaseFloor(m: Active): Promise<void> {
    this.#enter(m, 'floor');
    const withCards = [...m.attendees.values()]
      .filter((a) => PRESENT_MODES.has(a.mode))
      .map((a) => a.agentId);
    this.#fx.raiseCards?.(withCards);
    let idleSince = this.#clock.now();
    for (;;) {
      if (m.ended) throw new EndMeeting(m.ended);
      if (this.#timeLeft(m) <= this.#limits.wrapupReserveMs) return;
      const message = m.floorQueue.shift();
      if (message === undefined) {
        const idleLeft = this.#limits.floorIdleMs - (this.#clock.now() - idleSince);
        if (idleLeft <= 0) return;
        await this.#wait(
          m,
          Math.min(idleLeft, this.#timeLeft(m) - this.#limits.wrapupReserveMs),
          () => m.floorQueue.length > 0,
        );
        continue;
      }
      if (m.chair && m.chair !== 'player') {
        const chair = m.chair;
        const candidates = [...m.attendees.values()]
          .filter((a) => PRESENT_MODES.has(a.mode) && a.agentId !== chair)
          .map((a) => a.agentId);
        const names =
          candidates.map((id) => `${m.attendees.get(id)?.name ?? id} (${id})`).join(', ') || 'nobody';
        const result = await this.#turn(m, {
          kind: 'floor_chair',
          agentId: chair,
          maxSentences: 3,
          headline: `${this.#player} asked the meeting something (below). Answer briefly, and name at most ${this.#limits.maxResponders} attendees who should respond, from: ${names}.`,
          playerMessage: message,
          candidates,
        });
        const responders = [...new Set(result?.responders ?? [])]
          .filter((id) => candidates.includes(id))
          .slice(0, this.#limits.maxResponders);
        for (const id of responders) {
          if (m.ended) throw new EndMeeting(m.ended);
          if (!PRESENT_MODES.has(m.attendees.get(id)?.mode ?? 'left')) continue;
          await this.#turn(m, {
            kind: 'floor_reply',
            agentId: id,
            maxSentences: 3,
            headline: `The chair asked you to respond to ${this.#player} (below), in at most 3 sentences.`,
            playerMessage: message,
          });
        }
      }
      idleSince = this.#clock.now();
    }
  }

  async #phaseWrapup(m: Active): Promise<MeetingOutcome> {
    this.#enter(m, 'wrapup');
    let summary = '';
    const items: MeetingActionItem[] = [];
    if (m.chair && m.chair !== 'player') {
      const result = await this.#turn(m, {
        kind: 'wrapup',
        agentId: m.chair,
        maxSentences: 4,
        headline: `Wrap up "${sanitizeTitle(m.request.title)}": summarise in at most 4 sentences and list action items (assignee, task, when). If the Codex has duplicate pages, merge them.`,
      });
      summary = singleLine(result?.summary ?? result?.text ?? '', 1200);
      items.push(...(result?.actionItems ?? []));
    }
    const created = this.#createActionItems(m, items);
    const minutesId = await this.#writeMinutes(m, summary, created, null);
    return {
      status: 'held',
      minutesId,
      attended: [...m.attendees.values()]
        .filter((a) => a.mode === 'present' || a.mode === 'dial_in')
        .map((a) => a.agentId),
    };
  }

  async #adjourn(m: Active, reason: string): Promise<MeetingOutcome> {
    if (m.phase === 'gathering') return { status: 'adjourned', reason, minutesId: null };
    const minutesId = await this.#writeMinutes(m, '', [], reason);
    return { status: 'adjourned', reason, minutesId };
  }

  #createActionItems(m: Active, items: readonly MeetingActionItem[]): string[] {
    const created: string[] = [];
    const cal = this.#calendar;
    const chair = m.chair && m.chair !== 'player' ? m.chair : null;
    const chairName = chair ? (m.attendees.get(chair)?.name ?? chair) : this.#player;
    for (const item of items.slice(0, 8)) {
      const title = sanitizeTitle(item.title);
      if (!title) continue;
      if (!cal) {
        created.push(`${title} → ${item.assignee}`);
        continue;
      }
      // World tasks belong to the world (game clock); without a known world clock, "now" on the real clock.
      const gameKnown = cal.gameTicks !== null;
      const input: CalendarAddInput = {
        title,
        assignees: [item.assignee],
        when: item.when ?? 'now',
        task: item.task ?? title,
        clock: gameKnown || item.when ? 'game' : 'real',
      };
      const actor = chair
        ? ({ kind: 'agent', id: chair, name: chairName } as const)
        : ({ kind: 'player', name: this.#player } as const);
      const res = cal.add(actor, input);
      if (res.ok)
        created.push(`${title} → ${m.attendees.get(item.assignee)?.name ?? item.assignee} [${res.event.id}]`);
      else m.minutes.push(`(Action item "${title}" not scheduled: ${res.message})`);
    }
    return created;
  }

  async #writeMinutes(
    m: Active,
    summary: string,
    actionItems: readonly string[],
    adjourned: string | null,
  ): Promise<string | null> {
    if (!this.#codex) return null;
    const present = [...m.attendees.values()].filter((a) => a.mode === 'present').map((a) => a.name);
    const dialIn = [...m.attendees.values()]
      .filter((a) => a.mode === 'dial_in')
      .map((a) => `${a.name} (${a.reason ?? 'dial-in'})`);
    const absent = [...m.attendees.values()]
      .filter((a) => a.mode === 'absent' || a.mode === 'excused' || a.mode === 'left')
      .map((a) => `${a.name} (${a.reason ?? a.mode})`);
    const chairName =
      m.chair === 'player' ? this.#player : m.chair ? (m.attendees.get(m.chair)?.name ?? m.chair) : 'nobody';
    const lines = [
      `Chair: ${chairName}`,
      `Present: ${present.join(', ') || 'nobody'}`,
      dialIn.length ? `Dialled in: ${dialIn.join(', ')}` : '',
      absent.length ? `Absent: ${absent.join(', ')}` : '',
      adjourned ? `Adjourned early: ${adjourned}. Partial minutes.` : '',
      '',
      summary ? `## Summary\n\n${summary}\n` : '',
      actionItems.length ? `## Action items\n\n${actionItems.map((a) => `- ${a}`).join('\n')}\n` : '',
      '## Notes',
      '',
      ...m.minutes.map((l) => `- ${l}`),
    ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '');
    let body = lines.join('\n').trim();
    while (Buffer.byteLength(body, 'utf8') > 8000) body = `${body.slice(0, Math.floor(body.length * 0.9))}…`;
    const title = sanitizeTitle(`Minutes: ${m.request.title}, ${this.#formatNow()}`);
    try {
      const res = await this.#codex.write(
        { kind: 'system', id: 'meeting', name: 'MineVibe' },
        { mode: 'create', title, body, category: 'minutes', scope: 'world', tags: ['meeting'] },
      );
      if (res.ok) return res.page.id;
      this.#log?.warn({ code: res.code, message: res.message }, 'meeting minutes not written');
    } catch (e) {
      this.#log?.warn({ err: e }, 'meeting minutes failed');
    }
    return null;
  }

  #dismiss(m: Active): void {
    m.phase = 'done';
    m.speaker = null;
    this.#push();
    const released: string[] = [];
    for (const a of m.attendees.values()) {
      if (a.mode === 'absent' || a.mode === 'excused') continue;
      if (a.mode !== 'left') this.#fx.dismiss?.(a.agentId, { returnToPc: a.wasSeated });
      released.push(a.agentId);
    }
    this.#fx.marker?.(null);
    this.#calendar?.meetingEnded(released);
  }

  /** Lets gathered agents go back to work while a postponed meeting waits for quorum. */
  #releaseAttendees(m: Active): void {
    for (const a of m.attendees.values()) {
      if (a.mode === 'walking' || a.mode === 'present' || a.mode === 'dial_in') {
        this.#fx.dismiss?.(a.agentId, { returnToPc: a.wasSeated });
      }
    }
    this.#fx.marker?.(null);
  }

  // -------------------------------------------------------------------------------------------
  // Turns and waiting
  // -------------------------------------------------------------------------------------------

  async #turn(
    m: Active,
    t: {
      kind: MeetingTurnKind;
      agentId: string;
      maxSentences: number;
      headline: string;
      playerMessage?: string;
      candidates?: readonly string[];
    },
  ): Promise<MeetingTurnResult | null> {
    if (m.ended) throw new EndMeeting(m.ended);
    const attendee = m.attendees.get(t.agentId);
    if (!attendee || !PRESENT_MODES.has(attendee.mode)) return null;
    m.speaker = t.agentId;
    this.#push();
    const minutes = m.minutes.length > 0 ? m.minutes.slice(-30).join('\n') : '(nothing yet)';
    let prompt = this.#nonce.message(
      'MEETING',
      t.headline,
      wrapNote(
        { author: { kind: 'system', name: 'MineVibe' }, kind: 'minutes', title: m.request.title },
        minutes,
      ),
    );
    if (t.playerMessage) {
      prompt += `\n${wrapNote({ author: { kind: 'player', name: this.#player }, kind: 'meeting' }, t.playerMessage)}`;
    }
    const ac = new AbortController();
    m.turnAbort = ac;
    const onMeetingAbort = () => ac.abort(m.abort.signal.reason);
    m.abort.signal.addEventListener('abort', onMeetingAbort, { once: true });
    try {
      const timeout = sleep(this.#clock, this.#limits.turnTimeoutMs, ac.signal).then(
        () => null,
        () => null,
      );
      const result = await Promise.race([
        this.#brain
          .turn(
            {
              meetingId: m.id,
              kind: t.kind,
              agentId: t.agentId,
              prompt,
              maxSentences: t.maxSentences,
              playerMessage: t.playerMessage,
              candidates: t.candidates,
            },
            ac.signal,
          )
          .catch(() => null),
        timeout,
        new Promise<null>((resolve) =>
          ac.signal.addEventListener('abort', () => resolve(null), { once: true }),
        ),
      ]);
      if (m.ended) throw new EndMeeting(m.ended);
      if (!PRESENT_MODES.has(attendee.mode)) return null; // died or left mid-turn
      if (!result) {
        m.minutes.push(`${attendee.name}: (no answer)`);
        return null;
      }
      const text = clipSentences(result.text, t.maxSentences);
      if (text) {
        m.minutes.push(
          `${attendee.name}${t.kind === 'open' || t.kind === 'wrapup' ? ' (chair)' : ''}: ${text}`,
        );
        this.#fx.say?.(t.agentId, text);
      }
      return result;
    } finally {
      ac.abort();
      m.abort.signal.removeEventListener('abort', onMeetingAbort);
      m.turnAbort = null;
      m.speaker = null;
      this.#push();
    }
  }

  /** Waits up to `ms` or until `done()` holds (checked whenever something notifies the meeting). */
  async #wait(m: Active, ms: number, done: () => boolean): Promise<void> {
    const deadline = this.#clock.now() + Math.max(0, ms);
    while (!done() && !m.ended && this.#clock.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = this.#clock.setTimeout(() => resolve(), deadline - this.#clock.now());
        m.waker = () => {
          this.#clock.clearTimeout(timer);
          resolve();
        };
      });
      m.waker = null;
    }
  }

  #timeLeft(m: Active): number {
    return this.#limits.maxDurationMs - (this.#clock.now() - m.startedAt);
  }

  #enter(m: Active, phase: MeetingPhase): void {
    if (m.ended) throw new EndMeeting(m.ended);
    m.phase = phase;
    this.#push();
  }

  #snapshot(m: Active): MeetingState {
    return {
      id: m.id,
      title: m.request.title,
      eventId: m.request.eventId,
      phase: m.phase,
      attendees: [...m.attendees.values()].map((a) => ({ ...a })),
      speaker: m.speaker,
      chair: m.chair,
      format: m.format,
      startedAt: m.startedAt,
    };
  }

  #push(): void {
    const m = this.#active;
    if (!m) return;
    try {
      this.#fx.state?.(this.#snapshot(m));
    } catch (e) {
      this.#log?.warn({ err: e }, 'meeting state listener failed');
    }
  }
}
