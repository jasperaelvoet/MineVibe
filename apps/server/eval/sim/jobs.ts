/**
 * Skill jobs of the simulated world, mirroring the mod's jobs (`dev.minevibe.agent.job`): the same result keys
 * (`mined`/`items`, `collected`/`have`, `crafted`, `smelted`, `moved`/`contents`, ...), the same failure codes and
 * messages (protocol §7.4.1), and the same blind spots: `mine` and `collect` take the nearest exposed matching block,
 * whoever placed it, which is how `mine #minecraft:logs` ate the player's log house.
 */

import { ApiError } from '../../src/contracts/common.js';
import {
  blockSpec,
  breakTime,
  burnTicks,
  CRAFTING,
  type CraftRecipe,
  FOOD,
  isKnownBlock,
  matches,
  NS,
  normId,
  SMELTING,
  type SmeltRecipe,
  toolOf,
} from './items.js';
import { craftTreeJob, gatherJob, protectedIn, sequenceJob } from './v2.js';
import {
  AIR,
  dist,
  type JobEndSpec,
  type JobLogic,
  type JobNext,
  type JobStep,
  type Pos,
  posKey,
  round1,
  type SimWorld,
  TPS,
  WALK_BPS,
} from './world.js';

const MAX_SKIPS = 8;

function walkTicks(from: Pos, to: Pos): number {
  return Math.round((dist(from, to) / WALK_BPS) * TPS);
}

function short(p: Pos): string {
  return `${p.x}, ${p.y}, ${p.z}`;
}

function pos(p: Pos): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z };
}

function done(result: Record<string, unknown>): { end: JobEndSpec } {
  return { end: { status: 'done', result } };
}

function fail(code: string, msg: string, result: Record<string, unknown> = {}): { end: JobEndSpec } {
  return { end: { status: 'failed', result, error: { code, msg } } };
}

/** Items gained since `before` (the mod's Inv.gained). */
function gained(world: SimWorld, before: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, c] of world.agent.inventory) {
    const d = c - (before.get(id) ?? 0);
    if (d > 0) out[id] = d;
  }
  return out;
}

/** A job from a list of phases: each `next` call runs until a phase returns a step or an end. */
function sequence(next: () => JobNext): JobLogic {
  return { next };
}

/** One-step job: walk/act for `dt` ticks, then end with what `finish` says. */
function oneShot(dt: number, finish: () => { end: JobEndSpec }, effect?: () => void): JobLogic {
  let started = false;
  return sequence(() => {
    if (!started) {
      started = true;
      return { dt, effect };
    }
    return finish();
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Miner (mine, collect)
// -------------------------------------------------------------------------------------------------------------------

/** Item ids whose block is not the item itself (the mod's GatherJobs.DROPS, the part the world uses). */
const DROPS: Readonly<Record<string, readonly string[]>> = {
  [`${NS}cobblestone`]: [`${NS}stone`, `${NS}cobblestone`],
  [`${NS}coal`]: [`${NS}coal_ore`],
  [`${NS}raw_iron`]: [`${NS}iron_ore`],
  [`${NS}dirt`]: [`${NS}dirt`, `${NS}grass_block`],
};

/** Blocks that drop `itemRef` (the mod's GatherJobs.sourcesOf), or null. */
export function sourcesOf(itemRef: string): ((id: string) => boolean) | null {
  const ref = normId(itemRef);
  const preds: ((id: string) => boolean)[] = [];
  if (!ref.startsWith('#') && isKnownBlock(ref)) preds.push((id) => id === ref);
  const extra = DROPS[ref];
  if (extra) preds.push((id) => extra.includes(id));
  if (ref.startsWith('#') && ref.endsWith(':logs')) preds.push((id) => matches('#minecraft:logs', id));
  return preds.length === 0 ? null : (id) => preds.some((p) => p(id));
}

class Miner {
  mined = 0;
  failure: { code: string; msg: string } | null = null;
  readonly #skip = new Set<string>();

  constructor(
    private readonly world: SimWorld,
    private readonly match: (id: string) => boolean,
    private readonly center: Pos | null,
    private readonly radius: number,
    private readonly skill: string,
  ) {}

  /** The next block to break as a step, `none` when nothing reachable is left, or `failed`. */
  next(): JobStep | 'none' | 'failed' {
    const w = this.world;
    const from = this.center ?? w.agent.pos;
    const found = w
      .scan(from, this.radius, this.match)
      .filter(
        (c) => !this.#skip.has(posKey(c.pos)) && blockSpec(c.block.id).hardness >= 0 && w.exposed(c.pos),
      )
      .sort((a, b) => dist(a.pos, from) - dist(b.pos, from))
      .slice(0, 24)
      .sort((a, b) => dist(a.pos, w.agent.pos) - dist(b.pos, w.agent.pos));
    const target = found[0];
    if (!target) return 'none';
    if (w.isUnreachable(target.pos)) {
      this.#skip.add(posKey(target.pos));
      if (this.#skip.size > MAX_SKIPS) {
        // The mod's Walk.failure(): `no_path` (Miner: "cannot reach any matching block (no_path)").
        this.failure = { code: 'UNREACHABLE', msg: 'cannot reach any matching block (no_path)' };
        return 'failed';
      }
      return { dt: 2 * TPS };
    }
    const tools = [...w.agent.inventory.keys()].filter((id) => toolOf(id) !== null);
    const t = breakTime(target.block.id, tools);
    if (!t.harvest) {
      this.failure = {
        code: 'NEEDS_TOOL',
        msg: `breaking ${target.block.id} drops nothing without the right tool`,
      };
      return 'failed';
    }
    const best = tools.find((id) => toolOf(id)?.kind === blockSpec(target.block.id).tool);
    const dt = walkTicks(w.agent.pos, target.pos) + Math.round((t.seconds + 0.5) * TPS);
    return {
      dt,
      effect: () => {
        const now = w.block(target.pos);
        if (now.id === AIR || !this.match(now.id)) return; // someone else took it
        if (best) w.agent.held = best;
        w.agent.pos = w.standSpot(target.pos);
        w.breakBlock(target.pos, this.skill);
        this.mined++;
        const drop = blockSpec(now.id).drop;
        if (drop && w.freeSlots() > 0) {
          w.give(drop, 1);
          w.agentEvent('picked_up', { item: drop, count: 1 });
        }
      },
    };
  }
}

function mineJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = normId(String(args.block));
  const count = Number(args.count);
  const radius = typeof args.radius === 'number' ? args.radius : 24;
  const near = (args.near as Pos | undefined) ?? null;
  const before = new Map(world.agent.inventory);
  const miner = new Miner(world, (id) => matches(ref, id), near, radius, 'mine');
  const report = () => ({ mined: miner.mined, items: gained(world, before) });
  return sequence(() => {
    if (miner.mined >= count) return done(report());
    const step = miner.next();
    if (step === 'none') {
      return miner.mined < count
        ? fail('NOT_FOUND', `found only ${miner.mined} of ${count} ${ref} in range`, report())
        : done(report());
    }
    if (step === 'failed') {
      const f = miner.failure as { code: string; msg: string };
      return fail(f.code, f.msg, report());
    }
    return { ...step, progress: [miner.mined / count, `${miner.mined}/${count} ${ref}`] };
  });
}

function collectJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = normId(String(args.item));
  const count = Number(args.count);
  const radius = typeof args.radius === 'number' ? args.radius : 24;
  const match = (id: string) => matches(ref, id);
  const start = world.count(match);
  const before = new Map(world.agent.inventory);
  const sources = sourcesOf(ref);
  const miner = sources ? new Miner(world, sources, null, radius, 'collect') : null;
  const report = (got: number) => ({
    collected: Math.max(0, got),
    have: world.count(match),
    items: gained(world, before),
  });
  return sequence(() => {
    const got = world.count(match) - start;
    if (got >= count) return done(report(got));
    if (world.freeSlots() === 0) return fail('INVENTORY_FULL', `no room for more ${ref}`, report(got));
    if (!miner) {
      return fail(
        'NOT_FOUND',
        `no loose ${ref} nearby, and it is not dropped by any block MineVibe knows`,
        report(got),
      );
    }
    const step = miner.next();
    if (step === 'none') {
      return fail(
        'NOT_FOUND',
        `collected ${Math.max(0, got)} of ${count}; no more ${ref} sources within ${radius} blocks`,
        report(got),
      );
    }
    if (step === 'failed') {
      const f = miner.failure as { code: string; msg: string };
      return fail(f.code, f.msg, report(got));
    }
    return { ...step, progress: [Math.max(0, got) / count, `${Math.max(0, got)}/${count} ${ref}`] };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Crafting and smelting
// -------------------------------------------------------------------------------------------------------------------

/** How many times the agent can craft `recipe` with what it carries. */
export function craftable(world: SimWorld, recipe: CraftRecipe): number {
  let n = Number.POSITIVE_INFINITY;
  for (const ing of recipe.ingredients) {
    n = Math.min(n, Math.floor(world.count((id) => matches(ing.ref, id)) / ing.count));
  }
  return Number.isFinite(n) ? n : 0;
}

export function ingredientsOf(world: SimWorld, recipe: CraftRecipe): Record<string, unknown>[] {
  return recipe.ingredients.map((ing) => ({
    item: ing.ref,
    need: ing.count,
    have: world.count((id) => matches(ing.ref, id)),
  }));
}

function missingText(world: SimWorld, recipe: CraftRecipe): string {
  return recipe.ingredients
    .map((ing) => `${ing.count} ${ing.ref} (have ${world.count((id) => matches(ing.ref, id))})`)
    .join(', ');
}

/** A free spot next to the agent for a table or furnace. */
function freeSpotNear(world: SimWorld): Pos | null {
  const a = world.agent.pos;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
  ] as const) {
    const p = { x: a.x + dx, y: a.y, z: a.z + dz };
    if (world.isAir(p) && !world.isAir({ ...p, y: p.y - 1 })) return p;
  }
  return null;
}

/** The nearest block of `id` within `radius` of the agent. */
function nearestBlock(world: SimWorld, pred: (id: string) => boolean, radius: number): Pos | null {
  const a = world.agent.pos;
  const found = world.scan(a, radius, pred).sort((x, y) => dist(x.pos, a) - dist(y.pos, a));
  return found[0]?.pos ?? null;
}

function craftJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const item = normId(String(args.item));
  const count = Number(args.count);
  const requested = (args.table as Pos | undefined) ?? null;
  const result: Record<string, unknown> = {};
  let recipe: CraftRecipe | null = null;
  let phase: 'plan' | 'table' | 'craft' = 'plan';
  let table: Pos | null = null;
  let crafted = 0;
  const finish = () => {
    if (table) result.table = pos(table);
    result.crafted = crafted;
    result.item = item;
    result.have = world.count((id) => id === item);
    return done(result);
  };
  return sequence(() => {
    if (phase === 'plan') {
      const recipes = CRAFTING.filter((r) => r.result === item);
      const first = recipes[0];
      if (!first) return fail('NO_RECIPE', `nothing crafts ${item}`);
      recipe = recipes.find((r) => craftable(world, r) > 0) ?? null;
      if (!recipe) {
        result.ingredients = ingredientsOf(world, first);
        return fail(
          'MISSING_INGREDIENTS',
          `missing ingredients for ${item}: ${missingText(world, first)}`,
          result,
        );
      }
      result.recipe = recipe.id;
      phase = recipe.small && requested === null ? 'craft' : 'table';
      return { dt: 2 };
    }
    if (phase === 'table') {
      if (requested) {
        if (world.block(requested).id !== `${NS}crafting_table`)
          return fail('NO_TABLE', `no crafting table at ${short(requested)}`, result);
        if (world.isUnreachable(requested))
          return fail('UNREACHABLE', `cannot reach the crafting table at ${short(requested)}`, result);
        table = requested;
      } else {
        const near = nearestBlock(world, (id) => id === `${NS}crafting_table`, 24);
        const ownTable = world.count((id) => id === `${NS}crafting_table`) > 0;
        if (near && !(world.isUnreachable(near) && ownTable)) {
          if (world.isUnreachable(near))
            return fail('UNREACHABLE', `cannot reach the crafting table at ${short(near)}`, result);
          table = near;
        } else if (ownTable) {
          const spot = freeSpotNear(world);
          if (!spot) return fail('NO_ROOM', 'no free spot next to the agent to put a crafting table', result);
          world.take((id) => id === `${NS}crafting_table`, 1);
          world.placeBlock(spot, `${NS}crafting_table`);
          result.placedTable = pos(spot);
          table = spot;
        } else {
          return fail(
            'NEEDS_TABLE',
            `${item} needs a crafting table: craft one (4 planks) or stand near one`,
            result,
          );
        }
      }
      phase = 'craft';
      const at = table;
      return {
        dt: walkTicks(world.agent.pos, at) + 10,
        effect: () => (world.agent.pos = world.standSpot(at)),
      };
    }
    const r = recipe as CraftRecipe;
    if (crafted >= count) return finish();
    if (craftable(world, r) < 1) {
      if (crafted === 0) {
        result.ingredients = ingredientsOf(world, r);
        return fail(
          'MISSING_INGREDIENTS',
          `missing ingredients for ${item}: ${missingText(world, r)}`,
          result,
        );
      }
      result.short = true;
      return finish();
    }
    for (const ing of r.ingredients) world.take((id) => matches(ing.ref, id), ing.count);
    world.give(item, r.makes);
    crafted += r.makes;
    return {
      dt: 10,
      progress: [Math.min(crafted, count) / count, `${crafted}/${count} ${item.slice(NS.length)}`],
    };
  });
}

/** Fuel candidates in preference order: coal, charcoal, planks, logs (never the item being smelted). */
function fuelFor(world: SimWorld, fuelRef: string | null, input: string): string[] {
  const ids = [...world.agent.inventory.keys()].filter((id) => id !== input && burnTicks(id) > 0);
  if (fuelRef) return ids.filter((id) => matches(fuelRef, id));
  const rank = (id: string) => (burnTicks(id) >= 1600 ? 0 : matches('#minecraft:planks', id) ? 1 : 2);
  return ids.sort((a, b) => rank(a) - rank(b));
}

function smeltJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = normId(String(args.item));
  const count = Number(args.count);
  const fuelRef = typeof args.fuel === 'string' ? normId(args.fuel) : null;
  const requested = (args.furnace as Pos | undefined) ?? null;
  const result: Record<string, unknown> = {};
  let phase: 'plan' | 'furnace' | 'smelt' = 'plan';
  let recipe: SmeltRecipe | null = null;
  let input = '';
  let toSmelt = 0;
  let smelted = 0;
  let furnace: Pos | null = null;
  let burnLeft = 0;
  let fuelUsed: string | null = null;
  const output = () => recipe?.result ?? ref;
  const finish = () => {
    result.smelted = smelted;
    result.item = output();
    if (furnace) result.furnace = pos(furnace);
    if (fuelUsed) result.fuel = fuelUsed;
    return done(result);
  };
  return sequence(() => {
    if (phase === 'plan') {
      const asOutput = SMELTING.filter((r) => r.result === ref);
      const asInput = SMELTING.filter((r) => matches(r.input, ref));
      const candidates = asOutput.length > 0 ? asOutput : asInput;
      if (candidates.length === 0) return fail('NO_RECIPE', `${ref} cannot be smelted`);
      for (const r of candidates) {
        const have = [...world.agent.inventory.keys()].find((id) =>
          asOutput.length > 0 ? matches(r.input, id) : id === ref,
        );
        if (have) {
          recipe = r;
          input = have;
          break;
        }
      }
      if (!recipe) return fail('NO_ITEM', `nothing to smelt for ${ref} in the inventory`);
      const have = world.count((id) => id === input);
      toSmelt = Math.min(count, have);
      if (toSmelt < count) result.note = `only ${have} ${input} to smelt`;
      phase = 'furnace';
      return { dt: 2 };
    }
    if (phase === 'furnace') {
      if (requested) {
        if (world.block(requested).id !== `${NS}furnace`)
          return fail('NO_FURNACE', `no furnace at ${short(requested)}`, result);
        furnace = requested;
      } else {
        furnace = nearestBlock(world, (id) => id === `${NS}furnace`, 24);
        if (!furnace) {
          if (world.count((id) => id === `${NS}furnace`) === 0)
            return fail(
              'NEEDS_FURNACE',
              'no furnace nearby: craft one (8 cobblestone) or stand near one',
              result,
            );
          const spot = freeSpotNear(world);
          if (!spot) return fail('NO_ROOM', 'no free spot next to the agent to put a furnace', result);
          world.take((id) => id === `${NS}furnace`, 1);
          world.placeBlock(spot, `${NS}furnace`);
          result.placedFurnace = pos(spot);
          furnace = spot;
        }
      }
      if (world.isUnreachable(furnace))
        return fail('UNREACHABLE', `cannot reach the furnace at ${short(furnace)}`, result);
      if (fuelFor(world, fuelRef, input).length === 0) {
        return fail(
          'NO_FUEL',
          fuelRef
            ? `no ${fuelRef} in the inventory`
            : 'no fuel (coal, charcoal, logs, planks...) in the inventory',
          result,
        );
      }
      phase = 'smelt';
      const at = furnace;
      return {
        dt: walkTicks(world.agent.pos, at) + 10,
        effect: () => (world.agent.pos = world.standSpot(at)),
      };
    }
    if (smelted >= toSmelt) return finish();
    if (burnLeft < 200) {
      const fuel = fuelFor(world, fuelRef, input)[0];
      if (!fuel) {
        result.smelted = smelted;
        result.item = output();
        if (furnace) result.furnace = pos(furnace);
        return fail('NO_FUEL', `the fuel ran out after ${smelted} of ${toSmelt}`, result);
      }
      world.take((id) => id === fuel, 1);
      fuelUsed = fuel;
      burnLeft += burnTicks(fuel);
    }
    burnLeft -= 200;
    return {
      dt: 200,
      effect: () => {
        world.take((id) => id === input, 1);
        world.give(output(), 1);
        smelted++;
      },
      progress: [smelted / toSmelt, `${smelted}/${toSmelt} ${output().slice(NS.length)}`],
    };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Containers, placing, using
// -------------------------------------------------------------------------------------------------------------------

const CHEST_SLOTS = 27;

function contentsOf(items: ReadonlyMap<string, number>): Record<string, unknown> {
  const sorted = Object.fromEntries([...items].sort(([a], [b]) => a.localeCompare(b)));
  let used = 0;
  for (const [id, c] of items) used += Math.ceil(c / 64) + (id ? 0 : 0);
  return { items: sorted, freeSlots: Math.max(0, CHEST_SLOTS - used) };
}

function containerJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  // v2 mod (container.nearest): without pos, the nearest chest or barrel within 24 blocks.
  const at =
    (args.pos as Pos | undefined) ??
    nearestBlock(world, (id) => id === `${NS}chest` || id === `${NS}barrel`, 24) ??
    null;
  if (!at) return oneShot(2, () => fail('NOT_FOUND', 'no chest or barrel within 24 blocks'));
  const action = String(args.action);
  const ref = typeof args.item === 'string' ? normId(args.item) : null;
  const count = typeof args.count === 'number' ? args.count : 0;
  return sequence(
    (() => {
      let walked = false;
      return (): JobNext => {
        if (world.isAir(at)) return fail('NOT_FOUND', `no container at ${short(at)}`);
        if (world.isUnreachable(at)) return fail('UNREACHABLE', `cannot get within reach of ${short(at)}`);
        const items = world.containers.get(posKey(at));
        if (!items) return fail('NOT_A_CONTAINER', `${world.block(at).id} has no inventory to open`);
        if (!walked) {
          walked = true;
          return {
            dt: walkTicks(world.agent.pos, at) + TPS,
            effect: () => (world.agent.pos = world.standSpot(at)),
          };
        }
        // The v2 mod says which container it used (container.nearest).
        const result: Record<string, unknown> = world.mod === 'v2' ? { pos: pos(at) } : {};
        const match = (id: string) => ref !== null && matches(ref, id);
        if (action === 'put') {
          const have = world.count(match);
          if (have === 0) return fail('NO_ITEM', `no ${ref} in the inventory`);
          const want = count > 0 ? Math.min(count, have) : have;
          let room = (CHEST_SLOTS - world.slotsUsed(items)) * 64;
          for (const [id, c] of items) if (match(id)) room += (64 - (c % 64)) % 64;
          const moved = Math.min(want, Math.max(0, room));
          for (const [id, n] of world.take(match, moved)) items.set(id, (items.get(id) ?? 0) + n);
          result.moved = moved;
          result.item = ref;
          if (moved < want) result.full = true;
        } else if (action === 'take') {
          let there = 0;
          for (const [id, c] of items) if (match(id)) there += c;
          if (there === 0) return fail('NOT_FOUND', `no ${ref} in the container`);
          const want = count > 0 ? Math.min(count, there) : there;
          const moved = Math.min(want, world.freeSlots() * 64);
          let left = moved;
          for (const [id, c] of [...items]) {
            if (left <= 0 || !match(id)) continue;
            const n = Math.min(c, left);
            left -= n;
            if (c - n > 0) items.set(id, c - n);
            else items.delete(id);
            world.give(id, n);
          }
          result.moved = moved;
          result.item = ref;
          if (moved < want) result.inventoryFull = true;
        }
        result.contents = contentsOf(items);
        return done(result);
      };
    })(),
  );
}

function placeJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const id = normId(String(args.block));
  const at = args.pos as Pos;
  if (world.count((i) => i === id) === 0)
    return oneShot(2, () => fail('NO_ITEM', `no ${id} in the inventory`));
  if (world.isUnreachable(at))
    return oneShot(2 * TPS, () => fail('UNREACHABLE', `cannot get within reach of ${short(at)}`));
  const there = world.block(at);
  if (!world.isReplaceable(at))
    return oneShot(2, () => fail('OCCUPIED', `${there.id} is already at ${short(at)}`));
  const supported = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ].some(([dx, dy, dz]) => !world.isAir({ x: at.x + (dx ?? 0), y: at.y + (dy ?? 0), z: at.z + (dz ?? 0) }));
  if (!supported)
    return oneShot(2, () => fail('NO_SUPPORT', `nothing to place ${id} against at ${short(at)}`));
  return oneShot(
    walkTicks(world.agent.pos, at) + 5,
    () => done({ placed: world.block(at).id, pos: pos(at) }),
    () => {
      world.agent.pos = world.standSpot(at);
      world.take((i) => i === id, 1);
      world.placeBlock(at, id);
    },
  );
}

function digJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const a = args.from as Pos;
  const b = args.to as Pos;
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
  const targets: Pos[] = [];
  for (let y = max.y; y >= min.y; y--)
    for (let x = min.x; x <= max.x; x++) for (let z = min.z; z <= max.z; z++) targets.push({ x, y, z });
  const before = new Map(world.agent.inventory);
  let dug = 0;
  let i = 0;
  if (targets.length > 512) return oneShot(1, () => fail('BAD_ARGS', 'the box is larger than 512 blocks'));
  return sequence(() => {
    while (i < targets.length && world.isAir(targets[i] as Pos)) i++;
    const t = targets[i++];
    if (!t) return done({ dug, items: gained(world, before) });
    if (world.isUnreachable(t))
      return fail('UNREACHABLE', `cannot get within reach of ${short(t)}`, {
        dug,
        items: gained(world, before),
      });
    const tools = [...world.agent.inventory.keys()].filter((id) => toolOf(id) !== null);
    const bt = breakTime(world.block(t).id, tools);
    if (!Number.isFinite(bt.seconds)) return { dt: 1 };
    return {
      dt: walkTicks(world.agent.pos, t) + Math.round(bt.seconds * TPS),
      effect: () => {
        const b = world.block(t);
        if (b.id === AIR) return;
        world.breakBlock(t, 'dig');
        dug++;
        const drop = blockSpec(b.id).drop;
        if (drop && bt.harvest) world.give(drop, 1);
      },
    };
  });
}

function useBlockJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const at = args.pos as Pos;
  const b = world.block(at);
  if (b.id === AIR) return oneShot(2, () => fail('NOT_FOUND', `nothing at ${short(at)}`));
  if (world.isUnreachable(at))
    return oneShot(2 * TPS, () => fail('UNREACHABLE', `cannot get within reach of ${short(at)}`));
  const menus: Record<string, string> = {
    [`${NS}chest`]: 'minecraft:generic_9x3',
    [`${NS}crafting_table`]: 'minecraft:crafting',
    [`${NS}furnace`]: 'minecraft:furnace',
  };
  const usable = menus[b.id] !== undefined || b.id.endsWith('_door') || b.id.endsWith('_bed');
  return oneShot(
    walkTicks(world.agent.pos, at) + 5,
    () =>
      done({
        block: b.id,
        result: usable ? 'used' : 'nothing happened',
        ...(menus[b.id] ? { menu: menus[b.id] } : {}),
      }),
    () => (world.agent.pos = world.standSpot(at)),
  );
}

// -------------------------------------------------------------------------------------------------------------------
// Combat, items, body
// -------------------------------------------------------------------------------------------------------------------

function isPersonRef(ref: string, world: SimWorld): boolean {
  return (
    ref === 'player' || ref === world.agent.agentId || ref.toLowerCase() === world.player.name.toLowerCase()
  );
}

function findMob(world: SimWorld, ref: string, radius: number) {
  const type = ref.includes('-') && ref.length > 30 ? null : normId(ref);
  return world.mobs
    .filter((m) => m.alive && (m.id === ref || m.type === type) && dist(m.pos, world.agent.pos) <= radius)
    .sort((a, b) => dist(a.pos, world.agent.pos) - dist(b.pos, world.agent.pos))[0];
}

function fightTicks(world: SimWorld, hp: number): number {
  const dps = world.agent.held?.endsWith('_sword') ? 6 : 4;
  return Math.ceil(hp / dps) * TPS;
}

function attackJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = String(args.entity);
  if (isPersonRef(ref, world))
    return oneShot(1, () => fail('BAD_TARGET', 'agents never attack players or each other'));
  const mob = findMob(world, ref, 32);
  if (!mob) return oneShot(TPS, () => fail('NOT_FOUND', `cannot find ${ref}`));
  if (world.isUnreachable(mob.pos)) return oneShot(2 * TPS, () => fail('UNREACHABLE', `cannot reach ${ref}`));
  return oneShot(
    walkTicks(world.agent.pos, mob.pos) + fightTicks(world, mob.hp),
    () => (mob.alive ? fail('ESCAPED', `${ref} got away`) : done({ killed: true, target: mob.type })),
    () => {
      if (!mob.alive) return;
      world.agent.pos = world.standSpot(mob.pos);
      mob.alive = false;
      mob.hp = 0;
      world.log('mob_killed', { type: mob.type, by: 'attack' });
      world.agentEvent('killed', { entity: mob.type });
    },
  );
}

function huntJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = String(args.entity);
  const count = Number(args.count);
  const radius = typeof args.radius === 'number' ? args.radius : 32;
  const before = new Map(world.agent.inventory);
  let killed = 0;
  if (isPersonRef(ref, world))
    return oneShot(1, () => fail('BAD_TARGET', 'agents never attack players or each other'));
  return sequence(() => {
    if (killed >= count) return done({ killed, items: gained(world, before) });
    const mob = findMob(world, ref, radius);
    if (!mob)
      return fail('NOT_FOUND', `killed ${killed} of ${count}; no more ${ref} within ${radius} blocks`, {
        killed,
        items: gained(world, before),
      });
    return {
      dt: walkTicks(world.agent.pos, mob.pos) + fightTicks(world, mob.hp),
      effect: () => {
        world.agent.pos = world.standSpot(mob.pos);
        mob.alive = false;
        killed++;
        world.log('mob_killed', { type: mob.type, by: 'hunt' });
      },
    };
  });
}

function gotoJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const range = typeof args.range === 'number' ? args.range : 1.5;
  let target: Pos | null = (args.pos as Pos | undefined) ?? null;
  let place: string | null = null;
  if (!target && typeof args.entity === 'string') {
    const ref = args.entity;
    const places: Record<string, () => Pos | null> = {
      office: () => world.agent.home,
      home: () => world.agent.home,
      spawn: () => ({ x: 0, y: 64, z: 0 }),
      bed: () => nearestBlock(world, (id) => matches('#minecraft:beds', id), 48),
      chest: () => nearestBlock(world, (id) => id === `${NS}chest`, 48),
      crafting_table: () => nearestBlock(world, (id) => id === `${NS}crafting_table`, 48),
      furnace: () => nearestBlock(world, (id) => id === `${NS}furnace`, 48),
    };
    if (ref === 'player' || ref.toLowerCase() === world.player.name.toLowerCase()) target = world.player.pos;
    else if (places[ref]) {
      place = ref;
      target = places[ref]();
      if (!target) return oneShot(TPS, () => fail('NOT_FOUND', `no ${ref} near ${short(world.agent.pos)}`));
    } else if (ref.startsWith('pc:') || ref === 'codex') {
      return oneShot(TPS, () => fail('NOT_FOUND', `no ${ref} near ${short(world.agent.pos)}`));
    } else {
      const mob = findMob(world, ref, 64);
      if (!mob) return oneShot(TPS, () => fail('NOT_FOUND', `cannot find ${ref}`));
      target = mob.pos;
    }
  }
  const goal = target as Pos;
  if (world.isUnreachable(goal)) {
    // GotoSkillJob: "no path to <block pos | entity ref> (<Walk.failure()>)".
    const what = place === null && typeof args.entity === 'string' ? args.entity : short(goal);
    return oneShot(3 * TPS, () => fail('UNREACHABLE', `no path to ${what} (no_path)`));
  }
  return oneShot(
    walkTicks(world.agent.pos, goal),
    () => {
      const result: Record<string, unknown> = {};
      if (place) result.place = place;
      result.pos = pos(world.agent.pos);
      result.distance = round1(dist(world.agent.pos, goal));
      return done(result);
    },
    () => {
      world.agent.pos = range <= 1.5 ? world.standSpot(goal) : world.standSpot(goal);
    },
  );
}

function equipJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const id = normId(String(args.item));
  const slot = typeof args.slot === 'string' ? args.slot : 'mainhand';
  return oneShot(5, () => {
    const have = [...world.agent.inventory.keys()].find((i) => matches(id, i));
    if (!have) return fail('NO_ITEM', `no ${id} in the inventory`);
    world.agent.held = have;
    return done({ equipped: have, slot });
  });
}

function eatJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const ref = typeof args.item === 'string' ? normId(args.item) : null;
  return oneShot(32, () => {
    const foods = [...world.agent.inventory.keys()].filter(
      (i) => FOOD[i] !== undefined && (!ref || matches(ref, i)),
    );
    if (world.agent.food >= 20) return fail('NOT_HUNGRY', 'food is full');
    const food = foods[0];
    if (!food) return fail('NO_FOOD', ref ? `no edible ${ref} in the inventory` : 'no food in the inventory');
    world.take((i) => i === food, 1);
    world.agent.food = Math.min(20, world.agent.food + (FOOD[food] ?? 0));
    return done({ ate: food, food: world.agent.food, hp: world.agent.hp });
  });
}

function sleepJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  if (!world.isNight())
    return oneShot(5, () => fail('NOT_NIGHT', 'you can only sleep at night (or in a thunderstorm)'));
  const at = (args.pos as Pos | undefined) ?? nearestBlock(world, (id) => matches('#minecraft:beds', id), 32);
  if (!at) return oneShot(5, () => fail('NO_BED', 'no bed within 32 blocks'));
  if (!matches('#minecraft:beds', world.block(at).id))
    return oneShot(5, () => fail('NO_BED', `no bed at ${short(at)}`));
  return oneShot(
    walkTicks(world.agent.pos, at) + 2 * TPS,
    () => done({ slept: true, clockTime: world.clock }),
    () => (world.agent.pos = world.standSpot(at)),
  );
}

function dropJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const id = normId(String(args.item));
  const count = typeof args.count === 'number' ? args.count : Number.MAX_SAFE_INTEGER;
  return oneShot(5, () => {
    const taken = world.take((i) => matches(id, i), count);
    const n = [...taken.values()].reduce((s, c) => s + c, 0);
    if (n === 0) return fail('NO_ITEM', `no ${id} in the inventory`);
    world.log('dropped', { item: id, count: n });
    return done({ dropped: n, item: id });
  });
}

function giveJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const id = normId(String(args.item));
  // v2 mod (give.all): without count, everything of the item.
  const count = typeof args.count === 'number' ? args.count : world.count((i) => matches(id, i));
  const to = String(args.to);
  if (to !== 'player' && to.toLowerCase() !== world.player.name.toLowerCase())
    return oneShot(TPS, () => fail('NOT_FOUND', `cannot find ${to}`));
  return oneShot(
    walkTicks(world.agent.pos, world.player.pos) + 10,
    () => {
      const taken = world.take((i) => matches(id, i), count);
      let n = 0;
      for (const [i, c] of taken) {
        n += c;
        world.player.received.set(i, (world.player.received.get(i) ?? 0) + c);
      }
      if (n === 0) return fail('NO_ITEM', `no ${id} in the inventory`);
      return done({ gave: n, item: id, to });
    },
    () => (world.agent.pos = world.standSpot(world.player.pos)),
  );
}

/**
 * Building blocks for blueprint walls (the mod's BuildJob.isBuildingBlock: full-cube block items that are not block
 * entities, falling blocks, leaves, crafting tables or blocks with an axis). Logs have an axis, so they never count:
 * a shelter needs planks, cobblestone, dirt or stone.
 */
function isBuildMaterial(id: string): boolean {
  return (
    id === `${NS}dirt` || id === `${NS}cobblestone` || id === `${NS}stone` || matches('#minecraft:planks', id)
  );
}

type StepKind = 'solid' | 'clear' | 'torch';

interface Blueprint {
  /** Steps in build order (BuildJob.plan at rotation 0; `at` rotates them). */
  readonly steps: readonly { readonly kind: StepKind; readonly at: Pos }[];
  /** The space it shelters once every solid step stands (relative to the origin). */
  readonly interior: { readonly min: Pos; readonly max: Pos } | null;
}

/** The mod's built-in blueprints (BuildJob.plan) that the eval world simulates. */
function blueprint(name: string): Blueprint | null {
  const steps: { kind: StepKind; at: Pos }[] = [];
  if (name === 'shelter') {
    // A 5x5 hut: walls 3 high with a 2-high door gap facing north, the inside cleared first, a roof, a torch.
    for (let y = 0; y <= 2; y++)
      for (let x = -2; x <= 2; x++)
        for (let z = -2; z <= 2; z++) {
          const wall = Math.abs(x) === 2 || Math.abs(z) === 2;
          const door = x === 0 && z === -2 && y <= 1;
          steps.push({ kind: wall && !door ? 'solid' : 'clear', at: { x, y, z } });
        }
    const roof: { kind: StepKind; at: Pos }[] = [];
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++) roof.push({ kind: 'solid', at: { x, y: 3, z } });
    roof.sort(
      (a, b) => Math.max(Math.abs(b.at.x), Math.abs(b.at.z)) - Math.max(Math.abs(a.at.x), Math.abs(a.at.z)),
    );
    steps.push(...roof, { kind: 'torch', at: { x: 1, y: 0, z: 1 } });
    steps.sort((a, b) => (a.kind === 'clear' ? 0 : 1) - (b.kind === 'clear' ? 0 : 1));
    return { steps, interior: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } } };
  }
  if (name === 'wall_ring') {
    for (let y = 0; y <= 1; y++)
      for (let x = -4; x <= 4; x++)
        for (let z = -4; z <= 4; z++)
          if (Math.abs(x) === 4 || Math.abs(z) === 4) steps.push({ kind: 'solid', at: { x, y, z } });
    return { steps, interior: { min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 2, z: 3 } } };
  }
  if (name === 'torch_ring') {
    for (const [x, z] of [
      [5, 0],
      [4, 4],
      [0, 5],
      [-4, 4],
      [-5, 0],
      [-4, -4],
      [0, -5],
      [4, -4],
    ] as const)
      steps.push({ kind: 'torch', at: { x, y: 0, z } });
    return { steps, interior: null };
  }
  return null;
}

export const BUILTIN_BLUEPRINTS = [
  'shelter',
  'wall_ring',
  'torch_ring',
  'bridge',
  'stairs_down',
  'farm_plot',
];

/** BuildJob.at: (x, z) turned clockwise around the origin. */
function rotate(origin: Pos, rotation: number, p: Pos): Pos {
  switch (rotation) {
    case 90:
      return { x: origin.x - p.z, y: origin.y + p.y, z: origin.z + p.x };
    case 180:
      return { x: origin.x - p.x, y: origin.y + p.y, z: origin.z - p.z };
    case 270:
      return { x: origin.x + p.z, y: origin.y + p.y, z: origin.z - p.x };
    default:
      return { x: origin.x + p.x, y: origin.y + p.y, z: origin.z + p.z };
  }
}

function buildJob(world: SimWorld, args: Record<string, unknown>): JobLogic {
  const name = String(args.blueprint);
  const origin = args.origin as Pos;
  const rotation = typeof args.rotation === 'number' ? args.rotation : 0;
  const bp = blueprint(name);
  if (!bp)
    return oneShot(1, () => fail('FAILED', `the ${name} blueprint is not simulated in the eval world`));
  const steps = bp.steps.map((s) => ({ kind: s.kind, at: rotate(origin, rotation, s.at) }));
  const isClear = (p: Pos) => world.isReplaceable(p);
  const satisfied = (st: { kind: StepKind; at: Pos }) =>
    st.kind === 'solid'
      ? !world.isReplaceable(st.at)
      : st.kind === 'torch'
        ? world.block(st.at).id === `${NS}torch`
        : isClear(st.at);
  const result: Record<string, unknown> = {};
  let placed = 0;
  let dug = 0;
  let skipped = 0;
  let i = 0;
  let checked = false;
  const shelterIfStanding = () => {
    if (!bp.interior || !steps.every((st) => st.kind !== 'solid' || satisfied(st))) return;
    const a = rotate(origin, rotation, bp.interior.min);
    const b = rotate(origin, rotation, bp.interior.max);
    world.shelters.push({
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
    });
    if (world.isSheltered(world.player.pos)) world.player.sheltered = true;
  };
  return sequence(() => {
    if (!checked) {
      // BuildJob.precheck: enough building blocks (and torches for a torch ring) for the steps still to do.
      checked = true;
      const solids = steps.filter((st) => st.kind === 'solid' && !satisfied(st)).length;
      const torches = steps.filter((st) => st.kind === 'torch' && !satisfied(st)).length;
      const haveBlocks = world.count(isBuildMaterial);
      const haveTorches = world.count((id) => id === `${NS}torch`);
      result.needBlocks = solids;
      if (solids > haveBlocks)
        return fail(
          'NO_MATERIAL',
          `${name} needs ${solids} building blocks (dirt, cobblestone, planks...), have ${haveBlocks}`,
          result,
        );
      if (name === 'torch_ring' && torches > haveTorches)
        return fail('NO_MATERIAL', `torch_ring needs ${torches} torches, have ${haveTorches}`, result);
      return {
        dt: walkTicks(world.agent.pos, origin),
        effect: () => (world.agent.pos = world.standSpot(origin)),
      };
    }
    while (i < steps.length && satisfied(steps[i] as { kind: StepKind; at: Pos })) i++;
    const st = steps[i];
    if (!st) {
      shelterIfStanding();
      Object.assign(result, { blueprint: name, origin: pos(origin), placed, dug, skipped });
      return done(result);
    }
    const progress: [number, string] = [i / steps.length, `${name}: step ${i + 1}/${steps.length}`];
    if (st.kind === 'clear') {
      const b = world.block(st.at);
      if (blockSpec(b.id).hardness < 0) {
        skipped++;
        i++;
        return { dt: 1, progress };
      }
      return {
        dt: 5,
        progress,
        effect: () => {
          world.breakBlock(st.at, 'build');
          dug++;
          const drop = blockSpec(b.id).drop;
          const tools = [...world.agent.inventory.keys()].filter((id) => toolOf(id) !== null);
          if (drop && breakTime(b.id, tools).harvest) world.give(drop, 1);
        },
      };
    }
    const material = st.kind === 'torch' ? (id: string) => id === `${NS}torch` : isBuildMaterial;
    if (world.count(material) === 0 && st.kind === 'torch' && name !== 'torch_ring') {
      // BuildJob: a shelter's torch only lights the inside; without one the build goes on and ends done with a note.
      result.note = 'no torch carried: the inside stays dark';
      i++;
      return { dt: 1, progress };
    }
    if (world.count(material) === 0) {
      // BuildJob.finishShort: what stands stays.
      shelterIfStanding();
      Object.assign(result, { blueprint: name, placed, dug });
      return fail(
        'NO_MATERIAL',
        `${st.kind === 'torch' ? 'out of torches' : 'out of building blocks'} after ${placed} blocks`,
        result,
      );
    }
    return {
      dt: 5,
      progress,
      effect: () => {
        const [id] = world.take(material, 1).keys();
        if (!id) return;
        world.placeBlock(st.at, id);
        placed++;
      },
    };
  });
}

/** Builds the job logic of `skill` (args already validated against `SkillArgs`). */
export function buildJobLogic(world: SimWorld, skill: string, args: Record<string, unknown>): JobLogic {
  if (world.mod === 'v2') {
    const v2 = buildV2Logic(world, skill, args);
    if (v2) return v2;
  }
  switch (skill) {
    case 'goto':
      return gotoJob(world, args);
    case 'mine':
      return mineJob(world, args);
    case 'collect':
      return collectJob(world, args);
    case 'craft':
      return craftJob(world, args);
    case 'smelt':
      return smeltJob(world, args);
    case 'container':
      return containerJob(world, args);
    case 'place':
      return placeJob(world, args);
    case 'dig':
      return digJob(world, args);
    case 'use_block':
      return useBlockJob(world, args);
    case 'attack':
      return attackJob(world, args);
    case 'hunt':
      return huntJob(world, args);
    case 'equip':
      return equipJob(world, args);
    case 'eat':
      return eatJob(world, args);
    case 'sleep':
      return sleepJob(world, args);
    case 'drop':
      return dropJob(world, args);
    case 'give':
      return giveJob(world, args);
    case 'build': {
      const name = String(args.blueprint);
      if (!BUILTIN_BLUEPRINTS.includes(name)) throw new ApiError('UNKNOWN_BLUEPRINT', `no blueprint ${name}`);
      return buildJob(world, args);
    }
    case 'pickup':
      return oneShot(TPS, () => done({ picked: {} }));
    case 'emote':
    case 'dismount':
    case 'menu_close':
      return oneShot(5, () => done({}));
    case 'use_item':
      return oneShot(5, () => done({ item: world.agent.held ?? 'nothing', result: 'nothing happened' }));
    default:
      return oneShot(5, () => fail('FAILED', `${skill} is not simulated in the eval world`));
  }
}

/**
 * The v2 mod's skills (W1 world awareness plus tools-v2-mc.md M1-M8): natural-only gathering, the craft tree,
 * sequences, and PROTECTED for what a player built. Null: the v1 logic applies.
 */
function buildV2Logic(world: SimWorld, skill: string, args: Record<string, unknown>): JobLogic | null {
  switch (skill) {
    case 'collect':
      return gatherJob(world, args, 'collect');
    case 'mine':
      return gatherJob(world, args, 'mine');
    case 'craft':
      return args.tree === true
        ? craftTreeJob(world, args, {
            craft: (a) => craftJob(world, a),
            smelt: (a) => smeltJob(world, a),
          })
        : null;
    case 'sequence':
      return sequenceJob(args, (s, a) => buildJobLogic(world, s, a));
    case 'dig': {
      const a = args.from as Pos;
      const b = args.to as Pos;
      const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
      const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
      const prot = protectedIn(world, min, max);
      return prot
        ? oneShot(2, () =>
            fail(
              'PROTECTED',
              `${(prot.protected as { count: number }).count} block(s) in the box were built by ${world.player.name}`,
              {
                ...prot,
                dug: 0,
              },
            ),
          )
        : null;
    }
    case 'place': {
      const at = args.pos as Pos;
      const prot = protectedIn(world, at, at);
      return prot
        ? oneShot(2, () =>
            fail('PROTECTED', `the block at ${short(at)} was built by ${world.player.name}`, prot),
          )
        : null;
    }
    default:
      return null;
  }
}
