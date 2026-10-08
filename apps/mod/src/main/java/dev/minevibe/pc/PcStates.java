package dev.minevibe.pc;

import dev.minevibe.bridge.msg.Pc;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * What Node last said about the PCs (PLAN 7.5-7.7, protocol 7.7): every {@code PcInfo} by id, the MVF1 slot of each, the
 * host budget, and the seated agents' cursors. Written on bridge threads ({@code hello.ok}, {@code pc.state},
 * {@code budget.state}, {@code pc.cursor}); read on the client thread (monitors, screens) and the integrated server
 * thread (the LED). Everything here is thread-safe; {@link #version()} goes up on every change so screens can poll.
 */
public final class PcStates {
	private static final Map<String, Pc.PcInfo> BY_ID = new ConcurrentHashMap<>();
	private static final Map<Long, String> BY_SLOT = new ConcurrentHashMap<>();
	private static final Map<String, Pc.PcCursor> CURSORS = new ConcurrentHashMap<>();
	private static final List<Consumer<Pc.PcInfo>> LISTENERS = new CopyOnWriteArrayList<>();
	private static final List<Consumer<String>> REMOVAL_LISTENERS = new CopyOnWriteArrayList<>();
	private static final AtomicLong VERSION = new AtomicLong();

	private static volatile Pc.@Nullable Budget budget;
	private static volatile boolean connected;

	private PcStates() {}

	/** One PC changed ({@code pc.state}). Listeners run on the calling thread. */
	public static void put(final Pc.PcInfo info) {
		Pc.PcInfo previous = BY_ID.put(info.pcId(), info);
		if (previous != null && previous.slot() != info.slot()) {
			BY_SLOT.remove(previous.slot(), previous.pcId());
		}
		BY_SLOT.put(info.slot(), info.pcId());
		if ("decommissioned".equals(info.status())) {
			CURSORS.remove(info.pcId());
		}
		VERSION.incrementAndGet();
		for (Consumer<Pc.PcInfo> listener : LISTENERS) {
			listener.accept(info);
		}
	}

	/**
	 * The full snapshot of {@code hello.ok}: PCs Node no longer lists are dropped (and reported to the
	 * {@link #addRemovalListener removal listeners}).
	 */
	public static void replaceAll(final Collection<Pc.PcInfo> pcs, final Pc.@Nullable Budget newBudget) {
		List<String> gone = new ArrayList<>(BY_ID.keySet());
		for (Pc.PcInfo info : pcs) {
			gone.remove(info.pcId());
		}
		List<String> removedIds = new ArrayList<>();
		for (String id : gone) {
			Pc.PcInfo removed = BY_ID.remove(id);
			if (removed != null) {
				BY_SLOT.remove(removed.slot(), id);
				removedIds.add(id);
			}
			CURSORS.remove(id);
		}
		if (newBudget != null) {
			budget = newBudget;
		}
		connected = true;
		VERSION.incrementAndGet();
		for (String id : removedIds) {
			for (Consumer<String> listener : REMOVAL_LISTENERS) {
				listener.accept(id);
			}
		}
		for (Pc.PcInfo info : pcs) {
			put(info);
		}
	}

	public static void budget(final Pc.Budget newBudget) {
		budget = newBudget;
		VERSION.incrementAndGet();
	}

	public static void cursor(final Pc.PcCursor cursor) {
		CURSORS.put(cursor.pcId(), cursor);
	}

	/** The bridge connection went up or down; while down, monitors show "offline". */
	public static void connected(final boolean up) {
		if (connected != up) {
			connected = up;
			VERSION.incrementAndGet();
		}
	}

	public static boolean isConnected() {
		return connected;
	}

	public static Pc.@Nullable PcInfo get(final @Nullable String pcId) {
		return pcId == null ? null : BY_ID.get(pcId);
	}

	public static @Nullable String pcIdForSlot(final long slot) {
		return BY_SLOT.get(slot);
	}

	public static Collection<Pc.PcInfo> all() {
		return List.copyOf(BY_ID.values());
	}

	public static Pc.@Nullable Budget budget() {
		return budget;
	}

	public static Pc.@Nullable PcCursor cursorOf(final String pcId) {
		return CURSORS.get(pcId);
	}

	public static long version() {
		return VERSION.get();
	}

	/** Called on the thread that changes a PC (a bridge thread), so listeners must hand work off. */
	public static void addListener(final Consumer<Pc.PcInfo> listener) {
		LISTENERS.add(listener);
	}

	/**
	 * Called with the id of every PC a {@code hello.ok} snapshot no longer lists (Node deleted it while the bridge was
	 * down), on the bridge thread, so listeners must hand work off (free its monitor texture, turn its LED off).
	 */
	public static void addRemovalListener(final Consumer<String> listener) {
		REMOVAL_LISTENERS.add(listener);
	}

	/** Forgets everything (tests). */
	public static void clear() {
		BY_ID.clear();
		BY_SLOT.clear();
		CURSORS.clear();
		budget = null;
		connected = false;
		VERSION.incrementAndGet();
	}
}
