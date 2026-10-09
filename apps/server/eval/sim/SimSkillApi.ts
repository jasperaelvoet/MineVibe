/**
 * The {@link SkillApi} of the simulated world: `skill.run` starts a job in {@link SimWorld} and lets game time pass up
 * to `waitMs` (a job still going answers `running`, like the mod), `obs.query` answers from the world, every result
 * carries the mod's status `footer`. Arguments are validated with the protocol schemas, exactly as the bridge
 * SkillApi does, so a bad call fails the same way.
 */

import {
  type AgentSeatResult,
  type AgentSpawnResult,
  type BlockPos,
  ERROR_CODES,
  type IdleMode,
  MOD_CAPS,
  type ObsQueryName,
  type PayloadOf,
  type SkillName,
  type SkillRunResult,
} from '@minevibe/protocol';
import { ApiError } from '../../src/contracts/common.js';
import {
  type JobEnd,
  newJobId,
  type SeatRequest,
  type SkillApi,
  type SkillEvents,
  type SkillRunRequest,
  validateSkillArgs,
} from '../../src/contracts/SkillApi.js';
import { TypedEmitter } from '../../src/util/TypedEmitter.js';
import { buildJobLogic } from './jobs.js';
import { observe } from './observe.js';
import { SIM_V2_CAPS } from './v2.js';
import { type SimJob, type SimWorld, TPS } from './world.js';

/** Game ticks per real millisecond of waiting (20 tps). */
function msToTicks(ms: number): number {
  return Math.round((ms / 1000) * TPS);
}

/** The mod caps `waitMs` at 120 s (protocol §7.4). */
const MOD_WAIT_CAP_MS = 120_000;

export interface SimCall {
  readonly kind: 'skill' | 'obs' | 'mode' | 'cancel';
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly at: number;
}

export class SimSkillApi extends TypedEmitter<SkillEvents> implements SkillApi {
  readonly world: SimWorld;
  /** Every call, in order (scenario checks read it). */
  readonly calls: SimCall[] = [];
  readonly #ended = new Map<string, JobEnd>();

  constructor(world: SimWorld, options: { readonly mod?: 'v1' | 'v2' } = {}) {
    super();
    this.world = world;
    if (options.mod) world.mod = options.mod;
    world.onJobEnd = (job) => this.#ended_(job);
  }

  /** The simulated mod's `hello.caps`: none for the v1 mod, every v2 cap for the v2 one. */
  caps(): ReadonlySet<string> {
    return new Set(this.world.mod === 'v2' ? SIM_V2_CAPS : []);
  }

  #check(agentId: string): void {
    if (agentId !== this.world.agent.agentId)
      throw new ApiError(ERROR_CODES.UNKNOWN_AGENT, `no agent ${agentId}`);
  }

  #withFooter(result: Record<string, unknown> | undefined): Record<string, unknown> {
    return { ...(result ?? {}), footer: this.world.footer() };
  }

  #ended_(job: SimJob): void {
    const end: JobEnd = {
      jobId: job.jobId,
      agentId: this.world.agent.agentId,
      status: job.status === 'running' ? 'failed' : job.status,
      durationMs: Math.round(((job.endedAt ?? this.world.clock) - job.startedAt) * (1000 / TPS)),
      result: this.#withFooter(job.result),
    };
    if (job.error) end.error = { code: job.error.code, msg: job.error.msg };
    this.#ended.set(job.jobId, end);
    this.emit('result', end);
  }

  async runSkill<S extends SkillName>(request: SkillRunRequest<S>): Promise<SkillRunResult> {
    this.#check(request.agentId);
    const args = validateSkillArgs(request.skill, request.args) as Record<string, unknown>;
    this.calls.push({ kind: 'skill', name: request.skill, args, at: this.world.clock });
    const w = this.world;
    if (w.current && !request.replace) throw new ApiError(ERROR_CODES.BUSY, `${request.agentId} is busy`);
    // The v2 mod names the job its replace cancelled (cap run.replaced, M9).
    const prev = w.current;
    const replaced =
      prev && this.caps().has(MOD_CAPS.RUN_REPLACED)
        ? { jobId: prev.jobId, skill: prev.skill, ...(prev.text ? { text: prev.text.slice(0, 256) } : {}) }
        : undefined;
    if (w.current) w.cancelJob('replaced by a new job');
    const jobId = request.jobId ?? newJobId();
    const logic = buildJobLogic(w, request.skill, args);
    const job = w.startJob(jobId, request.skill, args, logic);
    const waitMs = Math.min(request.waitMs ?? 20_000, MOD_WAIT_CAP_MS);
    w.advance(w.clock + msToTicks(waitMs), () => job.status !== 'running');
    if (job.status === 'running')
      return replaced ? { jobId, status: 'running', replaced } : { jobId, status: 'running' };
    const out: SkillRunResult = { jobId, status: job.status, result: this.#withFooter(job.result) };
    if (replaced) out.replaced = replaced;
    if (job.error) out.error = { code: job.error.code, msg: job.error.msg };
    return out;
  }

  async cancelSkill(
    agentId: string,
    options: { jobId?: string | undefined; reason: string },
  ): Promise<readonly string[]> {
    this.#check(agentId);
    this.calls.push({ kind: 'cancel', name: 'stop', args: { reason: options.reason }, at: this.world.clock });
    const job = this.world.current;
    if (!job || (options.jobId !== undefined && options.jobId !== job.jobId)) return [];
    this.world.cancelJob(options.reason);
    return [job.jobId];
  }

  /** Lets game time pass until the job ends (at most `timeoutMs` of game time). */
  async awaitJob(jobId: string, timeoutMs = 10 * 60_000): Promise<JobEnd> {
    const done = this.#ended.get(jobId);
    if (done) return done;
    const job = this.world.jobs.get(jobId);
    if (!job) throw new ApiError(ERROR_CODES.UNKNOWN_JOB, `no job ${jobId}`);
    this.world.advance(this.world.clock + msToTicks(timeoutMs), () => job.status !== 'running');
    const end = this.#ended.get(jobId);
    if (!end) throw new ApiError(ERROR_CODES.TIMEOUT, `job ${jobId} did not end within ${timeoutMs} ms`);
    return end;
  }

  /** The end of a finished job, if any. */
  ended(jobId: string): JobEnd | undefined {
    return this.#ended.get(jobId);
  }

  async obsQuery(
    agentId: string,
    query: ObsQueryName,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.#check(agentId);
    this.calls.push({ kind: 'obs', name: query, args, at: this.world.clock });
    return this.#withFooter(observe(this.world, query, args));
  }

  async setMode(agentId: string, mode: IdleMode, anchor?: BlockPos): Promise<void> {
    this.#check(agentId);
    this.calls.push({ kind: 'mode', name: mode, args: anchor ? { anchor } : {}, at: this.world.clock });
    this.world.agent.mode = mode;
    // ReflexBrain.setMode: the given anchor, else none for follow and where the body stands for the others.
    this.world.agent.anchor = anchor ?? (mode === 'follow' ? null : this.world.agent.pos);
  }

  async seat(_request: SeatRequest): Promise<AgentSeatResult> {
    throw new ApiError(ERROR_CODES.NO_SEAT, 'there are no PCs in this world');
  }

  async unseat(_request: PayloadOf<'agent.unseat'>): Promise<void> {}

  async spawn(request: PayloadOf<'agent.spawn'>): Promise<AgentSpawnResult> {
    const p = this.world.agent.pos;
    return {
      pos: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 },
      dim: request.at?.dim ?? 'minecraft:overworld',
      restored: false,
    };
  }

  async despawn(_request: PayloadOf<'agent.despawn'>): Promise<void> {}
}
