import { createHash } from 'node:crypto';
import { encodeFrame, FrameCodec, FrameFlag, FrameKind } from '@minevibe/protocol';
import type { Logger } from 'pino';

/**
 * PC screen frames for the mod (PLAN §5, §8.4, §8.6).
 *
 * | Tier                               | Source                                   | Rate          |
 * |------------------------------------|------------------------------------------|---------------|
 * | focus (seated / watching)          | spacesd `openMedia`, BGRA, sent as BGRA8 | ≤ 30 fps      |
 * | visible, agent seated, player near | unary JPEG screenshots, max dim 960      | 4–8 fps       |
 * | visible within 32 blocks           | unary JPEG screenshots, max dim 640      | 2–4 fps       |
 * | none                               | —                                        | 0             |
 *
 * - Frames go out as MVF1 through a {@link FrameSink} (`BridgeServer.sendFrame` fits).
 * - At most 2 unacked frames per PC; the latest frame wins (an older pending frame is replaced).
 * - BGRA frames are damage-driven (0 fps while idle). Each received media frame is acked to the guest
 *   with `frame_ack` the way cua's viewer does.
 * - The guest cursor is NOT composited into frames; its position is polled separately at a low rate
 *   (`GetCursorPosition`) and reported through `onCursor`.
 */

export type ViewTier =
  | { mode: 'none' }
  | { mode: 'visible'; agentSeated?: boolean; px?: number }
  | { mode: 'focus' };

/** Where MVF1 frames go. Returns false when the frame was skipped (no mod, socket backed up). */
export interface FrameSink {
  sendFrame(frame: Uint8Array): boolean;
}

export interface MediaFrameLike {
  sequence: bigint | number;
  codec: string;
  width: number;
  height: number;
  data: ArrayBuffer;
}

export interface MediaSessionMin {
  close(): Promise<void>;
  codec(): string;
  sessionId(): string;
  sendControl(json: string): void;
  isClosed?(): boolean;
}

/** The spacesd calls the frame service needs. */
export interface FrameClient {
  screenshot(options: {
    format?: number;
    quality?: number;
    maxDimension?: number;
    includeCursor: boolean;
  }): Promise<{ image: ArrayBuffer; width: number; height: number }>;
  openMedia(
    options: {
      maxFps: number;
      maxDimension: number;
      audio: boolean;
      disableVideo: boolean;
      requestJson?: string;
    },
    sink: { onFrame(frame: MediaFrameLike): void; onEvent(event: { kind: string; json: string }): void },
  ): Promise<MediaSessionMin>;
  cursorPosition(): Promise<{ x: number; y: number }>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface FrameRates {
  focusMaxFps: number;
  /** Max dimension of the focus stream (0 = native). */
  focusMaxDimension: number;
  /** JPEG fallback when the media stream cannot open. */
  focusFallbackFps: number;
  seatedFps: [min: number, max: number];
  seatedMaxDimension: number;
  visibleFps: [min: number, max: number];
  visibleMaxDimension: number;
  jpegQuality: number;
  cursorHz: number;
}

export const DEFAULT_RATES: FrameRates = {
  focusMaxFps: 30,
  focusMaxDimension: 0,
  focusFallbackFps: 15,
  seatedFps: [4, 8],
  seatedMaxDimension: 960,
  visibleFps: [2, 4],
  visibleMaxDimension: 640,
  jpegQuality: 75,
  cursorHz: 4,
};

/** Picks the JPEG rate for a visible tier from the projected size on screen. */
export function visibleRate(
  tier: Extract<ViewTier, { mode: 'visible' }>,
  rates: FrameRates,
): { fps: number; maxDimension: number } {
  const [lo, hi] = tier.agentSeated ? rates.seatedFps : rates.visibleFps;
  const maxDimension = tier.agentSeated ? rates.seatedMaxDimension : rates.visibleMaxDimension;
  const px = tier.px;
  const fps =
    px === undefined
      ? Math.round((lo + hi) / 2)
      : px >= 400
        ? hi
        : px >= 200
          ? Math.round((lo + hi) / 2)
          : lo;
  return { fps, maxDimension };
}

export const BGRA_REQUEST_JSON = '{"codecs":["MEDIA_CODEC_BGRA"]}';

export interface FrameServiceOptions {
  sink: FrameSink;
  getClient: (pcId: string) => Promise<FrameClient>;
  /** The MVF1 `pcSlot` of a PC (undefined = unknown PC: frames are not produced). */
  slotOf: (pcId: string) => number | undefined;
  /** `ImageFormat.Jpeg` of the loaded cua module. */
  jpegFormat: number;
  clock?: Clock;
  rates?: Partial<FrameRates>;
  maxUnacked?: number;
  /** An unacked frame older than this no longer blocks sending (lost ack, mod reconnect). */
  ackTimeoutMs?: number;
  onCursor?: (pcId: string, pos: { x: number; y: number }) => void;
  logger?: Logger;
}

export interface FrameStats {
  produced: number;
  sent: number;
  /** Replaced while waiting for an ack slot (latest wins). */
  superseded: number;
  /** Skipped by the sink (no mod / backpressure). */
  sinkSkipped: number;
  /** JPEGs not sent because the image did not change. */
  unchanged: number;
  mediaFrames: number;
  errors: number;
}

interface PcFrames {
  pcId: string;
  tier: ViewTier;
  /** Bumped on every tier change; async work from an older epoch is discarded. */
  epoch: number;
  seq: number;
  unacked: Map<number, number>;
  pending: Uint8Array | null;
  flushTimer: unknown;
  pollTimer: unknown;
  inFlight: boolean;
  lastHash: string | null;
  media: MediaSessionMin | null;
  mediaFailed: boolean;
  cursorTimer: unknown;
  lastCursor: { x: number; y: number } | null;
  stats: FrameStats;
}

const newStats = (): FrameStats => ({
  produced: 0,
  sent: 0,
  superseded: 0,
  sinkSkipped: 0,
  unchanged: 0,
  mediaFrames: 0,
  errors: 0,
});

export class FrameService {
  readonly #o: Required<Omit<FrameServiceOptions, 'onCursor' | 'logger' | 'rates'>> & {
    onCursor?: FrameServiceOptions['onCursor'];
    logger?: Logger;
  };
  readonly #rates: FrameRates;
  readonly #clock: Clock;
  readonly #pcs = new Map<string, PcFrames>();
  #closed = false;

  constructor(options: FrameServiceOptions) {
    this.#clock = options.clock ?? realClock;
    this.#rates = { ...DEFAULT_RATES, ...options.rates };
    this.#o = {
      sink: options.sink,
      getClient: options.getClient,
      slotOf: options.slotOf,
      jpegFormat: options.jpegFormat,
      clock: this.#clock,
      maxUnacked: options.maxUnacked ?? 2,
      ackTimeoutMs: options.ackTimeoutMs ?? 1000,
      ...(options.onCursor ? { onCursor: options.onCursor } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    };
  }

  /** Sets a PC's view tier (from `pc.view`). Idempotent for an unchanged tier. */
  setTier(pcId: string, tier: ViewTier): void {
    if (this.#closed) return;
    let s = this.#pcs.get(pcId);
    if (!s) {
      s = {
        pcId,
        tier: { mode: 'none' },
        epoch: 0,
        seq: 0,
        unacked: new Map(),
        pending: null,
        flushTimer: null,
        pollTimer: null,
        inFlight: false,
        lastHash: null,
        media: null,
        mediaFailed: false,
        cursorTimer: null,
        lastCursor: null,
        stats: newStats(),
      };
      this.#pcs.set(pcId, s);
    }
    if (s.tier.mode === tier.mode) {
      // Same mode: a visible tier only changes its rate; apply it now rather than after the old interval.
      const before = s.tier.mode === 'visible' ? visibleRate(s.tier, this.#rates) : null;
      s.tier = tier;
      const after = tier.mode === 'visible' ? visibleRate(tier, this.#rates) : null;
      if (before && after && (before.fps !== after.fps || before.maxDimension !== after.maxDimension)) {
        if (!s.inFlight) this.#schedulePoll(s, 0);
      }
      return;
    }
    this.#stopWork(s, false);
    s.tier = tier;
    s.epoch++;
    s.lastHash = null;
    if (tier.mode === 'none') {
      s.pending = null;
      s.unacked.clear();
      return;
    }
    if (tier.mode === 'focus') {
      s.mediaFailed = false;
      void this.#openMedia(s, s.epoch);
    } else {
      this.#schedulePoll(s, 0);
    }
    this.#scheduleCursor(s, 0);
  }

  tierOf(pcId: string): ViewTier {
    return this.#pcs.get(pcId)?.tier ?? { mode: 'none' };
  }

  /** The mod acked frame `seq` of `pcSlot` (`pc.frame.ack`). Older unacked frames are released too. */
  ack(pcSlot: number, seq: number): void {
    for (const s of this.#pcs.values()) {
      if (this.#o.slotOf(s.pcId) !== pcSlot) continue;
      for (const k of [...s.unacked.keys()]) {
        if ((seq - k) >>> 0 < 0x80000000) s.unacked.delete(k);
      }
      this.#flush(s);
    }
  }

  /** Forces the next frame of a PC to be sent even if unchanged (mod reconnected, monitor re-bound). */
  refresh(pcId: string): void {
    const s = this.#pcs.get(pcId);
    if (!s) return;
    s.lastHash = null;
    s.unacked.clear();
    if (s.tier.mode === 'focus' && s.media) {
      // The BGRA stream is damage-driven; ask for a keyframe.
      try {
        s.media.sendControl(JSON.stringify({ type: 'request_keyframe', payload: {} }));
      } catch {}
    }
  }

  /** Forgets a PC (deleted, stopped). */
  removePc(pcId: string): void {
    const s = this.#pcs.get(pcId);
    if (!s) return;
    this.#stopWork(s, false);
    s.epoch++;
    this.#pcs.delete(pcId);
  }

  stats(pcId: string): FrameStats | undefined {
    const s = this.#pcs.get(pcId);
    return s ? { ...s.stats } : undefined;
  }

  unackedCount(pcId: string): number {
    return this.#pcs.get(pcId)?.unacked.size ?? 0;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const closing: Promise<void>[] = [];
    for (const s of this.#pcs.values()) {
      const m = s.media;
      this.#stopWork(s, false);
      if (m) closing.push(m.close().catch(() => {}));
    }
    this.#pcs.clear();
    await Promise.all(closing);
  }

  // ------------------------------------------------------------------ internals

  #stopWork(s: PcFrames, keepMedia: boolean): void {
    if (s.pollTimer !== null) this.#clock.clearTimeout(s.pollTimer);
    if (s.flushTimer !== null) this.#clock.clearTimeout(s.flushTimer);
    if (s.cursorTimer !== null) this.#clock.clearTimeout(s.cursorTimer);
    s.pollTimer = null;
    s.flushTimer = null;
    s.cursorTimer = null;
    if (!keepMedia && s.media) {
      const m = s.media;
      s.media = null;
      m.close().catch(() => {});
    }
  }

  #nextSeq(s: PcFrames): number {
    s.seq = (s.seq + 1) >>> 0;
    if (s.seq === 0) s.seq = 1;
    return s.seq;
  }

  /** Offers a finished MVF1 frame: send now if an ack slot is free, else keep it as the pending frame. */
  #offer(s: PcFrames, frame: Uint8Array): void {
    s.stats.produced++;
    if (s.pending) s.stats.superseded++;
    s.pending = frame;
    this.#flush(s);
  }

  #flush(s: PcFrames): void {
    if (!s.pending) return;
    const now = this.#clock.now();
    for (const [k, t] of s.unacked) if (now - t >= this.#o.ackTimeoutMs) s.unacked.delete(k);
    if (s.unacked.size >= this.#o.maxUnacked) {
      // Wake up when the oldest unacked frame expires, in case its ack never comes.
      if (s.flushTimer === null) {
        const oldest = Math.min(...s.unacked.values());
        const wait = Math.max(1, this.#o.ackTimeoutMs - (now - oldest));
        s.flushTimer = this.#clock.setTimeout(() => {
          s.flushTimer = null;
          this.#flush(s);
        }, wait);
      }
      return;
    }
    const frame = s.pending;
    s.pending = null;
    const seq = new DataView(frame.buffer, frame.byteOffset, 32).getUint32(12, false);
    if (this.#o.sink.sendFrame(frame)) {
      s.unacked.set(seq, now);
      s.stats.sent++;
    } else {
      s.stats.sinkSkipped++;
    }
  }

  #encode(s: PcFrames, codec: number, w: number, h: number, payload: Uint8Array): Uint8Array | null {
    const slot = this.#o.slotOf(s.pcId);
    if (slot === undefined) return null;
    return encodeFrame(
      {
        kind: FrameKind.PC_FRAME,
        codec: codec as (typeof FrameCodec)[keyof typeof FrameCodec],
        flags: FrameFlag.FULL,
        pcSlot: slot,
        seq: this.#nextSeq(s),
        w,
        h,
      },
      payload,
    );
  }

  // --- JPEG tiers (visible) and the focus fallback

  #pollPlan(s: PcFrames): { fps: number; maxDimension: number } | null {
    const t = s.tier;
    if (t.mode === 'visible') return visibleRate(t, this.#rates);
    if (t.mode === 'focus' && s.mediaFailed) {
      return { fps: this.#rates.focusFallbackFps, maxDimension: 1280 };
    }
    return null;
  }

  #schedulePoll(s: PcFrames, delayMs: number): void {
    if (s.pollTimer !== null) this.#clock.clearTimeout(s.pollTimer);
    const epoch = s.epoch;
    s.pollTimer = this.#clock.setTimeout(() => {
      s.pollTimer = null;
      void this.#pollOnce(s, epoch);
    }, delayMs);
  }

  async #pollOnce(s: PcFrames, epoch: number): Promise<void> {
    const plan = this.#pollPlan(s);
    if (!plan || s.epoch !== epoch || this.#closed) return;
    const interval = 1000 / plan.fps;
    const started = this.#clock.now();
    if (!s.inFlight) {
      s.inFlight = true;
      try {
        const client = await this.#o.getClient(s.pcId);
        const shot = await client.screenshot({
          format: this.#o.jpegFormat,
          quality: this.#rates.jpegQuality,
          maxDimension: plan.maxDimension,
          includeCursor: false,
        });
        if (s.epoch === epoch) {
          const bytes = new Uint8Array(shot.image);
          const hash = createHash('sha1').update(bytes).digest('hex');
          if (hash === s.lastHash) s.stats.unchanged++;
          else {
            const frame = this.#encode(s, FrameCodec.JPEG, shot.width, shot.height, bytes);
            if (frame) {
              s.lastHash = hash;
              this.#offer(s, frame);
            }
          }
        }
      } catch (err) {
        s.stats.errors++;
        this.#o.logger?.debug({ pcId: s.pcId, err: String(err) }, 'screenshot failed');
      } finally {
        s.inFlight = false;
      }
    }
    if (s.epoch !== epoch || this.#closed) return;
    const elapsed = this.#clock.now() - started;
    this.#schedulePoll(s, Math.max(0, interval - elapsed));
  }

  // --- focus tier: BGRA media stream

  async #openMedia(s: PcFrames, epoch: number): Promise<void> {
    let session: MediaSessionMin | null = null;
    const earlyAcks: number[] = [];
    const guestAck = (sequence: number) => {
      if (!session) {
        earlyAcks.push(sequence);
        return;
      }
      try {
        session.sendControl(
          JSON.stringify({
            type: 'frame_ack',
            payload: { session_id: session.sessionId(), sequence, decode_queue: s.unacked.size },
          }),
        );
      } catch {}
    };
    try {
      const client = await this.#o.getClient(s.pcId);
      session = await client.openMedia(
        {
          maxFps: this.#rates.focusMaxFps,
          maxDimension: this.#rates.focusMaxDimension,
          audio: false,
          disableVideo: false,
          requestJson: BGRA_REQUEST_JSON,
        },
        {
          onFrame: (f) => {
            const sequence = Number(f.sequence);
            guestAck(sequence);
            if (s.epoch !== epoch) return;
            s.stats.mediaFrames++;
            if (f.codec !== 'bgra') return;
            const payload = new Uint8Array(f.data);
            if (payload.byteLength !== f.width * f.height * 4) {
              s.stats.errors++;
              return;
            }
            const frame = this.#encode(s, FrameCodec.BGRA8, f.width, f.height, payload);
            if (frame) this.#offer(s, frame);
          },
          onEvent: (e) => {
            if (/clos|error|disconnect/i.test(e.kind) && s.epoch === epoch && s.tier.mode === 'focus') {
              this.#o.logger?.debug({ pcId: s.pcId, kind: e.kind }, 'media session ended; reopening');
              s.media = null;
              this.#clock.setTimeout(() => {
                if (s.epoch === epoch && s.tier.mode === 'focus' && !s.media) void this.#openMedia(s, epoch);
              }, 500);
            }
          },
        },
      );
    } catch (err) {
      s.stats.errors++;
      this.#o.logger?.warn({ pcId: s.pcId, err: String(err) }, 'openMedia failed; falling back to JPEG');
      if (s.epoch === epoch && s.tier.mode === 'focus') {
        s.mediaFailed = true;
        this.#schedulePoll(s, 0);
      }
      return;
    }
    if (s.epoch !== epoch || this.#closed) {
      await session.close().catch(() => {});
      return;
    }
    if (session.codec() !== 'bgra') {
      this.#o.logger?.warn({ pcId: s.pcId, codec: session.codec() }, 'media codec is not BGRA; using JPEG');
      await session.close().catch(() => {});
      s.mediaFailed = true;
      this.#schedulePoll(s, 0);
      return;
    }
    s.media = session;
    for (const seq of earlyAcks.splice(0)) guestAck(seq);
  }

  // --- cursor (not composited into frames)

  #scheduleCursor(s: PcFrames, delayMs: number): void {
    if (this.#rates.cursorHz <= 0 || !this.#o.onCursor) return;
    if (s.cursorTimer !== null) this.#clock.clearTimeout(s.cursorTimer);
    const epoch = s.epoch;
    s.cursorTimer = this.#clock.setTimeout(() => {
      s.cursorTimer = null;
      void this.#pollCursor(s, epoch);
    }, delayMs);
  }

  async #pollCursor(s: PcFrames, epoch: number): Promise<void> {
    if (s.epoch !== epoch || s.tier.mode === 'none' || this.#closed) return;
    try {
      const client = await this.#o.getClient(s.pcId);
      const p = await client.cursorPosition();
      if (s.epoch === epoch && (!s.lastCursor || s.lastCursor.x !== p.x || s.lastCursor.y !== p.y)) {
        s.lastCursor = { x: p.x, y: p.y };
        this.#o.onCursor?.(s.pcId, s.lastCursor);
      }
    } catch {
      s.stats.errors++;
    }
    if (s.epoch === epoch && !this.#closed) this.#scheduleCursor(s, 1000 / this.#rates.cursorHz);
  }
}
