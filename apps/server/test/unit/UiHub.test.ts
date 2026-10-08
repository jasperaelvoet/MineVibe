import { ERROR_CODES, type PendingCard } from '@minevibe/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../../src/bridge/BridgeServer.js';
import type { DeliveryResult } from '../../src/contracts/CrewApi.js';
import { FakeCrewApi } from '../../src/contracts/FakeCrewApi.js';
import { silentLogger } from '../../src/log.js';
import { brainFromSummary, ECHO_MAX_LENGTH, formatEcho, type UiBridge, UiHub } from '../../src/ui/UiHub.js';
import { FakeUiBridge } from '../helpers/fakeUiBridge.js';

const question: PendingCard = {
  kind: 'question',
  id: 'q-1',
  agentId: 'ada',
  createdAt: 1,
  parked: false,
  presenting: true,
  questions: [
    {
      question: 'Which wood?',
      options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
      multiSelect: false,
    },
  ],
  answers: [],
};

describe('formatEcho', () => {
  const base: DeliveryResult = { echo: 'You → Ada: hi', scope: 'direct', deliveries: [], answeredCard: null };

  it('returns the router echo when every agent reads the line at once', () => {
    expect(
      formatEcho({
        ...base,
        deliveries: [{ agentId: 'ada', mode: 'wake', queued: false, latencyMs: 0, hint: null }],
      }),
    ).toBe('You → Ada: hi');
  });

  it('appends the queue hints of addressed agents, once each', () => {
    const echo = formatEcho({
      ...base,
      echo: 'You → all: hi',
      scope: 'broadcast',
      deliveries: [
        { agentId: 'ada', mode: 'wake', queued: true, latencyMs: 30_000, hint: 'Ada is mid-task' },
        { agentId: 'bram', mode: 'wake', queued: true, latencyMs: null, hint: null },
        { agentId: 'cleo', mode: 'wake', queued: true, latencyMs: 30_000, hint: 'Ada is mid-task' },
        { agentId: 'dana', mode: 'context', queued: true, latencyMs: null, hint: 'Dana is seated' },
      ],
    });
    expect(echo).toBe('You → all: hi (queued: Ada is mid-task; bram reads this later)');
  });

  it('uses display names for queued agents without a hint, and stays within the echo limit', () => {
    const echo = formatEcho(
      {
        ...base,
        echo: `You → Bram: ${'x'.repeat(2500)}`,
        deliveries: [{ agentId: 'bram', mode: 'wake', queued: true, latencyMs: null, hint: null }],
      },
      new Map([['bram', 'Bram']]),
    );
    expect(echo.length).toBe(ECHO_MAX_LENGTH);
    expect(echo.endsWith('…')).toBe(true);
    expect(
      formatEcho(
        { ...base, deliveries: [{ agentId: 'bram', mode: 'wake', queued: true, latencyMs: 1, hint: null }] },
        new Map([['bram', 'Bram']]),
      ),
    ).toBe('You → Ada: hi (queued: Bram reads this later)');
  });
});

describe('UiHub', () => {
  let bridge: FakeUiBridge;
  let crew: FakeCrewApi;
  let hub: UiHub;
  let deferred: Array<() => void>;

  beforeEach(() => {
    bridge = new FakeUiBridge();
    crew = new FakeCrewApi([
      { agentId: 'ada', handle: 'ada', name: 'Ada', role: 'ceo', ceo: true },
      { agentId: 'bram', handle: 'bram', name: 'Bram', seatedPc: 'linux-1', model: 'opus' },
    ]);
    deferred = [];
    hub = new UiHub({
      bridge: bridge as unknown as UiBridge,
      crew,
      logger: silentLogger(),
      defer: (fn) => deferred.push(fn),
    }).start();
  });

  it('registers one handler per UI request type and refuses a second start', () => {
    expect([...bridge.handlers.keys()].sort()).toEqual([
      'agent.cmd',
      'chat.history',
      'chat.send',
      'hire.decision',
      'pending.answer',
      'plan.decision',
    ]);
    expect(() => hub.start()).toThrow(/already started/);
  });

  it('delivers chat.send to the crew and replies with the echo plus queue hints', async () => {
    crew.setBusy('ada', true);
    const reply = await bridge.call('chat.send', { to: 'all', text: '@ada build a house' });
    expect(crew.delivered).toEqual([{ to: 'all', text: '@ada build a house' }]);
    expect(reply).toEqual({
      echo: 'You → Ada: build a house (queued: Ada is mid-task, reads this at the next step)',
    });
  });

  it('passes AgentScreen modes and explicit recipients through', async () => {
    await bridge.call('chat.send', { to: ['bram'], text: 'fix the test', mode: 'task' });
    expect(crew.delivered).toEqual([{ to: ['bram'], text: 'fix the test', mode: 'task' }]);
  });

  it('turns ApiErrors into err replies, and toasts dead or dismissed names', async () => {
    await expect(bridge.call('chat.send', { to: 'all', text: '@zed hi' })).rejects.toMatchObject({
      code: ERROR_CODES.CHAT_UNKNOWN,
    });
    expect(bridge.pushed('ui.toast')).toEqual([]);
    await crew.command('bram', { cmd: 'dismiss' });
    const err = await bridge.call('chat.send', { to: ['bram'], text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: ERROR_CODES.CHAT_UNAVAILABLE, message: 'Bram is dismissed' });
    expect(bridge.pushed('ui.toast')).toEqual([{ text: 'Bram is dismissed', kind: 'warn' }]);
  });

  it('maps pending.answer, plan.decision and hire.decision onto answerCard', async () => {
    crew.raiseCard(question);
    crew.raiseCard({ ...question, id: 'q-2' });
    crew.raiseCard({ ...question, id: 'q-3' });
    crew.raiseCard({ ...question, id: 'q-4' });
    await bridge.call('pending.answer', {
      agentId: 'ada',
      pendingId: 'q-1',
      answer: { kind: 'options', picks: [2] },
    });
    await bridge.call('plan.decision', {
      agentId: 'ada',
      pendingId: 'q-2',
      decision: 'revise',
      feedback: 'tabs',
    });
    await bridge.call('hire.decision', { pendingId: 'q-3', decision: 'decline', note: 'not now' });
    const approved = await bridge.call('hire.decision', { pendingId: 'q-4', decision: 'approve' });
    expect(crew.answers).toEqual([
      { pendingId: 'q-1', answer: { kind: 'options', picks: [2] } },
      { pendingId: 'q-2', answer: { kind: 'revise', feedback: 'tabs' } },
      { pendingId: 'q-3', answer: { kind: 'decline', note: 'not now' } },
      { pendingId: 'q-4', answer: { kind: 'approve' } },
    ]);
    expect(approved).toEqual({ echo: 'You → Ada: approve' });
    await expect(
      bridge.call('pending.answer', { agentId: 'ada', pendingId: 'q-1', answer: { kind: 'later' } }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CARD_GONE });
  });

  it('refuses an answer sent from another agent screen than the card owner', async () => {
    crew.raiseCard(question);
    await expect(
      bridge.call('pending.answer', { agentId: 'bram', pendingId: 'q-1', answer: { kind: 'later' } }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.CARD_GONE,
      message: 'That card belongs to another agent now.',
    });
    await expect(
      bridge.call('plan.decision', { agentId: 'bram', pendingId: 'q-1', decision: 'approve' }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CARD_GONE });
    expect(crew.answers).toEqual([]);
    await bridge.call('pending.answer', { agentId: 'ada', pendingId: 'q-1', answer: { kind: 'later' } });
    expect(crew.answers).toHaveLength(1);
  });

  it('runs agent.cmd with its toggle and level, and pages chat.history', async () => {
    const reply = await bridge.call('agent.cmd', { agentId: 'bram', cmd: 'plan_first', on: true });
    await bridge.call('agent.cmd', { agentId: 'bram', cmd: 'autonomy', level: 'helpful' });
    expect(crew.commands).toEqual([
      { agentId: 'bram', command: { cmd: 'plan_first', on: true } },
      { agentId: 'bram', command: { cmd: 'autonomy', level: 'helpful' } },
    ]);
    expect(reply).toEqual({ echo: 'Bram: plan_first' });
    await expect(bridge.call('agent.cmd', { agentId: 'nobody', cmd: 'stop' })).rejects.toMatchObject({
      code: ERROR_CODES.UNKNOWN_AGENT,
    });

    crew.emitSay('ada', 'one');
    crew.emitSay('ada', 'two');
    crew.emitSay('ada', 'three');
    const page = await bridge.call('chat.history', { agentId: 'ada', limit: 2 });
    expect(page).toMatchObject({
      more: true,
      entries: [
        { seq: 1, text: 'two' },
        { seq: 2, text: 'three' },
      ],
    });
    const older = await bridge.call('chat.history', { agentId: 'ada', beforeSeq: 1, limit: 2 });
    expect(older).toMatchObject({ more: false, entries: [{ seq: 0, text: 'one' }] });
  });

  it('forwards crew events as UI pushes', () => {
    crew.emitSay('ada', 'Hello!');
    crew.emitBrain({
      agentId: 'ada',
      model: 'haiku',
      status: 'thinking',
      activity: 'Looking around',
      autonomy: 'listen',
      planFirst: false,
      pingInstead: false,
    });
    crew.raiseCard(question);
    crew.addAgent({ agentId: 'cleo', handle: 'cleo', name: 'Cleo' });
    expect(bridge.sent.map((s) => s.t)).toEqual([
      'agent.say',
      'chat.append',
      'agent.brain',
      'agent.pending',
      'crew.state',
    ]);
    expect(bridge.pushed('agent.say')[0]).toMatchObject({ agentId: 'ada', text: 'Hello!', style: 'speech' });
    expect(bridge.pushed('chat.append')[0]).toMatchObject({
      agentId: 'ada',
      entry: { kind: 'agent', text: 'Hello!' },
    });
    expect(hub.pending.get('ada')).toEqual([question]);
  });

  it('re-sends crew, brains, brain and cards after hello (deferred past hello.ok)', () => {
    crew.raiseCard(question);
    hub.setBrains({ inFlight: 1, queued: 0, max: 2, mode: 'tired', utilization: 0.8, resetsAt: null });
    crew.emitBrain({
      agentId: 'ada',
      model: 'haiku',
      status: 'waiting_player',
      activity: 'Waiting for you',
      autonomy: 'listen',
      planFirst: false,
      pingInstead: false,
    });
    bridge.clear();
    bridge.fire('hello', { mod: '0.1.0', mc: '26.3', phase: 'in_world', worldId: 'world-1' });
    expect(bridge.sent).toEqual([]);
    expect(deferred).toHaveLength(1);
    deferred[0]?.();
    expect(bridge.sent.map((s) => s.t)).toEqual([
      'crew.state',
      'brains.state',
      'agent.brain',
      'agent.pending',
      'agent.brain',
      'agent.pending',
    ]);
    expect(bridge.pushed('crew.state')[0]?.crew.map((c) => c.handle)).toEqual(['ada', 'bram']);
    expect(bridge.pushed('brains.state')[0]).toMatchObject({ mode: 'tired' });
    const [adaBrain, bramBrain] = bridge.pushed('agent.brain');
    expect(adaBrain).toMatchObject({ status: 'waiting_player', activity: 'Waiting for you' });
    const bram = crew.listAgents().find((a) => a.agentId === 'bram');
    expect(bram).toBeDefined();
    if (bram) expect(bramBrain).toEqual(brainFromSummary(bram));
    expect(bridge.pushed('agent.pending')).toEqual([
      { agentId: 'ada', cards: [question] },
      { agentId: 'bram', cards: [] },
    ]);
  });

  it('skips the resync while no mod is connected', () => {
    bridge.connected = false;
    hub.resync();
    expect(bridge.sent).toEqual([]);
  });

  it('sends toasts and unsubscribes on dispose', () => {
    expect(hub.toast('Hello', 'success', { agentId: 'ada', ttlMs: 4000 })).toBe(true);
    expect(bridge.pushed('ui.toast')).toEqual([
      { text: 'Hello', kind: 'success', agentId: 'ada', ttlMs: 4000 },
    ]);
    hub.dispose();
    expect(bridge.handlers.size).toBe(0);
    bridge.clear();
    crew.emitSay('ada', 'nobody listens');
    expect(bridge.sent).toEqual([]);
  });
});
