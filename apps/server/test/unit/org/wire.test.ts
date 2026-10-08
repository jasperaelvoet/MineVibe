import {
  CalendarEvent as CalendarEventSchema,
  CodexGetResult,
  CodexSearchResult,
  type PayloadOf,
  safeParseMessage,
} from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Occurrence } from '../../../src/org/calendar/types.js';
import type { CodexIndexEntry } from '../../../src/org/codex/CodexStore.js';
import type { CodexPage } from '../../../src/org/codex/types.js';
import type { MeetingState } from '../../../src/org/meeting/MeetingRunner.js';
import {
  calendarErrorCode,
  codexErrorCode,
  decodeRev,
  encodeRev,
  fromWireEventFields,
  fromWireEventPatch,
  toWireCalendarFired,
  toWireCalendarState,
  toWireCodexHit,
  toWireCodexIndex,
  toWireCodexPage,
  toWireHistoryEntry,
  toWireMeetingState,
  toWireOccurrences,
} from '../../../src/org/wire.js';

/** Validates a payload with the protocol's zod registry (the bridge does the same on send). */
function valid<T extends 'codex.index' | 'calendar.state' | 'calendar.fired' | 'meeting.state'>(
  t: T,
  payload: PayloadOf<T>,
): PayloadOf<T> {
  const res = safeParseMessage({ t, v: 1, ...payload });
  if (res.status !== 'ok') throw new Error(res.status === 'invalid' ? res.error : 'unknown type');
  return payload;
}

const page: CodexPage = {
  id: 'iron-cave',
  title: 'Iron cave',
  tags: ['iron', 'caves'],
  category: 'places',
  scope: 'world',
  world: 'world-1',
  author: 'bram-1',
  authorName: 'Bram',
  authorKind: 'agent',
  created: '2026-10-08T10:00:00.000Z',
  updated: '2026-10-08T11:00:00.000Z',
  createdDay: 2,
  links: ['smelting', 'Not A Slug'],
  rev: 3,
  pinned: false,
  coords: { x: 120, y: 40, z: -80, dim: 'minecraft:overworld' },
  contributors: ['bram-1'],
  body: 'Iron cave at (120,40,-80).',
};

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev-1',
    title: 'Farm wheat',
    kind: 'task',
    assignees: ['bram-1'],
    clock: 'game',
    start: 48_000,
    recurrence: { kind: 'once' },
    durationMin: 30,
    location: 'farm',
    task: 'Harvest and replant.',
    createdBy: 'player',
    createdByName: 'Jasper',
    createdByCeo: false,
    catchUp: 'skip',
    runWhileAway: false,
    status: 'active',
    orphaned: false,
    nextAt: 48_000,
    ring: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function meeting(over: Partial<MeetingState> = {}): MeetingState {
  return {
    id: 'mt-0a1b2c3d',
    title: 'Standup',
    phase: 'gathering',
    attendees: [
      { agentId: 'ada-1', name: 'Ada', mode: 'walking', etaSec: 12.4, wasSeated: false },
      { agentId: 'bram-1', name: 'Bram', mode: 'present', wasSeated: true },
      { agentId: 'cleo-1', name: 'Cleo', mode: 'dial_in', reason: 'dimension', wasSeated: false },
      { agentId: 'dan-1', name: 'Dan', mode: 'absent', reason: 'dead', wasSeated: false },
      { agentId: 'eve-1', name: 'Eve', mode: 'absent', reason: 'dismissed', wasSeated: false },
      { agentId: 'fay-1', name: 'Fay', mode: 'excused', reason: 'seated', wasSeated: true },
      { agentId: 'gus-1', name: 'Gus', mode: 'left', reason: 'died', wasSeated: false },
      { agentId: 'hal-1', name: 'Hal', mode: 'left', reason: 'dismissed', wasSeated: false },
    ],
    speaker: null,
    chair: null,
    format: 'full',
    startedAt: 1_791_513_600_000,
    endsBy: 1_791_514_200_000,
    plannedChair: 'ada-1',
    ...over,
  };
}

describe('wire adapters: Codex', () => {
  it('revisions are 7-digit tokens that round-trip, and anything else never matches', () => {
    expect(encodeRev(3)).toBe('0000003');
    expect(decodeRev(encodeRev(3))).toBe(3);
    expect(decodeRev(12)).toBe(12);
    expect(decodeRev('a1b2c3d4')).toBe(-1);
    expect(decodeRev(undefined)).toBeUndefined();
  });

  it('index, page (with git history) and hits validate against the protocol', () => {
    const entry: CodexIndexEntry = (({ contributors: _c, links: _l, body: _b, ...rest }) => rest)(page);
    const index = valid('codex.index', toWireCodexIndex([entry]));
    expect(index.pages[0]).toEqual({
      id: 'iron-cave',
      title: 'Iron cave',
      category: 'places',
      scope: 'world',
      tags: ['iron', 'caves'],
      author: { kind: 'agent', name: 'Bram', agentId: 'bram-1' },
      created: Date.parse('2026-10-08T10:00:00.000Z'),
      updated: Date.parse('2026-10-08T11:00:00.000Z'),
      rev: '0000003',
      pinned: false,
    });
    expect(toWireCodexIndex(Array.from({ length: 1001 }, () => entry)).truncated).toBe(true);

    const wirePage = toWireCodexPage(page, [
      {
        commit: 'ABCDEF0123456789abcdef0123456789abcdef01',
        authorName: 'Jasper (player)',
        authorEmail: 'player@minevibe.invalid',
        at: '2026-10-08T11:00:00+02:00',
        message: 'update iron-cave: Iron cave',
      },
      {
        commit: 'abcdef0',
        authorName: 'Bram (agent)',
        authorEmail: 'bram-1@agents.minevibe.invalid',
        at: '2026-10-08T10:00:00Z',
        message: '',
      },
      { commit: 'not-a-hash', authorName: 'x', authorEmail: 'x', at: '', message: 'x' },
    ]);
    expect(CodexGetResult.safeParse({ page: wirePage }).success).toBe(true);
    expect(wirePage.links).toEqual(['smelting']);
    expect(wirePage.history).toEqual([
      {
        rev: 'abcdef0123456789abcdef0123456789abcdef01',
        at: Date.parse('2026-10-08T09:00:00Z'),
        author: { kind: 'player', name: 'Jasper' },
        summary: 'update iron-cave: Iron cave',
      },
      {
        rev: 'abcdef0',
        at: Date.parse('2026-10-08T10:00:00Z'),
        author: { kind: 'agent', name: 'Bram', agentId: 'bram-1' },
        summary: 'update',
      },
    ]);
    expect(
      toWireHistoryEntry({
        commit: 'abcdef0',
        authorName: 'MineVibe (system)',
        authorEmail: 'system@minevibe.invalid',
        at: 'x',
        message: 'roll-up',
      })?.author,
    ).toEqual({ kind: 'system', name: 'MineVibe' });

    const hits = [
      toWireCodexHit({
        id: 'iron-cave',
        title: 'Iron cave',
        category: 'places',
        scope: 'world',
        tags: [],
        score: 4.2,
        snippet: 'x'.repeat(500),
        highlights: [],
        authorName: 'Bram',
        authorKind: 'agent',
      }),
    ];
    expect(CodexSearchResult.safeParse({ hits }).success).toBe(true);
    expect(hits[0]?.snippet).toHaveLength(400);
  });

  it('maps every Codex refusal onto a protocol code', () => {
    expect(codexErrorCode('REV_CONFLICT')).toBe('CODEX_CONFLICT');
    expect(codexErrorCode('LOCKED')).toBe('CODEX_CONFLICT');
    expect(codexErrorCode('SIMILAR_EXISTS')).toBe('CODEX_SIMILAR');
    expect(codexErrorCode('PAGE_FULL')).toBe('CODEX_TOO_LARGE');
    expect(codexErrorCode('BUDGET_EXCEEDED')).toBe('CODEX_BUDGET');
    expect(codexErrorCode('SECRET')).toBe('CODEX_SECRET');
    expect(codexErrorCode('NOT_FOUND')).toBe('CODEX_NOT_FOUND');
    expect(codexErrorCode('FORBIDDEN')).toBe('FORBIDDEN');
    expect(codexErrorCode('COORDS_IN_LASTING')).toBe('CODEX_INVALID');
  });
});

describe('wire adapters: calendar', () => {
  it('statuses, recurrence and occurrences validate against the protocol', () => {
    const events = [
      event(),
      event({ id: 'ev-2', status: 'awaiting_approval', recurrence: { kind: 'daily' } }),
      event({ id: 'ev-3', status: 'completed', nextAt: null }),
      event({ id: 'ev-4', status: 'declined', nextAt: null }),
      event({ id: 'ev-5', status: 'cancelled', nextAt: null }),
      event({ id: 'ev-6', status: 'paused', orphaned: true, orphanKept: true }),
      event({
        id: 'ev-7',
        clock: 'real',
        tz: 'Europe/Brussels',
        start: 1_791_513_600_000,
        nextAt: 1_791_600_000_000,
        recurrence: { kind: 'weekdays' },
        orphaned: true,
        task: '',
        location: undefined,
      }),
      // every_n_days with n = 1 is daily on the wire (n must be >= 2).
      event({ id: 'ev-8', recurrence: { kind: 'every_n_days', n: 1 } }),
      event({ id: 'ev-9', recurrence: { kind: 'every_n_days', n: 3 }, assignees: 'all' }),
    ];
    const state = valid('calendar.state', toWireCalendarState(events, 'Europe/Brussels'));
    expect(state.events.map((e) => e.status)).toEqual([
      'active',
      'pending_approval',
      'done',
      'cancelled',
      'cancelled',
      'paused',
      'orphaned',
      'active',
      'active',
    ]);
    expect(state.events[6]).toMatchObject({ tz: 'Europe/Brussels', clock: 'real' });
    expect(state.events[6]).not.toHaveProperty('task');
    expect(state.events[6]).not.toHaveProperty('location');
    expect(state.events[0]).not.toHaveProperty('tz');
    expect(state.events[7]?.recurrence).toEqual({ kind: 'daily' });
    expect(state.events[8]?.recurrence).toEqual({ kind: 'every_n_days', n: 3 });
    for (const e of state.events) expect(CalendarEventSchema.safeParse(e).success).toBe(true);
  });

  it('occurrences: one entry per assignee when outcomes differ, the newest 20 kept', () => {
    const ring: Occurrence[] = [
      { at: 1000, status: 'done' as const, note: 'harvested 40', assignees: { 'bram-1': 'done' as const } },
      {
        at: 2000,
        status: 'fired' as const,
        assignees: { 'bram-1': 'done' as const, 'cleo-1': 'fired' as const },
        note: 'x\ny',
      },
      {
        at: 3000,
        status: 'missed' as const,
        assignees: { 'bram-1': 'missed' as const, 'cleo-1': 'missed' as const },
      },
      { at: 4000, status: 'cancelled' as const, note: '' },
    ];
    expect(toWireOccurrences(ring)).toEqual([
      { at: 1000, status: 'done', note: 'harvested 40', agentId: 'bram-1' },
      { at: 2000, status: 'done', note: 'x y', agentId: 'bram-1' },
      { at: 2000, status: 'fired', agentId: 'cleo-1' },
      { at: 3000, status: 'missed' },
      { at: 4000, status: 'cancelled' },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({ at: i, status: 'done' as const }));
    const wire = toWireOccurrences(many);
    expect(wire).toHaveLength(20);
    expect(wire[0]?.at).toBe(10);
  });

  it('reads calendar.put fields, and leaves an unchanged schedule out of an edit', () => {
    const fields = {
      title: 'Standup',
      kind: 'meeting' as const,
      assignees: 'all' as const,
      clock: 'real' as const,
      at: 1_791_513_600_000,
      tz: 'Europe/Brussels',
      recurrence: { kind: 'every_n_days' as const, n: 2 },
      durationMin: 10,
      location: 'meeting_table',
      catchUp: 'once_late' as const,
      runWhileAway: false,
    };
    expect(fromWireEventFields(fields)).toMatchObject({
      when: 1_791_513_600_000,
      recurrence: { kind: 'every_n_days', n: 2 },
      tz: 'Europe/Brussels',
    });
    const existing = event({
      clock: 'real',
      tz: 'Europe/Brussels',
      start: 1_791_513_600_000,
      recurrence: { kind: 'every_n_days', n: 2 },
    });
    const same = fromWireEventPatch({ ...fields, title: 'Daily standup' }, existing);
    expect(same).toMatchObject({ title: 'Daily standup' });
    expect(same).not.toHaveProperty('when');
    expect(same).not.toHaveProperty('recurrence');
    const moved = fromWireEventPatch({ ...fields, at: 1_791_600_000_000 }, existing);
    expect(moved).toMatchObject({ when: 1_791_600_000_000, clock: 'real', tz: 'Europe/Brussels' });
  });

  it('calendar.fired carries the resolved assignees, the target and who walks', () => {
    const fired = valid(
      'calendar.fired',
      toWireCalendarFired(
        event(),
        48_000,
        ['bram-1', 'cleo-1', 'bad id'],
        { pos: { x: 30, y: 64, z: -20 }, dim: 'minecraft:overworld' },
        ['cleo-1', 'ghost'],
      ),
    );
    expect(fired).toEqual({
      eventId: 'ev-1',
      occurrence: 48_000,
      kind: 'task',
      title: 'Farm wheat',
      assignees: ['bram-1', 'cleo-1'],
      target: { pos: { x: 30, y: 64, z: -20 }, dim: 'minecraft:overworld' },
      walk: ['cleo-1'],
    });
  });

  it('maps calendar refusals onto protocol codes', () => {
    expect(calendarErrorCode('RATE_LIMITED')).toBe('CALENDAR_LIMIT');
    expect(calendarErrorCode('IN_PAST')).toBe('CALENDAR_INVALID');
    expect(calendarErrorCode('NO_CLOCK')).toBe('NOT_READY');
    expect(calendarErrorCode('NO_OPEN_OCCURRENCE')).toBe('CALENDAR_NOT_FOUND');
    expect(calendarErrorCode('FORBIDDEN')).toBe('FORBIDDEN');
  });
});

describe('wire adapters: meetings', () => {
  it('meeting.state: attendee statuses, the planned chair, endsBy and quick', () => {
    const wire = valid('meeting.state', toWireMeetingState(meeting()));
    expect(wire.chair).toBe('ada-1');
    expect(wire.endsBy).toBe(1_791_514_200_000);
    expect(wire.quick).toBe(false);
    expect(wire.eventId).toBeNull();
    expect(wire.attendees.map((a) => `${a.agentId}:${a.status}:${a.etaS}`)).toEqual([
      'ada-1:coming:12',
      'bram-1:seated:null',
      'cleo-1:dialed_in:null',
      'dan-1:dead:null',
      'eve-1:absent:null',
      'fay-1:excused:null',
      'gus-1:dead:null',
      'hal-1:left:null',
    ]);
    for (const phase of ['open', 'updates', 'floor', 'wrapup', 'done'] as const) {
      const s = valid(
        'meeting.state',
        toWireMeetingState(
          meeting({ phase, chair: 'player', speaker: 'bram-1', format: 'short', eventId: 'ev-3' }),
        ),
      );
      expect(s).toMatchObject({ phase, chair: 'player', speaker: 'bram-1', quick: true, eventId: 'ev-3' });
    }
  });
});
