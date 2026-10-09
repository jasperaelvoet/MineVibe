/**
 * Item and block data of the simulated world: ids, the tags the scenarios touch, what a block drops and which tool it
 * needs, how long it takes to break, crafting and smelting recipes, and fuels. Values follow vanilla closely enough
 * that the agent-facing numbers (counts, failure codes, rough timings) match the mod; nothing here is exhaustive.
 */

export const NS = 'minecraft:';

/** `oak_log` → `minecraft:oak_log`; `#logs` → `#minecraft:logs`. */
export function normId(ref: string): string {
  const tag = ref.startsWith('#');
  const body = (tag ? ref.slice(1) : ref).trim().toLowerCase();
  const full = body.includes(':') ? body : `${NS}${body}`;
  return tag ? `#${full}` : full;
}

/** `minecraft:oak_log` → `oak_log`. */
export function shortId(id: string): string {
  return id.startsWith(NS) ? id.slice(NS.length) : id;
}

const WOODS = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'] as const;

function ids(list: readonly string[]): string[] {
  return list.map((s) => `${NS}${s}`);
}

function logsOf(wood: string): string[] {
  return ids([`${wood}_log`, `${wood}_wood`, `stripped_${wood}_log`, `stripped_${wood}_wood`]);
}

/** Block and item tags (one table: the scenarios only use tags that exist for both). */
export const TAGS: Readonly<Record<string, readonly string[]>> = {
  'minecraft:logs': WOODS.flatMap(logsOf),
  'minecraft:logs_that_burn': WOODS.flatMap(logsOf),
  // Every wood's own logs tag (`#oak_logs`, …): its planks recipe takes any of them.
  ...Object.fromEntries(WOODS.map((w) => [`minecraft:${w}_logs`, logsOf(w)])),
  'minecraft:planks': ids(WOODS.map((w) => `${w}_planks`)),
  'minecraft:leaves': ids(WOODS.map((w) => `${w}_leaves`)),
  'minecraft:iron_ores': ids(['iron_ore', 'deepslate_iron_ore']),
  'minecraft:coal_ores': ids(['coal_ore', 'deepslate_coal_ore']),
  'minecraft:stone_crafting_materials': ids(['cobblestone', 'cobbled_deepslate', 'blackstone']),
  'minecraft:stone_tool_materials': ids(['cobblestone', 'cobbled_deepslate', 'blackstone']),
  'minecraft:coals': ids(['coal', 'charcoal']),
  'minecraft:beds': ids(['red_bed', 'white_bed']),
  'minecraft:doors': ids(['oak_door', 'spruce_door']),
  'minecraft:wooden_doors': ids(['oak_door', 'spruce_door']),
};

/** The mod's `Families.TAGS`, in order: material families whose kinds stand in for each other as ingredients. */
export const FAMILY_TAGS: readonly string[] = [
  'minecraft:logs',
  // The mod's next try when a stem would not do (a plan that smelts); the sim has no stems, so `logs` always wins.
  'minecraft:logs_that_burn',
  'minecraft:stone_tool_materials',
  'minecraft:stone_crafting_materials',
  'minecraft:coals',
  'minecraft:wool',
];

/** `Families.members`: each family's natural kinds (no stripped logs, wood or planks), families of one left out. */
export function familyMembers(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const tag of FAMILY_TAGS) {
    const members = (TAGS[tag] ?? []).filter((id) => !/^minecraft:stripped_|_(wood|hyphae|planks)$/.test(id));
    if (members.length > 1) out.set(`#${tag}`, members);
  }
  return out;
}

/** `Families.of`: the family of an item id (`oak_log` → `#minecraft:logs`), or null (a tag, or no family). */
export function familyOf(ref: string): string | null {
  const id = normId(ref.trim().split(/\s+/)[0] ?? '');
  if (id.startsWith('#')) return null;
  for (const [tag, members] of familyMembers()) if (members.includes(id)) return tag;
  return null;
}

/** Whether `id` (namespaced) matches `ref` (an id or a `#tag`, any namespace form). */
export function matches(ref: string, id: string): boolean {
  const r = normId(ref);
  if (r.startsWith('#')) return TAGS[r.slice(1)]?.includes(id) ?? false;
  return r === id;
}

export type ToolKind = 'axe' | 'pickaxe' | 'shovel' | 'hoe' | 'sword';
export type ToolTier = 'wooden' | 'stone' | 'iron' | 'diamond';
const TIER_RANK: Readonly<Record<ToolTier, number>> = { wooden: 1, stone: 2, iron: 3, diamond: 4 };
const TIER_SPEED: Readonly<Record<ToolTier, number>> = { wooden: 2, stone: 4, iron: 6, diamond: 8 };

export interface BlockSpec {
  /** What breaking it gives (null: nothing). */
  readonly drop: string | null;
  readonly hardness: number;
  readonly tool: ToolKind | null;
  /** The lowest tool tier that harvests it; without it the block drops nothing (`NEEDS_TOOL`). */
  readonly needs?: ToolTier;
  /** Solid blocks hide their neighbours (an enclosed block is not "exposed"). */
  readonly solid: boolean;
}

function spec(drop: string | null, hardness: number, tool: ToolKind | null, extra: Partial<BlockSpec> = {}) {
  return { drop, hardness, tool, solid: true, ...extra } satisfies BlockSpec;
}

const BLOCKS = new Map<string, BlockSpec>();
for (const w of WOODS) {
  for (const id of logsOf(w)) BLOCKS.set(id, spec(id, 2, 'axe'));
  BLOCKS.set(`${NS}${w}_planks`, spec(`${NS}${w}_planks`, 2, 'axe'));
  BLOCKS.set(`${NS}${w}_leaves`, spec(null, 0.2, 'hoe'));
}
const more: [string, BlockSpec][] = [
  ['grass_block', spec(`${NS}dirt`, 0.6, 'shovel')],
  ['dirt', spec(`${NS}dirt`, 0.5, 'shovel')],
  ['stone', spec(`${NS}cobblestone`, 1.5, 'pickaxe', { needs: 'wooden' })],
  ['cobblestone', spec(`${NS}cobblestone`, 2, 'pickaxe', { needs: 'wooden' })],
  ['deepslate', spec(`${NS}cobbled_deepslate`, 3, 'pickaxe', { needs: 'wooden' })],
  ['cobbled_deepslate', spec(`${NS}cobbled_deepslate`, 3.5, 'pickaxe', { needs: 'wooden' })],
  ['blackstone', spec(`${NS}blackstone`, 1.5, 'pickaxe', { needs: 'wooden' })],
  ['iron_ore', spec(`${NS}raw_iron`, 3, 'pickaxe', { needs: 'stone' })],
  ['coal_ore', spec(`${NS}coal`, 3, 'pickaxe', { needs: 'wooden' })],
  ['crafting_table', spec(`${NS}crafting_table`, 2.5, 'axe')],
  ['chest', spec(`${NS}chest`, 2.5, 'axe')],
  ['furnace', spec(`${NS}furnace`, 3.5, 'pickaxe', { needs: 'wooden' })],
  ['oak_door', spec(`${NS}oak_door`, 3, 'axe', { solid: false })],
  ['spruce_door', spec(`${NS}spruce_door`, 3, 'axe', { solid: false })],
  ['red_bed', spec(`${NS}red_bed`, 0.2, null, { solid: false })],
  ['glass_pane', spec(null, 0.3, null, { solid: false })],
  ['flower_pot', spec(`${NS}flower_pot`, 0, null, { solid: false })],
  ['potted_poppy', spec(`${NS}flower_pot`, 0, null, { solid: false })],
  ['torch', spec(`${NS}torch`, 0, null, { solid: false })],
  ['water', spec(null, -1, null, { solid: false })],
  ['bedrock', spec(null, -1, null)],
];
for (const [id, s] of more) BLOCKS.set(`${NS}${id}`, s);

export function blockSpec(id: string): BlockSpec {
  return BLOCKS.get(id) ?? spec(id, 1, null);
}

export function isKnownBlock(id: string): boolean {
  return BLOCKS.has(id);
}

/** A held tool: kind and tier, or null. */
export function toolOf(item: string | null): { kind: ToolKind; tier: ToolTier } | null {
  if (!item) return null;
  const m = /^minecraft:(wooden|stone|iron|diamond)_(axe|pickaxe|shovel|hoe|sword)$/.exec(item);
  return m ? { tier: m[1] as ToolTier, kind: m[2] as ToolKind } : null;
}

/**
 * Seconds to break a block with the best tool among `tools` (vanilla formula: hardness × 1.5 / speed when the tool
 * fits and harvests, hardness × 5 when the block needs a tool it does not get). `harvest` is false when it would
 * drop nothing.
 */
export function breakTime(id: string, tools: readonly string[]): { seconds: number; harvest: boolean } {
  const s = blockSpec(id);
  if (s.hardness < 0) return { seconds: Number.POSITIVE_INFINITY, harvest: false };
  let best: { kind: ToolKind; tier: ToolTier } | null = null;
  for (const t of tools) {
    const tool = toolOf(t);
    if (!tool || tool.kind !== s.tool) continue;
    if (!best || TIER_RANK[tool.tier] > TIER_RANK[best.tier]) best = tool;
  }
  const harvest = s.needs === undefined || (best !== null && TIER_RANK[best.tier] >= TIER_RANK[s.needs]);
  if (!harvest) return { seconds: s.hardness * 5, harvest: false };
  const speed = best ? TIER_SPEED[best.tier] : 1;
  return { seconds: Math.max(0.05, (s.hardness * 1.5) / speed), harvest: true };
}

/** Items that stack to 1 (tools, beds). */
export function maxStack(id: string): number {
  if (toolOf(id) || id.endsWith('_bed')) return 1;
  return 64;
}

export interface Ingredient {
  /** An item id or `#tag`. */
  readonly ref: string;
  readonly count: number;
}

export interface CraftRecipe {
  readonly id: string;
  readonly result: string;
  readonly makes: number;
  readonly ingredients: readonly Ingredient[];
  /** Fits the 2x2 inventory grid. */
  readonly small: boolean;
}

function craft(
  id: string,
  result: string,
  makes: number,
  ingredients: [string, number][],
  small: boolean,
): CraftRecipe {
  return {
    id: `${NS}${id}`,
    result: `${NS}${result}`,
    makes,
    ingredients: ingredients.map(([ref, count]) => ({ ref: normId(ref), count })),
    small,
  };
}

export const CRAFTING: readonly CraftRecipe[] = [
  ...WOODS.map((w) => craft(`${w}_planks`, `${w}_planks`, 4, [[`#${w}_logs`, 1]], true)).filter(
    (r) => TAGS[r.ingredients[0]?.ref.slice(1) ?? ''] !== undefined,
  ),
  craft('stick', 'stick', 4, [['#planks', 2]], true),
  craft('crafting_table', 'crafting_table', 1, [['#planks', 4]], true),
  craft(
    'torch',
    'torch',
    4,
    [
      ['#coals', 1],
      ['stick', 1],
    ],
    true,
  ),
  craft('chest', 'chest', 1, [['#planks', 8]], false),
  craft('furnace', 'furnace', 1, [['#stone_crafting_materials', 8]], false),
  craft(
    'wooden_pickaxe',
    'wooden_pickaxe',
    1,
    [
      ['#planks', 3],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'wooden_axe',
    'wooden_axe',
    1,
    [
      ['#planks', 3],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'wooden_sword',
    'wooden_sword',
    1,
    [
      ['#planks', 2],
      ['stick', 1],
    ],
    false,
  ),
  craft(
    'stone_pickaxe',
    'stone_pickaxe',
    1,
    [
      ['#stone_tool_materials', 3],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'stone_axe',
    'stone_axe',
    1,
    [
      ['#stone_tool_materials', 3],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'stone_sword',
    'stone_sword',
    1,
    [
      ['#stone_tool_materials', 2],
      ['stick', 1],
    ],
    false,
  ),
  craft(
    'stone_shovel',
    'stone_shovel',
    1,
    [
      ['#stone_tool_materials', 1],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'stone_hoe',
    'stone_hoe',
    1,
    [
      ['#stone_tool_materials', 2],
      ['stick', 2],
    ],
    false,
  ),
  // A kind the recipe names: oak planks only (the family test keeps oak logs for it).
  craft('oak_door', 'oak_door', 3, [['oak_planks', 6]], false),
  // A named kind beside an ingredient any wood makes: spruce planks, and sticks.
  craft(
    'spruce_fence',
    'spruce_fence',
    3,
    [
      ['spruce_planks', 4],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'iron_pickaxe',
    'iron_pickaxe',
    1,
    [
      ['iron_ingot', 3],
      ['stick', 2],
    ],
    false,
  ),
  craft(
    'iron_sword',
    'iron_sword',
    1,
    [
      ['iron_ingot', 2],
      ['stick', 1],
    ],
    false,
  ),
  craft('bread', 'bread', 1, [['wheat', 3]], false),
];

export interface SmeltRecipe {
  readonly id: string;
  /** An item id or `#tag`. */
  readonly input: string;
  readonly result: string;
}

export const SMELTING: readonly SmeltRecipe[] = [
  { id: `${NS}iron_ingot_from_smelting_raw_iron`, input: `${NS}raw_iron`, result: `${NS}iron_ingot` },
  { id: `${NS}iron_ingot_from_smelting_iron_ore`, input: `${NS}iron_ore`, result: `${NS}iron_ingot` },
  { id: `${NS}charcoal`, input: '#minecraft:logs_that_burn', result: `${NS}charcoal` },
  { id: `${NS}stone`, input: `${NS}cobblestone`, result: `${NS}stone` },
  { id: `${NS}cooked_beef`, input: `${NS}beef`, result: `${NS}cooked_beef` },
];

/** Ticks a fuel item burns (200 smelts one item); 0 when it is no fuel. */
export function burnTicks(id: string): number {
  if (id === `${NS}coal` || id === `${NS}charcoal`) return 1600;
  if (matches('#minecraft:logs_that_burn', id) || matches('#minecraft:planks', id)) return 300;
  if (id === `${NS}stick`) return 100;
  return 0;
}

/** Food points of edible items. */
export const FOOD: Readonly<Record<string, number>> = {
  [`${NS}bread`]: 5,
  [`${NS}apple`]: 4,
  [`${NS}cooked_beef`]: 8,
  [`${NS}beef`]: 3,
};
