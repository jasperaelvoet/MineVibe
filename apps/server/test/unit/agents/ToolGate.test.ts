import { describe, expect, it } from 'vitest';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { SeatFSM, type SeatSnapshot } from '../../../src/agents/SeatFSM.js';
import {
  checkWebTarget,
  createToolGateHook,
  decideTool,
  type GateContext,
  isPrivateAddress,
} from '../../../src/agents/ToolGate.js';
import { MC_TOOLS, PC_TOOLS } from '../../../src/agents/tools/catalog.js';

const HOME = '/Users/jasper';

function seat(
  state: 'wandering' | 'walking' | 'pending' | 'seated' | 'away' | 'standing' | 'meeting',
): SeatSnapshot {
  const fsm = new SeatFSM({ now: () => 1000 });
  if (state === 'wandering') return fsm.snapshot;
  if (state === 'meeting') {
    fsm.beginSit({ kind: 'meeting', meetingId: 'm1' });
    fsm.arrived();
    return fsm.snapshot;
  }
  fsm.beginSit({ kind: 'pc', pcId: 'linux-1' }, { purpose: 'fix tests' });
  if (state === 'walking') return fsm.snapshot;
  fsm.arrived();
  if (state === 'pending') return fsm.snapshot;
  fsm.boundary();
  if (state === 'seated') return fsm.snapshot;
  if (state === 'away') {
    fsm.goAway();
    return fsm.snapshot;
  }
  fsm.stand('stand');
  return fsm.snapshot;
}

function ctx(overrides: Partial<GateContext> & { state?: Parameters<typeof seat>[0] } = {}): GateContext {
  const { state, ...rest } = overrides;
  return {
    agentId: 'ada-1',
    ceo: false,
    seat: seat(state ?? 'wandering'),
    occupant: (pcId) => (pcId === 'linux-1' ? 'ada-1' : null),
    trackedMode: 'default',
    plans: new PlanCapture([HOME]),
    turn: { calls: 0, activeMs: 0 },
    playerName: 'Jasper',
    ...rest,
  };
}

const SDK = { serverSource: 'sdk' } as const;
const decide = (
  tool: string,
  input: Record<string, unknown>,
  c: GateContext,
  extra: Record<string, unknown> = SDK,
) => decideTool(tool, input, c, extra);

describe('ToolGate: wandering vs seated (PLAN §6.2 table)', () => {
  it('allows observe/social/codex/calendar tools in every state but pending swap', async () => {
    for (const state of ['wandering', 'seated', 'away', 'meeting', 'walking'] as const) {
      for (const tool of [
        'status',
        'look_around',
        'say',
        'tell',
        'eat',
        'equip',
        'remember',
        'codex_search',
        'codex_write',
      ]) {
        const d = await decide(`mcp__mc__${tool}`, {}, ctx({ state }));
        expect(d.behavior, `${tool} in ${state}`).toBe('allow');
      }
    }
  });

  it('denies movement, world jobs and sit_at_pc while seated: "stand up first"', async () => {
    for (const tool of ['goto', 'mine', 'craft', 'build', 'sit_at_pc', 'attack']) {
      const d = await decide(`mcp__mc__${tool}`, {}, ctx({ state: 'seated' }));
      expect(d).toMatchObject({ behavior: 'deny', code: 'seated' });
      expect(d.reason).toMatch(/stand up first/);
      expect((await decide(`mcp__mc__${tool}`, {}, ctx())).behavior).toBe('allow');
    }
    expect(await decide('mcp__mc__goto', {}, ctx({ state: 'meeting' }))).toMatchObject({ code: 'meeting' });
    expect(await decide('mcp__mc__goto', {}, ctx({ state: 'away' }))).toMatchObject({ code: 'away' });
    expect(await decide('mcp__mc__goto', {}, ctx({ state: 'walking' }))).toMatchObject({ code: 'walking' });
  });

  it('denies stand_up while wandering and allows it seated', async () => {
    expect(await decide('mcp__mc__stand_up', {}, ctx())).toMatchObject({
      behavior: 'deny',
      code: 'not_seated',
    });
    expect((await decide('mcp__mc__stand_up', {}, ctx({ state: 'seated' }))).behavior).toBe('allow');
    expect((await decide('mcp__mc__stand_up', {}, ctx({ state: 'walking' }))).behavior).toBe('allow');
  });

  it('denies every tool in seated_pending_swap with "end your turn now"', async () => {
    for (const tool of ['mcp__mc__status', 'mcp__mc__goto', 'mcp__pc__bash', 'mcp__pc__read']) {
      const d = await decide(tool, {}, ctx({ state: 'pending' }));
      expect(d).toMatchObject({ behavior: 'deny', code: 'pending_swap' });
      expect(d.reason).toMatch(/End your turn now/);
    }
  });

  it('request_hire is CEO only', async () => {
    expect(await decide('mcp__mc__request_hire', {}, ctx())).toMatchObject({
      behavior: 'deny',
      code: 'ceo_only',
    });
    expect((await decide('mcp__mc__request_hire', {}, ctx({ ceo: true }))).behavior).toBe('allow');
    expect((await decide('mcp__mc__request_hire', {}, ctx({ ceo: true, state: 'seated' }))).behavior).toBe(
      'allow',
    );
  });

  it('calendar: others schedule only for themselves, the CEO for anyone', async () => {
    expect((await decide('mcp__mc__calendar_add', { assignees: ['ada-1'] }, ctx())).behavior).toBe('allow');
    expect(await decide('mcp__mc__calendar_add', { assignees: ['bram-2'] }, ctx())).toMatchObject({
      code: 'self_only',
    });
    expect(await decide('mcp__mc__calendar_add', { assignees: 'all' }, ctx())).toMatchObject({
      code: 'self_only',
    });
    expect((await decide('mcp__mc__calendar_add', { assignees: 'all' }, ctx({ ceo: true }))).behavior).toBe(
      'allow',
    );
    expect((await decide('mcp__mc__calendar_update', { id: 'e1' }, ctx())).behavior).toBe('allow');
    expect(await decide('mcp__mc__calendar_update', { id: 'e1', assignees: ['x'] }, ctx())).toMatchObject({
      code: 'self_only',
    });
    expect((await decide('mcp__mc__report_task', {}, ctx())).behavior).toBe('allow');
    expect((await decide('mcp__mc__calendar_list', {}, ctx())).behavior).toBe('allow');
  });

  it('pc tools: denied while wandering ("walk to a PC and sit"), allowed seated at the occupied PC', async () => {
    for (const tool of PC_TOOLS) {
      const d = await decide(`mcp__pc__${tool}`, {}, ctx());
      expect(d, tool).toMatchObject({ behavior: 'deny', code: 'not_seated' });
      expect(d.reason).toMatch(/sit_at_pc/);
      expect((await decide(`mcp__pc__${tool}`, {}, ctx({ state: 'seated' }))).behavior, tool).toBe('allow');
    }
    expect(await decide('mcp__pc__bash', {}, ctx({ state: 'standing' }))).toMatchObject({
      code: 'not_seated',
    });
    expect(await decide('mcp__pc__bash', {}, ctx({ state: 'away' }))).toMatchObject({ code: 'away' });
    expect(await decide('mcp__pc__bash', {}, ctx({ state: 'walking' }))).toMatchObject({ code: 'walking' });
    expect(await decide('mcp__pc__bash', {}, ctx({ state: 'meeting' }))).toMatchObject({ code: 'meeting' });
  });

  it('pc tools: denied when the PcRegistry says someone else occupies the PC', async () => {
    const c = ctx({ state: 'seated', occupant: () => 'player' });
    expect(await decide('mcp__pc__bash', { command: 'ls' }, c)).toMatchObject({
      behavior: 'deny',
      code: 'not_occupant',
    });
    const nobody = ctx({ state: 'seated', occupant: () => null });
    expect(await decide('mcp__pc__read', {}, nobody)).toMatchObject({ code: 'not_occupant' });
  });

  it('plan mode: denies file and GUI mutators, allows reads and bash with a read-only note', async () => {
    const c = ctx({ state: 'seated', trackedMode: 'plan' });
    for (const tool of ['write', 'edit', 'click', 'double_click', 'right_click', 'drag', 'type', 'key']) {
      expect(
        await decide(`mcp__pc__${tool}`, { file_path: '/Users/jasper/Code/foo/a.ts' }, c),
        tool,
      ).toMatchObject({
        behavior: 'deny',
        code: 'plan_mode',
      });
    }
    expect(await decide('mcp__pc__clipboard', { action: 'set', text: 'x' }, c)).toMatchObject({
      code: 'plan_mode',
    });
    expect((await decide('mcp__pc__clipboard', {}, c)).behavior).toBe('allow');
    for (const tool of ['read', 'glob', 'grep', 'screenshot', 'move', 'scroll', 'info', 'bash_output']) {
      expect((await decide(`mcp__pc__${tool}`, {}, c)).behavior, tool).toBe('allow');
    }
    const bash = await decide('mcp__pc__bash', { command: 'git status' }, c);
    expect(bash).toMatchObject({ behavior: 'allow' });
    expect(bash.behavior === 'allow' && bash.context).toMatch(/read-only/);
  });

  it('plan mode: writes and edits under ~/.claude/plans/ are allowed (PlanCapture)', async () => {
    const c = ctx({ state: 'seated', trackedMode: 'plan' });
    for (const path of [
      `${HOME}/.claude/plans/fix-tests.md`,
      '~/.claude/plans/x.md',
      '/home/cua/.claude/plans/y.md',
    ]) {
      const d = await decide(
        'mcp__pc__write',
        { file_path: path, content: '# plan' },
        ctx({ ...c, plans: new PlanCapture([HOME, '/home/cua']) }),
      );
      expect(d.behavior, path).toBe('allow');
    }
    for (const path of [
      `${HOME}/.claude/plans/../settings.json`,
      `${HOME}/.claude/plans/`,
      `${HOME}/.claude/planz/x.md`,
    ]) {
      expect((await decide('mcp__pc__edit', { file_path: path }, c)).behavior, path).toBe('deny');
    }
  });

  it('input.permission_mode wins over the tracked mode', async () => {
    const c = ctx({ state: 'seated', trackedMode: 'default' });
    expect(
      await decide('mcp__pc__write', { file_path: '/x' }, c, { ...SDK, permissionMode: 'plan' }),
    ).toMatchObject({
      code: 'plan_mode',
    });
    const p = ctx({ state: 'seated', trackedMode: 'plan' });
    expect(
      (await decide('mcp__pc__write', { file_path: '/x' }, p, { ...SDK, permissionMode: 'default' }))
        .behavior,
    ).toBe('allow');
  });

  it('broker tools get no decision; EnterPlanMode only while seated at a PC', async () => {
    expect((await decide('AskUserQuestion', {}, ctx())).behavior).toBe('defer');
    expect((await decide('ExitPlanMode', {}, ctx({ state: 'seated' }))).behavior).toBe('defer');
    expect(await decide('EnterPlanMode', {}, ctx())).toMatchObject({ behavior: 'deny' });
    expect(await decide('EnterPlanMode', {}, ctx({ state: 'meeting' }))).toMatchObject({ behavior: 'deny' });
    expect((await decide('EnterPlanMode', {}, ctx({ state: 'seated' }))).behavior).toBe('defer');
  });

  it('web tools: denied away from a PC; WebFetch denies private targets', async () => {
    expect(await decide('WebSearch', { query: 'x' }, ctx())).toMatchObject({ code: 'web_wandering' });
    expect((await decide('WebSearch', { query: 'x' }, ctx({ state: 'seated' }))).behavior).toBe('allow');
    const resolve = async (h: string) => (h === 'evil.example' ? ['10.0.0.5'] : ['93.184.216.34']);
    const web = { resolve };
    const s = ctx({ state: 'seated' });
    expect((await decide('WebFetch', { url: 'https://example.com/a' }, s, { ...SDK, web })).behavior).toBe(
      'allow',
    );
    for (const url of [
      'http://127.0.0.1:47800/v1',
      'http://localhost:3000',
      'http://192.168.64.1/',
      'http://169.254.169.254/latest',
      'http://[::1]/',
      'http://2130706433/',
      'https://evil.example/',
      'file:///etc/passwd',
      'http://printer.local/',
    ]) {
      expect(await decide('WebFetch', { url }, s, { ...SDK, web }), url).toMatchObject({
        behavior: 'deny',
        code: 'web_private',
      });
    }
  });

  it('denies unknown tools, built-in host tools and untrusted servers (fail closed)', async () => {
    for (const tool of [
      'Bash',
      'Read',
      'Write',
      'Agent',
      'Task',
      'TodoWrite',
      'mcp__mc__teleport',
      'mcp__evil__x',
    ]) {
      expect(await decide(tool, {}, ctx({ state: 'seated' })), tool).toMatchObject({
        behavior: 'deny',
        code: 'unknown_tool',
      });
    }
    expect(await decide('mcp__mc__status', {}, ctx(), { serverSource: 'project' })).toMatchObject({
      code: 'untrusted_server',
    });
  });

  it('per-turn caps: 40 calls / 5 min wandering, 400 / 45 min seated', async () => {
    expect(await decide('mcp__mc__status', {}, ctx({ turn: { calls: 40, activeMs: 0 } }))).toMatchObject({
      code: 'turn_cap',
    });
    expect((await decide('mcp__mc__status', {}, ctx({ turn: { calls: 39, activeMs: 0 } }))).behavior).toBe(
      'allow',
    );
    expect(
      await decide('mcp__mc__status', {}, ctx({ turn: { calls: 1, activeMs: 5 * 60_000 } })),
    ).toMatchObject({ code: 'turn_cap' });
    expect(
      (
        await decide(
          'mcp__pc__bash',
          {},
          ctx({ state: 'seated', turn: { calls: 399, activeMs: 44 * 60_000 } }),
        )
      ).behavior,
    ).toBe('allow');
    expect(
      await decide('mcp__pc__bash', {}, ctx({ state: 'seated', turn: { calls: 400, activeMs: 0 } })),
    ).toMatchObject({ code: 'turn_cap' });
  });

  it('every catalog mc tool has a category the gate understands', async () => {
    for (const tool of Object.keys(MC_TOOLS)) {
      const d = await decide(`mcp__mc__${tool}`, { assignees: ['ada-1'] }, ctx({ ceo: true }));
      expect(['allow', 'deny']).toContain(d.behavior);
      if (tool !== 'stand_up') expect(d.behavior, tool).toBe('allow');
    }
  });
});

describe('ToolGate hook', () => {
  it('returns explicit decisions, nothing for broker tools, and denies on errors', async () => {
    const seen: string[] = [];
    let c = ctx();
    const hook = createToolGateHook(
      () => c,
      (o) => seen.push(`${o.toolName}:${o.decision.behavior}:${o.effort}`),
    );
    const call = (tool_name: string) =>
      hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 's',
          transcript_path: '/t',
          cwd: '/',
          permission_mode: 'default',
          effort: { level: 'xhigh' },
          tool_name,
          tool_input: {},
          tool_use_id: 'u1',
          mcp_server: { name: 'mc', source: 'sdk' },
        } as never,
        'u1',
        { signal: new AbortController().signal },
      );
    expect(await call('mcp__mc__status')).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(await call('AskUserQuestion')).toEqual({});
    expect(await call('mcp__pc__bash')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(seen).toEqual([
      'mcp__mc__status:allow:xhigh',
      'AskUserQuestion:defer:xhigh',
      'mcp__pc__bash:deny:xhigh',
    ]);
    c = new Proxy(c, {
      get() {
        throw new Error('boom');
      },
    });
    expect(await call('mcp__mc__status')).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/boom/),
      },
    });
  });
});

describe('WebFetch target checks', () => {
  it('classifies private and public addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.0.1',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(a), a).toBe(false);
  });

  it('fails closed on unresolvable hosts and credentials in URLs', async () => {
    expect(
      await checkWebTarget('https://nowhere.example/', {
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await checkWebTarget('https://a:b@example.com/', { resolve: async () => ['1.1.1.1'] }),
    ).toMatchObject({ ok: false });
    expect(await checkWebTarget(42)).toMatchObject({ ok: false });
    expect(
      await checkWebTarget('https://example.com/', { resolve: async () => ['1.1.1.1', '127.0.0.1'] }),
    ).toMatchObject({ ok: false });
  });
});
