package dev.minevibe.bridge;

import java.nio.ByteBuffer;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Direct byte buffers in power-of-two size classes (64 KiB up to 128 MiB), reused across binary messages so a
 * steady stream of PC frames does not allocate a fresh direct buffer per frame. Each class keeps at most
 * {@link #MAX_FREE_PER_CLASS} idle buffers; extra ones are dropped for the GC.
 */
public final class BufferPool {
	public static final int MIN_CAPACITY = 64 * 1024;
	public static final int MAX_CAPACITY = 128 * 1024 * 1024;
	static final int MAX_FREE_PER_CLASS = 4;

	private static final int MIN_SHIFT = Integer.numberOfTrailingZeros(MIN_CAPACITY);
	private static final int CLASSES = Integer.numberOfTrailingZeros(MAX_CAPACITY) - MIN_SHIFT + 1;

	@SuppressWarnings("unchecked")
	private final ConcurrentLinkedQueue<ByteBuffer>[] free = new ConcurrentLinkedQueue[CLASSES];

	private final AtomicInteger[] freeCounts = new AtomicInteger[CLASSES];
	private final AtomicInteger allocations = new AtomicInteger();

	public BufferPool() {
		for (int i = 0; i < CLASSES; i++) {
			free[i] = new ConcurrentLinkedQueue<>();
			freeCounts[i] = new AtomicInteger();
		}
	}

	private static int classOf(int minCapacity) {
		int capacity = Math.max(MIN_CAPACITY, minCapacity);
		int shift = 32 - Integer.numberOfLeadingZeros(capacity - 1);
		return shift - MIN_SHIFT;
	}

	/** A cleared buffer with at least {@code minCapacity} bytes. */
	public PooledBuffer acquire(int minCapacity) {
		if (minCapacity > MAX_CAPACITY) throw new IllegalArgumentException("buffer too large: " + minCapacity);
		int cls = classOf(minCapacity);
		ByteBuffer buf = free[cls].poll();
		if (buf != null) {
			freeCounts[cls].decrementAndGet();
			buf.clear();
		} else {
			buf = ByteBuffer.allocateDirect(1 << (cls + MIN_SHIFT));
			allocations.incrementAndGet();
		}
		return new PooledBuffer(this, buf, cls);
	}

	void release(ByteBuffer buf, int cls) {
		if (freeCounts[cls].incrementAndGet() <= MAX_FREE_PER_CLASS) {
			free[cls].offer(buf);
		} else {
			freeCounts[cls].decrementAndGet();
		}
	}

	/** How many direct buffers this pool has allocated (for tests and stats). */
	public int allocations() {
		return allocations.get();
	}

	/** A buffer on loan from a {@link BufferPool}. Call {@link #release()} exactly once when done with it. */
	public static final class PooledBuffer {
		private final BufferPool pool;
		private final int sizeClass;
		private ByteBuffer buffer;

		PooledBuffer(BufferPool pool, ByteBuffer buffer, int sizeClass) {
			this.pool = pool;
			this.buffer = buffer;
			this.sizeClass = sizeClass;
		}

		/** The underlying buffer. Invalid after {@link #release()}. */
		public ByteBuffer buffer() {
			ByteBuffer b = buffer;
			if (b == null) throw new IllegalStateException("buffer already released");
			return b;
		}

		public int capacity() {
			return buffer().capacity();
		}

		/** Returns the buffer to the pool. Further calls are ignored. */
		public void release() {
			ByteBuffer b = buffer;
			if (b == null) return;
			buffer = null;
			pool.release(b, sizeClass);
		}
	}
}
