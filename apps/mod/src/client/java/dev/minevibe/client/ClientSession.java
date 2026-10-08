package dev.minevibe.client;

import dev.minevibe.bridge.protocol.Messages;
import org.jspecify.annotations.Nullable;

/**
 * What the client knows about its world: the target Node asked for ({@code world.open}), the next world
 * ({@code world.next}), and the world it is in or loading. Written by bridge handlers and screens on the client
 * thread; read from bridge threads too (the {@code hello} snapshot), hence the volatile fields.
 */
public final class ClientSession {
	private static final ClientSession INSTANCE = new ClientSession();

	public static ClientSession get() {
		return INSTANCE;
	}

	private volatile Messages.@Nullable WorldOpen pendingOpen;
	private volatile Messages.@Nullable WorldNext lastNext;
	private volatile boolean lastNextShown;

	private volatile @Nullable String worldId;
	private volatile int gen;
	private volatile boolean fresh;
	private volatile boolean loading;
	private volatile long loadStartedNanos;
	private volatile @Nullable String readyWorldId;

	private volatile @Nullable String gameOverWorldId;
	private volatile long gameOverSinceNanos;

	private ClientSession() {}

	// --- Node's instructions --------------------------------------------------------------------

	/** A {@code world.open} to act on (BootScreen takes it). */
	public void offerOpen(Messages.WorldOpen open) {
		pendingOpen = open;
		if (open.gen() > 0 && open.worldId().equals(worldId)) gen = open.gen();
	}

	/** The pending {@code world.open}, left in place (a screen that is replaced before acting must not lose it). */
	public Messages.@Nullable WorldOpen peekPendingOpen() {
		return pendingOpen;
	}

	/** Removes {@code open} if it is still the pending request; returns whether it was. */
	public synchronized boolean claimPendingOpen(Messages.WorldOpen open) {
		if (pendingOpen != open) return false;
		pendingOpen = null;
		return true;
	}

	public void offerNext(Messages.WorldNext next) {
		Messages.WorldNext previous = lastNext;
		lastNext = next;
		if (previous == null || !previous.worldId().equals(next.worldId())) lastNextShown = false;
	}

	/** The {@code world.next} that follows {@code deadWorldId}, if Node sent it. */
	public Messages.@Nullable WorldNext nextFor(@Nullable String deadWorldId) {
		Messages.WorldNext next = lastNext;
		return next != null && deadWorldId != null && next.summary().worldId().equals(deadWorldId) ? next : null;
	}

	/** A {@code world.next} no Game Over screen has shown yet (BootScreen opens one for it). */
	public Messages.@Nullable WorldNext takeUnshownNext() {
		Messages.WorldNext next = lastNext;
		if (next == null || lastNextShown) return null;
		lastNextShown = true;
		return next;
	}

	public void markNextShown() {
		lastNextShown = true;
	}

	// --- The client's own world -------------------------------------------------------------------

	/** Opening or creating {@code id} is starting. */
	public void beginLoading(String id, int gen, boolean fresh) {
		this.worldId = id;
		this.gen = gen;
		this.fresh = fresh;
		this.loading = true;
		this.loadStartedNanos = System.nanoTime();
		this.readyWorldId = null;
	}

	/** The world is loaded and reported {@code ready}. Returns false if it already was. */
	public boolean markReady(String id) {
		if (id.equals(readyWorldId)) return false;
		if (!id.equals(worldId)) {
			// Opened by something other than BootScreen (e.g. a test): adopt it.
			worldId = id;
			gen = 0;
			fresh = false;
		}
		readyWorldId = id;
		loading = false;
		return true;
	}

	/** The client left its world (or never had one); keeps the id for Game Over. */
	public void leftWorld() {
		readyWorldId = null;
		loading = false;
	}

	/** The dead world was closed and reported; it is no longer the client's world. */
	public void markClosed(String id) {
		if (id.equals(worldId)) {
			worldId = null;
			gen = 0;
			fresh = false;
		}
		readyWorldId = null;
		loading = false;
		if (id.equals(gameOverWorldId)) gameOverWorldId = null;
	}

	public @Nullable String worldId() {
		return worldId;
	}

	/** World number, 0 when unknown. */
	public int gen() {
		return gen;
	}

	public boolean fresh() {
		return fresh;
	}

	public boolean loading() {
		return loading;
	}

	public long loadStartedNanos() {
		return loadStartedNanos;
	}

	public boolean isReady(String id) {
		return id.equals(readyWorldId);
	}

	/** When Game Over for {@code id} first showed (kept across screen re-inits so the 10 s fallback is not reset). */
	public long gameOverSince(String id) {
		if (!id.equals(gameOverWorldId)) {
			gameOverWorldId = id;
			gameOverSinceNanos = System.nanoTime();
		}
		return gameOverSinceNanos;
	}
}
