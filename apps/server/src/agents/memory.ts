/**
 * Small persistent texts the brains use (PLAN §6.5 "Memory", §6.3 kickoff, §7.9 Chronicle):
 * - {@link MemoryStore}: `memory.md` per agent, written by `mcp__mc__remember` (8 KB cap; the oldest notes drop
 *   off when full) and re-injected when a session starts or resumes. Private to the agent.
 * - {@link HandoffNotes}: `state/vault-handoffs/<key>.md`, written by `mcp__pc__handoff_note` and shown in the next
 *   kickoff at that PC (not in the user's repo).
 * - {@link Chronicle}: `state/chronicle.json`, the story across worlds (capped), given to the next CEO.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../util/atomicFile.js';
import { CHRONICLE_MAX_CHARS, MEMORY_MAX_BYTES } from './constants.js';

/** One remembered note: at most this many characters. */
export const MEMORY_NOTE_MAX = 600;

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Serializes writes per key. */
class WriteQueue {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

export interface RememberResult {
  readonly bytes: number;
  /** Notes dropped from the top to stay under the cap. */
  readonly dropped: number;
}

export class MemoryStore {
  readonly #fileOf: (agentId: string) => string;
  readonly #queue = new WriteQueue();
  readonly #cache = new Map<string, string[]>();

  constructor(fileOf: (agentId: string) => string) {
    this.#fileOf = fileOf;
  }

  async notes(agentId: string): Promise<string[]> {
    const cached = this.#cache.get(agentId);
    if (cached) return [...cached];
    const raw = (await readText(this.#fileOf(agentId))) ?? '';
    const notes = raw
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
    this.#cache.set(agentId, notes);
    return [...notes];
  }

  /** The file's text for injection ("" when empty). */
  async text(agentId: string): Promise<string> {
    const notes = await this.notes(agentId);
    return notes.map((n) => `- ${n}`).join('\n');
  }

  /** Appends a note (one line, at most {@link MEMORY_NOTE_MAX} characters). */
  remember(agentId: string, note: string, stamp: string): Promise<RememberResult> {
    return this.#queue.run(agentId, async () => {
      const line = `${stamp} ${note.replace(/\s+/g, ' ').trim()}`.slice(0, MEMORY_NOTE_MAX);
      const notes = [...(await this.notes(agentId)), line];
      let dropped = 0;
      const render = () => `# Memory\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
      while (bytes(render()) > MEMORY_MAX_BYTES && notes.length > 1) {
        notes.shift();
        dropped++;
      }
      const body = render();
      await writeFileAtomic(this.#fileOf(agentId), body, { mode: 0o600 });
      this.#cache.set(agentId, notes);
      return { bytes: bytes(body), dropped };
    });
  }
}

export interface HandoffNote {
  readonly at: number;
  readonly author: string;
  readonly text: string;
}

/** Notes kept per PC or mount. */
export const HANDOFF_KEEP = 5;
export const HANDOFF_NOTE_MAX = 1500;

export class HandoffNotes {
  readonly #dir: string;
  readonly #queue = new WriteQueue();
  readonly #redact: (text: string) => string;

  /** `redact`: the outbound redactor, applied to every note an agent leaves (agents/redact.ts). */
  constructor(dir: string, options: { readonly redact?: (text: string) => string } = {}) {
    this.#dir = dir;
    this.#redact = options.redact ?? ((t) => t);
  }

  /** File key for a PC id or a Vault mount path. */
  static key(target: string): string {
    return createHash('sha256').update(target).digest('hex').slice(0, 16);
  }

  #file(target: string): string {
    return `${this.#dir}/${HandoffNotes.key(target)}.json`;
  }

  async list(target: string): Promise<HandoffNote[]> {
    const raw = await readText(this.#file(target));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { notes?: HandoffNote[] };
      return Array.isArray(parsed.notes)
        ? parsed.notes.filter((n) => typeof n?.text === 'string' && typeof n.author === 'string')
        : [];
    } catch {
      return [];
    }
  }

  add(target: string, note: HandoffNote): Promise<number> {
    return this.#queue.run(target, async () => {
      const notes = [
        ...(await this.list(target)),
        { ...note, text: this.#redact(note.text).slice(0, HANDOFF_NOTE_MAX) },
      ].slice(-HANDOFF_KEEP);
      await writeFileAtomic(this.#file(target), `${JSON.stringify({ target, notes }, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      });
      return notes.length;
    });
  }
}

export interface ChronicleEntry {
  readonly worldId: string;
  readonly gen: number;
  readonly text: string;
}

export class Chronicle {
  readonly #file: string;
  readonly #queue = new WriteQueue();

  constructor(file: string) {
    this.#file = file;
  }

  async entries(): Promise<ChronicleEntry[]> {
    const raw = await readText(this.#file);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { entries?: ChronicleEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries.filter((e) => typeof e?.text === 'string') : [];
    } catch {
      return [];
    }
  }

  /** The chronicle as one paragraph, newest last, within the cap. */
  async paragraph(): Promise<string> {
    return (await this.entries()).map((e) => `World #${e.gen}: ${e.text}`).join('\n');
  }

  add(entry: ChronicleEntry): Promise<void> {
    return this.#queue.run('chronicle', async () => {
      const entries = [...(await this.entries()).filter((e) => e.worldId !== entry.worldId), entry];
      const render = () => entries.map((e) => `World #${e.gen}: ${e.text}`).join('\n');
      while (render().length > CHRONICLE_MAX_CHARS && entries.length > 1) entries.shift();
      await writeFileAtomic(this.#file, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
    });
  }
}
