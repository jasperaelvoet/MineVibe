/**
 * The simulated mod with world awareness (W1) and the v2 skill additions (docs/design/tools-v2-mc.md M1-M8), for the
 * eval of the v2 tools: `hello.caps`, natural-only gathering (`collect` / `mine` never take player-built blocks;
 * nothing natural in reach is `NO_NATURAL_SOURCE` with the candidates seen), `collect{near, make_tools}`, the craft
 * tree (`craft{tree, gather_missing}`, `recipe{tree}`), `sequence`, the nearest container, "give all", `PROTECTED`
 * for boxes and blocks a player built, and `find` with provenance. Result keys follow the mod's.
 *
 * Simplifications: no loose items or animals to gather (this world has none), whole trees are felled as their
 * trunks, and tools are made from what is carried (one level of crafting).
 */

import { MOD_CAPS } from '@minevibe/protocol';
import {
  blockSpec,
  breakTime,
  burnTicks,
  CRAFTING,
  type CraftRecipe,
  matches,
  NS,
  normId,
  SMELTING,
  shortId,
  TAGS,
  toolOf,
} from './items.js';
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

/** Every cap the simulated v2 mod announces. */
export const SIM_V2_CAPS: readonly string[] = Object.values(MOD_CAPS);

const RADIUS = 48;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function dir(from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return to.y > from.y ? 'above' : to.y < from.y ? 'below' : 'here';
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return COMPASS[Math.round((((angle % 360) + 360) % 360) / 45) % 8] ?? 'here';
}

function pos(p: Pos): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z };
}

function walkTicks(from: Pos, to: Pos): number {
  return Math.round((dist(from, to) / WALK_BPS) * TPS);
}

function done(result: Record<string, unknown>): { end: JobEndSpec } {
  return { end: { status: 'done', result } };
}

function fail(code: string, msg: string, result: Record<string, unknown> = {}): { end: JobEndSpec } {
  return { end: { status: 'failed', result, error: { code, msg } } };
}

function gained(world: SimWorld, before: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, c] of world.agent.inventory) {
    const d = c - (before.get(id) ?? 0);
    if (d > 0) out[id] = d;
  }
  return out;
}

/** Item ids whose block is not the item itself. */
const DROPS: Readonly<Record<string, readonly string[]>> = {
  [`${NS}cobblestone`]: [`${NS}stone`, `${NS}cobblestone`],
  [`${NS}coal`]: [`${NS}coal_ore`],
  [`${NS}raw_iron`]: [`${NS}iron_ore`],
  [`${NS}dirt`]: [`${NS}dirt`, `${NS}grass_block`],
};

/** W1: a tag means its natural kinds only (no stripped logs, wood or planks). */
function buildingVariant(id: string): boolean {
  const s = shortId(id);
  return s.startsWith('stripped_') || s.endsWith('_wood') || s.endsWith('_planks') || s.endsWith('_hyphae');
}

/** Blocks that drop `ref` (natural kinds only). */
function sourcesOf(ref: string): ((id: string) => boolean) | null {
  const r = normId(ref);
  if (r.startsWith('#')) {
    const tag = TAGS[r.slice(1)];
    if (!tag) return null;
    const kinds = tag.filter((id) => !buildingVariant(id));
    return kinds.length > 0 ? (id) => kinds.includes(id) : null;
  }
  if (buildingVariant(r)) return null;
  const extra = DROPS[r];
  if (extra) return (id) => id === r || extra.includes(id);
  return blockSpec(r).hardness >= 0 ? (id) => id === r : null;
}

/** The tool tier a block needs and whether the agent can make it from what it carries (one level). */
function makeTool(world: SimWorld, blockId: string): string | null {
  const spec = blockSpec(blockId);
  if (!spec.tool) return null;
  for (const tier of ['wooden', 'stone', 'iron'] as const) {
    const tool = `${NS}${tier}_${spec.tool}`;
    const recipe = CRAFTING.find((r) => r.result === tool);
    if (!recipe) continue;
    if (!breakTime(blockId, [tool]).harvest) continue;
    if (craftTimes(world, recipe) < 1) continue;
    for (const ing of recipe.ingredients) world.take((id) => matches(ing.ref, id), ing.count);
    world.give(tool, 1);
    return tool;
  }
  return null;
}

function craftTimes(world: SimWorld, recipe: CraftRecipe): number {
  let n = Number.POSITIVE_INFINITY;
  for (const ing of recipe.ingredients) n = Math.min(n, Math.floor(world.count((id) => matches(ing.ref, id)) / ing.count));
  return Number.isFinite(n) ? n : 0;
}

interface Candidate {
  pos: Pos;
  block: string;
  why: 'unreachable' | 'too_far' | 'protected' | 'not_natural';
}

/**
 * `collect{item, count, radius?, near?, make_tools?}` (W1 + M2): natural sources only, whole trees, tools made from
 * what is carried, `NO_NATURAL_SOURCE` with the candidates seen when nothing natural is in reach.
 */
export function gatherJob(world: SimWorld, args: Record<string, unknown>, skill = 'collect'): JobLogic {
  const ref = normId(String(args.item ?? args.block));
  const count = Number(args.count);
  const radius = typeof args.radius === 'number' ? args.radius : skill === 'mine' ? 24 : RADIUS;
  const near = (args.near as Pos | undefined) ?? null;
  const makeTools = args.make_tools === true;
  const isMine = skill === 'mine';
  const sources = isMine ? (sourcesOf(ref) ?? ((id: string) => matches(ref, id) && !buildingVariant(id))) : sourcesOf(ref);
  const match = (id: string) => matches(ref, id) && (!ref.startsWith('#') || !buildingVariant(id));
  const start = world.count(match);
  const before = new Map(world.agent.inventory);
  const skip = new Set<string>();
  const candidates = new Map<string, Candidate>();
  const used = new Map<string, { kind: string; what: string; pos: Pos; n: number }>();
  const toolsMade: string[] = [];
  let mined = 0;
  let tree: string | null = null;
  const got = () => (isMine ? mined : world.count(match) - start);
  const report = (): Record<string, unknown> => ({
    item: ref,
    got: Math.max(0, got()),
    have: world.count(match),
    ...(isMine ? { mined } : { collected: Math.max(0, got()) }),
    sources: [...used.values()].map((s) => ({ kind: s.kind, what: s.what, pos: pos(s.pos), n: s.n })),
    ...(toolsMade.length > 0 ? { tools_made: toolsMade } : {}),
    items: gained(world, before),
  });
  const noNatural = (): { end: JobEndSpec } => {
    const from = near ?? world.agent.pos;
    const list = [...candidates.values()]
      .sort((a, b) => dist(a.pos, from) - dist(b.pos, from))
      .slice(0, 8)
      .map((c) => ({
        pos: pos(c.pos),
        block: c.block,
        distance: Math.round(dist(c.pos, world.agent.pos)),
        dir: dir(world.agent.pos, c.pos),
        why: c.why,
        ...(c.why === 'protected' ? { owner: world.player.name } : {}),
      }));
    const what = shortId(ref);
    return fail('NO_NATURAL_SOURCE', `no reachable natural ${what} within ${radius} blocks`, {
      ...report(),
      noNaturalSource: {
        what,
        radius,
        candidates: list,
        hint: `Ask ${world.player.name} where to find natural ${what}, or what to use instead; never take built blocks.`,
      },
    });
  };
  return {
    next(): JobNext {
      if (got() >= count) return done(report());
      if (world.freeSlots() === 0) return fail('INVENTORY_FULL', `no room for more ${ref}`, report());
      if (!sources) return noNatural();
      const center = near ?? world.agent.pos;
      const all = world.scan(center, radius, sources).filter((c) => blockSpec(c.block.id).hardness >= 0);
      for (const c of all) {
        const k = posKey(c.pos);
        if (c.block.placedBy === 'player' && !candidates.has(k)) {
          candidates.set(k, { pos: c.pos, block: shortId(c.block.id), why: 'protected' });
        }
      }
      const natural = all
        .filter((c) => c.block.placedBy !== 'player' && !skip.has(posKey(c.pos)) && world.exposed(c.pos))
        // The tree being felled first (bottom-up), then the nearest.
        .sort(
          (a, b) =>
            Number(b.block.structure === tree && tree !== null) - Number(a.block.structure === tree && tree !== null) ||
            (a.block.structure === tree && tree !== null ? a.pos.y - b.pos.y : 0) ||
            dist(a.pos, center) - dist(b.pos, center),
        );
      const target = natural[0];
      if (!target) return noNatural();
      if (world.isUnreachable(target.pos)) {
        skip.add(posKey(target.pos));
        const label = target.block.structure?.startsWith('tree:')
          ? `${shortId(target.block.id).replace(/_log$/, '')} tree`
          : shortId(target.block.id);
        candidates.set(posKey(target.pos), { pos: target.pos, block: label, why: 'unreachable' });
        return { dt: TPS };
      }
      let tools = [...world.agent.inventory.keys()].filter((id) => toolOf(id) !== null);
      let t = breakTime(target.block.id, tools);
      if (!t.harvest && makeTools) {
        const made = makeTool(world, target.block.id);
        if (made) {
          toolsMade.push(shortId(made));
          tools = [...world.agent.inventory.keys()].filter((id) => toolOf(id) !== null);
          t = breakTime(target.block.id, tools);
        }
      }
      if (!t.harvest) {
        return fail('NEEDS_TOOL', `breaking ${target.block.id} drops nothing without the right tool`, report());
      }
      tree = target.block.structure?.startsWith('tree:') ? target.block.structure : null;
      const dt = walkTicks(world.agent.pos, target.pos) + Math.round((t.seconds + 0.5) * TPS);
      return {
        dt,
        progress: [Math.min(1, Math.max(0, got()) / count), `${Math.max(0, got())}/${count} ${ref}`],
        effect: () => {
          const now = world.block(target.pos);
          if (now.id === AIR || !sources(now.id)) return;
          world.agent.pos = world.standSpot(target.pos);
          world.breakBlock(target.pos, skill);
          mined++;
          const drop = blockSpec(now.id).drop;
          if (drop && world.freeSlots() > 0) {
            world.give(drop, 1);
            world.agentEvent('picked_up', { item: drop, count: 1 });
          }
          const key = now.structure ?? `${now.id}@${posKey(target.pos)}`;
          const kind = now.structure?.startsWith('tree:') ? 'tree' : now.id.endsWith('_ore') ? 'ore' : 'stone';
          const what = kind === 'tree' ? shortId(now.id).replace(/_log$/, '') : shortId(now.id);
          const s = used.get(key) ?? { kind, what, pos: target.pos, n: 0 };
          s.n++;
          used.set(key, s);
        },
      };
    },
  };
}

// --- The craft tree (M4, M5) ---------------------------------------------------------------------------------------

interface TreeStep {
  readonly kind: 'craft' | 'smelt';
  readonly item: string;
  readonly made: number;
  readonly from: Record<string, number>;
  readonly table: boolean;
}

interface TreePlan {
  readonly steps: TreeStep[];
  readonly missing: { item: string; need: number; have: number; for: string | null }[];
  readonly needsTable: boolean;
  readonly needsFurnace: boolean;
}

/** One concrete item for an ingredient ref: what is carried, else the plainest kind (oak first). */
function pickFor(ref: string, inv: Map<string, number>): string {
  const r = normId(ref);
  if (!r.startsWith('#')) return r;
  const options = (TAGS[r.slice(1)] ?? []).filter((id) => !buildingVariant(id) || id.endsWith('_planks'));
  const held = options.filter((id) => (inv.get(id) ?? 0) > 0).sort((a, b) => (inv.get(b) ?? 0) - (inv.get(a) ?? 0));
  if (held[0]) return held[0];
  // Planks whose log is carried.
  for (const id of options) {
    if (!id.endsWith('_planks')) continue;
    const log = id.replace(/_planks$/, '_log');
    if ((inv.get(log) ?? 0) > 0) return id;
  }
  return options.find((id) => id.includes('oak')) ?? options[0] ?? r;
}

/** Plans `count` of `item` from the inventory (the mod's RecipeTree, simplified). */
export function planTree(world: SimWorld, item: string, count: number): TreePlan {
  const inv = new Map(world.agent.inventory);
  const steps: TreeStep[] = [];
  const missing = new Map<string, { item: string; need: number; have: number; for: string | null }>();
  let needsTable = false;
  let needsFurnace = false;
  let smelts = 0;
  const lack = (id: string, n: number, forItem: string | null) => {
    const m = missing.get(id);
    if (m) m.need += n;
    else missing.set(id, { item: shortId(id), need: n, have: 0, for: forItem ? shortId(forItem) : null });
  };
  const need = (id: string, n: number, depth: number, up: Set<string>, forItem: string | null, fresh = false) => {
    const have = fresh ? 0 : (inv.get(id) ?? 0);
    const take = Math.min(have, n);
    if (take > 0) inv.set(id, have - take);
    const rest = n - take;
    if (rest <= 0) return;
    if (depth >= 4 || up.has(id)) return lack(id, rest, forItem);
    const recipe = CRAFTING.find((r) => r.result === id);
    const smelt = SMELTING.find((r) => r.result === id);
    const next = new Set(up).add(id);
    if (recipe) {
      const times = Math.ceil(rest / recipe.makes);
      const from: Record<string, number> = {};
      for (const ing of recipe.ingredients) {
        const pick = pickFor(ing.ref, inv);
        from[pick] = (from[pick] ?? 0) + ing.count * times;
        need(pick, ing.count * times, depth + 1, next, id);
      }
      if (!recipe.small) needsTable = true;
      steps.push({ kind: 'craft', item: id, made: times * recipe.makes, from, table: !recipe.small });
      inv.set(id, (inv.get(id) ?? 0) + times * recipe.makes - rest);
      return;
    }
    if (smelt) {
      const input = pickFor(smelt.input, inv);
      need(input, rest, depth + 1, next, id);
      needsFurnace = true;
      smelts += rest;
      steps.push({ kind: 'smelt', item: id, made: rest, from: { [input]: rest }, table: false });
      return;
    }
    lack(id, rest, forItem);
  };
  const near = (id: string) =>
    world.count((i) => i === id) > 0 || world.scan(world.agent.pos, 24, (i) => i === id).length > 0;
  const tableNear = near(`${NS}crafting_table`);
  const furnaceNear = near(`${NS}furnace`);
  // A first pass decides the stations; the plan then starts with the ones to make.
  const probe = planOnce();
  function planOnce(): { table: boolean; furnace: boolean } {
    const saved = new Map(inv);
    need(item, count, 0, new Set(), null, true);
    const r = { table: needsTable, furnace: needsFurnace };
    inv.clear();
    for (const [k, v] of saved) inv.set(k, v);
    steps.length = 0;
    missing.clear();
    needsTable = false;
    needsFurnace = false;
    smelts = 0;
    return r;
  }
  const makeFurnace = probe.furnace && !furnaceNear && item !== `${NS}furnace`;
  const makeTable = (probe.table || makeFurnace) && !tableNear && item !== `${NS}crafting_table`;
  if (makeTable) {
    need(`${NS}crafting_table`, 1, 0, new Set(), null);
    inv.set(`${NS}crafting_table`, (inv.get(`${NS}crafting_table`) ?? 0) + 1);
  }
  if (makeFurnace) {
    need(`${NS}furnace`, 1, 0, new Set(), null);
    inv.set(`${NS}furnace`, (inv.get(`${NS}furnace`) ?? 0) + 1);
  }
  need(item, count, 0, new Set(), null, true);
  // Fuel for the smelts: carried fuel the plan leaves, else logs.
  let ticks = smelts * 200;
  for (const [id, n] of [...inv].sort((a, b) => burnTicks(b[0]) - burnTicks(a[0]))) {
    const burn = burnTicks(id);
    if (ticks <= 0 || burn <= 0 || n <= 0) continue;
    const use = Math.min(n, Math.ceil(ticks / burn));
    inv.set(id, n - use);
    ticks -= use * burn;
  }
  if (ticks > 0) lack('#minecraft:logs', Math.ceil(ticks / 300), null);
  for (const m of missing.values()) m.have = world.count((i) => i === normId(m.item));
  return { steps, missing: [...missing.values()], needsTable, needsFurnace };
}

/** `obs.query recipe{item, count, tree:true}` (M5). */
export function recipeTree(world: SimWorld, item: string, count: number): Record<string, unknown> {
  const p = planTree(world, item, count);
  const station = (id: string) => {
    const found = world.scan(world.agent.pos, 24, (i) => i === id).sort((a, b) => dist(a.pos, world.agent.pos) - dist(b.pos, world.agent.pos))[0];
    if (found) return { pos: pos(found.pos) };
    return world.count((i) => i === id) > 0 ? { how: 'put down the one you carry' } : { how: 'craft one first' };
  };
  const stations: Record<string, unknown> = {};
  if (p.needsTable) stations.table = station(`${NS}crafting_table`);
  if (p.needsFurnace) stations.furnace = station(`${NS}furnace`);
  return {
    item,
    count,
    tree: true,
    ok: p.missing.length === 0,
    have: world.count((i) => i === item),
    steps: p.steps.map((s) => ({
      action: s.kind,
      item: shortId(s.item),
      count: s.made,
      from: Object.fromEntries(Object.entries(s.from).map(([k, v]) => [shortId(k), v])),
    })),
    missing: p.missing,
    stations,
  };
}

/** A logic that runs `children` in order (built lazily), ending with the last one's end or the first failure. */
function chain(
  build: (i: number) => JobLogic | null,
  onEnd: (i: number, end: JobEndSpec) => { end: JobEndSpec } | null,
  progress: (i: number, text: string) => [number, string],
): JobLogic {
  let i = 0;
  let current: JobLogic | null = null;
  return {
    next(): JobNext {
      for (let guard = 0; guard < 64; guard++) {
        if (!current) {
          current = build(i);
          if (!current) return onEnd(-1, { status: 'done', result: {} }) ?? done({});
        }
        const r = current.next();
        if ('end' in r) {
          current = null;
          const stop = onEnd(i, r.end);
          i++;
          if (stop) return stop;
          continue;
        }
        const step = r as JobStep;
        return { ...step, progress: progress(i, step.progress?.[1] ?? '') };
      }
      return { dt: 1 };
    },
  };
}

/**
 * `craft{item, count, table?, tree:true, gather_missing?}` (M4): plan, gather what is missing (natural sources), plan
 * again, then craft and smelt step by step (the v1 craft and smelt jobs do each step).
 */
export function craftTreeJob(
  world: SimWorld,
  args: Record<string, unknown>,
  steps: { craft: (a: Record<string, unknown>) => JobLogic; smelt: (a: Record<string, unknown>) => JobLogic },
): JobLogic {
  const item = normId(String(args.item));
  const count = Number(args.count);
  const gatherMissing = args.gather_missing === true;
  const start = world.count((i) => i === item);
  const texts: string[] = [];
  const gathered: Record<string, number> = {};
  let station: Record<string, unknown> | null = null;
  let rounds = 0;
  let phase: 'plan' | 'gather' | 'steps' = 'plan';
  let queue: { label: string; logic: () => JobLogic }[] = [];
  let current: { label: string; logic: JobLogic } | null = null;
  const report = (extra: Record<string, unknown> = {}) => ({
    item,
    crafted: Math.max(0, world.count((i) => i === item) - start),
    have: world.count((i) => i === item),
    steps: texts,
    ...(station ? { station } : {}),
    ...(Object.keys(gathered).length > 0 ? { gathered } : {}),
    ...extra,
  });
  return {
    next(): JobNext {
      for (let guard = 0; guard < 64; guard++) {
        if (current) {
          const r = current.logic.next();
          if (!('end' in r)) {
            const step = r as JobStep;
            return { ...step, progress: [0, `${current.label} ${step.progress?.[1] ?? ''}`.trim()] };
          }
          const end = r.end;
          const label = current.label;
          current = null;
          if (end.status !== 'done') {
            const keep: Record<string, unknown> = {};
            for (const k of ['noNaturalSource', 'protected', 'missing', 'ingredients']) {
              if (end.result[k] !== undefined) keep[k] = end.result[k];
            }
            return fail(end.error?.code ?? 'FAILED', `${label}: ${end.error?.msg ?? 'failed'}`, report(keep));
          }
          if (phase === 'gather') {
            for (const [k, v] of Object.entries((end.result.items as Record<string, number> | undefined) ?? {})) {
              gathered[shortId(k)] = (gathered[shortId(k)] ?? 0) + v;
            }
          } else {
            for (const [key, kind, placed] of [
              ['placedTable', 'crafting_table', true],
              ['table', 'crafting_table', false],
              ['placedFurnace', 'furnace', true],
              ['furnace', 'furnace', false],
            ] as const) {
              if (end.result[key] && (!station || placed)) station = { kind, pos: end.result[key], placed };
            }
          }
          continue;
        }
        const next = queue.shift();
        if (next) {
          current = { label: next.label, logic: next.logic() };
          continue;
        }
        if (phase === 'steps') {
          const made = world.count((i) => i === item) - start;
          return made >= count
            ? done(report())
            : fail('MISSING_INGREDIENTS', `made only ${Math.max(0, made)} of ${count} ${shortId(item)}`, report());
        }
        // Plan (again).
        const plan = planTree(world, item, count);
        if (plan.steps.length === 0 && plan.missing.length === 1 && normId(plan.missing[0]?.item ?? '') === item) {
          return fail('NO_RECIPE', `nothing crafts or smelts ${item}; gather it instead`, report());
        }
        if (plan.missing.length > 0) {
          if (!gatherMissing || rounds >= 3) {
            const text = plan.missing.map((m) => `${m.item} ${m.need}`).join(', ');
            return fail('MISSING_INGREDIENTS', `raw materials missing: ${text}`, report({ missing: plan.missing }));
          }
          rounds++;
          phase = 'gather';
          queue = plan.missing.map((m) => ({
            label: `gather ${m.item}`,
            logic: () => gatherJob(world, { item: m.item.includes(':') ? m.item : m.item.startsWith('#') ? m.item : `${NS}${m.item}`, count: m.need }),
          }));
          continue;
        }
        phase = 'steps';
        texts.length = 0;
        queue = plan.steps.map((s, i) => {
          const last = i === plan.steps.length - 1 && s.item === item;
          texts.push(`${Object.entries(s.from).map(([k, v]) => `${shortId(k)} ${v}`).join(' + ')} → ${shortId(s.item)} ${s.made}`);
          return s.kind === 'craft'
            ? {
                label: `craft ${shortId(s.item)}`,
                logic: () =>
                  steps.craft({
                    item: s.item,
                    count: last ? count : s.made,
                    ...(s.table && args.table ? { table: args.table } : {}),
                  }),
              }
            : {
                label: `smelt ${shortId(s.item)}`,
                logic: () => steps.smelt({ item: Object.keys(s.from)[0], count: s.made }),
              };
        });
      }
      return { dt: 1 };
    },
  };
}

/** `sequence{steps, stop_on_fail?}` (M1): the steps as one job. */
export function sequenceJob(
  args: Record<string, unknown>,
  build: (skill: string, args: Record<string, unknown>) => JobLogic,
): JobLogic {
  const steps = (args.steps as { skill: string; args: Record<string, unknown> }[]) ?? [];
  const stopOnFail = args.stop_on_fail !== false;
  const n = steps.length;
  const results: Record<string, unknown>[] = [];
  let firstFail: { code: string; msg: string } | null = null;
  const summary = () => ({ completed: results.filter((r) => r.status === 'done').length, steps: results });
  return chain(
    (i) => (i < n ? build(steps[i]?.skill ?? '', steps[i]?.args ?? {}) : null),
    (i, end) => {
      if (i < 0) {
        return firstFail
          ? fail(firstFail.code, `${summary().completed}/${n} steps done; ${firstFail.msg}`, summary())
          : done(summary());
      }
      const skill = steps[i]?.skill ?? '';
      const { footer: _f, ...result } = end.result;
      results.push({
        skill,
        status: end.status,
        ...(end.error ? { code: end.error.code, msg: end.error.msg } : {}),
        result,
      });
      if (end.status !== 'done') {
        const f = { code: end.error?.code ?? 'FAILED', msg: `step ${i + 1}/${n} ${skill}: ${end.error?.msg ?? 'failed'}` };
        firstFail ??= f;
        if (stopOnFail) return fail(f.code, f.msg, summary());
      }
      return null;
    },
    (i, text) => [Math.min(1, i / Math.max(1, n)), `step ${i + 1}/${n} ${text}`.trim()],
  );
}

/** W1: a box or block a player built is `PROTECTED` (the dig / place refusal). */
export function protectedIn(world: SimWorld, min: Pos, max: Pos): Record<string, unknown> | null {
  let first: Pos | null = null;
  let firstId = '';
  let n = 0;
  for (let x = min.x; x <= max.x; x++)
    for (let y = min.y; y <= max.y; y++)
      for (let z = min.z; z <= max.z; z++) {
        const b = world.block({ x, y, z });
        if (b.id !== AIR && b.placedBy === 'player') {
          n++;
          if (!first) {
            first = { x, y, z };
            firstId = b.id;
          }
        }
      }
  if (!first) return null;
  return {
    protected: {
      pos: pos(first),
      what: 'player-built',
      owner: world.player.name,
      block: firstId,
      count: n,
      hint: `${world.player.name} built this: ask before changing it.`,
    },
  };
}

/** `find` with W1 provenance, tree and reachability marks, and the natural / built filter. */
export function findBlocks(
  world: SimWorld,
  ref: string,
  radius: number,
  limit: number,
  filter: string,
): Record<string, unknown>[] {
  const a = world.agent.pos;
  const isTagged = ref.startsWith('#');
  return world
    .scan(a, radius, (id) => matches(ref, id) && (!isTagged || filter !== 'natural' || !buildingVariant(id)))
    .filter((m) =>
      filter === 'natural' ? m.block.placedBy !== 'player' : filter === 'built' ? m.block.placedBy === 'player' : true,
    )
    .sort((x, y) => dist(x.pos, a) - dist(y.pos, a))
    .slice(0, limit)
    .map((m) => {
      const out: Record<string, unknown> = {
        pos: pos(m.pos),
        block: m.block.id,
        distance: round1(dist(m.pos, a)),
        dir: dir(a, m.pos),
        exposed: world.exposed(m.pos),
      };
      if (m.block.placedBy === 'player') {
        out.provenance = 'player-built';
        out.owner = world.player.name;
      } else {
        out.provenance = m.block.placedBy === 'agent' ? 'agent-built' : 'natural';
        const structure = m.block.structure;
        if (structure?.startsWith('tree:')) {
          const logs = world.scan(m.pos, 8, (id) => id === m.block.id).filter((l) => l.block.structure === structure);
          const base = logs.reduce((lo, l) => (l.pos.y < lo.y ? l.pos : lo), m.pos);
          out.tree = { species: shortId(m.block.id).replace(/_log$/, ''), trunk: pos(base), logs: logs.length };
        }
        out.reachable = world.isUnreachable(m.pos) ? 'unreachable' : dist(m.pos, a) > 56 ? 'far' : 'reachable';
      }
      return out;
    });
}
