import type { Logger } from 'pino';
import { delay, withDeadline } from './deadline.js';
import { hasControlChar } from './Vault.js';

/**
 * `pc.input` → spacesd (PLAN §5, §7.7, §8.4).
 *
 * Batches arrive as `{pcId, seq, ev:[…]}` with event tuples:
 *   ["m",x,y] move · ["bd","left"] / ["bu","left"] button down/up · ["s",dx,dy] scroll
 *   ["t","héllo"] text · ["kd","KEY_SHIFT"] / ["ku","KEY_SHIFT"] key down/up · ["k","ctrl+c"] chord
 *
 * - Only the PC's current occupant is obeyed.
 * - One serialized queue per PC; consecutive moves coalesce (only the latest move is kept while a call
 *   is in flight) and consecutive scrolls add up.
 * - Held keys and buttons are tracked from what spacesd actually accepted (H2): a key counts as held only
 *   after its key-down call succeeded, and stops counting only after its key-up call succeeded. A
 *   release (unseat, kick, screen close, occupant change, removal) is a queued step that releases
 *   everything held *at the time it runs*, so a key-down still in flight is released too, and a failed
 *   key-up is retried by the next release. Unary RPCs have no lease, so this is the only safety net.
 * - Every spacesd call has a deadline (H3), long text is typed in chunks, batches and queues are capped
 *   (key-ups get a little slack; past it the queue is dropped and replaced by a release).
 */

export type MouseButtonName = 'left' | 'right' | 'middle';

export type PcInputEvent =
  | ['m', number, number]
  | ['bd', MouseButtonName]
  | ['bu', MouseButtonName]
  | ['s', number, number]
  | ['t', string]
  | ['kd', string]
  | ['ku', string]
  | ['k', string];

export interface Occupant {
  kind: 'player' | 'agent';
  id: string;
}

type CallOpts = { signal: AbortSignal };

/** The spacesd calls input needs (each takes the deadline's signal). */
export interface InputClient {
  pointerJson(requestJson: string, opts?: CallOpts): Promise<string>;
  keyboardJson(requestJson: string, opts?: CallOpts): Promise<string>;
  typeText(text: string, opts?: CallOpts): Promise<void>;
  hotkey(keys: string[], opts?: CallOpts): Promise<void>;
}

const BUTTONS: Record<MouseButtonName, string> = {
  left: 'MOUSE_BUTTON_LEFT',
  right: 'MOUSE_BUTTON_RIGHT',
  middle: 'MOUSE_BUTTON_MIDDLE',
};

export const MAX_TEXT_LENGTH = 4096;
/** Text is typed in chunks of this many code points, so each call stays well inside its deadline. */
export const TEXT_CHUNK = 128;
/** Events per `pc.input` batch; a larger batch is refused whole. */
export const MAX_BATCH_EVENTS = 256;
/** Extra queue room for key-ups and button-ups beyond `maxQueue`. */
const RELEASE_SLACK = 64;
const KEY_NAME_RE = /^KEY_[A-Z0-9_]{1,32}$/;
const CHORD_PART_RE = /^(?:[a-z][a-z0-9_]{0,23}|KEY_[A-Z0-9_]{1,32}|\S)$/i;

/** A key as spacesd's `Key` message: `{named:"KEY_X"}` or `{character:"a"}`. */
export function keySpec(key: string): { named: string } | { character: string } | null {
  if (KEY_NAME_RE.test(key)) return { named: key };
  if ([...key].length === 1 && !hasControlChar(key)) return { character: key };
  return null;
}

/** Validates one wire tuple; returns the typed event or null. */
export function parseInputEvent(raw: unknown): PcInputEvent | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [kind, a, b] = raw as [unknown, unknown, unknown];
  const int = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000;
  switch (kind) {
    case 'm':
      return int(a) && int(b) ? ['m', Math.round(a as number), Math.round(b as number)] : null;
    case 's':
      return int(a) && int(b) ? ['s', Math.round(a as number), Math.round(b as number)] : null;
    case 'bd':
    case 'bu':
      return typeof a === 'string' && a in BUTTONS ? [kind, a as MouseButtonName] : null;
    case 't':
      return typeof a === 'string' && a.length > 0 && a.length <= MAX_TEXT_LENGTH ? ['t', a] : null;
    case 'kd':
    case 'ku':
      return typeof a === 'string' && keySpec(a) ? [kind, a] : null;
    case 'k': {
      if (typeof a !== 'string' || a.length > 64) return null;
      const parts = splitChord(a);
      return parts && parts.length > 0 ? ['k', a] : null;
    }
    default:
      return null;
  }
}

/** "ctrl+shift+t" → ["ctrl","shift","t"]; a literal "+" key is written "ctrl++". */
export function splitChord(chord: string): string[] | null {
  // A dangling separator ("ctrl+") is malformed; "ctrl++" means ctrl and the plus key.
  if (chord.endsWith('+') && !chord.endsWith('++') && chord !== '+') return null;
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < chord.length; i++) {
    const ch = chord[i] as string;
    if (ch === '+' && cur !== '') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') parts.push(cur);
  if (parts.length === 0 || parts.length > 5 || !parts.every((p) => CHORD_PART_RE.test(p))) return null;
  return parts;
}

/** One queued spacesd call. `release` releases everything held when it runs. */
type Op =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; button: MouseButtonName }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'text'; text: string }
  | { t: 'keydown' | 'keyup'; key: string }
  | { t: 'chord'; keys: string[] }
  | { t: 'release' };

interface PcQueue {
  occupant: Occupant | null;
  ops: Op[];
  running: boolean;
  idle: (() => void)[];
  /** Keys whose key-down spacesd accepted and whose key-up it has not (yet) accepted. */
  downKeys: Set<string>;
  downButtons: Set<MouseButtonName>;
  lastPos: { x: number; y: number } | null;
  display: { w: number; h: number } | null;
  stats: { calls: number; coalesced: number; rejected: number; errors: number; overflows: number };
}

export interface InputRouterOptions {
  getClient: (pcId: string) => Promise<InputClient>;
  logger?: Logger;
  /** Queue bound per PC; past it, new events are refused (key-ups and button-ups get a little slack). */
  maxQueue?: number;
  /** Deadline of one spacesd input call (default 5 s). */
  callTimeoutMs?: number;
  /** How long `removePc` waits for queued releases before forgetting the PC (default 2 s). */
  removeWaitMs?: number;
}

export interface SubmitResult {
  accepted: number;
  rejected: number;
  reason?: 'NOT_OCCUPANT' | 'INVALID' | 'TOO_LARGE';
}

/** Splits text into chunks of at most `size` code points (never inside a surrogate pair). */
export function chunkText(text: string, size = TEXT_CHUNK): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

export class InputRouter {
  readonly #pcs = new Map<string, PcQueue>();
  readonly #getClient: InputRouterOptions['getClient'];
  readonly #log: Logger | undefined;
  readonly #maxQueue: number;
  readonly #callTimeoutMs: number;
  readonly #removeWaitMs: number;

  constructor(options: InputRouterOptions) {
    this.#getClient = options.getClient;
    this.#log = options.logger;
    this.#maxQueue = options.maxQueue ?? 512;
    this.#callTimeoutMs = options.callTimeoutMs ?? 5_000;
    this.#removeWaitMs = options.removeWaitMs ?? 2_000;
  }

  #q(pcId: string): PcQueue {
    let q = this.#pcs.get(pcId);
    if (!q) {
      q = {
        occupant: null,
        ops: [],
        running: false,
        idle: [],
        downKeys: new Set(),
        downButtons: new Set(),
        lastPos: null,
        display: null,
        stats: { calls: 0, coalesced: 0, rejected: 0, errors: 0, overflows: 0 },
      };
      this.#pcs.set(pcId, q);
    }
    return q;
  }

  /** Display size for clamping coordinates. */
  setDisplay(pcId: string, w: number, h: number): void {
    this.#q(pcId).display = { w, h };
  }

  occupant(pcId: string): Occupant | null {
    return this.#pcs.get(pcId)?.occupant ?? null;
  }

  /**
   * Sets who may drive the PC. A change drops the previous occupant's queued input and releases every
   * key and button still held (including one whose key-down is in flight right now).
   */
  setOccupant(pcId: string, occupant: Occupant | null): void {
    const q = this.#q(pcId);
    const same = q.occupant?.kind === occupant?.kind && q.occupant?.id === occupant?.id;
    if (same) return;
    this.#clearAndRelease(q);
    q.occupant = occupant;
    this.#pump(pcId, q);
  }

  /** Accepts one `pc.input` batch from `from`. */
  submit(pcId: string, from: Occupant, events: readonly unknown[]): SubmitResult {
    const q = this.#q(pcId);
    if (!q.occupant || q.occupant.kind !== from.kind || q.occupant.id !== from.id) {
      q.stats.rejected += events.length;
      return { accepted: 0, rejected: events.length, reason: 'NOT_OCCUPANT' };
    }
    if (events.length > MAX_BATCH_EVENTS) {
      q.stats.rejected += events.length;
      return { accepted: 0, rejected: events.length, reason: 'TOO_LARGE' };
    }
    let accepted = 0;
    let rejected = 0;
    for (const raw of events) {
      const ev = parseInputEvent(raw);
      if (!ev) {
        rejected++;
        continue;
      }
      if (this.#enqueue(q, ev)) accepted++;
      else rejected++;
    }
    q.stats.rejected += rejected;
    this.#pump(pcId, q);
    return rejected > 0 && accepted === 0
      ? { accepted, rejected, reason: 'INVALID' }
      : { accepted, rejected };
  }

  /** Releases every held key and button of a PC (unseat, kick, screen close). Resolves when sent. */
  releaseAll(pcId: string): Promise<void> {
    const q = this.#pcs.get(pcId);
    if (!q) return Promise.resolve();
    this.#pushRelease(q);
    this.#pump(pcId, q);
    return this.idle(pcId);
  }

  /** Keys and buttons spacesd currently holds down (as far as accepted calls tell). */
  held(pcId: string): { keys: string[]; buttons: MouseButtonName[] } {
    const q = this.#pcs.get(pcId);
    return { keys: [...(q?.downKeys ?? [])], buttons: [...(q?.downButtons ?? [])] };
  }

  stats(pcId: string): PcQueue['stats'] | undefined {
    const q = this.#pcs.get(pcId);
    return q ? { ...q.stats } : undefined;
  }

  queued(pcId: string): number {
    return this.#pcs.get(pcId)?.ops.length ?? 0;
  }

  /** Resolves when the PC's queue is empty and nothing is in flight. */
  idle(pcId: string): Promise<void> {
    const q = this.#pcs.get(pcId);
    if (!q || (!q.running && q.ops.length === 0)) return Promise.resolve();
    return new Promise((resolve) => q.idle.push(resolve));
  }

  /**
   * Drops queued input, releases everything held and forgets the PC. Waits at most `removeWaitMs` for
   * the release (H3): a hung guest must never block stop, recreate, reimage or decommission.
   */
  async removePc(pcId: string): Promise<void> {
    const q = this.#pcs.get(pcId);
    if (!q) return;
    this.#clearAndRelease(q);
    this.#pump(pcId, q);
    await Promise.race([this.idle(pcId), delay(this.#removeWaitMs)]);
    if (this.#pcs.get(pcId) === q) this.#pcs.delete(pcId);
  }

  // ------------------------------------------------------------------ internals

  #clamp(q: PcQueue, x: number, y: number): { x: number; y: number } {
    const cx = Math.max(0, q.display ? Math.min(q.display.w - 1, x) : x);
    const cy = Math.max(0, q.display ? Math.min(q.display.h - 1, y) : y);
    return { x: cx, y: cy };
  }

  #clearAndRelease(q: PcQueue): void {
    q.ops.length = 0;
    this.#pushRelease(q);
  }

  /**
   * Queues a release step when anything is or may become held: keys/buttons spacesd accepted, a call in
   * flight (it may be a key-down) or a queued key-down. Nothing held, nothing queued.
   */
  #pushRelease(q: PcQueue): void {
    const mayHold =
      q.downKeys.size > 0 ||
      q.downButtons.size > 0 ||
      q.running ||
      q.ops.some((o) => o.t === 'keydown' || o.t === 'down');
    if (mayHold && q.ops.at(-1)?.t !== 'release') q.ops.push({ t: 'release' });
  }

  #enqueue(q: PcQueue, ev: PcInputEvent): boolean {
    const last = q.ops[q.ops.length - 1];
    const full = q.ops.length >= this.#maxQueue;
    switch (ev[0]) {
      case 'm': {
        const p = this.#clamp(q, ev[1], ev[2]);
        q.lastPos = p;
        if (last?.t === 'move') {
          last.x = p.x;
          last.y = p.y;
          q.stats.coalesced++;
          return true;
        }
        if (full) return false;
        q.ops.push({ t: 'move', ...p });
        return true;
      }
      case 's': {
        if (last?.t === 'scroll') {
          last.dx += ev[1];
          last.dy += ev[2];
          q.stats.coalesced++;
          return true;
        }
        if (full) return false;
        q.ops.push({ t: 'scroll', dx: ev[1], dy: ev[2] });
        return true;
      }
      case 'bd':
        if (full) return false;
        q.ops.push({ t: 'down', button: ev[1] });
        return true;
      case 'kd':
        if (full) return false;
        q.ops.push({ t: 'keydown', key: ev[1] });
        return true;
      case 'bu':
      case 'ku': {
        if (q.ops.length >= this.#maxQueue + RELEASE_SLACK) {
          // Flooded: drop everything and release whatever is held rather than lose a key-up.
          q.stats.overflows++;
          this.#clearAndRelease(q);
          return false;
        }
        q.ops.push(ev[0] === 'bu' ? { t: 'up', button: ev[1] } : { t: 'keyup', key: ev[1] });
        return true;
      }
      case 't': {
        const chunks = chunkText(ev[1]);
        if (q.ops.length + chunks.length > this.#maxQueue) return false;
        for (const text of chunks) q.ops.push({ t: 'text', text });
        return true;
      }
      case 'k': {
        if (full) return false;
        const keys = splitChord(ev[1]);
        if (!keys) return false;
        q.ops.push({ t: 'chord', keys });
        return true;
      }
    }
  }

  #pump(pcId: string, q: PcQueue): void {
    if (q.running) return;
    if (q.ops.length === 0) {
      for (const r of q.idle.splice(0)) r();
      return;
    }
    q.running = true;
    void (async () => {
      try {
        while (q.ops.length > 0) {
          const op = q.ops.shift() as Op;
          if (op.t === 'release') {
            await this.#release(pcId, q);
            continue;
          }
          try {
            await this.#call(pcId, q, op);
            q.stats.calls++;
          } catch (err) {
            q.stats.errors++;
            this.#log?.debug({ pcId, op: op.t, err: String(err) }, 'pc input call failed');
          }
        }
      } finally {
        q.running = false;
        for (const r of q.idle.splice(0)) r();
      }
    })();
  }

  /** Sends key-up / button-up for everything held now; a failed one stays held for the next release. */
  async #release(pcId: string, q: PcQueue): Promise<void> {
    const ops: Exclude<Op, { t: 'release' }>[] = [
      ...[...q.downKeys].map((key) => ({ t: 'keyup' as const, key })),
      ...[...q.downButtons].map((button) => ({ t: 'up' as const, button })),
    ];
    for (const op of ops) {
      try {
        await this.#call(pcId, q, op);
        q.stats.calls++;
      } catch (err) {
        q.stats.errors++;
        this.#log?.debug({ pcId, op: op.t, err: String(err) }, 'pc input release failed; kept as held');
      }
    }
  }

  async #call(pcId: string, q: PcQueue, op: Exclude<Op, { t: 'release' }>): Promise<void> {
    try {
      await this.#send(pcId, q, op);
    } catch (err) {
      // A failed (or timed-out) down may still have landed in the guest: count it as held so the next
      // release sends its up. A spurious key-up is harmless; a missing one is a stuck key.
      if (op.t === 'keydown') q.downKeys.add(op.key);
      else if (op.t === 'down') q.downButtons.add(op.button);
      throw err;
    }
    // Only now, with spacesd's answer in hand, does the held state change (H2).
    if (op.t === 'keydown') q.downKeys.add(op.key);
    else if (op.t === 'keyup') q.downKeys.delete(op.key);
    else if (op.t === 'down') q.downButtons.add(op.button);
    else if (op.t === 'up') q.downButtons.delete(op.button);
  }

  async #send(pcId: string, q: PcQueue, op: Exclude<Op, { t: 'release' }>): Promise<void> {
    await withDeadline(this.#callTimeoutMs, `pc input ${op.t}`, async (signal) => {
      const c = await this.#getClient(pcId);
      const o = { signal };
      switch (op.t) {
        case 'move':
          await c.pointerJson(JSON.stringify({ move: { position: { x: op.x, y: op.y } } }), o);
          return;
        case 'down':
        case 'up':
          await c.pointerJson(JSON.stringify({ [op.t]: { button: BUTTONS[op.button] } }), o);
          return;
        case 'scroll': {
          const position = q.lastPos ?? { x: 0, y: 0 };
          await c.pointerJson(JSON.stringify({ scroll: { position, deltaX: op.dx, deltaY: op.dy } }), o);
          return;
        }
        case 'text':
          await c.typeText(op.text, o);
          return;
        case 'keydown':
        case 'keyup':
          await c.keyboardJson(
            JSON.stringify({ [op.t === 'keydown' ? 'down' : 'up']: { key: keySpec(op.key) } }),
            o,
          );
          return;
        case 'chord': {
          const single = op.keys.length === 1 ? keySpec(op.keys[0] as string) : null;
          if (single) await c.keyboardJson(JSON.stringify({ press: { key: single } }), o);
          else await c.hotkey(op.keys, o);
          return;
        }
      }
    });
  }
}
