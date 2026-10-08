import type { InputEvent } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { delay, withDeadline } from './deadline.js';
import { hasControlChar } from './Vault.js';

/**
 * PC input → spacesd (PLAN §5, §7.7, §8.4).
 *
 * The player's input arrives as `pc.input{pcId, seq, events}` with the T0 event objects (protocol §7.7):
 *   {k:"move",x,y} · {k:"button",button,down,x,y} · {k:"scroll",dx,dy,x,y} · {k:"key",key,down}
 *   {k:"text",text} · {k:"release_all"}
 * The seated agent's input (PcApi pointer/keyboard/type) goes through the same queue with
 * {@link InputRouter.perform}, which adds `click` (with a click count), `drag` and `chord` (a hotkey) and
 * resolves once spacesd accepted every call.
 *
 * - Only the PC's current occupant is obeyed.
 * - One serialized queue per PC; consecutive player moves coalesce (only the latest move is kept while a
 *   call is in flight) and consecutive scrolls add up.
 * - Held keys and buttons are tracked from what spacesd actually accepted (H2): a key counts as held only
 *   after its key-down call succeeded, and stops counting only after its key-up call succeeded. A
 *   release (unseat, kick, screen close, occupant change, removal, `release_all`) is a queued step that
 *   releases everything held *at the time it runs*, so a key-down still in flight is released too, and a
 *   failed key-up is retried by the next release. Unary RPCs have no lease, so this is the only safety net.
 * - Every spacesd call has a deadline (H3), long text is typed in chunks, batches and queues are capped
 *   (key-ups get a little slack; past it the queue is dropped and replaced by a release).
 */

export type MouseButtonName = 'left' | 'right' | 'middle';

/** An event the router accepts: a T0 `pc.input` event, or one of the agent-only actions. */
export type RouterEvent =
  | InputEvent
  /** Click `count` times at x,y (spacesd `PointerClick`, so a double click is one call). */
  | { k: 'click'; x: number; y: number; button: MouseButtonName; count: number }
  /** Left-button drag from x,y to toX,toY. */
  | { k: 'drag'; x: number; y: number; toX: number; toY: number }
  /** Press keys together (a hotkey); one key is a plain press. */
  | { k: 'chord'; keys: string[] };

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
  /** Left-button drag (spacesd's own, smooth); without it the router presses, moves and releases. */
  drag?(fromX: number, fromY: number, toX: number, toY: number, opts?: CallOpts): Promise<void>;
}

const BUTTONS: Record<MouseButtonName, string> = {
  left: 'MOUSE_BUTTON_LEFT',
  right: 'MOUSE_BUTTON_RIGHT',
  middle: 'MOUSE_BUTTON_MIDDLE',
};

/** Longest text one event may carry (the wire caps the player's at 512; an agent's `type` is longer). */
export const MAX_TEXT_LENGTH = 16_384;
/** Text is typed in chunks of this many code points, so each call stays well inside its deadline. */
export const TEXT_CHUNK = 128;
/** Events per batch; a larger batch is refused whole. */
export const MAX_BATCH_EVENTS = 256;
/** Largest coordinate accepted (guest pixels); the display clamps further. */
const MAX_COORD = 65_535;
/** Largest scroll delta per event. */
const MAX_SCROLL = 10_000;
/** Extra queue room for key-ups and button-ups beyond `maxQueue`. */
const RELEASE_SLACK = 64;
const KEY_NAME_RE = /^KEY_[A-Z0-9_]{1,32}$/;

/**
 * Friendly key names an agent (or a mod build) may use, as cua `KEY_*` names. Lookups are case-insensitive
 * and ignore `_`, `-` and spaces ("Page Up", "page_up" and "PAGEUP" are the same key).
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'KEY_CONTROL',
  control: 'KEY_CONTROL',
  lctrl: 'KEY_CONTROL_LEFT',
  rctrl: 'KEY_CONTROL_RIGHT',
  shift: 'KEY_SHIFT',
  lshift: 'KEY_SHIFT_LEFT',
  rshift: 'KEY_SHIFT_RIGHT',
  alt: 'KEY_ALT',
  option: 'KEY_ALT',
  opt: 'KEY_ALT',
  altgr: 'KEY_ALT_RIGHT',
  meta: 'KEY_META',
  cmd: 'KEY_META',
  command: 'KEY_META',
  super: 'KEY_META',
  win: 'KEY_META',
  windows: 'KEY_META',
  enter: 'KEY_ENTER',
  return: 'KEY_ENTER',
  esc: 'KEY_ESCAPE',
  escape: 'KEY_ESCAPE',
  tab: 'KEY_TAB',
  space: 'KEY_SPACE',
  spacebar: 'KEY_SPACE',
  backspace: 'KEY_BACKSPACE',
  delete: 'KEY_DELETE',
  del: 'KEY_DELETE',
  insert: 'KEY_INSERT',
  ins: 'KEY_INSERT',
  home: 'KEY_HOME',
  end: 'KEY_END',
  pageup: 'KEY_PAGE_UP',
  pgup: 'KEY_PAGE_UP',
  pagedown: 'KEY_PAGE_DOWN',
  pgdn: 'KEY_PAGE_DOWN',
  up: 'KEY_ARROW_UP',
  arrowup: 'KEY_ARROW_UP',
  down: 'KEY_ARROW_DOWN',
  arrowdown: 'KEY_ARROW_DOWN',
  left: 'KEY_ARROW_LEFT',
  arrowleft: 'KEY_ARROW_LEFT',
  right: 'KEY_ARROW_RIGHT',
  arrowright: 'KEY_ARROW_RIGHT',
  capslock: 'KEY_CAPS_LOCK',
  fn: 'KEY_FN',
  menu: 'KEY_CONTEXT_MENU',
  contextmenu: 'KEY_CONTEXT_MENU',
  printscreen: 'KEY_PRINT_SCREEN',
  print: 'KEY_PRINT_SCREEN',
  prtsc: 'KEY_PRINT_SCREEN',
  numlock: 'KEY_NUM_LOCK',
  scrolllock: 'KEY_SCROLL_LOCK',
  pause: 'KEY_PAUSE',
  plus: '+',
  minus: '-',
};

/**
 * A key name as cua understands it: a `KEY_*` name, one printable character, or a known alias ("ctrl",
 * "Enter", "F5", "PageUp"). Null when it is none of these.
 */
export function normalizeKeyName(name: string): string | null {
  if (name === ' ') return 'KEY_SPACE';
  const k = name.trim();
  if (KEY_NAME_RE.test(k)) return k;
  if ([...k].length === 1 && !hasControlChar(k)) return k;
  if (k.length === 0 || k.length > 32) return null;
  const flat = k.toLowerCase().replace(/[\s_-]+/g, '');
  if (/^key[a-z0-9]+$/.test(flat) && /^key_/i.test(k)) {
    const upper = k.toUpperCase();
    if (KEY_NAME_RE.test(upper)) return upper;
  }
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(flat);
  if (f) return `KEY_F${f[1]}`;
  return KEY_ALIASES[flat] ?? null;
}

/** A key as spacesd's `Key` message: `{named:"KEY_X"}` or `{character:"a"}`. */
export function keySpec(key: string): { named: string } | { character: string } | null {
  if (KEY_NAME_RE.test(key)) return { named: key };
  if ([...key].length === 1 && !hasControlChar(key)) return { character: key };
  return null;
}

const isCoord = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= -MAX_COORD && v <= MAX_COORD;
const isDelta = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCROLL;
const isButton = (v: unknown): v is MouseButtonName => typeof v === 'string' && v in BUTTONS;

/**
 * Validates one event object (a T0 `pc.input` event or an agent action) and normalizes it: coordinates
 * rounded, key names mapped to cua names. Returns null for anything malformed.
 */
export function parseInputEvent(raw: unknown): RouterEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  switch (e.k) {
    case 'move':
      return isCoord(e.x) && isCoord(e.y) ? { k: 'move', x: Math.round(e.x), y: Math.round(e.y) } : null;
    case 'button':
      return isButton(e.button) && typeof e.down === 'boolean' && isCoord(e.x) && isCoord(e.y)
        ? { k: 'button', button: e.button, down: e.down, x: Math.round(e.x), y: Math.round(e.y) }
        : null;
    case 'scroll':
      return isDelta(e.dx) && isDelta(e.dy) && isCoord(e.x) && isCoord(e.y)
        ? { k: 'scroll', dx: Math.round(e.dx), dy: Math.round(e.dy), x: Math.round(e.x), y: Math.round(e.y) }
        : null;
    case 'key': {
      if (typeof e.key !== 'string' || typeof e.down !== 'boolean') return null;
      const key = normalizeKeyName(e.key);
      return key && keySpec(key) ? { k: 'key', key, down: e.down } : null;
    }
    case 'text':
      return typeof e.text === 'string' && e.text.length > 0 && e.text.length <= MAX_TEXT_LENGTH
        ? { k: 'text', text: e.text }
        : null;
    case 'release_all':
      return { k: 'release_all' };
    case 'click': {
      const count = e.count === undefined ? 1 : e.count;
      return isCoord(e.x) &&
        isCoord(e.y) &&
        isButton(e.button) &&
        typeof count === 'number' &&
        Number.isInteger(count) &&
        count >= 1 &&
        count <= 3
        ? { k: 'click', x: Math.round(e.x), y: Math.round(e.y), button: e.button, count }
        : null;
    }
    case 'drag':
      return isCoord(e.x) && isCoord(e.y) && isCoord(e.toX) && isCoord(e.toY)
        ? {
            k: 'drag',
            x: Math.round(e.x),
            y: Math.round(e.y),
            toX: Math.round(e.toX),
            toY: Math.round(e.toY),
          }
        : null;
    case 'chord': {
      if (!Array.isArray(e.keys) || e.keys.length === 0 || e.keys.length > 6) return null;
      const keys: string[] = [];
      for (const k of e.keys) {
        const n = typeof k === 'string' ? normalizeKeyName(k) : null;
        if (!n) return null;
        keys.push(n);
      }
      return { k: 'chord', keys };
    }
    default:
      return null;
  }
}

/** Why an awaited {@link InputRouter.perform} failed. */
export class InputError extends Error {
  readonly code: 'NOT_OCCUPANT' | 'INVALID' | 'TOO_LARGE' | 'QUEUE_FULL' | 'FAILED';
  constructor(code: InputError['code'], message: string) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

/** The completion of one awaited batch: settles when its last op ran (or the queue was dropped). */
interface Batch {
  remaining: number;
  error: unknown;
  settled: boolean;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** One queued spacesd call. `release` releases everything held when it runs. */
type Op = (
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; button: MouseButtonName }
  /** At x,y: where the pointer is once the move queued before it ran (not wherever it went later). */
  | { t: 'scroll'; dx: number; dy: number; x: number; y: number }
  | { t: 'text'; text: string }
  | { t: 'keydown' | 'keyup'; key: string }
  | { t: 'chord'; keys: string[] }
  | { t: 'click'; x: number; y: number; button: MouseButtonName; count: number }
  | { t: 'drag'; x: number; y: number; toX: number; toY: number }
  | { t: 'release' }
) & { batch?: Batch };

type CallOp = Exclude<Op, { t: 'release' }>;

interface PcQueue {
  occupant: Occupant | null;
  ops: Op[];
  running: boolean;
  idle: (() => void)[];
  /** Keys whose key-down spacesd accepted and whose key-up it has not (yet) accepted. */
  downKeys: Set<string>;
  downButtons: Set<MouseButtonName>;
  /** Where the pointer is (or will be, once the queue ran): a move there again is skipped. */
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
  /** Called with the pointer position after every pointer call that spacesd accepted (the agent cursor). */
  onPointer?: (pcId: string, pos: { x: number; y: number }) => void;
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

const sameOccupant = (a: Occupant | null, b: Occupant | null) => a?.kind === b?.kind && a?.id === b?.id;

export class InputRouter {
  readonly #pcs = new Map<string, PcQueue>();
  readonly #getClient: InputRouterOptions['getClient'];
  readonly #log: Logger | undefined;
  readonly #maxQueue: number;
  readonly #callTimeoutMs: number;
  readonly #removeWaitMs: number;
  readonly #onPointer: InputRouterOptions['onPointer'];

  constructor(options: InputRouterOptions) {
    this.#getClient = options.getClient;
    this.#log = options.logger;
    this.#maxQueue = options.maxQueue ?? 512;
    this.#callTimeoutMs = options.callTimeoutMs ?? 5_000;
    this.#removeWaitMs = options.removeWaitMs ?? 2_000;
    this.#onPointer = options.onPointer;
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
   * Sets who may drive the PC. A change drops the previous occupant's queued input (awaited batches reject
   * with NOT_OCCUPANT) and releases every key and button still held (including one whose key-down is in
   * flight right now).
   */
  setOccupant(pcId: string, occupant: Occupant | null): void {
    const q = this.#q(pcId);
    if (sameOccupant(q.occupant, occupant)) return;
    this.#clearAndRelease(q);
    q.occupant = occupant;
    this.#pump(pcId, q);
  }

  /** Accepts one `pc.input` batch from `from` (fire and forget; failed calls are counted, not reported). */
  submit(pcId: string, from: Occupant, events: readonly unknown[]): SubmitResult {
    const q = this.#q(pcId);
    if (!sameOccupant(q.occupant, from)) {
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
      if (this.#enqueue(q, ev, undefined)) accepted++;
      else rejected++;
    }
    q.stats.rejected += rejected;
    this.#pump(pcId, q);
    return rejected > 0 && accepted === 0
      ? { accepted, rejected, reason: 'INVALID' }
      : { accepted, rejected };
  }

  /**
   * Queues `events` for `from` and resolves once spacesd accepted every call they make; rejects with an
   * {@link InputError} when `from` is not the occupant, an event is malformed, the queue is full, a call
   * failed, or the occupant changed before the batch ran. Nothing is queued unless the whole batch fits.
   */
  perform(pcId: string, from: Occupant, events: readonly unknown[]): Promise<void> {
    const q = this.#q(pcId);
    if (!sameOccupant(q.occupant, from)) {
      return Promise.reject(
        new InputError('NOT_OCCUPANT', `${from.kind} ${from.id} does not sit at ${pcId}`),
      );
    }
    if (events.length === 0) return Promise.resolve();
    if (events.length > MAX_BATCH_EVENTS) {
      return Promise.reject(new InputError('TOO_LARGE', `at most ${MAX_BATCH_EVENTS} events at once`));
    }
    const parsed: RouterEvent[] = [];
    for (const raw of events) {
      const ev = parseInputEvent(raw);
      if (!ev) return Promise.reject(new InputError('INVALID', `invalid input event ${JSON.stringify(raw)}`));
      parsed.push(ev);
    }
    return new Promise<void>((resolve, reject) => {
      const batch: Batch = { remaining: 0, error: null, settled: false, resolve, reject };
      const before = q.ops.length;
      for (const ev of parsed) {
        if (!this.#enqueue(q, ev, batch)) {
          // All or nothing: take back what this batch queued.
          q.ops = [...q.ops.slice(0, before), ...q.ops.slice(before).filter((o) => o.batch !== batch)];
          q.stats.rejected += parsed.length;
          this.#fail(batch, new InputError('QUEUE_FULL', `the input queue of ${pcId} is full`));
          this.#pump(pcId, q);
          return;
        }
      }
      batch.remaining = q.ops.filter((o) => o.batch === batch).length;
      if (batch.remaining === 0) {
        batch.settled = true;
        resolve();
        return;
      }
      this.#pump(pcId, q);
    });
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
    const dropped = q.ops.splice(0);
    for (const op of dropped) {
      if (op.batch) this.#fail(op.batch, new InputError('NOT_OCCUPANT', 'the occupant changed'));
    }
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

  /** Queues a pointer move to (x,y) unless the pointer is already headed there. */
  #moveTo(q: PcQueue, x: number, y: number, batch: Batch | undefined, room: number): boolean {
    const p = this.#clamp(q, x, y);
    const last = q.ops[q.ops.length - 1];
    if (!batch && last?.t === 'move' && !last.batch) {
      last.x = p.x;
      last.y = p.y;
      q.lastPos = p;
      q.stats.coalesced++;
      return true;
    }
    if (!batch && q.lastPos && q.lastPos.x === p.x && q.lastPos.y === p.y) return true;
    if (q.ops.length >= room) return false;
    q.lastPos = p;
    q.ops.push({ t: 'move', ...p, ...(batch ? { batch } : {}) });
    return true;
  }

  #enqueue(q: PcQueue, ev: RouterEvent, batch: Batch | undefined): boolean {
    const cap = this.#maxQueue;
    const full = q.ops.length >= cap;
    const b = batch ? { batch } : {};
    switch (ev.k) {
      case 'move':
        return this.#moveTo(q, ev.x, ev.y, batch, cap);
      case 'scroll': {
        if (!this.#moveTo(q, ev.x, ev.y, batch, cap)) return false;
        const at = this.#clamp(q, ev.x, ev.y);
        const tail = q.ops[q.ops.length - 1];
        if (!batch && tail?.t === 'scroll' && !tail.batch && tail.x === at.x && tail.y === at.y) {
          tail.dx += ev.dx;
          tail.dy += ev.dy;
          q.stats.coalesced++;
          return true;
        }
        if (q.ops.length >= cap) return false;
        q.ops.push({ t: 'scroll', dx: ev.dx, dy: ev.dy, x: at.x, y: at.y, ...b });
        return true;
      }
      case 'button': {
        if (ev.down) {
          if (!this.#moveTo(q, ev.x, ev.y, batch, cap)) return false;
          if (q.ops.length >= cap) return false;
          q.ops.push({ t: 'down', button: ev.button, ...b });
          return true;
        }
        // A button-up gets the release slack: losing it would leave the button stuck.
        const room = cap + RELEASE_SLACK;
        if (q.ops.length >= room) return this.#overflow(q);
        if (!this.#moveTo(q, ev.x, ev.y, batch, room)) return this.#overflow(q);
        q.ops.push({ t: 'up', button: ev.button, ...b });
        return true;
      }
      case 'key': {
        if (ev.down) {
          if (full) return false;
          q.ops.push({ t: 'keydown', key: ev.key, ...b });
          return true;
        }
        if (q.ops.length >= cap + RELEASE_SLACK) return this.#overflow(q);
        q.ops.push({ t: 'keyup', key: ev.key, ...b });
        return true;
      }
      case 'text': {
        const chunks = chunkText(ev.text);
        if (q.ops.length + chunks.length > cap) return false;
        for (const text of chunks) q.ops.push({ t: 'text', text, ...b });
        return true;
      }
      case 'release_all':
        if (batch) return true;
        this.#pushRelease(q);
        return true;
      case 'click': {
        if (q.ops.length >= cap) return false;
        const p = this.#clamp(q, ev.x, ev.y);
        q.lastPos = p;
        q.ops.push({ t: 'click', ...p, button: ev.button, count: ev.count, ...b });
        return true;
      }
      case 'drag': {
        if (q.ops.length >= cap) return false;
        const from = this.#clamp(q, ev.x, ev.y);
        const to = this.#clamp(q, ev.toX, ev.toY);
        q.lastPos = to;
        q.ops.push({ t: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y, ...b });
        return true;
      }
      case 'chord':
        if (full) return false;
        q.ops.push({ t: 'chord', keys: ev.keys, ...b });
        return true;
    }
  }

  /** Flooded with key-ups: drop everything and release whatever is held rather than lose a key-up. */
  #overflow(q: PcQueue): boolean {
    q.stats.overflows++;
    this.#clearAndRelease(q);
    return false;
  }

  #fail(batch: Batch, err: unknown): void {
    if (batch.settled) return;
    batch.settled = true;
    batch.reject(err);
  }

  /** One op of an awaited batch finished. */
  #done(batch: Batch | undefined, err: unknown): void {
    if (!batch || batch.settled) return;
    if (err && !batch.error) batch.error = err;
    batch.remaining--;
    if (batch.remaining > 0) return;
    batch.settled = true;
    if (batch.error) {
      const msg = batch.error instanceof Error ? batch.error.message : String(batch.error);
      batch.reject(new InputError('FAILED', msg));
    } else batch.resolve();
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
          let failure: unknown = null;
          try {
            await this.#call(pcId, q, op);
            q.stats.calls++;
          } catch (err) {
            failure = err;
            q.stats.errors++;
            this.#log?.debug({ pcId, op: op.t, err: String(err) }, 'pc input call failed');
          }
          this.#done(op.batch, failure);
        }
      } finally {
        q.running = false;
        for (const r of q.idle.splice(0)) r();
      }
    })();
  }

  /** Sends key-up / button-up for everything held now; a failed one stays held for the next release. */
  async #release(pcId: string, q: PcQueue): Promise<void> {
    const ops: CallOp[] = [
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

  async #call(pcId: string, q: PcQueue, op: CallOp): Promise<void> {
    try {
      await this.#send(pcId, op);
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
    if (this.#onPointer) {
      if (op.t === 'move' || op.t === 'click') this.#onPointer(pcId, { x: op.x, y: op.y });
      else if (op.t === 'drag') this.#onPointer(pcId, { x: op.toX, y: op.toY });
    }
  }

  async #send(pcId: string, op: CallOp): Promise<void> {
    const timeoutMs = op.t === 'drag' || op.t === 'click' ? this.#callTimeoutMs * 2 : this.#callTimeoutMs;
    await withDeadline(timeoutMs, `pc input ${op.t}`, async (signal) => {
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
        case 'scroll':
          await c.pointerJson(
            JSON.stringify({ scroll: { position: { x: op.x, y: op.y }, deltaX: op.dx, deltaY: op.dy } }),
            o,
          );
          return;
        case 'click':
          await c.pointerJson(
            JSON.stringify({
              click: { position: { x: op.x, y: op.y }, button: BUTTONS[op.button], count: op.count },
            }),
            o,
          );
          return;
        case 'drag':
          if (c.drag) {
            await c.drag(op.x, op.y, op.toX, op.toY, o);
            return;
          }
          await c.pointerJson(JSON.stringify({ move: { position: { x: op.x, y: op.y } } }), o);
          await c.pointerJson(JSON.stringify({ down: { button: BUTTONS.left } }), o);
          try {
            await c.pointerJson(JSON.stringify({ move: { position: { x: op.toX, y: op.toY } } }), o);
          } finally {
            await c.pointerJson(JSON.stringify({ up: { button: BUTTONS.left } }), o);
          }
          return;
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
