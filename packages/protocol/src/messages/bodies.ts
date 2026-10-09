import { z } from 'zod';
import {
  AgentId,
  AgentRole,
  BarkKey,
  BlockPos,
  CrewMember,
  Dimension,
  DisplayName,
  Fraction,
  Handle,
  IdleMode,
  ItemId,
  JobId,
  JsonObject,
  NonNegInt,
  Place,
  PlayerName,
  PosInt,
  Vec3,
  WorldId,
} from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';
import { SeatTarget } from './seats.js';
import { SkillName } from './skills.js';

// ---------------------------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------------------------

/** One agent body in `agent.state`. */
export const AgentBody = z.object({
  agentId: AgentId,
  pos: Vec3,
  dim: Dimension,
  hp: z.number().min(0).max(1024),
  maxHp: z.number().min(0).max(1024),
  food: z.number().int().min(0).max(20),
  saturation: z.number().min(0).max(20),
  mode: IdleMode,
  /** Edible food in the inventory. */
  hasFood: z.boolean(),
  /** A hostile within 12 blocks, or damage in the last 8 s. */
  inCombat: z.boolean(),
  /** The reflex in control when it preempts the job ("eat", "flee", "approach", ...). */
  reflex: z.string().min(1).max(32).optional(),
  /** The running job. */
  job: z.object({ jobId: JobId, skill: SkillName, progress: Fraction.optional() }).optional(),
  /** The seat the body sits on. */
  seat: SeatTarget.optional(),
  /** Distance to the local player in blocks, when in the same dimension. */
  playerDistance: z.number().min(0).optional(),
  /** Main-hand item. */
  held: ItemId.optional(),
  /** W1: where the body is relative to the nearest protected zone (`in Base`, `12m from Base`), as in the footer. */
  zone: z.string().min(1).max(64).optional(),
});
export type AgentBody = z.infer<typeof AgentBody>;

/** `agent.event` kinds. Node maps them to Digest lines and wakes (PLAN §6.5 "Layer 3"). */
export const AGENT_EVENT_KINDS = [
  /** Took damage. data: {amount, source}. */
  'hurt',
  /** HP critical and the heal reflex failed (P2). */
  'hp_critical',
  /** Food ≤ 6 and no food (P2). */
  'starving',
  'ate',
  /** Killed a mob. data: {entity}. */
  'killed',
  /** A reflex preempted the job. data: {reflex, priority}. */
  'reflex',
  /**
   * Navigation is stuck. Urgency 1: one Tier-1 walk gave up after jump, replan and the poof unstuck. Urgency 2 (a wake,
   * and Node says `data.bark`): a walk that keeps failing from the same spot (`data.why: "nav"`), or water the agent
   * cannot get out of (`data.why: "water"`, the WaterEscape reflex). data: {why, reason, pos, bark}.
   */
  'stuck',
  /** Left a seat. data: {reason}. */
  'unseated',
  /** Kicked off a PC by the player. data: {pcId}. */
  'kicked',
  /** The player's HP is below 30 % (Node wakes the Guard and the nearest wandering agent). */
  'player_low_hp',
  /** Changed dimension. data: {from, to}. */
  'dimension_changed',
  /** Reached an approach spot, a meeting chair or a task location. data: {target}. */
  'arrived',
  /** Could not walk to the player; ApproachQueue falls back to a ping. data: {why: combat|night|far|dimension|pc_screen}. */
  'approach_blocked',
  'fed_player',
  'shared_food',
  /** data: {item, count}. */
  'picked_up',
  /** data: {id}. */
  'advancement',
] as const;
export const AgentEventKind = z.enum(AGENT_EVENT_KINDS);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

/** Where a new body appears: the office door when absent. */
export const SpawnAt = Place;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * N→M request. Spawn an agent body, or restore it from its saved playerdata (`restore`: app restart, world
 * reload; a missing save spawns fresh). Reply: {@link AgentSpawnResult}. Errors: `NO_SERVER`, `NOT_READY`.
 */
export const AgentSpawn = defineMessage('agent.spawn', {
  agentId: AgentId,
  handle: Handle,
  name: DisplayName,
  role: AgentRole,
  ceo: z.boolean(),
  /** Skin key from the mod's role-skin table; absent = the role's skin. */
  skin: z.string().min(1).max(64).optional(),
  /**
   * Where the body appears, and its home (Shelter at dusk). Node passes the office `door` slot; absent = next to the
   * player (or world spawn). Ignored when a save is restored.
   */
  at: SpawnAt.optional(),
  restore: z.boolean(),
  mode: IdleMode,
  /** Bark on arrival ("reporting_for_duty"). */
  bark: BarkKey.optional(),
}).describe('Spawns or restores an agent body.');

export const AgentSpawnResult = z.object({
  pos: Vec3,
  dim: Dimension,
  /** True when saved playerdata was loaded. */
  restored: z.boolean(),
});
export type AgentSpawnResult = z.infer<typeof AgentSpawnResult>;

/** N→M request. Remove a body without killing it (dismissal, world end, shutdown). */
export const AgentDespawn = defineMessage('agent.despawn', {
  agentId: AgentId,
  reason: z.enum(['dismissed', 'world_end', 'shutdown']),
  /** Wave and walk off first (dismissal). */
  farewell: z.boolean(),
}).describe('Removes an agent body.');

/** M→N, 1 Hz. Every living agent body. */
export const AgentState = defineMessage('agent.state', {
  /** Integrated-server tick of the snapshot. */
  tick: NonNegInt,
  agents: z.array(AgentBody).max(64),
}).describe('1 Hz snapshot of every agent body.');

/** M→N. A notable body event. Node turns it into a Digest line or a wake (by kind and urgency). */
export const AgentEvent = defineMessage('agent.event', {
  agentId: AgentId,
  kind: AgentEventKind,
  /** 0 info, 1 notable, 2 critical (P2 wake), 3 emergency. */
  urgency: z.number().int().min(0).max(3),
  /** One line for the Digest ("Fled from a creeper"). */
  text: z.string().min(1).max(256),
  data: JsonObject.optional(),
}).describe('A notable event of an agent body.');

/**
 * M→N request. An agent died. Its inventory is in a grave and its memory in a diary. The mod re-sends it until
 * Node replies `ok` (idempotent per `agentId`).
 */
export const AgentDied = defineMessage('agent.died', {
  agentId: AgentId,
  worldId: WorldId,
  /** Vanilla death message. */
  cause: z.string().min(1).max(256),
  killer: z.string().min(1).max(128).optional(),
  day: PosInt,
  pos: BlockPos,
  dim: Dimension,
  /** Where the grave block was placed, if one could be. */
  grave: BlockPos.optional(),
}).describe('An agent died (request; re-sent until acked).');

/** N→M request. Set an agent's idle mode (`mc__set_mode`, AgentScreen Follow/Stay). */
export const AgentMode = defineMessage('agent.mode', {
  agentId: AgentId,
  mode: IdleMode,
  /** Anchor for `stay` / `guard`; absent = where the agent stands. */
  anchor: BlockPos.optional(),
}).describe("Sets an agent's idle mode.");

/**
 * M→N request (PLAN §7.5 "Agent Core"). The player used an Agent Core on two stacked copper blocks: wake a CEO there.
 * `pos` is the lower block (where the body will stand); the mod has already taken both blocks and the core aside,
 * and gives them back unless Node answers `ok`. Errors: `CEO_EXISTS` (the CEO hires the crew instead), `NOT_READY`
 * (no world open, or no brains), `NOT_HANDLED` (no agent runtime), `SPAWN_FAILED`.
 */
export const AgentAwaken = defineMessage('agent.awaken', {
  pos: BlockPos,
  dim: Dimension,
  /** The player who performed the ritual. */
  by: PlayerName,
}).describe('The awakening ritual: wake the first (or next) CEO at the copper stack.');

/** Result of a successful `agent.awaken`: the CEO who arrived. */
export const AgentAwakenResult = z.object({
  agentId: AgentId,
  name: DisplayName,
});
export type AgentAwakenResult = z.infer<typeof AgentAwakenResult>;

/** N→M. The crew of the current world (name tags, `@` Tab completion, CEO promotion). */
export const CrewState = defineMessage('crew.state', {
  crew: z.array(CrewMember).max(64),
}).describe('The crew list.');

export const bodyMessages = {
  'agent.spawn': {
    schema: AgentSpawn,
    direction: 'node_to_mod',
    group: 'bodies',
    summary: 'Request: spawn an agent body, or restore it from its playerdata.',
    reply: AgentSpawnResult,
  },
  'agent.despawn': {
    schema: AgentDespawn,
    direction: 'node_to_mod',
    group: 'bodies',
    summary: 'Request: remove an agent body (dismissed, world end, shutdown).',
  },
  'agent.state': {
    schema: AgentState,
    direction: 'mod_to_node',
    group: 'bodies',
    summary: '1 Hz snapshot of every agent body (position, vitals, job, seat).',
  },
  'agent.event': {
    schema: AgentEvent,
    direction: 'mod_to_node',
    group: 'bodies',
    summary: 'A notable body event (hurt, starving, stuck, kicked, arrived, ...).',
  },
  'agent.died': {
    schema: AgentDied,
    direction: 'mod_to_node',
    group: 'bodies',
    summary: 'Request: an agent died (grave placed); re-sent until acked.',
  },
  'agent.mode': {
    schema: AgentMode,
    direction: 'node_to_mod',
    group: 'bodies',
    summary: "Request: set an agent's idle mode (follow, stay, guard, wander).",
  },
  'agent.awaken': {
    schema: AgentAwaken,
    direction: 'mod_to_node',
    group: 'bodies',
    summary: 'Request: the awakening ritual (Agent Core on two copper blocks); wake a CEO there.',
    reply: AgentAwakenResult,
  },
  'crew.state': {
    schema: CrewState,
    direction: 'node_to_mod',
    group: 'bodies',
    summary: 'The crew list (names, handles, roles, CEO, status).',
  },
} as const satisfies Record<string, CatalogEntry>;
