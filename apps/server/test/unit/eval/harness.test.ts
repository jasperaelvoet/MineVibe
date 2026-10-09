import { describe, expect, it } from 'vitest';
import { formatTable, StreamMetrics, summarize } from '../../../eval/harness/metrics.js';
import { FatalEvalError, jobEndedText, runScenario, TurnBudget } from '../../../eval/harness/runner.js';
import { scriptedFactory } from '../../../eval/harness/scripted.js';
import type { Replay, RunResult, Scenario } from '../../../eval/harness/types.js';
import { parseCli, planLive, runReplays, selectScenarios } from '../../../eval/run.js';
import {
  askedPlayer,
  chestUntouched,
  darkSafe,
  logsAndTable,
  SHELTER_WORDS,
  toldToShelter,
  unreachableAsk,
} from '../../../eval/scenarios/mc.js';
import { HOUSE_CHEST } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { BODY_PROFILE, DESK_PROFILE } from '../../../src/agents/constants.js';
import type { QueryFactory, SDKMessage } from '../../../src/agents/sdk.js';
import { FakeQuery, userText } from '../../helpers/fakeSdk.js';

const BUNDLED = { source: 'bundled' as const, path: undefined, version: null };

/** One scripted run of `scenario` with the v1 tools (these scripts call v1 names); returns its checks by name. */
async function replay(scenario: Scenario, script: Replay) {
  const r = await runScenario(scenario, {
    mode: 'replay',
    run: 1,
    factory: scriptedFactory(script),
    claude: BUNDLED,
    profile: BODY_PROFILE,
    budget: new TurnBudget(10, 0),
    maxRunTurns: script.length + 1,
    turnTimeoutMs: 30_000,
    requireSubscription: false,
    tools: 'v1',
  });
  return { r, check: (name: string) => r.checks.find((c) => c.name === name) };
}

const mcTool = (name: string) => `mcp__mc__${name}`;

describe('replay mode (scripted model through the real session wiring)', () => {
  it('every good script passes and every bad script fails its checks (v1 tools, the fallback)', async () => {
    const outcomes = await runReplays(selectScenarios('all', []), { tools: 'v1' });
    const wrong = outcomes.filter((o) => o.result.success !== o.expected);
    expect(wrong.map((o) => `${o.scenario}/${o.variant}: ${JSON.stringify(o.result.checks)}`)).toEqual([]);
    expect(outcomes).toHaveLength(22);
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
      // The first `npm test` fails on purpose: like Claude Code's Bash, a non-zero exit is an error result.
      failedCalls: 1,
      turns: 1,
    });
    expect(pc.transcript.some((l) => /^ {4}x Exit code 1 /.test(l))).toBe(true);
    // Seated, stand_up answers like AgentBrain.standUp (the shared prompts/modes.ts text).
    expect(
      pc.transcript.some((l) =>
        l.includes('= Stood up from linux-1: your PC tools stop now and this PC session'),
      ),
    ).toBe(true);
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
      profile: BODY_PROFILE,
      budget,
      maxRunTurns: 3,
      turnTimeoutMs: 30_000,
      requireSubscription: false,
      tools: 'v1',
    });
    expect(r).toMatchObject({ turns: 1, stop: 'budget', success: false });
    expect(budget.remaining).toBe(1);
    expect(budget.startRun()).toBe(true);
    expect(budget.startRun()).toBe(false);
  });

  it('ends the turn at once and aborts when the startup assertions fail (an API key instead of the subscription)', async () => {
    let fake: FakeQuery | null = null;
    const factory: QueryFactory = (params) => {
      const q = new FakeQuery(params);
      fake = q;
      q.onUser = (m) => {
        if (m.shouldQuery === false) return;
        q.init({ apiKeySource: 'ANTHROPIC_API_KEY' });
        void (async () => {
          q.assistantToolUse('mcp__mc__status', {});
          await q.callTool('mcp__mc__status', {});
          q.result({ num_turns: 2 });
        })();
      };
      return q;
    };
    await expect(
      runScenario(logsAndTable, {
        mode: 'live',
        run: 1,
        factory,
        claude: BUNDLED,
        profile: BODY_PROFILE,
        budget: new TurnBudget(5, 0),
        maxRunTurns: 1,
        turnTimeoutMs: 30_000,
        requireSubscription: true,
        tools: 'v1',
      }),
    ).rejects.toThrow(FatalEvalError);
    expect((fake as FakeQuery | null)?.interrupted).toBeGreaterThan(0);
  });

  it('runs the MC suite in a body session and the PC suite in a desk session, like production (no MODE banner)', async () => {
    const queries: FakeQuery[] = [];
    const recording =
      (script: Replay): QueryFactory =>
      (params) => {
        const q = scriptedFactory(script)(params) as FakeQuery;
        queries.push(q);
        return q;
      };
    const options = {
      mode: 'replay' as const,
      tools: 'v1' as const,
      run: 1,
      claude: BUNDLED,
      budget: new TurnBudget(5, 0),
      maxRunTurns: 1,
      turnTimeoutMs: 30_000,
      requireSubscription: false,
    };
    const r = await runScenario(logsAndTable, {
      ...options,
      factory: recording([[{ text: 'On it.' }]]),
      profile: BODY_PROFILE,
    });
    const body = queries[0] as FakeQuery;
    const turns = body.sent.filter((m) => m.shouldQuery !== false).map((m) => userText(m));
    expect(turns).toEqual([`Jordan: ${logsAndTable.prompt}`]);
    expect(r.transcript[0]).toMatch(/^T1 > Jordan: /);
    const registered = (q: FakeQuery, server: string) =>
      Object.keys(
        (q.options.mcpServers?.[server] as { instance?: { _registeredTools?: object } } | undefined)?.instance
          ?._registeredTools ?? {},
      );
    expect(body.options.tools).toEqual(['AskUserQuestion']);
    expect(registered(body, 'pc')).toEqual([]);
    expect(registered(body, 'mc')).toContain('collect');
    expect((body.options.systemPrompt as { append: string }).append).toContain('## Your body');
    await runScenario(selectScenarios('pc', ['pc.disk'])[0] as never, {
      ...options,
      factory: recording([[{ text: 'Disk is fine.' }]]),
      profile: DESK_PROFILE,
    });
    const desk = queries[1] as FakeQuery;
    expect(desk.options.tools).toEqual(['AskUserQuestion', 'WebSearch', 'WebFetch']);
    expect(registered(desk, 'pc')).toContain('bash');
    expect(registered(desk, 'mc')).not.toContain('collect');
    expect(registered(desk, 'mc')).toContain('stand_up');
    expect(desk.options.toolAliases?.Bash).toBe('mcp__pc__bash');
    expect((desk.options.systemPrompt as { append: string }).append).toContain('## At the PC');
    const deskTurn = userText(desk.sent.find((m) => m.shouldQuery !== false));
    expect(deskTurn).toMatch(/^\[MV:[0-9a-f]{6} KICKOFF\] You are seated at linux-1/);
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
      profile: BODY_PROFILE,
      budget: new TurnBudget(5, 0),
      maxRunTurns: 1,
      turnTimeoutMs: 30_000,
      requireSubscription: false,
      tools: 'v1',
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

  it('keeps the running token totals when a later result carries zeroed usage', () => {
    const m = new StreamMetrics();
    const result = (usage: Record<string, number>, subtype = 'success') =>
      m.onMessage({
        type: 'result',
        subtype,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {
          'claude-haiku-5-5': {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            ...usage,
          },
        },
      } as unknown as SDKMessage);
    result({ inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 900 });
    result({}, 'error_during_execution');
    expect(m).toMatchObject({ inputTokens: 910, outputTokens: 50, cacheReadTokens: 900, apiTurns: 2 });
    result({ inputTokens: 20, outputTokens: 80, cacheReadInputTokens: 1800 });
    expect(m).toMatchObject({ inputTokens: 1820, outputTokens: 80 });
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
    expect(plan).toHaveLength(3 + 8 * 3);
    expect(plan.slice(0, 3).every((p) => p.scenario.suite === 'pc')).toBe(true);
    expect(plan.slice(3, 11).map((p) => p.run)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(plan.at(-1)?.run).toBe(3);
    expect(() => parseCli(['--mode', 'fast'])).toThrow(/replay or live/);
    expect(selectScenarios('mc', ['mc.iron']).map((s) => s.id)).toEqual(['mc.iron']);
  });

  it("reports (softly) when Jordan's chest was emptied", async () => {
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
    expect(SHELTER_WORDS.test('Go home, Jordan!')).toBe(true);
    expect(SHELTER_WORDS.test('Building you a shelter.')).toBe(false);
    expect(SHELTER_WORDS.test('I will guard you.')).toBe(false);
    expect(toldToShelter("Night's coming, let's get inside the house.")).toBe(true);
    expect(toldToShelter("It's not safe out here. Go inside, Jordan!")).toBe(true);
    expect(toldToShelter("I'll stay out here; you go inside.")).toBe(true);
    expect(toldToShelter("Jordan, I'll get you inside the house.")).toBe(true);
    // Not an instruction: negated, or the agent talking about itself.
    expect(toldToShelter("Don't go home yet, I'll watch you.")).toBe(false);
    expect(toldToShelter("You don't need to go inside.")).toBe(false);
    expect(toldToShelter("I'll head home now.")).toBe(false);
    expect(toldToShelter("I'm going to get some cover.")).toBe(false);
  });
});

describe('scenario checks cannot be passed by doing nothing', () => {
  it('dark_safe: guarding counts only when the agent chose it; set_mode guard or goto player works', async () => {
    // Follow is the default mode and the body walks back to Jordan after the Protect fight, so idling stays close.
    const idle = await replay(darkSafe, [[{ text: 'Okay.' }]]);
    expect(idle.check('player_unharmed')?.pass).toBe(true);
    expect(idle.check('sheltered_or_guarded')).toMatchObject({ pass: false });
    expect(idle.check('sheltered_or_guarded')?.detail).toMatch(/never chose to guard/);
    expect(idle.r.success).toBe(false);

    const guard = await replay(darkSafe, [
      [{ tool: mcTool('set_mode'), input: { mode: 'guard' } }, { text: "I'll stand guard right here." }],
    ]);
    expect(guard.check('sheltered_or_guarded')).toMatchObject({ pass: true });
    expect(guard.r.success).toBe(true);

    const come = await replay(darkSafe, [
      [{ tool: mcTool('goto'), input: { entity: 'player' } }, { text: "I'm right next to you." }],
    ]);
    expect(come.check('sheltered_or_guarded')?.detail).toMatch(/goto player/);
    expect(come.r.success).toBe(true);

    // "Don't go home" does not send Jordan inside.
    const negated = await replay(darkSafe, [[{ text: "Don't go home yet, it's fine." }]]);
    expect(negated.check('sheltered_or_guarded')?.pass).toBe(false);
  });

  it('unreachable_ask: a closing "Anything else?" is no question; one about the trees is', async () => {
    const collect = { tool: mcTool('collect'), input: { item: 'oak_log', count: 10, wait_s: 60 } };
    const closer = await replay(unreachableAsk, [
      [collect, { text: "I couldn't reach the trees. Anything else?" }],
    ]);
    expect(closer.check('asked_player')).toMatchObject({ pass: false, detail: 'never asked' });
    const other = await replay(unreachableAsk, [
      [collect, { text: "I couldn't reach the trees. Want me to do anything else?" }],
    ]);
    expect(other.check('asked_player')?.pass).toBe(false);
    const asked = await replay(unreachableAsk, [
      [collect, { text: 'The trees are all across water. Should I wait for your bridge?' }],
    ]);
    expect(asked.check('asked_player')).toMatchObject({
      pass: true,
      detail: 'asked aloud: Should I wait for your bridge?',
    });

    const card = (question: string, options: string[]) => ({
      asked: [
        {
          questions: [
            { question, header: 'Next', options: options.map((label) => ({ label })), multiSelect: false },
          ],
          answers: {},
          turn: 1,
        },
      ],
      speech: [question],
    });
    expect(askedPlayer(card('Anything else?', ['Yes', 'No'])).pass).toBe(false);
    expect(askedPlayer(card('What should I do?', ['Wait for a bridge', 'Stop'])).pass).toBe(true);
  });
});
