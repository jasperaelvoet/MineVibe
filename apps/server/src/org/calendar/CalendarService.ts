/**
 * CalendarService (PLAN §6.6 "Calendar"): tasks, reminders and meetings on the game or the real clock.
 *
 * Clocks
 * - Game: `world.state.clockTime` ({@link onGameClock}); game-clock events belong to the world and die with it.
 * - Real: wall clock in an IANA zone, DST-aware; real-clock events are lasting. After a world death, those whose
 *   assignees are gone become `orphaned` until the player reassigns, keeps or pauses them.
 *
 * Firing (a 1 s loop plus every game-clock update)
 * - Task: each assignee gets `[MV:nonce SCHEDULED] <title>` plus the task inside a data envelope, P1 (P4 when an
 *   agent scheduled itself). Dead or dismissed assignees: `missed`. Asleep (usage): `deferred` until `resetsAt`
 *   within a grace window, then staggered wakes. In a meeting: `deferred` until it ends. At most one open
 *   CEO-assigned task per assignee; further ones queue until `report_task` closes the open one.
 * - Reminder: bubble and toast only (zero tokens). Meeting: handed to the MeetingRunner.
 * - Time jumps (sleeping, app closed): at most one occurrence per event fires, per `catchUp` (`skip` | `once_late`
 *   within a grace window), staggered ≥ 10 s apart. Skipped occurrences become one "missed while offline" line.
 * - AFK (5 min without player input): agent-created events and game-clock wakes pause unless `runWhileAway`.
 *
 * Rights and limits (enforced here, not by the prompt)
 * - The CEO schedules for anyone (`when:"now"` delegates at once); other agents only for themselves.
 * - Recurring events and meetings created by an agent become approval cards for the player.
 * - Agents cannot edit or cancel events the player created; non-CEO agents only touch their own events.
 * - At most 6 CEO-created events per real hour. Agent-created wakes are charged to the creator's budget.
 * - Toasts are batched to at most one per 30 s.
 *
 * Storage: only the rule, `nextAt` and a ring of the last 20 occurrences are stored per event.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../../util/atomicFile.js';
import {
  formatGameTime,
  formatRealTime,
  gameDay,
  hostTimeZone,
  isValidTimeZone,
  type OrgClock,
  parseGameWhen,
  parseRealWhen,
  systemClock,
  TICKS_PER_DAY,
  zonedParts,
} from '../clock.js';
import { type ControlNonce, sanitizeTitle, singleLine, wrapNote } from '../envelope.js';
import { describeRecurrence } from './format.js';
import { occurrenceAfter, occurrenceAtOrAfter } from './recurrence.js';
import { ToastBatcher } from './ToastBatcher.js';
import {
  type CalendarErrorCode,
  type CalendarEvent,
  type CalendarResult,
  type CatchUp,
  type ClockKind,
  type EventKind,
  isRecurring,
  type Occurrence,
  type OccurrenceStatus,
  type Recurrence,
  RING_SIZE,
} from './types.js';

export interface CalendarLimits {
  /** Lateness that still counts as on time. */
  readonly gameSlackTicks: number;
  readonly realSlackMs: number;
  /** `once_late` fires a late occurrence only within this window. */
  readonly gameGraceTicks: number;
  readonly realGraceMs: number;
  /** Deferred-while-asleep deliveries expire after this. */
  readonly asleepGraceMs: number;
  /** Spacing of catch-up fires and released deferrals. */
  readonly staggerMs: number;
  readonly afkMs: number;
  readonly ceoEventsPerHour: number;
  /** An open CEO task stops blocking the queue after this long without a report. */
  readonly openTaskTtlMs: number;
  /** Queued and meeting-deferred deliveries expire after this. */
  readonly queueTtlMs: number;
  readonly meetingGapMs: number;
  readonly meetingGapTicks: number;
  readonly tickMs: number;
}

export const DEFAULT_CALENDAR_LIMITS: CalendarLimits = {
  gameSlackTicks: 600,
  realSlackMs: 90_000,
  gameGraceTicks: 6_000,
  realGraceMs: 2 * 3_600_000,
  asleepGraceMs: 3 * 3_600_000,
  staggerMs: 10_000,
  afkMs: 5 * 60_000,
  ceoEventsPerHour: 6,
  openTaskTtlMs: 2 * 3_600_000,
  queueTtlMs: 2 * 3_600_000,
  meetingGapMs: 30 * 60_000,
  meetingGapTicks: TICKS_PER_DAY,
  tickMs: 1_000,
};

export type UsageState = 'ok' | 'tired' | 'asleep';

/** What the calendar needs to know about the crew (supplied by the agent runtime). */
export interface CalendarCrew {
  /** Living agent ids (for `all`). */
  living(): readonly string[];
  status(agentId: string): 'alive' | 'dead' | 'dismissed' | 'unknown';
  isCeo(agentId: string): boolean;
  ceoId(): string | null;
  name(agentId: string): string;
  usage(agentId: string): { state: UsageState; resetsAt?: number | undefined };
  inMeeting(agentId: string): boolean;
}

export interface TaskDelivery {
  readonly agentId: string;
  readonly eventId: string;
  readonly occurrence: number;
  /** P1 for player- and CEO-assigned tasks, P4 when an agent scheduled itself. */
  readonly priority: 'P1' | 'P4';
  readonly text: string;
  readonly location?: string | undefined;
  readonly late: boolean;
}

export interface CalendarApprovalCard {
  readonly cardId: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly title: string;
  readonly summary: string;
}

/** Effects (bridge pushes, wakes, cards). Every method is optional. */
export interface CalendarSink {
  deliverTask?(delivery: TaskDelivery): void;
  reminder?(r: {
    eventId: string;
    occurrence: number;
    title: string;
    assignees: readonly string[];
    text: string;
  }): void;
  startMeeting?(m: { event: CalendarEvent; occurrence: number }): void;
  /** A `shouldQuery:false` context line for these agents. */
  context?(agentIds: readonly string[], text: string): void;
  wake?(agentId: string, text: string, priority: 'P3'): void;
  /** Charges an agent-created wake to the creator's autonomy budget; false when it is spent. */
  chargeWake?(creatorId: string, assigneeId: string): boolean;
  toast?(text: string): void;
  requestApproval?(card: CalendarApprovalCard): void;
  withdrawApproval?(cardId: string): void;
  /** `calendar.fired{eventId, occurrence}`. */
  fired?(eventId: string, occurrence: number): void;
  /** `calendar.state` should be pushed. */
  changed?(): void;
}

export type CalendarActor =
  | { readonly kind: 'player'; readonly name: string }
  | { readonly kind: 'agent'; readonly id: string; readonly name: string };

export type RecurrenceInput = Recurrence | 'once' | 'daily' | 'weekdays' | { readonly every_n_days: number };

export interface CalendarAddInput {
  readonly title: string;
  readonly kind?: EventKind | undefined;
  readonly assignees?: readonly string[] | 'all' | undefined;
  readonly clock?: ClockKind | undefined;
  /** "now", "Day 3 06:00", "08:00", "2026-10-09 08:00", an ISO instant, or raw ticks / epoch ms. */
  readonly when: string | number;
  readonly recurrence?: RecurrenceInput | undefined;
  readonly durationMin?: number | undefined;
  readonly location?: string | undefined;
  readonly task?: string | undefined;
  readonly catchUp?: CatchUp | undefined;
  readonly runWhileAway?: boolean | undefined;
  /** IANA zone for a real-clock event (default: the host's). */
  readonly tz?: string | undefined;
}

export type CalendarUpdateInput = Partial<CalendarAddInput>;

export type OrphanAction =
  | { readonly action: 'reassign'; readonly assignees: readonly string[] | 'all' }
  | { readonly action: 'keep' }
  | { readonly action: 'pause' };

export interface CalendarListFilter {
  readonly agent?: string | undefined;
  readonly from?: string | number | undefined;
  readonly to?: string | number | undefined;
  readonly includeInactive?: boolean | undefined;
}

export interface CalendarServiceOptions {
  readonly nonce: ControlNonce;
  readonly crew: CalendarCrew;
  readonly sink?: CalendarSink | undefined;
  /** `calendar/lasting.json`; null keeps real-clock events in memory only. */
  readonly lastingFile?: string | null | undefined;
  /** `worlds/<id>/calendar.json`; null keeps game-clock events in memory only. */
  readonly worldFile?: ((worldId: string) => string) | null | undefined;
  readonly clock?: OrgClock | undefined;
  readonly timeZone?: string | undefined;
  readonly playerName?: string | undefined;
  readonly limits?: Partial<CalendarLimits> | undefined;
  readonly logger?: Logger | undefined;
}

type ReportStatus = 'done' | 'failed' | 'blocked';

interface Deferred {
  readonly eventId: string;
  readonly at: number;
  readonly agentId: string;
  readonly reason: 'asleep' | 'meeting' | 'queued' | 'afk';
  /** Real ms when an `asleep` deferral may go out. */
  readonly until: number;
  /** Real ms after which it is missed. */
  readonly expiresAt: number;
}

interface PersistedFile {
  v: 1;
  events: CalendarEvent[];
}

const MAX_TASK_CHARS = 1000;

export type CalendarFailure = Extract<CalendarResult<object>, { ok: false }>;

function fail(code: CalendarErrorCode, message: string): CalendarFailure {
  return { ok: false, code, message };
}

function normalizeRecurrence(input: RecurrenceInput | undefined): Recurrence | null {
  if (input === undefined || input === 'once') return { kind: 'once' };
  if (input === 'daily') return { kind: 'daily' };
  if (input === 'weekdays') return { kind: 'weekdays' };
  if (typeof input === 'object' && input !== null) {
    if ('every_n_days' in input) {
      const n = Number(input.every_n_days);
      return Number.isInteger(n) && n >= 1 && n <= 365 ? { kind: 'every_n_days', n } : null;
    }
    if ('kind' in input) {
      if (input.kind === 'every_n_days') {
        return Number.isInteger(input.n) && input.n >= 1 && input.n <= 365
          ? { kind: 'every_n_days', n: input.n }
          : null;
      }
      if (input.kind === 'once' || input.kind === 'daily' || input.kind === 'weekdays')
        return { kind: input.kind };
    }
  }
  return null;
}

export class CalendarService {
  readonly #nonce: ControlNonce;
  readonly #crew: CalendarCrew;
  readonly #sink: CalendarSink;
  readonly #lastingFile: string | null;
  readonly #worldFile: ((worldId: string) => string) | null;
  readonly #clock: OrgClock;
  readonly #tz: string;
  readonly #playerName: string;
  readonly #limits: CalendarLimits;
  readonly #log: Logger | undefined;
  readonly #toasts: ToastBatcher;

  #events = new Map<string, CalendarEvent>();
  #worldId: string | null = null;
  #gameTicks: number | null = null;
  #lastInputAt: number;
  #afk = false;
  #deferred: Deferred[] = [];
  #stagger: Array<() => void> = [];
  #lastStaggerAt = Number.NEGATIVE_INFINITY;
  #offlineMissed: Array<{ title: string; assignees: readonly string[] }> = [];
  readonly #ceoCreates = new Map<string, number[]>();
  #saveQueue: Promise<void> = Promise.resolve();
  #timer: unknown = null;
  #running = false;

  constructor(options: CalendarServiceOptions) {
    this.#nonce = options.nonce;
    this.#crew = options.crew;
    this.#sink = options.sink ?? {};
    this.#lastingFile = options.lastingFile ?? null;
    this.#worldFile = options.worldFile ?? null;
    this.#clock = options.clock ?? systemClock;
    const tz = options.timeZone ?? hostTimeZone();
    this.#tz = isValidTimeZone(tz) ? tz : 'UTC';
    this.#playerName = options.playerName ?? 'the player';
    this.#limits = { ...DEFAULT_CALENDAR_LIMITS, ...options.limits };
    this.#log = options.logger;
    this.#lastInputAt = this.#clock.now();
    this.#toasts = new ToastBatcher(this.#clock, (text) => this.#sink.toast?.(text));
  }

  get timeZone(): string {
    return this.#tz;
  }

  get worldId(): string | null {
    return this.#worldId;
  }

  get gameTicks(): number | null {
    return this.#gameTicks;
  }

  get playerAfk(): boolean {
    return this.#afk;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Loads lasting (real-clock) events and the world's game-clock events. */
  async open(worldId: string | null): Promise<void> {
    this.#events = new Map();
    for (const ev of await this.#loadFile(this.#lastingFile)) {
      if (ev.clock === 'real') this.#events.set(ev.id, ev);
    }
    await this.setWorld(worldId);
  }

  /** Switches to a world's game-clock events (a new world after a death, or the first `world.open`). */
  async setWorld(worldId: string | null): Promise<void> {
    for (const ev of [...this.#events.values()]) if (ev.clock === 'game') this.#events.delete(ev.id);
    this.#worldId = worldId;
    this.#gameTicks = null;
    if (worldId !== null && this.#worldFile) {
      for (const ev of await this.#loadFile(this.#worldFile(worldId))) {
        if (ev.clock === 'game') this.#events.set(ev.id, { ...ev, worldId });
      }
    }
    this.#changed();
  }

  /**
   * World death: game-clock events die with the world; real-clock events whose assignees are gone become
   * orphaned (listed on Game Over and in CalendarScreen).
   */
  async onWorldEnded(worldId: string): Promise<string[]> {
    const orphaned: string[] = [];
    for (const ev of [...this.#events.values()]) {
      if (ev.clock === 'game') {
        this.#events.delete(ev.id);
        continue;
      }
      if (ev.status === 'cancelled' || ev.status === 'declined' || ev.status === 'completed') continue;
      if (ev.assignees !== 'all' && ev.kind !== 'meeting') {
        ev.orphaned = true;
        ev.orphanKept = false;
        ev.updatedAt = this.#clock.now();
        orphaned.push(ev.id);
      }
    }
    this.#deferred = this.#deferred.filter((d) => this.#events.has(d.eventId));
    if (this.#worldId === worldId) {
      this.#worldId = null;
      this.#gameTicks = null;
    }
    this.#save();
    this.#changed();
    return orphaned;
  }

  /** Starts the 1 s firing loop. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = () => {
      if (!this.#running) return;
      try {
        this.tick();
      } catch (e) {
        this.#log?.error({ err: e }, 'calendar tick failed');
      }
      this.#timer = this.#clock.setTimeout(loop, this.#limits.tickMs);
    };
    this.#timer = this.#clock.setTimeout(loop, this.#limits.tickMs);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#toasts.dispose();
  }

  /** Waits for pending saves. */
  async flush(): Promise<void> {
    await this.#saveQueue;
  }

  // -------------------------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------------------------

  /** `world.state.clockTime` (1 Hz). Going backwards (e.g. `/time set`) realigns recurring game events. */
  onGameClock(ticks: number): void {
    const prev = this.#gameTicks;
    this.#gameTicks = ticks;
    if (prev !== null && ticks < prev - this.#limits.gameSlackTicks) {
      for (const ev of this.#events.values()) {
        if (ev.clock !== 'game' || ev.status !== 'active' || !isRecurring(ev.recurrence)) continue;
        ev.nextAt = occurrenceAtOrAfter(ev, Math.max(ticks, ev.start));
      }
    }
    this.tick();
  }

  /** Any player input (chat, movement, UI). AFK is 5 min without one. */
  notePlayerInput(at = this.#clock.now()): void {
    this.#lastInputAt = Math.max(this.#lastInputAt, at);
    if (this.#afk) this.tick();
  }

  /** A meeting ended: deliveries deferred for its attendees go out (staggered). */
  meetingEnded(agentIds?: readonly string[]): void {
    const set = agentIds ? new Set(agentIds) : null;
    const release = this.#deferred.filter((d) => d.reason === 'meeting' && (!set || set.has(d.agentId)));
    this.#deferred = this.#deferred.filter((d) => !release.includes(d));
    for (const d of release) this.#queueStagger(() => this.#retryDeferred(d));
    this.#pumpStagger();
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  get(id: string): CalendarEvent | null {
    const ev = this.#events.get(id);
    return ev ? structuredClone(ev) : null;
  }

  /** Events (active, awaiting approval and paused by default), soonest first. */
  list(filter: CalendarListFilter = {}): CalendarEvent[] {
    const from = { game: this.#parseBound(filter.from, 'game'), real: this.#parseBound(filter.from, 'real') };
    const to = { game: this.#parseBound(filter.to, 'game'), real: this.#parseBound(filter.to, 'real') };
    return [...this.#events.values()]
      .filter(
        (ev) =>
          filter.includeInactive ||
          ev.status === 'active' ||
          ev.status === 'awaiting_approval' ||
          ev.status === 'paused',
      )
      .filter((ev) => !filter.agent || ev.assignees === 'all' || ev.assignees.includes(filter.agent))
      .filter((ev) => {
        const f = from[ev.clock];
        const t = to[ev.clock];
        if (f === null && t === null) return true;
        if (ev.nextAt === null) return false;
        return (f === null || ev.nextAt >= f) && (t === null || ev.nextAt <= t);
      })
      .sort((a, b) => (a.nextAt ?? Number.MAX_SAFE_INTEGER) - (b.nextAt ?? Number.MAX_SAFE_INTEGER))
      .map((ev) => structuredClone(ev));
  }

  /** Real-clock events orphaned by a world death and not yet resolved by the player. */
  orphans(): CalendarEvent[] {
    return [...this.#events.values()]
      .filter((ev) => ev.orphaned && !ev.orphanKept && ev.status !== 'cancelled')
      .map((ev) => structuredClone(ev));
  }

  /** "Day 3 06:00" or "2026-10-09 08:00". */
  formatWhen(ev: Pick<CalendarEvent, 'clock' | 'tz'>, at: number): string {
    return ev.clock === 'game' ? formatGameTime(at) : formatRealTime(at, ev.tz ?? this.#tz);
  }

  /** The `calendar.state` snapshot. */
  snapshot(): {
    events: CalendarEvent[];
    gameTicks: number | null;
    realNow: number;
    timeZone: string;
    orphans: string[];
  } {
    return {
      events: this.list({ includeInactive: true }),
      gameTicks: this.#gameTicks,
      realNow: this.#clock.now(),
      timeZone: this.#tz,
      orphans: this.orphans().map((e) => e.id),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Mutations (agent tools and CalendarScreen)
  // -------------------------------------------------------------------------------------------

  /** `calendar_add` / `calendar.put` (new). */
  add(
    actor: CalendarActor,
    input: CalendarAddInput,
  ): CalendarResult<{ event: CalendarEvent; needsApproval: boolean; firedNow: boolean }> {
    const built = this.#build(actor, input, null);
    if (!built.ok) return built;
    const { event } = built;

    if (actor.kind === 'agent' && this.#crew.isCeo(actor.id)) {
      const now = this.#clock.now();
      const log = (this.#ceoCreates.get(actor.id) ?? []).filter((t) => now - t < 3_600_000);
      if (log.length >= this.#limits.ceoEventsPerHour) {
        return fail(
          'RATE_LIMITED',
          `the CEO may create at most ${this.#limits.ceoEventsPerHour} events per hour`,
        );
      }
      log.push(now);
      this.#ceoCreates.set(actor.id, log);
    }

    const needsApproval =
      actor.kind === 'agent' && (isRecurring(event.recurrence) || event.kind === 'meeting');
    event.status = needsApproval ? 'awaiting_approval' : 'active';
    this.#events.set(event.id, event);
    if (needsApproval) this.#requestApproval(event);
    this.#save();
    this.#changed();
    const firedBefore = event.ring.length;
    if (!needsApproval) this.tick();
    const stored = this.#events.get(event.id) ?? event;
    return {
      ok: true,
      event: structuredClone(stored),
      needsApproval,
      firedNow: stored.ring.length > firedBefore,
    };
  }

  /** `calendar_update` / `calendar.put` (existing). */
  update(
    actor: CalendarActor,
    id: string,
    patch: CalendarUpdateInput,
  ): CalendarResult<{ event: CalendarEvent; needsApproval: boolean }> {
    const ev = this.#events.get(id);
    if (!ev || ev.status === 'cancelled')
      return fail('NOT_FOUND', `no calendar event "${singleLine(id, 40)}"`);
    const rights = this.#checkEditRights(actor, ev);
    if (rights) return rights;
    const merged: CalendarAddInput = {
      title: patch.title ?? ev.title,
      kind: patch.kind ?? ev.kind,
      assignees: patch.assignees ?? ev.assignees,
      clock: patch.clock ?? ev.clock,
      when: patch.when ?? ev.start,
      recurrence: patch.recurrence ?? ev.recurrence,
      durationMin: patch.durationMin ?? ev.durationMin,
      location: patch.location ?? ev.location,
      task: patch.task ?? ev.task,
      catchUp: patch.catchUp ?? ev.catchUp,
      runWhileAway: patch.runWhileAway ?? ev.runWhileAway,
      tz: patch.tz ?? ev.tz,
    };
    const built = this.#build(actor, merged, ev);
    if (!built.ok) return built;
    const next = built.event;
    // Any agent edit of a recurring event or a meeting goes back to the player.
    const needsApproval = actor.kind === 'agent' && (isRecurring(next.recurrence) || next.kind === 'meeting');
    // Never re-fire an occurrence that already happened.
    const sameClock = next.clock === ev.clock;
    const lastAt = sameClock ? ev.ring[ev.ring.length - 1]?.at : undefined;
    if (lastAt !== undefined && next.nextAt !== null && next.nextAt <= lastAt) {
      next.nextAt = occurrenceAfter(next, lastAt);
    }
    const updated: CalendarEvent = {
      ...next,
      id: ev.id,
      createdBy: ev.createdBy,
      createdByName: ev.createdByName,
      createdByCeo: ev.createdByCeo,
      createdAt: ev.createdAt,
      ring: sameClock ? ev.ring : [],
      orphaned: ev.orphaned,
      orphanKept: ev.orphanKept,
      lastMeetingAt: ev.lastMeetingAt,
      lastMeetingTick: ev.lastMeetingTick,
      status: needsApproval
        ? 'awaiting_approval'
        : ev.status === 'completed' || ev.status === 'awaiting_approval'
          ? next.nextAt === null
            ? 'completed'
            : 'active'
          : ev.status,
    };
    if (patch.assignees !== undefined && updated.orphaned) {
      updated.orphaned = false;
      updated.orphanKept = false;
    }
    this.#events.set(id, updated);
    if (needsApproval) this.#requestApproval(updated);
    this.#save();
    this.#changed();
    if (!needsApproval) this.tick();
    return { ok: true, event: structuredClone(this.#events.get(id) ?? updated), needsApproval };
  }

  /** `calendar_cancel` / `calendar.cancel`. */
  cancel(actor: CalendarActor, id: string): CalendarResult<{ event: CalendarEvent }> {
    const ev = this.#events.get(id);
    if (!ev || ev.status === 'cancelled')
      return fail('NOT_FOUND', `no calendar event "${singleLine(id, 40)}"`);
    const rights = this.#checkEditRights(actor, ev);
    if (rights) return rights;
    if (ev.status === 'awaiting_approval') this.#sink.withdrawApproval?.(`cal:${ev.id}`);
    ev.status = 'cancelled';
    ev.nextAt = null;
    ev.updatedAt = this.#clock.now();
    for (const occ of ev.ring) {
      if (occ.status === 'deferred') occ.status = 'cancelled';
      for (const [agent, st] of Object.entries(occ.assignees ?? {})) {
        if (st === 'deferred' && occ.assignees) occ.assignees[agent] = 'cancelled';
      }
    }
    this.#deferred = this.#deferred.filter((d) => d.eventId !== id);
    this.#save();
    this.#changed();
    return { ok: true, event: structuredClone(ev) };
  }

  /** The player's answer to an approval card. */
  decideApproval(
    eventId: string,
    approved: boolean,
    note?: string,
  ): CalendarResult<{ event: CalendarEvent }> {
    const ev = this.#events.get(eventId);
    if (ev?.status !== 'awaiting_approval') return fail('NOT_FOUND', 'no event waiting for approval');
    ev.updatedAt = this.#clock.now();
    if (approved) {
      ev.status = 'active';
      const now = this.#nowFor(ev.clock);
      if (now !== null) ev.nextAt = occurrenceAtOrAfter(ev, Math.max(now, ev.start));
    } else {
      ev.status = 'declined';
      ev.nextAt = null;
    }
    if (ev.createdBy !== 'player') {
      const verdict = approved ? 'approved' : 'declined';
      const extra = note ? ` Note: ${singleLine(note, 200)}` : '';
      this.#sink.context?.(
        [ev.createdBy],
        this.#nonce.line('APPROVAL', `${this.#playerName} ${verdict} "${ev.title}".${extra}`),
      );
    }
    this.#save();
    this.#changed();
    if (approved) this.tick();
    return { ok: true, event: structuredClone(ev) };
  }

  /** The player resolves an orphaned real-clock event. */
  resolveOrphan(id: string, action: OrphanAction): CalendarResult<{ event: CalendarEvent }> {
    const ev = this.#events.get(id);
    if (!ev?.orphaned) return fail('NOT_FOUND', 'no orphaned event with that id');
    ev.updatedAt = this.#clock.now();
    switch (action.action) {
      case 'reassign': {
        const assignees = this.#normalizeAssignees(action.assignees);
        if (!assignees) return fail('INVALID', 'assignees must be agent ids or "all"');
        ev.assignees = assignees;
        ev.orphaned = false;
        ev.orphanKept = false;
        if (ev.status === 'paused') ev.status = 'active';
        break;
      }
      case 'keep':
        ev.orphanKept = true;
        break;
      case 'pause':
        ev.status = 'paused';
        ev.orphanKept = true;
        break;
    }
    this.#save();
    this.#changed();
    return { ok: true, event: structuredClone(ev) };
  }

  /** Pauses or resumes an event (player). */
  setPaused(id: string, paused: boolean): CalendarResult<{ event: CalendarEvent }> {
    const ev = this.#events.get(id);
    if (!ev || (ev.status !== 'active' && ev.status !== 'paused'))
      return fail('NOT_FOUND', 'no such active event');
    ev.status = paused ? 'paused' : 'active';
    if (!paused) {
      const now = this.#nowFor(ev.clock);
      if (now !== null) ev.nextAt = occurrenceAtOrAfter(ev, Math.max(now, ev.start));
    }
    ev.updatedAt = this.#clock.now();
    this.#save();
    this.#changed();
    return { ok: true, event: structuredClone(ev) };
  }

  /**
   * `mc__report_task{eventId, status, note}`: closes the agent's open occurrence. Only `failed` or `blocked` wakes the
   * CEO; `done` goes to its digest.
   */
  reportTask(
    agentId: string,
    input: { eventId: string; status: ReportStatus; note?: string | undefined },
  ): CalendarResult<{ event: CalendarEvent; occurrence: Occurrence }> {
    const ev = this.#events.get(input.eventId);
    if (!ev) return fail('NOT_FOUND', `no calendar event "${singleLine(input.eventId, 40)}"`);
    if (input.status !== 'done' && input.status !== 'failed' && input.status !== 'blocked') {
      return fail('INVALID', 'status must be done, failed or blocked');
    }
    const occ = [...ev.ring].reverse().find((o) => o.assignees?.[agentId] === 'fired');
    if (!occ?.assignees) return fail('NO_OPEN_OCCURRENCE', 'you have no open occurrence of that event');
    occ.assignees[agentId] = input.status;
    occ.status = this.#aggregate(occ);
    if (input.note) occ.note = singleLine(input.note, 200);
    ev.updatedAt = this.#clock.now();

    const ceo = this.#crew.ceoId();
    const who = this.#crew.name(agentId);
    const note = input.note ? `: ${singleLine(input.note, 200)}` : '';
    if (ceo && ceo !== agentId) {
      const headline = `${who} reported "${ev.title}" ${input.status}`;
      const env = input.note
        ? wrapNote({ author: { kind: 'agent', name: who }, kind: 'calendar', id: ev.id }, input.note)
        : undefined;
      if (input.status === 'done')
        this.#sink.context?.([ceo], this.#nonce.line('REPORT', `${headline}${note}`));
      else this.#sink.wake?.(ceo, this.#nonce.message('REPORT', `${headline}.`, env), 'P3');
    }
    this.#releaseQueued(agentId);
    this.#save();
    this.#changed();
    return { ok: true, event: structuredClone(ev), occurrence: structuredClone(occ) };
  }

  /** The MeetingRunner reports what became of a fired meeting occurrence (held, missed, postponed). */
  recordOccurrence(eventId: string, at: number, status: OccurrenceStatus, note?: string): void {
    const ev = this.#events.get(eventId);
    if (!ev) return;
    const occ = ev.ring.find((o) => o.at === at);
    if (occ) {
      occ.status = status;
      if (note) occ.note = singleLine(note, 200);
    } else {
      this.#pushRing(ev, { at, status, note });
    }
    if (ev.kind === 'meeting' && (status === 'done' || status === 'fired')) {
      ev.lastMeetingAt = this.#clock.now();
      ev.lastMeetingTick = this.#gameTicks ?? undefined;
    }
    this.#save();
    this.#changed();
  }

  // -------------------------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------------------------

  /** One firing pass. Called every second and on every game-clock update. */
  tick(): void {
    const nowReal = this.#clock.now();
    const wasAfk = this.#afk;
    this.#afk = nowReal - this.#lastInputAt >= this.#limits.afkMs;
    if (wasAfk && !this.#afk) this.#releaseAfk();

    let changed = false;
    for (const ev of this.#events.values()) {
      if (ev.status !== 'active' || ev.nextAt === null) continue;
      const now = this.#nowFor(ev.clock);
      if (now === null || ev.nextAt > now) continue;
      this.#processDue(ev, now);
      changed = true;
    }
    this.#expireDeferred(nowReal);
    this.#flushOfflineMissed();
    this.#pumpStagger();
    if (changed) {
      this.#save();
      this.#changed();
    }
  }

  #processDue(ev: CalendarEvent, now: number): void {
    const due: number[] = [];
    let t: number | null = ev.nextAt;
    while (t !== null && t <= now && due.length < 400) {
      due.push(t);
      t = occurrenceAfter(ev, t);
    }
    if (t !== null && t <= now) t = occurrenceAfter(ev, now);
    ev.nextAt = t;
    if (t === null && !isRecurring(ev.recurrence)) ev.status = 'completed';

    const latest = due[due.length - 1];
    if (latest === undefined) return;
    const slack = ev.clock === 'game' ? this.#limits.gameSlackTicks : this.#limits.realSlackMs;
    const grace = ev.clock === 'game' ? this.#limits.gameGraceTicks : this.#limits.realGraceMs;
    // Everything before the latest due occurrence was skipped (time jump or app closed).
    const skipped = due.slice(0, -1);
    for (const at of skipped.slice(-RING_SIZE))
      this.#pushRing(ev, { at, status: 'missed', note: 'missed while offline' });
    if (skipped.length > 0) this.#noteOfflineMissed(ev);

    const lateness = now - latest;
    if (lateness <= slack) {
      this.#fire(ev, latest, false);
    } else if (ev.catchUp === 'once_late' && lateness <= grace) {
      this.#pushRing(ev, { at: latest, status: 'deferred', note: 'catching up' });
      this.#queueStagger(() => this.#fire(ev, latest, true));
    } else {
      this.#pushRing(ev, { at: latest, status: 'missed', note: 'missed while offline' });
      this.#noteOfflineMissed(ev);
    }
  }

  #isPausedByAfk(ev: CalendarEvent): boolean {
    if (!this.#afk || ev.runWhileAway || ev.kind === 'reminder') return false;
    return ev.createdBy !== 'player' || ev.clock === 'game';
  }

  #fire(ev: CalendarEvent, at: number, late: boolean): void {
    if (ev.status === 'cancelled' || ev.status === 'paused' || ev.status === 'declined') return;
    if (ev.orphaned) {
      this.#pushRing(ev, { at, status: 'orphaned', note: 'assignees died with their world' });
      return;
    }
    if (this.#isPausedByAfk(ev)) {
      this.#pushRing(ev, { at, status: 'deferred', note: `paused while ${this.#playerName} is away` });
      this.#deferred.push({
        eventId: ev.id,
        at,
        agentId: '*',
        reason: 'afk',
        until: 0,
        expiresAt: Number.POSITIVE_INFINITY,
      });
      return;
    }
    switch (ev.kind) {
      case 'reminder':
        this.#fireReminder(ev, at, late);
        break;
      case 'meeting':
        this.#fireMeeting(ev, at, late);
        break;
      default:
        this.#fireTask(ev, at, late);
    }
    this.#save();
    this.#changed();
  }

  #fireReminder(ev: CalendarEvent, at: number, late: boolean): void {
    const assignees = ev.assignees === 'all' ? [...this.#crew.living()] : ev.assignees;
    this.#pushRing(ev, { at, status: 'fired', firedAt: this.#clock.now(), late });
    const text = `Reminder: ${ev.title}`;
    this.#sink.reminder?.({ eventId: ev.id, occurrence: at, title: ev.title, assignees, text });
    this.#toasts.push(text);
    this.#sink.fired?.(ev.id, at);
  }

  #fireMeeting(ev: CalendarEvent, at: number, late: boolean): void {
    if (isRecurring(ev.recurrence) && ev.lastMeetingAt !== undefined) {
      const tooSoonReal = this.#clock.now() - ev.lastMeetingAt < this.#limits.meetingGapMs;
      const tooSoonGame =
        ev.lastMeetingTick !== undefined &&
        this.#gameTicks !== null &&
        this.#gameTicks - ev.lastMeetingTick < this.#limits.meetingGapTicks;
      if (tooSoonReal || tooSoonGame) {
        this.#pushRing(ev, { at, status: 'missed', note: 'too soon after the last meeting' });
        return;
      }
    }
    this.#pushRing(ev, { at, status: 'fired', firedAt: this.#clock.now(), late });
    this.#sink.startMeeting?.({ event: structuredClone(ev), occurrence: at });
    this.#toasts.push(`Meeting: ${ev.title}`);
    this.#sink.fired?.(ev.id, at);
  }

  #fireTask(ev: CalendarEvent, at: number, late: boolean): void {
    const assignees = ev.assignees === 'all' ? [...this.#crew.living()] : [...ev.assignees];
    const occ: Occurrence = { at, status: 'fired', assignees: {}, firedAt: this.#clock.now(), late };
    this.#pushRing(ev, occ);
    const stored = ev.ring.find((o) => o.at === at) ?? occ;
    stored.assignees = stored.assignees ?? {};
    for (const agentId of assignees) {
      stored.assignees[agentId] = this.#deliverTo(ev, at, agentId, late);
    }
    stored.status = assignees.length === 0 ? 'missed' : this.#aggregate(stored);
    if (assignees.length === 0) stored.note = 'nobody to do it';
    this.#sink.fired?.(ev.id, at);
  }

  /** Delivers one occurrence to one assignee, or defers it. Returns the assignee's status. */
  #deliverTo(ev: CalendarEvent, at: number, agentId: string, late: boolean): OccurrenceStatus {
    const nowReal = this.#clock.now();
    const status = this.#crew.status(agentId);
    if (status !== 'alive') return 'missed';
    if (this.#crew.inMeeting(agentId)) {
      this.#deferred.push({
        eventId: ev.id,
        at,
        agentId,
        reason: 'meeting',
        until: 0,
        expiresAt: nowReal + this.#limits.queueTtlMs,
      });
      return 'deferred';
    }
    const usage = this.#crew.usage(agentId);
    if (usage.state === 'asleep') {
      const resetsAt = usage.resetsAt ?? nowReal + this.#limits.asleepGraceMs + 1;
      if (resetsAt - nowReal > this.#limits.asleepGraceMs) return 'missed';
      this.#deferred.push({
        eventId: ev.id,
        at,
        agentId,
        reason: 'asleep',
        until: resetsAt,
        expiresAt: nowReal + this.#limits.asleepGraceMs,
      });
      return 'deferred';
    }
    const ceoAssigned = ev.createdByCeo && ev.createdBy !== agentId;
    if (ceoAssigned && this.#openCeoTask(agentId, ev.id, at)) {
      this.#deferred.push({
        eventId: ev.id,
        at,
        agentId,
        reason: 'queued',
        until: 0,
        expiresAt: nowReal + this.#limits.queueTtlMs,
      });
      return 'deferred';
    }
    if (ev.createdBy !== 'player') {
      const charged = this.#sink.chargeWake?.(ev.createdBy, agentId) ?? true;
      if (!charged) return 'missed';
    }
    const selfScheduled = ev.createdBy === agentId;
    const when = this.formatWhen(ev, at);
    const where = ev.location ? ` at ${singleLine(ev.location, 40)}` : '';
    const headline = `${ev.title} (${when}${where}${late ? ', late' : ''}). When finished, report_task{eventId:"${ev.id}"}.`;
    const envelope = wrapNote(
      {
        author: { kind: ev.createdBy === 'player' ? 'player' : 'agent', name: ev.createdByName },
        kind: 'calendar',
        id: ev.id,
        title: ev.title,
      },
      ev.task || ev.title,
    );
    this.#sink.deliverTask?.({
      agentId,
      eventId: ev.id,
      occurrence: at,
      priority: selfScheduled ? 'P4' : 'P1',
      text: this.#nonce.message('SCHEDULED', headline, envelope),
      location: ev.location,
      late,
    });
    return 'fired';
  }

  /** Whether the agent has an open CEO-assigned task other than this occurrence. */
  #openCeoTask(agentId: string, eventId: string, at: number): boolean {
    const now = this.#clock.now();
    for (const ev of this.#events.values()) {
      if (!ev.createdByCeo || ev.createdBy === agentId || ev.kind !== 'task') continue;
      for (const occ of ev.ring) {
        if (ev.id === eventId && occ.at === at) continue;
        if (occ.assignees?.[agentId] !== 'fired') continue;
        if (occ.firedAt !== undefined && now - occ.firedAt > this.#limits.openTaskTtlMs) continue;
        return true;
      }
    }
    return false;
  }

  #releaseQueued(agentId: string): void {
    const next = this.#deferred
      .filter((d) => d.agentId === agentId && d.reason === 'queued')
      .sort((a, b) => a.at - b.at)[0];
    if (!next) return;
    this.#deferred = this.#deferred.filter((d) => d !== next);
    this.#retryDeferred(next);
  }

  #retryDeferred(d: Deferred): void {
    const ev = this.#events.get(d.eventId);
    if (!ev || ev.status === 'cancelled' || ev.status === 'declined') return;
    const occ = ev.ring.find((o) => o.at === d.at);
    if (!occ) return;
    if (d.reason === 'afk') {
      // Back from AFK: apply the catch-up rule to the paused occurrence.
      const now = this.#nowFor(ev.clock);
      const grace = ev.clock === 'game' ? this.#limits.gameGraceTicks : this.#limits.realGraceMs;
      const slack = ev.clock === 'game' ? this.#limits.gameSlackTicks : this.#limits.realSlackMs;
      const lateness = now === null ? Number.POSITIVE_INFINITY : now - d.at;
      if (lateness <= slack || (ev.catchUp === 'once_late' && lateness <= grace)) {
        occ.status = 'cancelled'; // replaced by the real firing below
        ev.ring = ev.ring.filter((o) => o !== occ);
        this.#fire(ev, d.at, lateness > slack);
      } else {
        occ.status = 'missed';
        occ.note = `missed while ${this.#playerName} was away`;
      }
      this.#save();
      this.#changed();
      return;
    }
    occ.assignees = occ.assignees ?? {};
    occ.assignees[d.agentId] = this.#deliverTo(ev, d.at, d.agentId, true);
    occ.status = this.#aggregate(occ);
    this.#save();
    this.#changed();
  }

  #releaseAfk(): void {
    const held = this.#deferred.filter((d) => d.reason === 'afk');
    this.#deferred = this.#deferred.filter((d) => d.reason !== 'afk');
    for (const d of held) this.#queueStagger(() => this.#retryDeferred(d));
  }

  #expireDeferred(nowReal: number): void {
    const keep: Deferred[] = [];
    for (const d of this.#deferred) {
      if (d.reason === 'asleep' && nowReal >= d.until && nowReal < d.expiresAt) {
        this.#queueStagger(() => this.#retryDeferred(d));
        continue;
      }
      if (nowReal >= d.expiresAt) {
        const ev = this.#events.get(d.eventId);
        const occ = ev?.ring.find((o) => o.at === d.at);
        if (occ?.assignees) {
          occ.assignees[d.agentId] = 'missed';
          occ.status = this.#aggregate(occ);
        }
        continue;
      }
      keep.push(d);
    }
    this.#deferred = keep;
  }

  #queueStagger(fn: () => void): void {
    this.#stagger.push(fn);
  }

  #pumpStagger(): void {
    const now = this.#clock.now();
    while (this.#stagger.length > 0 && now - this.#lastStaggerAt >= this.#limits.staggerMs) {
      const fn = this.#stagger.shift();
      this.#lastStaggerAt = now;
      fn?.();
    }
  }

  #noteOfflineMissed(ev: CalendarEvent): void {
    this.#offlineMissed.push({ title: ev.title, assignees: ev.assignees === 'all' ? [] : ev.assignees });
  }

  #flushOfflineMissed(): void {
    if (this.#offlineMissed.length === 0) return;
    const items = this.#offlineMissed;
    this.#offlineMissed = [];
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.title, (counts.get(i.title) ?? 0) + 1);
    const list = [...counts.entries()].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
    const line = this.#nonce.line('MISSED', `Missed while offline: ${list}.`);
    const targets = new Set<string>();
    const ceo = this.#crew.ceoId();
    if (ceo) targets.add(ceo);
    for (const i of items) for (const a of i.assignees) if (this.#crew.status(a) === 'alive') targets.add(a);
    if (targets.size > 0) this.#sink.context?.([...targets], line);
  }

  #aggregate(occ: Occurrence): OccurrenceStatus {
    const all = Object.values(occ.assignees ?? {});
    if (all.length === 0) return occ.status;
    const first = all[0] as OccurrenceStatus;
    if (all.every((s) => s === first)) return first;
    for (const s of ['deferred', 'fired', 'failed', 'blocked', 'done'] as const)
      if (all.includes(s)) return s;
    return 'missed';
  }

  #pushRing(ev: CalendarEvent, occ: Occurrence): void {
    const existing = ev.ring.find((o) => o.at === occ.at);
    if (existing) Object.assign(existing, occ);
    else ev.ring.push(occ);
    ev.ring.sort((a, b) => a.at - b.at);
    if (ev.ring.length > RING_SIZE) ev.ring.splice(0, ev.ring.length - RING_SIZE);
  }

  // -------------------------------------------------------------------------------------------
  // Building and validating events
  // -------------------------------------------------------------------------------------------

  #nowFor(clock: ClockKind): number | null {
    return clock === 'game' ? this.#gameTicks : this.#clock.now();
  }

  #parseBound(v: string | number | undefined, clock: ClockKind): number | null {
    if (v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const now = this.#nowFor(clock);
    if (now === null) return null;
    return clock === 'game' ? parseGameWhen(v, now) : parseRealWhen(v, now, this.#tz);
  }

  #normalizeAssignees(input: readonly string[] | 'all' | undefined): string[] | 'all' | null {
    if (input === 'all') return 'all';
    if (!Array.isArray(input)) return null;
    const ids = [...new Set(input.map((s) => String(s).trim()).filter((s) => s.length > 0))];
    if (ids.length === 0 || ids.length > 16) return null;
    if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))) return null;
    return ids;
  }

  #checkEditRights(actor: CalendarActor, ev: CalendarEvent): CalendarFailure | null {
    if (actor.kind === 'player') return null;
    if (ev.createdBy === 'player') {
      return fail('FORBIDDEN', `${this.#playerName} created this event; agents cannot change or cancel it`);
    }
    if (ev.createdBy !== actor.id && !this.#crew.isCeo(actor.id)) {
      return fail('FORBIDDEN', 'only the CEO changes events other agents created');
    }
    return null;
  }

  #build(
    actor: CalendarActor,
    input: CalendarAddInput,
    existing: CalendarEvent | null,
  ): CalendarResult<{ event: CalendarEvent }> {
    const title = sanitizeTitle(String(input.title ?? ''));
    if (!title) return fail('INVALID', 'a title is required');
    const kind: EventKind = input.kind ?? 'task';
    if (kind !== 'task' && kind !== 'reminder' && kind !== 'meeting') {
      return fail('INVALID', 'kind must be task, reminder or meeting');
    }
    const clock: ClockKind = input.clock ?? 'game';
    if (clock !== 'game' && clock !== 'real') return fail('INVALID', 'clock must be game or real');
    const recurrence = normalizeRecurrence(input.recurrence);
    if (!recurrence)
      return fail('INVALID', 'recurrence must be once, daily, every_n_days (1-365) or weekdays');
    if (recurrence.kind === 'weekdays' && clock !== 'real') {
      return fail('INVALID', 'weekdays recurrence needs the real clock');
    }
    const durationMin = input.durationMin ?? (kind === 'meeting' ? 10 : 30);
    if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > 24 * 60) {
      return fail('INVALID', 'durationMin must be 1-1440');
    }
    const catchUp: CatchUp = input.catchUp ?? 'skip';
    if (catchUp !== 'skip' && catchUp !== 'once_late')
      return fail('INVALID', 'catchUp must be skip or once_late');
    const task = String(input.task ?? '').slice(0, MAX_TASK_CHARS);
    const location = input.location
      ? singleLine(String(input.location), 64)
      : kind === 'meeting'
        ? 'meeting_table'
        : undefined;

    // Assignees and rights.
    const defaultAssignees = actor.kind === 'agent' && kind !== 'meeting' ? [actor.id] : 'all';
    const assignees = this.#normalizeAssignees(input.assignees ?? defaultAssignees);
    if (!assignees) return fail('INVALID', 'assignees must be 1-16 agent ids or "all"');
    const isCeo = actor.kind === 'agent' && this.#crew.isCeo(actor.id);
    if (actor.kind === 'agent' && !isCeo) {
      if (kind === 'meeting') return fail('FORBIDDEN', 'only the CEO or the player calls meetings');
      if (assignees === 'all' || assignees.length !== 1 || assignees[0] !== actor.id) {
        return fail('FORBIDDEN', 'you can only schedule for yourself; ask the CEO to assign others');
      }
    }
    if (assignees !== 'all') {
      for (const id of assignees) {
        if (existing?.assignees !== 'all' && existing?.assignees.includes(id)) continue;
        if (this.#crew.status(id) !== 'alive') {
          return fail('INVALID', `${singleLine(id, 40)} is not a living crew member`);
        }
      }
    }

    // Time zone and start.
    let tz: string | undefined;
    if (clock === 'real') {
      tz = input.tz ?? existing?.tz ?? this.#tz;
      if (!isValidTimeZone(tz)) return fail('INVALID', `unknown time zone "${singleLine(tz, 40)}"`);
    }
    const now = this.#nowFor(clock);
    if (now === null) return fail('NO_CLOCK', 'the world clock is not known yet; try again in a moment');
    let start: number | null;
    let wallTime: { hour: number; minute: number } | undefined;
    const when = input.when;
    if (when === 'now') {
      start = now;
    } else if (typeof when === 'number' && Number.isFinite(when)) {
      start = Math.round(when);
    } else if (typeof when === 'string') {
      start = clock === 'game' ? parseGameWhen(when, now) : parseRealWhen(when, now, tz ?? this.#tz);
    } else {
      start = null;
    }
    if (start === null) {
      return fail(
        'INVALID',
        clock === 'game'
          ? 'when must be "now", "Day N hh:mm" or "hh:mm"'
          : 'when must be "now", "YYYY-MM-DD hh:mm", "hh:mm" or an ISO time',
      );
    }
    if (clock === 'real') {
      const p = zonedParts(start, tz ?? this.#tz);
      wallTime = { hour: p.hour, minute: p.minute };
    }
    const slack = clock === 'game' ? this.#limits.gameSlackTicks : this.#limits.realSlackMs;
    const schedule = { clock, start, recurrence, tz, wallTime };
    const nextAt = occurrenceAtOrAfter(schedule, Math.max(start, now - slack));
    if (nextAt === null || (!isRecurring(recurrence) && start < now - slack)) {
      return fail(
        'IN_PAST',
        `that time (${clock === 'game' ? formatGameTime(start) : formatRealTime(start, tz ?? this.#tz)}) has passed`,
      );
    }

    const nowReal = this.#clock.now();
    const event: CalendarEvent = {
      id: existing?.id ?? `ev-${randomBytes(4).toString('hex')}`,
      title,
      kind,
      assignees,
      clock,
      start,
      tz,
      wallTime,
      recurrence,
      durationMin: Math.round(durationMin),
      location,
      task,
      createdBy: actor.kind === 'player' ? 'player' : actor.id,
      createdByName: actor.name,
      createdByCeo: isCeo,
      catchUp,
      runWhileAway: input.runWhileAway === true,
      status: 'active',
      orphaned: false,
      nextAt,
      ring: [],
      createdAt: nowReal,
      updatedAt: nowReal,
      worldId: clock === 'game' ? (this.#worldId ?? undefined) : undefined,
    };
    return { ok: true, event };
  }

  #requestApproval(ev: CalendarEvent): void {
    const when = ev.nextAt !== null ? this.formatWhen(ev, ev.nextAt) : '?';
    const who = ev.assignees === 'all' ? 'everyone' : ev.assignees.map((a) => this.#crew.name(a)).join(', ');
    this.#sink.requestApproval?.({
      cardId: `cal:${ev.id}`,
      eventId: ev.id,
      agentId: ev.createdBy,
      title: ev.title,
      summary: `${ev.kind} for ${who}, ${describeRecurrence(ev.recurrence)} from ${when}`,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Persistence and notifications
  // -------------------------------------------------------------------------------------------

  #changed(): void {
    try {
      this.#sink.changed?.();
    } catch (e) {
      this.#log?.warn({ err: e }, 'calendar changed listener failed');
    }
  }

  async #loadFile(path: string | null): Promise<CalendarEvent[]> {
    if (!path) return [];
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<PersistedFile>;
      const events = Array.isArray(raw.events) ? raw.events : [];
      for (const ev of events) {
        // Deferred deliveries do not survive a restart.
        for (const occ of ev.ring ?? []) {
          if (occ.status === 'deferred') {
            occ.status = 'missed';
            occ.note = 'app restarted';
          }
          for (const [a, st] of Object.entries(occ.assignees ?? {})) {
            if (st === 'deferred' && occ.assignees) occ.assignees[a] = 'missed';
          }
        }
        ev.ring = ev.ring ?? [];
      }
      return events;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.#log?.warn({ err: e, path }, 'calendar file unreadable');
      return [];
    }
  }

  /** Drops finished events (completed, cancelled, declined) a week after their last change. */
  #prune(): void {
    const cutoff = this.#clock.now() - 7 * 86_400_000;
    for (const ev of [...this.#events.values()]) {
      const finished = ev.status === 'completed' || ev.status === 'cancelled' || ev.status === 'declined';
      if (finished && ev.updatedAt < cutoff) {
        this.#events.delete(ev.id);
      }
    }
  }

  #save(): void {
    this.#prune();
    const lasting = [...this.#events.values()].filter((e) => e.clock === 'real');
    const world = [...this.#events.values()].filter((e) => e.clock === 'game');
    const worldId = this.#worldId;
    const lastingFile = this.#lastingFile;
    const worldFile = worldId !== null && this.#worldFile ? this.#worldFile(worldId) : null;
    const lastingText = `${JSON.stringify({ v: 1, events: lasting } satisfies PersistedFile, null, 1)}\n`;
    const worldText = `${JSON.stringify({ v: 1, events: world } satisfies PersistedFile, null, 1)}\n`;
    this.#saveQueue = this.#saveQueue
      .then(async () => {
        if (lastingFile) await writeFileAtomic(lastingFile, lastingText, { mode: 0o600 });
        if (worldFile) await writeFileAtomic(worldFile, worldText, { mode: 0o600 });
      })
      .catch((e: unknown) => this.#log?.error({ err: e }, 'calendar save failed'));
  }
}

/** Game day of a tick value, re-exported for screens. */
export { gameDay };
