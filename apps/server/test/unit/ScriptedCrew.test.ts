import { ERROR_CODES, type PayloadOf, type PendingCard } from '@minevibe/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BridgeServer } from '../../src/bridge/BridgeServer.js';
import { silentLogger } from '../../src/log.js';
import { BUSY_MS, ScriptedCrew } from '../../src/ui/ScriptedCrew.js';
import { FakeUiBridge } from '../helpers/fakeUiBridge.js';

/** A manual clock and scheduler. */
class ManualTime {
  now = 1_000_000;
  readonly #tasks: Array<{ at: number; fn: () => void }> = [];
  readonly schedule = (fn: () => void, ms: number) => {
    this.#tasks.push({ at: this.now + ms, fn });
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      this.#tasks.sort((a, b) => a.at - b.at);
      const next = this.#tasks[0];
      if (!next || next.at > target) break;
      this.#tasks.shift();
      this.now = next.at;
      next.fn();
    }
    this.now = target;
  }
}

describe('ScriptedCrew', () => {
  let time: ManualTime;
  let bridge: FakeUiBridge;
  let crew: ScriptedCrew;
  let says: PayloadOf<'agent.say'>[];
  let brains: PayloadOf<'agent.brain'>[];
  let summaries: unknown[];

  beforeEach(() => {
    time = new ManualTime();
    bridge = new FakeUiBridge();
    summaries = [];
    crew = new ScriptedCrew({
      logger: silentLogger(),
      now: () => time.now,
      schedule: time.schedule,
      replyDelayMs: 1000,
      bridge: bridge as unknown as Pick<BridgeServer, 'request' | 'on'>,
      onBrains: (s) => summaries.push(s),
    });
    says = [];
    brains = [];
    crew.on('say', (p) => {
      says.push(p);
    });
    crew.on('brain', (p) => {
      brains.push(p);
    });
  });

  function cards(agentId = 'ada'): readonly PendingCard[] {
    return crew.cardsOf(agentId);
  }

  it('starts with Ada (CEO) and Bram (seated engineer on Opus)', () => {
    expect(crew.listAgents().map((a) => [a.handle, a.role, a.ceo, a.model, a.seatedPc])).toEqual([
      ['ada', 'ceo', true, 'haiku', null],
      ['bram', 'engineer', false, 'opus', 'linux-1'],
    ]);
  });

  it('thinks, then replies to a direct line', async () => {
    const result = await crew.deliverChat({ to: 'all', text: '@ada build a house' });
    expect(result).toMatchObject({ echo: 'You → Ada: build a house', scope: 'direct', answeredCard: null });
    expect(result.deliveries).toEqual([
      { agentId: 'ada', mode: 'wake', queued: false, latencyMs: 0, hint: null },
    ]);
    expect(brains.at(-1)).toMatchObject({
      agentId: 'ada',
      status: 'thinking',
      activity: 'Reading: build a house',
    });
    expect(summaries.at(-1)).toMatchObject({ inFlight: 1 });
    time.advance(1000);
    expect(says.at(-1)).toMatchObject({ agentId: 'ada', text: 'On it: build a house' });
    expect(brains.at(-1)).toMatchObject({ status: 'idle', activity: null });
    const history = await crew.chatHistory('ada', { limit: 10 });
    expect(history.entries.map((e) => [e.kind, e.text])).toEqual([
      ['player', 'build a house'],
      ['agent', 'On it: build a house'],
    ]);
  });

  it('routes with the real grammar: a question card answered by number in chat', async () => {
    await crew.deliverChat({ to: 'all', text: '@ada can you ask me something' });
    time.advance(1000);
    const [card] = cards();
    expect(card).toMatchObject({ kind: 'question', presenting: true, parked: false });
    expect(brains.at(-1)).toMatchObject({ status: 'waiting_player' });

    await expect(crew.deliverChat({ to: 'all', text: '@ada 1,2' })).rejects.toMatchObject({
      code: ERROR_CODES.CHAT_INVALID_ANSWER,
    });
    await expect(crew.deliverChat({ to: 'all', text: '@ada 7' })).rejects.toMatchObject({
      code: ERROR_CODES.CHAT_INVALID_ANSWER,
    });
    const answered = await crew.deliverChat({ to: 'all', text: '@ada 2' });
    expect(answered).toMatchObject({
      echo: 'You → Ada: Q1 = 2 (Spruce)',
      answeredCard: card?.id,
      deliveries: [],
    });
    expect(cards()).toEqual([]);
    time.advance(300);
    expect(says.at(-1)).toMatchObject({ text: 'Thanks! Going with Spruce.' });
  });

  it('a broadcast is never an answer, and wakes only wandering agents', async () => {
    await crew.deliverChat({ to: 'all', text: '@ada question please' });
    time.advance(1000);
    const result = await crew.deliverChat({ to: 'all', text: 'good morning' });
    expect(result.scope).toBe('broadcast');
    expect(result.echo).toContain('not an answer');
    expect(result.deliveries.map((d) => [d.agentId, d.mode])).toEqual([
      ['ada', 'wake'],
      ['bram', 'context'],
    ]);
    expect(cards()).toHaveLength(1);
  });

  it('advances a multi-question card from AgentScreen answers', async () => {
    await crew.deliverChat({ to: ['ada'], text: 'multi please' });
    time.advance(1000);
    const [card] = cards();
    if (!card) throw new Error('no card');
    const first = await crew.answerCard(card.id, { kind: 'options', picks: [3] });
    expect(first.echo).toBe('You → Ada: Q1 = 3 (On the hill)');
    expect(cards()[0]).toMatchObject({ id: card.id, answers: ['On the hill'] });
    await expect(crew.answerCard(card.id, { kind: 'options', picks: [9] })).rejects.toMatchObject({
      code: ERROR_CODES.CHAT_INVALID_ANSWER,
    });
    const second = await crew.answerCard(card.id, { kind: 'options', picks: [1, 3] });
    expect(second.echo).toBe('You → Ada: Q2 = 1,3 (Wheat, Potatoes)');
    expect(cards()).toEqual([]);
    await expect(crew.answerCard(card.id, { kind: 'later' })).rejects.toMatchObject({
      code: ERROR_CODES.CARD_GONE,
    });
  });

  it('plans: approve in chat; revise from the screen; later parks', async () => {
    await crew.deliverChat({ to: 'all', text: '@bram make a plan' });
    time.advance(1000);
    const [plan] = cards('bram');
    expect(plan?.kind).toBe('plan');
    expect((await crew.deliverChat({ to: 'all', text: '@bram is that safe?' })).echo).toContain('question');
    expect(cards('bram')).toHaveLength(1);
    const later = await crew.answerCard(plan?.id ?? '', { kind: 'later' });
    expect(later.echo).toContain('later');
    expect(cards('bram')[0]).toMatchObject({ parked: true, presenting: false });
    const revise = await crew.answerCard(plan?.id ?? '', { kind: 'revise', feedback: 'use tabs' });
    expect(revise.echo).toBe('You → Bram: revise plan: "use tabs"');
    expect(cards('bram')).toEqual([]);

    await crew.deliverChat({ to: 'all', text: '@bram another plan' });
    time.advance(1000);
    const approved = await crew.deliverChat({ to: 'all', text: '@bram approve' });
    expect(approved.echo).toBe('You → Bram: plan approved');
    time.advance(300);
    expect(says.at(-1)).toMatchObject({ agentId: 'bram', text: 'Plan approved. Starting now.' });
  });

  it('hires a miner when the CEO asks and the player says yes', async () => {
    await crew.deliverChat({ to: 'all', text: '@ceo should we hire someone' });
    time.advance(1000);
    expect(cards()[0]).toMatchObject({ kind: 'hire', name: 'Dana', handle: 'dana' });
    const result = await crew.deliverChat({ to: 'all', text: '@ada yes' });
    expect(result.echo).toBe('You → Ada: hire approved: Dana (miner)');
    expect(crew.listAgents().map((a) => a.handle)).toEqual(['ada', 'bram', 'dana']);
    time.advance(600);
    expect(says.at(-1)).toMatchObject({ agentId: 'dana', text: 'Reporting for duty!' });
    expect(bridge.requests.at(-1)).toMatchObject({
      t: 'agent.spawn',
      payload: { agentId: 'dana', role: 'miner' },
    });
  });

  it('queues lines to a busy agent with a hint, then answers when free', async () => {
    await crew.deliverChat({ to: ['ada'], text: 'stay busy' });
    time.advance(1000);
    const queued = await crew.deliverChat({ to: 'all', text: '@ada are you there' });
    expect(queued.deliveries[0]).toMatchObject({
      queued: true,
      hint: 'Ada is mid-task, reads this at the next step',
    });
    expect(brains.at(-1)).toMatchObject({ status: 'queued' });
    time.advance(BUSY_MS);
    time.advance(1000);
    expect(says.at(-1)).toMatchObject({ text: 'On it: are you there' });
  });

  it('long replies and calendar approvals', async () => {
    await crew.deliverChat({ to: ['ada'], text: 'tell me the long story' });
    time.advance(1000);
    expect((says.at(-1)?.text ?? '').length).toBeGreaterThan(200);
    await crew.deliverChat({ to: ['ada'], text: 'calendar' });
    time.advance(1000);
    const [card] = cards();
    expect(card).toMatchObject({ kind: 'calendar' });
    expect((await crew.answerCard(card?.id ?? '', { kind: 'decline', note: 'too often' })).echo).toBe(
      'You → Ada: declined: "too often"',
    );
  });

  it('reacts to AgentScreen commands and keeps the brain indicator in sync', async () => {
    expect((await crew.command('bram', { cmd: 'plan_first', on: false })).echo).toBe('Bram: plan first off');
    expect(brains.at(-1)).toMatchObject({ agentId: 'bram', planFirst: false });
    expect((await crew.command('ada', { cmd: 'autonomy', level: 'proactive' })).echo).toBe(
      'Ada: autonomy proactive',
    );
    expect(brains.at(-1)).toMatchObject({ agentId: 'ada', autonomy: 'proactive' });
    expect((await crew.command('ada', { cmd: 'follow' })).echo).toBe('Ada will follow');
    expect(bridge.requests.at(-1)).toEqual({ t: 'agent.mode', payload: { agentId: 'ada', mode: 'follow' } });
    await expect(crew.command('ada', { cmd: 'kick' })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    expect((await crew.command('bram', { cmd: 'kick' })).echo).toBe('Kicked Bram off linux-1');
    expect(brains.at(-1)).toMatchObject({ agentId: 'bram', model: 'haiku' });
    expect((await crew.command('bram', { cmd: 'dismiss' })).echo).toBe('Bram was dismissed');
    await expect(crew.deliverChat({ to: 'all', text: '@bram hi' })).rejects.toMatchObject({
      code: ERROR_CODES.CHAT_UNAVAILABLE,
    });
  });

  it('asks the mod for bodies once per ready world', async () => {
    bridge.fire('world.state', { worldId: 'world-1', phase: 'loading' });
    expect(bridge.requests).toEqual([]);
    bridge.fire('world.state', { worldId: 'world-1', phase: 'ready' });
    bridge.fire('world.state', { worldId: 'world-1', phase: 'ready' });
    expect(bridge.requests.map((r) => [r.t, r.payload.agentId, r.payload.restore])).toEqual([
      ['agent.spawn', 'ada', true],
      ['agent.spawn', 'bram', true],
    ]);
  });

  it('stops replying after dispose', async () => {
    await crew.deliverChat({ to: ['ada'], text: 'hello' });
    crew.dispose();
    const before = says.length;
    time.advance(5000);
    expect(says.length).toBe(before);
  });
});
