import { z } from 'zod';
import { ErrorCode } from '../envelope.js';
import {
  AgentId,
  BlockPos,
  ConsentId,
  EntityRef,
  EpochMs,
  Fraction,
  ItemId,
  JobId,
  JsonObject,
  NonNegInt,
  ZoneKind,
} from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

// ---------------------------------------------------------------------------------------------
// Skill names and arguments (PLAN §7.4). Skills listed here run in the mod as jobs; the rest of the
// `mcp__mc__*` tools are Node-side (say, tell, remember, wait, request_hire, codex_*, calendar_*,
// report_task), go through `agent.mode` (set_mode), `skill.cancel` (stop), `agent.seat` / `agent.unseat`
// (sit_at_pc, stand_up) or `obs.query` (observations).
// ---------------------------------------------------------------------------------------------

export const SKILL_NAMES = [
  'goto',
  'mine',
  'collect',
  'hunt',
  'dig',
  'place',
  'use_block',
  'use_item',
  'attack',
  'equip',
  'eat',
  'sleep',
  'pickup',
  'drop',
  'give',
  'craft',
  'smelt',
  'container',
  'open_menu',
  'menu_click',
  'menu_close',
  'build',
  'farm',
  'ride',
  'dismount',
  'emote',
  'sequence',
] as const;
export const SkillName = z.enum(SKILL_NAMES);
export type SkillName = z.infer<typeof SkillName>;

/** Observation queries (`obs.query`), answered at once without a job. */
export const OBS_QUERIES = [
  'status',
  'look_around',
  'inventory',
  'find',
  'recipe',
  'recent_events',
  'crew',
  'list_pcs',
  'job_status',
  'menu_state',
] as const;
export const ObsQueryName = z.enum(OBS_QUERIES);
export type ObsQueryName = z.infer<typeof ObsQueryName>;

const Count = z.number().int().min(1).max(2304);
const Radius = z.number().int().min(1).max(64);
const EquipSlot = z.enum(['mainhand', 'offhand', 'head', 'chest', 'legs', 'feet']);

function exactlyOne(keys: readonly string[]) {
  return (value: object) =>
    keys.filter((k) => (value as Record<string, unknown>)[k] !== undefined).length === 1;
}

/** Skills that cannot be a step of a `sequence` (protocol §7.4: no nesting, emotes run beside jobs). */
export const SEQUENCE_EXCLUDED = ['sequence', 'emote'] as const;
/** A `sequence` holds 2-8 steps. */
export const SEQUENCE_MIN_STEPS = 2;
export const SEQUENCE_MAX_STEPS = 8;

/** The per-skill `args` of every skill but `sequence` (whose steps are validated against these). */
const BASE_SKILL_ARGS = {
  /** Walk to a block position or an entity (`player`, an agent id, a UUID). Places are resolved by Node. */
  goto: z
    .object({
      pos: BlockPos.optional(),
      entity: EntityRef.optional(),
      /** Stop within this many blocks (default 1.5). */
      range: z.number().min(0).max(64).optional(),
    })
    .refine(exactlyOne(['pos', 'entity']), 'exactly one of pos, entity'),
  mine: z.object({
    /** Block id or `#tag`. */
    block: ItemId,
    count: Count,
    near: BlockPos.optional(),
    radius: Radius.optional(),
  }),
  /**
   * Get `count` more of an item. `near` searches around a spot instead of the body; `make_tools` crafts a missing
   * tool from the inventory instead of failing `NEEDS_TOOL` (both need the mod cap `collect.gather`).
   */
  collect: z.object({
    item: ItemId,
    count: Count,
    radius: Radius.optional(),
    near: BlockPos.optional(),
    make_tools: z.boolean().optional(),
  }),
  hunt: z.object({ entity: EntityRef, count: z.number().int().min(1).max(64), radius: Radius.optional() }),
  dig: z.object({ from: BlockPos, to: BlockPos }),
  place: z.object({ block: ItemId, pos: BlockPos }),
  use_block: z.object({ pos: BlockPos }),
  use_item: z.object({ item: ItemId.optional(), pos: BlockPos.optional(), entity: EntityRef.optional() }),
  attack: z.object({ entity: EntityRef }),
  equip: z.object({ item: ItemId, slot: EquipSlot.optional() }),
  eat: z.object({ item: ItemId.optional() }),
  sleep: z.object({ pos: BlockPos.optional() }),
  pickup: z.object({ item: ItemId.optional(), radius: z.number().int().min(1).max(32).optional() }),
  drop: z.object({ item: ItemId, count: Count.optional() }),
  /** Without `count`: everything of the item (mod cap `give.all`). */
  give: z.object({ item: ItemId, count: Count.optional(), to: EntityRef }),
  /**
   * `tree`: resolve the whole recipe tree (intermediates, smelting, a station placed when needed); `gather_missing`:
   * also gather missing raw materials from nature (mod cap `craft.tree`).
   */
  craft: z.object({
    item: ItemId,
    count: Count,
    table: BlockPos.optional(),
    tree: z.boolean().optional(),
    gather_missing: z.boolean().optional(),
  }),
  smelt: z.object({ item: ItemId, count: Count, fuel: ItemId.optional(), furnace: BlockPos.optional() }),
  /** Without `pos`: the nearest chest or barrel within 24 blocks (mod cap `container.nearest`). */
  container: z
    .object({
      pos: BlockPos.optional(),
      action: z.enum(['list', 'put', 'take']),
      item: ItemId.optional(),
      count: Count.optional(),
    })
    .refine((a) => a.action === 'list' || a.item !== undefined, 'put and take need item'),
  open_menu: z
    .object({ pos: BlockPos.optional(), entity: EntityRef.optional() })
    .refine(exactlyOne(['pos', 'entity']), 'exactly one of pos, entity'),
  menu_click: z.object({
    slot: z.number().int().min(-999).max(255),
    button: z.number().int().min(0).max(40),
    type: z.enum(['pickup', 'quick_move', 'swap', 'clone', 'throw', 'quick_craft', 'pickup_all']),
  }),
  menu_close: z.object({}),
  build: z.object({
    /** Blueprint id (built-in) or a Codex page id holding one. */
    blueprint: z.string().min(1).max(80),
    origin: BlockPos,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  }),
  farm: z.object({ from: BlockPos, to: BlockPos, crop: ItemId.optional() }),
  ride: z.object({ entity: EntityRef }),
  dismount: z.object({}),
  emote: z.object({ kind: z.enum(['wave', 'nod', 'shake_head', 'point', 'cheer', 'facepalm']) }),
} as const satisfies Record<Exclude<SkillName, 'sequence'>, z.ZodType>;

/** A skill a `sequence` step may run. */
export const SequenceStepSkill = SkillName.exclude(SEQUENCE_EXCLUDED);
export type SequenceStepSkill = z.infer<typeof SequenceStepSkill>;

/**
 * `sequence{steps, stop_on_fail?}` (mod cap `skill.sequence`): 2-8 skills run in order as ONE job (one job id, one
 * `skill.result`). Every step's `args` is validated against that skill's schema, so a bad step fails the whole
 * request with `BAD_ARGS: steps.<i>.args...` before anything runs. `stop_on_fail` (default true) fails the sequence
 * at the first failed step; with false the remaining steps still run.
 */
export const SequenceArgs = z
  .object({
    steps: z
      .array(z.object({ skill: SequenceStepSkill, args: JsonObject }))
      .min(SEQUENCE_MIN_STEPS)
      .max(SEQUENCE_MAX_STEPS),
    stop_on_fail: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    value.steps.forEach((step, i) => {
      const schema: z.ZodType = BASE_SKILL_ARGS[step.skill];
      const parsed = schema.safeParse(step.args);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'args', ...issue.path],
            message: `${step.skill}: ${issue.message}`,
          });
        }
      }
    });
  });

/**
 * Per-skill `args` of `skill.run`. Node validates `args` with the skill's schema before sending (and T3 builds
 * the `mcp__mc__*` tool input schemas from them); the mod's skill handler reads them into its own records.
 * The wire schema of `skill.run` itself only requires `args` to be an object.
 */
export const SkillArgs = {
  ...BASE_SKILL_ARGS,
  sequence: SequenceArgs,
} as const satisfies Record<SkillName, z.ZodType>;

/** The validated `args` of skill `S`. */
export type SkillArgsOf<S extends SkillName> = z.infer<(typeof SkillArgs)[S]>;

/**
 * Job failure codes of the world guard (§7.4.3). `PROTECTED`: the job would break or replace a block of the Base or
 * one a player placed, and no consent covers it. `NO_NATURAL_SOURCE`: nothing natural of the requested kind is in
 * reach (only protected blocks of it, or none it can path to).
 */
export const WORLD_GUARD_CODES = {
  PROTECTED: 'PROTECTED',
  NO_NATURAL_SOURCE: 'NO_NATURAL_SOURCE',
} as const;

/**
 * The player's consent to change protected blocks (§7.4.3). Only Node mints it, after the player allowed it on a
 * question card or in a clear chat reply to that agent; the agent's tools can never carry one. It covers `positions`
 * (the blocks the refused job reported) or, when the refusal named none, the whole `zone`, for this agent only, until
 * `expiresAt`.
 */
export const SkillConsent = z
  .object({
    consentId: ConsentId,
    agentId: AgentId,
    positions: z.array(BlockPos).max(512).optional(),
    zone: ZoneKind.optional(),
    expiresAt: EpochMs,
  })
  .refine((c) => c.positions !== undefined || c.zone !== undefined, 'positions or zone');
export type SkillConsent = z.infer<typeof SkillConsent>;

/** A job or skill failure: a stable `code` (`UNREACHABLE`, `NO_ITEM`, `INTERRUPTED`, ...) and a message. */
export const SkillError = z.object({ code: ErrorCode, msg: z.string().max(2000) });
export type SkillError = z.infer<typeof SkillError>;

/** Final job statuses. */
export const JobOutcome = z.enum(['done', 'failed', 'cancelled']);
export type JobOutcome = z.infer<typeof JobOutcome>;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * N→M request. Start a job. The mod waits up to `waitMs` for it to finish and replies
 * {@link SkillRunResult}: `done` / `failed` / `cancelled` when it ended in time, otherwise `running` (the
 * outcome then arrives as `skill.result`). A higher-priority reflex may preempt a job; it resumes or fails.
 * Errors: `UNKNOWN_AGENT`, `UNKNOWN_SKILL`, `BAD_ARGS`, `BUSY` (the agent already runs a job and `replace`
 * is false).
 */
export const SkillRun = defineMessage('skill.run', {
  jobId: JobId,
  agentId: AgentId,
  skill: SkillName,
  /** Validated by Node against `SkillArgs[skill]`. */
  args: JsonObject,
  /** How long the reply may wait for the job to finish (`wait_s` × 1000; default 20 000). */
  waitMs: z.number().int().min(0).max(600_000),
  /** Cancel the agent's current job first (otherwise `err BUSY`). */
  replace: z.boolean(),
  /** The player's consent to change protected blocks (§7.4.3); absent = protected blocks stay untouched. */
  consent: SkillConsent.optional(),
}).describe('Starts a job (skill) for an agent.');

export const SkillRunResult = z.object({
  jobId: JobId,
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  /** Skill-specific result (items gathered, position reached, ...) when it ended. */
  result: JsonObject.optional(),
  error: SkillError.optional(),
  /**
   * The agent's job that `replace: true` cancelled to start this one (mod cap `run.replaced`): its id, skill and
   * last progress text. Absent when nothing was running.
   */
  replaced: z
    .object({ jobId: JobId, skill: z.string().min(1).max(32), text: z.string().max(256).optional() })
    .optional(),
});
export type SkillRunResult = z.infer<typeof SkillRunResult>;

/** M→N. Progress of a running job ("12/20 logs"). Throttled to at most one per job per second. */
export const SkillProgress = defineMessage('skill.progress', {
  jobId: JobId,
  agentId: AgentId,
  progress: Fraction.optional(),
  text: z.string().min(1).max(256),
}).describe('Progress of a running job.');

/** N→M request. Cancel one job, or every job of the agent when `jobId` is absent. Reply: {@link SkillCancelResult}. */
export const SkillCancel = defineMessage('skill.cancel', {
  agentId: AgentId,
  jobId: JobId.optional(),
  reason: z.string().min(1).max(128),
}).describe('Cancels a job.');

export const SkillCancelResult = z.object({
  /** Jobs that were running and are now cancelled (each also gets a `skill.result`). */
  cancelled: z.array(JobId).max(16),
});
export type SkillCancelResult = z.infer<typeof SkillCancelResult>;

/** M→N. A job that outlived its `skill.run` reply (status `running`) ended. */
export const SkillResult = defineMessage('skill.result', {
  jobId: JobId,
  agentId: AgentId,
  status: JobOutcome,
  result: JsonObject.optional(),
  error: SkillError.optional(),
  durationMs: NonNegInt,
}).describe('A job ended.');

/** N→M request. An observation; the reply is {@link ObsQueryResult}. Errors: `UNKNOWN_AGENT`, `BAD_ARGS`. */
export const ObsQuery = defineMessage('obs.query', {
  agentId: AgentId,
  query: ObsQueryName,
  /**
   * Query-specific (`find{what, radius?, limit?}`, `recipe{item, count?, tree?}`, `job_status{jobId}`, ...).
   * `recipe{tree:true}` (mod cap `obs.recipe.tree`) answers the whole craft plan for `count` items.
   */
  args: JsonObject,
}).describe('Runs an observation query for an agent.');

export const ObsQueryResult = z.object({
  result: JsonObject,
});
export type ObsQueryResult = z.infer<typeof ObsQueryResult>;

export const skillMessages = {
  'skill.run': {
    schema: SkillRun,
    direction: 'node_to_mod',
    group: 'skills',
    summary: 'Request: start a job; replies running, done, failed or cancelled.',
    reply: SkillRunResult,
  },
  'skill.progress': {
    schema: SkillProgress,
    direction: 'mod_to_node',
    group: 'skills',
    summary: 'Progress of a running job.',
  },
  'skill.cancel': {
    schema: SkillCancel,
    direction: 'node_to_mod',
    group: 'skills',
    summary: 'Request: cancel one job or all jobs of an agent.',
    reply: SkillCancelResult,
  },
  'skill.result': {
    schema: SkillResult,
    direction: 'mod_to_node',
    group: 'skills',
    summary: 'A running job ended (done, failed, cancelled).',
  },
  'obs.query': {
    schema: ObsQuery,
    direction: 'node_to_mod',
    group: 'skills',
    summary: 'Request: an observation (status, look_around, inventory, find, ...).',
    reply: ObsQueryResult,
  },
} as const satisfies Record<string, CatalogEntry>;
