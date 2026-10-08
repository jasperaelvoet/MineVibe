package dev.minevibe.client.pc.frame;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.BufferPool;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

/** The 2-thread frame decoder: routing by slot, acks, latest wins without losing dirty rects, STB JPEG. */
class FrameDecoderTest {
	private final BufferPool pool = new BufferPool();
	private final Map<String, MonitorFrame> frames = new ConcurrentHashMap<>();
	private final List<String> acks = new CopyOnWriteArrayList<>();

	private BufferPool.PooledBuffer message(final Mvf1Header h, final byte[] payload) {
		BufferPool.PooledBuffer buf = this.pool.acquire(Mvf1Header.HEADER_BYTES + payload.length);
		buf.buffer().put(h.encode()).put(payload).flip();
		return buf;
	}

	private static Mvf1Header full(final long seq, final int w, final int h) {
		return new Mvf1Header(1, Mvf1Header.CODEC_BGRA8, Mvf1Header.FLAG_FULL, 7, seq, w, h, 0, 0, w, h, (long) w * h * 4);
	}

	private static Mvf1Header dirty(final long seq) {
		return new Mvf1Header(1, Mvf1Header.CODEC_BGRA8, Mvf1Header.FLAG_DIRTY_RECT, 7, seq, 2, 2, 1, 1, 1, 1, 4);
	}

	private FrameDecoder decoder(final CountDownLatch gate) {
		return new FrameDecoder(
			slot -> slot == 7 ? "linux-1" : null,
			pcId -> {
				try {
					gate.await(5, TimeUnit.SECONDS);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
				}
				return this.frames.computeIfAbsent(pcId, k -> new MonitorFrame());
			},
			(pcId, seq) -> this.acks.add(pcId + "#" + seq),
			2
		);
	}

	private void awaitAcks(final int n) throws InterruptedException {
		long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
		while (this.acks.size() < n && System.nanoTime() < deadline) {
			Thread.sleep(5);
		}
	}

	@Test
	void decodesAndAcksABgraFrame() throws Exception {
		FrameDecoder d = this.decoder(new CountDownLatch(0));
		d.onFrame(this.message(full(41, 1, 1), new byte[] {(byte) 0xFF, 0, 0, 0}));
		this.awaitAcks(1);
		assertEquals(List.of("linux-1#41"), this.acks);
		assertEquals(0xFFFF0000, this.frames.get("linux-1").pixel(0, 0));
		int allocations = this.pool.allocations();
		this.pool.acquire(64).release();
		assertEquals(allocations, this.pool.allocations(), "the frame's buffer went back to the pool");
		d.shutdown();
	}

	@Test
	void framesOfUnknownSlotsAreDroppedWithoutAck() throws Exception {
		FrameDecoder d = this.decoder(new CountDownLatch(0));
		long before = PcStats.UNKNOWN_SLOT.get();
		Mvf1Header other = new Mvf1Header(1, 3, 1, 99, 1, 1, 1, 0, 0, 1, 1, 4);
		d.onFrame(this.message(other, new byte[4]));
		Thread.sleep(50);
		assertTrue(this.acks.isEmpty());
		assertEquals(before + 1, PcStats.UNKNOWN_SLOT.get());
		d.shutdown();
	}

	@Test
	void aFullFrameReplacesWaitingFramesButDirtyRectsAreNeverDroppedForOneAnother() throws Exception {
		CountDownLatch gate = new CountDownLatch(1);
		FrameDecoder d = this.decoder(gate);
		d.onFrame(this.message(full(1, 2, 2), new byte[16]));
		Thread.sleep(50);
		d.onFrame(this.message(dirty(2), new byte[4]));
		d.onFrame(this.message(dirty(3), new byte[4]));
		assertEquals(2, d.pending(7), "dirty rects wait in order");
		d.onFrame(this.message(full(4, 2, 2), new byte[16]));
		assertEquals(1, d.pending(7), "the full frame dropped the dirty rects before it");
		gate.countDown();
		this.awaitAcks(2);
		Thread.sleep(50);
		assertEquals(List.of("linux-1#1", "linux-1#4"), this.acks);

		this.acks.clear();
		CountDownLatch gate2 = new CountDownLatch(1);
		FrameDecoder d2 = this.decoder(gate2);
		d2.onFrame(this.message(full(10, 2, 2), new byte[16]));
		Thread.sleep(50);
		d2.onFrame(this.message(dirty(11), new byte[4]));
		d2.onFrame(this.message(dirty(12), new byte[4]));
		gate2.countDown();
		this.awaitAcks(3);
		assertEquals(List.of("linux-1#10", "linux-1#11", "linux-1#12"), this.acks, "every dirty rect is applied, in order");
		d.shutdown();
		d2.shutdown();
	}

	@Test
	void decodesJpegWithStb() throws Exception {
		BufferedImage image = new BufferedImage(16, 8, BufferedImage.TYPE_INT_RGB);
		Graphics2D g = image.createGraphics();
		g.setColor(new Color(200, 30, 40));
		g.fillRect(0, 0, 16, 8);
		g.dispose();
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		ImageIO.write(image, "jpg", out);
		byte[] jpeg = out.toByteArray();

		MonitorFrame frame = new MonitorFrame();
		ByteBuffer payload = ByteBuffer.allocateDirect(jpeg.length).put(jpeg).flip();
		Mvf1Header h = new Mvf1Header(1, Mvf1Header.CODEC_JPEG, Mvf1Header.FLAG_FULL, 7, 3, 16, 8, 0, 0, 16, 8, jpeg.length);
		assertTrue(FrameDecoder.decodeJpeg(frame, h, payload));
		int p = frame.pixel(8, 4);
		int r = p & 0xFF;
		int gg = (p >>> 8) & 0xFF;
		int b = (p >>> 16) & 0xFF;
		assertTrue(Math.abs(r - 200) < 12 && Math.abs(gg - 30) < 12 && Math.abs(b - 40) < 12, "decoded colour ~ (200,30,40), got " + r + "," + gg + "," + b);
		assertEquals(0xFF, p >>> 24, "opaque");

		Mvf1Header wrongSize = new Mvf1Header(1, Mvf1Header.CODEC_JPEG, Mvf1Header.FLAG_FULL, 7, 4, 32, 8, 0, 0, 32, 8, jpeg.length);
		assertTrue(!FrameDecoder.decodeJpeg(frame, wrongSize, payload.rewind()), "a JPEG that is not the rect's size is refused");
	}
}
