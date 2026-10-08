import { describe, expect, it } from 'vitest';
import { gameTicksAt } from '../../../src/org/clock.js';
import { isNightAt, WorldView } from '../../../src/org/worldView.js';

const player = {
  pos: { x: 0, y: 64, z: 0 },
  dim: 'minecraft:overworld',
  hp: 10,
  maxHp: 20,
  food: 20,
  inCombat: true,
  idleMs: 4_000,
  screen: 'PcControlScreen',
  seatedPc: 'linux-1',
};

describe('WorldView', () => {
  it('night is 19:00 to 05:00 on the overworld clock', () => {
    expect(isNightAt(gameTicksAt(2, 12))).toBe(false);
    expect(isNightAt(gameTicksAt(2, 19))).toBe(true);
    expect(isNightAt(gameTicksAt(3, 4, 59))).toBe(true);
    expect(isNightAt(gameTicksAt(3, 5))).toBe(false);
    expect(isNightAt(null)).toBe(false);
  });

  it('without a player snapshot the player is active, unhurt, and the night safety rule is off', () => {
    const view = new WorldView();
    view.setClock(gameTicksAt(2, 22));
    expect(view.playerSnapshot()).toEqual({
      hpFraction: 1,
      inCombat: false,
      distanceToTable: null,
      isNight: false,
    });
    expect(view.approachSnapshot(1_000).player).toMatchObject({ lastInputAt: 1_000, inPcScreen: false });
  });

  it('reads the player snapshot, the meeting table and the usage summary', () => {
    const view = new WorldView();
    view.setClock(gameTicksAt(2, 22));
    view.setOffice({
      origin: { x: 0, y: 64, z: 0 },
      slots: [{ kind: 'meeting_table', pos: { x: 3, y: 64, z: 4 } }],
    });
    view.setPlayer(player, 10_000);
    expect(view.playerSnapshot()).toEqual({
      hpFraction: 0.5,
      inCombat: true,
      distanceToTable: 5,
      isNight: true,
    });
    expect(view.approachSnapshot(12_000).player).toMatchObject({
      hostileNearby: true,
      inPcScreen: true,
      seated: true,
      lastInputAt: 6_000,
    });
    expect(view.usage()).toEqual({ state: 'ok' });
    view.setBrains({ mode: 'asleep', resetsAt: 99 });
    expect(view.usage()).toEqual({ state: 'asleep', resetsAt: 99 });
  });
});
