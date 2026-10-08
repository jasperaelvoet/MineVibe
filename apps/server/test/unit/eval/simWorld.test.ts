import { describe, expect, it } from 'vitest';
import { NS } from '../../../eval/sim/items.js';
import { buildWorld, HOUSE, HOUSE_CHEST, HOUSE_FURNACE, ZOMBIE_SPAWN } from '../../../eval/sim/layout.js';
import { SimSkillApi } from '../../../eval/sim/SimSkillApi.js';
import { dayAndTime, dist, posKey, TPS } from '../../../eval/sim/world.js';
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
    // Miner.java: "cannot reach any matching block (" + Walk.failure() + ")", and Walk says `no_path`.
    expect(res.error).toEqual({ code: 'UNREACHABLE', msg: 'cannot reach any matching block (no_path)' });
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

  it('goto an unreachable spot fails like GotoSkillJob (no_path)', async () => {
    const { api } = setup();
    const res = await api.runSkill({
      agentId: A,
      skill: 'goto',
      args: { pos: { x: -20, y: 72, z: -2 } },
      waitMs: 20_000,
    });
    expect(res.error).toEqual({ code: 'UNREACHABLE', msg: 'no path to -20, 72, -2 (no_path)' });
  });

  it('builds a shelter like BuildJob: logs are no building blocks, 71 blocks, a torch last', async () => {
    const origin = { x: 2, y: 64, z: -2 };
    // Logs have an axis: BuildJob.isBuildingBlock refuses them.
    const logs = setup({ inventory: [[`${NS}oak_log`, 80]] });
    const refused = await logs.api.runSkill({
      agentId: A,
      skill: 'build',
      args: { blueprint: 'shelter', origin },
      waitMs: 120_000,
    });
    expect(refused).toMatchObject({
      status: 'failed',
      error: {
        code: 'NO_MATERIAL',
        msg: 'shelter needs 71 building blocks (dirt, cobblestone, planks...), have 0',
      },
      result: { needBlocks: 71 },
    });
    expect(logs.world.placed).toHaveLength(0);

    const ok = setup({
      inventory: [
        [`${NS}cobblestone`, 64],
        [`${NS}oak_planks`, 10],
        [`${NS}torch`, 1],
      ],
    });
    const built = await ok.api.runSkill({
      agentId: A,
      skill: 'build',
      args: { blueprint: 'shelter', origin },
      waitMs: 120_000,
    });
    expect(built.status).toBe('done');
    expect(built.result).toMatchObject({
      needBlocks: 71,
      blueprint: 'shelter',
      placed: 72,
      dug: 0,
      skipped: 0,
    });
    expect(ok.world.block({ x: 2, y: 67, z: -2 }).id).toBe(`${NS}oak_planks`); // the roof's last block
    expect(ok.world.block({ x: 2, y: 64, z: -4 }).id).toBe('minecraft:air'); // the door gap
    expect(ok.world.block({ x: 2, y: 66, z: -4 }).id).not.toBe('minecraft:air'); // above the door
    expect(ok.world.player.sheltered).toBe(true);

    // Without a torch the last step fails, as in the mod; the hut stands and shelters.
    const dark = setup({ inventory: [[`${NS}cobblestone`, 71]] });
    const short = await dark.api.runSkill({
      agentId: A,
      skill: 'build',
      args: { blueprint: 'shelter', origin },
      waitMs: 120_000,
    });
    expect(short.error).toEqual({ code: 'NO_MATERIAL', msg: 'out of torches after 71 blocks' });
    expect(dark.world.player.sheltered).toBe(true);
  });

  it("a shelter clears its inside first, even when that is Jasper's wall", async () => {
    const { world, api } = setup({ inventory: [[`${NS}dirt`, 80]] });
    await api.runSkill({
      agentId: A,
      skill: 'build',
      args: { blueprint: 'shelter', origin: { x: 3, y: 64, z: 6 } },
      waitMs: 120_000,
    });
    expect(world.damage(HOUSE).length).toBeGreaterThan(0);
    expect(world.broken.every((b) => b.skill === 'build')).toBe(true);
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
    // Far away and told to stay there (in follow mode the body would walk back to Jasper).
    world.agent.pos = { x: 30, y: 64, z: 30 };
    world.agent.mode = 'stay';
    world.agent.anchor = world.agent.pos;
    world.advance(world.clock + 60 * TPS);
    expect(world.agent.pos).toEqual({ x: 30, y: 64, z: 30 });
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

  it('idle modes move the body like the mod: follow comes back after a fight, guard returns to its anchor', async () => {
    // Follow (the default): Protect walks the body to the zombie; afterwards it is back by Jasper.
    const follow = setup({ clock: 12_900, zombieAt: 13_000 });
    follow.world.advance(follow.world.clock + 60 * TPS);
    expect(follow.world.mobs[0]?.alive).toBe(false);
    expect(dist(follow.world.agent.pos, follow.world.player.pos)).toBeLessThanOrEqual(4);

    // Guard: within 6 blocks of the anchor once the zombie is dead (IdleModeReflex walks back past 6).
    const guard = setup({ clock: 12_900, zombieAt: 13_000 });
    await guard.api.setMode(A, 'guard');
    expect(guard.world.agent.anchor).toEqual({ x: 0, y: 64, z: -3 });
    guard.world.advance(guard.world.clock + 60 * TPS);
    expect(guard.world.mobs[0]?.alive).toBe(false);
    expect(dist(guard.world.agent.pos, { x: 0, y: 64, z: -3 })).toBeLessThanOrEqual(6);
    // Pushed away, it walks back onto the anchor.
    guard.world.agent.pos = { x: 20, y: 64, z: -3 };
    guard.world.advance(guard.world.clock + 10 * TPS);
    expect(guard.world.agent.pos).toEqual({ x: 0, y: 64, z: -3 });

    // Guard far from Jasper still fights what comes near its anchor.
    const post = setup({ clock: 12_900, zombieAt: 13_000 });
    await post.api.setMode(A, 'guard', { x: -10, y: 64, z: -10 });
    post.world.agent.pos = { x: -10, y: 64, z: -10 };
    post.world.player.pos = { x: 40, y: 64, z: 40 };
    post.world.advance(post.world.clock + 30 * TPS);
    expect(post.world.events.find((e) => e.type === 'mob_killed')?.data).toMatchObject({ by: 'idle:guard' });

    // ReflexBrain.setMode anchors: none for follow, where the body stands for the others.
    await post.api.setMode(A, 'follow');
    expect(post.world.agent.anchor).toBeNull();
    await post.api.setMode(A, 'wander');
    expect(post.world.agent.anchor).toEqual(post.world.agent.pos);

    // No idle walking while a job runs.
    const busy = setup();
    busy.world.player.pos = { x: 30, y: 64, z: 30 };
    const job = await busy.api.runSkill({
      agentId: A,
      skill: 'collect',
      args: { item: 'oak_log', count: 10 },
      waitMs: 1_000,
    });
    expect(job.status).toBe('running');
    const at = busy.world.agent.pos;
    busy.world.advance(busy.world.clock + 2 * TPS);
    expect(busy.world.agent.pos).toEqual(at); // still walking to the first tree, not to Jasper
  });

  it('a player inside a shelter is safe; the zombie spawn is where the layout says', () => {
    const { world } = setup({ clock: 12_900, zombieAt: 13_000 });
    world.agent.pos = { x: 30, y: 64, z: 30 };
    world.agent.mode = 'stay';
    world.agent.anchor = world.agent.pos;
    world.player.pos = { x: 5, y: 64, z: 5 };
    world.advance(world.clock + 60 * TPS);
    expect(world.player.hp).toBe(20);
    expect(world.events.find((e) => e.type === 'mob_spawned')?.data?.pos).toEqual(ZOMBIE_SPAWN);
  });
});
