import { describe, expect, it } from 'vitest';
import {
  type AgentView,
  type ApproachCard,
  ApproachQueue,
  type ApproachSnapshot,
  type ApproachState,
  type PlayerView,
} from '../../../src/org/approach/ApproachQueue.js';
import { ManualClock } from '../../helpers/manualClock.js';

function harness() {
  const clock = new ManualClock();
  const log: string[] = [];
  const states: ApproachState[] = [];
  const q = new ApproachQueue({
    clock,
    effects: {
      approach: (a, c) => log.push(`approach ${a} ${c ?? 'null'}`),
      ping: (a, c, r) => log.push(`ping ${a} ${c} ${r}`),
      seat: (a, action) => log.push(`seat ${a} ${action}`),
      parked: (a, c) => log.push(`parked ${a} ${c}`),
      unparked: (a, c) => log.push(`unparked ${a} ${c}`),
      state: (s) => states.push(s),
    },
  });
  const player: PlayerView = {
    pos: { x: 0, y: 64, z: 0 },
    dimension: 'overworld',
    hostileNearby: false,
    lastDamageAt: null,
    inPcScreen: false,
    seated: false,
    lastInputAt: clock.now(),
    idle: false,
    inLitArea: true,
  };
  const agent = (x: number, extra: Partial<AgentView> = {}): AgentView => ({
    pos: { x, y: 64, z: 0 },
    dimension: 'overworld',
    seated: false,
    pathBlocks: Math.abs(x),
    pathNeedsDigging: false,
    inLitArea: true,
    ...extra,
  });
  let snap: ApproachSnapshot = {
    player,
    isNight: false,
    agents: { ada: agent(20), bram: agent(10), cleo: agent(30) },
  };
  const update = (
    patch: {
      player?: Partial<PlayerView>;
      agents?: Record<string, Partial<AgentView>>;
      isNight?: boolean;
      meetingAttendees?: string[];
    } = {},
  ) => {
    const agents: Record<string, AgentView> = { ...snap.agents };
    for (const [id, a] of Object.entries(patch.agents ?? {}))
      agents[id] = { ...(agents[id] ?? agent(0)), ...a };
    snap = {
      player: { ...snap.player, lastInputAt: clock.now(), ...patch.player },
      isNight: patch.isNight ?? snap.isNight,
      agents,
      meetingAttendees: patch.meetingAttendees ?? snap.meetingAttendees,
    };
    q.update(snap);
  };
  const card = (
    cardId: string,
    agentId: string,
    kind: ApproachCard['kind'],
    ageMs: number,
  ): ApproachCard => ({
    cardId,
    agentId,
    kind,
    createdAt: clock.now() - ageMs,
  });
  /** Advances time in 1 s steps, updating the snapshot each second (the 1 Hz agent.state). */
  const tick = async (ms: number, patch: Parameters<typeof update>[0] = {}) => {
    for (let t = 0; t < ms; t += 1000) {
      await clock.advance(1000);
      update(patch);
    }
  };
  return { clock, q, log, states, update, card, tick, agent };
}

describe('ApproachQueue', () => {
  it('presents one card at a time: blocking first, then oldest; queued agents wait', () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('h1', 'ada', 'hire', 60_000));
    expect(h.q.presenter).toMatchObject({ agentId: 'ada', cardId: 'h1', mode: 'approach' });
    h.q.resolve('h1');
    h.q.enqueue(h.card('h1', 'ada', 'hire', 60_000));
    h.q.enqueue(h.card('q1', 'bram', 'question', 10_000));
    // Ada is already presenting again (never pre-empted); Bram's question waits.
    expect(h.q.presenter?.agentId).toBe('ada');
    h.q.resolve('h1');
    h.q.enqueue(h.card('h2', 'ada', 'hire', 120_000));
    h.q.enqueue(h.card('p1', 'cleo', 'plan', 5_000));
    expect(h.q.presenter).toMatchObject({ agentId: 'bram', cardId: 'q1' });
    expect(h.q.state().queued).toEqual([
      { agentId: 'cleo', cardId: 'p1' },
      { agentId: 'ada', cardId: 'h2' },
    ]);
    h.q.resolve('q1');
    expect(h.q.presenter?.agentId).toBe('cleo');
    expect(h.log).toEqual([
      'approach ada h1',
      'approach ada null',
      'approach ada h1',
      'approach ada null',
      'approach bram q1',
      'approach bram null',
      'approach cleo p1',
    ]);
  });

  it('holds the card in combat and resumes after 8 s without damage', async () => {
    const h = harness();
    h.update({ player: { hostileNearby: true } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.presenter?.mode).toBe('hold');
    expect(h.log).toEqual([]);
    h.update({ player: { hostileNearby: false, lastDamageAt: h.clock.now() } });
    expect(h.q.presenter?.mode).toBe('hold');
    await h.tick(8000, { player: { hostileNearby: false } });
    expect(h.q.presenter?.mode).toBe('approach');
    expect(h.log).toEqual(['approach bram q1']);
  });

  it('pings instead of walking at night, far away, through rock, across dimensions and into a PC screen', () => {
    const cases: Array<[Parameters<ReturnType<typeof harness>['update']>[0], string]> = [
      [{ isNight: true, agents: { bram: { inLitArea: false } } }, 'night'],
      [{ agents: { bram: { pathBlocks: 60 } } }, 'far'],
      [{ agents: { bram: { pathNeedsDigging: true } } }, 'digging'],
      [{ agents: { bram: { dimension: 'the_nether' } } }, 'dimension'],
      [{ player: { inPcScreen: true } }, 'pc_screen'],
      [{ agents: { bram: { pathBlocks: null } } }, 'no_path'],
    ];
    for (const [patch, reason] of cases) {
      const h = harness();
      h.update(patch);
      h.q.enqueue(h.card('q1', 'bram', 'question', 0));
      expect(h.q.presenter, reason).toMatchObject({ mode: 'ping', reason });
      expect(h.log).toEqual([`ping bram q1 ${reason}`]);
    }
    // Night inside a lit area still walks.
    const lit = harness();
    lit.update({ isNight: true });
    lit.q.enqueue(lit.card('q1', 'bram', 'question', 0));
    expect(lit.q.presenter?.mode).toBe('approach');
  });

  it('switches from walking to a ping (and back) when the situation changes', () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    h.update({ player: { inPcScreen: true } });
    h.update({ player: { inPcScreen: false } });
    expect(h.log).toEqual([
      'approach bram q1',
      'approach bram null',
      'ping bram q1 pc_screen',
      'approach bram q1',
    ]);
  });

  it('parks on "later", keeps the card answerable, and returns after 10 minutes', async () => {
    const h = harness();
    h.update({ agents: { bram: { pos: { x: 40, y: 64, z: 0 }, pathBlocks: 40 } } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.later('bram')).toBe(true);
    expect(h.q.presenter).toBeNull();
    expect(h.q.state().parked).toEqual([
      { agentId: 'bram', cardId: 'q1', returnAt: h.clock.now() + 600_000 },
    ]);
    expect(h.q.later('bram')).toBe(false);
    await h.tick(599_000);
    expect(h.q.presenter).toBeNull();
    await h.tick(1000);
    expect(h.q.presenter).toMatchObject({ agentId: 'bram', cardId: 'q1' });
    expect(h.log).toEqual([
      'approach bram q1',
      'parked bram q1',
      'approach bram null',
      'unparked bram q1',
      'approach bram q1',
    ]);
    // Answering a parked card works too.
    h.q.later('bram');
    h.q.resolve('q1');
    expect(h.q.state().parked).toEqual([]);
  });

  it('brings a parked card back early when the player is idle within 16 blocks', async () => {
    const h = harness();
    h.update({ agents: { bram: { pos: { x: 40, y: 64, z: 0 } } } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    h.q.later('bram');
    await h.tick(5000, { player: { idle: true } }); // idle but far
    expect(h.q.presenter).toBeNull();
    await h.tick(1000, { player: { idle: true }, agents: { bram: { pos: { x: 10, y: 64, z: 0 } } } });
    expect(h.q.presenter?.agentId).toBe('bram');
  });

  it('auto-parks after 2 minutes shown (holds excluded) and after 2 minutes of player AFK', async () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    await h.tick(60_000);
    await h.tick(60_000, { player: { hostileNearby: true } }); // held: not counted
    expect(h.q.presenter?.cardId).toBe('q1');
    await h.tick(60_000, { player: { hostileNearby: false } });
    expect(h.q.presenter).toBeNull();
    expect(h.log).toContain('parked bram q1');

    const afk = harness();
    afk.update();
    afk.q.enqueue(afk.card('q2', 'cleo', 'question', 0));
    const lastInputAt = afk.clock.now();
    await afk.tick(119_000, { player: { lastInputAt } });
    expect(afk.q.presenter?.cardId).toBe('q2');
    await afk.tick(1000, { player: { lastInputAt } });
    expect(afk.q.presenter).toBeNull();
  });

  it('parks when the player walks away from a presenter that reached them', async () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    await h.tick(1000, { agents: { bram: { pos: { x: 2, y: 64, z: 0 } } } });
    expect(h.q.presenter?.cardId).toBe('q1');
    await h.tick(1000, { player: { pos: { x: 30, y: 64, z: 0 } } });
    expect(h.q.presenter).toBeNull();
    expect(h.q.state().parked.map((p) => p.cardId)).toEqual(['q1']);
  });

  it('seated agents ping by default and walk over only when the player is close, standing and safe', async () => {
    const h = harness();
    h.update({ agents: { bram: { seated: true, pos: { x: 40, y: 64, z: 0 } } } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.presenter).toMatchObject({ mode: 'ping', reason: 'seated' });
    // The player sits at a PC nearby: still a ping.
    h.update({
      player: { seated: true, inPcScreen: true },
      agents: { bram: { pos: { x: 10, y: 64, z: 0 } } },
    });
    expect(h.q.presenter).toMatchObject({ mode: 'ping', reason: 'pc_screen' });
    // Standing within 24 blocks: Bram reserves the chair and walks over.
    h.update({ player: { seated: false, inPcScreen: false } });
    expect(h.q.presenter?.mode).toBe('walk_from_seat');
    expect(h.q.isAway('bram')).toBe(true);
    expect(h.log.slice(-2)).toEqual(['seat bram reserve_and_walk', 'approach bram q1']);
    // Once away it stays away (the SeatFSM says away_from_seat, not seated).
    h.update({ agents: { bram: { seated: false } } });
    expect(h.q.presenter?.mode).toBe('walk_from_seat');
    // Answered: walk back and sit, no swap.
    h.q.resolve('q1');
    expect(h.log.slice(-2)).toEqual(['approach bram null', 'seat bram return']);
    expect(h.q.isAway('bram')).toBe(false);
  });

  it('returns a seated agent to its chair when its card parks', () => {
    const h = harness();
    h.update({ agents: { bram: { seated: true, pos: { x: 10, y: 64, z: 0 } } } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.presenter?.mode).toBe('walk_from_seat');
    h.q.later('bram');
    expect(h.log.slice(-2)).toEqual(['approach bram null', 'seat bram return']);
    expect(h.q.isAway('bram')).toBe(false);
  });

  it('expires the seat reservation after 3 minutes away and keeps the card', async () => {
    const h = harness();
    h.update({ agents: { bram: { seated: true, pos: { x: 10, y: 64, z: 0 } } } });
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.presenter?.mode).toBe('walk_from_seat');
    // A fight breaks out while Bram is away: the card is held (and the hold does not count toward auto-park).
    await h.tick(180_000, { player: { hostileNearby: true }, agents: { bram: { seated: false } } });
    expect(h.log).toContain('seat bram expire');
    expect(h.q.isAway('bram')).toBe(false);
    expect(h.q.presenter).toMatchObject({ cardId: 'q1', mode: 'hold' });
    // After the fight Bram is an ordinary wandering presenter.
    await h.tick(9000, { player: { hostileNearby: false } });
    expect(h.q.presenter).toMatchObject({ cardId: 'q1', mode: 'approach' });
    h.q.resolve('q1');
    expect(h.log.filter((l) => l === 'seat bram return')).toEqual([]);
  });

  it('honours "Ping instead of walking over" and lets a meeting win', () => {
    const h = harness();
    h.update();
    h.q.setPingPreference('bram', true);
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    expect(h.q.presenter).toMatchObject({ mode: 'ping', reason: 'setting' });
    h.q.setPingPreference('bram', false);
    expect(h.q.presenter?.mode).toBe('approach');
    h.update({ meetingAttendees: ['bram'] });
    // The meeting wins: Bram stops walking over and gives up the presenter slot; his card stays queued.
    expect(h.q.presenter).toBeNull();
    expect(h.log.at(-1)).toBe('approach bram null');
    expect(h.q.state().queued).toEqual([{ agentId: 'bram', cardId: 'q1' }]);
    h.update({ meetingAttendees: [] });
    expect(h.q.presenter).toMatchObject({ agentId: 'bram', cardId: 'q1', mode: 'approach' });
  });

  it('lets a non-attendee present while an attendee waits for the meeting to end (regression)', () => {
    const h = harness();
    h.update({ meetingAttendees: ['bram'] });
    h.q.enqueue(h.card('q1', 'bram', 'question', 60_000)); // older and blocking, but in the meeting
    h.q.enqueue(h.card('h1', 'cleo', 'hire', 0));
    expect(h.q.presenter).toMatchObject({ agentId: 'cleo', cardId: 'h1' });
    h.q.resolve('h1');
    expect(h.q.presenter).toBeNull();
    h.update({ meetingAttendees: [] });
    expect(h.q.presenter).toMatchObject({ agentId: 'bram', cardId: 'q1' });
  });

  it('"later" parks the card being presented, even when a blocking card arrived meanwhile (regression)', () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('h1', 'bram', 'hire', 0));
    expect(h.q.presenter?.cardId).toBe('h1');
    h.q.enqueue(h.card('q1', 'bram', 'question', 0)); // now Bram's front card, but h1 is on screen
    expect(h.q.later('bram')).toBe(true);
    expect(h.log).toContain('parked bram h1');
    expect(h.q.presenter).toMatchObject({ agentId: 'bram', cardId: 'q1' });
  });

  it('does not start presentations to an AFK player (regression: cards churned one per second)', async () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    h.q.enqueue(h.card('q2', 'cleo', 'question', 0));
    h.q.enqueue(h.card('q3', 'ada', 'question', 0));
    const lastInputAt = h.clock.now();
    await h.tick(125_000, { player: { lastInputAt } });
    // Bram's card auto-parked at 2 min of AFK; nobody else was shown or sent walking.
    expect(h.q.presenter).toBeNull();
    expect(h.log.filter((l) => l.startsWith('parked'))).toEqual(['parked bram q1']);
    expect(h.log.filter((l) => /^(approach|ping) (cleo|ada) /.test(l))).toEqual([]);
    // The player is back: the next card is presented.
    h.update();
    expect(h.q.presenter?.agentId).toMatch(/^(cleo|ada)$/);
  });

  it("drops an agent's cards when it dies or is dismissed", () => {
    const h = harness();
    h.update();
    h.q.enqueue(h.card('q1', 'bram', 'question', 0));
    h.q.enqueue(h.card('q2', 'bram', 'plan', 0));
    h.q.enqueue(h.card('q3', 'cleo', 'question', 0));
    h.q.removeAgent('bram');
    expect(h.q.presenter?.agentId).toBe('cleo');
    expect(h.states.at(-1)?.queued).toEqual([]);
  });
});
