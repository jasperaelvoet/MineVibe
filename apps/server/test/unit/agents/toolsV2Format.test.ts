import { describe, expect, it } from 'vitest';
import {
  compass,
  compose,
  distDir,
  dur,
  footerLine,
  HARD_STOP_CODES,
  hintFor,
  itemList,
  type JobMeta,
  renderCrew,
  renderDone,
  renderEvents,
  renderFailed,
  renderFind,
  renderInventory,
  renderMenu,
  renderOutcome,
  renderPcs,
  renderRunning,
  renderScene,
  renderSequence,
  renderStatus,
  short,
  wakeText,
} from '../../../src/agents/tools/format.js';
import { JobRegistry } from '../../../src/agents/tools/jobs.js';
import { progressFor, renderPlan } from '../../../src/agents/tools/mcToolsV2.js';
import { parsePos, requireTarget, resolveTarget } from '../../../src/agents/tools/targets.js';

const ctx = { here: { x: 5, y: 66, z: -5 }, playerName: 'Jasper' };
const gatherMeta: JobMeta = {
  tool: 'gather',
  skill: 'collect',
  what: 'gather oak_log',
  want: { item: 'oak_log', count: 10 },
  args: { item: 'oak_log', count: 10 },
};

describe('v2 result format basics (tools-v2-mc.md §6.2)', () => {
  it('R1-R5: ids, positions, compass, durations, item lists', () => {
    expect(short('minecraft:oak_log')).toBe('oak_log');
    expect(short('#minecraft:logs')).toBe('#logs');
    expect(short('create:brass')).toBe('create:brass');
    // North is -Z, east is +X.
    expect(compass({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 })).toBe('N');
    expect(compass({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: -10 })).toBe('NE');
    expect(compass({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 })).toBe('S');
    expect(distDir({ x: 5, y: 66, z: -5 }, { x: 6, y: 66, z: 24 })).toBe('29m S');
    expect(distDir({ x: 5, y: 66, z: -5 }, { x: 5, y: 66, z: -5 })).toBe('here');
    expect(dur(9_000)).toBe('9s');
    expect(dur(190_000)).toBe('3m 10s');
    expect(dur(120_000)).toBe('2m');
    expect(itemList({ 'minecraft:stick': 1, 'minecraft:oak_sapling': 2, dirt: 0 })).toBe(
      'oak_sapling 2, stick 1',
    );
    expect(itemList({ a: 1, b: 2, c: 3, d: 4 }, 2)).toBe('d 4, c 3 +2 more');
  });

  it('the footer drops the overworld and namespaces, keeps the rest', () => {
    expect(
      footerLine(
        'HP 20/20 food 20 | day 1 06:15 | 5 66 -5 overworld | idle (follow) | minecraft:wheat_seeds',
      ),
    ).toBe('· HP 20/20 food 20 | day 1 06:15 | 5 66 -5 | idle (follow) | wheat_seeds');
    expect(footerLine('HP 1/20 food 2 | day 1 | 0 64 0 the_nether | idle')).toContain('the_nether');
    expect(footerLine(null)).toBeNull();
  });

  it('positions are "x y z" strings with spaces or commas; targets resolve in §4.2 order', () => {
    expect(parsePos('12 64 -30')).toEqual({ x: 12, y: 64, z: -30 });
    expect(parsePos(' 12,64,-30 ')).toEqual({ x: 12, y: 64, z: -30 });
    expect(parsePos('12, 64, -30')).toEqual({ x: 12, y: 64, z: -30 });
    expect(parsePos('12 64')).toBeNull();
    expect(parsePos({ x: 1, y: 2, z: 3 })).toBeNull();
    const host = {
      playerName: () => 'Jasper',
      crewMember: (ref: string) =>
        ref.replace(/^@/, '').toLowerCase() === 'bram'
          ? { agentId: 'bram1a2b', name: 'Bram', handle: 'bram' }
          : null,
    };
    expect(resolveTarget('player', host)).toMatchObject({ kind: 'player', entity: 'player' });
    expect(resolveTarget('jasper', host)).toMatchObject({ kind: 'player' });
    expect(resolveTarget('@bram', host)).toMatchObject({ kind: 'agent', entity: 'bram1a2b', label: 'Bram' });
    expect(resolveTarget('crafting_table', host)).toMatchObject({ kind: 'place', entity: 'crafting_table' });
    expect(resolveTarget('pc:linux-1', host)).toMatchObject({ kind: 'place', entity: 'pc:linux-1' });
    expect(resolveTarget('cow', host)).toMatchObject({ kind: 'mob', entity: 'cow' });
    expect(resolveTarget('minecraft:zombie', host)).toMatchObject({ kind: 'mob' });
    expect(resolveTarget('5 66 0', host)).toMatchObject({ kind: 'pos', pos: { x: 5, y: 66, z: 0 } });
    // A bare word that is no mob is left for a Codex place (goto) or UNKNOWN_PLACE.
    expect(resolveTarget('mine', host)).toBeNull();
    expect(() => requireTarget('mine', host)).toThrow(/no place, crew member or mob called "mine"/);
  });
});

describe('v2 job results (§5.4, §6.1)', () => {
  it('done: gather with sources, extras, replanting and what you have', () => {
    const r = renderDone(
      gatherMeta,
      {
        status: 'done',
        durationMs: 74_000,
        result: {
          item: 'minecraft:oak_log',
          got: 10,
          have: 10,
          sources: [
            { kind: 'tree', what: 'oak', pos: { x: 6, y: 66, z: 24 }, n: 5 },
            { kind: 'tree', what: 'oak', pos: { x: 8, y: 66, z: 26 }, n: 5 },
          ],
          replanted: 1,
          items: { 'minecraft:oak_log': 10, 'minecraft:oak_sapling': 2, 'minecraft:stick': 1 },
        },
      },
      ctx,
    );
    expect(r.head).toBe(
      'done: gather oak_log 10/10 in 1m 14s | from 2 oak trees near 6 66 24 | also oak_sapling 2, stick 1 | replanted 1 | have oak_log 10',
    );
    expect(r.isError).toBe(false);
  });

  it("done: v1's collect keys still render (collected/have/items)", () => {
    const r = renderDone(
      gatherMeta,
      { status: 'done', result: { collected: 4, have: 4, items: { oak_log: 4 } } },
      ctx,
    );
    expect(r.head).toBe('done: gather oak_log 4/10 | have oak_log 4');
  });

  it('failed NO_NATURAL_SOURCE keeps the partial result, shows candidates, and says to ask (a hard stop)', () => {
    const r = renderFailed(
      gatherMeta,
      {
        status: 'failed',
        error: { code: 'NO_NATURAL_SOURCE', msg: 'no reachable natural oak_log within 48m' },
        result: {
          got: 0,
          candidates: [
            { what: 'oak trunk', pos: { x: 9, y: 67, z: -12 }, why: 'unreachable (no path: wall)' },
            { what: 'oak trunk', pos: { x: 6, y: 66, z: 60 }, why: 'beyond radius' },
          ],
        },
      },
      ctx,
    );
    const text = compose(r, '· HP 20/20');
    expect(text).toBe(
      [
        'failed: gather oak_log 0/10 | NO_NATURAL_SOURCE: no reachable natural oak_log within 48m',
        ' seen: oak trunk at 9 67 -12, 8m NE, unreachable (no path: wall)',
        ' seen: oak trunk at 6 66 60, 65m S, beyond radius',
        'next: ask Jasper (AskUserQuestion: go further / use something else / skip). Never take oak_log from buildings.',
        '· HP 20/20',
      ].join('\n'),
    );
    expect(r.isError).toBe(true);
    expect(HARD_STOP_CODES.has('NO_NATURAL_SOURCE')).toBe(true);
  });

  it('MISSING_INGREDIENTS lists what is missing (M4 tree and v1 ingredients) and suggests gather_missing', () => {
    const craft: JobMeta = {
      tool: 'craft',
      skill: 'craft',
      what: 'craft iron_pickaxe',
      want: { item: 'iron_pickaxe', count: 1 },
    };
    const tree = renderFailed(
      craft,
      {
        status: 'failed',
        error: { code: 'MISSING_INGREDIENTS', msg: 'raw materials missing' },
        result: { crafted: 0, missing: [{ item: 'raw_iron', need: 3, have: 0, for: 'iron_ingot' }] },
      },
      ctx,
    );
    expect(tree.head).toBe('failed: craft iron_pickaxe 0/1 | MISSING_INGREDIENTS: raw materials missing');
    expect(tree.details).toEqual(['need: raw_iron 3 (have 0), for iron_ingot']);
    expect(tree.next).toBe('craft{"item":"iron_pickaxe","gather_missing":true}');
    const v1 = renderFailed(
      craft,
      {
        status: 'failed',
        error: { code: 'MISSING_INGREDIENTS', msg: 'missing' },
        result: { ingredients: { iron_ingot: [3, 1], stick: [2, 2] } },
      },
      ctx,
    );
    expect(v1.details).toEqual(['need: iron_ingot 3 (have 1) per craft']);
    // An older mod (no craft.tree) ignores gather_missing: the hint says to make the ingredients first.
    const old = renderFailed(
      craft,
      {
        status: 'failed',
        error: { code: 'MISSING_INGREDIENTS', msg: 'missing' },
        result: { ingredients: { iron_ingot: [3, 1], stick: [2, 2] } },
      },
      { ...ctx, craftTree: false },
    );
    expect(old.next).toBe(
      'craft or gather each missing ingredient (and fuel) first, then craft{"item":"iron_pickaxe"}',
    );
  });

  it('PROTECTED names the block and whose it is; the hint is the "Allow" question (W2 consent)', () => {
    const r = renderFailed(
      { tool: 'use', skill: 'dig', what: 'break 6 66 -6' },
      {
        status: 'failed',
        error: { code: 'PROTECTED', msg: 'player-built' },
        result: {
          protected: [
            { pos: { x: 6, y: 66, z: -6 }, block: 'minecraft:stripped_spruce_log', owner: 'Jasper' },
          ],
        },
      },
      ctx,
    );
    expect(r.details).toEqual(["stripped_spruce_log at 6 66 -6 is Jasper's (player-built)"]);
    expect(r.next).toContain('"Allow"');
    expect(r.next).toContain('repeat this exact call');
  });

  it('every failure code of §8 that has a next step renders one, at most 160 characters', () => {
    const codes = [
      'UNKNOWN_PLACE',
      'NOT_FOUND',
      'UNREACHABLE',
      'NO_NATURAL_SOURCE',
      'PROTECTED',
      'OTHER_DIMENSION',
      'NEEDS_TOOL',
      'MISSING_INGREDIENTS',
      'NO_RECIPE',
      'NEEDS_TABLE',
      'NO_TABLE',
      'NEEDS_FURNACE',
      'NO_FURNACE',
      'FURNACE_BUSY',
      'NO_FUEL',
      'NO_ITEM',
      'INVENTORY_FULL',
      'OCCUPIED',
      'NO_SUPPORT',
      'BLOCKED',
      'CANNOT_PLACE',
      'NO_ROOM',
      'NO_FOOD',
      'ESCAPED',
      'NOT_A_CONTAINER',
      'NO_MENU',
      'BAD_CLICK',
      'BAD_SLOT',
      'SEATED',
      'NOT_RIDEABLE',
      'UNKNOWN_BLUEPRINT',
      'TIMEOUT',
      'UNKNOWN_JOB',
      'DISCONNECTED',
      'INTERNAL',
      'FAILED',
    ];
    for (const code of codes) {
      const next = hintFor(code, gatherMeta, ctx);
      expect(next, code).toBeTruthy();
      expect((next ?? '').length, code).toBeLessThanOrEqual(160);
    }
    // BAD_ARGS carries its example in the message itself.
    expect(hintFor('BAD_ARGS', gatherMeta, ctx)).toBeNull();
  });

  it('running: progress, job id and how to wait; cancelled keeps what was gathered', () => {
    const run = renderRunning(gatherMeta, 'j2-7', 20_400, progressFor(gatherMeta, '4/10 minecraft:oak_log'));
    expect(compose(run, null)).toBe(
      [
        'running: gather oak_log 4/10 (job j2-7, 20s so far)',
        'next: end your turn; [JOB DONE] wakes you. Or job{"action":"wait","seconds":60}, job{"action":"stop"}.',
      ].join('\n'),
    );
    const cancelled = renderOutcome(
      gatherMeta,
      {
        status: 'cancelled',
        error: { code: 'INTERRUPTED', msg: 'stop' },
        result: { got: 4, items: { oak_log: 4 } },
      },
      ctx,
    );
    expect(cancelled.head).toBe('cancelled: gather oak_log 4/10 (stop) | kept oak_log 4');
  });

  it('do: one line per step; a failed step names its code and the rest are skipped', () => {
    const meta: JobMeta = {
      tool: 'do',
      skill: 'sequence',
      what: 'do 2 steps',
      steps: [
        gatherMeta,
        {
          tool: 'craft',
          skill: 'craft',
          what: 'craft crafting_table',
          want: { item: 'crafting_table', count: 1 },
        },
      ],
    };
    const done = renderSequence(
      meta,
      {
        status: 'done',
        durationMs: 81_000,
        result: {
          completed: 2,
          steps: [
            { skill: 'collect', status: 'done', result: { got: 10, have: 10, item: 'oak_log' } },
            {
              skill: 'craft',
              status: 'done',
              result: {
                item: 'minecraft:crafting_table',
                crafted: 1,
                have: 1,
                steps: ['oak_log 1 → oak_planks 4'],
              },
            },
          ],
        },
      },
      ctx,
    );
    expect(done.head).toBe('done: do 2/2 steps in 1m 21s');
    expect(done.details[0]).toBe('1 gather oak_log 10/10 | have oak_log 10');
    expect(done.details[1]).toBe('2 craft crafting_table 1/1 | have crafting_table 1');
    const failed = renderSequence(
      meta,
      {
        status: 'failed',
        error: {
          code: 'NO_NATURAL_SOURCE',
          msg: 'step 1/2 collect: no reachable natural oak_log within 48m',
        },
        result: {
          completed: 0,
          steps: [{ skill: 'collect', status: 'failed', code: 'NO_NATURAL_SOURCE', result: { got: 0 } }],
        },
      },
      ctx,
    );
    expect(failed.head).toBe(
      'failed: do step 1/2 gather | NO_NATURAL_SOURCE: no reachable natural oak_log within 48m',
    );
    expect(failed.details).toEqual(['1 gather oak_log 0/10 failed', '2 craft crafting_table skipped']);
    expect(failed.next).toContain('AskUserQuestion');
    const wake = wakeText('j2-9', failed);
    expect(wake.startsWith('j2-9 do step 1/2 gather | NO_NATURAL_SOURCE')).toBe(true);
    expect(wake).toContain('| next: ask Jasper');
    expect(wake.length).toBeLessThanOrEqual(400);
  });

  it('progress texts: the asked-for item is dropped, sequence steps name their tool', () => {
    expect(progressFor(gatherMeta, '4/10 oak_log')).toBe('4/10');
    expect(progressFor(gatherMeta, '4/10 birch_log')).toBe('4/10 birch_log');
    const meta: JobMeta = { tool: 'do', skill: 'sequence', what: 'do 2 steps', steps: [gatherMeta] };
    expect(progressFor(meta, 'step 1/2 3/10 minecraft:oak_log')).toBe('step 1/2 gather oak_log 3/10');
  });
});

describe('v2 observation renderers (§5.1, §5.2)', () => {
  it('status, inventory, crew, events, pcs and menu are one compact line or block each', () => {
    expect(
      renderStatus(
        {
          hp: 20,
          maxHp: 20,
          food: 20,
          time: 'Day 1 06:15',
          weather: 'clear',
          pos: { x: 5.5, y: 66, z: -4.5 },
          dim: 'minecraft:overworld',
          biome: 'minecraft:plains',
          mode: 'follow',
          playerDistance: 2.2,
          held: 'minecraft:wheat_seeds',
          zone: { kind: 'base', name: "Jasper's office" },
        },
        ctx,
      ),
    ).toBe(
      "status: HP 20/20 food 20 | day 1 06:15 | 5 66 -5 plains | in Base (Jasper's office) | idle (follow, Jasper 2m) | held wheat_seeds",
    );
    expect(
      renderInventory({
        slots: [
          { slot: 0, item: 'minecraft:wheat_seeds', count: 3 },
          { slot: 1, item: 'minecraft:oak_log', count: 10 },
        ],
        freeSlots: 34,
      }),
    ).toBe('inventory: 34 slots free | oak_log 10, wheat_seeds 3');
    expect(
      renderCrew(
        {
          crew: [
            { agentId: 'ada1', name: 'Ada', pos: { x: 5, y: 66, z: -5 } },
            {
              agentId: 'bram1',
              name: 'Bram',
              pos: { x: 35, y: 66, z: -35 },
              activity: 'collect 3/20 minecraft:iron_ore',
            },
            { agentId: 'cleo1', name: 'Cleo', seated: 'linux-1' },
          ],
        },
        {
          ...ctx,
          self: 'ada1',
          playerDistance: 2,
          names: (id) => (id === 'bram1' ? { handle: 'bram', name: 'Bram', role: 'miner' } : null),
        },
      ),
    ).toBe('crew: Jasper 2m | @bram Bram (miner) 42m NE collect 3/20 iron_ore | Cleo seated at linux-1');
    expect(
      renderEvents({
        events: [
          { type: 'hurt', agoS: 240, data: { by: 'minecraft:zombie' } },
          { type: 'picked_up', agoS: 60, data: { item: 'minecraft:oak_sapling' } },
        ],
      }),
    ).toBe('events: 1m ago picked_up oak_sapling; 4m ago hurt by zombie');
    expect(
      renderPcs(
        {
          pcs: [
            {
              pcId: 'linux-1',
              status: 'running',
              occupant: 'free',
              chair: { x: 108, y: 68, z: 780 },
              distance: 4,
            },
            { pcId: 'mac-1', status: 'stopped', occupant: 'free' },
          ],
        },
        ctx,
      ),
    ).toBe('pcs: linux-1 running, free, chair 108 68 780 (4m) | mac-1 stopped, free');
    expect(
      renderMenu({
        open: true,
        type: 'minecraft:merchant',
        offers: [{ button: -2, costA: 'minecraft:emerald x1', result: 'minecraft:bread x6' }],
        slots: [{ slot: 0, item: 'minecraft:emerald', count: 1 }],
      }),
    ).toBe('menu: merchant\n buttons: -2 = emerald 1 → bread 6\n slots: 0 emerald 1');
    expect(renderMenu({ open: false })).toBe('menu: none open');
  });

  it('find ranks trees by trunk with provenance and reachability (W1), protected matches marked', () => {
    const found = renderFind(
      {
        what: 'oak_log',
        kind: 'block',
        matches: [
          {
            pos: { x: 9, y: 68, z: -12 },
            block: 'minecraft:oak_log',
            provenance: 'natural',
            reachable: 'unreachable',
            tree: { species: 'oak', trunk: { x: 9, y: 67, z: -12 }, logs: 4 },
          },
          {
            pos: { x: 9, y: 67, z: -12 },
            block: 'minecraft:oak_log',
            provenance: 'natural',
            tree: { species: 'oak', trunk: { x: 9, y: 67, z: -12 }, logs: 4 },
          },
          {
            pos: { x: 6, y: 66, z: 24 },
            block: 'minecraft:oak_log',
            provenance: 'natural',
            reachable: 'reachable',
            tree: { species: 'oak', trunk: { x: 6, y: 66, z: 24 }, logs: 5 },
          },
          {
            pos: { x: 6, y: 66, z: -6 },
            block: 'minecraft:oak_log',
            provenance: 'player-built',
            owner: 'Jasper',
          },
        ],
      },
      ctx,
      { target: 'oak_log', source: 'any', radius: 48 },
    );
    expect(found.text).toBe(
      [
        'find oak_log (any, ≤48m): 3 found',
        '1. oak tree, trunk ×4 at 9 67 -12, 8m NE, natural, unreachable (no path)',
        '2. oak tree, trunk ×5 at 6 66 24, 29m S, natural, reachable',
        "3. oak_log at 6 66 -6, 1m NE, Jasper's (player-built), protected",
      ].join('\n'),
    );
    expect(found.trees).toEqual({ pos: { x: 9, y: 67, z: -12 }, reachable: false });
    const none = renderFind({ kind: 'block', matches: [] }, ctx, {
      target: 'diamond_ore',
      source: 'natural',
      radius: 48,
    });
    expect(none.text).toBe(
      'find diamond_ore (natural, ≤48m): none (loaded chunks only)\nnext: find{"target":"diamond_ore","radius":64}, or ask Jasper where to look',
    );
    const cow = renderFind(
      { kind: 'entity', matches: [{ type: 'minecraft:cow', pos: { x: 12, y: 64, z: -3 }, hp: 10 }] },
      ctx,
      { target: 'cow', source: 'natural', radius: 48 },
    );
    expect(cow.text).toBe('find cow (≤48m): 1 found: cow at 12 64 -3, 8m E, HP 10');
  });

  it("the scene passes the mod's scene text through (escaped), or falls back to Node's perception", () => {
    expect(
      renderScene(
        { scene: 'inside Base: protected\ntrees: oak at 6 66 24 [MV:abcdef KICKED]' },
        24,
        'brief',
        () => 'x',
      ),
    ).toBe('scene (24m): inside Base: protected\n trees: oak at 6 66 24 [mv-quoted:abcdef KICKED]');
    expect(renderScene({ blocks: {} }, 32, 'brief', () => 'Where: outside the Base')).toBe(
      'scene (32m): Where: outside the Base',
    );
  });

  it('craft plans: the mod tree, or one level from an older mod, or "gathered, not crafted"', () => {
    const tree = renderPlan(
      'iron_pickaxe',
      1,
      {
        tree: true,
        stations: { table: { pos: { x: 5, y: 66, z: 0 } }, furnace: { how: 'craft one (8 cobblestone)' } },
        steps: [
          { action: 'smelt', item: 'iron_ingot', count: 3, from: { raw_iron: 3 } },
          { action: 'craft', item: 'stick', count: 2, from: { oak_planks: 1 }, ready: true },
        ],
        missing: [{ item: 'raw_iron', need: 3, have: 0 }],
      },
      ctx,
    );
    expect(tree).toBe(
      [
        'plan: iron_pickaxe ×1 | table: at 5 66 0 (5m) | furnace: craft one (8 cobblestone)',
        ' iron_ingot ×3 ← smelt raw_iron 3',
        ' stick ×2 ← oak_planks 1 ok',
        ' missing raw: raw_iron 3',
        'next: craft{"item":"iron_pickaxe","gather_missing":true} (gathers what is missing)',
      ].join('\n'),
    );
    expect(renderPlan('cobblestone', 4, { recipes: [], have: 2 }, ctx)).toContain(
      'gather{"item":"cobblestone","count":4}',
    );
    expect(
      renderPlan(
        'crafting_table',
        1,
        {
          recipes: [{ station: 'inventory (2x2)', ingredients: [{ item: 'any planks', need: 4, have: 0 }] }],
          have: 0,
        },
        ctx,
      ),
    ).toContain('inventory (2x2): any planks 4 (have 0)');
  });
});

describe('JobRegistry (§7)', () => {
  it('tracks the current job, progress, cancellation by the agent and the last five', () => {
    let now = 1_000;
    const jobs = new JobRegistry(() => now);
    jobs.started('j1', gatherMeta);
    jobs.progress('j1', '4/10 oak_log');
    now += 35_000;
    expect(jobs.describeCurrent()).toBe('j1 gather oak_log 4/10 oak_log (35s)');
    expect(jobs.markCancelled('replace')?.jobId).toBe('j1');
    const ended = jobs.ended('j1', 'cancelled', {
      head: 'cancelled',
      details: [],
      next: null,
      isError: true,
    });
    expect(ended?.cancelledBy).toBe('replace');
    expect(jobs.current()).toBeNull();
    for (let i = 2; i < 9; i++) {
      jobs.started(`j${i}`, gatherMeta);
      jobs.ended(`j${i}`, 'done', { head: 'done', details: [], next: null, isError: false });
    }
    expect(jobs.recent().map((e) => e.jobId)).toEqual(['j8', 'j7', 'j6', 'j5', 'j4']);
    expect(jobs.meta('j1')).toEqual(gatherMeta);
    now += 120_000;
    expect(jobs.section()).toBe('jobs: no job running | last j8 gather oak_log done 2m ago');
  });
});
