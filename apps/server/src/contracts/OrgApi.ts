/**
 * OrgApi: the organisation services (CodexStore, CalendarService, MeetingRunner; T5) as the agent tools
 * (`mcp__mc__codex_*`, `calendar_*`, `report_task`; T3) and the UI screens (CodexScreen, CalendarScreen, meeting HUD
 * via the bridge; T1/T6) use them. PLAN §6.6. This is the one OrgApi: `apps/server/src/org` implements it
 * (`org/contractApi.ts`, built by `org/module.ts`), and the fake below implements it for tests.
 *
 * Two faces:
 * - {@link OrgApi.tools}: the agent tools. Each takes the calling agent's id (stamped by Node, never taken from the
 *   model) and the tool's raw arguments, validates them, and returns the exact text the agent sees, with all shared
 *   text inside Node-made data envelopes ({@link OrgToolResult}).
 * - `codex` / `calendar` / `meeting`: structured calls in the protocol's shapes, for the screens and for Node.
 *   Every call names its {@link Actor}; rights are enforced here, not in prompts: only the player writes `rules`
 *   pages, other agents schedule only for themselves, agents cannot edit player-created events, and so on. Failures
 *   reject with {@link ApiError} using the protocol codes (`CODEX_*`, `CALENDAR_*`, `MEETING_*`, `NO_QUORUM`,
 *   `FORBIDDEN`). Shared text (page bodies, titles, tasks) is returned raw here.
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

/** The player's answer to a `calendar` approval card. */
export interface CalendarDecision {
  readonly approve: boolean;
  /** Passed on to the agent that created the event. */
  readonly note?: string | undefined;
}

export interface CalendarApi {
  list(actor: Actor, filter?: CalendarListFilter): Promise<readonly CalendarEvent[]>;
  /** Rejects with `FORBIDDEN` (scheduling others is CEO only), `CALENDAR_LIMIT`, `CALENDAR_INVALID`. */
  add(actor: Actor, event: CalendarEventInput): Promise<CalendarAddResult>;
  /** Rejects with `CALENDAR_NOT_FOUND`, `FORBIDDEN` (player-created events), `CALENDAR_INVALID`. */
  update(actor: Actor, eventId: string, patch: Partial<CalendarEventInput>): Promise<void>;
  /** The player cancelling an event that waits for approval declines it. */
  cancel(actor: Actor, eventId: string, scope: 'next' | 'all'): Promise<void>;
  report(actor: Actor, report: TaskReport): Promise<void>;
  /**
   * The player approves or declines an agent-created recurring event or meeting (the `calendar` PendingCard; PLAN
   * §6.6 "Rights and limits"). The creating agent is told. Player only (`FORBIDDEN`). Resolves without effect when
   * the event no longer waits for approval (it was edited, cancelled or decided meanwhile), so a stale card can
   * always be cleared; rejects with `CALENDAR_NOT_FOUND` for an unknown event.
   */
  decide(actor: Actor, eventId: string, decision: CalendarDecision): Promise<void>;
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
// Agent tools
// ---------------------------------------------------------------------------------------------

/** What an agent tool call returns. `text` goes to the agent verbatim (as an error result when `ok` is false). */
export interface OrgToolResult {
  readonly ok: boolean;
  readonly text: string;
  /** Machine-readable refusal code (`INVALID`, `FORBIDDEN`, `SIMILAR_EXISTS`, `CODEX_CONFLICT`, ...). */
  readonly code?: string | undefined;
}

/**
 * The org agent tools (`mcp__mc__codex_*`, `calendar_*`, `report_task`; PLAN §6.6). `agentId` is the calling agent
 * (stamped by Node); `input` is the tool's arguments as the model sent them (the `mc` server's schemas: `base_rev`,
 * `event_id`, `duration_min`, ...). Inputs are validated here; a malformed one is an `ok: false` result, never a throw.
 */
export interface OrgAgentTools {
  codexSearch(agentId: string, input: unknown): Promise<OrgToolResult>;
  codexRead(agentId: string, input: unknown): Promise<OrgToolResult>;
  codexWrite(agentId: string, input: unknown): Promise<OrgToolResult>;
  codexList(agentId: string, input: unknown): Promise<OrgToolResult>;
  calendarList(agentId: string, input: unknown): Promise<OrgToolResult>;
  calendarAdd(agentId: string, input: unknown): Promise<OrgToolResult>;
  calendarUpdate(agentId: string, input: unknown): Promise<OrgToolResult>;
  calendarCancel(agentId: string, input: unknown): Promise<OrgToolResult>;
  reportTask(agentId: string, input: unknown): Promise<OrgToolResult>;
}

// ---------------------------------------------------------------------------------------------
// OrgApi
// ---------------------------------------------------------------------------------------------

/** OrgApi events: the protocol payloads the org module pushes to the mod, for in-process listeners. */
export type OrgEvents = {
  codexIndex: [payload: PayloadOf<'codex.index'>];
  calendarState: [payload: PayloadOf<'calendar.state'>];
  /**
   * An occurrence fired, and again (same `occurrence`, longer `walk`) as assignees accept a task. Task text reaches
   * the assignees through `CrewHooks.deliver` (orchestrator/modules.ts), not through this event.
   */
  calendarFired: [payload: PayloadOf<'calendar.fired'>];
  meetingState: [payload: PayloadOf<'meeting.state'>];
};

export interface OrgApi extends Subscribable<OrgEvents> {
  readonly codex: CodexApi;
  readonly calendar: CalendarApi;
  readonly meeting: MeetingApi;
  readonly tools: OrgAgentTools;
}
