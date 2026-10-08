/**
 * The world guard's failures as teaching text (protocol §7.4.3). The mod refuses with `PROTECTED` (the job would
 * break or replace a block of the Base or one the player placed) or `NO_NATURAL_SOURCE` (nothing natural of the kind
 * is in reach). Those are hard stops: the text the model reads says what happened in one line, what it must not do
 * (retry, substitute a tag or another block, dig around the guard) and what to do instead (gather elsewhere, or ask
 * the player with a card).
 *
 * A gathering job that finds nothing (`NOT_FOUND`) or cannot path (`UNREACHABLE`) gets the same "don't substitute,
 * ask" hint: the incident that motivated this ("the oak logs were out of reach, so I'm mining the nearest logs
 * instead") started exactly there.
 */

import { type BlockPos, WORLD_GUARD_CODES, type ZoneKind } from '@minevibe/protocol';
import {
  asPos,
  type BaseArea,
  distanceToBox,
  FOUNDATION_DEPTH,
  inBase,
  isBaseMaterial,
  posText,
  type Vec3Like,
} from '../../world/baseArea.js';
import { singleLine } from '../envelope.js';

export const PROTECTED = WORLD_GUARD_CODES.PROTECTED;
export const NO_NATURAL_SOURCE = WORLD_GUARD_CODES.NO_NATURAL_SOURCE;

/** Skills whose jobs gather a resource the player asked for. */
const GATHERING = new Set(['mine', 'collect']);

/** What a `PROTECTED` refusal covered: the blocks (from `result.protected`) and their zone. */
export interface Refusal {
  readonly positions: readonly BlockPos[];
  readonly blocks: readonly string[];
  readonly zone: ZoneKind | null;
}

function short(id: string): string {
  return id.replace(/^minecraft:/, '');
}

/** Reads `result.protected` / `result.zone` of a `PROTECTED` failure (tolerant of a mod that sends less). */
export function refusalOf(result: Record<string, unknown> | undefined): Refusal {
  const positions: BlockPos[] = [];
  const blocks: string[] = [];
  const list = Array.isArray(result?.protected) ? (result?.protected as unknown[]) : [];
  for (const raw of list.slice(0, 512)) {
    const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const pos = asPos(item.pos) ?? asPos(raw);
    if (!pos) continue;
    positions.push(pos);
    if (typeof item.block === 'string') blocks.push(short(singleLine(item.block, 48)));
  }
  const z = result?.zone;
  const zoneKind = z && typeof z === 'object' ? (z as Record<string, unknown>).kind : z;
  const zone: ZoneKind | null = zoneKind === 'base' || zoneKind === 'built' ? zoneKind : null;
  return { positions, blocks, zone };
}

/** "4 blocks (e.g. stripped_spruce_log at 12 64 -30)". */
function refusalSummary(r: Refusal): string {
  const n = r.positions.length;
  if (n === 0) return 'those blocks';
  const first = r.positions[0];
  const what = r.blocks[0] ?? 'block';
  return `${n} block${n === 1 ? '' : 's'} (e.g. ${what} at ${first ? posText(first) : '?'})`;
}

export interface FailureInput {
  /** The job label ("mine #minecraft:logs ×10"). */
  readonly label: string;
  readonly skill: string;
  readonly code: string;
  readonly msg: string;
  readonly result?: Record<string, unknown> | undefined;
  readonly playerName: string;
}

/** The thing that was asked for, from the label ("collect oak_log ×10" → "oak_log"). */
function wanted(label: string): string {
  const m = /^\S+\s+(\S+)/.exec(label);
  return m?.[1] ? short(m[1]) : 'it';
}

/**
 * The failure text a job's result (tool result or `[JOB FAILED]` wake) carries: the code and message, plus the
 * teaching line for the world guard's codes and for gathering that came up empty.
 */
export function failureText(input: FailureInput): string {
  const p = input.playerName;
  const msg = singleLine(input.msg, 200);
  const head = `${input.code}: ${msg}`;
  if (input.code === PROTECTED) {
    const r = refusalOf(input.result);
    const one = r.positions.length === 1;
    const what =
      r.zone === 'built'
        ? `${one ? 'was' : 'were'} built by ${p}`
        : `${one ? 'is' : 'are'} part of the Base, ${p}'s home`;
    const them = one ? 'it' : 'them';
    return `${head}. ${refusalSummary(r)} ${what}. A hard stop: never break or take ${them}, don't retry or work around it, and never offer ${them} as a substitute. Gather from nature outside the Base (look_around, find) or ask ${p} what to use instead. Only if ${p} asked for exactly ${one ? 'this block' : 'these blocks'}: ask with AskUserQuestion, an option "Allow: <what it unlocks>" (e.g. "Allow: take ${one ? 'that' : 'those'} ${r.blocks[0] ?? 'Base blocks'}"); only ${p} picking it unlocks ${them}.`;
  }
  if (input.code === NO_NATURAL_SOURCE) {
    const what = wanted(input.label);
    const natural = Array.isArray(input.result?.natural) ? (input.result?.natural as unknown[]) : [];
    const first =
      natural[0] && typeof natural[0] === 'object' ? (natural[0] as Record<string, unknown>) : null;
    const pos = asPos(first?.pos);
    const seen = pos ? ` The nearest natural one, at ${posText(pos)}, has no path.` : '';
    const skipped =
      typeof input.result?.protectedCount === 'number' && input.result.protectedCount > 0
        ? ` ${input.result.protectedCount} protected ones were left alone.`
        : '';
    return `${head}.${seen}${skipped} A hard stop: don't substitute another block or a #tag, and never take protected ones. Tell ${p} and ask with AskUserQuestion, e.g. options "Go further for ${what}", "Use something else instead", "Skip".`;
  }
  if ((input.code === 'NOT_FOUND' || input.code === 'UNREACHABLE') && GATHERING.has(input.skill)) {
    return `${head}. If ${p} asked for this, don't switch to another block or a #tag on your own: say what you found and ask ${p} (AskUserQuestion: go further, use something else, or skip).`;
  }
  return head;
}

/** A job Node refuses itself, before the mod sees it: its arguments name the Base outright. */
export interface BaseConflict {
  readonly msg: string;
  readonly refusal: Refusal;
  /**
   * The teaching text after `PROTECTED: msg.`, when the generic one ({@link failureText}) would mislead: a search
   * Node refused because it could reach the Base is fine elsewhere or for the exact natural block.
   */
  readonly advice?: string;
}

/** What Node knows besides the job's arguments. */
export interface GuardContext {
  /** Where the agent stands: the centre of a `mine` / `collect` search without `near`. Null when unknown. */
  readonly here?: Vec3Like | null | undefined;
  /**
   * The mod guards provenance itself (protocol §7.4.3: its bodies carry `zone`), so a search never takes protected
   * blocks and Node leaves searches to it. False for today's mod, which takes the nearest match, Base or not.
   */
  readonly modGuards?: boolean | undefined;
  readonly playerName?: string | undefined;
}

/** How far each built-in blueprint reaches from its origin (BuildJob), horizontally; others get the most. */
const BLUEPRINT_REACH: Readonly<Record<string, number>> = {
  shelter: 2,
  wall_ring: 4,
  farm_plot: 4,
  torch_ring: 5,
  bridge: 8,
  stairs_down: 8,
};
const MAX_BLUEPRINT_REACH = 8;
/** Blueprints build up to 3 above their origin and dig (stairs_down) up to 9 below it. */
const BLUEPRINT_UP = 3;
const BLUEPRINT_DOWN = 9;
/** The mod's search radius of `mine` / `collect` without `radius` (SkillFactory). */
const DEFAULT_SEARCH_RADIUS = 24;
/** Wall torches and lanterns hang one block outside the walls. */
const WALL_FIXTURES = 1;

function boxesOverlap(a: { min: BlockPos; max: BlockPos }, b: { min: BlockPos; max: BlockPos }): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

function boxOf(from: BlockPos, to: BlockPos): { min: BlockPos; max: BlockPos } {
  return {
    min: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) },
    max: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) },
  };
}

function grow(
  box: { min: BlockPos; max: BlockPos },
  by: number,
  down = by,
): { min: BlockPos; max: BlockPos } {
  return {
    min: { x: box.min.x - by, y: box.min.y - down, z: box.min.z - by },
    max: { x: box.max.x + by, y: box.max.y + by, z: box.max.z + by },
  };
}

/** What to do instead of searching near the Base for a tag or something the Base is built of. */
function insteadOf(target: string): string {
  const t = short(target.trim().toLowerCase());
  if (t.startsWith('#'))
    return 'name the exact natural block you need (oak_log, spruce_log, stone), with near:{x,y,z} at one find showed';
  if (t.endsWith('_planks')) return 'get logs (e.g. oak_log) and craft planks from them';
  if (t === 'cobblestone') return 'mine natural stone ({block:"stone"}), which drops cobblestone';
  if (/crafting_table|furnace|chest|torch|lantern|_bed$|_door$|^minevibe:/.test(t))
    return `use the Base's ${t} where it stands, or craft your own`;
  return 'gather from nature away from the Base, or craft it';
}

/**
 * Defence in depth on Node's side (protocol §7.4.3), whatever the mod knows about provenance: a `dig` or `farm` box
 * that overlaps the Base building, a `mine` / `collect` aimed `near` a spot inside it, or a `build` whose blueprint
 * reaches into it, is refused as `PROTECTED` before it reaches the mod.
 *
 * Until the mod guards provenance itself ({@link GuardContext.modGuards}), Node also refuses a `mine` / `collect` for a
 * `#tag` or for something the Base is built of (planks, stripped logs, cobblestone, glass, its furniture) whose search
 * reaches the Base: today's mod takes the nearest match, and that is the Base (the live incident: `#minecraft:logs`
 * took the office's stripped spruce log pillars). The exact natural block (`oak_log`) is never refused.
 */
export function baseConflict(
  skill: string,
  args: Record<string, unknown>,
  base: BaseArea | null,
  ctx: GuardContext = {},
): BaseConflict | null {
  if (!base) return null;
  const building = { min: base.min, max: base.max };
  const refusal: Refusal = { positions: [], blocks: [], zone: 'base' };
  const extent = `the Base (x ${base.min.x} to ${base.max.x}, z ${base.min.z} to ${base.max.z})`;
  if (skill === 'dig' || skill === 'farm') {
    const from = asPos(args.from);
    const to = asPos(args.to);
    if (from && to && boxesOverlap(boxOf(from, to), grow(building, WALL_FIXTURES))) {
      return { msg: `the box overlaps ${extent}`, refusal };
    }
    return null;
  }
  if (skill === 'mine' || skill === 'collect') {
    const near = asPos(args.near);
    if (near && inBase(near, base, 1)) return { msg: `near ${posText(near)} is inside ${extent}`, refusal };
    if (ctx.modGuards) return null;
    const raw = skill === 'mine' ? args.block : args.item;
    const target = typeof raw === 'string' ? raw.trim() : '';
    const isTag = target.startsWith('#');
    if (!isTag && !isBaseMaterial(target)) return null;
    const radius = typeof args.radius === 'number' ? args.radius : DEFAULT_SEARCH_RADIUS;
    const center = near ?? ctx.here ?? null;
    const reach = grow(building, WALL_FIXTURES, FOUNDATION_DEPTH);
    if (center && distanceToBox(center, reach.min, reach.max) > radius) return null;
    const p = ctx.playerName ?? 'the player';
    const what = isTag
      ? `${target} means any of its kinds, and`
      : `${short(target)} is what the Base is built of, and`;
    return {
      msg: `${what} this search (${radius} blocks around ${center ? posText(center) : 'you'}) reaches the Base, so it could take the Base's own blocks`,
      refusal,
      advice: `Never take blocks of the Base, ${p}'s home. Instead ${insteadOf(target)}. If that is not possible, ask ${p} (AskUserQuestion: go further, use something else, or skip).`,
    };
  }
  if (skill === 'build') {
    const origin = asPos(args.origin);
    if (!origin) return null;
    const blueprint = typeof args.blueprint === 'string' ? args.blueprint : '';
    const r = BLUEPRINT_REACH[blueprint] ?? MAX_BLUEPRINT_REACH;
    const footprint = {
      min: { x: origin.x - r, y: origin.y - BLUEPRINT_DOWN, z: origin.z - r },
      max: { x: origin.x + r, y: origin.y + BLUEPRINT_UP, z: origin.z + r },
    };
    if (inBase(origin, base, 2) || boxesOverlap(footprint, grow(building, WALL_FIXTURES))) {
      return {
        msg: `the ${blueprint || 'blueprint'} at ${posText(origin)} reaches into ${extent}; build on open ground outside it, at least ${r + 2} blocks from its walls`,
        refusal,
      };
    }
  }
  return null;
}
