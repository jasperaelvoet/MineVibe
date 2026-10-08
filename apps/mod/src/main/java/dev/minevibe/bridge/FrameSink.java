package dev.minevibe.bridge;

/**
 * Receives complete binary messages (MVF1 frames, protocol §8) from the bridge. The buffer is flipped (position
 * 0, limit = message length) and on loan from the bridge's pool: the sink must call
 * {@link BufferPool.PooledBuffer#release()} once it is done, on any thread.
 *
 * <p>It is called on the WebSocket listener thread, so a real sink (the 2-thread frame decoder, M4) hands the
 * buffer off instead of decoding in place.
 */
@FunctionalInterface
public interface FrameSink {
	void onFrame(BufferPool.PooledBuffer frame);

	/** Drops every frame (M1 has no monitors yet). */
	FrameSink DISCARD = BufferPool.PooledBuffer::release;
}
