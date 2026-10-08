import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  formatGameTime,
  formatRealTime,
  gameDay,
  gameTicksAt,
  gameTime,
  isValidTimeZone,
  parseGameWhen,
  parseRealWhen,
  sleep,
  weekdayOf,
  zonedParts,
  zonedToEpoch,
  zoneOffsetMs,
} from '../../../src/org/clock.js';
import { ManualClock } from '../../helpers/manualClock.js';

describe('game clock', () => {
  it('tick 0 is Day 1 06:00 and a day runs 06:00 to 06:00', () => {
    expect(gameTime(0)).toEqual({ day: 1, hour: 6, minute: 0 });
    expect(formatGameTime(6000)).toBe('Day 1 12:00');
    expect(formatGameTime(18000)).toBe('Day 1 00:00');
    expect(formatGameTime(23999)).toBe('Day 1 05:59');
    expect(formatGameTime(24000)).toBe('Day 2 06:00');
    expect(gameDay(47999)).toBe(2);
  });

  it('follows Hour = ((t mod 24000)/1000 + 6) mod 24 for every hour', () => {
    for (let t = 0; t < 24000; t += 1000) {
      expect(gameTime(t).hour).toBe((t / 1000 + 6) % 24);
    }
  });

  it('converts "Day N hh:mm" to ticks and back', () => {
    expect(gameTicksAt(3, 6, 0)).toBe(48000);
    expect(gameTicksAt(1, 5, 0)).toBe(23000);
    expect(gameTicksAt(2, 8, 30)).toBe(24000 + 2500);
    for (const [d, h, m] of [
      [1, 6, 0],
      [4, 23, 15],
      [9, 0, 45],
      [2, 5, 59],
    ] as const) {
      expect(gameTime(gameTicksAt(d, h, m))).toEqual({ day: d, hour: h, minute: m });
    }
  });

  it('parses game-clock times', () => {
    expect(parseGameWhen('Day 3 06:00', 0)).toBe(48000);
    expect(parseGameWhen('day 3, at 8:30', 0)).toBe(48000 + 2500);
    expect(parseGameWhen('Day 2', 0)).toBe(24000);
    // "08:00" is the next 08:00 at or after now.
    expect(parseGameWhen('08:00', 0)).toBe(2000);
    expect(parseGameWhen('08:00', 3000)).toBe(26000);
    expect(parseGameWhen('Day 0', 0)).toBeNull();
    expect(parseGameWhen('tomorrow', 0)).toBeNull();
    expect(parseGameWhen('25:00', 0)).toBeNull();
  });
});

describe('real clock (IANA zones, DST)', () => {
  const BXL = 'Europe/Brussels';
  const NY = 'America/New_York';

  it('knows zones', () => {
    expect(isValidTimeZone(BXL)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('computes offsets across DST', () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 15, 12), BXL)).toBe(3600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), BXL)).toBe(7200_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), NY)).toBe(-4 * 3600_000);
  });

  it('maps local wall times to instants', () => {
    expect(zonedToEpoch({ year: 2026, month: 10, day: 9, hour: 8, minute: 0 }, BXL)).toBe(
      Date.UTC(2026, 9, 9, 6),
    );
    expect(zonedToEpoch({ year: 2026, month: 12, day: 9, hour: 8, minute: 0 }, BXL)).toBe(
      Date.UTC(2026, 11, 9, 7),
    );
  });

  it('moves nonexistent spring-forward times forward and takes the earlier ambiguous fall-back time', () => {
    // Brussels 2026-03-29: 02:00 -> 03:00. 02:30 does not exist and becomes 03:30 CEST (01:30Z).
    expect(zonedToEpoch({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BXL)).toBe(
      Date.UTC(2026, 2, 29, 1, 30),
    );
    // Brussels 2026-10-25: 03:00 -> 02:00. 02:30 happens twice; the first is 00:30Z (CEST).
    expect(zonedToEpoch({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BXL)).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    );
  });

  it('keeps 08:00 local across a DST change (daily recurrence stays at the wall time)', () => {
    const before = zonedToEpoch({ year: 2026, month: 10, day: 24, hour: 8, minute: 0 }, BXL);
    const after = zonedToEpoch(
      { ...addDays({ year: 2026, month: 10, day: 24 }, 1), hour: 8, minute: 0 },
      BXL,
    );
    expect(after - before).toBe(25 * 3600_000);
    expect(zonedParts(after, BXL).hour).toBe(8);
  });

  it('parses real-clock times', () => {
    const now = Date.UTC(2026, 9, 8, 10, 0); // 12:00 in Brussels
    expect(parseRealWhen('2026-10-09 08:00', now, BXL)).toBe(Date.UTC(2026, 9, 9, 6));
    expect(parseRealWhen('2026-10-09T08:00', now, BXL)).toBe(Date.UTC(2026, 9, 9, 6));
    expect(parseRealWhen('2026-10-09T08:00:00Z', now, BXL)).toBe(Date.UTC(2026, 9, 9, 8));
    expect(parseRealWhen('2026-10-09T08:00:00+02:00', now, BXL)).toBe(Date.UTC(2026, 9, 9, 6));
    expect(parseRealWhen('13:00', now, BXL)).toBe(Date.UTC(2026, 9, 8, 11));
    expect(parseRealWhen('11:00', now, BXL)).toBe(Date.UTC(2026, 9, 9, 9));
    expect(parseRealWhen('2026-13-01 08:00', now, BXL)).toBeNull();
    expect(parseRealWhen('soon', now, BXL)).toBeNull();
    expect(formatRealTime(Date.UTC(2026, 9, 9, 6), BXL)).toBe('2026-10-09 08:00');
  });

  it('does date arithmetic', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(daysBetween({ year: 2026, month: 10, day: 1 }, { year: 2026, month: 10, day: 8 })).toBe(7);
    expect(weekdayOf({ year: 2026, month: 10, day: 8 })).toBe(4); // a Thursday
  });
});

describe('sleep', () => {
  it('resolves on the clock and rejects on abort', async () => {
    const clock = new ManualClock();
    let done = false;
    void sleep(clock, 1000).then(() => {
      done = true;
    });
    await clock.advance(999);
    expect(done).toBe(false);
    await clock.advance(1);
    expect(done).toBe(true);

    const ac = new AbortController();
    const p = sleep(clock, 1000, ac.signal);
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(clock.pendingTimers).toBe(0);
  });
});
