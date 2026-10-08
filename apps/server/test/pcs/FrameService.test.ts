import { decodeFrame, FrameCodec, FrameFlag } from '@minevibe/protocol';
import { describe, expect, it } from 'vitest';
import {
  BGRA_REQUEST_JSON,
  backoff,
  type Clock,
  DEFAULT_RATES,
  type FrameClient,
  FrameService,
  type MediaFrameLike,
  visibleRate,
} from '../../src/pcs/FrameService.js';

/** Deterministic timers: `advance(ms)` runs due callbacks in order and flushes promises in between. */
class FakeClock implements Clock {
  t = 0;
  #id = 0;
  timers: { id: number; at: number; fn: () => void }[] = [];
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.#id;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await flush();
  }
}
const flush = () => new Promise<void>((r) => setImmediate(r));

const JPEG = 1;
function jpeg(n: number): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n & 0xff, 0, 0, 0]).buffer;
}

function fakeClient() {
  const shots: { maxDimension?: number; format?: number; includeCursor: boolean }[] = [];
  let shotN = 0;
  let sameImage = false;
  const controls: string[] = [];
  let sink: { onFrame(f: MediaFrameLike): void; onEvent(e: { kind: string; json: string }): void } | null =
    null;
  let mediaOpts: unknown = null;
  let mediaClosed = 0;
  let mediaFails = 0;
  let mediaOpens = 0;
  let shotFails = false;
  let cursor = { x: 1, y: 2 };
  let cursorCalls = 0;
  const client: FrameClient = {
    screenshot: async (o) => {
      shots.push(o);
      if (shotFails) throw new Error('connection refused');
      if (!sameImage) shotN++;
      const d = o.maxDimension === 640 ? 0.5 : o.maxDimension === 960 ? 0.75 : 1;
      return { image: jpeg(shotN), width: Math.round(1280 * d), height: Math.round(800 * d) };
    },
    openMedia: async (o, s) => {
      mediaOpens++;
      if (mediaFails > 0) {
        mediaFails--;
        throw new Error('media refused');
      }
      mediaOpts = o;
      sink = s;
      return {
        close: async () => {
          mediaClosed++;
        },
        codec: () => 'bgra',
        sessionId: () => 'sess-1',
        sendControl: (j) => controls.push(j),
      };
    },
    cursorPosition: async () => {
      cursorCalls++;
      if (shotFails) throw new Error('connection refused');
      return cursor;
    },
  };
  return {
    client,
    shots,
    controls,
    get sink() {
      return sink;
    },
    get mediaOpts() {
      return mediaOpts;
    },
    get mediaClosed() {
      return mediaClosed;
    },
    get cursorCalls() {
      return cursorCalls;
    },
    get mediaOpens() {
      return mediaOpens;
    },
    failShots(v: boolean) {
      shotFails = v;
    },
    setSame(v: boolean) {
      sameImage = v;
    },
    setCursor(p: { x: number; y: number }) {
      cursor = p;
    },
    failMedia(times = 1_000_000) {
      mediaFails = times;
    },
  };
}

function setup(opts: { autoAck?: boolean; sinkOk?: boolean } = {}) {
  const clock = new FakeClock();
  const f = fakeClient();
  const sent: Uint8Array[] = [];
  const cursors: { x: number; y: number }[] = [];
  const sink = { ok: opts.sinkOk !== false };
  const slots = new Map<string, number>([['linux-1', 7]]);
  const svc = new FrameService({
    sink: {
      sendFrame: (frame) => {
        if (!sink.ok) return false;
        sent.push(frame);
        return true;
      },
    },
    getClient: async () => f.client,
    slotOf: (id) => slots.get(id),
    jpegFormat: JPEG,
    clock,
    onCursor: (_id, p) => cursors.push(p),
  });
  const ackAll = () => {
    for (const fr of sent) svc.ack(7, decodeFrame(fr).header.seq);
  };
  return { clock, f, sent, svc, cursors, ackAll, sink, slots };
}

describe('tier rates (PLAN §8.4)', () => {
  it('visible = JPEG 640 at 2–4 fps; agent seated = JPEG 960 at 4–8 fps', () => {
    expect(visibleRate({ mode: 'visible' }, DEFAULT_RATES)).toEqual({ fps: 3, maxDimension: 640 });
    expect(visibleRate({ mode: 'visible', px: 100 }, DEFAULT_RATES)).toEqual({ fps: 2, maxDimension: 640 });
    expect(visibleRate({ mode: 'visible', px: 500 }, DEFAULT_RATES)).toEqual({ fps: 4, maxDimension: 640 });
    expect(visibleRate({ mode: 'visible', agentSeated: true, px: 500 }, DEFAULT_RATES)).toEqual({
      fps: 8,
      maxDimension: 960,
    });
    expect(visibleRate({ mode: 'visible', agentSeated: true, px: 10 }, DEFAULT_RATES)).toEqual({
      fps: 4,
      maxDimension: 960,
    });
  });
});

describe('FrameService scheduling (fake clock)', () => {
  it('none = 0 fps', async () => {
    const { clock, f, svc } = setup();
    svc.setTier('linux-1', { mode: 'none' });
    await clock.advance(5000);
    expect(f.shots).toHaveLength(0);
  });

  it('visible polls JPEG 640 at its rate and emits MVF1 JPEG frames', async () => {
    const { clock, f, sent, svc, ackAll } = setup();
    svc.setTier('linux-1', { mode: 'visible', px: 500 }); // 4 fps
    for (let i = 0; i < 20; i++) {
      await clock.advance(100);
      ackAll();
    }
    expect(f.shots.length).toBeGreaterThanOrEqual(8);
    expect(f.shots.length).toBeLessThanOrEqual(9);
    expect(
      f.shots.every((s) => s.maxDimension === 640 && s.format === JPEG && s.includeCursor === false),
    ).toBe(true);
    const fr = decodeFrame(sent[0] as Uint8Array);
    expect(fr.header).toMatchObject({
      codec: FrameCodec.JPEG,
      pcSlot: 7,
      seq: 1,
      w: 640,
      h: 400,
      flags: FrameFlag.FULL,
    });
    expect(decodeFrame(sent[1] as Uint8Array).header.seq).toBe(2);
  });

  it('agent seated: JPEG 960 at up to 8 fps', async () => {
    const { clock, f, svc, ackAll } = setup();
    svc.setTier('linux-1', { mode: 'visible', agentSeated: true, px: 800 });
    for (let i = 0; i < 10; i++) {
      await clock.advance(100);
      ackAll();
    }
    expect(f.shots.length).toBeGreaterThanOrEqual(8);
    expect(f.shots.length).toBeLessThanOrEqual(9);
    expect(f.shots[0]?.maxDimension).toBe(960);
  });

  it('a rate change inside the visible tier needs no restart', async () => {
    const { clock, f, svc, ackAll } = setup();
    svc.setTier('linux-1', { mode: 'visible', px: 10 }); // 2 fps
    await clock.advance(1000);
    ackAll();
    const before = f.shots.length;
    svc.setTier('linux-1', { mode: 'visible', agentSeated: true, px: 800 }); // 8 fps
    for (let i = 0; i < 10; i++) {
      await clock.advance(100);
      ackAll();
    }
    expect(f.shots.length - before).toBeGreaterThanOrEqual(7);
  });

  it('does not resend an unchanged image', async () => {
    const { clock, f, sent, svc, ackAll } = setup();
    f.setSame(true);
    svc.setTier('linux-1', { mode: 'visible' });
    for (let i = 0; i < 10; i++) {
      await clock.advance(200);
      ackAll();
    }
    expect(f.shots.length).toBeGreaterThan(3);
    expect(sent).toHaveLength(1);
    expect(svc.stats('linux-1')?.unchanged).toBe(f.shots.length - 1);
  });

  it('keeps at most 2 unacked frames per PC; the latest pending frame wins', async () => {
    const { clock, sent, svc } = setup();
    svc.setTier('linux-1', { mode: 'visible', agentSeated: true, px: 800 }); // 8 fps, never acked
    await clock.advance(600);
    expect(sent).toHaveLength(2);
    expect(svc.unackedCount('linux-1')).toBe(2);
    const st = svc.stats('linux-1');
    expect(st?.superseded).toBeGreaterThan(0);
    // Ack the second frame: the newest pending frame goes out next (not the oldest).
    svc.ack(7, 2);
    const last = decodeFrame(sent.at(-1) as Uint8Array).header.seq;
    expect(last).toBeGreaterThan(3);
    expect(sent).toHaveLength(3);
  });

  it('a lost ack stops blocking after the ack timeout', async () => {
    const { clock, sent, svc } = setup();
    svc.setTier('linux-1', { mode: 'visible', agentSeated: true, px: 800 });
    await clock.advance(500);
    expect(sent).toHaveLength(2);
    await clock.advance(1000);
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it('frames skipped by the sink do not count as unacked', async () => {
    const { clock, svc } = setup({ sinkOk: false });
    svc.setTier('linux-1', { mode: 'visible', px: 500 });
    await clock.advance(1000);
    expect(svc.unackedCount('linux-1')).toBe(0);
    expect(svc.stats('linux-1')?.sinkSkipped).toBeGreaterThan(2);
  });

  it('focus opens a BGRA media session, sends BGRA8 frames and acks the guest like the viewer', async () => {
    const { clock, f, sent, svc } = setup();
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(1);
    expect(f.mediaOpts).toMatchObject({
      maxFps: 30,
      audio: false,
      disableVideo: false,
      requestJson: BGRA_REQUEST_JSON,
    });
    const w = 4;
    const h = 2;
    f.sink?.onFrame({
      sequence: 41n,
      codec: 'bgra',
      width: w,
      height: h,
      data: new Uint8Array(w * h * 4).fill(9).buffer,
    });
    expect(sent).toHaveLength(1);
    const fr = decodeFrame(sent[0] as Uint8Array);
    expect(fr.header).toMatchObject({ codec: FrameCodec.BGRA8, w, h, pcSlot: 7 });
    expect(fr.payload[0]).toBe(9);
    expect(JSON.parse(f.controls[0] as string)).toEqual({
      type: 'frame_ack',
      payload: { session_id: 'sess-1', sequence: 41, decode_queue: 0 },
    });
    // A wrong-sized payload is dropped.
    f.sink?.onFrame({ sequence: 42n, codec: 'bgra', width: w, height: h, data: new ArrayBuffer(3) });
    expect(sent).toHaveLength(1);
    // No JPEG polling while the stream works.
    await clock.advance(2000);
    expect(f.shots).toHaveLength(0);
  });

  it('leaving focus closes the media session and stops the work', async () => {
    const { clock, f, svc } = setup();
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(1);
    svc.setTier('linux-1', { mode: 'none' });
    await clock.advance(1);
    expect(f.mediaClosed).toBe(1);
    const calls = f.cursorCalls;
    await clock.advance(3000);
    expect(f.cursorCalls).toBe(calls);
  });

  it('falls back to JPEG 1280 polling when the media stream cannot open', async () => {
    const { clock, f, svc } = setup();
    f.failMedia();
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(1000);
    expect(f.shots.length).toBeGreaterThan(0);
    expect(f.shots[0]?.maxDimension).toBe(1280);
  });

  it('polls the cursor separately at a low rate and reports only changes', async () => {
    const { clock, f, svc, cursors } = setup();
    svc.setTier('linux-1', { mode: 'visible' });
    await clock.advance(1000);
    expect(f.cursorCalls).toBeGreaterThanOrEqual(4);
    expect(f.cursorCalls).toBeLessThanOrEqual(5);
    expect(cursors).toEqual([{ x: 1, y: 2 }]);
    f.setCursor({ x: 30, y: 40 });
    await clock.advance(500);
    expect(cursors).toEqual([
      { x: 1, y: 2 },
      { x: 30, y: 40 },
    ]);
  });

  it('produces nothing for a PC without a slot', async () => {
    const { clock, sent, svc } = setup();
    svc.setTier('unknown', { mode: 'visible' });
    await clock.advance(1000);
    expect(sent).toHaveLength(0);
  });
});

describe('M3: backpressure keeps the newest frame', () => {
  it('a frame the sink skipped stays pending and goes out when the sink recovers', async () => {
    const { clock, f, sent, svc, sink } = setup({ sinkOk: false });
    f.setSame(true); // a single, unchanging image: no new frame will replace the skipped one
    svc.setTier('linux-1', { mode: 'visible', px: 500 });
    await clock.advance(1000);
    expect(sent).toHaveLength(0);
    expect(svc.stats('linux-1')?.sinkSkipped).toBeGreaterThan(1);
    sink.ok = true;
    await clock.advance(1100);
    expect(sent).toHaveLength(1);
    expect(decodeFrame(sent[0] as Uint8Array).header.codec).toBe(FrameCodec.JPEG);
  });

  it('a damage-driven BGRA frame skipped by the sink is delivered without new damage', async () => {
    const { clock, f, sent, svc, sink } = setup();
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(1);
    sink.ok = false;
    f.sink?.onFrame({
      sequence: 1n,
      codec: 'bgra',
      width: 2,
      height: 1,
      data: new Uint8Array(8).fill(5).buffer,
    });
    expect(sent).toHaveLength(0);
    sink.ok = true;
    await clock.advance(200);
    expect(sent).toHaveLength(1);
    expect(decodeFrame(sent[0] as Uint8Array).payload[0]).toBe(5);
  });
});

describe('M4: focus retries and backoff', () => {
  it('retries BGRA with backoff after an early openMedia failure and stops JPEG once it works', async () => {
    const { clock, f, svc } = setup();
    f.failMedia(2);
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(500);
    expect(f.mediaOpens).toBe(1);
    expect(f.shots.length).toBeGreaterThan(0); // JPEG meanwhile
    await clock.advance(1000); // retry 1 (1 s) fails
    expect(f.mediaOpens).toBe(2);
    await clock.advance(2000); // retry 2 (2 s) succeeds
    expect(f.mediaOpens).toBe(3);
    const shots = f.shots.length;
    await clock.advance(3000);
    expect(f.shots.length - shots).toBeLessThanOrEqual(1);
    expect(f.mediaOpens).toBe(3);
  });

  it('reopens a session exactly once when it reports both close and error', async () => {
    const { clock, f, svc } = setup();
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(1);
    expect(f.mediaOpens).toBe(1);
    f.sink?.onEvent({ kind: 'closed', json: '{}' });
    f.sink?.onEvent({ kind: 'error', json: '{}' });
    f.sink?.onEvent({ kind: 'disconnected', json: '{}' });
    await clock.advance(2000);
    expect(f.mediaOpens).toBe(2);
    expect(svc.stats('linux-1')?.mediaOpens).toBe(2);
  });

  it('backs off on a PC that keeps failing instead of hammering it', async () => {
    const { clock, f, svc } = setup();
    f.failMedia();
    f.failShots(true);
    svc.setTier('linux-1', { mode: 'focus' });
    await clock.advance(10_000);
    // 15 fps JPEG + 4 Hz cursor would be ~190 calls in 10 s.
    expect(f.shots.length).toBeLessThan(15);
    expect(f.cursorCalls).toBeLessThan(15);
    expect(f.mediaOpens).toBeLessThanOrEqual(5);
    expect(backoff(100, 0)).toBe(100);
    expect(backoff(100, 3)).toBe(800);
    expect(backoff(100, 20)).toBe(5000);
  });

  it('parks a PC without a slot (no calls at all) until wake', async () => {
    const { clock, f, svc, slots, ackAll } = setup();
    slots.delete('linux-1');
    svc.setTier('linux-1', { mode: 'visible', px: 500 });
    await clock.advance(3000);
    expect(f.shots).toHaveLength(0);
    expect(f.cursorCalls).toBe(0);
    expect(svc.isParked('linux-1')).toBe(true);
    slots.set('linux-1', 7);
    svc.wake('linux-1');
    for (let i = 0; i < 10; i++) {
      await clock.advance(100);
      ackAll();
    }
    expect(f.shots.length).toBeGreaterThanOrEqual(4);
    expect(svc.isParked('linux-1')).toBe(false);
  });

  it('passes an AbortSignal and times out a hung screenshot', async () => {
    const clock = new FakeClock();
    const signals: unknown[] = [];
    const svc = new FrameService({
      sink: { sendFrame: () => true },
      getClient: async () => ({
        screenshot: (_o, opts) => {
          signals.push(opts?.signal);
          return new Promise(() => {});
        },
        openMedia: async () => {
          throw new Error('no');
        },
        cursorPosition: async () => ({ x: 0, y: 0 }),
      }),
      slotOf: () => 1,
      jpegFormat: JPEG,
      clock,
      callTimeoutMs: 20,
    });
    svc.setTier('p', { mode: 'visible' });
    await clock.advance(1);
    await new Promise((r) => setTimeout(r, 60));
    await clock.advance(5000);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(svc.stats('p')?.errors).toBeGreaterThan(0);
    await svc.close();
  });
});
