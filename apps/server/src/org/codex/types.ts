import type { AuthorKind } from '../envelope.js';

/** Page categories (PLAN §6.6). `rules` is player-only. */
export const CODEX_CATEGORIES = [
  'places',
  'howto',
  'projects',
  'decisions',
  'people',
  'log',
  'minutes',
  'rules',
] as const;
export type CodexCategory = (typeof CODEX_CATEGORIES)[number];

export const CODEX_SCOPES = ['lasting', 'world'] as const;
/** `lasting` pages survive world death; `world` pages are archived with their world. */
export type CodexScope = (typeof CODEX_SCOPES)[number];

export type CodexWriteMode = 'create' | 'update' | 'append';

/** Largest page body, in UTF-8 bytes. */
export const CODEX_MAX_BODY_BYTES = 8 * 1024;
/** Codex writes per agent per game day. */
export const CODEX_WRITE_BUDGET = 6;
/** Results returned by `codex_search`. */
export const CODEX_SEARCH_LIMIT = 8;
export const CODEX_MAX_TAGS = 8;

/** Who is reading or writing. Node stamps this; it never comes from page text. */
export interface CodexActor {
  readonly kind: AuthorKind;
  /** Agent id, `player` or `system`. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
}

/** A block position plus dimension, stamped by Node from the agent's real position. */
export interface Coords {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dim: string;
}

export interface CodexPageMeta {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly category: CodexCategory;
  readonly scope: CodexScope;
  /** World id for world-scope pages. */
  readonly world?: string | undefined;
  /** Author id (agent id, `player` or `system`). */
  readonly author: string;
  readonly authorName: string;
  readonly authorKind: AuthorKind;
  /** ISO instants. */
  readonly created: string;
  readonly updated: string;
  /** Game day of creation, when a world clock was known. */
  readonly createdDay?: number | undefined;
  readonly links: readonly string[];
  /** Increments on every write; `update` needs the current value as `base_rev`. */
  readonly rev: number;
  readonly pinned: boolean;
  readonly coords?: Coords | undefined;
  /** Other writers (appends, updates), in order of first contribution. */
  readonly contributors: readonly string[];
  /** A weekly log roll-up page. */
  readonly rollup?: boolean | undefined;
}

export interface CodexPage extends CodexPageMeta {
  readonly body: string;
}

/** `mc__codex_write` input (also used by CodexScreen's `codex.put`). */
export interface CodexWriteInput {
  readonly title?: string | undefined;
  readonly body: string;
  readonly tags?: readonly string[] | undefined;
  readonly category?: CodexCategory | undefined;
  readonly scope?: CodexScope | undefined;
  readonly id?: string | undefined;
  readonly base_rev?: number | undefined;
  readonly mode: CodexWriteMode;
  /** Stamp the writer's real position (places). */
  readonly here?: boolean | undefined;
  /** With `here`: the position to stamp, when the caller already knows it (else the store asks for it). */
  readonly position?: Coords | undefined;
}

export type CodexErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SIMILAR_EXISTS'
  | 'REV_REQUIRED'
  | 'REV_CONFLICT'
  | 'TOO_LARGE'
  | 'PAGE_FULL'
  | 'BUDGET_EXCEEDED'
  | 'SECRET'
  | 'COORDS_IN_LASTING'
  | 'LOCKED'
  | 'NO_WORLD'
  | 'NO_POSITION';

export type CodexWriteResult =
  | {
      readonly ok: true;
      readonly page: CodexPage;
      readonly created: boolean;
      /** What Node changed or noticed ("forced to world scope", "similar page x exists"). */
      readonly notes: readonly string[];
      /** Writes left today for an agent (undefined for the player and system). */
      readonly budgetLeft?: number | undefined;
    }
  | {
      readonly ok: false;
      readonly code: CodexErrorCode;
      readonly message: string;
      readonly similarId?: string | undefined;
      /** The current page on a rev conflict. */
      readonly current?: CodexPage | undefined;
    };

export interface CodexSearchHit {
  readonly id: string;
  readonly title: string;
  readonly category: CodexCategory;
  readonly scope: CodexScope;
  readonly tags: readonly string[];
  readonly score: number;
  readonly snippet: string;
  /** [start, end) ranges of matched terms inside `snippet`. */
  readonly highlights: ReadonlyArray<readonly [number, number]>;
  readonly authorName: string;
  readonly authorKind: AuthorKind;
}

export interface CodexHistoryEntry {
  readonly commit: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly at: string;
  readonly message: string;
}

export type CodexChange =
  | { readonly type: 'write'; readonly id: string; readonly created: boolean }
  | { readonly type: 'delete'; readonly id: string }
  | { readonly type: 'pin'; readonly id: string; readonly pinned: boolean }
  | { readonly type: 'world'; readonly worldId: string | null }
  | { readonly type: 'archive'; readonly worldId: string }
  | { readonly type: 'rollup'; readonly ids: readonly string[] };

export function isCodexCategory(value: unknown): value is CodexCategory {
  return typeof value === 'string' && (CODEX_CATEGORIES as readonly string[]).includes(value);
}

export function isCodexScope(value: unknown): value is CodexScope {
  return value === 'lasting' || value === 'world';
}

/** Default scope when a writer gives none: world facts stay with the world. */
export function defaultScopeFor(category: CodexCategory): CodexScope {
  return category === 'places' || category === 'log' || category === 'minutes' ? 'world' : 'lasting';
}
