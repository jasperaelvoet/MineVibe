import { describe, expect, it } from 'vitest';
import { formatTable, StreamMetrics, summarize } from '../../../eval/harness/metrics.js';
import { jobEndedText, runScenario, TurnBudget } from '../../../eval/harness/runner.js';
import { scriptedFactory } from '../../../eval/harness/scripted.js';
import type { RunResult } from '../../../eval/harness/types.js';
import { parseCli, planLive, runReplays, selectScenarios } from '../../../eval/run.js';
import { chestUntouched, darkSafe, logsAndTable, SHELTER_WORDS } from '../../../eval/scenarios/mc.js';
import { HOUSE_CHEST } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { WANDERING_PROFILE } from '../../../src/agents/constants.js';
import type { SDKMessage } from '../../../src/agents/sdk.js';

const BUNDLED = { source: 'bundled' as const, path: undefined, version: null };

describe('replay mode (scripted model through the real session wiring)', () => {
  it('every good script passes and every bad script fails its checks', async () => {
    const outcomes = await runReplays(selectScenarios('all', []));
    const wrong = outcomes.filter((o) => o.result.success !== o.expected);
    expect(wrong.map((o) => `${o.scenario}/${o.variant}: ${JSON.stringify(o.result.checks)}`)).toEqual([]);
    expect(outcomes).toHaveLength(16);
    // The incident replay is caught by the house check.
    const incident = outcomes.find((o) => o.scenario === 'mc.logs_table' && o.variant === 'bad');
    expect(incident?.result.checks.find((c) => c.name === 'house_intact')).toMatchObject({ pass: false });
    // Models and efforts are the production profiles; metrics come from the stream.
    const pc = outcomes.find((o) => o.scenario === 'pc.fix_test' && o.variant === 'good')
      ?.result as RunResult;
    expect(pc).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      toolCalls: 5,
      failedCalls: 0,
      turns: 1,
    });
    // Seated, stand_up answers like AgentBrain.standUp.
    expect(pc.transcript.some((l) => l.includes('= Stood up from linux-1.'))).toBe(true);
    const mc = outcomes.find((o) => o.scenario === 'mc.logs_table' && o.variant === 'good')
      ?.result as RunResult;
    expect(mc).toMatchObject({
      model: 'claude-haiku-5-5',
      effort: 'xhigh',
      toolCalls: 3,
      turns: 2,
      stop: 'done',
    });
    // The running collect woke the agent with a [JOB DONE] turn.
    expect(
      mc.transcript.some((l) => /^T2 > \[JOB DONE\] \S+ collect oak_log ×10: \{"collected":10/.test(l)),
    ).toBe(true);
    const ask = outcomes.find((o) => o.scenario === 'mc.unreachable_ask' && o.variant === 'good')
      ?.result as RunResult;
    expect(ask).toMatchObject({ failedCalls: 1, toolCalls: 2 });
  }, 60_000);

  it('stops a run at the turn budget and keeps turns for the runs still to come', async () => {
    const budget = new TurnBudget(2, 2);
    const r = await runScenario(logsAndTable, {
      mode: 'replay',
      run: 1,
      factory: scriptedFactory(logsAndTable.replay.good),
      claude: BUNDLED,
      profile: WANDERING_PROFILE,
      budget,
      maxRunTurns: 3,
      turnTimeoutMs: 30_000,
      requireSubscription: false,
    });
    expect(r).toMatchObject({ turns: 1, stop: 'budget', success: false });
    expect(budget.remaining).toBe(1);
    expect(budget.startRun()).toBe(true);
    expect(budget.startRun()).toBe(false);
  });

  it('denies web tools on the offline eval PC and counts gate denials as failed calls', async () => {
    const r = await runScenario(selectScenarios('pc', ['pc.disk'])[0] as never, {
      mode: 'replay',
      run: 1,
      factory: scriptedFactory([
        [
          { tool: 'WebSearch', input: { query: 'disk usage' } },
          { tool: 'mcp__mc__mine', input: { block: 'stone', count: 1 } },
          { tool: 'mcp__pc__bash', input: { command: 'df -h' } },
          { text: 'Disk is 82% full.' },
        ],
      ]),
      claude: BUNDLED,
      profile: WANDERING_PROFILE,
      budget: new TurnBudget(5, 0),
      maxRunTurns: 1,
      turnTimeoutMs: 30_000,
      requireSubscription: false,
    });
    expect(r).toMatchObject({ toolCalls: 3, failedCalls: 2, deniedCalls: 2, success: true });
    expect(r.transcript.join('\n')).toMatch(/stand up first/);
  });
});

describe('metrics', () => {
  it('counts tool calls, failed results and tokens from the SDK stream', () => {
    const m = new StreamMetrics();
    const msg = (x: unknown) => m.onMessage(x as SDKMessage);
    msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude-haiku-5-5',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'mcp__mc__find', input: { what: 'oak_log' } },
        ],
      },
    });
    msg({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Error BAD_ARGS: x' }],
      },
    });
    msg({
      type: 'result',
      subtype: 'success',
      num_turns: 2,
      total_cost_usd: 0.01,
      usage: {},
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 100,
        },
      },
    });
    expect(m).toMatchObject({
      toolCalls: 1,
      failedCalls: 1,
      apiTurns: 2,
      inputTokens: 1010,
      outputTokens: 50,
      cacheReadTokens: 900,
      model: 'claude-haiku-5-5',
    });
    expect(m.transcript).toEqual(['  < Looking.', '  - mc.find {what:"oak_log"}', '    x Error BAD_ARGS: x']);
  });

  it('summarizes runs per scenario into a Markdown table', () => {
    const base = {
      suite: 'mc',
      mode: 'live',
      model: 'claude-haiku-5-5',
      effort: 'xhigh',
      checks: [],
      apiTurns: 3,
      deniedCalls: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      stop: 'done',
      finalText: '',
      transcript: [],
    } as const;
    const rows = summarize([
      {
        ...base,
        scenario: 'mc.iron',
        run: 1,
        success: true,
        turns: 2,
        toolCalls: 6,
        failedCalls: 1,
        inputTokens: 20_000,
        outputTokens: 900,
        wallMs: 30_000,
      },
      {
        ...base,
        scenario: 'mc.iron',
        run: 2,
        success: false,
        turns: 1,
        toolCalls: 4,
        failedCalls: 3,
        inputTokens: 10_000,
        outputTokens: 300,
        wallMs: 10_000,
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        scenario: 'mc.iron',
        model: 'haiku 5.5 / xhigh',
        runs: 2,
        successes: 1,
        toolCalls: 5,
        failedCalls: 2,
      }),
    ]);
    expect(formatTable(rows)).toContain(
      '| mc.iron | haiku 5.5 / xhigh | 1/2 | 5 | 2 | 15k | 600 | 20 | 1.5 | 0.020 |',
    );
  });

  it('formats [JOB DONE] wakes like the EventRouter', () => {
    const text = jobEndedText(
      'abc123',
      {
        jobId: 'j1',
        agentId: 'ada',
        status: 'done',
        durationMs: 5,
        result: { collected: 10, footer: 'HP 20/20' },
      },
      'collect oak_log ×10',
    );
    expect(text).toBe('[MV:abc123 JOB DONE] j1 collect oak_log ×10: {"collected":10}');
  });
});

describe('cli', () => {
  it('parses options and plans PC runs first, then mc round-robin', () => {
    const cli = parseCli(['--suite', 'all', '--mode', 'live', '--budget', '40']);
    expect(cli).toMatchObject({ suite: 'all', mode: 'live', budget: 40, runs: null });
    const plan = planLive(selectScenarios(cli.suite, []), cli.runs);
    expect(plan).toHaveLength(3 + 5 * 3);
    expect(plan.slice(0, 3).every((p) => p.scenario.suite === 'pc')).toBe(true);
    expect(plan.slice(3, 8).map((p) => p.run)).toEqual([1, 1, 1, 1, 1]);
    expect(plan.at(-1)?.run).toBe(3);
    expect(() => parseCli(['--mode', 'fast'])).toThrow(/replay or live/);
    expect(selectScenarios('mc', ['mc.iron']).map((s) => s.id)).toEqual(['mc.iron']);
  });

  it("reports (softly) when Jasper's chest was emptied", async () => {
    const world = darkSafe.world();
    expect(chestUntouched(world)).toMatchObject({ pass: true, required: false });
    const api = new SimSkillApi(world);
    await api.runSkill({
      agentId: 'ada',
      skill: 'container',
      args: { pos: HOUSE_CHEST, action: 'take', item: 'cobblestone' },
    });
    expect(chestUntouched(world)).toMatchObject({ pass: false, detail: 'now: 6 bread, 8 torch' });
  });

  it('the simulated player only obeys an instruction to get indoors', () => {
    expect(SHELTER_WORDS.test("Night's coming, let's get inside the house.")).toBe(true);
    expect(SHELTER_WORDS.test('Go home, Jasper!')).toBe(true);
    expect(SHELTER_WORDS.test('Building you a shelter.')).toBe(false);
    expect(SHELTER_WORDS.test('I will guard you.')).toBe(false);
  });
});
