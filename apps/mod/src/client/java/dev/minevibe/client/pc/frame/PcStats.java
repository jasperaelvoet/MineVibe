package dev.minevibe.client.pc.frame;

import java.util.Arrays;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Counters and render-thread timings of the monitor pipeline (spike S4: the render-thread cost target is under 2 ms
 * per frame). Decoder counters are atomic; render-thread samples are only touched on the render thread. With
 * {@code -Dminevibe.pcStats=true} or {@code MINEVIBE_PC_STATS=1}, {@link #maybeLog} prints one {@code [pc-stats]} line
 * every five seconds.
 */
public final class PcStats {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");
	private static final long LOG_EVERY_NANOS = 5_000_000_000L;

	public static final AtomicLong RECEIVED = new AtomicLong();
	public static final AtomicLong INVALID = new AtomicLong();
	public static final AtomicLong UNKNOWN_SLOT = new AtomicLong();
	public static final AtomicLong DROPPED = new AtomicLong();
	public static final AtomicLong DECODED = new AtomicLong();
	public static final AtomicLong DECODE_FAILED = new AtomicLong();
	public static final AtomicLong DECODE_NANOS = new AtomicLong();
	public static final AtomicLong DECODED_BYTES = new AtomicLong();
	public static final AtomicLong ACKED = new AtomicLong();

	private static final boolean ENABLED = enabled();

	// Render thread only.
	private static long[] frameCost = new long[4096];
	private static int frameCostCount;
	private static long uploads;
	private static long uploadBytes;
	private static long uploadNanos;
	private static long uploadMaxNanos;
	private static long frameNanos;
	private static long renderFrames;
	private static long lastLog = System.nanoTime();
	private static long lastDecoded;
	private static long lastReceived;

	private PcStats() {}

	private static boolean enabled() {
		String p = System.getProperty("minevibe.pcStats");
		String e = System.getenv("MINEVIBE_PC_STATS");
		return "true".equalsIgnoreCase(p) || "1".equals(p) || "true".equalsIgnoreCase(e) || "1".equals(e);
	}

	public static boolean isEnabled() {
		return ENABLED;
	}

	/**
	 * Render thread: one upload of {@code bytes} took {@code nanos}. Upload statistics only; the caller's
	 * {@link #work} span already contains the upload.
	 */
	public static void upload(final long bytes, final long nanos) {
		uploads++;
		uploadBytes += bytes;
		uploadNanos += nanos;
		uploadMaxNanos = Math.max(uploadMaxNanos, nanos);
	}

	/** Render thread: all monitor work of one call site this frame (extraction including any upload, GUI drawing). */
	public static void work(final long nanos) {
		frameNanos += nanos;
	}

	/** Render thread, once per rendered frame: closes the frame's cost sample and logs when due. */
	public static void endFrame(final int fps) {
		if (frameNanos > 0) {
			if (frameCostCount == frameCost.length) {
				frameCost = Arrays.copyOf(frameCost, frameCost.length * 2);
			}
			frameCost[frameCostCount++] = frameNanos;
		}
		frameNanos = 0;
		renderFrames++;
		maybeLog(fps);
	}

	private static void maybeLog(final int fps) {
		long now = System.nanoTime();
		if (!ENABLED || now - lastLog < LOG_EVERY_NANOS) {
			return;
		}
		double seconds = (now - lastLog) / 1e9;
		long decoded = DECODED.get();
		long received = RECEIVED.get();
		long[] costs = Arrays.copyOf(frameCost, frameCostCount);
		Arrays.sort(costs);
		double avgUpload = uploads == 0 ? 0 : uploadNanos / 1e6 / uploads;
		double p50 = percentile(costs, 0.50);
		double p95 = percentile(costs, 0.95);
		double max = costs.length == 0 ? 0 : costs[costs.length - 1] / 1e6;
		double avgDecode = decoded == 0 ? 0 : DECODE_NANOS.get() / 1e6 / decoded;
		LOG.info(
			"[pc-stats] fps={} renderFrames={} framesWithMonitorWork={} recvFps={} decodedFps={} uploads={} uploadMiB={} uploadAvgMs={} uploadMaxMs={} costP50Ms={} costP95Ms={} costMaxMs={} decodeAvgMs={} dropped={} invalid={} unknownSlot={} decodeFailed={} acked={}",
			fps,
			renderFrames,
			costs.length,
			String.format("%.1f", (received - lastReceived) / seconds),
			String.format("%.1f", (decoded - lastDecoded) / seconds),
			uploads,
			String.format("%.1f", uploadBytes / 1048576.0),
			String.format("%.3f", avgUpload),
			String.format("%.3f", uploadMaxNanos / 1e6),
			String.format("%.3f", p50),
			String.format("%.3f", p95),
			String.format("%.3f", max),
			String.format("%.2f", avgDecode),
			DROPPED.get(),
			INVALID.get(),
			UNKNOWN_SLOT.get(),
			DECODE_FAILED.get(),
			ACKED.get()
		);
		lastLog = now;
		lastDecoded = decoded;
		lastReceived = received;
		DECODE_NANOS.set(0);
		DECODED.set(0);
		lastDecoded = 0;
		frameCostCount = 0;
		uploads = 0;
		uploadBytes = 0;
		uploadNanos = 0;
		uploadMaxNanos = 0;
		renderFrames = 0;
	}

	private static double percentile(final long[] sorted, final double q) {
		if (sorted.length == 0) {
			return 0;
		}
		int i = (int) Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
		return sorted[i] / 1e6;
	}
}
