/**
 * Answer grammar (PLAN §6.4), shared by chat, AgentScreen and the G card.
 *
 * - Each agent has one **front card**: the blocking question or plan first, then a hire, oldest first.
 *   A multi-question AskUserQuestion is asked one question at a time ("Q1/3").
 * - Options match only on the **whole message**: a number list `^\d+(\s*,\s*\d+)*$`, or an exact
 *   case-insensitive option label.
 * - `approve`, `yes`, `no <note>` and `later` count only as the whole message.
 * - A message ending in "?" to an agent with a pending plan is a question, not a Revise.
 * - Anything else is free text (questions) or Revise (plans).
 * - Out-of-range numbers, and several numbers on a single-select question, are rejected inline.
 *
 * Only the router decides whether a message may resolve a card at all (exactly one addressed agent);
 * this module interprets text against a given card and is pure.
 */

export interface QuestionOption {
  readonly label: string;
  readonly description?: string | undefined;
}

/** One AskUserQuestion question. */
export interface CardQuestion {
  readonly question: string;
  readonly header?: string | undefined;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
}

interface CardBase {
  readonly id: string;
  readonly agentId: string;
  /** Creation time (epoch ms); older cards come first. */
  readonly createdAt: number;
}

/** AskUserQuestion card. `answers` holds the values given so far, in question order. */
export interface QuestionCard extends CardBase {
  readonly kind: 'question';
  readonly questions: readonly CardQuestion[];
  readonly answers: readonly string[];
}

/** ExitPlanMode card. */
export interface PlanCard extends CardBase {
  readonly kind: 'plan';
  readonly plan: string;
}

/** CEO hire request card. */
export interface HireCard extends CardBase {
  readonly kind: 'hire';
  readonly role: string;
  readonly name: string;
}

export type PendingCard = QuestionCard | PlanCard | HireCard;

/** The whole-message number list, e.g. "2" or "1, 3". */
export const NUMBER_LIST_RE = /^\d+(\s*,\s*\d+)*$/;

const BLOCKING: ReadonlySet<PendingCard['kind']> = new Set(['question', 'plan']);

/** The card a message to this agent answers: blocking (question/plan) before hire, then oldest first. */
export function frontCard(cards: readonly PendingCard[]): PendingCard | null {
  let best: PendingCard | null = null;
  for (const card of cards) {
    if (card.kind === 'question' && card.answers.length >= card.questions.length) continue; // already complete
    if (best === null) {
      best = card;
      continue;
    }
    const cardBlocking = BLOCKING.has(card.kind);
    const bestBlocking = BLOCKING.has(best.kind);
    if (cardBlocking !== bestBlocking) {
      if (cardBlocking) best = card;
      continue;
    }
    if (card.createdAt < best.createdAt) best = card;
  }
  return best;
}

/** Position within a multi-question card, for the bubble ("Q1/3") and the echo ("Q1"). */
export function questionProgress(card: QuestionCard): { index: number; total: number; label: string } {
  const total = card.questions.length;
  const index = Math.min(card.answers.length, Math.max(total - 1, 0));
  return { index, total, label: `Q${index + 1}/${total}` };
}

export type InvalidAnswerCode = 'out_of_range' | 'single_select' | 'no_question';

export type Interpretation =
  | {
      readonly kind: 'question.answer';
      readonly cardId: string;
      readonly questionIndex: number;
      readonly questionCount: number;
      /** The AskUserQuestion answer value: labels joined with ", ", or the free text. */
      readonly value: string;
      /** 1-based option numbers when picked by number; null for a label or free text. */
      readonly picks: readonly number[] | null;
      /** Picked option labels (empty for free text). */
      readonly labels: readonly string[];
      readonly freeText: boolean;
      /** True when this was the last unanswered question. */
      readonly done: boolean;
      /** `updatedInput.answers` for the SDK, present when `done`. */
      readonly answers: Readonly<Record<string, string>> | null;
    }
  | { readonly kind: 'plan.approve'; readonly cardId: string }
  | { readonly kind: 'plan.revise'; readonly cardId: string; readonly feedback: string }
  | { readonly kind: 'hire.approve'; readonly cardId: string }
  | { readonly kind: 'hire.decline'; readonly cardId: string; readonly note: string | null }
  | { readonly kind: 'later'; readonly cardId: string }
  /** Not an answer: delivered as an ordinary message; the card stays pending. */
  | { readonly kind: 'message'; readonly cardId: string; readonly note: string }
  /** Rejected inline; nothing is sent. */
  | {
      readonly kind: 'invalid';
      readonly cardId: string;
      readonly code: InvalidAnswerCode;
      readonly hint: string;
    };

/** Lowercased, trimmed, trailing `.`/`!` removed: how whole-message keywords are compared. */
export function normalizeKeyword(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim();
}

function isApprove(text: string): boolean {
  const k = normalizeKeyword(text);
  return k === 'approve' || k === 'yes';
}

function isLater(text: string): boolean {
  return normalizeKeyword(text) === 'later';
}

/** `no` or `no <note>` as the whole message (`no, use tabs`, `No - too risky`). Returns null otherwise. */
export function matchNo(text: string): { note: string | null } | null {
  const m = /^no(?:$|[\s,.;:!-]+([\s\S]*)$)/i.exec(text.trim());
  if (!m) return null;
  const note = (m[1] ?? '').trim();
  return { note: note.length > 0 ? note : null };
}

/** Parses a whole-message number list into distinct numbers in ascending order, or null if it isn't one. */
export function parseNumberList(text: string): number[] | null {
  const t = text.trim();
  if (!NUMBER_LIST_RE.test(t)) return null;
  const nums = t.split(',').map((part) => Number.parseInt(part.trim(), 10));
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** `updatedInput.answers` for AskUserQuestion: question text -> answer value. */
export function buildAnswers(
  questions: readonly CardQuestion[],
  values: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const v = values[i];
    if (v !== undefined) out[q.question] = v;
  });
  return out;
}

function optionRange(q: CardQuestion): string {
  return q.options.length === 1 ? '1' : `1-${q.options.length}`;
}

function interpretQuestion(card: QuestionCard, text: string): Interpretation {
  const index = card.answers.length;
  const q = card.questions[index];
  if (q === undefined) {
    return {
      kind: 'invalid',
      cardId: card.id,
      code: 'no_question',
      hint: 'That question was already answered',
    };
  }
  const qLabel = `Q${index + 1}`;
  const finish = (
    value: string,
    picks: number[] | null,
    labels: string[],
    freeText: boolean,
  ): Interpretation => {
    const done = index + 1 >= card.questions.length;
    return {
      kind: 'question.answer',
      cardId: card.id,
      questionIndex: index,
      questionCount: card.questions.length,
      value,
      picks,
      labels,
      freeText,
      done,
      answers: done ? buildAnswers(card.questions, [...card.answers, value]) : null,
    };
  };

  const numbers = parseNumberList(text);
  if (numbers !== null) {
    const bad = numbers.filter((n) => n < 1 || n > q.options.length);
    if (bad.length > 0) {
      return {
        kind: 'invalid',
        cardId: card.id,
        code: 'out_of_range',
        hint: `${qLabel} has options ${optionRange(q)}; ${bad.join(', ')} is not one of them`,
      };
    }
    if (!q.multiSelect && numbers.length > 1) {
      return {
        kind: 'invalid',
        cardId: card.id,
        code: 'single_select',
        hint: `${qLabel} takes one answer: pick a single number (${optionRange(q)})`,
      };
    }
    const labels = numbers.map((n) => q.options[n - 1]?.label ?? String(n));
    return finish(labels.join(', '), numbers, labels, false);
  }

  const wanted = text.trim().toLowerCase();
  const byLabel = q.options.findIndex((o) => o.label.trim().toLowerCase() === wanted);
  if (byLabel !== -1) {
    const label = q.options[byLabel]?.label ?? text.trim();
    return finish(label, null, [label], false);
  }

  if (isLater(text)) return { kind: 'later', cardId: card.id };
  return finish(text.trim(), null, [], true);
}

function interpretPlan(card: PlanCard, text: string, handle: string): Interpretation {
  if (isApprove(text)) return { kind: 'plan.approve', cardId: card.id };
  if (isLater(text)) return { kind: 'later', cardId: card.id };
  const no = matchNo(text);
  if (no) return { kind: 'plan.revise', cardId: card.id, feedback: no.note ?? 'No.' };
  if (text.trim().endsWith('?')) {
    return {
      kind: 'message',
      cardId: card.id,
      note: `(question; the plan is still waiting: @${handle} approve, or reply with changes)`,
    };
  }
  return { kind: 'plan.revise', cardId: card.id, feedback: text.trim() };
}

function interpretHire(card: HireCard, text: string, handle: string): Interpretation {
  if (isApprove(text)) return { kind: 'hire.approve', cardId: card.id };
  if (isLater(text)) return { kind: 'later', cardId: card.id };
  const no = matchNo(text);
  if (no) return { kind: 'hire.decline', cardId: card.id, note: no.note };
  return {
    kind: 'message',
    cardId: card.id,
    note: `(not an answer; the hire is still waiting: @${handle} yes, or @${handle} no <note>)`,
  };
}

/**
 * Interprets `text` (the message body, mentions already stripped) as an answer to `card`.
 * `handle` is the agent's handle, used in hints.
 */
export function interpretAnswer(card: PendingCard, text: string, handle: string): Interpretation {
  switch (card.kind) {
    case 'question':
      return interpretQuestion(card, text);
    case 'plan':
      return interpretPlan(card, text, handle);
    case 'hire':
      return interpretHire(card, text, handle);
  }
}

/** Returns the question card with the answer recorded (the card advances to its next question). */
export function applyQuestionAnswer(card: QuestionCard, value: string): QuestionCard {
  return { ...card, answers: [...card.answers, value] };
}

const ECHO_TEXT_MAX = 120;

/** Shortens long user text for echo lines. */
export function clip(text: string, max = ECHO_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The echo line shown in the chat log, describing how the message was read,
 * e.g. "You → Ada: Q1 = 2 (Spruce)".
 */
export function formatAnswerEcho(
  agentName: string,
  card: PendingCard,
  interp: Interpretation,
  text: string,
): string {
  const head = `You → ${agentName}:`;
  switch (interp.kind) {
    case 'question.answer': {
      const q = `Q${interp.questionIndex + 1}`;
      if (interp.picks !== null)
        return `${head} ${q} = ${interp.picks.join(',')} (${interp.labels.join(', ')})`;
      if (!interp.freeText) return `${head} ${q} = ${interp.value}`;
      return `${head} ${q} = "${clip(interp.value)}"`;
    }
    case 'plan.approve':
      return `${head} plan approved`;
    case 'plan.revise':
      return `${head} revise plan: "${clip(interp.feedback)}"`;
    case 'hire.approve':
      return card.kind === 'hire'
        ? `${head} hire approved: ${card.name} (${card.role})`
        : `${head} hire approved`;
    case 'hire.decline':
      return interp.note ? `${head} hire declined: "${clip(interp.note)}"` : `${head} hire declined`;
    case 'later':
      return `${head} later (card parked; answer any time with G)`;
    case 'message':
      return `${head} ${clip(text)} ${interp.note}`;
    case 'invalid':
      return interp.hint;
  }
}
