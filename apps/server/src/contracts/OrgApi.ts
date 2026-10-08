/**
 * OrgApi: the organisation services (CodexStore, CalendarService, MeetingRunner; T5) as the agent tools
 * (`mcp__mc__codex_*`, `calendar_*`, `report_task`; T3) and the UI screens (CodexScreen, CalendarScreen, meeting HUD
 * via the bridge; T1/T6) use them. PLAN §6.6.
 *
 * Every call names its {@link Actor}; rights are enforced here, not in prompts: only the player writes `rules` pages,
 * other agents schedule only for themselves, agents cannot edit player-created events, and so on. Failures reject with
 * {@link ApiError} using the protocol codes (`CODEX_*`, `CALENDAR_*`, `MEETING_*`, `NO_QUORUM`, `FORBIDDEN`).
 *
 * Shared text (page bodies, titles, tasks) is returned raw; wrapping it in the data envelope for agents is the agent
 * runtime's job (PLAN §3 principle 6).
 */

import type {
  CalendarEvent,
  CalendarKind,
  CodexCategory,
  CodexHit,
  CodexPage,
  CodexPageMeta,
  CodexScope,
  CodexWriteMode,
  MeetingStartResult,
  PayloadOf,
  Place,
} from '@minevibe/protocol';
import type { Actor, Subscribable } from './common.js';

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

export interface CodexSearchQuery {
  readonly query: string;
  readonly tags?: readonly string[] | undefined;
  readonly category?: CodexCategory | undefined;
  readonly scope?: CodexScope | undefined;
  /** Default 8 (the agent tool's top 8). */
  readonly limit?: number | undefined;
}

export interface CodexWrite {
  readonly mode: CodexWriteMode;
  /** For `update` and `append`. */
  readonly pageId?: string | undefined;
  /** Required for `update`; a stale one rejects with `CODEX_CONFLICT` (details: `{ rev, body }`). */
  readonly baseRev?: string | undefined;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly category: CodexCategory;
  readonly scope: CodexScope;
  readonly pinned?: boolean | undefined;
  /** `places` pages: stamp the agent's real position (forces `world` scope). */
  readonly here?: Place | undefined;
}

export interface CodexWriteResult {
  readonly pageId: string;
  readonly rev: string;
}

export interface CodexApi {
  search(actor: Actor, query: CodexSearchQuery): Promise<readonly CodexHit[]>;
  /** Rejects with `CODEX_NOT_FOUND`. */
  read(actor: Actor, pageId: string): Promise<CodexPage>;
  /** Rejects with `CODEX_CONFLICT`, `CODEX_SIMILAR`, `CODEX_TOO_LARGE`, `CODEX_SECRET`, `CODEX_INVALID`, `CODEX_BUDGET`, `FORBIDDEN`. */
  write(actor: Actor, write: CodexWrite): Promise<CodexWriteResult>;
  list(
    actor: Actor,
    filter?: { category?: CodexCategory | undefined; tag?: string | undefined },
  ): Promise<readonly CodexPageMeta[]>;
  /** Player only. */
  delete(actor: Actor, pageId: string, baseRev?: string): Promise<void>;
  /** The `codex.index` push. */
  index(): PayloadOf<'codex.index'>;
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

/** The fields a calendar event is created with (CalendarScreen form, `mcp__mc__calendar_add`). */
export type CalendarEventInput = Omit<
  CalendarEvent,
  'id' | 'createdBy' | 'status' | 'nextAt' | 'occurrences'
>;

export interface CalendarAddResult {
  readonly eventId: string;
  /** Agent-created recurring events and meetings wait for the player's approval card. */
  readonly needsApproval: boolean;
}

export interface CalendarListFilter {
  /** On each event's own clock (ticks or epoch ms). */
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly agentId?: string | undefined;
  readonly kind?: CalendarKind | undefined;
}

/** `mcp__mc__report_task`: closes an occurrence. Only `failed` and `blocked` wake the CEO. */
export interface TaskReport {
  readonly eventId: string;
  readonly status: 'done' | 'failed' | 'blocked';
  readonly note?: string | undefined;
}

export interface CalendarApi {
  list(actor: Actor, filter?: CalendarListFilter): Promise<readonly CalendarEvent[]>;
  /** Rejects with `FORBIDDEN` (scheduling others is CEO only), `CALENDAR_LIMIT`, `CALENDAR_INVALID`. */
  add(actor: Actor, event: CalendarEventInput): Promise<CalendarAddResult>;
  /** Rejects with `CALENDAR_NOT_FOUND`, `FORBIDDEN` (player-created events), `CALENDAR_INVALID`. */
  update(actor: Actor, eventId: string, patch: Partial<CalendarEventInput>): Promise<void>;
  cancel(actor: Actor, eventId: string, scope: 'next' | 'all'): Promise<void>;
  report(actor: Actor, report: TaskReport): Promise<void>;
  /** The `calendar.state` push. */
  state(): PayloadOf<'calendar.state'>;
}

// ---------------------------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------------------------

export interface MeetingStartRequest {
  readonly eventId?: string | undefined;
  readonly title?: string | undefined;
  /** Absent = everyone. */
  readonly attendees?: 'all' | readonly string[] | undefined;
  /** Only compute ETAs ("Start meeting now" first lists them). */
  readonly preview?: boolean | undefined;
}

export interface MeetingApi {
  /** Rejects with `MEETING_BUSY`, `NO_QUORUM`. */
  start(actor: Actor, request: MeetingStartRequest): Promise<MeetingStartResult>;
  /** Rejects with `MEETING_NOT_FOUND`. */
  end(actor: Actor, meetingId: string): Promise<void>;
  /** The active meeting (`meeting.state` payload), or null. */
  state(): PayloadOf<'meeting.state'> | null;
}

// ---------------------------------------------------------------------------------------------
// OrgApi
// ---------------------------------------------------------------------------------------------

/** OrgApi events: the protocol payloads to forward to the mod. */
export type OrgEvents = {
  codexIndex: [payload: PayloadOf<'codex.index'>];
  calendarState: [payload: PayloadOf<'calendar.state'>];
  calendarFired: [payload: PayloadOf<'calendar.fired'>];
  meetingState: [payload: PayloadOf<'meeting.state'>];
};

export interface OrgApi extends Subscribable<OrgEvents> {
  readonly codex: CodexApi;
  readonly calendar: CalendarApi;
  readonly meeting: MeetingApi;
}
