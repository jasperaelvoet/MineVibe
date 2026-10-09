/**
 * Modes in the dual-session runtime (agents/modes.ts, PLAN §6.2-6.3): the body persona carries Minecraft mode and the
 * desk persona PC mode, so neither needs a MODE banner at a sit or stand; the body session announces Meeting mode (and
 * Minecraft mode after it) with the MODE banner. ToolGate still holds every call to the seat's mode as a backstop.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolObservation } from '../../../src/agents/AgentManager.js';
import { createHarness, type Harness } from '../../helpers/agentHarness.js';
import { deskQuery, freshWorld, lastText, sitAtDesk, wake } from '../../helpers/desk.js';
import type { FakeQuery } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

async function world(options: Parameters<typeof freshWorld>[0] = {}) {
  const r = await freshWorld(options);
  h = r.w;
  const tools: ToolObservation[] = [];
  r.w.manager.on('tool', (o) => {
    tools.push(o);
  });
  return { ...r, tools };
}

const modeLine = (nonce: string, title: string) => `[MV:${nonce} MODE] ${title}:`;

/** Pulls the agent into meeting m-1 and seats it at the table. */
async function toTheTable(w: Harness, id: string) {
  await w.manager.pullIntoMeeting(id, 'm-1');
  w.skills.finish((w.skills.seats.at(-1) as { jobId: string }).jobId, { status: 'done' });
  const brain = w.manager.brain(id);
  await w.until(
    () => brain?.fsm.state === 'seated' && brain.fsm.snapshot.kind === 'meeting',
    'meeting chair',
  );
}

describe('modes in the dual-session runtime', () => {
  it('a new agent needs no banner: Minecraft mode is its body persona’s own', async () => {
    const { w, id, q } = await world();
    const welcome = w.texts(q).find((t) => t.includes('WELCOME')) ?? '';
    expect(welcome).not.toContain('MODE]');
    await wake(w, q, 'how are you');
    expect(lastText(w, q)).not.toContain('MODE]');
    expect(w.manager.brain(id)?.announcedMode).toBeNull();
  });

  it('sit and stand need no banner either: the desk persona is PC mode, the DESK REPORT says you are up', async () => {
    const { w, id, q, tools } = await world();
    await wake(w, q, 'fix the failing test');
    const d = await sitAtDesk(w, q, id);
    expect(lastText(w, d)).not.toContain('MODE]');
    const brain = w.manager.brain(id);
    expect(brain?.mode).toBe('seated');
    // PC mode: pc tools and the minimal mc set work; the gate refuses the rest (backstop: they are not its tools).
    expect((await d.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
    expect((await d.callTool('mcp__mc__status', {})).kind).toBe('allowed');
    expect(await d.callTool('mcp__mc__inventory', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/not available in PC mode\. Stand up first/),
    });
    expect(tools.find((t) => t.toolName === 'mcp__mc__inventory')).toMatchObject({
      behavior: 'deny',
      code: 'mode',
      mode: 'seated',
      session: 'desk',
    });
    expect(tools.find((t) => t.toolName === 'mcp__pc__bash')).toMatchObject({
      behavior: 'allow',
      session: 'desk',
      model: 'claude-opus-5-5',
    });
    await d.callTool('mcp__mc__stand_up', {});
    d.result();
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    expect(w.texts(q).some((t) => t.includes('MODE]'))).toBe(false);
    q.result();
    await w.until(() => brain?.status === 'idle', 'idle');
    expect((await q.callTool('mcp__mc__inventory', {})).kind).toBe('allowed');
  });

  it('the body announces Meeting mode at the table, and Minecraft mode once after it', async () => {
    const { w, id, q, nonce } = await world();
    await toTheTable(w, id);
    const brain = w.manager.brain(id);
    expect(brain?.mode).toBe('meeting');
    const answer = w.manager.meetingTurn(id, 'Status update, please.', { maxSentences: 2 });
    await w.until(() => lastText(w, q).includes('Status update'), 'meeting turn');
    const turn = lastText(w, q);
    expect(turn.startsWith(modeLine(nonce, 'Meeting mode'))).toBe(true);
    expect(turn.indexOf('MODE]')).toBeLessThan(turn.indexOf('MEETING]'));
    expect((await q.callTool('mcp__mc__say', { text: 'All good.' })).kind).toBe('allowed');
    expect(await q.callTool('mcp__mc__inventory', {})).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/not available in Meeting mode/),
    });
    q.assistantText('All good.');
    q.result();
    expect(await answer).toBe('All good.');
    await w.until(() => brain?.status === 'idle', 'idle');
    await w.manager.releaseFromMeeting(id);
    await wake(w, q, 'back to work');
    expect(lastText(w, q).startsWith(modeLine(nonce, 'Minecraft mode'))).toBe(true);
    q.result();
    await w.until(() => brain?.status === 'idle', 'idle again');
    await wake(w, q, 'and now');
    expect(lastText(w, q)).not.toContain('MODE]');
  });

  it('a compaction at the meeting table makes the next body turn announce Meeting mode again', async () => {
    const { w, id, q, nonce } = await world();
    await toTheTable(w, id);
    const answer = w.manager.meetingTurn(id, 'Anything?', { maxSentences: 1 });
    await w.until(() => lastText(w, q).includes('Anything?'), 'meeting turn');
    q.result();
    await answer;
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    q.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 150_000 },
      uuid: 'c',
      session_id: 's',
    } as never);
    await w.until(() => w.manager.brain(id)?.announcedMode === null, 'reset');
    await wake(w, q, 'still there?');
    expect(lastText(w, q).startsWith(modeLine(nonce, 'Meeting mode'))).toBe(true);
  });

  it('away from the seat keeps PC mode in the desk: the minimal mc set works, the rest is refused', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    const d = await sitAtDesk(w, q, id);
    const brain = w.manager.brain(id);
    expect(await brain?.goAway()).toBe(true);
    expect(brain?.mode).toBe('seated');
    expect((await d.callTool('mcp__mc__status', {})).kind).toBe('allowed');
    expect(await d.callTool('mcp__mc__inventory', {})).toMatchObject({ kind: 'denied' });
    expect(await brain?.comeBack()).toBe(true);
    expect(lastText(w, d)).not.toContain('MODE]');
  });

  it('the v2 tool set: the desk’s mc server registers v2’s minimal set, and the gate holds the rest', async () => {
    const { w, id, q } = await world({ mcTools: 'v2' });
    expect(w.manager.brain(id)?.mcTools).toBe('v2');
    await wake(w, q, 'fix the failing test');
    const d = await sitAtDesk(w, q, id);
    const cfg = d.options.mcpServers?.mc as { instance?: { _registeredTools?: Record<string, unknown> } };
    expect(Object.keys(cfg.instance?._registeredTools ?? {}).sort()).toEqual(
      ['observe', 'say', 'tell', 'remember', 'stand_up', 'codex', 'calendar'].sort(),
    );
    expect((d.options.systemPrompt as { append: string }).append).toContain(
      'mcp__mc__observe shows what goes on around you',
    );
    expect((await d.callTool('mcp__mc__observe', {})).kind).toBe('allowed');
    expect(await d.callTool('mcp__mc__items', { action: 'eat' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/mcp__mc__items is not available in PC mode.*only observe, say/),
    });
  });

  it('a reopened crew seated by the mod (worker restart): the desk session takes over, then the body after standing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-modes-'));
    try {
      const first = await createHarness({ dir });
      await first.manager.openWorld({ worldId: 'w1', gen: 1 });
      await first.cleanup();
      h = await createHarness({ dir });
      const w = h;
      await w.manager.openWorld({ worldId: 'w1', gen: 1 });
      const id = w.manager.listAgents()[0]?.agentId ?? '';
      const q = w.query(0);
      q.init();
      expect(w.texts(q).some((t) => t.includes('WELCOME'))).toBe(false);
      w.manager.onPcSeat({ pcId: 'linux-1', occupant: { kind: 'agent', agentId: id }, seatEpoch: 0 });
      await w.until(() => deskQuery(w, id) !== null, 'desk');
      const d = deskQuery(w, id) as FakeQuery;
      d.init();
      await w.until(() => w.texts(d).some((t) => t.includes('KICKOFF')), 'kickoff');
      await w.until(() => w.texts(d).some((t) => t.includes('RESTARTED')), 'restart note');
      expect(w.manager.brain(id)?.fsm.state).toBe('seated');
      expect((await d.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
      expect((await d.callTool('mcp__mc__stand_up', {})).kind).toBe('allowed');
      d.result();
      await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
      expect(w.manager.brain(id)?.activeSession).toBe('body');
    } finally {
      await h?.cleanup();
      h = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
