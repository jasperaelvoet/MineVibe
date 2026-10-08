/**
 * Card answers from the wire (`pending.answer`, `plan.decision`, `hire.decision`, AgentScreen, G, Alt+1-4) mapped onto
 * the same interpretation the chat grammar produces, so both paths resolve cards identically (PLAN §6.4).
 */

import type { CrewCardAnswer } from '../contracts/CrewApi.js';
import {
  buildAnswers,
  type PendingCard as GrammarCard,
  type QuestionCard as GrammarQuestionCard,
  type Interpretation,
  interpretAnswer,
} from './chat/answerGrammar.js';
import type { Card } from './PendingStore.js';

/** Calendar approval cards are decided with approve / decline only. */
export type CardInterpretation =
  | Interpretation
  | { readonly kind: 'calendar.approve'; readonly cardId: string }
  | { readonly kind: 'calendar.decline'; readonly cardId: string; readonly note: string | null };

/** The chat grammar's view of a protocol card (calendar cards are not answerable by chat). */
export function grammarCard(card: Card): GrammarCard | null {
  return card.kind === 'calendar' ? null : (card as GrammarCard);
}

function invalid(card: Card, hint: string): CardInterpretation {
  return { kind: 'invalid', cardId: card.id, code: 'no_question', hint };
}

function questionFromPicks(
  card: Extract<Card, { kind: 'question' }>,
  picks: readonly number[],
): CardInterpretation {
  const index = card.answers.length;
  const q = card.questions[index];
  if (!q) return invalid(card, 'That question was already answered');
  const label = `Q${index + 1}`;
  const unique = [...new Set(picks)].sort((a, b) => a - b);
  const bad = unique.filter((n) => n < 1 || n > q.options.length);
  if (bad.length > 0) {
    return {
      kind: 'invalid',
      cardId: card.id,
      code: 'out_of_range',
      hint: `${label} has options 1-${q.options.length}; ${bad.join(', ')} is not one of them`,
    };
  }
  if (!q.multiSelect && unique.length > 1) {
    return { kind: 'invalid', cardId: card.id, code: 'single_select', hint: `${label} takes one answer` };
  }
  const labels = unique.map((n) => q.options[n - 1]?.label ?? String(n));
  const value = labels.join(', ');
  const done = index + 1 >= card.questions.length;
  return {
    kind: 'question.answer',
    cardId: card.id,
    questionIndex: index,
    questionCount: card.questions.length,
    value,
    picks: unique,
    labels,
    freeText: false,
    done,
    answers: done
      ? buildAnswers(card.questions as GrammarQuestionCard['questions'], [...card.answers, value])
      : null,
  };
}

function questionFromText(card: Extract<Card, { kind: 'question' }>, text: string): CardInterpretation {
  const index = card.answers.length;
  if (!card.questions[index]) return invalid(card, 'That question was already answered');
  const value = text.trim();
  const done = index + 1 >= card.questions.length;
  return {
    kind: 'question.answer',
    cardId: card.id,
    questionIndex: index,
    questionCount: card.questions.length,
    value,
    picks: null,
    labels: [],
    freeText: true,
    done,
    answers: done
      ? buildAnswers(card.questions as GrammarQuestionCard['questions'], [...card.answers, value])
      : null,
  };
}

/** Interprets a structured answer against `card`. `handle` names the agent in hints. */
export function interpretWireAnswer(card: Card, answer: CrewCardAnswer, handle: string): CardInterpretation {
  if (answer.kind === 'later') return { kind: 'later', cardId: card.id };
  switch (card.kind) {
    case 'question':
      if (answer.kind === 'options') return questionFromPicks(card, answer.picks);
      if (answer.kind === 'text') return questionFromText(card, answer.text);
      return invalid(card, 'Answer the question with an option or text');
    case 'plan':
      if (answer.kind === 'approve') return { kind: 'plan.approve', cardId: card.id };
      if (answer.kind === 'revise')
        return { kind: 'plan.revise', cardId: card.id, feedback: answer.feedback };
      if (answer.kind === 'decline')
        return { kind: 'plan.revise', cardId: card.id, feedback: answer.note ?? 'No.' };
      if (answer.kind === 'text') return interpretAnswer(card as GrammarCard, answer.text, handle);
      return invalid(card, 'Approve the plan, or reply with changes');
    case 'hire':
      if (answer.kind === 'approve') return { kind: 'hire.approve', cardId: card.id };
      if (answer.kind === 'decline')
        return { kind: 'hire.decline', cardId: card.id, note: answer.note ?? null };
      if (answer.kind === 'text') return interpretAnswer(card as GrammarCard, answer.text, handle);
      return invalid(card, 'Approve or decline the hire');
    case 'calendar':
      if (answer.kind === 'approve') return { kind: 'calendar.approve', cardId: card.id };
      if (answer.kind === 'decline')
        return { kind: 'calendar.decline', cardId: card.id, note: answer.note ?? null };
      return invalid(card, 'Approve or decline the event');
  }
}
