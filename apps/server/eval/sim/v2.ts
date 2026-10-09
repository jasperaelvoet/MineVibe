/**
 * The simulated mod with world awareness (W1) and the v2 skill additions (docs/design/tools-v2-mc.md M1-M8), for the
 * eval of the v2 tools: `hello.caps`, natural-only gathering (`collect` / `mine` never take player-built blocks or
 * the Base; nothing natural in reach is `NO_NATURAL_SOURCE` with the candidates seen), `collect{near, make_tools}`,
 * the craft tree (`craft{tree, gather_missing}`, `recipe{tree}`), `sequence`, the nearest container, "give all",
 * `PROTECTED` for what a player built and for the Base zone (with the mod's consent token), and `find` with
 * provenance. Result keys and failure messages follow the mod's (`SkillJob.refuseProtected`, `noNaturalSource`,
 * `Observations.find`); the scene of `look_around` is scene.ts.
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
  familyMembers,
  familyOf,
  matches,
  NS,
  normId,
  SMELTING,
  shortId,
  TAGS,
  toolOf,
} from './items.js';
import { blocksApart, compassDir } from './scene.js';
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
  type Verdict,
  verdictHint,
  WALK_BPS,
} from './world.js';

/** Every cap the simulated v2 mod announces. */
export const SIM_V2_CAPS: readonly string[] = Object.values(MOD_CAPS);

const RADIUS = 48;

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
  [`${NS}cobbled_deepslate`]: [`${NS}deepslate`, `${NS}cobbled_deepslate`],
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
    // A family such as stone_tool_materials: its kinds' blocks and the blocks that drop them (stone, deepslate).
    const drops = kinds.flatMap((k) => DROPS[k] ?? []);
    return kinds.length > 0 ? (id) => kinds.includes(id) || drops.includes(id) : null;
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
  for (const ing of recipe.ingredients)
    n = Math.min(n, Math.floor(world.count((id) => matches(ing.ref, id)) / ing.count));
  return Number.isFinite(n) ? n : 0;
}

interface Candidate {
  pos: Pos;
  block: string;
  why: 'unreachable' | 'too_far' | 'protected' | 'not_natural';
  owner?: string | undefined;
}

/** The mod's `Miner.MAX_CANDIDATES`: at most 8 candidates, 3 of each kind, nearest first. */
const MAX_CANDIDATES = 8;

/** The mod's `Sources.Candidate.describe`: `oak tree 9m W at 3 70 -2 (unreachable)`. */
function describeCandidate(c: Candidate, from: Pos): string {
  const reason =
    c.why === 'unreachable'
      ? 'unreachable'
      : c.why === 'too_far'
        ? 'out of range'
        : c.why === 'protected'
          ? c.owner
            ? `${c.owner}'s, not touched`
            : 'protected, not touched'
          : 'not a natural tree';
  return `${c.block} ${blocksApart(from, c.pos)}m ${compassDir(from, c.pos)} at ${c.pos.x} ${c.pos.y} ${c.pos.z} (${reason})`;
}

/**
 * The mod's `SkillJob.refuseProtected`: `PROTECTED` with `result.protected` (the nearest refused block, whose it is,
 * how many, the consent token for all of them, the teaching line) and the mod's message. `allowAsked`: the call set
 * `allow_protected` without a valid consent.
 */
export function refuseProtected(
  world: SimWorld,
  v: Verdict,
  all: readonly Pos[],
  extra: Record<string, unknown> = {},
  allowAsked = false,
): { end: JobEndSpec } {
  const positions = [...all];
  if (!positions.some((q) => posKey(q) === posKey(v.pos))) positions.push(v.pos);
  const token = world.offerConsent(positions);
  const detail: Record<string, unknown> = {
    pos: pos(v.pos),
    what: v.what,
    owner: v.owner,
    block: v.block,
    ...(v.zone ? { zone: v.zone } : {}),
    count: positions.length,
    ...(token ? { consentId: token } : {}),
    hint: verdictHint(v),
  };
  const more = positions.length > 1 ? `, and ${positions.length - 1} more` : '';
  const where = `${shortId(v.block)} at ${v.pos.x} ${v.pos.y} ${v.pos.z}`;
  const tail = allowAsked
    ? ` allow_protected only works once ${v.owner} has agreed: ask ${v.owner} first.`
    : ` Nothing was changed. Ask ${v.owner}; only if they agree, retry with allow_protected.`;
  return fail('PROTECTED', `${verdictHint(v)} (${where}${more}).${tail}`, { ...extra, protected: detail });
}

/**
 * `collect{item, count, radius?, near?, make_tools?}` (W1 + M2): natural sources only, whole trees, tools made from
 * what is carried. Nothing natural in reach is `NO_NATURAL_SOURCE` with the candidates seen (unreachable, out of
 * range, protected), in the mod's words; only protected blocks of a non-log kind is `PROTECTED` (`shortOfSources`).
 */
export function gatherJob(world: SimWorld, args: Record<string, unknown>, skill = 'collect'): JobLogic {
  const ref = normId(String(args.item ?? args.block));
  const count = Number(args.count);
  const radius = typeof args.radius === 'number' ? args.radius : skill === 'mine' ? 24 : RADIUS;
  const near = (args.near as Pos | undefined) ?? null;
  const makeTools = args.make_tools === true;
  const isMine = skill === 'mine';
  const sources = isMine
    ? (sourcesOf(ref) ?? ((id: string) => matches(ref, id) && !buildingVariant(id)))
    : sourcesOf(ref);
  // `Sources.treeMode`: every kind asked for is a natural log, so the job works on whole trees.
  const kinds = ref.startsWith('#') ? (TAGS[ref.slice(1)] ?? []).filter((id) => !buildingVariant(id)) : [ref];
  const treeMode = sources !== null && kinds.length > 0 && kinds.every((id) => id.endsWith('_log'));
  const match = (id: string) => matches(ref, id) && (!ref.startsWith('#') || !buildingVariant(id));
  const start = world.count(match);
  const before = new Map(world.agent.inventory);
  const skip = new Set<string>();
  const candidates = new Map<string, Candidate>();
  const protectedSeen: Verdict[] = [];
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
  const noteProtected = (v: Verdict) => {
    const k = posKey(v.pos);
    if (candidates.has(k)) return;
    protectedSeen.push(v);
    candidates.set(k, { pos: v.pos, block: shortId(v.block), why: 'protected', owner: v.owner });
  };
  /** `Miner.candidates`: what was rejected, what was protected, and the nearest sources beyond the radius. */
  const candidateList = (): Candidate[] => {
    const from = near ?? world.agent.pos;
    const list = [...candidates.values()];
    if (sources) {
      const far = Math.min(64, radius + 40);
      const beyond = world
        .scan(from, far, sources)
        .filter(
          (c) =>
            dist(c.pos, from) > radius &&
            blockSpec(c.block.id).hardness >= 0 &&
            world.protectedAt(c.pos, { ignoreGrant: true }) === null,
        )
        .sort((a, b) => dist(a.pos, from) - dist(b.pos, from));
      if (treeMode) {
        const seen = new Set<string>();
        for (const c of beyond) {
          const t = c.block.structure;
          if (!t?.startsWith('tree:') || seen.has(t) || seen.size >= 2) continue;
          seen.add(t);
          const base = world
            .scan(c.pos, 8, (id) => id === c.block.id)
            .filter((l) => l.block.structure === t)
            .reduce((lo, l) => (l.pos.y < lo.y ? l.pos : lo), c.pos);
          list.push({ pos: base, block: `${shortId(c.block.id).replace(/_log$/, '')} tree`, why: 'too_far' });
        }
      } else if (beyond[0]) {
        list.push({ pos: beyond[0].pos, block: shortId(beyond[0].block.id), why: 'too_far' });
      }
    }
    const here = world.agent.pos;
    list.sort((a, b) => blocksApart(here, a.pos) - blocksApart(here, b.pos));
    const kept: Candidate[] = [];
    const perWhy = new Map<string, number>();
    for (const c of list) {
      if (kept.length >= MAX_CANDIDATES) break;
      const n = (perWhy.get(c.why) ?? 0) + 1;
      perWhy.set(c.why, n);
      if (n <= 3) kept.push(c);
    }
    return kept;
  };
  /** `GatherJobs.shortOfSources`: PROTECTED when only protected blocks matched, else NO_NATURAL_SOURCE. */
  const shortOf = (): { end: JobEndSpec } => {
    const list = candidateList();
    const first = protectedSeen.reduce<Verdict | null>(
      (best, v) => (!best || dist(v.pos, world.agent.pos) < dist(best.pos, world.agent.pos) ? v : best),
      null,
    );
    if (!treeMode && mined === 0 && first && list.every((c) => c.why === 'protected')) {
      return refuseProtected(
        world,
        first,
        protectedSeen.map((v) => v.pos),
        report(),
        args.allow_protected === true && world.grant === null,
      );
    }
    const what = shortId(ref);
    const here = world.agent.pos;
    const player = world.player.name;
    // `SkillJob.noNaturalSource`: one kind of a family (oak logs) is a hard stop only when the player named it, unless
    // the craft tree pinned it (a recipe names that kind).
    const family = args.pinned === true ? null : familyOf(what);
    const hint = family
      ? `If ${player} named this kind, don't take another instead: tell ${player} what you found and ask. If it is only an ingredient (planks, sticks, tools, a furnace), any kind will do: gather ${family} (the nearest kind), no need to ask.`
      : `Don't take anything else instead. Tell ${player} what you found and ask what to do (another place, or permission).`;
    let msg = `No reachable natural ${what} within ${radius} blocks`;
    if (list.length > 0) msg += `. Seen: ${list.map((c) => describeCandidate(c, here)).join('; ')}`;
    msg += `. ${hint}`;
    return fail('NO_NATURAL_SOURCE', msg, {
      ...report(),
      noNaturalSource: {
        what,
        radius: Math.max(1, Math.min(64, radius)),
        candidates: list.map((c) => ({
          pos: pos(c.pos),
          block: c.block,
          distance: blocksApart(here, c.pos),
          dir: compassDir(here, c.pos),
          why: c.why,
          ...(c.owner ? { owner: c.owner } : {}),
        })),
        hint,
      },
    });
  };
  return {
    next(): JobNext {
      if (got() >= count) return done(report());
      if (world.freeSlots() === 0) return fail('INVENTORY_FULL', `no room for more ${ref}`, report());
      if (!sources) return shortOf();
      const center = near ?? world.agent.pos;
      const all = world
        .scan(center, radius, sources)
        .filter((c) => blockSpec(c.block.id).hardness >= 0)
        // The tree being felled first (bottom-up), then the nearest.
        .sort(
          (a, b) =>
            Number(b.block.structure === tree && tree !== null) -
              Number(a.block.structure === tree && tree !== null) ||
            (a.block.structure === tree && tree !== null ? a.pos.y - b.pos.y : 0) ||
            dist(a.pos, center) - dist(b.pos, center),
        );
      let target: (typeof all)[number] | undefined;
      for (const c of all) {
        if (skip.has(posKey(c.pos)) || !world.exposed(c.pos)) continue;
        const v = world.protectedAt(c.pos);
        if (v) {
          noteProtected(v);
          continue;
        }
        target = c;
        break;
      }
      if (!target) return shortOf();
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
        return fail(
          'NEEDS_TOOL',
          `breaking ${target.block.id} drops nothing without the right tool`,
          report(),
        );
      }
      const chosen = target;
      tree = chosen.block.structure?.startsWith('tree:') ? chosen.block.structure : null;
      const dt = walkTicks(world.agent.pos, chosen.pos) + Math.round((t.seconds + 0.5) * TPS);
      return {
        dt,
        progress: [Math.min(1, Math.max(0, got()) / count), `${Math.max(0, got())}/${count} ${ref}`],
        effect: () => {
          const now = world.block(chosen.pos);
          if (now.id === AIR || !sources(now.id)) return;
          world.agent.pos = world.standSpot(chosen.pos);
          world.breakBlock(chosen.pos, skill);
          mined++;
          const drop = blockSpec(now.id).drop;
          if (drop && world.freeSlots() > 0) {
            world.give(drop, 1);
            world.agentEvent('picked_up', { item: drop, count: 1 });
          }
          const key = now.structure ?? `${now.id}@${posKey(chosen.pos)}`;
          const kind = now.structure?.startsWith('tree:')
            ? 'tree'
            : now.id.endsWith('_ore')
              ? 'ore'
              : 'stone';
          const what = kind === 'tree' ? shortId(now.id).replace(/_log$/, '') : shortId(now.id);
          const s = used.get(key) ?? { kind, what, pos: chosen.pos, n: 0 };
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

interface TreeMissing {
  item: string;
  need: number;
  have: number;
  for: string | null;
  /** The family any kind of which would do (`RecipeTree.gatherRef`), when the item is only the planner's pick. */
  any?: string;
}

interface TreePlan {
  readonly steps: TreeStep[];
  readonly missing: TreeMissing[];
  readonly needsTable: boolean;
  readonly needsFurnace: boolean;
}

/** One concrete item for an ingredient ref: what is carried, else the plainest kind (oak first). */
function pickFor(ref: string, inv: Map<string, number>): string {
  const r = normId(ref);
  if (!r.startsWith('#')) return r;
  const options = (TAGS[r.slice(1)] ?? []).filter((id) => !buildingVariant(id) || id.endsWith('_planks'));
  const held = options
    .filter((id) => (inv.get(id) ?? 0) > 0)
    .sort((a, b) => (inv.get(b) ?? 0) - (inv.get(a) ?? 0));
  if (held[0]) return held[0];
  // Planks whose log is carried.
  for (const id of options) {
    if (!id.endsWith('_planks')) continue;
    const log = id.replace(/_planks$/, '_log');
    if ((inv.get(log) ?? 0) > 0) return id;
  }
  return options.find((id) => id.includes('oak')) ?? options[0] ?? r;
}

/**
 * Plans `count` of `item` from the inventory (the mod's RecipeTree, simplified); `inventory` stands in for the agent's
 * (the family test of {@link gatherRefOf}).
 */
export function planTree(
  world: SimWorld,
  item: string,
  count: number,
  inventory: ReadonlyMap<string, number> = world.agent.inventory,
): TreePlan {
  const inv = new Map(inventory);
  const steps: TreeStep[] = [];
  const missing = new Map<string, TreeMissing>();
  let needsTable = false;
  let needsFurnace = false;
  let smelts = 0;
  const lack = (id: string, n: number, forItem: string | null) => {
    const m = missing.get(id);
    if (m) m.need += n;
    else missing.set(id, { item: shortId(id), need: n, have: 0, for: forItem ? shortId(forItem) : null });
  };
  const need = (
    id: string,
    n: number,
    depth: number,
    up: Set<string>,
    forItem: string | null,
    fresh = false,
  ) => {
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
  // `RecipeTree.FUEL_REF`: any log that burns (no stems).
  if (ticks > 0) lack('#minecraft:logs_that_burn', Math.ceil(ticks / 300), null);
  for (const m of missing.values()) m.have = world.count((i) => i === normId(m.item));
  return { steps, missing: [...missing.values()], needsTable, needsFurnace };
}

/**
 * `RecipeTree.gatherRef`: what to gather for a missing material. Its family (`#minecraft:logs`) when the same plan,
 * given that much of every other natural kind of the family instead, lacks neither (the plan named oak only because
 * nothing was carried); else the item itself (a kind the recipe names, such as the oak planks of an oak door). A kind
 * the plan already lacks for itself (the spruce logs of a spruce fence) is given on top of that.
 */
export function gatherRefOf(
  world: SimWorld,
  item: string,
  count: number,
  plan: TreePlan,
  m: TreeMissing,
): string {
  if (m.item.startsWith('#')) return m.item;
  const id = normId(m.item);
  const lacking = plan.missing.reduce((n, x) => n + x.need, 0);
  for (const [tag, members] of familyMembers()) {
    if (!members.includes(id)) continue;
    const all = members.every((other) => {
      if (other === id) return true;
      const own = plan.missing.find((x) => normId(x.item) === other)?.need ?? 0;
      const inv = new Map(world.agent.inventory);
      inv.set(other, (inv.get(other) ?? 0) + m.need + own);
      const p = planTree(world, item, count, inv);
      const left = p.missing.reduce((n, x) => n + x.need, 0);
      const short = p.missing.some((x) => normId(x.item) === id || normId(x.item) === other);
      return !short && left <= lacking - m.need - own;
    });
    if (all) return tag;
  }
  return m.item;
}

/** The plan's missing materials with `any` where a family would do, and what to gather for each (by item). */
function familyRefs(
  world: SimWorld,
  item: string,
  count: number,
  plan: TreePlan,
): { missing: TreeMissing[]; refs: Map<string, string> } {
  const refs = new Map(plan.missing.map((m) => [m.item, gatherRefOf(world, item, count, plan, m)]));
  const missing = plan.missing.map((m) => {
    const ref = refs.get(m.item) ?? m.item;
    return ref === m.item ? m : { ...m, any: ref };
  });
  return { missing, refs };
}

/** `obs.query recipe{item, count, tree:true}` (M5). */
export function recipeTree(world: SimWorld, item: string, count: number): Record<string, unknown> {
  const p = planTree(world, item, count);
  const station = (id: string) => {
    const found = world
      .scan(world.agent.pos, 24, (i) => i === id)
      .sort((a, b) => dist(a.pos, world.agent.pos) - dist(b.pos, world.agent.pos))[0];
    if (found) return { pos: pos(found.pos) };
    return world.count((i) => i === id) > 0
      ? { how: 'put down the one you carry' }
      : { how: 'craft one first' };
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
    missing: familyRefs(world, item, count, p).missing,
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
            for (const [k, v] of Object.entries(
              (end.result.items as Record<string, number> | undefined) ?? {},
            )) {
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
            : fail(
                'MISSING_INGREDIENTS',
                `made only ${Math.max(0, made)} of ${count} ${shortId(item)}`,
                report(),
              );
        }
        // Plan (again).
        const plan = planTree(world, item, count);
        if (
          plan.steps.length === 0 &&
          plan.missing.length === 1 &&
          normId(plan.missing[0]?.item ?? '') === item
        ) {
          return fail('NO_RECIPE', `nothing crafts or smelts ${item}; gather it instead`, report());
        }
        if (plan.missing.length > 0) {
          const { missing, refs } = familyRefs(world, item, count, plan);
          if (!gatherMissing || rounds >= 3) {
            const text = missing
              .map((m) => `${m.item} ${m.need}${m.any ? ` (any ${m.any})` : ''}`)
              .join(', ');
            return fail('MISSING_INGREDIENTS', `raw materials missing: ${text}`, report({ missing }));
          }
          rounds++;
          phase = 'gather';
          // A family is gathered as a whole (the nearest log of any kind for planks); an item stays pinned.
          const needs = new Map<string, number>();
          for (const m of plan.missing) {
            const ref = refs.get(m.item) ?? m.item;
            needs.set(ref, (needs.get(ref) ?? 0) + m.need);
          }
          queue = [...needs].map(([ref, need]) => ({
            label: `gather ${ref}`,
            logic: () =>
              gatherJob(world, {
                item: ref.includes(':') || ref.startsWith('#') ? ref : `${NS}${ref}`,
                count: need,
                ...(ref.startsWith('#') ? {} : { pinned: true }),
              }),
          }));
          continue;
        }
        phase = 'steps';
        texts.length = 0;
        queue = plan.steps.map((s, i) => {
          const last = i === plan.steps.length - 1 && s.item === item;
          texts.push(
            `${Object.entries(s.from)
              .map(([k, v]) => `${shortId(k)} ${v}`)
              .join(' + ')} → ${shortId(s.item)} ${s.made}`,
          );
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
        const f = {
          code: end.error?.code ?? 'FAILED',
          msg: `step ${i + 1}/${n} ${skill}: ${end.error?.msg ?? 'failed'}`,
        };
        firstFail ??= f;
        if (stopOnFail) return fail(f.code, f.msg, summary());
      }
      return null;
    },
    (i, text) => [Math.min(1, i / Math.max(1, n)), `step ${i + 1}/${n} ${text}`.trim()],
  );
}

/**
 * W1: the protected blocks of a box (the dig / place refusal): the nearest one's verdict and every protected position,
 * or null when nothing in it is protected (or the running job's consent covers it).
 */
export function protectedIn(
  world: SimWorld,
  min: Pos,
  max: Pos,
): { verdict: Verdict; positions: Pos[] } | null {
  const positions: Pos[] = [];
  let nearest: Verdict | null = null;
  for (let x = min.x; x <= max.x; x++)
    for (let y = min.y; y <= max.y; y++)
      for (let z = min.z; z <= max.z; z++) {
        const v = world.protectedAt({ x, y, z });
        if (!v) continue;
        positions.push(v.pos);
        if (!nearest || dist(v.pos, world.agent.pos) < dist(nearest.pos, world.agent.pos)) nearest = v;
      }
  return nearest ? { verdict: nearest, positions } : null;
}

/**
 * `find` with W1 provenance (the mod's `Observations.find` for blocks): `provenance` natural / player-built / base /
 * agent-built with the owner (and the zone), the natural tree a log belongs to, `reachable` for the nearest three
 * unprotected matches only, and `protectedNote` when any match is protected. `filter` natural keeps natural blocks
 * (logs: trees only), built keeps placed or protected ones.
 */
export function findBlocks(
  world: SimWorld,
  ref: string,
  radius: number,
  limit: number,
  filter: string,
): { matches: Record<string, unknown>[]; protectedNote?: string } {
  const a = world.agent.pos;
  const isTagged = ref.startsWith('#');
  const isNatural = (m: {
    pos: Pos;
    block: { id: string; placedBy: string; structure?: string | undefined };
  }) =>
    m.block.placedBy === 'natural' &&
    world.protectedAt(m.pos, { ignoreGrant: true }) === null &&
    (!m.block.id.endsWith('_log') || (m.block.structure?.startsWith('tree:') ?? false));
  let reachChecks = 0;
  let built = 0;
  const matchesOut = world
    .scan(a, radius, (id) => matches(ref, id) && (!isTagged || filter !== 'natural' || !buildingVariant(id)))
    .filter((m) => (filter === 'natural' ? isNatural(m) : filter === 'built' ? !isNatural(m) : true))
    .sort((x, y) => dist(x.pos, a) - dist(y.pos, a))
    .slice(0, limit)
    .map((m) => {
      const out: Record<string, unknown> = {
        pos: pos(m.pos),
        block: m.block.id,
        distance: round1(dist(m.pos, a)),
        dir: compassDir(a, m.pos),
        exposed: world.exposed(m.pos),
      };
      const v = world.protectedAt(m.pos, { ignoreGrant: true });
      if (m.block.placedBy === 'agent') {
        out.provenance = 'agent-built';
        out.owner = world.agent.name;
      } else if (v) {
        out.provenance = v.what;
        out.owner = v.owner;
        if (v.zone) out.zone = v.zone;
        built++;
      } else {
        out.provenance = 'natural';
      }
      const structure = m.block.structure;
      if (m.block.id.endsWith('_log') && !v && m.block.placedBy === 'natural') {
        if (structure?.startsWith('tree:')) {
          const logs = world
            .scan(m.pos, 8, (id) => id === m.block.id)
            .filter((l) => l.block.structure === structure);
          const base = logs.reduce((lo, l) => (l.pos.y < lo.y ? l.pos : lo), m.pos);
          out.tree = {
            species: shortId(m.block.id).replace(/_log$/, ''),
            trunk: pos(base),
            logs: logs.length,
          };
        } else {
          out.note = 'a log without natural leaves: not a tree';
        }
      }
      if (!v && reachChecks++ < 3) {
        out.reachable = world.isUnreachable(m.pos)
          ? 'unreachable'
          : Math.hypot(m.pos.x - a.x, m.pos.z - a.z) > 56
            ? 'far'
            : 'reachable';
      }
      return out;
    });
  return built > 0
    ? {
        matches: matchesOut,
        protectedNote: `Matches marked player-built or base belong to ${world.player.name}: never break or change them without asking.`,
      }
    : { matches: matchesOut };
}
