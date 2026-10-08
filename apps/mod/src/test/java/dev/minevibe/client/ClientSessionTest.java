package dev.minevibe.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.protocol.Messages;
import java.util.List;
import org.junit.jupiter.api.Test;

/** World bookkeeping that decides whether a {@code world.open} is acted on (review findings MAJOR 1 and 2). */
class ClientSessionTest {
	private static final long SECOND = 1_000_000_000L;

	private static Messages.WorldNext next(String dead, String next, int gen) {
		return new Messages.WorldNext(next, gen, new Messages.WorldNext.Summary(dead, gen - 1, 1, "fell", null, List.of(), List.of()));
	}

	@Test
	void aFailedLoadIsNotInProgress() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-2", 2, true, 0);
		assertTrue(s.loading());
		// No integrated server: vanilla gave up before starting one (datapack failure, unreadable level).
		assertFalse(s.isLoadInProgress("world-2", false, SECOND));
		assertTrue(s.clearStaleLoad(false, SECOND), "a load with no server is cleared");
		assertFalse(s.loading());
		assertFalse(s.clearStaleLoad(false, 2 * SECOND), "nothing left to clear");
	}

	@Test
	void aRunningLoadIsInProgressUntilItTimesOut() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-2", 2, true, 0);
		assertTrue(s.isLoadInProgress("world-2", true, 5 * SECOND));
		assertFalse(s.isLoadInProgress("world-3", true, 5 * SECOND), "another world is not this load");
		assertFalse(s.clearStaleLoad(true, 5 * SECOND));
		long late = ClientSession.LOAD_TIMEOUT_NANOS + SECOND;
		assertFalse(s.isLoadInProgress("world-2", true, late), "a load past its timeout no longer blocks world.open");
		assertTrue(s.clearStaleLoad(true, late));
		assertFalse(s.loading());
	}

	@Test
	void loadFailedOnlyClearsThatWorld() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-2", 2, true, 0);
		s.loadFailed("world-1");
		assertTrue(s.loading());
		s.loadFailed("world-2");
		assertFalse(s.loading());
	}

	@Test
	void aClosedDeadWorldIsNotShownOrReopenedUntilNodeAcknowledges() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-1", 1, true, 0);
		s.markReady("world-1");
		s.markClosed("world-1");
		assertNull(s.worldId());
		assertTrue(s.isClosedWorld("world-1"));
		assertTrue(s.isAwaitingCloseAck("world-1"));
		assertFalse(s.isAwaitingCloseAck("world-2"));

		// Node re-sends world.next after a reconnect until it has the close: never Game Over again.
		s.offerNext(next("world-1", "world-2", 2));
		assertNull(s.takeUnshownNext());

		s.closeAcknowledged("world-1");
		assertFalse(s.isAwaitingCloseAck("world-1"), "after the ack a world.open of that world is acted on again");

		// A death in the next world is shown as usual.
		s.offerNext(next("world-2", "world-3", 3));
		assertEquals("world-3", s.takeUnshownNext().worldId());
		s.beginLoading("world-3", 3, true, 0);
		s.markReady("world-3");
		assertFalse(s.isClosedWorld("world-1") && s.isAwaitingCloseAck("world-1"));
	}

	@Test
	void pendingOpenIsClaimedOnce() {
		ClientSession s = new ClientSession();
		Messages.WorldOpen open = new Messages.WorldOpen("world-4", 4, true, true, "hard", "1234");
		s.offerOpen(open);
		assertSame(open, s.peekPendingOpen());
		assertTrue(s.claimPendingOpen(open));
		assertFalse(s.claimPendingOpen(open));
		assertNull(s.peekPendingOpen());
	}

	@Test
	void helloSnapshotReportsInWorldOnlyWithALevel() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-5", 5, false, 0);
		assertNull(s.helloWorldId(), "no level yet: boot");
		s.publishLevelLoaded(true);
		assertEquals("world-5", s.helloWorldId());
		s.publishPlayerName("Jasper");
		assertEquals("Jasper", s.playerName());
	}
}
