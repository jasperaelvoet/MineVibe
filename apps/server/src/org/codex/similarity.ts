/**
 * Title similarity for the Codex create check (PLAN §6.6): "similar page <id> exists, use update/append".
 *
 * Titles are folded (lowercase, no diacritics, punctuation and stop words dropped, a plural `s` trimmed), then
 * compared three ways; the highest score counts:
 * - identical folded titles: 1;
 * - token Jaccard;
 * - containment: every token of the shorter title (≥ 2 tokens) appears in the longer one: 0.9;
 * - Dice coefficient over character bigrams of the joined tokens (catches "Ironcave" vs "Iron cave").
 * "Iron cave" ~ "Iron Cave at spawn" (0.9) but "Iron farm" !~ "Iron cave" (0.43), and a one-word title such as
 * "Iron" never blocks "Iron farm design".
 */

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'at',
  'in',
  'on',
  'to',
  'for',
  'and',
  'or',
  'it',
  'is',
  'with',
  'near',
  'by',
  'my',
  'our',
]);

/** Threshold at or above which two titles count as similar. */
export const SIMILARITY_THRESHOLD = 0.75;

export function titleTokens(title: string): string[] {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

/** Similarity of two titles in [0, 1]. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const ja = ta.join(' ');
  const jb = tb.join(' ');
  if (ja === jb) return 1;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const jaccard = inter / (sa.size + sb.size - inter);
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let contained = small.size >= 2;
  for (const t of small) if (!large.has(t)) contained = false;
  const d = dice(ta.join(''), tb.join(''));
  return Math.max(jaccard, contained ? 0.9 : 0, d);
}

/** The most similar title at or above the threshold, if any. */
export function findSimilar<T extends { id: string; title: string }>(
  title: string,
  candidates: Iterable<T>,
  threshold = SIMILARITY_THRESHOLD,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of candidates) {
    const score = titleSimilarity(title, item.title);
    if (score >= threshold && (!best || score > best.score)) best = { item, score };
  }
  return best;
}
