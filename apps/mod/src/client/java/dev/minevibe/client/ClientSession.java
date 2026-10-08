package dev.minevibe.client;

import dev.minevibe.bridge.protocol.Messages;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;

/**
 * What the client knows about its world: the target Node asked for ({@code world.open}), the next world
 * ({@code world.next}), the world it is in or loading, and the dead world it closed. Written by bridge handlers,
 * screens and the client tick on the client thread; read from bridge threads too (the {@code hello} snapshot), hence
 * the volatile fields.
 */
public final class ClientSession {
	/**
	 * A load that has not produced a world after this long is no longer treated as in progress (the integrated
	 * server never became ready, or a vanilla prompt replaced the loading screen and was left).
	 */
	public static final long LOAD_TIMEOUT_NANOS = TimeUnit.SECONDS.toNanos(120);

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

	/** The dead world this client closed last (Begin); Node may still talk about it for a moment. */
	private volatile @Nullable String closedWorldId;
	/** True from Begin until Node acknowledged {@code world.state{closed}} for {@link #closedWorldId}. */
	private volatile boolean closeUnacknowledged;

	private volatile @Nullable String gameOverWorldId;
	private volatile long gameOverSinceNanos;

	/** Published from the client tick, so {@code hello} never touches game state off the client thread. */
	private volatile boolean levelLoaded;
	private volatile @Nullable String playerName;

	ClientSession() {}

	// --- Node's instructions --------------------------------------------------------------------

	/** A {@code world.open} to act on (BootScreen takes it). */
	public synchronized void offerOpen(Messages.WorldOpen open) {
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

	/**
	 * Records Node's {@code world.next}. One that follows the dead world this client already closed is never shown
	 * as Game Over again (Node re-sends it after every {@code hello} until it has taken the {@code closed}).
	 */
	public void offerNext(Messages.WorldNext next) {
		Messages.WorldNext previous = lastNext;
		lastNext = next;
		if (isClosedWorld(next.summary().worldId())) {
			lastNextShown = true;
		} else if (previous == null || !previous.worldId().equals(next.worldId())) {
			lastNextShown = false;
		}
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
		if (isClosedWorld(next.summary().worldId())) return null;
		return next;
	}

	public void markNextShown() {
		lastNextShown = true;
	}

	// --- The client's own world -------------------------------------------------------------------

	/** Opening or creating {@code id} is starting. */
	public void beginLoading(String id, int gen, boolean fresh) {
		beginLoading(id, gen, fresh, System.nanoTime());
	}

	void beginLoading(String id, int gen, boolean fresh, long nowNanos) {
		this.worldId = id;
		this.gen = gen;
		this.fresh = fresh;
		this.loading = true;
		this.loadStartedNanos = nowNanos;
		this.readyWorldId = null;
	}

	/** Opening or creating {@code id} failed or was cancelled: nothing is loading any more. */
	public void loadFailed(String id) {
		if (id.equals(worldId)) {
			loading = false;
			readyWorldId = null;
		}
	}

	/**
	 * A load of {@code id} is under way: it was started, has not failed, and is not older than
	 * {@link #LOAD_TIMEOUT_NANOS}. There need not be an integrated server yet: opening an existing world
	 * ({@code WorldOpenFlows#openWorld}) reads and fixes the level data on a background executor first, with only
	 * the "Reading world data" screen up (DEBT M1 N1).
	 */
	public boolean isLoadInProgress(String id, long nowNanos) {
		return loading && id.equals(worldId) && nowNanos - loadStartedNanos < LOAD_TIMEOUT_NANOS;
	}

	/**
	 * Clears the loading flag of a load older than {@link #LOAD_TIMEOUT_NANOS} (it never produced a world). Returns
	 * true if it cleared one, so the caller can log it. The client tick and {@code world.open} use this: neither can
	 * tell a failed load from one still on the background executor.
	 */
	public boolean expireLoad(long nowNanos) {
		if (!loading || nowNanos - loadStartedNanos < LOAD_TIMEOUT_NANOS) return false;
		loading = false;
		readyWorldId = null;
		return true;
	}

	/**
	 * Clears the loading flag when BootScreen shows up with no world: vanilla falls back to a screen like it when
	 * opening or creating fails, so the load is over unless an integrated server runs (and is not past the timeout).
	 * Returns true if it cleared one.
	 */
	public boolean clearStaleLoad(boolean serverExists, long nowNanos) {
		if (!loading) return false;
		if (serverExists && nowNanos - loadStartedNanos < LOAD_TIMEOUT_NANOS) return false;
		loading = false;
		readyWorldId = null;
		return true;
	}

	/**
	 * The world is loaded and reported {@code ready}. Returns false if it already was. A {@code world.open} of this
	 * world still waiting for BootScreen (a duplicate Node sent while it loaded) is done with.
	 */
	public boolean markReady(String id) {
		dropPendingOpenFor(id);
		if (id.equals(readyWorldId)) return false;
		if (!id.equals(worldId)) {
			// Opened by something other than BootScreen (e.g. a test): adopt it.
			worldId = id;
			gen = 0;
			fresh = false;
		}
		readyWorldId = id;
		loading = false;
		if (id.equals(closedWorldId)) closedWorldId = null;
		return true;
	}

	/** The client left its world (or never had one); keeps the id for Game Over. */
	public void leftWorld() {
		readyWorldId = null;
		loading = false;
	}

	/**
	 * The dead world was closed (Begin): it is no longer the client's world, and Node's acknowledgement of
	 * {@code world.state{closed}} is outstanding until {@link #closeAcknowledged(String)}.
	 */
	public void markClosed(String id) {
		if (id.equals(worldId)) {
			worldId = null;
			gen = 0;
			fresh = false;
		}
		readyWorldId = null;
		loading = false;
		closedWorldId = id;
		closeUnacknowledged = true;
		if (id.equals(gameOverWorldId)) gameOverWorldId = null;
		dropPendingOpenFor(id);
	}

	/** Forgets a pending {@code world.open} of {@code id} (that world is open now, or closed for good). */
	private synchronized void dropPendingOpenFor(String id) {
		Messages.WorldOpen open = pendingOpen;
		if (open != null && open.worldId().equals(id)) pendingOpen = null;
	}

	/** Node acknowledged {@code world.state{closed}} for {@code id}. */
	public void closeAcknowledged(String id) {
		if (id.equals(closedWorldId)) closeUnacknowledged = false;
	}

	/** {@code id} is the dead world this client closed last. */
	public boolean isClosedWorld(@Nullable String id) {
		return id != null && id.equals(closedWorldId);
	}

	/**
	 * A {@code world.open} of {@code id} must wait: it is the dead world this client just closed, and Node has not
	 * acknowledged that yet (it may still be processing the death and will send the next world instead).
	 */
	public boolean isAwaitingCloseAck(@Nullable String id) {
		return closeUnacknowledged && isClosedWorld(id);
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

	// --- Snapshot for hello ----------------------------------------------------------------------

	/** Client thread: whether a client level exists right now (read by {@code hello} on bridge threads). */
	public void publishLevelLoaded(boolean loaded) {
		levelLoaded = loaded;
	}

	/** Client thread: the local profile name. */
	public void publishPlayerName(@Nullable String name) {
		playerName = name;
	}

	/** The world {@code hello} reports as {@code in_world}: the client's world while a level is loaded. */
	public @Nullable String helloWorldId() {
		String id = worldId;
		return levelLoaded && Messages.isWorldId(id) ? id : null;
	}

	public @Nullable String playerName() {
		return playerName;
	}
}
