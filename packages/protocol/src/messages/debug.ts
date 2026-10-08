import { z } from 'zod';
import { AgentId, NonNegInt, WorldId } from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

// ---------------------------------------------------------------------------------------------
// Debug (E2E only). The mod handles these only when the game runs with `-Dminevibe.e2e=true`;
// otherwise it answers `err NOT_HANDLED`. Type names are dotted lowercase with snake_case words.
// ---------------------------------------------------------------------------------------------

/** N→M request. Snapshot of the game client; the `ok` reply carries {@link DebugStateResult}. */
export const DebugState = defineMessage('debug.state', {}).describe(
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
export const DebugKillPlayer = defineMessage('debug.kill_player', {}).describe('E2E: kill the local player.');

/** N→M request. Opens the in-game menu the way Esc does; the `ok` reply has `screen`. */
export const DebugOpenMenu = defineMessage('debug.open_menu', {}).describe(
  'E2E: open the in-game menu as Esc would.',
);

/** N→M request. Presses [Begin World #N+1] on the Game Over screen; `err NOT_READY` if it is not enabled. */
export const DebugClickBegin = defineMessage('debug.click_begin', {}).describe(
  'E2E: press Begin on the Game Over screen.',
);

/** N→M request. Kills an agent body (as `/kill` would): grave, diary, `agent.died`. `err UNKNOWN_AGENT`. */
export const DebugKillAgent = defineMessage('debug.kill_agent', { agentId: AgentId }).describe(
  'E2E: kill an agent body.',
);

/** N→M request. Sets the overworld clock (scheduled tasks and meetings at Day N hh:mm). */
export const DebugSetClock = defineMessage('debug.set_clock', { clockTime: NonNegInt }).describe(
  'E2E: set the overworld clock time.',
);

export const debugMessages = {
  'debug.state': {
    schema: DebugState,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: snapshot of the client (request; reply carries DebugStateResult).',
    reply: DebugStateResult,
  },
  'debug.kill_player': {
    schema: DebugKillPlayer,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: kill the local player (request).',
  },
  'debug.open_menu': {
    schema: DebugOpenMenu,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: open the in-game menu as Esc would (request).',
  },
  'debug.click_begin': {
    schema: DebugClickBegin,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: press Begin on the Game Over screen (request).',
  },
  'debug.kill_agent': {
    schema: DebugKillAgent,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: kill an agent body (request).',
  },
  'debug.set_clock': {
    schema: DebugSetClock,
    direction: 'node_to_mod',
    group: 'debug',
    summary: 'E2E only: set the overworld clock time (request).',
  },
} as const satisfies Record<string, CatalogEntry>;
