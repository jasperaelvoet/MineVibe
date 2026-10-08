import { createMessage, type MessageOf, type OkReply } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import { BridgeError } from '../../src/bridge/BridgeServer.js';
import {
  type ApiError,
  agentActor,
  type CalendarEventInput,
  createBridgeSkillApi,
  FakeCrewApi,
  FakeOrgApi,
  FakePcApi,
  FakeSkillApi,
  globToRegExp,
  isApiError,
  PLAYER,
  type SkillBridge,
} from '../../src/contracts/index.js';

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isApiError(err, code), `expected ApiError ${code}, got ${String(err)}`).toBe(true);
  return err as ApiError;
}

const QUESTION = {
  id: 'card-1',
  agentId: 'ada',
  createdAt: 1,
  parked: false,
  presenting: true,
  kind: 'question' as const,
  questions: [{ question: 'Wood?', options: [{ label: 'Oak' }, { label: 'Spruce' }], multiSelect: false }],
  answers: [],
};

describe('FakeCrewApi', () => {
  function crew() {
    const api = new FakeCrewApi(
      [
        { agentId: 'ada', handle: 'ada', name: 'Ada', role: 'ceo', ceo: true },
        { agentId: 'bram', handle: 'bram', name: 'Bram', seatedPc: 'linux-1' },
        { agentId: 'cleo', handle: 'cleo', name: 'Cleo', status: 'dead' },
      ],
      { now: () => 1_000 },
    );
    const events: { name: string; payload: unknown }[] = [];
    for (const name of ['say', 'brain', 'pending', 'chat', 'crew'] as const) {
      api.on(name, (payload) => {
        events.push({ name, payload });
      });
    }
    return { api, events };
  }

  it('routes leading mentions, broadcasts and explicit recipients', async () => {
    const { api } = crew();
    const direct = await api.deliverChat({ to: 'all', text: '@ada @bram build a house' });
    expect(direct.scope).toBe('direct');
    expect(direct.deliveries.map((d) => d.agentId)).toEqual(['ada', 'bram']);
    expect(direct.echo).toBe('You → Ada, Bram: build a house');

    const broadcast = await api.deliverChat({ to: 'all', text: 'night is coming' });
    expect(broadcast.scope).toBe('broadcast');
    expect(broadcast.deliveries).toEqual([
      { agentId: 'ada', mode: 'wake', queued: false, latencyMs: 0, hint: null },
      { agentId: 'bram', mode: 'context', queued: false, latencyMs: 0, hint: null },
    ]);

    api.setBusy('bram', true);
    const queued = await api.deliverChat({ to: ['bram'], text: 'status?', mode: 'reply' });
    expect(queued.deliveries[0]).toMatchObject({ queued: true, latencyMs: 30_000 });
    expect(queued.deliveries[0]?.hint).toMatch(/mid-task/);
    expect(api.delivered).toHaveLength(3);
  });

  it('refuses unknown and dead recipients with the CHAT codes', async () => {
    const { api } = crew();
    await rejectsWith(api.deliverChat({ to: 'all', text: '@zed hi' }), 'CHAT_UNKNOWN');
    await rejectsWith(api.deliverChat({ to: 'all', text: '@cleo hi' }), 'CHAT_UNAVAILABLE');
    await rejectsWith(api.deliverChat({ to: 'all', text: '   ' }), 'CHAT_REJECTED');
  });

  it('answers, validates and parks cards, emitting valid agent.pending payloads', async () => {
    const { api, events } = crew();
    api.raiseCard(QUESTION);
    await rejectsWith(api.answerCard('card-1', { kind: 'options', picks: [3] }), 'CHAT_INVALID_ANSWER');
    await rejectsWith(api.answerCard('card-1', { kind: 'options', picks: [1, 2] }), 'CHAT_INVALID_ANSWER');
    await api.answerCard('card-1', { kind: 'later' });
    expect(api.cardsOf('ada')[0]?.parked).toBe(true);
    expect((await api.answerCard('card-1', { kind: 'options', picks: [2] })).echo).toBe('You → Ada: 2');
    expect(api.cardsOf('ada')).toEqual([]);
    await rejectsWith(api.answerCard('card-1', { kind: 'later' }), 'CARD_GONE');

    const pending = events.filter((e) => e.name === 'pending');
    expect(pending).toHaveLength(3);
    for (const e of pending) {
      expect(() => createMessage('agent.pending', e.payload as MessageOf<'agent.pending'>)).not.toThrow();
    }
  });

  it('applies commands and keeps a transcript', async () => {
    const { api, events } = crew();
    await api.command('bram', { cmd: 'plan_first', on: true });
    await api.command('ada', { cmd: 'autonomy', level: 'proactive' });
    expect(api.listAgents().find((a) => a.agentId === 'bram')?.planFirst).toBe(true);
    expect(api.listAgents().find((a) => a.agentId === 'ada')?.autonomy).toBe('proactive');
    await rejectsWith(api.command('zed', { cmd: 'stop' }), 'UNKNOWN_AGENT');

    api.emitSay('ada', 'On it.');
    await api.deliverChat({ to: ['ada'], text: 'thanks' });
    const page = await api.chatHistory('ada', { limit: 1 });
    expect(page.entries.map((e) => e.text)).toEqual(['thanks']);
    expect(page.more).toBe(true);
    const older = await api.chatHistory('ada', { beforeSeq: 1, limit: 10 });
    expect(older.entries.map((e) => e.kind)).toEqual(['agent']);
    for (const e of events.filter((x) => x.name === 'chat' || x.name === 'say' || x.name === 'crew')) {
      const t = e.name === 'chat' ? 'chat.append' : e.name === 'say' ? 'agent.say' : 'crew.state';
      expect(() => createMessage(t, e.payload as never)).not.toThrow();
    }
  });
});

describe('FakeOrgApi', () => {
  const page = {
    title: 'Iron cave',
    body: 'Iron at the far end.',
    tags: ['iron'],
    category: 'places',
    scope: 'world',
  } as const;

  it('creates, searches, updates with baseRev and refuses conflicts and similar titles', async () => {
    const org = new FakeOrgApi({ now: () => 5 });
    const cleo = agentActor('cleo');
    const created = await org.codex.write(cleo, { mode: 'create', ...page });
    expect(created.pageId).toBe('iron-cave');
    await rejectsWith(
      org.codex.write(cleo, { mode: 'create', ...page, title: 'IRON CAVE' }),
      'CODEX_SIMILAR',
    );

    const hits = await org.codex.search(cleo, { query: 'iron' });
    expect(hits.map((h) => h.id)).toEqual(['iron-cave']);
    const conflict = await rejectsWith(
      org.codex.write(cleo, { mode: 'update', pageId: 'iron-cave', baseRev: 'fffffff', ...page }),
      'CODEX_CONFLICT',
    );
    expect(conflict.details?.rev).toBe(created.rev);
    const updated = await org.codex.write(cleo, {
      mode: 'update',
      pageId: 'iron-cave',
      baseRev: created.rev,
      ...page,
    });
    expect(updated.rev).not.toBe(created.rev);
    await org.codex.write(cleo, { mode: 'append', pageId: 'iron-cave', ...page, body: 'Also coal.' });
    expect((await org.codex.read(cleo, 'iron-cave')).body).toBe('Iron at the far end.\nAlso coal.');
    expect(() => createMessage('codex.index', org.codex.index())).not.toThrow();
  });

  it('enforces rules, size and delete rights', async () => {
    const org = new FakeOrgApi();
    await rejectsWith(
      org.codex.write(agentActor('ada', true), {
        ...page,
        mode: 'create',
        category: 'rules',
        scope: 'lasting',
        title: 'Rules',
      }),
      'FORBIDDEN',
    );
    await rejectsWith(
      org.codex.write(PLAYER, { ...page, mode: 'create', body: 'x'.repeat(8193) }),
      'CODEX_TOO_LARGE',
    );
    const { pageId } = await org.codex.write(PLAYER, { ...page, mode: 'create' });
    await rejectsWith(org.codex.delete(agentActor('ada'), pageId), 'FORBIDDEN');
    await org.codex.delete(PLAYER, pageId);
    await rejectsWith(org.codex.read(PLAYER, pageId), 'CODEX_NOT_FOUND');
  });

  it('schedules with CEO rights, approval cards and player-owned events', async () => {
    const org = new FakeOrgApi({ tz: 'Europe/Brussels' });
    const fired: unknown[] = [];
    org.on('calendarFired', (p) => {
      fired.push(p);
    });
    const task: CalendarEventInput = {
      title: 'Farm wheat',
      kind: 'task',
      assignees: ['bram'],
      clock: 'game',
      at: 48_000,
      recurrence: { kind: 'once' },
      durationMin: 30,
      catchUp: 'skip',
      runWhileAway: false,
    };
    await rejectsWith(org.calendar.add(agentActor('cleo'), task), 'FORBIDDEN');
    const byCeo = await org.calendar.add(agentActor('ada', true), task);
    expect(byCeo.needsApproval).toBe(false);
    const recurring = await org.calendar.add(agentActor('bram'), { ...task, recurrence: { kind: 'daily' } });
    expect(recurring.needsApproval).toBe(true);
    const byPlayer = await org.calendar.add(PLAYER, task);
    await rejectsWith(
      org.calendar.update(agentActor('ada', true), byPlayer.eventId, { title: 'x' }),
      'FORBIDDEN',
    );
    await rejectsWith(
      org.calendar.add(PLAYER, { ...task, recurrence: { kind: 'weekdays' } }),
      'CALENDAR_INVALID',
    );

    expect(await org.calendar.list(PLAYER, { agentId: 'bram', to: 50_000 })).toHaveLength(3);
    expect(() => createMessage('calendar.state', org.calendar.state())).not.toThrow();
    const payload = org.fire(byCeo.eventId, ['bram']);
    expect(() => createMessage('calendar.fired', payload)).not.toThrow();
    expect(fired).toHaveLength(1);
    await org.calendar.report(agentActor('bram'), {
      eventId: byCeo.eventId,
      status: 'blocked',
      note: 'no seeds',
    });
    expect(org.reports).toHaveLength(1);
  });

  it('runs one meeting at a time', async () => {
    const org = new FakeOrgApi({ now: () => 1_000 });
    const preview = await org.meeting.start(PLAYER, { attendees: ['ada', 'bram'], preview: true });
    expect(preview.meetingId).toBeNull();
    expect(preview.etas).toHaveLength(2);
    const { meetingId } = await org.meeting.start(PLAYER, { title: 'Standup', attendees: ['ada', 'bram'] });
    expect(meetingId).not.toBeNull();
    const state = org.meeting.state();
    expect(state).not.toBeNull();
    if (state) expect(() => createMessage('meeting.state', state)).not.toThrow();
    await rejectsWith(org.meeting.start(PLAYER, {}), 'MEETING_BUSY');
    await org.meeting.end(PLAYER, meetingId ?? '');
    expect(org.meeting.state()).toBeNull();
    await rejectsWith(org.meeting.end(PLAYER, 'nope'), 'MEETING_NOT_FOUND');
  });
});

describe('FakePcApi', () => {
  const files = {
    '/home/cua/foo/src/math.ts': 'export const sum = (a, b) => a - b;\n// TODO sum\n',
    '/home/cua/foo/README.md': '# foo\n',
    '/home/cua/foo/src/deep/x.ts': 'const TODO = 1;\n',
  };

  it('reads, writes and edits with Edit semantics', async () => {
    const pc = new FakePcApi([{ pcId: 'linux-1', files }]);
    const read = await pc.readFile('linux-1', { path: '/home/cua/foo/src/math.ts', offset: 2, limit: 1 });
    expect(read).toEqual({ content: '// TODO sum', startLine: 2, totalLines: 3, truncated: true });
    await rejectsWith(pc.readFile('linux-1', { path: '/nope' }), 'NOT_FOUND');
    await rejectsWith(
      pc.editFile('linux-1', { path: 'foo/src/math.ts', oldString: 'nothing', newString: 'x' }),
      'EDIT_NOT_FOUND',
    );
    await rejectsWith(
      pc.editFile('linux-1', { path: 'foo/src/math.ts', oldString: 'sum', newString: 'add' }),
      'EDIT_AMBIGUOUS',
    );
    expect(
      await pc.editFile('linux-1', { path: 'foo/src/math.ts', oldString: 'a - b', newString: 'a + b' }),
    ).toBe(1);
    expect(
      await pc.editFile('linux-1', {
        path: 'foo/src/math.ts',
        oldString: 'sum',
        newString: 'add',
        replaceAll: true,
      }),
    ).toBe(2);
    expect(pc.files('linux-1').get('/home/cua/foo/src/math.ts')).toBe(
      'export const add = (a, b) => a + b;\n// TODO add\n',
    );
    expect(await pc.writeFile('linux-1', 'notes.txt', 'é')).toBe(2);
  });

  it('globs and greps like the tools expect', async () => {
    const pc = new FakePcApi([{ pcId: 'linux-1', files }]);
    expect((await pc.glob('linux-1', { pattern: 'foo/**/*.ts' })).paths).toEqual([
      '/home/cua/foo/src/deep/x.ts',
      '/home/cua/foo/src/math.ts',
    ]);
    const content = await pc.grep('linux-1', {
      pattern: 'TODO',
      outputMode: 'content',
      lineNumbers: true,
      path: 'foo',
    });
    expect(content.output).toBe(
      '/home/cua/foo/src/deep/x.ts:1:const TODO = 1;\n/home/cua/foo/src/math.ts:2:// TODO sum',
    );
    const filesOnly = await pc.grep('linux-1', {
      pattern: 'todo',
      caseInsensitive: true,
      outputMode: 'files_with_matches',
      glob: '*.md',
    });
    expect(filesOnly.matches).toBe(0);
    const count = await pc.grep('linux-1', { pattern: 'TODO', outputMode: 'count', headLimit: 1 });
    expect(count).toEqual({ output: '/home/cua/foo/src/deep/x.ts:1', matches: 2, truncated: true });
    expect(globToRegExp('/a/**/b?.ts').test('/a/x/y/b1.ts')).toBe(true);
    expect(globToRegExp('/a/*.ts').test('/a/x/b.ts')).toBe(false);
  });

  it('runs commands, background jobs and kills by tag; refuses a stopped PC', async () => {
    const pc = new FakePcApi();
    pc.execHandler = (_id, req) => ({
      exitCode: req.command === 'false' ? 1 : 0,
      output: 'x'.repeat(40_000),
    });
    const done = await pc.exec('linux-1', { command: 'npm test', tag: 'bram:3' });
    expect(done).toMatchObject({ kind: 'done', exitCode: 0, truncated: true });
    const bg = await pc.exec('linux-1', { command: 'npm run dev', tag: 'bram:3', background: true });
    if (bg.kind !== 'background') throw new Error('expected a background job');
    expect((await pc.jobOutput('linux-1', bg.jobId)).running).toBe(true);
    expect(await pc.kill('linux-1', { tag: 'bram:3' })).toBe(1);
    expect(await pc.jobOutput('linux-1', bg.jobId)).toMatchObject({ running: false, exitCode: 137 });
    await pc.pointer('linux-1', { action: 'click', x: 10, y: 20 });
    await pc.type('linux-1', 'ls');
    expect(pc.input.map((i) => i.kind)).toEqual(['pointer', 'type']);
    pc.setStatus('linux-1', 'off');
    await rejectsWith(pc.screenshot('linux-1'), 'PC_DOWN');
    await rejectsWith(pc.info('mac-9'), 'PC_UNKNOWN');
  });
});

/** A stand-in for BridgeServer's `request` / `on`. */
function fakeBridge(reply: (t: string, payload: Record<string, unknown>) => Record<string, unknown> | Error) {
  const listeners = new Map<string, ((message: unknown) => void)[]>();
  const sent: { t: string; payload: Record<string, unknown>; timeoutMs: number | undefined }[] = [];
  const bridge = {
    request: async (t: string, payload: Record<string, unknown>, options: { timeoutMs?: number } = {}) => {
      sent.push({ t, payload, timeoutMs: options.timeoutMs });
      const result = reply(t, payload);
      if (result instanceof Error) throw result;
      return { t: 'ok', v: 1, re: `n-${sent.length}`, ...result } as OkReply;
    },
    on: (event: string, listener: (message: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () =>
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== listener),
        );
    },
  };
  const deliver = (t: string, payload: Record<string, unknown>) => {
    for (const l of listeners.get(t) ?? []) l(createMessage(t as 'skill.result', payload as never));
  };
  return { bridge: bridge as unknown as SkillBridge, sent, deliver, listeners };
}

describe('createBridgeSkillApi', () => {
  it('validates args before sending and maps bridge errors', async () => {
    const { bridge, sent } = fakeBridge((t) =>
      t === 'skill.run' ? new BridgeError('BUSY', 'Ada is busy') : {},
    );
    const api = createBridgeSkillApi(bridge);
    await rejectsWith(api.runSkill({ agentId: 'ada', skill: 'goto', args: {} as never }), 'BAD_ARGS');
    expect(sent).toHaveLength(0);
    await rejectsWith(api.runSkill({ agentId: 'ada', skill: 'eat', args: {} }), 'BUSY');
    expect(sent[0]?.payload).toMatchObject({ agentId: 'ada', skill: 'eat', waitMs: 20_000, replace: false });
    expect(sent[0]?.payload).not.toHaveProperty('consent');
    expect(sent[0]?.timeoutMs).toBe(25_000);
    // Node's consent (protocol §7.4.3) goes out as skill.run.consent; it is never part of args.
    const consent = {
      consentId: 'consent-1',
      agentId: 'ada',
      positions: [{ x: 1, y: 2, z: 3 }],
      expiresAt: 5,
    };
    await rejectsWith(
      api.runSkill({ agentId: 'ada', skill: 'mine', args: { block: 'oak_log', count: 1 }, consent }),
      'BUSY',
    );
    expect(sent[1]?.payload).toMatchObject({ args: { block: 'oak_log', count: 1 }, consent });
  });

  it('resolves awaitJob from the reply or a later skill.result, and forwards progress', async () => {
    const { bridge, deliver, listeners } = fakeBridge((t, payload) => {
      if (t === 'skill.run') {
        return payload.skill === 'eat'
          ? { jobId: payload.jobId, status: 'done', result: { ate: 'bread' } }
          : { jobId: payload.jobId, status: 'running' };
      }
      return {};
    });
    const api = createBridgeSkillApi(bridge);
    const results: unknown[] = [];
    const progress: unknown[] = [];
    api.on('result', (end) => {
      results.push(end);
    });
    api.on('progress', (p) => {
      progress.push(p);
    });

    const eat = await api.runSkill({ agentId: 'ada', skill: 'eat', args: {}, jobId: 'job-1' });
    expect(eat.status).toBe('done');
    expect(await api.awaitJob('job-1')).toMatchObject({ status: 'done', result: { ate: 'bread' } });

    const mine = await api.runSkill({
      agentId: 'ada',
      skill: 'mine',
      args: { block: 'oak_log', count: 3 },
      jobId: 'job-2',
      waitMs: 0,
    });
    expect(mine.status).toBe('running');
    const waiting = api.awaitJob('job-2');
    deliver('skill.progress', { jobId: 'job-2', agentId: 'ada', text: '1/3 logs' });
    deliver('skill.result', { jobId: 'job-2', agentId: 'ada', status: 'done', durationMs: 900 });
    deliver('skill.result', { jobId: 'job-2', agentId: 'ada', status: 'done', durationMs: 900 });
    expect(await waiting).toEqual({ jobId: 'job-2', agentId: 'ada', status: 'done', durationMs: 900 });
    expect(results).toHaveLength(2);
    expect(progress).toEqual([{ jobId: 'job-2', agentId: 'ada', text: '1/3 logs' }]);

    await rejectsWith(api.awaitJob('job-never', 5), 'TIMEOUT');
    api.dispose();
    expect([...listeners.values()].every((l) => l.length === 0)).toBe(true);
  });

  it('cancels, observes, seats and spawns over the bridge', async () => {
    const { bridge, sent } = fakeBridge((t, payload) => {
      switch (t) {
        case 'skill.cancel':
          return { cancelled: ['job-2'] };
        case 'obs.query':
          return { result: { hp: 20 } };
        case 'agent.seat':
          return { jobId: payload.jobId, status: 'running' };
        case 'agent.spawn':
          return { pos: { x: 1.5, y: 64, z: 2.5 }, dim: 'minecraft:overworld', restored: true };
        default:
          return {};
      }
    });
    const api = createBridgeSkillApi(bridge);
    expect(await api.cancelSkill('ada', { reason: 'stop' })).toEqual(['job-2']);
    expect(await api.obsQuery('ada', 'status')).toEqual({ hp: 20 });
    const seat = await api.seat({ agentId: 'bram', seatEpoch: 4, target: { kind: 'pc', pcId: 'linux-1' } });
    expect(seat.status).toBe('running');
    await api.unseat({ agentId: 'bram', seatEpoch: 4, reason: 'kick', keepReservation: false });
    await api.setMode('ada', 'stay', { x: 1, y: 2, z: 3 });
    expect(
      (
        await api.spawn({
          agentId: 'ada',
          handle: 'ada',
          name: 'Ada',
          role: 'ceo',
          ceo: true,
          restore: true,
          mode: 'follow',
        })
      ).restored,
    ).toBe(true);
    await api.despawn({ agentId: 'ada', reason: 'shutdown', farewell: false });
    expect(sent.map((s) => s.t)).toEqual([
      'skill.cancel',
      'obs.query',
      'agent.seat',
      'agent.unseat',
      'agent.mode',
      'agent.spawn',
      'agent.despawn',
    ]);
    for (const s of sent)
      expect(() => createMessage(s.t as 'agent.seat', s.payload as never, { id: 'n-1' })).not.toThrow();
  });
});

describe('FakeSkillApi', () => {
  it('scripts jobs: busy, replace, finish, cancel', async () => {
    const api = new FakeSkillApi();
    api.skillHandler = (req) =>
      req.skill === 'mine' ? { status: 'running' } : { status: 'done', result: { ok: true } };
    expect((await api.runSkill({ agentId: 'ada', skill: 'eat', args: {} })).status).toBe('done');
    const mine = await api.runSkill({
      agentId: 'ada',
      skill: 'mine',
      args: { block: 'stone', count: 5 },
      jobId: 'j1',
    });
    expect(mine.status).toBe('running');
    await rejectsWith(api.runSkill({ agentId: 'ada', skill: 'eat', args: {} }), 'BUSY');
    const waiting = api.awaitJob('j1');
    api.progress('j1', '2/5 stone', 0.4);
    api.finish('j1', { status: 'failed', code: 'UNREACHABLE', msg: 'no path' });
    expect((await waiting).error?.code).toBe('UNREACHABLE');

    await api.runSkill({ agentId: 'ada', skill: 'mine', args: { block: 'stone', count: 5 }, jobId: 'j2' });
    await api.runSkill({ agentId: 'ada', skill: 'eat', args: {}, replace: true });
    expect((await api.awaitJob('j2')).status).toBe('cancelled');
    await rejectsWith(
      api.runSkill({ agentId: 'ada', skill: 'mine', args: { block: 'Stone!', count: 1 } }),
      'BAD_ARGS',
    );
    api.observations.set('status', { hp: 20 });
    expect(await api.obsQuery('ada', 'status')).toEqual({ hp: 20 });
    await api.setMode('ada', 'guard');
    expect(api.modeOf('ada')).toBe('guard');
    expect(api.runs).toHaveLength(5);
  });
});
