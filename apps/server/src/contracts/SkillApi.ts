/**
 * SkillApi: the agent runtime's (T3) view of the bodies in the mod (T4) over the bridge: jobs (`skill.run`,
 * `skill.cancel`, `skill.result`), observations (`obs.query`), idle modes, seats and spawning. PLAN §5, §7.4.
 *
 * {@link createBridgeSkillApi} implements it on a {@link BridgeServer}; {@link FakeSkillApi} (FakeSkillApi.ts) is the
 * scripted stand-in for tests. Failures reject with {@link ApiError}: the mod's `err` code (`UNKNOWN_AGENT`,
 * `UNKNOWN_SKILL`, `BAD_ARGS`, `BUSY`, `RESERVED`, `OCCUPIED_BY_PLAYER`, `UNREACHABLE`, `NO_SEAT`, ...) or the
 * bridge's local `TIMEOUT` / `DISCONNECTED`.
 */

import {
  AgentSeatResult,
  AgentSpawnResult,
  type BlockPos,
  ERROR_CODES,
  type IdleMode,
  type ObsQueryName,
  ObsQueryResult,
  type OkReply,
  type PayloadOf,
  type SeatTarget,
  SkillArgs,
  type SkillArgsOf,
  SkillCancelResult,
  type SkillName,
  SkillRunResult,
} from '@minevibe/protocol';
import type { z } from 'zod';
import { BridgeError, type BridgeServer } from '../bridge/BridgeServer.js';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { ApiError, type Subscribable } from './common.js';

export interface SkillRunRequest<S extends SkillName = SkillName> {
  readonly agentId: string;
  readonly skill: S;
  readonly args: SkillArgsOf<S>;
  /** How long to wait for the job to finish before it reports `running` (default 20 000 ms). */
  readonly waitMs?: number | undefined;
  /** Cancel the agent's current job first (default false: `BUSY`). */
  readonly replace?: boolean | undefined;
  /** Default: a fresh id. */
  readonly jobId?: string | undefined;
  /**
   * W1: the player's consent token for changing protected blocks (from an earlier `PROTECTED` failure's
   * `result.protected.consentId`). Only Node's consent ledger sets it, after the player explicitly agreed; it is sent
   * outside `args`, so no tool input can carry it.
   */
  readonly consent?: string | undefined;
}

export interface SeatRequest {
  readonly agentId: string;
  readonly seatEpoch: number;
  readonly target: SeatTarget;
  readonly purpose?: string | undefined;
  readonly jobId?: string | undefined;
}

/** How a job ended (`skill.result` payload). */
export type JobEnd = PayloadOf<'skill.result'>;

export type SkillEvents = {
  progress: [payload: PayloadOf<'skill.progress'>];
  /** A job ended, whether it outlived its `skill.run` reply or not. */
  result: [payload: JobEnd];
};

export interface SkillApi extends Subscribable<SkillEvents> {
  /** Starts a job; rejects with `BAD_ARGS` before sending when `args` do not fit the skill. */
  runSkill<S extends SkillName>(request: SkillRunRequest<S>): Promise<SkillRunResult>;
  /** Cancels one job, or every job of the agent; returns the cancelled job ids. */
  cancelSkill(
    agentId: string,
    options: { jobId?: string | undefined; reason: string },
  ): Promise<readonly string[]>;
  /** Resolves when job `jobId` ends (at once if it already did); rejects with `TIMEOUT`. */
  awaitJob(jobId: string, timeoutMs?: number): Promise<JobEnd>;
  obsQuery(
    agentId: string,
    query: ObsQueryName,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  setMode(agentId: string, mode: IdleMode, anchor?: BlockPos): Promise<void>;
  /** Starts the sit job; its outcome arrives as a `result` for the returned job id. */
  seat(request: SeatRequest): Promise<AgentSeatResult>;
  unseat(request: PayloadOf<'agent.unseat'>): Promise<void>;
  spawn(request: PayloadOf<'agent.spawn'>): Promise<AgentSpawnResult>;
  despawn(request: PayloadOf<'agent.despawn'>): Promise<void>;
}

/** Default `waitMs` of `skill.run` (the tools' `wait_s` default of 20 s). */
export const DEFAULT_SKILL_WAIT_MS = 20_000;

/** Slack on top of `waitMs` for the `skill.run` reply to arrive. */
const REPLY_SLACK_MS = 5_000;

/** Finished jobs remembered for {@link SkillApi.awaitJob}. */
const REMEMBERED_RESULTS = 256;

let jobSeq = 0;
/** A job id unique across Node restarts within one game session. */
export function newJobId(): string {
  return `j${Date.now().toString(36)}-${(++jobSeq).toString(36)}`;
}

/** Validates `args` against `SkillArgs[skill]`; throws `BAD_ARGS`. */
export function validateSkillArgs<S extends SkillName>(skill: S, args: unknown): SkillArgsOf<S> {
  const schema: z.ZodType = SkillArgs[skill];
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(ERROR_CODES.BAD_ARGS, `${skill}: ${where}${issue?.message ?? 'invalid args'}`);
  }
  return parsed.data as SkillArgsOf<S>;
}

/** The part of {@link BridgeServer} the SkillApi uses. */
export type SkillBridge = Pick<BridgeServer, 'request' | 'on'>;

function resultOf(reply: OkReply): Record<string, unknown> {
  const { t: _t, v: _v, re: _re, ...result } = reply as Record<string, unknown>;
  return result;
}

async function call<T>(promise: Promise<OkReply>, schema: z.ZodType<T> | null): Promise<T> {
  let reply: OkReply;
  try {
    reply = await promise;
  } catch (err) {
    if (err instanceof BridgeError) throw new ApiError(err.code, err.message);
    throw err;
  }
  if (schema === null) return undefined as T;
  const parsed = schema.safeParse(resultOf(reply));
  if (!parsed.success)
    throw new ApiError(ERROR_CODES.BAD_MESSAGE, `unexpected reply: ${parsed.error.message}`);
  return parsed.data;
}

class BridgeSkillApi extends TypedEmitter<SkillEvents> implements SkillApi {
  readonly #bridge: SkillBridge;
  readonly #results = new Map<string, JobEnd>();
  readonly #waiters = new Map<string, Set<(end: JobEnd) => void>>();
  readonly #off: (() => void)[] = [];

  constructor(bridge: SkillBridge) {
    super();
    this.#bridge = bridge;
    this.#off.push(
      bridge.on('skill.result', ({ t: _t, v: _v, id: _id, re: _re, ...end }) => this.#ended(end)),
      bridge.on('skill.progress', ({ t: _t, v: _v, id: _id, re: _re, ...progress }) => {
        this.emit('progress', progress);
      }),
    );
  }

  dispose(): void {
    for (const off of this.#off.splice(0)) off();
  }

  async runSkill<S extends SkillName>(request: SkillRunRequest<S>): Promise<SkillRunResult> {
    const args = validateSkillArgs(request.skill, request.args);
    const waitMs = request.waitMs ?? DEFAULT_SKILL_WAIT_MS;
    const jobId = request.jobId ?? newJobId();
    const started = Date.now();
    const payload: PayloadOf<'skill.run'> = {
      jobId,
      agentId: request.agentId,
      skill: request.skill,
      args,
      waitMs,
      replace: request.replace ?? false,
    };
    if (request.consent !== undefined) payload.consent = { token: request.consent };
    const result = await call(
      this.#bridge.request('skill.run', payload, { timeoutMs: waitMs + REPLY_SLACK_MS }),
      SkillRunResult,
    );
    if (result.status !== 'running') {
      const end: JobEnd = {
        jobId: result.jobId,
        agentId: request.agentId,
        status: result.status,
        durationMs: Date.now() - started,
      };
      if (result.result !== undefined) end.result = result.result;
      if (result.error !== undefined) end.error = result.error;
      this.#ended(end);
    }
    return result;
  }

  async cancelSkill(
    agentId: string,
    options: { jobId?: string | undefined; reason: string },
  ): Promise<readonly string[]> {
    const payload: PayloadOf<'skill.cancel'> = { agentId, reason: options.reason };
    if (options.jobId !== undefined) payload.jobId = options.jobId;
    const result = await call(this.#bridge.request('skill.cancel', payload), SkillCancelResult);
    return result.cancelled;
  }

  awaitJob(jobId: string, timeoutMs = 10 * 60_000): Promise<JobEnd> {
    const done = this.#results.get(jobId);
    if (done) return Promise.resolve(done);
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(jobId) ?? new Set();
      const timer = setTimeout(() => {
        waiters.delete(settle);
        reject(new ApiError(ERROR_CODES.TIMEOUT, `job ${jobId} did not end within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const settle = (end: JobEnd) => {
        clearTimeout(timer);
        resolve(end);
      };
      waiters.add(settle);
      this.#waiters.set(jobId, waiters);
    });
  }

  async obsQuery(
    agentId: string,
    query: ObsQueryName,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = await call(this.#bridge.request('obs.query', { agentId, query, args }), ObsQueryResult);
    return result.result;
  }

  async setMode(agentId: string, mode: IdleMode, anchor?: BlockPos): Promise<void> {
    const payload: PayloadOf<'agent.mode'> = { agentId, mode };
    if (anchor !== undefined) payload.anchor = anchor;
    await call(this.#bridge.request('agent.mode', payload), null);
  }

  async seat(request: SeatRequest): Promise<AgentSeatResult> {
    const payload: PayloadOf<'agent.seat'> = {
      agentId: request.agentId,
      jobId: request.jobId ?? newJobId(),
      seatEpoch: request.seatEpoch,
      target: request.target,
    };
    if (request.purpose !== undefined) payload.purpose = request.purpose;
    return call(this.#bridge.request('agent.seat', payload), AgentSeatResult);
  }

  async unseat(request: PayloadOf<'agent.unseat'>): Promise<void> {
    await call(this.#bridge.request('agent.unseat', request), null);
  }

  async spawn(request: PayloadOf<'agent.spawn'>): Promise<AgentSpawnResult> {
    return call(this.#bridge.request('agent.spawn', request), AgentSpawnResult);
  }

  async despawn(request: PayloadOf<'agent.despawn'>): Promise<void> {
    await call(this.#bridge.request('agent.despawn', request), null);
  }

  #ended(end: JobEnd): void {
    if (this.#results.has(end.jobId)) return; // a reply and a skill.result for the same job
    this.#results.set(end.jobId, end);
    if (this.#results.size > REMEMBERED_RESULTS) {
      const oldest = this.#results.keys().next().value;
      if (oldest !== undefined) this.#results.delete(oldest);
    }
    const waiters = this.#waiters.get(end.jobId);
    this.#waiters.delete(end.jobId);
    for (const settle of waiters ?? []) settle(end);
    this.emit('result', end);
  }
}

/** A {@link SkillApi} over the bridge. Call `dispose()` to stop listening. */
export function createBridgeSkillApi(bridge: SkillBridge): SkillApi & { dispose(): void } {
  return new BridgeSkillApi(bridge);
}
