/**
 * The Codex digest (PLAN §6.6 "Context"): delivered as a `shouldQuery:false` context message at session start and
 * once per real day, never in the system prompt. It lists house rules, pinned pages, and the top pages per
 * category by reads and recency, in about 800 tokens (~3200 characters). Everything except player-written rules
 * arrives inside a data envelope.
 */

import { type ControlNonce, singleLine, wrapHouseRules, wrapNote } from '../envelope.js';
import { formatCoords, pageAuthor } from './format.js';
import type { CodexCategory, CodexPage } from './types.js';

export interface DigestStats {
  readonly reads: Readonly<Record<string, number>>;
}

export interface DigestOptions {
  readonly nonce: ControlNonce;
  /** The player's name for "check the Codex before asking Jasper". */
  readonly playerName: string;
  readonly now: number;
  /** Character budget (~4 characters per token). */
  readonly maxChars?: number;
  /** Pages per category. */
  readonly perCategory?: number;
}

const CATEGORY_ORDER: ReadonlyArray<{ category: CodexCategory; label: string }> = [
  { category: 'projects', label: 'Projects' },
  { category: 'decisions', label: 'Decisions' },
  { category: 'howto', label: 'How-tos' },
  { category: 'places', label: 'Places' },
  { category: 'people', label: 'People' },
  { category: 'minutes', label: 'Minutes' },
  { category: 'log', label: 'Log' },
];

const DAY_MS = 86_400_000;
const RULE_PAGE_MAX_CHARS = 700;

/** Reads plus a recency bonus; ties broken by the most recent update. */
export function digestScore(page: CodexPage, stats: DigestStats, now: number): number {
  const reads = stats.reads[page.id] ?? 0;
  const age = now - Date.parse(page.updated);
  const recency = age < DAY_MS ? 5 : age < 7 * DAY_MS ? 2 : 0;
  return reads + recency + (Number.isFinite(age) ? 1 / (1 + Math.max(0, age) / DAY_MS) : 0);
}

function pageLine(page: CodexPage): string {
  const where = page.coords ? ` ${formatCoords(page.coords)}` : '';
  return `- [${page.id}] ${singleLine(page.title)}${where} (${page.scope}) by ${page.authorName}`;
}

/** Builds the digest text. Returns a short notice when the Codex is empty. */
export function buildCodexDigest(
  pages: readonly CodexPage[],
  stats: DigestStats,
  options: DigestOptions,
): string {
  const maxChars = options.maxChars ?? 3200;
  const perCategory = options.perCategory ?? 4;
  const lasting = pages.filter((p) => p.scope === 'lasting').length;
  const head = options.nonce.line(
    'CODEX',
    `Codex digest: ${pages.length} page(s) (${lasting} lasting, ${pages.length - lasting} in this world). ` +
      `Use codex_search and codex_read; check the Codex before asking ${options.playerName}.`,
  );
  if (pages.length === 0) return head;

  const parts: string[] = [head];
  let used = head.length;

  const rules = pages
    .filter((p) => p.category === 'rules' && p.authorKind === 'player')
    .sort((a, b) => a.created.localeCompare(b.created));
  if (rules.length > 0) {
    parts.push(options.nonce.line('HOUSE RULES', `House rules from ${options.playerName} (binding):`));
    for (const page of rules) {
      const body =
        page.body.length > RULE_PAGE_MAX_CHARS
          ? `${page.body.slice(0, RULE_PAGE_MAX_CHARS)}… (codex_read ${page.id} for the rest)`
          : page.body;
      const block = wrapHouseRules({ author: pageAuthor(page), id: page.id, title: page.title }, body);
      parts.push(block);
      used += block.length;
    }
  }

  const listed = new Set<string>();
  const sections: Array<{ label: string; lines: string[] }> = [];
  const pinned = pages
    .filter((p) => p.pinned && p.category !== 'rules')
    .sort((a, b) => digestScore(b, stats, options.now) - digestScore(a, stats, options.now));
  if (pinned.length > 0) {
    sections.push({ label: 'Pinned', lines: pinned.map(pageLine) });
    for (const p of pinned) listed.add(p.id);
  }
  for (const { category, label } of CATEGORY_ORDER) {
    const top = pages
      .filter((p) => p.category === category && !listed.has(p.id))
      .sort((a, b) => digestScore(b, stats, options.now) - digestScore(a, stats, options.now))
      .slice(0, perCategory);
    if (top.length === 0) continue;
    sections.push({ label, lines: top.map(pageLine) });
  }

  // Fit the sections into the remaining budget, dropping the lowest-ranked lines of the longest sections first.
  const envelopeOverhead = 120;
  const budget = Math.max(200, maxChars - used - envelopeOverhead);
  const render = () => sections.map((s) => `${s.label}:\n${s.lines.join('\n')}`).join('\n');
  let text = render();
  while (text.length > budget) {
    const longest = sections.reduce((a, b) => (b.lines.length > a.lines.length ? b : a));
    if (longest.lines.length <= 1) {
      const idx = sections.lastIndexOf(longest);
      sections.splice(idx, 1);
    } else {
      longest.lines.pop();
    }
    if (sections.length === 0) break;
    text = render();
  }
  if (text.length > 0) {
    parts.push(wrapNote({ author: { kind: 'system', name: 'MineVibe' }, kind: 'digest' }, text));
  }
  return parts.join('\n');
}
