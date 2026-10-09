import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CalendarCrew,
  CalendarService,
  type TaskDelivery,
} from '../../../src/org/calendar/CalendarService.js';
import { formatGameTime, gameTicksAt } from '../../../src/org/clock.js';
import { CodexStore } from '../../../src/org/codex/CodexStore.js';
import { ControlNonce } from '../../../src/org/envelope.js';
import {
  type MeetingBrain,
  type MeetingCrewMember,
  type MeetingRequest,
  MeetingRunner,
  type MeetingState,
  type MeetingTurnRequest,
  type MeetingTurnResult,
  type PlayerSnapshot,
  type StatusLine,
} from '../../../src/org/meeting/MeetingRunner.js';
import { ManualClock } from '../../helpers/manualClock.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Scripted = (req: MeetingTurnRequest) => MeetingTurnResult | Promise<MeetingTurnResult>;

/** A scripted brain: answers per turn kind, records every request, optionally takes time per turn. */
class ScriptedBrain implements MeetingBrain {
  readonly requests: MeetingTurnRequest[] = [];
  readonly aborted: string[] = [];
  delayMs = 0;
  hang = false;
  script: Partial<Record<MeetingTurnRequest['kind'], Scripted>> = {};
  constructor(private readonly clock: ManualClock) {}

  async turn(req: MeetingTurnRequest, signal: AbortSignal): Promise<MeetingTurnResult> {
    this.requests.push(req);
    signal.addEventListener('abort', () => this.aborted.push(`${req.kind}:${req.agentId}`), { once: true });
    if (this.hang) return new Promise(() => {});
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, this.delayMs));
    }
    const fn = this.script[req.kind];
    if (fn) return fn(req);
    return { text: `${req.agentId} ${req.kind}.` };
  }

  kinds(): string[] {
    return this.requests.map((r) => `${r.kind}:${r.agentId}`);
  }
}

function member(agentId: string, name: string, extra: Partial<MeetingCrewMember> = {}): MeetingCrewMember {
  return {
    agentId,
    name,
    status: 'alive',
    isCeo: false,
    seated: false,
    dimension: 'minecraft:overworld',
    escortingPlayer: false,
    distanceToPlayer: 10,
    ...extra,
  };
}

async function harness(options: { codex?: boolean } = {}) {
  const clock = new ManualClock();
  const nonce = new ControlNonce('abcd');
  let crew: MeetingCrewMember[] = [
    member('ada', 'Ada', { isCeo: true }),
    member('bram', 'Bram', { seated: true }),
    member('cleo', 'Cleo'),
  ];
  const etas = new Map<string, number | null>([
    ['ada', 10],
    ['bram', 20],
    ['cleo', 30],
  ]);
  const player: { value: PlayerSnapshot } = {
    value: { hpFraction: 1, inCombat: false, distanceToTable: 5, isNight: false },
  };
  const usage: { value: { state: 'ok' | 'tired' | 'asleep'; resetsAt?: number } } = {
    value: { state: 'ok' },
  };
  const status = new Map<string, StatusLine>();
  const fx = {
    states: [] as MeetingState[],
    gather: [] as string[],
    interrupted: [] as string[],
    debounce: [] as Array<[string, number]>,
    dialIn: [] as Array<[string, string]>,
    dismissed: [] as Array<[string, boolean]>,
    toasts: [] as string[],
    markers: [] as Array<string | null>,
    cards: [] as string[][],
    said: [] as Array<[string, string]>,
  };
  const brain = new ScriptedBrain(clock);

  let runner: MeetingRunner | null = null;
  const calCrew: CalendarCrew = {
    living: () => crew.filter((c) => c.status === 'alive').map((c) => c.agentId),
    status: (id) => crew.find((c) => c.agentId === id)?.status ?? 'unknown',
    isCeo: (id) => crew.find((c) => c.agentId === id)?.isCeo === true,
    ceoId: () => crew.find((c) => c.isCeo && c.status === 'alive')?.agentId ?? null,
    name: (id) => crew.find((c) => c.agentId === id)?.name ?? id,
    usage: () => ({ state: 'ok' }),
    inMeeting: (id) => runner?.isAttending(id) ?? false,
  };
  const tasks: TaskDelivery[] = [];
  const calendar = new CalendarService({
    nonce,
    crew: calCrew,
    clock,
    timeZone: 'UTC',
    sink: { deliverTask: (d) => tasks.push(d) },
  });
  await calendar.open('world-1');
  calendar.onGameClock(gameTicksAt(3, 8));
  calendar.start();

  let codex: CodexStore | undefined;
  if (options.codex !== false) {
    const dir = mkdtempSync(join(tmpdir(), 'mv-meet-'));
    tmpDirs.push(dir);
    codex = new CodexStore({
      root: join(dir, 'codex'),
      exportDir: null,
      gitBinary: null,
      clock,
      gameDay: () => 3,
    });
    await codex.open('world-1');
  }

  runner = new MeetingRunner({
    world: {
      crew: () => crew,
      etaSeconds: (id) => etas.get(id) ?? null,
      tableDimension: () => 'minecraft:overworld',
      player: () => player.value,
      usage: () => usage.value,
      statusLine: (id) => status.get(id) ?? { todo: [], lastActivity: '' },
    },
    brain,
    nonce,
    clock,
    codex,
    calendar,
    playerName: 'Jordan',
    formatNow: () => formatGameTime(calendar.gameTicks ?? 0),
    effects: {
      state: (s) => fx.states.push(s),
      gather: (id) => fx.gather.push(id),
      interruptSeated: (id) => fx.interrupted.push(id),
      stretchSwapDebounce: (id, ms) => fx.debounce.push([id, ms]),
      dialIn: (id, _m, reason) => fx.dialIn.push([id, reason]),
      dismiss: (id, info) => fx.dismissed.push([id, info.returnToPc]),
      toast: (t) => fx.toasts.push(t),
      marker: (m) => fx.markers.push(m),
      raiseCards: (ids) => fx.cards.push([...ids]),
      say: (id, text) => fx.said.push([id, text]),
    },
  });
  const r = runner;
  return {
    clock,
    runner: r,
    brain,
    fx,
    calendar,
    codex,
    tasks,
    etas,
    player,
    usage,
    status,
    setCrew: (c: MeetingCrewMember[]) => {
      crew = c;
    },
    crew: () => crew,
    /** Lets the runner reach its next wait. */
    settle: () => clock.advance(0),
    arriveAll: async () => {
      await clock.advance(0);
      for (const c of crew) r.arrived(c.agentId);
      await clock.advance(0);
    },
  };
}

/** Keeps the floor open with a player message every 20 s for `ms`. */
async function keepFloorBusy(h: Awaited<ReturnType<typeof harness>>, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 20_000) {
    if (h.runner.active?.phase === 'floor') h.runner.playerMessage('Anything else?');
    await h.clock.advance(20_000);
  }
}

const everyone = (extra: Partial<MeetingRequest> = {}): MeetingRequest => ({
  title: 'Morning standup',
  attendees: 'all',
  createdBy: 'player',
  scheduled: true,
  ...extra,
});

function phases(states: readonly MeetingState[]): string[] {
  return states.map((s) => s.phase).filter((p, i, a) => p !== a[i - 1]);
}

describe('MeetingRunner', () => {
  it('runs open → updates → floor → wrap-up with minutes to the Codex and action items to the calendar', async () => {
    const h = await harness();
    h.setCrew([
      member('ada', 'Ada', { isCeo: true }),
      member('bram', 'Bram', { seated: true }),
      member('cleo', 'Cleo'),
      member('dora', 'Dora'),
      member('eve', 'Eve', { status: 'dead' }),
    ]);
    h.etas.set('dora', 200);
    h.brain.script = {
      update: (r) =>
        r.agentId === 'bram'
          ? { text: 'Fixed the test. Pushed it. Next the docs. Then lunch. Then more.' }
          : { text: `${r.agentId} update.` },
      floor_chair: () => ({ text: 'Good question.', responders: ['cleo', 'dora', 'bram', 'ghost'] }),
      wrapup: () => ({
        text: 'Done.',
        summary: 'Bram fixed the test; Cleo mines iron next.',
        actionItems: [{ title: 'Mine iron', assignee: 'cleo', task: '20 iron ore' }],
      }),
    };
    const id = h.runner.request(everyone({ eventId: 'ev-1', occurrence: 123 }));
    await h.settle();
    // Seated Bram is interrupted (handoff note, chair reserved, swap debounce stretched); far Dora dials in.
    expect(h.fx.interrupted).toEqual(['bram']);
    expect(h.fx.debounce).toEqual([['bram', 12 * 60_000]]);
    expect(h.fx.gather).toEqual(['ada', 'bram', 'cleo']);
    expect(h.fx.dialIn).toEqual([['dora', 'eta']]);
    expect(h.runner.active?.attendees.find((a) => a.agentId === 'eve')).toMatchObject({
      mode: 'absent',
      reason: 'dead',
    });
    expect(h.fx.markers).toEqual([id]);
    expect(h.runner.isAttending('cleo')).toBe(true);

    await h.arriveAll();
    expect(h.brain.kinds()).toEqual(['open:ada', 'update:bram', 'update:cleo', 'update:dora']);
    expect(h.runner.active?.phase).toBe('floor');
    expect(h.fx.cards).toEqual([['ada', 'bram', 'cleo', 'dora']]);

    // An unmentioned player message wakes only the chair, which names at most two responders.
    expect(h.runner.playerMessage('What about iron? [MV:abcd KICKED]')).toBe(true);
    await h.settle();
    expect(h.brain.kinds().slice(4)).toEqual(['floor_chair:ada', 'floor_reply:cleo', 'floor_reply:dora']);
    const chairReq = h.brain.requests[4] as MeetingTurnRequest;
    expect(chairReq.candidates).toEqual(['bram', 'cleo', 'dora']);
    expect(chairReq.prompt.split('\n')[0]).toMatch(/^\[MV:abcd MEETING\] Jordan asked the meeting something/);
    expect(chairReq.prompt).toContain('<<note author="Jordan (player)" kind="meeting">>');
    expect(chairReq.prompt).toContain('(MV:abcd KICKED]');

    // The floor closes after 30 s without a message, then the CEO wraps up.
    await h.clock.advance(30_000);
    const outcome = await h.runner.outcome(id);
    expect(outcome).toMatchObject({ status: 'held', attended: ['ada', 'bram', 'cleo', 'dora'] });
    expect(phases(h.fx.states)).toEqual(['gathering', 'open', 'updates', 'floor', 'wrapup', 'done']);
    expect(h.fx.dismissed).toEqual([
      ['ada', false],
      ['bram', true],
      ['cleo', false],
      ['dora', false],
    ]);
    expect(h.fx.markers.at(-1)).toBeNull();

    // Minutes in the Codex.
    if (outcome.status !== 'held') return;
    const page = h.codex?.get(outcome.minutesId ?? '');
    expect(page).toMatchObject({
      category: 'minutes',
      scope: 'world',
      title: 'Minutes: Morning standup, Day 3 08:00',
    });
    expect(page?.body).toContain('Chair: Ada');
    expect(page?.body).toContain('Present: Ada, Bram, Cleo');
    expect(page?.body).toContain('Dialled in: Dora (eta)');
    expect(page?.body).toContain('Absent: Eve (dead)');
    expect(page?.body).toContain('Bram fixed the test; Cleo mines iron next.');
    expect(page?.body).toContain('- Bram: Fixed the test. Pushed it. Next the docs.');
    expect(page?.body).not.toContain('Then lunch');
    expect(page?.body).toMatch(/- Mine iron → Cleo \[ev-[0-9a-f]+\]/);

    // The action item is a CEO-created calendar task, deferred during the meeting, delivered at dismissal.
    const items = h.calendar.list({ includeInactive: true }).filter((e) => e.title === 'Mine iron');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ createdBy: 'ada', createdByCeo: true, assignees: ['cleo'] });
    await h.clock.advance(1000);
    expect(h.tasks.map((t) => t.agentId)).toEqual(['cleo']);
    expect(h.calendar.get(items[0]?.id ?? '')?.ring[0]?.assignees).toEqual({ cleo: 'fired' });
    // And the calendar occurrence that triggered the meeting is closed.
    expect(h.runner.active).toBeNull();
  });

  it('records the triggering occurrence on the calendar event', async () => {
    const h = await harness();
    const ev = h.calendar.add(
      { kind: 'player', name: 'Jordan' },
      { title: 'Sync', kind: 'meeting', when: 'Day 3 09:00' },
    );
    if (!ev.ok) throw new Error(ev.message);
    const at = gameTicksAt(3, 9);
    const id = h.runner.request(everyone({ eventId: ev.event.id, occurrence: at }));
    await h.arriveAll();
    await h.clock.advance(31_000);
    await h.runner.outcome(id);
    expect(h.calendar.get(ev.event.id)?.ring.find((o) => o.at === at)).toMatchObject({
      status: 'done',
      note: 'held: 3 attended',
    });
  });

  it('excuses seated agents from agent-created meetings', async () => {
    const h = await harness();
    h.runner.request(everyone({ createdBy: 'ada' }));
    await h.settle();
    expect(h.fx.interrupted).toEqual([]);
    expect(h.runner.active?.attendees.find((a) => a.agentId === 'bram')).toMatchObject({
      mode: 'excused',
      reason: 'seated',
    });
  });

  it('dials in agents in another dimension or escorting a far player; escorts near the player stay with the player', async () => {
    const h = await harness();
    h.setCrew([
      member('ada', 'Ada', { isCeo: true }),
      member('nether', 'Nia', { dimension: 'minecraft:the_nether' }),
      member('escort', 'Eli', { escortingPlayer: true, distanceToPlayer: 8 }),
      member('walker', 'Wes'),
    ]);
    h.etas.set('walker', 40);
    h.runner.request(everyone());
    await h.settle();
    expect(h.fx.dialIn).toEqual([
      ['nether', 'dimension'],
      ['escort', 'escort'],
    ]);
    expect(h.fx.gather).toEqual(['ada', 'walker']);
  });

  it('marks walkers who do not arrive within 120 s as late dial-ins', async () => {
    const h = await harness();
    h.runner.request(everyone());
    await h.settle();
    h.runner.arrived('ada');
    await h.clock.advance(120_000);
    const st = h.fx.states.find((s) => s.phase === 'open');
    expect(st?.attendees.filter((a) => a.mode === 'dial_in').map((a) => [a.agentId, a.reason])).toEqual([
      ['bram', 'late'],
      ['cleo', 'late'],
    ]);
  });

  it('postpones once without quorum (the CEO plus one), then marks the meeting missed', async () => {
    const h = await harness();
    h.setCrew([member('ada', 'Ada', { isCeo: true }), member('bram', 'Bram', { status: 'dead' })]);
    h.player.value = { ...h.player.value, distanceToTable: 100 };
    const ev = h.calendar.add(
      { kind: 'player', name: 'Jordan' },
      { title: 'Solo', kind: 'meeting', when: 'Day 3 10:00' },
    );
    if (!ev.ok) throw new Error(ev.message);
    const id = h.runner.request(everyone({ eventId: ev.event.id, occurrence: gameTicksAt(3, 10) }));
    await h.settle();
    expect(h.fx.toasts.some((t) => t.includes('no quorum'))).toBe(true);
    await h.clock.advance(120_000);
    expect(await h.runner.outcome(id)).toEqual({ status: 'missed', reason: 'no quorum' });
    expect(h.brain.requests).toHaveLength(0);
    expect(h.calendar.get(ev.event.id)?.ring.at(-1)).toMatchObject({ status: 'missed', note: 'no quorum' });

    // The player at the table makes quorum with the CEO.
    h.player.value = { ...h.player.value, distanceToTable: 4 };
    const id2 = h.runner.request(everyone());
    await h.arriveAll();
    await h.clock.advance(31_000);
    expect((await h.runner.outcome(id2)).status).toBe('held');
  });

  it('holds quorum when an attendee arrives during the retry', async () => {
    const h = await harness();
    h.setCrew([member('ada', 'Ada', { isCeo: true }), member('bram', 'Bram', { status: 'dead' })]);
    h.player.value = { ...h.player.value, distanceToTable: 100 };
    const id = h.runner.request(everyone());
    await h.settle();
    h.setCrew([member('ada', 'Ada', { isCeo: true }), member('cleo', 'Cleo')]);
    await h.clock.advance(120_000);
    await h.arriveAll();
    await h.clock.advance(31_000);
    expect((await h.runner.outcome(id)).status).toBe('held');
  });

  it('postpones scheduled meetings while the player is unsafe, up to one game hour', async () => {
    const h = await harness();
    h.player.value = { hpFraction: 0.3, inCombat: false, distanceToTable: 5, isNight: false };
    const id = h.runner.request(everyone());
    await h.settle();
    expect(h.fx.toasts[0]).toBe('Meeting "Morning standup" postponed: Jordan is hurt');
    expect(h.fx.gather).toEqual([]);
    await h.clock.advance(20_000);
    h.player.value = { hpFraction: 0.9, inCombat: false, distanceToTable: 5, isNight: false };
    await h.clock.advance(5_000);
    expect(h.fx.gather).toEqual(['ada', 'bram', 'cleo']);
    await h.arriveAll();
    await h.clock.advance(31_000);
    expect((await h.runner.outcome(id)).status).toBe('held');

    // Combat that lasts more than a game hour: missed.
    h.player.value = { hpFraction: 1, inCombat: true, distanceToTable: 5, isNight: false };
    const id2 = h.runner.request(everyone());
    await h.clock.advance(55_000);
    expect(await h.runner.outcome(id2)).toEqual({
      status: 'missed',
      reason: 'postponed too long (Jordan is in combat)',
    });

    // Far from the table at night counts too; "Start meeting now" skips the safety check.
    h.player.value = { hpFraction: 1, inCombat: false, distanceToTable: 100, isNight: true };
    h.runner.request(everyone({ scheduled: false, playerChairs: true }));
    await h.settle();
    expect(h.runner.active?.phase).toBe('gathering');
  });

  it('waits for usage when asleep and uses the short format when tired', async () => {
    const h = await harness();
    h.usage.value = { state: 'asleep', resetsAt: h.clock.now() + 60_000 };
    const id = h.runner.request(everyone());
    await h.settle();
    expect(h.fx.gather).toEqual([]);
    h.usage.value = { state: 'tired' };
    await h.clock.advance(60_000);
    await h.arriveAll();
    expect(await h.runner.outcome(id)).toMatchObject({ status: 'held' });
    expect(phases(h.fx.states)).toEqual(['gathering', 'open', 'updates', 'wrapup', 'done']);
    expect(h.runner.active).toBeNull();
  });

  it('renders a quick standup at zero tokens and gives turns only to blocked agents', async () => {
    const h = await harness();
    h.status.set('bram', { todo: ['fix tests', 'write docs'], lastActivity: 'ran npm test' });
    h.status.set('cleo', { todo: ['mine iron'], lastActivity: 'walking to the cave', blocker: 'no pickaxe' });
    const id = h.runner.request(everyone({ quick: true }));
    await h.arriveAll();
    await h.clock.advance(31_000);
    const outcome = await h.runner.outcome(id);
    expect(h.brain.kinds()).toEqual(['open:ada', 'update:cleo', 'wrapup:ada']);
    if (outcome.status !== 'held') throw new Error('not held');
    const body = h.codex?.get(outcome.minutesId ?? '')?.body ?? '';
    expect(body).toContain('- Bram (standup): todo: fix tests; write docs; last: ran npm test');
    expect(body).toContain('- Cleo is blocked: no pickaxe');
  });

  it('skips the floor after 30 s without a player message', async () => {
    const h = await harness();
    const id = h.runner.request(everyone());
    await h.arriveAll();
    expect(h.runner.active?.phase).toBe('floor');
    await h.clock.advance(29_000);
    expect(h.runner.active?.phase).toBe('floor');
    await h.clock.advance(1_000);
    expect((await h.runner.outcome(id)).status).toBe('held');
    expect(h.brain.kinds().filter((k) => k.startsWith('floor'))).toEqual([]);
  });

  it('caps meetings at 10 real minutes and writes partial minutes at zero tokens', async () => {
    const h = await harness();
    h.brain.script.wrapup = () => new Promise(() => {}); // the CEO never finishes wrapping up
    const id = h.runner.request(everyone());
    await h.arriveAll();
    await keepFloorBusy(h, 10 * 60_000);
    const outcome = await h.runner.outcome(id);
    expect(outcome).toMatchObject({ status: 'adjourned', reason: 'the 10-minute cap' });
    if (outcome.status !== 'adjourned') return;
    const body = h.codex?.get(outcome.minutesId ?? '')?.body ?? '';
    expect(body).toContain('Adjourned early: the 10-minute cap. Partial minutes.');
    expect(h.brain.aborted).toContain('wrapup:ada');
    // The floor closed with time left for the wrap-up.
    expect(h.brain.kinds().at(-1)).toBe('wrapup:ada');
  });

  it('ends on the HUD button or "@meeting end" and dismisses everyone', async () => {
    const h = await harness();
    const id = h.runner.request(everyone());
    await h.arriveAll();
    h.runner.end('ended by Jordan');
    await h.settle();
    expect(await h.runner.outcome(id)).toMatchObject({ status: 'adjourned', reason: 'ended by Jordan' });
    expect(h.fx.dismissed.map(([a]) => a)).toEqual(['ada', 'bram', 'cleo']);
    expect(h.runner.isAttending('ada')).toBe(false);
  });

  it('drops a dead attendee from the speaker order and hands the chair to a nearby player', async () => {
    const h = await harness();
    h.brain.delayMs = 1000;
    const id = h.runner.request(everyone());
    await h.arriveAll();
    // Bram dies before his update; the chair dies after.
    h.runner.agentDied('bram');
    await h.clock.advance(1000); // open
    await h.clock.advance(1000); // cleo
    expect(h.brain.kinds()).toEqual(['open:ada', 'update:cleo']);
    h.runner.agentDied('ada');
    expect(h.fx.toasts.at(-1)).toBe('Ada died. You chair the meeting.');
    await h.clock.advance(31_000);
    const outcome = await h.runner.outcome(id);
    expect(outcome.status).toBe('held');
    expect(h.brain.kinds()).toEqual(['open:ada', 'update:cleo']); // no CEO wrap-up turn
    expect(h.fx.dismissed.map(([a]) => a)).toEqual(['cleo']);
  });

  it('adjourns with partial minutes when the chair dies and the player is not at the table', async () => {
    const h = await harness();
    h.brain.delayMs = 1000;
    const id = h.runner.request(everyone());
    await h.arriveAll();
    await h.clock.advance(1000);
    h.player.value = { ...h.player.value, distanceToTable: 40 };
    h.runner.agentDied('ada');
    await h.settle();
    const outcome = await h.runner.outcome(id);
    expect(outcome).toMatchObject({ status: 'adjourned', reason: 'the chair died' });
    if (outcome.status !== 'adjourned') return;
    expect(h.codex?.get(outcome.minutesId ?? '')?.body).toContain('Adjourned early: the chair died.');
  });

  it('runs one meeting at a time; queued ones expire after 10 minutes', async () => {
    const h = await harness();
    h.brain.script.wrapup = () => new Promise(() => {});
    const first = h.runner.request(everyone({ title: 'First' }));
    const second = h.runner.request(everyone({ title: 'Second' }));
    expect(h.runner.queued).toBe(1);
    expect(h.fx.toasts).toContain('Meeting "Second" is queued behind the current one');
    await h.clock.advance(60_000); // a slow gathering
    await h.arriveAll();
    await keepFloorBusy(h, 10 * 60_000);
    expect((await h.runner.outcome(first)).status).toBe('adjourned');
    expect(await h.runner.outcome(second)).toEqual({
      status: 'missed',
      reason: 'queued too long behind another meeting',
    });
  });

  it('starts the next queued meeting when the first ends in time', async () => {
    const h = await harness();
    const first = h.runner.request(everyone({ title: 'First' }));
    const second = h.runner.request(everyone({ title: 'Second' }));
    await h.arriveAll();
    await h.clock.advance(30_000);
    expect((await h.runner.outcome(first)).status).toBe('held');
    await h.arriveAll();
    expect(h.runner.active?.title).toBe('Second');
    await h.clock.advance(30_000);
    expect((await h.runner.outcome(second)).status).toBe('held');
  });

  it('times out a silent speaker and moves on', async () => {
    const h = await harness();
    h.brain.script.update = (r) => (r.agentId === 'bram' ? new Promise(() => {}) : { text: 'ok.' });
    const id = h.runner.request(everyone());
    await h.arriveAll();
    await h.clock.advance(90_000);
    expect(h.brain.kinds()).toContain('update:cleo');
    await h.clock.advance(31_000);
    const outcome = await h.runner.outcome(id);
    if (outcome.status !== 'held') throw new Error('not held');
    expect(h.codex?.get(outcome.minutesId ?? '')?.body).toContain('- Bram: (no answer)');
  });

  it('exposes the chat scope and previews ETAs for "Start meeting now"', async () => {
    const h = await harness();
    expect(h.runner.chatScope()).toBeNull();
    expect(h.runner.playerMessage('hello')).toBe(false);
    expect(h.runner.previewEtas()).toEqual([
      { agentId: 'ada', name: 'Ada', etaSec: 10, mode: 'walking', reason: undefined },
      { agentId: 'bram', name: 'Bram', etaSec: 20, mode: 'walking', reason: undefined },
      { agentId: 'cleo', name: 'Cleo', etaSec: 30, mode: 'walking', reason: undefined },
    ]);
    h.runner.request(everyone());
    await h.arriveAll();
    expect(h.runner.chatScope()).toMatchObject({
      attendees: ['ada', 'bram', 'cleo'],
      chairId: 'ada',
      playerInScope: true,
    });
    h.player.value = { ...h.player.value, distanceToTable: 30 };
    expect(h.runner.chatScope()?.playerInScope).toBe(false);
  });
});

describe('MeetingRunner: cancelAll (world death, shutdown)', () => {
  it('misses a meeting waiting for usage and every queued one, so none runs in the next world', async () => {
    const h = await harness();
    h.usage.value = { state: 'asleep', resetsAt: h.clock.now() + 3_600_000 };
    const waiting = h.runner.request(everyone({ title: 'Waiting' }));
    const queued = h.runner.request(everyone({ title: 'Queued', scheduled: false }));
    await h.settle();
    expect(h.fx.toasts).toContain('Meeting "Queued" is queued behind the current one');
    h.runner.cancelAll('the world ended');
    expect(await h.runner.outcome(waiting)).toEqual({ status: 'missed', reason: 'the world ended' });
    expect(await h.runner.outcome(queued)).toEqual({ status: 'missed', reason: 'the world ended' });
    h.usage.value = { state: 'ok' };
    await h.clock.advance(3_700_000);
    expect(h.fx.gather).toEqual([]);
    expect(h.runner.active).toBeNull();
  });

  it('adjourns the active meeting', async () => {
    const h = await harness();
    const id = h.runner.request(everyone());
    await h.arriveAll();
    h.runner.cancelAll('MineVibe is closing');
    expect(await h.runner.outcome(id)).toMatchObject({ status: 'adjourned', reason: 'MineVibe is closing' });
  });
});
