/**
 * The v2 `mc` result format (docs/design/tools-v2-mc.md §6): compact text lines instead of raw mod JSON.
 *
 * ```
 * <state>: <what> <outcome> [| fact | fact …]
 *  <detail line>            (0-6 lines, one record each, 1-space indent)
 * next: <one imperative line with exact v2 call syntax>   (only on running / failed / empty / truncated)
 * · <footer>
 * ```
 *
 * Rules (R1-R11): ids without `minecraft:`, positions as `x y z`, distances as whole metres plus an 8-point compass
 * (north is -Z), durations as `9s` / `3m 10s`, progress as `got/need`, item lists sorted by count and capped with
 * `+N more`, booleans as words, one record per line, never a JSON dump of a mod result (unknown keys are dropped),
 * `next:` at most 160 characters with literal `tool{json}` syntax. Text other people wrote (custom names, sign text,
 * Codex titles) goes through {@link escapeShared}.
 *
 * The mod keeps answering JSON; only Node renders. Everything here is pure: the tool handlers, `[JOB DONE]` wakes and
 * the eval harness share it.
 */

import type { BlockPos } from '@minevibe/protocol';
import { escapeShared, singleLine } from '../envelope.js';

// ---------------------------------------------------------------------------------------------------------------
// Basics (R1-R6)
// ---------------------------------------------------------------------------------------------------------------

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** R1: `minecraft:oak_log` → `oak_log`, `#minecraft:logs` → `#logs`; other namespaces stay. */
export function short(id: string): string {
  return id.replace(/^(#?)minecraft:/, '$1');
}

/** Text from the game that someone else may have written (names, signs), flattened and escaped. */
export function gameText(value: unknown, max = 40): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = singleLine(escapeShared(String(value)), max);
  return s.length > 0 ? s : null;
}

/** A mod id as shown: stripped and kept to one short line. */
export function idText(value: unknown, max = 48): string | null {
  if (typeof value !== 'string') return null;
  const s = singleLine(short(value), max);
  return s.length > 0 ? s : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A `{x,y,z}` with numeric fields, else null. */
export function asPos(value: unknown): BlockPos | null {
  const v = obj(value);
  if (!v) return null;
  const x = num(v.x);
  const y = num(v.y);
  const z = num(v.z);
  if (x === null || y === null || z === null) return null;
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

/** R2: `12 64 -30`. */
export function posText(p: Vec3Like): string {
  return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** The 8-point compass direction from `from` to `to` (north is -Z, east is +X), or null when on top of it. */
export function compass(from: Vec3Like, to: Vec3Like): string | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return null;
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return COMPASS[Math.round((((angle % 360) + 360) % 360) / 45) % 8] ?? null;
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** R3: `28m S` (or `here`). */
export function distDir(from: Vec3Like, to: Vec3Like): string {
  const d = Math.round(distance(from, to));
  const dir = compass(from, to);
  if (d <= 1 && dir === null) return 'here';
  return dir ? `${d}m ${dir}` : `${d}m`;
}

/** `6 66 24, 28m S` (the direction only when the agent's position is known). */
export function at(pos: BlockPos, here: Vec3Like | null): string {
  return here ? `${posText(pos)}, ${distDir(here, pos)}` : posText(pos);
}

/** R4: `9s`, `3m 10s`, `1h 2m`. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** R5: `oak_log 10, stick 2 +3 more` (count descending, ties by name). */
export function itemList(items: Record<string, unknown> | null | undefined, max = 6): string {
  const entries = Object.entries(items ?? {})
    .map(([k, v]) => [short(k), num(v) ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, max).map(([k, n]) => `${singleLine(k, 40)} ${n}`);
  const more = entries.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more} more` : shown.join(', ');
}

/** Caps text at `max` characters (on a line boundary when possible), marking the cut. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max - 2);
  const head = cut > max / 2 ? text.slice(0, cut) : text.slice(0, max - 1);
  return `${head}…`;
}

/** R9: one `next:` line, at most 160 characters. */
export function nextLine(text: string): string {
  return `next: ${singleLine(text, 160)}`;
}

/** `{"action":"wait","seconds":60}` without spaces (the model copies it). */
export function call(tool: string, args: Record<string, unknown>): string {
  return `${tool}${JSON.stringify(args)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Footer (§6.4)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The footer line: `· HP 18/20 food 15 | day 3 08:12 | 120 64 -80 | gather 4/10 oak_log | iron_axe`. The mod's own
 * footer is the source (it is from the same tick as the result); the overworld is left out, ids lose `minecraft:`.
 */
export function footerLine(footer: string | null | undefined): string | null {
  if (!footer) return null;
  const text = singleLine(footer.replace(/ overworld(?= \||$)/, '').replace(/minecraft:/g, ''), 200);
  return text.length > 0 ? `· ${text}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs (§6.1, §7)
// ---------------------------------------------------------------------------------------------------------------

/** What Node knows about a job it started: enough to render its result now and in a `[JOB DONE]` wake later. */
export interface JobMeta {
  /** The v2 tool (`gather`, `craft`, `use`, ...). */
  readonly tool: string;
  /** The wire skill. */
  readonly skill: string;
  /** What it does, for result lines: `gather oak_log`, `goto crafting_table`, `placed torch at 1 2 3`. */
  readonly what: string;
  /** For got/need: the item (or mob) and how many were asked for. */
  readonly want?: { readonly item: string; readonly count: number } | undefined;
  /** Where the body stood when it started (walked distances). */
  readonly from?: BlockPos | null | undefined;
  /** The v2 call's arguments (for `next:` hints that repeat or adjust the call). */
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  /** `do` steps, in order. */
  readonly steps?: readonly JobMeta[] | undefined;
}

export type JobState = 'done' | 'failed' | 'cancelled';

export interface JobOutcome {
  readonly status: JobState;
  readonly result?: Record<string, unknown> | undefined;
  readonly error?: { readonly code: string; readonly msg: string } | undefined;
  readonly durationMs?: number | undefined;
}

export interface RenderContext {
  /** The agent's position now (distances and directions), or null. */
  readonly here: Vec3Like | null;
  readonly playerName: string;
}

/** A rendered job: the first line, detail lines and an optional `next:` hint. */
export interface Rendered {
  readonly head: string;
  readonly details: readonly string[];
  readonly next: string | null;
  readonly isError: boolean;
}

/** Puts a rendered result together (§6.1), capped at `max` characters before the footer. */
export function compose(r: Rendered, footer: string | null, max = 600): string {
  const lines = [r.head, ...r.details.slice(0, 6).map((d) => ` ${d}`)];
  let body = capText(lines.join('\n'), max);
  if (r.next) body += `\n${nextLine(r.next)}`;
  return footer ? `${body}\n${footer}` : body;
}

/** Everything the mod's result says about items gained, without the one that was asked for. */
function alsoGot(result: Record<string, unknown>, want: string | null): Record<string, unknown> {
  const items = { ...(obj(result.items) ?? obj(result.gained) ?? {}) };
  if (want) {
    for (const k of Object.keys(items)) if (short(k) === short(want)) delete items[k];
  }
  return items;
}

/** "from 2 oak trees near 6 66 24" (M2 `sources`, or W1's `trees`). */
function sourcesText(result: Record<string, unknown>): string | null {
  const sources = arr(result.sources)
    .map(obj)
    .filter((s): s is Record<string, unknown> => s !== null);
  if (sources.length > 0) {
    const byKind = new Map<string, { n: number; what: string; pos: BlockPos | null }>();
    for (const s of sources) {
      const kind = typeof s.kind === 'string' ? s.kind : 'block';
      const what = idText(s.what) ?? '';
      const key = `${kind}:${what}`;
      const prev = byKind.get(key);
      const n = num(s.n) ?? 1;
      if (prev) prev.n += kind === 'tree' || kind === 'animal' ? 1 : n;
      else byKind.set(key, { n: kind === 'tree' || kind === 'animal' ? 1 : n, what, pos: asPos(s.pos) });
    }
    const parts: string[] = [];
    for (const [key, v] of byKind) {
      const kind = key.slice(0, key.indexOf(':'));
      const near = v.pos ? ` near ${posText(v.pos)}` : '';
      if (kind === 'tree') parts.push(`${v.n} ${v.what ? `${v.what} ` : ''}tree${v.n === 1 ? '' : 's'}${near}`);
      else if (kind === 'animal') parts.push(`${v.n} ${v.what || 'animal'}${v.n === 1 ? '' : 's'}`);
      else if (kind === 'ground') parts.push(`${v.n} picked up`);
      else parts.push(`${v.n} ${v.what || kind}${near}`);
    }
    return `from ${parts.slice(0, 3).join(', ')}`;
  }
  const trees = num(result.trees) ?? num(result.treesFelled);
  if (trees !== null && trees > 0) return `from ${trees} tree${trees === 1 ? '' : 's'}`;
  return null;
}

/** "have oak_log 10" or "have crafting_table 1, oak_log 9". */
function haveText(result: Record<string, unknown>, item: string | null): string | null {
  const have = num(result.have);
  if (have !== null && item) {
    const extra = obj(result.haveAlso);
    return extra ? `have ${short(item)} ${have}, ${itemList(extra, 3)}` : `have ${short(item)} ${have}`;
  }
  return null;
}

/** got/need for gathering, crafting and hunting (`4/10`). */
function progressOf(meta: JobMeta, result: Record<string, unknown>): string | null {
  if (!meta.want) return null;
  const got =
    num(result.got) ??
    num(result.collected) ??
    num(result.crafted) ??
    num(result.smelted) ??
    num(result.killed) ??
    num(result.mined) ??
    num(result.given);
  return got === null ? null : `${got}/${meta.want.count}`;
}

/** The skill-specific facts and detail lines of a result (done, or the partial result of a failure). */
export function describeResult(
  meta: JobMeta,
  result: Record<string, unknown> | undefined,
  ctx: RenderContext,
): { facts: string[]; details: string[] } {
  const r = result ?? {};
  const facts: string[] = [];
  const details: string[] = [];
  const want = meta.want?.item ?? null;
  switch (meta.skill) {
    case 'goto': {
      const pos = asPos(r.pos);
      if (pos) {
        const walked = meta.from ? ` (${Math.round(distance(meta.from, pos))}m)` : '';
        facts.push(`at ${posText(pos)}${walked}`);
      }
      break;
    }
    case 'collect':
    case 'mine': {
      const from = sourcesText(r);
      if (from) facts.push(from);
      const also = itemList(alsoGot(r, want), 4);
      if (also) facts.push(`also ${also}`);
      const replanted = num(r.replanted);
      if (replanted) facts.push(`replanted ${replanted}`);
      const tools = arr(r.tools_made ?? r.toolsMade)
        .map((t) => idText(t))
        .filter(Boolean);
      if (tools.length > 0) facts.push(`made ${tools.join(', ')}`);
      const have = haveText(r, want);
      if (have) facts.push(have);
      break;
    }
    case 'hunt':
    case 'attack': {
      const got = itemList(obj(r.items), 4);
      if (got) facts.push(`got ${got}`);
      if (r.killed === true) facts.push('killed');
      break;
    }
    case 'dig': {
      const dug = num(r.dug);
      const skipped = num(r.skipped);
      if (dug !== null) facts.push(`dug ${dug}${skipped ? `, skipped ${skipped}` : ''}`);
      const got = itemList(obj(r.items), 4);
      if (got) facts.push(`got ${got}`);
      break;
    }
    case 'place':
      break;
    case 'use_block':
    case 'use_item': {
      const what = typeof r.result === 'string' ? singleLine(r.result, 60) : null;
      if (what && what !== 'used') facts.push(what);
      const menu = idText(r.menu);
      if (menu) facts.push(`opened ${menu}`);
      break;
    }
    case 'eat': {
      const food = num(r.food);
      if (food !== null) facts.push(`food ${food}`);
      break;
    }
    case 'sleep':
      break;
    case 'drop':
      break;
    case 'give': {
      if (r.received === false) facts.push('some fell on the ground');
      break;
    }
    case 'craft':
    case 'smelt': {
      for (const step of arr(r.steps).slice(0, 4)) {
        if (typeof step === 'string') details.push(`made ${singleLine(short(step), 80)}`);
        else {
          const s = obj(step);
          if (s) {
            const text = [idText(s.item), num(s.count)].filter((x) => x !== null).join(' ');
            if (text) details.push(`made ${text}`);
          }
        }
      }
      const gathered = itemList(obj(r.gathered), 4);
      if (gathered) facts.push(`gathered ${gathered}`);
      const station = obj(r.station);
      const stationPos = asPos(station?.pos) ?? asPos(r.placedTable) ?? asPos(r.placedFurnace);
      if (station && stationPos) {
        const kind = idText(station.kind) ?? 'station';
        facts.push(`${station.placed === true ? 'placed' : 'used'} ${kind} at ${posText(stationPos)}`);
      } else if (asPos(r.placedTable)) {
        facts.push(`placed crafting_table at ${posText(asPos(r.placedTable) as BlockPos)}`);
      } else if (asPos(r.placedFurnace)) {
        facts.push(`placed furnace at ${posText(asPos(r.placedFurnace) as BlockPos)}`);
      } else if (meta.skill === 'craft' && typeof r.recipe === 'string' && r.table === undefined) {
        facts.push('2x2 grid');
      }
      const fuel = idText(r.fuel);
      if (fuel) facts.push(`fuel ${fuel}`);
      if (r.short === true) facts.push('ran out of ingredients');
      const note = typeof r.note === 'string' ? singleLine(r.note, 80) : null;
      if (note) facts.push(note);
      const item = idText(r.item) ?? want;
      const have = num(r.have);
      if (have !== null && item) {
        const also = obj(r.haveAlso);
        facts.push(also ? `have ${item} ${have}, ${itemList(also, 3)}` : `have ${item} ${have}`);
      }
      break;
    }
    case 'container': {
      const contents = obj(r.contents);
      if (contents) {
        const items = itemList(obj(contents.items), 8);
        const free = num(contents.freeSlots);
        details.push(`${items || 'empty'}${free !== null ? ` (${free} slots free)` : ''}`);
      }
      if (r.full === true) facts.push('the container is full');
      if (r.inventoryFull === true) facts.push('your inventory is full');
      break;
    }
    case 'open_menu': {
      const menu = idText(r.menu) ?? idText(r.type);
      if (menu) facts.push(menu);
      break;
    }
    case 'menu_click':
    case 'menu_close':
      break;
    case 'build': {
      const placed = num(r.placed);
      const dug = num(r.dug);
      const parts = [placed !== null ? `placed ${placed}` : null, dug ? `cleared ${dug}` : null].filter(Boolean);
      if (parts.length > 0) facts.push(parts.join(', '));
      const skipped = num(r.skipped);
      if (skipped) facts.push(`skipped ${skipped}`);
      const need = num(r.needBlocks);
      if (need !== null && placed === null) facts.push(`needs ${need} blocks`);
      break;
    }
    case 'farm': {
      const parts = ['harvested', 'planted', 'tilled', 'bonemealed']
        .map((k) => (num(r[k]) ? `${k} ${num(r[k])}` : null))
        .filter(Boolean);
      if (parts.length > 0) facts.push(parts.join(', '));
      const note = typeof r.note === 'string' ? singleLine(r.note, 80) : null;
      if (note) facts.push(note);
      break;
    }
    case 'ride':
    case 'dismount':
    case 'emote':
      break;
    default: {
      // R8: an unknown skill falls back to `k v` pairs (scalars only), capped.
      const pairs = Object.entries(r)
        .filter(([k, v]) => k !== 'footer' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
        .map(([k, v]) => `${k} ${typeof v === 'string' ? singleLine(short(v), 40) : String(v)}`);
      if (pairs.length > 0) facts.push(singleLine(pairs.join(', '), 300));
    }
  }
  void ctx;
  return { facts, details };
}

/** The first line of a done job: `done: gather oak_log 10/10 in 74s | from … | have oak_log 10`. */
export function renderDone(meta: JobMeta, outcome: JobOutcome, ctx: RenderContext): Rendered {
  const r = outcome.result ?? {};
  if (meta.skill === 'sequence') return renderSequence(meta, outcome, ctx);
  const progress = progressOf(meta, r);
  const time = outcome.durationMs !== undefined && outcome.durationMs >= 1000 ? ` in ${dur(outcome.durationMs)}` : '';
  const { facts, details } = describeResult(meta, r, ctx);
  const head = [`done: ${meta.what}${progress ? ` ${progress}` : ''}${time}`, ...facts].join(' | ');
  return { head, details, next: null, isError: false };
}

/** Failure detail lines: what is missing, where the candidates are, what is protected. */
export function failureDetails(
  code: string,
  result: Record<string, unknown> | undefined,
  ctx: RenderContext,
): string[] {
  const r = result ?? {};
  const out: string[] = [];
  // M4: `missing: [{item, need, have, for}]`; v1: `ingredients: {name: [need, have]}`.
  const missing = arr(r.missing)
    .map(obj)
    .filter((m): m is Record<string, unknown> => m !== null);
  if (missing.length > 0) {
    const parts = missing.slice(0, 4).map((m) => {
      const item = idText(m.item) ?? '?';
      const need = num(m.need) ?? 0;
      const have = num(m.have) ?? 0;
      const forWhat = idText(m.for);
      return `${item} ${need} (have ${have})${forWhat ? `, for ${forWhat}` : ''}`;
    });
    out.push(`need: ${parts.join('; ')}`);
  } else {
    const ingredients = obj(r.ingredients);
    if (ingredients) {
      const parts = Object.entries(ingredients)
        .map(([name, v]) => {
          const pair = Array.isArray(v) ? v : [];
          const need = num(pair[0]) ?? 0;
          const have = num(pair[1]) ?? 0;
          return have < need ? `${short(name)} ${need} (have ${have})` : null;
        })
        .filter(Boolean);
      if (parts.length > 0) out.push(`need: ${parts.join(', ')} per craft`);
    }
  }
  // M3 / W1: `candidates: [{pos, why, block?}]`; W2 reads `natural: [{pos}]`.
  const candidates = [...arr(r.candidates), ...arr(r.natural)]
    .map(obj)
    .filter((c): c is Record<string, unknown> => c !== null);
  for (const c of candidates.slice(0, 2)) {
    const pos = asPos(c.pos);
    if (!pos) continue;
    const what = idText(c.what) ?? idText(c.block) ?? 'source';
    const why = typeof c.why === 'string' ? singleLine(c.why, 60) : 'unreachable';
    out.push(`seen: ${what} at ${at(pos, ctx.here)}, ${why}`);
  }
  if (code === 'PROTECTED') {
    const blocks = arr(r.protected)
      .map(obj)
      .filter((b): b is Record<string, unknown> => b !== null);
    const first = blocks[0];
    const pos = asPos(first?.pos);
    const owner = gameText(first?.owner, 24);
    const zone = obj(r.zone)?.kind ?? r.zone;
    const whose = zone === 'base' ? 'part of the Base' : owner ? `${owner}'s (player-built)` : `player-built`;
    if (pos) {
      const what = idText(first?.block) ?? 'block';
      const more = blocks.length > 1 ? ` (+${blocks.length - 1} more)` : '';
      out.push(`${what} at ${posText(pos)} is ${whose}${more}`);
    } else if (zone === 'base') {
      out.push('the target is inside the Base');
    }
  }
  const protectedCount = num(r.protectedCount);
  if (protectedCount) out.push(`left alone: ${protectedCount} player-built or Base blocks`);
  return out;
}

/** What `next:` says after a failure (§8). `meta.args` lets hints repeat or adjust the call. */
export function hintFor(code: string, meta: JobMeta, ctx: RenderContext): string | null {
  const p = ctx.playerName;
  const item = meta.want?.item ?? (typeof meta.args?.item === 'string' ? meta.args.item : null);
  const count = meta.want?.count ?? 1;
  switch (code) {
    case 'BAD_ARGS':
      return null;
    case 'UNKNOWN_PLACE':
      return `${call('codex', { action: 'search', query: String(meta.args?.to ?? meta.args?.target ?? '') })} or give "x y z"`;
    case 'NOT_FOUND':
      return item
        ? `${call('find', { target: item, radius: 64 })}, goto elsewhere, or ask ${p} where to look`
        : `observe, or ask ${p}`;
    case 'UNREACHABLE':
      return item
        ? `pick another spot from ${call('find', { target: item })}, goto nearer, or ask ${p}`
        : `goto nearer first, or ask ${p}`;
    case 'NO_NATURAL_SOURCE':
      return `ask ${p} (AskUserQuestion: go further / use something else / skip). Never take ${item ? short(item) : 'it'} from buildings.`;
    case 'PROTECTED':
      return `ask ${p} with AskUserQuestion; only an option starting "Allow" lets you repeat this exact call. Never work around it.`;
    case 'OTHER_DIMENSION':
      return `goto a portal, or ask ${p}`;
    case 'NEEDS_TOOL':
      return `${call('craft', { item: 'wooden_pickaxe' })} (or the stone/iron tier the message names), then retry`;
    case 'MISSING_INGREDIENTS':
    case 'NEEDS_TABLE':
    case 'NO_TABLE':
    case 'NEEDS_FURNACE':
    case 'NO_FURNACE':
    case 'FURNACE_BUSY':
    case 'NO_FUEL':
      return meta.tool === 'craft' && item
        ? `${call('craft', { item, ...(count > 1 ? { count } : {}), gather_missing: true })}`
        : item
          ? `${call('craft', { item, gather_missing: true })}`
          : `${call('observe', { sections: ['inventory'] })}, then gather or craft`;
    case 'NO_RECIPE':
      return item ? `${call('gather', { item, count })} (it is gathered, not crafted)` : null;
    case 'NO_ITEM':
    case 'NO_MATERIAL':
      return `${call('observe', { sections: ['inventory'] })}, then gather or craft it`;
    case 'INVENTORY_FULL':
      return `${call('items', { action: 'store' })} at a chest, or drop what you don't need`;
    case 'OCCUPIED':
    case 'NO_SUPPORT':
    case 'BLOCKED':
    case 'CANNOT_PLACE':
    case 'NO_ROOM':
      return `choose another spot (${call('observe', { sections: ['scene'] })})`;
    case 'NO_FOOD':
      return `${call('gather', { item: 'beef', count: 3 })} or ask ${p} for food`;
    case 'NOT_HUNGRY':
      return null;
    case 'NO_BED':
    case 'NOT_NIGHT':
    case 'NOT_SAFE':
    case 'OBSTRUCTED':
    case 'CANNOT_SLEEP_HERE':
      return null;
    case 'ESCAPED':
      return 'retry once or move on';
    case 'NOT_A_CONTAINER':
    case 'NO_MENU':
    case 'BAD_CLICK':
    case 'BAD_SLOT':
      return call('menu', { action: 'state' });
    case 'SEATED':
    case 'SEAT_EXCLUDED':
      return 'stand_up first';
    case 'NOT_RIDEABLE':
      return call('use', { action: 'dismount' });
    case 'UNKNOWN_BLUEPRINT':
      return 'blueprints: shelter, wall_ring, torch_ring, bridge, stairs_down, farm_plot';
    case 'TIMEOUT':
      return `${call('job', { action: 'status' })}, or retry with a smaller count`;
    case 'UNKNOWN_JOB':
      return call('job', { action: 'status' });
    case 'DISCONNECTED':
    case 'NO_SERVER':
    case 'UNKNOWN_AGENT':
      return `try once more; if it fails again, tell ${p} the game isn't responding`;
    case 'INTERNAL':
    case 'FAILED':
      return `tell ${p} briefly what failed; don't loop`;
    default:
      return null;
  }
}

/** Codes after which the model must stop and ask instead of retrying or substituting. */
export const HARD_STOP_CODES: ReadonlySet<string> = new Set(['PROTECTED', 'NO_NATURAL_SOURCE', 'BAD_TARGET']);

/** `failed: gather oak_log 0/10 | NO_NATURAL_SOURCE: …` plus details and `next:`. */
export function renderFailed(meta: JobMeta, outcome: JobOutcome, ctx: RenderContext): Rendered {
  if (meta.skill === 'sequence') return renderSequence(meta, outcome, ctx);
  const r = outcome.result ?? {};
  const code = outcome.error?.code ?? 'FAILED';
  const msg = singleLine(outcome.error?.msg ?? 'failed', 200);
  const progress = progressOf(meta, r);
  if (outcome.status === 'cancelled') {
    const kept = itemList(obj(r.items), 3);
    const why = msg && msg !== 'cancelled' && msg !== 'failed' ? ` (${msg})` : '';
    return {
      head: `cancelled: ${meta.what}${progress ? ` ${progress}` : ''}${why}${kept ? ` | kept ${kept}` : ''}`,
      details: [],
      next: null,
      isError: true,
    };
  }
  const { facts } = describeResult(meta, r, ctx);
  const head = [`failed: ${meta.what}${progress ? ` ${progress}` : ''}`, `${code}: ${msg}`, ...facts.slice(0, 2)].join(
    ' | ',
  );
  return { head, details: failureDetails(code, r, ctx), next: hintFor(code, meta, ctx), isError: true };
}

/** A done, failed or cancelled job. */
export function renderOutcome(meta: JobMeta, outcome: JobOutcome, ctx: RenderContext): Rendered {
  return outcome.status === 'done' ? renderDone(meta, outcome, ctx) : renderFailed(meta, outcome, ctx);
}

/** `running: gather oak_log 4/10 (job j2-7, 20s so far)` plus how to wait. */
export function renderRunning(
  meta: JobMeta,
  jobId: string,
  elapsedMs: number,
  progressText: string | null,
): Rendered {
  const progress = progressText ? ` ${singleLine(short(progressText), 80)}` : '';
  return {
    head: `running: ${meta.what}${progress} (job ${jobId}, ${dur(elapsedMs)} so far)`,
    details: [],
    next: `end your turn; [JOB DONE] wakes you. Or ${call('job', { action: 'wait', seconds: 60 })}, ${call('job', { action: 'stop' })}.`,
    isError: false,
  };
}

/** `do`: one line per step (§5.10). */
export function renderSequence(meta: JobMeta, outcome: JobOutcome, ctx: RenderContext): Rendered {
  const steps = meta.steps ?? [];
  const n = steps.length;
  const r = outcome.result ?? {};
  const results = arr(r.steps).map(obj);
  const completed = num(r.completed) ?? results.filter((s) => s?.status === 'done').length;
  const time = outcome.durationMs !== undefined && outcome.durationMs >= 1000 ? ` in ${dur(outcome.durationMs)}` : '';
  const details: string[] = [];
  let failedAt = -1;
  let failedCode: string | null = null;
  for (let i = 0; i < n; i++) {
    const step = steps[i] as JobMeta;
    const res = results[i] ?? null;
    if (!res) {
      details.push(`${i + 1} ${step.what} skipped`);
      continue;
    }
    const status = typeof res.status === 'string' ? res.status : 'done';
    const stepResult = obj(res.result) ?? undefined;
    if (status === 'done') {
      const line = renderDone(step, { status: 'done', result: stepResult }, ctx).head.replace(/^done: /, '');
      details.push(`${i + 1} ${singleLine(line, 160)}`);
    } else {
      const code = typeof res.code === 'string' ? res.code : 'FAILED';
      if (failedAt < 0) {
        failedAt = i;
        failedCode = code;
      }
      const progress = stepResult ? progressOf(step, stepResult) : null;
      details.push(`${i + 1} ${step.what}${progress ? ` ${progress}` : ''} ${status === 'cancelled' ? 'cancelled' : 'failed'}`);
    }
  }
  if (outcome.status === 'done') {
    return { head: `done: do ${completed}/${n} steps${time}`, details, next: null, isError: false };
  }
  const code = outcome.error?.code ?? failedCode ?? 'FAILED';
  const msg = singleLine(outcome.error?.msg ?? 'failed', 200).replace(/^step \d+\/\d+ \S+: /, '');
  if (outcome.status === 'cancelled') {
    return { head: `cancelled: do ${completed}/${n} steps${time} (${msg})`, details, next: null, isError: true };
  }
  const idx = failedAt >= 0 ? failedAt : Math.min(completed, n - 1);
  const step = steps[idx];
  const stepResult = obj(results[idx]?.result) ?? undefined;
  const extra = step ? failureDetails(code, stepResult, ctx) : [];
  return {
    head: `failed: do step ${idx + 1}/${n} ${step?.tool ?? ''} | ${code}: ${msg}`.replace('  |', ' |'),
    details: [...details, ...extra],
    next: step ? hintFor(code, step, ctx) : null,
    isError: true,
  };
}

/** The `[JOB DONE]` / `[JOB FAILED]` text (§6.5): line 1 of the result, plus `next:` for failures; ≤ 400 chars. */
export function wakeText(jobId: string, rendered: Rendered): string {
  const head = rendered.head.replace(/^(done|failed|cancelled): /, '');
  const next = rendered.next ? ` | next: ${rendered.next}` : '';
  return singleLine(`${jobId} ${head}${next}`, 400);
}

// ---------------------------------------------------------------------------------------------------------------
// Observations (§5.1, §5.2)
// ---------------------------------------------------------------------------------------------------------------

export type Detail = 'brief' | 'full';

/** Per-section caps, brief/full (§5.1). */
export const SECTION_CAPS: Readonly<Record<string, readonly [number, number]>> = {
  status: [200, 400],
  scene: [900, 2500],
  inventory: [300, 1200],
  crew: [400, 1000],
  jobs: [200, 600],
  events: [400, 1500],
  pcs: [300, 600],
  menu: [600, 2000],
};

function capSection(name: string, text: string, detail: Detail): string {
  const caps = SECTION_CAPS[name] ?? [400, 1000];
  return capText(text, detail === 'full' ? caps[1] : caps[0]);
}

/** `status: HP 20/20 food 20 | day 1 06:15 clear | 5 66 -5 plains | idle (follow, Player 2m) | held wheat_seeds`. */
export function renderStatus(r: Record<string, unknown>, ctx: RenderContext, detail: Detail = 'brief'): string {
  const parts: string[] = [];
  const hp = num(r.hp);
  const maxHp = num(r.maxHp);
  const food = num(r.food);
  if (hp !== null) parts.push(`HP ${Math.ceil(hp)}/${Math.round(maxHp ?? 20)}${food !== null ? ` food ${food}` : ''}`);
  const time = gameText(r.time, 24);
  const weather = typeof r.weather === 'string' && r.weather !== 'clear' ? ` ${r.weather}` : '';
  if (time) parts.push(`${time.replace(/^Day/, 'day')}${weather}`);
  const pos = asPos(r.pos);
  const dim = typeof r.dim === 'string' && r.dim !== 'minecraft:overworld' ? ` ${short(r.dim)}` : '';
  const biome = idText(r.biome, 24);
  if (pos) parts.push(`${posText(pos)}${dim}${biome ? ` ${biome}` : ''}`);
  const zone = obj(r.zone);
  if (zone && typeof zone.kind === 'string') {
    const name = gameText(zone.name, 40);
    if (zone.kind === 'base') parts.push(`in Base${name ? ` (${name})` : ''}`);
    else if (zone.kind === 'built') parts.push(`by ${ctx.playerName}'s builds`);
  }
  const activity = gameText(r.activity, 60);
  const mode = typeof r.mode === 'string' ? r.mode : null;
  const pd = num(r.playerDistance);
  const playerBit = pd !== null ? `${ctx.playerName} ${Math.round(pd)}m` : null;
  if (activity) parts.push(activity.replace(/minecraft:/g, ''));
  else if (mode) parts.push(`idle (${[mode, playerBit].filter(Boolean).join(', ')})`);
  if (activity && playerBit) parts.push(playerBit);
  const seat = obj(r.seat);
  if (seat && typeof seat.pcId === 'string') parts.push(`seated at ${singleLine(seat.pcId, 24)}`);
  if (r.inCombat === true) parts.push('IN COMBAT');
  const held = idText(r.held, 32);
  if (held && held !== 'nothing') parts.push(`held ${held}`);
  if (detail === 'full') {
    const effects = arr(r.effects)
      .map((e) => gameText(e, 30))
      .filter(Boolean);
    if (effects.length > 0) parts.push(`effects ${effects.join(', ')}`);
    const armor = num(r.armor);
    if (armor) parts.push(`armor ${armor}`);
    const xp = num(r.xpLevel);
    if (xp) parts.push(`xp ${xp}`);
  }
  return capSection('status', `status: ${parts.join(' | ')}`, detail);
}

/** `inventory: 34 slots free | oak_log 10, wheat_seeds 3` (+ equipment in full). */
export function renderInventory(r: Record<string, unknown>, detail: Detail = 'brief'): string {
  const counts: Record<string, number> = {};
  const durability: Record<string, number> = {};
  for (const s of arr(r.slots)) {
    const slot = obj(s);
    const item = typeof slot?.item === 'string' ? slot.item : null;
    if (!item) continue;
    counts[item] = (counts[item] ?? 0) + (num(slot?.count) ?? 1);
    const d = num(slot?.durability);
    if (d !== null) durability[short(item)] = d;
  }
  if (Object.keys(counts).length === 0 && obj(r.totals)) Object.assign(counts, obj(r.totals));
  const free = num(r.freeSlots);
  const list = itemList(counts, detail === 'full' ? 20 : 8);
  const head = `inventory: ${free !== null ? `${free} slots free` : '?'} | ${list || 'empty'}`;
  const lines = [head];
  if (detail === 'full') {
    const gear: string[] = [];
    const armor = obj(r.armor) ?? {};
    for (const [slot, item] of Object.entries(armor)) {
      const id = idText(item, 32);
      if (id) gear.push(`${slot} ${id}`);
    }
    const off = idText(r.offhand, 32);
    if (off) gear.push(`offhand ${off}`);
    if (gear.length > 0) lines.push(` worn: ${gear.join(', ')}`);
    const tools = Object.entries(durability).map(([k, v]) => `${k} ${v}`);
    if (tools.length > 0) lines.push(` durability: ${tools.slice(0, 8).join(', ')}`);
  }
  return capSection('inventory', lines.join('\n'), detail);
}

/** A crew member's names as Node knows them. */
export interface CrewNames {
  readonly handle: string;
  readonly name: string;
  readonly role: string;
}

/** `crew: Player 2m | @bram Bram (miner) 42m NE gather 3/20 iron_ore HP 20 | @cleo Cleo (engineer) seated at linux-1`. */
export function renderCrew(
  r: Record<string, unknown>,
  ctx: RenderContext & {
    readonly self: string;
    readonly names?: (agentId: string) => CrewNames | null;
    readonly playerDistance?: number | null;
  },
  detail: Detail = 'brief',
): string {
  const parts: string[] = [];
  if (ctx.playerDistance !== undefined && ctx.playerDistance !== null) {
    parts.push(`${ctx.playerName} ${Math.round(ctx.playerDistance)}m`);
  }
  for (const raw of arr(r.crew)) {
    const m = obj(raw);
    if (!m) continue;
    const id = typeof m.agentId === 'string' ? m.agentId : '?';
    if (id === ctx.self) continue;
    const names = ctx.names?.(id) ?? null;
    const name = names ? `@${names.handle} ${names.name} (${names.role})` : (gameText(m.name, 24) ?? id);
    const pos = asPos(m.pos);
    const where =
      typeof m.seated === 'string'
        ? `seated at ${singleLine(m.seated, 24)}`
        : pos && ctx.here
          ? distDir(ctx.here, pos)
          : pos
            ? `at ${posText(pos)}`
            : '';
    const activity = gameText(m.activity, 40);
    const hp = num(m.hp);
    const bits = [name, where, activity && !where.startsWith('seated') ? activity.replace(/minecraft:/g, '') : null];
    if (detail === 'full' && hp !== null) bits.push(`HP ${Math.ceil(hp)}`);
    parts.push(bits.filter(Boolean).join(' '));
  }
  return capSection('crew', `crew: ${parts.length > 0 ? parts.join(' | ') : 'nobody else'}`, detail);
}

/** `events: 1m ago picked_up oak_sapling 2; 4m ago hurt (HP 14)`. */
export function renderEvents(r: Record<string, unknown>, detail: Detail = 'brief'): string {
  const events = arr(r.events)
    .map(obj)
    .filter((e): e is Record<string, unknown> => e !== null);
  const shown = events.slice(-(detail === 'full' ? 20 : 8)).reverse();
  const parts = shown.map((e) => {
    const ago = num(e.agoS);
    const when = ago === null ? '' : ago < 60 ? `${Math.round(ago)}s ago ` : `${Math.round(ago / 60)}m ago `;
    const type = gameText(e.type, 30) ?? 'event';
    const data = obj(e.data);
    const extra = data
      ? Object.entries(data)
          .slice(0, 3)
          .map(([k, v]) => (k === 'job' || k === 'item' || k === 'reflex' ? gameText(short(String(v)), 30) : `${k} ${gameText(short(String(v)), 30)}`))
          .filter(Boolean)
          .join(' ')
      : '';
    return `${when}${type}${extra ? ` ${extra}` : ''}`;
  });
  return capSection('events', `events: ${parts.length > 0 ? parts.join('; ') : 'nothing lately'}`, detail);
}

/** `pcs: linux-1 running, free, chair 108 68 780 (4m) | mac-1 stopped`. */
export function renderPcs(r: Record<string, unknown>, ctx: RenderContext, detail: Detail = 'brief'): string {
  const parts: string[] = [];
  for (const raw of arr(r.pcs)) {
    const pc = obj(raw);
    if (!pc) continue;
    const id = gameText(pc.pcId, 24) ?? '?';
    const status = gameText(pc.status, 16) ?? 'unknown';
    const occupant = gameText(pc.occupant, 24) ?? 'free';
    const chair = asPos(pc.chair);
    const d = num(pc.distance);
    const bits = [`${id} ${status}`, occupant === 'free' ? 'free' : `taken (${occupant})`];
    if (chair) bits.push(`chair ${posText(chair)}${d !== null ? ` (${Math.round(d)}m)` : ''}`);
    const reserved = gameText(pc.reservedFor, 32);
    if (reserved) bits.push(`reserved for ${reserved}`);
    parts.push(bits.join(', '));
  }
  void ctx;
  return capSection('pcs', `pcs: ${parts.length > 0 ? parts.join(' | ') : 'none'}`, detail);
}

/** `menu: merchant | buttons: -2 = emerald 1 → bread 6 | slots: 0 wheat 20 …`. */
export function renderMenu(r: Record<string, unknown>, detail: Detail = 'brief'): string {
  if (r.open === false) return 'menu: none open';
  const type = idText(r.type, 40) ?? 'menu';
  const lines = [`menu: ${type}${r.lit === true ? ' (lit)' : ''}`];
  const offers = arr(r.offers)
    .map(obj)
    .filter((o): o is Record<string, unknown> => o !== null);
  if (offers.length > 0) {
    const shown = offers.slice(0, detail === 'full' ? 12 : 5).map((o) => {
      const cost = [o.costA, o.costB].map((c) => (typeof c === 'string' ? short(c).replace(' x', ' ') : null)).filter(Boolean);
      const res = typeof o.result === 'string' ? short(o.result).replace(' x', ' ') : '?';
      return `${num(o.button) ?? '?'} = ${cost.join(' + ')} → ${res}${o.outOfStock === true ? ' (out of stock)' : ''}`;
    });
    lines.push(` buttons: ${shown.join('; ')}${offers.length > shown.length ? ` +${offers.length - shown.length} more` : ''}`);
  }
  const costs = arr(r.levelCosts).map(num);
  if (costs.length > 0) lines.push(` buttons: -2/-3/-4 = enchant options costing ${costs.join('/')} levels`);
  const recipes = num(r.recipes);
  if (recipes !== null) lines.push(` buttons: -2 - index picks one of ${recipes} recipes (selected ${num(r.selected) ?? -1})`);
  const theirs: string[] = [];
  const own: string[] = [];
  for (const raw of arr(r.slots)) {
    const s = obj(raw);
    if (!s) continue;
    const text = `${num(s.slot) ?? '?'} ${idText(s.item, 32) ?? '?'} ${num(s.count) ?? 1}`;
    (s.own === true ? own : theirs).push(text);
  }
  if (theirs.length > 0) lines.push(` slots: ${theirs.slice(0, detail === 'full' ? 40 : 12).join(', ')}`);
  if (own.length > 0) lines.push(` yours: ${own.slice(0, detail === 'full' ? 40 : 8).join(', ')}${own.length > 8 && detail !== 'full' ? ' …' : ''}`);
  const carried = typeof r.carried === 'string' ? short(r.carried) : null;
  if (carried) lines.push(` carried: ${singleLine(carried, 40)}`);
  return capSection('menu', lines.join('\n'), detail);
}

/** One job from `obs.query job_status` (the mod's view). */
export function renderJobStatus(r: Record<string, unknown>): string | null {
  const status = typeof r.status === 'string' ? r.status : null;
  if (!status) return null;
  if (status === 'idle') return 'idle';
  const id = typeof r.jobId === 'string' ? r.jobId : '';
  const skill = typeof r.skill === 'string' ? r.skill : (typeof r.current === 'string' ? r.current : '');
  const text = typeof r.text === 'string' ? ` ${singleLine(short(r.text), 60)}` : '';
  const elapsed = num(r.elapsedS);
  return `${status} ${[id, skill].filter(Boolean).join(' ')}${text}${elapsed !== null ? ` (${dur(elapsed * 1000)})` : ''}`;
}

/** A tree the agent saw (feeds W2's scene line). */
export interface TreeSeen {
  readonly pos: BlockPos;
  readonly reachable: boolean | null;
}

/**
 * `find` (§5.2): `find oak_log (natural, ≤48m): 2 found` and one ranked record per line. Reads the mod's provenance
 * marks (`provenance`: natural / player-built / base / agent-built, `reachable`: reachable / unreachable / far, `tree`:
 * the trunk a log belongs to) and, from a mod without them, the older boolean flags; Node's Base box marks the rest.
 */
export function renderFind(
  r: Record<string, unknown>,
  ctx: RenderContext & { readonly inBase?: ((pos: BlockPos) => boolean) | undefined },
  query: { readonly target: string; readonly source: string; readonly radius: number },
  detail: Detail = 'brief',
): { text: string; trees: TreeSeen | null } {
  const kind = typeof r.kind === 'string' ? r.kind : 'block';
  const what = short(query.target);
  const matches = arr(r.matches)
    .map(obj)
    .filter((m): m is Record<string, unknown> => m !== null);
  const scope = kind === 'block' ? `${query.source}, ≤${query.radius}m` : `≤${query.radius}m`;
  const lines: string[] = [];
  let trees: TreeSeen | null = null;
  const seenTrunks = new Set<string>();
  let rank = 0;
  for (const m of matches) {
    const pos = asPos(m.pos);
    if (!pos) continue;
    if (kind === 'block') {
      const tree = obj(m.tree);
      const trunk = asPos(tree?.trunk);
      if (trunk) {
        const key = posText(trunk);
        if (seenTrunks.has(key)) continue;
        seenTrunks.add(key);
      }
      const prov = typeof m.provenance === 'string' ? m.provenance : null;
      const legacyProtected = m.protected === true || m.natural === false;
      const base = ctx.inBase?.(pos) === true;
      const marks: string[] = [];
      let isProtected = false;
      if (prov === 'natural' || (prov === null && m.natural === true && !base)) marks.push('natural');
      else if (prov === 'agent-built') marks.push(`built by ${gameText(m.owner, 24) ?? 'an agent'}`);
      else if (prov !== null || legacyProtected || base) {
        isProtected = true;
        const owner = gameText(m.owner, 24) ?? ctx.playerName;
        marks.push(prov === 'base' || (prov === null && base) ? 'Base, protected' : `${owner}'s (player-built), protected`);
      }
      const reach =
        typeof m.reachable === 'string'
          ? m.reachable
          : m.reachable === true
            ? 'reachable'
            : m.reachable === false
              ? 'unreachable'
              : null;
      if (!isProtected && reach && reach !== 'far') {
        marks.push(reach === 'unreachable' ? 'unreachable (no path)' : singleLine(reach, 20));
      }
      if (m.exposed === false) marks.push('buried');
      const note = typeof m.note === 'string' ? m.note : '';
      if (/not a tree/.test(note)) marks.push('not a tree');
      const block = idText(m.block) ?? what;
      const label = trunk ? `${idText(tree?.species) ?? ''} tree, trunk ×${num(tree?.logs) ?? '?'}`.trim() : block;
      const where = trunk ?? pos;
      rank++;
      lines.push(`${rank}. ${label} at ${at(where, ctx.here)}${marks.length > 0 ? `, ${marks.join(', ')}` : ''}`);
      if (!trees && !isProtected && (trunk || /_log$|_stem$/.test(block))) {
        trees = { pos: where, reachable: reach === 'unreachable' ? false : reach === 'reachable' ? true : null };
      }
    } else if (kind === 'entity') {
      const name =
        m.type === 'player' || m.type === 'agent'
          ? (gameText(m.name, 24) ?? String(m.type))
          : (gameText(m.name, 24) ?? idText(m.type) ?? 'entity');
      const hp = num(m.hp);
      rank++;
      lines.push(
        `${rank}. ${name} at ${at(pos, ctx.here)}${hp !== null ? `, HP ${Math.ceil(hp)}` : ''}${m.hostile === true ? ', hostile' : ''}`,
      );
    } else {
      rank++;
      lines.push(`${rank}. ${idText(m.item) ?? what} ×${num(m.count) ?? 1} at ${at(pos, ctx.here)}`);
    }
  }
  const head = `find ${what} (${scope}): ${rank === 0 ? 'none' : `${rank} found`}`;
  const inInv = num(r.inInventory);
  const have = inInv ? ` | you have ${inInv}` : '';
  if (rank === 0) {
    const hint =
      query.radius < 64
        ? `${call('find', { target: query.target, radius: 64 })}, or ask ${ctx.playerName} where to look`
        : `goto another area, or ask ${ctx.playerName} where to look`;
    return {
      text: `${head}${kind === 'block' ? ' (loaded chunks only)' : ''}${have}\n${nextLine(hint)}`,
      trees,
    };
  }
  const text =
    rank === 1 ? `${head}${have}: ${(lines[0] ?? '').replace(/^1\. /, '')}` : [`${head}${have}`, ...lines].join('\n');
  return { text: capText(text, detail === 'full' ? 1500 : 700), trees };
}

/**
 * The `scene` section (§5.1): the mod's own scene text when it sends one (W1 renders `look_around` as lines), else
 * `fallback` (Node's perception of the older JSON), prefixed with the radius.
 */
export function renderScene(
  r: Record<string, unknown>,
  radius: number,
  detail: Detail,
  fallback: (r: Record<string, unknown>) => string,
): string {
  const raw = typeof r.scene === 'string' && r.scene.trim().length > 0 ? r.scene : fallback(r);
  const text = raw
    .split('\n')
    .map((l) => escapeShared(l).replace(/minecraft:/g, '').trimEnd())
    .filter((l) => l.length > 0)
    .join('\n ');
  return capSection('scene', `scene (${radius}m): ${text}`, detail);
}
