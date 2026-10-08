import {
  type Author,
  type CalendarEvent,
  CODEX_BODY_MAX,
  type CodexHit,
  type CodexPage,
  type CodexPageMeta,
  ERROR_CODES,
  type MeetingStartResult,
  type PayloadOf,
} from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { type Actor, ApiError } from './common.js';
import type {
  CalendarAddResult,
  CalendarApi,
  CalendarEventInput,
  CalendarListFilter,
  CodexApi,
  CodexSearchQuery,
  CodexWrite,
  CodexWriteResult,
  MeetingApi,
  MeetingStartRequest,
  OrgApi,
  OrgEvents,
  TaskReport,
} from './OrgApi.js';

function authorOf(actor: Actor): Author {
  return actor.kind === 'player'
    ? { kind: 'player', name: 'Player' }
    : { kind: 'agent', name: actor.agentId, agentId: actor.agentId };
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return s.length > 0 ? s : 'page';
}

/**
 * An in-memory {@link OrgApi} for tests. It enforces the headline rights and limits (player-only `rules`, `baseRev`
 * conflicts, similar titles, the 8 KB body cap, self-only scheduling for non-CEO agents, player-created events,
 * one meeting at a time) but none of the storage, search ranking or clocks of the real services.
 */
export class FakeOrgApi extends TypedEmitter<OrgEvents> implements OrgApi {
  readonly codex: CodexApi;
  readonly calendar: CalendarApi;
  readonly meeting: MeetingApi;

  readonly #pages = new Map<string, CodexPage>();
  readonly #events = new Map<string, CalendarEvent>();
  readonly #reports: TaskReport[] = [];
  #meeting: PayloadOf<'meeting.state'> | null = null;
  #seq = 0;
  readonly #now: () => number;

  constructor(options: { now?: () => number; tz?: string } = {}) {
    super();
    this.#now = options.now ?? Date.now;
    const tz = options.tz ?? 'UTC';
    this.codex = {
      search: async (_actor, query) => this.#search(query),
      read: async (_actor, pageId) => this.#page(pageId),
      write: async (actor, write) => this.#write(actor, write),
      list: async (_actor, filter) =>
        [...this.#pages.values()]
          .filter(
            (p) =>
              (filter?.category === undefined || p.category === filter.category) &&
              (filter?.tag === undefined || p.tags.includes(filter.tag)),
          )
          .map(toMeta),
      delete: async (actor, pageId, baseRev) => {
        if (actor.kind !== 'player')
          throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player deletes pages');
        const page = this.#page(pageId);
        if (baseRev !== undefined && baseRev !== page.rev) {
          throw new ApiError(ERROR_CODES.CODEX_CONFLICT, `page changed (now ${page.rev})`, { rev: page.rev });
        }
        this.#pages.delete(pageId);
        this.emit('codexIndex', this.codex.index());
      },
      index: () => ({ pages: [...this.#pages.values()].map(toMeta), truncated: false }),
    };
    this.calendar = {
      list: async (_actor, filter) => this.#list(filter),
      add: async (actor, event) => this.#add(actor, event),
      update: async (actor, eventId, patch) => {
        const event = this.#editable(actor, eventId);
        this.#events.set(eventId, { ...event, ...patch });
        this.#emitCalendar();
      },
      cancel: async (actor, eventId, scope) => {
        const event = this.#editable(actor, eventId);
        if (scope === 'all') this.#events.set(eventId, { ...event, status: 'cancelled', nextAt: null });
        this.#emitCalendar();
      },
      report: async (_actor, report) => {
        if (!this.#events.has(report.eventId))
          throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, 'no such event');
        this.#reports.push(report);
      },
      state: () => ({ events: [...this.#events.values()], tz }),
    };
    this.meeting = {
      start: async (actor, request) => this.#start(actor, request),
      end: async (_actor, meetingId) => {
        if (this.#meeting?.meetingId !== meetingId)
          throw new ApiError(ERROR_CODES.MEETING_NOT_FOUND, 'no such meeting');
        const done = { ...this.#meeting, phase: 'done' as const, speaker: null };
        this.#meeting = null;
        this.emit('meetingState', done);
      },
      state: () => this.#meeting,
    };
  }

  /** Task reports received, in order. */
  get reports(): readonly TaskReport[] {
    return this.#reports;
  }

  /** Fires an occurrence (emits `calendarFired`), as the real CalendarService does at its due time. */
  fire(eventId: string, walk: readonly string[] = []): PayloadOf<'calendar.fired'> {
    const event = this.#events.get(eventId);
    if (!event) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, 'no such event');
    const payload: PayloadOf<'calendar.fired'> = {
      eventId,
      occurrence: event.nextAt ?? event.at,
      kind: event.kind,
      title: event.title,
      assignees: event.assignees === 'all' ? [] : [...event.assignees],
      target: null,
      walk: [...walk],
    };
    this.emit('calendarFired', payload);
    return payload;
  }

  #page(pageId: string): CodexPage {
    const page = this.#pages.get(pageId);
    if (!page) throw new ApiError(ERROR_CODES.CODEX_NOT_FOUND, `no page ${pageId}`);
    return page;
  }

  #search(query: CodexSearchQuery): CodexHit[] {
    const terms = query.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: CodexHit[] = [];
    for (const page of this.#pages.values()) {
      if (query.category !== undefined && page.category !== query.category) continue;
      if (query.scope !== undefined && page.scope !== query.scope) continue;
      if (query.tags?.some((t) => !page.tags.includes(t))) continue;
      const haystack = `${page.title}\n${page.body}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      if (terms.length > 0 && score === 0) continue;
      hits.push({
        id: page.id,
        title: page.title,
        category: page.category,
        scope: page.scope,
        snippet: page.body.slice(0, 160),
        score,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 8);
  }

  #write(actor: Actor, write: CodexWrite): CodexWriteResult {
    if (write.category === 'rules' && actor.kind !== 'player') {
      throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player writes rules pages');
    }
    const now = this.#now();
    const rev = (++this.#seq).toString(16).padStart(7, '0');
    if (write.mode === 'create') {
      const similar = [...this.#pages.values()].find(
        (p) => p.title.toLowerCase() === write.title.toLowerCase(),
      );
      if (similar) {
        throw new ApiError(
          ERROR_CODES.CODEX_SIMILAR,
          `similar page ${similar.id} exists, use update or append`,
          { pageId: similar.id },
        );
      }
      this.#checkBody(write.body);
      let id = slug(write.title);
      while (this.#pages.has(id)) id = `${id}-${this.#seq}`;
      const page: CodexPage = {
        id,
        title: write.title,
        category: write.category,
        scope: write.here ? 'world' : write.scope,
        tags: [...write.tags],
        author: authorOf(actor),
        created: now,
        updated: now,
        rev,
        pinned: write.pinned ?? false,
        body: write.here
          ? `${write.body}\n\n(${write.here.pos.x}, ${write.here.pos.y}, ${write.here.pos.z})`
          : write.body,
        links: [],
        history: [{ rev, at: now, author: authorOf(actor), summary: 'create' }],
      };
      this.#pages.set(id, page);
      this.emit('codexIndex', this.codex.index());
      return { pageId: id, rev };
    }
    const page = this.#page(write.pageId ?? '');
    if (page.category === 'rules' && actor.kind !== 'player') {
      throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the player edits rules pages');
    }
    if (write.mode === 'update' && write.baseRev !== page.rev) {
      throw new ApiError(ERROR_CODES.CODEX_CONFLICT, `page changed (now ${page.rev})`, {
        rev: page.rev,
        body: page.body,
      });
    }
    const body = write.mode === 'append' ? `${page.body}\n${write.body}` : write.body;
    this.#checkBody(body);
    const next: CodexPage = {
      ...page,
      title: write.title,
      body,
      tags: [...write.tags],
      updated: now,
      rev,
      pinned: write.pinned ?? page.pinned,
      history: [{ rev, at: now, author: authorOf(actor), summary: write.mode }, ...page.history].slice(0, 50),
    };
    this.#pages.set(page.id, next);
    this.emit('codexIndex', this.codex.index());
    return { pageId: page.id, rev };
  }

  #checkBody(body: string): void {
    if (body.length > CODEX_BODY_MAX || Buffer.byteLength(body, 'utf8') > CODEX_BODY_MAX) {
      throw new ApiError(ERROR_CODES.CODEX_TOO_LARGE, 'pages are capped at 8 KB; start a new page');
    }
  }

  #list(filter: CalendarListFilter | undefined): CalendarEvent[] {
    return [...this.#events.values()].filter((e) => {
      const at = e.nextAt ?? e.at;
      if (filter?.from !== undefined && at < filter.from) return false;
      if (filter?.to !== undefined && at > filter.to) return false;
      if (filter?.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter?.agentId !== undefined && e.assignees !== 'all' && !e.assignees.includes(filter.agentId))
        return false;
      return true;
    });
  }

  #add(actor: Actor, input: CalendarEventInput): CalendarAddResult {
    if (actor.kind === 'agent' && !actor.ceo) {
      const self = input.assignees !== 'all' && input.assignees.every((a) => a === actor.agentId);
      if (!self) throw new ApiError(ERROR_CODES.FORBIDDEN, 'only the CEO schedules for others');
    }
    if (input.recurrence.kind === 'weekdays' && input.clock !== 'real') {
      throw new ApiError(ERROR_CODES.CALENDAR_INVALID, 'weekdays needs the real clock');
    }
    const needsApproval =
      actor.kind === 'agent' && (input.recurrence.kind !== 'once' || input.kind === 'meeting');
    const eventId = `ev-${++this.#seq}`;
    this.#events.set(eventId, {
      ...input,
      id: eventId,
      createdBy: actor.kind === 'player' ? 'player' : actor.agentId,
      status: needsApproval ? 'pending_approval' : 'active',
      nextAt: input.at,
      occurrences: [],
    });
    this.#emitCalendar();
    return { eventId, needsApproval };
  }

  #editable(actor: Actor, eventId: string): CalendarEvent {
    const event = this.#events.get(eventId);
    if (!event) throw new ApiError(ERROR_CODES.CALENDAR_NOT_FOUND, 'no such event');
    if (actor.kind === 'agent' && event.createdBy === 'player') {
      throw new ApiError(ERROR_CODES.FORBIDDEN, 'agents cannot change events the player created');
    }
    return event;
  }

  #emitCalendar(): void {
    this.emit('calendarState', this.calendar.state());
  }

  #start(actor: Actor, request: MeetingStartRequest): MeetingStartResult {
    const attendees =
      request.attendees === undefined || request.attendees === 'all' ? [] : [...request.attendees];
    const etas = attendees.map((agentId) => ({ agentId, etaS: 10, dialIn: false }));
    if (request.preview) return { meetingId: null, etas };
    if (this.#meeting) throw new ApiError(ERROR_CODES.MEETING_BUSY, 'a meeting is already running');
    const now = this.#now();
    const meetingId = `mtg-${++this.#seq}`;
    this.#meeting = {
      meetingId,
      title: request.title ?? 'Meeting',
      phase: 'gathering',
      chair: actor.kind === 'player' ? 'player' : actor.agentId,
      speaker: null,
      attendees: attendees.map((agentId) => ({ agentId, status: 'coming', etaS: 10 })),
      eventId: request.eventId ?? null,
      startedAt: now,
      endsBy: now + 10 * 60_000,
      quick: false,
    };
    this.emit('meetingState', this.#meeting);
    return { meetingId, etas };
  }
}

function toMeta(page: CodexPage): CodexPageMeta {
  const { body: _body, links: _links, history: _history, ...meta } = page;
  return meta;
}
