/**
 * The background commands an agent started with `bash` (`run_in_background`, or a foreground command that overran
 * and was moved there): who may stop them, and what their `<task-notification>` says when they end. The brain keeps
 * one book per agent, so a session restart keeps it, and turns {@link PcApi.onJobExit} into notification wakes.
 */

export interface PcJob {
  readonly pcId: string;
  readonly jobId: string;
  /** The seat epoch it was started under (its notification is dropped after the seat ended). */
  readonly epoch: number;
  readonly command: string;
  /** The `description` the agent gave (else the command, shortened). */
  readonly description: string;
  readonly toolUseId?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly startedAt: number;
}

/** Jobs remembered per agent. */
const KEEP = 200;

/** The key of a background job: the PC and its job id (ids repeat across PCs). */
export function ownJobKey(pcId: string, jobId: string): string {
  return `${pcId}\n${jobId}`;
}

export class PcJobBook {
  readonly #jobs = new Map<string, PcJob>();

  add(job: PcJob): void {
    this.#jobs.set(ownJobKey(job.pcId, job.jobId), job);
    while (this.#jobs.size > KEEP) {
      const oldest = this.#jobs.keys().next().value as string;
      this.#jobs.delete(oldest);
    }
  }

  get(pcId: string, jobId: string): PcJob | undefined {
    return this.#jobs.get(ownJobKey(pcId, jobId));
  }

  has(pcId: string, jobId: string): boolean {
    return this.#jobs.has(ownJobKey(pcId, jobId));
  }

  delete(pcId: string, jobId: string): void {
    this.#jobs.delete(ownJobKey(pcId, jobId));
  }

  /** The jobs on a PC, oldest first. */
  on(pcId: string): PcJob[] {
    return [...this.#jobs.values()].filter((j) => j.pcId === pcId);
  }
}
