import { MOD_CAPS, type SkillName, type SkillRunResult } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import { categoryOf, MC_TOOLS_V2 } from '../../../src/agents/tools/catalog.js';
import { hintFor, type JobMeta } from '../../../src/agents/tools/format.js';
import { JobRegistry } from '../../../src/agents/tools/jobs.js';
import { createMcServer, type McHost } from '../../../src/agents/tools/mcServer.js';
import {
  MC_V2_DESCRIPTIONS,
  MC_V2_INSTRUCTIONS,
  MC_V2_TOOL_NAMES,
} from '../../../src/agents/tools/mcToolsV2.js';
import { ApiError, agentActor } from '../../../src/contracts/common.js';
import { FakeOrgApi } from '../../../src/contracts/FakeOrgApi.js';
import { FakeSkillApi } from '../../../src/contracts/FakeSkillApi.js';
import { withSequenceFallback } from '../../../src/contracts/SequenceFallback.js';
import { type SkillRunRequest, validateSkillArgs } from '../../../src/contracts/SkillApi.js';
import { listTools, toolListChars } from '../../helpers/listTools.js';

type Registered = Record<
  string,
  {
    inputSchema?: { safeParse(v: unknown): { success: boolean; data?: unknown } };
    handler: (a: unknown, e: unknown) => Promise<unknown>;
  }
>;

function registry(server: { instance: unknown }): Registered {
  return (server.instance as { _registeredTools: Registered })._registeredTools;
}

async function call(reg: Registered, name: string, args: Record<string, unknown>) {
  const tool = reg[name];
  if (!tool) throw new Error(`no tool ${name}`);
  const parsed = tool.inputSchema ? tool.inputSchema.safeParse(args) : { success: true, data: args };
  if (!parsed.success) return { invalid: true, text: '', isError: true };
  const res = (await tool.handler(parsed.data, {})) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    invalid: false,
    text: res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    isError: res.isError === true,
  };
}

const FOOTER = 'HP 20/20 food 20 | day 1 06:15 | 5 66 -5 overworld | idle (follow) | wheat_seeds';
const ALL_CAPS = Object.values(MOD_CAPS);

function v2Host(over: Partial<McHost> = {}, caps: readonly string[] = ALL_CAPS) {
  const fake = new FakeSkillApi();
  fake.capSet = new Set(caps);
  const skills = withSequenceFallback(fake);
  const org = new FakeOrgApi({
    now: () => 1_000,
    clockTime: () => 30_000,
    positionOf: () => ({ pos: { x: 5, y: 66, z: -5 }, dim: 'minecraft:overworld' }),
    isCeo: (agentId) => agentId === 'ada-1',
    playerName: () => 'Jordan',
  });
  const log: string[] = [];
  const jobs = new JobRegistry();
  const host: McHost = {
    agentId: 'ada-1',
    skills,
    org,
    actor: () => agentActor('ada-1', true),
    playerName: () => 'Jordan',
    footer: () => FOOTER,
    here: () => ({ pos: { x: 5, y: 66, z: -5 }, dim: 'minecraft:overworld' }),
    clockTime: () => 30_000,
    trackJob: (jobId, label) => log.push(`track:${jobId}:${label}`),
    say: (text) => log.push(`say:${text}`),
    tell: async (to, text) => `Told ${to}: ${text}`,
    remember: async () => 'Remembered.',
    requestHire: async (r) => `hire ${r.role}`,
    sitAtPc: async (r) => `sit ${r.pcId} ${r.waitMs}`,
    standUp: async () => 'Stood up.',
    wait: async (ms) => `waited ${ms}`,
    taskReported: (r) => log.push(`report:${r.eventId}:${r.status}`),
    jobs,
    crewMember: (ref) =>
      ref.replace(/^@/, '').toLowerCase() === 'bram'
        ? { agentId: 'bram1a2b', name: 'Bram', handle: 'bram' }
        : null,
    ...over,
  };
  return { host, fake, skills, org, log, jobs, reg: registry(createMcServer(host, 'v2')) };
}

describe('v2 mc tool list (tools-v2-mc.md §3, §13)', () => {
  it('defines exactly the 20 catalog tools, in list order, with the spec descriptions and the playbook', async () => {
    const { host } = v2Host();
    const { tools, instructions } = await listTools(createMcServer(host, 'v2'));
    expect(tools.map((t) => t.name)).toEqual([...MC_V2_TOOL_NAMES]);
    expect(Object.keys(MC_TOOLS_V2).sort()).toEqual([...MC_V2_TOOL_NAMES].sort());
    for (const t of tools)
      expect(t.description).toBe(MC_V2_DESCRIPTIONS[t.name as keyof typeof MC_V2_DESCRIPTIONS]);
    expect(instructions).toBe(MC_V2_INSTRUCTIONS);
    expect(instructions).toContain(
      'PROTECTED, and NO_NATURAL_SOURCE for what the player named, are hard stops: ask the player, never substitute. Ingredients they did not name can be any kind.',
    );
  });

  it('every example in a description is a valid call of that tool', () => {
    const { reg } = v2Host();
    for (const name of MC_V2_TOOL_NAMES) {
      const m = /\nExample: (\{.*\})$/.exec(MC_V2_DESCRIPTIONS[name]);
      if (name === 'stand_up') {
        expect(m).toBeNull();
        continue;
      }
      expect(m, name).not.toBeNull();
      const parsed = reg[name]?.inputSchema?.safeParse(JSON.parse(m?.[1] ?? '{}'));
      expect(parsed?.success, name).toBe(true);
    }
  });

  it('is under 60% of v1 (≈16k chars, ≈4k tokens): no wait_s, no int32 position objects', async () => {
    const { host } = v2Host();
    const v2 = (await listTools(createMcServer(host, 'v2'))).tools;
    const v1 = (await listTools(createMcServer(host, 'v1'))).tools;
    const v2Chars = toolListChars('mc', v2);
    const v1Chars = toolListChars('mc', v1);
    expect(v2.length).toBe(20);
    expect(v1.length).toBe(54);
    expect(v2Chars).toBeLessThanOrEqual(16_500);
    expect(v2Chars / v1Chars).toBeLessThan(0.6);
    const schemas = JSON.stringify(v2.map((t) => t.inputSchema));
    expect(schemas).not.toContain('wait_s');
    expect(schemas).not.toContain('2147483647');
  });

  it('reads are read-only (parallel-safe); world changers are marked destructive; everything is always loaded', async () => {
    const { host } = v2Host();
    const { tools } = await listTools(createMcServer(host, 'v2'));
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.observe?.annotations?.readOnlyHint).toBe(true);
    expect(byName.find?.annotations?.readOnlyHint).toBe(true);
    for (const n of ['gather', 'build', 'use', 'do'])
      expect(byName[n]?.annotations?.destructiveHint, n).toBe(true);
    for (const t of tools) expect(t._meta?.['anthropic/alwaysLoad'], t.name).toBe(true);
  });

  it('schema caps agree with the mod (observe radius ≤ 48 with the cap, find radius ≤ 64, limit ≤ 10)', () => {
    const { reg } = v2Host();
    expect(reg.observe?.inputSchema?.safeParse({ radius: 48 }).success).toBe(true);
    expect(reg.observe?.inputSchema?.safeParse({ radius: 64 }).success).toBe(false);
    expect(reg.find?.inputSchema?.safeParse({ target: 'oak_log', radius: 64, limit: 10 }).success).toBe(true);
    expect(reg.find?.inputSchema?.safeParse({ target: 'oak_log', radius: 65 }).success).toBe(false);
    expect(reg.find?.inputSchema?.safeParse({ target: 'oak_log', limit: 11 }).success).toBe(false);
    expect(reg.gather?.inputSchema?.safeParse({ item: 'oak_log', count: 641 }).success).toBe(false);
  });
});

describe('v2 gate categories (§9)', () => {
  it('action enums pick their gate from the input', () => {
    expect(categoryOf('craft', { item: 'stick', plan: true }, 'v2')).toBe('always');
    expect(categoryOf('craft', { item: 'stick' }, 'v2')).toBe('world');
    expect(categoryOf('items', { action: 'eat' }, 'v2')).toBe('always');
    expect(categoryOf('items', { action: 'equip' }, 'v2')).toBe('always');
    expect(categoryOf('items', { action: 'give' }, 'v2')).toBe('world');
    expect(categoryOf('menu', { action: 'state' }, 'v2')).toBe('always');
    expect(categoryOf('menu', { action: 'click' }, 'v2')).toBe('world');
    expect(categoryOf('codex', { action: 'read' }, 'v2')).toBe('codex_read');
    expect(categoryOf('codex', { action: 'append' }, 'v2')).toBe('codex_write');
    expect(categoryOf('mine', {}, 'v2')).toBeNull();
    expect(categoryOf('gather', {}, 'v1')).toBeNull();
    expect(categoryOf('mine', {}, 'v1')).toBe('world');
  });
});

describe('v2 world tools (§5)', () => {
  it('gather: one job, natural sources end to end; results are text with a footer', async () => {
    const { reg, fake, jobs } = v2Host();
    fake.skillHandler = () => ({
      status: 'done',
      result: {
        item: 'minecraft:oak_log',
        got: 10,
        have: 10,
        sources: [{ kind: 'tree', what: 'oak', pos: { x: 6, y: 66, z: 24 }, n: 10 }],
        footer: FOOTER,
      },
    });
    const res = await call(reg, 'gather', { item: 'oak_log', count: 10 });
    expect(fake.runs[0]).toMatchObject({
      skill: 'collect',
      args: { item: 'oak_log', count: 10, radius: 48, make_tools: true },
      waitMs: 20_000,
      replace: true,
    });
    expect(res.text).toBe(
      'done: gather oak_log 10/10 | from 1 oak tree near 6 66 24 | have oak_log 10\n· HP 20/20 food 20 | day 1 06:15 | 5 66 -5 | idle (follow) | wheat_seeds',
    );
    expect(jobs.recent()[0]?.status).toBe('done');
  });

  it('gather on an older mod (no collect.gather cap) sends plain v1 collect args', async () => {
    const { reg, fake } = v2Host({}, []);
    await call(reg, 'gather', { item: 'oak_log', count: 3, near: '9 67 -12' });
    expect(fake.runs[0]?.args).toEqual({ item: 'oak_log', count: 3, radius: 48, replant: true });
  });

  it('gather of a block that drops something else asks for the drop (never breaks every stone in reach)', async () => {
    const { reg, fake } = v2Host();
    fake.skillHandler = (r) => ({
      status: 'done',
      result: { item: `minecraft:${(r.args as { item: string }).item}`, got: 3, have: 3 },
    });
    const ore = await call(reg, 'gather', { item: 'minecraft:iron_ore', count: 3 });
    expect(fake.runs[0]?.args).toMatchObject({ item: 'raw_iron', count: 3 });
    expect(ore.text.split('\n')[0]).toBe('done: gather raw_iron (from iron_ore) 3/3 | have raw_iron 3');
    await call(reg, 'gather', { item: 'stone', count: 3 });
    await call(reg, 'gather', { item: '#minecraft:coal_ores', count: 3 });
    await call(reg, 'gather', { item: 'cobblestone', count: 3 });
    expect(fake.runs.map((r) => (r.args as { item: string }).item)).toEqual([
      'raw_iron',
      'cobblestone',
      'coal',
      'cobblestone',
    ]);
  });

  it('positions are strings: a bad one is BAD_ARGS with an example, nothing is sent', async () => {
    const { reg, fake } = v2Host();
    const res = await call(reg, 'gather', { item: 'oak_log', count: 3, near: 'by the river' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('BAD_ARGS: near must be "x y z", e.g. "12 64 -30"');
    expect(fake.runs).toHaveLength(0);
  });

  it('a long job answers running after 20 s with its progress; [JOB DONE] is tracked', async () => {
    const { reg, fake, log, jobs } = v2Host();
    fake.skillHandler = () => ({ status: 'running' });
    const res = await call(reg, 'gather', { item: 'oak_log', count: 10 });
    expect(res.text).toMatch(
      /^running: gather oak_log \(job j\S+, \d+s so far\)\nnext: end your turn; \[JOB DONE\] wakes you/,
    );
    expect(
      res.text.endsWith('· HP 20/20 food 20 | day 1 06:15 | 5 66 -5 | idle (follow) | wheat_seeds'),
    ).toBe(true);
    expect(log[0]).toMatch(/^track:j\S+:gather oak_log$/);
    const id = jobs.current()?.jobId ?? '';
    jobs.progress(id, '4/10 minecraft:oak_log');
    const status = await call(reg, 'job', { action: 'status' });
    expect(status.text).toMatch(new RegExp(`^running: ${id} gather oak_log 4/10 \\(\\d+s\\)`));
  });

  it('a new world call says which running job it stopped', async () => {
    const { reg, fake, jobs } = v2Host();
    fake.skillHandler = (r) =>
      r.skill === 'collect'
        ? { status: 'running' }
        : { status: 'done', result: { pos: { x: 5, y: 66, z: 0 } } };
    await call(reg, 'gather', { item: 'oak_log', count: 10 });
    const first = jobs.current()?.jobId ?? '';
    jobs.progress(first, '4/10 oak_log');
    const res = await call(reg, 'goto', { to: 'crafting_table' });
    expect(res.text).toContain(`(stopped your previous job ${first} gather oak_log 4/10)`);
    expect(fake.runs[1]).toMatchObject({ skill: 'goto', args: { entity: 'crafting_table' } });
    expect(jobs.get(first)?.cancelledBy).toBe('replace');
  });

  it('with run.replaced the mod says what a replace stopped: nothing stale, and jobs no tool started', async () => {
    const { reg, fake, jobs } = v2Host();
    fake.skillHandler = (r) =>
      r.skill === 'collect'
        ? { status: 'running' }
        : { status: 'done', result: { pos: { x: 5, y: 66, z: 0 } } };
    await call(reg, 'gather', { item: 'oak_log', count: 10 });
    const first = jobs.current()?.jobId ?? '';
    // It ended in the mod and its skill.result never reached Node (a reconnect): Node still thinks it runs.
    fake.finish(first, { status: 'done', result: { got: 10 } });
    const after = await call(reg, 'goto', { to: 'crafting_table' });
    expect(after.text).not.toContain('stopped your previous job');
    // A job no tool started (an /mv skill command, say) is still named.
    await fake.runSkill({
      agentId: 'ada-1',
      skill: 'collect',
      args: { item: 'dirt', count: 5 },
      replace: true,
      jobId: 'jmod-1',
    });
    const res = await call(reg, 'goto', { to: 'crafting_table' });
    expect(res.text).toContain('(stopped your previous job jmod-1 collect)');
  });

  it('a call the mod refuses before starting it (BAD_ARGS) leaves the running job current, still due a wake', async () => {
    /** The mod's SkillFactory rejects an unknown item before it touches the running job. */
    class RefusingMod extends FakeSkillApi {
      refuse = false;
      override async runSkill<S extends SkillName>(r: SkillRunRequest<S>): Promise<SkillRunResult> {
        if (this.refuse) throw new ApiError('BAD_ARGS', 'unknown item minecraft:oak_lgo');
        return super.runSkill(r);
      }
    }
    const mod = new RefusingMod();
    mod.capSet = new Set(ALL_CAPS);
    const { reg, jobs } = v2Host({ skills: withSequenceFallback(mod) });
    mod.skillHandler = () => ({ status: 'running' });
    await call(reg, 'gather', { item: 'oak_log', count: 10 });
    const first = jobs.current()?.jobId ?? '';
    mod.refuse = true;
    const res = await call(reg, 'gather', { item: 'oak_lgo', count: 2 });
    expect(res.text).toMatch(/^failed: gather oak_lgo \| BAD_ARGS: unknown item/);
    expect(jobs.current()?.jobId).toBe(first);
    expect(jobs.get(first)?.cancelledBy).toBeNull();
    expect(jobs.recent()[0]?.rendered.head).toMatch(/^failed: gather oak_lgo \| BAD_ARGS/);
  });

  it('craft carries the consent of a refused gather: allow_protected survives the wire schema', () => {
    const args = validateSkillArgs('craft', {
      item: 'furnace',
      count: 1,
      tree: true,
      gather_missing: true,
      allow_protected: true,
    });
    expect(args).toMatchObject({ allow_protected: true });
  });

  it('goto: places, crew, mobs, positions and Codex places; nothing matching is UNKNOWN_PLACE with a hint', async () => {
    const { reg, fake, org } = v2Host();
    fake.skillHandler = () => ({ status: 'done', result: { pos: { x: 9, y: 66, z: 2 } } });
    await call(reg, 'goto', { to: '@bram' });
    await call(reg, 'goto', { to: 'cow', range: 3 });
    await call(reg, 'goto', { to: '12 64 -30' });
    expect(fake.runs.map((r) => r.args)).toEqual([
      { entity: 'bram1a2b' },
      { entity: 'cow', range: 3 },
      { pos: { x: 12, y: 64, z: -30 } },
    ]);
    await org.codex.write(agentActor('ada-1'), {
      mode: 'create',
      title: 'Iron cave',
      body: 'Iron cave entrance at 120, 40, -80 by the river.',
      tags: [],
      category: 'places',
      scope: 'world',
    });
    const cave = await call(reg, 'goto', { to: 'Iron cave' });
    expect(fake.runs[3]?.args).toEqual({ pos: { x: 120, y: 40, z: -80 } });
    expect(cave.text).toMatch(/^done: goto Iron cave \| at 9 66 2 \(\d+m\)/);
    const none = await call(reg, 'goto', { to: 'the mine' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('UNKNOWN_PLACE: no place, crew member or mob called "the mine"');
    expect(none.text).toContain('next: codex{"action":"search","query":"the mine"} or give "x y z"');
  });

  it('craft resolves the tree with the mod (craft.tree) and smelts through craft on an older mod', async () => {
    const { reg, fake } = v2Host();
    await call(reg, 'craft', { item: 'crafting_table' });
    expect(fake.runs[0]).toMatchObject({
      skill: 'craft',
      args: { item: 'crafting_table', count: 1, tree: true },
    });
    await call(reg, 'craft', { item: 'iron_pickaxe', gather_missing: true, station: '5 66 0' });
    expect(fake.runs[1]?.args).toEqual({
      item: 'iron_pickaxe',
      count: 1,
      tree: true,
      gather_missing: true,
      table: { x: 5, y: 66, z: 0 },
    });
    expect((await call(reg, 'craft', { item: '#planks' })).text).toContain('must be one item id, not a tag');
    const old = v2Host({}, []);
    old.fake.observations.set('recipe', { recipes: [{ station: 'furnace', ingredients: [] }], have: 0 });
    await call(old.reg, 'craft', { item: 'iron_ingot', count: 3 });
    expect(old.fake.runs[0]).toMatchObject({ skill: 'smelt', args: { item: 'iron_ingot', count: 3 } });
  });

  it('craft{plan} only reads (obs recipe tree), it is no job', async () => {
    const { reg, fake } = v2Host();
    fake.observations.set('recipe', {
      tree: true,
      steps: [{ action: 'craft', item: 'oak_planks', count: 4, from: { oak_log: 1 }, ready: true }],
      missing: [],
      footer: FOOTER,
    });
    const plan = await call(reg, 'craft', { item: 'crafting_table', plan: true });
    expect(fake.runs).toHaveLength(0);
    expect(fake.obsCalls[0]).toEqual({
      query: 'recipe',
      args: { item: 'crafting_table', count: 1, tree: true },
    });
    expect(plan.text).toContain('plan: crafting_table ×1');
    expect(plan.text).toContain(' oak_planks ×4 ← oak_log 1 ok');
  });

  it('use, items, build and menu map their actions to the wire skills; missing fields get an example', async () => {
    const { reg, fake } = v2Host();
    fake.skillHandler = () => ({ status: 'done' });
    await call(reg, 'use', { action: 'place', item: 'crafting_table', target: '6 66 1' });
    await call(reg, 'use', { action: 'break', target: '6 66 1' });
    await call(reg, 'use', { action: 'interact', target: '3 66 1' });
    await call(reg, 'use', { action: 'interact', target: 'villager' });
    await call(reg, 'use', { action: 'attack', target: 'zombie', count: 2 });
    await call(reg, 'use', { action: 'attack', target: 'zombie' });
    await call(reg, 'items', { action: 'give', item: 'oak_log', count: 5, to: 'player' });
    await call(reg, 'items', { action: 'store', item: 'cobblestone' });
    await call(reg, 'items', { action: 'take', item: 'bread', container: '3 66 1' });
    await call(reg, 'build', { action: 'dig', from: '10 64 -3', to: '12 65 -1' });
    await call(reg, 'build', { action: 'blueprint', blueprint: 'shelter', at: '40 64 -3' });
    await call(reg, 'menu', { action: 'click', slot: -2 });
    expect(fake.runs.map((r) => [r.skill, r.args])).toEqual([
      ['place', { block: 'crafting_table', pos: { x: 6, y: 66, z: 1 } }],
      ['dig', { from: { x: 6, y: 66, z: 1 }, to: { x: 6, y: 66, z: 1 } }],
      ['use_block', { pos: { x: 3, y: 66, z: 1 } }],
      ['use_item', { entity: 'villager' }],
      ['hunt', { entity: 'zombie', count: 2 }],
      ['attack', { entity: 'zombie' }],
      ['give', { item: 'oak_log', to: 'player', count: 5 }],
      ['container', { action: 'put', item: 'cobblestone' }],
      ['container', { action: 'take', item: 'bread', count: 64, pos: { x: 3, y: 66, z: 1 } }],
      ['dig', { from: { x: 10, y: 64, z: -3 }, to: { x: 12, y: 65, z: -1 } }],
      ['build', { blueprint: 'shelter', origin: { x: 40, y: 64, z: -3 } }],
      ['menu_click', { slot: -2, button: 0, type: 'pickup' }],
    ]);
    const bad = await call(reg, 'use', { action: 'place', item: 'torch' });
    expect(bad.text).toContain(
      'BAD_ARGS: place needs item and target. Example: use{"action":"place","item":"crafting_table","target":"6 66 1"}',
    );
    expect((await call(reg, 'use', { action: 'attack', target: 'player' })).text).toContain('BAD_TARGET');
    expect((await call(reg, 'build', { action: 'dig', from: '0 0 0', to: '20 20 20' })).text).toContain(
      'at most 1024 blocks',
    );
  });

  it('items on an older mod: the nearest chest and "give all" are looked up by Node', async () => {
    const { reg, fake } = v2Host({}, []);
    fake.obsHandler = (q, a) =>
      q === 'find' && a.what === 'minecraft:chest'
        ? { kind: 'block', matches: [{ pos: { x: 3, y: 66, z: 1 } }] }
        : q === 'inventory'
          ? { totals: { 'minecraft:oak_log': 7 } }
          : null;
    await call(reg, 'items', { action: 'store', item: 'oak_log' });
    await call(reg, 'items', { action: 'give', item: 'oak_log', to: 'player' });
    expect(fake.runs.map((r) => r.args)).toEqual([
      { action: 'put', item: 'oak_log', pos: { x: 3, y: 66, z: 1 } },
      { item: 'oak_log', to: 'player', count: 7 },
    ]);
  });

  it('the world guard refuses Base-reaching calls before the mod sees them (v2 advice, consent hint)', async () => {
    const refusals: unknown[] = [];
    const world = () => ({
      here: { x: 6, y: 65, z: 5 },
      base: {
        name: 'Base (office)',
        min: { x: 0, y: 64, z: 0 },
        max: { x: 12, y: 69, z: 9 },
        door: null,
        floorY: 64,
      },
      zone: null,
      playerName: 'Jordan',
    });
    const { reg, fake } = v2Host({ world, noteRefusal: (r) => refusals.push(r) });
    const res = await call(reg, 'gather', { item: '#logs', count: 10 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^failed: gather #logs \| PROTECTED: #logs means any of its kinds/);
    expect(res.text).toContain('Name the exact natural block instead');
    expect(res.text).toContain('"Allow"');
    const dig = await call(reg, 'do', {
      steps: [
        { tool: 'goto', args: { to: 'crafting_table' } },
        { tool: 'build', args: { action: 'dig', from: '10 64 -2', to: '14 66 2' } },
      ],
    });
    expect(dig.text).toMatch(/^failed: do step 2\/2 build \| PROTECTED: the box overlaps the Base/);
    expect(fake.runs).toHaveLength(0);
    expect(refusals).toHaveLength(2);
  });

  it("the player's consent rides only on the exact call the mod refused, once, never from arguments", async () => {
    const token = { token: '0123456789abcdef0123456789abcdef' };
    let granted = false;
    const { reg, fake } = v2Host({
      hasConsent: () => granted,
      takeConsent: () => {
        if (!granted) return null;
        granted = false;
        return token;
      },
    });
    const dig = { action: 'dig', from: '6 66 -6', to: '6 66 -6' };
    fake.skillHandler = (r) =>
      r.skill === 'dig' && r.args && (r.args as { allow_protected?: boolean }).allow_protected !== true
        ? {
            status: 'failed',
            code: 'PROTECTED',
            msg: 'player-built',
            result: {
              protected: {
                pos: { x: 6, y: 66, z: -6 },
                what: 'player-built',
                owner: 'Jordan',
                block: 'minecraft:stripped_spruce_log',
                count: 1,
              },
            },
          }
        : { status: 'done', result: { dug: 1 } };
    const refused = await call(reg, 'build', dig);
    expect(refused.text).toContain('PROTECTED');
    expect(refused.text).toContain("stripped_spruce_log at 6 66 -6 is Jordan's (player-built)");
    expect(refused.text).toContain('"Allow"');
    // The player allowed it. Another call does not carry the token...
    granted = true;
    await call(reg, 'gather', { item: 'oak_log', count: 1, consent: { token: 'forged' } });
    expect(fake.runs[1]?.consent).toBeUndefined();
    expect(fake.runs[1]?.args).not.toHaveProperty('consent');
    expect(fake.runs[1]?.args).not.toHaveProperty('allow_protected');
    // ...the exact call the mod refused does, with allow_protected, once.
    const retry = await call(reg, 'build', dig);
    expect(retry.isError).toBe(false);
    expect(fake.runs[2]?.consent).toEqual(token);
    expect(fake.runs[2]?.args).toMatchObject({ allow_protected: true });
    await call(reg, 'build', dig);
    expect(fake.runs[3]?.consent).toBeUndefined();
  });
});

describe('v2 do (§5.10)', () => {
  const steps = [
    { tool: 'gather', args: { item: 'oak_log', count: 10 } },
    { tool: 'craft', args: { item: 'crafting_table' } },
  ];

  it('with the mod cap: one sequence job with every step translated', async () => {
    const { reg, fake } = v2Host();
    fake.skillHandler = () => ({
      status: 'done',
      result: {
        completed: 2,
        steps: [
          { skill: 'collect', status: 'done', result: { got: 10, have: 10 } },
          {
            skill: 'craft',
            status: 'done',
            result: { crafted: 1, have: 1, item: 'minecraft:crafting_table' },
          },
        ],
      },
    });
    const res = await call(reg, 'do', { steps });
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]).toMatchObject({
      skill: 'sequence',
      args: {
        steps: [
          { skill: 'collect', args: { item: 'oak_log', count: 10, radius: 48, make_tools: true } },
          { skill: 'craft', args: { item: 'crafting_table', count: 1, tree: true } },
        ],
      },
    });
    expect(res.text.split('\n').slice(0, 3)).toEqual([
      'done: do 2/2 steps',
      ' 1 gather oak_log 10/10 | have oak_log 10',
      ' 2 craft crafting_table 1/1 | have crafting_table 1',
    ]);
  });

  it('a bad step fails the whole call naming the step, before anything runs', async () => {
    const { reg, fake } = v2Host();
    const res = await call(reg, 'do', { steps: [steps[0], { tool: 'craft', args: { count: 2 } }] });
    expect(res.text).toContain(
      'BAD_ARGS: step 2 craft: item is required. Example: craft{"item":"crafting_table"}',
    );
    expect(fake.runs).toHaveLength(0);
    expect((await call(reg, 'do', { steps: [] })).invalid).toBe(true);
  });

  it('one step is valid and runs as that tool (no sequence): same wire call, same result text', async () => {
    const { reg, fake } = v2Host();
    fake.skillHandler = () => ({
      status: 'done',
      result: { item: 'minecraft:oak_log', got: 10, have: 10, footer: FOOTER },
    });
    const one = await call(reg, 'do', { steps: [steps[0]] });
    expect(one.invalid).toBe(false);
    expect(fake.runs.map((r) => r.skill)).toEqual(['collect']);
    expect(fake.runs[0]?.args).toMatchObject({ item: 'oak_log', count: 10, make_tools: true });
    const direct = await call(reg, 'gather', { item: 'oak_log', count: 10 });
    expect(one.text).toBe(direct.text);
    expect(one.text.split('\n')[0]).toBe('done: gather oak_log 10/10 | have oak_log 10');
    // The reads a step may not be answer as their tool would; a bad single step names its tool.
    fake.observations.set('recipe', { item: 'minecraft:stick', tree: true, steps: [], missing: [] });
    const plan = await call(reg, 'do', { steps: [{ tool: 'craft', args: { item: 'stick', plan: true } }] });
    expect(plan.text).toMatch(/^plan: stick ×1/);
    expect(fake.runs).toHaveLength(2);
    const bad = await call(reg, 'do', { steps: [{ tool: 'gather', args: { item: 'oak_log' } }] });
    expect(bad.text).toMatch(/^failed: gather oak_log \| BAD_ARGS: step 1 gather: count must be 1-640/);
  });

  it("a lone craft{plan} step keeps craft's own input bounds (count 1-640, an item), checked before the mod is asked", async () => {
    const { reg, fake } = v2Host();
    fake.observations.set('recipe', { item: 'minecraft:stick', tree: true, steps: [], missing: [] });
    const huge = await call(reg, 'do', {
      steps: [{ tool: 'craft', args: { item: 'stick', plan: true, count: 100_000 } }],
    });
    expect(huge.isError).toBe(true);
    expect(huge.text).toMatch(/^failed: craft stick \| BAD_ARGS: step 1 craft: count: /);
    const noItem = await call(reg, 'do', { steps: [{ tool: 'craft', args: { plan: true } }] });
    expect(noItem.text).toMatch(/^failed: craft \| BAD_ARGS: step 1 craft: item: /);
    expect(fake.obsCalls.filter((c) => c.query === 'recipe')).toHaveLength(0);
    const ok = await call(reg, 'do', {
      steps: [{ tool: 'craft', args: { item: 'stick', plan: true, count: 4 } }],
    });
    expect(ok.text).toMatch(/^plan: stick ×4/);
    expect(fake.obsCalls.filter((c) => c.query === 'recipe').map((c) => c.args)).toEqual([
      { item: 'stick', count: 4, tree: true },
    ]);
  });

  it('without the mod cap Node runs the steps as one macro job; stop_on_fail stops at the first failure', async () => {
    const { reg, fake } = v2Host({}, []);
    fake.skillHandler = (r) =>
      r.skill === 'collect'
        ? {
            status: 'failed',
            code: 'NO_NATURAL_SOURCE',
            msg: 'no reachable natural oak_log within 48m',
            result: { got: 0 },
          }
        : { status: 'done' };
    const res = await call(reg, 'do', { steps });
    expect(fake.runs.map((r) => r.skill)).toEqual(['collect']);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(
      /^failed: do step 1\/2 gather \| NO_NATURAL_SOURCE: no reachable natural oak_log within 48m\n 1 gather oak_log 0\/10 failed\n 2 craft crafting_table skipped\nnext: if Jordan named oak_log: ask; else gather/,
    );
    const cont = v2Host({}, []);
    cont.fake.skillHandler = fake.skillHandler;
    await call(cont.reg, 'do', { steps, stop_on_fail: false });
    expect(cont.fake.runs.map((r) => r.skill)).toEqual(['collect', 'craft']);
  });
});

describe('v2 next: hints (§8)', () => {
  it('every call a hint suggests is a valid call when copied as is (no BAD_ARGS)', async () => {
    const codes = [
      'UNKNOWN_PLACE',
      'NOT_FOUND',
      'UNREACHABLE',
      'NEEDS_TOOL',
      'MISSING_INGREDIENTS',
      'NO_FUEL',
      'NO_RECIPE',
      'NO_ITEM',
      'INVENTORY_FULL',
      'OCCUPIED',
      'NO_FOOD',
      'NOT_A_CONTAINER',
      'NOT_RIDEABLE',
      'TIMEOUT',
      'UNKNOWN_JOB',
    ];
    const metas: JobMeta[] = [
      {
        tool: 'gather',
        skill: 'collect',
        what: 'gather oak_log',
        want: { item: 'oak_log', count: 10 },
        args: { item: 'oak_log', count: 10 },
      },
      { tool: 'craft', skill: 'craft', what: 'craft furnace', want: { item: 'furnace', count: 1 } },
      // A failure before any wire call (a do step's translation): no item, no target in the arguments.
      { tool: 'do', skill: '', what: 'do 2 steps', args: { steps: [] } },
    ];
    const { reg } = v2Host();
    const CALL_RE = /\b([a-z_]+)(\{[^{}]*(?:\[[^\]]*\])?[^{}]*\})/g;
    let checked = 0;
    for (const meta of metas) {
      for (const code of codes) {
        const next = hintFor(code, meta, { here: null, playerName: 'Jordan' }) ?? '';
        for (const m of next.matchAll(CALL_RE)) {
          const [, tool = '', json = '{}'] = m;
          if (!reg[tool]) continue;
          const res = await call(reg, tool, JSON.parse(json));
          expect(res.invalid, `${code}: ${m[0]}`).toBe(false);
          expect(res.text, `${code}: ${m[0]}`).not.toContain('BAD_ARGS');
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('v2 job, observe and the rest', () => {
  it('job: wait returns the formatted result; stop says what was kept', async () => {
    const { reg, fake, jobs } = v2Host();
    fake.skillHandler = () => ({ status: 'running' });
    await call(reg, 'gather', { item: 'oak_log', count: 10 });
    const id = jobs.current()?.jobId ?? '';
    setTimeout(
      () => fake.finish(id, { status: 'done', result: { got: 10, have: 10, item: 'minecraft:oak_log' } }),
      5,
    );
    const waited = await call(reg, 'job', { action: 'wait', seconds: 5 });
    expect(waited.text.split('\n')[0]).toBe('done: gather oak_log 10/10 | have oak_log 10');
    await call(reg, 'gather', { item: 'oak_log', count: 10 });
    const stopped = await call(reg, 'job', { action: 'stop' });
    expect(stopped.text).toMatch(/^cancelled: j\S+ gather oak_log/);
    expect((await call(reg, 'job', { action: 'stop' })).text.split('\n')[0]).toBe('ok: no job was running');
  });

  it('observe: sections in a fixed order, in parallel; a failing section does not fail the call', async () => {
    const { reg, fake } = v2Host();
    fake.observations.set('status', {
      hp: 20,
      maxHp: 20,
      food: 20,
      pos: { x: 5, y: 66, z: -5 },
      mode: 'follow',
      footer: FOOTER,
    });
    fake.observations.set('inventory', {
      slots: [{ item: 'minecraft:wheat_seeds', count: 3 }],
      freeSlots: 35,
      footer: FOOTER,
    });
    fake.observations.set('look_around', {
      scene: 'inside Base: protected\ntrees: oak 28m S, reachable',
      footer: FOOTER,
    });
    const res = await call(reg, 'observe', { sections: ['inventory', 'status', 'scene', 'pcs'] });
    const lines = res.text.split('\n');
    expect(lines[0]).toMatch(/^status: HP 20\/20 food 20/);
    expect(lines[1]).toBe('scene (24m): inside Base: protected');
    expect(lines[2]).toBe(' trees: oak 28m S, reachable');
    expect(lines[3]).toBe('inventory: 35 slots free | wheat_seeds 3');
    expect(lines[4]).toBe('pcs: unavailable (NOT_HANDLED)');
    // No footer: status says it all.
    expect(lines).toHaveLength(5);
    expect(fake.obsCalls.find((c) => c.query === 'look_around')?.args).toEqual({
      radius: 24,
      detail: 'brief',
    });
    const noStatus = await call(reg, 'observe', { sections: ['inventory'] });
    expect(
      noStatus.text.endsWith('· HP 20/20 food 20 | day 1 06:15 | 5 66 -5 | idle (follow) | wheat_seeds'),
    ).toBe(true);
  });

  it('observe scene radius is clamped to what the mod accepts (32 without the cap)', async () => {
    const { reg, fake } = v2Host({}, []);
    fake.observations.set('look_around', { blocks: {} });
    await call(reg, 'observe', { sections: ['scene'], radius: 48 });
    expect(fake.obsCalls[0]?.args).toEqual({ radius: 32, detail: 'brief' });
  });

  it('find: natural by default, rendered with distances and a footer', async () => {
    const { reg, fake } = v2Host();
    fake.observations.set('find', { kind: 'block', matches: [], footer: FOOTER });
    const res = await call(reg, 'find', { target: 'diamond_ore' });
    expect(fake.obsCalls[0]).toEqual({
      query: 'find',
      args: { what: 'diamond_ore', radius: 48, limit: 5, filter: 'natural' },
    });
    expect(res.text.split('\n')[0]).toBe('find diamond_ore (natural, ≤48m): none (loaded chunks only)');
  });

  it('say speaks and emotes; set_mode takes an "x y z" anchor; social tools carry no footer', async () => {
    const { reg, fake, log } = v2Host();
    expect((await call(reg, 'say', { text: 'On my way!', emote: 'wave' })).text).toBe('ok: said, waved');
    expect(log).toContain('say:On my way!');
    expect(fake.runs[0]).toMatchObject({ skill: 'emote', args: { kind: 'wave' }, replace: false });
    expect((await call(reg, 'say', {})).text).toContain('BAD_ARGS');
    expect((await call(reg, 'set_mode', { mode: 'guard', anchor: '0 66 3' })).text).toBe(
      'ok: idle mode guard around 0 66 3',
    );
    expect(fake.modeOf('ada-1')).toBe('guard');
    expect((await call(reg, 'tell', { to: '@bram', text: 'hi' })).text).toBe('Told @bram: hi');
    expect((await call(reg, 'sit_at_pc', { pc: 'linux-1', purpose: 'tests' })).text).toBe(
      'sit linux-1 60000',
    );
  });

  it('codex and calendar map their actions onto the org tools (self by default, clock inferred, report)', async () => {
    const { reg, log } = v2Host();
    const created = await call(reg, 'codex', {
      action: 'create',
      title: 'Iron cave',
      body: 'At 120 40 -80.',
      category: 'places',
      scope: 'world',
    });
    expect(created.isError).toBe(false);
    const search = await call(reg, 'codex', { action: 'search', query: 'iron' });
    expect(search.text).toContain('Iron cave');
    expect(
      (
        await call(reg, 'codex', {
          action: 'create',
          title: 'x',
          body: 'y',
          category: 'rules',
          scope: 'world',
        })
      ).text,
    ).toContain("rules pages are the player's");
    const added = await call(reg, 'calendar', {
      action: 'add',
      title: 'Mine iron',
      when: 'now',
      task: 'Mine 20 iron ore',
    });
    expect(added.isError).toBe(false);
    const id = /ev-\d+/.exec(added.text)?.[0] ?? '';
    expect(id).not.toBe('');
    const listed = await call(reg, 'calendar', { action: 'list' });
    expect(listed.text).toContain('Mine iron');
    await call(reg, 'calendar', { action: 'report', id, status: 'done' });
    expect(log).toContain(`report:${id}:done`);
    expect((await call(reg, 'calendar', { action: 'add', title: 'x' })).text).toContain(
      'add needs title and when',
    );
  });
});
