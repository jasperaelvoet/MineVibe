/**
 * Dual sessions (PLAN §6.1, §6.3): each agent has a BODY session (Haiku 5.5 xhigh, every mc tool) and a DESK session
 * per PC (Opus 5.5 medium, the pc tools, a minimal mc set). The sit hands over to the desk with a KICKOFF handoff; a
 * stand hands back with a DESK REPORT. Desk sessions are resumed within their TTL, chat goes to the active session,
 * cards work in both, and the transcript is one merged history with session tags.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAYER } from '../../../src/contracts/common.js';
import { type Harness, MountedPcApi } from '../../helpers/agentHarness.js';
import { deskQuery, freshWorld, lastText, sitAtDesk, sitCall, wake } from '../../helpers/desk.js';
import { FAKE_ACCOUNT_EMAIL, type FakeQuery, resultText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

/** The tool names below are v1's (v2 is the process default since tools-v2-mc.md §16.10). */
async function world(options: Parameters<typeof freshWorld>[0] = {}) {
  const r = await freshWorld({ mcTools: 'v1', ...options });
  h = r.w;
  return r;
}

/** The names of the tools a session's in-process server registers. */
function toolsOf(q: FakeQuery, server: 'mc' | 'pc'): string[] {
  const cfg = q.options.mcpServers?.[server] as
    | { instance?: { _registeredTools?: Record<string, unknown> } }
    | undefined;
  return Object.keys(cfg?.instance?._registeredTools ?? {});
}

/** Records the PcApi `kill` calls (tagged guest processes). */
function recordKills(w: Harness): unknown[] {
  const kills: unknown[] = [];
  const kill = w.pcs.kill.bind(w.pcs);
  w.pcs.kill = async (pcId, target) => {
    kills.push({ pcId, target });
    return kill(pcId, target);
  };
  return kills;
}

/** Stands up from inside the desk turn and ends it; resolves once the body got its DESK REPORT. */
async function standAndReport(w: Harness, d: FakeQuery, q: FakeQuery, said = 'Fixed it; the tests pass.') {
  d.assistantText(said);
  expect(resultText(await d.callTool('mcp__mc__stand_up', {}))).toMatch(
    /Stood up from linux-1: your PC tools stop now and this PC session ends with this turn/,
  );
  d.result();
  await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'desk report');
  return w.texts(q).find((t) => t.includes('DESK REPORT')) ?? '';
}

describe('session lifecycle: create, resume, TTL', () => {
  it('sit: the body turn ends, then a desk session (Opus, its own tools and cwd) takes over with the KICKOFF', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'fix the failing test in foo');
    expect(await sitCall(w, q, id)).toBe(
      'Seated at linux-1. End your turn now; your PC session takes over from here.',
    );
    const brain = w.manager.brain(id);
    expect(brain?.fsm.state).toBe('seated_pending_handoff');
    expect(brain?.activeSession).toBe('body');
    // Still in the sit turn: every further call is refused ("end your turn now").
    expect(await q.callTool('mcp__mc__inventory', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/End your turn now/),
    });
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d = deskQuery(w, id) as FakeQuery;
    d.init();
    await w.until(() => w.texts(d).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect(brain?.activeSession).toBe('desk');
    expect(brain?.fsm.state).toBe('seated');
    expect(brain?.model).toBe('opus');
    expect(w.manager.listAgents()[0]).toMatchObject({ model: 'opus', seatedPc: 'linux-1' });
    // Fixed models, never swapped.
    expect(q.options.model).toBe('claude-haiku-5-5');
    expect(d.options.model).toBe('claude-opus-5-5');
    expect(d.options.settings).toMatchObject({ effortLevel: 'medium' });
    expect([...q.calls, ...d.calls].filter((c) => c.method === 'applyFlagSettings')).toEqual([]);
    // Each session has its own tool list.
    expect(q.options.tools).toEqual(['AskUserQuestion']);
    expect(d.options.tools).toEqual(['AskUserQuestion', 'WebSearch', 'WebFetch']);
    expect(toolsOf(q, 'pc')).toEqual([]);
    expect(toolsOf(q, 'mc')).toContain('goto');
    expect(toolsOf(d, 'mc').sort()).toEqual(
      [
        'status',
        'look_around',
        'stand_up',
        'say',
        'tell',
        'remember',
        'codex_search',
        'codex_read',
        'codex_write',
        'codex_list',
        'calendar_list',
        'calendar_add',
        'calendar_update',
        'calendar_cancel',
        'report_task',
      ].sort(),
    );
    expect(toolsOf(d, 'pc')).toContain('bash');
    expect(d.options.toolAliases?.Bash).toBe('mcp__pc__bash');
    expect(q.options.toolAliases).toBeUndefined();
    // Its own cwd (Claude Code keeps transcripts per cwd), titles, and personas.
    expect(d.options.cwd).toMatch(/agents\/[a-z0-9]+\/desk\/linux-1$/);
    expect(q.options.cwd).toMatch(/agents\/[a-z0-9]+\/home$/);
    expect(q.options.title).toBe('MineVibe · Ada · body · World #1');
    expect(d.options.title).toBe('MineVibe · Ada · desk:linux-1 · World #1');
    const persona = (o: FakeQuery) => (o.options.systemPrompt as { append: string }).append;
    expect(persona(d)).toContain('## At the PC');
    expect(persona(q)).toContain('## Your body');
    // The KICKOFF opens the desk's first turn; the body's sit turn never saw it.
    const kickoff = lastText(w, d);
    expect(kickoff.startsWith(`[MV:${nonce} KICKOFF] You are seated at linux-1`)).toBe(true);
    expect(w.texts(q).some((t) => t.includes('KICKOFF'))).toBe(false);
    expect(d.options.resume).toBeUndefined();
    // The desk works the PC; the world tools are not even its tools (and the gate, the backstop, refuses them).
    expect((await d.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
    expect(w.pcs.execs[0]?.request).toMatchObject({ tag: `${id}:0`, cwd: '/Users/jasper/Code/foo' });
    expect(brain?.lastEffort).toBe('medium');
    expect(toolsOf(d, 'mc')).not.toContain('goto');
    expect(await d.callTool('mcp__mc__goto', { entity: 'player' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/stand up first/),
    });
    expect(
      w.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'sat_at_pc'),
    ).toBe(true);
  });

  it('stand_up: the desk turn ends, the desk session closes and the body wakes with the DESK REPORT', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    await d.callTool('mcp__pc__write', { file_path: '/Users/jasper/Code/foo/a.ts', content: 'x' });
    w.pcs.execHandler = () => ({ exitCode: 1, output: '3 failed' });
    await d.callTool('mcp__pc__bash', { command: 'npm test' });
    d.assistantText('Fixed the tokenizer; 212 tests pass.');
    expect(resultText(await d.callTool('mcp__mc__stand_up', {}))).toMatch(/Stood up from linux-1/);
    const brain = w.manager.brain(id);
    expect(brain?.fsm.state).toBe('standing_pending_handoff');
    // The rest of the desk's last turn may call nothing more (the PC tools stopped).
    expect(await d.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/no longer seated at linux-1: this PC session is over/),
    });
    expect(d.interrupted).toBe(0);
    d.result();
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'desk report');
    expect(d.closed).toBe(true);
    expect(brain?.activeSession).toBe('body');
    expect(brain?.fsm.state).toBe('wandering');
    expect(brain?.model).toBe('haiku');
    const report = w.texts(q).find((t) => t.includes('DESK REPORT')) ?? '';
    expect(report.startsWith(`[MV:${nonce} DESK REPORT] You stood up from linux-1 (outcome: done).`)).toBe(
      true,
    );
    expect(report).toContain('Fixed the tokenizer; 212 tests pass.');
    expect(report).toContain('Files changed: /Users/jasper/Code/foo/a.ts.');
    expect(report).toContain('Last commands: `npm test` exit 1.');
    // No MODE banner: Minecraft mode is the body persona's own.
    expect(report).not.toContain('MODE]');
    // The record keeps the desk resumable.
    const desk = brain?.record.desks?.['linux-1'];
    expect(desk).toMatchObject({ sessionStarted: true });
  });

  it('a later sit at the same PC resumes its desk session; another PC gets its own', async () => {
    const { w, id, q } = await world({
      pcs: new MountedPcApi([
        { pcId: 'linux-1', files: { '/Users/jasper/Code/foo/CLAUDE.md': 'Use pnpm.\n' } },
        { pcId: 'linux-2' },
      ]),
    });
    await wake(w, q, 'fix it');
    const d1 = await sitAtDesk(w, q, id);
    const first = w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId;
    await standAndReport(w, d1, q);
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    await wake(w, q, 'one more thing');
    const d2 = await sitAtDesk(w, q, id, 'linux-1', 'add a test');
    expect(d2).not.toBe(d1);
    expect(d2.options.resume).toBe(first);
    const kickoff = lastText(w, d2);
    expect(kickoff).toContain('You sat down at linux-1 again');
    expect(kickoff).toContain('Your task: add a test');
    // A resumed desk gets this sit's permission mode explicitly (its transcript may end in another one).
    expect(d2.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual([
      'bypassPermissions',
    ]);
    await standAndReport(w, d2, q, 'Added the test.');
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    await wake(w, q, 'now the other PC');
    const d3 = await sitAtDesk(w, q, id, 'linux-2', 'check the build');
    expect(d3.options.resume).toBeUndefined();
    expect(d3.options.cwd).toMatch(/desk\/linux-2$/);
    expect(Object.keys(w.manager.brain(id)?.record.desks ?? {}).sort()).toEqual(['linux-1', 'linux-2']);
  });

  it('a desk session idle longer than the TTL starts fresh at the next sit', async () => {
    let now = 1_000_000;
    const { w, id, q } = await world({ now: () => now, deskTtlMs: 60_000 });
    await wake(w, q, 'fix it');
    const d1 = await sitAtDesk(w, q, id);
    const first = w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId;
    await standAndReport(w, d1, q);
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    now += 61_000;
    await wake(w, q, 'again');
    const d2 = await sitAtDesk(w, q, id);
    expect(d2.options.resume).toBeUndefined();
    const second = w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId;
    expect(second).not.toBe(first);
    expect(d2.options.sessionId).toBe(second);
    expect(lastText(w, d2)).toContain('You are seated at linux-1');
  });

  it('desk records live in the crew file: an app restart resumes the body, and the next sit resumes the desk', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    const d1 = await sitAtDesk(w, q, id);
    const deskId = w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId;
    d1.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'desk idle');
    await w.manager.shutdown();
    await w.manager.flush();
    const crew = JSON.parse(readFileSync(join(w.dir, 'worlds', 'w1', 'crew.json'), 'utf8')) as {
      records: {
        desks?: Record<string, { sessionId: string; sessionStarted: boolean }>;
        lastSeatedPc?: string;
      }[];
    };
    expect(crew.records[0]?.desks?.['linux-1']).toMatchObject({ sessionId: deskId, sessionStarted: true });
    expect(crew.records[0]?.lastSeatedPc).toBe('linux-1');
    // Both sessions were closed.
    expect(q.closed).toBe(true);
    expect(d1.closed).toBe(true);
  });

  it('a desk that crashes is restarted (resumed) while the seat holds; the body keeps running', async () => {
    const { w, id, q } = await world({ supervisor: { backoff: { base: 1, max: 1 } } });
    await wake(w, q, 'fix it');
    const d1 = await sitAtDesk(w, q, id);
    d1.crash('claude exited with code 1');
    await w.until(() => deskQuery(w, id) !== d1 && deskQuery(w, id) !== null, 'desk restarted');
    const d2 = deskQuery(w, id) as FakeQuery;
    expect(d2.options.resume).toBe(w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId);
    d2.init();
    await w.until(() => w.texts(d2).some((t) => t.includes('RESTARTED')), 'restart note');
    expect(w.manager.brain(id)?.activeSession).toBe('desk');
    expect(q.closed).toBe(false);
    expect((await d2.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
  });

  it('a compaction of the desk session makes its pc tools forget what it read', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'read the claude file');
    const d = await sitAtDesk(w, q, id);
    const read = () => d.callTool('mcp__pc__read', { file_path: '/Users/jasper/Code/foo/CLAUDE.md' });
    expect(resultText(await read())).toContain('Use pnpm.');
    expect(resultText(await read())).toMatch(/^Wasted call — file unchanged/);
    d.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000 },
      uuid: 'c',
      session_id: d.sessionId,
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(resultText(await read())).toContain('Use pnpm.');
  });
});

describe('handoffs', () => {
  it('the KICKOFF hands over the task, the player’s lines verbatim, memory, the Codex digest, notes and the PC', async () => {
    const { w, id, q, nonce } = await world();
    await w.org.codex.write(PLAYER, {
      mode: 'create',
      title: 'Build notes',
      body: 'Run pnpm test before pushing.',
      tags: [],
      category: 'howto',
      scope: 'lasting',
    });
    await w.manager.handoffs.add('linux-1', {
      at: 1,
      author: 'Bram (agent)',
      text: 'Half done; see TODO.md',
    });
    await wake(w, q, 'the parser test fails, please fix it');
    expect(resultText(await q.callTool('mcp__mc__remember', { note: 'Jasper wants small commits' }))).toBe(
      'Remembered.',
    );
    await w.manager.deliverChat({ to: 'all', text: '@ada and use tabs, not spaces' });
    await w.until(() => w.texts(q).some((t) => t.includes('use tabs')), 'folded');
    const d = await sitAtDesk(w, q, id, 'linux-1', 'fix the parser test');
    const kickoff = lastText(w, d);
    expect(
      kickoff.startsWith(`[MV:${nonce} KICKOFF] You are seated at linux-1 (linux, linux, screen 1280x800).`),
    ).toBe(true);
    expect(kickoff).toContain(
      "Jasper's Vault folders (same absolute path inside the PC):\n- /Users/jasper/Code/foo (read-write)",
    );
    expect(kickoff).toContain('Your task: fix the parser test');
    expect(kickoff).toContain(
      'What Jasper said to you lately (oldest first, word for word):\n- Jasper: the parser test fails, please fix it\n- Jasper: and use tabs, not spaces',
    );
    expect(kickoff).toContain('author="your own memory" kind="memory"');
    expect(kickoff).toContain('Jasper wants small commits');
    expect(kickoff).toContain(`[MV:${nonce} CODEX DIGEST] The Codex has 1 page(s).`);
    expect(kickoff).toContain('Build notes (howto)');
    expect(kickoff).toContain('author="Bram (agent)" kind="handoff"');
    expect(kickoff).toContain('Half done; see TODO.md');
    expect(kickoff).toContain('Use pnpm.');
    expect(kickoff).toContain('How to work this PC:');
    expect(kickoff).toContain('then call mcp__mc__stand_up.');
  });

  for (const [reason, why] of [
    ['damage', 'You got up from linux-1 to fight: you were attacked.'],
    ['survival', 'You got up from linux-1 to survive (hunger or a hazard).'],
    ['pc_down', 'linux-1 went down; you are no longer seated.'],
  ] as const) {
    it(`${reason}: the desk turn is interrupted, its processes killed, and the body wakes with the report`, async () => {
      const { w, id, q, nonce } = await world();
      await wake(w, q, 'work');
      const d = await sitAtDesk(w, q, id);
      const kills = recordKills(w);
      d.assistantText('Halfway through the refactor.');
      w.manager.onPcUnseat({
        pcId: 'linux-1',
        occupant: { kind: 'agent', agentId: id },
        reason,
        reserved: false,
      });
      await w.until(() => d.interrupted === 1, 'interrupt');
      await w.until(() => kills.length > 0, 'kill');
      expect(kills).toEqual([{ pcId: 'linux-1', target: { tag: `${id}:0` } }]);
      expect(await d.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
      d.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
      await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
      const report = w.texts(q).find((t) => t.includes('DESK REPORT')) ?? '';
      expect(
        report.startsWith(
          `[MV:${nonce} DESK REPORT] You are no longer at linux-1 (outcome: interrupted). ${why}`,
        ),
      ).toBe(true);
      expect(report).toContain('Halfway through the refactor.');
      expect(d.closed).toBe(true);
      expect(w.manager.brain(id)?.activeSession).toBe('body');
      // The critical notice is the report itself: no second wake.
      expect(w.texts(q).filter((t) => /CRITICAL|PC DOWN/.test(t.split('\n')[0] ?? ''))).toEqual([]);
    });
  }

  it('a kick while the desk waits on its plan card: kill the guest processes, deny the card, outcome kicked', async () => {
    const { w, id, q } = await world();
    await w.manager.command(id, { cmd: 'plan_first', on: true });
    await wake(w, q, 'refactor');
    const d = await sitAtDesk(w, q, id);
    const kills = recordKills(w);
    expect(d.options.permissionMode).toBe('plan');
    await d.callTool('mcp__pc__write', { file_path: '/Users/jasper/.claude/plans/p.md', content: '# Plan' });
    const exiting = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect((await w.manager.command(id, { cmd: 'kick' })).echo).toBe('Kicked Ada off linux-1');
    expect(await exiting).toMatchObject({ kind: 'denied' });
    expect(w.manager.pendingCards()).toEqual([]);
    expect(w.skills.seats.at(-1)).toMatchObject({ reason: 'kick' });
    expect(d.interrupted).toBe(1);
    expect(kills).toEqual([{ pcId: 'linux-1', target: { tag: `${id}:0` } }]);
    d.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    const report = w.texts(q).find((t) => t.includes('DESK REPORT')) ?? '';
    expect(report).toContain('(outcome: kicked). Jasper kicked you off linux-1 mid-task.');
    expect(report).toContain('Ask Jasper what they want, or do something else.');
    expect(w.events.some((e) => e.type === 'say' && (e.payload as { bark?: string }).bark === 'kicked')).toBe(
      true,
    );
  });

  it('a desk turn that keeps calling tools after stand_up is interrupted after two refusals', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    await d.callTool('mcp__mc__stand_up', {});
    for (let i = 0; i < 2; i++)
      expect(await d.callTool('mcp__pc__read', { file_path: '/x' })).toMatchObject({ kind: 'denied' });
    expect(d.interrupted).toBe(1);
    d.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    expect(w.manager.brain(id)?.activeSession).toBe('body');
  });

  it('a kick during the body’s sit turn (before any desk): the body hears it directly, no desk is opened', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'sit');
    await sitCall(w, q, id);
    const queries = w.factory.queries.length;
    await w.manager.command(id, { cmd: 'kick' });
    await w.until(() => q.interrupted === 1, 'interrupt');
    q.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => w.texts(q).some((t) => t.startsWith(`[MV:${nonce} KICKED]`)), 'kicked wake');
    expect(w.factory.queries.length).toBe(queries);
    expect(w.manager.brain(id)?.fsm.state).toBe('wandering');
    expect(w.manager.brain(id)?.deskSession).toBeNull();
  });

  it('a meeting pull: the desk is interrupted, the body takes back (report as context) for Meeting mode; back at the PC the desk resumes', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'work');
    const d1 = await sitAtDesk(w, q, id);
    d1.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'desk idle');
    await w.manager.pullIntoMeeting(id, 'm-1');
    const brain = w.manager.brain(id);
    expect(brain?.activeSession).toBe('body');
    expect(d1.closed).toBe(true);
    expect(w.skills.seats.find((s) => 'reason' in s && s.reason === 'meeting')).toMatchObject({
      keepReservation: true,
    });
    // The report reached the body as context (it is off to the meeting).
    const report = q.sent.find((m) => JSON.stringify(m.message.content).includes('DESK REPORT'));
    expect(report).toMatchObject({ shouldQuery: false });
    expect(JSON.stringify(report?.message.content)).toContain('You were called to a meeting.');
    w.skills.finish((w.skills.seats.at(-1) as { jobId: string }).jobId, { status: 'done' });
    await w.until(
      () => brain?.fsm.state === 'seated' && brain.fsm.snapshot.kind === 'meeting',
      'at the table',
    );
    expect(brain?.mode).toBe('meeting');
    const answer = w.manager.meetingTurn(id, 'Status update, please.', { maxSentences: 2 });
    await w.until(() => lastText(w, q).includes('Status update'), 'meeting turn');
    const turn = lastText(w, q);
    expect(turn.startsWith(`[MV:${nonce} MODE] Meeting mode:`)).toBe(true);
    expect(await q.callTool('mcp__mc__status', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/not available in Meeting mode/),
    });
    q.assistantText('All good at linux-1.');
    q.result();
    expect(await answer).toBe('All good at linux-1.');
    await w.until(() => brain?.status === 'idle', 'idle after the meeting turn');
    await w.manager.releaseFromMeeting(id);
    await w.until(() => brain?.fsm.snapshot.kind === 'pc', 'walk back');
    const back = w.skills.seats.at(-1) as { jobId: string; seatEpoch: number };
    w.manager.onPcSeat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      seatEpoch: back.seatEpoch,
    });
    w.skills.finish(back.jobId, { status: 'done' });
    await w.until(() => deskQuery(w, id) !== null && deskQuery(w, id) !== d1, 'desk again');
    const d2 = deskQuery(w, id) as FakeQuery;
    d2.init();
    await w.until(() => w.texts(d2).some((t) => t.includes('KICKOFF')), 'second kickoff');
    expect(d2.options.resume).toBe(brain?.record.desks?.['linux-1']?.sessionId);
    expect(lastText(w, d2)).toContain('You sat down at linux-1 again');
    expect(lastText(w, d2)).toContain('Your task: fix the failing test');
    // Back in Minecraft mode's world later: the body hears Minecraft mode again after the meeting.
    expect(brain?.announcedMode).toBe('meeting');
  });

  it('death closes both sessions without a report; dismissal too', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    const d = await sitAtDesk(w, q, id);
    await w.manager.onAgentDied({
      agentId: id,
      worldId: 'w1',
      cause: 'Ada was slain by a zombie',
      day: 2,
      pos: { x: 0, y: 64, z: 0 },
      dim: 'minecraft:overworld',
    });
    expect(q.closed).toBe(true);
    expect(d.closed).toBe(true);
    expect(w.texts(q).some((t) => t.includes('DESK REPORT'))).toBe(false);
  });
});

describe('chat goes to the active session', () => {
  it('player lines reach the body while it wanders and the desk while it sits; the body hears broadcasts later', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'hello');
    const d = await sitAtDesk(w, q, id);
    // A direct line while the desk works folds into its turn.
    await w.manager.deliverChat({ to: 'all', text: '@ada also bump the version' });
    await w.until(() => w.texts(d).some((t) => t.includes('also bump the version')), 'to the desk');
    expect(d.sent.at(-1)).toMatchObject({ priority: 'next' });
    expect(w.texts(q).some((t) => t.includes('also bump the version'))).toBe(false);
    d.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    // A broadcast to a seated agent is context for the desk (and copied for the body).
    await w.manager.deliverChat({ to: 'all', text: 'dinner at sunset, everyone' });
    await w.until(() => w.texts(d).some((t) => t.includes('dinner at sunset')), 'broadcast to the desk');
    expect(d.sent.at(-1)).toMatchObject({ shouldQuery: false });
    // A new direct line while the desk is idle starts a desk turn.
    await w.manager.deliverChat({ to: 'all', text: '@ada how is it going?' });
    await w.until(() => lastText(w, d).includes('how is it going?'), 'desk turn');
    expect(d.sent.at(-1)?.shouldQuery).toBeUndefined();
    await standAndReport(w, d, q);
    // The body got the broadcast it missed (context), before its report.
    const sent = w.texts(q);
    const missed = sent.findIndex((t) => t.includes('dinner at sunset'));
    expect(missed).toBeGreaterThan(-1);
    expect(missed).toBeLessThan(sent.findIndex((t) => t.includes('DESK REPORT')));
    // Back on its feet: chat goes to the body again.
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'body idle');
    await wake(w, q, 'come here');
    expect(w.texts(d).some((t) => t.includes('come here'))).toBe(false);
  });
});

describe('cards in both sessions', () => {
  const question = {
    questions: [
      { question: 'Oak or spruce?', options: [{ label: 'Oak' }, { label: 'Spruce' }], multiSelect: false },
    ],
  };

  it('AskUserQuestion works from the body and from the desk; the answer resumes the session that asked', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'build a shed');
    const fromBody = q.callTool('AskUserQuestion', question);
    await w.until(() => w.manager.pendingCards().length === 1, 'body card');
    expect(w.manager.brain(id)?.status).toBe('waiting_player');
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada 2' })).echo).toMatch(/Q1 = 2 \(Spruce\)/);
    expect(await fromBody).toMatchObject({
      kind: 'allowed',
      input: { answers: { 'Oak or spruce?': 'Spruce' } },
    });
    const d = await sitAtDesk(w, q, id);
    const fromDesk = d.callTool('AskUserQuestion', {
      questions: [
        { question: 'Squash the commits?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
      ],
    });
    await w.until(() => w.manager.pendingCards().length === 1, 'desk card');
    expect(w.manager.brain(id)?.status).toBe('waiting_player');
    await w.manager.deliverChat({ to: 'all', text: '@ada 1' });
    expect(await fromDesk).toMatchObject({
      kind: 'allowed',
      input: { answers: { 'Squash the commits?': 'Yes' } },
    });
    await w.until(() => w.manager.brain(id)?.status === 'thinking', 'desk resumed');
  });

  it('plan-first: the desk lists ExitPlanMode and starts in plan mode; approve returns it to bypassPermissions', async () => {
    const { w, id, q } = await world();
    await w.manager.command(id, { cmd: 'plan_first', on: true });
    await wake(w, q, 'refactor the parser');
    const d = await sitAtDesk(w, q, id);
    expect(d.options.tools).toContain('ExitPlanMode');
    expect(d.options.permissionMode).toBe('plan');
    expect(q.options.tools).not.toContain('ExitPlanMode');
    expect(lastText(w, d)).toContain('Plan first: you are in plan mode.');
    expect(
      await d.callTool('mcp__pc__edit', {
        file_path: '/Users/jasper/Code/foo/a.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/Plan mode/) });
    const plan = '# Plan\n1. Add a failing test\n2. Fix the tokenizer';
    await d.callTool('mcp__pc__write', { file_path: '/Users/jasper/.claude/plans/parser.md', content: plan });
    const exiting = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({ kind: 'plan', plan });
    expect((await w.manager.deliverChat({ to: 'all', text: '@ada approve' })).echo).toBe(
      'You → Ada: plan approved',
    );
    expect(await exiting).toMatchObject({ kind: 'allowed' });
    expect(d.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.args)).toEqual([
      'bypassPermissions',
    ]);
    expect(w.manager.brain(id)?.trackedMode).toBe('bypassPermissions');
    // The body has no plan mode at all.
    expect(await q.callTool('ExitPlanMode', {})).toMatchObject({ kind: 'denied' });
  });
});

describe('one merged transcript with session tags', () => {
  it('body lines say body, desk lines desk and their PC; the player’s lines carry the session they reached', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    q.assistantText('On my way to the PC.');
    const d = await sitAtDesk(w, q, id);
    d.assistantText('Running the tests now.');
    d.assistantToolUse('mcp__pc__bash', { command: 'npm test', description: 'run tests' });
    await w.manager.deliverChat({ to: 'all', text: '@ada thanks' });
    await w.until(() => w.texts(d).some((t) => t.includes('thanks')), 'to the desk');
    await standAndReport(w, d, q, 'All green.');
    q.assistantText('Back outside.');
    await w.until(
      () => w.manager.transcripts.tail(id, 50).some((e) => e.text === 'Back outside.'),
      'body line',
    );
    const lines = w.manager.transcripts
      .tail(id, 50)
      .map((e) => `${e.kind}|${e.session ?? '-'}|${e.pcId ?? '-'}|${e.text.slice(0, 30)}`);
    expect(lines).toContain('player|body|-|fix it');
    expect(lines).toContain('agent|body|-|On my way to the PC.');
    expect(lines).toContain('agent|desk|linux-1|Running the tests now.');
    expect(lines).toContain('activity|desk|linux-1|bash: run tests');
    expect(lines).toContain('player|desk|linux-1|thanks');
    expect(lines).toContain('agent|desk|linux-1|All green.');
    expect(lines).toContain('agent|body|-|Back outside.');
    // One history: the sequence numbers run on across both sessions.
    const seqs = w.manager.transcripts.tail(id, 50).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // chat.append carries the tag to the mod.
    expect(
      w.events.some(
        (e) =>
          e.type === 'chat' &&
          (e.payload as { entry: { session?: string; pcId?: string } }).entry.session === 'desk' &&
          (e.payload as { entry: { pcId?: string } }).entry.pcId === 'linux-1',
      ),
    ).toBe(true);
  });
});

describe('outbound redaction of account identifiers (agents/redact.ts)', () => {
  it('bubbles, the transcript, tells, Codex writes, calendar events, handoff notes, hires and meeting minutes', async () => {
    const { w, id, q } = await world();
    await w.until(() => w.manager.redactor.active, 'account read');
    const leak = `Mail me at ${FAKE_ACCOUNT_EMAIL.toUpperCase()} or ${FAKE_ACCOUNT_EMAIL}'s Organization.`;
    await wake(w, q, 'who are you?');
    q.assistantText(leak);
    await w.until(
      () =>
        w.events.some(
          (e) => e.type === 'say' && String((e.payload as { text?: string }).text).includes('Mail me'),
        ),
      'bubble',
    );
    const bubbles = w.events
      .filter((e) => e.type === 'say')
      .map((e) => (e.payload as { text?: string }).text ?? '')
      .join('\n');
    expect(bubbles).toContain('Mail me at [redacted] or [redacted].');
    expect(bubbles.toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    const transcript = JSON.stringify(w.manager.transcripts.tail(id, 50));
    expect(transcript.toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    await q.callTool('mcp__mc__say', { text: `ping ${FAKE_ACCOUNT_EMAIL}` });
    await q.callTool('mcp__mc__codex_write', {
      mode: 'create',
      title: `Contact ${FAKE_ACCOUNT_EMAIL}`,
      body: `Owner: ${FAKE_ACCOUNT_EMAIL}`,
      category: 'people',
      scope: 'lasting',
    });
    const page = w.org.codex.index().pages[0];
    expect(page?.title).toBe('Contact [redacted]');
    expect((await w.org.codex.read(PLAYER, page?.id ?? '')).body).toBe('Owner: [redacted]');
    const added = await q.callTool('mcp__mc__calendar_add', {
      title: `Mail ${FAKE_ACCOUNT_EMAIL}`,
      kind: 'task',
      assignees: [id],
      clock: 'real',
      when: '2099-01-01T08:00:00Z',
      task: `Write to ${FAKE_ACCOUNT_EMAIL}`,
    });
    expect(resultText(added)).toMatch(/Scheduled/);
    const events = JSON.stringify(await w.org.calendar.list(PLAYER));
    expect(events).toContain('Mail [redacted]');
    expect(events.toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    await q.callTool('mcp__mc__request_hire', {
      role: 'miner',
      reason: `ask ${FAKE_ACCOUNT_EMAIL}`,
      first_task: `mine for ${FAKE_ACCOUNT_EMAIL}`,
    });
    expect(JSON.stringify(w.manager.pendingCards()).toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    const d = await sitAtDesk(w, q, id);
    await d.callTool('mcp__pc__handoff_note', { text: `Ask ${FAKE_ACCOUNT_EMAIL} for the keys` });
    expect((await w.manager.handoffs.list('linux-1'))[0]?.text).toBe('Ask [redacted] for the keys');
    d.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'desk idle');
    const minutes = w.manager.meetingTurn(id, 'Your update?', { maxSentences: 2 });
    await w.until(() => lastText(w, d).includes('Your update?'), 'meeting turn');
    d.assistantText(`Done; reach me at ${FAKE_ACCOUNT_EMAIL}.`);
    d.result();
    expect(await minutes).toBe('Done; reach me at [redacted].');
    const all = JSON.stringify(w.events).toLowerCase();
    expect(all).not.toContain(FAKE_ACCOUNT_EMAIL);
  });

  it('tells are redacted for the other agent too', async () => {
    const { w, id, q } = await world();
    await w.until(() => w.manager.redactor.active, 'account read');
    // A second agent to tell.
    await wake(w, q, 'hire a miner');
    await q.callTool('mcp__mc__request_hire', { role: 'miner', reason: 'ore', first_task: 'mine iron' });
    await w.manager.deliverChat({ to: 'all', text: '@ada yes' });
    await w.until(() => w.manager.listAgents().length === 2, 'hired');
    const bram = w.manager.listAgents()[1]?.agentId ?? '';
    const hired = w.queryOf(bram);
    await w.until(() => w.texts(hired).some((t) => t.includes('WELCOME')), 'their welcome');
    hired.init();
    hired.result();
    await w.until(() => w.manager.brain(bram)?.status === 'idle', 'their turn ended');
    expect(
      resultText(await q.callTool('mcp__mc__tell', { to: bram, text: `mail ${FAKE_ACCOUNT_EMAIL}` })),
    ).toMatch(/Told/);
    const theirs = JSON.stringify(w.manager.transcripts.tail(bram, 20)).toLowerCase();
    expect(theirs).toContain('mail [redacted]');
    expect(theirs).not.toContain(FAKE_ACCOUNT_EMAIL);
    const bramQ = w.queryOf(bram);
    await w.until(() => w.texts(bramQ).some((t) => t.includes('mail [redacted]')), 'tell delivered');
    expect(w.texts(bramQ).join('\n').toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    expect(id).not.toBe(bram);
  });
});
