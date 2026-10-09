/**
 * v2 tool calls → wire skills (docs/design/tools-v2-mc.md §10, §11): one table shared by the single tools and the
 * steps of `do`. Cross-field rules the JSON schemas cannot carry ("place needs item and target") are checked here,
 * and every `BAD_ARGS` carries a corrected example the model can copy.
 *
 * Additive mod features are used only when the mod lists their cap in `hello.caps` (an older mod would silently drop
 * the new arguments, Gson ignores unknown fields); without it the translation falls back to what every mod does
 * (single-level craft, a Node-side container lookup, an inventory count for "give all").
 */

import { type BlockPos, ItemId, MOD_CAPS, type SkillName } from '@minevibe/protocol';
import { ApiError } from '../../contracts/common.js';
import { call, type JobMeta, posText, short } from './format.js';
import {
  optionalPos,
  requirePos,
  requireTarget,
  resolveTarget,
  type Target,
  type TargetHost,
  wireTarget,
} from './targets.js';

/** One skill to send. */
export interface WireCall {
  readonly skill: SkillName;
  readonly args: Record<string, unknown>;
  readonly meta: JobMeta;
}

/** What the translation needs from the agent runtime. */
export interface TranslateHost extends TargetHost {
  /** The mod's `hello.caps` (empty for an older mod). */
  caps(): ReadonlySet<string>;
  /** The body's block position, or null. */
  here(): BlockPos | null;
  /** A Codex `places` page (title or id) → its coordinates, or null (§4.2 rule 6, `goto` only). */
  codexPlace?(name: string): Promise<BlockPos | null>;
  /** An observation (fallback lookups for older mods). */
  obs(
    query: 'inventory' | 'find' | 'recipe',
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** World tools a `do` step may use. */
export const STEP_TOOLS = ['goto', 'gather', 'craft', 'build', 'use', 'items'] as const;
export type StepTool = (typeof STEP_TOOLS)[number];

/** Limits (§4.4). */
export const MAX_GATHER = 640;
export const DIG_MAX_BLOCKS = 1024;
export const GATHER_RADIUS = 48;
export const CONTAINER_RADIUS = 24;
/** `items{take}` without `count`: one stack. */
export const TAKE_DEFAULT = 64;

export function badArgs(message: string, example?: string): ApiError {
  return new ApiError('BAD_ARGS', example ? `${message}. Example: ${example}` : message);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** An item id or `#tag` (§4.3), or BAD_ARGS. */
function itemId(v: unknown, field: string, example: string, tagOk = true): string {
  const s = str(v);
  if (!s) throw badArgs(`${field} is required`, example);
  const id = s.toLowerCase();
  if (!ItemId.safeParse(id).success) throw badArgs(`${field} "${s.slice(0, 40)}" is not an item id`, example);
  if (!tagOk && id.startsWith('#')) throw badArgs(`${field} must be one item id, not a tag`, example);
  return id;
}

function has(host: TranslateHost, cap: string): boolean {
  return host.caps().has(cap);
}

// --- goto -------------------------------------------------------------------------------------------------------

export const GOTO_EXAMPLE = call('goto', { to: 'crafting_table' });

export async function translateGoto(a: Record<string, unknown>, host: TranslateHost): Promise<WireCall> {
  const to = str(a.to);
  if (!to) throw badArgs('to is required', GOTO_EXAMPLE);
  let target: Target | null = resolveTarget(to, host);
  let label = target?.label ?? to;
  if (!target) {
    const pos = (await host.codexPlace?.(to)) ?? null;
    if (!pos) {
      throw new ApiError('UNKNOWN_PLACE', `no place, crew member or mob called "${to.slice(0, 60)}"`);
    }
    target = { kind: 'pos', pos, label: posText(pos) };
    label = to;
  }
  const args: Record<string, unknown> = { ...wireTarget(target) };
  if (typeof a.range === 'number') args.range = a.range;
  return {
    skill: 'goto',
    args,
    meta: { tool: 'goto', skill: 'goto', what: `goto ${label.slice(0, 60)}`, from: host.here(), args: a },
  };
}

// --- gather -----------------------------------------------------------------------------------------------------

export const GATHER_EXAMPLE = call('gather', { item: 'oak_log', count: 10 });

/**
 * Natural blocks that drop another item when broken without silk touch (the mod's `GatherJobs.DROPS`, reversed), and
 * the ore tags. `gather` counts items gained, and the block itself never lands in the bag: `collect{item:"stone"}`
 * would break stone until the radius or the timeout ran out (v1's `mine` counted blocks). So gather asks for what
 * the block drops: "mine 10 iron ore" gets 10 raw iron.
 */
export const DROPPED_AS: Readonly<Record<string, string>> = {
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
  clay: 'clay_ball',
  glowstone: 'glowstone_dust',
  snow_block: 'snowball',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  '#coal_ores': 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  '#iron_ores': 'raw_iron',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  '#copper_ores': 'raw_copper',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  '#gold_ores': 'raw_gold',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  '#diamond_ores': 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  '#emerald_ores': 'emerald',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  '#redstone_ores': 'redstone',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  '#lapis_ores': 'lapis_lazuli',
  nether_quartz_ore: 'quartz',
};

export function translateGather(a: Record<string, unknown>, host: TranslateHost): WireCall {
  const asked = itemId(a.item, 'item', GATHER_EXAMPLE);
  const dropped = DROPPED_AS[short(asked)];
  const item = dropped ?? asked;
  const count = int(a.count);
  if (count === undefined || count < 1 || count > MAX_GATHER) {
    throw badArgs(`count must be 1-${MAX_GATHER}`, GATHER_EXAMPLE);
  }
  const near = optionalPos(a.near, 'near');
  const radius = int(a.radius) ?? GATHER_RADIUS;
  const args: Record<string, unknown> = { item, count, radius };
  if (has(host, MOD_CAPS.COLLECT_GATHER)) {
    if (near) args.near = near;
    args.make_tools = true;
  }
  // W1: plant a sapling on each stump of a felled tree (when one is carried); logs only.
  if (/(^|[:#_])logs?$|_log$/.test(item)) args.replant = true;
  return {
    skill: 'collect',
    args,
    meta: {
      tool: 'gather',
      skill: 'collect',
      what: dropped ? `gather ${dropped} (from ${short(asked)})` : `gather ${short(item)}`,
      want: { item, count },
      from: host.here(),
      args: a,
    },
  };
}

// --- craft ------------------------------------------------------------------------------------------------------

export const CRAFT_EXAMPLE = call('craft', { item: 'crafting_table' });

export async function translateCraft(a: Record<string, unknown>, host: TranslateHost): Promise<WireCall> {
  const item = itemId(a.item, 'item', CRAFT_EXAMPLE, false);
  const count = int(a.count) ?? 1;
  if (count < 1 || count > MAX_GATHER) throw badArgs(`count must be 1-${MAX_GATHER}`, CRAFT_EXAMPLE);
  const station = optionalPos(a.station, 'station');
  const meta: JobMeta = {
    tool: 'craft',
    skill: 'craft',
    what: `craft ${short(item)}`,
    want: { item, count },
    from: host.here(),
    args: a,
  };
  if (has(host, MOD_CAPS.CRAFT_TREE)) {
    const args: Record<string, unknown> = { item, count, tree: true };
    if (station) args.table = station;
    if (a.gather_missing === true) args.gather_missing = true;
    return { skill: 'craft', args, meta };
  }
  // An older mod crafts one level only, and smelting is its own skill: pick it when only a furnace makes the item.
  try {
    const recipe = await host.obs('recipe', { item });
    const recipes = Array.isArray(recipe.recipes) ? (recipe.recipes as Record<string, unknown>[]) : [];
    if (recipes.length > 0 && recipes.every((r) => r.station === 'furnace')) {
      const args: Record<string, unknown> = { item, count };
      if (station) args.furnace = station;
      return { skill: 'smelt', args, meta: { ...meta, skill: 'smelt' } };
    }
  } catch {
    // no recipe view: craft it and let the mod say what is wrong
  }
  const args: Record<string, unknown> = { item, count };
  if (station) args.table = station;
  return { skill: 'craft', args, meta };
}

// --- build ------------------------------------------------------------------------------------------------------

export const BUILD_EXAMPLES = {
  blueprint: call('build', { action: 'blueprint', blueprint: 'shelter', at: '10 64 -3' }),
  dig: call('build', { action: 'dig', from: '10 64 -3', to: '12 65 -1' }),
  farm: call('build', { action: 'farm', from: '10 64 -3', to: '16 64 3', crop: 'wheat_seeds' }),
} as const;

function box(from: BlockPos, to: BlockPos): string {
  return `${Math.abs(to.x - from.x) + 1}x${Math.abs(to.y - from.y) + 1}x${Math.abs(to.z - from.z) + 1}`;
}

export function translateBuild(a: Record<string, unknown>, host: TranslateHost): WireCall {
  const action = str(a.action);
  switch (action) {
    case 'blueprint': {
      const blueprint = str(a.blueprint);
      if (!blueprint || a.at === undefined) {
        throw badArgs('blueprint needs blueprint and at', BUILD_EXAMPLES.blueprint);
      }
      const origin = requirePos(a.at, 'at');
      const args: Record<string, unknown> = { blueprint: blueprint.toLowerCase(), origin };
      if (typeof a.rotation === 'number') args.rotation = a.rotation;
      return {
        skill: 'build',
        args,
        meta: {
          tool: 'build',
          skill: 'build',
          what: `build ${blueprint.toLowerCase().slice(0, 40)} at ${posText(origin)}`,
          from: host.here(),
          args: a,
        },
      };
    }
    case 'dig':
    case 'farm': {
      if (a.from === undefined || a.to === undefined) {
        throw badArgs(`${action} needs from and to`, BUILD_EXAMPLES[action]);
      }
      const from = requirePos(a.from, 'from');
      const to = requirePos(a.to, 'to');
      if (action === 'dig') {
        const volume =
          (Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1);
        if (volume > DIG_MAX_BLOCKS) {
          throw badArgs(
            `dig is at most ${DIG_MAX_BLOCKS} blocks at a time (that box has ${volume})`,
            BUILD_EXAMPLES.dig,
          );
        }
        return {
          skill: 'dig',
          args: { from, to },
          meta: {
            tool: 'build',
            skill: 'dig',
            what: `dig ${box(from, to)} box ${posText(from)}..${posText(to)}`,
            from: host.here(),
            args: a,
          },
        };
      }
      const args: Record<string, unknown> = { from, to };
      const crop = str(a.crop);
      if (crop) args.crop = itemId(crop, 'crop', BUILD_EXAMPLES.farm);
      return {
        skill: 'farm',
        args,
        meta: {
          tool: 'build',
          skill: 'farm',
          what: `farm ${posText(from)}..${posText(to)}`,
          from: host.here(),
          args: a,
        },
      };
    }
    default:
      throw badArgs('action is blueprint, dig or farm', BUILD_EXAMPLES.blueprint);
  }
}

// --- use --------------------------------------------------------------------------------------------------------

export const USE_EXAMPLES = {
  place: call('use', { action: 'place', item: 'crafting_table', target: '6 66 1' }),
  break: call('use', { action: 'break', target: '6 66 1' }),
  interact: call('use', { action: 'interact', target: '3 66 1' }),
  use_item: call('use', { action: 'use_item', item: 'bone_meal', target: '6 66 1' }),
  attack: call('use', { action: 'attack', target: 'zombie' }),
  ride: call('use', { action: 'ride', target: 'horse' }),
  dismount: call('use', { action: 'dismount' }),
  sleep: call('use', { action: 'sleep' }),
} as const;

function posTarget(a: Record<string, unknown>, action: keyof typeof USE_EXAMPLES): BlockPos {
  if (a.target === undefined) throw badArgs(`${action} needs target "x y z"`, USE_EXAMPLES[action]);
  return requirePos(a.target, 'target');
}

type EntityTarget = Exclude<Target, { kind: 'pos' }>;

function entityTarget(
  a: Record<string, unknown>,
  host: TranslateHost,
  action: keyof typeof USE_EXAMPLES,
): EntityTarget {
  const raw = str(a.target);
  if (!raw) throw badArgs(`${action} needs target`, USE_EXAMPLES[action]);
  const t = requireTarget(raw, host);
  if (t.kind === 'pos' || t.kind === 'place') {
    throw badArgs(
      `${action} needs an entity target ("player", @handle or a mob type), not a place`,
      USE_EXAMPLES[action],
    );
  }
  return t;
}

export function translateUse(a: Record<string, unknown>, host: TranslateHost): WireCall {
  const action = str(a.action) as keyof typeof USE_EXAMPLES | undefined;
  const here = host.here();
  const meta = (skill: string, what: string, extra: Partial<JobMeta> = {}): JobMeta => ({
    tool: 'use',
    skill,
    what,
    from: here,
    args: a,
    ...extra,
  });
  switch (action) {
    case 'place': {
      if (a.item === undefined || a.target === undefined) {
        throw badArgs('place needs item and target', USE_EXAMPLES.place);
      }
      const block = itemId(a.item, 'item', USE_EXAMPLES.place, false);
      const pos = posTarget(a, 'place');
      return {
        skill: 'place',
        args: { block, pos },
        meta: meta('place', `place ${short(block)} at ${posText(pos)}`),
      };
    }
    case 'break': {
      const pos = posTarget(a, 'break');
      return { skill: 'dig', args: { from: pos, to: pos }, meta: meta('dig', `break ${posText(pos)}`) };
    }
    case 'interact': {
      const raw = str(a.target);
      if (!raw) throw badArgs('interact needs target', USE_EXAMPLES.interact);
      const t = requireTarget(raw, host);
      if (t.kind === 'pos') {
        return { skill: 'use_block', args: { pos: t.pos }, meta: meta('use_block', `interact ${t.label}`) };
      }
      if (t.kind === 'place') throw badArgs('interact needs "x y z" or an entity', USE_EXAMPLES.interact);
      return { skill: 'use_item', args: { entity: t.entity }, meta: meta('use_item', `interact ${t.label}`) };
    }
    case 'use_item': {
      const args: Record<string, unknown> = {};
      let what = 'use ';
      if (a.item !== undefined) {
        args.item = itemId(a.item, 'item', USE_EXAMPLES.use_item, false);
        what += short(args.item as string);
      } else what += 'held item';
      const raw = str(a.target);
      if (raw) {
        const t = requireTarget(raw, host);
        if (t.kind === 'place')
          throw badArgs('use_item target is "x y z" or an entity', USE_EXAMPLES.use_item);
        Object.assign(args, wireTarget(t));
        what += ` on ${t.label}`;
      }
      return { skill: 'use_item', args, meta: meta('use_item', what) };
    }
    case 'attack': {
      const t = entityTarget(a, host, 'attack');
      if (t.kind === 'player' || t.kind === 'agent') {
        throw new ApiError('BAD_TARGET', 'players and agents are never attacked');
      }
      const count = int(a.count) ?? 1;
      if (count > 1) {
        if (t.kind !== 'mob') throw badArgs('attack with count needs a mob type', USE_EXAMPLES.attack);
        return {
          skill: 'hunt',
          args: { entity: t.entity, count },
          meta: meta('hunt', `attack ${t.label} ×${count}`, { want: { item: t.label, count } }),
        };
      }
      return { skill: 'attack', args: { entity: t.entity }, meta: meta('attack', `attack ${t.label}`) };
    }
    case 'ride': {
      const t = entityTarget(a, host, 'ride');
      return { skill: 'ride', args: { entity: t.entity }, meta: meta('ride', `ride ${t.label}`) };
    }
    case 'dismount':
      return { skill: 'dismount', args: {}, meta: meta('dismount', 'dismount') };
    case 'sleep': {
      const pos = a.target === undefined ? undefined : posTarget(a, 'sleep');
      return { skill: 'sleep', args: pos ? { pos } : {}, meta: meta('sleep', 'sleep') };
    }
    default:
      throw badArgs(
        'action is place, break, interact, use_item, attack, ride, dismount or sleep',
        USE_EXAMPLES.place,
      );
  }
}

// --- items ------------------------------------------------------------------------------------------------------

export const ITEMS_EXAMPLES = {
  equip: call('items', { action: 'equip', item: 'iron_pickaxe' }),
  eat: call('items', { action: 'eat' }),
  drop: call('items', { action: 'drop', item: 'dirt', count: 32 }),
  give: call('items', { action: 'give', item: 'oak_log', count: 5, to: 'player' }),
  store: call('items', { action: 'store', item: 'cobblestone' }),
  take: call('items', { action: 'take', item: 'bread', count: 5 }),
  list: call('items', { action: 'list' }),
} as const;

/** The nearest chest or barrel within 24 blocks, for an older mod (§5.8, M6). */
async function nearestContainer(host: TranslateHost): Promise<BlockPos> {
  for (const what of ['minecraft:chest', 'minecraft:barrel']) {
    try {
      const found = await host.obs('find', { what, radius: CONTAINER_RADIUS, limit: 1 });
      const first = Array.isArray(found.matches)
        ? (found.matches[0] as Record<string, unknown> | undefined)
        : undefined;
      const p = first?.pos as Record<string, unknown> | undefined;
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        return { x: p.x, y: p.y, z: p.z };
      }
    } catch {
      // try the next kind
    }
  }
  throw new ApiError(
    'NOT_FOUND',
    `no chest or barrel within ${CONTAINER_RADIUS} blocks; give container "x y z"`,
  );
}

/** How many of `item` the agent carries (for "give all" on an older mod). */
async function carried(host: TranslateHost, item: string): Promise<number> {
  const inv = await host.obs('inventory', {});
  const totals = (inv.totals ?? {}) as Record<string, unknown>;
  const want = item.includes(':') ? item : `minecraft:${item}`;
  const n = totals[want];
  return typeof n === 'number' ? n : 0;
}

export async function translateItems(a: Record<string, unknown>, host: TranslateHost): Promise<WireCall> {
  const action = str(a.action) as keyof typeof ITEMS_EXAMPLES | undefined;
  const here = host.here();
  const meta = (skill: string, what: string, extra: Partial<JobMeta> = {}): JobMeta => ({
    tool: 'items',
    skill,
    what,
    from: here,
    args: a,
    ...extra,
  });
  const count = int(a.count);
  switch (action) {
    case 'equip': {
      const item = itemId(a.item, 'item', ITEMS_EXAMPLES.equip);
      const args: Record<string, unknown> = { item };
      if (typeof a.slot === 'string') args.slot = a.slot;
      return { skill: 'equip', args, meta: meta('equip', `equip ${short(item)}`) };
    }
    case 'eat': {
      const item = a.item === undefined ? undefined : itemId(a.item, 'item', ITEMS_EXAMPLES.eat);
      return {
        skill: 'eat',
        args: item ? { item } : {},
        meta: meta('eat', `eat ${item ? short(item) : 'the best food'}`),
      };
    }
    case 'drop': {
      const item = itemId(a.item, 'item', ITEMS_EXAMPLES.drop);
      const args: Record<string, unknown> = { item };
      if (count !== undefined) args.count = count;
      return { skill: 'drop', args, meta: meta('drop', `drop ${short(item)}`) };
    }
    case 'give': {
      if (a.item === undefined || a.to === undefined)
        throw badArgs('give needs item and to', ITEMS_EXAMPLES.give);
      const item = itemId(a.item, 'item', ITEMS_EXAMPLES.give);
      const raw = str(a.to) ?? '';
      const t = requireTarget(raw, host, 'to');
      if (t.kind === 'pos' || t.kind === 'place') {
        throw badArgs('to is "player", a crew @handle or an entity, not a place', ITEMS_EXAMPLES.give);
      }
      const args: Record<string, unknown> = { item, to: t.entity };
      if (count !== undefined) args.count = count;
      else if (!has(host, MOD_CAPS.GIVE_ALL)) {
        const n = await carried(host, item);
        if (n <= 0) throw new ApiError('NO_ITEM', `you have no ${short(item)}`);
        args.count = n;
      }
      return {
        skill: 'give',
        args,
        meta: meta('give', `give ${short(item)} to ${t.label}`, count ? { want: { item, count } } : {}),
      };
    }
    case 'store':
    case 'take':
    case 'list': {
      const args: Record<string, unknown> = { action: action === 'store' ? 'put' : action };
      if (action !== 'list') {
        const item = itemId(a.item, 'item', ITEMS_EXAMPLES[action]);
        args.item = item;
        if (count !== undefined) args.count = count;
        else if (action === 'take') args.count = TAKE_DEFAULT;
      }
      let pos = optionalPos(a.container, 'container');
      if (!pos && !has(host, MOD_CAPS.CONTAINER_NEAREST)) pos = await nearestContainer(host);
      if (pos) args.pos = pos;
      const where = pos ? `container at ${posText(pos)}` : 'the nearest chest';
      const what =
        action === 'list'
          ? `list ${where}`
          : `${action} ${short(args.item as string)} ${action === 'store' ? 'in' : 'from'} ${where}`;
      return { skill: 'container', args, meta: meta('container', what) };
    }
    default:
      throw badArgs('action is equip, eat, drop, give, store, take or list', ITEMS_EXAMPLES.give);
  }
}

// --- menu -------------------------------------------------------------------------------------------------------

export const MENU_EXAMPLES = {
  open: call('menu', { action: 'open', target: 'villager' }),
  click: call('menu', { action: 'click', slot: -2 }),
} as const;

export function translateMenu(a: Record<string, unknown>, host: TranslateHost): WireCall {
  const action = str(a.action);
  const here = host.here();
  const meta = (skill: string, what: string): JobMeta => ({ tool: 'menu', skill, what, from: here, args: a });
  switch (action) {
    case 'open': {
      const raw = str(a.target);
      if (!raw) throw badArgs('open needs target', MENU_EXAMPLES.open);
      const t = requireTarget(raw, host);
      if (t.kind === 'place') throw badArgs('open needs "x y z" or an entity', MENU_EXAMPLES.open);
      return { skill: 'open_menu', args: { ...wireTarget(t) }, meta: meta('open_menu', `open ${t.label}`) };
    }
    case 'click': {
      const slot = int(a.slot);
      if (slot === undefined) throw badArgs('click needs slot', MENU_EXAMPLES.click);
      const button = int(a.button) ?? 0;
      const type = str(a.click) ?? 'pickup';
      return {
        skill: 'menu_click',
        args: { slot, button, type },
        meta: meta('menu_click', `click ${slot <= -2 ? `button ${slot}` : `slot ${slot}`}`),
      };
    }
    case 'close':
      return { skill: 'menu_close', args: {}, meta: meta('menu_close', 'close the menu') };
    default:
      throw badArgs('action is open, state, click or close', MENU_EXAMPLES.open);
  }
}

// --- do ---------------------------------------------------------------------------------------------------------

export const DO_EXAMPLE = call('do', {
  steps: [
    { tool: 'gather', args: { item: 'oak_log', count: 10 } },
    { tool: 'craft', args: { item: 'crafting_table' } },
  ],
});

/** One `do` step → its wire call, with errors that name the step (§5.10). */
export async function translateStep(
  index: number,
  step: { tool: string; args: Record<string, unknown> },
  host: TranslateHost,
): Promise<WireCall> {
  const n = index + 1;
  try {
    const a = step.args ?? {};
    switch (step.tool as StepTool) {
      case 'goto':
        return await translateGoto(a, host);
      case 'gather':
        return translateGather(a, host);
      case 'craft':
        if (a.plan === true) throw badArgs('craft{plan} is not a step: call it on its own');
        return await translateCraft(a, host);
      case 'build':
        return translateBuild(a, host);
      case 'use':
        return translateUse(a, host);
      case 'items':
        if (a.action === 'list') throw badArgs('items{list} is not a step: call it on its own');
        return await translateItems(a, host);
      default:
        throw badArgs(`tool is one of ${STEP_TOOLS.join(', ')}`, DO_EXAMPLE);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ApiError(err.code, `step ${n} ${step.tool}: ${err.message}`);
    }
    throw err;
  }
}
