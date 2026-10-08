/**
 * Search snippets built by MineVibe around the matched terms (PLAN §6.6 "Search"). MiniSearch reports which
 * document terms matched; we find them in the body and cut the window that covers the most distinct terms.
 */

export interface Snippet {
  readonly text: string;
  /** [start, end) ranges of matched terms inside `text`. */
  readonly highlights: Array<readonly [number, number]>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

function findHits(text: string, terms: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  const folded = text.toLowerCase();
  for (const term of new Set(terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0))) {
    // Terms match at a word start (MiniSearch prefix matching), and extend to the end of that word.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}[\\p{L}\\p{N}]*`, 'gu');
    for (const m of folded.matchAll(re)) {
      hits.push({ start: m.index, end: m.index + m[0].length, term });
      if (hits.length > 500) break;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * A one-line snippet of at most `maxLength` characters around the densest cluster of matched terms. Falls back
 * to the start of the text when nothing matches (e.g. a title-only match).
 */
export function buildSnippet(text: string, terms: readonly string[], maxLength = 180): Snippet {
  const hits = findHits(text, terms);
  let start = 0;
  if (hits.length > 0) {
    let bestStart = hits[0]?.start ?? 0;
    let bestScore = -1;
    for (let i = 0; i < hits.length; i++) {
      const from = hits[i]?.start ?? 0;
      const seen = new Set<string>();
      let count = 0;
      for (let j = i; j < hits.length; j++) {
        const h = hits[j];
        if (!h || h.end - from > maxLength) break;
        seen.add(h.term);
        count++;
      }
      const score = seen.size * 100 + count;
      if (score > bestScore) {
        bestScore = score;
        bestStart = from;
      }
    }
    // Centre a little: show some context before the first hit, at a word boundary.
    start = Math.max(0, bestStart - Math.floor(maxLength / 4));
    if (start > 0) {
      const space = text.lastIndexOf(' ', bestStart);
      start = space >= start ? space + 1 : start;
      const sentence = Math.max(text.lastIndexOf('. ', bestStart), text.lastIndexOf('\n', bestStart));
      if (sentence >= start - 1 && sentence < bestStart) start = sentence + 1;
    }
  }
  let end = Math.min(text.length, start + maxLength);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start + maxLength / 2) end = space;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  // Collapse whitespace while tracking offsets so highlights stay correct.
  let out = prefix;
  const map: number[] = []; // map[i] = output index for source index start+i
  let lastSpace = prefix.length > 0;
  for (let i = start; i < end; i++) {
    const ch = text[i] ?? '';
    map[i - start] = out.length;
    if (/\s/.test(ch)) {
      if (!lastSpace) out += ' ';
      lastSpace = true;
    } else {
      out += ch;
      lastSpace = false;
    }
  }
  out = out.trimEnd() + suffix;
  const highlights: Array<readonly [number, number]> = [];
  for (const h of hits) {
    if (h.start < start || h.end > end) continue;
    const s = map[h.start - start];
    const e = (map[h.end - 1 - start] ?? -1) + 1;
    if (s !== undefined && e > s) highlights.push([s, e]);
  }
  return { text: out.trim().length === 0 ? '' : out, highlights };
}
