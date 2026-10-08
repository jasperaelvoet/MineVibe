import { describe, expect, it } from 'vitest';
import {
  applyQuestionAnswer,
  buildAnswers,
  type CardQuestion,
  clip,
  formatAnswerEcho,
  frontCard,
  type HireCard,
  interpretAnswer,
  matchNo,
  normalizeKeyword,
  type PendingCard,
  type PlanCard,
  parseNumberList,
  type QuestionCard,
  questionProgress,
} from '../../src/agents/chat/answerGrammar.js';

const wood: CardQuestion = {
  question: 'Which wood?',
  header: 'Wood',
  options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
  multiSelect: false,
};
const extras: CardQuestion = {
  question: 'Which extras?',
  options: [{ label: 'Oak' }, { label: 'Torches' }, { label: 'Birch' }, { label: 'Later' }],
  multiSelect: true,
};

function question(questions: CardQuestion[], extra: Partial<QuestionCard> = {}): QuestionCard {
  return { kind: 'question', id: 'q-1', agentId: 'ada', createdAt: 100, questions, answers: [], ...extra };
}
const plan: PlanCard = {
  kind: 'plan',
  id: 'p-1',
  agentId: 'ada',
  createdAt: 200,
  plan: '1. Fix test\n2. Run it',
};
const hire: HireCard = {
  kind: 'hire',
  id: 'h-1',
  agentId: 'ada',
  createdAt: 50,
  role: 'miner',
  name: 'Bram',
};

describe('helpers', () => {
  it('parseNumberList accepts only whole-message number lists', () => {
    expect(parseNumberList('2')).toEqual([2]);
    expect(parseNumberList(' 1, 3 ')).toEqual([1, 3]);
    expect(parseNumberList('3,1,3')).toEqual([1, 3]);
    expect(parseNumberList('1 ,2,  3')).toEqual([1, 2, 3]);
    for (const s of ['2 stacks please', '1 3', '1,', ',1', '1,,2', 'one', '', '-1', '1.5', '2!']) {
      expect(parseNumberList(s), s).toBeNull();
    }
  });

  it('normalizeKeyword', () => {
    expect(normalizeKeyword('  Approve! ')).toBe('approve');
    expect(normalizeKeyword('YES.')).toBe('yes');
    expect(normalizeKeyword('yes?')).toBe('yes?');
  });

  it('matchNo', () => {
    expect(matchNo('no')).toEqual({ note: null });
    expect(matchNo('No.')).toEqual({ note: null });
    expect(matchNo('no too risky')).toEqual({ note: 'too risky' });
    expect(matchNo('NO, use tabs')).toEqual({ note: 'use tabs' });
    expect(matchNo('no - later maybe')).toEqual({ note: 'later maybe' });
    expect(matchNo('nope')).toBeNull();
    expect(matchNo('not now')).toBeNull();
    expect(matchNo('nothing')).toBeNull();
    expect(matchNo('I said no')).toBeNull();
  });

  it('buildAnswers maps question text to value', () => {
    expect(buildAnswers([wood, extras], ['Oak', 'Torches, Birch'])).toEqual({
      'Which wood?': 'Oak',
      'Which extras?': 'Torches, Birch',
    });
  });

  it('clip shortens and flattens', () => {
    expect(clip('a\n b')).toBe('a b');
    expect(clip('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

describe('frontCard', () => {
  it('is null without cards', () => {
    expect(frontCard([])).toBeNull();
  });

  it('prefers a blocking question or plan over an older hire', () => {
    expect(frontCard([hire, plan])?.id).toBe('p-1');
    expect(frontCard([hire, question([wood])])?.id).toBe('q-1');
  });

  it('takes the oldest among blocking cards', () => {
    const q = question([wood], { createdAt: 300 });
    expect(frontCard([q, plan])?.id).toBe('p-1');
    expect(frontCard([plan, question([wood], { createdAt: 10, id: 'q-old' })])?.id).toBe('q-old');
  });

  it('falls back to the oldest hire', () => {
    const newer: HireCard = { ...hire, id: 'h-2', createdAt: 60 };
    expect(frontCard([newer, hire])?.id).toBe('h-1');
  });

  it('skips completed question cards', () => {
    expect(frontCard([question([wood], { answers: ['Oak'] }), hire])?.id).toBe('h-1');
  });
});

describe('question cards', () => {
  it('a single number picks that option', () => {
    const r = interpretAnswer(question([wood]), '2', 'ada');
    expect(r).toMatchObject({
      kind: 'question.answer',
      value: 'Spruce',
      picks: [2],
      labels: ['Spruce'],
      freeText: false,
      done: true,
      answers: { 'Which wood?': 'Spruce' },
    });
  });

  it('an exact label matches case-insensitively', () => {
    expect(interpretAnswer(question([wood]), 'oak', 'ada')).toMatchObject({ value: 'Oak', picks: null });
    expect(interpretAnswer(question([wood]), '  SPRUCE ', 'ada')).toMatchObject({ value: 'Spruce' });
  });

  it('partial labels are free text, not options', () => {
    const r = interpretAnswer(question([wood]), 'oak and birch', 'ada');
    expect(r).toMatchObject({ kind: 'question.answer', freeText: true, value: 'oak and birch', labels: [] });
    expect(interpretAnswer(question([wood]), '2 stacks please', 'ada')).toMatchObject({ freeText: true });
  });

  it('multi-select joins labels with ", " in option order', () => {
    const r = interpretAnswer(question([extras]), '3, 1', 'ada');
    expect(r).toMatchObject({ value: 'Oak, Birch', picks: [1, 3], done: true });
  });

  it('rejects several numbers on a single-select question', () => {
    expect(interpretAnswer(question([wood]), '1,3', 'ada')).toMatchObject({
      kind: 'invalid',
      code: 'single_select',
      hint: expect.stringContaining('Q1 takes one answer'),
    });
  });

  it('rejects out-of-range numbers', () => {
    expect(interpretAnswer(question([wood]), '4', 'ada')).toMatchObject({
      kind: 'invalid',
      code: 'out_of_range',
      hint: 'Q1 has options 1-3; 4 is not one of them',
    });
    expect(interpretAnswer(question([wood]), '0', 'ada')).toMatchObject({ code: 'out_of_range' });
    expect(interpretAnswer(question([extras]), '1,9', 'ada')).toMatchObject({ code: 'out_of_range' });
  });

  it('duplicate numbers collapse', () => {
    expect(interpretAnswer(question([wood]), '2,2', 'ada')).toMatchObject({
      kind: 'question.answer',
      picks: [2],
    });
  });

  it('"later" parks the card unless it is an option label', () => {
    expect(interpretAnswer(question([wood]), 'later', 'ada')).toEqual({ kind: 'later', cardId: 'q-1' });
    expect(interpretAnswer(question([extras]), 'later', 'ada')).toMatchObject({
      kind: 'question.answer',
      value: 'Later',
    });
  });

  it('a question mark is just free text on a question card', () => {
    expect(interpretAnswer(question([wood]), 'which is cheaper?', 'ada')).toMatchObject({
      kind: 'question.answer',
      freeText: true,
    });
  });

  it('multi-question cards are answered one question at a time', () => {
    let card = question([wood, extras]);
    expect(questionProgress(card)).toEqual({ index: 0, total: 2, label: 'Q1/2' });
    const first = interpretAnswer(card, '1', 'ada');
    expect(first).toMatchObject({ questionIndex: 0, questionCount: 2, done: false, answers: null });
    if (first.kind !== 'question.answer') throw new Error('expected an answer');
    card = applyQuestionAnswer(card, first.value);
    expect(questionProgress(card).label).toBe('Q2/2');
    const second = interpretAnswer(card, '2,3', 'ada');
    expect(second).toMatchObject({
      questionIndex: 1,
      done: true,
      answers: { 'Which wood?': 'Oak', 'Which extras?': 'Torches, Birch' },
    });
  });

  it('a fully answered card yields no_question', () => {
    expect(interpretAnswer(question([wood], { answers: ['Oak'] }), '1', 'ada')).toMatchObject({
      kind: 'invalid',
      code: 'no_question',
    });
  });
});

describe('plan cards', () => {
  it.each(['approve', 'Approve!', 'yes', 'YES.'])('%j approves', (text) => {
    expect(interpretAnswer(plan, text, 'ada')).toEqual({ kind: 'plan.approve', cardId: 'p-1' });
  });

  it('approve only counts as the whole message', () => {
    expect(interpretAnswer(plan, 'approve but use tabs', 'ada')).toEqual({
      kind: 'plan.revise',
      cardId: 'p-1',
      feedback: 'approve but use tabs',
    });
  });

  it('a message ending in "?" is a question, not a Revise', () => {
    const r = interpretAnswer(plan, 'why step 2?', 'ada');
    expect(r).toMatchObject({ kind: 'message', note: expect.stringContaining('@ada approve') });
    expect(interpretAnswer(plan, 'why step 2?  ', 'ada').kind).toBe('message');
  });

  it('"no <note>" revises with the note', () => {
    expect(interpretAnswer(plan, 'no, keep the old API', 'ada')).toEqual({
      kind: 'plan.revise',
      cardId: 'p-1',
      feedback: 'keep the old API',
    });
    expect(interpretAnswer(plan, 'no', 'ada')).toMatchObject({ kind: 'plan.revise', feedback: 'No.' });
  });

  it('other text is a Revise', () => {
    expect(interpretAnswer(plan, 'Skip step 2.', 'ada')).toMatchObject({
      kind: 'plan.revise',
      feedback: 'Skip step 2.',
    });
  });

  it('later parks', () => {
    expect(interpretAnswer(plan, 'Later.', 'ada')).toEqual({ kind: 'later', cardId: 'p-1' });
  });

  it('numbers are not special on a plan', () => {
    expect(interpretAnswer(plan, '2', 'ada')).toMatchObject({ kind: 'plan.revise', feedback: '2' });
  });
});

describe('hire cards', () => {
  it('yes / approve hires', () => {
    expect(interpretAnswer(hire, 'yes', 'ceo').kind).toBe('hire.approve');
    expect(interpretAnswer(hire, 'approve', 'ceo').kind).toBe('hire.approve');
  });

  it('no <note> declines with the note', () => {
    expect(interpretAnswer(hire, 'no we have enough miners', 'ceo')).toEqual({
      kind: 'hire.decline',
      cardId: 'h-1',
      note: 'we have enough miners',
    });
    expect(interpretAnswer(hire, 'no', 'ceo')).toEqual({ kind: 'hire.decline', cardId: 'h-1', note: null });
  });

  it('anything else is delivered as a message and the card stays', () => {
    expect(interpretAnswer(hire, 'yes please, call him Bob', 'ceo')).toMatchObject({
      kind: 'message',
      note: expect.stringContaining('@ceo yes'),
    });
    expect(interpretAnswer(hire, 'why?', 'ceo').kind).toBe('message');
  });

  it('later parks', () => {
    expect(interpretAnswer(hire, 'later', 'ceo').kind).toBe('later');
  });
});

describe('formatAnswerEcho', () => {
  const echo = (card: PendingCard, text: string) =>
    formatAnswerEcho('Ada', card, interpretAnswer(card, text, 'ada'), text);

  it('numbered pick: "You → Ada: Q1 = 2 (Spruce)"', () => {
    expect(echo(question([wood]), '2')).toBe('You → Ada: Q1 = 2 (Spruce)');
  });

  it('multi pick', () => {
    expect(echo(question([extras]), '1,3')).toBe('You → Ada: Q1 = 1,3 (Oak, Birch)');
  });

  it('label pick', () => {
    expect(echo(question([wood]), 'birch')).toBe('You → Ada: Q1 = Birch');
  });

  it('free text is quoted', () => {
    expect(echo(question([wood]), 'whatever is closest')).toBe('You → Ada: Q1 = "whatever is closest"');
  });

  it('second question numbering', () => {
    expect(echo(question([wood, extras], { answers: ['Oak'] }), '2')).toBe('You → Ada: Q2 = 2 (Torches)');
  });

  it('plans', () => {
    expect(echo(plan, 'approve')).toBe('You → Ada: plan approved');
    expect(echo(plan, 'use tabs')).toBe('You → Ada: revise plan: "use tabs"');
    expect(echo(plan, 'why?')).toMatch(/^You → Ada: why\? \(question; the plan is still waiting/);
  });

  it('hires', () => {
    expect(echo(hire, 'yes')).toBe('You → Ada: hire approved: Bram (miner)');
    expect(echo(hire, 'no not now')).toBe('You → Ada: hire declined: "not now"');
    expect(echo(hire, 'no')).toBe('You → Ada: hire declined');
  });

  it('later', () => {
    expect(echo(plan, 'later')).toBe('You → Ada: later (card parked; answer any time with G)');
  });

  it('invalid returns the hint', () => {
    expect(echo(question([wood]), '9')).toBe('Q1 has options 1-3; 9 is not one of them');
  });
});
