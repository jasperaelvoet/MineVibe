package dev.minevibe.client.pc.frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.util.concurrent.locks.ReentrantLock;
import org.jspecify.annotations.Nullable;

/**
 * The CPU copy of one PC's screen: tightly packed RGBA8 rows ({@code w * h * 4} bytes, a direct buffer the GPU upload
 * reads from), patched by the decoder threads and uploaded by the render thread.
 *
 * <ul>
 *   <li>Decoders patch a rect (raw BGRA8 with an R/B swizzle, raw RGBA8, or decoded JPEG pixels) under the lock; alpha
 *       is forced opaque. A frame of another size reallocates the copy (black) and marks the texture for
 *       recreation.</li>
 *   <li>Changed rows accumulate into one dirty band, so several decoded frames between two render frames cost one
 *       upload, and a dirty-rect frame never loses an earlier rect.</li>
 *   <li>The render thread only {@link #tryUpload tries} the lock: while a decoder holds it, the upload waits for the
 *       next frame instead of stalling the render thread.</li>
 * </ul>
 */
public final class MonitorFrame {
	/** Receives the rows to upload: {@code rows} holds rows {@code y .. y + height} at full width. */
	@FunctionalInterface
	public interface Uploader {
		void upload(ByteBuffer rows, int y, int height, int width, int frameHeight, boolean resized);
	}

	private final ReentrantLock lock = new ReentrantLock();
	private ByteBuffer pixels = ByteBuffer.allocateDirect(4);
	private int width;
	private int height;
	/** {@code width << 32 | height}, written under the lock, read by the render thread without it. */
	private volatile long size;
	private int dirtyY0 = Integer.MAX_VALUE;
	private int dirtyY1;
	private boolean resized;
	private long seq = -1;
	private long patches;
	private volatile long lastPatchNanos;

	public int width() {
		return (int) (this.size >>> 32);
	}

	public int height() {
		return (int) this.size;
	}

	/**
	 * The frame size as one consistent pair ({@code [w, h]}), or null before the first frame. Any thread: a resize
	 * never shows as a new width with the old height.
	 */
	public int @Nullable [] size() {
		long s = this.size;
		return s == 0 ? null : new int[] {(int) (s >>> 32), (int) s};
	}

	/** Sequence number of the last frame patched in, -1 before the first. */
	public long seq() {
		return this.seq;
	}

	/** {@link System#nanoTime()} of the last patch, 0 before the first. */
	public long lastPatchNanos() {
		return this.lastPatchNanos;
	}

	public long patches() {
		return this.patches;
	}

	/** Whether rows wait for upload (tests). */
	public boolean isDirty() {
		return this.dirtyY1 > this.dirtyY0;
	}

	/**
	 * Patches a raw rect ({@code rectW * rectH * 4} bytes from {@code src}'s position) into a {@code frameW x frameH}
	 * frame. {@code bgra} swizzles R and B.
	 */
	public void patchRaw(
		final int frameW, final int frameH, final int rectX, final int rectY, final int rectW, final int rectH, final ByteBuffer src, final boolean bgra, final long frameSeq
	) {
		IntBuffer in = src.slice(src.position(), rectW * rectH * 4).order(ByteOrder.LITTLE_ENDIAN).asIntBuffer();
		this.lock.lock();
		try {
			this.ensureSize(frameW, frameH);
			IntBuffer out = this.pixels.duplicate().order(ByteOrder.LITTLE_ENDIAN).asIntBuffer();
			for (int row = 0; row < rectH; row++) {
				int s = row * rectW;
				int d = (rectY + row) * frameW + rectX;
				if (bgra) {
					for (int i = 0; i < rectW; i++) {
						int x = in.get(s + i);
						// Little-endian BGRA bytes read as 0xAARRGGBB; RGBA bytes are 0xAABBGGRR.
						out.put(d + i, (x & 0x0000FF00) | ((x >>> 16) & 0xFF) | ((x & 0xFF) << 16) | 0xFF000000);
					}
				} else {
					for (int i = 0; i < rectW; i++) {
						out.put(d + i, in.get(s + i) | 0xFF000000);
					}
				}
			}
			this.markDirty(rectY, rectY + rectH, frameSeq);
		} finally {
			this.lock.unlock();
		}
	}

	/** Patches decoded RGBA8 pixels ({@code rectW * rectH * 4} bytes from {@code rgba}'s position, already opaque). */
	public void patchRgba(
		final int frameW, final int frameH, final int rectX, final int rectY, final int rectW, final int rectH, final ByteBuffer rgba, final long frameSeq
	) {
		int base = rgba.position();
		this.lock.lock();
		try {
			this.ensureSize(frameW, frameH);
			int rowBytes = rectW * 4;
			if (rectX == 0 && rectW == frameW) {
				this.pixels.put(rectY * frameW * 4, rgba, base, rowBytes * rectH);
			} else {
				for (int row = 0; row < rectH; row++) {
					this.pixels.put(((rectY + row) * frameW + rectX) * 4, rgba, base + row * rowBytes, rowBytes);
				}
			}
			this.markDirty(rectY, rectY + rectH, frameSeq);
		} finally {
			this.lock.unlock();
		}
	}

	private void ensureSize(final int frameW, final int frameH) {
		if (frameW == this.width && frameH == this.height) {
			return;
		}
		int bytes = frameW * frameH * 4;
		this.pixels = ByteBuffer.allocateDirect(bytes);
		IntBuffer black = this.pixels.duplicate().order(ByteOrder.LITTLE_ENDIAN).asIntBuffer();
		for (int i = 0; i < frameW * frameH; i++) {
			black.put(i, 0xFF000000);
		}
		this.width = frameW;
		this.height = frameH;
		this.size = ((long) frameW << 32) | frameH;
		this.resized = true;
		this.dirtyY0 = 0;
		this.dirtyY1 = frameH;
	}

	private void markDirty(final int y0, final int y1, final long frameSeq) {
		this.dirtyY0 = Math.min(this.dirtyY0, y0);
		this.dirtyY1 = Math.max(this.dirtyY1, y1);
		this.seq = frameSeq;
		this.patches++;
		this.lastPatchNanos = System.nanoTime();
	}

	/**
	 * Render thread: uploads the dirty rows if the lock is free right now. Returns true when it uploaded; false when
	 * nothing was dirty or a decoder held the lock (try again next frame).
	 */
	public boolean tryUpload(final Uploader uploader) {
		if (!this.lock.tryLock()) {
			return false;
		}
		try {
			if (this.dirtyY1 <= this.dirtyY0 || this.width == 0) {
				return false;
			}
			int y0 = this.dirtyY0;
			int y1 = this.dirtyY1;
			ByteBuffer rows = this.pixels.slice(y0 * this.width * 4, (y1 - y0) * this.width * 4);
			uploader.upload(rows, y0, y1 - y0, this.width, this.height, this.resized);
			this.resized = false;
			this.dirtyY0 = Integer.MAX_VALUE;
			this.dirtyY1 = 0;
			return true;
		} finally {
			this.lock.unlock();
		}
	}

	/** Copies one pixel as {@code 0xAABBGGRR} (tests). */
	public int pixel(final int x, final int y) {
		this.lock.lock();
		try {
			return this.pixels.duplicate().order(ByteOrder.LITTLE_ENDIAN).getInt((y * this.width + x) * 4);
		} finally {
			this.lock.unlock();
		}
	}

	/** CRC32 of the pixels, or -1 before the first frame (E2E snapshots: a changed screen changes it). */
	public long contentCrc() {
		this.lock.lock();
		try {
			if (this.size == 0) {
				return -1;
			}
			java.util.zip.CRC32 crc = new java.util.zip.CRC32();
			crc.update(this.pixels.duplicate().clear());
			return crc.getValue();
		} finally {
			this.lock.unlock();
		}
	}
}
