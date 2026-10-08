/**
 * TranscriptStore: each agent's transcript for AgentScreen and the Crew log (`chat.append`, `chat.history`), kept in
 * `worlds/<w>/agents/<id>/chat.jsonl` (one ChatEntry per line). Claude's own transcripts stay under
 * `~/.claude/projects/<cwd>`.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type ChatEntry, ChatEntry as ChatEntrySchema } from '@minevibe/protocol';
import { TypedEmitter } from '../util/TypedEmitter.js';

export const TRANSCRIPT_TEXT_MAX = 8000;
/** Entries kept in memory per agent (the file keeps everything). */
export const TRANSCRIPT_MEMORY_MAX = 2000;

export type TranscriptEvents = { append: [agentId: string, entry: ChatEntry] };

export type TranscriptInput = Omit<ChatEntry, 'seq' | 'at'> & { at?: number };

interface Log {
  entries: ChatEntry[];
  nextSeq: number;
  loaded: boolean;
}

export class TranscriptStore extends TypedEmitter<TranscriptEvents> {
  readonly #logs = new Map<string, Log>();
  readonly #fileOf: (agentId: string) => string | null;
  readonly #now: () => number;
  readonly #writes = new Map<string, Promise<void>>();
  readonly #onError: (err: unknown) => void;

  constructor(
    options: {
      fileOf?: (agentId: string) => string | null;
      now?: () => number;
      onError?: (err: unknown) => void;
    } = {},
  ) {
    super();
    this.#fileOf = options.fileOf ?? (() => null);
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  /** Loads an agent's transcript tail from disk (once). */
  async load(agentId: string): Promise<void> {
    const log = this.#log(agentId);
    if (log.loaded) return;
    log.loaded = true;
    const file = this.#fileOf(agentId);
    if (!file) return;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const loaded: ChatEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = ChatEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) loaded.push(parsed.data);
      } catch {
        // a torn last line after a crash: skip it
      }
    }
    const merged = [...loaded, ...log.entries.filter((e) => !loaded.some((l) => l.seq === e.seq))];
    merged.sort((a, b) => a.seq - b.seq);
    log.entries = merged.slice(-TRANSCRIPT_MEMORY_MAX);
    log.nextSeq = Math.max(log.nextSeq, (merged.at(-1)?.seq ?? -1) + 1);
  }

  /** Appends one line; empty text is ignored (returns null). */
  append(agentId: string, input: TranscriptInput): ChatEntry | null {
    const text = input.text.trim();
    if (text.length === 0) return null;
    const log = this.#log(agentId);
    const entry: ChatEntry = {
      seq: log.nextSeq++,
      at: input.at ?? this.#now(),
      kind: input.kind,
      text: text.length > TRANSCRIPT_TEXT_MAX ? `${text.slice(0, TRANSCRIPT_TEXT_MAX - 1)}…` : text,
      ...(input.fromAgentId !== undefined ? { fromAgentId: input.fromAgentId } : {}),
      ...(input.cardId !== undefined ? { cardId: input.cardId } : {}),
    };
    log.entries.push(entry);
    if (log.entries.length > TRANSCRIPT_MEMORY_MAX)
      log.entries.splice(0, log.entries.length - TRANSCRIPT_MEMORY_MAX);
    this.#persist(agentId, entry);
    this.emit('append', agentId, entry);
    return entry;
  }

  /** A page of entries with `seq < beforeSeq` (newest page when absent), oldest first. */
  page(
    agentId: string,
    options: { beforeSeq?: number | undefined; limit: number },
  ): { entries: ChatEntry[]; more: boolean } {
    const all = this.#log(agentId).entries.filter(
      (e) => options.beforeSeq === undefined || e.seq < options.beforeSeq,
    );
    const limit = Math.max(1, Math.min(200, options.limit));
    const entries = all.slice(Math.max(0, all.length - limit));
    return { entries, more: all.length > entries.length };
  }

  /** The newest `n` entries. */
  tail(agentId: string, n: number): ChatEntry[] {
    return this.#log(agentId).entries.slice(-n);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#writes.values()]);
  }

  #log(agentId: string): Log {
    let log = this.#logs.get(agentId);
    if (!log) {
      log = { entries: [], nextSeq: 0, loaded: false };
      this.#logs.set(agentId, log);
    }
    return log;
  }

  #persist(agentId: string, entry: ChatEntry): void {
    const file = this.#fileOf(agentId);
    if (!file) return;
    const line = `${JSON.stringify(entry)}\n`;
    const prev = this.#writes.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch((err: unknown) => this.#onError(err));
    this.#writes.set(agentId, next);
    void next.then(() => {
      if (this.#writes.get(agentId) === next) this.#writes.delete(agentId);
    });
  }
}
