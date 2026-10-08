/**
 * Coordinate detection for lasting Codex pages (PLAN §6.6): coordinates die with the world, so a lasting page that
 * mentions block coordinates is refused. Only clearly-coordinate forms count, so "steps 1, 2, 3" or a version
 * "1.2.3" never trip it:
 * - a parenthesised or bracketed integer triple: `(120, 40, -80)`, `[120 40 -80]`;
 * - labelled axes: `x=120 y=40 z=-80`, `X: 120, Y: 40, Z: -80`;
 * - a keyword followed by a triple: `coords 120 40 -80`, `at 120/40/-80`, `/tp 120 40 -80`.
 */

const INT = '-?\\d{1,8}';
const SEP = '\\s*[,;/ ]\\s*';
const PATTERNS: readonly RegExp[] = [
  new RegExp(`[([{]\\s*${INT}${SEP}${INT}${SEP}${INT}\\s*[)\\]}]`),
  new RegExp(`\\bx\\s*[=:]\\s*${INT}[\\s,;]*y\\s*[=:]\\s*${INT}[\\s,;]*z\\s*[=:]\\s*${INT}`, 'i'),
  new RegExp(
    `(?:\\bco-?ord(?:inate)?s?\\b|\\bxyz\\b|\\bpos(?:ition)?\\b|\\blocated at\\b|\\bat\\b|/tp\\b|\\btp\\b)\\s*[:=]?\\s*${INT}${SEP}${INT}${SEP}${INT}\\b`,
    'i',
  ),
];

/** True when the text names block coordinates. */
export function containsCoordinates(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}
