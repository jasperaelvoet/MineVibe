import { z } from 'zod';
import {
  AgentId,
  Author,
  CodexId,
  EpochMs,
  EventId,
  MeetingId,
  NonNegInt,
  Place,
  Rev,
  Title,
} from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

// ---------------------------------------------------------------------------------------------
// Codex (PLAN §6.6)
// ---------------------------------------------------------------------------------------------

/** `rules` pages are player-only and the only binding house rules. */
export const CodexCategory = z.enum([
  'places',
  'howto',
  'projects',
  'decisions',
  'people',
  'log',
  'minutes',
  'rules',
]);
export type CodexCategory = z.infer<typeof CodexCategory>;

/** `lasting` pages survive world death; `world` pages are archived with the world. */
export const CodexScope = z.enum(['lasting', 'world']);
export type CodexScope = z.infer<typeof CodexScope>;

export const CodexTag = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'tag: 1-32 of [a-z0-9-]');

/** Largest page body, in characters (Node also enforces 8 KB of UTF-8). */
export const CODEX_BODY_MAX = 8192;

export const CodexPageMeta = z.object({
  id: CodexId,
  title: Title,
  category: CodexCategory,
  scope: CodexScope,
  tags: z.array(CodexTag).max(16),
  author: Author,
  created: EpochMs,
  updated: EpochMs,
  rev: Rev,
  pinned: z.boolean(),
});
export type CodexPageMeta = z.infer<typeof CodexPageMeta>;

export const CodexHistoryEntry = z.object({
  rev: Rev,
  at: EpochMs,
  author: Author,
  /** Commit summary ("append", "update: fixed coordinates"). */
  summary: z.string().min(1).max(200),
});
export type CodexHistoryEntry = z.infer<typeof CodexHistoryEntry>;

export const CodexPage = CodexPageMeta.extend({
  body: z.string().max(CODEX_BODY_MAX),
  links: z.array(CodexId).max(64),
  /** Newest first. */
  history: z.array(CodexHistoryEntry).max(50),
});
export type CodexPage = z.infer<typeof CodexPage>;

export const CodexHit = z.object({
  id: CodexId,
  title: Title,
  category: CodexCategory,
  scope: CodexScope,
  /** Text around the matched terms. */
  snippet: z.string().max(400),
  score: z.number().min(0),
});
export type CodexHit = z.infer<typeof CodexHit>;

export const CodexWriteMode = z.enum(['create', 'update', 'append']);
export type CodexWriteMode = z.infer<typeof CodexWriteMode>;

// ---------------------------------------------------------------------------------------------
// Calendar (PLAN §6.6)
// ---------------------------------------------------------------------------------------------

export const CalendarKind = z.enum(['task', 'reminder', 'meeting']);
export type CalendarKind = z.infer<typeof CalendarKind>;

/** `game`: the overworld clock (Day N hh:mm). `real`: the wall clock in an IANA time zone. */
export const CalendarClock = z.enum(['game', 'real']);
export type CalendarClock = z.infer<typeof CalendarClock>;

/** `weekdays` is real clock only; `every_n_days` needs `n`. */
export const Recurrence = z
  .object({
    kind: z.enum(['once', 'daily', 'every_n_days', 'weekdays']),
    n: z.number().int().min(2).max(365).optional(),
  })
  .refine((r) => (r.kind === 'every_n_days') === (r.n !== undefined), {
    message: 'every_n_days needs n (and only it)',
    path: ['n'],
  });
export type Recurrence = z.infer<typeof Recurrence>;

export const OccurrenceStatus = z.enum([
  'fired',
  'done',
  'failed',
  'blocked',
  'missed',
  'deferred',
  'orphaned',
  'cancelled',
]);
export type OccurrenceStatus = z.infer<typeof OccurrenceStatus>;

export const Occurrence = z.object({
  /** When it was due (game: clock ticks; real: epoch ms). */
  at: NonNegInt,
  status: OccurrenceStatus,
  note: z.string().min(1).max(200).optional(),
  /** The assignee this entry is about, for per-agent outcomes. */
  agentId: AgentId.optional(),
});
export type Occurrence = z.infer<typeof Occurrence>;

/** Assignees: agent ids, or `all`. */
export const Assignees = z.union([z.literal('all'), z.array(AgentId).min(1).max(16)]);
export type Assignees = z.infer<typeof Assignees>;

/** Who created an event: `player` or an agent id. */
export const CreatedBy = z.union([z.literal('player'), AgentId]);

/** The fields a calendar event is created or edited with (CalendarScreen form, `mc__calendar_add`). */
const calendarEventFields = {
  title: Title,
  kind: CalendarKind,
  assignees: Assignees,
  clock: CalendarClock,
  /** First due time. Game clock: overworld clock ticks (Day = floor(t/24000)+1, 06:00 = tick 0). Real: epoch ms. */
  at: NonNegInt,
  /** IANA zone for the real clock ("Europe/Brussels"); absent = the host zone. */
  tz: z.string().min(1).max(64).optional(),
  recurrence: Recurrence,
  durationMin: z.number().int().min(1).max(1440),
  /** A Codex place, `pc:<id>` or `meeting_table`. */
  location: z.string().min(1).max(80).optional(),
  task: z.string().min(1).max(2000).optional(),
  catchUp: z.enum(['skip', 'once_late']),
  runWhileAway: z.boolean(),
};

export const CalendarEvent = z
  .object({
    id: EventId,
    ...calendarEventFields,
    createdBy: CreatedBy,
    status: z.enum(['active', 'paused', 'pending_approval', 'orphaned', 'done', 'cancelled']),
    /** Next due time on the event's clock; null when nothing is due. */
    nextAt: NonNegInt.nullable(),
    /** The last 20 occurrences, newest last. */
    occurrences: z.array(Occurrence).max(20),
  })
  .refine((e) => e.recurrence.kind !== 'weekdays' || e.clock === 'real', {
    message: 'weekdays recurrence needs the real clock',
    path: ['recurrence'],
  });
export type CalendarEvent = z.infer<typeof CalendarEvent>;

// ---------------------------------------------------------------------------------------------
// Meetings (PLAN §6.6)
// ---------------------------------------------------------------------------------------------

export const MeetingPhase = z.enum(['gathering', 'open', 'updates', 'floor', 'wrapup', 'done']);
export type MeetingPhase = z.infer<typeof MeetingPhase>;

export const MeetingAttendee = z.object({
  agentId: AgentId,
  status: z.enum(['coming', 'seated', 'dialed_in', 'absent', 'excused', 'left', 'dead']),
  /** Path ETA in seconds while `coming`. */
  etaS: NonNegInt.nullable(),
});
export type MeetingAttendee = z.infer<typeof MeetingAttendee>;

/** `player` or an agent id. */
export const Speaker = z.union([z.literal('player'), AgentId]);

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** N→M. The Codex index for CodexScreen (sent after `hello.ok` and on every change). */
export const CodexIndex = defineMessage('codex.index', {
  pages: z.array(CodexPageMeta).max(1000),
  /** More pages exist than fit; CodexScreen falls back to `codex.search`. */
  truncated: z.boolean(),
}).describe('The Codex index.');

/** M→N request. CodexScreen search. Reply: {@link CodexSearchResult}. */
export const CodexSearch = defineMessage('codex.search', {
  query: z.string().max(200),
  tags: z.array(CodexTag).max(8).optional(),
  category: CodexCategory.optional(),
  scope: CodexScope.optional(),
  limit: z.number().int().min(1).max(50),
}).describe('Searches the Codex.');

export const CodexSearchResult = z.object({ hits: z.array(CodexHit).max(50) });
export type CodexSearchResult = z.infer<typeof CodexSearchResult>;

/** M→N request. Reads one page. Reply: {@link CodexGetResult}. Error: `CODEX_NOT_FOUND`. */
export const CodexGet = defineMessage('codex.get', { pageId: CodexId }).describe('Reads a Codex page.');

export const CodexGetResult = z.object({ page: CodexPage });
export type CodexGetResult = z.infer<typeof CodexGetResult>;

/**
 * M→N request. The player writes a page (stamped as player-authored; only the player may write `rules`).
 * `update` and `append` need `pageId`; `update` needs `baseRev`. Reply: {@link CodexPutResult}. Errors:
 * `CODEX_CONFLICT` (stale `baseRev`), `CODEX_SIMILAR`, `CODEX_TOO_LARGE`, `CODEX_SECRET`, `CODEX_NOT_FOUND`,
 * `CODEX_INVALID` (coordinates in a lasting page, ...).
 */
export const CodexPut = defineMessage('codex.put', {
  mode: CodexWriteMode,
  pageId: CodexId.optional(),
  baseRev: Rev.optional(),
  title: Title,
  body: z.string().min(1).max(CODEX_BODY_MAX),
  tags: z.array(CodexTag).max(16),
  category: CodexCategory,
  scope: CodexScope,
  pinned: z.boolean().optional(),
})
  .refine((m) => m.mode === 'create' || m.pageId !== undefined, {
    message: 'update and append need pageId',
    path: ['pageId'],
  })
  .refine((m) => m.mode !== 'update' || m.baseRev !== undefined, {
    message: 'update needs baseRev',
    path: ['baseRev'],
  })
  .describe('Creates, updates or appends to a Codex page.');

export const CodexPutResult = z.object({ pageId: CodexId, rev: Rev });
export type CodexPutResult = z.infer<typeof CodexPutResult>;

/** M→N request. Deletes a page (player only). Errors: `CODEX_NOT_FOUND`, `CODEX_CONFLICT`. */
export const CodexDelete = defineMessage('codex.delete', {
  pageId: CodexId,
  baseRev: Rev.optional(),
}).describe('Deletes a Codex page.');

/** N→M. Every calendar event (sent after `hello.ok` and on every change). */
export const CalendarState = defineMessage('calendar.state', {
  events: z.array(CalendarEvent).max(500),
  /** The host IANA zone (the Real-time tab). */
  tz: z.string().min(1).max(64),
}).describe('All calendar events.');

/**
 * M→N request. Create (no `eventId`) or replace (with `eventId`) an event from CalendarScreen. Reply: {@link
 * CalendarPutResult}. Errors: `CALENDAR_NOT_FOUND`, `CALENDAR_INVALID`.
 */
export const CalendarPut = defineMessage('calendar.put', {
  eventId: EventId.optional(),
  ...calendarEventFields,
})
  .refine((e) => e.recurrence.kind !== 'weekdays' || e.clock === 'real', {
    message: 'weekdays recurrence needs the real clock',
    path: ['recurrence'],
  })
  .describe('Creates or edits a calendar event.');

export const CalendarPutResult = z.object({ eventId: EventId });
export type CalendarPutResult = z.infer<typeof CalendarPutResult>;

/** M→N request. Cancels the next occurrence or the whole event. Error: `CALENDAR_NOT_FOUND`. */
export const CalendarCancel = defineMessage('calendar.cancel', {
  eventId: EventId,
  scope: z.enum(['next', 'all']),
}).describe('Cancels a calendar event or its next occurrence.');

/**
 * N→M. An occurrence fired. Reminders show a bubble and toast. For tasks, `walk` lists the assignees whose brain
 * accepted the task and who should now go to `target` (reflex 38); Node re-sends the same occurrence as more
 * assignees accept.
 */
export const CalendarFired = defineMessage('calendar.fired', {
  eventId: EventId,
  /** The occurrence's due time (its id within the event). */
  occurrence: NonNegInt,
  kind: CalendarKind,
  title: Title,
  assignees: z.array(AgentId).max(16),
  /** The resolved location, null when the event has none. */
  target: Place.nullable(),
  walk: z.array(AgentId).max(16),
}).describe('A calendar occurrence fired.');

/** N→M. The active meeting (phase, speaker, attendees); `phase: done` ends it on the HUD. */
export const MeetingState = defineMessage('meeting.state', {
  meetingId: MeetingId,
  title: Title,
  phase: MeetingPhase,
  chair: Speaker,
  speaker: Speaker.nullable(),
  attendees: z.array(MeetingAttendee).max(16),
  eventId: EventId.nullable(),
  startedAt: EpochMs,
  /** Hard cap: at most 10 real minutes. */
  endsBy: EpochMs,
  /** Quick standup, or usage is Tired: one round, no floor. */
  quick: z.boolean(),
}).describe('The active meeting.');

/**
 * M→N request. "Start meeting now" (CalendarScreen) or starting a scheduled meeting early. With `preview` Node
 * only computes ETAs. Reply: {@link MeetingStartResult}. Errors: `MEETING_BUSY`, `NO_QUORUM`.
 */
export const MeetingStart = defineMessage('meeting.start', {
  eventId: EventId.optional(),
  title: Title.optional(),
  /** Absent = everyone. */
  attendees: z.union([z.literal('all'), z.array(AgentId).min(1).max(16)]).optional(),
  preview: z.boolean(),
}).describe('Starts a meeting (or previews attendee ETAs).');

export const MeetingStartResult = z.object({
  /** Null for a preview. */
  meetingId: MeetingId.nullable(),
  etas: z.array(z.object({ agentId: AgentId, etaS: NonNegInt.nullable(), dialIn: z.boolean() })).max(16),
});
export type MeetingStartResult = z.infer<typeof MeetingStartResult>;

/** M→N request. The meeting HUD's End button. Error: `MEETING_NOT_FOUND`. */
export const MeetingEnd = defineMessage('meeting.end', { meetingId: MeetingId }).describe(
  'Ends the meeting.',
);

export const orgMessages = {
  'codex.index': {
    schema: CodexIndex,
    direction: 'node_to_mod',
    group: 'org',
    summary: 'The Codex page index for CodexScreen.',
  },
  'codex.search': {
    schema: CodexSearch,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: full-text Codex search.',
    reply: CodexSearchResult,
  },
  'codex.get': {
    schema: CodexGet,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: read a Codex page with its history.',
    reply: CodexGetResult,
  },
  'codex.put': {
    schema: CodexPut,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: create, update or append to a Codex page as the player.',
    reply: CodexPutResult,
  },
  'codex.delete': {
    schema: CodexDelete,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: delete a Codex page.',
  },
  'calendar.state': {
    schema: CalendarState,
    direction: 'node_to_mod',
    group: 'org',
    summary: 'Every calendar event with its occurrence log.',
  },
  'calendar.put': {
    schema: CalendarPut,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: create or edit a calendar event as the player.',
    reply: CalendarPutResult,
  },
  'calendar.cancel': {
    schema: CalendarCancel,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: cancel an event or its next occurrence.',
  },
  'calendar.fired': {
    schema: CalendarFired,
    direction: 'node_to_mod',
    group: 'org',
    summary: 'A calendar occurrence fired; lists who walks to the location now.',
  },
  'meeting.state': {
    schema: MeetingState,
    direction: 'node_to_mod',
    group: 'org',
    summary: 'The active meeting: phase, chair, speaker, attendees.',
  },
  'meeting.start': {
    schema: MeetingStart,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: start a meeting now (or preview ETAs).',
    reply: MeetingStartResult,
  },
  'meeting.end': {
    schema: MeetingEnd,
    direction: 'mod_to_node',
    group: 'org',
    summary: 'Request: end the meeting (HUD End button).',
  },
} as const satisfies Record<string, CatalogEntry>;
