import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { interpretWireAnswer } from '../../../src/agents/cardAnswers.js';
import { createInteractionBroker, MISSING_PLAN_TEXT } from '../../../src/agents/InteractionBroker.js';
import { type Card, type CardOutcome, PendingStore } from '../../../src/agents/PendingStore.js';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS = [
  {
    question: 'Which wood?',
    header: 'Wood',
    options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
    multiSelect: true,
  },
  { question: 'Where?', options: [{ label: 'Here' }, { label: 'There' }], multiSelect: false },
];

function setup(options: { seated?: boolean } = {}) {
  const store = new PendingStore();
  const plans = new PlanCapture(['/Users/jasper']);
  const events: string[] = [];
  let mode: PermissionMode = 'default';
  const broker = createInteractionBroker({
    agentId: 'ada-1',
    store,
    plans,
    canEnterPlan: () => options.seated ?? true,
    seatEpoch: () => 3,
    playerName: () => 'Jasper',
    now: () => 1000,
    hooks: {
      onWaitStart: (card) => events.push(`wait:${card.kind}`),
      onWaitEnd: async (card, outcome) => {
        events.push(`resume:${card.kind}:${outcome.kind}`);
      },
      setPermissionMode: async (m) => {
        mode = m;
        events.push(`mode:${m}`);
      },
      trackMode: (m) => {
        mode = m;
        events.push(`track:${m}`);
      },
    },
  });
  const call = (tool: string, input: Record<string, unknown>, signal = new AbortController().signal) =>
    broker(tool, input, { signal, toolUseID: 't1', requestId: 'r1' });
  return { store, plans, events, call, mode: () => mode };
}

const next = () => new Promise((r) => setImmediate(r));

describe('InteractionBroker (canUseTool)', () => {
  it('AskUserQuestion: raises a card, releases the slot, and answers with {questions, answers}', async () => {
    const { store, events, call } = setup();
    const pending = call('AskUserQuestion', { questions: QUESTIONS });
    await next();
    const [card] = store.list('ada-1');
    expect(card).toMatchObject({ kind: 'question', agentId: 'ada-1', answers: [], parked: false });
    expect(events).toEqual(['wait:question']);
    store.resolve(card?.id ?? '', {
      kind: 'answered',
      answers: { 'Which wood?': 'Oak, Spruce', 'Where?': 'Here' },
    });
    const res = await pending;
    expect(res).toEqual({
      behavior: 'allow',
      updatedInput: { questions: QUESTIONS, answers: { 'Which wood?': 'Oak, Spruce', 'Where?': 'Here' } },
    });
    expect(events).toEqual(['wait:question', 'resume:question:answered']);
    expect(store.list('ada-1')).toEqual([]);
  });

  it('AskUserQuestion: malformed input and cleanup become denies', async () => {
    const { store, call } = setup();
    expect(await call('AskUserQuestion', { questions: [] })).toMatchObject({ behavior: 'deny' });
    const pending = call('AskUserQuestion', { questions: QUESTIONS });
    await next();
    expect(store.cleanup('ada-1', 'Jasper kicked you.')).toBe(1);
    expect(await pending).toEqual({ behavior: 'deny', message: 'Jasper kicked you.' });
  });

  it('AskUserQuestion: an aborted turn withdraws the card', async () => {
    const { store, call } = setup();
    const ac = new AbortController();
    const pending = call('AskUserQuestion', { questions: QUESTIONS }, ac.signal);
    await next();
    expect(store.list('ada-1')).toHaveLength(1);
    ac.abort();
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect(store.list('ada-1')).toEqual([]);
  });

  it('ExitPlanMode: the captured plan becomes the card; approve → allow + default mode', async () => {
    const { store, plans, events, call, mode } = setup();
    plans.write('/Users/jasper/.claude/plans/fix.md', '# Plan\n- run the tests\n- fix the parser');
    const pending = call('ExitPlanMode', {});
    await next();
    const [card] = store.list('ada-1');
    expect(card).toMatchObject({ kind: 'plan', plan: '# Plan\n- run the tests\n- fix the parser' });
    expect(store.epochOf(card?.id ?? '')).toBe(3);
    store.resolve(card?.id ?? '', { kind: 'approved' });
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(mode()).toBe('default');
    expect(events).toEqual(['wait:plan', 'resume:plan:approved', 'mode:default']);
    expect(plans.latest()).toBeNull();
  });

  it('ExitPlanMode: revise → deny with the feedback; no captured plan shows a placeholder', async () => {
    const { store, call } = setup();
    const pending = call('ExitPlanMode', {});
    await next();
    const [card] = store.list('ada-1');
    expect(card).toMatchObject({ kind: 'plan', plan: MISSING_PLAN_TEXT });
    store.resolve(card?.id ?? '', { kind: 'revise', feedback: 'use tabs' });
    const res = await pending;
    expect(res).toMatchObject({ behavior: 'deny' });
    expect(res?.behavior === 'deny' ? res.message : '').toMatch(/Jasper wants changes to the plan: use tabs/);
  });

  it('EnterPlanMode: only while seated; anything else is denied', async () => {
    const seated = setup({ seated: true });
    expect(await seated.call('EnterPlanMode', {})).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(seated.mode()).toBe('plan');
    const wandering = setup({ seated: false });
    expect(await wandering.call('EnterPlanMode', {})).toMatchObject({ behavior: 'deny' });
    for (const tool of ['Bash', 'mcp__pc__bash', 'mcp__mc__status', 'WebFetch']) {
      expect(await wandering.call(tool, {}), tool).toMatchObject({ behavior: 'deny' });
    }
  });
});

describe('PendingStore', () => {
  function question(id: string, createdAt: number): Card {
    return {
      id,
      agentId: 'ada-1',
      createdAt,
      parked: false,
      presenting: false,
      kind: 'question',
      questions: QUESTIONS,
      answers: [],
    };
  }

  it('persists per agent and reloads question/plan cards as stale (restart re-ask)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-pending-'));
    tmp.push(dir);
    const fileOf = (agentId: string) => join(dir, agentId, 'pending.json');
    const a = new PendingStore({ fileOf });
    const outcomes: CardOutcome[] = [];
    a.add(question('q1', 2), { waiter: (o) => outcomes.push(o) });
    a.add({
      id: 'h1',
      agentId: 'ada-1',
      createdAt: 1,
      parked: false,
      presenting: false,
      kind: 'hire',
      role: 'miner',
      name: 'Bram',
      handle: 'bram',
      reason: 'iron',
      firstTask: 'mine',
    });
    a.update('q1', { answers: ['Oak'] } as Partial<Card>);
    await a.flush();
    const saved = JSON.parse(readFileSync(fileOf('ada-1'), 'utf8'));
    expect(saved.cards.map((c: Card) => c.id)).toEqual(['h1', 'q1']);
    const b = new PendingStore({ fileOf });
    const loaded = await b.load('ada-1');
    expect(loaded.map((c) => c.id)).toEqual(['h1', 'q1']);
    expect(b.isStale('q1')).toBe(true);
    expect(b.isStale('h1')).toBe(false);
    expect((b.get('q1') as Extract<Card, { kind: 'question' }>).answers).toEqual(['Oak']);
    expect(a.resolve('q1', { kind: 'answered', answers: {} })).toBe(true);
    expect(a.resolve('q1', { kind: 'answered', answers: {} })).toBe(false);
    expect(outcomes).toHaveLength(1);
  });

  it('cleans up blocking cards, moves hire cards and emits changes', () => {
    const s = new PendingStore();
    const changes: string[] = [];
    s.on('changed', (agentId, cards) => {
      changes.push(`${agentId}:${cards.length}`);
    });
    s.add(question('q1', 1));
    s.add({
      id: 'p1',
      agentId: 'ada-1',
      createdAt: 2,
      parked: false,
      presenting: false,
      kind: 'plan',
      plan: 'x',
    });
    s.add({
      id: 'h1',
      agentId: 'ada-1',
      createdAt: 3,
      parked: false,
      presenting: false,
      kind: 'hire',
      role: 'miner',
      name: 'B',
      handle: 'bram',
      reason: '',
      firstTask: '',
    });
    expect(s.cleanup('ada-1', 'kicked', (c) => c.kind === 'plan')).toBe(1);
    expect(s.cleanup('ada-1', 'died')).toBe(1);
    s.move('h1', 'bram-2');
    expect(s.list('bram-2').map((c) => c.id)).toEqual(['h1']);
    expect(changes.at(-1)).toBe('bram-2:1');
  });
});

describe('wire card answers', () => {
  const q: Card = {
    id: 'q1',
    agentId: 'a',
    createdAt: 1,
    parked: false,
    presenting: false,
    kind: 'question',
    questions: QUESTIONS,
    answers: [],
  };

  it('maps picks and text onto question answers with validation', () => {
    expect(interpretWireAnswer(q, { kind: 'options', picks: [3, 1] }, 'ada')).toMatchObject({
      kind: 'question.answer',
      value: 'Oak, Birch',
      done: false,
    });
    expect(interpretWireAnswer(q, { kind: 'options', picks: [4] }, 'ada')).toMatchObject({
      kind: 'invalid',
      code: 'out_of_range',
    });
    const second = { ...q, answers: ['Oak'] } as Card;
    expect(interpretWireAnswer(second, { kind: 'options', picks: [1, 2] }, 'ada')).toMatchObject({
      kind: 'invalid',
      code: 'single_select',
    });
    expect(interpretWireAnswer(second, { kind: 'text', text: 'by the lake' }, 'ada')).toMatchObject({
      kind: 'question.answer',
      done: true,
      answers: { 'Which wood?': 'Oak', 'Where?': 'by the lake' },
    });
    expect(interpretWireAnswer(q, { kind: 'later' }, 'ada')).toMatchObject({ kind: 'later' });
    expect(interpretWireAnswer(q, { kind: 'approve' }, 'ada')).toMatchObject({ kind: 'invalid' });
  });

  it('maps plan, hire and calendar decisions', () => {
    const plan: Card = {
      id: 'p1',
      agentId: 'a',
      createdAt: 1,
      parked: false,
      presenting: false,
      kind: 'plan',
      plan: 'x',
    };
    expect(interpretWireAnswer(plan, { kind: 'approve' }, 'ada')).toMatchObject({ kind: 'plan.approve' });
    expect(interpretWireAnswer(plan, { kind: 'revise', feedback: 'tabs' }, 'ada')).toMatchObject({
      kind: 'plan.revise',
      feedback: 'tabs',
    });
    expect(interpretWireAnswer(plan, { kind: 'text', text: 'approve' }, 'ada')).toMatchObject({
      kind: 'plan.approve',
    });
    const hire: Card = {
      id: 'h1',
      agentId: 'a',
      createdAt: 1,
      parked: false,
      presenting: false,
      kind: 'hire',
      role: 'miner',
      name: 'B',
      handle: 'bram',
      reason: '',
      firstTask: '',
    };
    expect(interpretWireAnswer(hire, { kind: 'decline', note: 'later' }, 'ceo')).toMatchObject({
      kind: 'hire.decline',
      note: 'later',
    });
    expect(interpretWireAnswer(hire, { kind: 'text', text: 'yes' }, 'ceo')).toMatchObject({
      kind: 'hire.approve',
    });
    const cal: Card = {
      id: 'k1',
      agentId: 'a',
      createdAt: 1,
      parked: false,
      presenting: false,
      kind: 'calendar',
      eventId: 'e1',
      summary: 'Daily standup',
    };
    expect(interpretWireAnswer(cal, { kind: 'approve' }, 'ada')).toMatchObject({ kind: 'calendar.approve' });
    expect(interpretWireAnswer(cal, { kind: 'options', picks: [1] }, 'ada')).toMatchObject({
      kind: 'invalid',
    });
  });
});
