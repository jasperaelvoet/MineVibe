/**
 * Occurrence math. Only the rule, `nextAt` and the ring are stored; every later occurrence is computed.
 *
 * - Game clock: `daily` = every 24000 ticks from the start, `every_n_days` = every n·24000 ticks.
 * - Real clock: occurrences keep the local wall time in the event's IANA zone across DST changes;
 *   `every_n_days` counts calendar days from the start date; `weekdays` is Monday to Friday.
 */

import {
  addDays,
  daysBetween,
  type LocalDate,
  localDateOf,
  TICKS_PER_DAY,
  weekdayOf,
  zonedParts,
  zonedToEpoch,
} from '../clock.js';
import type { CalendarEvent } from './types.js';

type Schedule = Pick<CalendarEvent, 'clock' | 'start' | 'recurrence' | 'tz' | 'wallTime'>;

function periodDays(s: Schedule): number {
  switch (s.recurrence.kind) {
    case 'every_n_days':
      return Math.max(1, Math.floor(s.recurrence.n));
    default:
      return 1;
  }
}

function wallTimeOf(s: Schedule): { hour: number; minute: number } {
  if (s.wallTime) return s.wallTime;
  const p = zonedParts(s.start, s.tz ?? 'UTC');
  return { hour: p.hour, minute: p.minute };
}

function realAt(s: Schedule, date: LocalDate): number {
  return zonedToEpoch({ ...date, ...wallTimeOf(s) }, s.tz ?? 'UTC');
}

/** The first occurrence at or after `t`, or null when there is none (a one-off in the past). */
export function occurrenceAtOrAfter(s: Schedule, t: number): number | null {
  const r = s.recurrence;
  if (r.kind === 'once') return s.start >= t ? s.start : null;

  if (s.clock === 'game') {
    if (r.kind === 'weekdays') return null; // rejected at creation
    const period = TICKS_PER_DAY * periodDays(s);
    if (t <= s.start) return s.start;
    return s.start + Math.ceil((t - s.start) / period) * period;
  }

  const tz = s.tz ?? 'UTC';
  const anchor = localDateOf(s.start, tz);
  if (t <= s.start && r.kind !== 'weekdays') return s.start;
  const from = t <= s.start ? anchor : localDateOf(t, tz);
  if (r.kind === 'weekdays') {
    let date = daysBetween(anchor, from) < 0 ? anchor : addDays(from, -1);
    for (let i = 0; i < 14; i++) {
      const wd = weekdayOf(date);
      if (wd >= 1 && wd <= 5 && daysBetween(anchor, date) >= 0) {
        const at = realAt(s, date);
        if (at >= t && at >= s.start) return at;
      }
      date = addDays(date, 1);
    }
    return null;
  }
  const n = periodDays(s);
  const offset = Math.max(0, daysBetween(anchor, from));
  let k = Math.max(0, Math.floor(offset / n) - 1);
  for (let i = 0; i < 8; i++, k++) {
    const at = realAt(s, addDays(anchor, k * n));
    if (at >= t) return at;
  }
  return null;
}

/** The first occurrence strictly after `t`. */
export function occurrenceAfter(s: Schedule, t: number): number | null {
  return occurrenceAtOrAfter(s, t + 1);
}

/** Occurrences in [from, to], at most `limit`. */
export function occurrencesBetween(s: Schedule, from: number, to: number, limit = 20): number[] {
  const out: number[] = [];
  let t = occurrenceAtOrAfter(s, from);
  while (t !== null && t <= to && out.length < limit) {
    out.push(t);
    t = occurrenceAfter(s, t);
  }
  return out;
}
