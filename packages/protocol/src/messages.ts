import { z } from 'zod';
import { CHAT_MAX_LENGTH } from './constants.js';
import { MessageId, ProtocolVersion } from './envelope.js';

// ---------------------------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------------------------

/** Agent id minted by Node (a short slug or a UUID). */
export const AgentId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'agent id: 1-64 of [A-Za-z0-9_-], starting alphanumeric');

/** World id minted by Node. Also the save-folder name, so it is restricted to a safe slug. */
export const WorldId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'world id: 1-64 of [a-z0-9-], starting alphanumeric');

/** Chat handle: what the player types after `@`. */
export const Handle = z.string().regex(/^[a-z][a-z0-9]{1,11}$/, 'handle: [a-z][a-z0-9]{1,11}');

/** Minecraft player name (offline profiles allow 1-16 of [A-Za-z0-9_]). */
export const PlayerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, 'Minecraft player name');

const Int32 = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);
const NonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A block position in the world. */
export const BlockPos = z.object({ x: Int32, y: Int32, z: Int32 });
export type BlockPos = z.infer<typeof BlockPos>;

/** A crew member as the mod needs it for name tags, chat completion and screens. */
export const CrewMember = z.object({
  agentId: AgentId,
  handle: Handle,
  name: z.string().min(1).max(32),
  role: z.string().min(1).max(32),
  ceo: z.boolean(),
  status: z.enum(['alive', 'dead', 'dismissed']),
});
export type CrewMember = z.infer<typeof CrewMember>;

/** Brain scheduler / usage summary (also pushed later as `brains.state`). */
export const BrainsSummary = z.object({
  inFlight: NonNegInt,
  queued: NonNegInt,
  max: NonNegInt,
  mode: z.enum(['normal', 'tired', 'asleep']),
  utilization: z.number().min(0).max(1).nullable(),
  /** Epoch milliseconds when usage resets, if known. */
  resetsAt: NonNegInt.nullable(),
});
export type BrainsSummary = z.infer<typeof BrainsSummary>;

// ---------------------------------------------------------------------------------------------
// Message helper
// ---------------------------------------------------------------------------------------------

function message<const T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({
    t: z.literal(t),
    v: ProtocolVersion,
    id: MessageId.optional(),
    re: MessageId.optional(),
    ...shape,
  });
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** M→N. First message on every (re)connect. Node answers with `hello.ok` and then re-sends full state. */
export const Hello = message('hello', {
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
}).describe('Mod handshake; sent first on every connection.');

/** N→M. Answer to `hello` (`re` = the hello's `id` when it had one) with a full state snapshot. */
export const HelloOk = message('hello.ok', {
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
  /** User settings relevant to the mod (free-form until later milestones pin them down). */
  settings: z.record(z.string(), z.unknown()),
  /** PC records (shape pinned in M4). */
  pcs: z.array(z.looseObject({ pcId: z.string().min(1).max(64) })),
  /** Host budget (shape pinned in M4); null until known. */
  budget: z.looseObject({}).nullable(),
  crew: z.array(CrewMember),
  brains: BrainsSummary,
  /** Pending cards (shape pinned in M3). */
  pending: z.array(
    z.looseObject({
      id: z.string().min(1).max(64),
      agentId: AgentId,
      kind: z.enum(['question', 'plan', 'hire']),
    }),
  ),
}).describe('Node handshake reply with a full state snapshot.');

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

/** N→M. Open (or create) this world. BootScreen calls openWorld, or createFreshLevel if missing. */
export const WorldOpen = message('world.open', {
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

/** M→N. World lifecycle updates; also pushed at 1 Hz while ready (with `clockTime`). */
export const WorldState = message('world.state', {
  worldId: WorldId,
  phase: z.enum(['loading', 'ready', 'closing', 'closed']),
  fresh: z.boolean().optional(),
  spawn: BlockPos.optional(),
  office: z
    .object({
      origin: BlockPos,
      slots: z.array(
        z.object({
          kind: z.string().min(1).max(32),
          pos: BlockPos,
          pcId: z.string().min(1).max(64).optional(),
        }),
      ),
    })
    .optional(),
  /** Overworld clock time in ticks (`getOverworldClockTime()`). Day = floor(t/24000)+1. */
  clockTime: NonNegInt.optional(),
}).describe('World lifecycle and clock updates from the mod.');

/**
 * M→N request. The local player died. The mod re-sends it (same `id`) until Node replies `ok`, so Node
 * must treat it idempotently per `worldId`.
 */
export const PlayerDied = message('player.died', {
  worldId: WorldId,
  cause: z.string().min(1).max(256),
  killer: z.string().min(1).max(128).optional(),
  /** Game day of death (1-based). */
  day: z.number().int().min(1),
  ticksAlive: NonNegInt,
}).describe('The player died; Node marks the world dead and allocates the next one.');

/** N→M. The next world is allocated; enables [Begin World #N] on the Game Over screen. */
export const WorldNext = message('world.next', {
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
export const ClientStopping = message('client.stopping', {
  reason: z.string().max(64).optional(),
}).describe('The game client is stopping.');

/** N→M. Node is shutting down; the mod should save and expect the socket to close. */
export const ServerShutdown = message('server.shutdown', {
  reason: z.string().max(64).optional(),
}).describe('Node is shutting down.');

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

/** N→M. A toast in the bottom-left corner. */
export const UiToast = message('ui.toast', {
  text: z.string().min(1).max(512),
  kind: z.enum(['info', 'success', 'warn', 'error']),
  /** Agent the toast is about (adds its face), if any. */
  agentId: AgentId.optional(),
  ttlMs: z.number().int().min(500).max(60_000).optional(),
}).describe('Shows a toast.');

/** N→M. A speech bubble above an agent's head. At least one of `text` / `bark` is present. */
export const AgentSay = message('agent.say', {
  agentId: AgentId,
  text: z.string().min(1).max(CHAT_MAX_LENGTH).optional(),
  /** Scripted bark key, rendered by the mod from its own table. */
  bark: z.string().min(1).max(64).optional(),
  style: z.enum(['speech', 'bark', 'tell']),
  ttlMs: z.number().int().min(500).max(120_000),
})
  .refine((m) => m.text !== undefined || m.bark !== undefined, {
    message: 'agent.say needs text or bark',
    path: ['text'],
  })
  .describe('Speech bubble above an agent.');

/**
 * M→N request. A line the player typed (chat box intercepted client-side) or sent from AgentScreen.
 * - `to: "all"`: a raw chat line. Node parses its leading `@mentions`; with none it is a broadcast.
 * - `to: [agentIds]`: explicit recipients (AgentScreen, the G card); `text` is not mention-parsed.
 * Node replies `ok{echo}` or `err{code: CHAT_*, msg: <inline hint>}`; on `err` the mod keeps the text
 * in the chat box and shows `msg`.
 */
export const ChatSend = message('chat.send', {
  to: z.union([z.literal('all'), z.array(AgentId).min(1).max(16)]),
  text: z.string().min(1).max(CHAT_MAX_LENGTH),
}).describe('Player chat line, routed by Node (mentions, broadcast, answers).');

/** Result payload of a successful `chat.send` (keys of the `ok` reply). */
export const ChatSendResult = z.object({
  /** How the message was read, e.g. "You → Ada: Q1 = 2 (Spruce)". Shown in the chat log. */
  echo: z
    .string()
    .min(1)
    .max(CHAT_MAX_LENGTH + 200),
});
export type ChatSendResult = z.infer<typeof ChatSendResult>;

// ---------------------------------------------------------------------------------------------
// Debug (E2E only). The mod handles these only when the game runs with `-Dminevibe.e2e=true`;
// otherwise it answers `err NOT_HANDLED`. Type names are dotted lowercase like every other type.
// ---------------------------------------------------------------------------------------------

/** N→M request. Snapshot of the game client; the `ok` reply carries {@link DebugStateResult}. */
export const DebugState = message('debug.state', {}).describe(
  'E2E: snapshot of the client (screen, world, pause state, server ticks, player health).',
);

/** Keys of the `ok` reply to `debug.state`. */
export const DebugStateResult = z.object({
  /** Simple class name of the open screen (`BootScreen`, `GameOverScreen`, …), null when in game. */
  screen: z.string().min(1).max(128).nullable(),
  /** The world the mod is in (or loading), null on BootScreen before `world.open`. */
  worldId: WorldId.nullable(),
  /** That world's number, when known. */
  gen: z.number().int().min(1).nullable(),
  /** A client level and player exist. */
  inWorld: z.boolean(),
  hardcore: z.boolean().nullable(),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']).nullable(),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']).nullable(),
  /** Commands allowed in this world (only in `-Dminevibe.dev=true` worlds). */
  allowCommands: z.boolean().nullable(),
  /** `Minecraft#isPaused()`. */
  paused: z.boolean(),
  /** Integrated server tick count, null without a server. */
  serverTicks: NonNegInt.nullable(),
  /** `IntegratedServer#isPaused()`, null without a server. */
  serverPaused: z.boolean().nullable(),
  /** Local player health, null when not in a world. */
  hp: z.number().min(0).nullable(),
  dead: z.boolean().nullable(),
  /** Game JVM process id (lets the E2E harness kill the client). */
  pid: NonNegInt,
});
export type DebugStateResult = z.infer<typeof DebugStateResult>;

/** N→M request. Kills the local player on the integrated server (as `/kill` would). */
export const DebugKillPlayer = message('debug.kill_player', {}).describe('E2E: kill the local player.');

/** N→M request. Opens the in-game menu the way Esc does; the `ok` reply has `screen`. */
export const DebugOpenMenu = message('debug.open_menu', {}).describe(
  'E2E: open the in-game menu as Esc would.',
);

/** N→M request. Presses [Begin World #N+1] on the Game Over screen; `err NOT_READY` if it is not enabled. */
export const DebugClickBegin = message('debug.click_begin', {}).describe(
  'E2E: press Begin on the Game Over screen.',
);
