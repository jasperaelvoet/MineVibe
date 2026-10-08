/**
 * Wire adapters: the org services' internal models ↔ the protocol shapes of `packages/protocol` (org group,
 * protocol §7.8). Every push and reply the org module sends is built here, and every request it receives is read
 * here. The wire is the truth; where the internal models differ:
 *
 * - Codex `rev` is an integer counter inside Node and an opaque hex token on the wire (7 zero-padded decimal digits,
 *   e.g. `0000003`, which matches `Rev`). {@link decodeRev} accepts the token, a plain number, or digits.
 * - Codex `created` / `updated` are ISO strings inside Node and epoch ms on the wire. Page history comes from git:
 *   each commit becomes `{ rev: <commit hash>, at, author, summary }`.
 * - Calendar statuses: `awaiting_approval` → `pending_approval`, `completed` → `done`, `declined` → `cancelled`, and
 *   an unresolved orphan (a real-clock event whose assignees died with their world) → `orphaned`.
 * - Calendar `ring` → `occurrences`: an occurrence with per-assignee outcomes becomes one entry per assignee
 *   (`agentId` set) unless they all agree; the newest 20 entries are kept.
 * - `every_n_days` needs `n >= 2` on the wire; every 1 day is `daily`.
 * - `meeting.state`: attendee modes become `coming | seated | dialed_in | absent | excused | left | dead`, `chair` is
 *   the planned chair while gathering, `endsBy` is the 10-minute cap and `quick` covers the quick standup and the
 *   short (Tired) format.
 */

import {
  ERROR_CODES,
  type MessageType,
  messageSchemas,
  type PayloadOf,
  type Place,
  type Author as WireAuthor,
  type CalendarEvent as WireCalendarEvent,
  type CodexPage as WireCodexPage,
  type CodexPageMeta as WireCodexPageMeta,
  type CodexHistoryEntry as WireHistoryEntry,
  type CodexHit as WireHit,
  type Occurrence as WireOccurrence,
  type Recurrence as WireRecurrence,
} from '@minevibe/protocol';
import type { CalendarErrorCode, CalendarEvent, Occurrence, Recurrence } from './calendar/types.js';
import type { CodexIndexEntry } from './codex/CodexStore.js';
import { encodeRev } from './codex/rev.js';
import type {
  CodexErrorCode,
  CodexHistoryEntry,
  CodexPage,
  CodexPageMeta,
  CodexSearchHit,
} from './codex/types.js';
import { type AuthorKind, singleLine } from './envelope.js';
import type { MeetingAttendee, MeetingState } from './meeting/MeetingRunner.js';

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CODEX_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CODEX_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_RE = /^[0-9a-f]{7,64}$/;

export { decodeRev, encodeRev, REV_WIDTH } from './codex/rev.js';

function epochMs(iso: string | number | undefined): number {
  if (typeof iso === 'number') return Number.isFinite(iso) && iso >= 0 ? Math.trunc(iso) : 0;
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

function title(text: string): string {
  return singleLine(text, 80) || 'Untitled';
}

/** A Node-stamped author (`name` ≤ 48, `agentId` only for agents). */
export function wireAuthor(kind: AuthorKind, name: string, id?: string): WireAuthor {
  const out: WireAuthor = {
    kind,
    name: singleLine(name, 48) || (kind === 'system' ? 'MineVibe' : kind === 'player' ? 'Player' : 'Agent'),
  };
  if (kind === 'agent' && id !== undefined && AGENT_ID_RE.test(id)) out.agentId = id;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

function wireTags(tags: readonly string[]): string[] {
  return tags.filter((t) => CODEX_TAG_RE.test(t)).slice(0, 16);
}

/** `CodexPageMeta` of an index entry or a page. */
export function toWireCodexMeta(meta: CodexIndexEntry | CodexPageMeta): WireCodexPageMeta {
  return {
    id: meta.id,
    title: title(meta.title),
    category: meta.category,
    scope: meta.scope,
    tags: wireTags(meta.tags),
    author: wireAuthor(meta.authorKind, meta.authorName, meta.author),
    created: epochMs(meta.created),
    updated: epochMs(meta.updated),
    rev: encodeRev(meta.rev),
    pinned: meta.pinned,
  };
}

/** One git commit of a page as a `CodexHistoryEntry`. Author identities are the Codex's fixed ones (git.ts). */
export function toWireHistoryEntry(entry: CodexHistoryEntry): WireHistoryEntry | null {
  const rev = entry.commit.trim().toLowerCase();
  if (!HEX_RE.test(rev)) return null;
  const email = entry.authorEmail.toLowerCase();
  const name = entry.authorName.replace(/\s*\((agent|player|system)\)\s*$/, '');
  let author: WireAuthor;
  if (email === 'player@minevibe.invalid') author = wireAuthor('player', name);
  else if (email === 'system@minevibe.invalid') author = wireAuthor('system', name || 'MineVibe');
  else
    author = wireAuthor(
      'agent',
      name,
      email.endsWith('@agents.minevibe.invalid') ? email.split('@')[0] : undefined,
    );
  return {
    rev,
    at: epochMs(entry.at),
    author,
    summary: singleLine(entry.message, 200) || 'update',
  };
}

/** A full page with its history (newest first, ≤ 50). */
export function toWireCodexPage(page: CodexPage, history: readonly CodexHistoryEntry[]): WireCodexPage {
  return {
    ...toWireCodexMeta(page),
    body: page.body.slice(0, 8192),
    links: page.links.filter((l) => CODEX_ID_RE.test(l)).slice(0, 64),
    history: history
      .map(toWireHistoryEntry)
      .filter((h): h is WireHistoryEntry => h !== null)
      .slice(0, 50),
  };
}

export function toWireCodexHit(hit: CodexSearchHit): WireHit {
  return {
    id: hit.id,
    title: title(hit.title),
    category: hit.category,
    scope: hit.scope,
    snippet: hit.snippet.slice(0, 400),
    score: Number.isFinite(hit.score) && hit.score > 0 ? hit.score : 0,
  };
}

/** Pages the `codex.index` push carries at most. */
export const CODEX_INDEX_MAX = 1000;

export function toWireCodexIndex(entries: readonly CodexIndexEntry[]): PayloadOf<'codex.index'> {
  return {
    pages: entries.slice(0, CODEX_INDEX_MAX).map(toWireCodexMeta),
    truncated: entries.length > CODEX_INDEX_MAX,
  };
}

/** The protocol error code of a Codex refusal. */
export function codexErrorCode(code: CodexErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return ERROR_CODES.CODEX_NOT_FOUND;
    case 'FORBIDDEN':
      return ERROR_CODES.FORBIDDEN;
    case 'SIMILAR_EXISTS':
      return ERROR_CODES.CODEX_SIMILAR;
    case 'REV_CONFLICT':
    case 'LOCKED':
      return ERROR_CODES.CODEX_CONFLICT;
    case 'TOO_LARGE':
    case 'PAGE_FULL':
      return ERROR_CODES.CODEX_TOO_LARGE;
    case 'BUDGET_EXCEEDED':
      return ERROR_CODES.CODEX_BUDGET;
    case 'SECRET':
      return ERROR_CODES.CODEX_SECRET;
    default:
      return ERROR_CODES.CODEX_INVALID;
  }
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

export function toWireRecurrence(r: Recurrence): WireRecurrence {
  if (r.kind === 'every_n_days') return r.n >= 2 ? { kind: 'every_n_days', n: r.n } : { kind: 'daily' };
  return { kind: r.kind };
}

export function toWireEventStatus(ev: CalendarEvent): WireCalendarEvent['status'] {
  switch (ev.status) {
    case 'awaiting_approval':
      return 'pending_approval';
    case 'completed':
      return 'done';
    case 'declined':
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      return 'paused';
    default:
      return ev.orphaned && !ev.orphanKept ? 'orphaned' : 'active';
  }
}

function occurrenceEntry(
  at: number,
  status: WireOccurrence['status'],
  note: string | undefined,
  agentId?: string,
): WireOccurrence {
  const entry: WireOccurrence = { at: Math.max(0, Math.trunc(at)), status };
  const n = note ? singleLine(note, 200) : '';
  if (n) entry.note = n;
  if (agentId !== undefined && AGENT_ID_RE.test(agentId)) entry.agentId = agentId;
  return entry;
}

/** The ring as wire occurrences: per-assignee entries when outcomes differ, newest 20 kept (oldest first). */
export function toWireOccurrences(ring: readonly Occurrence[]): WireOccurrence[] {
  const out: WireOccurrence[] = [];
  for (const occ of ring) {
    const per = Object.entries(occ.assignees ?? {});
    if (per.length === 0) {
      out.push(occurrenceEntry(occ.at, occ.status, occ.note));
    } else if (per.length === 1) {
      const [agentId, status] = per[0] as [string, Occurrence['status']];
      out.push(occurrenceEntry(occ.at, status, occ.note, agentId));
    } else if (per.every(([, st]) => st === per[0]?.[1])) {
      out.push(occurrenceEntry(occ.at, occ.status, occ.note));
    } else {
      per.forEach(([agentId, status], i) => {
        out.push(occurrenceEntry(occ.at, status, i === 0 ? occ.note : undefined, agentId));
      });
    }
  }
  return out.slice(-20);
}

export function toWireCalendarEvent(ev: CalendarEvent): WireCalendarEvent {
  const out: WireCalendarEvent = {
    id: ev.id,
    title: title(ev.title),
    kind: ev.kind,
    assignees: ev.assignees === 'all' ? 'all' : ev.assignees.slice(0, 16),
    clock: ev.clock,
    at: Math.max(0, Math.trunc(ev.start)),
    recurrence: toWireRecurrence(ev.recurrence),
    durationMin: Math.min(1440, Math.max(1, Math.round(ev.durationMin))),
    catchUp: ev.catchUp,
    runWhileAway: ev.runWhileAway,
    createdBy: ev.createdBy,
    status: toWireEventStatus(ev),
    nextAt: ev.nextAt === null ? null : Math.max(0, Math.trunc(ev.nextAt)),
    occurrences: toWireOccurrences(ev.ring),
  };
  if (ev.clock === 'real' && ev.tz) out.tz = ev.tz;
  const location = ev.location ? singleLine(ev.location, 80) : '';
  if (location) out.location = location;
  if (ev.task) out.task = ev.task.slice(0, 2000);
  return out;
}

/** Events the `calendar.state` push carries at most. */
export const CALENDAR_STATE_MAX = 500;

export function toWireCalendarState(
  events: readonly CalendarEvent[],
  tz: string,
): PayloadOf<'calendar.state'> {
  return { events: events.slice(0, CALENDAR_STATE_MAX).map(toWireCalendarEvent), tz };
}

/** The protocol error code of a calendar refusal. */
export function calendarErrorCode(code: CalendarErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
    case 'NO_OPEN_OCCURRENCE':
      return ERROR_CODES.CALENDAR_NOT_FOUND;
    case 'FORBIDDEN':
      return ERROR_CODES.FORBIDDEN;
    case 'RATE_LIMITED':
      return ERROR_CODES.CALENDAR_LIMIT;
    case 'NO_CLOCK':
      return ERROR_CODES.NOT_READY;
    default:
      return ERROR_CODES.CALENDAR_INVALID;
  }
}

/** The fields of a `calendar.put` / contract event input, as the CalendarService takes them. */
export interface WireEventFields {
  readonly title: string;
  readonly kind: CalendarEvent['kind'];
  readonly assignees: 'all' | readonly string[];
  readonly clock: CalendarEvent['clock'];
  readonly at: number;
  readonly tz?: string | undefined;
  readonly recurrence: WireRecurrence;
  readonly durationMin: number;
  readonly location?: string | undefined;
  readonly task?: string | undefined;
  readonly catchUp: CalendarEvent['catchUp'];
  readonly runWhileAway: boolean;
}

/** Internal add input of wire event fields. */
export function fromWireEventFields(f: WireEventFields) {
  return {
    title: f.title,
    kind: f.kind,
    assignees: f.assignees === 'all' ? ('all' as const) : [...f.assignees],
    clock: f.clock,
    when: f.at,
    recurrence:
      f.recurrence.kind === 'every_n_days'
        ? { kind: 'every_n_days' as const, n: f.recurrence.n ?? 0 }
        : { kind: f.recurrence.kind },
    durationMin: f.durationMin,
    location: f.location,
    task: f.task,
    catchUp: f.catchUp,
    runWhileAway: f.runWhileAway,
    tz: f.tz,
  };
}

/**
 * The internal update patch of wire fields for an existing event. The schedule (`at`, `clock`, `recurrence`, `tz`)
 * is left out when it is unchanged, so an edit of a due or late one-off (a new title, a new assignee) keeps its
 * time instead of being refused as "in the past".
 */
export function fromWireEventPatch(f: Partial<WireEventFields>, existing: CalendarEvent) {
  const sameRecurrence =
    f.recurrence === undefined ||
    JSON.stringify(toWireRecurrence(existing.recurrence)) ===
      JSON.stringify(f.recurrence.kind === 'every_n_days' ? f.recurrence : { kind: f.recurrence.kind });
  const sameSchedule =
    (f.at === undefined || f.at === existing.start) &&
    (f.clock === undefined || f.clock === existing.clock) &&
    (f.tz === undefined || f.tz === existing.tz) &&
    sameRecurrence;
  const patch: Record<string, unknown> = {};
  if (f.title !== undefined) patch.title = f.title;
  if (f.kind !== undefined) patch.kind = f.kind;
  if (f.assignees !== undefined) patch.assignees = f.assignees === 'all' ? 'all' : [...f.assignees];
  if (f.durationMin !== undefined) patch.durationMin = f.durationMin;
  if (f.location !== undefined) patch.location = f.location;
  if (f.task !== undefined) patch.task = f.task;
  if (f.catchUp !== undefined) patch.catchUp = f.catchUp;
  if (f.runWhileAway !== undefined) patch.runWhileAway = f.runWhileAway;
  if (!sameSchedule) {
    if (f.at !== undefined) patch.when = f.at;
    if (f.clock !== undefined) patch.clock = f.clock;
    if (f.tz !== undefined) patch.tz = f.tz;
    if (f.recurrence !== undefined) {
      patch.recurrence =
        f.recurrence.kind === 'every_n_days'
          ? { kind: 'every_n_days', n: f.recurrence.n ?? 0 }
          : { kind: f.recurrence.kind };
    }
  }
  return patch;
}

/** A `calendar.fired` payload. `assignees` is resolved (`all` → the living crew); `walk` ⊆ assignees. */
export function toWireCalendarFired(
  ev: Pick<CalendarEvent, 'id' | 'kind' | 'title'>,
  occurrence: number,
  assignees: readonly string[],
  target: Place | null,
  walk: readonly string[],
): PayloadOf<'calendar.fired'> {
  const ids = assignees.filter((a) => AGENT_ID_RE.test(a)).slice(0, 16);
  return {
    eventId: ev.id,
    occurrence: Math.max(0, Math.trunc(occurrence)),
    kind: ev.kind,
    title: title(ev.title),
    assignees: ids,
    target,
    walk: walk.filter((a) => ids.includes(a)).slice(0, 16),
  };
}

// ---------------------------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------------------------

type WireAttendeeStatus = PayloadOf<'meeting.state'>['attendees'][number]['status'];

export function toWireAttendeeStatus(a: Pick<MeetingAttendee, 'mode' | 'reason'>): WireAttendeeStatus {
  switch (a.mode) {
    case 'walking':
      return 'coming';
    case 'present':
      return 'seated';
    case 'dial_in':
      return 'dialed_in';
    case 'absent':
      return a.reason === 'dead' ? 'dead' : 'absent';
    case 'excused':
      return 'excused';
    case 'left':
      return a.reason === 'died' || a.reason === 'dead' ? 'dead' : 'left';
  }
}

function speaker(id: string | null): string | null {
  if (id === null) return null;
  return id === 'player' || AGENT_ID_RE.test(id) ? id : null;
}

export function toWireMeetingState(state: MeetingState): PayloadOf<'meeting.state'> {
  return {
    meetingId: state.id,
    title: title(state.title),
    phase: state.phase,
    chair: speaker(state.chair ?? state.plannedChair) ?? 'player',
    speaker: speaker(state.speaker),
    attendees: state.attendees.slice(0, 16).map((a) => ({
      agentId: a.agentId,
      status: toWireAttendeeStatus(a),
      etaS:
        a.mode === 'walking' && typeof a.etaSec === 'number' && Number.isFinite(a.etaSec)
          ? Math.max(0, Math.round(a.etaSec))
          : null,
    })),
    eventId: state.eventId ?? null,
    startedAt: Math.max(0, Math.trunc(state.startedAt)),
    endsBy: Math.max(0, Math.trunc(state.endsBy)),
    quick: state.format !== 'full',
  };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** Validates a payload against its message schema (the bridge does this too on send); throws a readable error. */
export function assertWire<T extends MessageType>(t: T, payload: PayloadOf<T>): PayloadOf<T> {
  const res = messageSchemas[t].safeParse({ t, v: 1, ...payload });
  if (!res.success) {
    const why = res.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`${t}: ${why}`);
  }
  return payload;
}
