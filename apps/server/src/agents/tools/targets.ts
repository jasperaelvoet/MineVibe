/**
 * Positions and targets of the v2 `mc` tools (docs/design/tools-v2-mc.md §4.1, §4.2).
 *
 * The model writes every position as a string `"x y z"` (spaces or commas), the way results print them, so it copies
 * them verbatim; the wire keeps `BlockPos {x,y,z}`. A target (`to`, `target`) is resolved in this order:
 *
 * 1. a position;
 * 2. `player`, or the player's name;
 * 3. a crew member: `@handle`, display name or agent id (becomes the agent id);
 * 4. a mod named place (`office`, `home`, `spawn`, `bed`, `chest`, `crafting_table`, `furnace`, `codex`, `pc:<id>`);
 * 5. a mob type (`cow`, `minecraft:zombie`) or an entity UUID;
 * 6. `goto` only: the title or id of a Codex `places` page.
 *
 * Nothing matching is `UNKNOWN_PLACE`.
 */

import type { BlockPos } from '@minevibe/protocol';
import { ApiError } from '../../contracts/common.js';

/**
 * `"12 64 -30"` or `"12,64,-30"` (tools-v2-mc.md §4.1). Wrapping quotes or brackets are tolerated (`"\"12 64 -30\""`,
 * `"[12, 64, -30]"`): Haiku sometimes copies the quotes of the schema's `"x y z"` into the value (eval, after v2).
 */
export const POS_RE = /^\s*["'[(]?\s*(-?\d{1,8})[\s,]+(-?\d{1,4})[\s,]+(-?\d{1,8})\s*["'\])]?\s*$/;

/** A `"x y z"` string as a block position, or null. */
export function parsePos(text: unknown): BlockPos | null {
  if (typeof text !== 'string') return null;
  const m = POS_RE.exec(text);
  if (!m) return null;
  const pos = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  return Number.isSafeInteger(pos.x) && Number.isSafeInteger(pos.y) && Number.isSafeInteger(pos.z)
    ? pos
    : null;
}

/** A required `"x y z"` argument; `BAD_ARGS` with an example otherwise. */
export function requirePos(text: unknown, field: string): BlockPos {
  const pos = parsePos(text);
  if (!pos) throw new ApiError('BAD_ARGS', `${field} must be "x y z", e.g. "12 64 -30"`);
  return pos;
}

/** An optional `"x y z"` argument. */
export function optionalPos(text: unknown, field: string): BlockPos | undefined {
  return text === undefined ? undefined : requirePos(text, field);
}

/** Places the mod resolves in `goto{entity}` (Places.java, protocol §7.4.2). */
export const MOD_PLACES = [
  'office',
  'home',
  'spawn',
  'bed',
  'chest',
  'crafting_table',
  'furnace',
  'codex',
] as const;
export type ModPlace = (typeof MOD_PLACES)[number];

const PC_PLACE_RE = /^pc:[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A namespaced id such as `minecraft:zombie` (taken as an entity type as it is). */
const NAMESPACED_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/**
 * Vanilla mobs a target may name without a namespace (living entities, plus the rideable and usable non-living
 * ones). A bare word outside this list is not taken as a mob, so `goto{"to":"mine"}` can still find a Codex place
 * called "mine" (or fail `UNKNOWN_PLACE`) instead of hunting for an entity type that does not exist.
 */
export const MOB_TYPES: ReadonlySet<string> = new Set([
  'allay',
  'armadillo',
  'axolotl',
  'bat',
  'bee',
  'blaze',
  'bogged',
  'breeze',
  'camel',
  'cat',
  'cave_spider',
  'chicken',
  'cod',
  'copper_golem',
  'cow',
  'creaking',
  'creeper',
  'dolphin',
  'donkey',
  'drowned',
  'elder_guardian',
  'enderman',
  'endermite',
  'evoker',
  'fox',
  'frog',
  'ghast',
  'glow_squid',
  'goat',
  'guardian',
  'happy_ghast',
  'hoglin',
  'horse',
  'husk',
  'iron_golem',
  'llama',
  'magma_cube',
  'mooshroom',
  'mule',
  'ocelot',
  'panda',
  'parrot',
  'phantom',
  'pig',
  'piglin',
  'piglin_brute',
  'pillager',
  'polar_bear',
  'pufferfish',
  'rabbit',
  'ravager',
  'salmon',
  'sheep',
  'shulker',
  'silverfish',
  'skeleton',
  'skeleton_horse',
  'slime',
  'sniffer',
  'snow_golem',
  'spider',
  'squid',
  'stray',
  'strider',
  'tadpole',
  'trader_llama',
  'tropical_fish',
  'turtle',
  'vex',
  'villager',
  'vindicator',
  'wandering_trader',
  'warden',
  'witch',
  'wither_skeleton',
  'wolf',
  'zoglin',
  'zombie',
  'zombie_horse',
  'zombie_villager',
  'zombified_piglin',
  // Rideable / usable things that are not mobs.
  'boat',
  'oak_boat',
  'minecart',
  'item_frame',
  'armor_stand',
]);

/** A crew member as the tools see one. */
export interface CrewRef {
  readonly agentId: string;
  readonly name: string;
  readonly handle: string;
}

/** What target resolution needs from the agent runtime. */
export interface TargetHost {
  playerName(): string;
  /** A crew member by `@handle`, name or agent id, or null. */
  crewMember?(ref: string): CrewRef | null;
}

export type Target =
  | { readonly kind: 'pos'; readonly pos: BlockPos; readonly label: string }
  | { readonly kind: 'player'; readonly entity: 'player'; readonly label: string }
  | { readonly kind: 'agent'; readonly entity: string; readonly label: string }
  | { readonly kind: 'place'; readonly entity: string; readonly label: string }
  | { readonly kind: 'mob'; readonly entity: string; readonly label: string }
  | { readonly kind: 'uuid'; readonly entity: string; readonly label: string };

/** What a target becomes on the wire: a block position, or an `EntityRef`. */
export function wireTarget(t: Target): { pos: BlockPos } | { entity: string } {
  return t.kind === 'pos' ? { pos: t.pos } : { entity: t.entity };
}

/**
 * Resolves rules 1-5 (§4.2). Returns null when nothing matches (the caller tries a Codex place, or fails
 * `UNKNOWN_PLACE`).
 */
export function resolveTarget(raw: string, host: TargetHost): Target | null {
  const text = raw.trim();
  const pos = parsePos(text);
  if (pos) return { kind: 'pos', pos, label: `${pos.x} ${pos.y} ${pos.z}` };
  const lower = text.toLowerCase();
  const player = host.playerName();
  if (lower === 'player' || lower === player.toLowerCase()) {
    return { kind: 'player', entity: 'player', label: player };
  }
  const crew = host.crewMember?.(text) ?? null;
  if (crew) return { kind: 'agent', entity: crew.agentId, label: crew.name };
  if ((MOD_PLACES as readonly string[]).includes(lower))
    return { kind: 'place', entity: lower, label: lower };
  if (PC_PLACE_RE.test(text)) return { kind: 'place', entity: text, label: text };
  if (UUID_RE.test(text)) return { kind: 'uuid', entity: lower, label: 'that entity' };
  const bare = lower.replace(/^minecraft:/, '');
  if (MOB_TYPES.has(bare) || NAMESPACED_RE.test(lower)) {
    return { kind: 'mob', entity: lower, label: bare };
  }
  return null;
}

/** Rules 1-5, or `UNKNOWN_PLACE` naming what was tried. */
export function requireTarget(raw: string, host: TargetHost, field = 'target'): Target {
  const t = resolveTarget(raw, host);
  if (t) return t;
  throw new ApiError(
    'UNKNOWN_PLACE',
    `no place, crew member or mob called "${raw.trim().slice(0, 60)}" (${field}: "x y z", "player", @handle, a mob type or a place)`,
  );
}
