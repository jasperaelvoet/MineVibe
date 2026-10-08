import {
  type AgentSeatResult,
  type AgentSpawnResult,
  type BlockPos,
  ERROR_CODES,
  type IdleMode,
  type ObsQueryName,
  type PayloadOf,
  type SkillName,
  type SkillRunResult,
} from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { ApiError } from './common.js';
import {
  type JobEnd,
  newJobId,
  type SeatRequest,
  type SkillApi,
  type SkillEvents,
  type SkillRunRequest,
  validateSkillArgs,
} from './SkillApi.js';

/** What a scripted skill does: finish at once, or keep running until {@link FakeSkillApi.finish}. */
export type FakeSkillOutcome =
  | { readonly status: 'done'; readonly result?: Record<string, unknown> }
  | {
      readonly status: 'failed';
      readonly code: string;
      readonly msg: string;
      readonly result?: Record<string, unknown>;
    }
  | { readonly status: 'running' };

/**
 * A scripted {@link SkillApi} for tests: `args` are validated like the real one, skills run per {@link skillHandler}
 * (default: done at once), running jobs end through {@link finish} or a cancel, and every call is recorded.
 */
export class FakeSkillApi extends TypedEmitter<SkillEvents> implements SkillApi {
  readonly #running = new Map<string, { agentId: string; started: number }>();
  readonly #ended = new Map<string, JobEnd>();
  readonly #waiters = new Map<string, ((end: JobEnd) => void)[]>();
  readonly #modes = new Map<string, IdleMode>();

  readonly runs: SkillRunRequest[] = [];
  readonly seats: (SeatRequest | PayloadOf<'agent.unseat'>)[] = [];
  readonly spawned: PayloadOf<'agent.spawn'>[] = [];
  readonly despawned: PayloadOf<'agent.despawn'>[] = [];
  skillHandler: (request: SkillRunRequest) => FakeSkillOutcome = () => ({ status: 'done' });
  /** `obs.query` answers by query name. */
  readonly observations = new Map<ObsQueryName, Record<string, unknown>>();

  async runSkill<S extends SkillName>(request: SkillRunRequest<S>): Promise<SkillRunResult> {
    validateSkillArgs(request.skill, request.args);
    this.runs.push(request as SkillRunRequest);
    const jobId = request.jobId ?? newJobId();
    const busy = [...this.#running.values()].some((j) => j.agentId === request.agentId);
    if (busy && !request.replace) throw new ApiError(ERROR_CODES.BUSY, `${request.agentId} is busy`);
    if (busy) await this.cancelSkill(request.agentId, { reason: 'replaced' });
    const outcome = this.skillHandler(request as SkillRunRequest);
    if (outcome.status === 'running') {
      this.#running.set(jobId, { agentId: request.agentId, started: Date.now() });
      return { jobId, status: 'running' };
    }
    const end = this.#end(jobId, request.agentId, outcome);
    const result: SkillRunResult = { jobId, status: end.status };
    if (end.result !== undefined) result.result = end.result;
    if (end.error !== undefined) result.error = end.error;
    return result;
  }

  /** Ends a running job as the mod's `skill.result` would. */
  finish(jobId: string, outcome: Exclude<FakeSkillOutcome, { status: 'running' }>): JobEnd {
    const job = this.#running.get(jobId);
    if (!job) throw new ApiError(ERROR_CODES.UNKNOWN_JOB, `no running job ${jobId}`);
    this.#running.delete(jobId);
    return this.#end(jobId, job.agentId, outcome);
  }

  /** Emits a `skill.progress`. */
  progress(jobId: string, text: string, progress?: number): void {
    const job = this.#running.get(jobId);
    if (!job) throw new ApiError(ERROR_CODES.UNKNOWN_JOB, `no running job ${jobId}`);
    this.emit(
      'progress',
      progress === undefined
        ? { jobId, agentId: job.agentId, text }
        : { jobId, agentId: job.agentId, text, progress },
    );
  }

  runningJobs(): readonly string[] {
    return [...this.#running.keys()];
  }

  modeOf(agentId: string): IdleMode | undefined {
    return this.#modes.get(agentId);
  }

  async cancelSkill(
    agentId: string,
    options: { jobId?: string | undefined; reason: string },
  ): Promise<readonly string[]> {
    const cancelled: string[] = [];
    for (const [jobId, job] of [...this.#running]) {
      if (job.agentId !== agentId || (options.jobId !== undefined && options.jobId !== jobId)) continue;
      this.#running.delete(jobId);
      this.#emitEnd({ jobId, agentId, status: 'cancelled', durationMs: Date.now() - job.started });
      cancelled.push(jobId);
    }
    return cancelled;
  }

  awaitJob(jobId: string): Promise<JobEnd> {
    const end = this.#ended.get(jobId);
    if (end) return Promise.resolve(end);
    return new Promise((resolve) => {
      this.#waiters.set(jobId, [...(this.#waiters.get(jobId) ?? []), resolve]);
    });
  }

  async obsQuery(agentId: string, query: ObsQueryName): Promise<Record<string, unknown>> {
    const result = this.observations.get(query);
    if (!result) throw new ApiError(ERROR_CODES.NOT_HANDLED, `no scripted ${query} for ${agentId}`);
    return result;
  }

  async setMode(agentId: string, mode: IdleMode, _anchor?: BlockPos): Promise<void> {
    this.#modes.set(agentId, mode);
  }

  async seat(request: SeatRequest): Promise<AgentSeatResult> {
    this.seats.push(request);
    const jobId = request.jobId ?? newJobId();
    this.#running.set(jobId, { agentId: request.agentId, started: Date.now() });
    return { jobId, status: 'running' };
  }

  async unseat(request: PayloadOf<'agent.unseat'>): Promise<void> {
    this.seats.push(request);
  }

  async spawn(request: PayloadOf<'agent.spawn'>): Promise<AgentSpawnResult> {
    this.spawned.push(request);
    const pos = request.at?.pos ?? { x: 0, y: 64, z: 0 };
    return {
      pos: { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 },
      dim: request.at?.dim ?? 'minecraft:overworld',
      restored: false,
    };
  }

  async despawn(request: PayloadOf<'agent.despawn'>): Promise<void> {
    this.despawned.push(request);
  }

  #end(jobId: string, agentId: string, outcome: Exclude<FakeSkillOutcome, { status: 'running' }>): JobEnd {
    const end: JobEnd =
      outcome.status === 'done'
        ? {
            jobId,
            agentId,
            status: 'done',
            durationMs: 0,
            ...(outcome.result ? { result: outcome.result } : {}),
          }
        : {
            jobId,
            agentId,
            status: 'failed',
            durationMs: 0,
            error: { code: outcome.code, msg: outcome.msg },
            ...(outcome.result ? { result: outcome.result } : {}),
          };
    this.#emitEnd(end);
    return end;
  }

  #emitEnd(end: JobEnd): void {
    this.#ended.set(end.jobId, end);
    const waiters = this.#waiters.get(end.jobId) ?? [];
    this.#waiters.delete(end.jobId);
    for (const resolve of waiters) resolve(end);
    this.emit('result', end);
  }
}
