/**
 * Question quality (a live run: "find me diamonds" → the agent asked "Use birch (Recommended)?" before a wooden
 * pickaxe). Interchangeable ingredients resolve by material family in the craft tree (the mod's `RecipeTree.gatherRef`,
 * mirrored by the simulated mod), the hints and the primer say an ingredient the player did not name is any kind, and
 * a kind the player named (or a recipe names) still stops and asks. Replayed through the real session wiring against
 * the simulated v2 mod.
 */

import { describe, expect, it } from 'vitest';
import type { Check, McScenario, McTrace, Replay, RunResult } from '../../../eval/harness/types.js';
import { runReplays } from '../../../eval/run.js';
import { anyWood, namedOak, stoneTools } from '../../../eval/scenarios/mc.js';
import { NS } from '../../../eval/sim/items.js';
import { buildWorld } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { gatherRefOf, planTree } from '../../../eval/sim/v2.js';
import { personaPrompt } from '../../../src/agents/prompts/persona.js';
import { renderPlan } from '../../../src/agents/tools/mcToolsV2.js';
import { familyOf } from '../../../src/agents/world/families.js';

const mc = (name: string) => `mcp__mc__${name}`;

async function play(
  scenario: McScenario,
  script: Replay,
): Promise<{ result: RunResult; trace: McTrace; check: (name: string) => Check | undefined }> {
  let trace: McTrace | null = null;
  const s: McScenario = {
    ...scenario,
    replayV2: { good: script },
    checks: (t) => {
      trace = t;
      return scenario.checks(t);
    },
  };
  const [out] = await runReplays([s], { tools: 'v2' });
  if (!out || !trace) throw new Error('the replay did not run');
  const result = out.result;
  return { result, trace, check: (name) => result.checks.find((c) => c.name === name) };
}

function texts(trace: McTrace, tool?: string): string[] {
  return trace.calls.filter((c) => !tool || c.tool === mc(tool)).map((c) => c.text);
}

/** The gather ref of the one missing raw material of `item` in `world`. */
function refFor(world: ReturnType<typeof buildWorld>, item: string, count = 1): string {
  const plan = planTree(world, `${NS}${item}`, count);
  expect(plan.missing.length, JSON.stringify(plan.missing)).toBeGreaterThan(0);
  return gatherRefOf(world, `${NS}${item}`, count, plan, plan.missing[0] as (typeof plan.missing)[number]);
}

describe('the craft tree resolves interchangeable ingredients by family (sim of RecipeTree.gatherRef)', () => {
  it('any log for planks, sticks, a table and wooden tools; any of the three stones for stone tools', () => {
    const birchOnly = buildWorld({ unreachableWoods: ['oak'] });
    expect(planTree(birchOnly, `${NS}wooden_pickaxe`, 1).missing[0]?.item).toBe('oak_log');
    expect(refFor(birchOnly, 'wooden_pickaxe')).toBe('#minecraft:logs');
    expect(refFor(birchOnly, 'crafting_table')).toBe('#minecraft:logs');
    expect(refFor(birchOnly, 'stick', 4)).toBe('#minecraft:logs');
    const sticks = buildWorld({ inventory: [[`${NS}stick`, 2]], rock: 'blackstone' });
    expect(planTree(sticks, `${NS}stone_pickaxe`, 1).missing[0]?.item).toBe('cobblestone');
    expect(refFor(sticks, 'stone_pickaxe')).toBe('#minecraft:stone_tool_materials');
  });

  it('a kind the recipe names stays that kind (oak planks, an oak door), and fuel is any log that burns already', () => {
    const birchOnly = buildWorld({ unreachableWoods: ['oak'] });
    expect(refFor(birchOnly, 'oak_planks', 4)).toBe('oak_log');
    expect(refFor(birchOnly, 'oak_door', 3)).toBe('oak_log');
    const ore = buildWorld({ inventory: [[`${NS}raw_iron`, 3]] });
    const plan = planTree(ore, `${NS}iron_ingot`, 3);
    const fuel = plan.missing.find((m) => m.item === '#minecraft:logs_that_burn');
    expect(fuel).toBeDefined();
    expect(gatherRefOf(ore, `${NS}iron_ingot`, 3, plan, fuel as (typeof plan.missing)[number])).toBe(
      '#minecraft:logs_that_burn',
    );
  });

  it('the sticks beside a kind the recipe names take any wood (a spruce fence: spruce planks, any sticks)', () => {
    // Before, the spruce stand-in went to the fence's own planks, the sticks still lacked oak, and oak looked pinned:
    // with no oak in reach the job stopped NO_NATURAL_SOURCE and the agent asked about the wood for the sticks.
    const world = buildWorld({ unreachableWoods: ['oak'] });
    const plan = planTree(world, `${NS}spruce_fence`, 3);
    const refs = Object.fromEntries(
      plan.missing.map((m) => [m.item, gatherRefOf(world, `${NS}spruce_fence`, 3, plan, m)]),
    );
    expect(refs).toEqual({ spruce_log: 'spruce_log', oak_log: '#minecraft:logs' });
  });

  it('a carried kind is used (birch logs make birch planks); the plan and its MISSING_INGREDIENTS name the family', async () => {
    const birch = buildWorld({ inventory: [[`${NS}birch_log`, 2]], unreachableWoods: ['oak'] });
    const plan = planTree(birch, `${NS}wooden_pickaxe`, 1);
    expect(plan.missing).toEqual([]);
    expect(plan.steps.some((s) => s.item === `${NS}birch_planks`)).toBe(true);
    const api = new SimSkillApi(buildWorld({ unreachableWoods: ['oak'] }), { mod: 'v2' });
    const recipe = await api.obsQuery('ada', 'recipe', { item: 'wooden_pickaxe', count: 1, tree: true });
    expect(recipe.missing).toEqual([expect.objectContaining({ item: 'oak_log', any: '#minecraft:logs' })]);
    const short = await api.runSkill({
      agentId: 'ada',
      skill: 'craft',
      args: { item: 'wooden_pickaxe', count: 1, tree: true },
      waitMs: 60_000,
      replace: true,
    });
    expect(short.error?.code).toBe('MISSING_INGREDIENTS');
    expect(short.error?.msg).toContain('oak_log 2 (any #minecraft:logs)');
    // craft{plan:true} shows it to the agent.
    expect(renderPlan('wooden_pickaxe', 1, recipe, { here: null, playerName: 'Jordan' })).toContain(
      'missing raw: oak_log 2 (or any #logs)',
    );
  });
});

describe('replays: no question for an ingredient, a question for what the player named', () => {
  it('craft a wooden pickaxe with only birch in reach: one call, birch, zero questions', async () => {
    const { result, trace, check } = await play(anyWood, anyWood.replayV2?.good as Replay);
    expect(result.success).toBe(true);
    expect(check('asked_nothing')).toMatchObject({ pass: true });
    expect(trace.world.agent.inventory.get(`${NS}wooden_pickaxe`)).toBe(1);
    expect(trace.world.broken.filter((b) => b.block.id === `${NS}birch_log`).length).toBeGreaterThan(0);
    expect(trace.world.broken.some((b) => b.block.id === `${NS}oak_log`)).toBe(false);
    expect(result.transcript.some((l) => /^T2 > \[JOB DONE\] .*gathered birch_log/.test(l))).toBe(true);
  }, 60_000);

  it('the live run\'s pointless "Use birch (Recommended)?" fails the scenario', async () => {
    const { result, check } = await play(anyWood, anyWood.replayV2?.bad as Replay);
    expect(result.success).toBe(false);
    expect(check('asked_nothing')).toMatchObject({
      pass: false,
      detail: 'AskUserQuestion: Use birch for the pickaxe?',
    });
  }, 60_000);

  it('make stone tools with only blackstone and deepslate: any of them, no question', async () => {
    const { result, trace, check } = await play(stoneTools, stoneTools.replayV2?.good as Replay);
    expect(result.success).toBe(true);
    expect(check('asked_nothing')).toMatchObject({ pass: true });
    expect(check('made_stone_tools')).toMatchObject({ pass: true, detail: 'stone pickaxe, axe, sword' });
    // The family's natural sources: deepslate (cobbled deepslate) and blackstone; there is no plain stone.
    const broken = new Set(trace.world.broken.map((b) => b.block.id));
    expect([...broken].every((id) => id === `${NS}deepslate` || id === `${NS}blackstone`)).toBe(true);
  }, 60_000);

  it('gather of one kind that is out of reach says: ask if the player named it, else gather the family', async () => {
    const { result, trace } = await play(stoneTools, [
      [
        { tool: mc('gather'), input: { item: 'cobblestone', count: 3 } },
        { tool: mc('gather'), input: { item: '#stone_tool_materials', count: 3 } },
        { tool: mc('job'), input: { action: 'wait', seconds: 120 } },
        { tool: mc('craft'), input: { item: 'stone_pickaxe' } },
        { tool: mc('craft'), input: { item: 'stone_axe', gather_missing: true } },
        { tool: mc('job'), input: { action: 'wait', seconds: 120 } },
        { text: 'Stone pickaxe and axe, from the deepslate.' },
      ],
    ]);
    const [miss, family] = texts(trace, 'gather');
    expect(miss).toMatch(/^failed: gather cobblestone 0\/3 \| NO_NATURAL_SOURCE/);
    expect(miss).toContain(
      'next: if Jordan named cobblestone: ask; else gather{"item":"#stone_tool_materials","count":3} (an ingredient: any kind, no question)',
    );
    expect(family).not.toMatch(/^failed/);
    expect(result.success).toBe(true);
  }, 60_000);

  it('collect 10 oak logs for my build with only birch in reach: asks, and no birch is taken', async () => {
    const { result, trace, check } = await play(namedOak, namedOak.replayV2?.good as Replay);
    expect(result.success).toBe(true);
    expect(texts(trace, 'gather')[0]).toMatch(/^failed: gather oak_log 0\/10 \| NO_NATURAL_SOURCE/);
    expect(check('asked_player')).toMatchObject({ pass: true });
    expect(check('no_birch_instead')).toMatchObject({ pass: true });
    const bad = await play(namedOak, namedOak.replayV2?.bad as Replay);
    expect(bad.check('no_birch_instead')).toMatchObject({ pass: false });
  }, 60_000);

  it('a craft whose recipe names the kind (oak planks) stops NO_NATURAL_SOURCE with no family offered', async () => {
    const { trace } = await play(namedOak, [
      [
        { tool: mc('craft'), input: { item: 'oak_planks', count: 4, gather_missing: true } },
        { tool: mc('job'), input: { action: 'wait', seconds: 120 } },
        { text: 'No oak in reach.' },
      ],
    ]);
    const failure = [...texts(trace, 'craft'), ...texts(trace, 'job')].join('\n');
    expect(failure).toContain('NO_NATURAL_SOURCE');
    expect(failure).not.toContain('#logs');
    expect(failure).toContain('next: ask Jordan (AskUserQuestion');
    expect(trace.world.broken.some((b) => b.block.id === `${NS}birch_log`)).toBe(false);
  }, 60_000);
});

describe('the rule in the prompts', () => {
  const persona = (mcTools: 'v1' | 'v2', session: 'body' | 'desk') =>
    personaPrompt({
      name: 'Ada',
      handle: 'ada',
      role: 'ceo',
      ceo: true,
      playerName: 'Jordan',
      nonce: 'abcdef',
      mcTools,
      session,
    });

  it('every persona (body and desk, v1 and v2) asks only when the answer matters to the player', () => {
    for (const v of ['v1', 'v2'] as const)
      for (const s of ['body', 'desk'] as const) {
        const p = persona(v, s);
        expect(p).toContain(
          '- Ask Jordan only when the answer matters to them: what they named, their builds, files and things, safety, a long detour, rare materials. Otherwise pick the sensible default, act, and mention it in passing ("using birch").',
        );
        // The rules that protect the player stay.
        expect(p).toContain("Decisions that are Jordan's go through AskUserQuestion.");
      }
  });

  it("the body's primer keeps the hard stops for what the player named and frees the ingredients", () => {
    for (const v of ['v1', 'v2'] as const) {
      const p = persona(v, 'body');
      expect(p).toContain('Never break, replace or take blocks of the Base or anything Jordan built');
      expect(p).toContain('If what Jordan named (an item, or a kind: "oak logs") is missing or out of reach');
      expect(p).toContain('Ingredients Jordan did not name can be any kind');
      expect(p).toContain('PROTECTED, and NO_NATURAL_SOURCE for what Jordan named, are hard stops');
      expect(p).toContain('Never offer Base blocks as an option.');
    }
    expect(persona('v2', 'body')).toContain('mcp__mc__craft takes the nearest kind, no question.');
  });

  it("Node's families match the mod's (logs and stems, the three stones, coal or charcoal, wool)", () => {
    expect(familyOf('oak_log')).toBe('#logs');
    expect(familyOf('minecraft:crimson_stem')).toBe('#logs');
    expect(familyOf('stripped_oak_log')).toBeNull();
    expect(familyOf('blackstone')).toBe('#stone_tool_materials');
    expect(familyOf('charcoal')).toBe('#coals');
    expect(familyOf('red_wool')).toBe('#wool');
    expect(familyOf('#logs')).toBeNull();
    expect(familyOf('raw_iron')).toBeNull();
  });
});
