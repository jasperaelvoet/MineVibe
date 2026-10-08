/**
 * CodexStore (PLAN §6.6 "Codex"): the crew's shared, markdown-backed knowledge base.
 *
 * Storage
 * - `<root>/lasting/<id>.md` and `<root>/world-<n>/<id>.md`: frontmatter + markdown body, at most 8 KB of body.
 * - The root is a git repo; every write is a commit authored by the writer (isolated git config, see git.ts).
 * - `<root>/.mv/state.json` (gitignored) keeps read counts and the per-day write budget.
 * - On world death, `world-<n>/` moves to `archive/world-<n>/`; lasting pages carry over.
 * - A read-only export (lasting pages plus the current world, no `.git`) is kept in sync for PCs (`/mnt/codex`);
 *   files are rewritten atomically inside a stable directory so a bind mount keeps working.
 *
 * Writes go through a single-writer queue. `update` needs `base_rev` and returns the current text on a mismatch;
 * `append` needs no merge and refuses with PAGE_FULL when the page would exceed 8 KB.
 *
 * Quality controls: title-similarity check on create, 6 writes per agent per game day, `places` pages forced to
 * world scope with Node-stamped coordinates (`here:true`), coordinates refused in lasting pages, a secret scan,
 * `rules` pages player-only, a soft lock while CodexScreen edits, weekly log roll-up.
 *
 * Search: MiniSearch over title, tags and body (rebuilt at startup), with snippets built around matched terms.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import MiniSearch from 'minisearch';
import type { Logger } from 'pino';
import { writeFileAtomic } from '../../util/atomicFile.js';
import { TypedEmitter } from '../../util/TypedEmitter.js';
import { type OrgClock, systemClock } from '../clock.js';
import { authorLabel, type ControlNonce, sanitizeTitle, singleLine } from '../envelope.js';
import { containsCoordinates } from './coordinates.js';
import { buildCodexDigest } from './digest.js';
import { formatCoords } from './format.js';
import { isValidPageId, normalizeTags, parsePage, serializePage, slugify } from './frontmatter.js';
import { CodexGit, identityFor } from './git.js';
import { encodeRev } from './rev.js';
import { scanForSecrets } from './secretScan.js';
import { findSimilar } from './similarity.js';
import { buildSnippet } from './snippet.js';
import {
  CODEX_MAX_BODY_BYTES,
  CODEX_MAX_TAGS,
  CODEX_SEARCH_LIMIT,
  CODEX_WRITE_BUDGET,
  type CodexActor,
  type CodexCategory,
  type CodexChange,
  type CodexHistoryEntry,
  type CodexPage,
  type CodexPageMeta,
  type CodexScope,
  type CodexSearchHit,
  type CodexWriteInput,
  type CodexWriteResult,
  type Coords,
  defaultScopeFor,
  isCodexCategory,
  isCodexScope,
} from './types.js';

export interface CodexStoreOptions {
  /** The Codex git repo (`App Support/MineVibe/codex`). */
  readonly root: string;
  /** The read-only export for PCs (`App Support/MineVibe/codex-export`); null disables it. */
  readonly exportDir?: string | null | undefined;
  /** Absolute git binary; null disables history (default `/usr/bin/git` when present). */
  readonly gitBinary?: string | null | undefined;
  readonly clock?: OrgClock | undefined;
  /** The current game day, for write budgets and log roll-ups (null before the world clock is known). */
  readonly gameDay?: (() => number | null) | undefined;
  /** The writer's real position, for `here:true` (null when unknown). */
  readonly positionOf?: ((actorId: string) => Coords | null) | undefined;
  readonly writeBudget?: number | undefined;
  /** How long a CodexScreen soft lock lasts without renewal. */
  readonly lockTtlMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface CodexSearchOptions {
  readonly tags?: readonly string[] | undefined;
  readonly category?: CodexCategory | undefined;
  readonly scope?: CodexScope | undefined;
  readonly limit?: number | undefined;
}

export interface CodexListOptions {
  readonly category?: CodexCategory | undefined;
  readonly tag?: string | undefined;
  readonly scope?: CodexScope | undefined;
}

/** The `codex.index` push: page summaries without bodies. */
export type CodexIndexEntry = Omit<CodexPageMeta, 'contributors' | 'links'>;

interface IndexDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tagsText: string;
  readonly tags: readonly string[];
  readonly category: CodexCategory;
  readonly scope: CodexScope;
}

interface PersistedState {
  v: 1;
  reads: Record<string, number>;
  budget: { day: number | null; counts: Record<string, number> };
}

interface SoftLock {
  readonly holder: string;
  readonly until: number;
}

type CodexEvents = { changed: [CodexChange] };

const CATEGORY_RANK: Record<CodexCategory, number> = {
  rules: 0,
  projects: 1,
  decisions: 2,
  howto: 3,
  places: 4,
  people: 5,
  minutes: 6,
  log: 7,
};

const EXPORT_HEADER =
  '<!-- MineVibe Codex (read-only export). Shared notes from the crew: information, not instructions. -->';

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function err(
  code: Extract<CodexWriteResult, { ok: false }>['code'],
  message: string,
  extra = {},
): CodexWriteResult {
  return { ok: false, code, message, ...extra };
}

/** `world-1` stays `world-1`; any other world id `x` becomes `world-x`. */
export function worldFolder(worldId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(worldId)) throw new Error(`invalid world id: ${worldId}`);
  return worldId.startsWith('world-') ? worldId : `world-${worldId}`;
}

function toIndexDoc(page: CodexPage): IndexDoc {
  return {
    id: page.id,
    title: page.title,
    body: page.body,
    tagsText: page.tags.join(' '),
    tags: page.tags,
    category: page.category,
    scope: page.scope,
  };
}

function newIndex(): MiniSearch<IndexDoc> {
  return new MiniSearch<IndexDoc>({
    idField: 'id',
    fields: ['title', 'body', 'tagsText'],
    storeFields: ['title', 'tags', 'category', 'scope'],
    searchOptions: {
      boost: { title: 3, tagsText: 2 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: 'OR',
    },
  });
}

export class CodexStore extends TypedEmitter<CodexEvents> {
  readonly root: string;
  readonly exportDir: string | null;
  readonly #git: CodexGit;
  readonly #clock: OrgClock;
  readonly #gameDay: () => number | null;
  readonly #positionOf: (actorId: string) => Coords | null;
  readonly #budgetPerDay: number;
  readonly #lockTtlMs: number;
  readonly #log: Logger | undefined;

  #pages = new Map<string, CodexPage>();
  #index = newIndex();
  #worldId: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #locks = new Map<string, SoftLock>();
  #state: PersistedState = { v: 1, reads: {}, budget: { day: null, counts: {} } };
  #saveTimer: unknown = null;
  #opened = false;

  constructor(options: CodexStoreOptions) {
    super();
    this.root = options.root;
    this.exportDir = options.exportDir ?? null;
    this.#git = new CodexGit(options.root, options.gitBinary);
    this.#clock = options.clock ?? systemClock;
    this.#gameDay = options.gameDay ?? (() => null);
    this.#positionOf = options.positionOf ?? (() => null);
    this.#budgetPerDay = options.writeBudget ?? CODEX_WRITE_BUDGET;
    this.#lockTtlMs = options.lockTtlMs ?? 5 * 60_000;
    this.#log = options.logger;
  }

  protected override onListenerError(event: string, error: unknown): void {
    this.#log?.warn({ err: error, event }, 'codex listener failed');
  }

  get worldId(): string | null {
    return this.#worldId;
  }

  get gitEnabled(): boolean {
    return this.#git.enabled;
  }

  /** Creates the repo if needed, loads lasting pages and the given world's pages, and rebuilds index and export. */
  open(worldId: string | null): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(join(this.root, 'lasting'), { recursive: true });
      const gitignore = join(this.root, '.gitignore');
      if (!existsSync(gitignore)) await writeFile(gitignore, '.mv/\n', 'utf8');
      const fresh = this.#git.enabled && !existsSync(join(this.root, '.git'));
      await this.#git.init();
      if (fresh)
        await this.#git.commit(
          ['.gitignore'],
          'codex: init',
          identityFor({ kind: 'system', id: 'system', name: 'MineVibe' }),
        );
      await this.#loadState();
      if (worldId !== null) worldFolder(worldId); // validates
      this.#worldId = worldId;
      await this.#loadPages();
      await this.#rebuildExport();
      this.#opened = true;
    });
  }

  /** Switches to another world (after `world.open` of a new world). */
  setWorld(worldId: string | null): Promise<void> {
    return this.#enqueue(async () => {
      if (worldId !== null) worldFolder(worldId);
      this.#worldId = worldId;
      await this.#loadPages();
      await this.#rebuildExport();
      this.emit('changed', { type: 'world', worldId });
    });
  }

  /**
   * World death: moves `world-<n>/` to `archive/world-<n>/` in one commit. Lasting pages persist. If it was the
   * current world, the store has no world until {@link setWorld}.
   */
  archiveWorld(worldId: string): Promise<number> {
    return this.#enqueue(async () => {
      const folder = worldFolder(worldId);
      const src = join(this.root, folder);
      let moved = 0;
      if (existsSync(src)) {
        moved = (await readdir(src)).filter((f) => f.endsWith('.md')).length;
        await mkdir(join(this.root, 'archive'), { recursive: true });
        let dest = join(this.root, 'archive', folder);
        for (let n = 2; existsSync(dest); n++) dest = join(this.root, 'archive', `${folder}-${n}`);
        await rename(src, dest);
        // Stage everything: the old folder may hold files git never saw (written while git was unavailable).
        await this.#commit(['.'], `archive ${folder} (world ended)`, {
          kind: 'system',
          id: 'system',
          name: 'MineVibe',
        });
      }
      if (this.#worldId === worldId) {
        this.#worldId = null;
        await this.#loadPages();
        await this.#rebuildExport();
      }
      this.emit('changed', { type: 'archive', worldId });
      return moved;
    });
  }

  /** Waits for every queued write. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.#saveTimer !== null) {
      this.#clock.clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#saveState();
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** A live page (lasting or current world). Counts a read for digests unless `count` is false. */
  get(id: string, options: { count?: boolean } = {}): CodexPage | null {
    const page = this.#pages.get(id) ?? null;
    if (page && options.count !== false) {
      this.#state.reads[id] = (this.#state.reads[id] ?? 0) + 1;
      this.#scheduleSave();
    }
    return page;
  }

  /** Page summaries, rules first, then by category, pinned first, most recently updated first. */
  list(options: CodexListOptions = {}): CodexPageMeta[] {
    const tag = options.tag ? normalizeTags([options.tag], 1)[0] : undefined;
    return [...this.#pages.values()]
      .filter((p) => !options.category || p.category === options.category)
      .filter((p) => !options.scope || p.scope === options.scope)
      .filter((p) => !tag || p.tags.includes(tag))
      .sort(
        (a, b) =>
          CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
          Number(b.pinned) - Number(a.pinned) ||
          b.updated.localeCompare(a.updated),
      )
      .map(({ body: _body, ...meta }) => meta);
  }

  /** The `codex.index` push. */
  index(): CodexIndexEntry[] {
    return this.list().map(({ contributors: _c, links: _l, ...rest }) => rest);
  }

  /** Every live page, bodies included. */
  pages(): CodexPage[] {
    return [...this.#pages.values()];
  }

  /** Full-text search with MineVibe-built snippets; top 8 by default. */
  search(query: string, options: CodexSearchOptions = {}): CodexSearchHit[] {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    const tags = normalizeTags(options.tags, CODEX_MAX_TAGS);
    const limit = Math.max(1, Math.min(options.limit ?? CODEX_SEARCH_LIMIT, 50));
    const results = this.#index.search(q, {
      filter: (r) => {
        if (options.category && r.category !== options.category) return false;
        if (options.scope && r.scope !== options.scope) return false;
        if (tags.length > 0) {
          const docTags = (r.tags as string[] | undefined) ?? [];
          if (!tags.every((t) => docTags.includes(t))) return false;
        }
        return true;
      },
    });
    const hits: CodexSearchHit[] = [];
    for (const r of results) {
      const page = this.#pages.get(String(r.id));
      if (!page) continue;
      const snippet = buildSnippet(page.body, r.terms);
      hits.push({
        id: page.id,
        title: page.title,
        category: page.category,
        scope: page.scope,
        tags: page.tags,
        score: r.score,
        snippet: snippet.text,
        highlights: snippet.highlights,
        authorName: page.authorName,
        authorKind: page.authorKind,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Commit history of a page, newest first. */
  async history(id: string, limit = 20): Promise<CodexHistoryEntry[]> {
    const page = this.#pages.get(id);
    if (!page) return [];
    await this.flush();
    return this.#git.log(this.#relPath(page), limit);
  }

  /** The Codex digest context message (~800 tokens). */
  digest(nonce: ControlNonce, playerName: string, maxChars?: number): string {
    return buildCodexDigest(
      this.pages(),
      { reads: this.#state.reads },
      {
        nonce,
        playerName,
        now: this.#clock.now(),
        maxChars,
      },
    );
  }

  /** Writes left today for an agent. */
  budgetLeft(agentId: string): number {
    this.#rollBudgetDay();
    return Math.max(0, this.#budgetPerDay - (this.#state.budget.counts[agentId] ?? 0));
  }

  // -------------------------------------------------------------------------------------------
  // Soft locks (CodexScreen)
  // -------------------------------------------------------------------------------------------

  /** Takes or renews a soft lock. False when someone else holds it. */
  lock(id: string, holder: string): boolean {
    const now = this.#clock.now();
    const current = this.#locks.get(id);
    if (current && current.holder !== holder && current.until > now) return false;
    this.#locks.set(id, { holder, until: now + this.#lockTtlMs });
    return true;
  }

  unlock(id: string, holder: string): void {
    if (this.#locks.get(id)?.holder === holder) this.#locks.delete(id);
  }

  lockHolder(id: string): string | null {
    const lock = this.#locks.get(id);
    if (!lock) return null;
    if (lock.until <= this.#clock.now()) {
      this.#locks.delete(id);
      return null;
    }
    return lock.holder;
  }

  // -------------------------------------------------------------------------------------------
  // Writes (single-writer queue)
  // -------------------------------------------------------------------------------------------

  /** `codex_write` / `codex.put`. */
  write(actor: CodexActor, input: CodexWriteInput): Promise<CodexWriteResult> {
    return this.#enqueue(() => this.#write(actor, input));
  }

  /** Deletes a page (player only). */
  delete(actor: CodexActor, id: string): Promise<CodexWriteResult | { ok: true; id: string }> {
    return this.#enqueue(async () => {
      if (actor.kind !== 'player') return err('FORBIDDEN', 'only the player deletes Codex pages');
      const page = this.#pages.get(id);
      if (!page) return err('NOT_FOUND', `no Codex page "${id}"`);
      await rm(this.#absPath(page), { force: true });
      await this.#commit([this.#relPath(page)], `delete ${page.id}: ${page.title}`, actor);
      this.#pages.delete(id);
      if (this.#index.has(id)) this.#index.discard(id);
      delete this.#state.reads[id];
      this.#locks.delete(id);
      await this.#exportRemove(page);
      this.emit('changed', { type: 'delete', id });
      return { ok: true as const, id };
    });
  }

  /** Pins or unpins a page (player only). Pinning is not a content change, so `rev` stays. */
  setPinned(actor: CodexActor, id: string, pinned: boolean): Promise<CodexWriteResult> {
    return this.#enqueue(async () => {
      if (actor.kind !== 'player') return err('FORBIDDEN', 'only the player pins Codex pages');
      const page = this.#pages.get(id);
      if (!page) return err('NOT_FOUND', `no Codex page "${id}"`);
      const next: CodexPage = { ...page, pinned };
      await this.#persist(next, `${pinned ? 'pin' : 'unpin'} ${id}`, actor);
      this.emit('changed', { type: 'pin', id, pinned });
      return { ok: true, page: next, created: false, notes: [] };
    });
  }

  /**
   * Weekly log roll-up: `log` pages of this world from completed game weeks (Days 1-7, 8-14, …) are merged into
   * one "Log, Days a–b" page per week (split into parts at the 8 KB cap) and the originals removed.
   */
  rollUpLogs(): Promise<string[]> {
    return this.#enqueue(async () => {
      const day = this.#gameDay();
      if (day === null || this.#worldId === null) return [];
      const currentWeek = Math.floor((day - 1) / 7);
      const groups = new Map<number, CodexPage[]>();
      for (const page of this.#pages.values()) {
        if (page.category !== 'log' || page.scope !== 'world' || page.rollup) continue;
        if (page.createdDay === undefined) continue;
        // A page that would not fit a roll-up part with its header stays as it is (rolling it up would truncate it,
        // and the original is deleted). So does a page someone is editing in CodexScreen.
        if (byteLength(rollupSection(page)) > CODEX_MAX_BODY_BYTES) continue;
        if (this.lockHolder(page.id) !== null) continue;
        const week = Math.floor((page.createdDay - 1) / 7);
        if (week >= currentWeek) continue;
        const group = groups.get(week) ?? [];
        group.push(page);
        groups.set(week, group);
      }
      const created: string[] = [];
      const system: CodexActor = { kind: 'system', id: 'system', name: 'MineVibe' };
      for (const [week, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        group.sort((a, b) => (a.createdDay ?? 0) - (b.createdDay ?? 0) || a.created.localeCompare(b.created));
        const first = week * 7 + 1;
        const title = `Log, Days ${first}–${first + 6}`;
        const sections = group.map(rollupSection);
        const chunks: string[] = [];
        let current = '';
        for (const piece of sections) {
          const joined = current ? `${current}\n\n${piece}` : piece;
          if (byteLength(joined) > CODEX_MAX_BODY_BYTES && current) {
            chunks.push(current);
            current = piece;
          } else {
            current = joined;
          }
        }
        if (current) chunks.push(current);
        const now = new Date(this.#clock.now()).toISOString();
        const touched: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const partTitle = chunks.length > 1 ? `${title} (part ${i + 1})` : title;
          const id = this.#uniqueId(partTitle);
          const page: CodexPage = {
            id,
            title: partTitle,
            tags: ['log', 'rollup'],
            category: 'log',
            scope: 'world',
            world: this.#worldId,
            author: 'system',
            authorName: 'MineVibe',
            authorKind: 'system',
            created: now,
            updated: now,
            createdDay: first,
            links: group.map((p) => p.id),
            rev: 1,
            pinned: false,
            contributors: [...new Set(group.map((p) => p.author))],
            rollup: true,
            body: chunks[i] ?? '',
          };
          await this.#writePageFile(page);
          this.#pages.set(id, page);
          this.#indexPage(page);
          await this.#exportPage(page);
          touched.push(this.#relPath(page));
          created.push(id);
        }
        for (const p of group) {
          await rm(this.#absPath(p), { force: true });
          touched.push(this.#relPath(p));
          this.#pages.delete(p.id);
          if (this.#index.has(p.id)) this.#index.discard(p.id);
          await this.#exportRemove(p);
        }
        await this.#commit(touched, `roll up ${title}`, system);
      }
      if (created.length > 0) this.emit('changed', { type: 'rollup', ids: created });
      return created;
    });
  }

  /** Rewrites the whole export (startup, world switch). */
  rebuildExport(): Promise<void> {
    return this.#enqueue(() => this.#rebuildExport());
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch((e: unknown) => this.#log?.error({ err: e }, 'codex queue task failed'));
    return run;
  }

  #rollBudgetDay(): void {
    const day = this.#gameDay();
    // An unknown day (app start, world switch, before the first world.state) keeps today's counts: rolling over to
    // `null` and back would hand every agent a fresh budget.
    if (day !== null && this.#state.budget.day !== day) this.#state.budget = { day, counts: {} };
  }

  async #write(actor: CodexActor, input: CodexWriteInput): Promise<CodexWriteResult> {
    if (!this.#opened) return err('INVALID', 'the Codex is not open yet');
    const mode = input.mode;
    if (mode !== 'create' && mode !== 'update' && mode !== 'append') {
      return err('INVALID', 'mode must be create, update or append');
    }
    if (typeof input.body !== 'string') return err('INVALID', 'body must be text');
    // Leading blank lines are dropped too, so a page reads back exactly as written (the file format puts the body
    // right after the frontmatter, and the parser tolerates one blank line there).
    const body = input.body
      .replace(/\r\n?/g, '\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\s+$/, '');
    if (input.category !== undefined && !isCodexCategory(input.category)) {
      return err('INVALID', 'unknown category');
    }
    if (input.scope !== undefined && !isCodexScope(input.scope))
      return err('INVALID', 'scope must be lasting or world');
    const isAgent = actor.kind === 'agent';
    const notes: string[] = [];

    // Budget (agents only), checked before any work.
    if (isAgent) {
      this.#rollBudgetDay();
      if ((this.#state.budget.counts[actor.id] ?? 0) >= this.#budgetPerDay) {
        return err(
          'BUDGET_EXCEEDED',
          `you have used your ${this.#budgetPerDay} Codex writes for today; batch notes into one page tomorrow`,
        );
      }
    }

    const existing = mode === 'create' ? null : (this.#pages.get(input.id ?? '') ?? null);
    if (mode !== 'create') {
      if (!input.id || !existing)
        return err('NOT_FOUND', `no Codex page "${singleLine(input.id ?? '', 64)}"`);
      const holder = this.lockHolder(existing.id);
      if (holder !== null && holder !== actor.id) {
        return err(
          'LOCKED',
          `${holder === 'player' ? 'the player' : holder} is editing this page right now; try again later`,
        );
      }
      if (existing.category === 'rules' && actor.kind !== 'player') {
        return err('FORBIDDEN', 'rules pages are written by the player only');
      }
    }

    const category: CodexCategory = input.category ?? existing?.category ?? 'howto';
    if (category === 'rules' && actor.kind !== 'player') {
      return err('FORBIDDEN', 'rules pages are written by the player only');
    }

    // Scope: places (and anything stamped with a position) belong to the world.
    let scope: CodexScope = existing?.scope ?? input.scope ?? defaultScopeFor(category);
    if (existing && input.scope && input.scope !== existing.scope) {
      notes.push(`scope stays ${existing.scope} (create a new page to change scope)`);
    }
    let coords: Coords | undefined = existing?.coords;
    if (input.here) {
      const pos = input.position ?? this.#positionOf(actor.id);
      if (!pos) return err('NO_POSITION', 'MineVibe could not read your position; try again in a moment');
      coords = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dim: pos.dim };
      notes.push(`stamped your position ${formatCoords(coords)}`);
    }
    if ((category === 'places' || coords) && scope === 'lasting') {
      if (existing)
        return err('INVALID', 'places pages belong to the world; this page is lasting, so create a new page');
      scope = 'world';
      notes.push('forced to world scope (places and positions die with the world)');
    }
    if (scope === 'world' && this.#worldId === null)
      return err('NO_WORLD', 'no world is open; world pages need one');

    // Title and tags.
    // Titles are shown outside envelopes too (refusals, lists, CodexScreen), so `[MV:` look-alikes and envelope
    // delimiters are escaped on the way in, like calendar titles.
    const title = sanitizeTitle(input.title ?? existing?.title ?? '');
    if (!title) return err('INVALID', 'a title is required');
    const tags =
      input.tags !== undefined ? normalizeTags(input.tags, CODEX_MAX_TAGS) : [...(existing?.tags ?? [])];

    // New body.
    let nextBody: string;
    if (mode === 'append') {
      if (!existing) return err('NOT_FOUND', 'no page to append to');
      if (!body) return err('INVALID', 'nothing to append');
      const stamp =
        actor.id !== existing.author ? `\n\n— ${authorLabel(actor)}${this.#dayLabel()}:\n` : '\n\n';
      nextBody = `${existing.body}${stamp}${body}`;
      if (byteLength(nextBody) > CODEX_MAX_BODY_BYTES) {
        return err(
          'PAGE_FULL',
          `page "${existing.id}" is full (8 KB); start a new page, e.g. "${singleLine(`${existing.title} (part 2)`)}"`,
        );
      }
    } else {
      if (!body) return err('INVALID', 'body is empty');
      nextBody = body;
      if (byteLength(nextBody) > CODEX_MAX_BODY_BYTES) {
        return err(
          'TOO_LARGE',
          `body is ${byteLength(nextBody)} bytes; the cap is 8 KB, so split it into pages`,
        );
      }
    }

    // Content checks on what this write adds.
    const added = `${title}\n${tags.join(' ')}\n${mode === 'append' ? body : nextBody}`;
    const secrets = scanForSecrets(added);
    if (secrets.found) {
      return err(
        'SECRET',
        `this looks like a credential (${secrets.kinds.join(', ')}); the Codex is shared with every agent and PC, so it never stores secrets`,
      );
    }
    if (scope === 'lasting' && containsCoordinates(`${title}\n${nextBody}`)) {
      return err(
        'COORDS_IN_LASTING',
        'lasting pages outlive this world, so they cannot hold coordinates; write a places page (world scope) instead',
      );
    }

    // Mode-specific checks.
    if (mode === 'create') {
      const similar = findSimilar(title, this.#pages.values());
      if (similar) {
        if (actor.kind === 'agent') {
          return err(
            'SIMILAR_EXISTS',
            `similar page ${similar.item.id} ("${singleLine(similar.item.title)}") exists; use update or append`,
            { similarId: similar.item.id },
          );
        }
        notes.push(`similar page ${similar.item.id} exists`);
      }
    } else if (mode === 'update' && existing) {
      if (input.base_rev === undefined) {
        return err(
          'REV_REQUIRED',
          `update needs base_rev (read the page first; it is at rev ${encodeRev(existing.rev)})`,
          {
            current: existing,
          },
        );
      }
      if (input.base_rev !== existing.rev) {
        return err(
          'REV_CONFLICT',
          `the page changed since ${input.base_rev >= 0 ? `rev ${encodeRev(input.base_rev)}` : 'the revision you gave'} (now rev ${encodeRev(existing.rev)}); merge your change into the current text`,
          { current: existing },
        );
      }
    }

    // Build and persist.
    const now = new Date(this.#clock.now()).toISOString();
    let page: CodexPage;
    if (existing) {
      const contributors =
        actor.id !== existing.author && !existing.contributors.includes(actor.id)
          ? [...existing.contributors, actor.id]
          : [...existing.contributors];
      page = {
        ...existing,
        title,
        tags,
        category,
        updated: now,
        rev: existing.rev + 1,
        coords,
        contributors,
        body: nextBody,
      };
    } else {
      const day = this.#gameDay();
      page = {
        id: this.#uniqueId(input.id && isValidPageId(input.id) ? input.id : title),
        title,
        tags,
        category,
        scope,
        world: scope === 'world' ? (this.#worldId ?? undefined) : undefined,
        author: actor.id,
        authorName: actor.name,
        authorKind: actor.kind,
        created: now,
        updated: now,
        createdDay: day ?? undefined,
        links: [],
        rev: 1,
        pinned: false,
        coords,
        contributors: [],
        body: nextBody,
      };
    }
    await this.#persist(page, `${mode} ${page.id}: ${page.title}`, actor);
    if (actor.kind === 'player') this.#locks.delete(page.id);

    let budgetLeft: number | undefined;
    if (isAgent) {
      this.#state.budget.counts[actor.id] = (this.#state.budget.counts[actor.id] ?? 0) + 1;
      budgetLeft = Math.max(0, this.#budgetPerDay - (this.#state.budget.counts[actor.id] ?? 0));
      await this.#saveState();
    }
    this.emit('changed', { type: 'write', id: page.id, created: !existing });
    return { ok: true, page, created: !existing, notes, budgetLeft };
  }

  #dayLabel(): string {
    const day = this.#gameDay();
    return day === null ? '' : `, Day ${day}`;
  }

  #uniqueId(titleOrId: string): string {
    const base = slugify(titleOrId);
    let id = base;
    const taken = (candidate: string) =>
      this.#pages.has(candidate) ||
      existsSync(this.#pathFor(candidate, 'lasting')) ||
      // A world file that was skipped at load (unparseable, or shadowed by a lasting page) must not be overwritten.
      (this.#worldId !== null && existsSync(this.#pathFor(candidate, 'world')));
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    return id;
  }

  #pathFor(id: string, scope: CodexScope, world?: string): string {
    if (scope === 'lasting') return join(this.root, 'lasting', `${id}.md`);
    return join(this.root, worldFolder(world ?? this.#worldId ?? 'unknown'), `${id}.md`);
  }

  #absPath(page: CodexPage): string {
    return this.#pathFor(page.id, page.scope, page.world);
  }

  #relPath(page: CodexPage): string {
    return page.scope === 'lasting'
      ? `lasting/${page.id}.md`
      : `${worldFolder(page.world ?? this.#worldId ?? 'unknown')}/${page.id}.md`;
  }

  async #writePageFile(page: CodexPage): Promise<void> {
    await writeFileAtomic(this.#absPath(page), serializePage(page), { mode: 0o644 });
  }

  async #persist(page: CodexPage, message: string, actor: CodexActor): Promise<void> {
    await this.#writePageFile(page);
    await this.#commit([this.#relPath(page)], message, actor);
    this.#pages.set(page.id, page);
    this.#indexPage(page);
    await this.#exportPage(page);
  }

  async #commit(paths: readonly string[], message: string, actor: CodexActor): Promise<void> {
    try {
      await this.#git.commit(paths, singleLine(message, 160), identityFor(actor));
    } catch (e) {
      // The file is written either way; history is best-effort.
      this.#log?.warn({ err: e }, 'codex git commit failed');
    }
  }

  #indexPage(page: CodexPage): void {
    const doc = toIndexDoc(page);
    if (this.#index.has(page.id)) this.#index.replace(doc);
    else this.#index.add(doc);
  }

  async #loadDir(dir: string, scope: CodexScope, world: string | undefined): Promise<void> {
    if (!existsSync(dir)) return;
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.md')) continue;
      const id = file.slice(0, -3);
      if (!isValidPageId(id) || this.#pages.has(id)) {
        this.#log?.warn({ file, dir }, 'codex: skipping page with an invalid or duplicate id');
        continue;
      }
      try {
        const parsed = parsePage(await readFile(join(dir, file), 'utf8'), id);
        if (!parsed) {
          this.#log?.warn({ file, dir }, 'codex: skipping page without frontmatter');
          continue;
        }
        this.#pages.set(id, { ...parsed, scope, world });
      } catch (e) {
        this.#log?.warn({ err: e, file }, 'codex: unreadable page');
      }
    }
  }

  async #loadPages(): Promise<void> {
    this.#pages = new Map();
    await this.#loadDir(join(this.root, 'lasting'), 'lasting', undefined);
    if (this.#worldId !== null) {
      await this.#loadDir(join(this.root, worldFolder(this.#worldId)), 'world', this.#worldId);
    }
    this.#index = newIndex();
    this.#index.addAll([...this.#pages.values()].map(toIndexDoc));
  }

  // --- export ---

  #exportPath(page: CodexPage): string | null {
    if (!this.exportDir) return null;
    return join(this.exportDir, page.scope === 'lasting' ? 'lasting' : 'world', `${page.id}.md`);
  }

  #exportText(page: CodexPage): string {
    const meta = [
      `by ${authorLabel({ kind: page.authorKind, name: page.authorName })}`,
      page.category,
      page.scope,
      page.tags.length ? `tags: ${page.tags.join(', ')}` : '',
      `rev ${encodeRev(page.rev)}`,
      `updated ${page.updated.slice(0, 10)}`,
    ].filter(Boolean);
    const coords = page.coords ? `\nLocation (stamped by MineVibe): ${formatCoords(page.coords)}\n` : '';
    return `${EXPORT_HEADER}\n# ${singleLine(page.title)}\n\n_${meta.join(' · ')}_\n${coords}\n${page.body}\n`;
  }

  async #exportPage(page: CodexPage): Promise<void> {
    const path = this.#exportPath(page);
    if (!path) return;
    try {
      await writeFileAtomic(path, this.#exportText(page), { mode: 0o444 });
    } catch (e) {
      this.#log?.warn({ err: e }, 'codex export write failed');
    }
  }

  async #exportRemove(page: CodexPage): Promise<void> {
    const path = this.#exportPath(page);
    if (path) await rm(path, { force: true });
  }

  async #rebuildExport(): Promise<void> {
    const dir = this.exportDir;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await rm(join(dir, '.git'), { recursive: true, force: true });
    await writeFileAtomic(
      join(dir, 'README.md'),
      `${EXPORT_HEADER}\n# Codex\n\nRead-only copy of the crew's Codex: \`lasting/\` survives world death, \`world/\` is this world only.\nWrite pages with the codex tools, not here.\n`,
      { mode: 0o444 },
    );
    for (const sub of ['lasting', 'world'] as const) {
      const subdir = join(dir, sub);
      await mkdir(subdir, { recursive: true });
      const want = new Set([...this.#pages.values()].filter((p) => p.scope === sub).map((p) => `${p.id}.md`));
      for (const file of await readdir(subdir)) {
        if (!want.has(file)) await rm(join(subdir, file), { recursive: true, force: true });
      }
    }
    for (const page of this.#pages.values()) await this.#exportPage(page);
  }

  // --- persisted state ---

  async #loadState(): Promise<void> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.root, '.mv', 'state.json'), 'utf8'),
      ) as Partial<PersistedState>;
      this.#state = {
        v: 1,
        reads: raw.reads && typeof raw.reads === 'object' ? raw.reads : {},
        budget:
          raw.budget && typeof raw.budget === 'object'
            ? { day: raw.budget.day ?? null, counts: raw.budget.counts ?? {} }
            : { day: null, counts: {} },
      };
    } catch {
      this.#state = { v: 1, reads: {}, budget: { day: null, counts: {} } };
    }
  }

  async #saveState(): Promise<void> {
    try {
      await writeFileAtomic(join(this.root, '.mv', 'state.json'), `${JSON.stringify(this.#state)}\n`, {
        mode: 0o644,
      });
    } catch (e) {
      this.#log?.warn({ err: e }, 'codex state save failed');
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== null) return;
    this.#saveTimer = this.#clock.setTimeout(() => {
      this.#saveTimer = null;
      void this.#saveState();
    }, 5_000);
  }
}

/** One log page inside a weekly roll-up. */
function rollupSection(p: CodexPage): string {
  return `### ${singleLine(p.title)} (${p.authorName}, Day ${p.createdDay ?? '?'})\n\n${p.body.trim()}`;
}
