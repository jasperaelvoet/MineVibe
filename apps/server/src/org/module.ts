/**
 * The org module (PLAN §6.4 ApproachQueue, §6.6 Codex / Calendar / Meetings): {@link OrgServices} wired to the bridge,
 * the crew and the world, behind the composition contract of orchestrator/modules.ts ({@link createOrgModule}).
 *
 * Bridge (the module owns the org group of the protocol, §7.8)
 * - Requests from CodexScreen, CalendarScreen and the meeting HUD: `codex.search/get/put/delete`, `calendar.put/cancel`,
 *   `meeting.start/end`, answered through the {@link OrgApi} as the player (`ApiError` → `err{code,msg}`).
 * - Pushes, all in the wire shapes (wire.ts): `codex.index`, `calendar.state`, `meeting.state` on every change and
 *   after every `hello`; `calendar.fired` when an occurrence fires and again as assignees accept; `agent.approach`
 *   for the ApproachQueue; `ui.toast` and `agent.say` for pings, meetings and reminders.
 * - World input: `world.state` (clock, player snapshot with its idle time, office slots), `agent.state`,
 *   `agent.event` (`approach_blocked`). Deaths and dismissals come from the crew.
 *
 * Crew ({@link OrgModule.bindCrew})
 * - The crew's pending cards (every `agent.pending` event) feed the ApproachQueue. The presenter's card is marked
 *   `presenting` (and parked cards `parked`) in the crew's card store when the crew offers one ({@link CrewCardControl},
 *   which the AgentManager does), else through a corrected `agent.pending` push. A card the player parks ("later")
 *   is parked in the queue too.
 * - A seated presenter that walks over: `CrewHooks.goAway`, and `comeBack` once answered.
 * - Meetings: `pullIntoMeeting` for every attendee who walks to the table (resolving when seated), `meetingTurn` for
 *   each speaker, `releaseFromMeeting` at dismissal.
 * - Calendar tasks: `deliver(…, 'scheduled')`; once it resolves (the brain accepted the task) the agent is added to
 *   `calendar.fired.walk` and the occurrence is re-sent. Context lines go out as `deliver(…, 'context')`.
 *
 * Text for the crew ({@link crewText}): the org's own control heads (`[MV:<org nonce> KIND]`) are not the agent's
 * session nonce, which the persona calls forged, so they are stripped; the crew side tags what it delivers with the
 * agent's own nonce for `kind`. Shared text stays inside the org's data envelopes.
 */

import { ERROR_CODES, type PayloadOf, type PendingCard, type Place } from '@minevibe/protocol';
import type { Logger } from 'pino';
import {
  BridgeError,
  type BridgeServer,
  type IncomingType,
  type OutgoingType,
  type RequestHandler,
} from '../bridge/BridgeServer.js';
import type { CrewApi } from '../contracts/CrewApi.js';
import { ApiError, PLAYER } from '../contracts/common.js';
import type { CreateOrgModule, CrewHooks, OrgModule, RuntimeContext } from '../orchestrator/modules.js';
import type { ApproachState, PingReason } from './approach/ApproachQueue.js';
import type { CalendarApprovalCard } from './calendar/CalendarService.js';
import { type OrgClock, systemClock } from './clock.js';
import { OrgContractApi } from './contractApi.js';
import { ControlNonce, singleLine } from './envelope.js';
import type { MeetingTurnRequest, MeetingTurnResult } from './meeting/MeetingRunner.js';
import {
  type DeliveryPriority,
  type OrgHost,
  type OrgPushType,
  OrgServices,
  orgPaths,
} from './OrgServices.js';
import { OVERWORLD, WorldView } from './worldView.js';

/** The parts of the bridge the module uses. */
export type OrgBridge = Pick<BridgeServer, 'on' | 'handle' | 'send'>;

/**
 * Optional card-store access a CrewApi may offer (the AgentManager does: `pending` is its PendingStore). Without it,
 * presenting/parked flags go out as a corrected `agent.pending` push and calendar approval cards stay with the
 * org's own ApproachQueue.
 */
export interface CrewCardControl {
  readonly pending?: {
    update(cardId: string, patch: { presenting?: boolean; parked?: boolean }): unknown;
    resolve?(cardId: string, outcome: { kind: 'denied'; reason: string }): unknown;
  };
  /** Raises a `calendar` approval card for an agent-created recurring event or meeting. */
  raiseCalendarApproval?(agentId: string, eventId: string, summary: string): { readonly id: string };
  /** Every pending card (for the first sync after binding). */
  pendingCards?(): readonly PendingCard[];
}

export interface OrgModuleOptions {
  readonly clock?: OrgClock | undefined;
  readonly nonce?: ControlNonce | undefined;
  /** Absolute git binary for the Codex history (default `/usr/bin/git`); null disables git. */
  readonly gitBinary?: string | null | undefined;
  readonly timeZone?: string | undefined;
  /** Runs the post-`hello` resync and the corrected `agent.pending` pushes later (default `setImmediate`). */
  readonly defer?: ((fn: () => void) => void) | undefined;
}

type DeliverKind = 'scheduled' | 'meeting' | 'context';

/**
 * Org text for an agent: each `[MV:<org nonce> KIND]` head at a line start is dropped when the crew's own tag for
 * `kind` says the same (SCHEDULED, MEETING) and becomes `KIND:` otherwise (APPROVAL, REPORT, MISSED, …).
 */
export function crewText(text: string, nonce: ControlNonce, kind: DeliverKind): string {
  const head = new RegExp(`^\\[MV:${nonce.value} ([A-Z ]+)\\] ?`, 'gm');
  return text.replace(head, (_m, k: string) =>
    (k === 'SCHEDULED' && kind === 'scheduled') || (k === 'MEETING' && kind === 'meeting') ? '' : `${k}: `,
  );
}

const RESPONDERS_RE = /^\s*(?:[-*]\s*)?RESPONDERS?\s*:\s*(.*)$/i;
const ACTION_RE = /^\s*(?:[-*]\s*)?ACTION\s*:\s*(.+)$/i;

/** The meeting-turn prompt for the crew: the org's prompt plus the reply format a turn kind needs. */
export function meetingPrompt(
  req: MeetingTurnRequest,
  nonce: ControlNonce,
  assignable: readonly { agentId: string; name: string }[],
): string {
  let prompt = crewText(req.prompt, nonce, 'meeting');
  if (req.kind === 'floor_chair') {
    const ids = (req.candidates ?? []).join(', ') || 'nobody';
    prompt += `\nEnd with one line "RESPONDERS: <ids>" naming at most 2 attendees who should answer (from: ${ids}), or "RESPONDERS: none".`;
  } else if (req.kind === 'wrapup') {
    const who = assignable.map((a) => `${a.agentId} (${a.name})`).join(', ') || 'nobody';
    prompt += `\nThen list each action item on its own line as "ACTION: <assignee id> | <task> | <when>" (when: "now", "Day 3 08:00" or "08:00"; blank means now). Assignees: ${who}.`;
  }
  return prompt;
}

/** Reads a meeting turn's reply: `RESPONDERS:` (floor chair) and `ACTION:` (wrap-up) lines are taken out of the text. */
export function parseMeetingTurn(
  req: MeetingTurnRequest,
  reply: string,
  resolve: (token: string) => string | null,
): MeetingTurnResult {
  const kept: string[] = [];
  const responders: string[] = [];
  const actionItems: Array<{ title: string; assignee: string; task?: string; when?: string }> = [];
  for (const line of reply.split(/\r?\n/)) {
    const r = RESPONDERS_RE.exec(line);
    if (r) {
      for (const token of (r[1] ?? '').split(/[\s,;]+/)) {
        const t = token.replace(/^@/, '').trim();
        if (!t || t.toLowerCase() === 'none') continue;
        const id = resolve(t);
        if (id && (req.candidates ?? []).includes(id) && !responders.includes(id)) responders.push(id);
      }
      continue;
    }
    const a = ACTION_RE.exec(line);
    if (a) {
      const [who = '', task = '', when = ''] = (a[1] ?? '').split('|').map((p) => p.trim());
      const assignee = resolve(who.replace(/^@/, ''));
      const title = singleLine(task, 80);
      if (assignee && title) {
        actionItems.push({ title, assignee, task: singleLine(task, 500), ...(when ? { when } : {}) });
      }
      continue;
    }
    kept.push(line);
  }
  const text = kept.join('\n').trim() || reply.trim();
  const out: { -readonly [K in keyof MeetingTurnResult]: MeetingTurnResult[K] } = { text };
  if (req.kind === 'floor_chair') out.responders = responders;
  if (req.kind === 'wrapup') {
    out.summary = text;
    out.actionItems = actionItems;
  }
  return out;
}

const DIAL_IN_LINES: Readonly<Record<string, string>> = {
  eta: 'Dialling in: too far to walk to the table.',
  unreachable: "Dialling in: I can't get to the table.",
  dimension: 'Dialling in from another dimension.',
  escort: 'Dialling in: staying with you.',
  late: 'Dialling in: running late.',
};

const CARD_WORDS: Readonly<Record<PendingCard['kind'], string>> = {
  question: 'a question',
  plan: 'a plan to approve',
  hire: 'a hire to approve',
  calendar: 'an event to approve',
};

const PING_WHY: Readonly<Record<PingReason, string>> = {
  night: 'it is dark out there',
  far: 'too far to walk over',
  digging: 'no clear path',
  dimension: 'you are in another dimension',
  pc_screen: 'you are at a PC',
  setting: 'pings instead of walking over',
  seated: 'busy at a PC',
  no_path: 'no path to you',
};

type ApproachRole = PayloadOf<'agent.approach'>['role'];

/** The presenting/parked flags of a card list, as a comparable key. */
function flagsKey(cards: readonly PendingCard[]): string {
  return JSON.stringify(cards.map((c) => [c.id, c.presenting, c.parked]));
}

/** The org module of the composition contract. */
export const createOrgModule: CreateOrgModule = (ctx) => new OrgModuleImpl(ctx);

/** {@link createOrgModule} with injectable clock, nonce and git (tests). */
export function createOrgModuleWith(ctx: RuntimeContext, options: OrgModuleOptions = {}): OrgModuleImpl {
  return new OrgModuleImpl(ctx, options);
}

export class OrgModuleImpl implements OrgModule {
  readonly orgApi: OrgContractApi;
  readonly services: OrgServices;
  readonly view = new WorldView();
  readonly #ctx: RuntimeContext;
  readonly #bridge: OrgBridge;
  readonly #log: Logger;
  readonly #clock: OrgClock;
  readonly #nonce: ControlNonce;
  readonly #defer: (fn: () => void) => void;
  readonly #offs: Array<() => void> = [];
  readonly #crewOffs: Array<() => void> = [];
  #crew: CrewApi | null = null;
  #hooks: CrewHooks | null = null;
  #started = false;
  #playerName = 'the player';
  #lastClock: number | null = null;
  /** A `world.state.player` snapshot arrived in this world (until then the player counts as active). */
  #sawPlayer = false;
  /** Living/dead status per agent, to notice deaths and dismissals in `crew` events. */
  readonly #statuses = new Map<string, string>();
  /** "The Codex survived" for the next world's CEO. */
  #pendingNotice: string | null = null;
  /** The "Ping instead of walking over" settings passed to the ApproachQueue. */
  readonly #pingPrefs = new Map<string, boolean>();
  /**
   * The starter office per world, as the mod reported it (once, in a `ready`). Kept across the view's world reset,
   * which can run after the report arrived (the crew opens the world first).
   */
  readonly #offices = new Map<string, NonNullable<PayloadOf<'world.state'>['office']>>();

  // Cards and the ApproachQueue
  /** Cards the queue knows, by card id. */
  readonly #cards = new Map<string, { agentId: string; kind: PendingCard['kind']; parked: boolean }>();
  /** The latest card list per agent (as the crew pushed it). */
  readonly #lastCards = new Map<string, readonly PendingCard[]>();
  /** The `agent.approach` role last sent per agent. */
  readonly #roles = new Map<string, { role: ApproachRole; pendingId: string | null }>();
  #presentingCard: string | null = null;
  readonly #pinged = new Set<string>();
  /** The presenting/parked flags the mod last got per agent (the crew's push, or a corrected one). */
  readonly #modCards = new Map<string, string>();
  readonly #decorateScheduled = new Set<string>();
  #syncing = false;
  readonly #syncAgain = new Set<string>();
  /** OrgServices approval card id (`cal:<eventId>`) → the crew's card id. */
  readonly #approvalCards = new Map<string, string>();

  // Meetings
  /** Attendees pulled into the running meeting (released at dismissal). */
  readonly #pulled = new Set<string>();

  constructor(ctx: RuntimeContext, options: OrgModuleOptions = {}) {
    this.#ctx = ctx;
    this.#bridge = ctx.bridge;
    this.#log = ctx.log.child({ component: 'org' });
    this.#clock = options.clock ?? systemClock;
    this.#nonce = options.nonce ?? new ControlNonce();
    this.#defer = options.defer ?? ((fn) => setImmediate(fn));
    const view = this.view;
    const host: OrgHost = {
      crew: () => view.orgCrew(),
      usage: () => view.usage(),
      player: () => view.playerSnapshot(),
      etaSeconds: (id) => view.etaSeconds(id),
      tableDimension: () => OVERWORLD,
      statusLine: (id) => view.statusLine(id),
      deliver: (agentId, text, how) => {
        const delivered = this.#deliver(agentId, text, how.priority);
        // A task's promise tells OrgServices the brain accepted it (walk re-send); other lines are fire-and-forget.
        if (how.occurrence !== undefined) return delivered;
        delivered.catch((err: unknown) => this.#log.warn({ err, agentId }, 'org delivery failed'));
        return undefined;
      },
      toast: (text) => this.#toast(text),
      requestApproval: (card) => this.#raiseApproval(card),
      withdrawApproval: (cardId, reason) => this.#withdrawApproval(cardId, reason),
      placeOf: (location) => this.placeOf(location),
      push: (type, payload) => this.#push(type, payload),
      meetingBrain: { turn: (req, signal) => this.#meetingTurn(req, signal) },
      meetingEffects: {
        gather: (agentId, meetingId) => this.#pull(agentId, meetingId),
        dialIn: (agentId, _meetingId, reason) => this.#say(agentId, DIAL_IN_LINES[reason] ?? 'Dialling in.'),
        dismiss: (agentId) => this.#release(agentId),
        toast: (text) => this.#toast(text),
        raiseCards: (agentIds) => this.#raiseCardsAtTable(agentIds),
        say: (agentId, text) => this.#say(agentId, text),
      },
      approachEffects: {
        approach: (agentId, cardId) => this.#onApproach(agentId, cardId),
        ping: (agentId, cardId, reason) => this.#onPing(agentId, cardId, reason),
        seat: (agentId, action) => this.#onSeat(agentId, action),
        parked: (_agentId, cardId) => this.#setCardFlags(cardId, { parked: true, presenting: false }),
        unparked: (_agentId, cardId) => this.#setCardFlags(cardId, { parked: false }),
        state: (state) => this.#onApproachState(state),
      },
    };
    this.services = new OrgServices({
      paths: orgPaths(ctx.paths),
      host,
      nonce: this.#nonce,
      clock: this.#clock,
      timeZone: options.timeZone,
      playerName: () => this.#playerName,
      gitBinary: options.gitBinary,
      logger: this.#log,
      // The crew tells the CEO about task reports (the `mc` server's `taskReported`, P3 coalesced); a second notice
      // from the calendar would wake the CEO twice.
      reportToCeo: false,
    });
    // Nothing fires until a crew is bound: occurrences due at startup and deliveries restored from disk would be
    // marked missed for want of anyone to deliver them to (bindCrew releases the calendar).
    this.services.calendar.hold(true);
    this.orgApi = new OrgContractApi(this.services, {
      crew: () => view.orgCrew(),
      playerName: () => this.#playerName,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle (OrgModule)
  // -------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.services.start(this.#ctx.world()?.worldId ?? null);
    this.#registerBridge();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const off of this.#offs.splice(0)) off();
    for (const off of this.#crewOffs.splice(0)) off();
    await this.services.stop();
  }

  bindCrew(crew: CrewApi, hooks: CrewHooks): void {
    for (const off of this.#crewOffs.splice(0)) off();
    this.#crew = crew;
    this.#hooks = hooks;
    this.#refreshCrew();
    this.#crewOffs.push(
      crew.on('crew', () => this.#refreshCrew()),
      crew.on('brain', (p) => {
        this.view.setActivity(p.agentId, p.activity);
        this.#refreshCrew();
      }),
      crew.on('pending', (p) => this.#syncCards(p.agentId, p.cards)),
    );
    // The AgentManager also emits the unmentioned player lines of a running meeting and the usage summary.
    const extra = crew as unknown as {
      on(event: 'meetingMessage', fn: (p: { text: string }) => void): () => void;
      on(
        event: 'brains',
        fn: (p: { mode: 'normal' | 'tired' | 'asleep'; resetsAt: number | null }) => void,
      ): () => void;
    };
    this.#crewOffs.push(
      extra.on('meetingMessage', (p) => this.services.meetingMessage(p.text)),
      extra.on('brains', (p) => this.view.setBrains(p)),
    );
    const summary = (crew as { brainsSummary?: () => unknown }).brainsSummary;
    if (typeof summary === 'function') {
      const b = summary.call(crew) as { mode?: unknown; resetsAt?: unknown } | null;
      if (b && (b.mode === 'normal' || b.mode === 'tired' || b.mode === 'asleep')) {
        this.view.setBrains({ mode: b.mode, resetsAt: typeof b.resetsAt === 'number' ? b.resetsAt : null });
      }
    }
    const control = crew as CrewCardControl;
    if (typeof control.pendingCards === 'function') {
      const byAgent = new Map<string, PendingCard[]>();
      for (const card of control.pendingCards()) {
        byAgent.set(card.agentId, [...(byAgent.get(card.agentId) ?? []), card]);
      }
      for (const [agentId, cards] of byAgent) this.#syncCards(agentId, cards);
    }
    this.services.calendar.hold(false);
  }

  async onWorldOpen(worldId: string, _fresh: boolean): Promise<void> {
    const changed = this.services.codex.worldId !== worldId || this.services.calendar.worldId !== worldId;
    if (changed) {
      this.view.resetWorld();
      this.#lastClock = null;
      this.#sawPlayer = false;
    }
    await this.services.openWorld(worldId);
    const office = this.#offices.get(worldId);
    if (office) {
      if (!this.view.office) this.view.setOffice(office);
      this.#ensureBasePage(worldId, office);
    }
    this.#deliverNotice();
  }

  /** The world-scope Codex page "Base (office)" (protocol §7.4.3), written once per world by MineVibe. */
  #ensureBasePage(worldId: string, office: NonNullable<PayloadOf<'world.state'>['office']>): void {
    this.services
      .ensureBasePage(worldId, office, this.#playerName)
      .catch((err: unknown) => this.#log.warn({ err, worldId }, 'Base page failed'));
  }

  async onWorldEnded(worldId: string): Promise<void> {
    // The crew dies with the world: nobody presents or queues any more, and its cards leave the queue.
    for (const agentId of [...this.#roles.keys()]) this.#sendApproach(agentId, null, 'release');
    this.#presentingCard = null;
    this.#cards.clear();
    this.#lastCards.clear();
    this.#modCards.clear();
    this.#pinged.clear();
    this.#approvalCards.clear();
    this.services.approach.clear();
    this.#pulled.clear();
    const ended = await this.services.worldEnded(worldId);
    this.#offices.delete(worldId);
    this.#pendingNotice = ended.notice;
    this.view.resetWorld();
    this.#lastClock = null;
    this.#sawPlayer = false;
  }

  onClock(clockTime: number): void {
    if (clockTime === this.#lastClock) return;
    this.#lastClock = clockTime;
    this.view.setClock(clockTime);
    this.services.onGameClock(clockTime);
  }

  // -------------------------------------------------------------------------------------------
  // Bridge
  // -------------------------------------------------------------------------------------------

  #registerBridge(): void {
    const b = this.#bridge;
    const api = this.orgApi;
    this.#offs.push(
      b.on('hello', (m) => {
        if (m.playerName) this.#playerName = m.playerName;
        this.#defer(() => this.resync());
      }),
      b.on('world.state', (m) => this.#onWorldState(m)),
      b.on('agent.state', (m) => {
        this.view.setBodies(m.agents);
        for (const body of m.agents) {
          if (body.seat?.kind === 'meeting' && this.services.meetingState()?.id === body.seat.meetingId) {
            this.services.meetingArrived(body.agentId);
          }
        }
        this.#worldView();
      }),
      b.on('agent.event', (m) => {
        if (m.kind !== 'approach_blocked') return;
        this.view.blocked(m.agentId, m.data?.why, this.#clock.now());
        this.#worldView();
      }),
    );
    // Deaths and dismissals arrive as crew changes (the crew answers `agent.died`); player activity comes with the
    // `world.state.player` snapshot. Neither request type gets a listener here, so the bridge still answers
    // NOT_HANDLED when nothing handles them.
    this.#handle('codex.search', async (m) => ({
      hits: await api.codex.search(PLAYER, {
        query: m.query,
        tags: m.tags,
        category: m.category,
        scope: m.scope,
        limit: m.limit,
      }),
    }));
    this.#handle('codex.get', async (m) => ({ page: await api.codex.read(PLAYER, m.pageId) }));
    this.#handle('codex.put', async (m) => {
      const res = await api.codex.write(PLAYER, {
        mode: m.mode,
        pageId: m.pageId,
        baseRev: m.baseRev,
        title: m.title,
        body: m.body,
        tags: m.tags,
        category: m.category,
        scope: m.scope,
        pinned: m.pinned,
      });
      return { pageId: res.pageId, rev: res.rev };
    });
    this.#handle('codex.delete', async (m) => {
      await api.codex.delete(PLAYER, m.pageId, m.baseRev);
      return {};
    });
    this.#handle('calendar.put', async (m) => {
      const { t: _t, v: _v, id: _id, re: _re, eventId, ...fields } = m;
      if (eventId !== undefined) {
        await api.calendar.update(PLAYER, eventId, fields);
        return { eventId };
      }
      const res = await api.calendar.add(PLAYER, fields);
      return { eventId: res.eventId };
    });
    this.#handle('calendar.cancel', async (m) => {
      await api.calendar.cancel(PLAYER, m.eventId, m.scope);
      return {};
    });
    this.#handle('meeting.start', async (m) => {
      const res = await api.meeting.start(PLAYER, {
        eventId: m.eventId,
        title: m.title,
        attendees: m.attendees,
        preview: m.preview,
      });
      return { meetingId: res.meetingId, etas: res.etas };
    });
    this.#handle('meeting.end', async (m) => {
      await api.meeting.end(PLAYER, m.meetingId);
      return {};
    });
  }

  /** Registers a request handler; an {@link ApiError} becomes `err{code,msg}`. */
  #handle<K extends IncomingType>(t: K, fn: RequestHandler<K>): void {
    try {
      this.#offs.push(
        this.#bridge.handle(t, async (m) => {
          try {
            return await fn(m);
          } catch (err) {
            if (err instanceof ApiError) throw new BridgeError(err.code, err.message);
            throw err;
          }
        }),
      );
    } catch (err) {
      this.#log.error({ err, t }, 'org request handler not registered: another module handles it');
    }
  }

  /** Re-sends the org state after `hello` (a reconnect is a full resync; protocol §7.2). Nothing changed: no events. */
  resync(): void {
    this.#send('codex.index', this.services.codexIndexPayload());
    this.#send('calendar.state', this.services.calendarStatePayload());
    const meeting = this.orgApi.meeting.state();
    if (meeting) this.#send('meeting.state', meeting);
    const roles = [...this.#roles];
    this.#roles.clear();
    for (const [agentId, r] of roles)
      if (r.role !== 'release') this.#sendApproach(agentId, r.pendingId, r.role);
    // The crew's resync re-sends its own card lists; corrected flags (no card store) go out after it.
    for (const [agentId, cards] of this.#lastCards) {
      this.#modCards.set(agentId, flagsKey(cards));
      this.#scheduleDecorate(agentId);
    }
  }

  #send<K extends OutgoingType>(t: K, payload: PayloadOf<K>): boolean {
    try {
      return this.#bridge.send(t, payload);
    } catch (err) {
      this.#log.error({ err, t }, 'org push failed validation');
      return false;
    }
  }

  #push<T extends OrgPushType>(type: T, payload: PayloadOf<T>): void {
    this.#send(type, payload as PayloadOf<OutgoingType>);
    switch (type) {
      case 'codex.index':
        this.orgApi.publish('codexIndex', payload as PayloadOf<'codex.index'>);
        break;
      case 'calendar.state':
        this.orgApi.publish('calendarState', payload as PayloadOf<'calendar.state'>);
        break;
      case 'calendar.fired':
        this.orgApi.publish('calendarFired', payload as PayloadOf<'calendar.fired'>);
        break;
      case 'meeting.state':
        this.orgApi.publish('meetingState', payload as PayloadOf<'meeting.state'>);
        break;
    }
  }

  #toast(text: string): void {
    this.#send('ui.toast', { text: singleLine(text, 512) || '…', kind: 'info' });
  }

  #say(agentId: string, text: string): void {
    const line = singleLine(text, 600);
    if (line) this.#send('agent.say', { agentId, text: line, style: 'speech', ttlMs: 10_000 });
  }

  // -------------------------------------------------------------------------------------------
  // World
  // -------------------------------------------------------------------------------------------

  #onWorldState(m: PayloadOf<'world.state'>): void {
    const current = this.services.calendar.worldId;
    if (m.office) this.#offices.set(m.worldId, m.office);
    if (current !== null && m.worldId !== current) return; // a late push from the previous world
    if (m.office) {
      this.view.setOffice(m.office);
      if (this.services.codex.worldId === m.worldId) this.#ensureBasePage(m.worldId, m.office);
    }
    const now = this.#clock.now();
    if (m.player) {
      this.#sawPlayer = true;
      this.view.setPlayer(m.player, now);
      this.services.calendar.notePlayerInput(now - m.player.idleMs);
    } else if (!this.#sawPlayer) {
      // No player snapshot from this mod (yet): the player counts as active, as everywhere else (worldView.ts).
      // Otherwise the calendar would call the player AFK 5 minutes after start and hold every game-clock and
      // agent-created event from then on.
      this.services.calendar.notePlayerInput(now);
    }
    if (m.clockTime !== undefined) this.onClock(m.clockTime);
    if (m.player) this.#worldView();
  }

  #worldView(): void {
    this.services.onWorldView(this.view.approachSnapshot(this.#clock.now()));
  }

  /**
   * Where an event location is: `meeting_table`, `pc:<id>` (its workstation slot), another office slot kind (`door`,
   * `codex`, …), or a Codex `places` page (by id or title; its stamped coordinates, else the first `x, y, z` in it).
   */
  placeOf(location: string): Place | null {
    const loc = location.trim();
    if (!loc) return null;
    if (loc === 'meeting_table' || loc === 'table') return this.view.slot('meeting_table');
    if (loc.startsWith('pc:')) return this.view.slot('workstation', loc.slice(3));
    const slot = this.view.slot(loc);
    if (slot) return slot;
    const codex = this.services.codex;
    const lower = loc.toLowerCase();
    const page =
      codex.get(loc, { count: false }) ??
      codex.list({ category: 'places' }).find((p) => p.title.toLowerCase() === lower) ??
      null;
    const full = page ? codex.get(page.id, { count: false }) : null;
    if (!full) return null;
    if (full.coords) {
      return {
        pos: { x: Math.round(full.coords.x), y: Math.round(full.coords.y), z: Math.round(full.coords.z) },
        dim: full.coords.dim,
      };
    }
    const m = /(-?\d{1,8})\s*[, ]\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,8})/.exec(full.body);
    return m ? { pos: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, dim: OVERWORLD } : null;
  }

  // -------------------------------------------------------------------------------------------
  // Crew
  // -------------------------------------------------------------------------------------------

  #refreshCrew(): void {
    const crew = this.#crew;
    if (!crew) return;
    const agents = crew.listAgents();
    this.view.setCrew(agents);
    for (const a of agents) {
      const before = this.#statuses.get(a.agentId);
      this.#statuses.set(a.agentId, a.status);
      if (before === 'alive' && a.status !== 'alive') this.#agentGone(a.agentId);
      if (a.status === 'alive' && this.#pingPrefs.get(a.agentId) !== a.pingInstead) {
        this.#pingPrefs.set(a.agentId, a.pingInstead);
        this.services.setPingPreference(a.agentId, a.pingInstead);
      }
    }
    this.#deliverNotice();
  }

  #agentGone(agentId: string): void {
    this.services.agentDied(agentId);
    this.#pulled.delete(agentId);
    if (this.#roles.has(agentId)) this.#sendApproach(agentId, null, 'release');
    for (const [id, c] of [...this.#cards]) if (c.agentId === agentId) this.#cards.delete(id);
  }

  /** "The Codex survived" reaches the next world's CEO once there is one. */
  #deliverNotice(): void {
    const notice = this.#pendingNotice;
    if (!notice || !this.#hooks) return;
    const ceo = this.view.members.find((a) => a.ceo && a.status === 'alive');
    if (!ceo) return;
    this.#pendingNotice = null;
    this.#hook('deliver', ceo.agentId, (h) =>
      h.deliver(ceo.agentId, crewText(notice, this.#nonce, 'context'), 'context'),
    );
  }

  #deliver(agentId: string, text: string, priority: DeliveryPriority): Promise<void> {
    const hooks = this.#hooks;
    if (!hooks) {
      this.#log.warn({ agentId }, 'org delivery dropped: no crew bound');
      return Promise.reject(new Error('no crew bound'));
    }
    const kind: DeliverKind = priority === 'context' ? 'context' : 'scheduled';
    try {
      return Promise.resolve(hooks.deliver(agentId, crewText(text, this.#nonce, kind), kind));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Runs a crew hook without letting a throw or a rejection escape into the org services. */
  #hook(what: string, agentId: string, fn: (hooks: CrewHooks) => Promise<unknown>): Promise<unknown> | null {
    const hooks = this.#hooks;
    if (!hooks) return null;
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(fn(hooks));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch((err: unknown) => this.#log.warn({ err, agentId }, `${what} failed`));
    return p;
  }

  // -------------------------------------------------------------------------------------------
  // Cards and the ApproachQueue
  // -------------------------------------------------------------------------------------------

  /**
   * One agent's card list from the crew: new cards join the queue, gone ones leave it, "later" parks them. Marking a
   * card in the crew's store makes the crew push the list again from inside a sync; that list waits for the end of
   * the current one.
   */
  #syncCards(agentId: string, cards: readonly PendingCard[]): void {
    this.#lastCards.set(agentId, cards);
    this.#modCards.set(agentId, flagsKey(cards));
    if (this.#syncing) {
      this.#syncAgain.add(agentId);
      return;
    }
    this.#syncing = true;
    try {
      this.#syncCardsNow(agentId, cards);
      for (let guard = 0; this.#syncAgain.size > 0 && guard < 64; guard++) {
        const next = this.#syncAgain.values().next().value as string;
        this.#syncAgain.delete(next);
        this.#syncCardsNow(next, this.#lastCards.get(next) ?? []);
      }
    } finally {
      this.#syncing = false;
      this.#syncAgain.clear();
    }
  }

  #syncCardsNow(agentId: string, cards: readonly PendingCard[]): void {
    const parkedInQueue = new Set(this.services.approachState().parked.map((p) => p.cardId));
    const listed = new Set<string>();
    for (const card of cards) {
      listed.add(card.id);
      const known = this.#cards.get(card.id);
      if (!known || known.agentId !== card.agentId) {
        if (known) this.services.cardResolved(card.id); // moved (a dead CEO's hire card)
        this.#cards.set(card.id, { agentId: card.agentId, kind: card.kind, parked: card.parked });
        this.services.cardPending({
          cardId: card.id,
          agentId: card.agentId,
          kind: card.kind,
          createdAt: card.createdAt,
        });
        if (card.parked) this.services.parkCard(card.id);
        continue;
      }
      // The player parked it ("later"); the queue's own parking is already reflected.
      if (card.parked && !known.parked && !parkedInQueue.has(card.id)) this.services.parkCard(card.id);
      known.parked = card.parked;
    }
    for (const [id, c] of [...this.#cards]) {
      if (c.agentId !== agentId || listed.has(id)) continue;
      this.#cards.delete(id);
      this.#pinged.delete(id);
      if (this.#presentingCard === id) this.#presentingCard = null;
      this.services.cardResolved(id);
    }
    this.#scheduleDecorate(agentId);
  }

  #sendApproach(agentId: string, pendingId: string | null, role: ApproachRole): void {
    const last = this.#roles.get(agentId);
    if (last && last.role === role && last.pendingId === pendingId) return;
    if (role === 'release') {
      if (!last) return;
      this.#roles.delete(agentId);
    } else {
      this.#roles.set(agentId, { role, pendingId });
    }
    this.#send('agent.approach', { agentId, pendingId: role === 'release' ? null : pendingId, role });
  }

  #onApproach(agentId: string, cardId: string | null): void {
    if (cardId) {
      this.#sendApproach(agentId, cardId, 'present');
      return;
    }
    // A presenter that switches to a ping stops walking; the ping that follows replaces the role.
    const presenter = this.services.approach.presenter;
    if (presenter?.agentId === agentId && presenter.mode === 'ping') return;
    const queued = this.services.approachState().queued.find((q) => q.agentId === agentId);
    if (queued && this.#mayQueue(agentId)) this.#sendApproach(agentId, queued.cardId, 'queue');
    else this.#sendApproach(agentId, null, 'release');
  }

  /**
   * Whether a waiting agent lines up behind the player ("?", 5-7 blocks back). Not when it attends a meeting (cards
   * are raised at the table), sits at a PC (seated agents ping), prefers pinging, or is far away or elsewhere.
   */
  #mayQueue(agentId: string): boolean {
    if (this.services.isInMeeting(agentId)) return false;
    const member = this.view.member(agentId);
    if (member?.status !== 'alive' || member.pingInstead || member.seatedPc !== null) return false;
    const body = this.view.body(agentId);
    if (!body || body.seat?.kind === 'pc') return false;
    return body.playerDistance !== undefined && body.playerDistance <= 48;
  }

  #onPing(agentId: string, cardId: string, reason: PingReason): void {
    this.#sendApproach(agentId, cardId, 'ping');
    const key = `${cardId}:${reason}`;
    if (this.#pinged.has(key)) return;
    this.#pinged.add(key);
    const member = this.view.member(agentId);
    const kind = this.#cards.get(cardId)?.kind ?? 'question';
    const name = member?.name ?? agentId;
    const how = member ? `@${member.handle} or G` : 'G';
    this.#send('ui.toast', {
      text: singleLine(`${name} has ${CARD_WORDS[kind]} for you (${PING_WHY[reason]}): ${how}`, 512),
      kind: 'info',
      agentId,
    });
  }

  #onSeat(agentId: string, action: 'reserve_and_walk' | 'return' | 'expire'): void {
    if (action === 'reserve_and_walk') {
      const cardId = this.services.approach.presenter?.cardId;
      if (cardId) this.#hook('goAway', agentId, (h) => h.goAway(agentId, cardId));
    } else if (action === 'return') {
      this.#hook('comeBack', agentId, (h) => h.comeBack(agentId));
    }
    // 'expire': the crew's SeatFSM ends a 3-minute reservation by itself (PLAN §6.3); the card is kept.
  }

  #onApproachState(state: ApproachState): void {
    const presenter = state.presenter;
    const queuedIds = new Set(state.queued.map((q) => q.agentId));
    for (const q of state.queued) {
      if (q.agentId === presenter?.agentId) continue;
      if (this.#mayQueue(q.agentId)) this.#sendApproach(q.agentId, q.cardId, 'queue');
      else this.#sendApproach(q.agentId, null, 'release');
    }
    for (const agentId of [...this.#roles.keys()]) {
      if (agentId === presenter?.agentId || queuedIds.has(agentId)) continue;
      this.#sendApproach(agentId, null, 'release');
    }
    const presenting = presenter?.cardId ?? null;
    if (presenting !== this.#presentingCard) {
      const before = this.#presentingCard;
      this.#presentingCard = presenting;
      if (before && this.#cards.has(before)) this.#setCardFlags(before, { presenting: false });
      if (presenting) this.#setCardFlags(presenting, { presenting: true });
    }
  }

  /** Marks a card in the crew's store, or (without a store) in a corrected `agent.pending` push. */
  #setCardFlags(cardId: string, flags: { presenting?: boolean; parked?: boolean }): void {
    const card = this.#cards.get(cardId);
    if (!card) return;
    const store = (this.#crew as CrewCardControl | null)?.pending;
    if (store && typeof store.update === 'function') {
      if (flags.parked !== undefined) card.parked = flags.parked;
      store.update(cardId, flags);
      return;
    }
    this.#scheduleDecorate(card.agentId);
  }

  #scheduleDecorate(agentId: string): void {
    const store = (this.#crew as CrewCardControl | null)?.pending;
    if (store && typeof store.update === 'function') return;
    if (this.#decorateScheduled.has(agentId)) return;
    this.#decorateScheduled.add(agentId);
    // After the crew's own `agent.pending` push (UiHub forwards it synchronously), so this one wins.
    this.#defer(() => {
      this.#decorateScheduled.delete(agentId);
      this.#decorate(agentId);
    });
  }

  #decorate(agentId: string): void {
    const cards = this.#lastCards.get(agentId);
    if (!cards) return;
    const parked = new Set(this.services.approachState().parked.map((p) => p.cardId));
    const decorated = cards.map((c) => ({
      ...c,
      presenting: c.id === this.#presentingCard,
      parked: c.parked || parked.has(c.id),
    }));
    const key = flagsKey(decorated);
    if (this.#modCards.get(agentId) === key) return;
    if (this.#send('agent.pending', { agentId, cards: decorated })) this.#modCards.set(agentId, key);
  }

  #raiseApproval(card: CalendarApprovalCard): string | undefined {
    const control = this.#crew as CrewCardControl | null;
    if (!control || typeof control.raiseCalendarApproval !== 'function') return undefined;
    // An edit that still needs approval asks again: the earlier card for the event goes, so only one is answerable.
    this.#withdrawApproval(card.cardId, 'replaced by a newer card');
    const summary = `${singleLine(card.title, 80)}: ${card.summary}`;
    const raised = control.raiseCalendarApproval(card.agentId, card.eventId, summary);
    this.#approvalCards.set(card.cardId, raised.id);
    return raised.id;
  }

  /**
   * Resolves the crew's approval card(s) of an event (`cal:<eventId>`): the one this module raised, and any other
   * calendar card for the event in the crew's store (one raised before an app restart, which this map forgets).
   */
  #withdrawApproval(cardId: string, reason = 'the event changed or was cancelled'): void {
    const ids = new Set<string>();
    const mapped = this.#approvalCards.get(cardId);
    if (mapped) ids.add(mapped);
    this.#approvalCards.delete(cardId);
    const control = this.#crew as CrewCardControl | null;
    const eventId = cardId.startsWith('cal:') ? cardId.slice(4) : null;
    if (eventId !== null && typeof control?.pendingCards === 'function') {
      for (const c of control.pendingCards())
        if (c.kind === 'calendar' && c.eventId === eventId) ids.add(c.id);
    }
    for (const id of ids) control?.pending?.resolve?.(id, { kind: 'denied', reason });
  }

  #raiseCardsAtTable(agentIds: readonly string[]): void {
    const names = agentIds
      .filter((id) => [...this.#cards.values()].some((c) => c.agentId === id))
      .map((id) => this.view.member(id)?.name ?? id);
    if (names.length === 0) return;
    this.#toast(
      `At the table: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} cards for you (G or @name)`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Meetings
  // -------------------------------------------------------------------------------------------

  /** An attendee walks to the table; the hook resolves once it sits there (the 1 Hz seat also tells). */
  #pull(agentId: string, meetingId: string): void {
    const pulled = this.#hook('pullIntoMeeting', agentId, (h) => h.pullIntoMeeting(agentId, meetingId));
    if (!pulled) return;
    this.#pulled.add(agentId);
    pulled.then(
      () => {
        if (this.services.meetingState()?.id === meetingId) this.services.meetingArrived(agentId);
      },
      () => {
        // Logged by #hook. The agent cannot get to the table: it dials in now instead of holding up the gathering.
        if (this.services.meetingState()?.id === meetingId) this.services.meetingCannotCome(agentId);
      },
    );
  }

  #release(agentId: string): void {
    if (!this.#pulled.delete(agentId)) return;
    this.#hook('releaseFromMeeting', agentId, (h) => h.releaseFromMeeting(agentId));
  }

  async #meetingTurn(req: MeetingTurnRequest, signal: AbortSignal): Promise<MeetingTurnResult> {
    const hooks = this.#hooks;
    if (!hooks) throw new Error('no crew bound');
    const assignable = this.view.members
      .filter((a) => a.status === 'alive')
      .map((a) => ({ agentId: a.agentId, name: a.name }));
    const reply = await hooks.meetingTurn(req.agentId, meetingPrompt(req, this.#nonce, assignable), {
      maxSentences: req.maxSentences,
    });
    if (signal.aborted) throw signal.reason ?? new Error('meeting moved on');
    return parseMeetingTurn(req, reply, (token) => this.#resolveAgent(token));
  }

  /** An agent id, handle or name → the agent id. */
  #resolveAgent(token: string): string | null {
    const t = token.trim().toLowerCase();
    if (!t) return null;
    const members = this.view.members;
    const hit =
      members.find((a) => a.agentId.toLowerCase() === t) ??
      members.find((a) => a.handle.toLowerCase() === t) ??
      members.find((a) => a.name.toLowerCase() === t);
    return hit?.agentId ?? null;
  }
}

/** Error codes the org handlers answer with (for docs and tests). */
export const ORG_ERROR_CODES = [
  ERROR_CODES.CODEX_NOT_FOUND,
  ERROR_CODES.CODEX_CONFLICT,
  ERROR_CODES.CODEX_SIMILAR,
  ERROR_CODES.CODEX_TOO_LARGE,
  ERROR_CODES.CODEX_SECRET,
  ERROR_CODES.CODEX_INVALID,
  ERROR_CODES.CODEX_BUDGET,
  ERROR_CODES.CALENDAR_NOT_FOUND,
  ERROR_CODES.CALENDAR_INVALID,
  ERROR_CODES.CALENDAR_LIMIT,
  ERROR_CODES.MEETING_BUSY,
  ERROR_CODES.MEETING_NOT_FOUND,
  ERROR_CODES.NO_QUORUM,
  ERROR_CODES.FORBIDDEN,
  ERROR_CODES.NOT_READY,
] as const;
