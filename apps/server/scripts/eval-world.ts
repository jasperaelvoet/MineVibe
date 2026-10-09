/**
 * Live eval of the agents' world context (docs/design/EVALS.md): does the CEO gather from nature, and ask the player
 * instead of breaking the house when nature is out of reach?
 *
 *   npm run eval:world            (root or apps/server; never part of `npm test`)
 *   npm run eval:world -- --tools v1   (the v1 `mc` tools, the fallback; default: MINEVIBE_MC_TOOLS, else v2)
 *
 * Three scenarios, each a fresh world and a fresh CEO session through the real AgentManager (persona, Digest scene,
 * ToolGate, InteractionBroker, `mc` tools) on Haiku at xhigh, with the SDK-bundled `claude` (`MINEVIBE_CLAUDE=bundled`
 * unless set). The body side is {@link EvalWorldSkills}: the live incident's world as a fake mod, either the mod of
 * protocol §7.4.3 (`reachable`, `unreachable`) or today's mod without provenance (`legacy`). Each scenario is a
 * welcome turn plus the player's request ("collect 10 oak logs and make a crafting table"), so 6 model turns in all;
 * a question card is answered from chat inside the request turn. Caps: 16 API round trips and $1 per session.
 *
 * Writes the transcript summary and verdicts to `scripts/out/eval-world.json` (gitignored) and prints them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { AgentManager } from '../src/agents/AgentManager.js';
import { agentEnv } from '../src/agents/agentEnv.js';
import { resolveClaudeBinary } from '../src/agents/claudeBinary.js';
import type { Card } from '../src/agents/PendingStore.js';
import { type QueryFactory, type SDKResultMessage, sdkQueryFactory } from '../src/agents/sdk.js';
import { FakeOrgApi } from '../src/contracts/FakeOrgApi.js';
import { FakePcApi } from '../src/contracts/FakePcApi.js';
import { type McToolsVersion, mcToolsVersion } from '../src/contracts/mcRefs.js';
import { SERVER_VERSION } from '../src/version.js';
import {
  AGENT_POS,
  CLOCK,
  EvalWorldSkills,
  OFFICE,
  type ScenarioName,
  type ScenarioRecord,
  scoreScenario,
  stepLine,
  type Verdict,
} from './eval/worldEval.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const REQUEST = '@ada collect 10 oak logs and make a crafting table';
const TURN_TIMEOUT_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TurnInfo {
  readonly label: string;
  readonly ms: number;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly model: string | null;
  readonly text: string;
}

interface ScenarioReport {
  readonly scenario: ScenarioName;
  readonly verdict: Verdict;
  readonly steps: string[];
  readonly tools: string[];
  readonly cards: ScenarioRecord['cards'];
  readonly answers: string[];
  readonly said: string[];
  readonly turns: TurnInfo[];
  readonly costUsd: number;
  /** The scene line the request turn started with (its Digest). */
  readonly scene: string;
}

async function runScenario(
  scenario: ScenarioName,
  env: NodeJS.ProcessEnv,
  mcTools: McToolsVersion,
): Promise<ScenarioReport> {
  const dir = mkdtempSync(join(tmpdir(), `mv-eval-${scenario}-`));
  const claude = await resolveClaudeBinary({
    env,
    versionEnv: agentEnv({ version: SERVER_VERSION, source: env }),
    allowBundled: true,
  });
  const skills = new EvalWorldSkills(scenario);
  const factory: QueryFactory = (params) =>
    sdkQueryFactory({ ...params, options: { ...params.options, maxTurns: 16, maxBudgetUsd: 1 } });
  const manager = new AgentManager({
    skills,
    org: new FakeOrgApi(),
    pcs: new FakePcApi([{ pcId: 'linux-1' }]),
    claude,
    agentEnv: () => agentEnv({ version: SERVER_VERSION, source: env }),
    worldsDir: join(dir, 'worlds'),
    stateDir: join(dir, 'state'),
    playerName: () => 'Jasper',
    log: pino({ level: env.MINEVIBE_LOG_LEVEL ?? 'warn' }),
    queryFactory: factory,
    chatDebounceMs: 0,
    autonomyTickMs: 0,
    mcTools,
  });
  let refusals = 0;
  const noteRefusal = manager.consents.noteRefusal.bind(manager.consents);
  manager.consents.noteRefusal = (agentId, refusal) => {
    refusals++;
    noteRefusal(agentId, refusal);
  };
  const results: SDKResultMessage[] = [];
  const turns: TurnInfo[] = [];
  const tools: string[] = [];
  const said: string[] = [];
  const cards: { questions: string[]; options: string[][] }[] = [];
  const answers: string[] = [];
  let label = 'welcome';
  let started = Date.now();
  manager.on('turn', ({ result, model }) => {
    results.push(result);
    turns.push({
      label,
      ms: Date.now() - started,
      numTurns: result.num_turns,
      costUsd: result.total_cost_usd,
      model,
      text: result.subtype === 'success' ? result.result.slice(0, 400) : result.subtype,
    });
  });
  manager.on('tool', (o) => {
    tools.push(`${o.toolName.replace(/^mcp__/, '')}:${o.behavior}${o.effort ? ` (${o.effort})` : ''}`);
  });
  manager.on('say', (s) => {
    if (s.text) said.push(s.text);
  });
  manager.on('card', (card: Card) => {
    if (card.kind !== 'question') return;
    cards.push({
      questions: card.questions.map((q) => q.question),
      options: card.questions.map((q) => q.options.map((o) => o.label)),
    });
  });
  const waitFor = async (pred: () => boolean, what: string, ms = TURN_TIMEOUT_MS) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`${scenario}: timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  let scene = '';
  try {
    manager.onWorldState({ worldId: 'eval-1', phase: 'ready', office: OFFICE, clockTime: CLOCK });
    await manager.openWorld({ worldId: 'eval-1', gen: 1 });
    const agentId = manager.listAgents()[0]?.agentId ?? '';
    const brain = () => manager.brain(agentId);
    manager.onAgentState({
      tick: 1,
      agents: [
        {
          agentId,
          pos: AGENT_POS,
          dim: 'minecraft:overworld',
          hp: 20,
          maxHp: 20,
          food: 18,
          saturation: 4,
          mode: 'follow',
          hasFood: true,
          inCombat: false,
          playerDistance: 4,
          // Today's mod sends no zone: the scene then works the Base out from the office box.
          ...(scenario === 'legacy' ? {} : { zone: 'in Base' }),
        },
      ],
    });
    await waitFor(() => results.length >= 1, 'welcome result');
    await waitFor(() => brain()?.session?.inTurn === false, 'welcome settled', 30_000);
    // The request turn; question cards are answered from chat as they come ("Skip" when offered).
    label = 'request';
    started = Date.now();
    scene = brain()?.scene() ?? '';
    const before = results.length;
    await manager.deliverChat({ to: 'all', text: REQUEST });
    while (results.length === before) {
      const card = manager.pendingCards().find((c) => c.kind === 'question' && c.agentId === agentId);
      if (card && card.kind === 'question') {
        const q = card.questions[card.answers.length];
        const labels = q?.options.map((o) => o.label) ?? [];
        let pick = labels.findIndex((l) => /\bskip\b/i.test(l));
        if (pick === -1 && scenario !== 'unreachable') pick = 0;
        if (pick === -1) pick = labels.length - 1;
        const text = `@ada ${pick + 1}`;
        answers.push(`${q?.question ?? '?'} → ${labels[pick] ?? '?'}`);
        await manager.deliverChat({ to: 'all', text });
      }
      if (Date.now() - started > TURN_TIMEOUT_MS)
        throw new Error(`${scenario}: the request turn did not end`);
      await sleep(200);
    }
    await waitFor(() => brain()?.session?.inTurn === false, 'request settled', 30_000);
  } finally {
    await manager.shutdown().catch(() => {});
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
  const record: ScenarioRecord = { scenario, steps: skills.steps, cards, refusals, said, mcTools };
  return {
    scenario,
    verdict: scoreScenario(record),
    steps: skills.steps.map(stepLine),
    tools,
    cards,
    answers,
    said,
    turns,
    costUsd: results.at(-1)?.total_cost_usd ?? 0,
    scene,
  };
}

/** `--tools v1|v2`, else MINEVIBE_MC_TOOLS, else the default. */
function toolsFlag(argv: readonly string[], env: NodeJS.ProcessEnv): McToolsVersion {
  const i = argv.indexOf('--tools');
  const value = i === -1 ? undefined : argv[i + 1];
  if (value === undefined) return mcToolsVersion(env);
  if (value !== 'v1' && value !== 'v2') throw new Error(`--tools takes v1 or v2, not ${value}`);
  return value;
}

async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MINEVIBE_CLAUDE: process.env.MINEVIBE_CLAUDE ?? 'bundled',
  };
  const mcTools = toolsFlag(process.argv.slice(2), env);
  process.stdout.write(`mc tools ${mcTools}\n`);
  const reports: ScenarioReport[] = [];
  for (const scenario of ['reachable', 'unreachable', 'legacy'] as const) {
    process.stdout.write(`\n== ${scenario} ==\n`);
    try {
      const report = await runScenario(scenario, env, mcTools);
      reports.push(report);
      process.stdout.write(`  scene: ${report.scene}\n`);
      for (const line of report.steps) process.stdout.write(`  ${line}\n`);
      for (const c of report.cards) process.stdout.write(`  card: ${JSON.stringify(c)}\n`);
      for (const a of report.answers) process.stdout.write(`  answered: ${a}\n`);
      for (const t of report.said) process.stdout.write(`  said: ${t}\n`);
      process.stdout.write(
        `  verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(report.verdict.checks)}${report.verdict.notes.length > 0 ? ` notes: ${report.verdict.notes.join('; ')}` : ''}\n`,
      );
    } catch (err) {
      process.stdout.write(`  ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      reports.push({
        scenario,
        verdict: {
          pass: false,
          checks: {},
          notes: [`error: ${err instanceof Error ? err.message : String(err)}`],
        },
        steps: [],
        tools: [],
        cards: [],
        answers: [],
        said: [],
        turns: [],
        costUsd: 0,
        scene: '',
      });
    }
  }
  const summary = {
    at: new Date().toISOString(),
    claude: env.MINEVIBE_CLAUDE,
    mcTools,
    request: REQUEST,
    pass: reports.every((r) => r.verdict.pass),
    totalCostUsd: Number(reports.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
    modelTurns: reports.reduce((s, r) => s + r.turns.length, 0),
    reports,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'eval-world.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `\n${summary.pass ? 'PASS' : 'FAIL'}: ${reports.map((r) => `${r.scenario} ${r.verdict.pass ? 'pass' : 'fail'}`).join(', ')}; ${summary.modelTurns} model turns, $${summary.totalCostUsd} list estimate. Details: scripts/out/eval-world.json\n`,
  );
  process.exitCode = summary.pass ? 0 : 1;
}

await main();
