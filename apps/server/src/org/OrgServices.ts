/**
 * OrgServices: CodexStore + CalendarService + MeetingRunner + ApproachQueue, the engine behind the OrgApi
 * (contracts/OrgApi.ts; implemented over this class by contractApi.ts, wired to the bridge and the crew by module.ts).
 *
 * Wiring
 * - Calendar meetings → MeetingRunner; attendees count as "in a meeting" for the calendar (tasks deferred).
 * - Meeting minutes → CodexStore (`minutes`, world scope); action items → CalendarService (as the chair).
 * - Calendar approval cards (agent-created recurring events and meetings) → the host's card store (the crew's
 *   pending cards, which feed the ApproachQueue), or straight into the ApproachQueue when the host keeps no cards,
 *   so the creating agent comes to the player like with a hire.
 * - Pushes are protocol payloads (wire.ts): `codex.index`, `calendar.state` and `meeting.state` are coalesced per
 *   tick; `calendar.fired` goes out when an occurrence fires and again, with a longer `walk`, as each assignee's
 *   brain accepts the task (the host's `deliver` resolves).
 *
 * The host supplies crew and world queries and delivers messages; everything here is testable without the mod.
 */

import { join } from 'node:path';
import type { PayloadOf, Place } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { type MineVibePaths, worldDir } from '../config/paths.js';
import type { OrgToolResult } from '../contracts/OrgApi.js';
import {
  type ApproachCard,
  type ApproachEffects,
  ApproachQueue,
  type ApproachSnapshot,
  type ApproachState,
} from './approach/ApproachQueue.js';
import {
  type CalendarActor,
  type CalendarAddInput,
  type CalendarApprovalCard,
  type CalendarCrew,
  CalendarService,
  type OrphanAction,
  type UsageState,
} from './calendar/CalendarService.js';
import { formatEventsForAgent } from './calendar/format.js';
import type { CalendarEvent } from './calendar/types.js';
import { formatGameTime, type OrgClock, systemClock } from './clock.js';
import { BASE_NAME, BASE_PAGE_TAGS, basePageBody } from './codex/basePage.js';
import { type CodexIndexEntry, CodexStore } from './codex/CodexStore.js';
import {
  formatListForAgent,
  formatPageForAgent,
  formatSearchForAgent,
  formatWriteResult,
} from './codex/format.js';
import {
  type CodexActor,
  type CodexHistoryEntry,
  type CodexPage,
  type CodexSearchHit,
  type CodexWriteResult,
  type Coords,
  isCodexCategory,
} from './codex/types.js';
import { ControlNonce, singleLine } from './envelope.js';
import {
  type AttendeeMode,
  type MeetingBrain,
  type MeetingEffects,
  type MeetingRequest,
  MeetingRunner,
  type MeetingState,
  type PlayerSnapshot,
  type StatusLine,
} from './meeting/MeetingRunner.js';
import {
  CalendarAddToolInput,
  CalendarCancelInput,
  CalendarListInput,
  CalendarUpdateToolInput,
  CodexListInput,
  CodexReadInput,
  CodexSearchInput,
  CodexWriteToolInput,
  normalizeToolInput,
  ReportTaskInput,
} from './toolInputs.js';
import { toWireCalendarFired, toWireCalendarState, toWireCodexIndex, toWireMeetingState } from './wire.js';
import { mcRefs } from '../contracts/mcRefs.js';

export type { OrgToolResult };

/** A crew member as the org services see it (from the agent runtime and the mod's 1 Hz agent.state). */
export interface OrgCrewMember {
  readonly agentId: string;
  readonly name: string;
  readonly handle?: string | undefined;
  readonly status: 'alive' | 'dead' | 'dismissed';
  readonly isCeo: boolean;
  /** Seated at a PC. */
  readonly seated: boolean;
  readonly dimension: string;
  readonly escortingPlayer: boolean;
  readonly distanceToPlayer: number | null;
  readonly usage: { readonly state: UsageState; readonly resetsAt?: number | undefined };
  /** Real block position (for `here:true` Codex stamps). */
  readonly position?: Coords | null | undefined;
}

export type OrgPushType = 'codex.index' | 'calendar.state' | 'calendar.fired' | 'meeting.state';

export type DeliveryPriority = 'P1' | 'P3' | 'P4' | 'context';

export interface OrgHost {
  crew(): readonly OrgCrewMember[];
  /** Crew-wide usage (UsageGovernor): Tired shortens meetings, Asleep postpones them. */
  usage(): { state: UsageState; resetsAt?: number | undefined };
  player(): PlayerSnapshot;
  etaSeconds(agentId: string): number | null;
  tableDimension(): string;
  statusLine?(agentId: string): StatusLine;
  /**
   * A wake at a priority, or a `shouldQuery:false` context message. For a calendar task (`eventId` and
   * `occurrence` set) the returned promise resolves once the agent's brain has accepted the task: the agent then
   * walks to the event's location (`calendar.fired` re-sent with the agent in `walk`).
   */
  deliver(
    agentId: string,
    text: string,
    how: {
      priority: DeliveryPriority;
      eventId?: string | undefined;
      location?: string | undefined;
      occurrence?: number | undefined;
    },
  ): undefined | Promise<unknown> | unknown;
  chargeWake?(creatorId: string, assigneeId: string): boolean;
  toast?(text: string): void;
  reminder?(r: { eventId: string; title: string; assignees: readonly string[]; text: string }): void;
  /**
   * Raises the approval card in the host's card store and returns its card id; the card then reaches the
   * ApproachQueue through the store ({@link OrgServices.cardPending}). Without a store (no id returned) the
   * ApproachQueue gets the card directly as `cal:<eventId>`.
   */
  requestApproval?(card: CalendarApprovalCard): string | undefined | unknown;
  /** The approval card is no longer needed: the event changed, was cancelled, or was decided elsewhere. */
  withdrawApproval?(cardId: string, reason?: string): void;
  /** Where an event location (`pc:<id>`, `meeting_table`, a Codex place) is, for `calendar.fired.target`. */
  placeOf?(location: string): Place | null;
  /** A protocol push (`payload` is the message payload, already in the wire shape). */
  push?<T extends OrgPushType>(type: T, payload: PayloadOf<T>): void;
  readonly meetingBrain: MeetingBrain;
  readonly meetingEffects?: MeetingEffects | undefined;
  readonly approachEffects?: ApproachEffects | undefined;
}

export interface OrgPaths {
  readonly codex: string;
  readonly codexExport: string | null;
  readonly lastingCalendar: string | null;
  readonly worldCalendar: ((worldId: string) => string) | null;
}

/** The org services' files inside the MineVibe data directory (PLAN §4). */
export function orgPaths(paths: MineVibePaths): OrgPaths {
  return {
    codex: paths.codex,
    codexExport: paths.codexExport,
    lastingCalendar: join(paths.calendar, 'lasting.json'),
    worldCalendar: (worldId) => join(worldDir(paths, worldId), 'calendar.json'),
  };
}

export interface OrgServicesOptions {
  readonly paths: OrgPaths;
  readonly host: OrgHost;
  readonly nonce?: ControlNonce | undefined;
  readonly clock?: OrgClock | undefined;
  readonly timeZone?: string | undefined;
  /** The player's name, or a getter (it is known only once the mod says hello). */
  readonly playerName?: string | (() => string) | undefined;
  readonly gitBinary?: string | null | undefined;
  readonly logger?: Logger | undefined;
  /** Whether `report_task` notifies the CEO from here (default true; see `CalendarServiceOptions.reportToCeo`). */
  readonly reportToCeo?: boolean | undefined;
}

/** `calendar.fired` occurrences remembered for their `walk` re-sends. */
const FIRED_MEMORY = 64;

function invalid(error: unknown): OrgToolResult {
  const issues =
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown[] }).issues)
      ? (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues
          .slice(0, 3)
          .map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`)
          .join('; ')
      : 'invalid input';
  return { ok: false, code: 'INVALID', text: `Invalid input (${singleLine(issues, 300)}).` };
}

export class OrgServices {
  readonly nonce: ControlNonce;
  readonly codex: CodexStore;
  readonly calendar: CalendarService;
  readonly meetings: MeetingRunner;
  readonly approach: ApproachQueue;
  readonly #host: OrgHost;
  readonly #playerNameOf: () => string;
  readonly #log: Logger | undefined;
  /** Fired task occurrences (`eventId@occurrence`) and the assignees that accepted them so far. */
  readonly #fired = new Map<string, { eventId: string; occurrence: number; walk: Set<string> }>();
  readonly #pending = new Set<'codex.index' | 'calendar.state' | 'meeting.state'>();
  #flushScheduled = false;
  #lastMeetingState: MeetingState | null = null;
  #lastDay: number | null = null;
  /** The "Base (office)" page write in flight or done, per world (one page per world). */
  readonly #basePages = new Map<string, Promise<string | null>>();

  constructor(options: OrgServicesOptions) {
    const host = options.host;
    const clock = options.clock ?? systemClock;
    this.#host = host;
    const playerName = options.playerName ?? 'the player';
    this.#playerNameOf = typeof playerName === 'function' ? playerName : () => playerName;
    this.#log = options.logger;
    this.nonce = options.nonce ?? new ControlNonce();

    const member = (id: string) => host.crew().find((c) => c.agentId === id);
    const crew: CalendarCrew = {
      living: () =>
        host
          .crew()
          .filter((c) => c.status === 'alive')
          .map((c) => c.agentId),
      status: (id) => member(id)?.status ?? 'unknown',
      isCeo: (id) => {
        const m = member(id);
        return m?.isCeo === true && m.status === 'alive';
      },
      ceoId: () => host.crew().find((c) => c.isCeo && c.status === 'alive')?.agentId ?? null,
      name: (id) => member(id)?.name ?? id,
      usage: (id) => member(id)?.usage ?? { state: 'ok' },
      inMeeting: (id) => this.meetings.isAttending(id),
    };

    this.calendar = new CalendarService({
      nonce: this.nonce,
      crew,
      clock,
      timeZone: options.timeZone,
      playerName: this.#playerNameOf,
      lastingFile: options.paths.lastingCalendar,
      worldFile: options.paths.worldCalendar,
      logger: options.logger,
      reportToCeo: options.reportToCeo,
      sink: {
        deliverTask: (d) => {
          let accepted: unknown;
          try {
            accepted = host.deliver(d.agentId, d.text, {
              priority: d.priority,
              eventId: d.eventId,
              location: d.location,
              occurrence: d.occurrence,
            });
          } catch (e) {
            this.#log?.warn({ err: e, agentId: d.agentId, eventId: d.eventId }, 'task delivery failed');
            return;
          }
          void Promise.resolve(accepted).then(
            () => this.#taskAccepted(d.eventId, d.occurrence, d.agentId),
            (e: unknown) =>
              this.#log?.warn({ err: e, agentId: d.agentId, eventId: d.eventId }, 'task not accepted'),
          );
        },
        reminder: (r) => host.reminder?.(r),
        startMeeting: ({ event, occurrence }) => {
          this.meetings.request({
            title: event.title,
            attendees: event.assignees,
            createdBy: event.createdBy,
            scheduled: true,
            eventId: event.id,
            occurrence,
          });
        },
        context: (agents, text) => {
          for (const a of agents) host.deliver(a, text, { priority: 'context' });
        },
        wake: (agent, text, priority) => host.deliver(agent, text, { priority }),
        chargeWake: (creator, assignee) => host.chargeWake?.(creator, assignee) ?? true,
        toast: (text) => host.toast?.(text),
        requestApproval: (card) => {
          const stored = host.requestApproval?.(card);
          if (typeof stored === 'string') return; // the crew's card store feeds the ApproachQueue
          this.approach.enqueue({
            cardId: card.cardId,
            agentId: card.agentId,
            kind: 'calendar',
            createdAt: clock.now(),
          });
        },
        withdrawApproval: (cardId) => {
          host.withdrawApproval?.(cardId);
          this.approach.resolve(cardId);
        },
        fired: (eventId, occurrence) => this.#onFired(eventId, occurrence),
        changed: () => this.#schedulePush('calendar.state'),
      },
    });

    this.codex = new CodexStore({
      root: options.paths.codex,
      exportDir: options.paths.codexExport,
      gitBinary: options.gitBinary,
      clock,
      gameDay: () => {
        const t = this.calendar.gameTicks;
        return t === null ? null : Math.floor(t / 24_000) + 1;
      },
      positionOf: (id) => member(id)?.position ?? null,
      logger: options.logger,
    });
    this.codex.on('changed', () => this.#schedulePush('codex.index'));

    const fx = host.meetingEffects ?? {};
    this.meetings = new MeetingRunner({
      world: {
        crew: () => host.crew(),
        etaSeconds: (id) => host.etaSeconds(id),
        tableDimension: () => host.tableDimension(),
        player: () => host.player(),
        usage: () => host.usage(),
        statusLine: host.statusLine
          ? (id) => host.statusLine?.(id) ?? { todo: [], lastActivity: '' }
          : undefined,
      },
      brain: host.meetingBrain,
      nonce: this.nonce,
      codex: this.codex,
      calendar: this.calendar,
      clock,
      playerName: this.#playerNameOf,
      formatNow: () => {
        const t = this.calendar.gameTicks;
        return t === null
          ? new Date(clock.now()).toISOString().slice(0, 16).replace('T', ' ')
          : formatGameTime(t);
      },
      logger: options.logger,
      effects: {
        ...fx,
        state: (s) => {
          fx.state?.(s);
          this.#lastMeetingState = s;
          this.#schedulePush('meeting.state');
        },
      },
    });

    this.approach = new ApproachQueue({ clock, effects: host.approachEffects });
  }

  get #playerName(): string {
    return this.#playerNameOf();
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /** Opens the stores for the current world and starts the calendar loop. */
  async start(worldId: string | null): Promise<void> {
    await this.codex.open(worldId);
    await this.calendar.open(worldId);
    this.calendar.start();
  }

  async stop(): Promise<void> {
    this.calendar.stop();
    this.meetings.cancelAll('MineVibe is closing');
    // The adjourned meeting writes its partial minutes before the Codex closes.
    await this.meetings.idle();
    await this.calendar.flush();
    await this.codex.close();
  }

  async openWorld(worldId: string): Promise<void> {
    if (this.codex.worldId !== worldId) await this.codex.setWorld(worldId);
    if (this.calendar.worldId !== worldId) await this.calendar.setWorld(worldId);
    this.#lastDay = null;
  }

  async worldEnded(
    worldId: string,
  ): Promise<{ codexArchived: number; orphanedEvents: string[]; notice: string }> {
    // Queued and postponed meetings of the dead world must not run in the next one. The adjourned meeting writes
    // its partial minutes into the dead world's Codex first, so they are archived with it.
    this.meetings.cancelAll('the world ended');
    await this.meetings.idle();
    const codexArchived = await this.codex.archiveWorld(worldId);
    const orphanedEvents = await this.calendar.onWorldEnded(worldId);
    const lasting = this.codex.list({ scope: 'lasting' }).length;
    const notice = this.nonce.line(
      'CODEX',
      `The Codex survived: ${lasting} lasting page(s) carried over from the last world; its world pages were archived.`,
    );
    return { codexArchived, orphanedEvents, notice };
  }

  onGameClock(ticks: number): void {
    this.calendar.onGameClock(ticks);
    // Weekly log roll-up: once whenever a new game week starts (Day 8, 15, …; also across sleeps and jumps).
    const day = Math.floor(ticks / 24_000) + 1;
    const week = (d: number) => Math.floor((d - 1) / 7);
    if (this.#lastDay !== null && week(day) > week(this.#lastDay)) {
      void this.codex
        .rollUpLogs()
        .catch((e: unknown) => this.#log?.warn({ err: e }, 'codex log roll-up failed'));
    }
    this.#lastDay = day;
  }

  notePlayerInput(): void {
    this.calendar.notePlayerInput();
  }

  onWorldView(snapshot: ApproachSnapshot): void {
    this.approach.update({ ...snapshot, meetingAttendees: this.meetings.attendeeIds() });
  }

  // -------------------------------------------------------------------------------------------
  // Agent tools
  // -------------------------------------------------------------------------------------------

  #agentActor(agentId: string): CodexActor & CalendarActor & { kind: 'agent'; id: string } {
    const name = this.#host.crew().find((c) => c.agentId === agentId)?.name ?? agentId;
    return { kind: 'agent', id: agentId, name };
  }

  /** Agent id, handle, name (case-insensitive) or `ceo` → agent id. */
  resolveAgent(token: string): string | null {
    const crew = this.#host.crew();
    const t = token.trim().replace(/^@/, '');
    const lower = t.toLowerCase();
    if (lower === 'ceo') return crew.find((c) => c.isCeo && c.status === 'alive')?.agentId ?? null;
    const exact = crew.find((c) => c.agentId === t);
    if (exact) return exact.agentId;
    const byHandle = crew.filter((c) => c.handle?.toLowerCase() === lower);
    if (byHandle.length === 1) return byHandle[0]?.agentId ?? null;
    const byName = crew.filter((c) => c.name.toLowerCase() === lower);
    return byName.length === 1 ? (byName[0]?.agentId ?? null) : null;
  }

  #resolveAssignees(
    input: readonly string[] | 'all' | undefined,
  ): string[] | 'all' | undefined | { error: string } {
    if (input === undefined || input === 'all') return input;
    const out: string[] = [];
    for (const token of input) {
      const id = this.resolveAgent(token);
      if (!id) return { error: `nobody called "${singleLine(token, 32)}" in the crew` };
      out.push(id);
    }
    return out;
  }

  codexSearch(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CodexSearchInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const hits = this.codex.search(parsed.data.query, {
      tags: parsed.data.tags,
      category: parsed.data.category,
    });
    return { ok: true, text: formatSearchForAgent(parsed.data.query, hits) };
  }

  codexRead(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CodexReadInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const page = this.codex.get(parsed.data.id);
    if (!page) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        text: `No Codex page "${singleLine(parsed.data.id, 64)}". Try ${mcRefs().codexSearch}.`,
      };
    }
    return { ok: true, text: formatPageForAgent(page) };
  }

  async codexWrite(agentId: string, input: unknown): Promise<OrgToolResult> {
    const parsed = CodexWriteToolInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const res = await this.codex.write(this.#agentActor(agentId), parsed.data);
    return { ok: res.ok, code: res.ok ? undefined : res.code, text: formatWriteResult(res) };
  }

  codexList(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CodexListInput.safeParse(normalizeToolInput(input ?? {}));
    if (!parsed.success) return invalid(parsed.error);
    return { ok: true, text: formatListForAgent(this.codex.list(parsed.data)) };
  }

  #eventFormat() {
    return {
      formatWhen: (ev: CalendarEvent, at: number) => this.calendar.formatWhen(ev, at),
      name: (id: string) => this.#host.crew().find((c) => c.agentId === id)?.name ?? id,
    };
  }

  calendarList(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CalendarListInput.safeParse(normalizeToolInput(input ?? {}));
    if (!parsed.success) return invalid(parsed.error);
    let agent: string | undefined;
    if (parsed.data.agent) {
      agent = this.resolveAgent(parsed.data.agent) ?? undefined;
      if (!agent)
        return {
          ok: false,
          code: 'NOT_FOUND',
          text: `Nobody called "${singleLine(parsed.data.agent, 32)}".`,
        };
    }
    const events = this.calendar.list({ agent, from: parsed.data.from, to: parsed.data.to });
    return { ok: true, text: formatEventsForAgent(events, this.#eventFormat()) };
  }

  calendarAdd(agentId: string, input: unknown): OrgToolResult {
    const parsed = CalendarAddToolInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const assignees = this.#resolveAssignees(parsed.data.assignees);
    if (assignees && typeof assignees === 'object' && 'error' in assignees) {
      return { ok: false, code: 'INVALID', text: `Not scheduled: ${assignees.error}.` };
    }
    const res = this.calendar.add(this.#agentActor(agentId), {
      ...parsed.data,
      assignees,
    } as CalendarAddInput);
    if (!res.ok) return { ok: false, code: res.code, text: `Not scheduled (${res.code}): ${res.message}` };
    const ev = res.event;
    const when = this.calendar.formatWhen(ev, ev.nextAt ?? ev.start);
    const who =
      ev.assignees === 'all' ? 'everyone' : ev.assignees.map((a) => this.#eventFormat().name(a)).join(', ');
    const tail = res.needsApproval
      ? ` It waits for ${this.#playerName}'s approval; you'll hear the decision.`
      : res.firedNow
        ? ' Delivered now.'
        : '';
    return { ok: true, text: `Scheduled [${ev.id}] "${singleLine(ev.title)}" for ${who} at ${when}.${tail}` };
  }

  calendarUpdate(agentId: string, input: unknown): OrgToolResult {
    const parsed = CalendarUpdateToolInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const { id, ...patch } = parsed.data;
    const assignees = this.#resolveAssignees(patch.assignees);
    if (assignees && typeof assignees === 'object' && 'error' in assignees) {
      return { ok: false, code: 'INVALID', text: `Not changed: ${assignees.error}.` };
    }
    const res = this.calendar.update(this.#agentActor(agentId), id, {
      ...patch,
      assignees,
    } as Partial<CalendarAddInput>);
    if (!res.ok) return { ok: false, code: res.code, text: `Not changed (${res.code}): ${res.message}` };
    const tail = res.needsApproval ? ` It waits for ${this.#playerName}'s approval.` : '';
    return { ok: true, text: `Updated [${res.event.id}] "${singleLine(res.event.title)}".${tail}` };
  }

  calendarCancel(agentId: string, input: unknown): OrgToolResult {
    const parsed = CalendarCancelInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const scope = parsed.data.scope ?? 'all';
    const res = this.calendar.cancel(this.#agentActor(agentId), parsed.data.id, scope);
    if (!res.ok) return { ok: false, code: res.code, text: `Not cancelled (${res.code}): ${res.message}` };
    const what = scope === 'next' ? 'the next occurrence of ' : '';
    return { ok: true, text: `Cancelled ${what}[${res.event.id}] "${singleLine(res.event.title)}".` };
  }

  reportTask(agentId: string, input: unknown): OrgToolResult {
    const parsed = ReportTaskInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return invalid(parsed.error);
    const res = this.calendar.reportTask(agentId, parsed.data);
    if (!res.ok) return { ok: false, code: res.code, text: `Not recorded (${res.code}): ${res.message}` };
    return { ok: true, text: `Recorded "${singleLine(res.event.title)}" as ${parsed.data.status}.` };
  }

  // -------------------------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------------------------

  /**
   * Writes the world-scope places page "Base (office)" (protocol §7.4.3) for the open world, once: the office's door,
   * extent and slots, and the crew's rule not to touch it. Resolves with the page id (an existing one is kept), or
   * null when no world is open or the write failed. Idempotent per world, also while a write is in flight.
   */
  ensureBasePage(
    worldId: string,
    office: NonNullable<PayloadOf<'world.state'>['office']>,
    playerName: string,
  ): Promise<string | null> {
    if (this.codex.worldId !== worldId) return Promise.resolve(null);
    const known = this.#basePages.get(worldId);
    if (known) return known;
    const run = (async (): Promise<string | null> => {
      const existing = this.codex
        .list({ category: 'places', scope: 'world' })
        .find((p) => p.title.toLowerCase() === BASE_NAME.toLowerCase());
      if (existing) return existing.id;
      const body = basePageBody(office, playerName);
      if (!body) return null;
      const door = office.slots.find((s) => s.kind === 'door')?.pos ?? office.origin;
      const res = await this.codex.write(
        { kind: 'system', id: 'system', name: 'MineVibe' },
        {
          mode: 'create',
          title: BASE_NAME,
          body,
          tags: [...BASE_PAGE_TAGS],
          category: 'places',
          scope: 'world',
          here: true,
          position: { x: door.x, y: door.y, z: door.z, dim: 'minecraft:overworld' },
        },
      );
      if (!res.ok) {
        this.#log?.warn({ code: res.code, message: res.message }, 'Base page write failed');
        return null;
      }
      return res.page.id;
    })();
    this.#basePages.set(worldId, run);
    // A failed write may be retried by the next office report.
    void run.then((id) => {
      if (id === null && this.#basePages.get(worldId) === run) this.#basePages.delete(worldId);
    });
    return run;
  }

  codexDigest(): string {
    return this.codex.digest(this.nonce, this.#playerName);
  }

  // -------------------------------------------------------------------------------------------
  // CodexScreen
  // -------------------------------------------------------------------------------------------

  #player(): CodexActor {
    return { kind: 'player', id: 'player', name: this.#playerName };
  }

  codexIndex(): CodexIndexEntry[] {
    return this.codex.index();
  }

  codexSearchScreen(query: string, options: { tags?: string[]; category?: string } = {}): CodexSearchHit[] {
    return this.codex.search(query, {
      tags: options.tags,
      category: isCodexCategory(options.category) ? options.category : undefined,
      limit: 20,
    });
  }

  codexGet(id: string): CodexPage | null {
    return this.codex.get(id, { count: false });
  }

  async codexPut(input: unknown): Promise<CodexWriteResult> {
    const parsed = CodexWriteToolInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return { ok: false, code: 'INVALID', message: invalid(parsed.error).text };
    return this.codex.write(this.#player(), parsed.data);
  }

  async codexDelete(id: string): Promise<{ ok: boolean; message?: string }> {
    const res = await this.codex.delete(this.#player(), id);
    return res.ok ? { ok: true } : { ok: false, message: 'message' in res ? res.message : undefined };
  }

  async codexPin(id: string, pinned: boolean): Promise<{ ok: boolean; message?: string }> {
    const res = await this.codex.setPinned(this.#player(), id, pinned);
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  }

  codexLock(id: string): boolean {
    return this.codex.lock(id, 'player');
  }

  codexUnlock(id: string): void {
    this.codex.unlock(id, 'player');
  }

  codexHistory(id: string): Promise<CodexHistoryEntry[]> {
    return this.codex.history(id);
  }

  // -------------------------------------------------------------------------------------------
  // CalendarScreen and the meeting HUD
  // -------------------------------------------------------------------------------------------

  calendarState() {
    return this.calendar.snapshot();
  }

  calendarPut(input: unknown): { ok: boolean; message?: string; event?: CalendarEvent } {
    const player: CalendarActor = { kind: 'player', name: this.#playerName };
    const withId = CalendarUpdateToolInput.safeParse(normalizeToolInput(input));
    const isEdit = withId.success && typeof (input as { id?: unknown }).id === 'string';
    if (isEdit && withId.success) {
      const { id, ...patch } = withId.data;
      const assignees = this.#resolveAssignees(patch.assignees);
      if (assignees && typeof assignees === 'object' && 'error' in assignees)
        return { ok: false, message: assignees.error };
      const res = this.calendar.update(player, id, { ...patch, assignees } as Partial<CalendarAddInput>);
      return res.ok ? { ok: true, event: res.event } : { ok: false, message: res.message };
    }
    const parsed = CalendarAddToolInput.safeParse(normalizeToolInput(input));
    if (!parsed.success) return { ok: false, message: invalid(parsed.error).text };
    const assignees = this.#resolveAssignees(parsed.data.assignees);
    if (assignees && typeof assignees === 'object' && 'error' in assignees)
      return { ok: false, message: assignees.error };
    const res = this.calendar.add(player, { ...parsed.data, assignees } as CalendarAddInput);
    return res.ok ? { ok: true, event: res.event } : { ok: false, message: res.message };
  }

  calendarCancelByPlayer(id: string, scope: 'next' | 'all' = 'all'): { ok: boolean; message?: string } {
    const res = this.calendar.cancel({ kind: 'player', name: this.#playerName }, id, scope);
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  }

  resolveOrphan(id: string, action: OrphanAction): { ok: boolean; message?: string } {
    const res = this.calendar.resolveOrphan(id, action);
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  }

  decideCalendarApproval(
    eventId: string,
    approved: boolean,
    note?: string,
  ): { ok: boolean; message?: string } {
    const res = this.calendar.decideApproval(eventId, approved, note);
    // Decided in CalendarScreen or through the card itself: either way the card is done.
    if (res.ok) this.#host.withdrawApproval?.(`cal:${eventId}`, approved ? 'approved' : 'declined');
    this.approach.resolve(`cal:${eventId}`);
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  }

  previewMeetingEtas(): Array<{ agentId: string; name: string; etaSec: number | null; mode: AttendeeMode }> {
    return this.meetings.previewEtas();
  }

  startMeetingNow(options: { playerChairs?: boolean; quick?: boolean } = {}): string {
    return this.meetings.request({
      title: 'Meeting',
      attendees: 'all',
      createdBy: 'player',
      scheduled: false,
      playerChairs: options.playerChairs,
      quick: options.quick,
    });
  }

  /** Queues a meeting (`meeting.start`, a scheduled meeting started early, ...). Returns its id. */
  requestMeeting(request: MeetingRequest): string {
    return this.meetings.request(request);
  }

  endMeeting(): void {
    this.meetings.end(`ended by ${this.#playerName}`);
  }

  meetingState(): MeetingState | null {
    return this.meetings.active;
  }

  // -------------------------------------------------------------------------------------------
  // Approach and meetings
  // -------------------------------------------------------------------------------------------

  cardPending(card: ApproachCard): void {
    this.approach.enqueue(card);
  }

  cardResolved(cardId: string): void {
    this.approach.resolve(cardId);
  }

  later(agentId: string): boolean {
    return this.approach.later(agentId);
  }

  /** The player parked this card ("later" from AgentScreen, the G card or chat). */
  parkCard(cardId: string): boolean {
    return this.approach.park(cardId);
  }

  setPingPreference(agentId: string, ping: boolean): void {
    this.approach.setPingPreference(agentId, ping);
  }

  approachState(): ApproachState {
    return this.approach.state();
  }

  meetingMessage(text: string): boolean {
    return this.meetings.playerMessage(text);
  }

  meetingArrived(agentId: string): void {
    this.meetings.arrived(agentId);
  }

  /** An attendee cannot get to the table: it dials in. */
  meetingCannotCome(agentId: string): void {
    this.meetings.cannotCome(agentId);
  }

  agentDied(agentId: string): void {
    this.meetings.agentDied(agentId);
    this.approach.removeAgent(agentId);
  }

  isInMeeting(agentId: string): boolean {
    return this.meetings.isAttending(agentId);
  }

  // -------------------------------------------------------------------------------------------
  // Pushes
  // -------------------------------------------------------------------------------------------

  #schedulePush(type: 'codex.index' | 'calendar.state' | 'meeting.state'): void {
    this.#pending.add(type);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      const types = [...this.#pending];
      this.#pending.clear();
      for (const t of types) {
        try {
          if (t === 'codex.index') this.#host.push?.(t, this.codexIndexPayload());
          else if (t === 'calendar.state') this.#host.push?.(t, this.calendarStatePayload());
          else {
            const meeting = this.meetingStatePayload();
            if (meeting) this.#host.push?.(t, meeting);
          }
        } catch (e) {
          this.#log?.warn({ err: e, type: t }, 'org push failed');
        }
      }
    });
  }

  /** The `codex.index` payload. */
  codexIndexPayload(): PayloadOf<'codex.index'> {
    return toWireCodexIndex(this.codex.index());
  }

  /** The `calendar.state` payload. */
  calendarStatePayload(): PayloadOf<'calendar.state'> {
    return toWireCalendarState(this.calendar.list({ includeInactive: true }), this.calendar.timeZone);
  }

  /** The `meeting.state` payload of the running meeting (or of the one that just ended), or null. */
  meetingStatePayload(): PayloadOf<'meeting.state'> | null {
    const m = this.meetings.active ?? this.#lastMeetingState;
    return m ? toWireMeetingState(m) : null;
  }

  /** The `calendar.fired` payload of an occurrence with the assignees that accepted so far, or null. */
  firedPayload(eventId: string, occurrence: number): PayloadOf<'calendar.fired'> | null {
    const ev = this.calendar.get(eventId);
    if (!ev) return null;
    const occ = ev.ring.find((o) => o.at === occurrence);
    const assignees =
      ev.assignees !== 'all'
        ? ev.assignees
        : occ?.assignees && Object.keys(occ.assignees).length > 0
          ? Object.keys(occ.assignees)
          : this.#host
              .crew()
              .filter((c) => c.status === 'alive')
              .map((c) => c.agentId);
    const target = ev.location ? (this.#host.placeOf?.(ev.location) ?? null) : null;
    const walk = this.#fired.get(`${eventId}@${occurrence}`)?.walk ?? new Set<string>();
    return toWireCalendarFired(ev, occurrence, assignees, target, [...walk]);
  }

  #onFired(eventId: string, occurrence: number): void {
    const key = `${eventId}@${occurrence}`;
    if (!this.#fired.has(key)) {
      this.#fired.set(key, { eventId, occurrence, walk: new Set() });
      while (this.#fired.size > FIRED_MEMORY) {
        const oldest = this.#fired.keys().next().value;
        if (oldest === undefined) break;
        this.#fired.delete(oldest);
      }
    }
    this.#pushFired(eventId, occurrence);
  }

  /** An assignee's brain took the task: it walks to the location now (reflex 38), so `walk` is re-sent. */
  #taskAccepted(eventId: string, occurrence: number, agentId: string): void {
    const key = `${eventId}@${occurrence}`;
    let entry = this.#fired.get(key);
    if (!entry) {
      // A deferred delivery released later (after a meeting, a usage reset, a restart).
      entry = { eventId, occurrence, walk: new Set() };
      this.#fired.set(key, entry);
    }
    if (entry.walk.has(agentId)) return;
    entry.walk.add(agentId);
    const payload = this.firedPayload(eventId, occurrence);
    if (payload?.target) this.#pushFiredPayload(payload);
  }

  #pushFired(eventId: string, occurrence: number): void {
    const payload = this.firedPayload(eventId, occurrence);
    if (payload) this.#pushFiredPayload(payload);
  }

  #pushFiredPayload(payload: PayloadOf<'calendar.fired'>): void {
    try {
      this.#host.push?.('calendar.fired', payload);
    } catch (e) {
      this.#log?.warn({ err: e }, 'calendar.fired push failed');
    }
  }
}
