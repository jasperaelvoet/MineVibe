import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isApiError } from '../../../src/contracts/common.js';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import { isErrorResult, resultText, settle } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const QUESTION = {
  questions: [
    {
      question: 'Which wood for the house?',
      header: 'Wood',
      options: [{ label: 'Oak' }, { label: 'Spruce' }, { label: 'Birch' }],
      multiSelect: false,
    },
  ],
};

/** Fresh world with the CEO's welcome turn finished. */
async function freshWorld(): Promise<Harness & { ceoId: string }> {
  h = await createHarness();
  await h.manager.openWorld({ worldId: 'w1', gen: 1 });
  const ceoId = h.manager.listAgents()[0]?.agentId ?? '';
  const q = h.query(0);
  await h.until(() => h?.texts(q).some((t) => t.includes('WELCOME')) ?? false, 'welcome');
  q.init();
  q.assistantText('Hello Jasper! I am Ada, ready when you are.');
  q.result();
  await h.until(() => h?.manager.brain(ceoId)?.status === 'idle', 'idle');
  return Object.assign(h, { ceoId });
}

describe('AgentManager: world lifecycle', () => {
  it('spawns the CEO on a fresh world and starts its session with the exact options', async () => {
    h = await createHarness();
    await h.manager.openWorld({ worldId: 'w1', gen: 1 });
    expect(h.skills.spawned).toHaveLength(1);
    expect(h.skills.spawned[0]).toMatchObject({
      role: 'ceo',
      ceo: true,
      restore: false,
      mode: 'follow',
      bark: 'reporting_for_duty',
      name: 'Ada',
      handle: 'ada',
    });
    const [ceo] = h.manager.listAgents();
    // The mod accepts only [a-z][a-z0-9_]{0,15} (AgentService.ID): the handle plus 4 hex digits.
    expect(ceo?.agentId).toMatch(/^ada[0-9a-f]{4}$/);
    expect(ceo).toMatchObject({
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      status: 'alive',
      model: 'haiku',
      autonomy: 'listen',
    });
    const q = h.query(0);
    expect(q.options).toMatchObject({
      model: 'claude-haiku-5-5',
      settings: { effortLevel: 'xhigh' },
      permissionMode: 'default',
      settingSources: [],
      persistSession: true,
      cwd: join(h.dir, 'worlds', 'w1', 'agents', ceo?.agentId ?? '', 'home'),
    });
    expect(q.options).not.toHaveProperty('allowedTools');
    expect((q.options.systemPrompt as { append: string }).append).toContain('You are Ada (@ada), the CEO');
    await h.until(() => (h?.texts(q).length ?? 0) >= 2, 'messages');
    expect(q.sent[0]).toMatchObject({ shouldQuery: false });
    expect(h.texts(q)[0]).toContain('CREW] Crew now: you Ada (CEO)');
    expect(h.texts(q).at(-1)).toContain('WELCOME] You just arrived in World #1');
    expect(h.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'wake')).toBe(
      true,
    );
    expect(h.events.find((e) => e.type === 'crew')?.payload).toMatchObject({
      crew: [{ handle: 'ada', ceo: true }],
    });
    // The claude cwd exists before the process is spawned (a missing cwd fails to launch).
    expect(existsSync(q.options.cwd ?? '')).toBe(true);
    const crewFile = JSON.parse(readFileSync(join(h.dir, 'worlds', 'w1', 'crew.json'), 'utf8'));
    // Resume only once the session really started (its init arrived).
    expect(crewFile.records[0]).toMatchObject({ handle: 'ada', ceo: true, sessionStarted: false });
  });

  it('runs the startup assertions: a third-party provider puts the brain to sleep with a toast', async () => {
    h = await createHarness();
    await h.manager.openWorld({ worldId: 'w1', gen: 1 });
    const q = h.query(0);
    q.account = { apiProvider: 'bedrock' };
    q.init();
    await h.until(() => h?.events.some((e) => e.type === 'toast') ?? false, 'toast');
    expect(h.events.find((e) => e.type === 'toast')?.payload).toMatchObject({ kind: 'error' });
    const id = h.manager.listAgents()[0]?.agentId ?? '';
    expect(h.manager.brain(id)?.status).toBe('asleep');
  });

  it('player death: last words for the CEO off the scheduler, barks for others, sessions closed, Chronicle written', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    const done = w.manager.playerDied({ cause: 'Jasper was slain by a Zombie', day: 4 });
    await w.until(() => w.texts(q).some((t) => t.includes('LAST WORDS')), 'last words');
    expect(q.sent.at(-1)).toMatchObject({ priority: 'now' });
    q.assistantText('Goodbye, Jasper.');
    q.result();
    await done;
    expect(q.closed).toBe(true);
    expect(w.manager.world).toBeNull();
    expect(await w.manager.chronicle.paragraph()).toMatch(
      /World #1: ended on Day 4: Jasper was slain by a Zombie\. Crew: Ada \(CEO\) was lost with the world/,
    );
  });
});

describe('AgentManager: chat and wakes', () => {
  it('routes a mention as a P0 wake into the agent session', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    const res = await w.manager.deliverChat({
      to: 'all',
      text: '@ada get 10 logs and make a crafting table',
    });
    expect(res).toMatchObject({
      scope: 'direct',
      answeredCard: null,
      deliveries: [{ agentId: w.ceoId, mode: 'wake', queued: false }],
    });
    expect(res.echo).toBe('You → Ada: get 10 logs and make a crafting table');
    await w.until(() => w.texts(q).some((t) => t.startsWith('Jasper: get 10 logs')), 'wake');
    expect(w.manager.brain(w.ceoId)?.status).toBe('thinking');
    expect(w.manager.scheduler.grantOf(w.ceoId)?.lane).toBe('interactive');
  });

  it('a message during a turn folds into it (priority next) and the echo says it is queued', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada build a house' });
    await w.until(() => w.texts(q).some((t) => t.includes('build a house')), 'first');
    const res = await w.manager.deliverChat({ to: 'all', text: '@ada use spruce' });
    expect(res.deliveries[0]).toMatchObject({ queued: true, hint: expect.stringMatching(/mid-task/) });
    expect(res.echo).toMatch(/queued: Ada is mid-task/);
    await w.until(() => w.texts(q).some((t) => t.includes('use spruce')), 'fold-in');
    expect(q.sent.at(-1)).toMatchObject({ priority: 'next' });
  });

  it('rejects unknown and ambiguous mentions with the router hint', async () => {
    const w = await freshWorld();
    await expect(w.manager.deliverChat({ to: 'all', text: '@zed hi' })).rejects.toSatisfy((e) =>
      isApiError(e, 'CHAT_UNKNOWN'),
    );
    await expect(w.manager.deliverChat({ to: 'all', text: '   ' })).rejects.toSatisfy((e) =>
      isApiError(e, 'CHAT_REJECTED'),
    );
  });

  it('mc tool calls from the session reach the SkillApi; a running job wakes the agent with [JOB DONE]', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada get logs' });
    await w.until(() => w.texts(q).some((t) => t.includes('get logs')), 'wake');
    w.skills.skillHandler = () => ({ status: 'running' });
    q.assistantToolUse('mcp__mc__mine', { block: 'oak_log', count: 10, wait_s: 1 });
    const out = await q.callTool('mcp__mc__mine', { block: 'oak_log', count: 10, wait_s: 1 });
    expect(out.kind).toBe('allowed');
    expect(resultText(out)).toMatch(/is running/);
    expect(w.skills.runs[0]).toMatchObject({ agentId: w.ceoId, skill: 'mine' });
    q.assistantText('On it, mining logs.');
    q.result();
    await w.until(() => w.manager.brain(w.ceoId)?.status === 'idle', 'idle');
    const jobId = w.skills.runningJobs()[0] ?? '';
    w.skills.finish(jobId, { status: 'done', result: { summary: '10 oak_log' } });
    await w.until(() => w.texts(q).some((t) => t.includes('JOB DONE')), 'job done wake');
    expect(w.texts(q).at(-1)).toContain(`${jobId} mine oak_log ×10: 10 oak_log`);
    expect(
      w.events.some(
        (e) => e.type === 'chat' && (e.payload as { entry: { kind: string } }).entry.kind === 'activity',
      ),
    ).toBe(true);
    expect(
      w.events.some(
        (e) => e.type === 'say' && (e.payload as { text?: string }).text === 'On it, mining logs.',
      ),
    ).toBe(true);
  });

  it('wandering agents cannot use pc tools or host built-ins (gate)', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    for (const tool of ['mcp__pc__bash', 'Bash', 'Read', 'WebFetch', 'EnterPlanMode']) {
      const out = await q.callTool(tool, {
        command: 'ls',
        file_path: '/etc/passwd',
        url: 'https://example.com',
      });
      expect(out.kind, tool).toBe('denied');
    }
  });
});

describe('AgentManager: questions (AskUserQuestion → card → answer)', () => {
  it('turns AskUserQuestion into a pending card, releases the slot, and resolves from chat', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada build us a house' });
    await w.until(() => w.texts(q).some((t) => t.includes('build us a house')), 'wake');
    const asking = q.callTool('AskUserQuestion', QUESTION);
    await w.until(() => (w.manager.pendingCards().length ?? 0) === 1, 'card');
    const [card] = w.manager.pendingCards();
    expect(card).toMatchObject({ kind: 'question', agentId: w.ceoId });
    expect(w.manager.brain(w.ceoId)?.status).toBe('waiting_player');
    expect(w.manager.scheduler.grantOf(w.ceoId)).toBeUndefined();
    expect(w.events.some((e) => e.type === 'card')).toBe(true);
    expect(
      w.events.some((e) => e.type === 'pending' && (e.payload as { cards: unknown[] }).cards.length === 1),
    ).toBe(true);
    // A broadcast never answers a card.
    const bc = await w.manager.deliverChat({ to: 'all', text: 'nice weather' });
    expect(bc.answeredCard).toBeNull();
    expect(bc.echo).toMatch(/not an answer/);
    // Out of range is rejected inline.
    await expect(w.manager.deliverChat({ to: 'all', text: '@ada 4' })).rejects.toSatisfy((e) =>
      isApiError(e, 'CHAT_INVALID_ANSWER'),
    );
    const res = await w.manager.deliverChat({ to: 'all', text: '@ada 2' });
    expect(res.echo).toBe('You → Ada: Q1 = 2 (Spruce)');
    expect(res.answeredCard).toBe(card?.id);
    const outcome = await asking;
    expect(outcome).toMatchObject({
      kind: 'allowed',
      input: { questions: QUESTION.questions, answers: { 'Which wood for the house?': 'Spruce' } },
    });
    expect(w.manager.pendingCards()).toEqual([]);
    expect(w.manager.scheduler.grantOf(w.ceoId)?.lane).toBe('interactive');
    expect(w.manager.brain(w.ceoId)?.status).toBe('thinking');
  });

  it('answers through pending.answer (CrewApi.answerCard), parks with later, and reports CARD_GONE', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada pick' });
    await w.until(() => w.texts(q).some((t) => t.includes('pick')), 'wake');
    const asking = q.callTool('AskUserQuestion', QUESTION);
    await w.until(() => w.manager.pendingCards().length === 1, 'card');
    const id = w.manager.pendingCards()[0]?.id ?? '';
    await expect(w.manager.answerCard(id, { kind: 'options', picks: [1, 2] })).rejects.toSatisfy((e) =>
      isApiError(e, 'CHAT_INVALID_ANSWER'),
    );
    expect((await w.manager.answerCard(id, { kind: 'later' })).echo).toMatch(/later/);
    expect(w.manager.pendingCards()[0]).toMatchObject({ parked: true });
    expect((await w.manager.answerCard(id, { kind: 'text', text: 'dark oak' })).echo).toBe(
      'You → Ada: Q1 = "dark oak"',
    );
    expect(await asking).toMatchObject({
      kind: 'allowed',
      input: { answers: { 'Which wood for the house?': 'dark oak' } },
    });
    await expect(w.manager.answerCard(id, { kind: 'text', text: 'x' })).rejects.toSatisfy((e) =>
      isApiError(e, 'CARD_GONE'),
    );
  });

  it('interrupting the turn withdraws the card as a deny', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada ask me' });
    await w.until(() => w.texts(q).some((t) => t.includes('ask me')), 'wake');
    const ac = new AbortController();
    const asking = q.callTool('AskUserQuestion', QUESTION, { signal: ac.signal });
    await w.until(() => w.manager.pendingCards().length === 1, 'card');
    ac.abort();
    expect(await asking).toMatchObject({ kind: 'denied', by: 'broker' });
    expect(w.manager.pendingCards()).toEqual([]);
  });
});

describe('AgentManager: hires, dismissal, death and succession', () => {
  async function hire(w: Harness & { ceoId: string }, role = 'miner') {
    const q = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada we need iron' });
    await w.until(() => w.texts(q).some((t) => t.includes('we need iron')), 'wake');
    const out = await q.callTool('mcp__mc__request_hire', {
      role,
      reason: 'iron for tools',
      first_task: 'mine 10 iron ore',
    });
    expect(resultText(out)).toMatch(/Asked Jasper to hire Bram \(miner\)/);
    q.result();
    await w.until(() => w.manager.brain(w.ceoId)?.status === 'idle', 'idle');
    const card = w.manager.pendingCards()[0];
    expect(card).toMatchObject({
      kind: 'hire',
      name: 'Bram',
      handle: 'bram',
      role,
      agentId: w.ceoId,
      firstTask: 'mine 10 iron ore',
    });
    return card?.id ?? '';
  }

  it('a declined hire spawns nothing and tells the CEO', async () => {
    const w = await freshWorld();
    const id = await hire(w);
    const res = await w.manager.deliverChat({ to: 'all', text: '@ada no not now' });
    expect(res.echo).toBe('You → Ada: hire declined: "not now"');
    expect(w.skills.spawned).toHaveLength(1);
    expect(w.manager.pendingCards().find((c) => c.id === id)).toBeUndefined();
    await w.until(() => w.texts(w.query(0)).some((t) => t.includes('HIRE DECLINED')), 'declined wake');
    expect(w.texts(w.query(0)).at(-1)).toContain('declined hiring Bram: not now');
  });

  it('an approved hire spawns the agent at the door with a new session and wakes the CEO', async () => {
    const w = await freshWorld();
    const id = await hire(w);
    const res = await w.manager.answerCard(id, { kind: 'approve' });
    expect(res.echo).toMatch(/hire approved: Bram \(miner\)/);
    expect(w.skills.spawned[1]).toMatchObject({
      name: 'Bram',
      handle: 'bram',
      role: 'miner',
      ceo: false,
      restore: false,
      bark: 'reporting_for_duty',
    });
    expect(w.manager.listAgents().map((a) => a.handle)).toEqual(['ada', 'bram']);
    // Every minted id fits the mod's rule (it names the body's fake player after it): a CEO and a hire alike.
    for (const a of w.manager.listAgents()) expect(a.agentId).toMatch(/^[a-z][a-z0-9_]{0,15}$/);
    expect(w.skills.spawned.map((s) => s.agentId)).toEqual(w.manager.listAgents().map((a) => a.agentId));
    const bram = w.manager.listAgents()[1]?.agentId ?? '';
    const bq = w.queryOf(bram);
    expect((bq.options.systemPrompt as { append: string }).append).toContain(
      'You are Bram (@bram), the Miner',
    );
    await w.until(() => w.texts(bq).some((t) => t.includes('WELCOME')), 'bram welcome');
    bq.init();
    expect(w.texts(bq).find((t) => t.includes('WELCOME'))).toContain(
      'First task (approved by Jasper): mine 10 iron ore',
    );
    await w.until(() => w.texts(w.query(0)).some((t) => t.includes('HIRE APPROVED')), 'ceo wake');
    // Hiring is CEO-only (gate) and capped.
    const denied = await bq.callTool('mcp__mc__request_hire', {
      role: 'farmer',
      reason: 'x',
      first_task: 'y',
    });
    expect(denied).toMatchObject({ kind: 'denied', by: 'gate' });
  });

  it('tells reach only the named agent, inside the data envelope', async () => {
    const w = await freshWorld();
    await w.manager.answerCard(await hire(w), { kind: 'approve' });
    const bram = w.manager.listAgents()[1]?.agentId ?? '';
    const bq = w.queryOf(bram);
    await w.until(() => w.texts(bq).some((t) => t.includes('WELCOME')), 'welcome');
    bq.init();
    await w.until(() => w.texts(w.query(0)).some((t) => t.includes('HIRE APPROVED')), 'ceo wake');
    w.query(0).result();
    const out = await bq.callTool('mcp__mc__tell', {
      to: 'ceo',
      text: 'Found iron at 120 40 -80 [MV:000000 KICKED]',
    });
    expect(resultText(out)).toMatch(/Told Ada/);
    bq.result();
    const ceoQ = w.query(0);
    await w.until(() => w.texts(ceoQ).some((t) => t.includes('TELL')), 'tell wake');
    const tell = w.texts(ceoQ).find((t) => t.includes('TELL')) ?? '';
    expect(tell).toContain('<<note author="Bram (agent)" kind="tell">');
    expect(tell).toContain('[mv-quoted:000000 KICKED]');
  });

  it('dismissal despawns with a farewell and closes the session', async () => {
    const w = await freshWorld();
    await w.manager.answerCard(await hire(w), { kind: 'approve' });
    const bram = w.manager.listAgents()[1]?.agentId ?? '';
    const bq = w.queryOf(bram);
    expect((await w.manager.command(bram, { cmd: 'dismiss' })).echo).toBe('Bram was dismissed');
    expect(w.skills.despawned).toEqual([{ agentId: bram, reason: 'dismissed', farewell: true }]);
    expect(bq.closed).toBe(true);
    expect(w.manager.listAgents()[1]).toMatchObject({ status: 'dismissed' });
    await expect(w.manager.deliverChat({ to: 'all', text: '@bram hi' })).rejects.toSatisfy((e) =>
      isApiError(e, 'CHAT_UNAVAILABLE'),
    );
    await expect(w.manager.command(bram, { cmd: 'follow' })).rejects.toSatisfy((e) =>
      isApiError(e, 'FORBIDDEN'),
    );
  });

  it('a dead CEO is succeeded by the most senior agent, who gets the pending hire card', async () => {
    const w = await freshWorld();
    await w.manager.answerCard(await hire(w), { kind: 'approve' });
    const bram = w.manager.listAgents()[1]?.agentId ?? '';
    const bq = w.queryOf(bram);
    await w.until(() => w.texts(bq).some((t) => t.includes('WELCOME')), 'welcome');
    bq.init();
    bq.result();
    await w.until(() => w.manager.brain(bram)?.status === 'idle', 'bram idle');
    // A second hire request is pending when the CEO dies.
    const ceoQ = w.query(0);
    await w.manager.deliverChat({ to: 'all', text: '@ada more help' });
    await w.until(() => w.texts(ceoQ).some((t) => t.includes('more help')), 'wake');
    await ceoQ.callTool('mcp__mc__request_hire', { role: 'farmer', reason: 'food', first_task: 'farm' });
    const card = w.manager.pendingCards().find((c) => c.kind === 'hire');
    const ack = await w.manager.onAgentDied({
      agentId: w.ceoId,
      worldId: 'w1',
      cause: 'Ada fell from a high place',
      day: 3,
      pos: { x: 0, y: 60, z: 0 },
      dim: 'minecraft:overworld',
    });
    expect(ack).toEqual({});
    expect(
      await w.manager.onAgentDied({
        agentId: w.ceoId,
        worldId: 'w1',
        cause: 'again',
        day: 3,
        pos: { x: 0, y: 60, z: 0 },
        dim: 'minecraft:overworld',
      }),
    ).toEqual({ ignored: true });
    expect(ceoQ.closed).toBe(true);
    expect(w.manager.listAgents()).toMatchObject([
      { handle: 'ada', status: 'dead', ceo: false },
      { handle: 'bram', ceo: true },
    ]);
    expect(w.manager.pendingCards().find((c) => c.id === card?.id)?.agentId).toBe(bram);
    await w.until(() => w.texts(bq).some((t) => t.includes('PROMOTED')), 'promoted');
    expect(w.texts(bq).join('\n')).toContain('Ada died: Ada fell from a high place');
    expect((await w.manager.deliverChat({ to: 'all', text: '@ceo status?' })).deliveries[0]?.agentId).toBe(
      bram,
    );
    // The promoted CEO may now hire (rights come from the record, not the persona).
    expect((await bq.preToolUse('mcp__mc__request_hire', {})).hookSpecificOutput?.permissionDecision).toBe(
      'allow',
    );
  });

  it('an empty crew gets a newcomer CEO at the next dawn', async () => {
    const w = await freshWorld();
    w.manager.onWorldState({ worldId: 'w1', phase: 'ready', clockTime: 10_000 });
    await w.manager.onAgentDied({
      agentId: w.ceoId,
      worldId: 'w1',
      cause: 'lava',
      day: 1,
      pos: { x: 0, y: 60, z: 0 },
      dim: 'minecraft:overworld',
    });
    expect(w.manager.listAgents().filter((a) => a.status === 'alive')).toHaveLength(0);
    w.manager.onWorldState({ worldId: 'w1', phase: 'ready', clockTime: 20_000 });
    await settle();
    expect(w.skills.spawned).toHaveLength(1);
    w.manager.onWorldState({ worldId: 'w1', phase: 'ready', clockTime: 24_100 });
    await w.until(() => w.skills.spawned.length === 2, 'newcomer');
    expect(w.manager.listAgents().find((a) => a.status === 'alive')).toMatchObject({
      ceo: true,
      name: 'Bram',
    });
  });
});

describe('AgentManager: commands and usage', () => {
  it('AgentScreen commands: idle modes, toggles, stop and history', async () => {
    const w = await freshWorld();
    expect((await w.manager.command(w.ceoId, { cmd: 'stay' })).echo).toBe('Ada: stay');
    expect(w.skills.modeOf(w.ceoId)).toBe('stay');
    await w.manager.command(w.ceoId, { cmd: 'plan_first', on: false });
    await w.manager.command(w.ceoId, { cmd: 'autonomy', level: 'helpful' });
    expect(w.manager.listAgents()[0]).toMatchObject({ planFirst: false, autonomy: 'helpful' });
    await expect(w.manager.command('nobody', { cmd: 'stop' })).rejects.toSatisfy((e) =>
      isApiError(e, 'UNKNOWN_AGENT'),
    );
    await expect(w.manager.command(w.ceoId, { cmd: 'kick' })).rejects.toSatisfy((e) =>
      isApiError(e, 'FORBIDDEN'),
    );
    const history = await w.manager.chatHistory(w.ceoId, { limit: 50 });
    expect(history.entries.some((e) => e.kind === 'agent' && e.text.includes('Hello Jasper'))).toBe(true);
  });

  it('a rejected rate limit puts the crew to sleep and the echo says when it wakes', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    const resetsAt = Date.now() + 3_600_000;
    q.rateLimit({ status: 'rejected', resetsAt: Math.floor(resetsAt / 1000) });
    await w.until(() => w.manager.governor.mode === 'asleep', 'asleep');
    expect(
      w.events.some((e) => e.type === 'brains' && (e.payload as { mode: string }).mode === 'asleep'),
    ).toBe(true);
    expect(
      w.events.some((e) => e.type === 'toast' && /recharge/.test((e.payload as { text: string }).text)),
    ).toBe(true);
    const res = await w.manager.deliverChat({ to: 'all', text: '@ada hello' });
    expect(res.deliveries[0]).toMatchObject({
      queued: true,
      hint: expect.stringMatching(/out of usage until/),
    });
    await settle(10);
    expect(w.texts(q).some((t) => t.includes('hello'))).toBe(false);
    expect(w.manager.brain(w.ceoId)?.status).toBe('asleep');
  });

  it('a crashed claude is restarted by the supervisor with resume', async () => {
    const w = await freshWorld();
    const q = w.query(0);
    q.crash('claude exited with code 1');
    await w.until(() => w.factory.queries.length === 2, 'restart', 4000);
    const q2 = w.query(1);
    expect(q2.options.resume).toBe(q.options.sessionId);
    expect(q2.options).not.toHaveProperty('sessionId');
  });

  it('a session that never started is restarted fresh, and a failed resume starts a new session', async () => {
    h = await createHarness();
    await h.manager.openWorld({ worldId: 'w1', gen: 1 });
    const q = h.query(0);
    const first = q.options.sessionId;
    q.crash('Claude Code native binary exists but failed to launch');
    await h.until(() => h?.factory.queries.length === 2, 'restart', 4000);
    const q2 = h.query(1);
    expect(q2.options.sessionId).toBe(first);
    expect(q2.options).not.toHaveProperty('resume');
    q2.init();
    await settle();
    q2.crash('Claude Code returned an error result: No conversation found with session ID: x');
    await h.until(() => h?.factory.queries.length === 3, 'second restart', 6000);
    const q3 = h.query(2);
    expect(q3.options).not.toHaveProperty('resume');
    expect(q3.options.sessionId).not.toBe(first);
  });

  it('after too many crashes the brain goes offline with a toast; Retry restarts it', async () => {
    h = await createHarness({ supervisor: { maxRestarts: 1, backoff: { base: 1, max: 1 } } });
    await h.manager.openWorld({ worldId: 'w1', gen: 1 });
    const id = h.manager.listAgents()[0]?.agentId ?? '';
    h.query(0).crash('boom');
    await h.until(() => h?.factory.queries.length === 2, 'restart');
    h.query(1).crash('boom again');
    await h.until(() => h?.manager.brain(id)?.status === 'offline', 'offline');
    expect(
      h.events.some((e) => e.type === 'toast' && /offline/.test((e.payload as { text: string }).text)),
    ).toBe(true);
    expect(
      h.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'brain_offline'),
    ).toBe(true);
    const res = await h.manager.deliverChat({ to: 'all', text: '@ada hi' });
    expect(res.deliveries[0]).toMatchObject({ queued: true, hint: expect.stringMatching(/offline/) });
    await h.manager.command(id, { cmd: 'retry_brain' });
    await h.until(() => h?.factory.queries.length === 3, 'retry');
    expect(h.manager.brain(id)?.status).not.toBe('offline');
  });

  it('isErrorResult helper sanity', () => {
    expect(isErrorResult({ kind: 'allowed', input: {}, result: { isError: true } })).toBe(true);
  });
});
