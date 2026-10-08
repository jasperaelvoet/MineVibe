import { describe, expect, it } from 'vitest';
import {
  chunkText,
  type InputClient,
  InputRouter,
  MAX_BATCH_EVENTS,
  parseInputEvent,
  splitChord,
  TEXT_CHUNK,
} from '../../src/pcs/InputRouter.js';

type Call = [string, unknown];

/** A fake spacesd input client; `gate()` holds the next call until released. */
function fakeClient() {
  const calls: Call[] = [];
  let hold: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const wait = async () => {
    if (hold) await hold;
  };
  const client: InputClient = {
    pointerJson: async (j) => {
      calls.push(['pointer', JSON.parse(j)]);
      await wait();
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

const player = { kind: 'player' as const, id: 'jasper' };
const ada = { kind: 'agent' as const, id: 'ada' };

function setup() {
  const f = fakeClient();
  const router = new InputRouter({ getClient: async () => f.client });
  router.setOccupant('linux-1', player);
  return { f, router };
}

describe('pc.input tuples', () => {
  it('parses the PLAN §5 tuples', () => {
    expect(parseInputEvent(['m', 10.4, 20.6])).toEqual(['m', 10, 21]);
    expect(parseInputEvent(['bd', 'left'])).toEqual(['bd', 'left']);
    expect(parseInputEvent(['bu', 'right'])).toEqual(['bu', 'right']);
    expect(parseInputEvent(['s', 0, -3])).toEqual(['s', 0, -3]);
    expect(parseInputEvent(['t', 'héllo'])).toEqual(['t', 'héllo']);
    expect(parseInputEvent(['kd', 'KEY_SHIFT'])).toEqual(['kd', 'KEY_SHIFT']);
    expect(parseInputEvent(['ku', 'a'])).toEqual(['ku', 'a']);
    expect(parseInputEvent(['k', 'ctrl+c'])).toEqual(['k', 'ctrl+c']);
  });

  it('rejects malformed ones', () => {
    for (const bad of [
      null,
      ['m', 'x', 1],
      ['m', 1],
      ['bd', 'thumb'],
      ['kd', 'shift'],
      ['kd', '\u0007'],
      ['t', ''],
      ['t', 'x'.repeat(5000)],
      ['k', 'ctrl+'],
      ['zz', 1, 2],
      ['m', Number.NaN, 1],
    ]) {
      expect(parseInputEvent(bad)).toBeNull();
    }
  });

  it('splits chords, including a literal plus', () => {
    expect(splitChord('ctrl+shift+t')).toEqual(['ctrl', 'shift', 't']);
    expect(splitChord('ctrl++')).toEqual(['ctrl', '+']);
    expect(splitChord('KEY_LEFTMETA+KEY_L')).toEqual(['KEY_LEFTMETA', 'KEY_L']);
  });
});

describe('InputRouter', () => {
  it('obeys only the occupant', async () => {
    const { f, router } = setup();
    expect(router.submit('linux-1', ada, [['t', 'hi']])).toMatchObject({
      accepted: 0,
      reason: 'NOT_OCCUPANT',
    });
    await router.idle('linux-1');
    expect(f.calls).toEqual([]);
  });

  it('maps tuples to spacesd calls', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [
      ['m', 100, 50],
      ['bd', 'left'],
      ['bu', 'left'],
      ['s', 0, -10],
      ['t', 'héllo'],
      ['kd', 'KEY_SHIFT'],
      ['ku', 'KEY_SHIFT'],
      ['k', 'ctrl+c'],
      ['k', 'KEY_ENTER'],
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
      ['hotkey', ['ctrl', 'c']],
      ['keyboard', { press: { key: { named: 'KEY_ENTER' } } }],
    ]);
  });

  it('coalesces moves while a call is in flight (only the latest move is kept)', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [['m', 1, 1]]);
    await Promise.resolve();
    for (let i = 2; i <= 50; i++) router.submit('linux-1', player, [['m', i, i]]);
    f.open();
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['pointer', { move: { position: { x: 1, y: 1 } } }],
      ['pointer', { move: { position: { x: 50, y: 50 } } }],
    ]);
    expect(router.stats('linux-1')?.coalesced).toBe(48);
  });

  it('keeps order around clicks: moves coalesce only when adjacent', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [['t', 'x']]);
    router.submit('linux-1', player, [
      ['m', 1, 1],
      ['m', 2, 2],
      ['bd', 'left'],
      ['m', 3, 3],
      ['m', 4, 4],
      ['bu', 'left'],
      ['s', 0, 1],
      ['s', 0, 2],
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

  it('tracks held keys and buttons and releases all of them', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [
      ['kd', 'KEY_SHIFT'],
      ['kd', 'KEY_LEFTCTRL'],
      ['ku', 'KEY_LEFTCTRL'],
      ['kd', 'a'],
      ['bd', 'right'],
    ]);
    await router.idle('linux-1');
    expect(router.held('linux-1')).toEqual({ keys: ['KEY_SHIFT', 'a'], buttons: ['right'] });
    f.calls.length = 0;
    await router.releaseAll('linux-1');
    expect(f.calls).toEqual([
      ['keyboard', { up: { key: { named: 'KEY_SHIFT' } } }],
      ['keyboard', { up: { key: { character: 'a' } } }],
      ['pointer', { up: { button: 'MOUSE_BUTTON_RIGHT' } }],
    ]);
    expect(router.held('linux-1')).toEqual({ keys: [], buttons: [] });
  });

  it('an occupant change (kick) drops queued input and releases held keys', async () => {
    const { f, router } = setup();
    f.gate();
    router.submit('linux-1', player, [['kd', 'KEY_SHIFT']]);
    router.submit('linux-1', player, [
      ['t', 'never typed'],
      ['m', 9, 9],
    ]);
    router.setOccupant('linux-1', ada);
    f.open();
    await router.idle('linux-1');
    expect(f.calls).toEqual([
      ['keyboard', { down: { key: { named: 'KEY_SHIFT' } } }],
      ['keyboard', { up: { key: { named: 'KEY_SHIFT' } } }],
    ]);
    expect(router.submit('linux-1', player, [['t', 'x']]).reason).toBe('NOT_OCCUPANT');
    expect(router.submit('linux-1', ada, [['t', 'x']]).accepted).toBe(1);
  });

  it('clamps pointer coordinates to the display', async () => {
    const { f, router } = setup();
    router.setDisplay('linux-1', 1280, 800);
    router.submit('linux-1', player, [['m', 5000, -20]]);
    await router.idle('linux-1');
    expect(f.calls[0]).toEqual(['pointer', { move: { position: { x: 1279, y: 0 } } }]);
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
    router.submit('p', player, [
      ['bd', 'left'],
      ['bu', 'left'],
    ]);
    await router.idle('p');
    expect(n).toBe(2);
    expect(router.stats('p')).toMatchObject({ errors: 1, calls: 1 });
  });
});

describe('H2: no stuck keys', () => {
  it('a queued key-up dropped by an occupant change is still released', async () => {
    const { f, router } = setup();
    router.submit('linux-1', player, [['kd', 'KEY_SHIFT']]);
    await router.idle('linux-1');
    f.gate();
    router.submit('linux-1', player, [['t', 'slow']]); // in flight
    router.submit('linux-1', player, [['ku', 'KEY_SHIFT']]); // queued behind it
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
    router.submit('p', player, [
      ['kd', 'KEY_LEFTCTRL'],
      ['ku', 'KEY_LEFTCTRL'],
    ]);
    await router.idle('p');
    expect(router.held('p').keys).toEqual(['KEY_LEFTCTRL']);
    await router.releaseAll('p');
    expect(ups).toEqual(['KEY_LEFTCTRL', 'KEY_LEFTCTRL']);
    expect(router.held('p').keys).toEqual([]);
  });

  it('only accepted key-downs count as held', async () => {
    const { router } = setup();
    router.submit('linux-1', player, [
      ['kd', 'KEY_A'],
      ['bd', 'left'],
    ]);
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
    router.submit('p', player, [
      ['m', 1, 1],
      ['k', 'KEY_ENTER'],
    ]);
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
    router.submit('p', player, [
      ['m', 1, 1],
      ['kd', 'a'],
      ['t', 'x'],
      ['k', 'ctrl+c'],
    ]);
    await router.idle('p');
    expect(signals).toHaveLength(4);
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
    router.submit('p', player, [['kd', 'KEY_SHIFT']]);
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
    const big = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ['m', 1, 1]);
    expect(router.submit('p', player, big)).toMatchObject({ accepted: 0, reason: 'TOO_LARGE' });
    f.gate();
    router.submit('p', player, [['t', 'in flight']]);
    await Promise.resolve();
    const r = router.submit('p', player, [
      ['kd', 'a'],
      ['kd', 'b'],
      ['kd', 'c'],
      ['kd', 'd'],
      ['kd', 'e'],
      ['bd', 'left'],
    ]);
    expect(r).toMatchObject({ accepted: 4, rejected: 2 });
    expect(router.queued('p')).toBe(4);
    // Key-ups get some slack past the cap…
    expect(router.submit('p', player, [['ku', 'a']]).accepted).toBe(1);
    // …and a flood of them collapses the queue into one release.
    const flood = Array.from({ length: 200 }, () => ['ku', 'b']);
    router.submit('p', player, flood);
    expect(router.queued('p')).toBeLessThanOrEqual(4 + 64);
    expect(router.stats('p')?.overflows).toBeGreaterThan(0);
    f.open();
    await router.idle('p');
  });

  it('types long text in chunks of code points', async () => {
    const { f, router } = setup();
    const text = `${'é'.repeat(TEXT_CHUNK - 1)}😀${'x'.repeat(10)}`;
    router.submit('linux-1', player, [['t', text]]);
    await router.idle('linux-1');
    const typed = f.calls.filter(([k]) => k === 'type').map(([, v]) => v as string);
    expect(typed).toHaveLength(2);
    expect(typed.join('')).toBe(text);
    expect([...(typed[0] as string)]).toHaveLength(TEXT_CHUNK);
    expect(chunkText('')).toEqual([]);
  });
});
