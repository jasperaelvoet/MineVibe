import { describe, expect, it } from 'vitest';
import {
  chunkText,
  type InputClient,
  InputError,
  InputRouter,
  MAX_BATCH_EVENTS,
  normalizeKeyName,
  parseInputEvent,
  TEXT_CHUNK,
} from '../../src/pcs/InputRouter.js';

type Call = [string, unknown];

/** A fake spacesd input client; `gate()` holds the next call until released. */
function fakeClient(options: { failPointer?: (json: Record<string, unknown>) => boolean } = {}) {
  const calls: Call[] = [];
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const wait = async () => {
    if (hold) await hold;
  };
  const client: InputClient = {
    pointerJson: async (j) => {
      const json = JSON.parse(j) as Record<string, unknown>;
      calls.push(['pointer', json]);
      await wait();
      if (options.failPointer?.(json)) throw new Error('pointer failed');
      return '{}';
    },
    keyboardJson: async (j) => {
      calls.push(['keyboard', JSON.parse(j)]);
      await wait();
      return '{}';
    },
    typeText: async (t) => {
      calls.push(['type', t]);
      await wait();
    },
    hotkey: async (k) => {
      calls.push(['hotkey', k]);
      await wait();
    },
  };
  return {
    client,
    calls,
    gate() {
      hold = new Promise((r) => {
        release = () => {
          hold = null;
          r();
        };
      });
    },
    open() {
      release?.();
    },
  };
}

const player = { kind: 'player' as const, id: 'jordan' };
const ada = { kind: 'agent' as const, id: 'ada' };

const move = (x: number, y: number) => ({ k: 'move', x, y });
const button = (b: string, down: boolean, x = 0, y = 0) => ({ k: 'button', button: b, down, x, y });
const key = (k: string, down: boolean) => ({ k: 'key', key: k, down });
const text = (t: string) => ({ k: 'text', text: t });

function setup() {
  const f = fakeClient();
  const router = new InputRouter({ getClient: async () => f.client });
  router.setOccupant('linux-1', player);
  return { f, router };
}

describe('pc.input events (T0 objects)', () => {
  it('parses every T0 event and normalizes it', () => {
    expect(parseInputEvent({ k: 'move', x: 10.4, y: 20.6 })).toEqual({ k: 'move', x: 10, y: 21 });
    expect(parseInputEvent({ k: 'button', button: 'left', down: true, x: 1, y: 2 })).toEqual({
      k: 'button',
      button: 'left',
      down: true,
      x: 1,
      y: 2,
    });
    expect(parseInputEvent({ k: 'scroll', dx: 0, dy: -3, x: 5, y: 6 })).toEqual({
      k: 'scroll',
      dx: 0,
      dy: -3,
      x: 5,
      y: 6,
    });
    expect(parseInputEvent({ k: 'key', key: 'KEY_SHIFT', down: true })).toEqual({
      k: 'key',
      key: 'KEY_SHIFT',
      down: true,
    });
    // Friendly names (the T0 schema allows any [A-Za-z0-9_] name) become cua KEY_* names.
    expect(parseInputEvent({ k: 'key', key: 'ctrl', down: false })).toEqual({
      k: 'key',
      key: 'KEY_CONTROL',
      down: false,
    });
    expect(parseInputEvent({ k: 'text', text: 'héllo' })).toEqual({ k: 'text', text: 'héllo' });
    expect(parseInputEvent({ k: 'release_all' })).toEqual({ k: 'release_all' });
  });

  it('rejects malformed ones (and the old tuple format)', () => {
    for (const bad of [
      null,
      ['m', 1, 2],
      { k: 'move', x: 'a', y: 1 },
      { k: 'move', x: 1 },
      { k: 'button', button: 'thumb', down: true, x: 0, y: 0 },
      { k: 'button', button: 'left', x: 0, y: 0 },
      { k: 'key', key: 'notakey', down: true },
      { k: 'key', key: '\u0007', down: true },
      { k: 'text', text: '' },
      { k: 'text', text: 'x'.repeat(20_000) },
      { k: 'scroll', dx: 1e9, dy: 0, x: 0, y: 0 },
      { k: 'move', x: Number.NaN, y: 1 },
      { k: 'zz' },
    ]) {
      expect(parseInputEvent(bad)).toBeNull();
    }
  });

  it('maps key names to cua names', () => {
    expect(normalizeKeyName('KEY_ENTER')).toBe('KEY_ENTER');
    expect(normalizeKeyName('Enter')).toBe('KEY_ENTER');
    expect(normalizeKeyName('return')).toBe('KEY_ENTER');
    expect(normalizeKeyName('ctrl')).toBe('KEY_CONTROL');
    expect(normalizeKeyName('Cmd')).toBe('KEY_META');
    expect(normalizeKeyName('Page Up')).toBe('KEY_PAGE_UP');
    expect(normalizeKeyName('arrow_left')).toBe('KEY_ARROW_LEFT');
    expect(normalizeKeyName('F5')).toBe('KEY_F5');
    expect(normalizeKeyName('f24')).toBe('KEY_F24');
    expect(normalizeKeyName('key_escape')).toBe('KEY_ESCAPE');
    expect(normalizeKeyName('a')).toBe('a');
    expect(normalizeKeyName('é')).toBe('é');
    expect(normalizeKeyName(' ')).toBe('KEY_SPACE');
    expect(normalizeKeyName('plus')).toBe('+');
    expect(normalizeKeyName('hyperdrive')).toBeNull();
    expect(normalizeKeyName('f25')).toBeNull();
  });
});

describe('InputRouter', () => {
  it('obeys only the occupant', async () => {
    const { f, router } = setup();
    expect(router.submit('linux-1', ada, [text('hi')])).toMatchObject({
      accepted: 0,
      reason: 'NOT_OCCUPANT',
    });
    await router.idle('linux-1');
    expect(f.calls).toEqual([]);
  });

  it('maps T0 events to spacesd calls', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [
      move(100, 50),
      button('left', true, 100, 50),
      button('left', false, 100, 50),
      { k: 'scroll', dx: 0, dy: -10, x: 100, y: 50 },
      text('héllo'),
      key('KEY_SHIFT', true),
      key('KEY_SHIFT', false),
    ]);
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['pointer', { move: { position: { x: 100, y: 50 } } }],
      ['pointer', { down: { button: 'MOUSE_BUTTON_LEFT' } }],
      ['pointer', { up: { button: 'MOUSE_BUTTON_LEFT' } }],
      ['pointer', { scroll: { position: { x: 100, y: 50 }, deltaX: 0, deltaY: -10 } }],
      ['type', 'héllo'],
      ['keyboard', { down: { key: { named: 'KEY_SHIFT' } } }],
      ['keyboard', { up: { key: { named: 'KEY_SHIFT' } } }],
    ]);
  });

  it('a button or scroll at a new position moves the pointer there first', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [
      button('right', true, 30, 40),
      button('right', false, 31, 41),
      { k: 'scroll', dx: 0, dy: 2, x: 7, y: 8 },
    ]);
    await router.idle('linux-1');
    expect(f.calls.map(([k, v]) => `${k}:${JSON.stringify(v)}`)).toEqual([
      'pointer:{"move":{"position":{"x":30,"y":40}}}',
      'pointer:{"down":{"button":"MOUSE_BUTTON_RIGHT"}}',
      'pointer:{"move":{"position":{"x":31,"y":41}}}',
      'pointer:{"up":{"button":"MOUSE_BUTTON_RIGHT"}}',
      'pointer:{"move":{"position":{"x":7,"y":8}}}',
      'pointer:{"scroll":{"position":{"x":7,"y":8},"deltaX":0,"deltaY":2}}',
    ]);
  });

  it('a scroll happens at its own position, not where the pointer went after it', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [text('x')]);
    // Scrolling while the mouse moves on: both land in one batch, the move after the scroll.
    router.submit('linux-1', player, [{ k: 'scroll', dx: 0, dy: 3, x: 10, y: 10 }, move(60, 60)]);
    f.open();
    await router.idle('linux-1');
    expect(f.calls.map(([k, v]) => `${k}:${JSON.stringify(v)}`)).toEqual([
      'type:"x"',
      'pointer:{"move":{"position":{"x":10,"y":10}}}',
      'pointer:{"scroll":{"position":{"x":10,"y":10},"deltaX":0,"deltaY":3}}',
      'pointer:{"move":{"position":{"x":60,"y":60}}}',
    ]);
  });

  it('coalesces moves while a call is in flight (only the latest move is kept)', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [move(1, 1)]);
    await Promise.resolve();
    for (let i = 2; i <= 50; i++) router.submit('linux-1', player, [move(i, i)]);
    f.open();
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['pointer', { move: { position: { x: 1, y: 1 } } }],
      ['pointer', { move: { position: { x: 50, y: 50 } } }],
    ]);
    expect(router.stats('linux-1')?.coalesced).toBe(48);
  });

  it('keeps order around clicks: moves coalesce only when adjacent, scrolls add up', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [text('x')]);
    router.submit('linux-1', player, [
      move(1, 1),
      move(2, 2),
      button('left', true, 2, 2),
      move(3, 3),
      move(4, 4),
      button('left', false, 4, 4),
      { k: 'scroll', dx: 0, dy: 1, x: 4, y: 4 },
      { k: 'scroll', dx: 0, dy: 2, x: 4, y: 4 },
    ]);
    f.open();
    await router.idle('linux-1');
    expect(f.calls.map(([k, v]) => `${k}:${JSON.stringify(v)}`)).toEqual([
      'type:"x"',
      'pointer:{"move":{"position":{"x":2,"y":2}}}',
      'pointer:{"down":{"button":"MOUSE_BUTTON_LEFT"}}',
      'pointer:{"move":{"position":{"x":4,"y":4}}}',
      'pointer:{"up":{"button":"MOUSE_BUTTON_LEFT"}}',
      'pointer:{"scroll":{"position":{"x":4,"y":4},"deltaX":0,"deltaY":3}}',
    ]);
  });

  it('tracks held keys and buttons; release_all and releaseAll release all of them', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [
      key('KEY_SHIFT', true),
      key('KEY_CONTROL', true),
      key('KEY_CONTROL', false),
      key('a', true),
      button('right', true),
    ]);
    await router.idle('linux-1');
    expect(router.held('linux-1')).toEqual({ keys: ['KEY_SHIFT', 'a'], buttons: ['right'] });
    f.calls.length = 0;
    router.submit('linux-1', player, [{ k: 'release_all' }]);
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['keyboard', { up: { key: { named: 'KEY_SHIFT' } } }],
      ['keyboard', { up: { key: { character: 'a' } } }],
      ['pointer', { up: { button: 'MOUSE_BUTTON_RIGHT' } }],
    ]);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
    router.submit('linux-1', player, [key('KEY_ALT', true)]);
    await router.idle('linux-1');
    await router.releaseAll('linux-1');
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
  });

  it('an occupant change (kick) drops queued input and releases held keys', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [key('KEY_SHIFT', true)]);
    router.submit('linux-1', player, [text('never typed'), move(9, 9)]);
    router.setOccupant('linux-1', ada);
    f.open();
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['keyboard', { down: { key: { named: 'KEY_SHIFT' } } }],
      ['keyboard', { up: { key: { named: 'KEY_SHIFT' } } }],
    ]);
    expect(router.submit('linux-1', player, [text('x')]).reason).toBe('NOT_OCCUPANT');
    expect(router.submit('linux-1', ada, [text('x')]).accepted).toBe(1);
  });

  it('clamps pointer coordinates to the display', async () => {
    const { f, router } = setup();
    router.setDisplay('linux-1', 1280, 800);
    router.submit('linux-1', player, [move(5000, 900)]);
    await router.idle('linux-1');
    expect(f.calls[0]).toEqual(['pointer', { move: { position: { x: 1279, y: 799 } } }]);
  });

  it('keeps going after a failed call', async () => {
    let n = 0;
    const router = new InputRouter({
      getClient: async () => ({
        pointerJson: async () => {
          n++;
          if (n === 1) throw new Error('boom');
          return '{}';
        },
        keyboardJson: async () => '{}',
        typeText: async () => {},
        hotkey: async () => {},
      }),
    });
    router.setOccupant('p', player);
    router.submit('p', player, [move(3, 3), button('left', true, 3, 3)]);
    await router.idle('p');
    expect(n).toBe(2);
    expect(router.stats('p')).toMatchObject({ errors: 1, calls: 1 });
  });
});

describe('InputRouter.perform (the seated agent)', () => {
  it('resolves once spacesd accepted every call: click counts, drag, chords, text', async () => {
    const f = fakeClient();
    const cursor: unknown[] = [];
    const router = new InputRouter({
      getClient: async () => ({
        ...f.client,
        drag: async (...a) => void f.calls.push(['drag', a.slice(0, 4)]),
      }),
      onPointer: (pcId, pos) => cursor.push([pcId, pos]),
    });
    router.setOccupant('p', ada);
    await router.perform('p', ada, [
      { k: 'click', x: 10, y: 20, button: 'left', count: 2 },
      { k: 'drag', x: 1, y: 2, toX: 30, toY: 40 },
      { k: 'chord', keys: ['ctrl', 'c'] },
      { k: 'chord', keys: ['Enter'] },
      text('ok'),
    ]);
    expect(f.calls).toEqual([
      ['pointer', { click: { position: { x: 10, y: 20 }, button: 'MOUSE_BUTTON_LEFT', count: 2 } }],
      ['drag', [1, 2, 30, 40]],
      ['hotkey', ['KEY_CONTROL', 'c']],
      ['keyboard', { press: { key: { named: 'KEY_ENTER' } } }],
      ['type', 'ok'],
    ]);
    expect(cursor).toEqual([
      ['p', { x: 10, y: 20 }],
      ['p', { x: 30, y: 40 }],
    ]);
  });

  it('drags with down/move/up when the client has no drag', async () => {
    const { f, router } = setup();
    router.setOccupant('linux-1', ada);
    await router.perform('linux-1', ada, [{ k: 'drag', x: 1, y: 2, toX: 3, toY: 4 }]);
    expect(f.calls.map(([, v]) => Object.keys(v as object)[0])).toEqual(['move', 'down', 'move', 'up']);
  });

  it('rejects a caller who is not the occupant, and malformed events, without queueing anything', async () => {
    const { f, router } = setup();
    await expect(router.perform('linux-1', ada, [move(1, 1)])).rejects.toMatchObject({
      code: 'NOT_OCCUPANT',
    });
    router.setOccupant('linux-1', ada);
    await expect(router.perform('linux-1', ada, [move(1, 1), { k: 'warp' }])).rejects.toBeInstanceOf(
      InputError,
    );
    await router.idle('linux-1');
    expect(f.calls).toEqual([]);
  });

  it('a failed call rejects the batch (the rest still runs)', async () => {
    const f = fakeClient({ failPointer: (j) => 'click' in j });
    const router = new InputRouter({ getClient: async () => f.client });
    router.setOccupant('p', ada);
    await expect(
      router.perform('p', ada, [{ k: 'click', x: 1, y: 1, button: 'left', count: 1 }, text('after')]),
    ).rejects.toMatchObject({ code: 'FAILED' });
    expect(f.calls.at(-1)).toEqual(['type', 'after']);
  });

  it('an occupant change while queued rejects the batch and releases what it held', async () => {
    const { f, router } = setup();
    router.setOccupant('linux-1', ada);
    f.gate();
    const first = router.perform('linux-1', ada, [key('KEY_SHIFT', true)]);
    const queued = router.perform('linux-1', ada, [text('never')]);
    router.setOccupant('linux-1', player);
    f.open();
    await first;
    await expect(queued).rejects.toMatchObject({ code: 'NOT_OCCUPANT' });
    await router.idle('linux-1');
    expect(f.calls.map(([k]) => k)).toEqual(['keyboard', 'keyboard']);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
  });

  it('is all or nothing when the queue is full', async () => {
    const f = fakeClient();
    const router = new InputRouter({ getClient: async () => f.client, maxQueue: 3 });
    router.setOccupant('p', ada);
    f.gate();
    void router.perform('p', ada, [text('in flight')]);
    await Promise.resolve();
    await expect(
      router.perform('p', ada, [move(1, 1), move(2, 2), move(3, 3), move(4, 4)]),
    ).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(router.queued('p')).toBe(0);
    f.open();
    await router.idle('p');
  });
});

describe('H2: no stuck keys', () => {
  it('a queued key-up dropped by an occupant change is still released', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [key('KEY_SHIFT', true)]);
    await router.idle('linux-1');
    f.gate();
    router.submit('linux-1', player, [text('slow')]); // in flight
    router.submit('linux-1', player, [key('KEY_SHIFT', false)]); // queued behind it
    router.setOccupant('linux-1', ada); // drops the queued key-up
    f.open();
    await router.idle('linux-1');
    expect(f.calls.map(([k, v]) => `${k}:${JSON.stringify(v)}`)).toEqual([
      'keyboard:{"down":{"key":{"named":"KEY_SHIFT"}}}',
      'type:"slow"',
      'keyboard:{"up":{"key":{"named":"KEY_SHIFT"}}}',
    ]);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
  });

  it('a failed key-up stays held and the next release retries it', async () => {
    let failUps = 1;
    const ups: string[] = [];
    const router = new InputRouter({
      getClient: async () => ({
        pointerJson: async () => '{}',
        keyboardJson: async (j) => {
          const r = JSON.parse(j) as { up?: { key: { named: string } } };
          if (r.up) {
            ups.push(r.up.key.named);
            if (failUps-- > 0) throw new Error('unavailable');
          }
          return '{}';
        },
        typeText: async () => {},
        hotkey: async () => {},
      }),
    });
    router.setOccupant('p', player);
    router.submit('p', player, [key('KEY_CONTROL', true), key('KEY_CONTROL', false)]);
    await router.idle('p');
    expect(router.held('p').keys).toEqual(['KEY_CONTROL']);
    await router.releaseAll('p');
    expect(ups).toEqual(['KEY_CONTROL', 'KEY_CONTROL']);
    expect(router.held('p').keys).toEqual([]);
  });

  it('only accepted key-downs count as held', async () => {
    const { router } = setup();
    router.submit('linux-1', player, [key('KEY_A', true), button('left', true)]);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
    await router.idle('linux-1');
    expect(router.held('linux-1')).toEqual({ keys: ['KEY_A'], buttons: ['left'] });
  });
});

describe('H3: bounded calls, queues and batches', () => {
  it('a hung spacesd call times out and the queue moves on', async () => {
    const calls: string[] = [];
    const router = new InputRouter({
      callTimeoutMs: 50,
      getClient: async () => ({
        pointerJson: async () => {
          calls.push('pointer');
          return new Promise<string>(() => {}); // never answers, ignores the signal
        },
        keyboardJson: async () => {
          calls.push('keyboard');
          return '{}';
        },
        typeText: async () => {},
        hotkey: async () => {},
      }),
    });
    router.setOccupant('p', player);
    router.submit('p', player, [move(1, 1), key('KEY_ENTER', true)]);
    const t0 = Date.now();
    await router.idle('p');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls).toEqual(['pointer', 'keyboard']);
    expect(router.stats('p')).toMatchObject({ errors: 1, calls: 1 });
  });

  it('passes an AbortSignal to every call', async () => {
    const signals: unknown[] = [];
    const router = new InputRouter({
      getClient: async () => ({
        pointerJson: async (_j, o) => {
          signals.push(o?.signal);
          return '{}';
        },
        keyboardJson: async (_j, o) => {
          signals.push(o?.signal);
          return '{}';
        },
        typeText: async (_t, o) => {
          signals.push(o?.signal);
        },
        hotkey: async (_k, o) => {
          signals.push(o?.signal);
        },
      }),
    });
    router.setOccupant('p', player);
    router.submit('p', player, [move(1, 1), key('a', true), text('x')]);
    await router.idle('p');
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('removePc waits at most removeWaitMs for a hung release', async () => {
    let hang = false;
    const router = new InputRouter({
      callTimeoutMs: 10_000,
      removeWaitMs: 50,
      getClient: async () => ({
        pointerJson: async () => '{}',
        keyboardJson: async () => (hang ? new Promise<string>(() => {}) : '{}'),
        typeText: async () => {},
        hotkey: async () => {},
      }),
    });
    router.setOccupant('p', player);
    router.submit('p', player, [key('KEY_SHIFT', true)]);
    await router.idle('p');
    hang = true;
    const t0 = Date.now();
    await router.removePc('p');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(router.occupant('p')).toBeNull();
  });

  it('refuses oversized batches and caps key/button events too', async () => {
    const f = fakeClient();
    const router = new InputRouter({ getClient: async () => f.client, maxQueue: 4 });
    router.setOccupant('p', player);
    const big = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => move(1, 1));
    expect(router.submit('p', player, big)).toMatchObject({ accepted: 0, reason: 'TOO_LARGE' });
    f.gate();
    router.submit('p', player, [text('in flight')]);
    await Promise.resolve();
    const r = router.submit('p', player, [
      key('a', true),
      key('b', true),
      key('c', true),
      key('d', true),
      key('e', true),
      button('left', true),
    ]);
    expect(r).toMatchObject({ accepted: 4, rejected: 2 });
    expect(router.queued('p')).toBe(4);
    // Key-ups get some slack past the cap…
    expect(router.submit('p', player, [key('a', false)]).accepted).toBe(1);
    // …and a flood of them collapses the queue into one release.
    const flood = Array.from({ length: 200 }, () => key('b', false));
    router.submit('p', player, flood);
    expect(router.queued('p')).toBeLessThanOrEqual(4 + 64);
    expect(router.stats('p')?.overflows).toBeGreaterThan(0);
    f.open();
    await router.idle('p');
  });

  it('types long text in chunks of code points', async () => {
    const { f, router } = setup();
    const long = `${'é'.repeat(TEXT_CHUNK - 1)}😀${'x'.repeat(10)}`;
    router.submit('linux-1', player, [text(long)]);
    await router.idle('linux-1');
    const typed = f.calls.filter(([k]) => k === 'type').map(([, v]) => v as string);
    expect(typed).toHaveLength(2);
    expect(typed.join('')).toBe(long);
    expect([...(typed[0] as string)]).toHaveLength(TEXT_CHUNK);
    expect(chunkText('')).toEqual([]);
  });
});

describe('agent input for PC tools V2', () => {
  it('maps xdotool keysyms to cua names', () => {
    expect(normalizeKeyName('Prior')).toBe('KEY_PAGE_UP');
    expect(normalizeKeyName('Next')).toBe('KEY_PAGE_DOWN');
    expect(normalizeKeyName('Page_Down')).toBe('KEY_PAGE_DOWN');
    expect(normalizeKeyName('KP_Enter')).toBe('KEY_NUMPAD_ENTER');
    expect(normalizeKeyName('KP_7')).toBe('KEY_NUMPAD_7');
    expect(normalizeKeyName('Super_L')).toBe('KEY_META_LEFT');
    expect(normalizeKeyName('Control_R')).toBe('KEY_CONTROL_RIGHT');
    expect(normalizeKeyName('bracketleft')).toBe('KEY_BRACKET_LEFT');
    expect(normalizeKeyName('apostrophe')).toBe('KEY_QUOTE');
    expect(normalizeKeyName('grave')).toBe('KEY_BACKQUOTE');
    expect(normalizeKeyName('XF86AudioMute')).toBe('KEY_VOLUME_MUTE');
    expect(normalizeKeyName('XF86Back')).toBe('KEY_BROWSER_BACK');
    expect(normalizeKeyName('BackSpace')).toBe('KEY_BACKSPACE');
  });

  it('parses press, hold, mouse and wheel events, and clicks at the pointer with modifiers', () => {
    expect(parseInputEvent({ k: 'press', key: 'Page_Down', modifiers: ['ctrl'], repeat: 3 })).toEqual({
      k: 'press',
      key: 'KEY_PAGE_DOWN',
      modifiers: ['KEY_CONTROL'],
      repeat: 3,
    });
    expect(parseInputEvent({ k: 'press', key: 'a', modifiers: ['banana'] })).toBeNull();
    expect(parseInputEvent({ k: 'press', key: 'a', repeat: 101 })).toBeNull();
    expect(parseInputEvent({ k: 'hold', keys: ['shift'], ms: 1500 })).toEqual({
      k: 'hold',
      keys: ['KEY_SHIFT'],
      ms: 1500,
    });
    expect(parseInputEvent({ k: 'hold', keys: ['shift'], ms: 400_000 })).toBeNull();
    expect(parseInputEvent({ k: 'mouse', button: 'left', down: true })).toEqual({
      k: 'mouse',
      button: 'left',
      down: true,
    });
    expect(parseInputEvent({ k: 'wheel', dx: 0, dy: 3 })).toEqual({ k: 'wheel', dx: 0, dy: 3 });
    expect(parseInputEvent({ k: 'wheel', dx: 0, dy: 3, x: 1 })).toBeNull();
    expect(parseInputEvent({ k: 'click', button: 'left', count: 3, modifiers: ['ctrl', 'Shift_L'] })).toEqual(
      {
        k: 'click',
        button: 'left',
        count: 3,
        modifiers: ['KEY_CONTROL', 'KEY_SHIFT_LEFT'],
      },
    );
  });

  it('a hold keeps its keys down until its time is up or any release, then lets go', async () => {
    const f = fakeClient();
    const router = new InputRouter({ getClient: async () => f.client });
    router.setOccupant('linux-1', ada);
    const hold = router.perform('linux-1', ada, [{ k: 'hold', keys: ['alt', 'Tab'], ms: 60_000 }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(router.held('linux-1').keys).toEqual(['KEY_ALT', 'KEY_TAB']);
    const t0 = Date.now();
    await router.releaseAll('linux-1');
    await hold;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(router.held('linux-1').keys).toEqual([]);
    expect(f.calls.map(([kind, j]) => `${kind} ${JSON.stringify(j)}`)).toEqual([
      'keyboard {"down":{"key":{"named":"KEY_ALT"}}}',
      'keyboard {"down":{"key":{"named":"KEY_TAB"}}}',
      'keyboard {"up":{"key":{"named":"KEY_TAB"}}}',
      'keyboard {"up":{"key":{"named":"KEY_ALT"}}}',
    ]);
  });

  it('a mouse button pressed where the pointer is stays held until released, and a release lets it go', async () => {
    const f = fakeClient();
    const router = new InputRouter({ getClient: async () => f.client });
    router.setOccupant('linux-1', ada);
    await router.perform('linux-1', ada, [{ k: 'mouse', button: 'left', down: true }]);
    expect(router.held('linux-1').buttons).toEqual(['left']);
    await router.releaseAll('linux-1');
    expect(router.held('linux-1').buttons).toEqual([]);
    expect(f.calls.at(-1)).toEqual(['pointer', { up: { button: 'MOUSE_BUTTON_LEFT' } }]);
  });
});

describe('macOS guests (no key or button down/up in spacesd)', () => {
  function macSetup() {
    const f = fakeClient();
    let now = 1_000;
    const pointers: { x: number; y: number }[] = [];
    const router = new InputRouter({
      getClient: async () => f.client,
      osOf: (id) => (id.startsWith('mac') ? 'macos' : 'linux'),
      now: () => now,
      onPointer: (_id, p) => void pointers.push(p),
    });
    router.setOccupant('mac-1', player);
    return {
      f,
      router,
      pointers,
      tick: (ms: number) => {
        now += ms;
      },
    };
  }

  it('keys: a key-down presses with the modifiers held; ups and modifiers alone send nothing', async () => {
    const { f, router } = macSetup();
    router.submit('mac-1', player, [
      text('echo hi'),
      key('KEY_ENTER', true),
      key('KEY_ENTER', false),
      key('KEY_META', true),
      key('q', true),
      key('q', false),
      key('KEY_META', false),
      key('KEY_SHIFT', true),
      key('KEY_SHIFT', false),
    ]);
    await router.idle('mac-1');
    expect(f.calls).toEqual([
      ['type', 'echo hi'],
      ['keyboard', { press: { key: { named: 'KEY_ENTER' } } }],
      ['keyboard', { press: { key: { character: 'q' }, modifiers: ['KEY_META'] } }],
    ]);
    expect(router.held('mac-1')).toEqual({ keys: [], buttons: [] });
    // A held key's repeats arrive as more key-downs: each presses again.
    router.submit('mac-1', player, [key('KEY_BACKSPACE', true), key('KEY_BACKSPACE', true)]);
    await router.idle('mac-1');
    expect(f.calls.filter(([, j]) => JSON.stringify(j).includes('KEY_BACKSPACE'))).toHaveLength(2);
  });

  it('buttons: a click where it went down, double clicks counted, a move while down makes a drag', async () => {
    const { f, router, pointers, tick } = macSetup();
    router.submit('mac-1', player, [button('left', true, 100, 100), button('left', false, 100, 100)]);
    await router.idle('mac-1');
    tick(200);
    router.submit('mac-1', player, [button('left', true, 101, 100), button('left', false, 101, 100)]);
    await router.idle('mac-1');
    const clicks = f.calls.filter(([, j]) => 'click' in (j as object)).map(([, j]) => j);
    expect(clicks).toEqual([
      { click: { position: { x: 100, y: 100 }, button: 'MOUSE_BUTTON_LEFT', count: 1 } },
      { click: { position: { x: 101, y: 100 }, button: 'MOUSE_BUTTON_LEFT', count: 2 } },
    ]);
    // Too late for a double click: one again, with the modifier held.
    tick(2_000);
    f.calls.length = 0;
    router.submit('mac-1', player, [
      key('KEY_SHIFT', true),
      button('left', true, 101, 100),
      button('left', false, 101, 100),
      key('KEY_SHIFT', false),
    ]);
    await router.idle('mac-1');
    expect(f.calls).toEqual([
      [
        'pointer',
        {
          click: {
            position: { x: 101, y: 100 },
            button: 'MOUSE_BUTTON_LEFT',
            count: 1,
            modifiers: ['KEY_SHIFT'],
          },
        },
      ],
    ]);
    // A drag: moves while the button is down are not sent; the up drags from where it went down.
    f.calls.length = 0;
    router.submit('mac-1', player, [
      move(200, 200),
      button('right', true, 200, 200),
      move(220, 210),
      move(260, 240),
      button('right', false, 260, 240),
      move(300, 300),
    ]);
    await router.idle('mac-1');
    expect(f.calls).toEqual([
      ['pointer', { move: { position: { x: 200, y: 200 } } }],
      [
        'pointer',
        { drag: { from: { x: 200, y: 200 }, to: { x: 260, y: 240 }, button: 'MOUSE_BUTTON_RIGHT' } },
      ],
      ['pointer', { move: { position: { x: 300, y: 300 } } }],
    ]);
    expect(pointers.at(-1)).toEqual({ x: 300, y: 300 });
    expect(router.held('mac-1')).toEqual({ keys: [], buttons: [] });
  });

  it('a release forgets a held button and modifiers without clicking; Linux PCs keep downs and ups', async () => {
    const { f, router } = macSetup();
    router.submit('mac-1', player, [key('KEY_META', true), button('left', true, 50, 50)]);
    await router.idle('mac-1');
    expect(router.held('mac-1')).toEqual({ keys: ['KEY_META'], buttons: ['left'] });
    await router.releaseAll('mac-1');
    expect(router.held('mac-1')).toEqual({ keys: [], buttons: [] });
    router.submit('mac-1', player, [button('left', false, 50, 50), key('a', true)]);
    await router.idle('mac-1');
    expect(f.calls.filter(([, j]) => 'click' in (j as object) || 'drag' in (j as object))).toEqual([]);
    expect(f.calls.at(-1)).toEqual(['keyboard', { press: { key: { character: 'a' } } }]);
    router.setOccupant('linux-1', player);
    router.submit('linux-1', player, [key('KEY_META', true), key('KEY_META', false)]);
    await router.idle('linux-1');
    expect(f.calls.slice(-2)).toEqual([
      ['keyboard', { down: { key: { named: 'KEY_META' } } }],
      ['keyboard', { up: { key: { named: 'KEY_META' } } }],
    ]);
  });

  it("an agent's drag and click keep their own modifiers; a drag uses spacesd's drag", async () => {
    const { f, router } = macSetup();
    router.setOccupant('mac-1', ada);
    await router.perform('mac-1', ada, [
      { k: 'drag', x: 10, y: 10, toX: 90, toY: 40, modifiers: ['alt'] },
      { k: 'click', x: 5, y: 6, button: 'left', count: 2 },
    ]);
    expect(f.calls).toEqual([
      [
        'pointer',
        {
          drag: {
            from: { x: 10, y: 10 },
            to: { x: 90, y: 40 },
            button: 'MOUSE_BUTTON_LEFT',
            modifiers: ['KEY_ALT'],
          },
        },
      ],
      ['pointer', { click: { position: { x: 5, y: 6 }, button: 'MOUSE_BUTTON_LEFT', count: 2 } }],
    ]);
  });
});
