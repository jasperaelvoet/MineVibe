/**
 * AgentBrain: everything one agent's mind does between the SDK session and the crew (PLAN §6.1-6.5).
 *
 * - Owns the AgentSession, the SeatFSM, PlanCapture, the Digest and the agent's wake queue.
 * - Gets brain slots from the BrainScheduler for each turn and releases them at `result` and while a card waits.
 * - Applies model/effort swaps only at turn boundaries (sit → Opus/medium, stand → Haiku/xhigh after the 60 s re-sit
 *   debounce, kick/damage/PC down → Haiku at once), with the context guard before a downswap.
 * - Switches the mode (Minecraft / PC / Meeting, agents/modes.ts) at the same boundary: the first turn after it opens
 *   with the new mode's MODE banner, on the swapped model. ToolGate holds every call to the seat's mode.
 * - Builds the ToolGate context, the broker hooks and the `mc` / `pc` tool hosts.
 *
 * The AgentManager creates brains and provides crew-level services through {@link BrainEnv}.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentBody,
  AgentRole,
  Autonomy,
  BrainStatus,
  ModelTier,
  PayloadOf,
  Place,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import { ApiError, agentActor } from '../contracts/common.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';
import type { SkillApi } from '../contracts/SkillApi.js';
import type { BaseArea } from '../world/baseArea.js';
import { AgentSession, type SwapResult } from './AgentSession.js';
import type { BrainScheduler, Grant, WakePriority } from './BrainScheduler.js';
import type { ResolvedClaude } from './claudeBinary.js';
import {
  AGENT_PERMISSION_MODE,
  type BrainProfile,
  BUBBLE_MAX_CHARS,
  CONTEXT_GUARD_RATIO,
  CONTEXT_GUARD_TIMEOUT_MS,
  HAIKU_CONTEXT_TOKENS,
  MAX_SEATED,
  MEETING_SWAP_DEBOUNCE_MS,
  MEETING_TURN_TIMEOUT_MS,
  SEATED_PROFILE,
  WANDERING_PROFILE,
} from './constants.js';
import { Digest, type Routed } from './EventRouter.js';
import { type ControlKind, control, escapeShared, singleLine } from './envelope.js';
import { createInteractionBroker } from './InteractionBroker.js';
import type { HandoffNotes, MemoryStore } from './memory.js';
import { type BrainMode, modeForSeat } from './modes.js';
import type { Card, PendingStore } from './PendingStore.js';
import { PlanCapture } from './PlanCapture.js';
import { BARKS, type BarkKey } from './prompts/barks.js';
import { kickoffMessage } from './prompts/kickoff.js';
import { modeBanner } from './prompts/modes.js';
import { personaPrompt } from './prompts/persona.js';
import { Mutex, type SeatEndReason, SeatFSM, type SeatSnapshot } from './SeatFSM.js';
import type {
  HookCallback,
  PermissionMode,
  QueryFactory,
  SDKResultMessage,
  SDKSystemMessage,
} from './sdk.js';
import { buildSessionOptions } from './sessionOptions.js';
import { createToolGateHook, type GateContext, type GateObservation } from './ToolGate.js';
import type { TranscriptStore } from './TranscriptStore.js';
import { TurnText } from './TurnText.js';
import { type PcToolName, pcToolName } from './tools/catalog.js';
import { createMcServer, type McHost, ticksToGameTime } from './tools/mcServer.js';
import { createPcServer, type PcHost } from './tools/pcServer.js';
import type { UsageGovernor } from './UsageGovernor.js';
import type { ConsentLedger } from './world/consent.js';
import { PerceptionMemory, sceneLine, zoneOfBody } from './world/scene.js';

/** The persisted crew record of one agent (`worlds/<w>/crew.json`). */
export interface AgentRecord {
  readonly agentId: string;
  readonly handle: string;
  name: string;
  readonly role: AgentRole;
  ceo: boolean;
  status: 'alive' | 'dead' | 'dismissed';
  readonly hiredAt: number;
  /** Lower is more senior (succession). */
  readonly seniority: number;
  /** The SDK session id (new sessions are started with it; restarts resume it). */
  sessionId: string;
  /** Whether the session was ever started (resume vs new). */
  sessionStarted: boolean;
  nonce: string;
  autonomy: Autonomy;
  planFirst: boolean;
  /**
   * The player set `planFirst` with the AgentScreen toggle. USER DECISION 2026-10-08: Plan-first is only on when the
   * player turned it on, so a record saved under the old role default (on for CEO and Engineer) loads with it off.
   */
  planFirstByPlayer?: boolean | undefined;
  pingInstead: boolean;
  diedDay?: number | undefined;
  cause?: string | undefined;
  /** The PC the agent sat at when the app stopped (restart notice). */
  lastSeatedPc?: string | null | undefined;
  lastActiveAt?: number | undefined;
}

/** Crew-level services a brain needs (implemented by the AgentManager). */
export interface BrainEnv {
  readonly scheduler: BrainScheduler;
  readonly governor: UsageGovernor;
  readonly pending: PendingStore;
  readonly transcripts: TranscriptStore;
  readonly memory: MemoryStore;
  readonly handoffs: HandoffNotes;
  readonly skills: SkillApi;
  readonly org: OrgApi;
  readonly pcs: PcApi;
  readonly queryFactory: QueryFactory;
  readonly log: Logger;
  now(): number;
  claude(): ResolvedClaude;
  agentEnv(): Record<string, string>;
  /** The agent's claude cwd (`worlds/<w>/agents/<id>/home`). */
  agentHome(agentId: string): string;
  playerName(): string;
  /** Who sits at a PC per the mod's PcRegistry. */
  occupant(pcId: string): string | null;
  /** Agents (other than `agentId`) holding a PC seat. */
  seatedOthers(agentId: string): number;
  body(agentId: string): AgentBody | null;
  clockTime(): number | null;
  /** The Base of the current world (`world.state.office`), for the scene line and perception texts. */
  base?(): BaseArea | null;
  /** Consents to change protected blocks (protocol §7.4.3); without it no job ever carries one. */
  readonly consents?: ConsentLedger | undefined;
  /** Crew messages. */
  tell(from: AgentBrain, to: string, text: string): Promise<string>;
  requestHire(from: AgentBrain, request: Parameters<McHost['requestHire']>[0]): Promise<string>;
  taskReported(from: AgentBrain, report: Parameters<McHost['taskReported']>[0]): void;
  /** UI events. */
  say(payload: PayloadOf<'agent.say'>): void;
  brainChanged(brain: AgentBrain): void;
  /** The session exited on its own (crash): the supervisor decides. */
  sessionExited(brain: AgentBrain, error: Error): void;
  /** Startup assertions failed. */
  assertionsFailed(brain: AgentBrain, problems: readonly string[]): void;
  /** Usage accounting per turn. */
  turnEnded(brain: AgentBrain, result: SDKResultMessage): void;
  /** Every ToolGate decision (activity log, debugging, the live smoke). */
  toolObserved?(brain: AgentBrain, observation: GateObservation): void;
  /** A card went up or ended (approach queue, toasts). */
  cardRaised(brain: AgentBrain, card: Card): void;
  /** `mode` per settings ("subscription" unless API-key mode). */
  authMode(): 'subscription' | 'api_key';
  /** Re-sit debounce override (tests, the live smoke); default 60 s. */
  readonly swapDebounceMs?: number | undefined;
  /** The record changed in a way that must reach `crew.json` now (e.g. the session was created). */
  recordChanged?(brain: AgentBrain): void;
  /**
   * Whether a `pc.seat` for an agent Node thinks is wandering restores the seat (a Node-only "worker" restart, the
   * game kept running) or stands the body up (an app restart: everyone loads unseated). Default true.
   */
  seatRestore?(): boolean;
}

interface QueuedWake {
  readonly priority: WakePriority;
  readonly kind: ControlKind | 'PLAYER';
  readonly text: string;
  readonly key: string | undefined;
  readonly epoch: number | null;
  readonly seq: number;
  /** A meeting turn waiting for what the agent says in the turn this item starts. */
  readonly collector?: TurnCollector | undefined;
}

/** Collects the assistant text of one turn (CrewHooks.meetingTurn). */
interface TurnCollector {
  readonly texts: string[];
  readonly maxSentences: number;
  active: boolean;
  done: boolean;
  timer: NodeJS.Timeout | null;
  readonly resolve: (text: string) => void;
}

/**
 * The first `n` sentences of `text` (whitespace collapsed). A sentence ends at `.`, `!` or `?` (plus closing quotes or
 * brackets) followed by whitespace, so `main.ts`, `v2.1` or `1.5x` inside a sentence never cut it.
 */
export function firstSentences(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0 || n <= 0) return '';
  return flat
    .split(/(?<=[.!?]+["')\]]*) /)
    .slice(0, n)
    .join(' ')
    .trim();
}

/** Job label prefix of a walk to a meeting chair (CrewHooks.pullIntoMeeting). */
const MEETING_SIT_LABEL = 'sit at meeting ';

/** Strikes before a turn that keeps calling tools after "end your turn" is interrupted. */
const PENDING_SWAP_STRIKES = 2;
const TURN_CAP_STRIKES = 3;

/** Seat ends after which the brain stops anyway: no model swap, no compaction. */
const TERMINAL_ENDS: ReadonlySet<SeatEndReason> = new Set(['death', 'world_end', 'dismiss']);

/** How long a tool call waits for the session's startup assertions before it is denied. */
const STARTUP_GATE_WAIT_MS = 15_000;

/** Whether `p` settles within `ms`. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void p.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/**
 * Whether an error result means the subscription's usage ran out (the crew sleeps). Context-length errors ("prompt is
 * too long", "context limit") mention limits too but are not usage.
 */
export function isUsageLimitText(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  if (/context|too long|max_tokens|prompt/i.test(text)) return false;
  return /(usage|rate)[ _-]?limit|hit your (usage )?limit|limit (reached|exceeded)|out of (extra )?usage|quota/i.test(
    text,
  );
}

/**
 * First 1-2 sentences of `text`, at most {@link BUBBLE_MAX_CHARS}. A sentence ends at `.`, `!` or `?` followed by a
 * space or the end, so a dot inside a token (`6.18.35`, `app.ts`) never splits one, and nothing before it is lost.
 */
export function bubbleText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/\S.*?[.!?]+(?=\s|$)|\S.*$/g) ?? [flat];
  let out = sentences.slice(0, 2).join(' ').trim();
  if (out.length === 0) out = flat;
  return out.length > BUBBLE_MAX_CHARS ? `${out.slice(0, BUBBLE_MAX_CHARS - 1)}…` : out;
}

/** One activity line for a tool call ("mine oak_log ×10", "bash: npm test"). */
export function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const short = name.replace(/^mcp__(mc|pc)__/, '');
  const pick = (...keys: string[]) =>
    keys.map((k) => i[k]).find((v) => typeof v === 'string' || typeof v === 'number');
  let detail: unknown;
  switch (short) {
    case 'bash':
      detail = i.description ?? i.command;
      break;
    case 'read':
    case 'write':
    case 'edit':
      detail = i.file_path;
      break;
    default:
      detail = pick(
        'block',
        'item',
        'entity',
        'place',
        'pc',
        'query',
        'title',
        'to',
        'pattern',
        'text',
        'id',
        'mode',
      );
  }
  const count = typeof i.count === 'number' ? ` ×${i.count}` : '';
  const line = detail !== undefined ? `${short}: ${String(detail)}${count}` : short;
  return singleLine(line, 160);
}

function tierOf(model: string | null): ModelTier {
  return model?.includes('opus') ? 'opus' : 'haiku';
}

const CRITICAL_UNSEAT: Partial<
  Record<SeatEndReason, { kind: ControlKind; text: (pc: string, player: string) => string }>
> = {
  kick: {
    kind: 'KICKED',
    text: (pc, p) => `${p} kicked you off ${pc} mid-task. Ask what they want, or do something else.`,
  },
  damage: { kind: 'CRITICAL', text: (pc) => `You got up from ${pc} to fight: you were attacked.` },
  survival: { kind: 'CRITICAL', text: (pc) => `You got up from ${pc} to survive (hunger or a hazard).` },
  pc_down: { kind: 'PC DOWN', text: (pc) => `${pc} went down; you are no longer seated.` },
  player_took: { kind: 'KICKED', text: (pc, p) => `${p} took your chair at ${pc} while you were away.` },
  reservation_expired: {
    kind: 'CRITICAL',
    text: (pc) => `Your reservation at ${pc} expired while you were away.`,
  },
};

export class AgentBrain {
  readonly record: AgentRecord;
  readonly fsm: SeatFSM;
  readonly plans: PlanCapture;
  /** What the agent last said in the current turn: the plan card's fallback (InteractionBroker). */
  readonly turnText: TurnText;
  readonly digest = new Digest();
  /** What this agent's look_around / find showed (the scene line's trees). */
  readonly perception: PerceptionMemory;
  readonly #env: BrainEnv;
  readonly #seatMutex = new Mutex();
  readonly #log: Logger;
  #session: AgentSession | null = null;
  #queue: QueuedWake[] = [];
  #contexts: string[] = [];
  #seq = 0;
  #grant: Grant | null = null;
  #acquiring: WakePriority | null = null;
  /** USER DECISION 2026-10-08: sessions run in bypassPermissions; `plan` only for a plan-first PC session. */
  #trackedMode: PermissionMode = AGENT_PERMISSION_MODE;
  #status: BrainStatus = 'idle';
  #offline = false;
  #assertionsFailed: readonly string[] | null = null;
  /**
   * Settles once the current session's `system/init` arrived and its startup assertions ran; null afterwards. The
   * gate waits for it, so no tool runs before the assertions passed (a hook can reach Node before the init message).
   */
  #startupCheck: Promise<void> | null = null;
  #startupChecked: (() => void) | null = null;
  /** >0 while a turn boundary is queued or running: no new turn starts until its swap is applied. */
  #boundaryHold = 0;
  #activity: string | null = null;
  #turn = { calls: 0, startedAt: 0, pausedAt: 0 as number, pausedMs: 0, pendingStrikes: 0, capStrikes: 0 };
  #waitingCards = new Set<string>();
  readonly #pcEpochs = new Map<PcToolName, number[]>();
  readonly #jobs = new Map<string, string>();
  readonly #turnEndWaiters: ((r: SDKResultMessage) => void)[] = [];
  #debounceTimer: NodeJS.Timeout | null = null;
  #awayTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastEffort: string | null = null;
  #lastSwap: SwapResult | null = null;
  #lastPlayerAt = 0;
  #lastAutonomousAt: number | null = null;
  /** Background `pc__bash` jobs this agent started (`ownJobKey`s: PC and job id), across session restarts. */
  readonly #bashJobs = new Set<string>();
  /** Meeting turns collecting the running turn's text. */
  #collectors: TurnCollector[] = [];
  /** The session is being closed on purpose to resume it with another model (no crash handling). */
  #resuming = false;
  /** The PC an agent pulled into a meeting returns to afterwards. */
  #meetingReturn: { pcId: string; purpose: string | null } | null = null;
  /**
   * The mode the model was last told about (the MODE banner), or null when it must be told again: a new or resumed
   * session, or a compaction that may have summarized the last banner away.
   */
  #announcedMode: BrainMode | null = null;

  constructor(record: AgentRecord, env: BrainEnv) {
    this.record = record;
    this.#env = env;
    this.perception = new PerceptionMemory(() => env.now());
    this.#log = env.log.child({ agentId: record.agentId });
    this.fsm = new SeatFSM({
      now: () => env.now(),
      ...(env.swapDebounceMs !== undefined ? { debounceMs: env.swapDebounceMs } : {}),
    });
    const home = env.agentEnv().HOME ?? '';
    this.plans = new PlanCapture(
      [home, '/home/cua'].filter((h) => h.length > 0),
      { now: () => env.now() },
    );
    this.turnText = new TurnText(() => env.now());
  }

  get agentId(): string {
    return this.record.agentId;
  }

  get session(): AgentSession | null {
    return this.#session;
  }

  get status(): BrainStatus {
    return this.#status;
  }

  get activity(): string | null {
    return this.#activity;
  }

  get trackedMode(): PermissionMode {
    return this.#trackedMode;
  }

  /** The tier the session actually runs (from the stream), haiku before it starts. */
  get model(): ModelTier {
    return tierOf(this.#session?.model ?? null);
  }

  get lastEffort(): string | null {
    return this.#lastEffort;
  }

  get lastSwap(): SwapResult | null {
    return this.#lastSwap;
  }

  /** The mode of the agent's seat right now (what ToolGate enforces). */
  get mode(): BrainMode {
    return modeForSeat(this.fsm.snapshot);
  }

  /** The mode the model was last told about, null until the next turn re-announces it. */
  get announcedMode(): BrainMode | null {
    return this.#announcedMode;
  }

  get queuedWakes(): readonly { priority: WakePriority; kind: string; text: string }[] {
    return this.#queue;
  }

  get offline(): boolean {
    return this.#offline;
  }

  /**
   * False while this brain cannot think at all: stopped, offline after repeated crashes, or halted by the startup
   * assertions (no usable claude, wrong account). A usage pause (asleep until `resetsAt`) still thinks later.
   */
  get canThink(): boolean {
    return !this.#stopped && !this.#offline && this.#assertionsFailed === null;
  }

  /** Ms since the player last addressed this agent (idle nudges). */
  idleMs(now = this.#env.now()): number {
    return now - Math.max(this.#lastPlayerAt, this.record.lastActiveAt ?? 0);
  }

  get lastAutonomousAt(): number | null {
    return this.#lastAutonomousAt;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Starts (or resumes) the SDK session. `contexts` are delivered first as `shouldQuery:false` (memory, roster,
   * restart notice); `wakes` are queued (welcome, kickoff).
   */
  start(
    options: { contexts?: readonly string[]; wakes?: readonly Routed[]; profile?: BrainProfile } = {},
  ): void {
    if (this.#stopped) throw new Error('brain stopped');
    if (this.#session?.started) return;
    this.#offline = false;
    // A (re)start re-runs the startup assertions (e.g. Retry after logging in again).
    this.#assertionsFailed = null;
    let claude: ResolvedClaude;
    try {
      claude = this.#env.claude();
    } catch (err) {
      // No usable claude (missing, too old): the brain stays asleep with a toast; the body keeps its reflexes.
      // Contexts and wakes wait in the queue, so a later Retry (after `claude update` and a restart) loses nothing.
      const problem = err instanceof Error ? err.message : String(err);
      this.#assertionsFailed = [problem];
      this.#log.error({ problem }, 'no usable claude: the brain stays asleep');
      this.#env.assertionsFailed(this, [problem]);
      for (const text of options.contexts ?? []) this.#contexts.push(text);
      for (const w of options.wakes ?? []) this.enqueue(w);
      this.#setStatus();
      return;
    }
    this.#startupChecked?.();
    const startup = new Promise<void>((resolve) => {
      this.#startupChecked = resolve;
    });
    this.#startupCheck = startup;
    void startup.then(() => {
      if (this.#startupCheck === startup) this.#startupCheck = null;
    });
    const env = this.#env;
    const gateHook = createToolGateHook(
      () => this.gateContext(),
      (o) => this.#observeGate(o),
    );
    // Fail closed: no tool runs before the startup assertions of this session have passed.
    const gate: HookCallback = async (input, toolUseId, opts) => {
      const pending = this.#startupCheck;
      if (pending && !(await settlesWithin(pending, STARTUP_GATE_WAIT_MS))) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'MineVibe is still checking this session; try again in a moment.',
          },
        };
      }
      return gateHook(input, toolUseId, opts);
    };
    const persona = personaPrompt({
      name: this.record.name,
      handle: this.record.handle,
      role: this.record.role,
      ceo: this.record.ceo,
      playerName: env.playerName(),
      nonce: this.record.nonce,
    });
    const resume = this.record.sessionStarted ? this.record.sessionId : null;
    const session = new AgentSession(
      {
        agentId: this.agentId,
        options: buildSessionOptions({
          claude,
          env: env.agentEnv(),
          cwd: env.agentHome(this.agentId),
          resume,
          sessionId: this.record.sessionId,
          persona,
          mc: createMcServer(this.#mcHost()),
          pc: createPcServer(this.#pcHost()),
          // A restart (crash, Retry) of a seated agent resumes on the seat's model, not on Haiku until the next boundary.
          profile: options.profile ?? (this.fsm.wantsOpus(env.now()) ? SEATED_PROFILE : WANDERING_PROFILE),
          stderr: (d) => this.#log.debug({ stderr: d.slice(0, 500) }, 'claude stderr'),
        }),
        gate,
        canUseTool: createInteractionBroker({
          agentId: this.agentId,
          store: env.pending,
          plans: this.plans,
          turnText: () => this.turnText.latest(),
          seatEpoch: () => this.fsm.epoch,
          playerName: () => env.playerName(),
          now: () => env.now(),
          hooks: {
            onWaitStart: (card) => this.#onCardWait(card),
            onWaitEnd: (card) => this.#onCardAnswered(card),
            setPermissionMode: async (mode) => {
              this.#trackedMode = mode;
              await this.#session?.setPermissionMode(mode);
            },
          },
        }),
        queryFactory: env.queryFactory,
        log: this.#log,
        now: () => env.now(),
      },
      {
        onInit: (init, first) => this.#onInit(init, first),
        onAssistantText: (text) => this.#onText(text),
        onToolUse: (name, input) => this.#onToolUse(name, input),
        onTurnEnd: (result) => this.#onTurnEnd(result),
        onRateLimit: (info) => env.governor.onRateLimit(info as never),
        onAssistantError: (error) => {
          if (error === 'rate_limit') env.governor.onRejected();
          else if (error === 'authentication_failed' || error === 'oauth_org_not_allowed')
            env.governor.onAuthFailure();
        },
        onModelSwitched: (input) =>
          this.#log.info(
            { from: input.from_model, to: input.to_model, cacheUsd: input.estimated_cache_write_usd },
            'model switched',
          ),
        // The summary may have dropped the last MODE banner: the next turn announces the mode again.
        onCompacted: () => {
          if (this.#session === session) this.#announcedMode = null;
        },
        onExit: (error) => this.#onExit(error),
      },
    );
    this.#session = session;
    this.#trackedMode = AGENT_PERMISSION_MODE;
    // A new or resumed session hears its mode again with its first turn.
    this.#announcedMode = null;
    session.start();
    for (const text of options.contexts ?? []) this.context(text);
    for (const item of this.#contexts.splice(0)) session.send(item, { shouldQuery: false });
    for (const w of options.wakes ?? []) this.enqueue(w);
    this.#setStatus();
    this.#pump();
  }

  /** Closes the session and cancels everything (dismissal, death, world end, shutdown). */
  async stop(reason: string, options: { keepCards?: boolean } = {}): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();
    this.#env.scheduler.cancel(this.agentId);
    this.#grant = null;
    this.#finishCollectors(this.#queue);
    this.#queue = [];
    if (!options.keepCards) {
      this.#env.pending.cleanup(this.agentId, reason, (c) => c.kind === 'question' || c.kind === 'plan');
    }
    const session = this.#session;
    this.#session = null;
    await session?.close();
  }

  /** Closes the session without stopping the brain (the supervisor restarts it). */
  async closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#grant?.release();
    this.#grant = null;
    await session?.close();
  }

  markOffline(): void {
    this.#offline = true;
    this.#grant?.release();
    this.#grant = null;
    this.#setStatus();
  }

  /** Re-evaluates the status (governor and scheduler changes). */
  refresh(): void {
    this.#setStatus();
    this.#pump();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------------------------------------------

  /** Queues one routed item: a wake, a context line or a digest line. */
  enqueue(item: Routed, collector?: TurnCollector): void {
    if (this.#stopped) {
      if (collector) this.#finishCollector(collector);
      return;
    }
    if (item.mode === 'digest') {
      this.digest.push(item.line);
      return;
    }
    if (item.mode === 'context') {
      this.context(item.text);
      return;
    }
    if (item.autonomous) this.#lastAutonomousAt = this.#env.now();
    if (item.now && this.#session?.inTurn) {
      void this.#session.interrupt();
    }
    // A player message during a running turn folds into it at the next tool boundary (`next`).
    if (item.priority === 0 && this.#session?.started && this.#session.inTurn && this.#grant && !item.now) {
      this.#session.send(item.text, { priority: 'next' });
      if (collector) this.#activate(collector);
      return;
    }
    const wake: QueuedWake = {
      priority: item.priority,
      kind: item.kind,
      text: item.text,
      key: item.key,
      epoch: item.kind === 'KICKOFF' ? this.fsm.epoch : null,
      seq: ++this.#seq,
      collector,
    };
    if (item.key !== undefined) this.#queue = this.#queue.filter((q) => q.key !== item.key);
    this.#queue.push(wake);
    this.#setStatus();
    this.#pump();
  }

  /** Adds context without a turn (`shouldQuery:false`); buffered while the session is down. */
  context(text: string): void {
    if (this.#session?.started) this.#session.send(text, { shouldQuery: false });
    else this.#contexts.push(text);
  }

  /**
   * One meeting turn (CrewHooks.meetingTurn): a P0 wake on the interactive lane that runs on its own, and resolves
   * with the agent's text from that turn, cut to `maxSentences`. After `timeoutMs` (queue wait included) the turn is
   * interrupted and the promise resolves with what was said so far.
   */
  meetingTurn(
    prompt: string,
    options: { maxSentences: number; timeoutMs?: number | undefined },
  ): Promise<string> {
    if (!this.canThink) {
      return Promise.reject(new ApiError('BRAIN_OFFLINE', `${this.record.name} cannot think right now.`));
    }
    return new Promise<string>((resolve) => {
      const collector: TurnCollector = {
        texts: [],
        maxSentences: options.maxSentences,
        active: false,
        done: false,
        timer: null,
        resolve,
      };
      collector.timer = setTimeout(() => {
        collector.timer = null;
        if (collector.done) return;
        if (collector.active) {
          if (this.#session?.inTurn) void this.#session.interrupt();
        } else {
          this.#queue = this.#queue.filter((q) => q.collector !== collector);
          this.#setStatus();
        }
        this.#finishCollector(collector);
      }, options.timeoutMs ?? MEETING_TURN_TIMEOUT_MS);
      collector.timer.unref?.();
      this.enqueue(
        {
          mode: 'wake',
          priority: 0,
          kind: 'MEETING',
          text: control(this.record.nonce, 'MEETING', prompt),
        },
        collector,
      );
    });
  }

  #activate(collector: TurnCollector): void {
    if (collector.done || collector.active) return;
    collector.active = true;
    this.#collectors.push(collector);
  }

  #finishCollector(collector: TurnCollector): void {
    if (collector.done) return;
    collector.done = true;
    if (collector.timer) clearTimeout(collector.timer);
    collector.timer = null;
    this.#collectors = this.#collectors.filter((c) => c !== collector);
    collector.resolve(firstSentences(collector.texts.join(' '), collector.maxSentences));
  }

  /** Ends every active collector, and those of `items` (dropped queue items). */
  #finishCollectors(items: readonly QueuedWake[]): void {
    for (const c of [...this.#collectors]) this.#finishCollector(c);
    for (const item of items) if (item.collector) this.#finishCollector(item.collector);
  }

  /** The player addressed this agent (debounced by the caller). */
  playerMessage(
    texts: readonly string[],
    mode: 'wake' | 'context',
    chatMode: 'chat' | 'reply' | 'task' | 'interrupt' = 'chat',
  ): void {
    const player = this.#env.playerName();
    this.#lastPlayerAt = this.#env.now();
    this.#lastAutonomousAt = null;
    const lead =
      chatMode === 'task'
        ? `New task from ${player}`
        : chatMode === 'interrupt'
          ? `${player} interrupts you`
          : player;
    const body = texts.map((t) => escapeShared(t)).join('\n');
    const text = `${lead}: ${body}`;
    if (mode === 'context') {
      this.context(
        `${control(this.record.nonce, 'CONTEXT', `${player} said to everyone (not for you to act on unless relevant):`)}\n${body}`,
      );
      return;
    }
    if (chatMode === 'task')
      void this.#env.skills.cancelSkill(this.agentId, { reason: 'new task' }).catch(() => {});
    this.enqueue({ mode: 'wake', priority: 0, kind: 'PLAYER', text, now: chatMode === 'interrupt' });
  }

  /** A job this agent started (returned `running`) is tracked for [JOB DONE]. */
  jobLabel(jobId: string): string | undefined {
    return this.#jobs.get(jobId);
  }

  forgetJob(jobId: string): void {
    this.#jobs.delete(jobId);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------------------------------------------

  gateContext(): GateContext {
    const t = this.#turn;
    const now = this.#env.now();
    const paused = t.pausedAt > 0 ? now - t.pausedAt : 0;
    return {
      agentId: this.agentId,
      ceo: this.record.ceo,
      seat: this.fsm.snapshot,
      occupant: (pcId) => this.#env.occupant(pcId),
      trackedMode: this.#trackedMode,
      plans: this.plans,
      turn: {
        calls: t.calls,
        activeMs: t.startedAt > 0 ? Math.max(0, now - t.startedAt - t.pausedMs - paused) : 0,
      },
      playerName: this.#env.playerName(),
      halted: this.#assertionsFailed ? (this.#assertionsFailed[0] ?? 'startup check failed') : null,
    };
  }

  #observeGate(o: GateObservation): void {
    this.#env.toolObserved?.(this, o);
    this.#turn.calls++;
    if (o.effort) this.#lastEffort = o.effort;
    if (
      o.permissionMode === 'plan' ||
      o.permissionMode === 'default' ||
      o.permissionMode === AGENT_PERMISSION_MODE
    ) {
      // The CLI's own view wins (e.g. after ExitPlanMode it switched itself). USER DECISION 2026-10-08: the normal
      // mode is bypassPermissions, which must be tracked too (or a stale 'plan' would outlive an approved plan).
      this.#trackedMode = o.permissionMode;
    }
    const pc = pcToolName(o.toolName);
    if (o.decision.behavior === 'allow' && pc !== null) {
      const list = this.#pcEpochs.get(pc) ?? [];
      list.push(this.fsm.epoch);
      this.#pcEpochs.set(pc, list);
    }
    if (o.decision.behavior === 'deny') {
      if (o.decision.code === 'pending_swap' && ++this.#turn.pendingStrikes >= PENDING_SWAP_STRIKES) {
        void this.#session?.interrupt();
      }
      if (o.decision.code === 'turn_cap' && ++this.#turn.capStrikes >= TURN_CAP_STRIKES) {
        void this.#session?.interrupt();
      }
    }
  }

  /** The seat a `pc` handler may use: seated, and the same epoch the gate allowed the call under. */
  #pcAccess(tool: PcToolName): { pcId: string; epoch: number } | null {
    const allowedAt = this.#pcEpochs.get(tool)?.shift();
    const s = this.fsm.snapshot;
    if (!this.fsm.hasPcAccess || s.pcId === null) return null;
    if (allowedAt !== undefined && allowedAt !== s.epoch) return null;
    if (this.#env.occupant(s.pcId) !== this.agentId) return null;
    return { pcId: s.pcId, epoch: s.epoch };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Turns and slots
  // ---------------------------------------------------------------------------------------------------------------

  #pump(): void {
    const session = this.#session;
    if (
      this.#stopped ||
      this.#offline ||
      this.#assertionsFailed ||
      !session?.started ||
      session.inTurn ||
      this.#grant ||
      this.#boundaryHold > 0
    )
      return;
    if (this.#queue.length === 0) {
      this.#setStatus();
      return;
    }
    const best = Math.min(...this.#queue.map((q) => q.priority)) as WakePriority;
    if (this.#acquiring !== null) {
      if (best < this.#acquiring) {
        this.#acquiring = best;
        this.#env.scheduler.acquire(this.agentId, best).catch(() => {});
      }
      return;
    }
    this.#acquiring = best;
    this.#setStatus();
    this.#env.scheduler.acquire(this.agentId, best).then(
      (grant) => {
        this.#acquiring = null;
        // The scheduler hands an agent's held grant back, so never release the one a running turn owns.
        const drop = () => {
          if (this.#grant !== grant) grant.release();
          this.#setStatus();
        };
        if (this.#stopped || !this.#session?.started) {
          drop();
          return;
        }
        if (this.#session.inTurn) {
          // A turn started meanwhile (e.g. an answered card resumed it): it runs on this slot.
          if (this.#grant && this.#grant !== grant) grant.release();
          else this.#grant = grant;
          this.#setStatus();
          return;
        }
        if (this.#queue.length === 0 || this.#boundaryHold > 0 || this.#assertionsFailed) {
          // A turn boundary is swapping the model: it pumps again when done.
          drop();
          return;
        }
        this.#grant = grant;
        this.#startTurn();
      },
      () => {
        this.#acquiring = null;
      },
    );
  }

  #startTurn(): void {
    const session = this.#session;
    if (!session) return;
    const epoch = this.fsm.epoch;
    const live = this.#queue.filter((q) => q.epoch === null || q.epoch === epoch);
    // A meeting turn runs on its own: what the agent says in it is the meeting's answer.
    const meeting = live.filter((q) => q.collector !== undefined);
    const items = (meeting.length > 0 ? meeting : live).sort(
      (a, b) => a.priority - b.priority || a.seq - b.seq,
    );
    this.#queue = meeting.length > 0 ? live.filter((q) => q.collector === undefined) : [];
    if (items.length === 0) {
      this.#grant?.release();
      this.#grant = null;
      this.#setStatus();
      return;
    }
    const parts: string[] = [];
    const mode = modeForSeat(this.fsm.snapshot);
    const banner = this.#modeBanner(mode);
    if (banner) parts.push(banner);
    const digest = meeting.length > 0 ? null : this.digest.take(this.record.nonce, this.scene());
    if (digest) parts.push(digest);
    for (const item of items) {
      parts.push(item.text);
      if (item.collector) this.#activate(item.collector);
    }
    this.#turn = {
      calls: 0,
      startedAt: this.#env.now(),
      pausedAt: 0,
      pausedMs: 0,
      pendingStrikes: 0,
      capStrikes: 0,
    };
    this.record.lastActiveAt = this.#env.now();
    // Gate epochs of calls whose handler never ran (e.g. rejected input) must not leak into this turn.
    this.#pcEpochs.clear();
    session.send(parts.join('\n\n'));
    if (banner) {
      this.#log.info({ from: this.#announcedMode, to: mode, model: session.model }, 'mode switched');
      this.#announcedMode = mode;
    }
    this.bark(BARKS.wake);
    this.#setStatus();
  }

  /**
   * The MODE banner when `mode` is not the one the model last heard about (agents/modes.ts), else null. Turns start
   * only after the turn boundary (and its swap) ran, so the banner of a sit or stand rides on the first turn of the
   * swapped model, ahead of the kickoff or wake in the same message.
   */
  #modeBanner(mode: BrainMode): string | null {
    if (mode === this.#announcedMode) return null;
    return modeBanner(mode, { nonce: this.record.nonce, playerName: this.#env.playerName() });
  }

  #onTurnEnd(result: SDKResultMessage): void {
    this.turnText.reset();
    this.#env.turnEnded(this, result);
    for (const w of this.#turnEndWaiters.splice(0)) w(result);
    this.#finishCollectors([]);
    if (result.is_error && result.subtype === 'success' && isUsageLimitText(result.result)) {
      this.#env.governor.onRejected();
    }
    const more = (result.queued_turn_count ?? 0) > 0;
    if (!more) {
      this.#grant?.release();
      this.#grant = null;
      this.#pcEpochs.clear();
    }
    this.#turn = {
      calls: 0,
      startedAt: more ? this.#env.now() : 0,
      pausedAt: 0,
      pausedMs: 0,
      pendingStrikes: 0,
      capStrikes: 0,
    };
    if (!more) this.#activity = null;
    this.#setStatus();
    if (!more) void this.#runBoundary();
  }

  /**
   * Queues the turn boundary on the seat mutex. From now until it ran, no new turn starts (#pump is held), so a wake
   * that arrives meanwhile can never start a turn before the swap, the plan mode and the kickoff are in place.
   */
  #runBoundary(): Promise<void> {
    this.#boundaryHold++;
    return this.#seatMutex
      .run(() => this.#boundary())
      .catch((err: unknown) => this.#log.error({ err }, 'turn boundary failed'))
      .finally(() => {
        this.#boundaryHold--;
        this.#pump();
      });
  }

  #onCardWait(card: Card): void {
    this.#waitingCards.add(card.id);
    if (this.#turn.pausedAt === 0) this.#turn.pausedAt = this.#env.now();
    this.#grant?.release();
    this.#grant = null;
    this.bark(BARKS.question);
    this.#env.cardRaised(this, card);
    this.#setStatus();
  }

  async #onCardAnswered(card: Card): Promise<void> {
    this.#waitingCards.delete(card.id);
    if (this.#turn.pausedAt > 0) {
      this.#turn.pausedMs += this.#env.now() - this.#turn.pausedAt;
      this.#turn.pausedAt = 0;
    }
    this.#setStatus();
    // An answered card resumes at P0 on the interactive lane.
    const session = this.#session;
    const grant = await this.#env.scheduler.acquire(this.agentId, 0);
    if (this.#stopped || this.#session !== session || !session?.inTurn) {
      // The turn ended while the slot was coming (interrupt, kick, crash, stop): nothing runs on it.
      if (this.#grant !== grant) grant.release();
      this.#setStatus();
      this.#pump();
      return;
    }
    if (this.#grant && this.#grant !== grant) grant.release();
    else this.#grant = grant;
    this.#setStatus();
  }

  /** A card of this agent ended without its waiter continuing (cleanup) or was answered. */
  cardGone(cardId: string): void {
    if (this.#waitingCards.delete(cardId)) this.#setStatus();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------------------------------------------

  #onInit(init: SDKSystemMessage, first: boolean): void {
    if (!first || !this.#session) return;
    // From now on a restart resumes this session (persisted at once: a crash must not re-create it).
    if (!this.record.sessionStarted) {
      this.record.sessionStarted = true;
      this.#env.recordChanged?.(this);
    }
    const session = this.#session;
    const checked = this.#startupChecked;
    void session
      .checkStartup(init, this.#env.authMode())
      .then(
        (problems) => {
          if (problems.length > 0) this.#halt(session, problems);
        },
        (err: unknown) =>
          this.#halt(session, [`startup check failed (${err instanceof Error ? err.message : String(err)})`]),
      )
      .finally(() => checked?.());
  }

  /**
   * Startup assertions failed (PLAN §6.1): the brain stays asleep. The running turn is interrupted, the claude process
   * closed (no more spending), every tool call is denied and nothing new starts until Retry starts a fresh session.
   */
  #halt(session: AgentSession, problems: readonly string[]): void {
    this.#assertionsFailed = problems;
    this.#log.error({ problems }, 'startup assertions failed');
    this.#env.assertionsFailed(this, problems);
    this.#setStatus();
    if (this.#session !== session) return;
    void session
      .interrupt()
      .then(() => (this.#session === session ? this.closeSession() : undefined))
      .catch((err: unknown) => this.#log.warn({ err }, 'closing the halted session failed'))
      .finally(() => this.#setStatus());
  }

  #onText(text: string): void {
    const trimmed = text.trim();
    this.#env.transcripts.append(this.agentId, { kind: 'agent', text: trimmed });
    if (/^\(?silent\)?\.?$/i.test(trimmed)) return;
    this.turnText.text(trimmed);
    for (const c of this.#collectors) c.texts.push(trimmed);
    const bubble = bubbleText(trimmed);
    if (bubble.length === 0) return;
    this.#env.say({
      agentId: this.agentId,
      text: bubble,
      style: 'speech',
      ttlMs: Math.min(20_000, Math.max(4_000, bubble.length * 70)),
    });
  }

  #onToolUse(name: string, input: unknown): void {
    this.turnText.toolUse(name);
    const line = describeTool(name, input);
    this.#activity = line;
    this.#env.transcripts.append(this.agentId, { kind: 'activity', text: line });
    this.#env.brainChanged(this);
  }

  #onExit(error: Error | null): void {
    this.turnText.reset();
    this.#grant?.release();
    this.#grant = null;
    this.#acquiring = null;
    for (const w of this.#turnEndWaiters.splice(0))
      w({ subtype: 'error_during_execution' } as SDKResultMessage);
    // A meeting turn in flight ends with what was said so far.
    this.#finishCollectors([]);
    if (this.#resuming) {
      // Closed on purpose to resume with another model (PLAN §6.3 fallback): nothing was lost.
      this.#setStatus();
      return;
    }
    if (!this.#stopped) {
      // A crash: questions are re-asked (stale), plans die with the turn.
      this.#env.pending.markStale(this.agentId);
      this.#env.pending.cleanup(
        this.agentId,
        'The brain restarted.',
        (c, e) => c.kind === 'plan' && !e.stale,
      );
    }
    this.#waitingCards.clear();
    if (error && !this.#stopped) {
      this.#log.warn({ err: error.message }, 'session ended unexpectedly');
      if (/No conversation found/i.test(error.message)) {
        // The session to resume never got written (e.g. the first launch failed): start a new one.
        this.record.sessionStarted = false;
        this.record.sessionId = randomUUID();
      }
      this.#session = null;
      this.#env.sessionExited(this, error);
    }
    this.#setStatus();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------------------------------------------

  #setStatus(): void {
    const prev = this.#status;
    const session = this.#session;
    for (const id of [...this.#waitingCards])
      if (this.#env.pending.get(id) === undefined) this.#waitingCards.delete(id);
    let next: BrainStatus;
    if (this.#offline) next = 'offline';
    else if (this.#env.governor.mode === 'asleep' || this.#assertionsFailed) next = 'asleep';
    else if (this.#waitingCards.size > 0) next = 'waiting_player';
    else if (session?.inTurn && this.#grant) next = 'thinking';
    else if (this.#queue.length > 0 || this.#acquiring !== null) next = 'queued';
    else next = 'idle';
    this.#status = next;
    if (next !== prev) this.#env.brainChanged(this);
  }

  /** The `agent.brain` payload. */
  brainPayload(): PayloadOf<'agent.brain'> {
    return {
      agentId: this.agentId,
      model: this.model,
      status: this.#status,
      activity: this.#activity,
      autonomy: this.record.autonomy,
      planFirst: this.record.planFirst,
      pingInstead: this.record.pingInstead,
    };
  }

  bark(bark: BarkKey): void {
    this.#env.say({ agentId: this.agentId, bark, style: 'bark', ttlMs: 3000 });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Seats (PLAN §6.3)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The turn boundary: swap model/effort when the seat asks for it, then finish pending seat transitions (and queue
   * the kickoff after a sit). Runs under the seat mutex.
   */
  async #boundary(): Promise<void> {
    const session = this.#session;
    if (!session?.started || this.#stopped) return;
    if (session.inTurn) return;
    this.#boundaryHold++;
    try {
      const s = this.fsm.snapshot;
      // A dying, dismissed or ending brain is about to stop: no swap, and never a compaction.
      const ending = s.lastEnd !== null && TERMINAL_ENDS.has(s.lastEnd) && !this.fsm.holdsPcSeat;
      const target = this.fsm.wantsOpus(this.#env.now()) ? SEATED_PROFILE : WANDERING_PROFILE;
      if (!ending && tierOf(session.model) !== target.tier) {
        if (target.tier === 'haiku') await this.#contextGuard();
        if (this.#session !== session || !session.started || session.inTurn) return;
        try {
          this.#lastSwap = await session.applyProfile(target);
          this.#log.info({ swap: this.#lastSwap }, 'brain swapped');
        } catch (err) {
          this.#log.error({ err }, 'applyFlagSettings failed: closing and resuming with the new model');
          await this.#resumeWithProfile(target);
        }
        this.#env.brainChanged(this);
      }
      // Sat at a PC: plan mode and the bark also apply to a quick re-sit that needed no swap (debounce).
      if (this.fsm.state === 'seated_pending_swap' && this.fsm.snapshot.kind === 'pc') {
        if (this.record.planFirst && this.#trackedMode !== 'plan') await this.#setMode('plan');
        this.bark(BARKS.satAtPc);
      }
      // USER DECISION 2026-10-08: leaving a PC (or a plan) returns to bypassPermissions, never 'default'.
      if (this.fsm.state === 'standing_pending_swap' && this.#trackedMode !== AGENT_PERMISSION_MODE)
        await this.#setMode(AGENT_PERMISSION_MODE);
      // Pulled from a PC into a meeting: no plan mode at the table (it comes back with the PC).
      if (this.fsm.snapshot.kind === 'meeting' && this.#trackedMode === 'plan')
        await this.#setMode(AGENT_PERMISSION_MODE);
      const t = this.fsm.boundary();
      if (t?.to === 'seated') await this.#queueKickoff(t.snapshot);
      if (t?.to === 'wandering') this.plans.clear();
      this.#scheduleDebounce();
    } finally {
      this.#boundaryHold--;
      if (this.#boundaryHold === 0) queueMicrotask(() => this.#pump());
    }
  }

  /**
   * PLAN §6.3 fallback when the flag-layer swap fails: T3 Code's `close()` + `resume` with the explicit model and
   * effort. Runs at a turn boundary (no turn, no card waiting), so nothing is lost: the conversation resumes from the
   * persisted session, queued wakes and buffered context carry over, and the startup assertions run again.
   */
  async #resumeWithProfile(profile: BrainProfile): Promise<void> {
    const old = this.#session;
    if (!old || this.#stopped) return;
    const t0 = this.#env.now();
    this.#resuming = true;
    try {
      await this.closeSession();
    } finally {
      this.#resuming = false;
    }
    if (this.#stopped) return;
    try {
      this.start({ profile });
    } catch (err) {
      this.#log.error({ err }, 'resume with the new model failed');
      return;
    }
    this.#lastSwap = {
      from: old.model,
      to: profile.model,
      ms: this.#env.now() - t0,
      acked: false,
      estimatedCacheWriteUsd: null,
      resumed: true,
    };
    this.#log.info({ swap: this.#lastSwap }, 'brain swapped by close + resume');
  }

  async #setMode(mode: PermissionMode): Promise<void> {
    this.#trackedMode = mode;
    try {
      await this.#session?.setPermissionMode(mode);
    } catch (err) {
      this.#log.warn({ err, mode }, 'setPermissionMode failed');
    }
  }

  /**
   * Before Opus→Haiku: compact when the context exceeds ~70% of Haiku's window [U S3]. The `/compact` result always
   * ends its turn (a command), and the wait is capped so the seat mutex can never wedge on it.
   */
  async #contextGuard(): Promise<void> {
    const session = this.#session;
    const used = session?.lastUsage?.contextTokens ?? 0;
    if (!session || used <= CONTEXT_GUARD_RATIO * HAIKU_CONTEXT_TOKENS) return;
    this.#log.info({ used }, 'compacting before the downswap');
    const ended = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#log.warn('compaction did not finish in time; the swap waits for its turn to end');
        resolve();
      }, CONTEXT_GUARD_TIMEOUT_MS);
      timer.unref?.();
      this.#turnEndWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    session.send('/compact', { command: true });
    await ended;
  }

  #scheduleDebounce(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
    const s = this.fsm.snapshot;
    const now = this.#env.now();
    if (this.model !== 'opus' || s.debounceUntil <= now || this.fsm.holdsPcSeat) return;
    this.#debounceTimer = setTimeout(
      () => {
        this.#debounceTimer = null;
        if (this.#session?.inTurn) return; // the turn's own boundary swaps
        void this.#runBoundary();
      },
      s.debounceUntil - now + 5,
    );
    this.#debounceTimer.unref?.();
  }

  async #queueKickoff(seat: SeatSnapshot): Promise<void> {
    if (seat.pcId === null) return;
    const pcId = seat.pcId;
    const env = this.#env;
    let info: Awaited<ReturnType<PcApi['info']>>;
    try {
      info = await env.pcs.info(pcId);
    } catch (err) {
      this.#log.warn({ err, pcId }, 'kickoff: PC info failed');
      return;
    }
    const primary = info.mounts.find((m) => m.mode === 'rw') ?? info.mounts[0];
    let claudeMd: { path: string; text: string } | null = null;
    if (primary) {
      const path = `${primary.hostPath.replace(/\/+$/, '')}/CLAUDE.md`;
      try {
        const res = await env.pcs.readFile(pcId, { path, limit: 400 });
        if (res.content.trim().length > 0) claudeMd = { path, text: res.content };
      } catch {
        // no CLAUDE.md
      }
    }
    const handoffs = [
      ...(await env.handoffs.list(pcId)),
      ...(primary ? await env.handoffs.list(primary.hostPath) : []),
    ].sort((a, b) => a.at - b.at);
    this.enqueue({
      mode: 'wake',
      priority: 1,
      kind: 'KICKOFF',
      key: 'kickoff',
      text: kickoffMessage({
        nonce: this.record.nonce,
        playerName: env.playerName(),
        pc: info,
        task: seat.purpose,
        planFirst: this.record.planFirst,
        claudeMd,
        handoffs,
      }),
    });
  }

  /** `mcp__mc__sit_at_pc` (PLAN §6.3 "Sitting"). */
  sitAtPc(request: { pcId: string; purpose: string; waitMs: number }): Promise<string> {
    const env = this.#env;
    return this.#seatMutex
      .run(async () => {
        if (this.fsm.state !== 'wandering' && this.fsm.state !== 'standing_pending_swap') {
          throw new ApiError('SEATED', 'You are already seated or on your way to a chair.');
        }
        let status: string;
        try {
          status = (await env.pcs.info(request.pcId)).status;
        } catch (err) {
          throw new ApiError(
            'PC_UNKNOWN',
            `There is no PC called ${request.pcId}. ${err instanceof Error ? err.message : ''}`.trim(),
          );
        }
        if (status !== 'running') throw new ApiError('PC_DOWN', `${request.pcId} is ${status}, not running.`);
        if (env.seatedOthers(this.agentId) >= MAX_SEATED) {
          throw new ApiError(
            'SEAT_CAP',
            `${MAX_SEATED} agents already sit at PCs; wait for one to stand up.`,
          );
        }
        const occupant = env.occupant(request.pcId);
        if (occupant === 'player')
          throw new ApiError('OCCUPIED_BY_PLAYER', `${env.playerName()} sits at ${request.pcId}.`);
        if (occupant !== null && occupant !== this.agentId)
          throw new ApiError('RESERVED', `${request.pcId} is taken.`);
        const jobId = `sit-${randomUUID().slice(0, 8)}`;
        const t = this.fsm.beginSit({ kind: 'pc', pcId: request.pcId }, { purpose: request.purpose, jobId });
        try {
          await env.skills.seat({
            agentId: this.agentId,
            seatEpoch: t.epoch,
            target: { kind: 'pc', pcId: request.pcId },
            purpose: singleLine(request.purpose, 200),
            jobId,
          });
        } catch (err) {
          this.fsm.sitFailed();
          throw err;
        }
        return jobId;
      })
      .then(async (jobId) => {
        let end: Awaited<ReturnType<SkillApi['awaitJob']>> | null = null;
        try {
          end = await env.skills.awaitJob(jobId, request.waitMs);
        } catch {
          end = null;
        }
        if (end === null) {
          this.#jobs.set(jobId, `sit at ${request.pcId}`);
          return `Walking to ${request.pcId} (job ${jobId}). You'll get [SEATED] when you sit: end your turn now.`;
        }
        return this.#seatSettled(jobId, end.status === 'done', end.error?.msg ?? end.status);
      });
  }

  /** The sit job ended (from the tool, or later from `skill.result`). */
  async #seatSettled(jobId: string, ok: boolean, detail: string): Promise<string> {
    return this.#seatMutex.run(async () => {
      const s = this.fsm.snapshot;
      if (s.jobId !== jobId || s.state !== 'walking_to_seat') {
        const seated = s.jobId === jobId && (s.state === 'seated_pending_swap' || s.state === 'seated');
        if (ok && seated)
          return `Seated at ${s.pcId}. End your turn now; your PC session starts with your next turn.`;
        return ok ? 'You are no longer on your way to that chair.' : `Could not sit: ${detail}.`;
      }
      const where = s.kind === 'meeting' ? 'the meeting table' : (s.pcId ?? 'the chair');
      if (!ok) {
        this.fsm.sitFailed();
        throw new ApiError('UNREACHABLE', `Could not sit at ${where}: ${detail}.`);
      }
      this.fsm.arrived();
      if (!this.#session?.inTurn) await this.#boundary();
      this.#pump();
      if (s.kind === 'meeting') return 'Seated at the meeting table.';
      return `Seated at ${s.pcId}. End your turn now; your PC session starts with your next turn.`;
    });
  }

  /** A sit job that outlived its tool call ended. */
  async sitJobEnded(jobId: string, ok: boolean, detail: string): Promise<void> {
    const meeting = this.#jobs.get(jobId)?.startsWith(MEETING_SIT_LABEL) === true;
    this.#jobs.delete(jobId);
    if (meeting && !ok) {
      // The org services asked for this walk, not the agent: no [JOB FAILED] wake. An agent pulled off its PC goes
      // back to it (and dials in from there).
      await this.#seatSettled(jobId, ok, detail).catch(() => '');
      this.#log.info({ jobId, detail }, 'no meeting chair reached');
      this.#returnToPc('the meeting chair could not be reached');
      return;
    }
    try {
      const text = await this.#seatSettled(jobId, ok, detail);
      if (!ok)
        this.enqueue({
          mode: 'wake',
          priority: 3,
          kind: 'JOB FAILED',
          text: control(this.record.nonce, 'JOB FAILED', text),
        });
    } catch (err) {
      this.enqueue({
        mode: 'wake',
        priority: 3,
        kind: 'JOB FAILED',
        text: control(this.record.nonce, 'JOB FAILED', err instanceof Error ? err.message : String(err)),
      });
    }
  }

  /** The mod says the body sat down (`pc.seat`). */
  async seatedByMod(pcId: string, epoch: number | undefined): Promise<void> {
    await this.#seatMutex.run(async () => {
      const s = this.fsm.snapshot;
      if (epoch !== undefined && epoch < s.epoch) {
        // A late pc.seat for a sit this agent already gave up (stood up, cancelled the walk, kicked): the seat is
        // over for Node, so stand the body up instead of re-seating a brain that thinks it wanders.
        this.#log.info({ pcId, epoch, current: s.epoch }, 'stale pc.seat: standing the body up');
        await this.#env.skills
          .unseat({ agentId: this.agentId, seatEpoch: epoch, reason: 'stand', keepReservation: false })
          .catch((err: unknown) => this.#log.warn({ err }, 'unseat (stale seat) failed'));
        return;
      }
      if (s.state === 'walking_to_seat' && s.pcId === pcId && (epoch === undefined || epoch === s.epoch)) {
        this.fsm.arrived();
        if (!this.#session?.inTurn) await this.#boundary();
        return;
      }
      if (s.state === 'wandering' && epoch !== undefined) {
        if (this.#env.seatRestore?.() === false) {
          // App restart (the game booted again): everyone loads unseated (PLAN §6.3), so the body stands up.
          this.#log.info({ pcId, epoch }, 'seated after an app restart: standing the body up');
          await this.#env.skills
            .unseat({
              agentId: this.agentId,
              seatEpoch: epoch,
              reason: 'app_restart',
              keepReservation: false,
            })
            .catch((err: unknown) => this.#log.warn({ err }, 'unseat (app restart) failed'));
          return;
        }
        // Worker restart: the mod still has the agent in the chair.
        this.fsm.restoreSeated(pcId, epoch);
        this.context(
          control(this.record.nonce, 'RESTARTED', `MineVibe restarted; you are still seated at ${pcId}.`),
        );
        if (!this.#session?.inTurn) await this.#boundary();
      }
    });
    this.#pump();
  }

  /** `mcp__mc__stand_up`. */
  standUp(): Promise<string> {
    return this.#seatMutex.run(async () => {
      const s = this.fsm.snapshot;
      if (s.state === 'wandering' || s.state === 'standing_pending_swap') return 'You are not seated.';
      if (s.state === 'walking_to_seat') {
        if (s.jobId)
          await this.#env.skills
            .cancelSkill(this.agentId, { jobId: s.jobId, reason: 'stand_up' })
            .catch(() => []);
        this.fsm.stand('stand');
        return 'Cancelled: you are no longer walking to the chair.';
      }
      await this.#env.skills
        .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'stand', keepReservation: false })
        .catch((err: unknown) => this.#log.warn({ err }, 'unseat failed'));
      this.fsm.stand('stand');
      if (!this.#session?.inTurn) await this.#boundary();
      return s.kind === 'pc'
        ? `Stood up from ${s.pcId}: Minecraft mode, your PC tools stop now. Tell ${this.#env.playerName()} the result if you haven't.`
        : 'You left the meeting chair: Minecraft mode.';
    });
  }

  /**
   * The seat ended without the agent asking (`pc.unseat` from the mod: kick, damage, survival, PC down, player took
   * the chair, reservation expired, death, world end, dismissal). PLAN §6.3: interrupt, kill the agent's tagged guest
   * processes, purge the stale kickoff, deny the pending plan card, swap to Haiku and wake with a critical notice.
   */
  async seatLost(reason: SeatEndReason, options: { releaseReservation?: boolean } = {}): Promise<void> {
    await this.#seatMutex.run(async () => {
      const before = this.fsm.snapshot;
      if (before.state === 'wandering' || before.state === 'standing_pending_swap') return;
      if (before.state === 'away_from_seat' && reason === 'away') return;
      // The away timer fired but the agent sat back down meanwhile.
      if (reason === 'reservation_expired' && before.state !== 'away_from_seat') return;
      if (options.releaseReservation) {
        // Node's own 3-minute expiry: the mod still holds the chair ("BRB") until told otherwise.
        await this.#env.skills
          .unseat({
            agentId: this.agentId,
            seatEpoch: before.epoch,
            reason: 'reservation_expired',
            keepReservation: false,
          })
          .catch((err: unknown) => this.#log.warn({ err }, 'unseat (release reservation) failed'));
      }
      this.fsm.stand(reason);
      if (this.#awayTimer) clearTimeout(this.#awayTimer);
      this.#awayTimer = null;
      if (reason === 'stand') {
        if (!this.#session?.inTurn) await this.#boundary();
        return;
      }
      if (this.#session?.inTurn) await this.#session.interrupt();
      if (before.kind === 'pc' && before.pcId) {
        await this.#env.pcs
          .kill(before.pcId, { tag: `${this.agentId}:${before.epoch}` })
          .catch((err: unknown) => this.#log.warn({ err }, 'kill tagged processes failed'));
      }
      this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
      this.#env.pending.cleanup(this.agentId, `Not seated any more (${reason}).`, (c) => c.kind === 'plan');
      this.plans.clear();
      const notice = CRITICAL_UNSEAT[reason];
      if (reason === 'kick') this.bark(BARKS.kicked);
      if (notice && before.pcId) {
        this.enqueue({
          mode: 'wake',
          priority: 2,
          kind: notice.kind,
          key: `unseat:${reason}`,
          text: control(this.record.nonce, notice.kind, notice.text(before.pcId, this.#env.playerName())),
        });
      }
      if (!this.#session?.inTurn) await this.#boundary();
    });
    this.#pump();
  }

  /** `seated → away_from_seat`: the agent walks over to ask the player (chair stays reserved, model stays Opus). */
  async goAway(): Promise<boolean> {
    return this.#seatMutex.run(async () => {
      if (this.fsm.state !== 'seated') return false;
      const s = this.fsm.snapshot;
      await this.#env.skills
        .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'away', keepReservation: true })
        .catch((err: unknown) => this.#log.warn({ err }, 'unseat(away) failed'));
      const t = this.fsm.goAway();
      const ms = (t.snapshot.awayExpiresAt ?? this.#env.now()) - this.#env.now();
      this.#awayTimer = setTimeout(
        () => {
          this.#awayTimer = null;
          void this.seatLost('reservation_expired', { releaseReservation: true });
        },
        Math.max(0, ms),
      );
      this.#awayTimer.unref?.();
      return true;
    });
  }

  /** The answer came; walk back and sit with no swap (`away_from_seat → seated`). */
  async comeBack(): Promise<boolean> {
    return this.#seatMutex.run(async () => {
      if (this.fsm.state !== 'away_from_seat') return false;
      const s = this.fsm.snapshot;
      if (this.#awayTimer) clearTimeout(this.#awayTimer);
      this.#awayTimer = null;
      if (s.pcId) {
        await this.#env.skills
          .seat({ agentId: this.agentId, seatEpoch: s.epoch, target: { kind: 'pc', pcId: s.pcId } })
          .catch((err: unknown) => this.#log.warn({ err }, 'seat(back) failed'));
      }
      this.fsm.comeBack();
      return true;
    });
  }

  /**
   * Pulled into a meeting (PLAN §6.6, CrewHooks.pullIntoMeeting). A PC seat is left with the chair kept
   * (`agent.unseat{meeting, keepReservation}`), the running turn is interrupted and the swap debounce stretches over
   * the meeting, so the model stays and the walk back costs no swap. Then the body walks to a meeting chair
   * (`agent.seat{meeting}`); the sit job's `skill.result` seats it. Resolves once the walk started.
   */
  pullIntoMeeting(meetingId: string, options: { debounceMs?: number | undefined } = {}): Promise<void> {
    return this.#seatMutex.run(async () => {
      const env = this.#env;
      const s = this.fsm.snapshot;
      if (s.kind === 'meeting' && s.meetingId === meetingId) return; // already there or on the way
      if (s.kind === 'pc' && s.state !== 'wandering' && s.state !== 'standing_pending_swap') {
        if (s.state === 'walking_to_seat') {
          if (s.jobId)
            await env.skills.cancelSkill(this.agentId, { jobId: s.jobId, reason: 'meeting' }).catch(() => []);
          this.fsm.stand('meeting');
        } else {
          if (s.pcId) this.#meetingReturn = { pcId: s.pcId, purpose: s.purpose };
          await env.skills
            .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'meeting', keepReservation: true })
            .catch((err: unknown) => this.#log.warn({ err }, 'unseat (meeting) failed'));
          if (this.#awayTimer) clearTimeout(this.#awayTimer);
          this.#awayTimer = null;
          this.fsm.stand('meeting', { debounceMs: options.debounceMs ?? MEETING_SWAP_DEBOUNCE_MS });
          this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
          // A turn waiting on the player's answer keeps waiting (its card is raised at the table); any other turn
          // stops at its next tool boundary.
          if (this.#session?.inTurn && this.#waitingCards.size === 0) await this.#session.interrupt();
          else if (!this.#session?.inTurn && this.#trackedMode !== AGENT_PERMISSION_MODE)
            await this.#setMode(AGENT_PERMISSION_MODE);
        }
      } else if (s.kind === 'meeting' && s.state !== 'wandering') {
        // Another meeting's chair: leave it first.
        if (s.state === 'walking_to_seat' && s.jobId)
          await env.skills.cancelSkill(this.agentId, { jobId: s.jobId, reason: 'meeting' }).catch(() => []);
        else
          await env.skills
            .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'stand', keepReservation: false })
            .catch(() => {});
        this.fsm.stand('stand');
      }
      const jobId = `sit-${randomUUID().slice(0, 8)}`;
      const t = this.fsm.beginSit({ kind: 'meeting', meetingId }, { purpose: 'meeting', jobId });
      try {
        await env.skills.seat({
          agentId: this.agentId,
          seatEpoch: t.epoch,
          target: { kind: 'meeting', meetingId },
          purpose: 'meeting',
          jobId,
        });
      } catch (err) {
        this.fsm.sitFailed();
        // Refused (NO_SEAT, UNREACHABLE): an agent pulled off its PC goes back to its reserved chair, so the meeting
        // can dial it in from there instead of leaving it standing with the chair held.
        this.#returnToPc('no meeting chair');
        throw err;
      }
      this.#jobs.set(jobId, `${MEETING_SIT_LABEL}${meetingId}`);
    });
  }

  /**
   * Leaves the meeting chair (CrewHooks.releaseFromMeeting); an agent pulled from a PC walks back to its reserved
   * chair (no swap: the stretched debounce still holds) and gets its kickoff again.
   */
  async releaseFromMeeting(): Promise<void> {
    await this.#seatMutex.run(async () => {
      const s = this.fsm.snapshot;
      if (s.kind === 'meeting' && s.state !== 'wandering') {
        if (s.state === 'walking_to_seat') {
          if (s.jobId)
            await this.#env.skills
              .cancelSkill(this.agentId, { jobId: s.jobId, reason: 'meeting over' })
              .catch(() => []);
        } else {
          await this.#env.skills
            .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'stand', keepReservation: false })
            .catch((err: unknown) => this.#log.warn({ err }, 'unseat (meeting over) failed'));
        }
        this.fsm.stand('stand');
      }
    });
    this.#returnToPc('the meeting is over');
  }

  /**
   * An agent pulled from its PC into a meeting walks back to its reserved chair (no swap: the stretched debounce still
   * holds) and gets its kickoff again. Runs on its own (its sit job ends in `skill.result` like any sit, and it queues
   * behind the seat mutex); a refusal wakes the agent. No-op when the agent did not come from a PC.
   */
  #returnToPc(why: string): void {
    const back = this.#meetingReturn;
    this.#meetingReturn = null;
    if (!back || this.#stopped) return;
    void this.sitAtPc({
      pcId: back.pcId,
      purpose: back.purpose ?? 'Carry on where you left off before the meeting.',
      waitMs: 0,
    }).catch((err: unknown) => {
      this.#log.warn({ err, pcId: back.pcId }, 'could not return to the PC after the meeting');
      this.enqueue({
        mode: 'wake',
        priority: 2,
        kind: 'CRITICAL',
        text: control(
          this.record.nonce,
          'CRITICAL',
          `You were called to a meeting (${why}), but could not get back to ${back.pcId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    });
  }

  /**
   * The game restarted into the same world while Node kept running (PLAN §6.3 "App restart"): the body comes back
   * unseated and the mod's jobs are gone. The seat ends with no debounce (PC tools stop as soon as the seat mutex is
   * free; the model swaps back to Haiku at the next boundary, which may compact first), tracked jobs are forgotten,
   * and the agent is told (context, no turn). Resolves once the seat reset and its boundary ran.
   */
  async gameRestarted(): Promise<void> {
    const s = this.fsm.snapshot;
    const pcId = s.kind === 'pc' && this.fsm.holdsPcSeat ? s.pcId : null;
    const hadJobs = this.#jobs.size > 0;
    this.#jobs.clear();
    this.#meetingReturn = null;
    if (this.#awayTimer) clearTimeout(this.#awayTimer);
    this.#awayTimer = null;
    this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
    const reset = this.resetSeat('app_restart');
    // A plan for a PC the agent no longer sits at dies with the seat (as on a kick).
    if (pcId) this.#env.pending.cleanup(this.agentId, 'The game restarted.', (c) => c.kind === 'plan');
    const parts = ['The game restarted.'];
    if (pcId) parts.push(`You are no longer seated at ${pcId}.`);
    if (hadJobs) parts.push('Jobs you had running were stopped.');
    this.context(control(this.record.nonce, 'RESTARTED', parts.join(' ')));
    this.#setStatus();
    await reset;
  }

  /** App restart, death, dismissal or world end: unseated with no swap debounce. */
  async resetSeat(reason: SeatEndReason): Promise<void> {
    await this.#seatMutex.run(async () => {
      if (this.fsm.state === 'wandering') return;
      this.fsm.reset(reason);
      this.plans.clear();
      if (!this.#session?.inTurn) await this.#boundary();
    });
  }

  #clearTimers(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#awayTimer) clearTimeout(this.#awayTimer);
    this.#debounceTimer = null;
    this.#awayTimer = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tool hosts
  // ---------------------------------------------------------------------------------------------------------------

  #mcHost(): McHost {
    const env = this.#env;
    return {
      agentId: this.agentId,
      skills: env.skills,
      org: env.org,
      actor: () => agentActor(this.agentId, this.record.ceo),
      playerName: () => env.playerName(),
      footer: () => this.footer(),
      here: () => {
        const body = env.body(this.agentId);
        if (!body) return null;
        const place: Place = {
          pos: { x: Math.floor(body.pos.x), y: Math.floor(body.pos.y), z: Math.floor(body.pos.z) },
          dim: body.dim,
        };
        return place;
      },
      clockTime: () => env.clockTime(),
      trackJob: (jobId, label) => {
        this.#jobs.set(jobId, label);
      },
      say: (text) => {
        const bubble = bubbleText(text);
        env.say({
          agentId: this.agentId,
          text: bubble,
          style: 'speech',
          ttlMs: Math.min(20_000, Math.max(4_000, bubble.length * 70)),
        });
        env.transcripts.append(this.agentId, { kind: 'agent', text });
      },
      tell: (to, text) => env.tell(this, to, text),
      remember: async (note) => {
        const clock = env.clockTime();
        const stamp =
          clock !== null
            ? `[${ticksToGameTime(clock)}]`
            : `[${new Date(env.now()).toISOString().slice(0, 16)}]`;
        const res = await env.memory.remember(this.agentId, note, stamp);
        return res.dropped > 0
          ? `Remembered. (Memory is full: ${res.dropped} oldest note(s) dropped.)`
          : 'Remembered.';
      },
      requestHire: (request) => env.requestHire(this, request),
      sitAtPc: (request) => this.sitAtPc(request),
      standUp: () => this.standUp(),
      wait: async (ms, jobId) => {
        if (jobId) {
          try {
            const end = await env.skills.awaitJob(jobId, ms);
            this.#jobs.delete(jobId);
            return `Job ${jobId} ${end.status}.`;
          } catch {
            return `Waited ${Math.round(ms / 1000)} s; job ${jobId} is still running.`;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, ms).unref?.());
        return `Waited ${Math.round(ms / 1000)} s.`;
      },
      taskReported: (report) => env.taskReported(this, report),
      world: () => {
        const body = env.body(this.agentId);
        return {
          here: body ? body.pos : null,
          base: env.base?.() ?? null,
          zone: zoneOfBody(body?.zone),
          playerName: env.playerName(),
        };
      },
      noteTrees: (sighting) => this.perception.noteTrees(sighting, env.body(this.agentId)?.pos ?? null),
      takeConsent: () => env.consents?.take(this.agentId) ?? null,
      noteRefusal: (refusal) => env.consents?.noteRefusal(this.agentId, refusal),
    };
  }

  #pcHost(): PcHost {
    const env = this.#env;
    return {
      agentId: this.agentId,
      pcs: env.pcs,
      plans: this.plans,
      handoffs: env.handoffs,
      access: (tool) => this.#pcAccess(tool),
      authorName: () => this.record.name,
      ownJobs: this.#bashJobs,
    };
  }

  /**
   * The ~25-token status footer, in the mod's format (`HP 18/20 food 15 | day 3 08:12 | 120 64 -80 overworld |
   * collect | iron_sword`). The mod's own footer (in every `skill.run` / `obs.query` result) is the source; this one
   * is only for tool results that never reach the mod (protocol §7.3). Null before the first `agent.state`.
   */
  footer(): string | null {
    return statusFooter(this.#env.body(this.agentId), this.#env.clockTime());
  }

  /**
   * The one-line scene of the Digest (world/scene.ts): `D2 07:40 · in Base (office) · trees 20m NE · Jasper 4m · no
   * threats`. Null before Node knows the clock or the body.
   */
  scene(): string | null {
    const body = this.#env.body(this.agentId);
    return sceneLine({
      clockTime: this.#env.clockTime(),
      body,
      base: this.#env.base?.() ?? null,
      trees: this.perception.trees(body?.pos ?? null),
      playerName: this.#env.playerName(),
    });
  }
}

/** The mod's status footer, built from an `agent.state` body (see {@link AgentBrain.footer}). */
export function statusFooter(body: AgentBody | null, clockTime: number | null): string | null {
  if (!body) return null;
  const parts = [`HP ${Math.ceil(body.hp)}/${Math.round(body.maxHp)} food ${body.food}`];
  if (clockTime !== null) parts.push(ticksToGameTime(clockTime).replace(/^Day/, 'day'));
  const dim = body.dim.includes(':') ? body.dim.slice(body.dim.indexOf(':') + 1) : body.dim;
  parts.push(`${Math.floor(body.pos.x)} ${Math.floor(body.pos.y)} ${Math.floor(body.pos.z)} ${dim}`);
  if (body.zone) parts.push(body.zone);
  let activity: string;
  if (body.reflex) activity = body.job ? `${body.reflex} (${body.job.skill} paused)` : body.reflex;
  else if (body.job)
    activity =
      body.job.progress !== undefined
        ? `${body.job.skill} ${Math.round(body.job.progress * 100)}%`
        : body.job.skill;
  else if (body.seat) activity = 'seated';
  else activity = `idle (${body.mode})`;
  parts.push(activity);
  if (body.inCombat) parts.push('IN COMBAT');
  if (body.held) parts.push(body.held.replace(/^minecraft:/, ''));
  return parts.join(' | ');
}
