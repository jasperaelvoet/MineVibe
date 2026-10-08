import { execFile } from 'node:child_process';

/**
 * Process identity across time: a pid plus its start time, so a reused pid never passes for the process that wrote a
 * record. Used by the run lock (`orchestrator/runLock.ts`) and the PC instance registry (`pcs/InstanceRegistry.ts`).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^[A-Za-z]{3} +([A-Za-z]{3}) +(\d{1,2}) +(\d{1,2}):(\d{2}):(\d{2}) +(\d{4})$/;

/**
 * Parses `ps -o lstart=` output in the C locale (`Thu Oct  8 17:08:12 2026`) as a wall-clock time in `zone`.
 * Returns epoch milliseconds, or null when `text` is not in that format.
 */
export function parseLstart(text: string, zone: 'utc' | 'local'): number | null {
  const m = LSTART.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] as string);
  if (month < 0) return null;
  const [day, hour, minute, second, year] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms =
    zone === 'utc'
      ? Date.UTC(year, month, day, hour, minute, second)
      : new Date(year, month, day, hour, minute, second).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a process started, as an ISO-8601 UTC instant (`2026-10-08T17:08:12.000Z`). `ps -o lstart=` prints local
 * time, so it runs with `TZ=UTC` (and `LC_ALL=C`): the value never depends on the time zone of the process that
 * asks, which can differ between an app started by launchd and a terminal. Unexpected `ps` output is returned as
 * is (whitespace collapsed); it still compares exactly. Null when the process is not running or ps cannot tell.
 */
export function processStartTime(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 },
      (err, stdout) => {
        const raw = err ? '' : String(stdout).trim().replace(/\s+/g, ' ');
        if (raw === '') {
          resolvePromise(null);
          return;
        }
        const ms = parseLstart(raw, 'utc');
        resolvePromise(ms === null ? raw : new Date(ms).toISOString());
      },
    );
  });
}

/**
 * A recorded start time in epoch milliseconds: an ISO-8601 instant, or the bare `ps -o lstart=` text that versions
 * before the UTC change recorded (in their local time zone, which is the best reading there is). Null otherwise.
 */
export function startTimeMs(text: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }
  return parseLstart(text, 'local');
}

/** Whether two recorded start times name the same second. Text that is not a time compares exactly. */
export function sameStartTime(a: string, b: string): boolean {
  if (a === b) return true;
  const am = startTimeMs(a);
  const bm = startTimeMs(b);
  return am !== null && bm !== null && Math.floor(am / 1000) === Math.floor(bm / 1000);
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
