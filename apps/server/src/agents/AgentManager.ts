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
 *   context or wakes (EventRouter) on each agent's brain, through the BrainScheduler and the UsageGovernor.
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
import { ApiError, PLAYER } from '../contracts/common.js';
import type { OrgApi } from '../contracts/OrgApi.js';
import type { PcApi } from '../contracts/PcApi.js';
import type { JobEnd, SkillApi } from '../contracts/SkillApi.js';
import { writeFileAtomic } from '../util/atomicFile.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { AgentBrain, type AgentRecord, type BrainEnv } from './AgentBrain.js';
import { BrainScheduler } from './BrainScheduler.js';
import { BrainSupervisor, type SupervisorOptions } from './BrainSupervisor.js';
import { type CardInterpretation, grammarCard, interpretWireAnswer } from './cardAnswers.js';
import { formatAnswerEcho, frontCard } from './chat/answerGrammar.js';
import { type ChatContext, ChatInbox, ChatRouter, type Delivery } from './chat/ChatRouter.js';
import { handleFromName, validateHandle } from './chat/handles.js';
import type { ResolvedClaude } from './claudeBinary.js';
import { CREW_CAP, LAST_WORDS_MS } from './constants.js';
import { EventRouter, type RoutedFor, type RouterAgent } from './EventRouter.js';
import { control, escapeShared, newNonce, singleLine, wrapNote } from './envelope.js';
import { Chronicle, HandoffNotes, MemoryStore } from './memory.js';
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
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from './sdk.js';
import { TranscriptStore } from './TranscriptStore.js';
import { UsageGovernor } from './UsageGovernor.js';

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
  /** Decides an agent-created calendar event the player approved (no OrgApi method exists yet). */
  readonly approveCalendarEvent?: (eventId: string) => Promise<void>;
  readonly lastWordsMs?: number;
  /** Re-sit debounce after a stand (default 60 s). */
  readonly swapDebounceMs?: number;
  /** Restart policy overrides (tests). */
  readonly supervisor?: Omit<SupervisorOptions, 'now'>;
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
  /** A real turn of an agent ended. */
  turn: [
    payload: { readonly agentId: string; readonly result: SDKResultMessage; readonly model: string | null },
  ];
};

export interface ToolObservation {
  readonly agentId: string;
  readonly toolName: string;
  readonly behavior: 'allow' | 'deny' | 'defer';
  readonly reason: string;
  readonly effort: string | null;
  readonly permissionMode: string | null;
  readonly model: string | null;
}

interface CrewFile {
  readonly v: 1;
  readonly worldId: string;
  readonly gen: number;
  readonly records: AgentRecord[];
}

function clockDay(ticks: number): number {
  return Math.floor(ticks / 24_000) + 1;
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
  #dawnNewcomer = false;
  #autonomyTimer: NodeJS.Timeout | null = null;
  #rulesRevs = new Map<string, string>();
  #persistChain: Promise<void> = Promise.resolve();
  readonly #off: (() => void)[] = [];
  #ending = false;
  #tokens = new Map<string, number>();

  constructor(options: AgentManagerOptions) {
    super();
    this.#o = options;
    this.#log = options.log.child({ component: 'agents' });
    this.#now = options.now ?? Date.now;
    this.scheduler = new BrainScheduler({ now: this.#now });
    this.governor = new UsageGovernor({ now: this.#now });
    this.supervisor = new BrainSupervisor({ now: this.#now, ...options.supervisor });
    this.router = new EventRouter({ now: this.#now, playerName: options.playerName });
    this.pending = new PendingStore({
      fileOf: (agentId) => (this.#world ? join(this.#agentDir(agentId), 'pending.json') : null),
      onError: (err) => this.#log.warn({ err }, 'pending store'),
    });
    this.transcripts = new TranscriptStore({
      fileOf: (agentId) => (this.#world ? join(this.#agentDir(agentId), 'chat.jsonl') : null),
      now: this.#now,
      onError: (err) => this.#log.warn({ err }, 'transcript store'),
    });
    this.#memory = new MemoryStore((agentId) => join(this.#agentDir(agentId), 'memory.md'));
    this.chronicle = new Chronicle(join(options.stateDir, 'chronicle.json'));
    this.handoffs = new HandoffNotes(join(options.stateDir, 'vault-handoffs'));
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
      options.skills.on('result', (end) => this.#onJobEnd(end)),
      options.org.on('calendarFired', (fired) => this.#onCalendarFired(fired)),
      options.org.on('codexIndex', (index) => void this.#onCodexIndex(index)),
    );
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
    const body: CrewFile = { v: 1, worldId: world.worldId, gen: world.gen, records: this.#records };
    const text = `${JSON.stringify(body, null, 2)}\n`;
    this.#persistChain = this.#persistChain
      .then(() => writeFileAtomic(file, text, { mode: 0o600 }))
      .catch((err: unknown) => this.#log.error({ err }, 'crew.json write failed'));
    return this.#persistChain;
  }

  async #loadCrew(): Promise<AgentRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#crewFile(), 'utf8')) as Partial<CrewFile>;
      return Array.isArray(parsed.records) ? parsed.records : [];
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
      playerName: o.playerName,
      occupant: (pcId) => this.#occupants.get(pcId) ?? null,
      seatedOthers: (agentId) =>
        [...this.#brains.values()].filter((b) => b.agentId !== agentId && b.fsm.holdsPcSeat).length,
      body: (agentId) => this.#bodies.get(agentId) ?? null,
      clockTime: () => this.#clockTime,
      tell: (from, to, text) => this.#tell(from, to, text),
      requestHire: (from, req) => this.#requestHire(from, req),
      taskReported: (from, report) => {
        const ceo = this.#ceoRecord();
        for (const r of this.router.taskReport(
          this.#routerAgent(from.record),
          ceo ? this.#routerAgent(ceo) : undefined,
          report,
        )) {
          this.#deliver(r);
        }
      },
      say: (payload) => this.emit('say', payload),
      brainChanged: (brain) => this.emit('brain', brain.brainPayload()),
      sessionExited: (brain, error) => this.#onSessionCrash(brain, error),
      assertionsFailed: (brain, problems) =>
        this.emit('toast', {
          text: `${brain.record.name} can't think: ${problems[0] ?? 'startup check failed'}`,
          kind: 'error',
          agentId: brain.agentId,
          ttlMs: 15_000,
        }),
      turnEnded: (brain, result) => this.#onTurnEnded(brain, result),
      toolObserved: (brain, o) =>
        this.emit('tool', {
          agentId: brain.agentId,
          toolName: o.toolName,
          behavior: o.decision.behavior,
          reason: o.decision.reason,
          effort: o.effort,
          permissionMode: o.permissionMode,
          model: brain.session?.model ?? null,
        }),
      cardRaised: (_brain, card) => this.emit('card', card),
      authMode: () => o.authMode ?? 'subscription',
      swapDebounceMs: o.swapDebounceMs,
      recordChanged: () => void this.#persist(),
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
  async openWorld(world: WorldInfo): Promise<void> {
    if (this.#world?.worldId === world.worldId) {
      this.#emitCrew();
      for (const b of this.#brains.values()) this.emit('brain', b.brainPayload());
      return;
    }
    if (this.#world) await this.#closeWorld('world changed');
    this.#world = world;
    this.#ending = false;
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

  async #restore(record: AgentRecord): Promise<void> {
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
        `The Codex has ${index.pages.length} page(s). Read with mcp__mc__codex_read.`,
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
    await mkdir(join(this.#agentDir(record.agentId), 'home'), { recursive: true, mode: 0o700 });
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

  #newRecord(input: { name: string; handle: string; role: AgentRole; ceo: boolean }): AgentRecord {
    const seniority = this.#records.reduce((m, r) => Math.max(m, r.seniority), 0) + 1;
    return {
      agentId: `${input.handle}-${randomUUID().slice(0, 6)}`,
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
      planFirst: input.role === 'ceo' || input.role === 'engineer',
      pingInstead: false,
    };
  }

  /** Spawns a new CEO (fresh world, or a newcomer at dawn when the crew is empty). */
  async #hireCeo(options: { fresh: boolean }): Promise<AgentRecord | null> {
    if (!this.#world) return null;
    const { name, handle } = this.#pickName();
    const record = this.#newRecord({ name, handle, role: 'ceo', ceo: true });
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
    this.#records = [];
    this.#world = null;
    this.#dawnNewcomer = false;
    this.#emitCrew();
  }

  /** App shutdown: remember who sat where, close every session (they resume next time). */
  async shutdown(): Promise<void> {
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
    if (msg.clockTime === undefined) return;
    const prev = this.#clockTime;
    this.#clockTime = msg.clockTime;
    if (this.#dawnNewcomer && prev !== null && clockDay(msg.clockTime) > clockDay(prev) && this.#world) {
      this.#dawnNewcomer = false;
      void this.#hireCeo({ fresh: false });
    }
  }

  onAgentState(msg: PayloadOf<'agent.state'>): void {
    for (const body of msg.agents) this.#bodies.set(body.agentId, body);
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
    this.transcripts.append(record.agentId, { kind: 'system', text: `Died on Day ${msg.day}: ${msg.cause}` });
    await this.#persist();
    this.#emitCrew();
    return {};
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
    const label = brain.jobLabel(end.jobId);
    if (label === undefined) return;
    if (label.startsWith('sit at ')) {
      void brain.sitJobEnded(end.jobId, end.status === 'done', end.error?.msg ?? end.status);
      return;
    }
    brain.forgetJob(end.jobId);
    this.#deliver(this.router.jobEnded(this.#routerAgent(brain.record), end, label));
  }

  #onCalendarFired(fired: PayloadOf<'calendar.fired'>): void {
    if (fired.kind === 'meeting') return; // the MeetingRunner's
    let task: string | null = null;
    try {
      task = this.#o.org.calendar.state().events.find((e) => e.id === fired.eventId)?.task ?? null;
    } catch {
      task = null;
    }
    for (const agentId of fired.assignees) {
      const record = this.#records.find((r) => r.agentId === agentId && r.status === 'alive');
      if (!record) continue;
      if (fired.kind === 'reminder') {
        this.emit('say', {
          agentId,
          text: singleLine(`Reminder: ${fired.title}`, 120),
          style: 'speech',
          ttlMs: 8_000,
        });
        continue;
      }
      // Re-sends of the same occurrence (more assignees walking) are coalesced by key.
      this.#deliver(this.router.scheduled(this.#routerAgent(record), fired, task));
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

  #onTurnEnded(brain: AgentBrain, result: SDKResultMessage): void {
    this.emit('turn', { agentId: brain.agentId, result, model: brain.session?.model ?? null });
    const tokens = Object.values(result.modelUsage ?? {}).reduce(
      (sum, u) =>
        sum +
        (u.inputTokens ?? 0) +
        (u.outputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0),
      0,
    );
    this.#tokens.set(brain.agentId, tokens);
  }

  /** Cumulative tokens of an agent's current session (HUD). */
  tokensOf(agentId: string): number {
    return this.#tokens.get(agentId) ?? 0;
  }

  #onSessionCrash(brain: AgentBrain, error: Error): void {
    this.supervisor.onCrash(brain.agentId, error, {
      restart: () => {
        if (!this.#brains.has(brain.agentId) || brain.record.status !== 'alive') return;
        void this.#startContexts(brain.record).then((contexts) => {
          try {
            brain.start({ contexts });
          } catch (err) {
            this.#log.error({ err }, 'brain restart failed');
          }
        });
      },
      offline: (reason) => {
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

  async #tell(from: AgentBrain, to: string, text: string): Promise<string> {
    const target = this.#resolveCrewRef(to);
    if (!target) throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `Nobody in the crew is called ${to}.`);
    if (target.status !== 'alive')
      throw new ApiError(ERROR_CODES.CHAT_UNAVAILABLE, `${target.name} is ${target.status}.`);
    if (target.agentId === from.agentId) throw new ApiError('BAD_ARGS', 'That is you.');
    this.transcripts.append(target.agentId, { kind: 'tell', text, fromAgentId: from.agentId });
    this.transcripts.append(from.agentId, {
      kind: 'tell',
      text: `→ ${target.name}: ${text}`,
      fromAgentId: target.agentId,
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
      reason: req.reason.slice(0, 500),
      firstTask: req.firstTask.slice(0, 2000),
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

  #emitCrew(): void {
    this.emit('crew', this.crewState());
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
      if (m && m.phase !== 'done') {
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
    const chatMode = delivery.mode ?? (delivery.to === 'all' ? 'chat' : 'reply');
    const immediate = chatMode === 'interrupt';
    const meetingIds: string[] = [];
    for (const d of route.deliveries) {
      if (d.mode === 'meeting') meetingIds.push(d.agentId);
      this.transcripts.append(d.agentId, {
        kind: 'player',
        text: route.body.length > 0 ? route.body : delivery.text,
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
          await this.#o.approveCalendarEvent?.(card.eventId);
          this.pending.resolve(card.id, { kind: 'approved' });
        }
        break;
      case 'calendar.decline':
        if (card.kind === 'calendar') {
          await this.#o.org.calendar.cancel(PLAYER, card.eventId, 'all').catch(() => {});
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
        if (brain && !brain.session?.started) {
          await brain.closeSession();
          brain.start({ contexts: await this.#startContexts(record) });
        }
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
