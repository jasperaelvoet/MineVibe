/**
 * Tool eval harness CLI (not part of `npm test`):
 *
 *   npm run eval:tools -- --suite mc|pc|all --mode replay|live [--budget N] [--runs N] [--scenario id,id]
 *
 * - `replay` (default) runs every scenario's scripted good run (must pass) and bad run (must fail) through the real
 *   session wiring with a scripted model: no model calls, deterministic, exits 1 when a script does not behave.
 * - `live` runs the scenarios on the user's subscription through the Agent SDK (`MINEVIBE_CLAUDE=bundled` in dev):
 *   mc on Haiku 5.5 at xhigh (3 runs each), pc on Opus 5.5 at medium (1 run each), PC runs first, mc runs round-robin.
 *   `--budget` caps model turns across the whole eval (default 40); every run keeps a turn for the runs still to come.
 *
 * Results: a Markdown summary on stdout and every run (checks, metrics, transcript) as JSON in `eval/out/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentEnv } from '../src/agents/agentEnv.js';
import { type ResolvedClaude, resolveClaudeBinary } from '../src/agents/claudeBinary.js';
import { type BrainProfile, SEATED_PROFILE, WANDERING_PROFILE } from '../src/agents/constants.js';
import { type QueryFactory, sdkQueryFactory } from '../src/agents/sdk.js';
import { SERVER_VERSION } from '../src/version.js';
import { formatRuns, formatTable, summarize } from './harness/metrics.js';
import { FatalEvalError, runScenario, TurnBudget } from './harness/runner.js';
import { scriptedFactory } from './harness/scripted.js';
import type { Mode, RunResult, Scenario, Suite } from './harness/types.js';
import { MC_SCENARIOS } from './scenarios/mc.js';
import { PC_SCENARIOS } from './scenarios/pc.js';

export interface CliOptions {
  readonly suite: Suite | 'all';
  readonly mode: Mode;
  readonly budget: number;
  readonly runs: number | null;
  readonly scenarios: readonly string[];
  readonly mcTurns: number;
  readonly pcTurns: number;
  readonly out: string | null;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      suite: { type: 'string', default: 'all' },
      mode: { type: 'string', default: 'replay' },
      budget: { type: 'string', default: '40' },
      runs: { type: 'string' },
      scenario: { type: 'string' },
      'mc-turns': { type: 'string', default: '3' },
      'pc-turns': { type: 'string', default: '2' },
      out: { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  const suite = values.suite as string;
  if (!['mc', 'pc', 'all'].includes(suite)) throw new Error(`--suite must be mc, pc or all (got ${suite})`);
  const mode = values.mode as string;
  if (mode !== 'replay' && mode !== 'live') throw new Error(`--mode must be replay or live (got ${mode})`);
  const int = (name: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return n;
  };
  return {
    suite: suite as CliOptions['suite'],
    mode,
    budget: int('budget', values.budget, 1),
    runs: values.runs === undefined ? null : int('runs', values.runs, 1),
    scenarios: values.scenario ? values.scenario.split(',').map((s) => s.trim()) : [],
    mcTurns: int('mc-turns', values['mc-turns'], 1),
    pcTurns: int('pc-turns', values['pc-turns'], 1),
    out: values.out ?? null,
  };
}

/** The scenarios of a suite, filtered by id (a prefix like `mc.iron` or the full id). */
export function selectScenarios(suite: CliOptions['suite'], ids: readonly string[]): Scenario[] {
  const all: Scenario[] = [...(suite === 'mc' ? [] : PC_SCENARIOS), ...(suite === 'pc' ? [] : MC_SCENARIOS)];
  const picked =
    ids.length === 0 ? all : all.filter((s) => ids.some((id) => s.id === id || s.id.startsWith(id)));
  if (picked.length === 0) throw new Error(`no scenario matches ${ids.join(', ')}`);
  return picked;
}

export interface PlannedRun {
  readonly scenario: Scenario;
  readonly run: number;
}

/** Live order: every PC run first, then the mc runs round-robin (run 1 of each, then run 2, ...). */
export function planLive(scenarios: readonly Scenario[], runs: number | null): PlannedRun[] {
  const plan: PlannedRun[] = [];
  const pcs = scenarios.filter((s) => s.suite === 'pc');
  const mcs = scenarios.filter((s) => s.suite === 'mc');
  for (let r = 1; r <= (runs ?? 1); r++) for (const s of pcs) plan.push({ scenario: s, run: r });
  for (let r = 1; r <= (runs ?? 3); r++) for (const s of mcs) plan.push({ scenario: s, run: r });
  return plan;
}

function profileFor(s: Scenario): BrainProfile {
  return s.suite === 'pc' ? SEATED_PROFILE : WANDERING_PROFILE;
}

const BUNDLED: ResolvedClaude = { source: 'bundled', path: undefined, version: null };

export interface ReplayOutcome {
  readonly scenario: string;
  readonly variant: 'good' | 'bad';
  readonly expected: boolean;
  readonly result: RunResult;
}

/** Runs the scripted good and bad runs of each scenario. */
export async function runReplays(scenarios: readonly Scenario[]): Promise<ReplayOutcome[]> {
  const out: ReplayOutcome[] = [];
  for (const s of scenarios) {
    for (const variant of ['good', 'bad'] as const) {
      const replay = s.replay[variant];
      if (!replay) continue;
      const result = await runScenario(s, {
        mode: 'replay',
        run: variant === 'good' ? 1 : 2,
        factory: scriptedFactory(replay),
        claude: BUNDLED,
        profile: profileFor(s),
        budget: new TurnBudget(Number.MAX_SAFE_INTEGER, 0),
        maxRunTurns: replay.length,
        turnTimeoutMs: 30_000,
        requireSubscription: false,
      });
      out.push({ scenario: s.id, variant, expected: variant === 'good', result });
    }
  }
  return out;
}

/** Live caps per turn (API round trips) and per run spend, on top of the production options. */
const LIVE_CAPS = {
  mc: { maxTurns: 30, maxBudgetUsd: 1 },
  pc: { maxTurns: 50, maxBudgetUsd: 3 },
} as const;

function liveFactory(suite: Suite): QueryFactory {
  const caps = LIVE_CAPS[suite];
  return (params) =>
    sdkQueryFactory({
      ...params,
      options: {
        ...params.options,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
        persistSession: false,
      },
    });
}

export async function runLive(
  plan: readonly PlannedRun[],
  cli: CliOptions,
  log: (line: string) => void,
): Promise<RunResult[]> {
  const claude = await resolveClaudeBinary({
    versionEnv: agentEnv({ version: SERVER_VERSION }),
    allowBundled: true,
  });
  log(
    `claude: ${claude.source}${claude.version ? ` ${claude.version}` : ''}; budget ${cli.budget} turns, ${plan.length} runs`,
  );
  const budget = new TurnBudget(cli.budget, plan.length);
  const results: RunResult[] = [];
  for (const { scenario, run } of plan) {
    if (budget.remaining <= 0) {
      log(`- ${scenario.id} #${run}: skipped (turn budget spent)`);
      continue;
    }
    log(`- ${scenario.id} #${run} (${budget.remaining} turns left)`);
    try {
      const r = await runScenario(scenario, {
        mode: 'live',
        run,
        factory: liveFactory(scenario.suite),
        claude,
        profile: profileFor(scenario),
        budget,
        maxRunTurns: scenario.suite === 'pc' ? cli.pcTurns : cli.mcTurns,
        turnTimeoutMs: scenario.suite === 'pc' ? 12 * 60_000 : 6 * 60_000,
        requireSubscription: true,
        log,
      });
      results.push(r);
      log(
        `  ${r.success ? 'PASS' : 'FAIL'} ${r.toolCalls} calls, ${r.failedCalls} failed, ${r.turns} turns, ${(r.wallMs / 1000).toFixed(1)} s, stop ${r.stop}`,
      );
    } catch (err) {
      if (err instanceof FatalEvalError) {
        log(`ABORT: ${err.message}`);
        break;
      }
      throw err;
    }
  }
  return results;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  const scenarios = selectScenarios(cli.suite, cli.scenarios);
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const outDir = join(import.meta.dirname, 'out');
  mkdirSync(outDir, { recursive: true });
  const outFile = cli.out ?? join(outDir, `${cli.mode}-${cli.suite}-${stamp()}.json`);

  if (cli.mode === 'replay') {
    const outcomes = await runReplays(scenarios);
    const bad = outcomes.filter((o) => o.result.success !== o.expected);
    log('## Replay (scripted model)\n');
    log(
      outcomes
        .map(
          (o) =>
            `- ${o.scenario} [${o.variant}] ${o.result.success ? 'PASS' : 'FAIL'} (expected ${o.expected ? 'PASS' : 'FAIL'})${o.result.success === o.expected ? '' : '  <-- unexpected'} — ${o.result.toolCalls} calls, ${o.result.failedCalls} failed`,
        )
        .join('\n'),
    );
    writeFileSync(outFile, `${JSON.stringify(outcomes, null, 2)}\n`);
    log(
      `\n${bad.length === 0 ? 'all scripts behave' : `${bad.length} scripts misbehave`}; details in ${outFile}`,
    );
    return bad.length === 0 ? 0 : 1;
  }

  const plan = planLive(scenarios, cli.runs);
  const results = await runLive(plan, cli, log);
  writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);
  log(
    `\n## Summary\n\n${formatTable(summarize(results))}\n\n## Runs\n\n${formatRuns(results)}\n\nDetails: ${outFile}`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('/eval/run.ts')) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(2);
    },
  );
}
