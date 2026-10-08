import { createHash } from 'node:crypto';
import { encodeFrame, FrameCodec, FrameFlag, FrameKind } from '@minevibe/protocol';
import type { Logger } from 'pino';
import { withDeadline } from './deadline.js';

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
 * - At most 2 unacked frames per PC; the latest frame wins (an older pending frame is replaced). A frame
 *   the sink skipped (backpressure, no mod) stays pending and is retried with backoff (M3).
 * - The focus tier retries the BGRA stream with exponential backoff after a failure, JPEG in between, and
 *   reopens a closed stream exactly once per session (M4). Failing PCs are polled with backoff, and a PC
 *   without a slot (not running) is not polled at all until {@link FrameService.wake}.
 * - Every spacesd call has a deadline.
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

type CallOpts = { signal: AbortSignal };

/** The spacesd calls the frame service needs (each takes the deadline's signal). */
export interface FrameClient {
  screenshot(
    options: {
      format?: number;
      quality?: number;
      maxDimension?: number;
      includeCursor: boolean;
    },
    opts?: CallOpts,
  ): Promise<{ image: ArrayBuffer; width: number; height: number }>;
  openMedia(
    options: {
      maxFps: number;
      maxDimension: number;
      audio: boolean;
      disableVideo: boolean;
      requestJson?: string;
    },
    sink: { onFrame(frame: MediaFrameLike): void; onEvent(event: { kind: string; json: string }): void },
    opts?: CallOpts,
  ): Promise<MediaSessionMin>;
  cursorPosition(opts?: CallOpts): Promise<{ x: number; y: number }>;
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
  /** Deadline of one screenshot / cursor call (default 5 s); `openMedia` gets twice this. */
  callTimeoutMs?: number;
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
  /** `openMedia` attempts (first open, reopen after close, retries after failure). */
  mediaOpens: number;
}

/** Backoff bounds. */
const SINK_RETRY_MS: [number, number] = [50, 1000];
const MEDIA_RETRY_MS: [number, number] = [1000, 30_000];
const ERROR_BACKOFF_MAX_MS = 5000;

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
  /** Bumped per `openMedia` attempt and when a session is given up; stale sessions/events are ignored. */
  mediaGen: number;
  mediaRetryTimer: unknown;
  mediaBackoffMs: number;
  cursorTimer: unknown;
  lastCursor: { x: number; y: number } | null;
  /** Consecutive failures, for backoff. */
  pollErrors: number;
  cursorErrors: number;
  sinkBackoffMs: number;
  /** No slot (PC not running): all work stopped until `wake`. */
  parked: boolean;
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
  mediaOpens: 0,
});

export class FrameService {
  readonly #o: Required<Omit<FrameServiceOptions, 'onCursor' | 'logger' | 'rates' | 'callTimeoutMs'>> & {
    onCursor?: FrameServiceOptions['onCursor'];
    logger?: Logger;
  };
  readonly #rates: FrameRates;
  readonly #clock: Clock;
  readonly #pcs = new Map<string, PcFrames>();
  readonly #callTimeoutMs: number;
  #closed = false;

  constructor(options: FrameServiceOptions) {
    this.#clock = options.clock ?? realClock;
    this.#rates = { ...DEFAULT_RATES, ...options.rates };
    this.#callTimeoutMs = options.callTimeoutMs ?? 5000;
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
        mediaGen: 0,
        mediaRetryTimer: null,
        mediaBackoffMs: 0,
        cursorTimer: null,
        lastCursor: null,
        pollErrors: 0,
        cursorErrors: 0,
        sinkBackoffMs: 0,
        parked: false,
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
    s.tier = tier;
    this.#restart(s);
  }

  /** Starts the work of the current tier from scratch (new epoch, no backoff). */
  #restart(s: PcFrames): void {
    this.#stopWork(s, false);
    s.epoch++;
    s.lastHash = null;
    s.parked = false;
    s.pollErrors = 0;
    s.cursorErrors = 0;
    s.mediaBackoffMs = 0;
    if (s.tier.mode === 'none') {
      s.pending = null;
      s.unacked.clear();
      return;
    }
    if (s.tier.mode === 'focus') {
      s.mediaFailed = false;
      void this.#openMedia(s, s.epoch);
    } else {
      this.#schedulePoll(s, 0);
    }
    this.#scheduleCursor(s, 0);
  }

  /**
   * The PC (re)gained its slot, i.e. it is running again: resume a parked PC's work right away and drop
   * any error backoff (PcManager calls this when a PC turns `running`).
   */
  wake(pcId: string): void {
    const s = this.#pcs.get(pcId);
    if (!s || this.#closed || s.tier.mode === 'none') return;
    if (s.parked || s.pollErrors > 0 || s.cursorErrors > 0 || s.mediaFailed) this.#restart(s);
  }

  /** Whether a PC's frame work is parked (no slot). */
  isParked(pcId: string): boolean {
    return this.#pcs.get(pcId)?.parked ?? false;
  }

  /** No slot: stop every timer and the media session; nothing polls a PC that isn't running. */
  #park(s: PcFrames): void {
    if (s.parked) return;
    this.#stopWork(s, false);
    s.epoch++;
    s.parked = true;
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
    if (s.mediaRetryTimer !== null) this.#clock.clearTimeout(s.mediaRetryTimer);
    s.pollTimer = null;
    s.flushTimer = null;
    s.cursorTimer = null;
    s.mediaRetryTimer = null;
    if (!keepMedia) {
      s.mediaGen++;
      if (s.media) {
        const m = s.media;
        s.media = null;
        m.close().catch(() => {});
      }
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
    if (s.parked || s.tier.mode === 'none') {
      s.pending = null;
      return;
    }
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
    const seq = new DataView(frame.buffer, frame.byteOffset, 32).getUint32(12, false);
    if (this.#o.sink.sendFrame(frame)) {
      s.pending = null;
      s.unacked.set(seq, now);
      s.stats.sent++;
      s.sinkBackoffMs = 0;
      return;
    }
    // M3: the sink skipped it (backpressure, no mod). Keep it pending (a newer frame still replaces it)
    // and retry with backoff, so a damage-driven stream that goes quiet still delivers its last frame.
    s.stats.sinkSkipped++;
    s.sinkBackoffMs = Math.min(SINK_RETRY_MS[1], Math.max(SINK_RETRY_MS[0], s.sinkBackoffMs * 2));
    if (s.flushTimer === null) {
      s.flushTimer = this.#clock.setTimeout(() => {
        s.flushTimer = null;
        this.#flush(s);
      }, s.sinkBackoffMs);
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
    if (this.#o.slotOf(s.pcId) === undefined) {
      this.#park(s);
      return;
    }
    const interval = 1000 / plan.fps;
    const started = this.#clock.now();
    if (!s.inFlight) {
      s.inFlight = true;
      try {
        const client = await this.#o.getClient(s.pcId);
        const shot = await withDeadline(this.#callTimeoutMs, 'screenshot', (signal) =>
          client.screenshot(
            {
              format: this.#o.jpegFormat,
              quality: this.#rates.jpegQuality,
              maxDimension: plan.maxDimension,
              includeCursor: false,
            },
            { signal },
          ),
        );
        s.pollErrors = 0;
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
        s.pollErrors++;
        this.#o.logger?.debug({ pcId: s.pcId, err: String(err) }, 'screenshot failed');
      } finally {
        s.inFlight = false;
      }
    }
    if (s.epoch !== epoch || this.#closed) return;
    const elapsed = this.#clock.now() - started;
    this.#schedulePoll(s, Math.max(0, backoff(interval, s.pollErrors) - elapsed));
  }

  // --- focus tier: BGRA media stream

  async #openMedia(s: PcFrames, epoch: number): Promise<void> {
    if (s.epoch !== epoch || this.#closed || s.tier.mode !== 'focus') return;
    if (this.#o.slotOf(s.pcId) === undefined) {
      this.#park(s);
      return;
    }
    const gen = ++s.mediaGen;
    s.stats.mediaOpens++;
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
    const current = () => s.epoch === epoch && s.mediaGen === gen && s.tier.mode === 'focus' && !this.#closed;
    try {
      const client = await this.#o.getClient(s.pcId);
      session = await withDeadline(this.#callTimeoutMs * 2, 'openMedia', (signal) =>
        client.openMedia(
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
              if (!current()) return;
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
              // A session may report both "closed" and "error": only the first reopens, once.
              if (!/clos|error|disconnect/i.test(e.kind) || !current()) return;
              this.#o.logger?.debug({ pcId: s.pcId, kind: e.kind }, 'media session ended; reopening');
              s.mediaGen++;
              if (s.media === session) s.media = null;
              this.#scheduleMediaRetry(s, epoch, 500);
            },
          },
          { signal },
        ),
      );
    } catch (err) {
      s.stats.errors++;
      if (s.epoch !== epoch || s.mediaGen !== gen) return;
      this.#o.logger?.warn({ pcId: s.pcId, err: String(err) }, 'openMedia failed; JPEG until it reopens');
      this.#mediaFailed(s, epoch);
      return;
    }
    if (!current()) {
      await session.close().catch(() => {});
      return;
    }
    if (session.codec() !== 'bgra') {
      this.#o.logger?.warn({ pcId: s.pcId, codec: session.codec() }, 'media codec is not BGRA; using JPEG');
      s.mediaGen++;
      await session.close().catch(() => {});
      this.#mediaFailed(s, epoch);
      return;
    }
    s.media = session;
    s.mediaBackoffMs = 0;
    if (s.mediaFailed) {
      // The JPEG fallback loop ends by itself (#pollPlan returns null once the stream works).
      s.mediaFailed = false;
      s.lastHash = null;
    }
    for (const seq of earlyAcks.splice(0)) guestAck(seq);
  }

  /** JPEG fallback now, another BGRA attempt later (exponential backoff). */
  #mediaFailed(s: PcFrames, epoch: number): void {
    if (s.epoch !== epoch || s.tier.mode !== 'focus') return;
    if (!s.mediaFailed) {
      s.mediaFailed = true;
      if (s.pollTimer === null && !s.inFlight) this.#schedulePoll(s, 0);
    }
    s.mediaBackoffMs = Math.min(MEDIA_RETRY_MS[1], Math.max(MEDIA_RETRY_MS[0], s.mediaBackoffMs * 2));
    this.#scheduleMediaRetry(s, epoch, s.mediaBackoffMs);
  }

  #scheduleMediaRetry(s: PcFrames, epoch: number, delayMs: number): void {
    if (s.mediaRetryTimer !== null) return;
    s.mediaRetryTimer = this.#clock.setTimeout(() => {
      s.mediaRetryTimer = null;
      if (s.epoch === epoch && s.tier.mode === 'focus' && !s.media) void this.#openMedia(s, epoch);
    }, delayMs);
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
    if (this.#o.slotOf(s.pcId) === undefined) {
      this.#park(s);
      return;
    }
    try {
      const client = await this.#o.getClient(s.pcId);
      const p = await withDeadline(this.#callTimeoutMs, 'cursorPosition', (signal) =>
        client.cursorPosition({ signal }),
      );
      s.cursorErrors = 0;
      if (s.epoch === epoch && (!s.lastCursor || s.lastCursor.x !== p.x || s.lastCursor.y !== p.y)) {
        s.lastCursor = { x: p.x, y: p.y };
        this.#o.onCursor?.(s.pcId, s.lastCursor);
      }
    } catch {
      s.stats.errors++;
      s.cursorErrors++;
    }
    if (s.epoch === epoch && !this.#closed) {
      this.#scheduleCursor(s, backoff(1000 / this.#rates.cursorHz, s.cursorErrors));
    }
  }
}

/** `base` doubled per consecutive error, capped at 5 s (never below `base`). */
export function backoff(base: number, errors: number): number {
  if (errors <= 0) return base;
  return Math.max(base, Math.min(ERROR_BACKOFF_MAX_MS, base * 2 ** Math.min(errors, 8)));
}
