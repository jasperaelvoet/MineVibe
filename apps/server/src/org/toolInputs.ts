/**
 * Inputs of the org agent tools (`mcp__mc__codex_*`, `calendar_*`, `report_task`; PLAN §6.6), validated with zod.
 *
 * The tools are defined for the model by the agent runtime's `mc` server (snake_case arguments such as `base_rev`,
 * `event_id`, `duration_min`, a `{kind, n}` recurrence, a wire revision token). {@link normalizeToolInput} maps those
 * spellings onto the camelCase ones used here, so the same schemas also take Node's own callers' input.
 */

import { z } from 'zod';
import { decodeRev } from './codex/rev.js';
import { CODEX_CATEGORIES } from './codex/types.js';

const Category = z.enum(CODEX_CATEGORIES);
const Tag = z.string().min(1).max(32);

export const CodexSearchInput = z.object({
  query: z.string().min(1).max(200),
  tags: z.array(Tag).max(8).optional(),
  category: Category.optional(),
});
export type CodexSearchInput = z.infer<typeof CodexSearchInput>;

export const CodexReadInput = z.object({ id: z.string().min(1).max(80) });
export type CodexReadInput = z.infer<typeof CodexReadInput>;

export const CodexWriteToolInput = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(16_384),
  /** At most 8 are kept. */
  tags: z.array(Tag).max(16).optional(),
  category: Category.optional(),
  scope: z.enum(['lasting', 'world']).optional(),
  id: z.string().max(80).optional(),
  /** The page revision `codex_read` showed; -1 (an unreadable token) never matches, so the write is a conflict. */
  base_rev: z.number().int().min(-1).optional(),
  mode: z.enum(['create', 'update', 'append']),
  here: z.boolean().optional(),
});
export type CodexWriteToolInput = z.infer<typeof CodexWriteToolInput>;

export const CodexListInput = z.object({ category: Category.optional(), tag: Tag.optional() });
export type CodexListInput = z.infer<typeof CodexListInput>;

const Recurrence = z.union([
  z.enum(['once', 'daily', 'weekdays']),
  z.object({ every_n_days: z.number().int().min(1).max(365) }),
  z.object({
    kind: z.enum(['once', 'daily', 'every_n_days', 'weekdays']),
    n: z.number().int().min(1).max(365).optional(),
  }),
]);

const Bound = z.union([z.string().max(40), z.number().min(0)]);

export const CalendarListInput = z.object({
  from: Bound.optional(),
  to: Bound.optional(),
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
  location: z.string().max(80).optional(),
  task: z.string().max(2000).optional(),
  catchUp: z.enum(['skip', 'once_late']).optional(),
  runWhileAway: z.boolean().optional(),
  tz: z.string().min(1).max(64).optional(),
});
export type CalendarAddToolInput = z.infer<typeof CalendarAddToolInput>;

export const CalendarUpdateToolInput = CalendarAddToolInput.partial().extend({
  id: z.string().min(1).max(64),
});
export type CalendarUpdateToolInput = z.infer<typeof CalendarUpdateToolInput>;

export const CalendarCancelInput = z.object({
  id: z.string().min(1).max(64),
  scope: z.enum(['next', 'all']).optional(),
});
export type CalendarCancelInput = z.infer<typeof CalendarCancelInput>;

export const ReportTaskInput = z.object({
  eventId: z.string().min(1).max(64),
  status: z.enum(['done', 'failed', 'blocked']),
  note: z.string().max(500).optional(),
});
export type ReportTaskInput = z.infer<typeof ReportTaskInput>;

/** snake_case argument → camelCase field. */
const ALIASES: Readonly<Record<string, string>> = {
  event_id: 'eventId',
  duration_min: 'durationMin',
  catch_up: 'catchUp',
  run_while_away: 'runWhileAway',
};

/**
 * Maps the `mc` server's argument spellings onto these schemas: snake_case aliases, and a `base_rev` wire token
 * (`"0000003"`) or digit string onto the revision number. Anything that is not a plain object is returned as is
 * (the schema then rejects it).
 */
export function normalizeToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const name = ALIASES[key] ?? key;
    if (name in out && key !== name) continue; // the camelCase spelling wins
    out[name] = value;
  }
  if (typeof out.base_rev === 'string') out.base_rev = decodeRev(out.base_rev);
  return out;
}
