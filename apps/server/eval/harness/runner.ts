/**
 * Runs one scenario once: a real MineVibe agent session (AgentSession + buildSessionOptions + persona, the `mc` and
 * `pc` tool definitions of production, the ToolGate hook and the InteractionBroker) wired to the simulated world and
 * the scripted PC. Only the query factory differs between modes: the Agent SDK (live) or the scripted model (replay).
 *
 * The run sends the player's message (mc) or the PC kickoff (pc), lets jobs that answered `running` finish in game
 * time and wakes the agent with `[JOB DONE]` like the EventRouter would (within the per-run turn cap and the global
 * turn budget), lets the world settle, then evaluates the scenario's checks.
 *
 * Eval-only deviations from production, all deliberate: one agent (the CEO Ada) with no welcome turn (its first turn
 * opens with the mode's MODE banner, as in production), the PC session starts seated (no sit/swap turn), WebSearch/WebFetch are denied (the eval PC is offline), question cards are
 * answered by the scenario at once, and every `mc` tool call costs 2 s of game time ("thinking").
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CardQuestion } from '@minevibe/protocol';
import { AgentSession } from '../../src/agents/AgentSession.js';
import { agentEnv } from '../../src/agents/agentEnv.js';
import type { ResolvedClaude } from '../../src/agents/claudeBinary.js';
import { type BrainProfile, MCP_TOOL_TIMEOUT_MS, type McToolsVersion } from '../../src/agents/constants.js';
import { summarizeResult } from '../../src/agents/EventRouter.js';
import { control, newNonce, singleLine } from '../../src/agents/envelope.js';
import { createInteractionBroker } from '../../src/agents/InteractionBroker.js';
import { HandoffNotes } from '../../src/agents/memory.js';
import { modeForSeat } from '../../src/agents/modes.js';
import { type Card, PendingStore } from '../../src/agents/PendingStore.js';
import { PlanCapture } from '../../src/agents/PlanCapture.js';
import { kickoffMessage, rosterContext } from '../../src/agents/prompts/kickoff.js';
import { modeBanner } from '../../src/agents/prompts/modes.js';
import { personaPrompt } from '../../src/agents/prompts/persona.js';
import type { SeatSnapshot } from '../../src/agents/SeatFSM.js';
import type {
  HookCallback,
  PermissionMode,
  PreToolUseHookInput,
  QueryFactory,
  SDKResultMessage,
} from '../../src/agents/sdk.js';
import { buildSessionOptions } from '../../src/agents/sessionOptions.js';
import { createToolGateHook, type GateContext } from '../../src/agents/ToolGate.js';
import { renderOutcome, wakeText } from '../../src/agents/tools/format.js';
import { JobRegistry } from '../../src/agents/tools/jobs.js';
import {
  type McHost,
  mcServerOptions,
  mcToolDefinitions,
  splitFooter,
} from '../../src/agents/tools/mcServer.js';
import {
  BatchBook,
  jobNotification,
  type PcHost,
  PcJobBook,
  pcToolDefinitions,
} from '../../src/agents/tools/pcServer.js';
import type { CallToolResult } from '../../src/agents/tools/results.js';
import { agentActor } from '../../src/contracts/common.js';
import { FakeOrgApi } from '../../src/contracts/FakeOrgApi.js';
import { withSequenceFallback } from '../../src/contracts/SequenceFallback.js';
import type { JobEnd } from '../../src/contracts/SkillApi.js';
import { SERVER_VERSION } from '../../src/version.js';
import { HOME } from '../pc/content.js';
import { PC_ID, ScriptedPc } from '../pc/ScriptedPc.js';
import { buildWorld } from '../sim/layout.js';
import { SimSkillApi } from '../sim/SimSkillApi.js';
import { type SimWorld, TPS } from '../sim/world.js';
import { clip, StreamMetrics } from './metrics.js';
import type {
  AskRecord,
  Check,
  Mode,
  RunResult,
  RunTrace,
  Scenario,
  StopReason,
  ToolCallRecord,
} from './types.js';

export const AGENT_ID = 'ada';
export const PLAYER = 'Jasper';
/** Game time one `mc` tool call costs (the world keeps running while the model thinks). */
export const THINK_TICKS = 2 * TPS;

/** The global model-turn budget of an eval: every run keeps one turn for each run still to come. */
export class TurnBudget {
  remaining: number;
  pendingRuns: number;

  constructor(turns: number, runs: number) {
    this.remaining = turns;
    this.pendingRuns = runs;
  }

  /** The first turn of a run. */
  startRun(): boolean {
    this.pendingRuns = Math.max(0, this.pendingRuns - 1);
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  /** A follow-up turn ([JOB DONE]) of the current run, if it leaves a turn for every run still to come. */
  extra(): boolean {
    if (this.remaining - 1 < this.pendingRuns) return false;
    this.remaining--;
    return true;
  }
}

export class FatalEvalError extends Error {}

export interface RunOptions {
  readonly mode: Mode;
  readonly run: number;
  readonly factory: QueryFactory;
  readonly claude: ResolvedClaude;
  readonly profile: BrainProfile;
  readonly budget: TurnBudget;
  /** Model turns one run may use (the opening message plus [JOB DONE] wakes). */
  readonly maxRunTurns: number;
  readonly turnTimeoutMs: number;
  /** Abort the eval when the session's startup assertions fail (live: an API key, no subscription). */
  readonly requireSubscription: boolean;
  /** The `mc` tool set (default v1). */
  readonly tools?: McToolsVersion | undefined;
  /** The simulated mod: v1 (no provenance) or v2 (W1 + the v2 skills). Default: the tool set's. */
  readonly mod?: 'v1' | 'v2' | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: tool definitions of many input shapes
type Def = SdkMcpToolDefinition<any>;

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text') as { text?: string } | undefined;
  return block?.text ?? '';
}

/** Default answer to a question card: the first option, else "Your call." */
function defaultAnswer(q: CardQuestion): string {
  return q.options[0]?.label ?? 'Your call.';
}

/** The `[JOB DONE]` / `[JOB FAILED]` wake of a tracked job (EventRouter.jobEnded). */
export function jobEndedText(nonce: string, end: JobEnd, label: string): string {
  const kind = end.status === 'done' ? 'JOB DONE' : 'JOB FAILED';
  const detail =
    end.status === 'done'
      ? summarizeResult(end.result)
      : end.status === 'cancelled'
        ? 'cancelled'
        : `${end.error?.code ?? 'FAILED'}: ${end.error?.msg ?? 'failed'}`;
  return control(nonce, kind, singleLine(`${end.jobId} ${label}: ${detail}`, 400));
}

/**
 * The v2 wake of a tracked job (AgentBrain.toolJobEnded + EventRouter.jobEnded): the result line in the v2 format, or
 * null when no wake is due ({@link JobRegistry.wakeDue}): the agent itself stopped or replaced the job, or a
 * `job{wait}` already returned its end.
 */
export function jobEndedTextV2(
  nonce: string,
  end: JobEnd,
  jobs: JobRegistry,
  player: string,
  world: SimWorld,
): string | null {
  const meta = jobs.meta(end.jobId);
  if (!meta) return null;
  const rendered = renderOutcome(
    meta,
    {
      status: end.status,
      result: splitFooter(end.result).result,
      error: end.error,
      durationMs: end.durationMs,
    },
    { here: world.agent.pos, playerName: player, craftTree: world.mod === 'v2' },
  );
  jobs.ended(end.jobId, end.status, rendered, end.error?.code);
  // As AgentBrain.toolJobEnded: no wake for a job the agent stopped or replaced, or one a job{wait} reported.
  if (!jobs.wakeDue(end.jobId, end.status)) return null;
  return control(
    nonce,
    end.status === 'done' ? 'JOB DONE' : 'JOB FAILED',
    wakeText(end.jobId, rendered, meta.skill === 'sequence'),
  );
}

const WANDERING: SeatSnapshot = {
  state: 'wandering',
  kind: null,
  pcId: null,
  meetingId: null,
  epoch: 0,
  since: 0,
  purpose: null,
  jobId: null,
  debounceUntil: 0,
  lastPcId: null,
  awayExpiresAt: null,
  lastEnd: null,
};

function seatedAt(pcId: string, purpose: string): SeatSnapshot {
  return { ...WANDERING, state: 'seated', kind: 'pc', pcId, epoch: 1, purpose };
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), 'mv-eval-'));
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const nonce = newNonce();
  const seated = scenario.suite === 'pc';
  const world: SimWorld = scenario.suite === 'mc' ? scenario.world() : buildWorld();
  const tools: McToolsVersion = opts.tools ?? 'v1';
  const skills = new SimSkillApi(world, { mod: opts.mod ?? tools });
  // What production gives the tools: Node's `sequence` fallback when the mod lacks the cap.
  const toolSkills = withSequenceFallback(skills);
  const jobs = new JobRegistry(() => Math.round((world.clock * 1000) / TPS));
  const pc = new ScriptedPc();
  const metrics = new StreamMetrics();
  const calls: ToolCallRecord[] = [];
  const denials: { tool: string; reason: string; turn: number }[] = [];
  const asked: AskRecord[] = [];
  const speech: string[] = [];
  const tracked = new Map<string, string>();
  const delivered = new Set<string>();
  let turn = 0;
  let finalText = '';
  let effort: string | null = null;
  const log = opts.log ?? (() => {});

  const onSpeech = (text: string) => {
    speech.push(text);
    if (scenario.suite === 'mc') scenario.onSpeech?.(world, text);
  };

  // --- tool hosts over the simulated backends -------------------------------------------------------------------
  const org = new FakeOrgApi({
    clockTime: () => world.clock,
    playerName: () => PLAYER,
    isCeo: () => true,
    positionOf: () => ({ pos: world.agent.pos, dim: 'minecraft:overworld' }),
  });
  const mcHost: McHost = {
    agentId: AGENT_ID,
    skills: toolSkills,
    org,
    actor: () => agentActor(AGENT_ID, true),
    playerName: () => PLAYER,
    footer: () => world.footer(),
    here: () => ({ pos: world.agent.pos, dim: 'minecraft:overworld' }),
    clockTime: () => world.clock,
    trackJob: (jobId, label) => {
      tracked.set(jobId, label);
    },
    say: (text) => onSpeech(text),
    tell: async (to) => `Sent to ${to}.`,
    remember: async () => 'Remembered.',
    requestHire: async () => `Asked ${PLAYER}; you get a [HIRE DECISION] later.`,
    sitAtPc: async () => 'There is no PC in this world.',
    // AgentBrain.standUp's reply while seated (the gate denies stand_up while wandering).
    standUp: async () =>
      `Stood up from ${PC_ID}. Your PC tools stop now; tell ${PLAYER} the result if you haven't.`,
    wait: async (ms, jobId) => {
      if (jobId) {
        try {
          const end = await toolSkills.awaitJob(jobId, ms);
          delivered.add(jobId);
          return `Job ${jobId} ${end.status}.`;
        } catch {
          return `Waited ${Math.round(ms / 1000)} s; job ${jobId} is still running.`;
        }
      }
      world.advance(world.clock + Math.round((ms / 1000) * TPS));
      return `Waited ${Math.round(ms / 1000)} s.`;
    },
    taskReported: () => {},
    jobs,
    body: () => null,
  };
  const plans = new PlanCapture([home, HOME]);
  // PC tools V2: the batch book is fed from the stream (as AgentBrain does), background jobs notify like the brain's
  // `<task-notification>` wakes, and the scripted screen settles at once (it never animates).
  const batch = new BatchBook();
  const pcJobs = new PcJobBook();
  const pcNotices: string[] = [];
  pc.onJobExit((exit) => {
    const job = pcJobs.get(exit.pcId, exit.jobId);
    if (!job) return;
    pcJobs.delete(exit.pcId, exit.jobId);
    const block = jobNotification(job, exit);
    if (block) pcNotices.push(`${control(nonce, 'PC JOB', 'A background command ended.')}\n${block}`);
  });
  const pcHost: PcHost = {
    agentId: AGENT_ID,
    pcs: pc,
    plans,
    handoffs: new HandoffNotes(join(tmp, 'handoffs')),
    access: () => (seated ? { pcId: PC_ID, epoch: 1 } : null),
    authorName: () => 'Ada',
    playerName: () => PLAYER,
    batch,
    jobs: pcJobs,
    settle: { pollMs: 10, minMs: 0, maxMs: 100 },
  };

  const instrument = (server: 'mc' | 'pc', defs: Def[]): Def[] =>
    defs.map((d) => ({
      ...d,
      handler: async (args: Record<string, unknown>, extra: unknown) => {
        if (server === 'mc') world.advance(world.clock + THINK_TICKS);
        let res: CallToolResult;
        try {
          res = await d.handler(args, extra);
        } catch (err) {
          calls.push({
            tool: `mcp__${server}__${d.name}`,
            input: args,
            isError: true,
            text: String(err),
            turn,
          });
          throw err;
        }
        calls.push({
          tool: `mcp__${server}__${d.name}`,
          input: args,
          isError: res.isError === true,
          text: clip(firstText(res), 300),
          turn,
        });
        return res;
      },
    }));
  const mcServer = createSdkMcpServer({
    ...mcServerOptions(tools),
    tools: instrument('mc', mcToolDefinitions(mcHost, tools)),
  });
  const pcServer = createSdkMcpServer({
    name: 'pc',
    version: '1.0.0',
    alwaysLoad: true,
    timeout: MCP_TOOL_TIMEOUT_MS,
    tools: instrument('pc', pcToolDefinitions(pcHost)),
  });

  // --- gate and broker --------------------------------------------------------------------------------------------
  const seat = seated ? seatedAt(PC_ID, scenario.prompt) : WANDERING;
  let trackedMode: PermissionMode = 'default';
  const turnState = { calls: 0, startedAt: Date.now() };
  let halted: string | null = null;
  let startupDone: Promise<void> | null = null;
  let startupProblems: string[] = [];
  const context = (): GateContext => ({
    agentId: AGENT_ID,
    ceo: true,
    seat,
    occupant: (id) => (seated && id === PC_ID ? AGENT_ID : null),
    trackedMode,
    plans,
    turn: { calls: turnState.calls, activeMs: Date.now() - turnState.startedAt },
    playerName: PLAYER,
    halted,
    mcTools: tools,
  });
  const gateHook = createToolGateHook(context, (o) => {
    turnState.calls++;
    if (o.effort) effort = o.effort;
    if (o.permissionMode === 'plan' || o.permissionMode === 'default') trackedMode = o.permissionMode;
    if (o.decision.behavior === 'deny') denials.push({ tool: o.toolName, reason: o.decision.reason, turn });
  });
  const gate: HookCallback = async (input, toolUseId, options) => {
    if (startupDone) await Promise.race([startupDone, new Promise((r) => setTimeout(r, 15_000).unref?.())]);
    // A halted live session (startup assertions failed before this turn began) ends the turn at its first tool call.
    if (halted && opts.requireSubscription) void session?.interrupt();
    const h = input as PreToolUseHookInput;
    if (h.hook_event_name === 'PreToolUse' && (h.tool_name === 'WebSearch' || h.tool_name === 'WebFetch')) {
      const reason = 'This eval PC is offline: there is no web access. Use the PC itself.';
      denials.push({ tool: h.tool_name, reason, turn });
      turnState.calls++;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    return gateHook(input, toolUseId, options);
  };
  let session: AgentSession | null = null;
  const store = new PendingStore();
  const answerCard = (card: Card) => {
    if (card.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const q of card.questions) {
        answers[q.question] = scenario.answer?.(q) ?? defaultAnswer(q);
        speech.push(q.question);
      }
      asked.push({ questions: card.questions, answers, turn });
      metrics.transcript.push(
        `    ? ${clip(
          Object.entries(answers)
            .map(([q, a]) => `${q} -> ${a}`)
            .join(' | '),
          200,
        )}`,
      );
      store.resolve(card.id, { kind: 'answered', answers });
    } else if (card.kind === 'plan') {
      metrics.transcript.push('    ? plan approved');
      store.resolve(card.id, { kind: 'approved' });
    }
  };
  const canUseTool = createInteractionBroker({
    agentId: AGENT_ID,
    store,
    plans,
    seatEpoch: () => seat.epoch,
    playerName: () => PLAYER,
    hooks: {
      onWaitStart: (card) => {
        setImmediate(() => answerCard(card));
      },
      onWaitEnd: async () => {},
      setPermissionMode: async (mode) => {
        trackedMode = mode;
        await session?.setPermissionMode(mode);
      },
    },
  });

  // --- session ----------------------------------------------------------------------------------------------------
  const persona = personaPrompt({
    name: 'Ada',
    handle: 'ada',
    role: 'ceo',
    ceo: true,
    playerName: PLAYER,
    nonce,
    mcTools: tools,
  });
  const options = buildSessionOptions({
    claude: opts.claude,
    env: agentEnv({ version: SERVER_VERSION }),
    cwd: home,
    resume: null,
    sessionId: randomUUID(),
    persona,
    mc: mcServer,
    pc: pcServer,
    profile: opts.profile,
  });
  let waiter: ((r: SDKResultMessage | null) => void) | null = null;
  let exitError: Error | null = null;
  session = new AgentSession(
    { agentId: AGENT_ID, options, gate, canUseTool, queryFactory: opts.factory },
    {
      onInit: (init, first) => {
        if (!first || !session) return;
        startupDone = session.checkStartup(init, 'subscription').then((problems) => {
          startupProblems = problems;
          if (problems.length === 0) return;
          halted = problems.join('; ');
          // Live: end the turn now. The gate denies every tool while halted, but the model would keep calling them,
          // one API round trip each (up to maxTurns), on whatever account the session is wrongly using.
          if (opts.requireSubscription) void session?.interrupt();
        });
      },
      onMessage: (m) => metrics.onMessage(m),
      onToolUse: (name, _input, toolUseId, messageId) => {
        if (messageId) batch.toolUse(messageId, toolUseId, name);
      },
      onStream: (mark) => {
        if (mark.kind === 'message_start') batch.messageStart(mark.messageId);
        else if (mark.kind === 'tool_use') batch.toolUse(mark.messageId, mark.toolUseId, mark.name);
        else batch.messageStop(mark.messageId);
      },
      onTurnEnd: (r) => waiter?.(r),
      onExit: (err) => {
        exitError = err;
        waiter?.(null);
      },
    },
  );

  const sendAndWait = (text: string): Promise<{ result: SDKResultMessage | null; timedOut: boolean }> =>
    new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        log(`  ! turn timeout after ${opts.turnTimeoutMs} ms: interrupting`);
        void session?.interrupt();
        setTimeout(() => {
          waiter = null;
          resolve({ result: null, timedOut: true });
        }, 30_000).unref?.();
      }, opts.turnTimeoutMs);
      waiter = (r) => {
        clearTimeout(timer);
        waiter = null;
        resolve({ result: r, timedOut });
      };
      session?.send(text);
    });

  let stop: StopReason = 'done';
  let error: string | undefined;
  let turns = 0;
  try {
    session.start();
    let text: string;
    if (scenario.suite === 'mc') {
      session.send(
        rosterContext(nonce, 'ada', [
          { name: 'Ada', handle: 'ada', role: 'ceo', ceo: true, status: 'alive' },
        ]),
        { shouldQuery: false },
      );
      text = `${PLAYER}: ${scenario.prompt}`;
    } else {
      text = kickoffMessage({
        nonce,
        playerName: PLAYER,
        pc: await pc.info(PC_ID),
        task: scenario.prompt,
        planFirst: false,
        claudeMd: null,
        handoffs: [],
      });
    }
    // As in production (AgentBrain), the first turn opens with the mode banner: Minecraft mode for mc, PC mode for pc.
    text = `${modeBanner(modeForSeat(seat), { nonce, playerName: PLAYER, mcTools: tools })}\n\n${text}`;
    for (let t = 0; ; t++) {
      if (t >= opts.maxRunTurns) {
        stop = 'turn_cap';
        break;
      }
      if (!(t === 0 ? opts.budget.startRun() : opts.budget.extra())) {
        stop = 'budget';
        break;
      }
      turn = t + 1;
      turnState.calls = 0;
      turnState.startedAt = Date.now();
      metrics.turnTexts = [];
      metrics.transcript.push(`T${turn} > ${clip(text.replace(/\[MV:[0-9a-f]{6} /g, '['), 220)}`);
      const { result, timedOut } = await sendAndWait(text);
      turns++;
      if (startupProblems.length > 0 && opts.requireSubscription) {
        throw new FatalEvalError(`startup assertions failed: ${startupProblems.join('; ')}`);
      }
      if (timedOut) stop = 'timeout';
      if (!result) {
        stop = exitError ? 'error' : 'timeout';
        error = exitError ? String((exitError as Error).message) : 'no result';
        break;
      }
      const said = result.subtype === 'success' ? result.result : (metrics.turnTexts.at(-1) ?? '');
      finalText = said;
      if (said.trim().length > 0) onSpeech(said);
      if (result.subtype !== 'success') metrics.transcript.push(`  ! ${result.subtype}`);
      if (timedOut) break;
      // Jobs that answered `running` finish in game time; their ends wake the agent like the EventRouter does.
      const endOf = new Map<string, JobEnd>();
      for (const jobId of tracked.keys()) {
        if (delivered.has(jobId)) continue;
        try {
          endOf.set(jobId, skills.ended(jobId) ?? (await toolSkills.awaitJob(jobId, 10 * 60_000)));
        } catch {
          // still running after 10 minutes: no wake
        }
      }
      const ended = [...tracked].filter(([id]) => !delivered.has(id) && endOf.has(id));
      const wakes = ended
        .map(([id, label]) => {
          delivered.add(id);
          const end = endOf.get(id) as JobEnd;
          return tools === 'v2'
            ? jobEndedTextV2(nonce, end, jobs, PLAYER, world)
            : jobEndedText(nonce, end, label);
        })
        .filter((t): t is string => t !== null);
      // Background PC commands that ended wake the agent with their task notification, like the brain's wakes.
      await new Promise((r) => setTimeout(r, 0));
      const notices = pcNotices.splice(0);
      if (wakes.length === 0 && notices.length === 0) break;
      text = [...wakes, ...notices].join('\n\n');
    }
  } catch (err) {
    if (err instanceof FatalEvalError) {
      await session.close().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    stop = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - t0;
  await session.close().catch(() => {});
  if (scenario.suite === 'mc' && scenario.settleTicks) world.advance(world.clock + scenario.settleTicks);

  const trace: RunTrace = { calls, denials, asked, speech, finalText };
  let checks: Check[];
  try {
    checks =
      scenario.suite === 'mc'
        ? scenario.checks({ ...trace, world, skills })
        : scenario.checks({ ...trace, pc });
  } catch (err) {
    checks = [{ name: 'checks_ran', pass: false, required: true, detail: String(err) }];
  }
  rmSync(tmp, { recursive: true, force: true });
  const success = checks.filter((c) => c.required).every((c) => c.pass) && stop !== 'error';
  return {
    scenario: scenario.id,
    suite: scenario.suite,
    mode: opts.mode,
    run: opts.run,
    tools,
    model: metrics.model ?? opts.profile.model,
    effort: effort ?? opts.profile.effort,
    success,
    checks,
    turns,
    apiTurns: metrics.apiTurns,
    toolCalls: metrics.toolCalls,
    // The stream's tool results are the model's view; without them, count what the gate and handlers saw.
    failedCalls:
      metrics.toolResults > 0 ? metrics.failedCalls : calls.filter((c) => c.isError).length + denials.length,
    deniedCalls: denials.length,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    costUsd: metrics.costUsd,
    wallMs,
    stop,
    error,
    finalText,
    transcript: metrics.transcript,
  };
}
