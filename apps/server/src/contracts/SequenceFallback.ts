/**
 * `sequence` for mods without it (docs/design/tools-v2-mc.md §5.10, §11 M1/M8): when the connected mod does not list
 * the `skill.sequence` cap, Node runs the steps itself, one job after the other, under one macro job id (`m…`). The
 * macro behaves like the mod's own sequence job: `runSkill` answers `done` / `failed` / `running` within `waitMs`,
 * `skill.result` (the `result` event) ends it with `{completed, steps:[{skill, status, code?, msg?, result}]}`,
 * progress reads `step i/n <step's progress>`, `cancelSkill` and `awaitJob` take the macro id, and a step cancelled
 * from outside (replaced by another job, the player's new task) ends the macro as cancelled.
 *
 * Unlike the mod's job, a macro does not survive a Node restart.
 */

import { MOD_CAPS, type SequenceStepSkill, type SkillName, type SkillRunResult } from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';
import { ApiError } from './common.js';
import {
  type JobEnd,
  newJobId,
  type SkillApi,
  type SkillEvents,
  type SkillRunRequest,
  validateSkillArgs,
} from './SkillApi.js';

/** Skills whose jobs may change protected blocks (they can carry the player's consent). */
const CONSENT_STEPS: ReadonlySet<string> = new Set([
  'mine',
  'collect',
  'dig',
  'place',
  'build',
  'farm',
  'use_item',
  'attack',
  'container',
  'craft',
]);

/** How long one step may run before the macro gives up on it (the mod caps a sequence at 40 min). */
const STEP_TIMEOUT_MS = 40 * 60_000;

let macroSeq = 0;
export function newMacroId(): string {
  return `m${Date.now().toString(36)}-${(++macroSeq).toString(36)}`;
}

interface StepOutcome {
  skill: string;
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  code?: string;
  msg?: string;
  result?: Record<string, unknown>;
}

class Macro {
  readonly id: string;
  readonly agentId: string;
  readonly started = Date.now();
  childId: string | null = null;
  cancelled: string | null = null;
  readonly done: Promise<JobEnd>;
  #resolve!: (end: JobEnd) => void;

  constructor(id: string, agentId: string) {
    this.id = id;
    this.agentId = agentId;
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  finish(end: JobEnd): void {
    this.#resolve(end);
  }
}

export class SequenceFallbackSkillApi extends TypedEmitter<SkillEvents> implements SkillApi {
  readonly #inner: SkillApi;
  readonly #macros = new Map<string, Macro>();
  readonly #ended = new Map<string, JobEnd>();
  /** Child job id → its macro (progress is re-emitted for the macro). */
  readonly #children = new Map<string, Macro>();
  readonly #off: (() => void)[] = [];

  constructor(inner: SkillApi) {
    super();
    this.#inner = inner;
    this.#off.push(
      inner.on('progress', (p) => {
        this.emit('progress', p);
        const macro = this.#children.get(p.jobId);
        if (macro) this.#stepProgress(macro, p.text);
      }),
      inner.on('result', (end) => {
        this.emit('result', end);
      }),
    );
  }

  /** The wrapped API (tests). */
  get inner(): SkillApi {
    return this.#inner;
  }

  dispose(): void {
    for (const off of this.#off.splice(0)) off();
  }

  caps(): ReadonlySet<string> {
    return this.#inner.caps?.() ?? new Set<string>();
  }

  #native(): boolean {
    return this.caps().has(MOD_CAPS.SEQUENCE);
  }

  #progressText = new Map<string, string>();

  #stepProgress(macro: Macro, text: string): void {
    const prefix = this.#progressText.get(macro.id) ?? '';
    this.emit('progress', {
      jobId: macro.id,
      agentId: macro.agentId,
      text: `${prefix} ${text}`.trim().slice(0, 256),
    });
  }

  async runSkill<S extends SkillName>(request: SkillRunRequest<S>): Promise<SkillRunResult> {
    if (request.skill !== 'sequence' || this.#native()) return this.#inner.runSkill(request);
    const args = validateSkillArgs('sequence', request.args);
    // Like the mod: a run for the agent replaces its current job (the first step's own run does that for mod jobs).
    if (!request.replace && [...this.#macros.values()].some((m) => m.agentId === request.agentId)) {
      throw new ApiError('BUSY', `${request.agentId} is busy`);
    }
    for (const m of [...this.#macros.values()]) {
      if (m.agentId === request.agentId) this.#cancelMacro(m, `replaced by sequence`);
    }
    const macro = new Macro(request.jobId ?? newMacroId(), request.agentId);
    this.#macros.set(macro.id, macro);
    void this.#run(macro, args.steps, args.stop_on_fail !== false, request);
    const waitMs = request.waitMs ?? 20_000;
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref?.());
    const end = await Promise.race([macro.done, timer]);
    if (!end) return { jobId: macro.id, status: 'running' };
    const result: SkillRunResult = { jobId: macro.id, status: end.status };
    if (end.result !== undefined) result.result = end.result;
    if (end.error !== undefined) result.error = end.error;
    return result;
  }

  async #run(
    macro: Macro,
    steps: readonly { skill: SequenceStepSkill; args: Record<string, unknown> }[],
    stopOnFail: boolean,
    request: SkillRunRequest,
  ): Promise<void> {
    const outcomes: StepOutcome[] = [];
    const n = steps.length;
    let consent =
      request.consent && (request.args as { allow_protected?: boolean }).allow_protected === true
        ? request.consent
        : null;
    let failure: { code: string; msg: string } | null = null;
    for (const [i, step] of steps.entries()) {
      if (macro.cancelled) break;
      if (failure && stopOnFail) break;
      this.#progressText.set(macro.id, `step ${i + 1}/${n}`);
      this.emit('progress', {
        jobId: macro.id,
        agentId: macro.agentId,
        text: `step ${i + 1}/${n} ${step.skill}`,
      });
      const childId = newJobId();
      macro.childId = childId;
      this.#children.set(childId, macro);
      // The player's single-use consent (W1 token) goes with the first step that changes blocks: separate jobs, unlike
      // the mod's own sequence, cannot share it.
      const withConsent = consent !== null && CONSENT_STEPS.has(step.skill);
      let end: JobEnd;
      try {
        const res = await this.#inner.runSkill({
          agentId: macro.agentId,
          skill: step.skill,
          args: (withConsent ? { ...step.args, allow_protected: true } : step.args) as never,
          waitMs: 0,
          replace: true,
          jobId: childId,
          ...(withConsent && consent ? { consent } : {}),
        });
        if (withConsent) consent = null;
        end =
          res.status === 'running'
            ? await this.#inner.awaitJob(childId, STEP_TIMEOUT_MS)
            : {
                jobId: childId,
                agentId: macro.agentId,
                status: res.status,
                durationMs: 0,
                ...(res.result ? { result: res.result } : {}),
                ...(res.error ? { error: res.error } : {}),
              };
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'FAILED';
        end = {
          jobId: childId,
          agentId: macro.agentId,
          status: 'failed',
          durationMs: 0,
          error: { code, msg: err instanceof Error ? err.message : String(err) },
        };
      } finally {
        this.#children.delete(childId);
        macro.childId = null;
      }
      const { footer: _footer, ...result } = end.result ?? {};
      const outcome: StepOutcome = { skill: step.skill, status: end.status, result };
      if (end.error) {
        outcome.code = end.error.code;
        outcome.msg = end.error.msg;
      }
      outcomes.push(outcome);
      if (end.status === 'cancelled') {
        macro.cancelled ??= end.error?.msg ?? 'cancelled';
        break;
      }
      if (end.status === 'failed' && !failure) {
        failure = {
          code: end.error?.code ?? 'FAILED',
          msg: `step ${i + 1}/${n} ${step.skill}: ${end.error?.msg ?? 'failed'}`,
        };
      }
    }
    const completed = outcomes.filter((o) => o.status === 'done').length;
    const summary = { completed, steps: outcomes };
    const durationMs = Date.now() - macro.started;
    const end: JobEnd = macro.cancelled
      ? {
          jobId: macro.id,
          agentId: macro.agentId,
          status: 'cancelled',
          durationMs,
          result: summary,
          error: { code: 'INTERRUPTED', msg: macro.cancelled },
        }
      : failure
        ? {
            jobId: macro.id,
            agentId: macro.agentId,
            status: 'failed',
            durationMs,
            result: summary,
            error: failure,
          }
        : { jobId: macro.id, agentId: macro.agentId, status: 'done', durationMs, result: summary };
    this.#macros.delete(macro.id);
    this.#progressText.delete(macro.id);
    this.#ended.set(macro.id, end);
    if (this.#ended.size > 64) {
      const oldest = this.#ended.keys().next().value;
      if (oldest !== undefined) this.#ended.delete(oldest);
    }
    macro.finish(end);
    this.emit('result', end);
  }

  #cancelMacro(macro: Macro, reason: string): void {
    macro.cancelled ??= reason;
    const child = macro.childId;
    if (child) void this.#inner.cancelSkill(macro.agentId, { jobId: child, reason }).catch(() => {});
  }

  async cancelSkill(
    agentId: string,
    options: { jobId?: string | undefined; reason: string },
  ): Promise<readonly string[]> {
    const macro = options.jobId ? this.#macros.get(options.jobId) : undefined;
    if (macro) {
      if (macro.agentId !== agentId) return [];
      this.#cancelMacro(macro, options.reason);
      return [macro.id];
    }
    const macros = [...this.#macros.values()].filter((m) => m.agentId === agentId);
    for (const m of macros) m.cancelled ??= options.reason;
    const cancelled = await this.#inner.cancelSkill(agentId, options);
    // The running step's id belongs to the macro: report the macro instead.
    const childIds = new Set(macros.map((m) => m.childId));
    return [
      ...cancelled.filter((id) => !childIds.has(id)),
      ...(options.jobId ? [] : macros.map((m) => m.id)),
    ];
  }

  awaitJob(jobId: string, timeoutMs?: number): Promise<JobEnd> {
    const ended = this.#ended.get(jobId);
    if (ended) return Promise.resolve(ended);
    const macro = this.#macros.get(jobId);
    if (!macro) return this.#inner.awaitJob(jobId, timeoutMs);
    if (timeoutMs === undefined) return macro.done;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ApiError('TIMEOUT', `job ${jobId} did not end within ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
      void macro.done.then((end) => {
        clearTimeout(timer);
        resolve(end);
      });
    });
  }

  obsQuery(...a: Parameters<SkillApi['obsQuery']>): ReturnType<SkillApi['obsQuery']> {
    return this.#inner.obsQuery(...a);
  }

  setMode(...a: Parameters<SkillApi['setMode']>): ReturnType<SkillApi['setMode']> {
    return this.#inner.setMode(...a);
  }

  seat(...a: Parameters<SkillApi['seat']>): ReturnType<SkillApi['seat']> {
    return this.#inner.seat(...a);
  }

  unseat(...a: Parameters<SkillApi['unseat']>): ReturnType<SkillApi['unseat']> {
    return this.#inner.unseat(...a);
  }

  spawn(...a: Parameters<SkillApi['spawn']>): ReturnType<SkillApi['spawn']> {
    return this.#inner.spawn(...a);
  }

  despawn(...a: Parameters<SkillApi['despawn']>): ReturnType<SkillApi['despawn']> {
    return this.#inner.despawn(...a);
  }
}

/** `skills` with Node's `sequence` fallback (a no-op wrapper for a mod that runs sequences itself). */
export function withSequenceFallback(skills: SkillApi): SkillApi {
  return skills instanceof SequenceFallbackSkillApi ? skills : new SequenceFallbackSkillApi(skills);
}
