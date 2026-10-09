/**
 * Dual sessions, the edges (PLAN §6.1, §6.3; review of the dual-sessions track): what reaches which session while a
 * handoff is in flight, the body's sit turn, the slot of a running desk turn when the body goes offline, Retry after a
 * desk stopped the brain, a desk whose session id is already in use, a KICKOFF without the PC's details, and the
 * outbound redactor on cut-to-length texts and on cards.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Harness, MountedPcApi } from '../../helpers/agentHarness.js';
import { deskQuery, freshWorld, lastText, sitAtDesk, sitCall, wake } from '../../helpers/desk.js';
import { FAKE_ACCOUNT_EMAIL, FAKE_MODELS, type FakeQuery, resultText } from '../../helpers/fakeSdk.js';

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
  h = null;
});

async function world(options: Parameters<typeof freshWorld>[0] = {}) {
  const r = await freshWorld(options);
  h = r.w;
  return r;
}

/** The transcript tag of the agent's player line containing `text`. */
function playerTag(w: Harness, id: string, text: string) {
  const e = w.manager.transcripts.tail(id, 50).find((x) => x.kind === 'player' && x.text.includes(text));
  return { session: e?.session, pcId: e?.pcId };
}

describe('chat during a handoff waits for the session that takes over', () => {
  it('a line during the desk’s last turn (after stand_up) reaches the body with the DESK REPORT, not the closing desk', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    const brain = w.manager.brain(id);
    d.assistantText('Fixed; the tests pass.');
    await d.callTool('mcp__mc__stand_up', {});
    expect(brain?.fsm.state).toBe('standing_pending_handoff');
    expect(brain?.activeSession).toBe('desk');
    await w.manager.deliverChat({ to: 'all', text: '@ada then chop some wood' });
    await w.until(
      () => brain?.queuedWakes.some((x) => x.text.includes('then chop some wood')) === true,
      'queued for the body',
    );
    // The desk ends with this turn: the line never folds into it.
    expect(w.texts(d).some((t) => t.includes('then chop some wood'))).toBe(false);
    expect(playerTag(w, id, 'then chop some wood')).toEqual({ session: 'body', pcId: undefined });
    d.result();
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    const turn = lastText(w, q);
    expect(turn.startsWith(`[MV:${nonce} DESK REPORT]`)).toBe(true);
    expect(turn).toContain('Jasper: then chop some wood');
    expect(d.closed).toBe(true);
  });

  it('a line during the body’s sit turn reaches the desk after its KICKOFF, not the body that can act on nothing', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'go fix the parser');
    await sitCall(w, q, id);
    const brain = w.manager.brain(id);
    expect(brain?.fsm.state).toBe('seated_pending_handoff');
    await w.manager.deliverChat({ to: 'all', text: '@ada and run the linter too' });
    await w.until(
      () => brain?.queuedWakes.some((x) => x.text.includes('run the linter')) === true,
      'queued for the desk',
    );
    expect(w.texts(q).some((t) => t.includes('run the linter'))).toBe(false);
    expect(playerTag(w, id, 'run the linter')).toEqual({ session: 'desk', pcId: 'linux-1' });
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d = deskQuery(w, id) as FakeQuery;
    d.init();
    await w.until(() => w.texts(d).some((t) => t.includes('KICKOFF')), 'kickoff');
    const first = lastText(w, d);
    expect(first.startsWith(`[MV:${nonce} KICKOFF]`)).toBe(true);
    // The handoff quotes it, and it is a wake of its own after the KICKOFF in the desk's first turn.
    expect(first).toContain('- Jasper: and run the linter too');
    expect(first).toContain('\n\nJasper: and run the linter too');
  });

  it('a kick during the body’s sit turn: the waiting line reaches the body with the KICKED notice', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'go sit');
    await sitCall(w, q, id);
    await w.manager.deliverChat({ to: 'all', text: '@ada are you there?' });
    const brain = w.manager.brain(id);
    await w.until(() => brain?.queuedWakes.length === 1, 'queued');
    await w.manager.command(id, { cmd: 'kick' });
    await w.until(() => q.interrupted === 1, 'interrupt');
    q.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => w.texts(q).some((t) => t.includes(`[MV:${nonce} KICKED]`)), 'kicked');
    // One body turn: the player's line (P0) and the notice.
    expect(lastText(w, q)).toContain('Jasper: are you there?');
    expect(lastText(w, q)).toContain(`[MV:${nonce} KICKED] Jasper kicked you off linux-1`);
    expect(brain?.deskSession).toBeNull();
  });

  it('the body’s sit turn may not raise a question card (it would hold the handoff until answered)', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'sit down');
    await sitCall(w, q, id);
    const out = await q.callTool('AskUserQuestion', {
      questions: [{ question: 'Which PC?', options: [{ label: 'linux-1' }], multiSelect: false }],
    });
    expect(out).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/End your turn now/) });
    expect(w.manager.pendingCards()).toEqual([]);
  });
});

describe('slots and Retry across the two sessions', () => {
  it('the body going offline while its desk works leaves the desk’s slot with the desk until its result', async () => {
    const { w, id, q } = await world({ supervisor: { maxRestarts: 0 } });
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    const brain = w.manager.brain(id);
    await w.until(() => brain?.status === 'thinking', 'desk turn');
    const grant = w.manager.scheduler.grantOf(id);
    expect(grant).toBeDefined();
    q.crash('claude exited with code 1');
    await w.until(() => brain?.offline === true, 'offline');
    expect(w.manager.scheduler.grantOf(id)).toBe(grant);
    expect(grant?.released).toBe(false);
    d.result();
    await w.until(() => grant?.released === true, 'released at the result');
    expect(w.manager.scheduler.grantOf(id)).toBeUndefined();
  });

  it('Retry after a desk’s startup assertions failed restarts the desk and the brain thinks again', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'fix it');
    await sitCall(w, q, id);
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d1 = deskQuery(w, id) as FakeQuery;
    d1.models = FAKE_MODELS.filter((m) => m.resolvedModel !== 'claude-opus-5-5');
    d1.init();
    const brain = w.manager.brain(id);
    await w.until(() => brain?.canThink === false, 'halted');
    await w.until(() => d1.closed, 'desk closed');
    expect(brain?.status).toBe('asleep');
    expect(q.closed).toBe(false);
    await w.manager.command(id, { cmd: 'retry_brain' });
    await w.until(() => deskQuery(w, id) !== d1 && deskQuery(w, id) !== null, 'desk restarted');
    const d2 = deskQuery(w, id) as FakeQuery;
    expect(d2.options.resume).toBe(brain?.record.desks?.['linux-1']?.sessionId);
    d2.init();
    expect(brain?.canThink).toBe(true);
    // The KICKOFF that never ran opens the new desk session's first turn.
    await w.until(() => w.texts(d2).some((t) => t.includes('KICKOFF')), 'kickoff');
    expect((await d2.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
  });

  it('Retry after a desk halted the brain and the seat ended since: the body thinks again', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'fix it');
    await sitCall(w, q, id);
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d1 = deskQuery(w, id) as FakeQuery;
    d1.models = [];
    d1.init();
    const brain = w.manager.brain(id);
    await w.until(() => brain?.canThink === false && d1.closed, 'halted');
    await w.manager.command(id, { cmd: 'kick' });
    await w.until(() => brain?.activeSession === 'body', 'handed back');
    expect(brain?.canThink).toBe(false);
    await w.manager.command(id, { cmd: 'retry_brain' });
    expect(brain?.canThink).toBe(true);
    await w.until(() => w.texts(q).some((t) => t.startsWith(`[MV:${nonce} DESK REPORT]`)), 'report');
  });

  it('a desk whose new session id is already in use (an earlier launch wrote it) is resumed by the restart', async () => {
    const { w, id, q } = await world({ supervisor: { backoff: { base: 1, max: 1 } } });
    await wake(w, q, 'fix it');
    await sitCall(w, q, id);
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d1 = deskQuery(w, id) as FakeQuery;
    const sessionId = w.manager.brain(id)?.record.desks?.['linux-1']?.sessionId ?? '';
    expect(d1.options.sessionId).toBe(sessionId);
    d1.crash(`Claude Code process exited with code 1\nError: Session ID ${sessionId} is already in use.`);
    await w.until(() => deskQuery(w, id) !== d1 && deskQuery(w, id) !== null, 'desk restarted');
    const d2 = deskQuery(w, id) as FakeQuery;
    expect(d2.options.resume).toBe(sessionId);
    expect(d2.options.sessionId).toBeUndefined();
    expect(w.manager.brain(id)?.record.desks?.['linux-1']?.sessionStarted).toBe(true);
  });
});

describe('the DESK REPORT', () => {
  it('a game restart while the desk waits on its question: the card ends with the desk', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    const asking = d.callTool('AskUserQuestion', {
      questions: [{ question: 'Squash the commits?', options: [{ label: 'Yes' }], multiSelect: false }],
    });
    await w.until(() => w.manager.pendingCards().length === 1, 'desk card');
    await w.manager.brain(id)?.gameRestarted();
    expect(await asking).toMatchObject({ kind: 'denied' });
    expect(w.manager.pendingCards()).toEqual([]);
    expect(d.closed).toBe(true);
    const report = q.sent.find((m) =>
      JSON.stringify(m.message.content).includes(`[MV:${nonce} DESK REPORT]`),
    );
    expect(report).toMatchObject({ shouldQuery: false });
  });

  it('a desk that dies in its last turn (after stand_up) hands back at once, with no restart', async () => {
    // A long restart backoff: the hand-back must not wait for the supervisor.
    const { w, id, q, nonce } = await world({ supervisor: { backoff: { base: 60_000, max: 60_000 } } });
    await wake(w, q, 'fix it');
    const d = await sitAtDesk(w, q, id);
    d.assistantText('All fixed.');
    expect(resultText(await d.callTool('mcp__mc__stand_up', {}))).toMatch(/Stood up from linux-1/);
    const queries = w.factory.queries.length;
    d.crash('claude exited with code 1');
    await w.until(() => w.texts(q).some((t) => t.startsWith(`[MV:${nonce} DESK REPORT]`)), 'report');
    expect(lastText(w, q)).toContain('All fixed.');
    expect(w.factory.queries.length).toBe(queries);
    expect(w.manager.brain(id)?.activeSession).toBe('body');
    expect(w.manager.brain(id)?.fsm.state).toBe('wandering');
  });

  it('a closed desk session works no PC, even while the agent sits at another one', async () => {
    const { w, id, q } = await world({
      pcs: new MountedPcApi([{ pcId: 'linux-1' }, { pcId: 'linux-2' }]),
    });
    await wake(w, q, 'fix it');
    const d1 = await sitAtDesk(w, q, id);
    d1.assistantText('Done here.');
    await d1.callTool('mcp__mc__stand_up', {});
    d1.result();
    await w.until(() => w.texts(q).some((t) => t.includes('DESK REPORT')), 'report');
    q.result();
    await w.until(() => w.manager.brain(id)?.status === 'idle', 'idle');
    await wake(w, q, 'now linux-2');
    const d2 = await sitAtDesk(w, q, id, 'linux-2', 'check the build');
    expect(d1.closed).toBe(true);
    const execs = w.pcs.execs.length;
    expect(await d1.callTool('mcp__pc__bash', { command: 'ls' })).toMatchObject({
      kind: 'denied',
      reason: expect.stringMatching(/this PC session is over/),
    });
    expect(w.pcs.execs.length).toBe(execs);
    expect((await d2.callTool('mcp__pc__bash', { command: 'ls' })).kind).toBe('allowed');
  });

  it('a meeting pull whose chair is refused before the desk’s turn ended still reports the meeting (as context)', async () => {
    const { w, id, q } = await world();
    await wake(w, q, 'work');
    const d = await sitAtDesk(w, q, id);
    const seat = w.skills.seat.bind(w.skills);
    w.skills.seat = async (request) => {
      if (request.target.kind === 'meeting') throw new Error('NO_SEAT: every meeting chair is taken');
      return seat(request);
    };
    await expect(w.manager.pullIntoMeeting(id, 'm-1')).rejects.toThrow(/NO_SEAT/);
    const brain = w.manager.brain(id);
    // Walking back to its reserved chair while the desk's interrupted turn still ends.
    await w.until(() => brain?.fsm.state === 'walking_to_seat', 'walking back');
    expect(brain?.fsm.snapshot.lastEnd).toBe('sit_failed');
    d.result({ subtype: 'error_during_execution', is_error: true, num_turns: 0 });
    await w.until(() => d.closed, 'desk closed');
    const report = q.sent.find((m) => JSON.stringify(m.message.content).includes('DESK REPORT'));
    expect(report).toMatchObject({ shouldQuery: false });
    expect(JSON.stringify(report?.message.content)).toContain('You were called to a meeting.');
    expect(brain?.queuedWakes.some((x) => x.kind === 'DESK REPORT')).toBe(false);
  });
});

describe('the KICKOFF', () => {
  it('still hands over the task and the player’s lines when the PC’s details cannot be read', async () => {
    const { w, id, q, nonce } = await world();
    await wake(w, q, 'please fix the flaky test');
    await sitCall(w, q, id, 'linux-1', 'fix the flaky test');
    w.pcs.info = async () => {
      throw new Error('spacesd is not answering');
    };
    q.result();
    await w.until(() => deskQuery(w, id) !== null, 'desk');
    const d = deskQuery(w, id) as FakeQuery;
    d.init();
    await w.until(() => w.texts(d).some((t) => t.includes('KICKOFF')), 'kickoff');
    const kickoff = lastText(w, d);
    expect(
      kickoff.startsWith(
        `[MV:${nonce} KICKOFF] You are seated at linux-1. This is your PC session. Its details could not be read just now`,
      ),
    ).toBe(true);
    expect(kickoff).toContain('Your task: fix the flaky test');
    expect(kickoff).toContain('- Jasper: please fix the flaky test');
    expect(kickoff).toContain('then call mcp__mc__stand_up.');
  });
});

describe('the outbound redactor on cut texts and cards', () => {
  it('a bubble or activity line cut to length never keeps part of the e-mail address', async () => {
    const { w, id, q } = await world();
    await w.until(() => w.manager.redactor.active, 'account read');
    await wake(w, q, 'talk');
    // One long sentence whose cut (240 characters) falls inside the address.
    q.assistantText(`${'a'.repeat(230)} ${FAKE_ACCOUNT_EMAIL} is where to write.`);
    await q.callTool('mcp__mc__say', { text: `${'b'.repeat(232)} ${FAKE_ACCOUNT_EMAIL} again.` });
    const d = await sitAtDesk(w, q, id);
    // An activity line is cut at 160 characters.
    d.assistantToolUse('mcp__pc__bash', { command: `echo ${'c'.repeat(145)} ${FAKE_ACCOUNT_EMAIL}` });
    await w.until(
      () => w.manager.transcripts.tail(id, 50).some((e) => e.kind === 'activity' && e.text.includes('ccc')),
      'activity',
    );
    const local = FAKE_ACCOUNT_EMAIL.split('@')[0] ?? '';
    const bubbles = w.events
      .filter((e) => e.type === 'say')
      .map((e) => (e.payload as { text?: string }).text ?? '');
    expect(bubbles.some((b) => b.startsWith('aaaa'))).toBe(true);
    expect(bubbles.some((b) => b.startsWith('bbbb'))).toBe(true);
    expect(bubbles.filter((b) => b.includes(`${local}@`))).toEqual([]);
    const lines = w.manager.transcripts.tail(id, 50).map((e) => e.text);
    expect(lines.filter((l) => l.includes(`${local}@`))).toEqual([]);
    expect(w.manager.brain(id)?.brainPayload().activity ?? '').not.toContain(`${local}@`);
  });

  it('question and plan cards are redacted; the answer reaches the model under its own question', async () => {
    const { w, id, q } = await world();
    await w.until(() => w.manager.redactor.active, 'account read');
    await w.manager.command(id, { cmd: 'plan_first', on: true });
    await wake(w, q, 'who gets the report?');
    const question = `Send the report to ${FAKE_ACCOUNT_EMAIL}?`;
    const asking = q.callTool('AskUserQuestion', {
      questions: [
        {
          question,
          header: 'Report',
          options: [
            { label: `Yes, ${FAKE_ACCOUNT_EMAIL}`, description: `mail ${FAKE_ACCOUNT_EMAIL}` },
            { label: 'No' },
          ],
          multiSelect: false,
        },
      ],
    });
    await w.until(() => w.manager.pendingCards().length === 1, 'question card');
    const card = JSON.stringify(w.manager.pendingCards());
    expect(card).toContain('Send the report to [redacted]?');
    expect(card.toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
    await w.manager.deliverChat({ to: 'all', text: '@ada 1' });
    expect(await asking).toMatchObject({
      kind: 'allowed',
      input: { answers: { [question]: 'Yes, [redacted]' } },
    });
    const d = await sitAtDesk(w, q, id);
    await d.callTool('mcp__pc__write', {
      file_path: '/Users/jasper/.claude/plans/report.md',
      content: `# Plan\n1. Mail the report to ${FAKE_ACCOUNT_EMAIL}`,
    });
    const exiting = d.callTool('ExitPlanMode', {});
    await w.until(() => w.manager.pendingCards().length === 1, 'plan card');
    expect(w.manager.pendingCards()[0]).toMatchObject({
      kind: 'plan',
      plan: '# Plan\n1. Mail the report to [redacted]',
    });
    await w.manager.deliverChat({ to: 'all', text: '@ada approve' });
    expect(await exiting).toMatchObject({ kind: 'allowed' });
    expect(JSON.stringify(w.events).toLowerCase()).not.toContain(FAKE_ACCOUNT_EMAIL);
  });
});
