package dev.minevibe.client.pc.frame;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The CPU frame: BGRA swizzle, opaque alpha, dirty-rect patching, one coalesced upload band. */
class MonitorFrameTest {
	private record Upload(int y, int height, int width, int frameHeight, boolean resized, int bytes) {}

	private static ByteBuffer pixels(final int... bytes) {
		ByteBuffer b = ByteBuffer.allocateDirect(bytes.length);
		for (int v : bytes) {
			b.put((byte) v);
		}
		return b.flip();
	}

	private static List<Upload> drain(final MonitorFrame f) {
		List<Upload> out = new ArrayList<>();
		f.tryUpload((rows, y, height, width, frameHeight, resized) -> out.add(new Upload(y, height, width, frameHeight, resized, rows.remaining())));
		return out;
	}

	@Test
	void bgraIsSwizzledToOpaqueRgba() {
		MonitorFrame f = new MonitorFrame();
		// Two BGRA pixels: blue (alpha 0) and a mix.
		f.patchRaw(2, 1, 0, 0, 2, 1, pixels(0xFF, 0, 0, 0, 0x11, 0x22, 0x33, 0x80), true, 5);
		// RGBA bytes read little-endian: 0xAABBGGRR.
		assertEquals(0xFFFF0000, f.pixel(0, 0), "blue, made opaque");
		assertEquals(0xFF112233, f.pixel(1, 0), "R=0x33 G=0x22 B=0x11");
		assertEquals(5, f.seq());
		List<Upload> up = drain(f);
		assertEquals(1, up.size());
		assertEquals(new Upload(0, 1, 2, 1, true, 8), up.getFirst());
		assertTrue(drain(f).isEmpty(), "nothing left to upload");
	}

	@Test
	void rgbaIsCopiedAndForcedOpaque() {
		MonitorFrame f = new MonitorFrame();
		f.patchRaw(1, 1, 0, 0, 1, 1, pixels(0x10, 0x20, 0x30, 0x00), false, 1);
		assertEquals(0xFF302010, f.pixel(0, 0));
	}

	@Test
	void dirtyRectsPatchAndUnionIntoOneBand() {
		MonitorFrame f = new MonitorFrame();
		f.patchRaw(4, 4, 0, 0, 4, 4, ByteBuffer.allocateDirect(64), false, 1);
		drain(f);
		f.patchRaw(4, 4, 1, 1, 1, 1, pixels(1, 2, 3, 4), false, 2);
		f.patchRaw(4, 4, 2, 3, 2, 1, pixels(5, 6, 7, 8, 9, 10, 11, 12), false, 3);
		assertEquals(0xFF030201, f.pixel(1, 1));
		assertEquals(0xFF0B0A09, f.pixel(3, 3));
		assertEquals(0xFF000000, f.pixel(0, 0), "untouched pixels keep their value");
		List<Upload> up = drain(f);
		assertEquals(1, up.size(), "two rects between frames cost one upload");
		assertEquals(new Upload(1, 3, 4, 4, false, 3 * 4 * 4), up.getFirst(), "rows 1..3 at full width");
		assertEquals(3, f.seq());
	}

	@Test
	void decodedPixelsAndResizes() {
		MonitorFrame f = new MonitorFrame();
		f.patchRgba(2, 2, 0, 0, 2, 2, pixels(1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255), 1);
		assertEquals(0xFF040404, f.pixel(1, 1));
		drain(f);
		f.patchRgba(3, 1, 1, 0, 1, 1, pixels(9, 9, 9, 255), 2);
		assertEquals(3, f.width());
		assertEquals(0xFF000000, f.pixel(0, 0), "a new size starts black");
		assertEquals(0xFF090909, f.pixel(1, 0));
		Upload u = drain(f).getFirst();
		assertTrue(u.resized());
		assertEquals(3, u.width());
	}

	@Test
	void anUploadWaitsWhileADecoderHoldsTheFrame() throws Exception {
		MonitorFrame f = new MonitorFrame();
		f.patchRaw(1, 1, 0, 0, 1, 1, pixels(1, 2, 3, 4), false, 1);
		assertTrue(f.isDirty());
		Thread holder = new Thread(() -> f.patchRaw(1, 1, 0, 0, 1, 1, pixels(1, 2, 3, 4), false, 2));
		// tryUpload never blocks; with no contention it uploads.
		holder.start();
		holder.join();
		assertEquals(1, drain(f).size());
		assertFalse(f.isDirty());
	}
}
