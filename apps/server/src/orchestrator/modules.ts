/**
 * apps/server/src/orchestrator/modules.ts: the shared composition contract between the core runtime
 * (orchestrator/runtime.ts) and the PC and org modules (pcs/module.ts, org/module.ts). PLAN §3, §6.
 *
 * The runtime owns the bridge, the world lifecycle and the agent runtime; it builds a {@link PcModule} and an
 * {@link OrgModule} through injected factories, hands the org module the crew ({@link OrgModule.bindCrew}) and drives
 * both with the world events below. Each module registers its own bridge handlers on `ctx.bridge` (one handler per
 * message type) in its factory or in `start()`.
 *
 * Call order (runtime.ts):
 * 1. `createPcModule(ctx, …)` and `createOrgModule(ctx)`; the agent runtime is built on `pcModule.pcApi` and
 *    `orgModule.orgApi`.
 * 2. `orgModule.bindCrew(crew, hooks)` (once, before `start()`).
 * 3. `pcModule.start()`, then `orgModule.start()`, then the bridge starts listening.
 * 4. World events, any number of times:
 *    - `onWorldOpen(worldId, fresh)`: the mod reported the current world `ready`, the first time in this game session
 *      (again after the game restarted). `fresh` is true only the first time that world was ever ready. Called after
 *      the crew of that world was restored or its first CEO was hired.
 *    - `onClock(clockTime)`: every `world.state` that carries the overworld clock (1 Hz while ready).
 *    - `onWorldEnded(worldId)`: the player died in that world, after the CEO's last words, once the crew's sessions are
 *      closed. It can be called again for the same world after a Node restart on the Game Over screen, so it must be
 *      idempotent.
 * 5. Shutdown: `orgModule.stop()`, then `pcModule.stop()`, then the bridge closes.
 *
 * Calendar tasks and meeting traffic reach agents only through {@link CrewHooks}: once `bindCrew` was called the agent
 * runtime no longer turns the OrgApi's `calendarFired` events into wakes (the org module delivers them with
 * `deliver(…, 'scheduled')` and owns reminders, which are bubbles and toasts).
 */

import type { Logger } from 'pino';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { MineVibePaths } from '../config/paths.js';
import type { CrewApi } from '../contracts/CrewApi.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';

export interface RuntimeContext {
  bridge: BridgeServer;
  paths: MineVibePaths;
  log: Logger;
  /** The world the mod is in and Node opened (`ready` seen), or null (boot screen, between worlds). */
  world(): { worldId: string; gen: number } | null;
  mode: 'dev' | 'play' | 'app';
}

export interface WorldEvents {
  onWorldOpen(worldId: string, fresh: boolean): void | Promise<void>;
  onWorldEnded(worldId: string): void | Promise<void>;
  onClock(clockTime: number): void;
}

/**
 * What the org services (ApproachQueue, MeetingRunner, CalendarService) may ask of the crew's minds and seats. Every
 * call rejects with an `ApiError` (`UNKNOWN_AGENT` for no living agent with that id, `BRAIN_OFFLINE` when it cannot
 * think, or the mod's seat error code) instead of failing silently.
 */
export interface CrewHooks {
  /** A seated agent walks over to present card `pendingId`: `seated → away_from_seat`, the chair stays reserved. */
  goAway(agentId: string, pendingId: string): Promise<void>;
  /** The card was answered: walk back and sit, no model swap (`away_from_seat → seated`). */
  comeBack(agentId: string): Promise<void>;
  /**
   * Into a meeting: a seated agent is interrupted, keeps its PC chair reserved and its model (the swap debounce
   * stretches over the meeting), then the body walks to a meeting chair (`agent.seat{meeting}`). Resolves once the
   * walk started; the mod's `NO_SEAT` / `UNREACHABLE` rejects (the meeting can dial the agent in instead).
   */
  pullIntoMeeting(agentId: string, meetingId: string): Promise<void>;
  /** Leaves the meeting chair; an agent that was seated at a PC walks back to its reserved chair. */
  releaseFromMeeting(agentId: string): Promise<void>;
  /**
   * Delivers Node-made text to an agent. `scheduled`: a P1 wake after the current turn, `meeting`: a P1 meeting
   * notice, `context`: no turn (`shouldQuery:false`). The runtime prefixes the agent's own nonce-tagged control tag;
   * shared text inside `text` must already be in a data envelope (control-tag look-alikes are neutralized anyway).
   */
  deliver(agentId: string, text: string, kind: 'scheduled' | 'meeting' | 'context'): Promise<void>;
  /**
   * One meeting turn on the interactive lane (P0): resolves with what the agent said, cut to `maxSentences`
   * sentences. The agent's bubbles show while it speaks. A turn that runs too long is interrupted and resolves with
   * what was said so far.
   */
  meetingTurn(agentId: string, prompt: string, opts: { maxSentences: number }): Promise<string>;
}

export interface PcModule extends Partial<WorldEvents> {
  readonly pcApi: PcApi;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OrgModule extends WorldEvents {
  readonly orgApi: OrgApi;
  bindCrew(crew: CrewApi, hooks: CrewHooks): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type CreatePcModule = (
  ctx: RuntimeContext,
  opts: { runtime: 'container' | 'docker'; bundleInstallRoot?: string },
) => PcModule;
export type CreateOrgModule = (ctx: RuntimeContext) => OrgModule;
