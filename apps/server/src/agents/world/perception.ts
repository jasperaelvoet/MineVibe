/**
 * Perception as a scene (protocol §7.4.3): the mod's raw `look_around` and `find` results become short text that says
 * what the model needs before it acts. Where it stands (the Base is the player's home), what is natural and fine to
 * gather (by distance, direction and reachability), and what is protected (part of the Base or built by the player:
 * never break). Nothing in the raw result is dropped: positions stay in the lines, and keys this formatter does not
 * know go out as compact JSON under "More".
 *
 * The mod's provenance flags (`natural`, `protected`, `reachable`, `zone`, per-category `natural` / `built`) are used
 * when present. Without them, Node still knows the Base box (`world.state.office`) and marks blocks inside it as
 * protected, so even an older mod never gets its office pillars offered as "logs".
 *
 * Names in results (custom mob names, items) are game text: they are flattened and escaped like shared text.
 */

import type { AgentZone, BlockPos } from '@minevibe/protocol';
import {
  asPos,
  type BaseArea,
  baseCenter,
  distanceAndDir,
  inBase,
  posText,
  type Vec3Like,
} from '../../world/baseArea.js';
import { singleLine } from '../envelope.js';
import { compactJson } from '../tools/results.js';
import { type TreeSighting, zoneOfBody } from './scene.js';

export interface PerceptionContext {
  /** The agent's position (for distance and direction), or null when unknown. */
  readonly here: Vec3Like | null;
  readonly base: BaseArea | null;
  /** The body's zone from `agent.state`, when the observation itself carries none. */
  readonly zone?: AgentZone | null | undefined;
  readonly playerName: string;
}

export interface Perceived {
  readonly text: string;
  /** The nearest natural trees the observation showed (for the scene line), if any. */
  readonly trees: TreeSighting | null;
}

/** How many block matches the mod's `find` lists by default (Observations.find `limit`). */
const FIND_LIST_LIMIT = 5;
/** Blocks within this many blocks of the Base building count as part of it when the mod gives no provenance. */
const BUILDING_MARGIN = 1;

/** Categories of `look_around.blocks` that are things to gather. */
const RESOURCE_RE = /^(logs|wood|stone|sand|gravel|clay|[a-z_]*_ore|[a-z_]*_ores)$/;
/** Categories that are furniture to use (never to break). */
const USEFUL = new Set(['crafting_table', 'furnace', 'chest', 'bed', 'office_chair', 'barrel', 'smoker']);
const LOG_RE = /(^|[:#_])(logs?|wood|stems?)$|_log$|_wood$|_stem$/;
/** Blocks one uses where they stand (a table to craft at, a chest): never gathered, never broken. */
const USABLE_RE =
  /crafting_table|furnace|smoker|chest|barrel|bed$|anvil|office_chair|codex|calendar|lectern|door/;

function str(v: unknown, max = 48): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = singleLine(String(v), max);
  return s.length > 0 ? s : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function short(id: string): string {
  return id.replace(/^minecraft:/, '');
}

/** "25m NE at 130 64 -20" (or just the position without a reference point). */
function where(ctx: PerceptionContext, pos: BlockPos): string {
  return ctx.here ? `${distanceAndDir(ctx.here, pos)} at ${posText(pos)}` : `at ${posText(pos)}`;
}

function inBuilding(ctx: PerceptionContext, pos: BlockPos): boolean {
  return ctx.base !== null && inBase(pos, ctx.base, BUILDING_MARGIN);
}

/** The zone line: where the agent stands and what that means. */
function zoneLine(ctx: PerceptionContext, zone: AgentZone | null): string | null {
  const p = ctx.playerName;
  const insideBox = ctx.here && ctx.base ? inBase(ctx.here, ctx.base) : false;
  if (zone?.kind === 'base' || (!zone && insideBox)) {
    const name = str(zone?.name) ?? ctx.base?.name ?? 'the Base';
    return `Where: in ${name}, ${p}'s home. Never break or take its blocks (its chests, tables and beds are there to use).`;
  }
  const toBase = ctx.here && ctx.base ? ` (Base ${distanceAndDir(ctx.here, baseCenter(ctx.base))})` : '';
  if (zone?.kind === 'built') return `Where: among blocks ${p} built${toBase}. Leave them alone.`;
  if (zone?.kind === 'wild' || (ctx.here && ctx.base)) return `Where: outside the Base${toBase}, in nature.`;
  return null;
}

function zoneOf(value: unknown): AgentZone | null {
  const z = obj(value);
  if (z && (z.kind === 'base' || z.kind === 'built' || z.kind === 'wild')) {
    const name = typeof z.name === 'string' ? z.name : undefined;
    return name ? { kind: z.kind, name } : { kind: z.kind };
  }
  // The mod's look_around zone (protocol §7.4.2): `{ name, inside, distance, owner }`.
  if (z && typeof z.inside === 'boolean') {
    if (!z.inside) return { kind: 'wild' };
    return typeof z.name === 'string' && z.name !== 'Base'
      ? { kind: 'base', name: z.name }
      : { kind: 'base' };
  }
  if (value === 'base' || value === 'built' || value === 'wild') return { kind: value };
  if (typeof value === 'string') return zoneOfBody(value);
  return null;
}

interface Bucket {
  readonly count: number;
  readonly nearest: BlockPos | null;
  readonly reachable: boolean | null;
}

function bucket(value: unknown): Bucket | null {
  const b = obj(value);
  if (!b) return null;
  const count = num(b.count) ?? 0;
  if (count <= 0) return null;
  return {
    count,
    nearest: asPos(b.nearest),
    reachable: typeof b.reachable === 'boolean' ? b.reachable : null,
  };
}

function bucketText(ctx: PerceptionContext, name: string, b: Bucket): string {
  const near = b.nearest ? ` nearest ${where(ctx, b.nearest)}` : '';
  const reach = b.reachable === false ? ' (unreachable)' : b.reachable === true ? ' (reachable)' : '';
  return `${name} ×${b.count}${near}${reach}`;
}

/** `look_around` → scene text. */
export function perceiveLookAround(result: Record<string, unknown>, ctx: PerceptionContext): Perceived {
  const known = new Set([
    'zone',
    'entities',
    'itemsOnGround',
    'blocks',
    'time',
    'dark',
    'sky',
    'blockLight',
    'standingOn',
    'biome',
  ]);
  const lines: string[] = [];
  const zone = zoneOf(result.zone) ?? ctx.zone ?? null;
  const zl = zoneLine(ctx, zone);
  if (zl) lines.push(zl);

  const env: string[] = [];
  const biome = str(result.biome);
  if (biome) env.push(`biome ${short(biome)}`);
  const time = str(result.time);
  if (time) env.push(time);
  if (result.dark === true) env.push('dark');
  if (result.sky === false) env.push('no sky (indoors or underground)');
  const on = str(result.standingOn);
  if (on) env.push(`on ${short(on)}`);
  if (env.length > 0) lines.push(`Here: ${env.join(', ')}.`);

  const natural: string[] = [];
  const protectedList: string[] = [];
  const unverified: string[] = [];
  const useful: string[] = [];
  const other: string[] = [];
  let trees: TreeSighting | null = null;
  const blocks = obj(result.blocks) ?? {};
  for (const [rawName, value] of Object.entries(blocks)) {
    const name = str(rawName, 32) ?? 'blocks';
    const all = bucket(value);
    const b = obj(value) ?? {};
    const nat = bucket(b.natural);
    const built = bucket(b.built);
    const isResource = RESOURCE_RE.test(rawName);
    if (!isResource) {
      if (!all) continue;
      if (USEFUL.has(rawName)) useful.push(bucketText(ctx, name, all));
      else other.push(bucketText(ctx, name, all));
      continue;
    }
    if (nat || built || 'natural' in b || 'built' in b) {
      if (nat) {
        natural.push(bucketText(ctx, name, nat));
        if (rawName === 'logs' && nat.nearest) trees = { pos: nat.nearest, reachable: nat.reachable };
      }
      if (built) protectedList.push(bucketText(ctx, name, built));
      continue;
    }
    if (!all) continue;
    // No provenance from the mod: the Base box is all Node knows.
    if (all.nearest && inBuilding(ctx, all.nearest)) {
      unverified.push(
        `${bucketText(ctx, name, all)}: the nearest is part of the Base (protected); find natural ones with find`,
      );
    } else {
      unverified.push(bucketText(ctx, name, all));
      if (rawName === 'logs' && all.nearest) trees = { pos: all.nearest, reachable: all.reachable };
    }
  }
  if (natural.length > 0) lines.push(`Natural, fine to gather: ${natural.join('; ')}.`);
  if (protectedList.length > 0)
    lines.push(`PROTECTED (Base or built by ${ctx.playerName}), never break: ${protectedList.join('; ')}.`);
  if (unverified.length > 0) lines.push(`Blocks: ${unverified.join('; ')}.`);
  if (useful.length > 0) lines.push(`To use: ${useful.join('; ')}.`);
  if (other.length > 0) lines.push(`Also: ${other.join('; ')}.`);

  const beings = Array.isArray(result.entities) ? result.entities : [];
  const people: string[] = [];
  const mobs = new Map<string, { n: number; hostile: boolean; first: string }>();
  for (const raw of beings) {
    const e = obj(raw);
    if (!e) continue;
    const type = str(e.type, 40) ?? 'entity';
    const pos = asPos(e.pos);
    const dist = num(e.distance);
    const at = pos ? where(ctx, pos) : dist !== null ? `${Math.round(dist)}m` : '';
    if (type === 'player' || type === 'agent') {
      const name = str(e.name, 24) ?? type;
      people.push(`${name} ${at}`.trim());
      continue;
    }
    const key = short(type);
    const m = mobs.get(key);
    if (m) m.n++;
    else mobs.set(key, { n: 1, hostile: e.hostile === true, first: at });
  }
  const mobText = [...mobs.entries()].map(([k, m]) =>
    `${k}${m.n > 1 ? ` ×${m.n}` : ''} ${m.first}${m.hostile ? ' HOSTILE' : ''}`.trim(),
  );
  if (people.length > 0) lines.push(`People: ${people.join('; ')}.`);
  if (mobText.length > 0) lines.push(`Mobs: ${mobText.join('; ')}.`);
  const items = obj(result.itemsOnGround);
  if (items) {
    const list = Object.entries(items)
      .map(([k, v]) => `${short(str(k, 40) ?? 'item')} ×${num(v) ?? '?'}`)
      .slice(0, 12);
    if (list.length > 0) lines.push(`On the ground: ${list.join(', ')}.`);
  }
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !known.has(k)));
  if (Object.keys(extra).length > 0) lines.push(`More: ${compactJson(extra, 2_000)}`);
  if (lines.length === 0) lines.push('Nothing notable around.');
  return { text: lines.join('\n'), trees };
}

/** One classified `find` block match. */
interface BlockMatch {
  readonly pos: BlockPos;
  readonly block: string;
  readonly protected: boolean;
  readonly natural: boolean | null;
  readonly reachable: boolean | null;
  readonly exposed: boolean | null;
  readonly inBase: boolean;
  /** Placed by the crew: theirs to take back. */
  readonly crewBuilt: boolean;
  /** The natural tree a log belongs to (the mod's `tree`), e.g. "oak tree, 6 logs". */
  readonly tree: string | null;
}

function classifyBlock(m: Record<string, unknown>, ctx: PerceptionContext): BlockMatch | null {
  const pos = asPos(m.pos);
  if (!pos) return null;
  // The mod's provenance label (protocol §7.4.2), or the older `natural` / `protected` flags.
  const provenance = typeof m.provenance === 'string' ? m.provenance : null;
  const base = inBuilding(ctx, pos) || provenance === 'base';
  const crewBuilt = provenance === 'agent-built';
  const natural =
    provenance !== null ? provenance === 'natural' : typeof m.natural === 'boolean' ? m.natural : null;
  const isProtected =
    provenance !== null
      ? provenance === 'base' || provenance === 'player-built'
      : m.protected === true || natural === false || (base && m.protected !== false);
  const reachable =
    typeof m.reachable === 'boolean'
      ? m.reachable
      : m.reachable === 'reachable'
        ? true
        : m.reachable === 'unreachable'
          ? false
          : null;
  const t = obj(m.tree);
  const species = t ? str(t.species, 24) : null;
  const logs = t ? num(t.logs) : null;
  return {
    pos,
    block: short(str(m.block, 48) ?? 'block'),
    protected: isProtected,
    natural,
    reachable,
    exposed: typeof m.exposed === 'boolean' ? m.exposed : null,
    inBase: base,
    crewBuilt,
    tree: species ? `${short(species)} tree${logs !== null ? `, ${logs} logs` : ''}` : null,
  };
}

/** `find` → a list with natural / PROTECTED / unreachable marks, and what to do next. */
export function perceiveFind(result: Record<string, unknown>, ctx: PerceptionContext): Perceived {
  const p = ctx.playerName;
  const what = str(result.what, 64) ?? '?';
  const kind = typeof result.kind === 'string' ? result.kind : 'block';
  const raw = Array.isArray(result.matches) ? result.matches : [];
  const lines: string[] = [];
  const known = new Set(['what', 'kind', 'matches', 'note', 'inInventory', 'filter', 'protectedNote']);
  let trees: TreeSighting | null = null;

  if (kind === 'block') {
    const matches = raw
      .map((m) => (obj(m) ? classifyBlock(obj(m) as Record<string, unknown>, ctx) : null))
      .filter((m): m is BlockMatch => m !== null);
    const usable = USABLE_RE.test(what);
    // The mod lists only the nearest few (5 unless asked for more): a full list says nothing about how many exist.
    lines.push(
      matches.length >= FIND_LIST_LIMIT
        ? `find ${what}: the nearest ${matches.length} block(s) (only the nearest are listed; there may be more near them).`
        : `find ${what}: ${matches.length} block(s).`,
    );
    for (const m of matches) {
      const marks: string[] = [];
      if (m.protected && usable)
        marks.push(m.inBase ? 'in the Base: use it, never break it' : 'use it, never break it');
      else if (m.protected)
        marks.push(m.inBase ? 'PROTECTED (part of the Base)' : `PROTECTED (built by ${p})`);
      else if (m.crewBuilt) marks.push('built by the crew (yours to take back)');
      else if (m.natural === true) marks.push(m.tree ? `natural (${m.tree})` : 'natural');
      if (!m.protected) {
        if (m.reachable === true) marks.push('reachable');
        if (m.reachable === false) marks.push('UNREACHABLE (no path)');
      }
      if (m.exposed === false) marks.push('buried');
      lines.push(`- ${m.block} ${where(ctx, m.pos)}${marks.length > 0 ? `: ${marks.join(', ')}` : ''}`);
    }
    const free = matches.filter((m) => !m.protected);
    const reachable = free.filter((m) => m.reachable !== false);
    if (usable) {
      if (matches.length > 0)
        lines.push(
          'Use it where it stands (craft with table:{x,y,z}, use_block or container); never break it.',
        );
    } else if (matches.length > 0 && free.length === 0) {
      lines.push(
        `All of these are protected: never break them. Search further (a bigger radius, or walk toward a forest) or ask ${p}.`,
      );
    } else if (free.length > 0 && reachable.length === 0) {
      lines.push(
        `The natural ones are out of reach. Don't take protected blocks instead: ask ${p} (go further, use something else, or skip).`,
      );
    } else if (reachable.length > 0 && !what.startsWith('#')) {
      const near = reachable[0]?.pos;
      lines.push(
        `Gather natural ones: collect{item:"${what}", count:N} or mine{block:"${what}", count:N${near ? `, near:{x:${near.x},y:${near.y},z:${near.z}}` : ''}}.`,
      );
    }
    // Trees for the scene line: logs, never building variants (stripped logs, wood) that someone placed.
    const variant = (id: string) => /^stripped_|_wood$/.test(id);
    const kindOf = what.replace(/^#?minecraft:/, '');
    if (LOG_RE.test(kindOf) && !variant(kindOf)) {
      // A natural log (the mod names its tree), never one the crew placed.
      const log = (m: BlockMatch) => !variant(m.block) && !m.crewBuilt && m.natural !== false;
      const named = (list: BlockMatch[]) => list.find((m) => log(m) && m.tree !== null);
      const tree = named(reachable) ?? named(free) ?? reachable.find(log) ?? free.find(log);
      if (tree) trees = { pos: tree.pos, reachable: tree.reachable };
    }
  } else {
    lines.push(`find ${what}: ${raw.length} ${kind === 'entity' ? 'match(es)' : 'item stack(s)'}.`);
    for (const r of raw) {
      const m = obj(r);
      if (!m) continue;
      const pos = asPos(m.pos);
      const name =
        kind === 'entity'
          ? (str(m.name, 24) ?? short(str(m.type, 40) ?? 'entity'))
          : short(str(m.item, 40) ?? 'item');
      const count = num(m.count);
      const marks = kind === 'entity' && m.hostile === true ? ' HOSTILE' : '';
      lines.push(
        `- ${name}${count !== null ? ` ×${count}` : ''} ${pos ? where(ctx, pos) : ''}${marks}`.trimEnd(),
      );
    }
    if (num(result.inInventory) !== null) lines.push(`In your inventory: ${num(result.inInventory)}.`);
  }
  const note = str(result.note, 160);
  if (note) {
    lines.push(`Note: ${note}.`);
    if (raw.length === 0)
      lines.push(`Don't substitute something else on your own: search further or ask ${p}.`);
  }
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !known.has(k)));
  if (Object.keys(extra).length > 0) lines.push(`More: ${compactJson(extra, 2_000)}`);
  return { text: lines.join('\n'), trees };
}
