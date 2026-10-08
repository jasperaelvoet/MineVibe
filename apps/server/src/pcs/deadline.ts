/**
 * Deadlines for spacesd calls (H3). Every call gets an `AbortSignal` that fires at the deadline, and the
 * returned promise rejects at the deadline even when the callee ignores the signal, so a hung guest can
 * never hold an input queue, a frame loop or a lifecycle operation forever.
 */

export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Runs `fn` with a deadline. `onLate` receives a value that `fn` produced only after the deadline had
 * already rejected (N6): nobody else will ever see it, so a session or client must be released there.
 */
export async function withDeadline<T>(
  ms: number,
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { onLate?: (value: T) => void } = {},
): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const err = new DeadlineError(what, ms);
      ac.abort(err);
      reject(err);
    }, ms);
    timer.unref?.();
  });
  let work: Promise<T>;
  try {
    work = fn(ac.signal);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  work.then(
    (v) => {
      if (!expired || !options.onLate) return;
      try {
        options.onLate(v);
      } catch {
        // cleanup of a late value never throws into the caller
      }
    },
    () => {},
  );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for `p` at most `ms` (unref'd timer); resolves either way and never rejects (N5). */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      p.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves after `ms` (unref'd), for bounded waits. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
