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
	void aLoadThatEndedAtBootScreenIsNotInProgress() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-2", 2, true, 0);
		assertTrue(s.loading());
		// BootScreen shows with no world and no server: vanilla gave up (datapack failure, unreadable level).
		assertTrue(s.clearStaleLoad(false, SECOND), "BootScreen without a server ends the load");
		assertFalse(s.loading());
		assertFalse(s.isLoadInProgress("world-2", SECOND));
		assertFalse(s.clearStaleLoad(false, 2 * SECOND), "nothing left to clear");
	}

	@Test
	void aRunningLoadIsInProgressUntilItTimesOut() {
		ClientSession s = new ClientSession();
		s.beginLoading("world-2", 2, true, 0);
		assertTrue(s.isLoadInProgress("world-2", 5 * SECOND));
		assertFalse(s.isLoadInProgress("world-3", 5 * SECOND), "another world is not this load");
		assertFalse(s.clearStaleLoad(true, 5 * SECOND));
		assertFalse(s.expireLoad(5 * SECOND));
		long late = ClientSession.LOAD_TIMEOUT_NANOS + SECOND;
		assertFalse(s.isLoadInProgress("world-2", late), "a load past its timeout no longer blocks world.open");
		assertTrue(s.expireLoad(late));
		assertFalse(s.loading());
	}

	/**
	 * DEBT M1 N1, the S7 gap: reopening an existing live world. {@code WorldOpenFlows#openWorld} resumes on a background
	 * executor, so for a while there is neither a level nor an integrated server. The client tick must not end the load
	 * then, a duplicate {@code world.open} (Node re-sends it after every hello) must not count as a new request, and one
	 * that was parked anyway must not outlive the world becoming ready.
	 */
	@Test
	void reopeningAnExistingWorldSurvivesTheAsyncOpenAndDuplicates() {
		ClientSession s = new ClientSession();
		Messages.WorldOpen open = new Messages.WorldOpen("world-3", 3, false, true, "hard", null);
		s.offerOpen(open);
		assertTrue(s.claimPendingOpen(open), "BootScreen takes it");
		s.beginLoading("world-3", 3, false, 0);
		// Ticks while openWorld runs on the background executor: no level, no server. Only the timeout ends it.
		for (long t = 0; t < 30; t++) {
			assertFalse(s.expireLoad(t * SECOND), "tick " + t + " must not end the load");
		}
		assertTrue(s.loading());
		// A duplicate world.open (a reconnect's hello) arrives mid-open: still the same load, not a new request.
		assertTrue(s.isLoadInProgress("world-3", 31 * SECOND), "a duplicate is ignored as already loading");
		// Even if one was parked (an older client path, or a switch request), the world becoming ready drops it.
		s.offerOpen(new Messages.WorldOpen("world-3", 3, false, true, "hard", null));
		Messages.WorldOpen other = new Messages.WorldOpen("world-9", 9, true, true, "hard", null);
		assertTrue(s.markReady("world-3"));
		assertNull(s.peekPendingOpen(), "no stale world.open of the world that is open now");
		assertFalse(s.loading());
		assertTrue(s.isReady("world-3"));
		assertFalse(s.fresh(), "reopened, not created");
		// A request for another world is kept for BootScreen, and closing the world drops only its own.
		s.offerOpen(other);
		assertFalse(s.markReady("world-3"));
		assertSame(other, s.peekPendingOpen());
		s.markClosed("world-9");
		assertNull(s.peekPendingOpen(), "closing a world drops a pending open of it");
		s.offerOpen(other);
		s.markClosed("world-3");
		assertSame(other, s.peekPendingOpen(), "closing world-3 keeps world-9's open");
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
		s.publishPlayerName("Jordan");
		assertEquals("Jordan", s.playerName());
	}
}
