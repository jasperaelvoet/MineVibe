package dev.minevibe.pc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.bridge.msg.Types;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The PC blocks' seat registry, without a server (integration track I2): statuses from {@code pc.state}, the kick's
 * re-sit cooldown, the player taking a kept chair, and the PCs the reservation sweep must see.
 */
class PcSeatRegistryTest {
	private static final long SECOND = 1_000_000_000L;

	@AfterEach
	void clear() {
		PcStates.clear();
	}

	@Test
	void statusesComeFromPcStateAndFallBackToPcStates() {
		PcSeatRegistry registry = new PcSeatRegistry();
		assertNull(registry.status("linux-1"), "unknown PC");
		PcStates.put(PcStatesTest.pc("linux-1", 5, "booting", true));
		assertEquals("booting", registry.status("linux-1"), "nobody set it: what Node last pushed");
		registry.onPcState(PcStatesTest.pc("linux-1", 5, "running", true));
		assertEquals("running", registry.status("linux-1"), "pc.state through the PcStates listener");
		registry.setStatus("linux-1", "off");
		assertEquals("off", registry.status("linux-1"));
		registry.clearStatus("linux-1");
		PcStates.put(PcStatesTest.pc("linux-1", 5, "stopping", true));
		assertEquals("stopping", registry.status("linux-1"), "a removed status falls back to PcStates");
	}

	@Test
	void aKickBlocksReSittingForThirtySeconds() {
		PcSeatRegistry registry = new PcSeatRegistry();
		AtomicLong now = new AtomicLong(1_000 * SECOND);
		registry.setClock(now::get);
		assertEquals(0, registry.resitCooldownSeconds("bram", "linux-1"));
		// Node's agent.unseat{kick} and the mod's own kick both end in onUnseated(kick).
		registry.onUnseated("linux-1", Types.Occupant.agent("bram"), "kick", false);
		assertEquals(PcSeatRegistry.RESIT_COOLDOWN_SECONDS, registry.resitCooldownSeconds("bram", "linux-1"));
		assertEquals(0, registry.resitCooldownSeconds("bram", "linux-2"), "only that PC");
		assertEquals(0, registry.resitCooldownSeconds("ada", "linux-1"), "only that agent");
		now.addAndGet(29 * SECOND + SECOND / 2);
		assertEquals(1, registry.resitCooldownSeconds("bram", "linux-1"), "rounded up");
		now.addAndGet(SECOND);
		assertEquals(0, registry.resitCooldownSeconds("bram", "linux-1"), "over after 30 s");
		// Other reasons start no cooldown.
		registry.onUnseated("linux-1", Types.Occupant.agent("bram"), "stand", false);
		registry.onUnseated("linux-1", Types.Occupant.player(), "kick", false);
		assertEquals(0, registry.resitCooldownSeconds("bram", "linux-1"));
	}

	@Test
	void thePlayerTakingAKeptChairEndsTheReservation() {
		PcSeatRegistry registry = new PcSeatRegistry();
		registry.reserve("linux-1", "bram", PcRegistry.Reservation.AWAY);
		assertNull(registry.playerSat("linux-2"), "nobody's chair");
		assertEquals("bram", registry.reservation("linux-1").agentId(), "another PC's chair: kept");
		// Bram is away asking: Node must hear that the player took his chair (pc.unseat{player_took}).
		assertEquals("bram", registry.playerSat("linux-1"), "the away agent lost its PC");
		assertNull(registry.reservation("linux-1"));
		assertNull(registry.playerSat("linux-1"), "nothing left to take");
	}

	@Test
	void thePlayerTakingAChairAnAgentWalksToOnlyEndsTheReservation() {
		PcSeatRegistry registry = new PcSeatRegistry();
		registry.reserve("linux-1", "ada", PcRegistry.Reservation.COMING);
		// Ada is not seated anywhere yet: her seat job fails with OCCUPIED_BY_PLAYER, no pc.unseat.
		assertNull(registry.playerSat("linux-1"));
		assertNull(registry.reservation("linux-1"));
	}

	@Test
	void reservedPcsAreListedForTheSweepAndForgottenWithTheWorld() {
		PcSeatRegistry registry = new PcSeatRegistry();
		AtomicLong now = new AtomicLong(0);
		registry.setClock(now::get);
		registry.reserve("linux-7", "ada", PcRegistry.Reservation.COMING);
		assertTrue(registry.pcIds(null).contains("linux-7"), "a reservation without a loaded desk is still swept");
		registry.onUnseated("linux-7", Types.Occupant.agent("ada"), "kick", false);
		registry.onServerStopped();
		assertEquals(List.of(), registry.pcIds(null).stream().filter(id -> id.equals("linux-7")).toList());
		assertNull(registry.reservation("linux-7"));
		assertEquals(0, registry.resitCooldownSeconds("ada", "linux-7"), "cooldowns end with the world");
	}
}
