package dev.minevibe.bridge.msg;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.bridge.protocol.ProtocolException;
import dev.minevibe.bridge.protocol.Schema;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The later message groups (bodies, skills, seats, ui, pc, org, debug) as the mod reads and writes them. */
class MsgCatalogTest {
	private static String read(String group, String name) {
		String dir = System.getProperty("minevibe.protocolFixtures");
		assertNotNull(dir, "minevibe.protocolFixtures is not set (run through Gradle)");
		try {
			return Files.readString(Path.of(dir, group, name), StandardCharsets.UTF_8);
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static <P> P parse(MessageType<P> type, String group, String name) {
		ProtocolCodec.Parsed parsed = ProtocolCodec.parse(read(group, name));
		return assertInstanceOf(ProtocolCodec.Valid.class, parsed, () -> name + ": " + parsed).payloadAs(type);
	}

	/** The result keys of an {@code ok} fixture. */
	private static JsonObject okResult(String name) {
		JsonObject json = JsonParser.parseString(read("reply", name)).getAsJsonObject();
		for (String key : List.of("t", "v", "id", "re")) json.remove(key);
		return json;
	}

	@Test
	void everyGroupTypeIsRegistered() {
		for (List<MessageType<?>> group : List.of(Bodies.TYPES, Skills.TYPES, Seats.TYPES, Ui.TYPES, Pc.TYPES, Org.TYPES, Debug.TYPES)) {
			for (MessageType<?> type : group) assertSame(type, Messages.byName(type.name()), type.name());
		}
		assertEquals(69, Messages.catalog().size(), "the catalog has every type of registry.ts");
	}

	@Test
	void readsBodies() {
		Bodies.AgentState state = parse(Bodies.AGENT_STATE, "bodies", "agent.state.json");
		assertEquals(3, state.agents().size());
		Bodies.AgentBody cleo = state.agents().get(2);
		assertEquals("mine", cleo.job().skill());
		assertEquals(0.4, cleo.job().progress());
		assertEquals("self_defense", cleo.reflex());
		assertEquals("linux-1", state.agents().get(1).seat().pcId());
		assertNull(state.agents().get(0).seat());

		Bodies.AgentSpawn spawn = parse(Bodies.AGENT_SPAWN, "bodies", "agent.spawn--restore.json");
		assertTrue(spawn.restore());
		assertEquals(-40, spawn.at().pos().z());
		assertEquals("minecraft:overworld", spawn.at().dim());
	}

	@Test
	void readsSkillsAndTheirArgs() {
		Skills.SkillRun run = parse(Skills.SKILL_RUN, "skills", "skill.run.json");
		Skills.Args.Mine mine = ProtocolCodec.GSON.fromJson(run.args(), Skills.Args.Mine.class);
		assertEquals("#minecraft:iron_ores", mine.block());
		assertEquals(12, mine.count());
		assertEquals(32, mine.radius());
		assertNull(mine.near());

		Skills.SkillRun go = parse(Skills.SKILL_RUN, "skills", "skill.run--goto.json");
		Skills.Args.Goto args = ProtocolCodec.GSON.fromJson(go.args(), Skills.Args.Goto.class);
		assertEquals("player", args.entity());
		assertEquals(2.5, args.range());

		Skills.SkillResult failed = parse(Skills.SKILL_RESULT, "skills", "skill.result--failed.json");
		assertEquals("UNREACHABLE", failed.error().code());
	}

	@Test
	void readsCardsOfEveryKind() {
		Ui.AgentPending pending = parse(Ui.AGENT_PENDING, "ui", "agent.pending.json");
		Ui.PendingCard question = pending.cards().get(0);
		assertEquals(Ui.PendingCard.QUESTION, question.kind());
		assertEquals(2, question.questions().size());
		assertTrue(question.questions().get(1).multiSelect());
		assertEquals("Spruce", question.answers().get(0));
		assertEquals("cleo", pending.cards().get(1).handle());
		assertEquals("ev-3", pending.cards().get(2).eventId());

		Messages.HelloOk full = parse(Messages.HELLO_OK, "world", "hello.ok--full.json");
		assertEquals("linux-1", full.pcs().get(0).pcId());
		assertEquals("bram", full.pcs().get(0).occupant().agentId());
		assertEquals(2, full.budget().macos().max());
		assertEquals(Ui.PendingCard.PLAN, full.pending().get(1).kind());

		Ui.AgentApproach release = parse(Ui.AGENT_APPROACH, "ui", "agent.approach--release.json");
		assertNull(release.pendingId());
	}

	@Test
	void readsPcAndOrg() {
		Pc.PcInfo mac = parse(Pc.PC_STATE, "pc", "pc.state--awaiting-consent.json");
		assertEquals(24_000_000_000L, mac.consent().bytes());
		assertNull(mac.occupant());

		Org.CalendarState calendar = parse(Org.CALENDAR_STATE, "org", "calendar.state.json");
		assertTrue(calendar.events().get(0).assignees().isJsonArray());
		assertEquals(new JsonPrimitive("all"), calendar.events().get(1).assignees());
		assertNull(calendar.events().get(1).nextAt());
		assertEquals(2, calendar.events().get(2).recurrence().n());

		Org.MeetingState meeting = parse(Org.MEETING_STATE, "org", "meeting.state.json");
		assertEquals("bram", meeting.speaker());
		assertFalse(meeting.quick());
		assertNull(meeting.attendees().get(0).etaS());

		Messages.WorldState world = parse(Messages.WORLD_STATE, "world", "world.state--player.json");
		assertEquals("linux-1", world.player().seatedPc());
		assertEquals(17, world.player().food());
	}

	@Test
	void okFixturesMatchTheirResultSchemasAndRecords() {
		Map<String, Schema.Obj> schemas = Map.of(
				"ok--skill-run.json", Skills.SKILL_RUN_RESULT,
				"ok--codex-search.json", Org.CODEX_SEARCH_RESULT,
				"ok--meeting-start.json", Org.MEETING_START_RESULT,
				"ok--pick-folder.json", Pc.PICK_FOLDER_RESULT);
		schemas.forEach((name, schema) -> assertEquals(List.of(), schema.validate(okResult(name)), name));

		Skills.SkillRunResult run = ProtocolCodec.GSON.fromJson(okResult("ok--skill-run.json"), Skills.SkillRunResult.class);
		assertEquals(Skills.RUNNING, run.status());
		Org.MeetingStartResult start = ProtocolCodec.GSON.fromJson(okResult("ok--meeting-start.json"), Org.MeetingStartResult.class);
		assertNull(start.meetingId());
		assertTrue(start.etas().get(1).dialIn());
		Bodies.AgentSpawnResult spawned = ProtocolCodec.GSON.fromJson(okResult("ok--agent-spawn.json"), Bodies.AgentSpawnResult.class);
		assertEquals(6.5, spawned.pos().x());
	}

	@Test
	void encodesWhatTheModSends() {
		String input = ProtocolCodec.encode(Pc.PC_INPUT, new Pc.PcInput("linux-1", 1, List.of(
				Pc.InputEvent.move(10, 20),
				Pc.InputEvent.button("left", true, 10, 20),
				Pc.InputEvent.scroll(0, -3, 10, 20),
				Pc.InputEvent.key("KEY_ENTER", false),
				Pc.InputEvent.text("ls"),
				Pc.InputEvent.releaseAll())), null, null);
		JsonObject json = JsonParser.parseString(input).getAsJsonObject();
		assertEquals(6, json.getAsJsonArray("events").size());
		assertFalse(json.getAsJsonArray("events").get(5).getAsJsonObject().has("x"), "absent keys are omitted, not null");

		String seat = ProtocolCodec.encode(Seats.PC_SEAT, new Seats.PcSeat("linux-1", Types.Occupant.player(), null), null, null);
		assertEquals(JsonParser.parseString("{\"t\":\"pc.seat\",\"v\":1,\"pcId\":\"linux-1\",\"occupant\":{\"kind\":\"player\"}}"),
				JsonParser.parseString(seat));

		String answer = ProtocolCodec.encode(
				Ui.PENDING_ANSWER, new Ui.PendingAnswer("ada", "card-7", Ui.CardAnswer.options(List.of(1, 3))), "m-1", null);
		assertTrue(answer.contains("\"picks\":[1,3]"));

		Messages.ChatSend legacy = new Messages.ChatSend(new JsonPrimitive("all"), "@ada hi");
		assertNull(legacy.mode());
		ProtocolCodec.encode(Messages.CHAT_SEND, legacy, "m-2", null);
		ProtocolCodec.encode(Messages.WORLD_STATE, new Messages.WorldState("world-1", Messages.WorldState.READY, null, null, null, 20L), null, null);
	}

	@Test
	void refinementsMatchTheZodSchemas() {
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Pc.PC_ACTION, new Pc.PcAction("create", "linux-2", "linux", null), "m-1", null));
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Pc.PC_ACTION, new Pc.PcAction("stop", null, null, null), "m-1", null));
		ProtocolCodec.encode(Pc.PC_ACTION, new Pc.PcAction("create", null, "linux", null), "m-1", null);

		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Ui.AGENT_CMD, new Ui.AgentCmd("ada", "ping_instead", null, null), "m-1", null));
		ProtocolCodec.encode(Ui.AGENT_CMD, Ui.AgentCmd.of("ada", "stop"), "m-1", null);

		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Ui.PLAN_DECISION, new Ui.PlanDecision("bram", "card-8", "revise", null), "m-1", null));

		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(Org.CODEX_PUT,
				new Org.CodexPut("update", "house-rules", null, "House rules", "x", List.of(), "rules", "lasting", null), "m-1", null));

		Org.CalendarPut weekdaysOnGameClock = new Org.CalendarPut(null, "Standup", "meeting", new JsonPrimitive("all"), "game", 0, null,
				new Org.Recurrence("weekdays", null), 10, null, null, "skip", false);
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(Org.CALENDAR_PUT, weekdaysOnGameClock, "m-1", null));
		Org.CalendarPut everyNWithoutN = new Org.CalendarPut(null, "Water", "task", new JsonPrimitive("all"), "game", 0, null,
				new Org.Recurrence("every_n_days", null), 10, null, null, "skip", false);
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(Org.CALENDAR_PUT, everyNWithoutN, "m-1", null));
	}
}
