import type { Logger } from 'pino';
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
 * - Held keys and buttons are tracked; `releaseAll` (unseat, kick, screen close, occupant change) sends
 *   key-up / button-up for every one of them, since unary RPCs have no lease.
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

/** The spacesd calls input needs. */
export interface InputClient {
  pointerJson(requestJson: string): Promise<string>;
  keyboardJson(requestJson: string): Promise<string>;
  typeText(text: string): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
}

const BUTTONS: Record<MouseButtonName, string> = {
  left: 'MOUSE_BUTTON_LEFT',
  right: 'MOUSE_BUTTON_RIGHT',
  middle: 'MOUSE_BUTTON_MIDDLE',
};

export const MAX_TEXT_LENGTH = 4096;
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

/** One queued spacesd call. */
type Op =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; button: MouseButtonName }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'text'; text: string }
  | { t: 'keydown' | 'keyup'; key: string }
  | { t: 'chord'; keys: string[] };

interface PcQueue {
  occupant: Occupant | null;
  ops: Op[];
  running: boolean;
  idle: (() => void)[];
  heldKeys: Set<string>;
  heldButtons: Set<MouseButtonName>;
  lastPos: { x: number; y: number } | null;
  display: { w: number; h: number } | null;
  stats: { calls: number; coalesced: number; rejected: number; errors: number };
}

export interface InputRouterOptions {
  getClient: (pcId: string) => Promise<InputClient>;
  logger?: Logger;
  /** Queue bound per PC; past it, moves and scrolls are dropped (key/button state never is). */
  maxQueue?: number;
}

export interface SubmitResult {
  accepted: number;
  rejected: number;
  reason?: 'NOT_OCCUPANT' | 'INVALID';
}

export class InputRouter {
  readonly #pcs = new Map<string, PcQueue>();
  readonly #getClient: InputRouterOptions['getClient'];
  readonly #log: Logger | undefined;
  readonly #maxQueue: number;

  constructor(options: InputRouterOptions) {
    this.#getClient = options.getClient;
    this.#log = options.logger;
    this.#maxQueue = options.maxQueue ?? 512;
  }

  #q(pcId: string): PcQueue {
    let q = this.#pcs.get(pcId);
    if (!q) {
      q = {
        occupant: null,
        ops: [],
        running: false,
        idle: [],
        heldKeys: new Set(),
        heldButtons: new Set(),
        lastPos: null,
        display: null,
        stats: { calls: 0, coalesced: 0, rejected: 0, errors: 0 },
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
   * key and button it still holds.
   */
  setOccupant(pcId: string, occupant: Occupant | null): void {
    const q = this.#q(pcId);
    const same = q.occupant?.kind === occupant?.kind && q.occupant?.id === occupant?.id;
    if (same) return;
    q.ops.length = 0;
    this.#enqueueRelease(q);
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
    this.#enqueueRelease(q);
    this.#pump(pcId, q);
    return this.idle(pcId);
  }

  held(pcId: string): { keys: string[]; buttons: MouseButtonName[] } {
    const q = this.#pcs.get(pcId);
    return { keys: [...(q?.heldKeys ?? [])], buttons: [...(q?.heldButtons ?? [])] };
  }

  stats(pcId: string): PcQueue['stats'] | undefined {
    const q = this.#pcs.get(pcId);
    return q ? { ...q.stats } : undefined;
  }

  /** Resolves when the PC's queue is empty and nothing is in flight. */
  idle(pcId: string): Promise<void> {
    const q = this.#pcs.get(pcId);
    if (!q || (!q.running && q.ops.length === 0)) return Promise.resolve();
    return new Promise((resolve) => q.idle.push(resolve));
  }

  /** Releases everything and forgets the PC. */
  async removePc(pcId: string): Promise<void> {
    const q = this.#pcs.get(pcId);
    if (!q) return;
    q.ops.length = 0;
    this.#enqueueRelease(q);
    this.#pump(pcId, q);
    await this.idle(pcId);
    this.#pcs.delete(pcId);
  }

  // ------------------------------------------------------------------ internals

  #clamp(q: PcQueue, x: number, y: number): { x: number; y: number } {
    const cx = Math.max(0, q.display ? Math.min(q.display.w - 1, x) : x);
    const cy = Math.max(0, q.display ? Math.min(q.display.h - 1, y) : y);
    return { x: cx, y: cy };
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
        q.heldButtons.add(ev[1]);
        q.ops.push({ t: 'down', button: ev[1] });
        return true;
      case 'bu':
        q.heldButtons.delete(ev[1]);
        q.ops.push({ t: 'up', button: ev[1] });
        return true;
      case 'kd':
        q.heldKeys.add(ev[1]);
        q.ops.push({ t: 'keydown', key: ev[1] });
        return true;
      case 'ku':
        q.heldKeys.delete(ev[1]);
        q.ops.push({ t: 'keyup', key: ev[1] });
        return true;
      case 't':
        if (full) return false;
        q.ops.push({ t: 'text', text: ev[1] });
        return true;
      case 'k': {
        if (full) return false;
        const keys = splitChord(ev[1]);
        if (!keys) return false;
        q.ops.push({ t: 'chord', keys });
        return true;
      }
    }
  }

  #enqueueRelease(q: PcQueue): void {
    for (const key of q.heldKeys) q.ops.push({ t: 'keyup', key });
    for (const button of q.heldButtons) q.ops.push({ t: 'up', button });
    q.heldKeys.clear();
    q.heldButtons.clear();
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

  async #call(pcId: string, q: PcQueue, op: Op): Promise<void> {
    const c = await this.#getClient(pcId);
    switch (op.t) {
      case 'move':
        await c.pointerJson(JSON.stringify({ move: { position: { x: op.x, y: op.y } } }));
        return;
      case 'down':
      case 'up':
        await c.pointerJson(JSON.stringify({ [op.t]: { button: BUTTONS[op.button] } }));
        return;
      case 'scroll': {
        const position = q.lastPos ?? { x: 0, y: 0 };
        await c.pointerJson(JSON.stringify({ scroll: { position, deltaX: op.dx, deltaY: op.dy } }));
        return;
      }
      case 'text':
        await c.typeText(op.text);
        return;
      case 'keydown':
      case 'keyup':
        await c.keyboardJson(
          JSON.stringify({ [op.t === 'keydown' ? 'down' : 'up']: { key: keySpec(op.key) } }),
        );
        return;
      case 'chord': {
        const single = op.keys.length === 1 ? keySpec(op.keys[0] as string) : null;
        if (single) await c.keyboardJson(JSON.stringify({ press: { key: single } }));
        else await c.hotkey(op.keys);
        return;
      }
    }
  }
}
