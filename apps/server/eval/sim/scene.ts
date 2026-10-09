/**
 * `look_around` of the simulated W1 mod: a port of the mod's `dev.minevibe.agent.perception.Scene` over the
 * simulated world, so the v2 eval measures the scene the agents really read. The lines, most important first: where
 * the agent is (`Here:`), the zone (`Inside Base (...)` or `Base (Jordan's base) 7m SE`), hazards, natural trees with
 * reachability, what players and agents built (`Built: Base 3m SE; Jordan's build (152 blocks) 4m SE.`), the people
 * (the player with whether they stand in a zone and under cover), water and ores, the ground; `full` adds workstations.
 * `brief` stays within 900 characters, `full` within 2500. The result carries `zone` and `trees` as data, like the mod.
 *
 * Simplifications: one biome (plains), no drops or lava, no animals or crops, and reachability is the world's
 * unreachable boxes (the mod runs one A* search per tree).
 */

import { matches, NS, shortId, TAGS } from './items.js';
import {
  AIR,
  dayAndTime,
  GROUND_Y,
  type Pos,
  type SimWorld,
  WORLD_RADIUS,
  type Zone,
  zoneCenter,
  zoneDistance,
  zoneHorizontalDistance,
} from './world.js';

export const BRIEF_CHARS = 900;
export const FULL_CHARS = 2500;
/** The mod's `Reach.MAX_CHECK`: trees farther than this (horizontally) are `far`. */
const MAX_CHECK = 56;

const POINTS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;

/** The mod's `Compass.dir`: eight points (north is -z), or here / above / below within 1.5 blocks. */
export function compassDir(from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  if (dx * dx + dz * dz < 1.5 * 1.5) return dy > 1.5 ? 'above' : dy < -1.5 ? 'below' : 'here';
  const yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
  const index = Math.floor(((((yaw % 360) + 360) % 360) + 22.5) / 45) % 8;
  return POINTS[index] ?? 'here';
}

/** `Compass.distance`: whole blocks, rounded. */
export function blocksApart(a: Pos, b: Pos): number {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
}

/** `Compass.where`: `14m NE`, or `here`. */
export function where(from: Pos, to: Pos): string {
  const d = compassDir(from, to);
  return d === 'here' ? 'here' : `${blocksApart(from, to)}m ${d}`;
}

function xyz(p: Pos): string {
  return `${p.x} ${p.y} ${p.z}`;
}

function boxText(z: Zone): string {
  const { min, max } = z.box;
  return `${min.x} ${min.y} ${min.z}..${max.x} ${max.y} ${max.z}`;
}

/** The mod's `Scene.shelterWords`: whether someone at `feet` is in a protected zone and under a roof (not leaves). */
export function shelterWords(world: SimWorld, feet: Pos): string {
  const zone = world.zoneAt(feet);
  const roofed = world.covered(feet, { noLeaves: true });
  return `${zone ? `in ${zone.name}, ` : ''}${roofed ? 'under cover' : 'in the open'}`;
}

interface Tree {
  readonly species: string;
  readonly base: Pos;
  readonly logs: number;
  readonly nearest: number;
}

/** Natural trees with a log within `radius` of `here`, nearest first (the mod's `Scene.nearbyTrees`). */
export function nearbyTrees(world: SimWorld, here: Pos, radius: number, limit: number): Tree[] {
  const byTree = new Map<string, { id: string; logs: Pos[] }>();
  for (const { pos, block } of world.scan(here, radius * 1.8, (id) => id.endsWith('_log'))) {
    if (block.placedBy !== 'natural' || !block.structure?.startsWith('tree:')) continue;
    const t = byTree.get(block.structure) ?? { id: block.id, logs: [] };
    t.logs.push(pos);
    byTree.set(block.structure, t);
  }
  const trees: Tree[] = [];
  for (const t of byTree.values()) {
    const nearest = Math.min(...t.logs.map((p) => Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z)));
    if (nearest > radius) continue;
    const base = t.logs.reduce((lo, p) => (p.y < lo.y ? p : lo));
    trees.push({ species: shortId(t.id).replace(/_log$/, ''), base, logs: t.logs.length, nearest });
  }
  return trees.sort((a, b) => a.nearest - b.nearest).slice(0, limit);
}

/** `Reach.walkTo` in the simulated world: the unreachable boxes, and `far` beyond one search. */
function reach(world: SimWorld, here: Pos, target: Pos): 'reachable' | 'unreachable' | 'far' {
  if (Math.hypot(target.x - here.x, target.z - here.z) > MAX_CHECK) return 'far';
  return world.isUnreachable(target) ? 'unreachable' : 'reachable';
}

function hereLine(world: SimWorld, full: boolean): string {
  const feet = world.agent.pos;
  const night = world.isNight();
  const covered = world.covered(feet);
  const light = covered ? (night ? 4 : 12) : night ? 4 : 15;
  const text = `Here: ${xyz(feet)} overworld, plains, ${dayAndTime(world.clock)} (${night ? 'night' : 'day'}, light ${light}, ${covered ? 'under cover' : 'open sky'})`;
  return `${text}${full ? `. ${world.activity()}` : ''}.`;
}

function hazards(world: SimWorld, radius: number, full: boolean): string {
  const here = world.agent.pos;
  const r = Math.max(radius, 24);
  const hostiles = world.mobs
    .filter((m) => m.alive && m.hostile && Math.abs(m.pos.x - here.x) <= r && Math.abs(m.pos.z - here.z) <= r)
    .sort(
      (a, b) =>
        Math.hypot(a.pos.x - here.x, a.pos.y - here.y, a.pos.z - here.z) -
        Math.hypot(b.pos.x - here.x, b.pos.y - here.y, b.pos.z - here.z),
    );
  const shown = full ? 5 : 3;
  const out = hostiles.slice(0, shown).map((m) => `${shortId(m.type)} ${where(here, m.pos)}`);
  if (hostiles.length > shown) out.push(`+${hostiles.length - shown} more hostiles`);
  return out.length === 0 ? 'Hazards: none seen.' : `Hazards: ${out.join(', ')}.`;
}

/** The mod's `Scene.cluster`: positions whose 4x4x4 cells touch (26 neighbours) form one group. */
export function cluster(positions: readonly Pos[]): Pos[][] {
  const cells = new Map<string, Pos[]>();
  const cellOf = (p: Pos) => [p.x >> 2, p.y >> 2, p.z >> 2] as const;
  for (const p of positions) {
    const key = cellOf(p).join(',');
    const list = cells.get(key) ?? [];
    list.push(p);
    cells.set(key, list);
  }
  const parent = new Map<string, string>([...cells.keys()].map((k) => [k, k]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const key of cells.keys()) {
    const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const n = `${cx + dx},${cy + dy},${cz + dz}`;
          if (!parent.has(n)) continue;
          const ra = find(key);
          const rb = find(n);
          if (ra !== rb) parent.set(ra, rb);
        }
  }
  const groups = new Map<string, Pos[]>();
  for (const [key, list] of cells) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), ...list]);
  }
  return [...groups.values()];
}

function built(world: SimWorld, radius: number, zone: Zone | null, full: boolean): string {
  const here = world.agent.pos;
  const byOwner = new Map<string, Pos[]>();
  let total = 0;
  for (const { pos, block } of world.scan(here, radius * 1.8, () => true)) {
    if (block.placedBy === 'natural') continue;
    if (
      total >= 4096 ||
      Math.abs(pos.x - here.x) > radius ||
      Math.abs(pos.z - here.z) > radius ||
      Math.abs(pos.y - here.y) > radius
    )
      continue;
    total++;
    const label =
      block.placedBy === 'player' ? `${world.player.name}'s build` : `${world.agent.name} (crew) build`;
    byOwner.set(label, [...(byOwner.get(label) ?? []), pos]);
  }
  const parts: string[] = [];
  if (zone && zoneDistance(zone, here) <= radius) {
    parts.push(
      `${zone.name} ${world.zoneAt(here) === zone ? '(you are in it)' : where(here, zoneCenter(zone))}`,
    );
  }
  const clusters: { owner: string; count: number; min: Pos; max: Pos; nearest: Pos; d: number }[] = [];
  for (const [owner, list] of byOwner) {
    for (const group of cluster(list)) {
      const d2 = (p: Pos) => (p.x - here.x) ** 2 + (p.y - here.y) ** 2 + (p.z - here.z) ** 2;
      const nearest = group.reduce((a, b) => (d2(b) < d2(a) ? b : a));
      clusters.push({
        owner,
        count: group.length,
        min: {
          x: Math.min(...group.map((p) => p.x)),
          y: Math.min(...group.map((p) => p.y)),
          z: Math.min(...group.map((p) => p.z)),
        },
        max: {
          x: Math.max(...group.map((p) => p.x)),
          y: Math.max(...group.map((p) => p.y)),
          z: Math.max(...group.map((p) => p.z)),
        },
        nearest,
        d: d2(nearest),
      });
    }
  }
  clusters.sort((a, b) => a.d - b.d);
  const max = full ? 6 : 3;
  let shown = 0;
  for (const c of clusters) {
    if (shown++ >= max) {
      parts.push(`+${clusters.length - max} more`);
      break;
    }
    const size = c.count === 1 ? '1 block' : `${c.count} blocks`;
    const box = c.count > 1 ? ` ${xyz(c.min)}..${xyz(c.max)}` : ` at ${xyz(c.nearest)}`;
    parts.push(`${c.owner} (${size}) ${where(here, c.nearest)}${full ? box : ''}`);
  }
  return parts.length === 0
    ? ''
    : `Built: ${parts.join('; ')}. Player-built blocks are protected; crew-built ones are yours to change.`;
}

function people(world: SimWorld, full: boolean): string {
  const here = world.agent.pos;
  const p = world.player.pos;
  return `People: ${world.player.name} (player) ${where(here, p)}${full ? ` at ${xyz(p)}` : ''}, ${shelterWords(world, p)}.`;
}

const ORES: readonly (readonly [string, string])[] = [
  ['coal', `${NS}coal_ores`],
  ['iron', `${NS}iron_ores`],
];

function resources(world: SimWorld, radius: number, full: boolean): string {
  const here = world.agent.pos;
  const parts: string[] = [];
  const d = (q: Pos) => Math.hypot(q.x - here.x, q.y - here.y, q.z - here.z);
  const water = world
    .scan(here, Math.max(radius, 24), (id) => id === `${NS}water`)
    .sort((a, b) => d(a.pos) - d(b.pos))[0];
  if (water) parts.push(`water ${where(here, water.pos)}`);
  const ores: string[] = [];
  for (const [name, tag] of ORES) {
    const kinds = TAGS[tag] ?? [];
    const found = world
      .scan(here, Math.min(radius, 16), (id) => kinds.includes(id))
      .filter((m) => world.exposed(m.pos) && world.protectedAt(m.pos, { ignoreGrant: true }) === null)
      .sort((a, b) => d(a.pos) - d(b.pos))
      .slice(0, 8);
    const first = found[0];
    if (first) {
      const n = found.length > 1 ? ` x${found.length}${found.length >= 8 ? '+' : ''}` : '';
      ores.push(`${name}${n} ${where(here, first.pos)}`);
    }
  }
  if (ores.length > 0) parts.push(`ores in sight: ${ores.slice(0, full ? 8 : 3).join(', ')}`);
  return parts.length === 0 ? '' : `Resources: ${parts.join('; ')}.`;
}

/** The highest block of a column (leaves left out), or null beyond the generated plain (unloaded). */
function topOf(world: SimWorld, x: number, z: number): { y: number; id: string } | null {
  if (Math.abs(x) > WORLD_RADIUS || Math.abs(z) > WORLD_RADIUS) return null;
  for (let y = GROUND_Y + 40; y >= GROUND_Y; y--) {
    const b = world.block({ x, y, z });
    if (b.id === AIR || b.id.endsWith('_leaves')) continue;
    return { y, id: b.id };
  }
  return { y: GROUND_Y, id: world.block({ x, y: GROUND_Y, z }).id };
}

function ground(world: SimWorld, radius: number, full: boolean): string {
  const feet = world.agent.pos;
  const step = Math.max(2, Math.floor(radius / 4));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const surface = new Map<string, number>();
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const top = topOf(world, feet.x + dx * step, feet.z + dz * step);
      if (!top) continue;
      const h = top.y + 1 - feet.y;
      min = Math.min(min, h);
      max = Math.max(max, h);
      const name = top.id === `${NS}water` ? 'water' : shortId(top.id);
      surface.set(name, (surface.get(name) ?? 0) + 1);
    }
  }
  const main = [...surface].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';
  let text = `Ground: ${main}`;
  if (Number.isFinite(min)) {
    const range = max - min;
    const shape = range <= 2 ? 'flat' : range <= 6 ? 'gentle slopes' : range <= 15 ? 'hilly' : 'steep';
    const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    text += `, ${shape} (${sign(min)}..${sign(max)} within ${step * 4}m)`;
  }
  text += `, standing on ${shortId(world.block({ ...feet, y: feet.y - 1 }).id)}`;
  // Nothing in this world gives off light (no torches are simulated).
  if (full) text += ', block light 0';
  return `${text}.`;
}

function extras(world: SimWorld, radius: number): string {
  const here = world.agent.pos;
  const parts: string[] = [];
  const spots: readonly (readonly [string, (id: string) => boolean])[] = [
    ['crafting table', (id) => id === `${NS}crafting_table`],
    ['furnace', (id) => id === `${NS}furnace`],
    ['chest', (id) => id === `${NS}chest` || id === `${NS}barrel`],
    ['bed', (id) => matches('#minecraft:beds', id)],
  ];
  const d = (q: Pos) => Math.hypot(q.x - here.x, q.y - here.y, q.z - here.z);
  for (const [name, test] of spots) {
    const found = world.scan(here, Math.min(radius, 24), test).sort((a, b) => d(a.pos) - d(b.pos))[0];
    if (found) parts.push(`${name} ${where(here, found.pos)} at ${xyz(found.pos)}`);
  }
  return parts.length === 0 ? '' : `Also: ${parts.join('; ')}.`;
}

/**
 * `obs.query look_around` of the v2 mod (`Scene.lookAround`): `{scene, detail, zone?, trees}`. `radius` 1-48 (entities
 * and blocks); trees and buildings are looked for a bit farther (32, or 40 in full).
 */
export function lookAroundV2(world: SimWorld, radius: number, full: boolean): Record<string, unknown> {
  const here = world.agent.pos;
  const far = Math.max(radius, full ? 40 : 32);
  const lines: string[] = [hereLine(world, full)];
  const out: Record<string, unknown> = {};
  const zone = world.nearestZone(here);
  if (zone) {
    const owner = zone.owner ?? world.player.name;
    const inside = world.zoneAt(here) === zone;
    const dist = Math.round(zoneHorizontalDistance(zone, here));
    out.zone = { name: zone.name, inside, distance: inside ? 0 : dist, owner };
    const label = zone.name === 'Base' ? `${owner}'s base` : `${zone.name}, ${owner}'s`;
    if (inside) {
      lines.push(`Inside ${zone.name} (${label}, ${boxText(zone)}): never break or change its blocks.`);
    } else if (dist <= 96 || full) {
      lines.push(
        `${zone.name} (${label}) ${dist}m ${compassDir(here, zoneCenter(zone))}: its blocks are protected.`,
      );
    }
  }
  lines.push(hazards(world, radius, full));
  const trees = nearbyTrees(world, here, far, full ? 6 : 4);
  const facts: Record<string, unknown>[] = [];
  const said: string[] = [];
  trees.forEach((t, i) => {
    const r = i < (full ? 5 : 3) ? reach(world, here, t.base) : 'far';
    facts.push({
      species: t.species,
      trunk: { ...t.base },
      distance: blocksApart(here, t.base),
      dir: compassDir(here, t.base),
      reachable: r,
      logs: t.logs,
    });
    said.push(`${t.species} ${where(here, t.base)} at ${xyz(t.base)}, ${r}${full ? `, ${t.logs} logs` : ''}`);
  });
  out.trees = facts;
  lines.push(
    trees.length === 0
      ? `Trees: no natural tree within ${far}m (logs in buildings are not trees).`
      : `Trees (natural): ${said.join('; ')}.`,
  );
  const b = built(world, far, zone, full);
  if (b) lines.push(b);
  lines.push(people(world, full));
  const r = resources(world, radius, full);
  if (r) lines.push(r);
  lines.push(ground(world, radius, full));
  if (full) {
    const e = extras(world, radius);
    if (e) lines.push(e);
  }
  const budget = full ? FULL_CHARS : BRIEF_CHARS;
  let scene = '';
  for (const text of lines) {
    const need = (scene.length === 0 ? 0 : 1) + text.length;
    if (scene.length + need > budget) {
      const room = budget - scene.length - (scene.length === 0 ? 0 : 1);
      if (room > 40) scene += `${scene.length === 0 ? '' : '\n'}${text.slice(0, room - 1)}…`;
      break;
    }
    scene += `${scene.length === 0 ? '' : '\n'}${text}`;
  }
  return { scene, detail: full ? 'full' : 'brief', ...out };
}
