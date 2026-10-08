/** Calendar event model (PLAN §6.6 "Calendar"). */

export type EventKind = 'task' | 'reminder' | 'meeting';
/** `game`: the world clock (ticks, Day N hh:mm). `real`: the wall clock (epoch ms, IANA zone). */
export type ClockKind = 'game' | 'real';
export type CatchUp = 'skip' | 'once_late';

export type Recurrence =
  | { readonly kind: 'once' }
  | { readonly kind: 'daily' }
  | { readonly kind: 'every_n_days'; readonly n: number }
  /** Monday to Friday; real clock only. */
  | { readonly kind: 'weekdays' };

export type OccurrenceStatus =
  | 'fired'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'missed'
  | 'deferred'
  | 'orphaned'
  | 'cancelled';

/**
 * - `active`: scheduled and firing.
 * - `awaiting_approval`: an agent-created recurring event or meeting waiting on the player's card.
 * - `paused`: kept but not firing (player choice, e.g. for an orphaned event).
 * - `completed`: a one-off that fired.
 * - `cancelled` / `declined`.
 */
export type EventStatus = 'active' | 'awaiting_approval' | 'paused' | 'completed' | 'cancelled' | 'declined';

export interface Occurrence {
  /** Scheduled time: game ticks or epoch ms, per the event's clock. */
  at: number;
  status: OccurrenceStatus;
  note?: string | undefined;
  /** Per-assignee status, for tasks. */
  assignees?: Record<string, OccurrenceStatus> | undefined;
  /** Real time it fired (epoch ms). */
  firedAt?: number | undefined;
  /** Fired after its time (catch-up). */
  late?: boolean | undefined;
}

export interface CalendarEvent {
  id: string;
  title: string;
  kind: EventKind;
  assignees: string[] | 'all';
  clock: ClockKind;
  /** First occurrence (game ticks or epoch ms). */
  start: number;
  /** Real clock: IANA zone the wall time is kept in. */
  tz?: string | undefined;
  /** Real clock: local wall time recurring occurrences keep across DST. */
  wallTime?: { hour: number; minute: number } | undefined;
  recurrence: Recurrence;
  durationMin: number;
  /** A place, `pc:<id>` or `meeting_table`. */
  location?: string | undefined;
  task: string;
  /** `player` or an agent id. */
  createdBy: string;
  createdByName: string;
  /** Created by the agent that was CEO at the time. */
  createdByCeo: boolean;
  catchUp: CatchUp;
  runWhileAway: boolean;
  status: EventStatus;
  /** Real-clock event whose assignees died with their world. */
  orphaned: boolean;
  /** The player acknowledged the orphan and kept it as is. */
  orphanKept?: boolean | undefined;
  nextAt: number | null;
  /** The last 20 occurrences, oldest first. */
  ring: Occurrence[];
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** World of a game-clock event. */
  worldId?: string | undefined;
  /** Spacing caps for recurring meetings: last held occurrence (real ms and game ticks). */
  lastMeetingAt?: number | undefined;
  lastMeetingTick?: number | undefined;
}

/** Ring size (PLAN: "a ring of the last 20 occurrences"). */
export const RING_SIZE = 20;

export function isRecurring(r: Recurrence): boolean {
  return r.kind !== 'once';
}

export type CalendarErrorCode =
  | 'INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NO_CLOCK'
  | 'IN_PAST'
  | 'NO_OPEN_OCCURRENCE';

export type CalendarResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: CalendarErrorCode; readonly message: string };
