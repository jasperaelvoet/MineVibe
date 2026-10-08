/**
 * The composed MineVibe server (PLAN §3, §6): one bridge, the world lifecycle, the crew and the PC and org modules.
 * `npm run dev`, `npm run play` and MineVibe.app (`main.ts app`) all start it through {@link startRuntime}.
 *
 * - **Bridge.** 127.0.0.1 with a fresh token per run; `run/bridge.json` (0600) tells the mod where it is.
 * - **World lifecycle** (PLAN §7.9): the durable hardcore loop, plus `hello.ok`'s live snapshot (crew, brains, cards)
 *   and the Game Over summary's crew fates. Dead saves move to `saves/_graveyard/` once the mod closed them.
 * - **Crew.** `agents` (default): the T3 agent runtime (AgentManager over a bridge SkillApi) behind T1's UiHub, which
 *   answers `chat.send`, `pending.answer`, `plan.decision`, `hire.decision`, `agent.cmd` and `chat.history` and
 *   forwards `agent.say/brain/pending`, `chat.append`, `crew.state`, `brains.state` and toasts. Without a usable
 *   claude the bodies still spawn and every brain sleeps with a toast. `scripted`: the zero-token ScriptedCrew (dev UI
 *   work). `none`: M1's chat handler against an empty roster (contract tests).
 * - **Modules** (orchestrator/modules.ts): a PcModule and an OrgModule from injected factories (factories.ts by
 *   default). The org module gets the crew and the {@link CrewHooks}; both get the world events in order.
 * - **Worlds.** The first `ready` of the current world in a game session opens it: the crew is restored (or a fresh
 *   world's CEO is hired at the office door, `world.state.office`), then the modules hear `onWorldOpen`. Player death
 *   gives the CEO's last words and closes the crew's sessions (archiving the world's crew file), then the modules
 *   hear `onWorldEnded`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DebugStateResult, type PayloadOf, type Place } from '@minevibe/protocol';
import type { Logger } from 'pino';
import type { AgentRecord } from '../agents/AgentBrain.js';
import type { AgentManager, CrewFate } from '../agents/AgentManager.js';
import { ChatRouter } from '../agents/chat/ChatRouter.js';
import { createChatSendHandler } from '../agents/chat/chatSend.js';
import type { ResolvedClaude } from '../agents/claudeBinary.js';
import { type AgentRuntime, type AgentRuntimeOptions, createAgentRuntime } from '../agents/runtime.js';
import type { QueryFactory } from '../agents/sdk.js';
import { appBundleLayout } from '../app/appLayout.js';
import { BridgeServer } from '../bridge/BridgeServer.js';
import { generateToken, removeBridgeFile, writeBridgeFile } from '../bridge/bridgeFile.js';
import { ensureBaseDirs, type MineVibePaths } from '../config/paths.js';
import type { CrewApi } from '../contracts/CrewApi.js';
import { ApiError } from '../contracts/common.js';
import { FakeCrewApi } from '../contracts/FakeCrewApi.js';
import { ScriptedCrew } from '../ui/ScriptedCrew.js';
import { UiHub } from '../ui/UiHub.js';
import { SERVER_VERSION } from '../version.js';
import { CurrentWorldStore } from '../world/currentWorld.js';
import { buryWorldSave, GRAVEYARD_KEEP } from '../world/graveyard.js';
import { WorldLifecycle, type WorldLifecycleOptions } from '../world/WorldLifecycle.js';
import { defaultOrgModule, defaultPcModule } from './factories.js';
import type {
  CreateOrgModule,
  CreatePcModule,
  CrewHooks,
  OrgModule,
  PcModule,
  RuntimeContext,
} from './modules.js';
import { createNullPcModule } from './placeholderModules.js';

/** `docker` | `container` (default): the PC driver (PLAN §9.4). */
export const PC_RUNTIME_ENV = 'MINEVIBE_PC_RUNTIME';
/** `off` (or `0`, `false`, `no`) runs without PCs: no container engine is touched. */
export const PCS_ENV = 'MINEVIBE_PCS';

/** How long a new agent's spawn waits for the office door before it appears near the player instead. */
export const OFFICE_DOOR_WAIT_MS = 5_000;
/**
 * How long {@link Runtime.stop} lets a world event already running (an open, a world end) finish before the modules
 * stop. The sessions are closed by then, so last words end at once and no new brain starts.
 */
export const STOP_WORLD_WAIT_MS = 10_000;

export type CrewMode = 'agents' | 'scripted' | 'none';

/** E2E helpers that drive the mod's `debug.*` handlers (the game must run with `-Dminevibe.e2e=true`). */
export interface DevDebug {
  state(timeoutMs?: number): Promise<DebugStateResult>;
  killPlayer(): Promise<void>;
  openMenu(): Promise<{ screen: string | null }>;
  clickBegin(): Promise<void>;
}

export interface RuntimeOptions {
  readonly mode: RuntimeContext['mode'];
  readonly paths: MineVibePaths;
  readonly log: Logger;
  /** Where the game keeps its saves (dead worlds are buried in `<savesDir>/_graveyard`). */
  readonly savesDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Bridge port; 0 (default) picks a random one. */
  readonly port?: number;
  /** Default: a fresh random token. */
  readonly token?: string;
  /** Heartbeat interval for the bridge (0 disables). */
  readonly heartbeatMs?: number;
  /** Offline profile name until the mod reports one (default "Jasper"). */
  readonly playerName?: string;
  readonly graveyardKeep?: number;
  /** E2E mode: exposes {@link Runtime.debug}. */
  readonly e2e?: boolean;
  /** Default `agents`. */
  readonly crew?: CrewMode;
  /** Reply delay of the scripted crew. */
  readonly scriptedReplyDelayMs?: number;
  /** Module factories; default factories.ts (and no PCs with `MINEVIBE_PCS=off`). */
  readonly modules?: { readonly pc?: CreatePcModule; readonly org?: CreateOrgModule };
  /** Default: `MINEVIBE_PC_RUNTIME`, else `container`. */
  readonly pcRuntime?: 'container' | 'docker';
  /** Default in app mode: the bundle's `Contents/Runtime/container`. */
  readonly bundleInstallRoot?: string;
  /** Test seams and settings of the agent runtime (`crew: 'agents'`). */
  readonly agents?: {
    readonly queryFactory?: QueryFactory;
    readonly claude?: ResolvedClaude;
    readonly allowBundled?: boolean;
    readonly apiKey?: string;
    readonly manager?: AgentRuntimeOptions['manager'];
  };
  /** How long a spawn waits for the office door (default 5 s). */
  readonly officeDoorWaitMs?: number;
}

export interface Runtime {
  readonly mode: RuntimeContext['mode'];
  readonly bridge: BridgeServer;
  readonly paths: MineVibePaths;
  readonly port: number;
  readonly lifecycle: WorldLifecycle;
  readonly store: CurrentWorldStore;
  /** Where the game keeps its saves (and the `_graveyard`). */
  readonly savesDir: string;
  /** Non-null in E2E mode. */
  readonly debug: DevDebug | null;
  /** The UI hub, when a crew runs behind it. */
  readonly ui: UiHub | null;
  /** The scripted crew (`crew: 'scripted'`). */
  readonly scriptedCrew: ScriptedCrew | null;
  /** The agent runtime (`crew: 'agents'`). */
  readonly agents: AgentRuntime | null;
  readonly pcModule: PcModule;
  readonly orgModule: OrgModule;
  readonly ctx: RuntimeContext;
  /** Resolves when the world events queued so far (opens, ends) have run (tests). */
  settled(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

function envFlag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envOff(value: string | undefined): boolean {
  return value !== undefined && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function createDebug(bridge: BridgeServer): DevDebug {
  return {
    async state(timeoutMs) {
      const reply = await bridge.request('debug.state', {}, timeoutMs !== undefined ? { timeoutMs } : {});
      const { t: _t, v: _v, re: _re, ...payload } = reply;
      return DebugStateResult.parse(payload);
    },
    async killPlayer() {
      await bridge.request('debug.kill_player', {});
    },
    async openMenu() {
      const reply = await bridge.request('debug.open_menu', {});
      return { screen: typeof reply.screen === 'string' ? reply.screen : null };
    },
    async clickBegin() {
      await bridge.request('debug.click_begin', {});
    },
  };
}

/** The CrewHooks over the agent runtime (orchestrator/modules.ts). */
export function crewHooksOf(manager: AgentManager): CrewHooks {
  return {
    goAway: (agentId, pendingId) => manager.goAway(agentId, pendingId),
    comeBack: (agentId) => manager.comeBack(agentId),
    pullIntoMeeting: (agentId, meetingId) => manager.pullIntoMeeting(agentId, meetingId),
    releaseFromMeeting: (agentId) => manager.releaseFromMeeting(agentId),
    deliver: (agentId, text, kind) => manager.deliverTo(agentId, text, kind),
    meetingTurn: (agentId, prompt, opts) => manager.meetingTurn(agentId, prompt, opts),
  };
}

/** Hooks for a crew without minds (scripted or none): every call rejects. */
export function noCrewHooks(): CrewHooks {
  const none = (agentId: string) =>
    Promise.reject(new ApiError('UNKNOWN_AGENT', `No agent runtime runs ${agentId}.`));
  return {
    goAway: none,
    comeBack: none,
    pullIntoMeeting: none,
    releaseFromMeeting: none,
    deliver: none,
    meetingTurn: none,
  };
}

/** The office door of a `world.state.office` as a spawn place (the `door` slot, else the `spawn` slot). */
export function officeDoor(
  office:
    | { readonly slots: readonly { readonly kind: string; readonly pos: Place['pos'] }[] }
    | null
    | undefined,
): Place | null {
  const slot = office?.slots.find((s) => s.kind === 'door') ?? office?.slots.find((s) => s.kind === 'spawn');
  return slot ? { pos: slot.pos, dim: 'minecraft:overworld' } : null;
}

/** Whether `p` settles within `ms` (it is never rejected here: the world chain catches its own errors). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Crew fates from a world's archived `crew.json` (Game Over after a Node restart). */
async function fatesFromDisk(paths: MineVibePaths, worldId: string): Promise<CrewFate[]> {
  try {
    const parsed = JSON.parse(await readFile(join(paths.worlds, worldId, 'crew.json'), 'utf8')) as {
      records?: AgentRecord[];
    };
    return (parsed.records ?? []).map((r) => ({
      agentId: r.agentId,
      name: r.name.slice(0, 32),
      role: r.ceo ? 'ceo' : r.role,
      fate: r.status === 'dead' ? 'died' : r.status === 'dismissed' ? 'dismissed' : 'lost_with_world',
      ...(r.status === 'dead' && r.cause
        ? { detail: `${r.cause}${r.diedDay !== undefined ? ` on Day ${r.diedDay}` : ''}`.slice(0, 256) }
        : {}),
    }));
  } catch {
    return [];
  }
}

/** Starts the composed server: modules, crew, world lifecycle, then the bridge. */
export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const env = options.env ?? process.env;
  const paths = options.paths;
  const log = options.log;
  await ensureBaseDirs(paths);
  const graveyardKeep = options.graveyardKeep ?? GRAVEYARD_KEEP;
  const crewMode: CrewMode = options.crew ?? 'agents';
  const token = options.token ?? generateToken();

  const store = new CurrentWorldStore(join(paths.state, 'current-world.json'));
  await store.load();

  const bridge = new BridgeServer({
    token,
    port: options.port ?? 0,
    logger: log.child({ component: 'bridge' }),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });

  // --- World tracking --------------------------------------------------------------------------------------------
  /** The world Node opened (its first `ready` in this game session), until the player dies in it. */
  let opened: { worldId: string; gen: number } | null = null;
  /** `<worldId>#<game session>` of the last open; a game restart (hello on BootScreen) opens the world again. */
  let openedKey: string | null = null;
  let gameSession = 0;
  /** World transitions run one at a time, in order. */
  let worldChain: Promise<void> = Promise.resolve();
  /** Set by `stop()`: no world event starts any more, and the modules are not called after they stopped. */
  let closing = false;
  const enqueueWorld = (what: string, fn: () => Promise<void>): void => {
    worldChain = worldChain
      .then(() => (closing ? undefined : fn()))
      .catch((err: unknown) => log.error({ err }, `${what} failed`));
  };
  const fates = new Map<string, CrewFate[]>();
  /** Worlds whose end already ran (or is queued). */
  const ended = new Set<string>();
  const offices = new Map<string, NonNullable<PayloadOf<'world.state'>['office']>>();
  const doorWaiters = new Set<() => void>();
  /** Worlds whose door wait already timed out once: later spawns do not wait again (no office there). */
  const noDoor = new Set<string>();

  const ctx: RuntimeContext = {
    bridge,
    paths,
    log,
    world: () => (opened ? { ...opened } : null),
    mode: options.mode,
  };

  // --- Modules ---------------------------------------------------------------------------------------------------
  const pcRuntime =
    options.pcRuntime ?? (env[PC_RUNTIME_ENV]?.trim() === 'docker' ? 'docker' : ('container' as const));
  const bundleInstallRoot =
    options.bundleInstallRoot ??
    (options.mode === 'app' ? appBundleLayout()?.containerInstallRoot : undefined);
  const createPc = options.modules?.pc ?? (envOff(env[PCS_ENV]) ? createNullPcModule : defaultPcModule);
  const createOrg = options.modules?.org ?? defaultOrgModule;
  const pcModule = createPc(ctx, {
    runtime: pcRuntime,
    ...(bundleInstallRoot !== undefined ? { bundleInstallRoot } : {}),
  });
  const orgModule = createOrg(ctx);

  // --- Lifecycle -------------------------------------------------------------------------------------------------
  // The crew is built below; the lifecycle's hooks read it lazily.
  let agents: AgentRuntime | null = null;
  let scriptedCrew: ScriptedCrew | null = null;
  let ui: UiHub | null = null;
  const worldLog = log.child({ component: 'world' });
  const lifecycle = new WorldLifecycle({
    bridge,
    store,
    logger: worldLog,
    serverVersion: SERVER_VERSION,
    playerName: options.playerName ?? 'Jasper',
    onWorldEnded: async (dead) => {
      const result = await buryWorldSave(options.savesDir, dead.worldId, { keep: graveyardKeep });
      fates.delete(dead.worldId);
      worldLog.info(
        { worldId: dead.worldId, movedTo: result.movedTo, pruned: result.pruned.length },
        result.movedTo ? 'dead world moved to the graveyard' : 'dead world has no save to bury',
      );
    },
    onWorldReady: (world, { fresh }) => onWorldReady(world, fresh),
    snapshot: () => snapshot(),
    crewFates: (worldId) => fates.get(worldId) ?? [],
  });

  // --- Crew ------------------------------------------------------------------------------------------------------
  let crew: CrewApi;
  let hooks: CrewHooks;
  if (crewMode === 'agents') {
    agents = await createAgentRuntime({
      bridge,
      paths,
      version: SERVER_VERSION,
      log,
      playerName: () => lifecycle.playerName,
      org: orgModule.orgApi,
      pcs: pcModule.pcApi,
      worldInfo: (worldId) => {
        const rec = store.current;
        return rec.worldId === worldId ? { worldId, gen: rec.gen } : null;
      },
      env,
      allowBundled: options.agents?.allowBundled ?? options.mode !== 'app',
      ...(options.agents?.apiKey ? { apiKey: options.agents.apiKey } : {}),
      ...(options.agents?.queryFactory ? { queryFactory: options.agents.queryFactory } : {}),
      ...(options.agents?.claude ? { claude: options.agents.claude } : {}),
      tolerateMissingClaude: true,
      worldEvents: false,
      manager: {
        spawnPlace: () => doorOfOpenWorld(),
        // The org module delivers calendar tasks through the CrewHooks (modules.ts).
        calendarWakes: false,
        approveCalendarEvent: async (eventId) => {
          // contracts/OrgApi has no approve call yet; an org module that offers one is used (I1c).
          const calendar = orgModule.orgApi.calendar as typeof orgModule.orgApi.calendar & {
            approve?: (actor: { kind: 'player' }, eventId: string) => Promise<void>;
          };
          if (!calendar.approve)
            throw new ApiError('NOT_SUPPORTED', 'Approving events is not available yet.');
          await calendar.approve({ kind: 'player' }, eventId);
        },
        ...options.agents?.manager,
      },
    });
    const manager = agents.manager;
    crew = manager;
    hooks = crewHooksOf(manager);
    const hub = new UiHub({ bridge, crew: manager, logger: log.child({ component: 'ui' }) }).start();
    manager.on('brains', (summary) => hub.setBrains(summary));
    manager.on('toast', (t) => {
      hub.toast(t.text, t.kind, {
        ...(t.agentId !== undefined ? { agentId: t.agentId } : {}),
        ...(t.ttlMs !== undefined ? { ttlMs: t.ttlMs } : {}),
      });
    });
    hub.setBrains(manager.brainsSummary());
    if (agents.claudeProblem) {
      // Said again on every connect, so the player sees it in game (the brains sleep until it is fixed).
      const problem = agents.claudeProblem;
      bridge.on('hello', () => {
        setImmediate(() => hub.toast(`The crew cannot think: ${problem}`, 'error', { ttlMs: 30_000 }));
      });
    }
    ui = hub;
  } else if (crewMode === 'scripted') {
    let hub: UiHub | null = null;
    scriptedCrew = new ScriptedCrew({
      logger: log.child({ component: 'scripted-crew' }),
      bridge,
      playerName: () => lifecycle.playerName,
      onBrains: (summary) => hub?.setBrains(summary),
      ...(options.scriptedReplyDelayMs !== undefined ? { replyDelayMs: options.scriptedReplyDelayMs } : {}),
    });
    hub = new UiHub({ bridge, crew: scriptedCrew, logger: log.child({ component: 'ui' }) }).start();
    hub.setBrains(scriptedCrew.brainsSummary());
    ui = hub;
    crew = scriptedCrew;
    hooks = noCrewHooks();
  } else {
    // M1: chat is routed (and validated) against an empty roster, and nothing is delivered.
    const chatLog = log.child({ component: 'chat' });
    bridge.handle(
      'chat.send',
      createChatSendHandler(
        new ChatRouter(),
        () => ({ playerName: lifecycle.playerName, crew: [], cards: new Map(), meeting: null }),
        (route) => chatLog.info({ scope: route.scope, deliveries: route.deliveries.length }, route.echo),
      ),
    );
    crew = new FakeCrewApi();
    hooks = noCrewHooks();
  }
  orgModule.bindCrew(crew, hooks);

  function snapshot(): ReturnType<NonNullable<WorldLifecycleOptions['snapshot']>> {
    if (agents) {
      const m = agents.manager;
      return { crew: m.crewState().crew, brains: m.brainsSummary(), pending: m.pendingCards() };
    }
    const list = crew.listAgents();
    return {
      crew: list.map((a) => ({
        agentId: a.agentId,
        handle: a.handle,
        name: a.name,
        role: a.role,
        ceo: a.ceo,
        status: a.status,
      })),
      pending: ui ? [...ui.pending.values()].flat() : [],
      ...(scriptedCrew ? { brains: scriptedCrew.brainsSummary() } : {}),
    };
  }

  // --- World events ----------------------------------------------------------------------------------------------
  async function doorOfOpenWorld(): Promise<Place | null> {
    const worldId = opened?.worldId ?? store.current.worldId;
    const known = officeDoor(offices.get(worldId));
    if (known || noDoor.has(worldId)) return known;
    const waitMs = options.officeDoorWaitMs ?? OFFICE_DOOR_WAIT_MS;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        doorWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        noDoor.add(worldId);
        done();
      }, waitMs);
      timer.unref?.();
      doorWaiters.add(done);
    });
    const door = officeDoor(offices.get(worldId));
    if (!door) log.info({ worldId }, 'no office door reported: the agent appears near the player');
    return door;
  }

  function onWorldReady(world: { worldId: string; gen: number }, fresh: boolean): void {
    const key = `${world.worldId}#${gameSession}`;
    if (key === openedKey) return;
    openedKey = key;
    opened = { ...world };
    enqueueWorld('world open', async () => {
      if (agents) {
        const respawn = agents.manager.world?.worldId === world.worldId;
        try {
          await agents.manager.openWorld(world, { respawn });
        } catch (err) {
          // The crew failing to come back must not keep the PCs and the org services out of the world.
          log.error({ err, worldId: world.worldId }, 'the crew could not be restored');
        }
      }
      if (closing) return;
      log.info({ worldId: world.worldId, gen: world.gen, fresh }, 'world opened');
      await pcModule.onWorldOpen?.(world.worldId, fresh);
      await orgModule.onWorldOpen(world.worldId, fresh);
    });
  }

  function onPlayerDied(msg: PayloadOf<'player.died'>): void {
    // Re-sends (the mod repeats player.died until it is acknowledged) and deaths in a world Node did not open are the
    // lifecycle's alone.
    if (opened?.worldId !== msg.worldId || ended.has(msg.worldId)) return;
    const worldId = msg.worldId;
    ended.add(worldId);
    if (agents?.manager.world?.worldId === worldId) {
      // Captured before the lifecycle answers (listeners run before handlers), so world.next lists the crew.
      fates.set(worldId, agents.manager.crewFates());
    }
    enqueueWorld('world end', async () => {
      if (agents?.manager.world?.worldId === worldId) {
        await agents.manager.playerDied({ cause: msg.cause, day: msg.day });
      }
      if (opened?.worldId === worldId) {
        opened = null;
        openedKey = null;
      }
      log.info({ worldId }, 'world ended');
      await pcModule.onWorldEnded?.(worldId);
      await orgModule.onWorldEnded(worldId);
    });
  }

  bridge.on('hello', (msg) => {
    // BootScreen: a new game session (the game restarted), so the next `ready` opens the world again.
    if (msg.phase === 'boot') gameSession++;
    // Seats the mod reports survive a Node-only restart, never an app restart (PLAN §6.3).
    agents?.manager.noteHello(msg.phase);
  });
  bridge.on('world.state', (msg) => {
    if (msg.office) {
      offices.set(msg.worldId, msg.office);
      noDoor.delete(msg.worldId);
      for (const wake of [...doorWaiters]) wake();
    }
    // A dead world's clock (Game Over still pushes `ready` until the world closes) is nobody's business.
    if (msg.clockTime !== undefined && opened?.worldId === msg.worldId && !ended.has(msg.worldId)) {
      const t = msg.clockTime;
      try {
        pcModule.onClock?.(t);
        orgModule.onClock(t);
      } catch (err) {
        log.warn({ err }, 'clock hook failed');
      }
    }
  });
  bridge.on('player.died', (msg) => onPlayerDied(msg));

  // --- Start -----------------------------------------------------------------------------------------------------
  let port: number;
  try {
    await pcModule.start();
    await orgModule.start();
    const dead = store.current;
    if (dead.status === 'dead') {
      // Node restarted on Game Over: the summary lists the crew from the archive, and the modules get the world end
      // they may have missed (onWorldEnded is idempotent).
      ended.add(dead.worldId);
      fates.set(dead.worldId, await fatesFromDisk(paths, dead.worldId));
      enqueueWorld('world end (catch-up)', async () => {
        await pcModule.onWorldEnded?.(dead.worldId);
        await orgModule.onWorldEnded(dead.worldId);
      });
    }
    port = await bridge.start();
    await writeBridgeFile(paths.bridgeFile, { port, token, pid: process.pid });
  } catch (err) {
    ui?.dispose();
    scriptedCrew?.dispose();
    await agents?.dispose().catch(() => {});
    await orgModule.stop().catch(() => {});
    await pcModule.stop().catch(() => {});
    lifecycle.dispose();
    await bridge.close('startup failed').catch(() => {});
    throw err;
  }
  log.info(
    {
      mode: options.mode,
      port,
      bridgeFile: paths.bridgeFile,
      home: paths.appSupport,
      savesDir: options.savesDir,
      crew: crewMode,
      claude: agents ? (agents.claude?.source ?? 'none') : null,
      pcRuntime,
      e2e: options.e2e === true,
      world: store.current.worldId,
    },
    'MineVibe runtime ready',
  );

  let stopping: Promise<void> | null = null;
  return {
    mode: options.mode,
    bridge,
    paths,
    port,
    lifecycle,
    store,
    savesDir: options.savesDir,
    debug: options.e2e ? createDebug(bridge) : null,
    ui,
    scriptedCrew,
    agents,
    pcModule,
    orgModule,
    ctx,
    settled: async () => {
      let seen: Promise<void> | null = null;
      while (seen !== worldChain) {
        seen = worldChain;
        await seen;
      }
    },
    stop(reason = 'quit') {
      stopping ??= (async () => {
        closing = true;
        // A spawn waiting for the office door goes ahead now (it finds the runtime closing and gives up).
        for (const wake of [...doorWaiters]) wake();
        ui?.dispose();
        scriptedCrew?.dispose();
        // Sessions close first (they resume next time) and no new brain starts; then the world event in flight
        // finishes (bounded), so the modules never hear of a world after they stopped; then the services and the
        // bridge.
        await agents?.dispose().catch((err: unknown) => log.warn({ err }, 'agent runtime stop failed'));
        const chainDone = await settlesWithin(worldChain, STOP_WORLD_WAIT_MS);
        if (!chainDone) log.warn('a world event was still running at shutdown');
        await orgModule.stop().catch((err: unknown) => log.warn({ err }, 'org module stop failed'));
        await pcModule.stop().catch((err: unknown) => log.warn({ err }, 'PC module stop failed'));
        lifecycle.dispose();
        await bridge.close(reason);
        await removeBridgeFile(paths.bridgeFile, process.pid);
      })();
      return stopping;
    },
  };
}

/** `envFlag` for callers that read the dev flags (`MINEVIBE_E2E`, `MINEVIBE_SCRIPTED_CREW`). */
export { envFlag };
