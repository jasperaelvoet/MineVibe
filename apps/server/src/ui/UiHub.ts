/**
 * UiHub (PLAN §6.4, §6.5, §7.8): the bridge side of the in-game UI. It is the only module that turns the mod's UI
 * requests into CrewApi calls and the CrewApi's events into UI pushes.
 *
 * Requests from the mod (each answered `ok` or `err{code,msg}`; `msg` is the inline hint the mod shows):
 * - `chat.send` → {@link CrewApi.deliverChat}. The echo says how the line was read and, when an addressed agent will
 *   not read it at once, why ("queued: Ada is mid-task, reads this at her next step").
 * - `pending.answer` / `plan.decision` / `hire.decision` → {@link CrewApi.answerCard}.
 * - `agent.cmd` → {@link CrewApi.command}; `chat.history` → {@link CrewApi.chatHistory}.
 *
 * Pushes to the mod: `agent.say`, `agent.brain`, `agent.pending`, `chat.append` and `crew.state` straight from the
 * CrewApi events, plus `ui.toast` ({@link UiHub.toast}) and `brains.state` ({@link UiHub.setBrains}).
 *
 * Resync: the hub mirrors the latest crew, brain, card and brains-summary state, and re-sends all of it after every
 * `hello` (PLAN §5 "Reconnects"), so a reconnecting or freshly started game shows the right bubbles, icons and cards.
 * The pushes go out on the next turn of the event loop, after `hello.ok`.
 */

import {
  type BrainsSummary,
  CHAT_MAX_LENGTH,
  ERROR_CODES,
  type MessageOf,
  type PayloadOf,
  type PendingCard,
} from '@minevibe/protocol';
import type { Logger } from 'pino';
import { BridgeError, type BridgeServer, type OutgoingType } from '../bridge/BridgeServer.js';
import type { AgentSummary, CrewApi, CrewCardAnswer, DeliveryResult } from '../contracts/CrewApi.js';
import { ApiError } from '../contracts/common.js';

/** What the hub needs from the bridge ({@link BridgeServer} provides it). */
export type UiBridge = Pick<BridgeServer, 'handle' | 'send' | 'on'>;

export interface UiHubOptions {
  readonly bridge: UiBridge;
  readonly crew: CrewApi;
  readonly logger: Logger;
  /** Schedules the post-`hello` resync; default `setImmediate`. */
  readonly defer?: (fn: () => void) => void;
}

/** The longest echo `ChatSendResult` allows. */
export const ECHO_MAX_LENGTH = CHAT_MAX_LENGTH + 200;

export type ToastKind = PayloadOf<'ui.toast'>['kind'];

function clipEcho(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  return flat.length <= ECHO_MAX_LENGTH ? flat : `${flat.slice(0, ECHO_MAX_LENGTH - 1)}…`;
}

/**
 * The echo for a delivered line: the router's reading plus, when an addressed agent cannot read it right away, the
 * reason ("(queued: Ada is mid-task, reads this at her next step)"). Context-only deliveries (seated agents copied on
 * a broadcast) are not waits and add nothing.
 */
export function formatEcho(result: DeliveryResult, names: ReadonlyMap<string, string> = new Map()): string {
  const hints: string[] = [];
  for (const d of result.deliveries) {
    if (!d.queued || d.mode === 'context') continue;
    const hint = d.hint ?? `${names.get(d.agentId) ?? d.agentId} reads this later`;
    if (!hints.includes(hint)) hints.push(hint);
  }
  return clipEcho(hints.length === 0 ? result.echo : `${result.echo} (queued: ${hints.join('; ')})`);
}

/** The default brain payload for an agent the hub has not seen an `agent.brain` for yet. */
export function brainFromSummary(agent: AgentSummary): PayloadOf<'agent.brain'> {
  return {
    agentId: agent.agentId,
    model: agent.model,
    status: agent.brain,
    activity: null,
    autonomy: agent.autonomy,
    planFirst: agent.planFirst,
    pingInstead: agent.pingInstead,
  };
}

export class UiHub {
  readonly #bridge: UiBridge;
  readonly #crew: CrewApi;
  readonly #log: Logger;
  readonly #defer: (fn: () => void) => void;
  readonly #offs: Array<() => void> = [];
  readonly #brains = new Map<string, PayloadOf<'agent.brain'>>();
  readonly #pending = new Map<string, PendingCard[]>();
  #crewState: PayloadOf<'crew.state'> | null = null;
  #brainsState: BrainsSummary | null = null;
  #started = false;

  constructor(options: UiHubOptions) {
    this.#bridge = options.bridge;
    this.#crew = options.crew;
    this.#log = options.logger;
    this.#defer = options.defer ?? ((fn) => setImmediate(fn));
  }

  /** Registers the request handlers and subscribes to the crew. Call once. */
  start(): this {
    if (this.#started) throw new Error('UiHub already started');
    this.#started = true;
    const b = this.#bridge;
    this.#offs.push(
      b.handle('chat.send', (m) => this.#chatSend(m)),
      b.handle('pending.answer', (m) => this.#answer(m.pendingId, m.answer)),
      b.handle('plan.decision', (m) =>
        this.#answer(
          m.pendingId,
          m.decision === 'approve'
            ? { kind: 'approve' }
            : { kind: 'revise', feedback: m.feedback ?? 'Revise.' },
        ),
      ),
      b.handle('hire.decision', (m) =>
        this.#answer(
          m.pendingId,
          m.decision === 'approve'
            ? { kind: 'approve' }
            : m.note
              ? { kind: 'decline', note: m.note }
              : { kind: 'decline' },
        ),
      ),
      b.handle('agent.cmd', (m) => this.#command(m)),
      b.handle('chat.history', (m) => this.#history(m)),
      b.on('hello', () => this.#defer(() => this.resync())),
      this.#crew.on('say', (p) => {
        this.#send('agent.say', p);
      }),
      this.#crew.on('brain', (p) => {
        this.#brains.set(p.agentId, p);
        this.#send('agent.brain', p);
      }),
      this.#crew.on('pending', (p) => {
        this.#pending.set(p.agentId, [...p.cards]);
        this.#send('agent.pending', p);
      }),
      this.#crew.on('chat', (p) => {
        this.#send('chat.append', p);
      }),
      this.#crew.on('crew', (p) => {
        this.#crewState = p;
        this.#send('crew.state', p);
      }),
    );
    return this;
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  /** Shows a toast in the game (bottom-left). Returns false when no mod is connected. */
  toast(text: string, kind: ToastKind = 'info', options: { agentId?: string; ttlMs?: number } = {}): boolean {
    const payload: PayloadOf<'ui.toast'> = { text: text.slice(0, 512) || '…', kind };
    if (options.agentId !== undefined) payload.agentId = options.agentId;
    if (options.ttlMs !== undefined) payload.ttlMs = options.ttlMs;
    return this.#send('ui.toast', payload);
  }

  /** Publishes the brain scheduler / usage summary (CrewHud, Zz icons). */
  setBrains(summary: BrainsSummary): void {
    this.#brainsState = summary;
    this.#send('brains.state', summary);
  }

  /** The cards of the last `agent.pending` push per agent. */
  get pending(): ReadonlyMap<string, readonly PendingCard[]> {
    return this.#pending;
  }

  /** Re-sends the full UI state (after `hello`). */
  resync(): void {
    const agents = this.#crew.listAgents();
    const crew: PayloadOf<'crew.state'> = this.#crewState ?? {
      crew: agents.map((a) => ({
        agentId: a.agentId,
        handle: a.handle,
        name: a.name,
        role: a.role,
        ceo: a.ceo,
        status: a.status,
      })),
    };
    if (!this.#send('crew.state', crew)) return;
    if (this.#brainsState) this.#send('brains.state', this.#brainsState);
    for (const agent of agents) {
      this.#send('agent.brain', this.#brains.get(agent.agentId) ?? brainFromSummary(agent));
      this.#send('agent.pending', { agentId: agent.agentId, cards: this.#pending.get(agent.agentId) ?? [] });
    }
    this.#log.debug({ agents: agents.length }, 'ui state re-sent');
  }

  async #chatSend(m: MessageOf<'chat.send'>): Promise<{ echo: string }> {
    const result = await this.#call(() =>
      this.#crew.deliverChat({ to: m.to, text: m.text, ...(m.mode !== undefined ? { mode: m.mode } : {}) }),
    );
    const names = new Map(this.#crew.listAgents().map((a) => [a.agentId, a.name]));
    const echo = formatEcho(result, names);
    this.#log.info(
      { scope: result.scope, deliveries: result.deliveries.length, answered: result.answeredCard },
      echo,
    );
    return { echo };
  }

  async #answer(pendingId: string, answer: CrewCardAnswer): Promise<{ echo: string }> {
    const { echo } = await this.#call(() => this.#crew.answerCard(pendingId, answer));
    this.#log.info({ pendingId, answer: answer.kind }, echo);
    return { echo: clipEcho(echo) };
  }

  async #command(m: MessageOf<'agent.cmd'>): Promise<{ echo: string }> {
    const { echo } = await this.#call(() =>
      this.#crew.command(m.agentId, {
        cmd: m.cmd,
        ...(m.on !== undefined ? { on: m.on } : {}),
        ...(m.level !== undefined ? { level: m.level } : {}),
      }),
    );
    this.#log.info({ agentId: m.agentId, cmd: m.cmd }, echo);
    return { echo: clipEcho(echo) };
  }

  async #history(m: MessageOf<'chat.history'>): Promise<{ entries: unknown[]; more: boolean }> {
    const page = await this.#call(() =>
      this.#crew.chatHistory(m.agentId, {
        limit: m.limit,
        ...(m.beforeSeq !== undefined ? { beforeSeq: m.beforeSeq } : {}),
      }),
    );
    return { entries: page.entries, more: page.more };
  }

  /** Runs a CrewApi call; {@link ApiError}s become `err{code,msg}` replies (and a toast for dead or dismissed names). */
  async #call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === ERROR_CODES.CHAT_UNAVAILABLE) this.toast(err.message, 'warn');
        throw new BridgeError(err.code, err.message);
      }
      throw err;
    }
  }

  #send<K extends OutgoingType>(t: K, payload: PayloadOf<K>): boolean {
    try {
      return this.#bridge.send(t, payload);
    } catch (err) {
      this.#log.error({ err, type: t }, 'ui push failed validation');
      return false;
    }
  }
}
