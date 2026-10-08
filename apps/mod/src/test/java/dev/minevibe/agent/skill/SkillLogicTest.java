package dev.minevibe.agent.skill;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.agent.job.BuildJob;
import dev.minevibe.agent.job.GotoSkillJob;
import dev.minevibe.agent.job.MenuJobs;
import dev.minevibe.agent.job.WorldJobs;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Seats;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Pure logic of the skill layer: the clock formula, names, blueprint rotation, argument checks and payload shapes. */
class SkillLogicTest {
	@BeforeAll
	static void bootstrap() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void gameClockFormulaStartsTheDayAtSix() {
		assertEquals("day 1 06:00", WorldClock.dayAndTime(0));
		assertEquals("day 1 18:30", WorldClock.dayAndTime(12500));
		assertEquals("day 1 00:00", WorldClock.dayAndTime(18000));
		assertEquals("day 2 12:00", WorldClock.dayAndTime(30000));
	}

	@Test
	void theClockFallsBackUntilTheServerPublishes() {
		WorldClock.clear();
		assertEquals(1234L, WorldClock.overworldClockTime(1234L));
		assertEquals(0L, WorldClock.overworldClockTime(-5L));
	}

	@Test
	void displayNamesBecomeMinecraftNames() {
		assertEquals("AdaLovelace", SkillService.mcName("Ada Lovelace", "ada"));
		assertEquals("bob", SkillService.mcName("😀!", "bob"));
		assertEquals("Abcdefghijklmnop", SkillService.mcName("Abcdefghijklmnopqrst", "x"));
	}

	@Test
	void blueprintsRotateClockwiseAroundTheOrigin() throws Exception {
		BlockPos origin = new BlockPos(10, 64, 10);
		var at = BuildJob.class.getDeclaredMethod("at", int.class, int.class, int.class);
		at.setAccessible(true);
		assertEquals(new BlockPos(10, 63, 11), at.invoke(new BuildJob("bridge", origin, 0), 0, -1, 1));
		assertEquals(new BlockPos(9, 63, 10), at.invoke(new BuildJob("bridge", origin, 90), 0, -1, 1));
		assertEquals(new BlockPos(10, 63, 9), at.invoke(new BuildJob("bridge", origin, 180), 0, -1, 1));
		assertEquals(new BlockPos(11, 63, 10), at.invoke(new BuildJob("bridge", origin, 270), 0, -1, 1));
	}

	private static JsonObject json(final String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	private static String code(final Runnable r) {
		BridgeException e = assertThrows(BridgeException.class, r::run);
		return e.code();
	}

	@Test
	void skillArgsAreCheckedAgain() {
		assertEquals("UNKNOWN_SKILL", code(() -> SkillFactory.create("fly", new JsonObject())));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("craft", json("{\"count\":1}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("craft", json("{\"item\":\"no_such_thing\",\"count\":1}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("goto", json("{}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("goto", json("{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"entity\":\"player\"}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("emote", json("{\"kind\":\"dance\"}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("mine", json("{\"block\":\"stone\",\"count\":0}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("container", json("{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"action\":\"put\"}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("dig", json("{\"from\":{\"x\":0,\"y\":0,\"z\":0},\"to\":{\"x\":20,\"y\":20,\"z\":20}}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("hunt", json("{\"entity\":\"minecraft:player\",\"count\":1}"))));
		assertEquals("UNKNOWN_BLUEPRINT", code(() -> SkillFactory.create("build", json("{\"blueprint\":\"castle\",\"origin\":{\"x\":0,\"y\":0,\"z\":0}}"))));

		// Far-apart int coordinates must not overflow past the size limits (a 65536x65536 dig was "0 blocks").
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("dig", json("{\"from\":{\"x\":0,\"y\":0,\"z\":0},\"to\":{\"x\":65535,\"y\":0,\"z\":65535}}"))));
		assertEquals(65536L * 65536L, dev.minevibe.agent.job.GatherJobs.Dig.volume(BlockPos.ZERO, new BlockPos(65535, 0, 65535)));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("farm", json(
			"{\"from\":{\"x\":2147483647,\"y\":0,\"z\":0},\"to\":{\"x\":-2147483648,\"y\":0,\"z\":3}}"))));
		assertEquals("BAD_ARGS", code(() -> SkillFactory.create("farm", json(
			"{\"from\":{\"x\":0,\"y\":0,\"z\":0},\"to\":{\"x\":3,\"y\":0,\"z\":3},\"crop\":\"minecraft:dirt\"}"))));
		assertInstanceOf(dev.minevibe.agent.job.FarmJob.class, SkillFactory.create("farm", json(
			"{\"from\":{\"x\":0,\"y\":0,\"z\":0},\"to\":{\"x\":3,\"y\":0,\"z\":3},\"crop\":\"carrot\"}")));
		assertInstanceOf(GotoSkillJob.class, SkillFactory.create("goto", json("{\"pos\":{\"x\":1,\"y\":2,\"z\":3},\"range\":2}")));
		assertInstanceOf(GotoSkillJob.class, SkillFactory.create("goto", json("{\"entity\":\"player\"}")));
		assertInstanceOf(MenuJobs.MenuClick.class, SkillFactory.create("menu_click", json("{\"slot\":-3,\"button\":0,\"type\":\"pickup\"}")));
		assertInstanceOf(WorldJobs.Equip.class, SkillFactory.create("equip", json("{\"item\":\"minecraft:iron_helmet\",\"slot\":\"head\"}")));
		assertInstanceOf(BuildJob.class, SkillFactory.create("build", json("{\"blueprint\":\"Shelter\",\"origin\":{\"x\":0,\"y\":0,\"z\":0},\"rotation\":90}")));
		for (String skill : Skills.SKILL_NAMES) {
			// Every skill the protocol names is known here (no UNKNOWN_SKILL), even if these args are wrong.
			try {
				SkillFactory.create(skill, new JsonObject());
			} catch (BridgeException e) {
				assertTrue(!"UNKNOWN_SKILL".equals(e.code()), skill + " is unknown to the mod");
			}
		}
	}

	@Test
	void handlersRegisteredElsewhereFirstAreKept() {
		dev.minevibe.bridge.BridgeClient bridge = dev.minevibe.bridge.BridgeClient.builder()
			.config(() -> {
				throw new java.io.IOException("no bridge in this test");
			})
			.hello(() -> new Messages.Hello("0.1.0", "26.3", Messages.Hello.PHASE_BOOT, null, null))
			.build();
		try {
			bridge.handle(Bodies.AGENT_SPAWN, dev.minevibe.bridge.BridgeClient.Route.SERVER, req -> java.util.Map.of());
			// Another module took agent.spawn: the skill layer keeps that handler and registers the rest.
			SkillBridge.register(bridge);
			assertThrows(IllegalStateException.class, () -> bridge.handle(Skills.SKILL_RUN, dev.minevibe.bridge.BridgeClient.Route.SERVER, req -> null));
			// Pushes are observed, so a UI handler for agent.approach can still be added.
			bridge.on(dev.minevibe.bridge.msg.Ui.AGENT_APPROACH, dev.minevibe.bridge.BridgeClient.Route.CLIENT, a -> {});
		} finally {
			bridge.close("test over");
		}
	}

	@Test
	void bridgePayloadsMatchTheContract() {
		Bodies.AgentBody body = new Bodies.AgentBody(
			"ada", new Types.Vec3(1.5, 64.0, -3.25), "minecraft:overworld", 18.0, 20.0, 15, 3.5, "follow", true, false, "unseat_to_survive",
			new Bodies.BodyJob("j1-a", "collect", 0.25), Seats.SeatTarget.pc("linux-1"), 4.2, "minecraft:iron_sword");
		ProtocolCodec.encode(Bodies.AGENT_STATE, new Bodies.AgentState(1200, List.of(body)), null, null);
		JsonObject data = new JsonObject();
		data.addProperty("why", "combat");
		ProtocolCodec.encode(Bodies.AGENT_EVENT, new Bodies.AgentEvent("ada", "approach_blocked", 1, "cannot walk over (combat)", data), null, null);
		ProtocolCodec.encode(Skills.SKILL_PROGRESS, new Skills.SkillProgress("j1-a", "ada", 0.5, "1/2 oak_log"), null, null);
		JsonObject result = new JsonObject();
		result.addProperty("footer", "HP 20/20 food 20 | day 1 06:00 | 0 64 0 overworld | idle (follow)");
		ProtocolCodec.encode(Skills.SKILL_RESULT, new Skills.SkillResult("j1-a", "ada", "failed", result, new Types.Failure("NOT_FOUND", "no oak_log"), 5000), null, null);
		ProtocolCodec.encode(Seats.PC_SEAT, new Seats.PcSeat("linux-1", Types.Occupant.agent("ada"), 3L), null, null);
		ProtocolCodec.encode(Seats.PC_UNSEAT, new Seats.PcUnseat("linux-1", Types.Occupant.agent("ada"), "damage", false), null, null);
		ProtocolCodec.encode(Bodies.AGENT_DIED, new Bodies.AgentDied(
			"ada", "world-3", "Ada was slain by Zombie", "minecraft:zombie", 2, new Messages.BlockPos(1, 64, 2), "minecraft:overworld", null), "m-1", null);
		// Every kind the emitters use is a protocol kind.
		for (String kind : List.of("hurt", "hp_critical", "starving", "ate", "killed", "reflex", "stuck", "unseated", "kicked", "player_low_hp",
			"dimension_changed", "arrived", "approach_blocked", "fed_player", "shared_food", "picked_up")) {
			assertTrue(Bodies.EVENT_KINDS.contains(kind), kind);
		}
	}
}
