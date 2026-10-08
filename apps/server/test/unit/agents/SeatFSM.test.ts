import { describe, expect, it } from 'vitest';
import { Mutex, SeatFSM, SeatTransitionError } from '../../../src/agents/SeatFSM.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SeatFSM (PLAN §6.3)', () => {
  it('walks the full PC path with the swap states', () => {
    const c = clock();
    const fsm = new SeatFSM({ now: c.now });
    expect(fsm.state).toBe('wandering');
    const sit = fsm.beginSit({ kind: 'pc', pcId: 'linux-1' }, { purpose: 'fix', jobId: 'j1' });
    expect(sit).toMatchObject({ from: 'wandering', to: 'walking_to_seat', epoch: 0 });
    expect(fsm.holdsPcSeat).toBe(true);
    expect(fsm.wantsOpus()).toBe(false);
    expect(fsm.arrived().to).toBe('seated_pending_swap');
    expect(fsm.wantsOpus()).toBe(true);
    expect(fsm.hasPcAccess).toBe(false);
    expect(fsm.boundary()?.to).toBe('seated');
    expect(fsm.hasPcAccess).toBe(true);
    expect(fsm.snapshot).toMatchObject({ pcId: 'linux-1', purpose: 'fix', jobId: 'j1', kind: 'pc' });
    const stand = fsm.stand('stand');
    expect(stand).toMatchObject({ from: 'seated', to: 'standing_pending_swap', epochBefore: 0, epoch: 1 });
    expect(fsm.hasPcAccess).toBe(false);
    expect(fsm.boundary()?.to).toBe('wandering');
    expect(fsm.boundary()).toBeNull();
  });

  it('keeps Opus for 60 s after a voluntary stand (debounce) but not after a kick', () => {
    const c = clock();
    const fsm = new SeatFSM({ now: c.now });
    fsm.beginSit({ kind: 'pc', pcId: 'linux-1' });
    fsm.arrived();
    fsm.boundary();
    fsm.stand('stand');
    fsm.boundary();
    expect(fsm.wantsOpus()).toBe(true);
    c.advance(59_000);
    expect(fsm.wantsOpus()).toBe(true);
    c.advance(1_001);
    expect(fsm.wantsOpus()).toBe(false);

    fsm.beginSit({ kind: 'pc', pcId: 'linux-1' });
    fsm.arrived();
    fsm.boundary();
    fsm.stand('kick');
    expect(fsm.wantsOpus()).toBe(false);
    expect(fsm.snapshot.lastEnd).toBe('kick');
  });

  it('meetings stretch the debounce; meeting seats never want Opus or count as PC seats', () => {
    const c = clock();
    const fsm = new SeatFSM({ now: c.now });
    fsm.beginSit({ kind: 'pc', pcId: 'linux-1' });
    fsm.arrived();
    fsm.boundary();
    fsm.stand('meeting', { debounceMs: 12 * 60_000 });
    fsm.boundary();
    c.advance(10 * 60_000);
    expect(fsm.wantsOpus()).toBe(true);
    const m = new SeatFSM({ now: c.now });
    m.beginSit({ kind: 'meeting', meetingId: 'm1' });
    expect(m.arrived().to).toBe('seated');
    expect(m.holdsPcSeat).toBe(false);
    expect(m.wantsOpus()).toBe(false);
    expect(m.hasPcAccess).toBe(false);
    expect(m.stand('stand').to).toBe('wandering');
  });

  it('seated ⇄ away_from_seat keeps the epoch; losing the chair while away bumps it', () => {
    const c = clock();
    const fsm = new SeatFSM({ now: c.now, awayMs: 180_000 });
    fsm.beginSit({ kind: 'pc', pcId: 'linux-1' });
    fsm.arrived();
    fsm.boundary();
    const away = fsm.goAway();
    expect(away).toMatchObject({ to: 'away_from_seat', epoch: 0 });
    expect(fsm.wantsOpus()).toBe(true);
    expect(fsm.holdsPcSeat).toBe(true);
    expect(fsm.awayExpired()).toBe(false);
    c.advance(180_000);
    expect(fsm.awayExpired()).toBe(true);
    expect(fsm.comeBack()).toMatchObject({ to: 'seated', epoch: 0 });
    fsm.goAway();
    expect(fsm.stand('player_took')).toMatchObject({ to: 'standing_pending_swap', epoch: 1 });
    expect(fsm.wantsOpus()).toBe(false);
  });

  it('every edge out of a seated state increments the epoch', () => {
    const reasons = [
      'stand',
      'kick',
      'damage',
      'survival',
      'death',
      'pc_down',
      'meeting',
      'world_end',
      'dismiss',
      'app_restart',
      'worker_restart',
    ] as const;
    for (const reason of reasons) {
      const fsm = new SeatFSM();
      fsm.beginSit({ kind: 'pc', pcId: 'p' });
      fsm.arrived();
      fsm.boundary();
      expect(fsm.stand(reason).epoch, reason).toBe(1);
    }
    const walking = new SeatFSM();
    walking.beginSit({ kind: 'pc', pcId: 'p' });
    expect(walking.sitFailed()).toMatchObject({ to: 'wandering', epoch: 1 });
    const pending = new SeatFSM();
    pending.beginSit({ kind: 'pc', pcId: 'p' });
    pending.arrived();
    expect(pending.stand('kick')).toMatchObject({
      from: 'seated_pending_swap',
      to: 'standing_pending_swap',
      epoch: 1,
    });
  });

  it('rejects impossible edges', () => {
    const fsm = new SeatFSM();
    expect(() => fsm.arrived()).toThrow(SeatTransitionError);
    expect(() => fsm.goAway()).toThrow(SeatTransitionError);
    expect(() => fsm.stand('stand')).toThrow(SeatTransitionError);
    fsm.beginSit({ kind: 'pc', pcId: 'p' });
    expect(() => fsm.beginSit({ kind: 'pc', pcId: 'q' })).toThrow(SeatTransitionError);
    expect(() => fsm.comeBack()).toThrow(SeatTransitionError);
  });

  it('reset and restore (app and worker restarts)', () => {
    const fsm = new SeatFSM({ epoch: 4 });
    fsm.beginSit({ kind: 'pc', pcId: 'p' });
    fsm.arrived();
    expect(fsm.reset('app_restart')).toMatchObject({ to: 'wandering', epoch: 5 });
    expect(fsm.wantsOpus()).toBe(false);
    const t = fsm.restoreSeated('linux-1', 9);
    expect(t.epoch).toBe(9);
    expect(fsm.hasPcAccess).toBe(true);
    expect(fsm.restoreSeated('linux-1', 2).epoch).toBe(9);
  });
});

describe('Mutex', () => {
  it('serializes async work and survives failures', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    const b = m.run(async () => {
      order.push('b');
      throw new Error('x');
    });
    const c = m.run(() => order.push('c'));
    await a;
    await expect(b).rejects.toThrow('x');
    await c;
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
