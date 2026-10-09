/**
 * AgentManager (PLAN §6): the crew of the current world, behind the CrewApi the UI uses.
 *
 * - **World lifecycle.** A fresh world gets a CEO (`agent.spawn` at the office door); a reopened world restores its
 *   living agents (resumed sessions, everyone unseated with a restart notice, stale cards re-asked). Player death
 *   gives the CEO an 8 s last-words turn off the scheduler, barks for the others, then every session is closed and a
 *   Chronicle entry is written.
 * - **Crew changes.** Hire cards (CEO `request_hire` → player decision → spawn + new session + CEO wake), dismissal,
 *   death (grave and diary are the mod's) and succession (most senior agent; an empty crew gets a newcomer at dawn).
 * - **Chat.** `chat.send` lines are routed by the ChatRouter (mentions, broadcasts, meetings, card answers),
 *   debounced per agent and delivered as P0 wakes or context.
 * - **Events.** Body events, job ends, tells, task reports, calendar tasks and autonomy nudges become digest lines,
 *   context or wakes (EventRouter) on each agent's brain, through the BrainScheduler and the UsageGovernor. Each brain
 *   runs a body session and, at a PC, a desk session (PLAN §6.1, dual sessions); everything goes to its active one.
 * - **Privacy.** The outbound redactor (agents/redact.ts) learns the account's e-mail address and organisation from
 *   the sessions' `accountInfo()` and blanks them in everything agent-authored that leaves a session.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentBody,
  type AgentRole,
  type BrainsSummary,
  type ChatHistoryResult,
  ERROR_CODES,
  type MessageOf,
  type PayloadOf,
  type Place,
  type UnseatReason,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import type {
  AgentDeliveryInfo,
  AgentSummary,
  ChatDelivery,
  CrewActionResult,
  CrewApi,
  CrewCardAnswer,
  CrewCommand,
  CrewEvents,
  DeliveryResult,
} from '../contracts/CrewApi.js';
import { ApiError, isApiError, PLAYER } from '../contracts/common.js';
import { mcRefs, mcToolsVersion } from '../contracts/mcRefs.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';
import { withSequenceFallback } from '../contracts/SequenceFallback.js';
import type { JobEnd, SkillApi } from '../contracts/SkillApi.js';
import { writeFileAtomic } from '../util/atomicFile.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { type BaseArea, baseAreaOf, type OfficeLayout } from '../world/baseArea.js';
import { AgentBrain, type AgentRecord, type BrainEnv } from './AgentBrain.js';
import { BrainScheduler } from './BrainScheduler.js';
import { BrainSupervisor, type SupervisorOptions } from './BrainSupervisor.js';
import { type CardInterpretation, grammarCard, interpretWireAnswer } from './cardAnswers.js';
import { formatAnswerEcho, frontCard } from './chat/answerGrammar.js';
import { type ChatContext, ChatInbox, ChatRouter, type Delivery } from './chat/ChatRouter.js';
import { handleFromName, validateHandle } from './chat/handles.js';
import type { ResolvedClaude } from './claudeBinary.js';
import { CREW_CAP, LAST_WORDS_MS, type McToolsVersion, MOD_AGENT_ID, type SessionKind } from './constants.js';
import { EventRouter, type RoutedFor, type RouterAgent } from './EventRouter.js';
import { control, escapeShared, neutralizeControlTags, newNonce, singleLine, wrapNote } from './envelope.js';
import { Chronicle, HandoffNotes, MemoryStore } from './memory.js';
import type { BrainMode } from './modes.js';
import { type Card, newCardId, PendingStore } from './PendingStore.js';
import { BARKS } from './prompts/barks.js';
import {
  memoryContext,
  promotedMessage,
  restartNotice,
  rosterContext,
  welcomeMessage,
} from './prompts/kickoff.js';
import { sanitizeDisplayName } from './prompts/persona.js';
import { AccountRedactor, redactingOrgApi } from './redact.js';
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from './sdk.js';
import { TranscriptStore } from './TranscriptStore.js';
import { UsageGovernor } from './UsageGovernor.js';
import { ConsentLedger, type GrantVerdict, grantScope } from './world/consent.js';
import { PROTECTED, refusalOf } from './world/guard.js';
import { zoneOfBody } from './world/scene.js';

/** First names for agents (handles derive from them). */
export const AGENT_NAMES = [
  'Ada',
  'Bram',
  'Cleo',
  'Dax',
  'Esme',
  'Finn',
  'Gus',
  'Hana',
  'Ivo',
  'Juno',
  'Kit',
  'Lena',
  'Milo',
  'Nora',
  'Otto',
  'Pip',
  'Quinn',
  'Rosa',
  'Sven',
  'Tove',
  'Uma',
  'Vic',
  'Wren',
  'Yara',
  'Zeno',
] as const;

export interface WorldInfo {
  readonly worldId: string;
  readonly gen: number;
}

export interface AgentManagerOptions {
  readonly skills: SkillApi;
  readonly org: OrgApi;
  readonly pcs: PcApi;
  readonly claude: ResolvedClaude | (() => ResolvedClaude);
  /** The allowlisted agent env (agentEnv()). */
  readonly agentEnv: () => Record<string, string>;
  /** `worlds/` (per-world crew and agent data). */
  readonly worldsDir: string;
  /** `state/` (Chronicle, Vault handoff notes). */
  readonly stateDir: string;
  readonly playerName: () => string;
  readonly log: Logger;
  readonly queryFactory?: QueryFactory;
  readonly now?: () => number;
  /** Player messages within this window merge into one wake (default 2000 ms). */
  readonly chatDebounceMs?: number;
  readonly crewCap?: number;
  readonly authMode?: 'subscription' | 'api_key';
  /** Autonomy ticker period (default 30 s; 0 disables). */
  readonly autonomyTickMs?: number;
  /**
   * Decides an agent-created calendar event the player approved. Optional: by default the card's answer goes to
   * `OrgApi.calendar.decide`.
   */
  readonly approveCalendarEvent?: (eventId: string) => Promise<void>;
  readonly lastWordsMs?: number;
  /** How long a desk session stays resumable after its last turn (default 6 h, PLAN §6.1). */
  readonly deskTtlMs?: number;
  /** The agents' `mc` tool set (default: `MINEVIBE_MC_TOOLS`; tools-v2-mc.md §14). */
  readonly mcTools?: McToolsVersion | undefined;
  /** Restart policy overrides (tests). */
  readonly supervisor?: Omit<SupervisorOptions, 'now'>;
  /**
   * Where new agents (the first CEO, hires, the dawn newcomer) appear: the office door slot of `world.state.office`
   * (PLAN §6.4 "spawn at the office door"). Null, or no option, lets the mod place the body near the player.
   */
  readonly spawnPlace?: () => Promise<Place | null>;
  /**
   * Whether `calendarFired` events become task wakes and reminder bubbles here (default true). The composed runtime
   * turns it off: the org module delivers calendar tasks through CrewHooks.deliver (orchestrator/modules.ts).
   */
  readonly calendarWakes?: boolean;
}

/** A crew member's fate for the Game Over summary (`world.next.summary.crewFates`). */
export interface CrewFate {
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  readonly fate: 'died' | 'dismissed' | 'lost_with_world';
  readonly detail?: string | undefined;
}

/** Events beyond the CrewApi ones (forwarded as `brains.state`, `ui.toast`; card and meeting hooks). */
export type ManagerEvents = CrewEvents & {
  brains: [payload: BrainsSummary];
  toast: [payload: PayloadOf<'ui.toast'>];
  /** A card went up (the ApproachQueue decides who presents). */
  card: [card: Card];
  /** Unmentioned player lines during a meeting (for the MeetingRunner). */
  meetingMessage: [payload: { readonly text: string; readonly agentIds: readonly string[] }];
  /** A ToolGate decision, with the model the session ran and the effort the CLI applied. */
  tool: [payload: ToolObservation];
  /** A real turn of an agent ended (in its body or desk session). */
  turn: [
    payload: {
      readonly agentId: string;
      readonly result: SDKResultMessage;
      readonly model: string | null;
      readonly session: SessionKind;
    },
  ];
};

export interface ToolObservation {
  readonly agentId: string;
  readonly toolName: string;
  readonly behavior: 'allow' | 'deny' | 'defer';
  readonly reason: string;
  /** The deny code (`mode` for a tool outside the agent's mode), null otherwise. */
  readonly code: string | null;
  /** The mode of the agent's seat when the call came (agents/modes.ts). */
  readonly mode: BrainMode;
  /** The session that made the call: the body or the desk (PLAN §6.1, dual sessions). */
  readonly session: SessionKind;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly model: string | null;
}

interface CrewFile {
  readonly v: 1;
  readonly worldId: string;
  readonly gen: number;
  readonly records: AgentRecord[];
  /** Set when the player died: the world's crew data stays here as its archive and is never loaded again. */
  readonly ended?: { readonly day: number; readonly cause: string; readonly at: number } | undefined;
}

function clockDay(ticks: number): number {
  return Math.floor(ticks / 24_000) + 1;
}

/**
 * USER DECISION 2026-10-08 (no automatic plan mode): Plan-first is only on when the player turned it on. Records saved
 * before the decision carry the old role default (on for CEO and Engineer) without `planFirstByPlayer`; they load off.
 */
export function migratePlanFirst(record: AgentRecord): AgentRecord {
  if (record.planFirst && record.planFirstByPlayer !== true) record.planFirst = false;
  return record;
}

export class AgentManager extends TypedEmitter<ManagerEvents> implements CrewApi {
  readonly #o: AgentManagerOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly scheduler: BrainScheduler;
  readonly governor: UsageGovernor;
  readonly supervisor: BrainSupervisor;
  readonly router: EventRouter;
  readonly pending: PendingStore;
  readonly transcripts: TranscriptStore;
  readonly chronicle: Chronicle;
  readonly handoffs: HandoffNotes;
  /** Consents to change protected blocks (protocol §7.4.3): only the player's explicit answers mint them. */
  readonly consents: ConsentLedger;
  #memory: MemoryStore;
  readonly #chatRouter = new ChatRouter();
  readonly #chatInbox: ChatInbox;
  readonly #chatModes = new Map<string, 'chat' | 'reply' | 'task' | 'interrupt'>();
  #chatTimer: NodeJS.Timeout | null = null;
  #world: WorldInfo | null = null;
  #records: AgentRecord[] = [];
  readonly #brains = new Map<string, AgentBrain>();
  readonly #bodies = new Map<string, AgentBody>();
  readonly #occupants = new Map<string, string>();
  #clockTime: number | null = null;
  /** The starter office of the world it came with (`world.state.office`): the Base. */
  #office: { readonly worldId: string; readonly layout: OfficeLayout } | null = null;
  #dawnNewcomer = false;
  #autonomyTimer: NodeJS.Timeout | null = null;
  #rulesRevs = new Map<string, string>();
  #persistChain: Promise<void> = Promise.resolve();
  readonly #off: (() => void)[] = [];
  #ending = false;
  #ended: CrewFile['ended'] = undefined;
  /** False after the game booted again (an app restart): seats the mod reports are not restored. */
  #seatRestore = true;
  /** Set by {@link shutdown}: no brain is created or started any more (a world open still in flight stops). */
  #closed = false;
  /** Cumulative tokens per agent and session (`<agentId>:body`, `<agentId>:desk`). */
  #tokens = new Map<string, number>();
  /**
   * The outbound redactor (agents/redact.ts): the account's e-mail address and organisation, learned from the
   * sessions' `accountInfo()` and kept only in memory, are replaced by `[redacted]` in everything agents write that
   * leaves their sessions.
   */
  readonly redactor = new AccountRedactor();
  /** The OrgApi the agents' `mc` tools write through: Codex, calendar and task-report text redacted. */
  readonly #toolOrg: OrgApi;

  constructor(options: AgentManagerOptions) {
    super();
    // `sequence` (the v2 `do` tool) runs in Node when the mod has no `skill.sequence` cap (tools-v2-mc.md §11).
    this.#o = { ...options, skills: withSequenceFallback(options.skills) };
    options = this.#o;
    this.#log = options.log.child({ component: 'agents' });
    this.#now = options.now ?? Date.now;
    this.scheduler = new BrainScheduler({ now: this.#now });
    this.governor = new UsageGovernor({ now: this.#now });
    this.supervisor = new BrainSupervisor({ now: this.#now, ...options.supervisor });
    this.router = new EventRouter({
      now: this.#now,
      playerName: options.playerName,
      mcTools: options.mcTools,
    });
    this.pending = new PendingStore({
      fileOf: (agentId) => (this.#world ? join(this.#agentDir(agentId), 'pending.json') : null),
      onError: (err) => this.#log.warn({ err }, 'pending store'),
    });
    this.transcripts = new TranscriptStore({
      fileOf: (agentId) => (this.#world ? join(this.#agentDir(agentId), 'chat.jsonl') : null),
      now: this.#now,
      onError: (err) => this.#log.warn({ err }, 'transcript store'),
      redact: (text) => this.redactor.redact(text),
    });
    this.#memory = new MemoryStore((agentId) => join(this.#agentDir(agentId), 'memory.md'));
    this.chronicle = new Chronicle(join(options.stateDir, 'chronicle.json'));
    this.handoffs = new HandoffNotes(join(options.stateDir, 'vault-handoffs'), {
      redact: (text) => this.redactor.redact(text),
    });
    this.#toolOrg = redactingOrgApi(options.org, this.redactor);
    this.consents = new ConsentLedger({ now: this.#now });
    this.#chatInbox = new ChatInbox(options.chatDebounceMs ?? 2_000);

    this.#off.push(
      this.scheduler.on('change', () => this.#emitBrains()),
      this.governor.on('change', (state) => {
        this.scheduler.setMode(state.mode);
        for (const b of this.#brains.values()) b.refresh();
        if (state.mode === 'asleep') {
          const until = state.resetsAt ? new Date(state.resetsAt).toTimeString().slice(0, 5) : 'later';
          this.emit('toast', {
            text:
              state.reason === 'auth'
                ? 'Brains asleep: claude needs you to log in again'
                : `Brains recharge at ${until}`,
            kind: 'warn',
          });
        }
        this.#emitBrains();
      }),
      this.pending.on('changed', (agentId, cards) => {
        this.emit('pending', { agentId, cards: [...cards] });
        this.#brains.get(agentId)?.refresh();
      }),
      this.transcripts.on('append', (agentId, entry) => {
        this.emit('chat', { agentId, entry });
      }),
      this.pending.on('resolved', (card, outcome) => {
        if (card.kind !== 'question' || outcome.kind !== 'answered') return;
        this.#consentVerdict(
          card.agentId,
          this.consents.fromCard(card.agentId, card, outcome.answers),
          'card',
        );
      }),
      options.skills.on('result', (end) => this.#onJobEnd(end)),
      options.skills.on('progress', (p) => this.#brains.get(p.agentId)?.toolJobs.progress(p.jobId, p.text)),
      options.org.on('codexIndex', (index) => void this.#onCodexIndex(index)),
    );
    if (options.calendarWakes !== false) {
      this.#off.push(options.org.on('calendarFired', (fired) => this.#onCalendarFired(fired)));
    }
    const tick = options.autonomyTickMs ?? 30_000;
    if (tick > 0) {
      this.#autonomyTimer = setInterval(() => this.#autonomyTick(), tick);
      this.#autonomyTimer.unref?.();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Paths and persistence
  // ---------------------------------------------------------------------------------------------------------------

  get world(): WorldInfo | null {
    return this.#world;
  }

  #worldDir(): string {
    if (!this.#world) throw new Error('no world');
    return join(this.#o.worldsDir, this.#world.worldId);
  }

  #agentDir(agentId: string): string {
    return join(this.#worldDir(), 'agents', agentId);
  }

  #crewFile(): string {
    return join(this.#worldDir(), 'crew.json');
  }

  #persist(): Promise<void> {
    if (!this.#world) return Promise.resolve();
    const world = this.#world;
    const file = this.#crewFile();
    const body: CrewFile = {
      v: 1,
      worldId: world.worldId,
      gen: world.gen,
      records: this.#records,
      ...(this.#ended ? { ended: this.#ended } : {}),
    };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    this.#persistChain = this.#persistChain
      .then(() => writeFileAtomic(file, text, { mode: 0o600 }))
      .catch((err: unknown) => this.#log.error({ err }, 'crew.json write failed'));
    return this.#persistChain;
  }

  async #loadCrew(): Promise<AgentRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#crewFile(), 'utf8')) as Partial<CrewFile>;
      return Array.isArray(parsed.records) ? parsed.records.map(migratePlanFirst) : [];
    } catch {
      return [];
    }
  }

  /** Waits for queued writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.#persistChain;
    await this.pending.flush();
    await this.transcripts.flush();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Brain environment
  // ---------------------------------------------------------------------------------------------------------------

  #env(): BrainEnv {
    const o = this.#o;
    return {
      scheduler: this.scheduler,
      governor: this.governor,
      pending: this.pending,
      transcripts: this.transcripts,
      memory: this.#memory,
      handoffs: this.handoffs,
      skills: o.skills,
      org: o.org,
      pcs: o.pcs,
      queryFactory: o.queryFactory ?? sdkQueryFactory,
      log: this.#log,
      now: this.#now,
      claude: () => (typeof o.claude === 'function' ? o.claude() : o.claude),
      agentEnv: o.agentEnv,
      agentHome: (agentId) => join(this.#agentDir(agentId), 'home'),
      // Each desk session has a cwd of its own (Claude Code keeps its transcripts per cwd): `agents/<id>/desk/<pc>`.
      deskHome: (agentId, pcId) => join(this.#agentDir(agentId), 'desk', pcId),
      playerName: o.playerName,
      occupant: (pcId) => this.#occupants.get(pcId) ?? null,
      seatedOthers: (agentId) =>
        [...this.#brains.values()].filter((b) => b.agentId !== agentId && b.fsm.holdsPcSeat).length,
      body: (agentId) => this.#bodies.get(agentId) ?? null,
      clockTime: () => this.#clockTime,
      base: () => this.base(),
      consents: this.consents,
      tell: (from, to, text) => this.#tell(from, to, text),
      crewMember: (ref) => {
        const r = this.#resolveCrewRef(ref);
        return r && r.status === 'alive' ? { agentId: r.agentId, name: r.name, handle: r.handle } : null;
      },
      crewNames: (agentId) => {
        const r = this.#records.find((x) => x.agentId === agentId);
        return r ? { handle: r.handle, name: r.name, role: r.role } : null;
      },
      mcTools: o.mcTools,
      requestHire: (from, req) => this.#requestHire(from, req),
      taskReported: (from, report) => {
        const ceo = this.#ceoRecord();
        for (const r of this.router.taskReport(
          this.#routerAgent(from.record),
          ceo ? this.#routerAgent(ceo) : undefined,
          this.redactor.redactDeep(report),
        )) {
          this.#deliver(r);
        }
      },
      say: (payload) =>
        this.emit(
          'say',
          payload.text === undefined ? payload : { ...payload, text: this.redactor.redact(payload.text) },
        ),
      brainChanged: (brain) => this.emit('brain', brain.brainPayload()),
      sessionExited: (brain, error, session) => this.#onSessionCrash(brain, error, session),
      assertionsFailed: (brain, problems) =>
        this.emit('toast', {
          text: `${brain.record.name} can't think: ${problems[0] ?? 'startup check failed'}`,
          kind: 'error',
          agentId: brain.agentId,
          ttlMs: 15_000,
        }),
      turnEnded: (brain, result, session) => this.#onTurnEnded(brain, result, session),
      toolObserved: (brain, o) =>
        this.emit('tool', {
          agentId: brain.agentId,
          toolName: o.toolName,
          behavior: o.decision.behavior,
          reason: o.decision.reason,
          code: o.decision.behavior === 'deny' ? o.decision.code : null,
          mode: brain.mode,
          session: o.session ?? brain.activeSession,
          effort: o.effort,
          permissionMode: o.permissionMode,
          model:
            (o.session === 'desk'
              ? brain.deskSession
              : o.session === 'body'
                ? brain.bodySession
                : brain.session
            )?.model ?? null,
        }),
      cardRaised: (_brain, card) => this.emit('card', card),
      authMode: () => o.authMode ?? 'subscription',
      deskTtlMs: o.deskTtlMs,
      recordChanged: () => void this.#persist(),
      seatRestore: () => this.#seatRestore,
      codexDigest: (nonce) => this.#codexDigest(nonce),
      noteAccount: (account) => this.redactor.noteAccount(account),
      redact: (text) => this.redactor.redact(text),
      toolOrg: this.#toolOrg,
      worldGen: () => this.#world?.gen ?? null,
    };
  }

  #routerAgent(r: AgentRecord): RouterAgent {
    const brain = this.#brains.get(r.agentId);
    const body = this.#bodies.get(r.agentId);
    return {
      agentId: r.agentId,
      name: r.name,
      handle: r.handle,
      role: r.role,
      ceo: r.ceo,
      alive: r.status === 'alive',
      seated: brain?.fsm.holdsPcSeat ?? false,
      nonce: r.nonce,
      autonomy: r.autonomy,
      playerDistance: body?.playerDistance ?? null,
    };
  }

  #crewView(): RouterAgent[] {
    return this.#records.map((r) => this.#routerAgent(r));
  }

  #deliver(r: RoutedFor): void {
    this.#brains.get(r.agentId)?.enqueue(r.item);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // World lifecycle
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * The world is ready (`world.state{ready}`): restore its crew, or hire the first CEO in a fresh world. Calling it
   * again for the same world (a reconnect) only re-announces the crew.
   */
  async openWorld(world: WorldInfo, options: { respawn?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    if (this.#world?.worldId === world.worldId) {
      if (options.respawn) {
        // The game restarted into the same world while Node kept running (PLAN §6.3 "App restart"): the bodies are
        // only in the playerdata now, unseated, and their jobs are gone. The brains follow: no seat, no PC access.
        this.#occupants.clear();
        this.#bodies.clear();
        for (const r of this.#records.filter((x) => x.status === 'alive')) {
          // Not awaited: the desk session (if any) hands back to the body first, and the world open must not wait.
          void this.#brains
            .get(r.agentId)
            ?.gameRestarted()
            .catch((err: unknown) => this.#log.warn({ err, agentId: r.agentId }, 'seat reset failed'));
          await this.#respawn(r);
        }
      }
      this.#emitCrew();
      return;
    }
    if (this.#world) await this.#closeWorld('world changed');
    this.#world = world;
    this.#ending = false;
    this.#ended = undefined;
    this.#memory = new MemoryStore((agentId) => join(this.#agentDir(agentId), 'memory.md'));
    await mkdir(this.#worldDir(), { recursive: true });
    this.#records = await this.#loadCrew();
    const alive = this.#records.filter((r) => r.status === 'alive');
    if (alive.length === 0) {
      if (this.#records.length === 0) await this.#hireCeo({ fresh: true });
      else this.#dawnNewcomer = true;
    } else {
      for (const r of alive) await this.#restore(r);
    }
    this.#emitCrew();
    this.#emitBrains();
  }

  /** `agent.spawn{restore}` (idempotent in the mod): the body comes back from its playerdata. */
  async #respawn(record: AgentRecord): Promise<void> {
    try {
      await this.#o.skills.spawn({
        agentId: record.agentId,
        handle: record.handle,
        name: record.name,
        role: record.role,
        ceo: record.ceo,
        restore: true,
        mode: 'follow',
      });
    } catch (err) {
      this.#log.warn({ err, agentId: record.agentId }, 'restore spawn failed');
    }
  }

  /** The office door (or null), never failing the spawn it is for. */
  async #spawnAt(): Promise<{ at: Place } | Record<string, never>> {
    try {
      const at = (await this.#o.spawnPlace?.()) ?? null;
      return at ? { at } : {};
    } catch (err) {
      this.#log.warn({ err }, 'no spawn place');
      return {};
    }
  }

  async #restore(record: AgentRecord): Promise<void> {
    await this.#respawn(record);
    await this.transcripts.load(record.agentId);
    const stale = await this.pending.load(record.agentId);
    for (const card of stale) {
      if (card.kind === 'plan')
        this.pending.resolve(card.id, { kind: 'denied', reason: 'The app restarted.' });
    }
    const brain = await this.#createBrain(record);
    const contexts = await this.#startContexts(record);
    contexts.push(
      restartNotice(
        record.nonce,
        record.lastSeatedPc ?? null,
        record.lastActiveAt ? this.#now() - record.lastActiveAt : null,
      ),
    );
    record.lastSeatedPc = null;
    brain.start({ contexts });
    await this.#persist();
  }

  async #startContexts(record: AgentRecord): Promise<string[]> {
    const out: string[] = [];
    out.push(rosterContext(record.nonce, record.handle, this.#records));
    const mem = memoryContext(record.nonce, await this.#memory.text(record.agentId).catch(() => ''));
    if (mem) out.push(mem);
    const digest = this.#codexDigest(record.nonce);
    if (digest) out.push(digest);
    return out;
  }

  /** The Codex digest (rules, pinned pages, recent pages per category), as context (PLAN §6.6). */
  #codexDigest(nonce: string): string | null {
    let index: PayloadOf<'codex.index'>;
    try {
      index = this.#o.org.codex.index();
    } catch {
      return null;
    }
    if (index.pages.length === 0) return null;
    const rules = index.pages.filter((p) => p.category === 'rules' && p.author.kind === 'player');
    const others = index.pages
      .filter((p) => p.category !== 'rules')
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated)
      .slice(0, 20);
    const lines = others.map((p) => `[${p.id}] ${p.title} (${p.category}${p.pinned ? ', pinned' : ''})`);
    const parts = [
      control(
        nonce,
        'CODEX DIGEST',
        `The Codex has ${index.pages.length} page(s). Read with ${mcRefs(this.#mcTools()).codexRead}.`,
      ),
    ];
    if (lines.length > 0)
      parts.push(wrapNote({ author: 'the Codex', kind: 'codex', text: lines.join('\n') }));
    if (rules.length > 0) {
      parts.push(
        control(
          nonce,
          'HOUSE RULES',
          `${this.#o.playerName()}'s rules pages: ${rules.map((r) => r.id).join(', ')} (read them).`,
        ),
      );
    }
    return parts.join('\n');
  }

  /** Creates the brain and its claude cwd (`agents/<id>/home`; spawning in a missing cwd fails to launch). */
  async #createBrain(record: AgentRecord): Promise<AgentBrain> {
    const existing = this.#brains.get(record.agentId);
    if (existing) return existing;
    // After shutdown a brain would start a claude nobody closes.
    if (this.#closed) throw new Error('the agent runtime is shutting down');
    await mkdir(join(this.#agentDir(record.agentId), 'home'), { recursive: true, mode: 0o700 });
    if (this.#closed) throw new Error('the agent runtime is shutting down');
    const raced = this.#brains.get(record.agentId);
    if (raced) return raced;
    const brain = new AgentBrain(record, this.#env());
    this.#brains.set(record.agentId, brain);
    return brain;
  }

  #pickName(): { name: string; handle: string } {
    const taken = this.#takenHandles();
    for (const name of AGENT_NAMES) {
      const handle = handleFromName(name);
      if (handle && validateHandle(handle, { taken, playerName: this.#o.playerName() }) === null)
        return { name, handle };
    }
    const n = this.#records.length + 1;
    return { name: `Agent ${n}`, handle: `agent${n}` };
  }

  #takenHandles(): string[] {
    const fromCards = this.pending
      .all()
      .filter((c): c is Extract<Card, { kind: 'hire' }> => c.kind === 'hire')
      .map((c) => c.handle);
    return [...this.#records.map((r) => r.handle), ...fromCards];
  }

  /**
   * A new agent id inside the mod's rule (`MOD_AGENT_ID`): the mod names the body's fake player after it, so it is at
   * most 16 characters of `[a-z0-9_]` starting with a letter. The handle (`[a-z][a-z0-9]{1,11}`) plus 4 hex digits,
   * unique among this world's records (ids of the dead and dismissed included).
   */
  #mintAgentId(handle: string): string {
    const taken = new Set(this.#records.map((r) => r.agentId));
    for (;;) {
      const id = `${handle}${randomUUID().replaceAll('-', '').slice(0, 4)}`;
      if (!taken.has(id) && MOD_AGENT_ID.test(id)) return id;
    }
  }

  #newRecord(input: { name: string; handle: string; role: AgentRole; ceo: boolean }): AgentRecord {
    const seniority = this.#records.reduce((m, r) => Math.max(m, r.seniority), 0) + 1;
    return {
      agentId: this.#mintAgentId(input.handle),
      handle: input.handle,
      name: input.name,
      role: input.role,
      ceo: input.ceo,
      status: 'alive',
      hiredAt: this.#now(),
      seniority,
      sessionId: randomUUID(),
      sessionStarted: false,
      nonce: newNonce(),
      autonomy: 'listen',
      // USER DECISION 2026-10-08: no automatic plan mode. Plan-first is off for every role; only the player's toggle
      // in AgentScreen turns it on for one agent.
      planFirst: false,
      pingInstead: false,
    };
  }

  /** Spawns a new CEO (fresh world, or a newcomer at dawn when the crew is empty). */
  async #hireCeo(options: { fresh: boolean }): Promise<AgentRecord | null> {
    if (!this.#world || this.#closed) return null;
    const { name, handle } = this.#pickName();
    const record = this.#newRecord({ name, handle, role: 'ceo', ceo: true });
    const world = this.#world;
    const at = await this.#spawnAt();
    if (this.#world !== world || this.#ending || this.#closed) return null;
    try {
      await this.#o.skills.spawn({
        agentId: record.agentId,
        handle,
        name,
        role: 'ceo',
        ceo: true,
        restore: false,
        mode: 'follow',
        bark: BARKS.reportingForDuty,
        ...at,
      });
    } catch (err) {
      this.#log.error({ err }, 'CEO spawn failed');
      this.emit('toast', {
        text: `The CEO could not arrive: ${err instanceof Error ? err.message : String(err)}`,
        kind: 'error',
      });
      return null;
    }
    this.#records.push(record);
    await this.#persist();
    const brain = await this.#createBrain(record);
    const chronicle = await this.chronicle.paragraph().catch(() => '');
    const contexts = await this.#startContexts(record);
    brain.start({
      contexts,
      wakes: [
        {
          mode: 'wake',
          priority: 1,
          kind: 'WELCOME',
          text: welcomeMessage({
            nonce: record.nonce,
            playerName: this.#o.playerName(),
            worldGen: this.#world.gen,
            ceo: true,
            chronicle: chronicle || undefined,
            codexSurvived: this.#world.gen > 1,
            base: this.base(),
          }),
        },
      ],
    });
    await this.#persist();
    this.#log.info({ agentId: record.agentId, name, fresh: options.fresh }, 'CEO arrived');
    this.#emitCrew();
    return record;
  }

  /**
   * The player died (PLAN §7.9): last words (one CEO turn, ≤ 8 s, off the scheduler, skipped when Tired or
   * Asleep), barks for the others, then every session closes and the Chronicle gets an entry.
   */
  async playerDied(death: { cause: string; day: number }): Promise<void> {
    if (!this.#world || this.#ending) return;
    this.#ending = true;
    const ceo = this.#ceoRecord();
    const ceoBrain = ceo ? this.#brains.get(ceo.agentId) : undefined;
    for (const b of this.#brains.values()) if (b !== ceoBrain) b.bark(BARKS.lastWords);
    if (ceoBrain?.session?.started && this.governor.mode === 'normal' && ceo) {
      const session = ceoBrain.session;
      try {
        if (session.inTurn) await session.interrupt();
        session.send(
          control(
            ceo.nonce,
            'LAST WORDS',
            `${this.#o.playerName()} just died (${death.cause}). The world ends. Say goodbye in one short sentence.`,
          ),
          { priority: 'now' },
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#o.lastWordsMs ?? LAST_WORDS_MS);
          timer.unref?.();
          const poll = setInterval(() => {
            if (!session.inTurn) {
              clearInterval(poll);
              clearTimeout(timer);
              resolve();
            }
          }, 50);
          poll.unref?.();
        });
      } catch (err) {
        this.#log.warn({ err }, 'last words failed');
      }
    }
    const world = this.#world;
    const fates = this.#records.map(
      (r) =>
        `${r.name} (${r.ceo ? 'CEO' : r.role}) ${r.status === 'alive' ? 'was lost with the world' : r.status}`,
    );
    await this.chronicle
      .add({
        worldId: world.worldId,
        gen: world.gen,
        text: singleLine(
          `ended on Day ${death.day}: ${death.cause}. Crew: ${fates.join('; ') || 'none'}.`,
          1200,
        ),
      })
      .catch((err: unknown) => this.#log.warn({ err }, 'chronicle write failed'));
    this.#ended = { day: death.day, cause: singleLine(death.cause, 256), at: this.#now() };
    await this.#closeWorld('world_end');
  }

  async #closeWorld(reason: string): Promise<void> {
    for (const brain of this.#brains.values()) {
      await brain.resetSeat('world_end').catch(() => {});
      await brain.stop(reason);
    }
    await this.#persist();
    await this.flush();
    for (const r of this.#records) this.pending.drop(r.agentId);
    this.#brains.clear();
    this.#bodies.clear();
    this.#occupants.clear();
    this.consents.clear();
    this.#records = [];
    this.#world = null;
    this.#dawnNewcomer = false;
    this.#emitCrew();
  }

  /** App shutdown: remember who sat where, close every session (they resume next time). */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const brain of this.#brains.values()) {
      const s = brain.fsm.snapshot;
      if (s.kind === 'pc' && s.pcId && brain.fsm.holdsPcSeat) brain.record.lastSeatedPc = s.pcId;
    }
    await this.#persist();
    await this.pending.flush();
    this.pending.freeze();
    for (const brain of this.#brains.values()) await brain.stop('shutdown', { keepCards: true });
    await this.flush();
  }

  dispose(): void {
    for (const off of this.#off.splice(0)) off();
    if (this.#autonomyTimer) clearInterval(this.#autonomyTimer);
    if (this.#chatTimer) clearTimeout(this.#chatTimer);
    this.governor.dispose();
    this.supervisor.dispose();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Body events (from the bridge)
  // ---------------------------------------------------------------------------------------------------------------

  onWorldState(msg: PayloadOf<'world.state'>): void {
    if (msg.office) this.#office = { worldId: msg.worldId, layout: msg.office };
    if (msg.clockTime === undefined) return;
    const prev = this.#clockTime;
    this.#clockTime = msg.clockTime;
    if (this.#dawnNewcomer && prev !== null && clockDay(msg.clockTime) > clockDay(prev) && this.#world) {
      this.#dawnNewcomer = false;
      void this.#hireCeo({ fresh: false }).catch((err: unknown) =>
        this.#log.error({ err }, 'the dawn newcomer could not arrive'),
      );
    }
  }

  /**
   * The mod said hello (PLAN §6.3 "Restarts"): `in_world` means only Node restarted (or the socket dropped), so seats
   * the mod still reports are restored (worker restart); `boot` means the game started again, so every agent loads
   * unseated (app restart) and a body found sitting is stood up.
   */
  noteHello(phase: 'boot' | 'in_world'): void {
    this.#seatRestore = phase === 'in_world';
  }

  onAgentState(msg: PayloadOf<'agent.state'>): void {
    for (const body of msg.agents) this.#bodies.set(body.agentId, body);
  }

  /** The Base of the open world (its starter office), or null before the mod reported one. */
  base(): BaseArea | null {
    const office = this.#office;
    if (!office || (this.#world && office.worldId !== this.#world.worldId)) return null;
    return baseAreaOf(office.layout);
  }

  /**
   * A player answer was read for consent (protocol §7.4.3). A grant is announced to the player (toast) and to the
   * agent (context, so its retry knows). An unclear one tells the player how to grant it (the chat echo, or a toast
   * for a card) and the agent that nothing is unlocked, so it does not read the reply as a yes and retry.
   */
  #consentVerdict(agentId: string, verdict: GrantVerdict, via: 'card' | 'chat'): string | null {
    const brain = this.#brains.get(agentId);
    const name = brain?.record.name ?? 'The agent';
    if (verdict.kind === 'none') return null;
    if (verdict.kind === 'unclear') {
      const note = `not a permission: ${verdict.reason}`;
      if (via === 'card') this.emit('toast', { text: `${name}: ${note}`, kind: 'info', agentId });
      brain?.context(
        control(
          brain.record.nonce,
          'CONSENT',
          `${this.#o.playerName()}'s reply did not allow changing protected blocks; nothing protected is unlocked, so don't retry the refused job. Gather elsewhere, or ask what to use instead.`,
        ),
      );
      return note;
    }
    const grant = verdict.grant;
    const scope = grantScope(grant);
    const minutes = Math.max(1, Math.round((grant.expiresAt - this.#now()) / 60_000));
    this.#log.info(
      { agentId, via: grant.via, positions: grant.positions.length, count: grant.count ?? null },
      'consent issued',
    );
    this.emit('toast', {
      text: `${name} may change ${scope} for ${minutes} min (you allowed it)`,
      kind: 'info',
      agentId,
    });
    if (brain) {
      brain.context(
        control(
          brain.record.nonce,
          'CONSENT',
          `${this.#o.playerName()} allowed you to change the ${scope} you were refused, for ${minutes} min. Retry that same job now with allow_protected:true (once); nothing else protected is unlocked.`,
        ),
      );
    }
    return `permission: ${name} may change ${scope} for ${minutes} min`;
  }

  onAgentEvent(msg: PayloadOf<'agent.event'>): void {
    for (const r of this.router.agentEvent(msg, this.#crewView())) this.#deliver(r);
  }

  onPcSeat(msg: PayloadOf<'pc.seat'>): void {
    if (msg.occupant.kind === 'player') {
      this.#occupants.set(msg.pcId, 'player');
      return;
    }
    this.#occupants.set(msg.pcId, msg.occupant.agentId);
    void this.#brains.get(msg.occupant.agentId)?.seatedByMod(msg.pcId, msg.seatEpoch);
  }

  onPcUnseat(msg: PayloadOf<'pc.unseat'>): void {
    const current = this.#occupants.get(msg.pcId);
    if (current === (msg.occupant.kind === 'player' ? 'player' : msg.occupant.agentId))
      this.#occupants.delete(msg.pcId);
    if (msg.occupant.kind !== 'agent') return;
    const brain = this.#brains.get(msg.occupant.agentId);
    if (!brain) return;
    const ignore: readonly UnseatReason[] = ['stand', 'away', 'meeting'];
    if (ignore.includes(msg.reason)) return;
    void brain.seatLost(msg.reason);
  }

  /** `agent.died` (a request the mod re-sends until acked): idempotent per agent. */
  async onAgentDied(msg: PayloadOf<'agent.died'>): Promise<Record<string, unknown>> {
    const record = this.#records.find((r) => r.agentId === msg.agentId);
    if (record?.status !== 'alive') return { ignored: true };
    record.status = 'dead';
    record.diedDay = msg.day;
    record.cause = msg.cause;
    this.consents.clear(record.agentId);
    const brain = this.#brains.get(record.agentId);
    if (brain) {
      await brain.resetSeat('death').catch(() => {});
      await brain.stop('died');
      this.#brains.delete(record.agentId);
    }
    for (const r of this.router.teammateDied(this.#routerAgent(record), msg.cause, this.#crewView()))
      this.#deliver(r);
    for (const b of this.#brains.values()) b.bark(BARKS.teammateDied);
    if (record.ceo) {
      record.ceo = false;
      this.#succession(record);
    }
    this.#endCalendarCards(record, `${record.name} died before you decided.`);
    this.transcripts.append(record.agentId, { kind: 'system', text: `Died on Day ${msg.day}: ${msg.cause}` });
    await this.#persist();
    this.#emitCrew();
    return {};
  }

  /**
   * A dead or dismissed agent's calendar approval cards (PLAN §6.6) end as declined, and the events waiting on them
   * are cancelled: nobody is left to own them, and a card for a gone agent would never be answered (its AgentScreen
   * is closed). Hire cards are not touched here (they move to the next CEO in {@link #succession}).
   */
  #endCalendarCards(record: AgentRecord, why: string): void {
    for (const c of this.pending.list(record.agentId)) {
      if (c.kind !== 'calendar') continue;
      this.pending.resolve(c.id, { kind: 'declined', note: why });
      void this.#o.org.calendar
        .cancel(PLAYER, c.eventId, 'all')
        .catch((err: unknown) =>
          this.#log.warn({ err, eventId: c.eventId }, 'cancel of an orphaned event failed'),
        );
    }
  }

  #succession(previous: AgentRecord): void {
    const next = this.#records
      .filter((r) => r.status === 'alive')
      .sort((a, b) => a.seniority - b.seniority)[0];
    const hireCards = this.pending.list(previous.agentId).filter((c) => c.kind === 'hire');
    if (!next) {
      for (const c of hireCards) this.pending.resolve(c.id, { kind: 'denied', reason: 'The CEO died.' });
      this.#dawnNewcomer = true;
      this.emit('toast', { text: 'The crew is gone. A newcomer arrives at dawn.', kind: 'warn' });
      return;
    }
    next.ceo = true;
    for (const c of hireCards) this.pending.move(c.id, next.agentId);
    const brain = this.#brains.get(next.agentId);
    brain?.bark(BARKS.promoted);
    brain?.enqueue({
      mode: 'wake',
      priority: 2,
      kind: 'PROMOTED',
      text: promotedMessage(next.nonce, previous.name, this.#o.playerName()),
    });
    this.emit('toast', { text: `${next.name} is the new CEO.`, kind: 'info', agentId: next.agentId });
  }

  #onJobEnd(end: JobEnd): void {
    const brain = this.#brains.get(end.agentId);
    if (!brain) return;
    if (end.status === 'failed' && end.error?.code === PROTECTED) {
      const refusal = refusalOf(end.result);
      const zone = zoneOfBody(this.#bodies.get(end.agentId)?.zone)?.kind;
      this.consents.noteRefusal(end.agentId, {
        ...refusal,
        zone: refusal.zone ?? (zone === 'base' || zone === 'built' ? zone : null),
      });
    }
    const label = brain.jobLabel(end.jobId);
    if (label === undefined) return;
    if (label.startsWith('sit at ')) {
      void brain.sitJobEnded(end.jobId, end.status === 'done', end.error?.msg ?? end.status);
      return;
    }
    brain.forgetJob(end.jobId);
    if (brain.mcTools === 'v2') {
      // v2: the result in the tool set's own format; no wake for a job the agent (or the player's task) cancelled.
      const wake = brain.toolJobEnded(end);
      if (wake) this.#deliver(this.router.jobEnded(this.#routerAgent(brain.record), end, label, wake));
      return;
    }
    this.#deliver(this.router.jobEnded(this.#routerAgent(brain.record), end, label));
  }

  #onCalendarFired(fired: PayloadOf<'calendar.fired'>): void {
    // Only reminders (zero-token bubbles) are handled here. Meetings are the MeetingRunner's, and task text reaches
    // the assignees through the org module's CrewHooks.deliver(…, 'scheduled') (orchestrator/modules.ts); the same
    // occurrence is also re-sent as assignees accept it (a longer `walk`), so delivering here would wake them twice.
    if (fired.kind !== 'reminder') return;
    for (const agentId of fired.assignees) {
      const record = this.#records.find((r) => r.agentId === agentId && r.status === 'alive');
      if (!record) continue;
      this.emit('say', {
        agentId,
        text: singleLine(`Reminder: ${fired.title}`, 120),
        style: 'speech',
        ttlMs: 8_000,
      });
    }
  }

  async #onCodexIndex(index: PayloadOf<'codex.index'>): Promise<void> {
    const rules = index.pages.filter((p) => p.category === 'rules' && p.author.kind === 'player');
    const changed = rules.filter((p) => this.#rulesRevs.get(p.id) !== p.rev);
    const removed = [...this.#rulesRevs.keys()].filter((id) => !rules.some((p) => p.id === id));
    this.#rulesRevs = new Map(rules.map((p) => [p.id, p.rev]));
    if (changed.length === 0 && removed.length === 0) return;
    for (const page of changed) {
      let body: string;
      try {
        body = (await this.#o.org.codex.read(PLAYER, page.id)).body;
      } catch {
        continue;
      }
      // Binding, but still shared text: look-alike control tags and envelope delimiters are made inert.
      const title = singleLine(page.title, 80).replace(/"/g, "'");
      const rules = escapeShared(body.slice(0, 4_000));
      for (const b of this.#brains.values()) {
        b.context(
          `${control(b.record.nonce, 'HOUSE RULES', `${this.#o.playerName()} set house rules "${title}" (binding):`)}\n${rules}`,
        );
      }
    }
  }

  #autonomyTick(): void {
    const now = this.#now();
    for (const brain of this.#brains.values()) {
      if (brain.status !== 'idle' || brain.queuedWakes.length > 0) continue;
      const since = brain.lastAutonomousAt === null ? null : now - brain.lastAutonomousAt;
      const r = this.router.autonomousWake(
        this.#routerAgent(brain.record),
        brain.idleMs(now),
        since,
        this.governor.mode,
      );
      if (r) this.#deliver(r);
    }
  }

  #onTurnEnded(brain: AgentBrain, result: SDKResultMessage, session: SessionKind): void {
    const model = (session === 'desk' ? brain.deskSession : brain.bodySession)?.model ?? null;
    this.emit('turn', { agentId: brain.agentId, result, model, session });
    const tokens = Object.values(result.modelUsage ?? {}).reduce(
      (sum, u) =>
        sum +
        (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0),
      0,
    );
    this.#tokens.set(`${brain.agentId}:${session}`, tokens);
  }

  /** Cumulative tokens of an agent's current sessions, body and desk together (HUD). */
  tokensOf(agentId: string): number {
    return (this.#tokens.get(`${agentId}:body`) ?? 0) + (this.#tokens.get(`${agentId}:desk`) ?? 0);
  }

  /**
   * A session crashed (PLAN §6.5 "Brain supervisor"). Each session has its own restart budget: the body restarts
   * (resumed) with its start contexts; a desk restarts while its seat holds. A body over its budget goes offline (Retry);
   * a desk over its budget stands the agent up and the body takes back with a DESK REPORT.
   */
  #onSessionCrash(brain: AgentBrain, error: Error, session: SessionKind): void {
    const key = session === 'desk' ? `${brain.agentId}:desk` : brain.agentId;
    this.supervisor.onCrash(key, error, {
      restart: () => {
        if (!this.#brains.has(brain.agentId) || brain.record.status !== 'alive') return;
        if (session === 'desk') {
          void brain.restartDesk().catch((err: unknown) => this.#log.error({ err }, 'desk restart failed'));
          return;
        }
        void this.#startContexts(brain.record).then((contexts) => {
          try {
            brain.start({ contexts });
          } catch (err) {
            this.#log.error({ err }, 'brain restart failed');
          }
        });
      },
      offline: (reason) => {
        if (session === 'desk') {
          void brain.deskFailed(reason).catch((err: unknown) => this.#log.error({ err }, 'desk failure'));
          this.emit('toast', {
            text: `${brain.record.name}'s PC session stopped working (${reason}); they got up.`,
            kind: 'error',
            agentId: brain.agentId,
          });
          return;
        }
        brain.markOffline();
        brain.bark(BARKS.brainOffline);
        this.emit('toast', {
          text: `${brain.record.name}'s brain is offline (${reason}). Retry from the agent screen.`,
          kind: 'error',
          agentId: brain.agentId,
        });
      },
      auth: () => {
        this.governor.onAuthFailure();
        brain.markOffline();
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Crew messages and hires (from tools)
  // ---------------------------------------------------------------------------------------------------------------

  #resolveCrewRef(ref: string): AgentRecord | null {
    const key = ref.trim().replace(/^@/, '').toLowerCase();
    if (key === 'ceo') return this.#ceoRecord() ?? null;
    return (
      this.#records.find((r) => r.agentId === ref.trim()) ??
      this.#records.find((r) => r.handle === key) ??
      this.#records.find((r) => r.name.toLowerCase() === key) ??
      null
    );
  }

  async #tell(from: AgentBrain, to: string, said: string): Promise<string> {
    const target = this.#resolveCrewRef(to);
    if (!target) throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `Nobody in the crew is called ${to}.`);
    if (target.status !== 'alive')
      throw new ApiError(ERROR_CODES.CHAT_UNAVAILABLE, `${target.name} is ${target.status}.`);
    if (target.agentId === from.agentId) throw new ApiError('BAD_ARGS', 'That is you.');
    // A tell leaves the sender's session: account identifiers never reach the other agent (agents/redact.ts).
    const text = this.redactor.redact(said);
    this.transcripts.append(target.agentId, {
      kind: 'tell',
      text,
      fromAgentId: from.agentId,
      ...this.#tagOf(target.agentId),
    });
    this.transcripts.append(from.agentId, {
      kind: 'tell',
      text: `→ ${target.name}: ${text}`,
      fromAgentId: target.agentId,
      ...from.transcriptTag(),
    });
    this.emit('say', {
      agentId: from.agentId,
      text: singleLine(`@${target.handle} ${text}`, 200),
      style: 'tell',
      ttlMs: 6_000,
    });
    this.#deliver(this.router.tell(this.#routerAgent(from.record), this.#routerAgent(target), text));
    return `Told ${target.name}.`;
  }

  /** The session tag of a transcript line for `agentId` now: its active session (body, or desk at a PC). */
  #tagOf(agentId: string): { session?: SessionKind; pcId?: string } {
    return this.#brains.get(agentId)?.transcriptTag() ?? {};
  }

  /** The agents' `mc` tool set (texts that name tools follow it). */
  #mcTools(): McToolsVersion {
    return this.#o.mcTools ?? mcToolsVersion();
  }

  #ceoRecord(): AgentRecord | undefined {
    return this.#records.find((r) => r.ceo && r.status === 'alive');
  }

  async #requestHire(
    from: AgentBrain,
    req: { role: AgentRole; name?: string | undefined; reason: string; firstTask: string },
  ): Promise<string> {
    const player = this.#o.playerName();
    if (!from.record.ceo) throw new ApiError(ERROR_CODES.FORBIDDEN, 'Only the CEO can hire.');
    if (this.governor.mode !== 'normal')
      throw new ApiError('TIRED', `Hiring is paused while the crew's usage is low.`);
    if (req.role === 'ceo') throw new ApiError('BAD_ARGS', 'There is only one CEO.');
    const pendingHires = this.pending.all().filter((c) => c.kind === 'hire');
    if (pendingHires.length > 0)
      throw new ApiError('HIRE_PENDING', `A hire already waits for ${player}'s decision.`);
    const cap = this.#o.crewCap ?? CREW_CAP;
    const alive = this.#records.filter((r) => r.status === 'alive').length;
    if (alive >= cap) throw new ApiError('CREW_CAP', `The crew is full (${alive}/${cap}).`);
    let name: string;
    let handle: string;
    if (req.name) {
      name = sanitizeDisplayName(req.name, '');
      const h = name ? handleFromName(name) : null;
      if (!name || !h)
        throw new ApiError('BAD_ARGS', `"${singleLine(req.name, 24)}" is not usable as a name.`);
      const problem = validateHandle(h, { taken: this.#takenHandles(), playerName: player });
      if (problem) throw new ApiError('BAD_ARGS', `${problem.message}. Pick another name.`);
      handle = h;
    } else {
      ({ name, handle } = this.#pickName());
    }
    const card: Card = {
      id: newCardId('h'),
      agentId: from.agentId,
      createdAt: this.#now(),
      parked: false,
      presenting: false,
      kind: 'hire',
      role: req.role,
      name,
      handle,
      // The card shows agent-authored text to the player and becomes the hire's first task: redacted.
      reason: this.redactor.redact(req.reason).slice(0, 500),
      firstTask: this.redactor.redact(req.firstTask).slice(0, 2000),
    };
    this.pending.add(card);
    this.transcripts.append(from.agentId, {
      kind: 'card',
      text: `Hire request: ${name} (${req.role})`,
      cardId: card.id,
    });
    this.emit('card', card);
    return `Asked ${player} to hire ${name} (${req.role}). You'll get [HIRE DECISION] later; carry on meanwhile.`;
  }

  async #decideHire(
    card: Extract<Card, { kind: 'hire' }>,
    approve: boolean,
    note: string | null,
  ): Promise<string> {
    const ceo = this.#records.find((r) => r.agentId === card.agentId);
    const cap = this.#o.crewCap ?? CREW_CAP;
    if (approve && this.#records.filter((r) => r.status === 'alive').length >= cap) {
      // The card stays up (the player can still decline it) instead of vanishing with nobody told.
      throw new ApiError('CREW_CAP', 'The crew is already full.');
    }
    this.pending.resolve(card.id, approve ? { kind: 'approved' } : { kind: 'declined', note });
    const ceoBrain = ceo ? this.#brains.get(ceo.agentId) : undefined;
    if (!approve) {
      ceoBrain?.enqueue({
        mode: 'wake',
        priority: 3,
        kind: 'HIRE DECLINED',
        text: control(
          ceo?.nonce ?? '000000',
          'HIRE DECLINED',
          `${this.#o.playerName()} declined hiring ${card.name}${note ? `: ${note}` : '.'}`,
        ),
      });
      return `hire declined`;
    }
    const record = this.#newRecord({ name: card.name, handle: card.handle, role: card.role, ceo: false });
    try {
      await this.#o.skills.spawn({
        agentId: record.agentId,
        handle: record.handle,
        name: record.name,
        role: record.role,
        ceo: false,
        restore: false,
        mode: 'follow',
        bark: BARKS.reportingForDuty,
        ...(await this.#spawnAt()),
      });
    } catch (err) {
      ceoBrain?.enqueue({
        mode: 'wake',
        priority: 3,
        kind: 'HIRE DECISION',
        text: control(
          ceo?.nonce ?? '000000',
          'HIRE DECISION',
          `${card.name} was approved but could not arrive: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
      throw err;
    }
    this.#records.push(record);
    await this.#persist();
    const brain = await this.#createBrain(record);
    brain.start({
      contexts: await this.#startContexts(record),
      wakes: [
        {
          mode: 'wake',
          priority: 1,
          kind: 'WELCOME',
          text: welcomeMessage({
            nonce: record.nonce,
            playerName: this.#o.playerName(),
            worldGen: this.#world?.gen ?? 1,
            ceo: false,
            hiredBy: ceo?.name ?? 'the CEO',
            firstTask: card.firstTask,
            base: this.base(),
          }),
        },
      ],
    });
    await this.#persist();
    for (const b of this.#brains.values()) {
      if (b !== brain) b.context(rosterContext(b.record.nonce, b.record.handle, this.#records));
    }
    ceoBrain?.enqueue({
      mode: 'wake',
      priority: 3,
      kind: 'HIRE APPROVED',
      text: control(
        ceo?.nonce ?? '000000',
        'HIRE APPROVED',
        `${this.#o.playerName()} hired ${record.name} (@${record.handle}, ${record.role}); they start on the first task.`,
      ),
    });
    this.#emitCrew();
    return `hire approved: ${record.name} (${record.role})`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // CrewApi
  // ---------------------------------------------------------------------------------------------------------------

  listAgents(): readonly AgentSummary[] {
    return [...this.#records]
      .sort((a, b) => a.seniority - b.seniority)
      .map((r) => {
        const brain = this.#brains.get(r.agentId);
        const s = brain?.fsm.snapshot;
        return {
          agentId: r.agentId,
          handle: r.handle,
          name: r.name,
          role: r.role,
          ceo: r.ceo,
          status: r.status,
          model: brain?.model ?? 'haiku',
          brain: brain?.status ?? (r.status === 'alive' ? 'offline' : 'idle'),
          seatedPc: s && s.kind === 'pc' && brain?.fsm.holdsPcSeat ? s.pcId : null,
          autonomy: r.autonomy,
          planFirst: r.planFirst,
          pingInstead: r.pingInstead,
          pendingCards: this.pending.list(r.agentId).length,
        };
      });
  }

  /** The brain of an agent (tests, integration). */
  brain(agentId: string): AgentBrain | undefined {
    return this.#brains.get(agentId);
  }

  /** Every pending card (`hello.ok.pending`). */
  pendingCards(): Card[] {
    return this.pending.all();
  }

  crewState(): PayloadOf<'crew.state'> {
    return {
      crew: this.#records.map((r) => ({
        agentId: r.agentId,
        handle: r.handle,
        name: r.name,
        role: r.role,
        ceo: r.ceo,
        status: r.status,
      })),
    };
  }

  brainsSummary(): BrainsSummary {
    return { ...this.scheduler.summary(), ...this.governor.summaryFields() };
  }

  /**
   * `crew.state`, then every brain again: the mod ignores `agent.brain` for an agent its crew list does not have yet,
   * and a new agent's brain starts (queued, thinking) before it joins the list, so without the re-send its head icon
   * stays blank through its first turn.
   */
  #emitCrew(): void {
    this.emit('crew', this.crewState());
    for (const b of this.#brains.values()) this.emit('brain', b.brainPayload());
  }

  #emitBrains(): void {
    this.emit('brains', this.brainsSummary());
  }

  #chatContext(): ChatContext {
    const cards = new Map<string, ReturnType<typeof grammarCard>[]>();
    for (const r of this.#records) {
      cards.set(
        r.agentId,
        this.pending
          .list(r.agentId)
          .map(grammarCard)
          .filter((c) => c !== null),
      );
    }
    let meeting: ChatContext['meeting'] = null;
    try {
      const m = this.#o.org.meeting.state();
      // While the meeting gathers nobody takes the floor yet (the MeetingRunner ignores lines then): chat routes as
      // usual until it opens.
      if (m && m.phase !== 'done' && m.phase !== 'gathering') {
        meeting = {
          meetingId: m.meetingId,
          attendees: m.attendees
            .filter((a) => a.status === 'seated' || a.status === 'dialed_in')
            .map((a) => a.agentId),
          chairId: m.chair === 'player' ? null : m.chair,
          playerInScope: m.chair === 'player',
        };
      }
    } catch {
      meeting = null;
    }
    return {
      playerName: this.#o.playerName(),
      crew: this.#records.map((r) => ({
        agentId: r.agentId,
        handle: r.handle,
        name: r.name,
        status: r.status,
        ceo: r.ceo,
        diedDay: r.diedDay,
        seated: this.#brains.get(r.agentId)?.fsm.holdsPcSeat ?? false,
      })),
      cards: cards as ChatContext['cards'],
      meeting,
    };
  }

  #deliveryInfo(d: Delivery, debounced: boolean): AgentDeliveryInfo {
    const brain = this.#brains.get(d.agentId);
    const name = brain?.record.name ?? 'The agent';
    if (d.mode === 'meeting')
      return { agentId: d.agentId, mode: 'meeting', queued: false, latencyMs: null, hint: null };
    if (d.mode === 'context')
      return { agentId: d.agentId, mode: 'context', queued: false, latencyMs: null, hint: null };
    if (this.governor.mode === 'asleep') {
      const at = this.governor.state.resetsAt;
      return {
        agentId: d.agentId,
        mode: 'wake',
        queued: true,
        latencyMs: at ? Math.max(0, at - this.#now()) : null,
        hint: `${name} is out of usage${at ? ` until ${new Date(at).toTimeString().slice(0, 5)}` : ''}`,
      };
    }
    if (brain?.offline)
      return {
        agentId: d.agentId,
        mode: 'wake',
        queued: true,
        latencyMs: null,
        hint: `${name}'s brain is offline`,
      };
    const est = this.scheduler.estimate(d.agentId);
    if (brain?.session?.inTurn) {
      return {
        agentId: d.agentId,
        mode: 'wake',
        queued: true,
        latencyMs: 15_000,
        hint: `${name} is mid-task, reads this at the next step`,
      };
    }
    if (
      est.waiting ||
      this.scheduler.summary().inFlight >= this.scheduler.workCap + this.scheduler.interactiveCap
    ) {
      return {
        agentId: d.agentId,
        mode: 'wake',
        queued: true,
        latencyMs: 30_000,
        hint: `${name} waits for a free brain`,
      };
    }
    return {
      agentId: d.agentId,
      mode: 'wake',
      queued: false,
      latencyMs: debounced ? (this.#o.chatDebounceMs ?? 2_000) : 0,
      hint: null,
    };
  }

  async deliverChat(delivery: ChatDelivery): Promise<DeliveryResult> {
    const ctx = this.#chatContext();
    const route = this.#chatRouter.route({ to: delivery.to, text: delivery.text }, ctx);
    if (!route.ok) throw new ApiError(route.error.wireCode, route.error.hint);
    let answeredCard: string | null = null;
    let echo = route.echo;
    if (route.answer) {
      const card = this.pending.get(route.answer.cardId);
      if (!card) throw new ApiError(ERROR_CODES.CARD_GONE, 'That card is no longer pending.');
      await this.#applyInterpretation(card, route.answer);
      answeredCard = card.id;
      this.transcripts.append(card.agentId, { kind: 'answer', text: delivery.text.trim(), cardId: card.id });
    }
    if (route.command === 'meeting.end' && ctx.meeting) {
      await this.#o.org.meeting.end(PLAYER, ctx.meeting.meetingId);
    }
    // A direct reply to one agent may grant the consent it asked for (protocol §7.4.3); card answers go through the
    // card path (PendingStore `resolved`), never here.
    const direct = route.deliveries.filter((d) => d.mode === 'wake' || d.mode === 'context');
    const only = direct[0];
    if (route.scope === 'direct' && !route.answer && direct.length === 1 && only) {
      const note = this.#consentVerdict(
        only.agentId,
        this.consents.fromChat(only.agentId, route.body),
        'chat',
      );
      if (note) echo = `${echo} (${note})`;
    }
    const chatMode = delivery.mode ?? (delivery.to === 'all' ? 'chat' : 'reply');
    const immediate = chatMode === 'interrupt';
    const meetingIds: string[] = [];
    for (const d of route.deliveries) {
      if (d.mode === 'meeting') meetingIds.push(d.agentId);
      this.transcripts.append(d.agentId, {
        kind: 'player',
        text: route.body.length > 0 ? route.body : delivery.text,
        // The line reaches the agent's active session: its tag says which (AgentScreen's merged history).
        ...this.#tagOf(d.agentId),
      });
    }
    if (meetingIds.length > 0) this.emit('meetingMessage', { text: route.body, agentIds: meetingIds });
    const toInbox = route.deliveries.filter((d) => d.mode !== 'meeting');
    if (immediate) {
      for (const d of toInbox)
        this.#brains
          .get(d.agentId)
          ?.playerMessage([route.body], d.mode === 'wake' ? 'wake' : 'context', 'interrupt');
    } else if (toInbox.length > 0) {
      for (const d of toInbox) this.#chatModes.set(d.agentId, chatMode);
      this.#chatInbox.push(toInbox, route.body, this.#now());
      this.#scheduleChatFlush();
    }
    const infos = route.deliveries.map((d) => this.#deliveryInfo(d, !immediate));
    const queuedHints = infos.filter((i) => i.hint !== null).map((i) => i.hint);
    if (queuedHints.length > 0 && route.scope === 'direct')
      echo = `${echo} (queued: ${queuedHints.join('; ')})`;
    return { echo, scope: route.scope, deliveries: infos, answeredCard };
  }

  #scheduleChatFlush(): void {
    const at = this.#chatInbox.nextFlushAt();
    if (at === null) return;
    if (this.#chatTimer) clearTimeout(this.#chatTimer);
    const delay = Math.max(0, at - this.#now());
    const run = () => {
      this.#chatTimer = null;
      for (const merged of this.#chatInbox.flush(this.#now())) {
        const mode = this.#chatModes.get(merged.agentId) ?? 'chat';
        this.#chatModes.delete(merged.agentId);
        this.#brains.get(merged.agentId)?.playerMessage(merged.texts, merged.mode, mode);
      }
      if (this.#chatInbox.size > 0) this.#scheduleChatFlush();
    };
    if (delay === 0) {
      queueMicrotask(run);
      return;
    }
    this.#chatTimer = setTimeout(run, delay);
    this.#chatTimer.unref?.();
  }

  async answerCard(pendingId: string, answer: CrewCardAnswer): Promise<CrewActionResult> {
    const card = this.pending.get(pendingId);
    if (!card) throw new ApiError(ERROR_CODES.CARD_GONE, 'That card is no longer pending.');
    const record = this.#records.find((r) => r.agentId === card.agentId);
    const interp = interpretWireAnswer(card, answer, record?.handle ?? 'agent');
    if (interp.kind === 'invalid') throw new ApiError(ERROR_CODES.CHAT_INVALID_ANSWER, interp.hint);
    const echo = await this.#applyInterpretation(card, interp);
    this.transcripts.append(card.agentId, { kind: 'answer', text: echo, cardId: card.id });
    return { echo };
  }

  /** Applies an answer to a card; returns the echo line. */
  async #applyInterpretation(card: Card, interp: CardInterpretation): Promise<string> {
    const record = this.#records.find((r) => r.agentId === card.agentId);
    const name = record?.name ?? 'Agent';
    const g = grammarCard(card);
    const echo =
      g && interp.kind !== 'calendar.approve' && interp.kind !== 'calendar.decline'
        ? formatAnswerEcho(name, g, interp, '')
        : `You → ${name}: ${interp.kind === 'calendar.approve' ? 'event approved' : 'event declined'}`;
    switch (interp.kind) {
      case 'question.answer': {
        if (card.kind !== 'question') break;
        const answers = [...card.answers, interp.value];
        if (!interp.done || !interp.answers) {
          this.pending.update(card.id, { answers } as Partial<Card>);
          break;
        }
        if (this.pending.isStale(card.id)) {
          this.pending.resolve(card.id, { kind: 'answered', answers: interp.answers });
          const qa = Object.entries(interp.answers)
            .map(([q, a]) => `"${singleLine(q, 200)}" → ${singleLine(a, 500)}`)
            .join('; ');
          this.#brains.get(card.agentId)?.enqueue({
            mode: 'wake',
            priority: 0,
            kind: 'ANSWER',
            text: control(
              record?.nonce ?? '000000',
              'ANSWER',
              `Before the restart you asked ${this.#o.playerName()}; the answers: ${qa}`,
            ),
          });
          break;
        }
        this.pending.resolve(card.id, { kind: 'answered', answers: interp.answers });
        break;
      }
      case 'later':
        this.pending.update(card.id, { parked: true, presenting: false });
        break;
      case 'plan.approve':
        this.pending.resolve(card.id, { kind: 'approved' });
        break;
      case 'plan.revise':
        this.pending.resolve(card.id, { kind: 'revise', feedback: interp.feedback });
        break;
      case 'hire.approve':
        if (card.kind === 'hire') return `You → ${name}: ${await this.#decideHire(card, true, null)}`;
        break;
      case 'hire.decline':
        if (card.kind === 'hire') return `You → ${name}: ${await this.#decideHire(card, false, interp.note)}`;
        break;
      case 'calendar.approve':
        if (card.kind === 'calendar') {
          // OrgApi.calendar.decide resolves without effect for an event that no longer waits, and an event that is
          // gone altogether has nothing left to approve, so a stale card always clears; any other failure keeps the
          // card up.
          try {
            if (this.#o.approveCalendarEvent) await this.#o.approveCalendarEvent(card.eventId);
            else await this.#o.org.calendar.decide(PLAYER, card.eventId, { approve: true });
          } catch (err) {
            if (!isApiError(err, ERROR_CODES.CALENDAR_NOT_FOUND)) throw err;
          }
          this.pending.resolve(card.id, { kind: 'approved' });
        }
        break;
      case 'calendar.decline':
        if (card.kind === 'calendar') {
          await this.#o.org.calendar
            .decide(PLAYER, card.eventId, { approve: false, note: interp.note ?? undefined })
            .catch(() => {});
          this.pending.resolve(card.id, { kind: 'declined', note: interp.note });
        }
        break;
      case 'message':
      case 'invalid':
        break;
    }
    return echo;
  }

  /** Raises a calendar approval card for an agent-created recurring event or meeting (PLAN §6.6). */
  raiseCalendarApproval(agentId: string, eventId: string, summary: string): Card {
    const card: Card = {
      id: newCardId('k'),
      agentId,
      createdAt: this.#now(),
      parked: false,
      presenting: false,
      kind: 'calendar',
      eventId,
      summary: singleLine(summary, 500),
    };
    this.pending.add(card);
    this.emit('card', card);
    return card;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Crew hooks (orchestrator/modules.ts CrewHooks: what the org services ask of minds and seats)
  // ---------------------------------------------------------------------------------------------------------------

  #livingBrain(agentId: string): AgentBrain {
    const record = this.#records.find((r) => r.agentId === agentId);
    const brain = this.#brains.get(agentId);
    if (record?.status !== 'alive' || !brain)
      throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `No living agent ${agentId}.`);
    return brain;
  }

  /** A seated agent walks over to present a card (`seated → away_from_seat`). No-op when it is not seated. */
  async goAway(agentId: string, pendingId: string): Promise<void> {
    const brain = this.#livingBrain(agentId);
    const went = await brain.goAway();
    this.#log.info({ agentId, pendingId, went }, 'away from the seat to present a card');
  }

  /** The presented card was answered: back to the reserved chair. No-op when the agent is not away. */
  async comeBack(agentId: string): Promise<void> {
    await this.#livingBrain(agentId).comeBack();
  }

  async pullIntoMeeting(agentId: string, meetingId: string): Promise<void> {
    await this.#livingBrain(agentId).pullIntoMeeting(meetingId);
  }

  async releaseFromMeeting(agentId: string): Promise<void> {
    await this.#livingBrain(agentId).releaseFromMeeting();
  }

  /**
   * Node-made text from the org services, under the agent's own nonce: `scheduled` and `meeting` wake at P1 after the
   * current turn, `context` adds no turn. Control-tag look-alikes in `text` are neutralized; its data envelopes stay.
   */
  async deliverTo(agentId: string, text: string, kind: 'scheduled' | 'meeting' | 'context'): Promise<void> {
    const brain = this.#livingBrain(agentId);
    const body = neutralizeControlTags(text).trim();
    const nonce = brain.record.nonce;
    if (kind === 'context') {
      brain.context(control(nonce, 'CONTEXT', body));
      return;
    }
    // A wake for a brain that cannot think would wait forever: the org module marks the task missed instead.
    if (!brain.canThink) throw new ApiError('BRAIN_OFFLINE', `${brain.record.name} cannot think right now.`);
    const controlKind = kind === 'scheduled' ? 'SCHEDULED' : 'MEETING';
    brain.enqueue({ mode: 'wake', priority: 1, kind: controlKind, text: control(nonce, controlKind, body) });
  }

  /** One meeting turn of an agent; resolves with what it said (CrewHooks.meetingTurn). */
  async meetingTurn(agentId: string, prompt: string, opts: { maxSentences: number }): Promise<string> {
    const brain = this.#livingBrain(agentId);
    const said = await brain.meetingTurn(neutralizeControlTags(prompt).trim(), {
      maxSentences: opts.maxSentences,
    });
    // What an agent says at the table becomes the meeting minutes: account identifiers never get there.
    return this.redactor.redact(said);
  }

  /** Every crew member's fate, for the Game Over summary of the current world (call before it closes). */
  crewFates(): CrewFate[] {
    return this.#records.map((r) => {
      const fate: CrewFate['fate'] =
        r.status === 'dead' ? 'died' : r.status === 'dismissed' ? 'dismissed' : 'lost_with_world';
      const detail =
        r.status === 'dead' && r.cause
          ? singleLine(`${r.cause}${r.diedDay !== undefined ? ` on Day ${r.diedDay}` : ''}`, 256)
          : undefined;
      return {
        agentId: r.agentId,
        name: singleLine(r.name, 32),
        role: r.ceo ? 'ceo' : r.role,
        fate,
        ...(detail ? { detail } : {}),
      };
    });
  }

  async command(agentId: string, command: CrewCommand): Promise<CrewActionResult> {
    const record = this.#records.find((r) => r.agentId === agentId);
    if (!record) throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `No agent ${agentId}.`);
    if (record.status !== 'alive')
      throw new ApiError(ERROR_CODES.FORBIDDEN, `${record.name} is ${record.status}.`);
    const brain = this.#brains.get(agentId);
    const player = this.#o.playerName();
    switch (command.cmd) {
      case 'follow':
      case 'stay':
      case 'guard':
      case 'wander':
        await this.#o.skills.setMode(agentId, command.cmd);
        brain?.context(control(record.nonce, 'CONTEXT', `${player} set your idle mode to ${command.cmd}.`));
        return { echo: `${record.name}: ${command.cmd}` };
      case 'stop':
        await this.#o.skills.cancelSkill(agentId, { reason: 'player stop' }).catch(() => []);
        await brain?.session?.interrupt();
        return { echo: `${record.name}: stopped` };
      case 'interrupt':
        await brain?.session?.interrupt();
        return { echo: `${record.name}: interrupted` };
      case 'kick': {
        const s = brain?.fsm.snapshot;
        if (!brain || !s || !brain.fsm.holdsPcSeat)
          throw new ApiError(ERROR_CODES.FORBIDDEN, `${record.name} is not at a PC.`);
        await this.#o.skills
          .unseat({ agentId, seatEpoch: s.epoch, reason: 'kick', keepReservation: false })
          .catch((err: unknown) => this.#log.warn({ err }, 'kick unseat failed'));
        await brain.seatLost('kick');
        return { echo: `Kicked ${record.name} off ${s.pcId}` };
      }
      case 'dismiss':
        await this.#dismiss(record);
        return { echo: `${record.name} was dismissed` };
      case 'plan_first':
        record.planFirst = command.on ?? !record.planFirst;
        // USER DECISION 2026-10-08: remembers that this value is the player's choice (see migratePlanFirst).
        record.planFirstByPlayer = true;
        break;
      case 'ping_instead':
        record.pingInstead = command.on ?? !record.pingInstead;
        break;
      case 'autonomy':
        if (command.level) record.autonomy = command.level;
        break;
      case 'retry_brain':
        this.supervisor.reset(agentId);
        if (this.governor.state.reason === 'auth') this.governor.wake();
        this.supervisor.reset(`${agentId}:desk`);
        if (brain && !brain.bodySession?.started) {
          await brain.closeSession();
          brain.start({ contexts: await this.#startContexts(record) });
        }
        if (brain && brain.deskPc !== null && !brain.deskSession?.started) await brain.restartDesk();
        return { echo: `${record.name}: brain restarting` };
    }
    await this.#persist();
    if (brain) this.emit('brain', brain.brainPayload());
    return {
      echo: `${record.name}: ${command.cmd}${command.on !== undefined ? (command.on ? ' on' : ' off') : command.level ? ` ${command.level}` : ''}`,
    };
  }

  async #dismiss(record: AgentRecord): Promise<void> {
    const brain = this.#brains.get(record.agentId);
    record.status = 'dismissed';
    this.consents.clear(record.agentId);
    if (brain) {
      const s = brain.fsm.snapshot;
      if (brain.fsm.holdsPcSeat) {
        await this.#o.skills
          .unseat({ agentId: record.agentId, seatEpoch: s.epoch, reason: 'dismiss', keepReservation: false })
          .catch(() => {});
      }
      await brain.resetSeat('dismiss').catch(() => {});
      await brain.stop('dismissed');
      this.#brains.delete(record.agentId);
    }
    for (const c of this.pending.list(record.agentId)) {
      if (c.kind === 'hire' || c.kind === 'calendar') continue;
      this.pending.resolve(c.id, { kind: 'denied', reason: 'Dismissed.' });
    }
    await this.#o.skills
      .despawn({ agentId: record.agentId, reason: 'dismissed', farewell: true })
      .catch(() => {});
    if (record.ceo) {
      record.ceo = false;
      this.#succession(record);
    }
    this.#endCalendarCards(record, `${record.name} was dismissed before you decided.`);
    for (const b of this.#brains.values())
      b.context(rosterContext(b.record.nonce, b.record.handle, this.#records));
    await this.#persist();
    this.#emitCrew();
  }

  async chatHistory(
    agentId: string,
    options: { beforeSeq?: number | undefined; limit: number },
  ): Promise<ChatHistoryResult> {
    if (!this.#records.some((r) => r.agentId === agentId))
      throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `No agent ${agentId}.`);
    await this.transcripts.load(agentId);
    return this.transcripts.page(agentId, options);
  }

  /** The front card of an agent (G key). */
  frontCard(agentId: string): Card | null {
    const cards = this.pending.list(agentId);
    const g = frontCard(cards.map(grammarCard).filter((c) => c !== null));
    return g ? (cards.find((c) => c.id === g.id) ?? null) : (cards[0] ?? null);
  }
}

/** Convenience: the bridge message handlers the runtime needs (see attachAgentRuntime). */
export type AgentBridgeMessage =
  | MessageOf<'agent.state'>
  | MessageOf<'agent.event'>
  | MessageOf<'pc.seat'>
  | MessageOf<'pc.unseat'>;
