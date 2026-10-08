package dev.minevibe.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.msg.World;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.pc.screen.PcControlScreen;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/**
 * What {@code WorldTicker} reports in {@code world.state} (integration track I2): the office once per connection and
 * on change, the player snapshot's screen name, and the idle time behind Node's AFK rule.
 */
class WorldReportTest {
	@Test
	void theOfficeGoesOutOncePerConnectionAndAgainWhenItChanges() {
		WorldTicker.OfficeReport report = new WorldTicker.OfficeReport();
		assertFalse(report.due(null), "no office, nothing to send");
		String first = WorldTicker.OfficeReport.key("world-1", 1, 42);
		assertTrue(report.due(first));
		assertTrue(report.due(first), "not sent yet (the bridge was down): still due");
		report.sent(first);
		assertFalse(report.due(first), "Node has it on this connection");
		assertTrue(report.due(WorldTicker.OfficeReport.key("world-1", 2, 42)), "a new connection gets it again");
		assertTrue(report.due(WorldTicker.OfficeReport.key("world-1", 1, 43)), "a rebuilt office goes out again");
		assertTrue(report.due(WorldTicker.OfficeReport.key("world-2", 1, 42)), "a new world goes out again");
	}

	@Test
	void screenNamesAreSimpleClassNames() {
		assertEquals("PcControlScreen", WorldTicker.screenName(PcControlScreen.class));
		Object anonymous = new Object() {};
		assertEquals("WorldReportTest$1", WorldTicker.screenName(anonymous.getClass()), "an anonymous screen keeps its outer name");
		assertNull(WorldTicker.screenName((net.minecraft.client.gui.screens.Screen)null), "in game: no screen");
	}

	@Test
	void idleTimeCountsFromTheLastInput() {
		AtomicLong now = new AtomicLong(0);
		PlayerActivity activity = new PlayerActivity(now::get);
		activity.observe(100, 100, 0.0F, 0.0F);
		now.set(5_000_000_000L);
		activity.observe(100, 100, 0.0F, 0.0F);
		assertEquals(5_000, activity.idleMs(), "nothing moved for 5 s");
		activity.observe(101, 100, 0.0F, 0.0F);
		assertEquals(0, activity.idleMs(), "a mouse move is input");
		now.set(7_000_000_000L);
		activity.observe(101, 100, 0.0F, 0.0F);
		assertEquals(2_000, activity.idleMs());
		activity.observe(101, 100, 90.0F, 0.0F);
		assertEquals(0, activity.idleMs(), "turning is input");
		now.set(9_000_000_000L);
		activity.noteInput();
		assertEquals(0, activity.idleMs(), "a key is input");
		now.set(10_000_000_000L);
		activity.observe(101, 100, Float.NaN, Float.NaN);
		activity.observe(101, 100, 10.0F, 0.0F);
		assertEquals(1_000, activity.idleMs(), "a player appearing (no rotation before) is not input");
	}

	@Test
	void thePlayerSnapshotMatchesTheProtocol() {
		World.PlayerState player = new World.PlayerState(new Types.Vec3(10.5, 64, -3.25), "minecraft:overworld", 17.5, 20, 18, false, 1234,
			"PcControlScreen", "linux-1");
		Messages.WorldState state = new Messages.WorldState("world-1", Messages.WorldState.READY, null, null, null, 6000L, player);
		String json = dev.minevibe.bridge.protocol.ProtocolCodec.encode(Messages.WORLD_STATE, state, null, null);
		assertTrue(json.contains("\"seatedPc\":\"linux-1\"") && json.contains("\"idleMs\":1234"), json);
		World.PlayerState inGame = new World.PlayerState(new Types.Vec3(0, 70, 0), "minecraft:the_nether", 20, 20, 20, true, 0, null, null);
		assertFalse(dev.minevibe.bridge.protocol.ProtocolCodec.encode(Messages.WORLD_STATE,
			new Messages.WorldState("world-1", Messages.WorldState.READY, null, null, null, 0L, inGame), null, null).contains("seatedPc"));
	}
}
