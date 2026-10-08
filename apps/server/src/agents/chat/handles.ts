/**
 * Chat handles (PLAN §6.5 "Handles"): what the player types after `@`.
 *
 * - Every agent has a unique handle matching `[a-z][a-z0-9]{1,11}`, enforced at hire.
 * - No handle may be a prefix of another handle, of a reserved word or of the player's name (checked in
 *   both directions, so `@all` can never be mistaken for an agent called Allie).
 * - `@ceo` is an alias for the current CEO.
 * - Resolution: an exact match wins, otherwise a unique prefix of at least 2 characters.
 */

export const HANDLE_RE = /^[a-z][a-z0-9]{1,11}$/;
export const HANDLE_MAX_LENGTH = 12;
/** Shortest prefix that may resolve to a handle. */
export const MIN_PREFIX_LENGTH = 2;

export const RESERVED_WORDS = ['all', 'ceo', 'everyone', 'meeting'] as const;
export type ReservedWord = (typeof RESERVED_WORDS)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_WORDS);

export function isReservedWord(word: string): word is ReservedWord {
  return RESERVED_SET.has(word);
}

export type AgentStatus = 'alive' | 'dead' | 'dismissed';

/** What handle resolution needs to know about a crew member of the current world (living or not). */
export interface HandleTarget {
  readonly agentId: string;
  readonly handle: string;
  /** Display name ("Ada"). */
  readonly name: string;
  readonly status: AgentStatus;
  /** True for the current CEO (the `@ceo` alias). */
  readonly ceo: boolean;
  /** Game day of death, for "Ada died on Day 4". */
  readonly diedDay?: number | undefined;
}

export function isValidHandleSyntax(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

function prefixRelated(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Folds a display or profile name to `[a-z0-9]` (diacritics stripped), for comparisons and derivation. */
export function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Derives a handle candidate from a display name ("Zoë-Ann" -> "zoeann"). Leading digits are dropped and
 * the result is truncated to 12 characters. Returns null when nothing usable remains. The candidate still
 * has to pass {@link validateHandle}.
 */
export function handleFromName(name: string): string | null {
  const folded = foldName(name)
    .replace(/^[0-9]+/, '')
    .slice(0, HANDLE_MAX_LENGTH);
  return isValidHandleSyntax(folded) ? folded : null;
}

export type HandleProblem =
  | { readonly code: 'syntax'; readonly message: string }
  | { readonly code: 'reserved'; readonly word: ReservedWord; readonly message: string }
  | { readonly code: 'player'; readonly message: string }
  | { readonly code: 'taken'; readonly other: string; readonly message: string }
  | { readonly code: 'prefix'; readonly other: string; readonly message: string };

export interface HandleRules {
  /** Every handle already used in this world, including dead and dismissed agents. */
  readonly taken: Iterable<string>;
  /** The player's profile name. */
  readonly playerName?: string | undefined;
}

/** Checks a new handle at hire time. Returns null when it may be used. */
export function validateHandle(handle: string, rules: HandleRules): HandleProblem | null {
  if (!isValidHandleSyntax(handle)) {
    return {
      code: 'syntax',
      message: `"${handle}" is not a handle: use 2-12 lowercase letters or digits, starting with a letter`,
    };
  }
  for (const word of RESERVED_WORDS) {
    if (prefixRelated(handle, word)) {
      return { code: 'reserved', word, message: `"${handle}" clashes with the reserved word @${word}` };
    }
  }
  const player = rules.playerName ? foldName(rules.playerName) : '';
  if (player.length > 0 && prefixRelated(handle, player)) {
    return { code: 'player', message: `"${handle}" clashes with the player's name` };
  }
  for (const other of rules.taken) {
    if (other === handle) return { code: 'taken', other, message: `@${handle} is already taken` };
    if (prefixRelated(handle, other)) {
      return {
        code: 'prefix',
        other,
        message: `"${handle}" and @${other} would be ambiguous (one is a prefix)`,
      };
    }
  }
  return null;
}

export type HandleResolution =
  | { readonly kind: 'agent'; readonly agent: HandleTarget; readonly via: 'exact' | 'prefix' | 'ceo' }
  | { readonly kind: 'reserved'; readonly word: Exclude<ReservedWord, 'ceo'> }
  | { readonly kind: 'unavailable'; readonly agent: HandleTarget }
  | { readonly kind: 'no_ceo' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'too_short'; readonly candidates: readonly string[] }
  | { readonly kind: 'unknown' };

type Candidate = { readonly word: ReservedWord } | { readonly agent: HandleTarget };

function resolveCeo(roster: readonly HandleTarget[]): HandleResolution {
  const ceo = roster.find((a) => a.ceo && a.status === 'alive');
  return ceo ? { kind: 'agent', agent: ceo, via: 'ceo' } : { kind: 'no_ceo' };
}

function fromCandidate(
  c: Candidate,
  roster: readonly HandleTarget[],
  via: 'exact' | 'prefix',
): HandleResolution {
  if ('word' in c) {
    return c.word === 'ceo' ? resolveCeo(roster) : { kind: 'reserved', word: c.word };
  }
  return c.agent.status === 'alive'
    ? { kind: 'agent', agent: c.agent, via }
    : { kind: 'unavailable', agent: c.agent };
}

function candidateLabel(c: Candidate): string {
  if ('word' in c) return `@${c.word}`;
  return c.agent.status === 'alive' ? c.agent.name : `${c.agent.name} (${c.agent.status})`;
}

/**
 * Resolves the name typed after `@` against the world's roster (living, dead and dismissed agents).
 * Exact matches (handles and reserved words) win; otherwise a unique prefix of at least
 * {@link MIN_PREFIX_LENGTH} characters. Dead or dismissed agents resolve to `unavailable` so they are
 * reported, never silently skipped or broadcast.
 */
export function resolveHandle(typed: string, roster: readonly HandleTarget[]): HandleResolution {
  const name = typed.toLowerCase();
  if (isReservedWord(name)) return fromCandidate({ word: name }, roster, 'exact');
  const exact = roster.find((a) => a.handle === name);
  if (exact) return fromCandidate({ agent: exact }, roster, 'exact');

  const candidates: Candidate[] = [
    ...RESERVED_WORDS.filter((w) => w.startsWith(name)).map((word) => ({ word })),
    ...roster.filter((a) => a.handle.startsWith(name)).map((agent) => ({ agent })),
  ];
  const [first] = candidates;
  if (first === undefined) return { kind: 'unknown' };
  if (name.length < MIN_PREFIX_LENGTH)
    return { kind: 'too_short', candidates: candidates.map(candidateLabel) };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates: candidates.map(candidateLabel) };
  return fromCandidate(first, roster, 'prefix');
}

/** Tab-completion entries for the chat box (`ClientboundCustomChatCompletionsPacket`). */
export function chatCompletions(
  roster: readonly HandleTarget[],
  options: { meetingActive?: boolean } = {},
): string[] {
  const out = roster.filter((a) => a.status === 'alive').map((a) => `@${a.handle}`);
  if (roster.some((a) => a.ceo && a.status === 'alive')) out.push('@ceo');
  out.push('@all', '@everyone');
  if (options.meetingActive) out.push('@meeting');
  return out;
}
