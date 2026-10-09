/**
 * The mode switch at the turn boundary (agents/modes.ts, PLAN §6.3 "Mode switch"): the model/effort swap first, then
 * the first turn on the new model opens with the new mode's MODE banner; ToolGate holds every call to the seat's mode.
 * Kick, damage, survival, PC down, death, meetings, away-from-seat, the re-sit debounce and compaction.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnseatReason } from '@minevibe/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolObservation } from '../../../src/agents/AgentManager.js';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import { type FakeQuery, resultText, userText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

/** What reached the session, in order: user messages (first line) and flag-layer swaps. */
function recorder(q: FakeQuery): string[] {
  const log: string[] = [];
  for (const m of q.sent) log.push(`user:${userText(m).split('\n')[0]}`);
  const prev = q.onUser;
  q.onUser = (m) => {
    log.push(`user:${userText(m).split('\n')[0]}`);
    prev?.(m);
  };
  const apply = q.applyFlagSettings.bind(q);
  q.applyFlagSettings = async (settings) => {
    log.push(`flags:${settings.model}/${settings.effortLevel}`);
    return apply(settings);
  };
  return log;
}

/** A fresh world whose CEO is idle after its welcome turn. */
async function world(options: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness(options);
  await h.manager.openWorld({ worldId: 'w1', gen: 1 });
  const id = h.manager.listAgents()[0]?.agentId ?? '';
  const q = h.query(0);
  await h.until(() => h?.texts(q).some((t) => t.includes('WELCOME')) ?? false, 'welcome');
  q.init();
  q.result();
  await h.until(() => h?.manager.brain(id)?.status === 'idle', 'idle');
  const nonce = h.manager.brain(id)?.record.nonce ?? '';
  const tools: ToolObservation[] = [];
  h.manager.on('tool', (o) => {
    tools.push(o);
  });
  return { w: h, id, q, nonce, tools };
}

async function wake(w: Harness, q: FakeQuery, text: string) {
  await w.manager.deliverChat({ to: 'all', text: `@ada ${text}` });
  await w.until(() => w.texts(q).some((t) => t.includes(text)), `wake ${text}`);
}

/** Sits at linux-1 within the current turn and ends that turn; resolves once the kickoff turn started. */
async function sitAndKickoff(w: Harness, q: FakeQuery, id: string) {
  const seats = w.skills.seats.length;
  const calling = q.callTool('mcp__mc__sit_at_pc', { pc: 'linux-1', purpose: 'fix the failing test' });
  await w.until(() => w.skills.seats.length > seats, 'agent.seat');
  const seat = w.skills.seats.at(-1) as { jobId: string; seatEpoch: number };
  w.manager.onPcSeat({
    pcId: 'linux-1',
    occupant: { kind: 'agent', agentId: id },
    seatEpoch: seat.seatEpoch,
  });
  w.skills.finish(seat.jobId, { status: 'done' });
  await calling;
  const kickoffs = () => w.texts(q).filter((t) => t.includes('KICKOFF')).length;
  const before = kickoffs();
  q.result();
  await w.until(() => kickoffs() > before, 'kickoff');
}

const lastText = (w: Harness, q: FakeQuery) => w.texts(q).at(-1) ?? '';
const modeLine = (nonce: string, title: string) => `[MV:${nonce} MODE] ${title}:`;

describe('mode switch at the turn boundary', () => {
  it('a new agent hears Minecraft mode with its first turn, and only once', async () => {
    const { w, q, nonce } = await world();
    const welcome = w.texts(q).find((t) => t.includes('WELCOME')) ?? '';
    expect(welcome.startsWith(modeLine(nonce, 'Minecraft mode'))).toBe(true);
    expect(welcome.indexOf('MODE]')).toBeLessThan(welcome.indexOf('WELCOME]'));
    await wake(w, q, 'how are you');
    expect(lastText(w, q)).not.toContain('MODE]');
  });

  it('sit: Opus/medium is applied first, then the PC-mode banner and the kickoff open the next turn', async () => {
    const { w, id, q, nonce, tools } = await world();
    const log = recorder(q);
    await wake(w, q, 'fix the failing test');
    await sitAndKickoff(w, q, id);
    const flags = log.indexOf('flags:claude-opus-5-5/medium');
    const banner = log.indexOf(`user:${modeLine(nonce, 'PC mode')} you sit at an office PC.`);
    expect(flags).toBeGreaterThan(0);
    expect(banner).toBe(flags + 1);
    const kickoff = lastText(w, q);
    expect(kickoff.startsWith(modeLine(nonce, 'PC mode'))).toBe(true);
    expect(kickoff.indexOf('MODE]')).toBeLessThan(kickoff.indexOf('KICKOFF]'));
    expect(kickoff).toContain('from mcp__mc__ only status, look_around, stand_up');
    const brain = w.manager.brain(id);
    expect(brain?.announcedMode).toBe('seated');
    expect(brain?.mode).toBe('seated');
    // PC mode: pc tools and the minimal mc set work, the rest of the world waits for stand_up.
    expect((await q.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
    expect((await q.callTool('mcp__mc__status', {})).kind).toBe('allowed');
    expect(await q.callTool('mcp__mc__inventory', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/not available in PC mode\. Stand up first/),
    });
    expect(await q.callTool('mcp__mc__goto', { pos: { x: 1, y: 64, z: 1 } })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/PC mode.*stand up first/),
    });
    expect(tools.find((t) => t.toolName === 'mcp__mc__inventory')).toMatchObject({
      behavior: 'deny',
      code: 'mode',
      mode: 'seated',
    });
    expect(tools.find((t) => t.toolName === 'mcp__pc__bash')).toMatchObject({
      behavior: 'allow',
      code: null,
    });
  });

  it('stand: Minecraft mode opens the next turn, on Opus within the debounce; the later downswap adds no banner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { w, id, q, nonce } = await world();
    const log = recorder(q);
    await wake(w, q, 'fix it');
    await sitAndKickoff(w, q, id);
    expect(resultText(await q.callTool('mcp__mc__stand_up', {}))).toMatch(
      /Stood up from linux-1: Minecraft mode/,
    );
    // The rest of this turn is Minecraft mode already: pc tools stop, world tools work.
    expect(await q.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
    expect((await q.callTool('mcp__mc__inventory', {})).kind).toBe('allowed');
    q.result();
    await w.until(() => w.manager.brain(id)?.fsm.state === 'wandering', 'wandering');
    expect(w.manager.brain(id)?.model).toBe('opus');
    await wake(w, q, 'what next');
    const next = lastText(w, q);
    expect(next.startsWith(modeLine(nonce, 'Minecraft mode'))).toBe(true);
    expect(next).toContain('what next');
    expect(w.manager.brain(id)?.model).toBe('opus');
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    vi.advanceTimersByTime(61_000);
    await w.until(() => log.includes('flags:claude-haiku-5-5/xhigh'), 'downswap');
    await wake(w, q, 'and now');
    expect(lastText(w, q)).not.toContain('MODE]');
    // Welcome (Minecraft), sit (PC), stand (Minecraft): one banner per switch.
    expect(log.filter((l) => l.includes('MODE]'))).toHaveLength(3);
  });

  for (const reason of ['kick', 'damage', 'survival', 'pc_down'] as const satisfies readonly UnseatReason[]) {
    it(`${reason}: Haiku/xhigh at once, then the critical wake opens with Minecraft mode`, async () => {
      const { w, id, q, nonce } = await world();
      const log = recorder(q);
      await wake(w, q, 'work');
      await sitAndKickoff(w, q, id);
      w.manager.onPcUnseat({
        pcId: 'linux-1',
        occupant: { kind: 'agent', agentId: id },
        reason,
        reserved: false,
      });
      await w.until(() => q.interrupted === 1, 'interrupt');
      // Interrupted mid-turn: the seat's mode holds the rest of the turn.
      expect(w.manager.brain(id)?.mode).toBe('wander');
      expect(await q.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
      q.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
      await w.until(() => log.includes('flags:claude-haiku-5-5/xhigh'), 'downswap');
      await w.until(() => w.texts(q).at(-1)?.startsWith(modeLine(nonce, 'Minecraft mode')) ?? false, 'wake');
      const flags = log.indexOf('flags:claude-haiku-5-5/xhigh');
      const banner = log.findIndex((l, i) => i > flags && l.includes('Minecraft mode'));
      expect(banner).toBe(flags + 1);
      expect(lastText(w, q)).toMatch(/KICKED|CRITICAL|PC DOWN/);
      expect(w.manager.brain(id)?.announcedMode).toBe('wander');
    });
  }

  it('death: the seat resets to Minecraft mode, with no swap and no banner (the brain stops)', async () => {
    const { w, id, q } = await world();
    const log = recorder(q);
    await wake(w, q, 'work');
    await sitAndKickoff(w, q, id);
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    const brain = w.manager.brain(id);
    await brain?.resetSeat('death');
    expect(brain?.mode).toBe('wander');
    expect(log.filter((l) => l.startsWith('flags:'))).toEqual(['flags:claude-opus-5-5/medium']);
  });

  it('meeting: pulled from a PC the meeting turn opens with Meeting mode; back at the PC the kickoff opens with PC mode, no swap', async () => {
    const { w, id, q, nonce } = await world();
    const log = recorder(q);
    await wake(w, q, 'work');
    await sitAndKickoff(w, q, id);
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    await w.manager.pullIntoMeeting(id, 'm-1');
    const brain = w.manager.brain(id);
    expect(brain?.mode).toBe('wander'); // walking to the table
    w.skills.finish((w.skills.seats.at(-1) as { jobId: string }).jobId, { status: 'done' });
    await w.until(
      () => brain?.fsm.state === 'seated' && brain.fsm.snapshot.kind === 'meeting',
      'meeting chair',
    );
    expect(brain?.mode).toBe('meeting');
    const answer = w.manager.meetingTurn(id, 'Status update, please.', { maxSentences: 2 });
    await w.until(() => lastText(w, q).includes('Status update'), 'meeting turn');
    const turn = lastText(w, q);
    expect(turn.startsWith(modeLine(nonce, 'Meeting mode'))).toBe(true);
    expect(turn.indexOf('MODE]')).toBeLessThan(turn.indexOf('MEETING]'));
    expect((await q.callTool('mcp__mc__say', { text: 'All good.' })).kind).toBe('allowed');
    expect(await q.callTool('mcp__mc__status', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/not available in Meeting mode/),
    });
    expect(await q.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({ kind: 'denied' });
    q.assistantText('All good.');
    q.result();
    expect(await answer).toBe('All good.');
    await w.until(() => brain?.status === 'idle', 'idle after meeting turn');

    await w.manager.releaseFromMeeting(id);
    await w.until(() => brain?.fsm.snapshot.kind === 'pc', 'walk back');
    const back = w.skills.seats.at(-1) as { jobId: string; seatEpoch: number };
    w.manager.onPcSeat({
      pcId: 'linux-1',
      occupant: { kind: 'agent', agentId: id },
      seatEpoch: back.seatEpoch,
    });
    w.skills.finish(back.jobId, { status: 'done' });
    await w.until(() => w.texts(q).filter((t) => t.includes('KICKOFF')).length === 2, 'second kickoff');
    expect(lastText(w, q).startsWith(modeLine(nonce, 'PC mode'))).toBe(true);
    // The stretched debounce kept Opus over the meeting: still only the one up-swap.
    expect(log.filter((l) => l.startsWith('flags:'))).toEqual(['flags:claude-opus-5-5/medium']);
    expect(log.filter((l) => l.includes('MODE]')).map((l) => l.slice(l.indexOf('MODE]')))).toEqual([
      'MODE] Minecraft mode: you are on your feet in the world.',
      'MODE] PC mode: you sit at an office PC.',
      'MODE] Meeting mode: you sit at the meeting table.',
      'MODE] PC mode: you sit at an office PC.',
    ]);
  });

  it('away from the seat keeps PC mode: the minimal mc set works, the rest is refused, no banner on return', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    await sitAndKickoff(w, q, id);
    const brain = w.manager.brain(id);
    expect(await brain?.goAway()).toBe(true);
    expect(brain?.mode).toBe('seated');
    expect((await q.callTool('mcp__mc__status', {})).kind).toBe('allowed');
    expect(await q.callTool('mcp__mc__inventory', {})).toMatchObject({ kind: 'denied' });
    expect(await brain?.comeBack()).toBe(true);
    q.result();
    await w.until(() => brain?.status === 'idle', 'idle');
    await wake(w, q, 'carry on');
    expect(lastText(w, q)).not.toContain('MODE]');
    expect(brain?.announcedMode).toBe('seated');
  });

  it('the v2 tool set: the PC-mode banner names its tools, and the gate holds its action tools to the mode', async () => {
    const { w, id, q, nonce } = await world({ mcTools: 'v2' });
    expect(w.manager.brain(id)?.mcTools).toBe('v2');
    await wake(w, q, 'fix the failing test');
    await sitAndKickoff(w, q, id);
    const kickoff = lastText(w, q);
    expect(kickoff.startsWith(modeLine(nonce, 'PC mode'))).toBe(true);
    expect(kickoff).toContain('from mcp__mc__ only observe, say, tell, remember, stand_up, codex, calendar.');
    expect(kickoff).toContain('mcp__mc__observe shows what goes on around you');
    expect((await q.callTool('mcp__mc__observe', {})).kind).toBe('allowed');
    // items{eat} is a read-ish action, but items is a Minecraft-mode tool.
    expect(await q.callTool('mcp__mc__items', { action: 'eat' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/mcp__mc__items is not available in PC mode.*only observe, say/),
    });
  });

  it('a reopened crew seated by the mod (worker restart): PC mode first, then Minecraft mode after standing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-modes-'));
    try {
      const first = await createHarness({ dir });
      await first.manager.openWorld({ worldId: 'w1', gen: 1 });
      await first.cleanup();
      h = await createHarness({ dir, swapDebounceMs: 0 });
      const w = h;
      await w.manager.openWorld({ worldId: 'w1', gen: 1 });
      const id = w.manager.listAgents()[0]?.agentId ?? '';
      const q = w.query(0);
      q.init();
      const log = recorder(q);
      expect(w.texts(q).some((t) => t.includes('WELCOME'))).toBe(false);
      w.manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId: id }, seatEpoch: 0 });
      await w.until(() => log.includes('flags:claude-opus-5-5/medium'), 'upswap');
      const nonce = w.manager.brain(id)?.record.nonce ?? '';
      await wake(w, q, 'stand up when done');
      expect(lastText(w, q).startsWith(modeLine(nonce, 'PC mode'))).toBe(true);
      expect((await q.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
      expect((await q.callTool('mcp__mc__stand_up', {})).kind).toBe('allowed');
      q.result();
      await w.until(() => log.includes('flags:claude-haiku-5-5/xhigh'), 'downswap');
      await wake(w, q, 'back outside');
      expect(lastText(w, q).startsWith(modeLine(nonce, 'Minecraft mode'))).toBe(true);
    } finally {
      await h?.cleanup();
      h = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a compaction makes the next turn announce the mode again', async () => {
    const { w, id, q, nonce } = await world();
    q.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000 },
      uuid: 'c',
      session_id: 's',
    } as never);
    await w.until(() => w.manager.brain(id)?.announcedMode === null, 'reset');
    await wake(w, q, 'still there?');
    expect(lastText(w, q).startsWith(modeLine(nonce, 'Minecraft mode'))).toBe(true);
  });
});
