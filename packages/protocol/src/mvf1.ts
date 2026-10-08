/**
 * MVF1: binary frame format for PC screen frames (Node -> mod), one frame per WebSocket binary message.
 *
 * 32-byte big-endian header, then the payload:
 *
 * | off | type | field      |
 * |-----|------|------------|
 * | 0   | u32  | magic 'MVF1' (0x4D564631) |
 * | 4   | u8   | kind (1 = pc_frame) |
 * | 5   | u8   | codec (1 = JPEG, 2 = RGBA8, 3 = BGRA8) |
 * | 6   | u16  | flags (bit0 full frame, bit1 cursor drawn, bit2 dirty rect) |
 * | 8   | u32  | pcSlot |
 * | 12  | u32  | seq |
 * | 16  | u16  | w (full frame width) |
 * | 18  | u16  | h (full frame height) |
 * | 20  | u16  | rectX |
 * | 22  | u16  | rectY |
 * | 24  | u16  | rectW |
 * | 26  | u16  | rectH |
 * | 28  | u32  | payloadLen |
 * | 32  | ...  | payload (the pixels of the rect) |
 */

export const MVF1_MAGIC = 0x4d564631;
export const MVF1_HEADER_BYTES = 32;
/** Upper bound for one frame's payload (a 4096x4096 BGRA8 frame is exactly 64 MiB). */
export const MVF1_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export const FrameKind = { PC_FRAME: 1 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const FrameCodec = { JPEG: 1, RGBA8: 2, BGRA8: 3 } as const;
export type FrameCodec = (typeof FrameCodec)[keyof typeof FrameCodec];

export const FrameFlag = {
  /** The rect covers the whole frame. */
  FULL: 1 << 0,
  /** The guest cursor is drawn into the pixels. */
  CURSOR: 1 << 1,
  /** The rect is a dirty region to patch into the previous frame. */
  DIRTY_RECT: 1 << 2,
} as const;
const KNOWN_FLAGS = FrameFlag.FULL | FrameFlag.CURSOR | FrameFlag.DIRTY_RECT;

const KNOWN_KINDS: ReadonlySet<number> = new Set(Object.values(FrameKind));
const KNOWN_CODECS: ReadonlySet<number> = new Set(Object.values(FrameCodec));

export interface Mvf1Header {
  kind: FrameKind;
  codec: FrameCodec;
  flags: number;
  pcSlot: number;
  seq: number;
  /** Full frame width in pixels. */
  w: number;
  /** Full frame height in pixels. */
  h: number;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
  payloadLen: number;
}

/** Header fields supplied when encoding; the rect defaults to the full frame and `payloadLen` is derived. */
export type Mvf1HeaderInit = Omit<Mvf1Header, 'payloadLen' | 'rectX' | 'rectY' | 'rectW' | 'rectH'> &
  Partial<Pick<Mvf1Header, 'rectX' | 'rectY' | 'rectW' | 'rectH'>>;

export interface Mvf1Frame {
  header: Mvf1Header;
  /** A view into the decoded buffer (no copy). */
  payload: Uint8Array;
}

export type Mvf1ErrorCode =
  | 'TOO_SHORT'
  | 'BAD_MAGIC'
  | 'BAD_LENGTH'
  | 'BAD_KIND'
  | 'BAD_CODEC'
  | 'BAD_FLAGS'
  | 'BAD_GEOMETRY'
  | 'BAD_PAYLOAD'
  | 'OUT_OF_RANGE';

export class Mvf1Error extends Error {
  readonly code: Mvf1ErrorCode;

  constructor(code: Mvf1ErrorCode, message: string) {
    super(`MVF1 ${code}: ${message}`);
    this.name = 'Mvf1Error';
    this.code = code;
  }
}

const BYTES_PER_PIXEL = 4;

function checkUint(name: string, value: number, bits: 8 | 16 | 32): void {
  const max = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Mvf1Error('OUT_OF_RANGE', `${name}=${value} is not a u${bits}`);
  }
}

/**
 * Validates header semantics. When `payload` is given, also checks it against the codec
 * (raw codecs: exact size; JPEG: SOI marker).
 */
export function validateHeader(header: Mvf1Header, payload?: Uint8Array): void {
  checkUint('kind', header.kind, 8);
  checkUint('codec', header.codec, 8);
  checkUint('flags', header.flags, 16);
  checkUint('pcSlot', header.pcSlot, 32);
  checkUint('seq', header.seq, 32);
  checkUint('w', header.w, 16);
  checkUint('h', header.h, 16);
  checkUint('rectX', header.rectX, 16);
  checkUint('rectY', header.rectY, 16);
  checkUint('rectW', header.rectW, 16);
  checkUint('rectH', header.rectH, 16);
  checkUint('payloadLen', header.payloadLen, 32);

  if (!KNOWN_KINDS.has(header.kind)) throw new Mvf1Error('BAD_KIND', `unknown kind ${header.kind}`);
  if (!KNOWN_CODECS.has(header.codec)) throw new Mvf1Error('BAD_CODEC', `unknown codec ${header.codec}`);
  if ((header.flags & ~KNOWN_FLAGS) !== 0) {
    throw new Mvf1Error('BAD_FLAGS', `reserved flag bits set (0x${header.flags.toString(16)})`);
  }
  const full = (header.flags & FrameFlag.FULL) !== 0;
  const dirty = (header.flags & FrameFlag.DIRTY_RECT) !== 0;
  if (full && dirty) throw new Mvf1Error('BAD_FLAGS', 'FULL and DIRTY_RECT are mutually exclusive');

  if (header.w === 0 || header.h === 0) throw new Mvf1Error('BAD_GEOMETRY', 'frame size must be non-zero');
  if (header.rectW === 0 || header.rectH === 0) throw new Mvf1Error('BAD_GEOMETRY', 'rect must be non-empty');
  if (header.rectX + header.rectW > header.w || header.rectY + header.rectH > header.h) {
    throw new Mvf1Error(
      'BAD_GEOMETRY',
      `rect ${header.rectX},${header.rectY} ${header.rectW}x${header.rectH} exceeds ${header.w}x${header.h}`,
    );
  }
  const coversFrame =
    header.rectX === 0 && header.rectY === 0 && header.rectW === header.w && header.rectH === header.h;
  if (full && !coversFrame) throw new Mvf1Error('BAD_GEOMETRY', 'FULL frame rect must cover the frame');

  if (header.payloadLen > MVF1_MAX_PAYLOAD_BYTES) {
    throw new Mvf1Error('BAD_LENGTH', `payload ${header.payloadLen} exceeds ${MVF1_MAX_PAYLOAD_BYTES}`);
  }
  if (header.codec === FrameCodec.RGBA8 || header.codec === FrameCodec.BGRA8) {
    const expected = header.rectW * header.rectH * BYTES_PER_PIXEL;
    if (header.payloadLen !== expected) {
      throw new Mvf1Error('BAD_PAYLOAD', `raw payload is ${header.payloadLen} bytes, rect needs ${expected}`);
    }
  } else if (header.codec === FrameCodec.JPEG) {
    if (header.payloadLen < 4) throw new Mvf1Error('BAD_PAYLOAD', 'JPEG payload too short');
    if (payload !== undefined && (payload[0] !== 0xff || payload[1] !== 0xd8)) {
      throw new Mvf1Error('BAD_PAYLOAD', 'JPEG payload lacks the SOI marker');
    }
  }
  if (payload !== undefined && payload.byteLength !== header.payloadLen) {
    throw new Mvf1Error(
      'BAD_LENGTH',
      `payload is ${payload.byteLength} bytes, header says ${header.payloadLen}`,
    );
  }
}

/** Encodes one frame (header + payload) into a new buffer. Throws {@link Mvf1Error} on invalid input. */
export function encodeFrame(init: Mvf1HeaderInit, payload: Uint8Array): Uint8Array {
  const header: Mvf1Header = {
    kind: init.kind,
    codec: init.codec,
    flags: init.flags,
    pcSlot: init.pcSlot,
    seq: init.seq,
    w: init.w,
    h: init.h,
    rectX: init.rectX ?? 0,
    rectY: init.rectY ?? 0,
    rectW: init.rectW ?? init.w,
    rectH: init.rectH ?? init.h,
    payloadLen: payload.byteLength,
  };
  validateHeader(header, payload);
  const out = new Uint8Array(MVF1_HEADER_BYTES + payload.byteLength);
  writeHeader(new DataView(out.buffer, out.byteOffset, MVF1_HEADER_BYTES), header);
  out.set(payload, MVF1_HEADER_BYTES);
  return out;
}

/** Encodes only the 32-byte header (for scatter/gather sends). */
export function encodeFrameHeader(header: Mvf1Header): Uint8Array {
  validateHeader(header);
  const out = new Uint8Array(MVF1_HEADER_BYTES);
  writeHeader(new DataView(out.buffer), header);
  return out;
}

function writeHeader(view: DataView, h: Mvf1Header): void {
  view.setUint32(0, MVF1_MAGIC, false);
  view.setUint8(4, h.kind);
  view.setUint8(5, h.codec);
  view.setUint16(6, h.flags, false);
  view.setUint32(8, h.pcSlot, false);
  view.setUint32(12, h.seq, false);
  view.setUint16(16, h.w, false);
  view.setUint16(18, h.h, false);
  view.setUint16(20, h.rectX, false);
  view.setUint16(22, h.rectY, false);
  view.setUint16(24, h.rectW, false);
  view.setUint16(26, h.rectH, false);
  view.setUint32(28, h.payloadLen, false);
}

/** Reads and validates the header of `buf` (does not require the payload to be present). */
export function decodeFrameHeader(buf: Uint8Array): Mvf1Header {
  if (buf.byteLength < MVF1_HEADER_BYTES) {
    throw new Mvf1Error(
      'TOO_SHORT',
      `${buf.byteLength} bytes is shorter than the ${MVF1_HEADER_BYTES}-byte header`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, MVF1_HEADER_BYTES);
  const magic = view.getUint32(0, false);
  if (magic !== MVF1_MAGIC)
    throw new Mvf1Error('BAD_MAGIC', `magic 0x${magic.toString(16).padStart(8, '0')}`);
  const header: Mvf1Header = {
    kind: view.getUint8(4) as FrameKind,
    codec: view.getUint8(5) as FrameCodec,
    flags: view.getUint16(6, false),
    pcSlot: view.getUint32(8, false),
    seq: view.getUint32(12, false),
    w: view.getUint16(16, false),
    h: view.getUint16(18, false),
    rectX: view.getUint16(20, false),
    rectY: view.getUint16(22, false),
    rectW: view.getUint16(24, false),
    rectH: view.getUint16(26, false),
    payloadLen: view.getUint32(28, false),
  };
  validateHeader(header);
  return header;
}

/** Decodes one complete frame. The buffer must hold exactly header + payload. */
export function decodeFrame(buf: Uint8Array): Mvf1Frame {
  const header = decodeFrameHeader(buf);
  const actual = buf.byteLength - MVF1_HEADER_BYTES;
  if (actual !== header.payloadLen) {
    throw new Mvf1Error(
      'BAD_LENGTH',
      `buffer holds ${actual} payload bytes, header says ${header.payloadLen}`,
    );
  }
  const payload = buf.subarray(MVF1_HEADER_BYTES);
  validateHeader(header, payload);
  return { header, payload };
}

/** Cheap check used before sending: does `buf` start with the MVF1 magic and hold at least a header? */
export function looksLikeMvf1(buf: Uint8Array): boolean {
  return (
    buf.byteLength >= MVF1_HEADER_BYTES &&
    buf[0] === 0x4d &&
    buf[1] === 0x56 &&
    buf[2] === 0x46 &&
    buf[3] === 0x31
  );
}
