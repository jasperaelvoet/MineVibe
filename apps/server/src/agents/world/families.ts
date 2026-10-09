/**
 * Material families (the mod's `Families`): kinds that stand in for each other as an ingredient. Any log makes planks
 * of its kind (and any planks make sticks, a crafting table or wooden tools); cobblestone, blackstone or cobbled
 * deepslate make stone tools and a furnace; coal or charcoal; wool where the color does not matter. The mod's craft
 * tree gathers the whole family when the recipe allows it, so a missing oak tree is no reason to stop or to ask; the
 * failure hints use these to say which tag gets "any kind". A kind the player named stays a hard stop.
 */

/** The family tag of an item id (`oak_log` → `#logs`), or null: a tag, a building variant, or no family. */
export function familyOf(item: string): string | null {
  const id = item
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '');
  if (id.startsWith('#') || id.startsWith('stripped_')) return null;
  if (/_(log|stem)$/.test(id)) return '#logs';
  if (id === 'cobblestone' || id === 'cobbled_deepslate' || id === 'blackstone')
    return '#stone_tool_materials';
  if (id === 'coal' || id === 'charcoal') return '#coals';
  if (id.endsWith('_wool')) return '#wool';
  return null;
}
