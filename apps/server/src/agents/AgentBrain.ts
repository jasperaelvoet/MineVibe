/**
 * AgentBrain: everything one agent's mind does between its SDK sessions and the crew (PLAN §6.1-6.5).
 *
 * - **Dual sessions (PLAN §6.1).** Each agent has a BODY session (Haiku 5.5 xhigh, every `mc` tool, the body persona)
 *   for the world, and a DESK session per PC (Opus 5.5 medium, the `pc` tools with the host aliases, the web, PC mode's
 *   minimal `mc` set, the desk persona). Each runs one fixed model and one fixed tool list for its whole life: there are
 *   no model swaps. Exactly one session is ACTIVE at a time; wakes, player chat and context go to it.
 * - **Handoffs (PLAN §6.3).** When the body sits at a PC (SeatFSM `seated_pending_handoff`), its turn ends, then the
 *   desk session for that PC is created or resumed (within {@link DESK_SESSION_TTL_MS} of its last turn) and opens with
 *   a KICKOFF handoff: the task, the player's recent lines verbatim, memory.md, the Codex digest, the Vault handoff
 *   notes, the PC. When the seat ends (stand_up, kick, damage, survival, PC down, a meeting, an expired reservation),
 *   the desk's turn is interrupted (a voluntary stand_up lets the turn end itself), its guest processes are killed as
 *   before, the desk session is closed (its record stays resumable), and the body wakes with a DESK REPORT.
 * - Owns the SeatFSM, PlanCapture, the Digest and the agent's wake queue. Gets brain slots from the BrainScheduler for
 *   each turn of whichever session is active and releases them at `result` and while a card waits.
 * - Meeting mode stays a prompt-level switch inside the body session: the first body turn after it opens with the
 *   MODE banner. ToolGate holds every call to the seat's mode and the session's seat as a backstop.
 * - Builds the ToolGate contexts, the broker hooks and the `mc` / `pc` tool hosts of both sessions.
 *
 * The AgentManager creates brains and provides crew-level services through {@link BrainEnv}.
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  type AgentBody,
  type AgentRole,
  type Autonomy,
  type BrainStatus,
  MOD_CAPS,
  type ModelTier,
  type PayloadOf,
  type Place,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import { ApiError, agentActor } from '../contracts/common.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { JobExit, PcApi } from '../contracts/PcApi.js';
import type { JobEnd, SkillApi } from '../contracts/SkillApi.js';
import type { BaseArea } from '../world/baseArea.js';
import { AgentSession } from './AgentSession.js';
import type { BrainScheduler, Grant, WakePriority } from './BrainScheduler.js';
import type { ResolvedClaude } from './claudeBinary.js';
import {
  AGENT_PERMISSION_MODE,
  BUBBLE_MAX_CHARS,
  DESK_CLOSED_STRIKES,
  DESK_SESSION_TTL_MS,
  HANDOFF_PLAYER_LINES,
  MAX_SEATED,
  type McToolsVersion,
  MEETING_TURN_TIMEOUT_MS,
  mcToolsVersion,
  type SessionKind,
} from './constants.js';
import { Digest, type Routed } from './EventRouter.js';
import { type ControlKind, control, escapeShared, singleLine } from './envelope.js';
import { createInteractionBroker } from './InteractionBroker.js';
import type { HandoffNotes, MemoryStore } from './memory.js';
import { type BrainMode, modeForSeat, sessionMcTools } from './modes.js';
import type { Card, PendingStore } from './PendingStore.js';
import { PlanCapture } from './PlanCapture.js';
import { BARKS, type BarkKey } from './prompts/barks.js';
import {
  type DeskCommand,
  type DeskOutcome,
  deskReportMessage,
  kickoffMessage,
  kickoffWithoutPcMessage,
} from './prompts/kickoff.js';
import { modeBanner, stoodUpText } from './prompts/modes.js';
import { personaPrompt } from './prompts/persona.js';
import { Mutex, type SeatEndReason, SeatFSM, type SeatSnapshot } from './SeatFSM.js';
import type {
  AccountInfo,
  HookCallback,
  PermissionMode,
  QueryFactory,
  SDKResultMessage,
  SDKSystemMessage,
} from './sdk.js';
import { buildSessionOptions, sessionTitle } from './sessionOptions.js';
import { createToolGateHook, type GateContext, type GateObservation } from './ToolGate.js';
import type { TranscriptInput, TranscriptStore } from './TranscriptStore.js';
import { TurnText } from './TurnText.js';
import { type PcToolName, pcToolName } from './tools/catalog.js';
import { type CrewNames, renderOutcome, wakeText } from './tools/format.js';
import { JobRegistry } from './tools/jobs.js';
import { createMcServer, type McHost, splitFooter, ticksToGameTime } from './tools/mcServer.js';
import { jobNotification } from './tools/pc/jobs.js';
import { BatchBook, createPcServer, type PcHost, PcJobBook } from './tools/pcServer.js';
import type { CrewRef } from './tools/targets.js';
import { toolsUpdatedNote } from './tools/toolRefs.js';
import type { UsageGovernor } from './UsageGovernor.js';
import type { ConsentLedger } from './world/consent.js';
import { PerceptionMemory, sceneLine, zoneOfBody } from './world/scene.js';

/** A desk session's resumable record (one per agent and PC, in the world's crew file). */
export interface DeskRecord {
  readonly sessionId: string;
  /** Whether the session was ever started (resume vs new). */
  sessionStarted: boolean;
  readonly createdAt: number;
  /** The last turn's end (or the close): a desk idle longer than the TTL starts fresh. */
  lastActiveAt: number;
}

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
  /** The BODY session's SDK id (new sessions are started with it; restarts resume it). */
  sessionId: string;
  /** Whether the body session was ever started (resume vs new). */
  sessionStarted: boolean;
  /** Desk sessions by PC id (PLAN §6.1): resumed at the next sit within the TTL. They end with the world. */
  desks?: Record<string, DeskRecord> | undefined;
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
  /**
   * The `mc` tool set the session was started with (absent: v1). A resumed session whose transcript holds the other
   * set's calls gets a one-time TOOLS UPDATED note (docs/design/tools-v2-mc.md N11).
   */
  mcTools?: McToolsVersion | undefined;
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
  /** The body session's claude cwd (`worlds/<w>/agents/<id>/home`). */
  agentHome(agentId: string): string;
  /** A desk session's claude cwd (`worlds/<w>/agents/<id>/desk/<pcId>`); default: the body's. */
  deskHome?(agentId: string, pcId: string): string;
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
  /** A session exited on its own (crash): the supervisor decides. */
  sessionExited(brain: AgentBrain, error: Error, session: SessionKind): void;
  /** Startup assertions failed. */
  assertionsFailed(brain: AgentBrain, problems: readonly string[]): void;
  /** Usage accounting per turn (of the given session). */
  turnEnded(brain: AgentBrain, result: SDKResultMessage, session: SessionKind): void;
  /** Every ToolGate decision (activity log, debugging, the live smoke). */
  toolObserved?(brain: AgentBrain, observation: GateObservation): void;
  /** A card went up or ended (approach queue, toasts). */
  cardRaised(brain: AgentBrain, card: Card): void;
  /** `mode` per settings ("subscription" unless API-key mode). */
  authMode(): 'subscription' | 'api_key';
  /** The `mc` tool set (default: `MINEVIBE_MC_TOOLS`, tools-v2-mc.md §14). */
  readonly mcTools?: McToolsVersion | undefined;
  /** How long a desk session stays resumable after its last turn (default 6 h). */
  readonly deskTtlMs?: number | undefined;
  /** A crew member by `@handle`, name or agent id (v2 targets). */
  crewMember?(ref: string): CrewRef | null;
  /** Handle, name and role by agent id (v2 crew section). */
  crewNames?(agentId: string): CrewNames | null;
  /** The record changed in a way that must reach `crew.json` now (e.g. a session was created). */
  recordChanged?(brain: AgentBrain): void;
  /**
   * Whether a `pc.seat` for an agent Node thinks is wandering restores the seat (a Node-only "worker" restart, the
   * game kept running) or stands the body up (an app restart: everyone loads unseated). Default true.
   */
  seatRestore?(): boolean;
  /** The Codex digest context for a handoff (Node-made), or null. */
  codexDigest?(nonce: string): string | null;
  /** A session read its account (`accountInfo()`): the outbound redactor learns its identifiers. */
  noteAccount?(account: AccountInfo): void;
  /** The outbound redactor (account identifiers → `[redacted]`); identity when absent. */
  redact?(text: string): string;
  /** The OrgApi the `mc` tools write through (the redacting one); default {@link org}. */
  readonly toolOrg?: OrgApi | undefined;
  /** The world number, for the sessions' titles. */
  worldGen?(): number | null;
}

interface QueuedWake {
  readonly priority: WakePriority;
  readonly kind: ControlKind | 'PLAYER';
  readonly text: string;
  readonly key: string | undefined;
  readonly epoch: number | null;
  readonly seq: number;
  /** Only this session takes the item (a KICKOFF is the desk's, a DESK REPORT the body's); absent: the active one. */
  readonly target?: SessionKind | undefined;
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

/** The open desk session of the agent (one PC at a time). */
interface DeskState {
  readonly pcId: string;
  session: AgentSession;
  readonly record: DeskRecord;
  /** It continued an earlier session at this PC (resumed), or started fresh. */
  readonly resumed: boolean;
  /** The text blocks of the running desk turn. */
  turnTexts: string[];
  /** The desk's last words at this sit: the last text block of its latest turn that said something. */
  lastText: string | null;
  /** Files written or edited at this sit. */
  readonly changedFiles: string[];
  /** Foreground commands at this sit, oldest first (the last few). */
  readonly commands: DeskCommand[];
  /** Node's view of the desk's permission mode (`plan` for a plan-first sit). */
  trackedMode: PermissionMode;
  /** Calls refused because the seat ended (`desk_closed`): the turn is interrupted after a few. */
  closedStrikes: number;
  /** The `pc` tool server's compaction listeners (read-state and the last image are forgotten). */
  compactionListeners: (() => void)[];
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
const PENDING_HANDOFF_STRIKES = 2;
const TURN_CAP_STRIKES = 3;

/** Seat ends after which the brain stops anyway: no handoff back, no DESK REPORT. */
const TERMINAL_ENDS: ReadonlySet<SeatEndReason> = new Set(['death', 'world_end', 'dismiss']);

/** Body contexts kept while a desk session is active (they reach the body when it takes back). */
const BODY_BACKLOG_MAX = 20;
/** Foreground commands a desk remembers for its report. */
const DESK_COMMANDS_KEPT = 10;

/** How a tool call waits for the session's startup assertions before it is denied. */
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
  const at = Array.isArray(i.coordinate)
    ? ` at ${i.coordinate.join(',')}`
    : typeof i.ref === 'string'
      ? ` ${i.ref}`
      : '';
  switch (short) {
    case 'bash':
      detail = i.description ?? i.command;
      break;
    case 'read':
    case 'write':
    case 'edit':
      detail = i.file_path;
      break;
    // PC tools V2: the computer actions as verbs.
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      return singleLine(
        `${short === 'left_click' ? '' : `${short.replace('_click', '')}-`}clicked${at}`,
        160,
      );
    case 'type':
      return `typed ${typeof i.text === 'string' ? [...i.text].length : 0} chars`;
    case 'key':
    case 'hold_key':
      return singleLine(`${short === 'key' ? 'pressed' : 'held'} ${String(i.text ?? '')}`, 160);
    case 'screenshot':
      return 'looked at the screen';
    case 'zoom':
      return 'zoomed into the screen';
    case 'open':
      return singleLine(`opened ${String(i.target ?? '')}`, 160);
    case 'ui':
      return singleLine(
        `ui ${String(i.action ?? '')}${typeof i.query === 'string' ? ` "${i.query}"` : ''}`,
        160,
      );
    case 'ui_act':
      return singleLine(`${String(i.op ?? 'act')} ${String(i.ref ?? i.window ?? '')}`, 160);
    case 'wait_for':
      return singleLine(
        `waiting for ${String(i.text ?? i.name ?? i.window ?? (i.stable ? 'a still screen' : ''))}`,
        160,
      );
    case 'task_stop':
      return singleLine(`stopped ${String(i.task_id ?? i.shell_id ?? '')}`, 160);
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

/** Why a seat ended, in the words of the body's notice or the DESK REPORT (PLAN §6.3 "Kick, damage, …"). */
const SEAT_END_TEXT: Partial<
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

/** The DESK REPORT's outcome of a seat end. */
function outcomeOf(reason: SeatEndReason | null): DeskOutcome {
  if (reason === 'stand') return 'done';
  if (reason === 'kick' || reason === 'player_took') return 'kicked';
  return 'interrupted';
}

/** Why the seat ended, for the DESK REPORT (null for a voluntary stand). */
function whyOf(reason: SeatEndReason | null, pcId: string, player: string): string | null {
  if (reason === null || reason === 'stand') return null;
  const known = SEAT_END_TEXT[reason];
  if (known) return known.text(pcId, player).replace(/ Ask what they want, or do something else\.$/, '');
  switch (reason) {
    case 'meeting':
      return 'You were called to a meeting.';
    case 'app_restart':
    case 'worker_restart':
      return 'The game restarted.';
    default:
      return `Your seat ended (${reason}).`;
  }
}

export class AgentBrain {
  readonly record: AgentRecord;
  readonly fsm: SeatFSM;
  readonly plans: PlanCapture;
  /** What the agent last said in the current turn: the plan card's fallback (InteractionBroker). */
  readonly turnText: TurnText;
  readonly digest = new Digest();
  /** What this agent's look_around / find showed (the scene line's trees). */
  readonly perception: PerceptionMemory;
  /** The world jobs the v2 tools started (tools-v2-mc.md §7): results, `job{…}`, wakes, the replace notice. */
  readonly toolJobs: JobRegistry;
  /** The session's `mc` tool set. */
  readonly mcTools: McToolsVersion;
  readonly #env: BrainEnv;
  readonly #seatMutex = new Mutex();
  readonly #log: Logger;
  /** The body session (Haiku, every `mc` tool), or null while it is down. */
  #body: AgentSession | null = null;
  /** The open desk session (Opus, one PC), or null. */
  #desk: DeskState | null = null;
  /** The session wakes, chat and context go to. */
  #active: SessionKind = 'body';
  #queue: QueuedWake[] = [];
  /** Context for a session that is down, delivered when it starts. */
  #pendingContexts: { readonly target: SessionKind; readonly text: string }[] = [];
  /** Context the body missed while its desk session was active (delivered at the handoff back). */
  #bodyBacklog: string[] = [];
  #seq = 0;
  #grant: Grant | null = null;
  #acquiring: WakePriority | null = null;
  #status: BrainStatus = 'idle';
  #offline = false;
  #assertionsFailed: readonly string[] | null = null;
  /** Which session's startup failed (the body's halt is lifted only by a new body, {@link start}). */
  #haltedBy: SessionKind | null = null;
  /**
   * Per session: settles once its `system/init` arrived and its startup assertions ran. The gate waits for it, so no
   * tool runs before the assertions passed (a hook can reach Node before the init message).
   */
  readonly #startupChecks = new Map<AgentSession, { promise: Promise<void>; done: () => void }>();
  /** >0 while a turn boundary is queued or running: no new turn starts until its handoff is in place. */
  #boundaryHold = 0;
  #activity: string | null = null;
  #turn = { calls: 0, startedAt: 0, pausedAt: 0 as number, pausedMs: 0, pendingStrikes: 0, capStrikes: 0 };
  #waitingCards = new Set<string>();
  /** Which session raised each waiting card (a crash makes only its own questions stale). */
  readonly #cardSessions = new Map<string, SessionKind>();
  /** Per `pc` tool, the seat epochs (and tool_use ids) the gate allowed calls under, oldest first. */
  readonly #pcEpochs = new Map<PcToolName, { epoch: number; toolUseId: string }[]>();
  readonly #jobs = new Map<string, string>();
  #awayTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastEffort: string | null = null;
  #lastPlayerAt = 0;
  #lastAutonomousAt: number | null = null;
  /** Background `pc__bash` jobs this agent started, across session restarts (ownership and notifications). */
  readonly #pcJobs = new PcJobBook();
  /** Which `pc` calls each assistant message made (PC tools V2 batches), fed from the desk's stream. */
  readonly #batch = new BatchBook();
  #unsubscribeJobs: (() => void) | null = null;
  /** Meeting turns collecting the running turn's text. */
  #collectors: TurnCollector[] = [];
  /** The PC an agent pulled into a meeting returns to afterwards. */
  #meetingReturn: { pcId: string; purpose: string | null } | null = null;
  /**
   * The mode the body session was last told about with a MODE banner, or null: Minecraft mode is the body persona's
   * own, so it is only announced after the body left Meeting mode. Null again for a new or resumed body session and
   * after a compaction (the summary may have dropped the last banner).
   */
  #announcedMode: BrainMode | null = null;
  /** Why the current seat ended, when Node knows better than the reason code (a desk that kept crashing). */
  #seatEndWhy: string | null = null;
  /** The compaction listeners of the desk session being created (its `pc` tool server subscribes while built). */
  #deskListeners: (() => void)[] = [];

  constructor(record: AgentRecord, env: BrainEnv) {
    this.record = record;
    this.#env = env;
    this.perception = new PerceptionMemory(() => env.now());
    this.toolJobs = new JobRegistry(() => env.now());
    this.mcTools = env.mcTools ?? mcToolsVersion();
    this.#log = env.log.child({ agentId: record.agentId });
    this.fsm = new SeatFSM({ now: () => env.now() });
    const home = env.agentEnv().HOME ?? '';
    this.plans = new PlanCapture(
      [home, '/home/cua'].filter((h) => h.length > 0),
      { now: () => env.now() },
    );
    this.turnText = new TurnText(() => env.now());
    this.#unsubscribeJobs = env.pcs.onJobExit((exit) => this.#onPcJobExit(exit));
  }

  get agentId(): string {
    return this.record.agentId;
  }

  /** The ACTIVE session (the body's, or the desk's while one is open), or null while it is down. */
  get session(): AgentSession | null {
    return this.#active === 'desk' ? (this.#desk?.session ?? null) : this.#body;
  }

  /** Which session is active. */
  get activeSession(): SessionKind {
    return this.#active;
  }

  /** The body session, whether active or not. */
  get bodySession(): AgentSession | null {
    return this.#body;
  }

  /** The open desk session, or null. */
  get deskSession(): AgentSession | null {
    return this.#desk?.session ?? null;
  }

  /** The PC of the open desk session, or null. */
  get deskPc(): string | null {
    return this.#desk?.pcId ?? null;
  }

  get status(): BrainStatus {
    return this.#status;
  }

  get activity(): string | null {
    return this.#activity;
  }

  /** Node's view of the active session's permission mode (`plan` only in a plan-first desk session). */
  get trackedMode(): PermissionMode {
    return this.#active === 'desk' && this.#desk ? this.#desk.trackedMode : AGENT_PERMISSION_MODE;
  }

  /** The tier of the active session: Opus at a desk, Haiku in the body. */
  get model(): ModelTier {
    return this.#active === 'desk' ? 'opus' : 'haiku';
  }

  get lastEffort(): string | null {
    return this.#lastEffort;
  }

  /** The mode of the agent's seat right now (what ToolGate enforces). */
  get mode(): BrainMode {
    return modeForSeat(this.fsm.snapshot);
  }

  /** The mode the body session was last told about (MODE banner), null when it is its persona's Minecraft mode. */
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

  /**
   * The session tag of a transcript line for this agent now: the session that reads it. That is the active one, except
   * during a handoff: in the body's sit turn the desk takes over next, and a desk whose seat ended hands back to the
   * body (chat waits for the session that takes over, {@link enqueue}).
   */
  transcriptTag(): Pick<TranscriptInput, 'session' | 'pcId'> {
    const s = this.fsm.snapshot;
    if (this.#active === 'body' && this.#handingOver() && s.pcId !== null)
      return { session: 'desk', pcId: s.pcId };
    if (this.#active === 'desk' && this.#handingOver()) return { session: 'body' };
    return this.#tag(this.#active);
  }

  /**
   * Whether the active session is about to hand over (PLAN §6.3): the body in its sit turn (`seated_pending_handoff`,
   * every call refused, its desk takes over when it ends), or a desk whose seat ended (its last turn, then the body).
   * Nothing new folds into such a turn: it waits for the session that takes over.
   */
  #handingOver(): boolean {
    if (this.#active === 'desk') return this.#desk !== null && this.fsm.deskPc !== this.#desk.pcId;
    const s = this.fsm.snapshot;
    return s.kind === 'pc' && s.state === 'seated_pending_handoff';
  }

  #tag(kind: SessionKind): Pick<TranscriptInput, 'session' | 'pcId'> {
    const pcId = this.#desk?.pcId;
    return kind === 'desk' && pcId ? { session: 'desk', pcId } : { session: 'body' };
  }

  #redact(text: string): string {
    return this.#env.redact?.(text) ?? text;
  }

  /** A tool input with its top-level strings redacted (what {@link describeTool} shows of it). */
  #redactInput(input: unknown): unknown {
    if (!this.#env.redact || !input || typeof input !== 'object' || Array.isArray(input)) return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>))
      out[k] = typeof v === 'string' ? this.#redact(v) : v;
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Starts (or resumes) the BODY session. `contexts` are delivered first as `shouldQuery:false` (memory, roster,
   * restart notice); `wakes` are queued (welcome). A seat waiting for its handoff (a worker restart) hands over to its
   * desk session once the body runs.
   */
  start(options: { contexts?: readonly string[]; wakes?: readonly Routed[] } = {}): void {
    if (this.#stopped) throw new Error('brain stopped');
    if (this.#body?.started) return;
    this.#offline = false;
    // A (re)start re-runs the startup assertions (e.g. Retry after logging in again).
    this.#assertionsFailed = null;
    this.#haltedBy = null;
    let claude: ResolvedClaude;
    try {
      claude = this.#env.claude();
    } catch (err) {
      // No usable claude (missing, too old): the brain stays asleep with a toast; the body keeps its reflexes.
      // Contexts and wakes wait in the queue, so a later Retry (after `claude update` and a restart) loses nothing.
      const problem = err instanceof Error ? err.message : String(err);
      this.#assertionsFailed = [problem];
      this.#haltedBy = 'body';
      this.#log.error({ problem }, 'no usable claude: the brain stays asleep');
      this.#env.assertionsFailed(this, [problem]);
      for (const text of options.contexts ?? []) this.#pendingContexts.push({ target: 'body', text });
      for (const w of options.wakes ?? []) this.enqueue(w);
      this.#setStatus();
      return;
    }
    const env = this.#env;
    const resume = this.record.sessionStarted ? this.record.sessionId : null;
    const session = this.#createSession('body', {
      claude,
      resume,
      sessionId: this.record.sessionId,
      cwd: env.agentHome(this.agentId),
    });
    this.#body = session;
    // A new or resumed body hears its mode again (Meeting mode only: Minecraft mode is its persona's own).
    this.#announcedMode = null;
    session.start();
    // N11: a resumed transcript full of the other tool set's calls is told the new names once.
    const before = this.record.mcTools ?? 'v1';
    if (before !== this.mcTools) {
      if (resume) this.#sendContext('body', toolsUpdatedNote(this.record.nonce, before, this.mcTools));
      this.record.mcTools = this.mcTools;
      env.recordChanged?.(this);
    }
    for (const text of options.contexts ?? []) this.#sendContext('body', text);
    this.#flushPending('body');
    for (const w of options.wakes ?? []) this.enqueue(w);
    this.#setStatus();
    // A seat that waits for its handoff (worker restart, or a crash of the body mid-handoff) completes now.
    if (this.fsm.state === 'seated_pending_handoff' || this.fsm.state === 'standing_pending_handoff')
      void this.#runBoundary();
    this.#pump();
  }

  /** Creates one session of this agent (not started): its options, gate, broker and stream callbacks. */
  #createSession(
    kind: SessionKind,
    input: {
      claude: ResolvedClaude;
      resume: string | null;
      sessionId: string;
      cwd: string;
      pcId?: string | undefined;
      planFirst?: boolean | undefined;
    },
  ): AgentSession {
    const env = this.#env;
    let session: AgentSession | null = null;
    const gateHook = createToolGateHook(
      () => this.gateContext(kind, session ?? undefined),
      (o) => this.#observeGate(kind, o),
    );
    // Fail closed: no tool runs before the startup assertions of this session have passed.
    const gate: HookCallback = async (hookInput, toolUseId, opts) => {
      const pending = session ? this.#startupChecks.get(session)?.promise : undefined;
      if (pending && !(await settlesWithin(pending, STARTUP_GATE_WAIT_MS))) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'MineVibe is still checking this session; try again in a moment.',
          },
        };
      }
      return gateHook(hookInput, toolUseId, opts);
    };
    const persona = personaPrompt({
      name: this.record.name,
      handle: this.record.handle,
      role: this.record.role,
      ceo: this.record.ceo,
      playerName: env.playerName(),
      nonce: this.record.nonce,
      mcTools: this.mcTools,
      session: kind,
    });
    const title = sessionTitle({
      name: this.record.name,
      kind,
      pcId: input.pcId,
      worldGen: env.worldGen?.() ?? null,
    });
    const common = {
      claude: input.claude,
      env: env.agentEnv(),
      cwd: input.cwd,
      resume: input.resume,
      sessionId: input.sessionId,
      persona,
      title,
      stderr: (d: string) => this.#log.debug({ stderr: d.slice(0, 500), session: kind }, 'claude stderr'),
    };
    const options =
      kind === 'desk'
        ? buildSessionOptions({
            ...common,
            kind: 'desk',
            mc: createMcServer(this.#mcHost('desk'), this.mcTools, sessionMcTools('desk', this.mcTools)),
            pc: createPcServer(this.#pcHost()),
            planFirst: input.planFirst,
          })
        : buildSessionOptions({
            ...common,
            kind: 'body',
            mc: createMcServer(this.#mcHost('body'), this.mcTools),
          });
    const created: AgentSession = new AgentSession(
      {
        agentId: this.agentId,
        options,
        gate,
        canUseTool: createInteractionBroker({
          agentId: this.agentId,
          store: env.pending,
          plans: this.plans,
          turnText: () => this.turnText.latest(),
          seatEpoch: () => this.fsm.epoch,
          playerName: () => env.playerName(),
          now: () => env.now(),
          // Cards show agent-authored text to the player: account identifiers are redacted (agents/redact.ts).
          redact: (text) => this.#redact(text),
          hooks: {
            onWaitStart: (card) => this.#onCardWait(kind, card),
            onWaitEnd: (card) => this.#onCardAnswered(created, card),
            setPermissionMode: async (mode) => {
              // Only a desk session has plan mode (ExitPlanMode is a desk tool).
              const desk = this.#desk;
              if (kind !== 'desk' || !desk || desk.session !== created) return;
              desk.trackedMode = mode;
              await created.setPermissionMode(mode);
            },
          },
        }),
        queryFactory: env.queryFactory,
        log: this.#log,
        now: () => env.now(),
      },
      {
        onInit: (init, first) => this.#onInit(created, kind, init, first),
        onAssistantText: (text) => this.#onText(created, kind, text),
        onToolUse: (name, toolInput, toolUseId, messageId) => {
          if (kind === 'desk' && messageId) this.#batch.toolUse(messageId, toolUseId, name);
          this.#onToolUse(kind, name, toolInput);
        },
        onStream: (mark) => {
          if (kind !== 'desk') return;
          if (mark.kind === 'message_start') this.#batch.messageStart(mark.messageId);
          else if (mark.kind === 'tool_use') this.#batch.toolUse(mark.messageId, mark.toolUseId, mark.name);
          else this.#batch.messageStop(mark.messageId);
        },
        onCompacted: () => {
          if (kind === 'body') {
            // The summary may have dropped the last MODE banner: the next body turn announces the mode again.
            if (this.#body === created) this.#announcedMode = null;
            return;
          }
          const desk = this.#desk;
          if (desk?.session === created) for (const listener of desk.compactionListeners) listener();
        },
        onTurnEnd: (result) => this.#onTurnEnd(created, kind, result),
        onRateLimit: (info) => env.governor.onRateLimit(info as never),
        onAssistantError: (error) => {
          if (error === 'rate_limit') env.governor.onRejected();
          else if (error === 'authentication_failed' || error === 'oauth_org_not_allowed')
            env.governor.onAuthFailure();
        },
        onExit: (error) => this.#onExit(created, kind, error),
      },
    );
    session = created;
    let done: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.#startupChecks.set(created, { promise, done });
    void promise.then(() => this.#startupChecks.delete(created));
    return created;
  }

  /** Closes every session and cancels everything (dismissal, death, world end, shutdown). */
  async stop(reason: string, options: { keepCards?: boolean } = {}): Promise<void> {
    this.#stopped = true;
    this.#unsubscribeJobs?.();
    this.#unsubscribeJobs = null;
    this.#clearTimers();
    this.#env.scheduler.cancel(this.agentId);
    this.#grant = null;
    this.#finishCollectors(this.#queue);
    this.#queue = [];
    if (!options.keepCards) {
      this.#env.pending.cleanup(this.agentId, reason, (c) => c.kind === 'question' || c.kind === 'plan');
    }
    const desk = this.#desk;
    this.#desk = null;
    this.#active = 'body';
    if (desk) {
      desk.record.lastActiveAt = this.#env.now();
      this.#env.recordChanged?.(this);
    }
    const body = this.#body;
    this.#body = null;
    await Promise.all([desk?.session.close(), body?.close()]);
  }

  /** Closes the body session without stopping the brain (the supervisor or Retry restarts it). */
  async closeSession(): Promise<void> {
    const session = this.#body;
    this.#body = null;
    if (this.#active === 'body') {
      this.#grant?.release();
      this.#grant = null;
    }
    await session?.close();
  }

  /**
   * The brain shows "offline" and starts nothing new until Retry. A turn still running in the other session (the desk
   * while the body crashed) keeps its slot until its `result`: releasing it here would let the scheduler hand the slot
   * out twice.
   */
  markOffline(): void {
    this.#offline = true;
    if (!this.session?.inTurn) {
      this.#grant?.release();
      this.#grant = null;
    }
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
  enqueue(item: Routed, collector?: TurnCollector, target?: SessionKind): void {
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
    const active = this.session;
    const forActive = target === undefined || target === this.#active;
    if (item.now && forActive && active?.inTurn) {
      void active.interrupt();
    }
    // A player message during a running turn folds into it at the next tool boundary (`next`). Not into a turn that is
    // handing over (the body's sit turn, a desk whose seat ended): that session can act on nothing more, and a desk
    // closes with it, so the message waits in the queue for the session that takes over (PLAN §6.3).
    if (
      item.priority === 0 &&
      forActive &&
      active?.started &&
      active.inTurn &&
      this.#grant &&
      !item.now &&
      this.#boundaryHold === 0 &&
      !this.#handingOver()
    ) {
      active.send(item.text, { priority: 'next' });
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
      target,
      collector,
    };
    if (item.key !== undefined) this.#queue = this.#queue.filter((q) => q.key !== item.key);
    this.#queue.push(wake);
    this.#setStatus();
    this.#pump();
  }

  /**
   * Adds context without a turn (`shouldQuery:false`) to the active session. While a desk session is active the body
   * keeps a copy and hears it when it takes back; a session that is down hears it when it starts.
   */
  context(text: string): void {
    this.#sendContext(this.#active, text);
    if (this.#active === 'desk') {
      this.#bodyBacklog.push(text);
      if (this.#bodyBacklog.length > BODY_BACKLOG_MAX) this.#bodyBacklog.shift();
    }
  }

  #sessionOf(kind: SessionKind): AgentSession | null {
    return kind === 'desk' ? (this.#desk?.session ?? null) : this.#body;
  }

  #sendContext(kind: SessionKind, text: string): void {
    const session = this.#sessionOf(kind);
    if (session?.started) session.send(text, { shouldQuery: false });
    else this.#pendingContexts.push({ target: kind, text });
  }

  #flushPending(kind: SessionKind): void {
    const session = this.#sessionOf(kind);
    if (!session?.started) return;
    const mine = this.#pendingContexts.filter((c) => c.target === kind);
    this.#pendingContexts = this.#pendingContexts.filter((c) => c.target !== kind);
    for (const c of mine) session.send(c.text, { shouldQuery: false });
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
          const session = this.session;
          if (session?.inTurn) void session.interrupt();
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

  /** The player addressed this agent (debounced by the caller); it reaches the ACTIVE session. */
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
    if (chatMode === 'task') {
      // The player's new task wakes the agent anyway: the cancelled job needs no [JOB FAILED] of its own.
      this.toolJobs.markCancelled('replace');
      void this.#env.skills.cancelSkill(this.agentId, { reason: 'new task' }).catch(() => {});
    }
    this.enqueue({ mode: 'wake', priority: 0, kind: 'PLAYER', text, now: chatMode === 'interrupt' });
  }

  /** A job this agent started (returned `running`) is tracked for [JOB DONE]. */
  jobLabel(jobId: string): string | undefined {
    return this.#jobs.get(jobId);
  }

  forgetJob(jobId: string): void {
    this.#jobs.delete(jobId);
  }

  /**
   * v2 (tools-v2-mc.md §6.5, §7): renders a tracked job's end for its wake and records it in the job registry. Null
   * when no wake is due: the agent itself stopped or replaced the job (its tool result said so), a player's new task
   * cancelled it (the player's message wakes the agent), or the agent's `job{wait}` was waiting for it (that result
   * carries the end).
   */
  toolJobEnded(end: JobEnd): { readonly ok: boolean; readonly text: string } | null {
    const meta = this.toolJobs.meta(end.jobId);
    if (!meta) return null;
    const { result } = splitFooter(end.result);
    const body = this.#env.body(this.agentId);
    const rendered = renderOutcome(
      meta,
      { status: end.status, result, error: end.error, durationMs: end.durationMs },
      {
        here: body ? body.pos : null,
        playerName: this.#env.playerName(),
        craftTree: this.#env.skills.caps?.().has(MOD_CAPS.CRAFT_TREE) ?? false,
      },
    );
    this.toolJobs.ended(end.jobId, end.status, rendered, end.error?.code);
    if (!this.toolJobs.wakeDue(end.jobId, end.status)) return null;
    return { ok: end.status === 'done', text: wakeText(end.jobId, rendered, meta.skill === 'sequence') };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * What the gate knows when a call of `session` (default: the active one) arrives. `from`: the session object that
   * makes the call; a desk session that is no longer the open one (closed, or replaced by a restart) works no PC.
   */
  gateContext(session: SessionKind = this.#active, from?: AgentSession): GateContext {
    const t = this.#turn;
    const now = this.#env.now();
    const paused = t.pausedAt > 0 ? now - t.pausedAt : 0;
    const desk = this.#desk;
    return {
      agentId: this.agentId,
      ceo: this.record.ceo,
      seat: this.fsm.snapshot,
      occupant: (pcId) => this.#env.occupant(pcId),
      trackedMode: session === 'desk' && desk ? desk.trackedMode : AGENT_PERMISSION_MODE,
      mcTools: this.mcTools,
      plans: this.plans,
      turn: {
        calls: t.calls,
        activeMs: t.startedAt > 0 ? Math.max(0, now - t.startedAt - t.pausedMs - paused) : 0,
      },
      playerName: this.#env.playerName(),
      halted: this.#assertionsFailed ? (this.#assertionsFailed[0] ?? 'startup check failed') : null,
      session,
      deskPc:
        session === 'desk' && (from === undefined || desk?.session === from) ? (desk?.pcId ?? null) : null,
    };
  }

  #observeGate(kind: SessionKind, o: GateObservation): void {
    this.#env.toolObserved?.(this, o);
    this.#turn.calls++;
    if (o.effort) this.#lastEffort = o.effort;
    const desk = this.#desk;
    if (
      kind === 'desk' &&
      desk &&
      (o.permissionMode === 'plan' ||
        o.permissionMode === 'default' ||
        o.permissionMode === AGENT_PERMISSION_MODE)
    ) {
      // The CLI's own view wins (e.g. after ExitPlanMode it switched itself). USER DECISION 2026-10-08: the normal
      // mode is bypassPermissions, which must be tracked too (or a stale 'plan' would outlive an approved plan).
      desk.trackedMode = o.permissionMode;
    }
    const pc = pcToolName(o.toolName);
    if (o.decision.behavior === 'allow' && pc !== null) {
      const list = this.#pcEpochs.get(pc) ?? [];
      list.push({ epoch: this.fsm.epoch, toolUseId: o.toolUseId });
      this.#pcEpochs.set(pc, list);
    }
    if (o.decision.behavior === 'deny') {
      const session = this.#sessionOf(kind);
      if (o.decision.code === 'pending_handoff' && ++this.#turn.pendingStrikes >= PENDING_HANDOFF_STRIKES) {
        void session?.interrupt();
      }
      if (o.decision.code === 'desk_closed' && desk && ++desk.closedStrikes >= DESK_CLOSED_STRIKES) {
        void desk.session.interrupt();
      }
      if (o.decision.code === 'turn_cap' && ++this.#turn.capStrikes >= TURN_CAP_STRIKES) {
        void session?.interrupt();
      }
    }
  }

  /**
   * The seat a `pc` handler may use: seated, and the same epoch the gate allowed the call under; with the call's
   * tool_use id as the gate saw it (mutating `pc` calls run one at a time, so the oldest allowed call is this one).
   */
  #pcAccess(tool: PcToolName): { pcId: string; epoch: number; toolUseId?: string } | null {
    const allowed = this.#pcEpochs.get(tool)?.shift();
    const s = this.fsm.snapshot;
    if (!this.fsm.hasPcAccess || s.pcId === null) return null;
    if (this.#desk?.pcId !== s.pcId) return null;
    if (allowed !== undefined && allowed.epoch !== s.epoch) return null;
    if (this.#env.occupant(s.pcId) !== this.agentId) return null;
    return { pcId: s.pcId, epoch: s.epoch, ...(allowed?.toolUseId ? { toolUseId: allowed.toolUseId } : {}) };
  }

  /**
   * A background `pc__bash` command ended: one notification wake (Claude Code's `<task-notification>`) for the desk
   * session while the seat it started under still holds; a job the agent stopped itself, or whose seat ended, is only
   * forgotten.
   */
  #onPcJobExit(exit: JobExit): void {
    const job = this.#pcJobs.get(exit.pcId, exit.jobId);
    if (!job) return;
    this.#pcJobs.delete(exit.pcId, exit.jobId);
    const s = this.fsm.snapshot;
    // The same seat (also while away asking the player: its processes run on); a new seat or none drops it.
    if (this.#stopped || s.kind !== 'pc' || s.pcId !== exit.pcId || s.epoch !== job.epoch) return;
    const block = jobNotification(job, exit);
    if (!block) return;
    this.enqueue(
      {
        mode: 'wake',
        priority: 3,
        kind: 'PC JOB',
        text: `${control(this.record.nonce, 'PC JOB', 'A background command ended.')}\n${block}`,
        key: `pcjob:${exit.pcId}:${exit.jobId}`,
      },
      undefined,
      'desk',
    );
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Turns and slots
  // ---------------------------------------------------------------------------------------------------------------

  /** Whether a queued item runs in the active session (its target, and the seat epoch of a KICKOFF). */
  #deliverable(q: QueuedWake): boolean {
    return (
      (q.target === undefined || q.target === this.#active) &&
      (q.epoch === null || q.epoch === this.fsm.epoch)
    );
  }

  #pump(): void {
    const session = this.session;
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
    const ready = this.#queue.filter((q) => this.#deliverable(q));
    if (ready.length === 0) {
      this.#setStatus();
      return;
    }
    const best = Math.min(...ready.map((q) => q.priority)) as WakePriority;
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
        const active = this.session;
        if (this.#stopped || !active?.started) {
          drop();
          return;
        }
        if (active.inTurn) {
          // A turn started meanwhile (e.g. an answered card resumed it): it runs on this slot.
          if (this.#grant && this.#grant !== grant) grant.release();
          else this.#grant = grant;
          this.#setStatus();
          return;
        }
        if (
          !this.#queue.some((q) => this.#deliverable(q)) ||
          this.#boundaryHold > 0 ||
          this.#assertionsFailed
        ) {
          // A turn boundary is handing over: it pumps again when done.
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
    const session = this.session;
    if (!session) return;
    const kind = this.#active;
    const epoch = this.fsm.epoch;
    const stale = (q: QueuedWake) => q.epoch !== null && q.epoch !== epoch;
    const other = (q: QueuedWake) => q.target !== undefined && q.target !== kind;
    for (const q of this.#queue.filter(stale)) if (q.collector) this.#finishCollector(q.collector);
    const waiting = this.#queue.filter((q) => !stale(q) && other(q));
    const live = this.#queue.filter((q) => !stale(q) && !other(q));
    // A meeting turn runs on its own: what the agent says in it is the meeting's answer.
    const meeting = live.filter((q) => q.collector !== undefined);
    // A handoff opens its session's turn: the KICKOFF (desk) and the DESK REPORT (body) come first.
    const first = (q: QueuedWake) => (q.kind === 'KICKOFF' || q.kind === 'DESK REPORT' ? 0 : 1);
    const items = (meeting.length > 0 ? meeting : live).sort(
      (a, b) => first(a) - first(b) || a.priority - b.priority || a.seq - b.seq,
    );
    this.#queue = [...waiting, ...(meeting.length > 0 ? live.filter((q) => q.collector === undefined) : [])];
    if (items.length === 0) {
      this.#grant?.release();
      this.#grant = null;
      this.#setStatus();
      return;
    }
    const parts: string[] = [];
    const mode = modeForSeat(this.fsm.snapshot);
    const banner = kind === 'body' ? this.#modeBanner(mode) : null;
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
    if (kind === 'desk' && this.#desk) this.#desk.turnTexts = [];
    session.send(parts.join('\n\n'));
    if (banner) {
      this.#log.info({ from: this.#announcedMode, to: mode }, 'mode switched');
      this.#announcedMode = mode;
    }
    this.bark(BARKS.wake);
    this.#setStatus();
  }

  /**
   * The body's MODE banner when `mode` is not the one it last heard about, else null. Minecraft mode is the body
   * persona's own, so it is announced only after Meeting mode; PC mode never reaches the body (its desk session has
   * that mode in its persona).
   */
  #modeBanner(mode: BrainMode): string | null {
    if (mode === 'seated') return null;
    if (mode === (this.#announcedMode ?? 'wander')) return null;
    return modeBanner(mode, {
      nonce: this.record.nonce,
      playerName: this.#env.playerName(),
      mcTools: this.mcTools,
    });
  }

  #onTurnEnd(session: AgentSession, kind: SessionKind, result: SDKResultMessage): void {
    if (session !== this.#sessionOf(kind)) return; // a closed session's late result
    this.turnText.reset();
    this.#env.turnEnded(this, result, kind);
    this.#finishCollectors([]);
    if (result.is_error && result.subtype === 'success' && isUsageLimitText(result.result)) {
      this.#env.governor.onRejected();
    }
    const desk = this.#desk;
    if (kind === 'desk' && desk) {
      const said = desk.turnTexts.at(-1);
      if (said) desk.lastText = said;
      // The TTL counts from the desk's last turn: kept in the crew file, so an app restart sees it.
      desk.record.lastActiveAt = this.#env.now();
      this.#env.recordChanged?.(this);
    }
    const more = (result.queued_turn_count ?? 0) > 0;
    if (!more && kind === this.#active) {
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
   * that arrives meanwhile can never start a turn before a handoff, the plan mode and the kickoff are in place.
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

  #onCardWait(kind: SessionKind, card: Card): void {
    this.#waitingCards.add(card.id);
    this.#cardSessions.set(card.id, kind);
    if (this.#turn.pausedAt === 0) this.#turn.pausedAt = this.#env.now();
    this.#grant?.release();
    this.#grant = null;
    this.bark(BARKS.question);
    this.#env.cardRaised(this, card);
    this.#setStatus();
  }

  async #onCardAnswered(session: AgentSession, card: Card): Promise<void> {
    this.#waitingCards.delete(card.id);
    this.#cardSessions.delete(card.id);
    if (this.#turn.pausedAt > 0) {
      this.#turn.pausedMs += this.#env.now() - this.#turn.pausedAt;
      this.#turn.pausedAt = 0;
    }
    this.#setStatus();
    // An answered card resumes at P0 on the interactive lane.
    const grant = await this.#env.scheduler.acquire(this.agentId, 0);
    if (this.#stopped || this.session !== session || !session.inTurn) {
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
    this.#cardSessions.delete(cardId);
    if (this.#waitingCards.delete(cardId)) this.#setStatus();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------------------------------------------

  #onInit(session: AgentSession, kind: SessionKind, init: SDKSystemMessage, first: boolean): void {
    if (!first || session !== this.#sessionOf(kind)) {
      this.#startupChecks.get(session)?.done();
      return;
    }
    // From now on a restart resumes this session (persisted at once: a crash must not re-create it).
    if (kind === 'body' && !this.record.sessionStarted) {
      this.record.sessionStarted = true;
      this.#env.recordChanged?.(this);
    }
    const desk = this.#desk;
    if (kind === 'desk' && desk && !desk.record.sessionStarted) {
      desk.record.sessionStarted = true;
      this.#env.recordChanged?.(this);
    }
    const checked = this.#startupChecks.get(session);
    void session
      .checkStartup(init, this.#env.authMode(), (account) => this.#env.noteAccount?.(account))
      .then(
        (problems) => {
          if (problems.length > 0) this.#halt(session, kind, problems);
        },
        (err: unknown) =>
          this.#halt(session, kind, [
            `startup check failed (${err instanceof Error ? err.message : String(err)})`,
          ]),
      )
      .finally(() => checked?.done());
  }

  /**
   * Startup assertions failed (PLAN §6.1): the brain stays asleep. The running turn is interrupted, the claude process
   * closed (no more spending), every tool call is denied and nothing new starts until Retry starts a fresh session.
   */
  #halt(session: AgentSession, kind: SessionKind, problems: readonly string[]): void {
    this.#assertionsFailed = problems;
    this.#haltedBy = kind;
    this.#log.error({ problems, session: kind }, 'startup assertions failed');
    this.#env.assertionsFailed(this, problems);
    this.#setStatus();
    if (session !== this.#sessionOf(kind)) return;
    void session
      .interrupt()
      .then(async () => {
        if (kind === 'body' && this.#body === session) await this.closeSession();
        else if (kind === 'desk' && this.#desk?.session === session) await session.close();
      })
      .catch((err: unknown) => this.#log.warn({ err }, 'closing the halted session failed'))
      .finally(() => this.#setStatus());
  }

  #onText(session: AgentSession, kind: SessionKind, text: string): void {
    const trimmed = text.trim();
    this.#env.transcripts.append(this.agentId, { kind: 'agent', text: trimmed, ...this.#tag(kind) });
    if (/^\(?silent\)?\.?$/i.test(trimmed)) return;
    const desk = this.#desk;
    if (kind === 'desk' && desk?.session === session) desk.turnTexts.push(trimmed);
    this.turnText.text(trimmed);
    for (const c of this.#collectors) c.texts.push(trimmed);
    // Redacted before the bubble is cut to length: a cut must never leave part of an account identifier behind.
    const bubble = bubbleText(this.#redact(trimmed));
    if (bubble.length === 0) return;
    this.#env.say({
      agentId: this.agentId,
      text: bubble,
      style: 'speech',
      ttlMs: Math.min(20_000, Math.max(4_000, bubble.length * 70)),
    });
  }

  #onToolUse(kind: SessionKind, name: string, input: unknown): void {
    this.turnText.toolUse(name);
    // The activity line is cut to length: its input is redacted first, so no cut leaves part of an identifier.
    const line = describeTool(name, this.#redactInput(input));
    this.#activity = line;
    this.#env.transcripts.append(this.agentId, { kind: 'activity', text: line, ...this.#tag(kind) });
    this.#env.brainChanged(this);
  }

  #onExit(session: AgentSession, kind: SessionKind, error: Error | null): void {
    this.#startupChecks.get(session)?.done();
    if (session !== this.#sessionOf(kind)) return; // closed on purpose (a desk handed back, a halted session)
    const active = kind === this.#active;
    if (active) {
      this.turnText.reset();
      this.#grant?.release();
      this.#grant = null;
      this.#acquiring = null;
      // A meeting turn in flight ends with what was said so far.
      this.#finishCollectors([]);
    }
    const mine = (c: Card) => (this.#cardSessions.get(c.id) ?? 'body') === kind;
    if (!this.#stopped) {
      // A crash: this session's questions are re-asked (stale), its plans die with the turn.
      this.#env.pending.markStale(this.agentId, (c) => c.kind === 'question' && mine(c));
      this.#env.pending.cleanup(
        this.agentId,
        'The brain restarted.',
        (c, e) => c.kind === 'plan' && !e.stale && mine(c),
      );
    }
    for (const id of [...this.#waitingCards]) {
      if ((this.#cardSessions.get(id) ?? 'body') !== kind) continue;
      this.#waitingCards.delete(id);
      this.#cardSessions.delete(id);
    }
    const desk = this.#desk;
    if (kind === 'desk' && desk && this.fsm.deskPc !== desk.pcId && !this.#stopped) {
      // The desk died in its last turn (its seat had ended): nothing to restart, the body takes back now instead of
      // after the supervisor's backoff.
      if (error) this.#log.warn({ err: error.message, pcId: desk.pcId }, 'desk ended after its seat');
      this.#setStatus();
      void this.#runBoundary();
      return;
    }
    if (error && !this.#stopped) {
      this.#log.warn({ err: error.message, session: kind }, 'session ended unexpectedly');
      const notFound = /No conversation found/i.test(error.message);
      // A new session whose id already has a transcript (an earlier launch wrote it, then died before Node saw its
      // init): Claude Code refuses the id ("Session ID … is already in use"), so the restart resumes it instead.
      const inUse = /Session ID \S+ is already in use/i.test(error.message);
      if (kind === 'body') {
        if (notFound) {
          // The session to resume never got written (e.g. the first launch failed): start a new one.
          this.record.sessionStarted = false;
          this.record.sessionId = randomUUID();
        } else if (inUse && !this.record.sessionStarted) {
          this.record.sessionStarted = true;
          this.#env.recordChanged?.(this);
        }
        this.#body = null;
      } else if (this.#desk && inUse && !this.#desk.record.sessionStarted) {
        this.#desk.record.sessionStarted = true;
        this.#env.recordChanged?.(this);
      } else if (this.#desk && notFound) {
        // The desk to resume is gone: the restart starts a fresh desk session at this PC.
        const pcId = this.#desk.pcId;
        const fresh: DeskRecord = {
          sessionId: randomUUID(),
          sessionStarted: false,
          createdAt: this.#env.now(),
          lastActiveAt: this.#env.now(),
        };
        this.record.desks = { ...this.record.desks, [pcId]: fresh };
        this.#desk = { ...this.#desk, record: fresh };
        this.#env.recordChanged?.(this);
      }
      this.#env.sessionExited(this, error, kind);
    }
    this.#setStatus();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------------------------------------------

  #setStatus(): void {
    const prev = this.#status;
    const session = this.session;
    for (const id of [...this.#waitingCards])
      if (this.#env.pending.get(id) === undefined) {
        this.#waitingCards.delete(id);
        this.#cardSessions.delete(id);
      }
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
    const activity = this.#activity === null ? null : singleLine(this.#redact(this.#activity), 160) || null;
    return {
      agentId: this.agentId,
      model: this.model,
      status: this.#status,
      activity,
      autonomy: this.record.autonomy,
      planFirst: this.record.planFirst,
      pingInstead: this.record.pingInstead,
    };
  }

  bark(bark: BarkKey): void {
    this.#env.say({ agentId: this.agentId, bark, style: 'bark', ttlMs: 3000 });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Seats and handoffs (PLAN §6.3)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The turn boundary: the handoffs between the two sessions. Runs under the seat mutex, only while the active
   * session is between turns.
   *
   * - Body active, the body sat at a PC (`seated_pending_handoff`): the desk session takes over (opened or resumed,
   *   with the KICKOFF handoff), the seat becomes `seated`.
   * - Desk active, its seat ended (stood up, kicked, pulled into a meeting, …): the desk session closes and the body
   *   takes back with a DESK REPORT.
   * - A seat that ended before any desk took over just finishes (`standing_pending_handoff → wandering`).
   */
  async #boundary(): Promise<void> {
    if (this.#stopped) return;
    const active = this.session;
    if (active?.started && active.inTurn) return;
    this.#boundaryHold++;
    try {
      const desk = this.#desk;
      if (desk && this.fsm.deskPc !== desk.pcId) {
        // The desk's seat is over (or moved to another PC): the body takes back.
        await this.#closeDesk();
      }
      const s = this.fsm.snapshot;
      if (s.state === 'seated_pending_handoff' && s.kind === 'pc' && s.pcId !== null && !this.#desk) {
        await this.#openDesk(s);
      } else if (s.state === 'standing_pending_handoff') {
        this.fsm.boundary();
        this.plans.clear();
      }
    } finally {
      this.#boundaryHold--;
      if (this.#boundaryHold === 0) queueMicrotask(() => this.#pump());
    }
  }

  /**
   * The body sat at `seat.pcId`: its desk session takes over. Resumes the PC's desk session when it was active within
   * the TTL (continuity of PC work), else starts a fresh one; the first desk turn opens with the KICKOFF handoff.
   */
  async #openDesk(seat: SeatSnapshot): Promise<void> {
    const pcId = seat.pcId;
    if (pcId === null) return;
    const env = this.#env;
    const now = env.now();
    if (!this.record.desks) this.record.desks = {};
    const desks = this.record.desks;
    const ttl = env.deskTtlMs ?? DESK_SESSION_TTL_MS;
    let record = desks[pcId];
    if (!record || (record.sessionStarted && now - record.lastActiveAt > ttl)) {
      record = { sessionId: randomUUID(), sessionStarted: false, createdAt: now, lastActiveAt: now };
      desks[pcId] = record;
      env.recordChanged?.(this);
    }
    const resumed = record.sessionStarted;
    const planFirst = this.record.planFirst;
    let session: AgentSession;
    try {
      const claude = env.claude();
      const cwd = env.deskHome?.(this.agentId, pcId) ?? env.agentHome(this.agentId);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      this.#deskListeners = [];
      session = this.#createSession('desk', {
        claude,
        resume: resumed ? record.sessionId : null,
        sessionId: record.sessionId,
        cwd,
        pcId,
        planFirst,
      });
    } catch (err) {
      this.#log.error({ err, pcId }, 'the desk session could not start: standing up');
      await env.skills
        .unseat({ agentId: this.agentId, seatEpoch: seat.epoch, reason: 'stand', keepReservation: false })
        .catch(() => {});
      this.fsm.stand('pc_down');
      this.fsm.boundary();
      this.enqueue({
        mode: 'wake',
        priority: 2,
        kind: 'CRITICAL',
        text: control(
          this.record.nonce,
          'CRITICAL',
          `Your PC session at ${pcId} could not start (${err instanceof Error ? err.message : String(err)}); you got up again.`,
        ),
      });
      return;
    }
    this.#desk = {
      pcId,
      session,
      record,
      resumed,
      turnTexts: [],
      lastText: null,
      changedFiles: [],
      commands: [],
      trackedMode: planFirst ? 'plan' : AGENT_PERMISSION_MODE,
      closedStrikes: 0,
      compactionListeners: this.#deskListeners,
    };
    this.#active = 'desk';
    this.#batch.reset();
    session.start();
    if (resumed) {
      // A resumed transcript may end in another permission mode: this sit's mode is set explicitly.
      await session
        .setPermissionMode(planFirst ? 'plan' : AGENT_PERMISSION_MODE)
        .catch((err: unknown) => this.#log.warn({ err }, 'setPermissionMode failed'));
    }
    this.#flushPending('desk');
    this.fsm.boundary();
    this.bark(BARKS.satAtPc);
    this.#log.info({ pcId, resumed, sessionId: record.sessionId }, 'desk session took over');
    await this.#queueKickoff(this.fsm.snapshot, resumed);
    env.brainChanged(this);
  }

  /**
   * The desk's seat ended: close the desk session (its record stays resumable), and hand back to the body with a DESK
   * REPORT (a wake; context only after a meeting call or a game restart, where the body has other things to say; none
   * when the brain is about to stop).
   */
  async #closeDesk(): Promise<void> {
    const desk = this.#desk;
    if (!desk) return;
    const env = this.#env;
    this.#desk = null;
    this.#active = 'body';
    desk.record.lastActiveAt = env.now();
    env.recordChanged?.(this);
    // Items only the desk could take are gone with it.
    const dropped = this.#queue.filter((q) => q.target === 'desk');
    this.#queue = this.#queue.filter((q) => q.target !== 'desk');
    this.#finishCollectors(dropped);
    this.#pendingContexts = this.#pendingContexts.filter((c) => c.target !== 'desk');
    // A card the desk raised ends with it (an interrupt aborts it too; this covers a close without one, e.g. a game
    // restart while the desk waited on the player): no orphaned question for a session that is gone.
    env.pending.cleanup(
      this.agentId,
      `Not seated at ${desk.pcId} any more.`,
      (c) => (c.kind === 'question' || c.kind === 'plan') && this.#cardSessions.get(c.id) === 'desk',
    );
    if (this.#grant && !this.#body?.inTurn) {
      this.#grant.release();
      this.#grant = null;
    }
    await desk.session.close().catch((err: unknown) => this.#log.warn({ err }, 'closing the desk failed'));
    this.#log.info({ pcId: desk.pcId }, 'desk session handed back to the body');
    // How the desk's own seat ended (a later seat, e.g. a meeting chair refused right after a meeting pull, does not
    // change it); the brain stops anyway after a terminal end of either.
    const latest = this.fsm.snapshot.lastEnd;
    const reason = this.fsm.snapshot.lastPcEnd ?? latest;
    const backlog = this.#bodyBacklog.splice(0);
    for (const text of backlog) this.#sendContext('body', text);
    if ((reason !== null && TERMINAL_ENDS.has(reason)) || (latest !== null && TERMINAL_ENDS.has(latest)))
      return;
    const report = deskReportMessage({
      nonce: this.record.nonce,
      playerName: env.playerName(),
      pcId: desk.pcId,
      outcome: outcomeOf(reason),
      why: this.#seatEndWhy ?? whyOf(reason, desk.pcId, env.playerName()),
      summary: desk.turnTexts.at(-1) ?? desk.lastText,
      changedFiles: desk.changedFiles,
      commands: desk.commands,
    });
    this.#seatEndWhy = null;
    if (reason === 'meeting' || reason === 'app_restart' || reason === 'worker_restart') {
      this.#sendContext('body', report);
      return;
    }
    const outcome = outcomeOf(reason);
    this.enqueue(
      {
        mode: 'wake',
        priority: outcome === 'done' ? 3 : 2,
        kind: 'DESK REPORT',
        key: 'desk-report',
        text: report,
      },
      undefined,
      'body',
    );
  }

  /** The KICKOFF handoff of a desk turn (PLAN §6.3 "Handoffs"). */
  async #queueKickoff(seat: SeatSnapshot, resumed: boolean): Promise<void> {
    if (seat.pcId === null) return;
    const pcId = seat.pcId;
    const env = this.#env;
    let info: Awaited<ReturnType<PcApi['info']>> | null = null;
    try {
      info = await env.pcs.info(pcId);
    } catch (err) {
      // The handoff still goes out (the task and the player's lines must not be lost), without the PC's details.
      this.#log.warn({ err, pcId }, 'kickoff: PC info failed');
    }
    const primary = info ? (info.mounts.find((m) => m.mode === 'rw') ?? info.mounts[0]) : undefined;
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
    const memory = await env.memory.text(this.agentId).catch(() => '');
    const playerLines = env.transcripts
      .tail(this.agentId, 200)
      .filter((e) => e.kind === 'player')
      .slice(-HANDOFF_PLAYER_LINES)
      .map((e) => e.text);
    let codexDigest: string | null = null;
    try {
      codexDigest = env.codexDigest?.(this.record.nonce) ?? null;
    } catch {
      codexDigest = null;
    }
    const handoff = {
      nonce: this.record.nonce,
      playerName: env.playerName(),
      task: seat.purpose,
      planFirst: this.record.planFirst,
      handoffs,
      resumed,
      playerLines,
      memory,
      codexDigest,
    };
    this.enqueue(
      {
        mode: 'wake',
        priority: 1,
        kind: 'KICKOFF',
        key: 'kickoff',
        text: info
          ? kickoffMessage({ ...handoff, pc: info, claudeMd })
          : kickoffWithoutPcMessage({ ...handoff, pcId }),
      },
      undefined,
      'desk',
    );
  }

  /** `mcp__mc__sit_at_pc` (PLAN §6.3 "Sitting"). */
  sitAtPc(request: { pcId: string; purpose: string; waitMs: number }): Promise<string> {
    const env = this.#env;
    return this.#seatMutex
      .run(async () => {
        if (this.fsm.state !== 'wandering' && this.fsm.state !== 'standing_pending_handoff') {
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
        const seated = s.jobId === jobId && (s.state === 'seated_pending_handoff' || s.state === 'seated');
        if (ok && seated)
          return `Seated at ${s.pcId}. End your turn now; your PC session takes over from here.`;
        return ok ? 'You are no longer on your way to that chair.' : `Could not sit: ${detail}.`;
      }
      const where = s.kind === 'meeting' ? 'the meeting table' : (s.pcId ?? 'the chair');
      if (!ok) {
        this.fsm.sitFailed();
        throw new ApiError('UNREACHABLE', `Could not sit at ${where}: ${detail}.`);
      }
      this.fsm.arrived();
      if (!this.session?.inTurn) await this.#boundary();
      this.#pump();
      if (s.kind === 'meeting') return 'Seated at the meeting table.';
      return `Seated at ${s.pcId}. End your turn now; your PC session takes over from here.`;
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
        if (!this.session?.inTurn) await this.#boundary();
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
        // Worker restart: the mod still has the agent in the chair; its desk session takes over again. The note is
        // the desk's own (the body would hear it only after the seat ended, where it is no longer true).
        this.fsm.restoreSeated(pcId, epoch);
        if (!this.session?.inTurn) await this.#boundary();
        const note = control(
          this.record.nonce,
          'RESTARTED',
          `MineVibe restarted; you are still seated at ${pcId}.`,
        );
        if (this.#desk?.pcId === pcId) this.#sendContext('desk', note);
        else this.context(note);
      }
    });
    this.#pump();
  }

  /**
   * `mcp__mc__stand_up`. From a desk session: its PC tools stop now and its turn is its last at this sit (the body
   * takes back with a DESK REPORT once it ends). From the meeting table: the body is back in Minecraft mode.
   */
  standUp(): Promise<string> {
    return this.#seatMutex.run(async () => {
      const s = this.fsm.snapshot;
      if (s.state === 'wandering' || s.state === 'standing_pending_handoff') return 'You are not seated.';
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
      if (!this.session?.inTurn) await this.#boundary();
      return stoodUpText(
        s.kind === 'pc' ? { kind: 'pc', pcId: s.pcId } : { kind: 'meeting' },
        this.#env.playerName(),
      );
    });
  }

  /**
   * The seat ended without the agent asking (`pc.unseat` from the mod: kick, damage, survival, PC down, player took
   * the chair, reservation expired, death, world end, dismissal). PLAN §6.3: interrupt the active session, kill the
   * agent's tagged guest processes, purge the stale kickoff and deny the pending plan card; the desk session's turn
   * ends and the body takes back with a DESK REPORT (or, when no desk had taken over yet, a critical notice).
   */
  async seatLost(
    reason: SeatEndReason,
    options: { releaseReservation?: boolean; why?: string } = {},
  ): Promise<void> {
    await this.#seatMutex.run(async () => {
      const before = this.fsm.snapshot;
      if (before.state === 'wandering' || before.state === 'standing_pending_handoff') return;
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
      this.#seatEndWhy = options.why ?? null;
      if (this.#awayTimer) clearTimeout(this.#awayTimer);
      this.#awayTimer = null;
      if (reason === 'stand') {
        if (!this.session?.inTurn) await this.#boundary();
        return;
      }
      const session = this.session;
      if (session?.inTurn) await session.interrupt();
      if (before.kind === 'pc' && before.pcId) {
        await this.#env.pcs
          .kill(before.pcId, { tag: `${this.agentId}:${before.epoch}` })
          .catch((err: unknown) => this.#log.warn({ err }, 'kill tagged processes failed'));
      }
      this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
      this.#env.pending.cleanup(this.agentId, `Not seated any more (${reason}).`, (c) => c.kind === 'plan');
      this.plans.clear();
      if (reason === 'kick') this.bark(BARKS.kicked);
      const notice = SEAT_END_TEXT[reason];
      if (!this.#desk && notice && before.pcId && before.kind === 'pc') {
        // No desk session took over yet (the body's sit turn was still running): the body hears it directly.
        this.enqueue(
          {
            mode: 'wake',
            priority: 2,
            kind: notice.kind,
            key: `unseat:${reason}`,
            text: control(this.record.nonce, notice.kind, notice.text(before.pcId, this.#env.playerName())),
          },
          undefined,
          'body',
        );
      }
      if (!this.session?.inTurn) await this.#boundary();
    });
    this.#pump();
  }

  /**
   * The desk session kept crashing (the supervisor gave up on it): the body stands up and takes back with a DESK
   * REPORT saying why; the body session itself keeps running.
   */
  async deskFailed(reason: string): Promise<void> {
    const s = this.fsm.snapshot;
    if (this.#desk === null) return;
    if (s.kind === 'pc' && this.fsm.deskPc !== null) {
      await this.#env.skills
        .unseat({ agentId: this.agentId, seatEpoch: s.epoch, reason: 'stand', keepReservation: false })
        .catch(() => {});
      await this.seatLost('pc_down', { why: `Your PC session at ${s.pcId} stopped working (${reason}).` });
      return;
    }
    await this.#seatMutex.run(() => this.#boundary());
    this.#pump();
  }

  /**
   * The player's Retry (`agent.cmd{retry_brain}`) while the body session runs: what stopped the brain came from a desk
   * session (its startup assertions failed, or its crash was an auth error), since a body that fails closes itself.
   * The brain is no longer offline or halted, and a desk that is down while its seat holds restarts (its new session
   * runs the startup assertions again). Without this, a halt raised by a desk outlived the desk, even after a stand.
   */
  async retryDesk(): Promise<void> {
    // A body that failed its own startup is still closing: only a new body lifts that halt.
    if (this.#stopped || !this.#body?.started || this.#haltedBy === 'body') return;
    this.#offline = false;
    this.#assertionsFailed = null;
    this.#haltedBy = null;
    if (this.#desk && !this.#desk.session.started) await this.restartDesk();
    this.#setStatus();
    this.#pump();
  }

  /**
   * Restarts the desk session after a crash (the supervisor's call): resumed when it had started, with a RESTARTED
   * note; a desk that never started gets its KICKOFF again. A seat that ended meanwhile just hands back to the body.
   */
  async restartDesk(): Promise<void> {
    await this.#seatMutex.run(async () => {
      const desk = this.#desk;
      if (!desk || this.#stopped) return;
      if (this.fsm.deskPc !== desk.pcId) {
        await this.#boundary();
        return;
      }
      if (desk.session.started) return;
      const resumed = desk.record.sessionStarted;
      try {
        const env = this.#env;
        this.#deskListeners = [];
        const session = this.#createSession('desk', {
          claude: env.claude(),
          resume: resumed ? desk.record.sessionId : null,
          sessionId: desk.record.sessionId,
          cwd: env.deskHome?.(this.agentId, desk.pcId) ?? env.agentHome(this.agentId),
          pcId: desk.pcId,
          planFirst: this.record.planFirst,
        });
        desk.session = session;
        desk.compactionListeners = this.#deskListeners;
        this.#batch.reset();
        session.start();
      } catch (err) {
        this.#log.error({ err }, 'desk restart failed');
        return;
      }
      if (resumed) {
        this.#sendContext(
          'desk',
          control(
            this.record.nonce,
            'RESTARTED',
            `Your PC session restarted; you are still seated at ${desk.pcId}.`,
          ),
        );
      } else {
        this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
        await this.#queueKickoff(this.fsm.snapshot, false);
      }
      this.#flushPending('desk');
    });
    this.#setStatus();
    this.#pump();
  }

  /** `seated → away_from_seat`: the agent walks over to ask the player (chair reserved, the desk session waits). */
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

  /** The answer came; walk back and sit (`away_from_seat → seated`), the desk session carries on. */
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
   * (`agent.unseat{meeting, keepReservation}`), the desk session's turn is interrupted (its card, if any, is denied)
   * and the body takes back for the meeting. Then the body walks to a meeting chair (`agent.seat{meeting}`); the sit
   * job's `skill.result` seats it. Resolves once the walk started.
   */
  pullIntoMeeting(meetingId: string): Promise<void> {
    return this.#seatMutex.run(async () => {
      const env = this.#env;
      const s = this.fsm.snapshot;
      if (s.kind === 'meeting' && s.meetingId === meetingId) return; // already there or on the way
      if (s.kind === 'pc' && s.state !== 'wandering' && s.state !== 'standing_pending_handoff') {
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
          this.fsm.stand('meeting');
          this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
          const session = this.session;
          if (session?.inTurn) await session.interrupt();
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
      if (this.fsm.state === 'standing_pending_handoff' && !this.session?.inTurn) await this.#boundary();
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
   * chair, where its desk session resumes with a new KICKOFF.
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
   * An agent pulled from its PC into a meeting walks back to its reserved chair; its desk session resumes there with a
   * new KICKOFF. Runs on its own (its sit job ends in `skill.result` like any sit, and it queues behind the seat
   * mutex); a refusal wakes the agent. No-op when the agent did not come from a PC.
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
   * unseated and the mod's jobs are gone. The seat ends (a desk session hands back to the body, its report as
   * context), tracked jobs are forgotten, and the agent is told (context, no turn).
   */
  async gameRestarted(): Promise<void> {
    const s = this.fsm.snapshot;
    const pcId = s.kind === 'pc' && this.fsm.holdsPcSeat ? s.pcId : null;
    const hadJobs = this.#jobs.size > 0;
    this.#jobs.clear();
    this.toolJobs.clear();
    this.#meetingReturn = null;
    if (this.#awayTimer) clearTimeout(this.#awayTimer);
    this.#awayTimer = null;
    this.#queue = this.#queue.filter((q) => q.kind !== 'KICKOFF');
    const reset = this.resetSeat('app_restart');
    // A plan for a PC the agent no longer sits at dies with the seat (as on a kick).
    if (pcId) this.#env.pending.cleanup(this.agentId, 'The game restarted.', (c) => c.kind === 'plan');
    await reset;
    const parts = ['The game restarted.'];
    if (pcId) parts.push(`You are no longer seated at ${pcId}.`);
    if (hadJobs) parts.push('Jobs you had running were stopped.');
    this.context(control(this.record.nonce, 'RESTARTED', parts.join(' ')));
    this.#setStatus();
  }

  /**
   * App restart, death, dismissal or world end: unseated at once. An open desk session is interrupted and closed (its
   * record stays resumable); only a game restart reports it to the body (as context).
   */
  async resetSeat(reason: SeatEndReason): Promise<void> {
    await this.#seatMutex.run(async () => {
      if (this.fsm.state === 'wandering' && !this.#desk) return;
      if (this.fsm.state !== 'wandering') this.fsm.reset(reason);
      this.plans.clear();
      const desk = this.#desk;
      if (desk?.session.inTurn) await desk.session.interrupt();
      if (desk) await this.#closeDesk();
    });
    this.#pump();
  }

  #clearTimers(): void {
    if (this.#awayTimer) clearTimeout(this.#awayTimer);
    this.#awayTimer = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Tool hosts
  // ---------------------------------------------------------------------------------------------------------------

  /** The `mc` host of one session (the transcript lines of its `say` carry the session's tag). */
  #mcHost(kind: SessionKind): McHost {
    const env = this.#env;
    return {
      agentId: this.agentId,
      skills: env.skills,
      org: env.toolOrg ?? env.org,
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
      say: (said) => {
        // Redacted before the bubble is cut to length (a cut must never leave part of an account identifier).
        const text = this.#redact(said);
        const bubble = bubbleText(text);
        env.say({
          agentId: this.agentId,
          text: bubble,
          style: 'speech',
          ttlMs: Math.min(20_000, Math.max(4_000, bubble.length * 70)),
        });
        env.transcripts.append(this.agentId, { kind: 'agent', text, ...this.#tag(kind) });
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
      hasConsent: () => (env.consents?.active(this.agentId) ?? null) !== null,
      noteRefusal: (refusal) => env.consents?.noteRefusal(this.agentId, refusal),
      jobs: this.toolJobs,
      crewMember: (ref) => env.crewMember?.(ref) ?? null,
      crewNames: (agentId) => env.crewNames?.(agentId) ?? null,
      body: () => env.body(this.agentId),
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
      jobs: this.#pcJobs,
      batch: this.#batch,
      playerName: () => env.playerName(),
      // The tool server subscribes while it is built, before its desk state exists: the listeners are collected for
      // the desk session being created (#deskListeners) and handed to its state.
      onCompaction: (listener) => {
        this.#deskListeners.push(listener);
      },
      onCommand: ({ pcId, command, exitCode }) => {
        const desk = this.#desk;
        if (desk?.pcId !== pcId) return;
        desk.commands.push({ command, exitCode });
        if (desk.commands.length > DESK_COMMANDS_KEPT) desk.commands.shift();
      },
      onFileChanged: ({ pcId, path }) => {
        const desk = this.#desk;
        if (desk?.pcId !== pcId) return;
        desk.changedFiles.push(path);
      },
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
