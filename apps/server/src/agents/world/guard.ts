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
import { asPos, type BaseArea, inBase, posText } from '../../world/baseArea.js';
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
    return `${head}. ${refusalSummary(r)} ${what}. A hard stop: never break or take ${them}, don't retry or work around it. Gather from nature outside the Base (look_around, find). If only ${one ? 'this one' : 'these'} will do, ask ${p} with AskUserQuestion; only an answered option starting "Allow" (e.g. "Allow: take ${one ? 'that' : 'those'} ${r.blocks[0] ?? 'blocks'}") unlocks ${them}.`;
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
}

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

/**
 * Defence in depth on Node's side (protocol §7.4.3), whatever the mod knows about provenance: a `dig` or `farm` box
 * that overlaps the Base building, a `mine` / `collect` aimed `near` a spot inside it, or a `build` whose origin is in
 * it, is refused as `PROTECTED` before it reaches the mod. Only explicit coordinates are judged here; the mod guards
 * everything else (which blocks a search picks).
 */
export function baseConflict(
  skill: string,
  args: Record<string, unknown>,
  base: BaseArea | null,
): BaseConflict | null {
  if (!base) return null;
  const building = { min: base.min, max: base.max };
  const refusal: Refusal = { positions: [], blocks: [], zone: 'base' };
  const extent = `the Base (x ${base.min.x} to ${base.max.x}, z ${base.min.z} to ${base.max.z})`;
  if (skill === 'dig' || skill === 'farm') {
    const from = asPos(args.from);
    const to = asPos(args.to);
    if (from && to && boxesOverlap(boxOf(from, to), building)) {
      return { msg: `the box overlaps ${extent}`, refusal };
    }
    return null;
  }
  if (skill === 'mine' || skill === 'collect') {
    const near = asPos(args.near);
    if (near && inBase(near, base, 1)) return { msg: `near ${posText(near)} is inside ${extent}`, refusal };
    return null;
  }
  if (skill === 'build') {
    const origin = asPos(args.origin);
    if (origin && inBase(origin, base, 2)) {
      return {
        msg: `origin ${posText(origin)} is inside ${extent}; build on open ground outside it`,
        refusal,
      };
    }
  }
  return null;
}
