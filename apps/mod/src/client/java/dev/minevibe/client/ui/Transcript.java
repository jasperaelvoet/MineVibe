package dev.minevibe.client.ui;

import dev.minevibe.bridge.msg.Ui;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * The part of one agent's transcript the client has seen: live {@code chat.append} lines plus pages fetched with
 * {@code chat.history} (AgentScreen paging). Entries are kept by sequence number, so overlaps and re-sends merge.
 */
public final class Transcript {
	/** Kept in memory per agent; older lines are paged in again from Node when needed. */
	static final int MAX_ENTRIES = 1000;

	private final TreeMap<Long, Ui.ChatEntry> entries = new TreeMap<>();
	/** Older entries exist on Node (unknown until the first history page arrives). */
	private boolean moreOlder = true;
	private boolean historyLoaded;

	public void add(Ui.ChatEntry entry) {
		entries.put(entry.seq(), entry);
		trim();
	}

	/**
	 * Merges a history page (oldest first). {@code more} says whether entries older than the page exist; it decides
	 * {@link #moreOlder()} only when the page reaches at least as far back as what is already here.
	 */
	public void addPage(List<Ui.ChatEntry> page, boolean more) {
		Long before = oldestSeq();
		for (Ui.ChatEntry e : page) entries.put(e.seq(), e);
		if (page.isEmpty()) {
			moreOlder = false;
		} else if (before == null || page.getFirst().seq() <= before) {
			moreOlder = more;
		}
		historyLoaded = true;
		trim();
	}

	public List<Ui.ChatEntry> entries() {
		return new ArrayList<>(entries.values());
	}

	public @Nullable Long oldestSeq() {
		return entries.isEmpty() ? null : entries.firstKey();
	}

	public boolean moreOlder() {
		return moreOlder;
	}

	public boolean historyLoaded() {
		return historyLoaded;
	}

	public int size() {
		return entries.size();
	}

	private void trim() {
		while (entries.size() > MAX_ENTRIES) {
			entries.pollFirstEntry();
			moreOlder = true;
		}
	}
}
