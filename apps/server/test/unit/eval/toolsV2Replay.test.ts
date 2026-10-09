import { MOD_CAPS } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import type { RunResult, Scenario } from '../../../eval/harness/types.js';
import { parseCli, runReplays, selectScenarios } from '../../../eval/run.js';
import { buildWorld, HOUSE, HOUSE_CHEST } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { planTree } from '../../../eval/sim/v2.js';

const get = (outcomes: Awaited<ReturnType<typeof runReplays>>, id: string, variant: 'good' | 'bad') =>
  outcomes.find((o) => o.scenario === id && o.variant === variant)?.result as RunResult;

describe('eval with the v2 tools (tools-v2-mc.md §14)', () => {
  it('every v2 good script passes and every bad one fails; the incident takes one call', async () => {
    const outcomes = await runReplays(selectScenarios('mc', []), { tools: 'v2' });
    const wrong = outcomes.filter((o) => o.result.success !== o.expected);
    expect(wrong.map((o) => `${o.scenario}/${o.variant}: ${JSON.stringify(o.result.checks)}`)).toEqual([]);
    expect(outcomes).toHaveLength(16);
    const s1 = get(outcomes, 'mc.logs_table', 'good');
    expect(s1).toMatchObject({ tools: 'v2', toolCalls: 1, failedCalls: 0, turns: 2, stop: 'done' });
    expect(s1.checks.find((c) => c.name === 'house_intact')?.pass).toBe(true);
    expect(
      s1.transcript.some((l) =>
        /^T2 > \[JOB DONE\] \S+ do 2\/2 steps in \d+s \| gather oak_log 10\/10 \| from 2 oak trees near .* \| craft crafting_table 1\/1/.test(
          l,
        ),
      ),
    ).toBe(true);
    // Smelting goes through craft: one call gathers the raw iron and fuel, and smelts.
    expect(get(outcomes, 'mc.iron', 'good')).toMatchObject({ toolCalls: 1, failedCalls: 0 });
    // Without reachable trees gather stops with NO_NATURAL_SOURCE and the candidates; the agent asks.
    const ask = get(outcomes, 'mc.unreachable_ask', 'good');
    expect(ask.transcript.some((l) => l.includes('NO_NATURAL_SOURCE') && l.includes('unreachable'))).toBe(
      true,
    );
  }, 60_000);

  it('the v2 tools on the v1 mod fall back (Node runs do; single-level craft) and still never touch the house', async () => {
    const outcomes = await runReplays(selectScenarios('mc', ['mc.logs_table']), { tools: 'v2', mod: 'v1' });
    const good = get(outcomes, 'mc.logs_table', 'good');
    expect(good.checks.find((c) => c.name === 'house_intact')?.pass).toBe(true);
    expect(good.toolCalls).toBe(1);
  }, 60_000);

  it('a job its job{wait} already reported wakes nobody after the turn (AgentBrain parity)', async () => {
    const [logs] = selectScenarios('mc', ['mc.logs_table']);
    const steps = [
      { tool: 'gather', args: { item: 'oak_log', count: 10 } },
      { tool: 'craft', args: { item: 'crafting_table' } },
    ];
    const waited: Scenario = {
      ...(logs as Scenario),
      replayV2: {
        good: [
          [
            { tool: 'mcp__mc__do', input: { steps } },
            { tool: 'mcp__mc__job', input: { action: 'wait', seconds: 120 } },
            { text: 'Got 10 oak logs and made a crafting table.' },
          ],
          // Only a (wrong) wake would play this turn.
          [{ text: 'Woken again.' }],
        ],
      },
    };
    const [run] = await runReplays([waited], { tools: 'v2' });
    expect(run?.result).toMatchObject({ success: true, toolCalls: 2, failedCalls: 0, turns: 1 });
    expect(run?.result.transcript.some((l) => l.startsWith('T2 '))).toBe(false);
    expect(run?.result.transcript.some((l) => /= done: do 2\/2 steps/.test(l))).toBe(true);
  }, 60_000);

  it('--tools and --mod select the tool set and the simulated mod (default v2, like production)', () => {
    expect(parseCli([])).toMatchObject({ tools: 'v2', mod: 'v2' });
    expect(parseCli(['--tools', 'v1'])).toMatchObject({ tools: 'v1', mod: 'v1' });
    expect(parseCli(['--tools', 'v2'])).toMatchObject({ tools: 'v2', mod: 'v2' });
    expect(parseCli(['--tools', 'v2', '--mod', 'v1'])).toMatchObject({ tools: 'v2', mod: 'v1' });
    expect(() => parseCli(['--tools', 'v3'])).toThrow(/--tools/);
  });

  it('the simulated v2 mod: caps, natural-only gathering, PROTECTED, the recipe tree, the nearest chest', async () => {
    const world = buildWorld({ inventory: [['minecraft:oak_log', 3]] });
    const api = new SimSkillApi(world, { mod: 'v2' });
    expect([...(api.caps?.() ?? [])].sort()).toEqual(Object.values(MOD_CAPS).sort());
    expect([...new SimSkillApi(buildWorld()).caps()]).toEqual([]);
    // The house is player-built: digging into it is PROTECTED, nothing breaks.
    const dig = await api.runSkill({
      agentId: 'ada',
      skill: 'dig',
      args: { from: { x: 3, y: 64, z: 3 }, to: { x: 3, y: 64, z: 3 } },
      waitMs: 5_000,
      replace: true,
    });
    expect(dig).toMatchObject({ status: 'failed', error: { code: 'PROTECTED' } });
    expect(world.damage(HOUSE)).toHaveLength(0);
    // #logs gathers natural trees only.
    const logs = await api.runSkill({
      agentId: 'ada',
      skill: 'collect',
      args: { item: '#minecraft:logs', count: 4 },
      waitMs: 120_000,
      replace: true,
    });
    expect(logs.status).toBe('done');
    expect(world.damage(HOUSE)).toHaveLength(0);
    expect((logs.result?.sources as { kind: string }[] | undefined)?.[0]?.kind).toBe('tree');
    // A wooden pickaxe without a table nearby... the house has one: no table is planned.
    const plan = planTree(world, 'minecraft:wooden_pickaxe', 1);
    expect(plan.missing).toEqual([]);
    expect(plan.steps.map((s) => s.item)).toEqual([
      'minecraft:oak_planks',
      'minecraft:oak_planks',
      'minecraft:stick',
      'minecraft:wooden_pickaxe',
    ]);
    // The nearest chest when no container is named.
    const list = await api.runSkill({
      agentId: 'ada',
      skill: 'container',
      args: { action: 'list' },
      waitMs: 60_000,
      replace: true,
    });
    expect(list).toMatchObject({ status: 'done', result: { pos: HOUSE_CHEST } });
  });
});
