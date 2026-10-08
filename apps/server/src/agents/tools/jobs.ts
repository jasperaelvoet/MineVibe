/**
 * Node's job registry, per agent (docs/design/tools-v2-mc.md §7): the world job that runs now, and the last few that
 * ended, with what the v2 tools need to talk about them (the {@link JobMeta} of the call that started each job, its
 * latest progress text, its rendered result). It feeds `job{status|wait|stop}`, `observe{sections:["jobs"]}`, the
 * `[JOB DONE]` wakes and the "stopped your previous job" notice.
 */

import { dur, type JobMeta, type Rendered } from './format.js';

export interface RunningJob {
  readonly jobId: string;
  readonly meta: JobMeta;
  readonly startedAt: number;
  /** The latest `skill.progress` text ("4/10 oak_log"), or null. */
  progress: string | null;
  /** Set when the agent itself cancelled or replaced the job (its end needs no wake). */
  cancelledBy: 'stop' | 'replace' | null;
}

export interface EndedJob {
  readonly jobId: string;
  readonly meta: JobMeta;
  readonly status: 'done' | 'failed' | 'cancelled';
  readonly rendered: Rendered;
  readonly endedAt: number;
  readonly cancelledBy: 'stop' | 'replace' | null;
}

/** How many ended jobs are kept. */
export const RECENT_JOBS = 5;
/** Jobs whose meta is kept for wakes that arrive late (a reply lost on reconnect). */
const KNOWN_JOBS = 64;

export class JobRegistry {
  readonly #now: () => number;
  #current: RunningJob | null = null;
  readonly #recent: EndedJob[] = [];
  /** Every job started through the tools (for late wakes), oldest first. */
  readonly #known = new Map<string, RunningJob>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A tool started a job (whatever its first answer was). */
  started(jobId: string, meta: JobMeta): RunningJob {
    const job: RunningJob = { jobId, meta, startedAt: this.#now(), progress: null, cancelledBy: null };
    this.#current = job;
    this.#known.set(jobId, job);
    while (this.#known.size > KNOWN_JOBS) {
      const oldest = this.#known.keys().next().value;
      if (oldest === undefined) break;
      this.#known.delete(oldest);
    }
    return job;
  }

  /** `skill.progress` of a job. */
  progress(jobId: string, text: string): void {
    const job = this.#known.get(jobId);
    if (job) job.progress = text;
  }

  /** The agent is about to stop or replace whatever runs now. Returns that job, if any. */
  markCancelled(by: 'stop' | 'replace'): RunningJob | null {
    const job = this.#current;
    if (job) job.cancelledBy = by;
    return job;
  }

  /** A job ended; it leaves `current` and joins the recent list. */
  ended(jobId: string, status: EndedJob['status'], rendered: Rendered): EndedJob | null {
    const job = this.#known.get(jobId);
    if (!job) return null;
    if (this.#current?.jobId === jobId) this.#current = null;
    const prior = this.#recent.findIndex((e) => e.jobId === jobId);
    if (prior >= 0) this.#recent.splice(prior, 1);
    const ended: EndedJob = {
      jobId,
      meta: job.meta,
      status,
      rendered,
      endedAt: this.#now(),
      cancelledBy: job.cancelledBy,
    };
    this.#recent.unshift(ended);
    this.#recent.length = Math.min(this.#recent.length, RECENT_JOBS);
    return ended;
  }

  current(): RunningJob | null {
    return this.#current;
  }

  /** The job (running, or ended recently) with this id. */
  get(jobId: string): RunningJob | null {
    return this.#known.get(jobId) ?? null;
  }

  meta(jobId: string): JobMeta | null {
    return this.#known.get(jobId)?.meta ?? null;
  }

  endedJob(jobId: string): EndedJob | null {
    return this.#recent.find((e) => e.jobId === jobId) ?? null;
  }

  /** Most recent first. */
  recent(): readonly EndedJob[] {
    return this.#recent;
  }

  /** Forget everything (a new session, a world change). */
  clear(): void {
    this.#current = null;
    this.#recent.length = 0;
    this.#known.clear();
  }

  /** `now j2-7 gather oak_log 4/10 (35s)`. */
  describeCurrent(): string | null {
    const job = this.#current;
    if (!job) return null;
    const progress = job.progress ? ` ${job.progress.replace(/minecraft:/g, '')}` : '';
    return `${job.jobId} ${job.meta.what}${progress} (${dur(this.#now() - job.startedAt)})`;
  }

  /** `j2-6 craft crafting_table done 2m ago`. */
  describeEnded(e: EndedJob): string {
    return `${e.jobId} ${e.meta.what} ${e.status} ${dur(this.#now() - e.endedAt)} ago`;
  }

  /** `jobs: now j2-7 … | last j2-6 … done 2m ago` (observe section). */
  section(): string {
    const parts: string[] = [];
    const now = this.describeCurrent();
    parts.push(now ? `now ${now}` : 'no job running');
    const last = this.#recent[0];
    if (last) parts.push(`last ${this.describeEnded(last)}`);
    return `jobs: ${parts.join(' | ')}`;
  }
}
