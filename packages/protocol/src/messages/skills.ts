import { z } from 'zod';
import { ErrorCode } from '../envelope.js';
import { AgentId, BlockPos, EntityRef, Fraction, ItemId, JobId, JsonObject, NonNegInt } from './common.js';
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

/**
 * W1: ask to change protected blocks (player-built, the Base). It counts only when Node also passes the player's
 * `consent` on the `skill.run` (outside `args`), which Node attaches only after the player explicitly agreed; on its
 * own the mod refuses with `PROTECTED` as usual. A model can therefore never authorize itself.
 */
const AllowProtected = z
  .boolean()
  .optional()
  .describe(
    'Only after the player explicitly agreed to let you change their blocks (MineVibe passes their consent). Never set it on your own: it does nothing without that consent.',
  );

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
  /**
   * Natural sources only (W1): a `#tag` leaves out building variants (stripped logs, wood, planks), logs come from
   * whole natural trees, protected blocks are never touched. `NO_NATURAL_SOURCE` / `PROTECTED` otherwise.
   */
  mine: z.object({
    /** Block id or `#tag`. */
    block: ItemId,
    count: Count,
    near: BlockPos.optional(),
    /** Blocks around `near` or the body; default 32 (as `find`). */
    radius: Radius.optional(),
    allow_protected: AllowProtected,
  }),
  /**
   * Get `count` more of an item. `replant` plants a sapling of the same kind on each stump of a felled tree (when one
   * is carried). `near` searches around a spot instead of the body; `make_tools` crafts a missing tool from the
   * inventory instead of failing `NEEDS_TOOL` (both need the mod cap `collect.gather`).
   */
  collect: z.object({
    item: ItemId,
    count: Count,
    /** Blocks around `near` or the body; default 32 (as `find`). */
    radius: Radius.optional(),
    replant: z.boolean().optional(),
    allow_protected: AllowProtected,
    near: BlockPos.optional(),
    make_tools: z.boolean().optional(),
  }),
  hunt: z.object({ entity: EntityRef, count: z.number().int().min(1).max(64), radius: Radius.optional() }),
  dig: z.object({ from: BlockPos, to: BlockPos, allow_protected: AllowProtected }),
  place: z.object({ block: ItemId, pos: BlockPos, allow_protected: AllowProtected }),
  /** A right-click that takes from or retunes a protected block (a pot, a lectern) can be allowed (W1). */
  use_block: z.object({ pos: BlockPos, allow_protected: AllowProtected }),
  use_item: z.object({
    item: ItemId.optional(),
    pos: BlockPos.optional(),
    entity: EntityRef.optional(),
    allow_protected: AllowProtected,
  }),
  attack: z.object({ entity: EntityRef, allow_protected: AllowProtected }),
  equip: z.object({ item: ItemId, slot: EquipSlot.optional() }),
  eat: z.object({ item: ItemId.optional() }),
  sleep: z.object({ pos: BlockPos.optional() }),
  pickup: z.object({ item: ItemId.optional(), radius: z.number().int().min(1).max(32).optional() }),
  drop: z.object({ item: ItemId, count: Count.optional() }),
  /** Without `count`: everything of the item (mod cap `give.all`). */
  give: z.object({ item: ItemId, count: Count.optional(), to: EntityRef }),
  /**
   * `tree`: resolve the whole recipe tree (intermediates, smelting, a station placed when needed); `gather_missing`:
   * also gather missing raw materials from nature (mod cap `craft.tree`). Its gathering can be refused `PROTECTED`
   * like `collect`, so it takes the same `allow_protected` (W1).
   */
  craft: z.object({
    item: ItemId,
    count: Count,
    table: BlockPos.optional(),
    tree: z.boolean().optional(),
    gather_missing: z.boolean().optional(),
    allow_protected: AllowProtected,
  }),
  smelt: z.object({ item: ItemId, count: Count, fuel: ItemId.optional(), furnace: BlockPos.optional() }),
  /** Without `pos`: the nearest chest or barrel within 24 blocks (mod cap `container.nearest`). */
  container: z
    .object({
      pos: BlockPos.optional(),
      action: z.enum(['list', 'put', 'take']),
      item: ItemId.optional(),
      count: Count.optional(),
      allow_protected: AllowProtected,
    })
    .refine((a) => a.action === 'list' || a.item !== undefined, 'put and take need item'),
  open_menu: z
    .object({ pos: BlockPos.optional(), entity: EntityRef.optional() })
    .refine(exactlyOne(['pos', 'entity']), 'exactly one of pos, entity'),
  /** A click that takes from the player's chest can be allowed (W1). */
  menu_click: z.object({
    slot: z.number().int().min(-999).max(255),
    button: z.number().int().min(0).max(40),
    type: z.enum(['pickup', 'quick_move', 'swap', 'clone', 'throw', 'quick_craft', 'pickup_all']),
    allow_protected: AllowProtected,
  }),
  menu_close: z.object({}),
  build: z.object({
    /** Blueprint id (built-in) or a Codex page id holding one. */
    blueprint: z.string().min(1).max(80),
    origin: BlockPos,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    allow_protected: AllowProtected,
  }),
  farm: z.object({ from: BlockPos, to: BlockPos, crop: ItemId.optional(), allow_protected: AllowProtected }),
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
    /** W1 consent for the whole sequence: its steps may change the protected blocks the token covers. */
    allow_protected: AllowProtected,
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
 * W1: the skills whose `args` take `allow_protected`, i.e. whose `PROTECTED` refusal the player can allow (Node then
 * passes the mod's token as `skill.run.consent`): every skill that changes or takes from protected blocks, the
 * right-click (`use_block`) and menu click (`menu_click`) included, plus `craft` (its tree's gathering) and
 * `sequence` (its steps).
 */
export const CONSENT_SKILLS: readonly SkillName[] = SKILL_NAMES.filter((skill) => {
  const schema = SkillArgs[skill] as unknown as { shape?: Record<string, unknown> };
  return schema.shape !== undefined && Object.hasOwn(schema.shape, 'allow_protected');
});

/**
 * Job failure codes of the world guard (§7.4.3). `PROTECTED`: the job would break or replace a block of the Base or
 * one a player placed, and no consent covers it. `NO_NATURAL_SOURCE`: nothing natural of the requested kind is in
 * reach (only protected blocks of it, or none it can path to).
 */
export const WORLD_GUARD_CODES = {
  PROTECTED: 'PROTECTED',
  NO_NATURAL_SOURCE: 'NO_NATURAL_SOURCE',
} as const;

/** A job or skill failure: a stable `code` (`UNREACHABLE`, `NO_ITEM`, `INTERRUPTED`, ...) and a message. */
export const SkillError = z.object({ code: ErrorCode, msg: z.string().max(2000) });
export type SkillError = z.infer<typeof SkillError>;

// ---------------------------------------------------------------------------------------------
// W1: world awareness and protection. Additive: these live inside the free-form `result` objects of
// `skill.run` replies / `skill.result` (failures) and of `obs.query` (look_around), plus `skill.run.consent`.
// ---------------------------------------------------------------------------------------------

/** A consent token the mod minted with a `PROTECTED` failure: 32 lowercase hex characters. */
export const ConsentToken = z.string().regex(/^[0-9a-f]{32}$/, 'consent token: 32 lowercase hex');

/** `skill.run.consent`: the player's consent for this job (see {@link SkillRun}). */
export const SkillConsent = z.object({ token: ConsentToken });
export type SkillConsent = z.infer<typeof SkillConsent>;

/** Compass words of perception: north is -Z, east +X. */
export const CompassDir = z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'here', 'above', 'below']);

/**
 * `result.protected` of a job that failed with `PROTECTED`: the nearest protected block it would have changed, whose
 * it is, how many it met, the consent offer for them, and the teaching line for the agent.
 */
export const ProtectedDetail = z.object({
  pos: BlockPos,
  what: z.enum(['player-built', 'base']),
  /** The player's name. */
  owner: z.string().min(1).max(48),
  /** Block (or decoration entity) id. */
  block: z.string().min(1).max(128),
  /** The protected zone it lies in (`Base`). */
  zone: z.string().min(1).max(48).optional(),
  /** Protected blocks this action would change (the consent covers their bounding box). */
  count: z.number().int().min(1).max(1_000_000),
  /** Node keeps it; after the player explicitly agrees it may pass it back as `skill.run.consent.token`. */
  consentId: ConsentToken.optional(),
  hint: z.string().min(1).max(400),
});
export type ProtectedDetail = z.infer<typeof ProtectedDetail>;

/** A source a job saw but could not use. */
export const SourceCandidate = z.object({
  pos: BlockPos,
  /** `oak tree`, `iron_ore`, ... */
  block: z.string().min(1).max(128),
  distance: z.number().int().min(0).max(100_000),
  dir: CompassDir,
  why: z.enum(['unreachable', 'too_far', 'protected', 'not_natural']),
  owner: z.string().min(1).max(48).optional(),
});
export type SourceCandidate = z.infer<typeof SourceCandidate>;

/** `result.noNaturalSource` of a job that failed with `NO_NATURAL_SOURCE` (it never substitutes another block). */
export const NoNaturalSourceDetail = z.object({
  what: z.string().min(1).max(160),
  radius: z.number().int().min(1).max(64),
  candidates: z.array(SourceCandidate).max(8),
  hint: z.string().min(1).max(400),
});
export type NoNaturalSourceDetail = z.infer<typeof NoNaturalSourceDetail>;

/** `obs.query look_around` args: `detail` brief (default, scene ≤ 900 chars) or full (≤ 2500). */
export const LookAroundArgs = z.object({
  radius: z.number().int().min(1).max(32).optional(),
  detail: z.enum(['brief', 'full']).optional(),
});

/** `obs.query find` args: `filter` natural, built or any (default). */
export const FindArgs = z.object({
  what: z.string().min(1).max(128),
  radius: z.number().int().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(10).optional(),
  filter: z.enum(['natural', 'built', 'any']).optional(),
});

/** The `result` of `obs.query look_around` (plus the status `footer`). */
export const LookAroundResult = z.object({
  /** What the agent reads: position, zone, hazards, trees, buildings, people, resources, ground. */
  scene: z.string().min(1).max(2500),
  detail: z.enum(['brief', 'full']),
  zone: z
    .object({
      name: z.string().min(1).max(48),
      inside: z.boolean(),
      distance: z.number().int().min(0),
      owner: z.string().min(1).max(48),
    })
    .optional(),
  trees: z
    .array(
      z.object({
        species: z.string().min(1).max(64),
        trunk: BlockPos,
        distance: z.number().int().min(0).max(100_000),
        dir: CompassDir,
        reachable: z.enum(['reachable', 'unreachable', 'far']),
        logs: z.number().int().min(1).max(1000),
      }),
    )
    .max(8)
    .optional(),
  footer: z.string().optional(),
});
export type LookAroundResult = z.infer<typeof LookAroundResult>;

/** Job failure codes added by W1 (protocol.md §7.4.1). */
export const PROTECTED = 'PROTECTED';
export const NO_NATURAL_SOURCE = 'NO_NATURAL_SOURCE';

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
  /**
   * W1: the player's consent to change protected blocks, set only by Node after the player explicitly agreed, never
   * from a tool call's input. Counts only with `args.allow_protected`; a token the mod does not know (or offered to
   * another agent, or expired) is `err BAD_ARGS`.
   */
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
