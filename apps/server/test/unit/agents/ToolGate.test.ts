import { describe, expect, it } from 'vitest';
import { PlanCapture } from '../../../src/agents/PlanCapture.js';
import { SeatFSM, type SeatSnapshot } from '../../../src/agents/SeatFSM.js';
import {
  checkWebTarget,
  createToolGateHook,
  decideTool,
  type GateContext,
  isPrivateAddress,
  networkScanIn,
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
    trackedMode: 'bypassPermissions',
    plans: new PlanCapture([HOME]),
    turn: { calls: 0, activeMs: 0 },
    playerName: 'Jordan',
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
  it('allows observe/social/codex/calendar tools in every state but pending swap, within the mode', async () => {
    // Mode profiles (agents/modes.ts): PC mode keeps status/look_around, social, memory and Codex; Meeting mode keeps
    // social, memory and Codex. Everything else of the "always" rows is a Minecraft-mode tool.
    const inMode: Record<string, readonly string[]> = {
      wandering: [
        'status',
        'look_around',
        'say',
        'tell',
        'eat',
        'equip',
        'remember',
        'codex_search',
        'codex_write',
      ],
      walking: [
        'status',
        'look_around',
        'say',
        'tell',
        'eat',
        'equip',
        'remember',
        'codex_search',
        'codex_write',
      ],
      seated: ['status', 'look_around', 'say', 'tell', 'remember', 'codex_search', 'codex_write'],
      away: ['status', 'look_around', 'say', 'tell', 'remember', 'codex_search', 'codex_write'],
      meeting: ['say', 'tell', 'remember', 'codex_search', 'codex_write'],
    };
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
        if (inMode[state]?.includes(tool)) expect(d.behavior, `${tool} in ${state}`).toBe('allow');
        else expect(d, `${tool} in ${state}`).toMatchObject({ behavior: 'deny', code: 'mode' });
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

  it('denies every tool in seated_pending_handoff with "end your turn now"', async () => {
    for (const tool of ['mcp__mc__status', 'mcp__mc__goto', 'mcp__pc__bash', 'mcp__pc__read']) {
      const d = await decide(tool, {}, ctx({ state: 'pending' }));
      expect(d).toMatchObject({ behavior: 'deny', code: 'pending_handoff' });
      expect(d.reason).toMatch(/End your turn now/);
    }
  });

  it('request_hire is CEO only', async () => {
    expect(await decide('mcp__mc__request_hire', {}, ctx())).toMatchObject({
      behavior: 'deny',
      code: 'ceo_only',
    });
    expect((await decide('mcp__mc__request_hire', {}, ctx({ ceo: true }))).behavior).toBe('allow');
    // Hiring is a Minecraft-mode tool: a seated CEO stands up first.
    expect(await decide('mcp__mc__request_hire', {}, ctx({ ceo: true, state: 'seated' }))).toMatchObject({
      behavior: 'deny',
      code: 'mode',
    });
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
    for (const tool of [
      'write',
      'edit',
      'left_click',
      'right_click',
      'middle_click',
      'double_click',
      'triple_click',
      'left_click_drag',
      'left_mouse_down',
      'left_mouse_up',
      'type',
      'key',
      'hold_key',
      'ui_act',
      'open',
    ]) {
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
    for (const tool of [
      'read',
      'glob',
      'grep',
      'screenshot',
      'zoom',
      'cursor_position',
      'mouse_move',
      'scroll',
      'wait',
      'ui',
      'wait_for',
      'info',
      'task_stop',
    ]) {
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

  it('broker tools get no decision; ExitPlanMode only in plan mode; EnterPlanMode never (USER DECISION 2026-10-08)', async () => {
    expect((await decide('AskUserQuestion', {}, ctx())).behavior).toBe('defer');
    expect((await decide('AskUserQuestion', {}, ctx({ state: 'seated' }))).behavior).toBe('defer');
    // A plan-first session (the player's toggle) is in plan mode: ExitPlanMode reaches the broker.
    const planning = ctx({ state: 'seated', trackedMode: 'plan' });
    expect((await decide('ExitPlanMode', {}, planning)).behavior).toBe('defer');
    expect(
      (await decide('ExitPlanMode', {}, ctx({ state: 'seated' }), { ...SDK, permissionMode: 'plan' }))
        .behavior,
    ).toBe('defer');
    // Outside plan mode there is no plan to approve (the CLI's own mode wins over the tracked one).
    expect(await decide('ExitPlanMode', {}, ctx({ state: 'seated' }))).toMatchObject({
      code: 'no_plan_mode',
    });
    expect(
      await decide('ExitPlanMode', {}, planning, { ...SDK, permissionMode: 'bypassPermissions' }),
    ).toMatchObject({ code: 'no_plan_mode' });
    // Agents never put themselves into plan mode, wherever they are.
    for (const state of ['wandering', 'seated', 'meeting'] as const) {
      expect(await decide('EnterPlanMode', {}, ctx({ state })), state).toMatchObject({
        behavior: 'deny',
        code: 'no_plan_mode',
      });
    }
  });

  it('decides every mc/pc call explicitly under bypassPermissions (an undecided call would be auto-allowed)', async () => {
    const bypass = { ...SDK, permissionMode: 'bypassPermissions' };
    for (const state of ['wandering', 'seated', 'away', 'meeting'] as const) {
      for (const tool of [
        'mcp__mc__status',
        'mcp__mc__sit_at_pc',
        'mcp__pc__bash',
        'mcp__pc__write',
        'WebFetch',
      ]) {
        const d = await decide(
          tool,
          { command: 'ls', file_path: '/x', url: 'https://example.com' },
          ctx({ state }),
          bypass,
        );
        expect(d.behavior, `${tool} ${state}`).not.toBe('defer');
      }
    }
    expect((await decide('Bash', { command: 'ls' }, ctx({ state: 'seated' }), bypass)).behavior).toBe('deny');
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

  it('denies network scans of the local network from a PC, in any mode; loopback and public hosts stay allowed', async () => {
    // PLAN §8.7: a live desk agent port-scanned its PC's network for the player's Mac.
    for (const command of [
      'nmap -sn 192.168.65.0/24',
      'sudo -n nmap -p 1-65535 192.168.64.1',
      'apt-get install -y nmap && nmap 10.0.0.0/8',
      'masscan 172.16.0.0/12 -p80',
      'nmap 192.168.65.1-254',
      'fping -a -g 192.168.1.0/24',
      'sudo arp-scan --localnet',
      'netdiscover -r 192.168.0.0/16',
      'for i in $(seq 1 254); do ping -c1 -W1 192.168.65.$i; done',
      'for i in {1..254}; do (echo > /dev/tcp/192.168.64.$i/22) 2>/dev/null && echo up; done',
      'nc -zv 192.168.64.1 1-1024',
      'timeout 60 /usr/bin/nmap mac.local',
    ]) {
      expect(networkScanIn(command), command).not.toBeNull();
      expect(await decide('mcp__pc__bash', { command }, ctx({ state: 'seated' })), command).toMatchObject({
        behavior: 'deny',
        code: 'net_scan',
      });
    }
    // Plan mode too (read-only commands still may not scan).
    expect(
      await decide(
        'mcp__pc__bash',
        { command: 'nmap 192.168.65.0/24' },
        ctx({ state: 'seated', trackedMode: 'plan' }),
      ),
    ).toMatchObject({ code: 'net_scan' });
    const denied = await decide('mcp__pc__bash', { command: 'nmap 192.168.64.1' }, ctx({ state: 'seated' }));
    expect(denied.reason).toMatch(/off-limits/);
    expect(denied.reason).toContain('Jordan');
    for (const command of [
      'nmap 127.0.0.1',
      'nmap -p 3000 localhost',
      'nmap scanme.nmap.org',
      'nc -z localhost 8080',
      'nc -zv 192.168.64.1 22',
      'apt-get install -y nmap',
      'man nmap',
      'echo nmap 192.168.65.0/24 >> notes.txt',
      'ping -c1 android-phone',
      'android adb shell getprop ro.build.version.release',
      'curl -fsSL https://example.com/install.sh | bash',
      'git log --oneline -5',
    ]) {
      expect(networkScanIn(command), command).toBeNull();
      expect((await decide('mcp__pc__bash', { command }, ctx({ state: 'seated' }))).behavior, command).toBe(
        'allow',
      );
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

describe('ToolGate: the session rules (PLAN §6.1 dual sessions, a backstop to the per-session tool lists)', () => {
  it('a desk session whose seat ended may call nothing more: desk_closed, end your turn', async () => {
    const desk = { session: 'desk' as const, deskPc: 'linux-1' };
    // While its seat holds (pending, seated, away), the desk passes on to the seat rules.
    expect(
      (await decide('mcp__pc__bash', { command: 'ls' }, ctx({ state: 'seated', ...desk }))).behavior,
    ).toBe('allow');
    expect(await decide('mcp__pc__bash', { command: 'ls' }, ctx({ state: 'away', ...desk }))).toMatchObject({
      code: 'away',
    });
    // Stood up (or kicked, or pulled into a meeting): everything is refused, the broker tools too.
    for (const tool of ['mcp__pc__bash', 'mcp__mc__say', 'mcp__mc__status', 'AskUserQuestion', 'WebSearch']) {
      const d = await decide(tool, { command: 'ls', text: 'hi' }, ctx({ state: 'standing', ...desk }));
      expect(d, tool).toMatchObject({ behavior: 'deny', code: 'desk_closed' });
      expect(d.reason).toMatch(/no longer seated at linux-1: this PC session is over\. End your turn now/);
    }
    // A desk for another PC than the seat's is closed too.
    expect(
      await decide(
        'mcp__pc__bash',
        { command: 'ls' },
        ctx({ state: 'seated', session: 'desk', deskPc: 'linux-2' }),
      ),
    ).toMatchObject({ code: 'desk_closed' });
  });

  it('the body session calls nothing while its desk session owns the agent: desk_active', async () => {
    for (const state of ['seated', 'away'] as const) {
      const d = await decide('mcp__mc__inventory', {}, ctx({ state, session: 'body' }));
      expect(d, state).toMatchObject({ behavior: 'deny', code: 'desk_active' });
      expect(d.reason).toMatch(/Your PC session is working at linux-1 right now; end your turn\./);
    }
    // In its own sit turn (pending handoff) the old rule holds: end the turn. AskUserQuestion too: a card would hold
    // the turn open, and with it the handoff, until the player answered (review fix).
    expect(await decide('mcp__mc__inventory', {}, ctx({ state: 'pending', session: 'body' }))).toMatchObject({
      code: 'pending_handoff',
    });
    expect(
      await decide('AskUserQuestion', { questions: [] }, ctx({ state: 'pending', session: 'body' })),
    ).toMatchObject({
      behavior: 'deny',
      code: 'pending_handoff',
      reason: expect.stringMatching(/End your turn now/),
    });
    // Before the sit (walking to the chair) the body may still ask.
    expect(
      await decide('AskUserQuestion', { questions: [] }, ctx({ state: 'walking', session: 'body' })),
    ).toEqual({
      behavior: 'defer',
      reason: 'broker',
    });
    // Wandering and at the meeting table the body works as before.
    expect(
      (await decide('mcp__mc__inventory', {}, ctx({ state: 'wandering', session: 'body' }))).behavior,
    ).toBe('allow');
    expect(
      (await decide('mcp__mc__say', { text: 'hi' }, ctx({ state: 'meeting', session: 'body' }))).behavior,
    ).toBe('allow');
  });

  it('the hook reports which session made the call', async () => {
    const seen: string[] = [];
    const hook = createToolGateHook(
      () => ctx({ state: 'wandering', session: 'body' }),
      (o) => seen.push(`${o.toolName}:${o.session}`),
    );
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__mc__status',
        tool_input: {},
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '/dev/null',
        cwd: '/',
        mcp_server: { name: 'mc', source: 'sdk' },
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(seen).toEqual(['mcp__mc__status:body']);
  });
});
