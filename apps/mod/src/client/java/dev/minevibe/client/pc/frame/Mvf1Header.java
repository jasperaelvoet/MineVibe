package dev.minevibe.client.pc.frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * The 32-byte big-endian header of an MVF1 binary frame (protocol section 8; mirrors
 * {@code packages/protocol/src/mvf1.ts}), with the same validation: magic, known kind and codec, no reserved flag
 * bits, {@code FULL} and {@code DIRTY_RECT} exclusive, non-empty frame and rect inside it, a {@code FULL} rect
 * covering the frame, raw payloads of exactly {@code rectW * rectH * 4} bytes, JPEG payloads starting with SOI, and
 * {@code payloadLen} equal to the message length minus 32 (at most 64 MiB).
 */
public record Mvf1Header(
	int kind, int codec, int flags, long pcSlot, long seq, int w, int h, int rectX, int rectY, int rectW, int rectH, long payloadLen
) {
	public static final int MAGIC = 0x4D564631;
	public static final int HEADER_BYTES = 32;
	public static final long MAX_PAYLOAD_BYTES = 64L * 1024 * 1024;

	public static final int KIND_PC_FRAME = 1;
	public static final int CODEC_JPEG = 1;
	public static final int CODEC_RGBA8 = 2;
	public static final int CODEC_BGRA8 = 3;
	public static final int FLAG_FULL = 1;
	public static final int FLAG_CURSOR = 2;
	public static final int FLAG_DIRTY_RECT = 4;
	private static final int KNOWN_FLAGS = FLAG_FULL | FLAG_CURSOR | FLAG_DIRTY_RECT;

	/** A frame the mod must reject (and drop without acking). */
	public static final class InvalidFrameException extends Exception {
		public InvalidFrameException(final String message) {
			super("MVF1: " + message);
		}
	}

	public boolean isFull() {
		return (this.flags & FLAG_FULL) != 0;
	}

	public boolean isDirtyRect() {
		return (this.flags & FLAG_DIRTY_RECT) != 0;
	}

	/** The rect is the whole frame (with or without the {@code FULL} flag). */
	public boolean coversFrame() {
		return this.rectX == 0 && this.rectY == 0 && this.rectW == this.w && this.rectH == this.h;
	}

	public boolean isRaw() {
		return this.codec == CODEC_RGBA8 || this.codec == CODEC_BGRA8;
	}

	/**
	 * Reads and validates the header of one complete binary message ({@code frame} from position 0 to its limit;
	 * the buffer's position and byte order are left untouched).
	 */
	public static Mvf1Header parse(final ByteBuffer frame) throws InvalidFrameException {
		ByteBuffer b = frame.duplicate().order(ByteOrder.BIG_ENDIAN);
		int length = b.limit();
		if (length < HEADER_BYTES) {
			throw new InvalidFrameException(length + " bytes is shorter than the header");
		}
		if (b.getInt(0) != MAGIC) {
			throw new InvalidFrameException("bad magic 0x" + Integer.toHexString(b.getInt(0)));
		}
		Mvf1Header h = new Mvf1Header(
			Byte.toUnsignedInt(b.get(4)),
			Byte.toUnsignedInt(b.get(5)),
			Short.toUnsignedInt(b.getShort(6)),
			Integer.toUnsignedLong(b.getInt(8)),
			Integer.toUnsignedLong(b.getInt(12)),
			Short.toUnsignedInt(b.getShort(16)),
			Short.toUnsignedInt(b.getShort(18)),
			Short.toUnsignedInt(b.getShort(20)),
			Short.toUnsignedInt(b.getShort(22)),
			Short.toUnsignedInt(b.getShort(24)),
			Short.toUnsignedInt(b.getShort(26)),
			Integer.toUnsignedLong(b.getInt(28))
		);
		h.validate();
		if (h.payloadLen != length - HEADER_BYTES) {
			throw new InvalidFrameException("payload is " + (length - HEADER_BYTES) + " bytes, header says " + h.payloadLen);
		}
		if (h.codec == CODEC_JPEG && (Byte.toUnsignedInt(b.get(HEADER_BYTES)) != 0xFF || Byte.toUnsignedInt(b.get(HEADER_BYTES + 1)) != 0xD8)) {
			throw new InvalidFrameException("JPEG payload lacks the SOI marker");
		}
		return h;
	}

	/** Header semantics (protocol section 8), without the payload checks that need the bytes. */
	public void validate() throws InvalidFrameException {
		if (this.kind != KIND_PC_FRAME) {
			throw new InvalidFrameException("unknown kind " + this.kind);
		}
		if (this.codec != CODEC_JPEG && this.codec != CODEC_RGBA8 && this.codec != CODEC_BGRA8) {
			throw new InvalidFrameException("unknown codec " + this.codec);
		}
		if ((this.flags & ~KNOWN_FLAGS) != 0) {
			throw new InvalidFrameException("reserved flag bits set (0x" + Integer.toHexString(this.flags) + ")");
		}
		if (this.isFull() && this.isDirtyRect()) {
			throw new InvalidFrameException("FULL and DIRTY_RECT are mutually exclusive");
		}
		if (this.w == 0 || this.h == 0) {
			throw new InvalidFrameException("frame size must be non-zero");
		}
		if (this.rectW == 0 || this.rectH == 0) {
			throw new InvalidFrameException("rect must be non-empty");
		}
		if (this.rectX + this.rectW > this.w || this.rectY + this.rectH > this.h) {
			throw new InvalidFrameException("rect " + this.rectX + "," + this.rectY + " " + this.rectW + "x" + this.rectH + " exceeds " + this.w + "x" + this.h);
		}
		if (this.isFull() && !this.coversFrame()) {
			throw new InvalidFrameException("FULL frame rect must cover the frame");
		}
		if (this.payloadLen > MAX_PAYLOAD_BYTES) {
			throw new InvalidFrameException("payload " + this.payloadLen + " exceeds " + MAX_PAYLOAD_BYTES);
		}
		if (this.isRaw()) {
			long expected = (long) this.rectW * this.rectH * 4;
			if (this.payloadLen != expected) {
				throw new InvalidFrameException("raw payload is " + this.payloadLen + " bytes, rect needs " + expected);
			}
		} else if (this.payloadLen < 4) {
			throw new InvalidFrameException("JPEG payload too short");
		}
	}

	/** Encodes this header (tests and tools). */
	public ByteBuffer encode() {
		ByteBuffer b = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
		b.putInt(MAGIC).put((byte) this.kind).put((byte) this.codec).putShort((short) this.flags);
		b.putInt((int) this.pcSlot).putInt((int) this.seq);
		b.putShort((short) this.w).putShort((short) this.h);
		b.putShort((short) this.rectX).putShort((short) this.rectY).putShort((short) this.rectW).putShort((short) this.rectH);
		b.putInt((int) this.payloadLen);
		return b.flip();
	}
}
