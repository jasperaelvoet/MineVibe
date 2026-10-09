import { afterEach, describe, expect, it, vi } from 'vitest';
import { migratePlanFirst } from '../../../src/agents/AgentManager.js';
import type { Harness } from '../../helpers/agentHarness.js';
import { freshWorld, sitAtDesk, wake } from '../../helpers/desk.js';
import { resultText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

/** A fresh world whose CEO is idle; `planFirst` is turned on (the player's toggle) only when asked. */
async function world(options: { planFirst?: boolean } = {}) {
  const r = await freshWorld();
  h = r.w;
  // USER DECISION 2026-10-08: Plan-first is off by default; only the player's toggle turns it on.
  if (options.planFirst) await r.w.manager.command(r.id, { cmd: 'plan_first', on: true });
  return r;
}

describe('sit at a PC (PLAN §6.3 "Sitting")', () => {
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

  it('a failed sit job returns to wandering with a new epoch and opens no desk', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'sit');
    const queries = w.factory.queries.length;
    const calling = q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'x' });
    await w.until(() => w.skills.seats.length > 0, 'agent.seat');
    w.skills.finish((w.skills.seats[0] as { jobId: string }).jobId, {
      status: 'failed',
      code: 'UNREACHABLE',
      msg: 'no path',
    });
    expect(resultText(await calling)).toMatch(/UNREACHABLE.*no path/);
    expect(w.manager.brain(id)?.fsm.snapshot).toMatchObject({ state: 'wandering', epoch: 1 });
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    expect(w.factory.queries.length).toBe(queries);
    expect(w.manager.brain(id)?.activeSession).toBe('body');
  });
});

describe('plan-first: plan mode, PlanCapture and the plan card (desk session)', () => {
  it('Revise keeps plan mode and denies ExitPlanMode with the feedback', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor');
    const d = await sitAtDesk(w, q, id);
    await d.callTool('mcp__pc__write', { file_path: '/Users/jasper/.claude/plans/p.md', content: '# Plan' });
    expect(w.pcs.files('linux-1').has('/Users/jasper/.claude/plans/p.md')).toBe(false);
    const exiting = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    // A question to an agent with a pending plan is delivered, not a Revise.
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada why tabs?' })).answeredCard).toBeNull();
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada use tabs, not spaces' })).echo).toMatch(
      /revise plan/,
    );
    expect(await exiting).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/Jordan wants changes to the plan: use tabs, not spaces/),
    });
    expect(w.manager.brain(id)?.trackedMode).toBe('plan');
    // Read-only in plan mode, except the plan file; bash is allowed with the read-only note.
    expect(await d.callTool('mcp__pc__key', { keys: 'ctrl+s' })).toMatchObject({ kind: 'denied' });
    expect(await d.callTool('mcp__pc__bash', { command: 'git status' })).toMatchObject({
      kind: 'allowed',
      context: expect.stringMatching(/read-only/),
    });
  });

  it('without a plan file the card shows what the agent last said in its turn; a revise asks for the plan again', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor the parser');
    const d = await sitAtDesk(w, q, id);
    // Words from an earlier turn (the body's) never become the plan.
    expect(w.manager.brain(id)?.turnText.latest()).toBeNull();
    d.assistantText('Let me look at the tokenizer first.');
    // The CLI streams each tool_use before it runs the tool.
    d.assistantToolUse('mcp__pc__bash', { command: 'git status' });
    expect((await d.callTool('mcp__pc__bash', { command: 'git status' })).kind).toBe('allowed');
    const plan = 'Plan:\n1. Add a failing test for nested quotes\n2. Fix the tokenizer\n3. Run the suite';
    d.assistantText(plan);
    d.assistantToolUse('ExitPlanMode', {});
    const exiting = d.callTool('ExitPlanMode', {});
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
    d.assistantText(revised);
    const again = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'second plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan: revised });
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada approve' })).echo).toBe(
      'You → Ada: plan approved',
    );
    expect(await again).toMatchObject({ kind: 'allowed' });
    expect(
      (
        await d.callTool('mcp__pc__edit', {
          file_path: '/Users/jasper/Code/foo/a.ts',
          old_string: 'x',
          new_string: 'y',
        })
      ).kind,
    ).toBe('allowed');
    d.result();
    await w.until(() => w.manager.brain(id)?.turnText.latest() === null, 'turn text cleared');
  });

  it('a plan file written in the turn still wins over the prose around it', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor the parser');
    const d = await sitAtDesk(w, q, id);
    d.assistantToolUse('mcp__pc__write', {
      file_path: '/Users/jasper/.claude/plans/p.md',
      content: '# The plan',
    });
    await d.callTool('mcp__pc__write', {
      file_path: '/Users/jasper/.claude/plans/p.md',
      content: '# The plan',
    });
    d.assistantText('I wrote the plan to ~/.claude/plans/p.md.');
    const exiting = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan: '# The plan' });
    await w.manager.deliverChat({ to: 'all', text: '@ada approve' });
    expect(await exiting).toMatchObject({ kind: 'allowed' });
  });

  it('plan-first applies to every sit, also a resumed desk session', async () => {
    const { w, id, q } = await world({ planFirst: true });
    await wake(w, q, 'refactor');
    const d1 = await sitAtDesk(w, q, id);
    expect(d1.options.permissionMode).toBe('plan');
    await d1.callTool('mcp__mc__stand_up', {});
    d1.result();
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    await wake(w, q, 'again');
    const d2 = await sitAtDesk(w, q, id);
    expect(d2.options.resume).toBeDefined();
    expect(d2.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual(['plan']);
    expect(w.texts(d2).find((t) => t.includes('KICKOFF'))).toContain('Plan first');
    expect(w.manager.brain(id)?.trackedMode).toBe('plan');
  });
});

describe('USER DECISION 2026-10-08: bypassPermissions, no automatic plan mode', () => {
  it('both sessions run in bypassPermissions; Plan-first is off, so sitting never enters plan mode', async () => {
    const { w, id, q } = await world();
    expect(q.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(q.options.tools).not.toContain('EnterPlanMode');
    expect(w.manager.listAgents()[0]).toMatchObject({ role: 'ceo', planFirst: false });
    expect(w.manager.brain(id)?.trackedMode).toBe('bypassPermissions');
    await wake(w, q, 'fix the parser');
    const d = await sitAtDesk(w, q, id);
    expect(d.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(d.options.tools).not.toContain('ExitPlanMode');
    expect(d.calls.filter((c) => c.method === 'setPermissionMode')).toEqual([]);
    expect(w.texts(d).find((t) => t.includes('KICKOFF'))).not.toContain('Plan first');
    // The agent cannot put itself into plan mode, and there is no plan to exit.
    expect(await d.callTool('EnterPlanMode', {})).toMatchObject({
      kind: 'denied',
      by: 'gate',
      reason: expect.stringMatching(/Plan-first/),
    });
    expect(await d.callTool('ExitPlanMode', {})).toMatchObject({ kind: 'denied', by: 'gate' });
    expect(w.manager.pendingCards()).toEqual([]);
    // Seated work runs straight away (the gate allows; nothing waits on a permission prompt).
    expect(
      (await d.callTool('mcp__pc__write', { file_path: '/Users/jasper/Code/foo/a.ts', content: 'x' })).kind,
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

describe('stand up, kick and away (PLAN §6.3, §6.4)', () => {
  it('stand_up unseats through the mod; the epoch moves on and pc tools stop at once', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    expect(resultText(await d.callTool('mcp__mc__stand_up', {}))).toMatch(/Stood up from linux-1/);
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'stand', keepReservation: false, seatEpoch: 0 });
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'stand',
      reserved: false,
    });
    expect(w.manager.brain(id)?.fsm.snapshot).toMatchObject({ state: 'standing_pending_handoff', epoch: 1 });
    expect(await d.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
    d.result();
    await w.until(() => w.manager.brain(id)?.fsm.state === 'wandering', 'wandering');
    expect(w.manager.brain(id)?.model).toBe('haiku');
  });

  it('an in-flight pc call allowed before a kick is refused after it (seat epoch)', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'clean');
    const d = await sitAtDesk(w, q, id);
    const hook = await d.preToolUse('mcp__pc__bash', { command: 'rm -rf build' });
    expect(hook.hookSpecificOutput?.permissionDecision).toBe('allow');
    w.manager.onPcUnseat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      reason: 'kick',
      reserved: false,
    });
    await w.until(() => w.manager.brain(id)?.fsm.epoch === 1, 'epoch');
    type Handler = (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
    const pcServer = d.options.mcpServers?.pc as unknown as {
      instance: { _registeredTools: Record<string, { handler: Handler }> };
    };
    const res = await pcServer.instance._registeredTools.bash?.handler({ command: 'rm -rf build' }, {});
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toMatch(/Not seated/);
    expect(w.pcs.execs).toHaveLength(0);
  });

  it('away from the seat: the desk session waits (pc tools pause), the answer brings the agent back', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    const d = await sitAtDesk(w, q, id);
    const brain = w.manager.brain(id);
    expect(await brain?.goAway()).toBe(true);
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'away', keepReservation: true });
    expect(await d.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/away/),
    });
    expect(brain?.activeSession).toBe('desk');
    expect(brain?.model).toBe('opus');
    expect(await brain?.comeBack()).toBe(true);
    expect(brain?.fsm.snapshot).toMatchObject({ state: 'seated', epoch: 0 });
    expect((await d.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
    expect(d.closed).toBe(false);
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

  it('one slot per agent: a desk turn and the body never run at once', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    expect(w.manager.brain(id)?.status).toBe('thinking');
    expect(w.manager.brainsSummary()).toMatchObject({ inFlight: 1 });
    // A card wait releases the slot, as before.
    const asking = d.callTool('AskUserQuestion', {
      questions: [
        {
          question: 'Rebase or merge?',
          options: [{ label: 'Rebase' }, { label: 'Merge' }],
          multiSelect: false,
        },
      ],
    });
    await w.until(() => w.manager.brainsSummary().inFlight === 0, 'slot released');
    await w.manager.deliverChat({ to: 'all', text: '@ada 1' });
    expect(await asking).toMatchObject({ kind: 'allowed' });
    await w.until(() => w.manager.brainsSummary().inFlight === 1, 'slot back');
    expect(q.closed).toBe(false);
    expect(q.sent.at(-1)?.shouldQuery).not.toBe(true);
  });
});
