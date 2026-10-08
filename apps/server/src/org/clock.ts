/**
 * Clocks for the org services (PLAN §6.6 "Game clock").
 *
 * - {@link OrgClock}: real time plus timers, injected so tests drive everything with a manual clock.
 * - Game clock: `world.state.clockTime` (overworld clock ticks). Day = floor(t/24000)+1,
 *   Hour = ((t mod 24000)/1000 + 6) mod 24. A game day runs 06:00 to 06:00, so tick 0 is Day 1 06:00 and
 *   Day 1 05:59 is the last minute of Day 1.
 * - Real clock: wall time in an IANA time zone, DST-aware. Local times that do not exist (spring forward) move
 *   forward by the gap; ambiguous times (fall back) take the earlier instant (Temporal's "compatible").
 */

/** Real time and timers. */
export interface OrgClock {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: OrgClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Resolves after `ms` on `clock`; rejects with the signal's reason when aborted. */
export function sleep(clock: OrgClock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(handle);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const handle = clock.setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Game clock
// ---------------------------------------------------------------------------------------------

export const TICKS_PER_DAY = 24_000;
export const TICKS_PER_HOUR = 1_000;
/** Game ticks per real second at 20 TPS. */
export const TICKS_PER_SECOND = 20;

export interface GameTime {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Day = floor(t/24000)+1. */
export function gameDay(ticks: number): number {
  return Math.floor(ticks / TICKS_PER_DAY) + 1;
}

/** Day, hour and minute of a clock time. */
export function gameTime(ticks: number): GameTime {
  const inDay = mod(ticks, TICKS_PER_DAY);
  const hour = mod(Math.floor(inDay / TICKS_PER_HOUR) + 6, 24);
  const minute = Math.floor((mod(inDay, TICKS_PER_HOUR) * 60) / TICKS_PER_HOUR);
  return { day: gameDay(ticks), hour, minute };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Day 3 06:00". */
export function formatGameTime(ticks: number): string {
  const t = gameTime(ticks);
  return `Day ${t.day} ${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** Ticks since the start of a game day (06:00) for a wall time hh:mm. */
export function ticksIntoDay(hour: number, minute: number): number {
  return mod(hour - 6, 24) * TICKS_PER_HOUR + Math.ceil((minute * TICKS_PER_HOUR) / 60);
}

/** Clock time of "Day N hh:mm". Because a day runs 06:00-06:00, "Day 1 05:00" is late on Day 1 (tick 23000). */
export function gameTicksAt(day: number, hour: number, minute = 0): number {
  return (day - 1) * TICKS_PER_DAY + ticksIntoDay(hour, minute);
}

/** Converts real milliseconds to game ticks at 20 TPS. */
export function msToTicks(ms: number): number {
  return Math.round((ms / 1000) * TICKS_PER_SECOND);
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseHhMm(text: string): { hour: number; minute: number } | null {
  const m = HHMM_RE.exec(text.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Parses a game-clock time: "Day 3 06:00", "day 3 6:00", "Day 3" (06:00), or "06:00" (the next 06:00 at or after
 * `nowTicks`). Returns clock ticks, or null when unparseable.
 */
export function parseGameWhen(text: string, nowTicks: number): number | null {
  const s = text.trim();
  const full = /^day\s+(\d{1,6})(?:\s*,?\s*(?:at\s+)?(\d{1,2}:\d{2}))?$/i.exec(s);
  if (full) {
    const day = Number(full[1]);
    if (day < 1) return null;
    const hm = full[2] ? parseHhMm(full[2]) : { hour: 6, minute: 0 };
    if (!hm) return null;
    return gameTicksAt(day, hm.hour, hm.minute);
  }
  const hm = parseHhMm(s);
  if (!hm) return null;
  const today = gameTicksAt(gameDay(nowTicks), hm.hour, hm.minute);
  return today >= nowTicks ? today : today + TICKS_PER_DAY;
}

// ---------------------------------------------------------------------------------------------
// Real clock (IANA time zones)
// ---------------------------------------------------------------------------------------------

export interface LocalDate {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** True for a time zone this runtime knows ("Europe/Brussels", "UTC"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The host's IANA zone. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(epochMs: number, timeZone: string): LocalDateTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

/** UTC offset of a zone at an instant, in ms (Brussels summer: +7_200_000). */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant of a local wall time in a zone. Nonexistent times (DST gap) move forward by the gap; ambiguous
 * times (DST overlap) resolve to the earlier instant.
 */
export function zonedToEpoch(
  local: LocalDate & { hour: number; minute: number; second?: number },
  timeZone: string,
): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  const DAY = 86_400_000;
  const offsets = new Set([zoneOffsetMs(guess - DAY, timeZone), zoneOffsetMs(guess + DAY, timeZone)]);
  const valid: number[] = [];
  for (const off of offsets) {
    const t = guess - off;
    const p = zonedParts(t, timeZone);
    if (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === local.hour &&
      p.minute === local.minute
    ) {
      valid.push(t);
    }
  }
  if (valid.length > 0) return Math.min(...valid);
  // In the gap: use the offset in force before the transition, which lands after the gap.
  return guess - zoneOffsetMs(guess - DAY, timeZone);
}

/** Adds days to a calendar date (no zone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Whole days from `a` to `b` (calendar dates). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The local calendar date of an instant in a zone. */
export function localDateOf(epochMs: number, timeZone: string): LocalDate {
  const p = zonedParts(epochMs, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** "2026-10-09 08:00" in the zone. */
export function formatRealTime(epochMs: number, timeZone: string): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * Parses a real-clock time in `timeZone`: "2026-10-09 08:00", "2026-10-09T08:00", an ISO instant with an offset
 * ("2026-10-09T08:00:00+02:00", "…Z"), or "08:00" (the next 08:00 at or after `nowMs`). Returns epoch ms or null.
 */
export function parseRealWhen(text: string, nowMs: number, timeZone: string): number | null {
  const s = text.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const dt = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}:\d{2}))?$/.exec(s);
  if (dt) {
    const hm = dt[4] ? parseHhMm(dt[4]) : { hour: 0, minute: 0 };
    if (!hm) return null;
    const date = { year: Number(dt[1]), month: Number(dt[2]), day: Number(dt[3]) };
    if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
    return zonedToEpoch({ ...date, ...hm }, timeZone);
  }
  const hm = parseHhMm(s);
  if (!hm) return null;
  const today = localDateOf(nowMs, timeZone);
  const t = zonedToEpoch({ ...today, ...hm }, timeZone);
  return t >= nowMs ? t : zonedToEpoch({ ...addDays(today, 1), ...hm }, timeZone);
}
