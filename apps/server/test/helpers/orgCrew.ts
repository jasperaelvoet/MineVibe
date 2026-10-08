/**
 * A crew for org module tests: {@link FakeCrewApi} plus the card-store access the AgentManager offers
 * ({@link CrewCardControl}), and {@link FakeHooks}, a scripted {@link CrewHooks} that records every call.
 */

import type { PendingCard } from '@minevibe/protocol';
import type { AgentSummary } from '../../src/contracts/CrewApi.js';
import { type FakeAgentInit, FakeCrewApi } from '../../src/contracts/FakeCrewApi.js';
import type { CrewHooks } from '../../src/orchestrator/modules.js';
import type { CrewCardControl } from '../../src/org/module.js';

export class OrgFakeCrew extends FakeCrewApi implements CrewCardControl {
  readonly flagWrites: Array<{ cardId: string; patch: { presenting?: boolean; parked?: boolean } }> = [];
  readonly resolved: Array<{ cardId: string; reason: string }> = [];
  #seq = 0;
  readonly #clock: () => number;

  /** `withStore: false` hides the card store (the corrected `agent.pending` fallback). */
  constructor(agents: readonly FakeAgentInit[], options: { now?: () => number; withStore?: boolean } = {}) {
    super(agents, { now: options.now });
    this.#clock = options.now ?? Date.now;
    if (options.withStore === false) {
      Object.defineProperty(this, 'pending', { value: undefined });
      Object.defineProperty(this, 'raiseCalendarApproval', { value: undefined });
    }
  }

  readonly pending: NonNullable<CrewCardControl['pending']> = {
    update: (cardId, patch) => {
      this.flagWrites.push({ cardId, patch });
      const card = this.allCards().find((c) => c.id === cardId);
      if (card) this.raiseCard({ ...card, ...patch } as PendingCard);
      return card;
    },
    resolve: (cardId, outcome) => {
      this.resolved.push({ cardId, reason: outcome.reason });
      this.dropCard(cardId);
      return true;
    },
  };

  raiseCalendarApproval(agentId: string, eventId: string, summary: string): { id: string } {
    const id = `k-${++this.#seq}`;
    this.raiseCard({
      id,
      agentId,
      createdAt: this.#clock(),
      parked: false,
      presenting: false,
      kind: 'calendar',
      eventId,
      summary,
    });
    return { id };
  }

  pendingCards(): readonly PendingCard[] {
    return this.allCards();
  }

  allCards(): PendingCard[] {
    return this.listAgents().flatMap((a) => [...this.cardsOf(a.agentId)]);
  }

  /** Raises a question card for an agent. */
  ask(agentId: string, id: string, question = 'Oak or spruce?'): PendingCard {
    const card: PendingCard = {
      id,
      agentId,
      createdAt: this.#clock(),
      parked: false,
      presenting: false,
      kind: 'question',
      questions: [{ question, options: [{ label: 'Oak' }, { label: 'Spruce' }], multiSelect: false }],
      answers: [],
    };
    this.raiseCard(card);
    return card;
  }

  /** Removes a card (answered). */
  dropCard(cardId: string): void {
    const card = this.allCards().find((c) => c.id === cardId);
    if (card) void this.answerCard(cardId, { kind: 'text', text: 'done' });
  }

  /** Changes an agent's summary (seat, status, CEO, ping setting) and emits `crew`. */
  update(agentId: string, patch: Partial<AgentSummary>): void {
    const agent = this.listAgents().find((a) => a.agentId === agentId);
    if (!agent) throw new Error(`no agent ${agentId}`);
    this.addAgent({ ...agent, ...patch });
  }

  /** The usage summary, as the AgentManager emits it (`brains.state`). */
  brains(mode: 'normal' | 'tired' | 'asleep', resetsAt: number | null): void {
    (this.emit as (event: string, ...args: unknown[]) => boolean)('brains', {
      inFlight: 0,
      queued: 0,
      max: 2,
      mode,
      utilization: null,
      resetsAt,
    });
  }

  /** An unmentioned player line during a meeting, as the AgentManager emits it. */
  meetingLine(text: string, agentIds: readonly string[]): void {
    (this.emit as (event: string, ...args: unknown[]) => boolean)('meetingMessage', { text, agentIds });
  }
}

type Deferred = { resolve: () => void; reject: (err: Error) => void };

/** Scripted CrewHooks: every call is recorded; deliveries and pulls resolve at once unless held. */
export class FakeHooks implements CrewHooks {
  readonly calls: string[] = [];
  readonly delivered: Array<{ agentId: string; text: string; kind: 'scheduled' | 'meeting' | 'context' }> =
    [];
  readonly prompts: Array<{ agentId: string; prompt: string; maxSentences: number }> = [];
  /** Hold `deliver` until {@link accept} (the brain has not taken the task yet). */
  holdDeliveries = false;
  /** Hold `pullIntoMeeting` until {@link arrive}. */
  holdPulls = false;
  readonly #held = new Map<string, Deferred>();
  readonly #pulls = new Map<string, Deferred>();
  /** The scripted meeting brain. */
  turn: (agentId: string, prompt: string) => string = (agentId) => `${agentId} has nothing to add.`;

  async goAway(agentId: string, pendingId: string): Promise<void> {
    this.calls.push(`goAway ${agentId} ${pendingId}`);
  }

  async comeBack(agentId: string): Promise<void> {
    this.calls.push(`comeBack ${agentId}`);
  }

  pullIntoMeeting(agentId: string, meetingId: string): Promise<void> {
    this.calls.push(`pull ${agentId} ${meetingId}`);
    if (!this.holdPulls) return Promise.resolve();
    return new Promise((resolve, reject) => this.#pulls.set(agentId, { resolve, reject }));
  }

  async releaseFromMeeting(agentId: string): Promise<void> {
    this.calls.push(`release ${agentId}`);
  }

  deliver(agentId: string, text: string, kind: 'scheduled' | 'meeting' | 'context'): Promise<void> {
    this.delivered.push({ agentId, text, kind });
    this.calls.push(`deliver ${agentId} ${kind}`);
    if (!this.holdDeliveries || kind !== 'scheduled') return Promise.resolve();
    return new Promise((resolve, reject) => this.#held.set(agentId, { resolve, reject }));
  }

  async meetingTurn(agentId: string, prompt: string, opts: { maxSentences: number }): Promise<string> {
    this.prompts.push({ agentId, prompt, maxSentences: opts.maxSentences });
    this.calls.push(`turn ${agentId}`);
    return this.turn(agentId, prompt);
  }

  /** The held delivery to `agentId` is accepted by its brain. */
  accept(agentId: string): void {
    this.#held.get(agentId)?.resolve();
    this.#held.delete(agentId);
  }

  /** The held pull of `agentId` ends with it seated at the table. */
  arrive(agentId: string): void {
    this.#pulls.get(agentId)?.resolve();
    this.#pulls.delete(agentId);
  }

  /** The held pull of `agentId` fails: the crew cannot walk it to the table. */
  failPull(agentId: string): void {
    this.#pulls.get(agentId)?.reject(new Error('no path to the table'));
    this.#pulls.delete(agentId);
  }
}
