package dev.minevibe.client.org;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.client.org.calendar.GameClock;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The in-memory backend the screens use without Node: it must answer like Node does where the screens depend on it,
 * and everything it pushes must be valid protocol.
 */
class FakeOrgBackendTest {
	private final AtomicLong game = new AtomicLong(GameClock.at(3, 7, 0));
	private final AtomicLong real = new AtomicLong(1_790_000_000_000L);
	private OrgClientState state;
	private FakeOrgBackend fake;

	@BeforeEach
	void setUp() {
		this.state = new OrgClientState();
		this.fake = new FakeOrgBackend(this.state, this.game::get, this.real::get, "Jasper").seed();
	}

	private static String code(final CompletableFuture<?> future) {
		Throwable t = assertThrows(Exception.class, future::join);
		return OrgClient.code(t);
	}

	@Test
	void seedingPushesValidState() {
		assertTrue(this.state.codexKnown());
		assertTrue(this.state.calendarKnown());
		assertEquals(4, this.state.codexPages().size());
		assertEquals(6, this.state.events().size());
		assertEquals(3, this.state.crew().alive().size());
		assertEquals("Ada", this.state.crew().members().getFirst().name(), "the CEO first");
		assertValid(Org.CODEX_INDEX, new Org.CodexIndex(this.state.codexPages(), false));
		assertValid(Org.CALENDAR_STATE, new Org.CalendarState(this.state.events(), this.state.tz()));
	}

	@Test
	void codexWritesFollowNodesRules() {
		Org.CodexPutResult created = this.fake.codexPut(new Org.CodexPut("create", null, null, "Wheat farm", "Rows by the river", List.of("farm"), "places", "world", null)).join();
		assertEquals("wheat-farm", created.pageId());
		Org.CodexPage page = this.fake.codexGet("wheat-farm").join();
		assertEquals("player", page.author().kind());
		assertEquals("Jasper", page.author().name());
		assertEquals(5, this.state.codexPages().size(), "the index was pushed");
		assertValid(Org.CODEX_GET_RESULT, new Org.CodexGetResult(page));
		JsonObject half = ProtocolCodec.GSON.toJsonTree(new Org.CodexGetResult(page)).getAsJsonObject();
		half.getAsJsonObject("page").remove("body");
		assertFalse(Org.CODEX_GET_RESULT.validate(half).isEmpty(), "a codex.get reply without the body is refused before CodexScreen draws it");

		assertEquals(Codes.CODEX_SIMILAR, code(this.fake.codexPut(new Org.CodexPut("create", null, null, "wheat FARM", "again", List.of(), "places", "world", null))));
		assertEquals(Codes.CODEX_CONFLICT, code(this.fake.codexPut(new Org.CodexPut("update", "wheat-farm", "0000000", "Wheat farm", "x", List.of(), "places", "world", null))));
		Org.CodexPutResult updated = this.fake.codexPut(new Org.CodexPut("update", "wheat-farm", page.rev(), "Wheat farm", "x", List.of(), "places", "world", true)).join();
		assertNotEquals(page.rev(), updated.rev());
		assertTrue(this.fake.codexGet("wheat-farm").join().pinned());
		assertEquals(2, this.fake.codexGet("wheat-farm").join().history().size());

		this.fake.codexPut(new Org.CodexPut("append", "wheat-farm", null, "Wheat farm", "more", List.of(), "places", "world", null)).join();
		assertEquals("x\n\nmore", this.fake.codexGet("wheat-farm").join().body());
		String big = "y".repeat(Org.CODEX_BODY_MAX);
		assertEquals(Codes.CODEX_TOO_LARGE, code(this.fake.codexPut(new Org.CodexPut("append", "wheat-farm", null, "Wheat farm", big, List.of(), "places", "world", null))));
		assertEquals(Codes.BAD_MESSAGE, code(this.fake.codexPut(new Org.CodexPut("update", "wheat-farm", null, "Wheat farm", "z", List.of(), "places", "world", null))),
			"update without baseRev is rejected by the schema");

		String rev = this.fake.codexGet("wheat-farm").join().rev();
		assertEquals(Codes.CODEX_CONFLICT, code(this.fake.codexDelete(new Org.CodexDelete("wheat-farm", "1111111"))));
		this.fake.codexDelete(new Org.CodexDelete("wheat-farm", rev)).join();
		assertEquals(Codes.CODEX_NOT_FOUND, code(this.fake.codexGet("wheat-farm")));
	}

	@Test
	void searchRanksTitlesFirst() {
		Org.CodexSearchResult result = this.fake.codexSearch(new Org.CodexSearch("iron", null, null, null, 10)).join();
		assertFalse(result.hits().isEmpty());
		assertEquals("iron-cave", result.hits().getFirst().id());
		assertValid(Org.CODEX_SEARCH_RESULT, result);
		assertTrue(this.fake.codexSearch(new Org.CodexSearch("iron", null, "howto", null, 10)).join().hits().isEmpty(), "category filter");
	}

	@Test
	void anAgentEditMakesTheIndexMove() {
		Org.CodexPage before = this.fake.codexGet("iron-cave").join();
		this.fake.agentEdit("iron-cave", "Bram", "moved");
		Org.CodexPageMeta meta = this.state.codexPages().stream().filter(m -> m.id().equals("iron-cave")).findFirst().orElseThrow();
		assertNotEquals(before.rev(), meta.rev());
		assertEquals("Bram", meta.author().name());
	}

	@Test
	void calendarPutAndCancel() {
		long at = GameClock.at(4, 9, 0);
		Org.CalendarPut put = new Org.CalendarPut(null, "Dig", "task", new JsonPrimitive("all"), "game", at, null, new Org.Recurrence("daily", null), 30, null,
			"dig a cellar", "skip", false);
		String id = this.fake.calendarPut(put).join().eventId();
		Org.CalendarEvent event = this.state.event(id);
		assertEquals(at, event.nextAt());
		this.fake.calendarCancel(new Org.CalendarCancel(id, "next")).join();
		event = this.state.event(id);
		assertEquals(at + GameClock.TICKS_PER_DAY, event.nextAt(), "skipping moves to the next day");
		assertEquals("cancelled", event.occurrences().getLast().status());
		this.fake.calendarCancel(new Org.CalendarCancel(id, "all")).join();
		event = this.state.event(id);
		assertEquals("cancelled", event.status());
		assertNull(event.nextAt());
		assertEquals(Codes.CALENDAR_NOT_FOUND, code(this.fake.calendarCancel(new Org.CalendarCancel("ev-nope", "all"))));
		assertEquals(Codes.BAD_MESSAGE, code(this.fake.calendarPut(new Org.CalendarPut(null, "Bad", "task", new JsonPrimitive("all"), "game", at, null,
			new Org.Recurrence("weekdays", null), 30, null, null, "skip", false))), "weekdays on the game clock");
		assertValid(Org.CALENDAR_STATE, new Org.CalendarState(this.state.events(), this.state.tz()));
	}

	@Test
	void oneMeetingAtATime() {
		Org.MeetingStartResult preview = this.fake.meetingStart(new Org.MeetingStart(null, "Standup", null, true)).join();
		assertNull(preview.meetingId());
		assertEquals(3, preview.etas().size());
		assertNull(this.state.meeting(), "a preview starts nothing");
		Org.MeetingStartResult started = this.fake.meetingStart(new Org.MeetingStart(null, "Standup", null, false)).join();
		assertEquals(started.meetingId(), this.state.meeting().meetingId());
		assertEquals("gathering", this.state.meeting().phase());
		assertValid(Org.MEETING_STATE, this.state.meeting());
		assertEquals(Codes.MEETING_BUSY, code(this.fake.meetingStart(new Org.MeetingStart(null, "Again", null, false))));
		this.fake.advanceMeeting();
		assertEquals("open", this.state.meeting().phase());
		assertEquals("ada", this.state.meeting().speaker());
		this.fake.meetingEnd(started.meetingId()).join();
		assertNull(this.state.meeting());
		assertEquals(Codes.MEETING_NOT_FOUND, code(this.fake.meetingEnd(started.meetingId())));
	}

	@Test
	void offlineFailsEverything() {
		this.fake.setOnline(false);
		assertFalse(this.fake.online());
		assertEquals(Codes.DISCONNECTED, code(this.fake.codexGet("iron-cave")));
		assertEquals("MineVibe is offline; try again in a moment", OrgClient.describe(assertThrows(Exception.class, () -> this.fake.codexGet("x").join())));
	}

	@Test
	void writeAsStampsTheAuthor() {
		String id = this.fake.writeAs(new Types.Author("agent", "Cleo", "cleo"), "Seeds", "howto", "lasting", List.of("farm"), "Plant in rows");
		assertEquals("Cleo", this.fake.codexGet(id).join().author().name());
	}

	/**
	 * Checks a Node-to-mod payload the way the mod reads it from Node. Gson drops nulls, but on the wire a nullable key
	 * is present with {@code null} and an optional one is absent: serialize with nulls, then drop the nulls the schema
	 * does not allow.
	 */
	private static <P> void assertValid(final dev.minevibe.bridge.protocol.MessageType<P> type, final P payload) {
		JsonObject json = new GsonBuilder().serializeNulls().create().toJsonTree(payload).getAsJsonObject();
		json.addProperty("t", type.name());
		json.addProperty("v", 1);
		for (int round = 0; round < 50; round++) {
			List<String> errors = type.schema().validate(json);
			if (errors.isEmpty()) {
				return;
			}
			boolean removed = false;
			for (String error : errors) {
				String path = error.substring(0, error.indexOf(':'));
				if (removeNull(json, path.split("\\."))) {
					removed = true;
				}
			}
			assertTrue(removed, type + ": " + errors);
		}
	}

	private static boolean removeNull(final JsonElement root, final String[] path) {
		JsonElement at = root;
		for (int i = 0; i < path.length - 1; i++) {
			at = at.isJsonArray() ? at.getAsJsonArray().get(Integer.parseInt(path[i])) : at.getAsJsonObject().get(path[i]);
			if (at == null) {
				return false;
			}
		}
		String last = path[path.length - 1];
		if (at.isJsonObject() && at.getAsJsonObject().has(last) && at.getAsJsonObject().get(last).isJsonNull()) {
			at.getAsJsonObject().remove(last);
			return true;
		}
		return false;
	}

	private static void assertValid(final dev.minevibe.bridge.protocol.Schema.Obj schema, final Object result) {
		assertEquals(List.of(), schema.validate(ProtocolCodec.GSON.toJsonTree(result)));
	}

	@Test
	void describesErrorsForThePlayer() {
		assertEquals("A meeting is already running", OrgClient.describe(new dev.minevibe.bridge.BridgeException(Codes.MEETING_BUSY, "x")));
		assertEquals("boom", OrgClient.describe(new IllegalStateException("boom")));
		assertNull(OrgClient.code(new IllegalStateException("boom")));
		assertEquals(Messages.Codes.NO_QUORUM, OrgClient.code(new java.util.concurrent.CompletionException(new dev.minevibe.bridge.BridgeException(Codes.NO_QUORUM, "q"))));
	}
}
