/**
 * `obs.query` answers of the simulated world, in the mod's formats (`dev.minevibe.agent.skill.Observations`): the
 * same keys, the same notable-block categories, the same limits and `BAD_ARGS` messages. The footer is added by
 * SimSkillApi. Like the mod, nothing here says who placed a block.
 */

import { ERROR_CODES } from '@minevibe/protocol';
import { ApiError } from '../../src/contracts/common.js';
import { CRAFTING, isKnownBlock, matches, NS, normId, SMELTING, TAGS, toolOf } from './items.js';
import { craftable, ingredientsOf } from './jobs.js';
import {
  AIR,
  dayAndTime,
  dist,
  GROUND_Y,
  type Pos,
  round1,
  type SimJob,
  type SimWorld,
  TPS,
} from './world.js';

function badArgs(msg: string): ApiError {
  return new ApiError(ERROR_CODES.BAD_ARGS, msg);
}

function intArg(args: Record<string, unknown>, key: string, dflt: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number') throw badArgs(`${key} must be a number`);
  const n = Math.trunc(v);
  if (n < min || n > max) throw badArgs(`${key} must be ${min}-${max}`);
  return n;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim().length === 0) throw badArgs(`${key} (a string) is required`);
  return v.trim();
}

function pos(p: Pos): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z };
}

/** Entity coordinates (block centre, two decimals), as the mod's SkillJob.toJson(Vec3). */
function vec(p: Pos): { x: number; y: number; z: number } {
  return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
}

export function jobJson(job: SimJob): Record<string, unknown> {
  const o: Record<string, unknown> = { jobId: job.jobId, skill: job.skill };
  if (job.status !== 'running') {
    o.status = job.status;
    o.result = job.result ?? {};
    if (job.error) o.error = `${job.error.code}: ${job.error.msg}`;
  } else {
    o.status = 'running';
    if (job.progress !== null) o.progress = round1(job.progress);
    if (job.text.length > 0) o.text = job.text;
  }
  return o;
}

function status(world: SimWorld): Record<string, unknown> {
  const a = world.agent;
  const o: Record<string, unknown> = {
    agentId: a.agentId,
    name: a.name,
    role: a.role,
    hp: a.hp,
    maxHp: a.maxHp,
    food: a.food,
    saturation: a.saturation,
    air: 300,
    armor: 0,
    xpLevel: 0,
    pos: vec(a.pos),
    dim: 'minecraft:overworld',
    biome: 'minecraft:plains',
    time: dayAndTime(world.clock),
    weather: 'clear',
    light: world.isNight() ? 4 : 15,
    mode: a.mode,
  };
  if (a.anchor) o.anchor = pos(a.anchor);
  o.activity = world.activity();
  if (world.current) o.job = withElapsed(world, world.current);
  o.held = a.held ?? 'nothing';
  o.inCombat = world.mobs.some((m) => m.alive && m.hostile && dist(m.pos, a.pos) <= 12);
  o.playerDistance = round1(dist(a.pos, world.player.pos));
  return o;
}

function withElapsed(world: SimWorld, job: SimJob): Record<string, unknown> {
  const o = jobJson(job);
  o.elapsedS = Math.floor(((job.endedAt ?? world.clock) - job.startedAt) / TPS);
  return o;
}

/** The mod's NOTABLE categories, in its order. */
const NOTABLE: readonly (readonly [string, (id: string) => boolean])[] = [
  ['logs', (id) => matches('#minecraft:logs', id)],
  ['coal_ore', (id) => matches('#minecraft:coal_ores', id)],
  ['iron_ore', (id) => matches('#minecraft:iron_ores', id)],
  ['copper_ore', (id) => id.endsWith('copper_ore')],
  ['gold_ore', (id) => id.endsWith('gold_ore')],
  ['redstone_ore', (id) => id.endsWith('redstone_ore')],
  ['lapis_ore', (id) => id.endsWith('lapis_ore')],
  ['diamond_ore', (id) => id.endsWith('diamond_ore')],
  ['emerald_ore', (id) => id.endsWith('emerald_ore')],
  ['crafting_table', (id) => id === `${NS}crafting_table`],
  ['furnace', (id) => id === `${NS}furnace` || id === `${NS}smoker` || id === `${NS}blast_furnace`],
  ['chest', (id) => id === `${NS}chest` || id === `${NS}barrel` || id === `${NS}trapped_chest`],
  ['bed', (id) => matches('#minecraft:beds', id)],
  ['crops', (id) => id === `${NS}wheat`],
  ['ripe_crops', () => false],
  ['water', (id) => id === `${NS}water`],
  ['lava', (id) => id === `${NS}lava`],
  ['office_chair', (id) => id === 'minevibe:office_chair'],
];

const BORING = new Set([`${NS}stone`, `${NS}dirt`, `${NS}grass_block`, `${NS}deepslate`, AIR]);

/** Counts and nearest position per notable category in a cube of `radius` (the mod's notableBlocks). */
function notableBlocks(world: SimWorld, radius: number): Record<string, unknown> {
  const c = world.agent.pos;
  const counts = new Map<string, { count: number; nearest: Pos; d: number }>();
  for (const { pos: p, block } of world.scan(c, radius * Math.SQRT2 * 1.3, (id) => !BORING.has(id))) {
    if (Math.abs(p.x - c.x) > radius || Math.abs(p.y - c.y) > radius || Math.abs(p.z - c.z) > radius)
      continue;
    for (const [name, test] of NOTABLE) {
      if (!test(block.id)) continue;
      const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2;
      const e = counts.get(name);
      if (!e) counts.set(name, { count: 1, nearest: p, d });
      else {
        e.count++;
        if (d < e.d) {
          e.d = d;
          e.nearest = p;
        }
      }
    }
  }
  const o: Record<string, unknown> = {};
  for (const [name] of NOTABLE) {
    const e = counts.get(name);
    if (e) o[name] = { count: e.count, nearest: pos(e.nearest) };
  }
  return o;
}

function entities(world: SimWorld, radius: number): Record<string, unknown>[] {
  const a = world.agent.pos;
  const list: { d: number; j: Record<string, unknown> }[] = [];
  const pd = dist(world.player.pos, a);
  if (pd <= radius) {
    list.push({
      d: pd,
      j: {
        type: 'player',
        name: world.player.name,
        distance: round1(pd),
        pos: pos(world.player.pos),
        hp: world.player.hp,
      },
    });
  }
  for (const m of world.mobs) {
    if (!m.alive) continue;
    const d = dist(m.pos, a);
    if (d > radius) continue;
    const j: Record<string, unknown> = {
      type: m.type,
      id: m.id,
      distance: round1(d),
      pos: pos(m.pos),
      hp: m.hp,
    };
    if (m.hostile) j.hostile = true;
    list.push({ d, j });
  }
  return list
    .sort((x, y) => x.d - y.d)
    .slice(0, 20)
    .map((e) => e.j);
}

function lookAround(world: SimWorld, radius: number): Record<string, unknown> {
  const feet = world.agent.pos;
  const indoors = world.isSheltered(feet);
  return {
    entities: entities(world, radius),
    blocks: notableBlocks(world, Math.min(radius, 12)),
    time: dayAndTime(world.clock),
    dark: world.isNight(),
    sky: !indoors,
    blockLight: indoors ? 12 : 0,
    standingOn: world.block({ ...feet, y: feet.y - 1 }).id,
    biome: 'minecraft:plains',
  };
}

function inventory(world: SimWorld): Record<string, unknown> {
  const slots: Record<string, unknown>[] = [];
  let slot = 0;
  for (const [item, count] of world.agent.inventory) {
    const stack = toolOf(item) || item.endsWith('_bed') ? 1 : 64;
    let left = count;
    while (left > 0) {
      const n = Math.min(stack, left);
      const e: Record<string, unknown> = { slot: slot++, item, count: n };
      if (toolOf(item)) e.durability = 131;
      slots.push(e);
      left -= n;
    }
  }
  return {
    slots,
    armor: {},
    selected: 0,
    freeSlots: world.freeSlots(),
    totals: world.totals(),
  };
}

const ENTITY_TYPES = new Set(
  ['zombie', 'skeleton', 'creeper', 'spider', 'cow', 'pig', 'sheep', 'chicken'].map((t) => `${NS}${t}`),
);

function find(world: SimWorld, what: string, radius: number, limit: number): Record<string, unknown> {
  const o: Record<string, unknown> = { what };
  const ref = normId(what);
  const isBlock = ref.startsWith('#') ? TAGS[ref.slice(1)] !== undefined : isKnownBlock(ref);
  const a = world.agent.pos;
  let matchesOut: Record<string, unknown>[] = [];
  if ((ENTITY_TYPES.has(ref) && !isBlock) || what === 'player') {
    o.kind = 'entity';
    matchesOut = entities(world, radius)
      .filter((e) => (what === 'player' ? e.type === 'player' : e.type === ref))
      .slice(0, limit);
  } else if (isBlock) {
    o.kind = 'block';
    matchesOut = world
      .scan(a, radius, (id) => matches(ref, id))
      .sort((x, y) => dist(x.pos, a) - dist(y.pos, a))
      .slice(0, limit)
      .map((m) => ({
        pos: pos(m.pos),
        block: m.block.id,
        distance: round1(dist(m.pos, a)),
        exposed: world.exposed(m.pos),
      }));
  } else {
    o.kind = 'item';
    o.inInventory = world.count((id) => matches(ref, id));
  }
  o.matches = matchesOut;
  if (matchesOut.length === 0) o.note = `none within ${radius} blocks (only loaded chunks are searched)`;
  return o;
}

function recipe(world: SimWorld, itemRef: string): Record<string, unknown> {
  const item = normId(itemRef);
  if (item.startsWith('#')) throw badArgs('recipe needs one item, not a tag');
  const crafts = CRAFTING.filter((r) => r.result === item);
  const smelts = SMELTING.filter((r) => r.result === item);
  const recipes: Record<string, unknown>[] = [];
  for (const r of crafts) {
    recipes.push({
      id: r.id,
      makes: r.makes,
      station: r.small ? 'inventory (2x2)' : 'crafting_table',
      ingredients: ingredientsOf(world, r),
      canCraftNow: craftable(world, r),
    });
  }
  for (const r of smelts) {
    recipes.push({
      id: r.id,
      makes: 1,
      station: 'furnace',
      ingredients: [{ item: r.input, need: 1, have: world.count((id) => matches(r.input, id)) }],
    });
  }
  const o: Record<string, unknown> = { item, recipes: recipes.slice(0, 4) };
  if (recipes.length === 0) o.note = 'no crafting or smelting recipe makes it; gather it instead';
  o.have = world.count((id) => id === item);
  return o;
}

function recentEvents(world: SimWorld, limit: number): Record<string, unknown> {
  const events = world.agentEvents.slice(-limit).map((e) => {
    const j: Record<string, unknown> = {
      type: e.type,
      agoS: Math.max(0, Math.floor((world.clock - e.at) / TPS)),
    };
    if (e.data && Object.keys(e.data).length > 0) j.data = e.data;
    return j;
  });
  return { events };
}

function crew(world: SimWorld): Record<string, unknown> {
  const a = world.agent;
  return {
    crew: [
      {
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        pos: pos(a.pos),
        dim: 'minecraft:overworld',
        hp: a.hp,
        food: a.food,
        activity: world.activity(),
      },
    ],
  };
}

function jobStatus(world: SimWorld, jobId: string | null): Record<string, unknown> {
  const job = jobId ? world.jobs.get(jobId) : world.current;
  if (!job) {
    const o: Record<string, unknown> = { status: jobId === null ? 'idle' : 'unknown' };
    return o;
  }
  return withElapsed(world, job);
}

/** Answers one `obs.query` (without the footer). Throws `BAD_ARGS` like the mod. */
export function observe(
  world: SimWorld,
  query: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (query) {
    case 'status':
      return status(world);
    case 'look_around':
      return lookAround(world, intArg(args, 'radius', 16, 1, 32));
    case 'inventory':
      return inventory(world);
    case 'find':
      return find(
        world,
        stringArg(args, 'what').toLowerCase(),
        intArg(args, 'radius', 32, 1, 64),
        intArg(args, 'limit', 5, 1, 10),
      );
    case 'recipe':
      return recipe(world, stringArg(args, 'item').toLowerCase());
    case 'recent_events':
      return recentEvents(world, intArg(args, 'limit', 20, 1, 50));
    case 'crew':
      return crew(world);
    case 'list_pcs':
      return { pcs: [] };
    case 'job_status':
      return jobStatus(world, typeof args.jobId === 'string' ? args.jobId.trim() : null);
    case 'menu_state':
      return { open: false };
    default:
      throw badArgs(`unknown query ${query}`);
  }
}

/** Ground level helper for layouts and checks. */
export const STAND_Y = GROUND_Y + 1;
