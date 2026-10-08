import { CHAT_MAX_LENGTH, type ChatEntry, ERROR_CODES, type PendingCard } from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
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
} from './CrewApi.js';
import { ApiError } from './common.js';

/** A crew member for {@link FakeCrewApi}: only the identity is required. */
export type FakeAgentInit = Pick<AgentSummary, 'agentId' | 'handle' | 'name'> & Partial<AgentSummary>;

/**
 * An in-memory {@link CrewApi} for tests and the scripted dev crew. Routing is deliberately simple (exact leading
 * `@handle`s, otherwise a broadcast to every living agent) and is not the real ChatRouter. Every call is recorded, and
 * the `emit*` / `raiseCard` / `setBusy` helpers drive the events a real runtime would produce.
 */
export class FakeCrewApi extends TypedEmitter<CrewEvents> implements CrewApi {
  readonly #agents = new Map<string, AgentSummary>();
  readonly #cards = new Map<string, PendingCard[]>();
  readonly #transcripts = new Map<string, ChatEntry[]>();
  readonly #busy = new Set<string>();
  readonly #now: () => number;

  /** Calls, in order. */
  readonly delivered: ChatDelivery[] = [];
  readonly answers: { pendingId: string; answer: CrewCardAnswer }[] = [];
  readonly commands: { agentId: string; command: CrewCommand }[] = [];

  constructor(agents: readonly FakeAgentInit[] = [], options: { now?: () => number } = {}) {
    super();
    this.#now = options.now ?? Date.now;
    for (const agent of agents) this.addAgent(agent);
  }

  addAgent(init: FakeAgentInit): AgentSummary {
    const agent: AgentSummary = {
      role: 'engineer',
      ceo: false,
      status: 'alive',
      model: 'haiku',
      brain: 'idle',
      seatedPc: null,
      autonomy: 'listen',
      planFirst: false,
      pingInstead: false,
      pendingCards: 0,
      ...init,
    };
    this.#agents.set(agent.agentId, agent);
    this.#emitCrew();
    return agent;
  }

  /** Marks an agent mid-turn: deliveries to it are `queued` with a latency hint. */
  setBusy(agentId: string, busy: boolean): void {
    if (busy) this.#busy.add(agentId);
    else this.#busy.delete(agentId);
  }

  /** Adds (or replaces) a pending card and emits `pending`. */
  raiseCard(card: PendingCard): void {
    const cards = (this.#cards.get(card.agentId) ?? []).filter((c) => c.id !== card.id);
    cards.push(card);
    this.#setCards(card.agentId, cards);
  }

  cardsOf(agentId: string): readonly PendingCard[] {
    return this.#cards.get(agentId) ?? [];
  }

  /** The agent speaks: a bubble plus a transcript line. */
  emitSay(agentId: string, text: string): void {
    this.#agent(agentId);
    this.emit('say', { agentId, text, style: 'speech', ttlMs: 8000 });
    this.#append(agentId, 'agent', text);
  }

  emitBrain(payload: CrewEvents['brain'][0]): void {
    const agent = this.#agent(payload.agentId);
    this.#agents.set(agent.agentId, {
      ...agent,
      model: payload.model,
      brain: payload.status,
      autonomy: payload.autonomy,
      planFirst: payload.planFirst,
      pingInstead: payload.pingInstead,
    });
    this.emit('brain', payload);
  }

  listAgents(): readonly AgentSummary[] {
    return [...this.#agents.values()];
  }

  async deliverChat(delivery: ChatDelivery): Promise<DeliveryResult> {
    this.delivered.push(delivery);
    const text = delivery.text.trim();
    if (text.length === 0 || delivery.text.length > CHAT_MAX_LENGTH) {
      throw new ApiError(ERROR_CODES.CHAT_REJECTED, 'type a message');
    }
    let targets: AgentSummary[];
    let body = text;
    let scope: DeliveryResult['scope'] = 'direct';
    if (delivery.to === 'all') {
      const mentions: string[] = [];
      const mention = /^@([A-Za-z][A-Za-z0-9_]*)(?:\s+|$)/;
      for (let m = mention.exec(body); m; m = mention.exec(body)) {
        mentions.push((m[1] ?? '').toLowerCase());
        body = body.slice(m[0].length);
      }
      if (mentions.length === 0 || mentions.includes('all')) {
        scope = 'broadcast';
        targets = this.listAgents().filter((a) => a.status === 'alive');
      } else {
        targets = mentions.map((handle) => this.#byHandle(handle));
      }
    } else {
      targets = delivery.to.map((id) => this.#agent(id));
    }
    for (const t of targets) {
      if (t.status !== 'alive') throw new ApiError(ERROR_CODES.CHAT_UNAVAILABLE, `${t.name} is ${t.status}`);
    }
    const deliveries: AgentDeliveryInfo[] = targets.map((t) => {
      const queued = this.#busy.has(t.agentId);
      return {
        agentId: t.agentId,
        mode: scope === 'broadcast' && t.seatedPc !== null ? 'context' : 'wake',
        queued,
        latencyMs: queued ? 30_000 : 0,
        hint: queued ? `${t.name} is mid-task, reads this at the next step` : null,
      };
    });
    for (const t of targets) this.#append(t.agentId, 'player', body.length > 0 ? body : text);
    const who = scope === 'broadcast' ? 'everyone' : targets.map((t) => t.name).join(', ');
    return { echo: `You → ${who}: ${body.length > 0 ? body : text}`, scope, deliveries, answeredCard: null };
  }

  async answerCard(pendingId: string, answer: CrewCardAnswer): Promise<CrewActionResult> {
    this.answers.push({ pendingId, answer });
    const found = this.#findCard(pendingId);
    if (!found) throw new ApiError(ERROR_CODES.CARD_GONE, 'that card is no longer pending');
    const { card, agent } = found;
    if (answer.kind === 'options') {
      if (card.kind !== 'question') throw new ApiError(ERROR_CODES.CHAT_INVALID_ANSWER, 'not a question');
      const question = card.questions[Math.min(card.answers.length, card.questions.length - 1)];
      const count = question?.options.length ?? 0;
      if (answer.picks.some((p) => p > count)) {
        throw new ApiError(ERROR_CODES.CHAT_INVALID_ANSWER, `pick 1-${count}`);
      }
      if (answer.picks.length > 1 && !question?.multiSelect) {
        throw new ApiError(ERROR_CODES.CHAT_INVALID_ANSWER, 'pick one option');
      }
    }
    const cards = this.cardsOf(agent.agentId);
    if (answer.kind === 'later') {
      this.#setCards(
        agent.agentId,
        cards.map((c) => (c.id === pendingId ? { ...c, parked: true, presenting: false } : c)),
      );
      return { echo: `You → ${agent.name}: later` };
    }
    this.#setCards(
      agent.agentId,
      cards.filter((c) => c.id !== pendingId),
    );
    return { echo: `You → ${agent.name}: ${describeAnswer(answer)}` };
  }

  async command(agentId: string, command: CrewCommand): Promise<CrewActionResult> {
    this.commands.push({ agentId, command });
    const agent = this.#agent(agentId);
    const next: AgentSummary = {
      ...agent,
      planFirst: command.cmd === 'plan_first' ? (command.on ?? agent.planFirst) : agent.planFirst,
      pingInstead: command.cmd === 'ping_instead' ? (command.on ?? agent.pingInstead) : agent.pingInstead,
      autonomy: command.cmd === 'autonomy' ? (command.level ?? agent.autonomy) : agent.autonomy,
      status: command.cmd === 'dismiss' ? 'dismissed' : agent.status,
      seatedPc: command.cmd === 'kick' ? null : agent.seatedPc,
    };
    this.#agents.set(agentId, next);
    if (next.status !== agent.status) this.#emitCrew();
    return { echo: `${agent.name}: ${command.cmd}` };
  }

  async chatHistory(
    agentId: string,
    options: { beforeSeq?: number | undefined; limit: number },
  ): Promise<{ entries: ChatEntry[]; more: boolean }> {
    this.#agent(agentId);
    const all = (this.#transcripts.get(agentId) ?? []).filter(
      (e) => options.beforeSeq === undefined || e.seq < options.beforeSeq,
    );
    const entries = all.slice(Math.max(0, all.length - options.limit));
    return { entries, more: all.length > entries.length };
  }

  #agent(agentId: string): AgentSummary {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `no agent ${agentId}`);
    return agent;
  }

  #byHandle(handle: string): AgentSummary {
    const agent =
      handle === 'ceo'
        ? this.listAgents().find((a) => a.ceo && a.status === 'alive')
        : this.listAgents().find((a) => a.handle === handle);
    if (!agent) throw new ApiError(ERROR_CODES.CHAT_UNKNOWN, `@${handle} matches nobody`);
    return agent;
  }

  #findCard(pendingId: string): { card: PendingCard; agent: AgentSummary } | null {
    for (const [agentId, cards] of this.#cards) {
      const card = cards.find((c) => c.id === pendingId);
      if (card) return { card, agent: this.#agent(agentId) };
    }
    return null;
  }

  #setCards(agentId: string, cards: PendingCard[]): void {
    const agent = this.#agent(agentId);
    this.#cards.set(agentId, cards);
    this.#agents.set(agentId, { ...agent, pendingCards: cards.length });
    this.emit('pending', { agentId, cards });
  }

  #append(agentId: string, kind: ChatEntry['kind'], text: string): void {
    const list = this.#transcripts.get(agentId) ?? [];
    const entry: ChatEntry = { seq: list.length, at: this.#now(), kind, text };
    list.push(entry);
    this.#transcripts.set(agentId, list);
    this.emit('chat', { agentId, entry });
  }

  #emitCrew(): void {
    this.emit('crew', {
      crew: this.listAgents().map((a) => ({
        agentId: a.agentId,
        handle: a.handle,
        name: a.name,
        role: a.role,
        ceo: a.ceo,
        status: a.status,
      })),
    });
  }
}

function describeAnswer(answer: CrewCardAnswer): string {
  switch (answer.kind) {
    case 'options':
      return answer.picks.join(',');
    case 'text':
      return answer.text;
    case 'revise':
      return `revise: ${answer.feedback}`;
    case 'decline':
      return answer.note ? `no ${answer.note}` : 'no';
    default:
      return answer.kind;
  }
}
