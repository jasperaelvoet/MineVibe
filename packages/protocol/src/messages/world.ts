import { z } from 'zod';
import { ProtocolVersion } from '../envelope.js';
import {
  AgentId,
  BlockPos,
  BrainsSummary,
  CrewMember,
  Dimension,
  NonNegInt,
  PcId,
  PlayerName,
  Vec3,
  WorldId,
} from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';
import { Budget, PcInfo } from './pc.js';
import { PendingCard } from './ui.js';

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** A mod feature flag in `hello.caps` (`skill.sequence`, `craft.tree`, ...): lowercase dotted words. */
export const ModCap = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/);

/**
 * The caps this protocol defines (protocol §6.1). The mod may list others (Node ignores unknown ones); Node checks
 * these before relying on the matching additive arguments, because Gson drops unknown fields silently.
 */
export const MOD_CAPS = {
  /** `skill.run{skill:"sequence"}`: several skills as one job. */
  SEQUENCE: 'skill.sequence',
  /** `collect{near?, make_tools?}`: gather end to end (loose drops, natural sources, animals for drops, tools). */
  COLLECT_GATHER: 'collect.gather',
  /** `craft{tree?, gather_missing?}`: resolve the whole recipe tree, stations and smelting included. */
  CRAFT_TREE: 'craft.tree',
  /** `obs.query recipe{item, count?, tree:true}`: the craft plan without acting. */
  RECIPE_TREE: 'obs.recipe.tree',
  /** `container{pos?}`: the nearest chest or barrel within 24 blocks when `pos` is absent. */
  CONTAINER_NEAREST: 'container.nearest',
  /** `give{count?}`: everything of the item when `count` is absent. */
  GIVE_ALL: 'give.all',
  /** `SkillRunResult.replaced`: the job a `replace:true` run cancelled. */
  RUN_REPLACED: 'run.replaced',
  /** `look_around{radius}` up to 48 (was 32). */
  LOOK_AROUND_48: 'obs.look_around.48',
} as const;
export type ModCapName = (typeof MOD_CAPS)[keyof typeof MOD_CAPS];

/** M→N. First message on every (re)connect. Node answers with `hello.ok` and then re-sends full state. */
export const Hello = defineMessage('hello', {
  /** Mod version. */
  mod: z.string().min(1).max(64),
  /** Minecraft version. */
  mc: z.string().min(1).max(32),
  /** `boot`: on BootScreen, no world loaded. `in_world`: a world is open (reconnect). */
  phase: z.enum(['boot', 'in_world']),
  /** The world currently open, when `phase` is `in_world`. */
  worldId: WorldId.optional(),
  /** The local player's profile name. */
  playerName: PlayerName.optional(),
  /**
   * Optional features this mod build supports (additive; protocol §6.1), e.g. `skill.sequence`, `craft.tree`. Node
   * uses a feature only when its cap is listed and falls back otherwise, so an older mod (no `caps`) keeps working.
   */
  caps: z.array(ModCap).max(64).optional(),
}).describe('Mod handshake; sent first on every connection.');

/**
 * N→M. Answer to `hello` (`re` = the hello's `id` when it had one) with a full state snapshot. Node then sends
 * the per-topic pushes (`crew.state`, `agent.brain`, `agent.pending`, `pc.state`, `budget.state`,
 * `codex.index`, `calendar.state`, `meeting.state`, `brains.state`) as it does on every change.
 */
export const HelloOk = defineMessage('hello.ok', {
  server: z.object({
    version: z.string().min(1).max(64),
    protocol: ProtocolVersion,
  }),
  /** The world the mod should be in, or null while Node has not decided yet. */
  world: z
    .object({
      id: WorldId,
      gen: z.number().int().min(1),
      fresh: z.boolean(),
    })
    .nullable(),
  player: z.object({ name: PlayerName }),
  /** User settings relevant to the mod (free-form; keys documented in protocol.md). */
  settings: z.record(z.string(), z.unknown()),
  pcs: z.array(PcInfo).max(64),
  /** Host budget; null until known. */
  budget: Budget.nullable(),
  crew: z.array(CrewMember),
  brains: BrainsSummary,
  /** Every pending card of every agent. */
  pending: z.array(PendingCard).max(256),
}).describe('Node handshake reply with a full state snapshot.');

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

/** The local player as Node needs it (ApproachQueue, meetings, calendar AFK, P2 wakes). */
export const PlayerState = z.object({
  pos: Vec3,
  dim: Dimension,
  hp: z.number().min(0).max(1024),
  maxHp: z.number().min(0).max(1024),
  food: z.number().int().min(0).max(20),
  /** A hostile within 12 blocks, or damage in the last 8 s. */
  inCombat: z.boolean(),
  /** Milliseconds since the last player input (AFK after 5 min). */
  idleMs: NonNegInt,
  /** Simple class name of the open screen ("PcControlScreen"), absent in game. */
  screen: z.string().min(1).max(64).optional(),
  /** The PC the player sits at. */
  seatedPc: PcId.optional(),
});
export type PlayerState = z.infer<typeof PlayerState>;

/**
 * What an office slot is (`world.state.office.slots[].kind`, the mod's OfficeLayout): `workstation` (a PC desk's
 * main column; `pcId` once a PC is bound to it), `meeting_table` (the primary table block), `codex` (its anchor),
 * `wall_calendar`, `chest`, `bed`, `door` (the porch cell in front of the door: agents spawned without `at` appear
 * here) and `spawn` (where the player first appears).
 */
export const OfficeSlotKind = z.enum([
  'workstation',
  'meeting_table',
  'codex',
  'wall_calendar',
  'chest',
  'bed',
  'door',
  'spawn',
]);
export type OfficeSlotKind = z.infer<typeof OfficeSlotKind>;

/** The starter office as OfficeBuilder placed it (protocol §6.4). */
export const OfficeLayout = z.object({
  /** Local 0,0,0: the north-west floor corner. */
  origin: BlockPos,
  slots: z.array(
    z.object({
      kind: OfficeSlotKind,
      pos: BlockPos,
      pcId: PcId.optional(),
    }),
  ),
});
export type OfficeLayout = z.infer<typeof OfficeLayout>;

/** N→M. Open (or create) this world. BootScreen calls openWorld, or createFreshLevel if missing. */
export const WorldOpen = defineMessage('world.open', {
  worldId: WorldId,
  /** World number shown to the player ("World #7"). */
  gen: z.number().int().min(1),
  /** True when Node allocated this world and expects it to be created. */
  fresh: z.boolean(),
  hardcore: z.literal(true),
  difficulty: z.literal('hard'),
  /** Optional level seed for createFreshLevel. */
  seed: z.string().max(64).optional(),
}).describe('Tells BootScreen which world to open or create.');

/** M→N. World lifecycle updates; also pushed at 1 Hz while ready (with `clockTime` and `player`). */
export const WorldState = defineMessage('world.state', {
  worldId: WorldId,
  phase: z.enum(['loading', 'ready', 'closing', 'closed']),
  fresh: z.boolean().optional(),
  spawn: BlockPos.optional(),
  /** The starter office; sent on a `ready` once the world has one (again after every reconnect). */
  office: OfficeLayout.optional(),
  /** Overworld clock time in ticks (`getOverworldClockTime()`). Day = floor(t/24000)+1. */
  clockTime: NonNegInt.optional(),
  /** The local player (1 Hz pushes while ready). */
  player: PlayerState.optional(),
}).describe('World lifecycle and clock updates from the mod.');

/**
 * M→N request. The local player died. The mod re-sends it (same `id`) until Node replies `ok`, so Node
 * must treat it idempotently per `worldId`.
 */
export const PlayerDied = defineMessage('player.died', {
  worldId: WorldId,
  cause: z.string().min(1).max(256),
  killer: z.string().min(1).max(128).optional(),
  /** Game day of death (1-based). */
  day: z.number().int().min(1),
  ticksAlive: NonNegInt,
}).describe('The player died; Node marks the world dead and allocates the next one.');

/** N→M. The next world is allocated; enables [Begin World #N+1] on the Game Over screen. */
export const WorldNext = defineMessage('world.next', {
  /** The next world. */
  worldId: WorldId,
  gen: z.number().int().min(1),
  /** Summary of the world that just ended. */
  summary: z.object({
    worldId: WorldId,
    gen: z.number().int().min(1),
    day: z.number().int().min(1),
    cause: z.string().min(1).max(256),
    killer: z.string().min(1).max(128).optional(),
    crewFates: z.array(
      z.object({
        agentId: AgentId,
        name: z.string().min(1).max(32),
        role: z.string().min(1).max(32),
        fate: z.enum(['died', 'dismissed', 'lost_with_world']),
        /** e.g. "Fell from a high place on Day 3". */
        detail: z.string().max(256).optional(),
      }),
    ),
    vaultCommits: z.array(
      z.object({
        mount: z.string().min(1).max(1024),
        commits: NonNegInt,
      }),
    ),
  }),
}).describe('Announces the next world and summarises the one that ended.');

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/** M→N. The client is shutting down (window closed / Quit MineVibe). */
export const ClientStopping = defineMessage('client.stopping', {
  reason: z.string().max(64).optional(),
}).describe('The game client is stopping.');

/** N→M. Node is shutting down; the mod should save and expect the socket to close. */
export const ServerShutdown = defineMessage('server.shutdown', {
  reason: z.string().max(64).optional(),
}).describe('Node is shutting down.');

export const worldMessages = {
  hello: {
    schema: Hello,
    direction: 'mod_to_node',
    group: 'world',
    summary: 'Mod handshake; sent first on every connection.',
  },
  'hello.ok': {
    schema: HelloOk,
    direction: 'node_to_mod',
    group: 'world',
    summary: 'Handshake reply with a full state snapshot.',
  },
  'world.open': {
    schema: WorldOpen,
    direction: 'node_to_mod',
    group: 'world',
    summary: 'Open or create the given hardcore world.',
  },
  'world.state': {
    schema: WorldState,
    direction: 'mod_to_node',
    group: 'world',
    summary: 'World lifecycle phase, plus 1 Hz clock and player updates.',
  },
  'player.died': {
    schema: PlayerDied,
    direction: 'mod_to_node',
    group: 'world',
    summary: 'Request: the player died; re-sent until acked.',
  },
  'world.next': {
    schema: WorldNext,
    direction: 'node_to_mod',
    group: 'world',
    summary: 'Next world allocated, plus the summary of the one that ended.',
  },
  'client.stopping': {
    schema: ClientStopping,
    direction: 'mod_to_node',
    group: 'world',
    summary: 'The game client is shutting down.',
  },
  'server.shutdown': {
    schema: ServerShutdown,
    direction: 'node_to_mod',
    group: 'world',
    summary: 'Node is shutting down.',
  },
} as const satisfies Record<string, CatalogEntry>;
