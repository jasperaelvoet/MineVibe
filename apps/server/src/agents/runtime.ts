/**
 * Wiring of the brain runtime to the bridge: resolves the `claude` binary, builds the AgentManager and subscribes it
 * to the mod's body, seat and world messages. The UI glue (UiHub, T1) forwards the CrewApi events to the mod; pass
 * `forwardUi` to let this module send them itself (dev without UiHub). The composed server (orchestrator/runtime.ts)
 * drives world open and player death itself (`worldEvents: false`), so modules see them in order.
 */

import type { Logger } from 'pino';
import type { BridgeServer } from '../bridge/BridgeServer.js';
import type { MineVibePaths } from '../config/paths.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';
import { createBridgeSkillApi, type SkillApi } from '../contracts/SkillApi.js';
import { AgentManager, type AgentManagerOptions, type WorldInfo } from './AgentManager.js';
import { agentEnv } from './agentEnv.js';
import { ClaudeBinaryError, type ResolvedClaude, resolveClaudeBinary } from './claudeBinary.js';
import type { QueryFactory } from './sdk.js';

export type RuntimeBridge = Pick<BridgeServer, 'on' | 'handle' | 'send' | 'request'>;

export interface AgentRuntimeOptions {
  readonly bridge: RuntimeBridge;
  readonly paths: MineVibePaths;
  readonly version: string;
  readonly log: Logger;
  readonly playerName: () => string;
  readonly org: OrgApi;
  readonly pcs: PcApi;
  /** The world number of a world id (from the CurrentWorldStore). */
  readonly worldInfo: (worldId: string) => WorldInfo | null;
  readonly skills?: SkillApi;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Dev builds may run the SDK-bundled claude with MINEVIBE_CLAUDE=bundled. */
  readonly allowBundled?: boolean;
  /** API-key mode: injected into the agent env only. */
  readonly apiKey?: string;
  readonly forwardUi?: boolean;
  readonly queryFactory?: QueryFactory;
  /** A claude already resolved (tests, the brainless runs); skips {@link resolveClaudeBinary}. */
  readonly claude?: ResolvedClaude;
  /**
   * Without a usable claude, start anyway: bodies spawn and keep their reflexes, every brain stays asleep with a
   * toast saying what to do (PLAN §6.1). Default false: reject with the ClaudeBinaryError.
   */
  readonly tolerateMissingClaude?: boolean;
  /** Let the bridge's `world.state{ready}` and `player.died` open and end worlds here (default true). */
  readonly worldEvents?: boolean;
  /** Passed through to the AgentManager. */
  readonly manager?: Partial<
    Pick<
      AgentManagerOptions,
      | 'spawnPlace'
      | 'calendarWakes'
      | 'chatDebounceMs'
      | 'autonomyTickMs'
      | 'lastWordsMs'
      | 'deskTtlMs'
      | 'crewCap'
      | 'now'
      | 'approveCalendarEvent'
    >
  >;
}

export interface AgentRuntime {
  readonly manager: AgentManager;
  /** The claude the sessions run, or null when none is usable (brains asleep). */
  readonly claude: ResolvedClaude | null;
  /** Why no claude is usable (the player-facing instruction), or null. */
  readonly claudeProblem: string | null;
  dispose(): Promise<void>;
}

/** Builds the runtime. Rejects with a ClaudeBinaryError when no usable `claude` is installed (unless tolerated). */
export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const env = options.env ?? process.env;
  const envFor = () =>
    agentEnv({
      version: options.version,
      source: env,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
  let claude: ResolvedClaude | null = options.claude ?? null;
  let claudeProblem: string | null = null;
  if (claude === null) {
    try {
      claude = await resolveClaudeBinary({
        env,
        versionEnv: envFor(),
        allowBundled: options.allowBundled ?? false,
      });
    } catch (err) {
      if (!(err instanceof ClaudeBinaryError) || !options.tolerateMissingClaude) throw err;
      claudeProblem = err.message;
      options.log.error({ problem: err.problem, found: err.found }, `no usable claude: ${err.message}`);
    }
  }
  const resolved = claude;
  const skills = options.skills ?? createBridgeSkillApi(options.bridge);
  const manager = new AgentManager({
    skills,
    org: options.org,
    pcs: options.pcs,
    claude: () => {
      if (resolved === null) throw new ClaudeBinaryError('missing', claudeProblem ?? 'no claude', null, null);
      return resolved;
    },
    agentEnv: envFor,
    worldsDir: options.paths.worlds,
    stateDir: options.paths.state,
    playerName: options.playerName,
    log: options.log,
    authMode: options.apiKey ? 'api_key' : 'subscription',
    ...(options.queryFactory ? { queryFactory: options.queryFactory } : {}),
    ...options.manager,
  });
  const off = attachAgentBridge(options.bridge, manager, {
    worldInfo: options.worldInfo,
    forwardUi: options.forwardUi ?? false,
    log: options.log,
    worldEvents: options.worldEvents ?? true,
  });
  return {
    manager,
    claude: resolved,
    claudeProblem,
    async dispose() {
      off();
      await manager.shutdown();
      manager.dispose();
      (skills as { dispose?: () => void }).dispose?.();
    },
  };
}

/** Subscribes the manager to the bridge; returns an unsubscribe function. */
export function attachAgentBridge(
  bridge: RuntimeBridge,
  manager: AgentManager,
  options: {
    worldInfo: (worldId: string) => WorldInfo | null;
    forwardUi: boolean;
    log: Logger;
    /** Open worlds on `world.state{ready}` and end them on `player.died` here (default true). */
    worldEvents?: boolean;
  },
): () => void {
  const worldEvents = options.worldEvents ?? true;
  const offs: (() => void)[] = [
    bridge.on('world.state', (msg) => {
      manager.onWorldState(msg);
      if (worldEvents && msg.phase === 'ready') {
        const info = options.worldInfo(msg.worldId) ?? { worldId: msg.worldId, gen: 1 };
        void manager.openWorld(info).catch((err: unknown) => options.log.error({ err }, 'openWorld failed'));
      }
    }),
    bridge.on('agent.state', (msg) => manager.onAgentState(msg)),
    bridge.on('agent.event', (msg) => manager.onAgentEvent(msg)),
    bridge.on('pc.seat', (msg) => manager.onPcSeat(msg)),
    bridge.on('pc.unseat', (msg) => manager.onPcUnseat(msg)),
    bridge.handle('agent.died', (msg) => manager.onAgentDied(msg)),
  ];
  if (worldEvents) {
    offs.push(
      bridge.on('player.died', (msg) => {
        // A re-send for a world that already ended (or another world) must not end the current crew.
        if (manager.world?.worldId !== msg.worldId) return;
        void manager.playerDied({ cause: msg.cause, day: msg.day });
      }),
    );
  }
  if (options.forwardUi) {
    const send = <K extends Parameters<RuntimeBridge['send']>[0]>(
      t: K,
      payload: Parameters<RuntimeBridge['send']>[1],
    ) => {
      try {
        bridge.send(t, payload as never);
      } catch (err) {
        options.log.warn({ err, t }, 'ui forward failed');
      }
    };
    offs.push(
      manager.on('say', (p) => send('agent.say', p)),
      manager.on('brain', (p) => send('agent.brain', p)),
      manager.on('pending', (p) => send('agent.pending', p)),
      manager.on('chat', (p) => send('chat.append', p)),
      manager.on('crew', (p) => send('crew.state', p)),
      manager.on('brains', (p) => send('brains.state', p)),
      manager.on('toast', (p) => send('ui.toast', p)),
    );
  }
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
