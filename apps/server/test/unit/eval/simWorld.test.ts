import { describe, expect, it } from 'vitest';
import { NS } from '../../../eval/sim/items.js';
import { buildWorld, HOUSE, HOUSE_CHEST, HOUSE_FURNACE, ZOMBIE_SPAWN } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { dayAndTime, posKey, TPS } from '../../../eval/sim/world.js';
import { isApiError } from '../../../src/contracts/common.js';

const A = 'ada';

function setup(options: Parameters<typeof buildWorld>[0] = {}) {
  const world = buildWorld(options);
  return { world, api: new SimSkillApi(world) };
}

async function rejectsCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(isApiError(err, code)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('SimWorld observations (mod formats)', () => {
  it('status carries the mod keys and the footer', async () => {
    const { api } = setup();
    const s = await api.obsQuery(A, 'status');
    expect(s).toMatchObject({
      agentId: A,
      hp: 20,
      food: 20,
      mode: 'follow',
      held: 'nothing',
      time: 'day 1 08:00',
    });
    expect(s.pos).toEqual({ x: 0.5, y: 64, z: -2.5 });
    expect(s.footer).toBe('HP 20/20 food 20 | day 1 08:00 | 0 64 -3 overworld | idle (follow)');
  });

  it('look_around counts the house logs as logs (no provenance), like the mod', async () => {
    const { api } = setup();
    const look = await api.obsQuery(A, 'look_around');
    const blocks = look.blocks as Record<
      string,
      { count: number; nearest: { x: number; y: number; z: number } }
    >;
    expect(blocks.logs?.count).toBeGreaterThan(40);
    // The nearest "log" is a wall of Jasper's house, not a tree.
    expect(blocks.logs?.nearest.x).toBeGreaterThanOrEqual(3);
    expect(blocks.chest?.nearest).toEqual(HOUSE_CHEST);
    expect((look.entities as { type: string; name?: string }[])[0]).toMatchObject({
      type: 'player',
      name: 'Jasper',
    });
    await rejectsCode(api.obsQuery(A, 'look_around', { radius: 40 }), 'BAD_ARGS');
  });

  it('find returns nearest matches with exposure; oak_log finds the tree, the logs tag the house', async () => {
    const { api } = setup();
    const oak = await api.obsQuery(A, 'find', { what: 'oak_log' });
    expect(oak.kind).toBe('block');
    // Oak C, the nearest tree.
    expect((oak.matches as { pos: unknown; exposed: boolean }[])[0]).toMatchObject({
      pos: { x: 6, y: 64, z: -14 },
      exposed: true,
    });
    const any = await api.obsQuery(A, 'find', { what: '#minecraft:logs' });
    expect((any.matches as { block: string }[])[0]?.block).toBe(`${NS}stripped_spruce_log`);
    const ingots = await api.obsQuery(A, 'find', { what: 'iron_ingot' });
    expect(ingots).toMatchObject({ kind: 'item', inInventory: 0, matches: [] });
    expect(ingots.note).toMatch(/none within/);
  });

  it('recipe lists crafting and smelting recipes with what the agent has', async () => {
    const { api } = setup({ inventory: [[`${NS}oak_planks`, 4]] });
    const table = await api.obsQuery(A, 'recipe', { item: 'crafting_table' });
    expect(table.recipes).toEqual([
      expect.objectContaining({
        station: 'inventory (2x2)',
        canCraftNow: 1,
        ingredients: [{ item: '#minecraft:planks', need: 4, have: 4 }],
      }),
    ]);
    const ingot = await api.obsQuery(A, 'recipe', { item: 'iron_ingot' });
    expect((ingot.recipes as { station: string }[]).some((r) => r.station === 'furnace')).toBe(true);
  });

  it('the clock reads like WorldClock.dayAndTime', () => {
    expect(dayAndTime(0)).toBe('day 1 06:00');
    expect(dayAndTime(13_000)).toBe('day 1 19:00');
    expect(dayAndTime(24_000 + 18_000)).toBe('day 2 00:00');
  });
});

describe('SimWorld jobs', () => {
  it('reproduces the incident: mine #minecraft:logs eats the house; collect oak_log takes trees', async () => {
    const bad = setup();
    const res = await bad.api.runSkill({
      agentId: A,
      skill: 'mine',
      args: { block: '#minecraft:logs', count: 10 },
      waitMs: 120_000,
    });
    expect(res.status).toBe('done');
    expect(res.result).toMatchObject({ mined: 10, items: { [`${NS}stripped_spruce_log`]: 10 } });
    expect(bad.world.damage(HOUSE)).toHaveLength(10);

    const good = setup();
    const ok = await good.api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 120_000,
    });
    expect(ok.status).toBe('done');
    expect(ok.result).toMatchObject({ collected: 10, have: 10 });
    expect(good.world.damage(HOUSE)).toHaveLength(0);
    expect(good.world.broken.every((b) => b.block.placedBy === 'natural')).toBe(true);
  });

  it('answers running past waitMs, finishes in game time, and emits the result', async () => {
    const { world, api } = setup();
    const ends: string[] = [];
    api.on('result', (e) => {
      ends.push(`${e.jobId}:${e.status}`);
    });
    const res = await api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 5_000,
    });
    expect(res.status).toBe('running');
    expect(world.current?.text).toMatch(/\/10 minecraft:oak_log/);
    const status = await api.obsQuery(A, 'job_status');
    expect(status).toMatchObject({ skill: 'collect', status: 'running' });
    await rejectsCode(api.runSkill({ agentId: A, skill: 'eat', args: {} }), 'BUSY');
    const end = await api.awaitJob(res.jobId);
    expect(end.status).toBe('done');
    expect(end.result?.footer).toMatch(/^HP 20\/20/);
    expect(ends).toEqual([`${res.jobId}:done`]);
  });

  it('replacing a job cancels it and keeps only finished steps', async () => {
    const { world, api } = setup();
    const first = await api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 8_000,
    });
    expect(first.status).toBe('running');
    const logs = world.count((id) => id === `${NS}oak_log`);
    await api.runSkill({ agentId: A, skill: 'emote', args: { kind: 'wave' }, replace: true });
    expect(api.ended(first.jobId)?.status).toBe('cancelled');
    expect(world.count((id) => id === `${NS}oak_log`)).toBe(logs);
  });

  it('skips unreachable trees and fails UNREACHABLE when every tree is out of reach', async () => {
    const { world, api } = setup({ allTreesUnreachable: true });
    const res = await api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 120_000,
    });
    expect(res.status).toBe('failed');
    expect(res.error).toEqual({ code: 'UNREACHABLE', msg: 'cannot reach any matching block (no path)' });
    expect(world.broken).toHaveLength(0);
  });

  it('crafts planks then a table; a table recipe without planks fails MISSING_INGREDIENTS', async () => {
    const { world, api } = setup({ inventory: [[`${NS}oak_log`, 1]] });
    const missing = await api.runSkill({
      agentId: A,
      skill: 'craft',
      args: { item: 'crafting_table', count: 1 },
    });
    expect(missing.status).toBe('failed');
    expect(missing.error?.code).toBe('MISSING_INGREDIENTS');
    expect(missing.result?.ingredients).toEqual([{ item: '#minecraft:planks', need: 4, have: 0 }]);
    expect(
      (await api.runSkill({ agentId: A, skill: 'craft', args: { item: 'oak_planks', count: 4 } })).result,
    ).toMatchObject({
      crafted: 4,
      have: 4,
    });
    expect(
      (await api.runSkill({ agentId: A, skill: 'craft', args: { item: 'crafting_table', count: 1 } })).status,
    ).toBe('done');
    expect(world.count((id) => id === `${NS}crafting_table`)).toBe(1);
    const chest = await api.runSkill({ agentId: A, skill: 'craft', args: { item: 'chest', count: 1 } });
    expect(chest.error?.code).toBe('MISSING_INGREDIENTS');
  });

  it('smelts in the house furnace with coal, and fails NO_FUEL without fuel', async () => {
    const noFuel = setup({ inventory: [[`${NS}raw_iron`, 3]] });
    const r1 = await noFuel.api.runSkill({
      agentId: A,
      skill: 'smelt',
      args: { item: 'iron_ingot', count: 3 },
    });
    expect(r1.error?.code).toBe('NO_FUEL');
    const ok = setup({
      inventory: [
        [`${NS}raw_iron`, 3],
        [`${NS}coal`, 1],
      ],
    });
    const r2 = await ok.api.runSkill({
      agentId: A,
      skill: 'smelt',
      args: { item: 'raw_iron', count: 3 },
      waitMs: 120_000,
    });
    expect(r2.status).toBe('done');
    expect(r2.result).toMatchObject({
      smelted: 3,
      item: `${NS}iron_ingot`,
      furnace: HOUSE_FURNACE,
      fuel: `${NS}coal`,
    });
    expect(ok.world.count((id) => id === `${NS}iron_ingot`)).toBe(3);
  });

  it('mines iron with a stone pickaxe and says NEEDS_TOOL without one', async () => {
    const bare = setup();
    const r1 = await bare.api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'raw_iron', count: 1 },
      waitMs: 60_000,
    });
    expect(r1.error?.code).toBe('NEEDS_TOOL');
    const tooled = setup({ inventory: [[`${NS}stone_pickaxe`, 1]] });
    const r2 = await tooled.api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'raw_iron', count: 3 },
      waitMs: 120_000,
    });
    expect(r2.result).toMatchObject({ collected: 3 });
    expect(tooled.world.agent.held).toBe(`${NS}stone_pickaxe`);
  });

  it('puts a tag of items into the chest and lists it', async () => {
    const { world, api } = setup({
      inventory: [
        [`${NS}oak_log`, 12],
        [`${NS}birch_log`, 4],
      ],
    });
    const put = await api.runSkill({
      agentId: A,
      skill: 'container',
      args: { pos: HOUSE_CHEST, action: 'put', item: '#minecraft:logs' },
    });
    expect(put.result).toMatchObject({ moved: 16, item: '#minecraft:logs' });
    expect(world.containers.get(posKey(HOUSE_CHEST))?.get(`${NS}oak_log`)).toBe(12);
    const list = await api.runSkill({
      agentId: A,
      skill: 'container',
      args: { pos: HOUSE_CHEST, action: 'list' },
    });
    const contents = list.result?.contents as { items: Record<string, number> } | undefined;
    expect(contents?.items).toMatchObject({
      [`${NS}bread`]: 6,
      [`${NS}birch_log`]: 4,
    });
    const notChest = await api.runSkill({
      agentId: A,
      skill: 'container',
      args: { pos: { x: 3, y: 64, z: 3 }, action: 'list' },
    });
    expect(notChest.error?.code).toBe('NOT_A_CONTAINER');
  });

  it('places blocks into air or water, never over a block', async () => {
    const { world, api } = setup({ allTreesUnreachable: true, inventory: [[`${NS}cobblestone`, 2]] });
    const water = { x: 9, y: 63, z: -17 };
    expect(world.block(water).id).toBe(`${NS}water`);
    expect(
      (await api.runSkill({ agentId: A, skill: 'place', args: { block: 'cobblestone', pos: water } })).status,
    ).toBe('done');
    expect(world.block(water)).toMatchObject({ id: `${NS}cobblestone`, placedBy: 'agent' });
    const wall = await api.runSkill({
      agentId: A,
      skill: 'place',
      args: { block: 'cobblestone', pos: { x: 3, y: 64, z: 3 } },
    });
    expect(wall.error?.code).toBe('OCCUPIED');
  });

  it('validates args with the protocol schemas', async () => {
    const { api } = setup();
    await rejectsCode(
      api.runSkill({ agentId: A, skill: 'mine', args: { block: 'oak_log' } as never }),
      'BAD_ARGS',
    );
    await rejectsCode(api.obsQuery('bob', 'status'), 'UNKNOWN_AGENT');
    await rejectsCode(
      api.runSkill({
        agentId: A,
        skill: 'build',
        args: { blueprint: 'castle', origin: { x: 0, y: 64, z: 0 } },
      }),
      'UNKNOWN_BLUEPRINT',
    );
  });
});

describe('SimWorld night', () => {
  it('a zombie walks to an unguarded player and hurts them', () => {
    const { world } = setup({ clock: 12_900, zombieAt: 13_000 });
    world.agent.pos = { x: 30, y: 64, z: 30 };
    world.advance(world.clock + 60 * TPS);
    expect(world.mobs[0]?.type).toBe(`${NS}zombie`);
    expect(world.player.hp).toBeLessThan(20);
  });

  it("the body's Protect reflex kills a zombie near the player", () => {
    const { world } = setup({ clock: 12_900, zombieAt: 13_000, inventory: [[`${NS}wooden_sword`, 1]] });
    world.advance(world.clock + 60 * TPS);
    expect(world.mobs[0]?.alive).toBe(false);
    expect(world.player.hp).toBe(20);
    expect(world.events.some((e) => e.type === 'mob_killed')).toBe(true);
  });

  it('a player inside a shelter is safe; the zombie spawn is where the layout says', () => {
    const { world } = setup({ clock: 12_900, zombieAt: 13_000 });
    world.agent.pos = { x: 30, y: 64, z: 30 };
    world.player.pos = { x: 5, y: 64, z: 5 };
    world.advance(world.clock + 60 * TPS);
    expect(world.player.hp).toBe(20);
    expect(world.events.find((e) => e.type === 'mob_spawned')?.data?.pos).toEqual(ZOMBIE_SPAWN);
  });
});
