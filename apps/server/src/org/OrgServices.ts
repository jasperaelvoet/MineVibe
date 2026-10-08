/**
 * OrgServices: CodexStore + CalendarService + MeetingRunner + ApproachQueue behind the {@link OrgApi} facade.
 *
 * Wiring
 * - Calendar meetings → MeetingRunner; attendees count as "in a meeting" for the calendar (tasks deferred).
 * - Meeting minutes → CodexStore (`minutes`, world scope); action items → CalendarService (as the chair).
 * - Calendar approval cards (agent-created recurring events and meetings) → the host's card store and the
 *   ApproachQueue, so the creating agent comes to the player like with a hire.
 * - Pushes (`codex.index`, `calendar.state`, `calendar.fired`, `meeting.state`) are coalesced per tick.
 *
 * The host supplies crew and world queries and delivers messages; everything here is testable without the mod.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import { type MineVibePaths, worldDir } from '../config/paths.js';
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
  type OrgApi,
  type OrgToolResult,
  ReportTaskInput,
} from './OrgApi.js';

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
  /** A wake at a priority, or a `shouldQuery:false` context message. */
  deliver(
    agentId: string,
    text: string,
    how: { priority: DeliveryPriority; eventId?: string | undefined; location?: string | undefined },
  ): void;
  chargeWake?(creatorId: string, assigneeId: string): boolean;
  toast?(text: string): void;
  reminder?(r: { eventId: string; title: string; assignees: readonly string[]; text: string }): void;
  requestApproval?(card: CalendarApprovalCard): void;
  withdrawApproval?(cardId: string): void;
  push?(type: OrgPushType, payload: unknown): void;
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
  readonly playerName?: string | undefined;
  readonly gitBinary?: string | null | undefined;
  readonly logger?: Logger | undefined;
}

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

export class OrgServices implements OrgApi {
  readonly nonce: ControlNonce;
  readonly codex: CodexStore;
  readonly calendar: CalendarService;
  readonly meetings: MeetingRunner;
  readonly approach: ApproachQueue;
  readonly #host: OrgHost;
  readonly #playerName: string;
  readonly #log: Logger | undefined;
  readonly #pending = new Set<OrgPushType>();
  #flushScheduled = false;
  #lastMeetingState: MeetingState | null = null;
  #lastDay: number | null = null;

  constructor(options: OrgServicesOptions) {
    const host = options.host;
    const clock = options.clock ?? systemClock;
    this.#host = host;
    this.#playerName = options.playerName ?? 'the player';
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
      playerName: this.#playerName,
      lastingFile: options.paths.lastingCalendar,
      worldFile: options.paths.worldCalendar,
      logger: options.logger,
      sink: {
        deliverTask: (d) =>
          host.deliver(d.agentId, d.text, { priority: d.priority, eventId: d.eventId, location: d.location }),
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
          host.requestApproval?.(card);
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
        fired: (eventId, occurrence) => host.push?.('calendar.fired', { eventId, occurrence }),
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
      playerName: this.#playerName,
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
    // Queued and postponed meetings of the dead world must not run in the next one.
    this.meetings.cancelAll('the world ended');
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
    const parsed = CodexSearchInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const hits = this.codex.search(parsed.data.query, {
      tags: parsed.data.tags,
      category: parsed.data.category,
    });
    return { ok: true, text: formatSearchForAgent(parsed.data.query, hits) };
  }

  codexRead(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CodexReadInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const page = this.codex.get(parsed.data.id);
    if (!page) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        text: `No Codex page "${singleLine(parsed.data.id, 64)}". Try codex_search.`,
      };
    }
    return { ok: true, text: formatPageForAgent(page) };
  }

  async codexWrite(agentId: string, input: unknown): Promise<OrgToolResult> {
    const parsed = CodexWriteToolInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const res = await this.codex.write(this.#agentActor(agentId), parsed.data);
    return { ok: res.ok, code: res.ok ? undefined : res.code, text: formatWriteResult(res) };
  }

  codexList(_agentId: string, input: unknown): OrgToolResult {
    const parsed = CodexListInput.safeParse(input ?? {});
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
    const parsed = CalendarListInput.safeParse(input ?? {});
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
    const parsed = CalendarAddToolInput.safeParse(input);
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
    const parsed = CalendarUpdateToolInput.safeParse(input);
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
    const parsed = CalendarCancelInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const res = this.calendar.cancel(this.#agentActor(agentId), parsed.data.id);
    if (!res.ok) return { ok: false, code: res.code, text: `Not cancelled (${res.code}): ${res.message}` };
    return { ok: true, text: `Cancelled [${res.event.id}] "${singleLine(res.event.title)}".` };
  }

  reportTask(agentId: string, input: unknown): OrgToolResult {
    const parsed = ReportTaskInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const res = this.calendar.reportTask(agentId, parsed.data);
    if (!res.ok) return { ok: false, code: res.code, text: `Not recorded (${res.code}): ${res.message}` };
    return { ok: true, text: `Recorded "${singleLine(res.event.title)}" as ${parsed.data.status}.` };
  }

  // -------------------------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------------------------

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
    const parsed = CodexWriteToolInput.safeParse(input);
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
    const withId = CalendarUpdateToolInput.safeParse(input);
    const isEdit = withId.success && typeof (input as { id?: unknown }).id === 'string';
    if (isEdit && withId.success) {
      const { id, ...patch } = withId.data;
      const assignees = this.#resolveAssignees(patch.assignees);
      if (assignees && typeof assignees === 'object' && 'error' in assignees)
        return { ok: false, message: assignees.error };
      const res = this.calendar.update(player, id, { ...patch, assignees } as Partial<CalendarAddInput>);
      return res.ok ? { ok: true, event: res.event } : { ok: false, message: res.message };
    }
    const parsed = CalendarAddToolInput.safeParse(input);
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

  #schedulePush(type: OrgPushType): void {
    this.#pending.add(type);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      const types = [...this.#pending];
      this.#pending.clear();
      for (const t of types) {
        try {
          this.#host.push?.(t, this.#payload(t));
        } catch (e) {
          this.#log?.warn({ err: e, type: t }, 'org push failed');
        }
      }
    });
  }

  #payload(type: OrgPushType): unknown {
    switch (type) {
      case 'codex.index':
        return { pages: this.codex.index() };
      case 'calendar.state':
        return this.calendar.snapshot();
      case 'meeting.state':
        return this.#lastMeetingState;
      default:
        return null;
    }
  }
}
