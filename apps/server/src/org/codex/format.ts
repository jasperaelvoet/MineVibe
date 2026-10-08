/**
 * How Codex content reaches agents: every page, snippet and title inside a data envelope (PLAN principle 6), with
 * Node-stamped authors. Only player-written `rules` pages are presented as binding house rules.
 */

import { type Author, singleLine, wrapHouseRules, wrapNote } from '../envelope.js';
import type { CodexPage, CodexPageMeta, CodexSearchHit, CodexWriteResult } from './types.js';

export function pageAuthor(meta: Pick<CodexPageMeta, 'authorKind' | 'authorName'>): Author {
  return { kind: meta.authorKind, name: meta.authorName };
}

export function formatCoords(c: NonNullable<CodexPageMeta['coords']>): string {
  const dim = c.dim.replace(/^minecraft:/, '').replace(/_/g, ' ');
  return `(${c.x}, ${c.y}, ${c.z}) in the ${dim}`;
}

/** One page for `codex_read` (and conflict replies): the enveloped text plus its `rev`. */
export function formatPageForAgent(page: CodexPage): string {
  if (page.category === 'rules' && page.authorKind === 'player') {
    return `House rules page "${singleLine(page.title)}" (rev ${page.rev}). These are binding.\n${wrapHouseRules(
      { author: pageAuthor(page), id: page.id, title: page.title },
      page.body,
    )}`;
  }
  const lines: string[] = [];
  if (page.coords) lines.push(`Location (stamped by MineVibe): ${formatCoords(page.coords)}`);
  if (page.tags.length > 0) lines.push(`Tags: ${page.tags.join(', ')}`);
  lines.push('');
  lines.push(page.body);
  return wrapNote(
    {
      author: pageAuthor(page),
      kind: 'codex',
      scope: page.scope,
      id: page.id,
      title: page.title,
      attrs: { category: page.category, rev: page.rev, updated: page.updated.slice(0, 10) },
    },
    lines.join('\n'),
  );
}

/** `codex_search` results: one enveloped block, one line per hit. */
export function formatSearchForAgent(query: string, hits: readonly CodexSearchHit[]): string {
  if (hits.length === 0) return `No Codex pages match "${singleLine(query, 60)}".`;
  const lines = hits.map(
    (h, i) =>
      `${i + 1}. [${h.id}] ${singleLine(h.title)} (${h.category}, ${h.scope}, by ${h.authorName}): ${h.snippet}`,
  );
  return `${hits.length} Codex result(s) for "${singleLine(query, 60)}". Read one with codex_read{id}.\n${wrapNote(
    { author: { kind: 'system', name: 'MineVibe' }, kind: 'search' },
    lines.join('\n'),
  )}`;
}

/** `codex_list` result. */
export function formatListForAgent(metas: readonly CodexPageMeta[]): string {
  if (metas.length === 0) return 'The Codex has no pages here yet.';
  const lines = metas.map(
    (m) =>
      `- [${m.id}] ${singleLine(m.title)} (${m.category}, ${m.scope}${m.pinned ? ', pinned' : ''}) by ${m.authorName}, rev ${m.rev}`,
  );
  return `${metas.length} Codex page(s):\n${wrapNote(
    { author: { kind: 'system', name: 'MineVibe' }, kind: 'search' },
    lines.join('\n'),
  )}`;
}

/** `codex_write` result. */
export function formatWriteResult(result: CodexWriteResult): string {
  if (result.ok) {
    const verb = result.created ? 'Created' : 'Saved';
    const parts = [`${verb} Codex page [${result.page.id}] rev ${result.page.rev} (${result.page.scope}).`];
    for (const note of result.notes) parts.push(note);
    if (result.budgetLeft !== undefined) parts.push(`${result.budgetLeft} Codex write(s) left today.`);
    return parts.join(' ');
  }
  const head = `Codex write refused (${result.code}): ${result.message}`;
  if (result.current) {
    return `${head}\nCurrent text (rev ${result.current.rev}):\n${formatPageForAgent(result.current)}`;
  }
  return head;
}
