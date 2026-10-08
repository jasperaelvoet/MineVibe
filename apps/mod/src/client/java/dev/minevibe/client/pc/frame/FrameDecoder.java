package dev.minevibe.client.pc.frame;

import dev.minevibe.bridge.BufferPool;
import dev.minevibe.bridge.FrameSink;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.function.LongFunction;
import org.jspecify.annotations.Nullable;
import org.lwjgl.stb.STBImage;
import org.lwjgl.system.MemoryStack;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decodes MVF1 frames off the render thread (PLAN 5, 7.6; protocol 8): two decoder threads, frames of one PC strictly
 * in order on one thread at a time, latest wins.
 *
 * <ul>
 *   <li>The sink runs on the WebSocket listener thread: it only parses the 32-byte header, finds the PC by its slot
 *       ({@code pc.state}) and queues the pooled buffer.</li>
 *   <li>A frame covering the whole screen drops every frame of that PC still waiting (their buffers go back to the
 *       pool). Dirty-rect frames are never dropped in favour of a newer dirty rect (that would lose a region); more
 *       than {@link #MAX_PENDING} waiting frames are all dropped.</li>
 *   <li>JPEG decodes with {@code STBImage.stbi_load_from_memory}; BGRA8 is copied with an R/B swizzle; RGBA8 is copied.
 *       The pixels land in the PC's {@link MonitorFrame}; the render thread uploads them.</li>
 *   <li>Every decoded frame is acknowledged ({@code pc.frame.ack}); Node keeps at most 2 unacknowledged frames per PC,
 *       and an acknowledgement also releases the older ones it skipped.</li>
 * </ul>
 */
public final class FrameDecoder implements FrameSink {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");
	static final int MAX_PENDING = 8;

	/** Sends {@code pc.frame.ack}. */
	@FunctionalInterface
	public interface Acker {
		void ack(String pcId, long seq);
	}

	private record Item(BufferPool.PooledBuffer buffer, Mvf1Header header, String pcId) {}

	private static final class Queue {
		final ArrayDeque<Item> items = new ArrayDeque<>();
		boolean scheduled;
	}

	private final ExecutorService pool;
	private final LongFunction<@Nullable String> pcIdForSlot;
	private final Function<String, MonitorFrame> frames;
	private final Acker acker;
	private final Map<Long, Queue> queues = new ConcurrentHashMap<>();

	public FrameDecoder(final LongFunction<@Nullable String> pcIdForSlot, final Function<String, MonitorFrame> frames, final Acker acker, final int threads) {
		this.pcIdForSlot = pcIdForSlot;
		this.frames = frames;
		this.acker = acker;
		AtomicInteger n = new AtomicInteger();
		this.pool = Executors.newFixedThreadPool(threads, r -> {
			Thread t = new Thread(r, "mv-pc-decode-" + n.incrementAndGet());
			t.setDaemon(true);
			t.setPriority(Thread.NORM_PRIORITY - 1);
			return t;
		});
	}

	@Override
	public void onFrame(final BufferPool.PooledBuffer frame) {
		PcStats.RECEIVED.incrementAndGet();
		Mvf1Header header;
		try {
			header = Mvf1Header.parse(frame.buffer());
		} catch (Mvf1Header.InvalidFrameException e) {
			PcStats.INVALID.incrementAndGet();
			LOG.debug("Dropping a frame: {}", e.getMessage());
			frame.release();
			return;
		}
		String pcId = this.pcIdForSlot.apply(header.pcSlot());
		if (pcId == null) {
			PcStats.UNKNOWN_SLOT.incrementAndGet();
			frame.release();
			return;
		}
		Queue q = this.queues.computeIfAbsent(header.pcSlot(), k -> new Queue());
		boolean schedule;
		synchronized (q) {
			if (header.coversFrame() || q.items.size() >= MAX_PENDING) {
				for (Item stale : q.items) {
					stale.buffer().release();
					PcStats.DROPPED.incrementAndGet();
				}
				q.items.clear();
			}
			q.items.add(new Item(frame, header, pcId));
			schedule = !q.scheduled;
			q.scheduled = true;
		}
		if (schedule) {
			try {
				this.pool.execute(() -> this.drain(q));
			} catch (RuntimeException e) {
				synchronized (q) {
					q.scheduled = false;
					q.items.forEach(item -> item.buffer().release());
					q.items.clear();
				}
			}
		}
	}

	private void drain(final Queue q) {
		while (true) {
			Item item;
			synchronized (q) {
				item = q.items.poll();
				if (item == null) {
					q.scheduled = false;
					return;
				}
			}
			this.decode(item);
		}
	}

	private void decode(final Item item) {
		long t0 = System.nanoTime();
		Mvf1Header h = item.header();
		try {
			MonitorFrame frame = this.frames.apply(item.pcId());
			ByteBuffer buf = item.buffer().buffer();
			ByteBuffer payload = buf.slice(Mvf1Header.HEADER_BYTES, (int) h.payloadLen());
			if (h.isRaw()) {
				frame.patchRaw(h.w(), h.h(), h.rectX(), h.rectY(), h.rectW(), h.rectH(), payload, h.codec() == Mvf1Header.CODEC_BGRA8, h.seq());
			} else if (!decodeJpeg(frame, h, payload)) {
				PcStats.DECODE_FAILED.incrementAndGet();
				return;
			}
			PcStats.DECODED.incrementAndGet();
			PcStats.DECODED_BYTES.addAndGet(h.payloadLen());
			PcStats.DECODE_NANOS.addAndGet(System.nanoTime() - t0);
			this.acker.ack(item.pcId(), h.seq());
			PcStats.ACKED.incrementAndGet();
		} catch (RuntimeException e) {
			PcStats.DECODE_FAILED.incrementAndGet();
			LOG.warn("Decoding a frame of {} failed", item.pcId(), e);
		} finally {
			item.buffer().release();
		}
	}

	/** STB JPEG decode into {@code frame}; false (logged at debug) when STB refuses or the size is not the rect's. */
	static boolean decodeJpeg(final MonitorFrame frame, final Mvf1Header h, final ByteBuffer jpeg) {
		try (MemoryStack stack = MemoryStack.stackPush()) {
			IntBuffer w = stack.mallocInt(1);
			IntBuffer hh = stack.mallocInt(1);
			IntBuffer comp = stack.mallocInt(1);
			ByteBuffer rgba = STBImage.stbi_load_from_memory(jpeg, w, hh, comp, 4);
			if (rgba == null) {
				LOG.debug("STB could not decode a JPEG frame: {}", STBImage.stbi_failure_reason());
				return false;
			}
			try {
				if (w.get(0) != h.rectW() || hh.get(0) != h.rectH()) {
					LOG.debug("JPEG is {}x{}, rect is {}x{}", w.get(0), hh.get(0), h.rectW(), h.rectH());
					return false;
				}
				frame.patchRgba(h.w(), h.h(), h.rectX(), h.rectY(), h.rectW(), h.rectH(), rgba, h.seq());
				return true;
			} finally {
				STBImage.stbi_image_free(rgba);
			}
		}
	}

	/** Frames of {@code pcSlot} still waiting (tests). */
	int pending(final long pcSlot) {
		Queue q = this.queues.get(pcSlot);
		if (q == null) {
			return 0;
		}
		synchronized (q) {
			return q.items.size();
		}
	}

	public void shutdown() {
		this.pool.shutdownNow();
	}
}
