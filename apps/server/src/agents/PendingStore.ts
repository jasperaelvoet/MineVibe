/**
 * PendingStore (PLAN §6.4): every pending card of the crew (questions, plans, hires, calendar approvals), persisted per
 * agent in `worlds/<w>/agents/<id>/pending.json` so a restart can re-ask them.
 *
 * Question and plan cards normally have a live waiter (the canUseTool promise the InteractionBroker holds). Cards
 * loaded from disk after an app restart have none: they are `stale`, and the runtime delivers their answers as
 * messages instead (re-ask). Hire and calendar cards are Node-side and need no waiter.
 */

import { readFile } from 'node:fs/promises';
import { type PendingCard as WireCard, PendingCard as WireCardSchema } from '@minevibe/protocol';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomicFile.js';
import { TypedEmitter } from '../util/TypedEmitter.js';

export type Card = WireCard;
export type QuestionCard = Extract<Card, { kind: 'question' }>;
export type PlanCard = Extract<Card, { kind: 'plan' }>;
export type HireCard = Extract<Card, { kind: 'hire' }>;
export type CalendarCard = Extract<Card, { kind: 'calendar' }>;

/** How a card ended. */
export type CardOutcome =
  | { readonly kind: 'answered'; readonly answers: Readonly<Record<string, string>> }
  | { readonly kind: 'approved'; readonly firstTask?: string | undefined; readonly name?: string | undefined }
  | { readonly kind: 'revise'; readonly feedback: string }
  | { readonly kind: 'declined'; readonly note: string | null }
  /** Cleanup (interrupt, kick, death, dismiss, world end, aborted turn): the waiter denies with `reason`. */
  | { readonly kind: 'denied'; readonly reason: string; readonly interrupt?: boolean | undefined };

export type CardWaiter = (outcome: CardOutcome) => void;

interface Entry {
  card: Card;
  readonly waiter: CardWaiter | null;
  /** Seat epoch the card belongs to (plan cards die with the seat). */
  readonly epoch: number | null;
  /** Loaded from disk after a restart: no live canUseTool promise. */
  readonly stale: boolean;
}

export type PendingEvents = {
  /** The full card list of one agent changed (forward as `agent.pending`). */
  changed: [agentId: string, cards: readonly Card[]];
};

const PendingFile = z.object({ v: z.literal(1), cards: z.array(WireCardSchema) });

let cardSeq = 0;
/** A card id that fits the protocol's opaque-id pattern. */
export function newCardId(prefix = 'c'): string {
  cardSeq = (cardSeq + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}-${cardSeq.toString(36)}`;
}

export interface PendingStoreOptions {
  /** `pending.json` of an agent, or null to keep cards in memory only (tests, or before a world is known). */
  readonly fileOf?: (agentId: string) => string | null;
  readonly onError?: (err: unknown) => void;
}

export class PendingStore extends TypedEmitter<PendingEvents> {
  readonly #entries = new Map<string, Entry>();
  readonly #fileOf: (agentId: string) => string | null;
  readonly #onError: (err: unknown) => void;
  readonly #writes = new Map<string, Promise<void>>();
  #frozen = false;

  constructor(options: PendingStoreOptions = {}) {
    super();
    this.#fileOf = options.fileOf ?? (() => null);
    this.#onError = options.onError ?? (() => {});
  }

  /** Loads an agent's cards from disk (app restart). Question and plan cards come back `stale`. */
  async load(agentId: string): Promise<readonly Card[]> {
    const file = this.#fileOf(agentId);
    if (!file) return [];
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    let parsed: z.infer<typeof PendingFile>;
    try {
      parsed = PendingFile.parse(JSON.parse(raw));
    } catch (err) {
      this.#onError(err);
      return [];
    }
    for (const card of parsed.cards) {
      if (card.agentId !== agentId || this.#entries.has(card.id)) continue;
      this.#entries.set(card.id, {
        card: { ...card, presenting: false },
        waiter: null,
        epoch: null,
        stale: card.kind === 'question' || card.kind === 'plan',
      });
    }
    this.#changed(agentId);
    return this.list(agentId);
  }

  add(card: Card, options: { waiter?: CardWaiter | null; epoch?: number | null } = {}): void {
    if (this.#entries.has(card.id)) throw new Error(`card ${card.id} exists`);
    this.#entries.set(card.id, {
      card,
      waiter: options.waiter ?? null,
      epoch: options.epoch ?? null,
      stale: false,
    });
    this.#changed(card.agentId);
  }

  get(cardId: string): Card | undefined {
    return this.#entries.get(cardId)?.card;
  }

  isStale(cardId: string): boolean {
    return this.#entries.get(cardId)?.stale ?? false;
  }

  epochOf(cardId: string): number | null {
    return this.#entries.get(cardId)?.epoch ?? null;
  }

  /** An agent's cards, oldest first. */
  list(agentId: string): Card[] {
    return [...this.#entries.values()]
      .filter((e) => e.card.agentId === agentId)
      .map((e) => e.card)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  all(): Card[] {
    return [...this.#entries.values()].map((e) => e.card).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Replaces fields of a card (answers so far, parked, presenting). */
  update(cardId: string, patch: Partial<Card>): Card | undefined {
    const entry = this.#entries.get(cardId);
    if (!entry) return undefined;
    entry.card = { ...entry.card, ...patch, id: entry.card.id, kind: entry.card.kind } as Card;
    this.#changed(entry.card.agentId);
    return entry.card;
  }

  /** Ends a card: removes it and hands `outcome` to its waiter. Returns false when it was already gone. */
  resolve(cardId: string, outcome: CardOutcome): boolean {
    const entry = this.#entries.get(cardId);
    if (!entry) return false;
    this.#entries.delete(cardId);
    this.#changed(entry.card.agentId);
    try {
      entry.waiter?.(outcome);
    } catch (err) {
      this.#onError(err);
    }
    return true;
  }

  /**
   * Resolves the agent's cards matching `filter` (default: questions and plans, the blocking ones) as denied with
   * `reason`. Returns how many were resolved.
   */
  cleanup(
    agentId: string,
    reason: string,
    filter: (card: Card, entry: { epoch: number | null; stale: boolean }) => boolean = (c) =>
      c.kind === 'question' || c.kind === 'plan',
  ): number {
    let n = 0;
    for (const [id, entry] of [...this.#entries]) {
      if (entry.card.agentId !== agentId) continue;
      if (!filter(entry.card, { epoch: entry.epoch, stale: entry.stale })) continue;
      if (this.resolve(id, { kind: 'denied', reason })) n++;
    }
    return n;
  }

  /** Moves a card to another agent (a dead CEO's hire card goes to the promoted CEO). */
  move(cardId: string, toAgentId: string): void {
    const entry = this.#entries.get(cardId);
    if (!entry) return;
    const from = entry.card.agentId;
    entry.card = { ...entry.card, agentId: toAgentId, presenting: false };
    this.#changed(from);
    this.#changed(toAgentId);
  }

  /**
   * The agent's session died (crash): its question cards lose their live waiter and become stale, so they are
   * re-asked and answered as messages. Returns how many.
   */
  markStale(agentId: string, filter: (card: Card) => boolean = (c) => c.kind === 'question'): number {
    let n = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.card.agentId !== agentId || entry.stale || !filter(entry.card)) continue;
      this.#entries.set(id, { ...entry, waiter: null, stale: true });
      n++;
    }
    return n;
  }

  /** Stops writing `pending.json` (app shutdown: the cards on disk are re-asked next start). */
  freeze(): void {
    this.#frozen = true;
  }

  /** Forgets every card of an agent without resolving (the world's data is archived). */
  drop(agentId: string): void {
    for (const [id, entry] of [...this.#entries])
      if (entry.card.agentId === agentId) this.#entries.delete(id);
    this.#changed(agentId);
  }

  /** Waits for pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.#writes.values()]);
  }

  #changed(agentId: string): void {
    const cards = this.list(agentId);
    this.emit('changed', agentId, cards);
    this.#persist(agentId, cards);
  }

  #persist(agentId: string, cards: readonly Card[]): void {
    if (this.#frozen) return;
    const file = this.#fileOf(agentId);
    if (!file) return;
    const body = `${JSON.stringify({ v: 1, cards }, null, 2)}\n`;
    const prev = this.#writes.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => writeFileAtomic(file, body, { mode: 0o600 }))
      .catch((err: unknown) => this.#onError(err));
    this.#writes.set(agentId, next);
    void next.then(() => {
      if (this.#writes.get(agentId) === next) this.#writes.delete(agentId);
    });
  }
}
