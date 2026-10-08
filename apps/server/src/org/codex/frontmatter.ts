/**
 * Codex page files: `---` frontmatter, then the markdown body.
 *
 * Every frontmatter value is written as JSON (`title: "Iron cave"`, `tags: ["iron","mining"]`), which is also valid
 * YAML, so the files read naturally and open in any markdown tool, while parsing stays exact and dependency-free.
 */

import { isAbsolute } from 'node:path';
import type { AuthorKind } from '../envelope.js';
import { type CodexPage, type Coords, isCodexCategory, isCodexScope } from './types.js';

const KEY_ORDER = [
  'id',
  'title',
  'tags',
  'category',
  'scope',
  'world',
  'author',
  'authorName',
  'authorKind',
  'created',
  'updated',
  'createdDay',
  'links',
  'rev',
  'pinned',
  'coords',
  'contributors',
  'rollup',
] as const;

/** Serialises a page to its file text. */
export function serializePage(page: CodexPage): string {
  const lines = ['---'];
  const record = page as unknown as Record<string, unknown>;
  for (const key of KEY_ORDER) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === 'rollup' && value === false) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '');
  const body = page.body.endsWith('\n') ? page.body : `${page.body}\n`;
  return `${lines.join('\n')}${body}`;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function coords(v: unknown): Coords | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const nums = [o.x, o.y, o.z];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x: o.x as number, y: o.y as number, z: o.z as number, dim: str(o.dim, 'minecraft:overworld') };
}

function authorKind(v: unknown): AuthorKind {
  return v === 'player' || v === 'system' ? v : 'agent';
}

/**
 * Parses a page file. `id` is the file's slug, which wins over the frontmatter. Returns null when the file has no
 * usable frontmatter. Unknown keys are ignored; lines that are not `key: <json>` are ignored too.
 */
export function parsePage(text: string, id: string): CodexPage | null {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const head = normalized.slice(4, end);
  let body = normalized.slice(end + 5);
  if (body.startsWith('\n')) body = body.slice(1);
  body = body.replace(/\n$/, '');

  const fm: Record<string, unknown> = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const raw = (m[2] ?? '').trim();
    try {
      fm[m[1] as string] = JSON.parse(raw);
    } catch {
      fm[m[1] as string] = raw; // a hand-edited plain scalar
    }
  }
  const category = isCodexCategory(fm.category) ? fm.category : 'howto';
  const scope = isCodexScope(fm.scope) ? fm.scope : 'lasting';
  const rev = typeof fm.rev === 'number' && Number.isInteger(fm.rev) && fm.rev > 0 ? fm.rev : 1;
  const created = str(fm.created, new Date(0).toISOString());
  return {
    id,
    title: str(fm.title, id),
    tags: strArray(fm.tags),
    category,
    scope,
    world: typeof fm.world === 'string' ? fm.world : undefined,
    author: str(fm.author, 'unknown'),
    authorName: str(fm.authorName, str(fm.author, 'unknown')),
    authorKind: authorKind(fm.authorKind),
    created,
    updated: str(fm.updated, created),
    createdDay: typeof fm.createdDay === 'number' ? fm.createdDay : undefined,
    links: strArray(fm.links),
    rev,
    pinned: fm.pinned === true,
    coords: coords(fm.coords),
    contributors: strArray(fm.contributors),
    rollup: fm.rollup === true ? true : undefined,
    body,
  };
}

/** Lowercase ASCII slug (≤ 48 chars) for a title; never empty, never a path. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'page';
}

const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True for an id that can name a page file. */
export function isValidPageId(id: string): boolean {
  return PAGE_ID_RE.test(id) && !isAbsolute(id);
}

/** Normalises tags: lowercase `[a-z0-9-]`, ≤ 24 chars, unique, at most `max`. */
export function normalizeTags(tags: readonly string[] | undefined, max: number): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const t = slugify(String(tag)).slice(0, 24).replace(/-+$/g, '');
    if (t && t !== 'page' && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
