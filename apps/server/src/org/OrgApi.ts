/**
 * The org services facade (PLAN §6.6, §6.4): what the agent runtime's `mc` tool server, the bridge handlers for
 * CodexScreen / CalendarScreen / the meeting HUD, and the world lifecycle call.
 *
 * Local facade for track T5. T0 owns the shared contract in `apps/server/src/contracts/OrgApi.ts`; names here follow
 * the PLAN's tool names (`codex_search` → `codexSearch`, …) so the merge can reconcile the two.
 *
 * Every agent-facing result is `{ ok, text }`: `text` is exactly what the agent sees, with all shared text (pages,
 * titles, tasks, notes) inside Node-made data envelopes and control lines tagged with the session nonce.
 */

import { z } from 'zod';
import type { ApproachCard, ApproachSnapshot, ApproachState } from './approach/ApproachQueue.js';
import type { CalendarApprovalCard, OrphanAction } from './calendar/CalendarService.js';
import type { CalendarEvent } from './calendar/types.js';
import type { CodexIndexEntry } from './codex/CodexStore.js';
import {
  CODEX_CATEGORIES,
  type CodexHistoryEntry,
  type CodexPage,
  type CodexSearchHit,
  type CodexWriteResult,
} from './codex/types.js';
import type { AttendeeMode, MeetingState } from './meeting/MeetingRunner.js';

// ---------------------------------------------------------------------------------------------
// Agent tool inputs (mcp__mc__codex_* / calendar_* / report_task)
// ---------------------------------------------------------------------------------------------

const Category = z.enum(CODEX_CATEGORIES);
const Tag = z.string().min(1).max(32);

export const CodexSearchInput = z.object({
  query: z.string().min(1).max(200),
  tags: z.array(Tag).max(8).optional(),
  category: Category.optional(),
});
export type CodexSearchInput = z.infer<typeof CodexSearchInput>;

export const CodexReadInput = z.object({ id: z.string().min(1).max(64) });
export type CodexReadInput = z.infer<typeof CodexReadInput>;

export const CodexWriteToolInput = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(16_384),
  tags: z.array(Tag).max(8).optional(),
  category: Category.optional(),
  scope: z.enum(['lasting', 'world']).optional(),
  id: z.string().max(64).optional(),
  base_rev: z.number().int().positive().optional(),
  mode: z.enum(['create', 'update', 'append']),
  here: z.boolean().optional(),
});
export type CodexWriteToolInput = z.infer<typeof CodexWriteToolInput>;

export const CodexListInput = z.object({ category: Category.optional(), tag: Tag.optional() });
export type CodexListInput = z.infer<typeof CodexListInput>;

const Recurrence = z.union([
  z.enum(['once', 'daily', 'weekdays']),
  z.object({ every_n_days: z.number().int().min(1).max(365) }),
]);

export const CalendarListInput = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  agent: z.string().max(64).optional(),
});
export type CalendarListInput = z.infer<typeof CalendarListInput>;

export const CalendarAddToolInput = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['task', 'reminder', 'meeting']).optional(),
  /** Agent ids, handles or names; or "all". */
  assignees: z.union([z.literal('all'), z.array(z.string().min(1).max(64)).min(1).max(16)]).optional(),
  clock: z.enum(['game', 'real']).optional(),
  when: z.union([z.string().min(1).max(64), z.number()]),
  recurrence: Recurrence.optional(),
  durationMin: z.number().int().min(1).max(1440).optional(),
  location: z.string().max(64).optional(),
  task: z.string().max(1000).optional(),
  catchUp: z.enum(['skip', 'once_late']).optional(),
  runWhileAway: z.boolean().optional(),
});
export type CalendarAddToolInput = z.infer<typeof CalendarAddToolInput>;

export const CalendarUpdateToolInput = CalendarAddToolInput.partial().extend({
  id: z.string().min(1).max(64),
});
export type CalendarUpdateToolInput = z.infer<typeof CalendarUpdateToolInput>;

export const CalendarCancelInput = z.object({ id: z.string().min(1).max(64) });
export type CalendarCancelInput = z.infer<typeof CalendarCancelInput>;

export const ReportTaskInput = z.object({
  eventId: z.string().min(1).max(64),
  status: z.enum(['done', 'failed', 'blocked']),
  note: z.string().max(500).optional(),
});
export type ReportTaskInput = z.infer<typeof ReportTaskInput>;

/** What an agent tool call returns: `text` goes to the agent verbatim. */
export interface OrgToolResult {
  readonly ok: boolean;
  readonly text: string;
  /** Machine-readable refusal code (SIMILAR_EXISTS, FORBIDDEN, …). */
  readonly code?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------------------------

/** Called by the agent runtime's `mc` tool server. `agentId` is stamped by Node, never taken from the model. */
export interface OrgAgentTools {
  codexSearch(agentId: string, input: unknown): OrgToolResult;
  codexRead(agentId: string, input: unknown): OrgToolResult;
  codexWrite(agentId: string, input: unknown): Promise<OrgToolResult>;
  codexList(agentId: string, input: unknown): OrgToolResult;
  calendarList(agentId: string, input: unknown): OrgToolResult;
  calendarAdd(agentId: string, input: unknown): OrgToolResult;
  calendarUpdate(agentId: string, input: unknown): OrgToolResult;
  calendarCancel(agentId: string, input: unknown): OrgToolResult;
  reportTask(agentId: string, input: unknown): OrgToolResult;
}

/** Context messages for agents (`shouldQuery:false`). */
export interface OrgContext {
  /** The Codex digest: at session start and once per real day (~800 tokens). */
  codexDigest(): string;
}

/** CodexScreen (`codex.search/get/put/delete`), the player's side. */
export interface OrgCodexScreen {
  codexIndex(): CodexIndexEntry[];
  codexSearchScreen(query: string, options?: { tags?: string[]; category?: string }): CodexSearchHit[];
  codexGet(id: string): CodexPage | null;
  codexPut(input: unknown): Promise<CodexWriteResult>;
  codexDelete(id: string): Promise<{ ok: boolean; message?: string }>;
  codexPin(id: string, pinned: boolean): Promise<{ ok: boolean; message?: string }>;
  codexLock(id: string): boolean;
  codexUnlock(id: string): void;
  codexHistory(id: string): Promise<CodexHistoryEntry[]>;
}

/** CalendarScreen (`calendar.put/cancel`) and the meeting HUD. */
export interface OrgCalendarScreen {
  calendarState(): {
    events: CalendarEvent[];
    gameTicks: number | null;
    realNow: number;
    timeZone: string;
    orphans: string[];
  };
  /** New event (no `id`) or an edit (with `id`), as the player. */
  calendarPut(input: unknown): { ok: boolean; message?: string; event?: CalendarEvent };
  calendarCancelByPlayer(id: string): { ok: boolean; message?: string };
  resolveOrphan(id: string, action: OrphanAction): { ok: boolean; message?: string };
  /** The player's answer to an agent's recurring-event or meeting card. */
  decideCalendarApproval(
    eventId: string,
    approved: boolean,
    note?: string,
  ): { ok: boolean; message?: string };
  previewMeetingEtas(): Array<{ agentId: string; name: string; etaSec: number | null; mode: AttendeeMode }>;
  startMeetingNow(options?: { playerChairs?: boolean; quick?: boolean }): string;
  /** HUD End button or exactly `@meeting end`. */
  endMeeting(): void;
  meetingState(): MeetingState | null;
}

/** World lifecycle and 1 Hz inputs. */
export interface OrgLifecycle {
  openWorld(worldId: string): Promise<void>;
  /** World death: archive the world's Codex pages, drop game-clock events, orphan real-clock ones. */
  worldEnded(worldId: string): Promise<{ codexArchived: number; orphanedEvents: string[]; notice: string }>;
  onGameClock(ticks: number): void;
  notePlayerInput(): void;
  /** The 1 Hz world view for the ApproachQueue. */
  onWorldView(snapshot: ApproachSnapshot): void;
}

/** Cards that make agents come to the player (PLAN §6.4). */
export interface OrgApproach {
  cardPending(card: ApproachCard): void;
  cardResolved(cardId: string): void;
  later(agentId: string): boolean;
  setPingPreference(agentId: string, ping: boolean): void;
  approachState(): ApproachState;
}

/** Meeting inputs from chat and the mod. */
export interface OrgMeetings {
  /** An unmentioned player line routed to the meeting by the ChatRouter. */
  meetingMessage(text: string): boolean;
  meetingArrived(agentId: string): void;
  agentDied(agentId: string): void;
  isInMeeting(agentId: string): boolean;
}

export interface OrgApi
  extends OrgAgentTools,
    OrgContext,
    OrgCodexScreen,
    OrgCalendarScreen,
    OrgLifecycle,
    OrgApproach,
    OrgMeetings {}

export type { CalendarApprovalCard };
