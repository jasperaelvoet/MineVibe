/**
 * Chat routing glue (PLAN §6.4, §6.5): connects the pure {@link ChatRouter} / answer grammar to the CrewApi contract.
 *
 * - {@link chatContextFrom} builds the router's snapshot from what a CrewApi exposes: `listAgents()` and the cards of
 *   the last `agent.pending` push per agent.
 * - {@link toCrewCardAnswer} turns the router's card answer (an answer-grammar interpretation) into the contract's
 *   {@link CrewCardAnswer}, the same shape AgentScreen and the G card send as `pending.answer` / `plan.decision` /
 *   `hire.decision`. So a chat line `@ada 2` and a click on option 2 resolve a card identically.
 *
 * Calendar approval cards are not part of the chat grammar (they are answered in AgentScreen or with G only), so
 * they never become the front card here.
 */

import type { PendingCard as WireCard } from '@minevibe/protocol';
import type { PendingCard as GrammarCard } from '../agents/chat/answerGrammar.js';
import type { CardAnswer, ChatAgent, ChatContext, MeetingScope } from '../agents/chat/ChatRouter.js';
import type { AgentSummary, CrewCardAnswer } from '../contracts/CrewApi.js';

/** The protocol card as the answer grammar sees it, or null for kinds the grammar does not answer (calendar). */
export function toGrammarCard(card: WireCard): GrammarCard | null {
  switch (card.kind) {
    case 'question':
      return {
        kind: 'question',
        id: card.id,
        agentId: card.agentId,
        createdAt: card.createdAt,
        questions: card.questions,
        answers: card.answers,
      };
    case 'plan':
      return { kind: 'plan', id: card.id, agentId: card.agentId, createdAt: card.createdAt, plan: card.plan };
    case 'hire':
      return {
        kind: 'hire',
        id: card.id,
        agentId: card.agentId,
        createdAt: card.createdAt,
        role: card.role,
        name: card.name,
      };
    case 'calendar':
      return null;
  }
}

/** A crew member as the router sees it. Meeting chairs never count as seated (only PCs do). */
export function toChatAgent(agent: AgentSummary): ChatAgent {
  return {
    agentId: agent.agentId,
    handle: agent.handle,
    name: agent.name,
    status: agent.status,
    ceo: agent.ceo,
    seated: agent.seatedPc !== null,
  };
}

export interface ChatContextInput {
  readonly playerName: string;
  readonly agents: readonly AgentSummary[];
  /** The latest cards per agent id (as pushed in `agent.pending`). */
  readonly cards: ReadonlyMap<string, readonly WireCard[]>;
  readonly meeting?: MeetingScope | null;
}

export function chatContextFrom(input: ChatContextInput): ChatContext {
  const cards = new Map<string, GrammarCard[]>();
  for (const [agentId, list] of input.cards) {
    const mapped = list.map(toGrammarCard).filter((c): c is GrammarCard => c !== null);
    if (mapped.length > 0) cards.set(agentId, mapped);
  }
  return {
    playerName: input.playerName,
    crew: input.agents.map(toChatAgent),
    cards,
    meeting: input.meeting ?? null,
  };
}

/**
 * Maps a routed card answer onto the contract. Question answers keep the 1-based option numbers when the player typed
 * numbers; an exact label becomes its option number; free text stays text. Returns null when the card is unknown or a
 * label no longer matches (the caller then reports the card as gone).
 */
export function toCrewCardAnswer(answer: CardAnswer, card: WireCard | undefined): CrewCardAnswer | null {
  switch (answer.kind) {
    case 'question.answer': {
      if (answer.freeText) return { kind: 'text', text: answer.value };
      if (answer.picks !== null) return { kind: 'options', picks: [...answer.picks] };
      if (card?.kind !== 'question') return null;
      const question = card.questions[answer.questionIndex];
      if (!question) return null;
      const picks = answer.labels
        .map((label) => question.options.findIndex((o) => o.label === label) + 1)
        .filter((n) => n > 0);
      return picks.length === answer.labels.length && picks.length > 0 ? { kind: 'options', picks } : null;
    }
    case 'plan.approve':
    case 'hire.approve':
      return { kind: 'approve' };
    case 'plan.revise':
      return { kind: 'revise', feedback: answer.feedback };
    case 'hire.decline':
      return answer.note ? { kind: 'decline', note: answer.note } : { kind: 'decline' };
    case 'later':
      return { kind: 'later' };
  }
}

/** Finds a card by id across agents. */
export function findCard(
  cards: ReadonlyMap<string, readonly WireCard[]>,
  pendingId: string,
): WireCard | undefined {
  for (const list of cards.values()) {
    const card = list.find((c) => c.id === pendingId);
    if (card) return card;
  }
  return undefined;
}
