import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratePlanFirst } from '../../../src/agents/AgentManager.js';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import type { FakeQuery } from '../../helpers/fakeSdk.js';
import { resultText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

/** A fresh world whose CEO is idle; `planFirst` is turned on (the player's toggle) only when asked. */
async function world(options: { planFirst?: boolean } = {}) {
  h = await createHarness();
  await h.manager.openWorld({ worldId: 'w1', gen: 1 });
  const id = h.manager.listAgents()[0]?.agentId ?? '';
  const q = h.query(0);
  await h.until(() => h?.texts(q).some((t) => t.includes('WELCOME')) ?? false, 'welcome');
  q.init();
  q.result();
  await h.until(() => h?.manager.brain(id)?.status === 'idle', 'idle');
  // USER DECISION 2026-10-08: Plan-first is off by default; only the player's toggle turns it on.
  if (options.planFirst) await h.manager.command(id, { cmd: 'plan_first', on: true });
  return { w: h, id, q };
}

/** Starts a turn with a player message. */
async function wake(w: Harness, q: FakeQuery, text: string) {
  await w.manager.deliverChat({ to: 'all', text: `@ada ${text}` });
  await w.until(() => w.texts(q).some((t) => t.includes(text)), `wake ${text}`);
}

/** Sits the agent at linux-1: the sit job ends and the mod reports pc.seat. Returns the tool text. */
async function sit(w: Harness, q: FakeQuery, id: string) {
  const before = w.skills.seats.length;
  const calling = q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'fix the failing test' });
  await w.until(() => w.skills.seats.length > before, 'agent.seat');
  const seat = w.skills.seats.at(-1) as { jobId: string; seatEpoch: number };
  w.manager.onPcSeat({
    pcId: 'linux-1',
    occupant: { kind: 'agent', agentId: id },
    seatEpoch: seat.seatEpoch,
  });
  w.skills.finish(seat.jobId, { status: 'done' });
  return resultText(await calling);
}

function flagCalls(q: FakeQuery) {
  return q.calls.filter((c) => c.method === 'applyFlagSettings').map((c) => c.args);
}

describe('sit → swap to Opus/medium at the turn boundary → kickoff', () => {
  it('swaps only after the turn ends, then queues the kickoff and opens pc tools', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix the failing test in foo');
    expect(await sit(w, q, id)).toBe(
      'Seated at linux-1. End your turn now; your PC session starts with your next turn.',
    );
    expect(w.skills.seats[0]).toMatchObject({
      agentId: id,
      target: { kind: 'pc', pcId: 'linux-1' },
      purpose: 'fix the failing test',
      seatEpoch: 0,
    });
    expect(w.manager.brain(id)?.fsm.state).toBe('seated_pending_swap');
    expect(flagCalls(q)).toEqual([]);
    // Still in the sit turn: every further tool call is denied ("end your turn now").
    const early = await q.callTool('mcp__pc__bash', { command: 'ls' });
    expect(early).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/End your turn now/) });
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect(flagCalls(q)).toEqual([{ model: 'claude-opus-5-5', effortLevel: 'medium' }]);
    expect(w.manager.brain(id)?.fsm.state).toBe('seated');
    expect(w.manager.brain(id)?.model).toBe('opus');
    expect(w.manager.listAgents()[0]).toMatchObject({ model: 'opus', seatedPc: 'linux-1' });
    const kickoff = w.texts(q).find((t) => t.includes('KICKOFF')) ?? '';
    expect(kickoff).toContain('You are seated at linux-1');
    expect(kickoff).toContain('/Users/jasper/Code/foo (read-write)');
    expect(kickoff).toContain('Your task: fix the failing test');
    expect(kickoff).toContain('Use pnpm.');
    expect(
      w.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'sat_at_pc'),
    ).toBe(true);
    // The PreToolUse input now carries Opus's applied effort.
    const bash = await q.callTool('mcp__pc__bash', { command: 'npm test', description: 'run tests' });
    expect(bash.kind).toBe('allowed');
    expect(w.pcs.execs[0]?.request).toMatchObject({ tag: `${id}:0`, cwd: '/Users/jasper/Code/foo' });
    expect(w.manager.brain(id)?.lastEffort).toBe('medium');
    // Movement is denied while seated.
    expect(await q.callTool('mcp__mc__goto', { entity: 'player' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/stand up first/),
    });
  });

  it('refuses typed pre-check failures: PC down, seat cap, occupied by the player', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'sit');
    w.pcs.setStatus('linux-1', 'booting');
    expect(resultText(await q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'x' }))).toMatch(
      /PC_DOWN/,
    );
    w.pcs.setStatus('linux-1', 'running');
    w.manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'player' } });
    expect(resultText(await q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'x' }))).toMatch(
      /OCCUPIED_BY_PLAYER/,
    );
    expect(resultText(await q.callTool('mcp__mc__sit_at_pc', { pc: 'nope', purpose: 'x' }))).toMatch(
      /PC_UNKNOWN/,
    );
    expect(w.manager.brain(id)?.fsm.state).toBe('wandering');
  });

  it('a failed sit job returns to wandering with a new epoch', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'sit');
    const calling = q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'x' });
    await w.until(() => w.skills.seats.length > 0, 'agent.seat');
    w.skills.finish((w.skills.seats[0] as { jobId: string }).jobId, {
      status: 'failed',
      code: 'UNREACHABLE',
      msg: 'no path',
    });
    expect(resultText(await calling)).toMatch(/UNREACHABLE.*no path/);
    expect(w.manager.brain(id)?.fsm.snapshot).toMatchObject({ state: 'wandering', epoch: 1 });
  });
});

describe('plan-first: plan mode, PlanCapture and the plan card', () => {
  it('enters plan mode after the swap; the plan file becomes the card; approve → back to bypassPermissions', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor the parser');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect(q.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual(['plan']);
    expect(w.texts(q).find((t) => t.includes('KICKOFF'))).toContain('Plan first');
    // Read-only in plan mode, except the plan file (captured in memory, never written to the PC).
    expect(
      await q.callTool('mcp__pc__edit', {
        file_path: '/Users/jasper/Code/foo/a.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/Plan mode/),
    });
    expect(await q.callTool('mcp__pc__key', { keys: 'ctrl+s' })).toMatchObject({ kind: 'denied' });
    const ro = await q.callTool('mcp__pc__bash', { command: 'git status' });
    expect(ro).toMatchObject({ kind: 'allowed', context: expect.stringMatching(/read-only/) });
    const plan = '# Plan\n1. Add a failing test\n2. Fix the tokenizer';
    expect(
      (
        await q.callTool('mcp__pc__write', {
          file_path: '/Users/jasper/.claude/plans/parser.md',
          content: plan,
        })
      ).kind,
    ).toBe('allowed');
    expect(w.pcs.files('linux-1').has('/Users/jasper/.claude/plans/parser.md')).toBe(false);
    const exiting = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan });
    expect(w.manager.brain(id)?.status).toBe('waiting_player');
    // A question to an agent with a pending plan is delivered, not a Revise.
    const question = await w.manager.deliverChat({ to: 'all', text: '@ada why the tokenizer?' });
    expect(question.answeredCard).toBeNull();
    const res = await w.manager.deliverChat({ to: 'all', text: '@ada approve' });
    expect(res.echo).toBe('You → Ada: plan approved');
    expect(await exiting).toMatchObject({ kind: 'allowed' });
    expect(q.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual([
      'plan',
      'bypassPermissions',
    ]);
    expect(
      (
        await q.callTool('mcp__pc__edit', {
          file_path: '/Users/jasper/Code/foo/a.ts',
          old_string: 'x',
          new_string: 'y',
        })
      ).kind,
    ).toBe('allowed');
  });

  it('Revise keeps plan mode and denies ExitPlanMode with the feedback', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    await q.callTool('mcp__pc__write', { file_path: '/Users/jasper/.claude/plans/p.md', content: '# Plan' });
    const exiting = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada use tabs, not spaces' })).echo).toMatch(
      /revise plan/,
    );
    expect(await exiting).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/Jasper wants changes to the plan: use tabs, not spaces/),
    });
    expect(w.manager.brain(id)?.trackedMode).toBe('plan');
  });
});

describe('plan-first: a plan stated in prose (DEBT "a plan card without a plan")', () => {
  it('without a plan file the card shows what the agent last said in its turn; a revise asks for the plan again', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor the parser');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    // Words from an earlier turn never become the plan.
    expect(w.manager.brain(id)?.turnText.latest()).toBeNull();
    q.assistantText('Let me look at the tokenizer first.');
    // The CLI streams each tool_use before it runs the tool.
    q.assistantToolUse('mcp__pc__bash', { command: 'git status' });
    expect((await q.callTool('mcp__pc__bash', { command: 'git status' })).kind).toBe('allowed');
    const plan = 'Plan:\n1. Add a failing test for nested quotes\n2. Fix the tokenizer\n3. Run the suite';
    q.assistantText(plan);
    q.assistantToolUse('ExitPlanMode', {});
    const exiting = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan });
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada also cover escapes' })).echo).toMatch(
      /revise plan/,
    );
    const denied = await exiting;
    expect(denied).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/also cover escapes/) });
    expect(denied.kind === 'denied' ? denied.reason : '').toMatch(
      /~\/\.claude\/plans\/ \(or state it in full\)/,
    );

    // The revised plan, stated again in the same turn, is the next card.
    const revised = `${plan}\n4. Cover escapes`;
    q.assistantText(revised);
    const again = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'second plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan: revised });
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada approve' })).echo).toBe(
      'You → Ada: plan approved',
    );
    expect(await again).toMatchObject({ kind: 'allowed' });
    q.result();
    await w.until(() => w.manager.brain(id)?.turnText.latest() === null, 'turn text cleared');
  });

  it('a plan file written in the turn still wins over the prose around it', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor the parser');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    q.assistantToolUse('mcp__pc__write', {
      file_path: '/Users/jasper/.claude/plans/p.md',
      content: '# The plan',
    });
    await q.callTool('mcp__pc__write', {
      file_path: '/Users/jasper/.claude/plans/p.md',
      content: '# The plan',
    });
    q.assistantText('I wrote the plan to ~/.claude/plans/p.md.');
    const exiting = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan: '# The plan' });
    await w.manager.deliverChat({ to: 'all', text: '@ada approve' });
    expect(await exiting).toMatchObject({ kind: 'allowed' });
  });
});

describe('USER DECISION 2026-10-08: bypassPermissions, no automatic plan mode', () => {
  it('runs in bypassPermissions; Plan-first is off, so sitting never enters plan mode', async () => {
    const { w, id, q } = await world();
    expect(q.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(q.options.tools).not.toContain('EnterPlanMode');
    expect(w.manager.listAgents()[0]).toMatchObject({ role: 'ceo', planFirst: false });
    expect(w.manager.brain(id)?.trackedMode).toBe('bypassPermissions');
    await wake(w, q, 'fix the parser');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect(q.calls.filter((c) => c.method === 'setPermissionMode')).toEqual([]);
    expect(w.texts(q).find((t) => t.includes('KICKOFF'))).not.toContain('Plan first');
    // The agent cannot put itself into plan mode, and there is no plan to exit.
    expect(await q.callTool('EnterPlanMode', {})).toMatchObject({
      kind: 'denied',
      by: 'gate',
      reason: expect.stringMatching(/Plan-first/),
    });
    expect(await q.callTool('ExitPlanMode', {})).toMatchObject({ kind: 'denied', by: 'gate' });
    expect(w.manager.pendingCards()).toEqual([]);
    // Seated work runs straight away (the gate allows; nothing waits on a permission prompt).
    expect(
      (await q.callTool('mcp__pc__write', { file_path: '/Users/jasper/Code/foo/a.ts', content: 'x' })).kind,
    ).toBe('allowed');
    expect(w.manager.brain(id)?.trackedMode).toBe('bypassPermissions');
  });

  it('loads records saved under the old role default with Plan-first off; a player toggle survives', () => {
    const base = {
      agentId: 'ada1',
      handle: 'ada',
      name: 'Ada',
      role: 'ceo' as const,
      ceo: true,
      status: 'alive' as const,
      hiredAt: 0,
      seniority: 1,
      sessionId: 's',
      sessionStarted: true,
      nonce: 'n',
      autonomy: 'listen' as const,
      pingInstead: false,
    };
    expect(migratePlanFirst({ ...base, planFirst: true }).planFirst).toBe(false);
    expect(migratePlanFirst({ ...base, planFirst: true, planFirstByPlayer: true }).planFirst).toBe(true);
    expect(migratePlanFirst({ ...base, planFirst: false, planFirstByPlayer: true }).planFirst).toBe(false);
  });

  it('the AgentScreen toggle turns Plan-first on and marks it as the player’s choice', async () => {
    const { w, id } = await world();
    await w.manager.command(id, { cmd: 'plan_first', on: true });
    expect(w.manager.listAgents()[0]).toMatchObject({ planFirst: true });
    expect(w.manager.brain(id)?.record).toMatchObject({ planFirst: true, planFirstByPlayer: true });
  });
});

describe('stand up, debounce and kick', () => {
  it('stand → back to Haiku/xhigh after the 60 s debounce (no swap for a quick re-sit)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect(resultText(await q.callTool('mcp__mc__stand_up', {}))).toMatch(/Stood up from linux-1/);
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'stand', keepReservation: false, seatEpoch: 0 });
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'stand',
      reserved: false,
    });
    expect(w.manager.brain(id)?.fsm.snapshot).toMatchObject({ state: 'standing_pending_swap', epoch: 1 });
    // pc tools stop at once.
    expect(await q.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
    q.result();
    await w.until(() => w.manager.brain(id)?.fsm.state === 'wandering', 'wandering');
    expect(flagCalls(q)).toEqual([{ model: 'claude-opus-5-5', effortLevel: 'medium' }]);
    expect(w.manager.brain(id)?.model).toBe('opus');
    vi.advanceTimersByTime(61_000);
    await w.until(() => flagCalls(q).length === 2, 'downswap');
    expect(flagCalls(q)[1]).toEqual({ model: 'claude-haiku-5-5', effortLevel: 'xhigh' });
    expect(w.manager.brain(id)?.model).toBe('haiku');
  });

  it('a quick re-sit within the debounce skips the swap', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    await q.callTool('mcp__mc__stand_up', {});
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'stand',
      reserved: false,
    });
    q.result();
    await w.until(() => w.manager.brain(id)?.fsm.state === 'wandering', 'wandering');
    await wake(w, q, 'one more thing');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).filter((t) => t.includes('KICKOFF')).length === 2, 'second kickoff');
    expect(flagCalls(q)).toEqual([{ model: 'claude-opus-5-5', effortLevel: 'medium' }]);
  });

  it('kick: interrupt, kill the tagged guest processes, deny the plan card, Haiku at once, [KICKED] wake', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    await q.callTool('mcp__pc__write', { file_path: '/Users/jasper/.claude/plans/p.md', content: '# Plan' });
    const exiting = q.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    const kills: unknown[] = [];
    const kill = w.pcs.kill.bind(w.pcs);
    w.pcs.kill = async (pcId, target) => {
      kills.push({ pcId, target });
      return kill(pcId, target);
    };
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'kick',
      reserved: false,
    });
    await w.until(() => q.interrupted === 1, 'interrupt');
    expect(await exiting).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/kick/) });
    expect(kills).toEqual([{ pcId: 'linux-1', target: { tag: `${id}:0` } }]);
    expect(w.manager.pendingCards()).toEqual([]);
    expect(w.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'kicked')).toBe(
      true,
    );
    q.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => w.texts(q).some((t) => t.includes('KICKED')), 'kicked wake');
    expect(flagCalls(q).at(-1)).toEqual({ model: 'claude-haiku-5-5', effortLevel: 'xhigh' });
    expect(q.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual([
      'plan',
      'bypassPermissions',
    ]);
    expect(w.texts(q).find((t) => t.includes('KICKED'))).toContain('Jasper kicked you off linux-1 mid-task');
    expect(w.manager.brain(id)?.fsm.snapshot).toMatchObject({ state: 'wandering', epoch: 1 });
  });

  it("context guard: compacts before an Opus → Haiku swap when the context is over 70% of Haiku's window", async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'big job');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'pc_down',
      reserved: false,
    });
    await w.until(() => q.interrupted === 1, 'interrupt');
    q.result({
      usage: {
        input_tokens: 120_000,
        output_tokens: 5_000,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 0,
      },
    });
    await w.until(() => w.texts(q).includes('/compact'), 'compact');
    expect(flagCalls(q)).toHaveLength(1);
    q.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 155_000 },
      uuid: 'c',
      session_id: 's',
    } as never);
    q.result({
      usage: {
        input_tokens: 2_000,
        output_tokens: 300,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    await w.until(() => flagCalls(q).length === 2, 'downswap');
    expect(flagCalls(q)[1]).toEqual({ model: 'claude-haiku-5-5', effortLevel: 'xhigh' });
    await w.until(() => w.texts(q).some((t) => t.includes('PC DOWN')), 'pc down wake');
  });

  it('an in-flight pc call allowed before a kick is refused after it (seat epoch)', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'clean');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    const hook = await q.preToolUse('mcp__pc__bash', { command: 'rm -rf build' });
    expect(hook.hookSpecificOutput?.permissionDecision).toBe('allow');
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'kick',
      reserved: false,
    });
    await w.until(() => w.manager.brain(id)?.fsm.epoch === 1, 'epoch');
    type Handler = (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
    const pcServer = q.options.mcpServers?.pc as unknown as {
      instance: { _registeredTools: Record<string, { handler: Handler }> };
    };
    const tools = pcServer.instance._registeredTools;
    const res = await tools.bash?.handler({ command: 'rm -rf build' }, {});
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toMatch(/Not seated/);
    expect(w.pcs.execs).toHaveLength(0);
  });

  it('the AgentScreen Kick button unseats through the mod', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    expect((await w.manager.command(id, { cmd: 'kick' })).echo).toBe('Kicked Ada off linux-1');
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'kick', keepReservation: false });
    await w.until(() => flagCalls(q).length === 2, 'downswap');
    expect(flagCalls(q)[1]).toEqual({ model: 'claude-haiku-5-5', effortLevel: 'xhigh' });
  });

  it('away from the seat: Opus stays, pc tools pause, the answer brings the agent back without a swap', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    await sit(w, q, id);
    q.result();
    await w.until(() => w.texts(q).some((t) => t.includes('KICKOFF')), 'kickoff');
    const brain = w.manager.brain(id);
    expect(await brain?.goAway()).toBe(true);
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'away', keepReservation: true });
    expect(await q.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/away/),
    });
    expect(brain?.model).toBe('opus');
    expect(await brain?.comeBack()).toBe(true);
    expect(brain?.fsm.snapshot).toMatchObject({ state: 'seated', epoch: 0 });
    expect((await q.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
    expect(flagCalls(q)).toHaveLength(1);
  });
});

describe('BrainScheduler with a crew', () => {
  it('runs at most 2 work turns while a P0 message still gets through', async () => {
    const { w, id, q } = await world();
    const hire = async (role: string) => {
      await wake(w, q, `hire a ${role}`);
      await q.callTool('mcp__mc__request_hire', { role, reason: 'help', first_task: `be a ${role}` });
      q.result();
      await w.until(() => w.manager.brain(id)?.status !== 'thinking', 'ceo done');
      const card = w.manager.pendingCards().find((c) => c.kind === 'hire');
      await w.manager.answerCard(card?.id ?? '', { kind: 'approve' });
    };
    await hire('miner');
    await w.until(() => w.texts(q).some((t) => t.includes('HIRE APPROVED')), 'approved');
    q.result();
    await hire('farmer');
    const [, bram, cleo] = w.manager.listAgents();
    const bq = w.queryOf(bram?.agentId ?? '');
    const cq = w.queryOf(cleo?.agentId ?? '');
    // Both new agents run their welcome turns (P1): the work lane is full, so the CEO's P3 [HIRE APPROVED] waits.
    await w.until(
      () => w.texts(bq).some((t) => t.includes('WELCOME')) && w.texts(cq).some((t) => t.includes('WELCOME')),
      'welcomes',
    );
    expect(w.manager.brainsSummary()).toMatchObject({ inFlight: 2, queued: 1, max: 3 });
    expect(w.manager.brain(id)?.status).toBe('queued');
    // A P0 player message to the CEO still gets through, on the interactive lane (merged with its queued wake).
    await wake(w, q, 'status?');
    expect(w.manager.scheduler.grantOf(id)?.lane).toBe('interactive');
    expect(w.manager.brainsSummary()).toMatchObject({ inFlight: 3, queued: 0 });
    expect(w.texts(q).at(-1)).toContain('HIRE APPROVED');
  });
});
