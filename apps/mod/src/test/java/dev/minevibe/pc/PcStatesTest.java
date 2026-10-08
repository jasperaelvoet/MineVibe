package dev.minevibe.pc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Pc;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** What the mod remembers of Node's PCs, and the LED it derives (PLAN 7.5). */
class PcStatesTest {
	static Pc.PcInfo pc(final String id, final long slot, final String status, final boolean plugged) {
		return new Pc.PcInfo(id, "linux", id, status, null, null, slot, 2, 4096, 64, plugged, false, false, List.of(), null, null, null, null, null);
	}

	@AfterEach
	void clear() {
		PcStates.clear();
	}

	@Test
	void slotsMapToPcsAndFollowChanges() {
		List<String> seen = new ArrayList<>();
		PcStates.addListener(info -> seen.add(info.pcId() + ":" + info.status()));
		long v0 = PcStates.version();
		PcStates.put(pc("linux-1", 3, "booting", true));
		assertEquals("linux-1", PcStates.pcIdForSlot(3));
		PcStates.put(pc("linux-1", 4, "running", true));
		assertNull(PcStates.pcIdForSlot(3), "the old slot is released");
		assertEquals("linux-1", PcStates.pcIdForSlot(4));
		assertTrue(PcStates.version() > v0);
		assertTrue(seen.containsAll(List.of("linux-1:booting", "linux-1:running")));
	}

	@Test
	void helloSnapshotReplacesEverything() {
		PcStates.put(pc("linux-1", 1, "running", true));
		PcStates.put(pc("old-pc", 2, "off", true));
		PcStates.cursor(new Pc.PcCursor("old-pc", 1, 1, true));
		assertFalse(PcStates.isConnected());
		PcStates.replaceAll(List.of(pc("linux-1", 1, "running", true)), null);
		assertTrue(PcStates.isConnected());
		assertNull(PcStates.get("old-pc"));
		assertNull(PcStates.pcIdForSlot(2));
		assertNull(PcStates.cursorOf("old-pc"));
		assertEquals(1, PcStates.all().size());
		PcStates.connected(false);
		assertFalse(PcStates.isConnected());
	}

	@Test
	void ledFollowsTheStatus() {
		assertEquals(PcLed.GREEN, PcLed.of("running"));
		assertEquals(PcLed.AMBER, PcLed.of("booting"));
		assertEquals(PcLed.AMBER, PcLed.of("awaiting_consent"));
		assertEquals(PcLed.RED, PcLed.of("no_capacity"));
		assertEquals(PcLed.RED, PcLed.of("macos_slots_full"));
		assertEquals(PcLed.OFF, PcLed.of("off"));
		assertEquals(PcLed.OFF, PcLed.of("decommissioned"));
		assertEquals(PcLed.OFF, PcLed.of(null));
		assertEquals(PcLed.AMBER, PcLed.forDesk(null, true, null, null, true), "creating");
		assertEquals(PcLed.RED, PcLed.forDesk(null, false, "NO_CAPACITY", null, true), "create refused");
		assertEquals(PcLed.OFF, PcLed.forDesk(null, false, null, null, true), "unbound");
		assertEquals(PcLed.OFF, PcLed.forDesk("linux-1", false, null, "running", false), "unplugged");
		assertEquals(PcLed.GREEN, PcLed.forDesk("linux-1", false, null, "running", true));
	}
}
