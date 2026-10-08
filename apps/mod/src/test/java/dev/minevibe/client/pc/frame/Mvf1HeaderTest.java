package dev.minevibe.client.pc.frame;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import org.junit.jupiter.api.Test;

/** MVF1 header parsing and validation (protocol section 8), mirroring {@code packages/protocol/test/mvf1.test.ts}. */
class Mvf1HeaderTest {
	static ByteBuffer frame(final Mvf1Header h, final byte[] payload) {
		ByteBuffer b = ByteBuffer.allocateDirect(Mvf1Header.HEADER_BYTES + payload.length);
		b.put(h.encode()).put(payload).flip();
		return b;
	}

	static Mvf1Header bgra(final int w, final int h, final long seq) {
		return new Mvf1Header(1, Mvf1Header.CODEC_BGRA8, Mvf1Header.FLAG_FULL, 7, seq, w, h, 0, 0, w, h, (long) w * h * 4);
	}

	@Test
	void parsesAFullBgraFrame() throws Exception {
		Mvf1Header h = Mvf1Header.parse(frame(bgra(4, 2, 0xFFFF_FFFEL), new byte[32]));
		assertEquals(7, h.pcSlot());
		assertEquals(0xFFFF_FFFEL, h.seq(), "seq is an unsigned u32");
		assertEquals(4, h.w());
		assertEquals(2, h.h());
		assertTrue(h.isFull());
		assertTrue(h.coversFrame());
		assertTrue(h.isRaw());
	}

	@Test
	void parsesADirtyRectAndAJpeg() throws Exception {
		Mvf1Header rect = new Mvf1Header(1, Mvf1Header.CODEC_RGBA8, Mvf1Header.FLAG_DIRTY_RECT, 1, 2, 100, 50, 10, 20, 3, 2, 24);
		Mvf1Header parsed = Mvf1Header.parse(frame(rect, new byte[24]));
		assertTrue(parsed.isDirtyRect());
		assertFalse(parsed.coversFrame());
		byte[] jpeg = {(byte) 0xFF, (byte) 0xD8, 1, 2, 3};
		Mvf1Header j = new Mvf1Header(1, Mvf1Header.CODEC_JPEG, Mvf1Header.FLAG_FULL, 3, 9, 640, 400, 0, 0, 640, 400, jpeg.length);
		assertEquals(Mvf1Header.CODEC_JPEG, Mvf1Header.parse(frame(j, jpeg)).codec());
	}

	@Test
	void rejectsBrokenFrames() {
		assertThrows(Mvf1Header.InvalidFrameException.class, () -> Mvf1Header.parse(ByteBuffer.allocate(10)), "too short");
		ByteBuffer badMagic = frame(bgra(1, 1, 0), new byte[4]);
		badMagic.put(0, (byte) 0);
		assertThrows(Mvf1Header.InvalidFrameException.class, () -> Mvf1Header.parse(badMagic), "magic");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(2, 3, 1, 0, 0, 1, 1, 0, 0, 1, 1, 4), new byte[4])), "kind");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 9, 1, 0, 0, 1, 1, 0, 0, 1, 1, 4), new byte[4])), "codec");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 8, 0, 0, 1, 1, 0, 0, 1, 1, 4), new byte[4])), "reserved flag");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 5, 0, 0, 1, 1, 0, 0, 1, 1, 4), new byte[4])), "FULL and DIRTY_RECT");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 4, 0, 0, 4, 4, 3, 3, 2, 2, 16), new byte[16])), "rect outside");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 1, 0, 0, 4, 4, 0, 0, 2, 2, 16), new byte[16])), "FULL must cover");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 1, 0, 0, 2, 2, 0, 0, 2, 2, 12), new byte[12])), "raw size");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2, 5), new byte[] {1, 2, 3, 4, 5})), "JPEG SOI");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(bgra(2, 2, 0), new byte[15])), "payload length");
		assertThrows(Mvf1Header.InvalidFrameException.class,
			() -> Mvf1Header.parse(frame(new Mvf1Header(1, 3, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0), new byte[0])), "empty frame");
	}
}
