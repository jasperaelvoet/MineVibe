import type { PendingCard } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import { ChatRouter, type RouteOk } from '../../src/agents/chat/ChatRouter.js';
import type { AgentSummary } from '../../src/contracts/CrewApi.js';
import { chatContextFrom, findCard, toCrewCardAnswer, toGrammarCard } from '../../src/ui/chatGlue.js';

function summary(agentId: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId,
    handle: agentId,
    name: agentId.charAt(0).toUpperCase() + agentId.slice(1),
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
    ...extra,
  };
}

const base = { agentId: 'ada', createdAt: 5, parked: false, presenting: false };
const wood: PendingCard = {
  ...base,
  kind: 'question',
  id: 'q-1',
  questions: [
    {
      question: 'Which wood?',
      options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
      multiSelect: false,
    },
    { question: 'Extras?', options: [{ label: 'Torches' }, { label: 'Beds' }], multiSelect: true },
  ],
  answers: [],
};
const plan: PendingCard = { ...base, kind: 'plan', id: 'p-1', plan: '1. do it' };
const hire: PendingCard = {
  ...base,
  kind: 'hire',
  id: 'h-1',
  createdAt: 1,
  role: 'miner',
  name: 'Dana',
  handle: 'dana',
  reason: 'iron',
  firstTask: 'mine',
};
const calendar: PendingCard = { ...base, kind: 'calendar', id: 'c-1', eventId: 'ev-1', summary: 'Standup' };

const router = new ChatRouter();
function route(text: string, cards: PendingCard[]): RouteOk {
  const ctx = chatContextFrom({
    playerName: 'Jordan',
    agents: [summary('ada', { ceo: true }), summary('bram', { seatedPc: 'linux-1' })],
    cards: new Map([['ada', cards]]),
  });
  const result = router.route({ to: 'all', text }, ctx);
  if (!result.ok) throw new Error(result.error.hint);
  return result;
}

describe('chat glue', () => {
  it('maps protocol cards to grammar cards and drops calendar approvals', () => {
    expect(toGrammarCard(plan)).toEqual({
      kind: 'plan',
      id: 'p-1',
      agentId: 'ada',
      createdAt: 5,
      plan: '1. do it',
    });
    expect(toGrammarCard(hire)).toEqual({
      kind: 'hire',
      id: 'h-1',
      agentId: 'ada',
      createdAt: 1,
      role: 'miner',
      name: 'Dana',
    });
    expect(toGrammarCard(calendar)).toBeNull();
    const ctx = chatContextFrom({
      playerName: 'Jordan',
      agents: [summary('ada'), summary('bram', { seatedPc: 'linux-1', status: 'dead' })],
      cards: new Map([
        ['ada', [calendar]],
        ['bram', [plan]],
      ]),
    });
    expect(ctx.cards.has('ada')).toBe(false);
    expect(ctx.cards.get('bram')).toHaveLength(1);
    expect(ctx.crew.map((a) => [a.handle, a.seated, a.status])).toEqual([
      ['ada', false, 'alive'],
      ['bram', true, 'dead'],
    ]);
    expect(ctx.meeting).toBeNull();
  });

  it('turns typed numbers, labels and free text into contract answers', () => {
    const byNumber = route('@ada 2', [wood]).answer;
    expect(byNumber && toCrewCardAnswer(byNumber, wood)).toEqual({ kind: 'options', picks: [2] });
    const byLabel = route('@ada spruce', [wood]).answer;
    expect(byLabel && toCrewCardAnswer(byLabel, wood)).toEqual({ kind: 'options', picks: [2] });
    const free = route('@ada whatever is cheapest', [wood]).answer;
    expect(free && toCrewCardAnswer(free, wood)).toEqual({ kind: 'text', text: 'whatever is cheapest' });
    const second = { ...wood, answers: ['Oak'] } as PendingCard;
    const multi = route('@ada 1, 2', [second]).answer;
    expect(multi && toCrewCardAnswer(multi, second)).toEqual({ kind: 'options', picks: [1, 2] });
    const later = route('@ada later', [wood]).answer;
    expect(later && toCrewCardAnswer(later, wood)).toEqual({ kind: 'later' });
  });

  it('turns plan and hire decisions into contract answers', () => {
    const approve = route('@ada approve', [plan]).answer;
    expect(approve && toCrewCardAnswer(approve, plan)).toEqual({ kind: 'approve' });
    const revise = route('@ada use tabs instead', [plan]).answer;
    expect(revise && toCrewCardAnswer(revise, plan)).toEqual({
      kind: 'revise',
      feedback: 'use tabs instead',
    });
    const yes = route('@ada yes', [hire]).answer;
    expect(yes && toCrewCardAnswer(yes, hire)).toEqual({ kind: 'approve' });
    const no = route('@ada no, too early', [hire]).answer;
    expect(no && toCrewCardAnswer(no, hire)).toEqual({ kind: 'decline', note: 'too early' });
    const bare = route('@ada no', [hire]).answer;
    expect(bare && toCrewCardAnswer(bare, hire)).toEqual({ kind: 'decline' });
  });

  it('reports a label answer whose card changed as gone', () => {
    const byLabel = route('@ada spruce', [wood]).answer;
    expect(byLabel).not.toBeNull();
    if (!byLabel) return;
    expect(toCrewCardAnswer(byLabel, undefined)).toBeNull();
    expect(toCrewCardAnswer(byLabel, plan)).toBeNull();
    const renamed = {
      ...wood,
      questions: [
        { ...(wood.kind === 'question' ? wood.questions[0] : undefined), options: [{ label: 'Pine' }] },
      ],
    } as PendingCard;
    expect(toCrewCardAnswer(byLabel, renamed)).toBeNull();
  });

  it('finds cards across agents', () => {
    const cards = new Map([
      ['ada', [wood]],
      ['bram', [plan]],
    ]);
    expect(findCard(cards, 'p-1')).toBe(plan);
    expect(findCard(cards, 'nope')).toBeUndefined();
  });
});
