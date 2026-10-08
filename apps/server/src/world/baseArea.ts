/**
 * The Base: the starter office OfficeBuilder puts at spawn, which is the player's home (PLAN §7.5, protocol §6.4 and
 * §7.4.3). Node derives its extent from `world.state.office` (the north-west floor corner `origin` plus the slots), so
 * the agents' scene line, the perception texts and the Codex "Base (office)" page all name the same box.
 *
 * Geometry helpers for the agents' world view live here too: compass directions (north is -Z, east is +X) and
 * distances, rounded the way the model reads them ("25m NE").
 */

import type { BlockPos, PayloadOf } from '@minevibe/protocol';

export type OfficeLayout = NonNullable<PayloadOf<'world.state'>['office']>;

/** What agents and the Codex call the starter office. */
export const BASE_NAME = 'Base (office)';

/**
 * OfficeBuilder's footprint from `origin` (OfficePlan: 13 cells west to east, 9 north to south plus the porch row,
 * floor 0 to roof 5). The slots extend it if a later plan grows.
 */
export const OFFICE_FOOTPRINT = Object.freeze({ width: 13, depth: 10, height: 6 });

/** Blocks around the walls that still count as the Base (its grounds: the porch, the yard). */
export const BASE_GROUNDS = 4;

/** OfficeBuilder's foundation fills at most this far below the floor (OfficePlan.MAX_FOUNDATION_DEPTH). */
export const FOUNDATION_DEPTH = 24;

/**
 * What OfficeBuilder builds the Base of (keep in sync with OfficeBuilder): its foundation, floor, walls, corner pillars,
 * windows, door, lights and furniture. MineVibe's own blocks (`minevibe:*`: desks, chairs, the Codex, the calendar)
 * and beds count too ({@link isBaseMaterial}). A mod without provenance (protocol §7.4.3) cannot tell these from
 * natural blocks.
 */
const BASE_MATERIALS: ReadonlySet<string> = new Set([
  'cobblestone',
  'spruce_planks',
  'oak_planks',
  'polished_andesite',
  'stone_bricks',
  'stripped_spruce_log',
  'spruce_door',
  'glass_pane',
  'furnace',
  'crafting_table',
  'chest',
  'lantern',
  'torch',
  'wall_torch',
]);
/** Building variants of the same kinds (any wood's planks or stripped logs, bricks, glass, doors, beds). */
const BUILDING_VARIANT_RE = /^stripped_|_planks$|_bricks$|glass|_door$|_bed$/;

/** Whether a block or item id (`minecraft:` optional) is something the Base is built of. Tags are not judged here. */
export function isBaseMaterial(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (lower.startsWith('#')) return false;
  if (lower.startsWith('minevibe:')) return true;
  const bare = lower.replace(/^minecraft:/, '');
  return BASE_MATERIALS.has(bare) || BUILDING_VARIANT_RE.test(bare);
}

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BaseArea {
  readonly name: string;
  /** Inclusive corners of the building (footprint, porch, floor to roof). */
  readonly min: BlockPos;
  readonly max: BlockPos;
  /** The porch cell in front of the door (the `door` slot), if reported. */
  readonly door: BlockPos | null;
  /** The floor level (origin y). */
  readonly floorY: number;
}

/** The Base of a reported office, or null without one. */
export function baseAreaOf(office: OfficeLayout | null | undefined): BaseArea | null {
  if (!office) return null;
  const o = office.origin;
  let min = { x: o.x, y: o.y, z: o.z };
  let max = {
    x: o.x + OFFICE_FOOTPRINT.width - 1,
    y: o.y + OFFICE_FOOTPRINT.height - 1,
    z: o.z + OFFICE_FOOTPRINT.depth - 1,
  };
  for (const s of office.slots) {
    min = { x: Math.min(min.x, s.pos.x), y: Math.min(min.y, s.pos.y), z: Math.min(min.z, s.pos.z) };
    max = { x: Math.max(max.x, s.pos.x), y: Math.max(max.y, s.pos.y), z: Math.max(max.z, s.pos.z) };
  }
  const door = office.slots.find((s) => s.kind === 'door')?.pos ?? null;
  return { name: BASE_NAME, min, max, door: door ? { ...door } : null, floorY: o.y };
}

/** Whether `pos` is inside the Base building, or within `grounds` blocks of its walls (default: the grounds). */
export function inBase(pos: Vec3Like, base: BaseArea, grounds = BASE_GROUNDS): boolean {
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  return (
    x >= base.min.x - grounds &&
    x <= base.max.x + grounds &&
    z >= base.min.z - grounds &&
    z <= base.max.z + grounds &&
    y >= base.min.y - grounds &&
    y <= base.max.y + grounds
  );
}

/** Straight-line distance from `pos` to the nearest point of the box `min..max` (0 inside it). */
export function distanceToBox(pos: Vec3Like, min: Vec3Like, max: Vec3Like): number {
  const gap = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  return Math.hypot(gap(pos.x, min.x, max.x), gap(pos.y, min.y, max.y), gap(pos.z, min.z, max.z));
}

/** The Base's centre at floor level. */
export function baseCenter(base: BaseArea): Vec3Like {
  return {
    x: Math.floor((base.min.x + base.max.x) / 2),
    y: base.floorY,
    z: Math.floor((base.min.z + base.max.z) / 2),
  };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Compass = (typeof COMPASS)[number];

/** The 8-point compass direction from `from` to `to` (Minecraft: north is -Z, east is +X), or null when on top. */
export function compassDir(from: Vec3Like, to: Vec3Like): Compass | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return null;
  // 0 = north, clockwise.
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const sector = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return COMPASS[sector] ?? null;
}

/** Horizontal-and-vertical distance, in whole blocks. */
export function blocksBetween(a: Vec3Like, b: Vec3Like): number {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
}

/** "25m NE" (or "here" when within a block). */
export function distanceAndDir(from: Vec3Like, to: Vec3Like): string {
  const d = blocksBetween(from, to);
  const dir = compassDir(from, to);
  if (d <= 1 && dir === null) return 'here';
  return dir ? `${d}m ${dir}` : `${d}m`;
}

/** "12 64 -30". */
export function posText(p: Vec3Like): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
}

/** A `{x,y,z}` with numeric fields, else null (tolerant reader for the mod's JSON results). */
export function asPos(value: unknown): BlockPos | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') return null;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null;
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}
