/**
 * The agent's one-line scene (PLAN §6.5 "Layer 2: Digest"), prepended to every turn with the Digest:
 *
 *   `D2 07:40 · in Base (office) · trees 20m NE · Jasper 4m · no threats`
 *
 * Built at zero tokens from what Node already has: the overworld clock (`world.state`), the agent's body
 * (`agent.state`, its `zone` included), the Base (`world.state.office`) and the nearest natural trees the agent saw in
 * its own look_around / find results ({@link PerceptionMemory}). It stays under {@link SCENE_MAX_CHARS} (about 50
 * tokens): enough for the model to know where it is before it acts, never a second status footer.
 */

import type { AgentBody, AgentZone, BlockPos } from '@minevibe/protocol';
import { ticksToGameTime } from '../../contracts/orgTools.js';
import { type BaseArea, baseCenter, distanceAndDir, inBase, type Vec3Like } from '../../world/baseArea.js';
import { escapeShared } from '../envelope.js';

/** About 50 tokens. */
export const SCENE_MAX_CHARS = 200;
/** A tree sighting older than this, or seen from further than {@link SIGHTING_MAX_MOVE} away, is dropped. */
export const SIGHTING_TTL_MS = 10 * 60_000;
export const SIGHTING_MAX_MOVE = 32;

const OVERWORLD = 'minecraft:overworld';

/** The nearest natural trees an agent saw. */
export interface TreeSighting {
  readonly pos: BlockPos;
  /** False when the mod said no path reaches it; null when unknown. */
  readonly reachable: boolean | null;
}

/** Per-agent memory of what its observations showed (feeds the scene line). */
export class PerceptionMemory {
  #trees: (TreeSighting & { at: number; from: Vec3Like }) | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Records the nearest natural trees of an observation made at `from`. */
  noteTrees(sighting: TreeSighting, from: Vec3Like | null): void {
    this.#trees = { ...sighting, at: this.#now(), from: from ?? sighting.pos };
  }

  /** The last sighting, unless it is stale or the agent has walked far from where it looked. */
  trees(here: Vec3Like | null): TreeSighting | null {
    const t = this.#trees;
    if (!t) return null;
    if (this.#now() - t.at > SIGHTING_TTL_MS) return null;
    if (here && Math.hypot(here.x - t.from.x, here.z - t.from.z) > SIGHTING_MAX_MOVE) return null;
    return { pos: t.pos, reachable: t.reachable };
  }

  clear(): void {
    this.#trees = null;
  }
}

export interface SceneInput {
  readonly clockTime: number | null;
  readonly body: AgentBody | null;
  readonly base: BaseArea | null;
  readonly trees: TreeSighting | null;
  readonly playerName: string;
}

/** 13000-23000 ticks into the day (06:00 = 0): mobs spawn. */
function isNight(clockTime: number): boolean {
  const t = ((clockTime % 24_000) + 24_000) % 24_000;
  return t >= 13_000 && t < 23_000;
}

/** "D2 07:40" (plus " night"). */
export function clockText(clockTime: number): string {
  const text = ticksToGameTime(clockTime).replace(/^Day /, 'D');
  return isNight(clockTime) ? `${text} night` : text;
}

/**
 * The body's zone from `agent.state` (protocol §7.4.3: the footer's words, `in Base` or `12m from Base`) as a kind:
 * `in <zone>` is inside a protected zone (the Base kind; the Base itself goes unnamed so Node's own name is used), any
 * other text is outside, in the wild. Null without a zone (a mod that does not guard provenance).
 */
export function zoneOfBody(zone: string | undefined | null): AgentZone | null {
  if (!zone) return null;
  const m = /^in (.+)$/.exec(zone.trim());
  if (!m?.[1]) return { kind: 'wild' };
  return m[1] === 'Base' ? { kind: 'base' } : { kind: 'base', name: m[1] };
}

/** A mod-supplied zone name, made safe for a control line. */
function zoneName(name: string | undefined): string | null {
  if (!name) return null;
  const flat = escapeShared(name).replace(/\s+/g, ' ').trim().slice(0, 48);
  return flat.length > 0 ? flat : null;
}

/** Where the body is: "in Base (office)", "outside, Base 34m SW", "by Jasper's builds", "in the_nether". */
export function whereText(body: AgentBody, base: BaseArea | null, playerName: string): string | null {
  if (body.dim !== OVERWORLD) {
    const dim = body.dim.includes(':') ? body.dim.slice(body.dim.indexOf(':') + 1) : body.dim;
    return `in ${dim}`;
  }
  const zone = zoneOfBody(body.zone);
  const insideBox = base ? inBase(body.pos, base) : false;
  if (zone?.kind === 'base' || (!zone && insideBox)) {
    return `in ${zoneName(zone?.name) ?? base?.name ?? 'the Base'}`;
  }
  const toBase = base ? `Base ${distanceAndDir(body.pos, baseCenter(base))}` : null;
  if (zone?.kind === 'built')
    return toBase ? `by ${playerName}'s builds, ${toBase}` : `by ${playerName}'s builds`;
  if (toBase) return `outside, ${toBase}`;
  return zone?.kind === 'wild' ? 'in the wild' : null;
}

/** The scene line, or null when nothing is known yet (no body and no clock). */
export function sceneLine(input: SceneInput): string | null {
  const { body, base, playerName } = input;
  const parts: string[] = [];
  if (input.clockTime !== null) parts.push(clockText(input.clockTime));
  if (body) {
    const where = whereText(body, base, playerName);
    if (where) parts.push(where);
    if (body.seat?.kind === 'pc') parts.push(`seated at ${body.seat.pcId}`);
    if (input.trees && body.dim === OVERWORLD) {
      const trees = `trees ${distanceAndDir(body.pos, input.trees.pos)}`;
      parts.push(input.trees.reachable === false ? `${trees} (unreachable)` : trees);
    }
    parts.push(
      body.playerDistance !== undefined
        ? `${playerName} ${Math.round(body.playerDistance)}m`
        : `${playerName} elsewhere`,
    );
    parts.push(body.inCombat ? 'THREAT nearby' : 'no threats');
  }
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.length > SCENE_MAX_CHARS ? `${line.slice(0, SCENE_MAX_CHARS - 1)}…` : line;
}
