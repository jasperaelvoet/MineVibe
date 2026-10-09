package dev.minevibe.client.pc;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.client.pc.render.MonitorGeometry;
import dev.minevibe.client.pc.screen.PcBudgetMath;
import dev.minevibe.client.pc.screen.PcCapabilityText;
import dev.minevibe.client.pc.screen.PcLayout;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Pure client logic of the PC screens: layout and mouse mapping, frame tiers, budget clamps, status screens. */
class PcClientLogicTest {
	static Pc.PcInfo pc(final String status, final int cpus, final int memoryMiB) {
		return new Pc.PcInfo(
			"linux-1", "linux", "Linux 1", status, null, null, 1, cpus, memoryMiB, 64, true, false, false, List.of(), null, null, null, null, null
		);
	}

	static Pc.Budget budget(final long cpuTotal, final long cpuUsed, final long memPool, final long memUsed) {
		return new Pc.Budget(
			new Pc.CpuBudget(cpuTotal, cpuUsed, cpuTotal - cpuUsed, 1.5),
			new Pc.MemoryBudget(memPool, memUsed, memPool - memUsed),
			200,
			new Pc.MacosSlots(0, 2),
			4
		);
	}

	@Test
	void layoutFitsTheGuestAspectAndMapsTheMouse() {
		PcLayout.Rect r = PcLayout.fit(0, 0, 1000, 800, 1280, 800, 0.92);
		assertEquals(920, r.w(), 1e-9);
		assertEquals(575, r.h(), 1e-9);
		assertEquals(40, r.x(), 1e-9);
		assertEquals(112.5, r.y(), 1e-9);
		assertArrayEquals(new int[] {0, 0}, PcLayout.toGuest(r, r.x(), r.y(), 1280, 800));
		assertArrayEquals(new int[] {640, 400}, PcLayout.toGuest(r, r.x() + r.w() / 2, r.y() + r.h() / 2, 1280, 800));
		assertArrayEquals(new int[] {1279, 799}, PcLayout.toGuest(r, 5000, 5000, 1280, 800), "clamped to the guest screen");
		double[] back = PcLayout.toGui(r, 640, 400, 1280, 800);
		assertArrayEquals(new int[] {640, 400}, PcLayout.toGuest(r, back[0], back[1], 1280, 800));
		PcLayout.Rect tall = PcLayout.fit(0, 0, 1000, 400, 1280, 800, 1.0);
		assertEquals(400, tall.h(), 1e-9, "height-limited");
		assertEquals(640, tall.w(), 1e-9);
		assertEquals(1.0, PcLayout.easeOut(2), 1e-9);
		assertEquals(0.0, PcLayout.easeOut(-1), 1e-9);
	}

	@Test
	void monitorPictureIsLetterboxedIntoTheScreenArea() {
		float[] r = MonitorGeometry.screenRect(1280, 800);
		assertEquals(1.6f, (r[2] - r[0]) / (r[3] - r[1]), 1e-4);
		assertTrue(r[0] >= MonitorGeometry.AREA_X0 - 1e-6 && r[2] <= MonitorGeometry.AREA_X1 + 1e-6);
		assertTrue(r[1] >= MonitorGeometry.AREA_Y0 - 1e-6 && r[3] <= MonitorGeometry.AREA_Y1 + 1e-6);
		float[] square = MonitorGeometry.screenRect(800, 800);
		assertEquals(MonitorGeometry.AREA_Y1 - MonitorGeometry.AREA_Y0, square[3] - square[1], 1e-6);
		assertEquals(square[3] - square[1], square[2] - square[0], 1e-6);
	}

	@Test
	void viewTiersWithFocusAndHysteresis() {
		Map<String, Double> d = new HashMap<>(Map.of("a", 10.0, "b", 33.0, "c", 100.0));
		Map<String, String> first = PcViewTiers.compute(null, d, Map.of());
		assertEquals(Map.of("a", "visible", "b", "none", "c", "none"), first);
		Map<String, String> walk = PcViewTiers.compute(null, Map.of("a", 34.0, "b", 31.0, "c", 100.0), first);
		assertEquals("visible", walk.get("a"), "a visible monitor stays visible a little past 32 blocks");
		assertEquals("visible", walk.get("b"));
		Map<String, String> seated = PcViewTiers.compute("c", d, walk);
		assertEquals("focus", seated.get("c"));
		Map<String, String> changes = PcViewTiers.changes(walk, seated);
		assertEquals(Map.of("c", "focus"), changes, "b at 33 blocks is still inside the hysteresis band");
		assertEquals(Map.of("a", "none", "b", "none", "c", "none"), PcViewTiers.changes(seated, Map.of()), "leaving the world drops everything to none");
	}

	@Test
	void slidersClampToTheFreeBudget() {
		Pc.Budget b = budget(12, 6, 24_576, 12_288);
		Pc.PcInfo running = pc("running", 2, 4096);
		assertEquals(2 + 18 - 6, PcBudgetMath.maxCpus(running, b), "its own 2 plus up to 1.5x overcommit of the pool");
		assertEquals(2 + 6, PcBudgetMath.comfortableCpus(running, b));
		assertEquals(4096 + 12_288, PcBudgetMath.maxMemoryMiB(running, b));
		Pc.PcInfo off = pc("off", 2, 4096);
		assertEquals(12, PcBudgetMath.maxCpus(off, b), "a stopped PC counts nothing as used");
		Pc.Budget full = budget(4, 4, 8192, 8000);
		assertEquals(4096, PcBudgetMath.maxMemoryMiB(off, full), "never below the current size");
		assertEquals(2, PcBudgetMath.maxCpus(off, full));
		assertEquals(4096, PcBudgetMath.maxMemoryMiB(running, null));
		assertEquals(1, PcBudgetMath.cpusAt(0, 8));
		assertEquals(8, PcBudgetMath.cpusAt(1, 8));
		assertEquals(4608, PcBudgetMath.memoryAt(0.5, 8192), "snapped to 512 MiB steps");
		assertEquals(0.0, PcBudgetMath.position(1, 1, 1) - 1.0, 1e-9);
	}

	@Test
	void statusScreens() {
		assertNull(PcStatusText.of("linux-1", false, null, pc("running", 2, 4096), true, true), "a running PC with a picture needs none");
		assertNotNull(PcStatusText.of("linux-1", false, null, pc("running", 2, 4096), true, false));
		assertEquals("Creating PC…", PcStatusText.of(null, true, null, null, true, false).title());
		assertEquals("Apple allows 2 macOS VMs", PcStatusText.of(null, false, "MACOS_SLOTS_FULL", null, true, false).title());
		assertEquals("Not enough resources", PcStatusText.of(null, false, "NO_CAPACITY", null, true, false).title());
		assertEquals("MineVibe offline", PcStatusText.of("linux-1", false, null, pc("running", 2, 4096), false, false).title());
		Pc.PcInfo booting = new Pc.PcInfo(
			"linux-1", "linux", "Linux 1", "booting", 0.42, null, 1, 2, 4096, 64, true, false, false, List.of(), null, null, null, null, null
		);
		PcStatusText.Screen s = PcStatusText.of("linux-1", false, null, booting, true, false);
		assertEquals("Booting 42%", s.title());
		assertEquals(0.42, s.progress(), 1e-9);
		Pc.PcInfo away = new Pc.PcInfo(
			"linux-1", "linux", "Linux 1", "running", null, null, 1, 2, 4096, 64, true, false, false, List.of(), Types.Occupant.agent("bram"), null, "BRB", null, null
		);
		assertNull(PcStatusText.of("linux-1", false, null, away, true, true));
	}

	@Test
	void capabilityTogglesAndThePhoneLine() {
		Pc.PcInfo plain = pc("running", 2, 4096);
		assertFalse(PcCapabilityText.virtualizationOn(plain));
		assertFalse(PcCapabilityText.androidOn(plain));
		Pc.Capabilities caps = new Pc.Capabilities(
			new Pc.VirtualizationCapability(true, null),
			new Pc.AndroidCapability(true, null, "preparing", 0.42, "downloading the Android image (45%)"));
		Pc.PcInfo on = new Pc.PcInfo(
			"linux-1", "linux", "Linux 1", "running", null, null, 1, 2, 4096, 64, true, false, false, List.of(), null, null, null, null, null, caps
		);
		assertTrue(PcCapabilityText.virtualizationOn(on));
		assertTrue(PcCapabilityText.androidOn(on));
		assertEquals("preparing 42% · downloading the Android image (45%)", PcCapabilityText.phoneStatus(caps.android()));
		assertEquals("running · android-phone", PcCapabilityText.phoneStatus(new Pc.AndroidCapability(true, null, "running", null, "x")));
		assertEquals("failed · no room", PcCapabilityText.phoneStatus(new Pc.AndroidCapability(true, null, "error", null, "no room")));
	}
}
