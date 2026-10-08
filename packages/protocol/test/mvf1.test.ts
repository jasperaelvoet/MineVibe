import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  decodeFrameHeader,
  encodeFrame,
  encodeFrameHeader,
  FrameCodec,
  FrameFlag,
  FrameKind,
  looksLikeMvf1,
  MVF1_HEADER_BYTES,
  MVF1_MAGIC,
  Mvf1Error,
  type Mvf1HeaderInit,
} from '../src/index.js';

function jpeg(len = 64): Uint8Array {
  const out = new Uint8Array(len);
  out[0] = 0xff;
  out[1] = 0xd8;
  for (let i = 2; i < len; i++) out[i] = i & 0xff;
  return out;
}

function raw(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7) & 0xff;
  return out;
}

const fullJpeg: Mvf1HeaderInit = {
  kind: FrameKind.PC_FRAME,
  codec: FrameCodec.JPEG,
  flags: FrameFlag.FULL | FrameFlag.CURSOR,
  pcSlot: 3,
  seq: 4_000_000_000,
  w: 1280,
  h: 800,
};

function expectMvf1Error(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Mvf1Error);
    expect((e as Mvf1Error).code).toBe(code);
    return;
  }
  throw new Error(`expected Mvf1Error ${code}`);
}

describe('MVF1 round trip', () => {
  it('encodes a 32-byte big-endian header followed by the payload', () => {
    const payload = jpeg(100);
    const buf = encodeFrame(fullJpeg, payload);
    expect(buf.byteLength).toBe(MVF1_HEADER_BYTES + 100);
    const view = new DataView(buf.buffer, buf.byteOffset);
    expect(view.getUint32(0, false)).toBe(MVF1_MAGIC);
    expect(String.fromCharCode(...buf.subarray(0, 4))).toBe('MVF1');
    expect(buf[4]).toBe(1);
    expect(buf[5]).toBe(1);
    expect(view.getUint16(6, false)).toBe(0b011);
    expect(view.getUint32(8, false)).toBe(3);
    expect(view.getUint32(12, false)).toBe(4_000_000_000);
    expect(view.getUint16(16, false)).toBe(1280);
    expect(view.getUint16(18, false)).toBe(800);
    expect(view.getUint16(24, false)).toBe(1280);
    expect(view.getUint16(26, false)).toBe(800);
    expect(view.getUint32(28, false)).toBe(100);
  });

  it('round-trips a full JPEG frame', () => {
    const payload = jpeg(512);
    const { header, payload: out } = decodeFrame(encodeFrame(fullJpeg, payload));
    expect(header).toEqual({
      ...fullJpeg,
      rectX: 0,
      rectY: 0,
      rectW: 1280,
      rectH: 800,
      payloadLen: 512,
    });
    expect(Array.from(out)).toEqual(Array.from(payload));
  });

  it('round-trips a BGRA8 dirty rect', () => {
    const init: Mvf1HeaderInit = {
      kind: FrameKind.PC_FRAME,
      codec: FrameCodec.BGRA8,
      flags: FrameFlag.DIRTY_RECT,
      pcSlot: 0,
      seq: 1,
      w: 64,
      h: 48,
      rectX: 10,
      rectY: 20,
      rectW: 16,
      rectH: 8,
    };
    const payload = raw(16, 8);
    const frame = decodeFrame(encodeFrame(init, payload));
    expect(frame.header).toMatchObject({ rectX: 10, rectY: 20, rectW: 16, rectH: 8, payloadLen: 16 * 8 * 4 });
    expect(frame.payload).toEqual(payload);
  });

  it('round-trips an RGBA8 full frame at u16/u32 limits', () => {
    const init: Mvf1HeaderInit = {
      kind: FrameKind.PC_FRAME,
      codec: FrameCodec.RGBA8,
      flags: FrameFlag.FULL,
      pcSlot: 0xffffffff,
      seq: 0xffffffff,
      w: 2,
      h: 3,
    };
    const frame = decodeFrame(encodeFrame(init, raw(2, 3)));
    expect(frame.header.pcSlot).toBe(0xffffffff);
    expect(frame.header.seq).toBe(0xffffffff);
  });

  it('decodes from a view with a non-zero byteOffset', () => {
    const enc = encodeFrame(fullJpeg, jpeg(32));
    const padded = new Uint8Array(enc.byteLength + 7);
    padded.set(enc, 7);
    expect(decodeFrame(padded.subarray(7)).header.payloadLen).toBe(32);
  });

  it('encodes a header alone', () => {
    const header = decodeFrameHeader(encodeFrame(fullJpeg, jpeg(40)));
    expect(encodeFrameHeader(header)).toEqual(encodeFrame(fullJpeg, jpeg(40)).subarray(0, MVF1_HEADER_BYTES));
  });

  it('looksLikeMvf1', () => {
    expect(looksLikeMvf1(encodeFrame(fullJpeg, jpeg()))).toBe(true);
    expect(looksLikeMvf1(new Uint8Array(32))).toBe(false);
    expect(looksLikeMvf1(new TextEncoder().encode('MVF1'))).toBe(false);
  });
});

describe('MVF1 rejects', () => {
  const good = () => encodeFrame(fullJpeg, jpeg(64));

  it('bad magic', () => {
    const buf = good();
    buf[3] = 0x32; // 'MVF2'
    expectMvf1Error(() => decodeFrame(buf), 'BAD_MAGIC');
  });

  it('a buffer shorter than the header', () => {
    expectMvf1Error(() => decodeFrame(good().subarray(0, 31)), 'TOO_SHORT');
    expectMvf1Error(() => decodeFrame(new Uint8Array(0)), 'TOO_SHORT');
  });

  it('a truncated payload', () => {
    expectMvf1Error(() => decodeFrame(good().subarray(0, MVF1_HEADER_BYTES + 63)), 'BAD_LENGTH');
  });

  it('trailing bytes after the payload', () => {
    const buf = good();
    const longer = new Uint8Array(buf.byteLength + 1);
    longer.set(buf);
    expectMvf1Error(() => decodeFrame(longer), 'BAD_LENGTH');
  });

  it('a payloadLen that lies', () => {
    const buf = good();
    new DataView(buf.buffer).setUint32(28, 65, false);
    expectMvf1Error(() => decodeFrame(buf), 'BAD_LENGTH');
  });

  it('unknown kind and codec', () => {
    const a = good();
    a[4] = 9;
    expectMvf1Error(() => decodeFrame(a), 'BAD_KIND');
    const b = good();
    b[5] = 4;
    expectMvf1Error(() => decodeFrame(b), 'BAD_CODEC');
  });

  it('reserved flag bits and FULL+DIRTY_RECT', () => {
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, flags: 0x8000 }, jpeg()), 'BAD_FLAGS');
    expectMvf1Error(
      () => encodeFrame({ ...fullJpeg, flags: FrameFlag.FULL | FrameFlag.DIRTY_RECT }, jpeg()),
      'BAD_FLAGS',
    );
  });

  it('a rect outside the frame or a partial FULL rect', () => {
    expectMvf1Error(
      () => encodeFrame({ ...fullJpeg, flags: FrameFlag.DIRTY_RECT, rectX: 1200, rectW: 100 }, jpeg()),
      'BAD_GEOMETRY',
    );
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, rectW: 640 }, jpeg()), 'BAD_GEOMETRY');
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, w: 0, h: 0 }, jpeg()), 'BAD_GEOMETRY');
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, flags: 0, rectW: 0 }, jpeg()), 'BAD_GEOMETRY');
  });

  it('raw payloads of the wrong size', () => {
    const init: Mvf1HeaderInit = { ...fullJpeg, codec: FrameCodec.BGRA8, flags: FrameFlag.FULL, w: 4, h: 4 };
    expectMvf1Error(() => encodeFrame(init, raw(4, 3)), 'BAD_PAYLOAD');
    expect(() => encodeFrame(init, raw(4, 4))).not.toThrow();
  });

  it('JPEG payloads without SOI', () => {
    const bad = jpeg();
    bad[0] = 0;
    expectMvf1Error(() => encodeFrame(fullJpeg, bad), 'BAD_PAYLOAD');
    expectMvf1Error(() => encodeFrame(fullJpeg, new Uint8Array([0xff, 0xd8])), 'BAD_PAYLOAD');
  });

  it('out-of-range header integers', () => {
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, w: 70_000 }, jpeg()), 'OUT_OF_RANGE');
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, seq: -1 }, jpeg()), 'OUT_OF_RANGE');
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, pcSlot: 1.5 }, jpeg()), 'OUT_OF_RANGE');
    expectMvf1Error(() => encodeFrame({ ...fullJpeg, seq: 2 ** 32 }, jpeg()), 'OUT_OF_RANGE');
  });
});
