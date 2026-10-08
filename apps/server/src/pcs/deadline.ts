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

export async function withDeadline<T>(
  ms: number,
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DeadlineError(what, ms);
      ac.abort(err);
      reject(err);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(ac.signal), deadline]);
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
