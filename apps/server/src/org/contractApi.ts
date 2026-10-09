/**
 * The OrgApi contract (contracts/OrgApi.ts) over {@link OrgServices}: the structured calls speak the protocol's
 * shapes (wire.ts) and reject with {@link ApiError} using the protocol codes; the agent tools return the services'
 * own text, which is exactly what the agent sees.
 *
 * Rights come from Node's crew view (the CEO flag of the calling agent), never from the caller's claim.
 */

import { ERROR_CODES, type MeetingStartResult } from '@minevibe/protocol';
import type { Actor } from '../contracts/common.js';
import { ApiError } from '../contracts/common.js';
import type {
  CalendarApi,
  CodexApi,
  MeetingApi,
  OrgAgentTools,
  OrgApi,
  OrgEvents,
  OrgToolResult,
} from '../contracts/OrgApi.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import type { CalendarActor, CalendarAddInput, CalendarUpdateInput } from './calendar/CalendarService.js';
import type { CodexActor, CodexWriteResult } from './codex/types.js';
import type { OrgCrewMember, OrgServices } from './OrgServices.js';
import {
  calendarErrorCode,
  codexErrorCode,
  decodeRev,
  encodeRev,
  fromWireEventFields,
  fromWireEventPatch,
  toWireCalendarEvent,
  toWireCodexHit,
  toWireCodexMeta,
  toWireCodexPage,
  toWireMeetingState,
} from './wire.js';

export interface OrgApiContext {
  /** Node's crew view (names, CEO flags). */
  crew(): readonly OrgCrewMember[];
  playerName(): string;
}

function codexFailure(res: Extract<CodexWriteResult, { ok: false }>): ApiError {
  const details: Record<string, unknown> = {};
  if (res.current) {
    details.rev = encodeRev(res.current.rev);
    details.body = res.current.body;
  }
  if (res.similarId) details.pageId = res.similarId;
  return new ApiError(codexErrorCode(res.code), res.message, details);
}

function wrapTool(fn: () => OrgToolResult | Promise<OrgToolResult>): Promise<OrgToolResult> {
  try {
    return Promise.resolve(fn()).catch((err: unknown) => ({
      ok: false,
      code: 'INTERNAL',
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    }));
  } catch (err) {
    return Promise.resolve({
      ok: false,
      code: 'INTERNAL',
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export class OrgContractApi extends TypedEmitter<OrgEvents> implements OrgApi {
  readonly codex: CodexApi;
  readonly calendar: CalendarApi;
  readonly meeting: MeetingApi;
  readonly tools: OrgAgentTools;
  readonly #s: OrgServices;
  readonly #ctx: OrgApiContext;

  constructor(services: OrgServices, ctx: OrgApiContext) {
    super();
    this.#s = services;
    this.#ctx = ctx;
    const s = services;

    this.codex = {
      search: async (_actor, q) =>
        s.codex
          .search(q.query, { tags: q.tags, category: q.category, scope: q.scope, limit: q.limit ?? 8 })
          .map(toWireCodexHit),
      read: async (actor, pageId) => {
        const page = s.codex.get(pageId, { count: actor.kind === 'agent' });
        if (!page) throw new ApiError(ERROR_CODES.CODEX_NOT_FOUND, `no Codex page "${pageId}"`);
        return toWireCodexPage(page, await s.codex.history(pageId));
      },
      write: async (actor, w) => {
        const here = w.here;
        const res = await s.codex.write(this.#codexActor(actor), {
          mode: w.mode,
          id: w.pageId,
          base_rev: decodeRev(w.baseRev),
          title: w.title,
          body: w.body,
          tags: w.tags,
          category: w.category,
          scope: w.scope,
          here: here !== undefined,
          position: here ? { x: here.pos.x, y: here.pos.y, z: here.pos.z, dim: here.dim } : undefined,
        });
        if (!res.ok) throw codexFailure(res);
        let page = res.page;
        if (w.pinned !== undefined && w.pinned !== page.pinned && actor.kind === 'player') {
          const pinned = await s.codex.setPinned(this.#codexActor(actor), page.id, w.pinned);
          if (pinned.ok) page = pinned.page;
        }
        return { pageId: page.id, rev: encodeRev(page.rev) };
      },
      list: async (_actor, filter) =>
        s.codex.list({ category: filter?.category, tag: filter?.tag }).map(toWireCodexMeta),
      delete: async (actor, pageId, baseRev) => {
        if (actor.kind !== 'player')
          throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player deletes pages');
        const page = s.codex.get(pageId, { count: false });
        if (!page) throw new ApiError(ERROR_CODES.CODEX_NOT_FOUND, `no Codex page "${pageId}"`);
        if (baseRev !== undefined && decodeRev(baseRev) !== page.rev) {
          throw new ApiError(
            ERROR_CODES.CODEX_CONFLICT,
            `the page changed (now rev ${encodeRev(page.rev)}); reload it before deleting`,
            { rev: encodeRev(page.rev) },
          );
        }
        const res = await s.codex.delete(this.#codexActor(actor), pageId);
        if (!res.ok) throw codexFailure(res);
      },
      index: () => s.codexIndexPayload(),
    };

    this.calendar = {
      list: async (_actor, filter) =>
        s.calendar
          .list({ agent: filter?.agentId, from: filter?.from, to: filter?.to })
          .filter((ev) => filter?.kind === undefined || ev.kind === filter.kind)
          .map(toWireCalendarEvent),
      add: async (actor, event) => {
        const res = s.calendar.add(
          this.#calendarActor(actor),
          fromWireEventFields(event) as CalendarAddInput,
        );
        if (!res.ok) throw new ApiError(calendarErrorCode(res.code), res.message);
        return { eventId: res.event.id, needsApproval: res.needsApproval };
      },
      update: async (actor, eventId, patch) => {
        const existing = s.calendar.get(eventId);
        if (!existing) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, `no calendar event "${eventId}"`);
        const res = s.calendar.update(
          this.#calendarActor(actor),
          eventId,
          fromWireEventPatch(patch, existing) as CalendarUpdateInput,
        );
        if (!res.ok) throw new ApiError(calendarErrorCode(res.code), res.message);
      },
      cancel: async (actor, eventId, scope) => {
        const existing = s.calendar.get(eventId);
        if (!existing) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, `no calendar event "${eventId}"`);
        if (actor.kind === 'player' && existing.status === 'awaiting_approval') {
          const res = s.decideCalendarApproval(eventId, false);
          if (!res.ok) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, res.message ?? 'not pending');
          return;
        }
        const res = s.calendar.cancel(this.#calendarActor(actor), eventId, scope);
        if (!res.ok) throw new ApiError(calendarErrorCode(res.code), res.message);
      },
      report: async (actor, report) => {
        if (actor.kind !== 'agent')
          throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the assignee reports a task');
        const res = s.calendar.reportTask(actor.agentId, report);
        if (!res.ok) throw new ApiError(calendarErrorCode(res.code), res.message);
      },
      decide: async (actor, eventId, decision) => {
        if (actor.kind !== 'player')
          throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player approves calendar events');
        const existing = s.calendar.get(eventId);
        if (!existing) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, `no calendar event "${eventId}"`);
        if (existing.status !== 'awaiting_approval') return; // edited, cancelled or decided meanwhile
        const res = s.decideCalendarApproval(eventId, decision.approve, decision.note);
        if (!res.ok) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, res.message ?? 'not pending');
      },
      state: () => s.calendarStatePayload(),
    };

    this.meeting = {
      start: async (actor, request) => this.#startMeeting(actor, request),
      end: async (actor, meetingId) => {
        if (actor.kind !== 'player')
          throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player ends meetings');
        const active = s.meetingState();
        if (!active || active.id !== meetingId || active.phase === 'done')
          throw new ApiError(ERROR_CODES.MEETING_NOT_FOUND, 'no such meeting is running');
        s.endMeeting();
      },
      state: () => {
        const active = s.meetingState();
        return active ? toWireMeetingState(active) : null;
      },
    };

    this.tools = {
      codexSearch: (agentId, input) => wrapTool(() => s.codexSearch(agentId, input)),
      codexRead: (agentId, input) => wrapTool(() => s.codexRead(agentId, input)),
      codexWrite: (agentId, input) => wrapTool(() => s.codexWrite(agentId, input)),
      codexList: (agentId, input) => wrapTool(() => s.codexList(agentId, input)),
      calendarList: (agentId, input) => wrapTool(() => s.calendarList(agentId, input)),
      calendarAdd: (agentId, input) => wrapTool(() => s.calendarAdd(agentId, input)),
      calendarUpdate: (agentId, input) => wrapTool(() => s.calendarUpdate(agentId, input)),
      calendarCancel: (agentId, input) => wrapTool(() => s.calendarCancel(agentId, input)),
      reportTask: (agentId, input) => wrapTool(() => s.reportTask(agentId, input)),
    };
  }

  /** Tells in-process listeners about a push the org module sent to the mod. */
  publish<K extends keyof OrgEvents>(event: K, ...args: OrgEvents[K]): void {
    this.emit(event, ...args);
  }

  #name(agentId: string): string {
    return this.#ctx.crew().find((c) => c.agentId === agentId)?.name ?? agentId;
  }

  #codexActor(actor: Actor): CodexActor {
    return actor.kind === 'player'
      ? { kind: 'player', id: 'player', name: this.#ctx.playerName() }
      : { kind: 'agent', id: actor.agentId, name: this.#name(actor.agentId) };
  }

  #calendarActor(actor: Actor): CalendarActor {
    return actor.kind === 'player'
      ? { kind: 'player', name: this.#ctx.playerName() }
      : { kind: 'agent', id: actor.agentId, name: this.#name(actor.agentId) };
  }

  /**
   * "Start meeting now" (`meeting.start`). With `preview` only the ETAs. A scheduled meeting started early holds its
   * next occurrence now. Without a CEO coming the player chairs. Rejects with `MEETING_BUSY` (one meeting at a
   * time; a player-started one is not queued), `NO_QUORUM` (nobody can attend), `CALENDAR_NOT_FOUND` (bad
   * `eventId`), `FORBIDDEN` (agents call meetings through the calendar, which needs the player's approval).
   */
  async #startMeeting(
    actor: Actor,
    request: Parameters<MeetingApi['start']>[1],
  ): Promise<MeetingStartResult> {
    const s = this.#s;
    if (actor.kind !== 'player') {
      throw new ApiError(
        ERROR_CODES.FORBIDDEN,
        'agents call meetings with the calendar tool (kind "meeting"); the player approves them',
      );
    }
    const event = request.eventId !== undefined ? s.calendar.get(request.eventId) : null;
    if (request.eventId !== undefined && event?.kind !== 'meeting') {
      throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, `no meeting event "${request.eventId}"`);
    }
    const invited = request.attendees ?? event?.assignees ?? 'all';
    const crew = this.#ctx.crew();
    const plan = s
      .previewMeetingEtas()
      .filter((a) => invited === 'all' || invited.includes(a.agentId))
      .filter((a) => crew.find((c) => c.agentId === a.agentId)?.status === 'alive');
    const etas = plan.slice(0, 16).map((a) => ({
      agentId: a.agentId,
      etaS: a.etaSec === null ? null : Math.max(0, Math.round(a.etaSec)),
      dialIn: a.mode === 'dial_in',
    }));
    if (request.preview) return { meetingId: null, etas };

    const active = s.meetingState();
    if (active && active.phase !== 'done')
      throw new ApiError(ERROR_CODES.MEETING_BUSY, 'a meeting is already running');
    const coming = plan.filter((a) => a.mode === 'walking' || a.mode === 'present' || a.mode === 'dial_in');
    if (coming.length === 0) throw new ApiError(ERROR_CODES.NO_QUORUM, 'nobody can attend');
    const ceoComing = coming.some((a) => crew.find((c) => c.agentId === a.agentId)?.isCeo);
    const took = event ? s.calendar.takeNextOccurrence(event.id) : null;
    const meetingId = s.requestMeeting({
      title: request.title ?? event?.title ?? 'Meeting',
      attendees: invited === 'all' ? 'all' : [...invited],
      createdBy: 'player',
      scheduled: false,
      eventId: event?.id,
      occurrence: took?.occurrence,
      playerChairs: !ceoComing,
    });
    return { meetingId, etas };
  }
}
