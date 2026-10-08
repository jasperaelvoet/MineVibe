package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.AUTHOR;
import static dev.minevibe.bridge.msg.Types.CODEX_ID;
import static dev.minevibe.bridge.msg.Types.EPOCH_MS;
import static dev.minevibe.bridge.msg.Types.EVENT_ID;
import static dev.minevibe.bridge.msg.Types.MEETING_ID;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.NON_NEG_NUMBER;
import static dev.minevibe.bridge.msg.Types.PLACE;
import static dev.minevibe.bridge.msg.Types.REV;
import static dev.minevibe.bridge.msg.Types.TITLE;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.nullable;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** Org group (PLAN §5, §6.6): Codex, calendar and meetings. Mirrors {@code org.ts}. */
public final class Org {
	private Org() {}

	public static final int CODEX_BODY_MAX = 8192;

	public static final List<String> CODEX_CATEGORIES =
			List.of("places", "howto", "projects", "decisions", "people", "log", "minutes", "rules");

	public static final List<String> OCCURRENCE_STATUSES =
			List.of("fired", "done", "failed", "blocked", "missed", "deferred", "orphaned", "cancelled");

	// -----------------------------------------------------------------------------------------
	// Records: Codex
	// -----------------------------------------------------------------------------------------

	public record CodexPageMeta(
			String id,
			String title,
			String category,
			String scope,
			List<String> tags,
			Types.Author author,
			long created,
			long updated,
			String rev,
			boolean pinned) {}

	public record CodexHistoryEntry(String rev, long at, Types.Author author, String summary) {}

	public record CodexPage(
			String id,
			String title,
			String category,
			String scope,
			List<String> tags,
			Types.Author author,
			long created,
			long updated,
			String rev,
			boolean pinned,
			String body,
			List<String> links,
			List<CodexHistoryEntry> history) {}

	public record CodexHit(String id, String title, String category, String scope, String snippet, double score) {}

	/** N→M. */
	public record CodexIndex(List<CodexPageMeta> pages, boolean truncated) {}

	/** M→N request. Reply: {@link CodexSearchResult}. */
	public record CodexSearch(
			String query, @Nullable List<String> tags, @Nullable String category, @Nullable String scope, int limit) {}

	public record CodexSearchResult(List<CodexHit> hits) {}

	/** M→N request. Reply: {@link CodexGetResult}. */
	public record CodexGet(String pageId) {}

	public record CodexGetResult(CodexPage page) {}

	/** M→N request. {@code mode}: create, update (pageId, baseRev), append (pageId). Reply: {@link CodexPutResult}. */
	public record CodexPut(
			String mode,
			@Nullable String pageId,
			@Nullable String baseRev,
			String title,
			String body,
			List<String> tags,
			String category,
			String scope,
			@Nullable Boolean pinned) {}

	public record CodexPutResult(String pageId, String rev) {}

	/** M→N request. */
	public record CodexDelete(String pageId, @Nullable String baseRev) {}

	// -----------------------------------------------------------------------------------------
	// Records: calendar
	// -----------------------------------------------------------------------------------------

	/** {@code kind}: once, daily, every_n_days (n), weekdays (real clock only). */
	public record Recurrence(String kind, @Nullable Integer n) {}

	public record Occurrence(long at, String status, @Nullable String note, @Nullable String agentId) {}

	/**
	 * A calendar event. {@code assignees} is {@code "all"} or an array of agent ids; {@code createdBy} is
	 * {@code player} or an agent id. {@code at} / {@code nextAt} are clock ticks (game) or epoch ms (real).
	 */
	public record CalendarEvent(
			String id,
			String title,
			String kind,
			JsonElement assignees,
			String clock,
			long at,
			@Nullable String tz,
			Recurrence recurrence,
			int durationMin,
			@Nullable String location,
			@Nullable String task,
			String catchUp,
			boolean runWhileAway,
			String createdBy,
			String status,
			@Nullable Long nextAt,
			List<Occurrence> occurrences) {}

	/** N→M. */
	public record CalendarState(List<CalendarEvent> events, String tz) {}

	/** M→N request: create (no eventId) or replace. Reply: {@link CalendarPutResult}. */
	public record CalendarPut(
			@Nullable String eventId,
			String title,
			String kind,
			JsonElement assignees,
			String clock,
			long at,
			@Nullable String tz,
			Recurrence recurrence,
			int durationMin,
			@Nullable String location,
			@Nullable String task,
			String catchUp,
			boolean runWhileAway) {}

	public record CalendarPutResult(String eventId) {}

	/** M→N request. {@code scope}: next, all. */
	public record CalendarCancel(String eventId, String scope) {}

	/** N→M. {@code walk}: assignees that go to {@code target} now (reflex 38). */
	public record CalendarFired(
			String eventId, long occurrence, String kind, String title, List<String> assignees, Types.@Nullable Place target, List<String> walk) {}

	// -----------------------------------------------------------------------------------------
	// Records: meetings
	// -----------------------------------------------------------------------------------------

	/** {@code status}: coming, seated, dialed_in, absent, excused, left, dead. */
	public record MeetingAttendee(String agentId, String status, @Nullable Long etaS) {}

	/** N→M. {@code chair} / {@code speaker}: {@code player} or an agent id. */
	public record MeetingState(
			String meetingId,
			String title,
			String phase,
			String chair,
			@Nullable String speaker,
			List<MeetingAttendee> attendees,
			@Nullable String eventId,
			long startedAt,
			long endsBy,
			boolean quick) {}

	/** M→N request. {@code attendees}: absent (everyone), {@code "all"} or agent ids. Reply: {@link MeetingStartResult}. */
	public record MeetingStart(@Nullable String eventId, @Nullable String title, @Nullable JsonElement attendees, boolean preview) {}

	public record Eta(String agentId, @Nullable Long etaS, boolean dialIn) {}

	public record MeetingStartResult(@Nullable String meetingId, List<Eta> etas) {}

	/** M→N request. */
	public record MeetingEnd(String meetingId) {}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Node CATEGORY = oneOf(CODEX_CATEGORIES.toArray(String[]::new));
	static final Schema.Node SCOPE = oneOf("lasting", "world");
	static final Schema.Node TAG = string(1, 32, "[a-z0-9][a-z0-9-]{0,31}", "tag");
	static final Schema.Node ASSIGNEES = union(literal("all"), array(AGENT_ID, 1, 16));
	static final Schema.Node CALENDAR_KIND = oneOf("task", "reminder", "meeting");

	static final Schema.Obj PAGE_META = object()
			.req("id", CODEX_ID)
			.req("title", TITLE)
			.req("category", CATEGORY)
			.req("scope", SCOPE)
			.req("tags", array(TAG, 0, 16))
			.req("author", AUTHOR)
			.req("created", EPOCH_MS)
			.req("updated", EPOCH_MS)
			.req("rev", REV)
			.req("pinned", bool());

	static final Schema.Obj RECURRENCE = object()
			.req("kind", oneOf("once", "daily", "every_n_days", "weekdays"))
			.opt("n", integer(2, 365))
			.refine(o -> "every_n_days".equals(Ui.str(o.get("kind"))) == o.has("n"), "every_n_days needs n (and only it)");

	/** Event fields shared by {@code CalendarEvent} and {@code calendar.put}. */
	private static Schema.Obj eventFields() {
		return object()
				.req("title", TITLE)
				.req("kind", CALENDAR_KIND)
				.req("assignees", ASSIGNEES)
				.req("clock", oneOf("game", "real"))
				.req("at", NON_NEG_INT)
				.opt("tz", string(1, 64))
				.req("recurrence", RECURRENCE)
				.req("durationMin", integer(1, 1440))
				.opt("location", string(1, 80))
				.opt("task", string(1, 2000))
				.req("catchUp", oneOf("skip", "once_late"))
				.req("runWhileAway", bool())
				.refine(Org::weekdaysOnRealClock, "weekdays recurrence needs the real clock");
	}

	static boolean weekdaysOnRealClock(JsonObject o) {
		JsonElement recurrence = o.get("recurrence");
		String kind = recurrence instanceof JsonObject r ? Ui.str(r.get("kind")) : null;
		return !"weekdays".equals(kind) || "real".equals(Ui.str(o.get("clock")));
	}

	static final Schema.Obj CALENDAR_EVENT = eventFields()
			.req("id", EVENT_ID)
			.req("createdBy", union(literal("player"), AGENT_ID))
			.req("status", oneOf("active", "paused", "pending_approval", "orphaned", "done", "cancelled"))
			.req("nextAt", nullable(NON_NEG_INT))
			.req("occurrences", array(object()
					.req("at", NON_NEG_INT)
					.req("status", oneOf(OCCURRENCE_STATUSES.toArray(String[]::new)))
					.opt("note", string(1, 200))
					.opt("agentId", AGENT_ID), 0, 20));

	static final Schema.Node SPEAKER = union(literal("player"), AGENT_ID);

	public static final MessageType<CodexIndex> CODEX_INDEX = type("codex.index", Direction.NODE_TO_MOD, CodexIndex.class, object()
			.req("pages", array(PAGE_META, 0, 1000))
			.req("truncated", bool()));

	public static final MessageType<CodexSearch> CODEX_SEARCH = type("codex.search", Direction.MOD_TO_NODE, CodexSearch.class, object()
			.req("query", string(0, 200))
			.opt("tags", array(TAG, 0, 8))
			.opt("category", CATEGORY)
			.opt("scope", SCOPE)
			.req("limit", integer(1, 50)));

	public static final MessageType<CodexGet> CODEX_GET =
			type("codex.get", Direction.MOD_TO_NODE, CodexGet.class, object().req("pageId", CODEX_ID));

	public static final MessageType<CodexPut> CODEX_PUT = type("codex.put", Direction.MOD_TO_NODE, CodexPut.class, object()
			.req("mode", oneOf("create", "update", "append"))
			.opt("pageId", CODEX_ID)
			.opt("baseRev", REV)
			.req("title", TITLE)
			.req("body", string(1, CODEX_BODY_MAX))
			.req("tags", array(TAG, 0, 16))
			.req("category", CATEGORY)
			.req("scope", SCOPE)
			.opt("pinned", bool())
			.refine(o -> "create".equals(Ui.str(o.get("mode"))) || o.has("pageId"), "update and append need pageId")
			.refine(o -> !"update".equals(Ui.str(o.get("mode"))) || o.has("baseRev"), "update needs baseRev"));

	public static final MessageType<CodexDelete> CODEX_DELETE = type("codex.delete", Direction.MOD_TO_NODE, CodexDelete.class, object()
			.req("pageId", CODEX_ID)
			.opt("baseRev", REV));

	public static final MessageType<CalendarState> CALENDAR_STATE = type("calendar.state", Direction.NODE_TO_MOD, CalendarState.class, object()
			.req("events", array(CALENDAR_EVENT, 0, 500))
			.req("tz", string(1, 64)));

	public static final MessageType<CalendarPut> CALENDAR_PUT =
			type("calendar.put", Direction.MOD_TO_NODE, CalendarPut.class, eventFields().opt("eventId", EVENT_ID));

	public static final MessageType<CalendarCancel> CALENDAR_CANCEL = type("calendar.cancel", Direction.MOD_TO_NODE, CalendarCancel.class, object()
			.req("eventId", EVENT_ID)
			.req("scope", oneOf("next", "all")));

	public static final MessageType<CalendarFired> CALENDAR_FIRED = type("calendar.fired", Direction.NODE_TO_MOD, CalendarFired.class, object()
			.req("eventId", EVENT_ID)
			.req("occurrence", NON_NEG_INT)
			.req("kind", CALENDAR_KIND)
			.req("title", TITLE)
			.req("assignees", array(AGENT_ID, 0, 16))
			.req("target", nullable(PLACE))
			.req("walk", array(AGENT_ID, 0, 16)));

	public static final MessageType<MeetingState> MEETING_STATE = type("meeting.state", Direction.NODE_TO_MOD, MeetingState.class, object()
			.req("meetingId", MEETING_ID)
			.req("title", TITLE)
			.req("phase", oneOf("gathering", "open", "updates", "floor", "wrapup", "done"))
			.req("chair", SPEAKER)
			.req("speaker", nullable(SPEAKER))
			.req("attendees", array(object()
					.req("agentId", AGENT_ID)
					.req("status", oneOf("coming", "seated", "dialed_in", "absent", "excused", "left", "dead"))
					.req("etaS", nullable(NON_NEG_INT)), 0, 16))
			.req("eventId", nullable(EVENT_ID))
			.req("startedAt", EPOCH_MS)
			.req("endsBy", EPOCH_MS)
			.req("quick", bool()));

	public static final MessageType<MeetingStart> MEETING_START = type("meeting.start", Direction.MOD_TO_NODE, MeetingStart.class, object()
			.opt("eventId", EVENT_ID)
			.opt("title", TITLE)
			.opt("attendees", ASSIGNEES)
			.req("preview", bool()));

	public static final MessageType<MeetingEnd> MEETING_END =
			type("meeting.end", Direction.MOD_TO_NODE, MeetingEnd.class, object().req("meetingId", MEETING_ID));

	public static final Schema.Obj CODEX_SEARCH_RESULT = object().req("hits", array(object()
			.req("id", CODEX_ID)
			.req("title", TITLE)
			.req("category", CATEGORY)
			.req("scope", SCOPE)
			.req("snippet", string(0, 400))
			.req("score", NON_NEG_NUMBER), 0, 50));

	public static final Schema.Obj CODEX_PUT_RESULT = object().req("pageId", CODEX_ID).req("rev", REV);
	public static final Schema.Obj CALENDAR_PUT_RESULT = object().req("eventId", EVENT_ID);
	public static final Schema.Obj MEETING_START_RESULT = object()
			.req("meetingId", nullable(MEETING_ID))
			.req("etas", array(object().req("agentId", AGENT_ID).req("etaS", nullable(NON_NEG_INT)).req("dialIn", bool()), 0, 16));

	public static final List<MessageType<?>> TYPES = List.of(
			CODEX_INDEX, CODEX_SEARCH, CODEX_GET, CODEX_PUT, CODEX_DELETE, CALENDAR_STATE, CALENDAR_PUT, CALENDAR_CANCEL, CALENDAR_FIRED,
			MEETING_STATE, MEETING_START, MEETING_END);
}
