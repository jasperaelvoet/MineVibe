/**
 * The org agent tools ({@link OrgAgentTools}) built on the structured {@link OrgApi} calls, for implementations that
 * have no text layer of their own ({@link FakeOrgApi}). The real org services (`apps/server/src/org`) format their
 * own agent text. Also the game-clock helpers both sides use.
 */

import {
  Assignees,
  CalendarClock,
  type CalendarEvent,
  CalendarKind,
  CodexCategory,
  type CodexHit,
  CodexScope,
  CodexTag,
  CodexWriteMode,
  type Place,
} from '@minevibe/protocol';
import { z } from 'zod';
import { authorLabel, singleLine, wrapNote } from '../agents/envelope.js';
import { type Actor, ApiError, isApiError } from './common.js';
import { mcRefs } from './mcRefs.js';
import type { CalendarEventInput, OrgAgentTools, OrgApi, OrgToolResult } from './OrgApi.js';

/** Day N hh:mm → overworld clock ticks (06:00 = tick 0 of the day; PLAN §6.6). */
export function gameTimeToTicks(day: number, hour: number, minute: number): number {
  const hourOfDay = (((hour - 6) % 24) + 24) % 24;
  return (day - 1) * 24_000 + hourOfDay * 1000 + Math.floor((minute * 1000) / 60);
}

/** Overworld ticks → "Day N hh:mm". */
export function ticksToGameTime(ticks: number): string {
  const day = Math.floor(ticks / 24_000) + 1;
  const inDay = ticks % 24_000;
  const hour = (Math.floor(inDay / 1000) + 6) % 24;
  const minute = Math.floor(((inDay % 1000) * 60) / 1000);
  return `Day ${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** `when` of calendar_add: "now", ticks/epoch ms, "Day 3 06:00" (game) or an ISO date (real). */
export function parseWhen(
  when: unknown,
  clock: 'game' | 'real',
  now: { ticks: number | null; ms: number },
): number {
  if (when === 'now' || when === undefined) {
    if (clock === 'game') {
      if (now.ticks === null) throw new ApiError('CALENDAR_INVALID', 'the world clock is not known yet');
      return now.ticks;
    }
    return now.ms;
  }
  if (typeof when === 'number' && Number.isFinite(when) && when >= 0) return Math.floor(when);
  if (typeof when === 'string') {
    const m = /^\s*day\s+(\d{1,5})\s+(\d{1,2}):(\d{2})\s*$/i.exec(when);
    if (m) {
      if (clock !== 'game')
        throw new ApiError('CALENDAR_INVALID', '"Day N hh:mm" is a game-clock time; use clock:"game"');
      const [day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (day < 1 || hour > 23 || minute > 59)
        throw new ApiError('CALENDAR_INVALID', `bad game time "${when}"`);
      return gameTimeToTicks(day, hour, minute);
    }
    const ms = Date.parse(when);
    if (!Number.isNaN(ms)) {
      if (clock !== 'real')
        throw new ApiError('CALENDAR_INVALID', 'a date is a real-clock time; use clock:"real"');
      return ms;
    }
  }
  throw new ApiError(
    'CALENDAR_INVALID',
    `cannot read when=${JSON.stringify(when)}: use "now", "Day 3 06:00" or an ISO date`,
  );
}

function formatHits(hits: readonly CodexHit[]): string {
  if (hits.length === 0) return 'No Codex pages match.';
  const body = hits.map((h) => `[${h.id}] ${h.title} (${h.category}, ${h.scope})\n${h.snippet}`).join('\n\n');
  return `${hits.length} page(s); read one with ${mcRefs().codexRead}{id}.\n${wrapNote({ author: 'the Codex', kind: 'codex', text: body })}`;
}

function formatEvent(e: CalendarEvent): string {
  const when = e.clock === 'game' ? ticksToGameTime(e.at) : new Date(e.at).toISOString();
  const next =
    e.nextAt === null
      ? 'nothing due'
      : e.clock === 'game'
        ? ticksToGameTime(e.nextAt)
        : new Date(e.nextAt).toISOString();
  const who = e.assignees === 'all' ? 'all' : e.assignees.join(',');
  const rec = e.recurrence.kind === 'every_n_days' ? `every ${e.recurrence.n} days` : e.recurrence.kind;
  return `[${e.id}] ${e.kind} "${e.title}" for ${who}, ${rec} from ${when}; next ${next}; ${e.status}; by ${e.createdBy}${e.task ? `\n  task: ${e.task}` : ''}`;
}

const Recurrence = z.object({
  kind: z.enum(['once', 'daily', 'every_n_days', 'weekdays']),
  n: z.number().int().min(2).max(365).optional(),
});

/** The `mc` tool argument schemas (as the model sends them). */
export const ORG_TOOL_INPUTS = {
  codexSearch: z.object({
    query: z.string().min(1).max(200),
    tags: z.array(CodexTag).max(8).optional(),
    category: CodexCategory.optional(),
  }),
  codexRead: z.object({ id: z.string().min(1).max(80) }),
  codexWrite: z.object({
    mode: CodexWriteMode,
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(8192),
    tags: z.array(CodexTag).max(16).optional(),
    category: CodexCategory.exclude(['rules']),
    scope: CodexScope,
    id: z.string().min(1).max(80).optional(),
    base_rev: z.string().min(7).max(64).optional(),
    here: z.boolean().optional(),
  }),
  codexList: z.object({ category: CodexCategory.optional(), tag: CodexTag.optional() }),
  calendarList: z.object({
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    agent: z.string().min(1).max(64).optional(),
  }),
  calendarAdd: z.object({
    title: z.string().min(1).max(80),
    kind: CalendarKind,
    assignees: Assignees,
    clock: CalendarClock,
    when: z.union([z.string().min(1).max(64), z.number().min(0)]),
    recurrence: Recurrence.optional(),
    duration_min: z.number().int().min(1).max(1440).optional(),
    location: z.string().min(1).max(80).optional(),
    task: z.string().min(1).max(2000).optional(),
    catch_up: z.enum(['skip', 'once_late']).optional(),
    run_while_away: z.boolean().optional(),
  }),
  calendarUpdate: z.object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(80).optional(),
    assignees: Assignees.optional(),
    when: z.union([z.string().min(1).max(64), z.number().min(0)]).optional(),
    clock: CalendarClock.optional(),
    recurrence: Recurrence.optional(),
    duration_min: z.number().int().min(1).max(1440).optional(),
    location: z.string().min(1).max(80).optional(),
    task: z.string().min(1).max(2000).optional(),
  }),
  calendarCancel: z.object({ id: z.string().min(1).max(64), scope: z.enum(['next', 'all']).optional() }),
  reportTask: z.object({
    event_id: z.string().min(1).max(64),
    status: z.enum(['done', 'failed', 'blocked']),
    note: z.string().min(1).max(500).optional(),
  }),
} as const;

/** What {@link structuredOrgTools} needs besides the structured calls. */
export interface StructuredToolsContext {
  /** The calling agent as an {@link Actor} (CEO rights). */
  actor(agentId: string): Actor;
  /** The agent's position (for `here`), or null when unknown. */
  here(agentId: string): Place | null;
  /** The overworld clock in ticks, or null when unknown. */
  clockTime(): number | null;
  now(): number;
  playerName(): string;
}

function ok(text: string): OrgToolResult {
  return { ok: true, text };
}

function refused(err: unknown): OrgToolResult {
  if (isApiError(err)) return { ok: false, code: err.code, text: `Error ${err.code}: ${err.message}` };
  return { ok: false, code: 'INTERNAL', text: `Error: ${err instanceof Error ? err.message : String(err)}` };
}

/** Builds the agent tools on the structured calls of `org`. */
export function structuredOrgTools(
  org: Pick<OrgApi, 'codex' | 'calendar'>,
  ctx: StructuredToolsContext,
): OrgAgentTools {
  const run = async <S extends z.ZodType>(
    schema: S,
    input: unknown,
    fn: (args: z.infer<S>) => Promise<OrgToolResult>,
  ): Promise<OrgToolResult> => {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      const why = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ');
      return { ok: false, code: 'INVALID', text: `Invalid input (${why}).` };
    }
    try {
      return await fn(parsed.data);
    } catch (err) {
      return refused(err);
    }
  };
  const I = ORG_TOOL_INPUTS;
  return {
    codexSearch: (agentId, input) =>
      run(I.codexSearch, input, async (args) =>
        ok(
          formatHits(
            await org.codex.search(ctx.actor(agentId), {
              query: args.query,
              tags: args.tags,
              category: args.category,
              limit: 8,
            }),
          ),
        ),
      ),
    codexRead: (agentId, input) =>
      run(I.codexRead, input, async (args) => {
        const page = await org.codex.read(ctx.actor(agentId), args.id);
        const head = `Page ${page.id} rev ${page.rev} (${page.category}, ${page.scope}${page.pinned ? ', pinned' : ''}).`;
        return ok(
          `${head}\n${wrapNote({
            author: authorLabel(page.author),
            kind: 'codex',
            attrs: { id: page.id, title: page.title, scope: page.scope, rev: page.rev },
            text: page.body,
          })}`,
        );
      }),
    codexWrite: (agentId, input) =>
      run(I.codexWrite, input, async (args) => {
        const here = args.here ? ctx.here(agentId) : null;
        if (args.here && !here)
          return { ok: false, text: 'Your position is not known yet; try again in a moment.' };
        try {
          const res = await org.codex.write(ctx.actor(agentId), {
            mode: args.mode,
            pageId: args.id,
            baseRev: args.base_rev,
            title: singleLine(args.title, 80),
            body: args.body,
            tags: args.tags ?? [],
            category: args.category,
            scope: args.scope,
            here: here ?? undefined,
          });
          return ok(`Saved page ${res.pageId} rev ${res.rev}.`);
        } catch (err) {
          if (isApiError(err, 'CODEX_CONFLICT') && typeof err.details?.body === 'string') {
            return {
              ok: false,
              code: err.code,
              text: `Error CODEX_CONFLICT: the page changed (now rev ${String(err.details.rev)}). Merge your change into the current text and update with that base_rev:\n${wrapNote({ author: 'the Codex', kind: 'codex', text: err.details.body })}`,
            };
          }
          throw err;
        }
      }),
    codexList: (agentId, input) =>
      run(I.codexList, input, async (args) => {
        const pages = await org.codex.list(ctx.actor(agentId), { category: args.category, tag: args.tag });
        if (pages.length === 0) return ok('No pages.');
        const body = pages
          .slice(0, 60)
          .map((p) => `[${p.id}] ${p.title} (${p.category}, ${p.scope}) by ${authorLabel(p.author)}`)
          .join('\n');
        return ok(wrapNote({ author: 'the Codex', kind: 'codex', text: body }));
      }),
    calendarList: (agentId, input) =>
      run(I.calendarList, input, async (args) => {
        const events = await org.calendar.list(ctx.actor(agentId), {
          from: args.from,
          to: args.to,
          agentId: args.agent,
        });
        if (events.length === 0) return ok('No events.');
        return ok(
          wrapNote({
            author: 'calendar',
            kind: 'calendar',
            text: events.slice(0, 40).map(formatEvent).join('\n'),
          }),
        );
      }),
    calendarAdd: (agentId, input) =>
      run(I.calendarAdd, input, async (args) => {
        const at = parseWhen(args.when, args.clock, { ticks: ctx.clockTime(), ms: ctx.now() });
        const event: CalendarEventInput = {
          title: singleLine(args.title, 80),
          kind: args.kind,
          assignees: args.assignees,
          clock: args.clock,
          at,
          recurrence: args.recurrence ?? { kind: 'once' },
          durationMin: args.duration_min ?? 30,
          catchUp: args.catch_up ?? 'skip',
          runWhileAway: args.run_while_away ?? false,
          ...(args.location !== undefined ? { location: args.location } : {}),
          ...(args.task !== undefined ? { task: args.task } : {}),
        };
        const res = await org.calendar.add(ctx.actor(agentId), event);
        return ok(
          res.needsApproval
            ? `Created ${res.eventId}; it waits for ${ctx.playerName()}'s approval.`
            : `Scheduled ${res.eventId}.`,
        );
      }),
    calendarUpdate: (agentId, input) =>
      run(I.calendarUpdate, input, async (args) => {
        const patch: Partial<CalendarEventInput> = {};
        if (args.title !== undefined) patch.title = singleLine(args.title, 80);
        if (args.assignees !== undefined) patch.assignees = args.assignees;
        if (args.recurrence !== undefined) patch.recurrence = args.recurrence;
        if (args.duration_min !== undefined) patch.durationMin = args.duration_min;
        if (args.location !== undefined) patch.location = args.location;
        if (args.task !== undefined) patch.task = args.task;
        if (args.clock !== undefined) patch.clock = args.clock;
        if (args.when !== undefined) {
          patch.at = parseWhen(args.when, args.clock ?? 'game', { ticks: ctx.clockTime(), ms: ctx.now() });
        }
        await org.calendar.update(ctx.actor(agentId), args.id, patch);
        return ok(`Updated ${args.id}.`);
      }),
    calendarCancel: (agentId, input) =>
      run(I.calendarCancel, input, async (args) => {
        await org.calendar.cancel(ctx.actor(agentId), args.id, args.scope ?? 'all');
        return ok(`Cancelled ${args.id}${args.scope === 'next' ? ' (next occurrence)' : ''}.`);
      }),
    reportTask: (agentId, input) =>
      run(I.reportTask, input, async (args) => {
        await org.calendar.report(ctx.actor(agentId), {
          eventId: args.event_id,
          status: args.status,
          note: args.note,
        });
        return ok(`Reported ${args.event_id} ${args.status}.`);
      }),
  };
}
