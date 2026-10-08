package dev.minevibe.bridge.protocol;

import static dev.minevibe.bridge.protocol.Schema.MAX_SAFE_INTEGER;
import static dev.minevibe.bridge.protocol.Schema.anyObject;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.decimal;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.nullable;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Debug;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Seats;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.msg.World;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The message catalog. The M1 records (session, world, toast, bubble, chat line, debug) live here; every later group's
 * records and types live in {@code dev.minevibe.bridge.msg} ({@link Bodies}, {@link Skills}, {@link Seats}, {@link Ui},
 * {@link Pc}, {@link Org}, {@link Debug}) and are registered below, mirroring {@code packages/protocol/src/messages/*.ts}
 * and {@code registry.ts}. Records hold the payload only; the envelope keys ({@code t v id re}) travel beside them.
 * Optional and nullable fields are {@code @Nullable} references.
 */
public final class Messages {
	private Messages() {}

	public static final int PROTOCOL_VERSION = 1;
	public static final String SUBPROTOCOL = "minevibe.v1";
	public static final String BRIDGE_PATH = "/v1";
	public static final int MAX_TEXT_FRAME_BYTES = 256 * 1024;
	public static final int CHAT_MAX_LENGTH = 2000;

	// -----------------------------------------------------------------------------------------
	// Shared value types (regexes are full-match, without ^ and $)
	// -----------------------------------------------------------------------------------------

	public static final String WORLD_ID_REGEX = Types.WORLD_ID_REGEX;
	public static final String PLAYER_NAME_REGEX = Types.PLAYER_NAME_REGEX;
	public static final String MESSAGE_ID_REGEX = Types.MESSAGE_ID_REGEX;
	public static final String TYPE_NAME_REGEX = Types.TYPE_NAME_REGEX;
	public static final String ERROR_CODE_REGEX = Types.ERROR_CODE_REGEX;

	// The shared value schemas live in Types (no dependencies, so group classes can use them without init cycles).
	static final Schema.Node AGENT_ID = Types.AGENT_ID;
	static final Schema.Node WORLD_ID = Types.WORLD_ID;
	static final Schema.Node HANDLE = Types.HANDLE;
	static final Schema.Node PLAYER_NAME = Types.PLAYER_NAME;
	static final Schema.Node MESSAGE_ID = Types.MESSAGE_ID;
	static final Schema.Node TYPE_NAME = Types.TYPE_NAME;
	static final Schema.Node ERROR_CODE = Types.ERROR_CODE;
	static final Schema.Node INT32 = Types.INT32;
	static final Schema.Node NON_NEG_INT = Types.NON_NEG_INT;
	static final Schema.Node POS_INT = Types.POS_INT;
	static final Schema.Obj BLOCK_POS = Types.BLOCK_POS;

	public static boolean isWorldId(@Nullable String s) {
		return s != null && s.matches(WORLD_ID_REGEX);
	}

	public static boolean isPlayerName(@Nullable String s) {
		return s != null && s.matches(PLAYER_NAME_REGEX);
	}

	// -----------------------------------------------------------------------------------------
	// Payload records
	// -----------------------------------------------------------------------------------------

	public record BlockPos(int x, int y, int z) {}

	/** M→N. First message on every connection. */
	public record Hello(String mod, String mc, String phase, @Nullable String worldId, @Nullable String playerName) {
		public static final String PHASE_BOOT = "boot";
		public static final String PHASE_IN_WORLD = "in_world";
	}

	/** N→M. Handshake reply with a state snapshot ({@code budget} is null until known). */
	public record HelloOk(
			HelloOk.Server server,
			HelloOk.@Nullable World world,
			HelloOk.Player player,
			JsonObject settings,
			List<Pc.PcInfo> pcs,
			Pc.@Nullable Budget budget,
			List<CrewMember> crew,
			Brains brains,
			List<Ui.PendingCard> pending) {
		public record Server(String version, int protocol) {}

		public record World(String id, int gen, boolean fresh) {}

		public record Player(String name) {}
	}

	public record CrewMember(String agentId, String handle, String name, String role, boolean ceo, String status) {}

	public record Brains(long inFlight, long queued, long max, String mode, @Nullable Double utilization, @Nullable Long resetsAt) {}

	/** N→M. Open (or create) this world. */
	public record WorldOpen(String worldId, int gen, boolean fresh, boolean hardcore, String difficulty, @Nullable String seed) {}

	/** M→N. World lifecycle updates; pushed at 1 Hz while ready (with {@code clockTime} and {@code player}). */
	public record WorldState(
			String worldId,
			String phase,
			@Nullable Boolean fresh,
			@Nullable BlockPos spawn,
			@Nullable JsonObject office,
			@Nullable Long clockTime,
			World.@Nullable PlayerState player) {
		public static final String LOADING = "loading";
		public static final String READY = "ready";
		public static final String CLOSING = "closing";
		public static final String CLOSED = "closed";

		/** Without the player snapshot (the M1 shape). */
		public WorldState(
				String worldId,
				String phase,
				@Nullable Boolean fresh,
				@Nullable BlockPos spawn,
				@Nullable JsonObject office,
				@Nullable Long clockTime) {
			this(worldId, phase, fresh, spawn, office, clockTime, null);
		}

		public static WorldState phase(String worldId, String phase) {
			return new WorldState(worldId, phase, null, null, null, null, null);
		}
	}

	/** M→N request. The local player died; re-sent until acked. */
	public record PlayerDied(String worldId, String cause, @Nullable String killer, int day, long ticksAlive) {}

	/** N→M. The next world is allocated, plus a summary of the world that ended. */
	public record WorldNext(String worldId, int gen, WorldNext.Summary summary) {
		public record Summary(
				String worldId,
				int gen,
				int day,
				String cause,
				@Nullable String killer,
				List<CrewFate> crewFates,
				List<VaultCommits> vaultCommits) {}

		public record CrewFate(String agentId, String name, String role, String fate, @Nullable String detail) {}

		public record VaultCommits(String mount, long commits) {}
	}

	public record ClientStopping(@Nullable String reason) {}

	public record ServerShutdown(@Nullable String reason) {}

	public record UiToast(String text, String kind, @Nullable String agentId, @Nullable Integer ttlMs) {}

	public record AgentSay(String agentId, @Nullable String text, @Nullable String bark, String style, int ttlMs) {}

	/**
	 * M→N request. {@code to} is {@code "all"} or an array of agent ids; {@code mode} (AgentScreen) is chat, reply, task or
	 * interrupt.
	 */
	public record ChatSend(JsonElement to, String text, @Nullable String mode) {
		public ChatSend(JsonElement to, String text) {
			this(to, text, null);
		}
	}

	/** A success reply; {@code result} holds every key except the envelope keys. */
	public record Ok(JsonObject result) {}

	public record Err(String code, String msg) {}

	/** N→M request (E2E only). */
	public record DebugState() {}

	/** N→M request (E2E only). */
	public record DebugKillPlayer() {}

	/** N→M request (E2E only). */
	public record DebugOpenMenu() {}

	/** N→M request (E2E only). */
	public record DebugClickBegin() {}

	// -----------------------------------------------------------------------------------------
	// Catalog
	// -----------------------------------------------------------------------------------------

	private static final Map<String, MessageType<?>> CATALOG = new LinkedHashMap<>();

	private static <P> MessageType<P> register(MessageType<P> type) {
		if (CATALOG.putIfAbsent(type.name(), type) != null) throw new IllegalStateException("duplicate message type " + type.name());
		return type;
	}

	private static <P> MessageType<P> register(String name, Direction direction, Class<P> payload, Schema.Obj schema) {
		return register(Types.type(name, direction, payload, schema));
	}

	private static final Schema.Obj CREW_MEMBER = Types.CREW_MEMBER;

	public static final MessageType<Hello> HELLO = register("hello", Direction.MOD_TO_NODE, Hello.class, object()
			.req("mod", string(1, 64))
			.req("mc", string(1, 32))
			.req("phase", oneOf(Hello.PHASE_BOOT, Hello.PHASE_IN_WORLD))
			.opt("worldId", WORLD_ID)
			.opt("playerName", PLAYER_NAME));

	public static final MessageType<HelloOk> HELLO_OK = register("hello.ok", Direction.NODE_TO_MOD, HelloOk.class, object()
			.req("server", object().req("version", string(1, 64)).req("protocol", literal(PROTOCOL_VERSION)))
			.req("world", nullable(object().req("id", WORLD_ID).req("gen", POS_INT).req("fresh", bool())))
			.req("player", object().req("name", PLAYER_NAME))
			.req("settings", anyObject())
			.req("pcs", array(Pc.PC_INFO, 0, 64))
			.req("budget", nullable(Pc.BUDGET))
			.req("crew", array(CREW_MEMBER, 0, Integer.MAX_VALUE))
			.req("brains", Types.BRAINS)
			.req("pending", array(Ui.PENDING_CARD, 0, 256)));

	public static final MessageType<WorldOpen> WORLD_OPEN = register("world.open", Direction.NODE_TO_MOD, WorldOpen.class, object()
			.req("worldId", WORLD_ID)
			.req("gen", POS_INT)
			.req("fresh", bool())
			.req("hardcore", literal(true))
			.req("difficulty", literal("hard"))
			.opt("seed", string(0, 64)));

	public static final MessageType<WorldState> WORLD_STATE = register("world.state", Direction.MOD_TO_NODE, WorldState.class, object()
			.req("worldId", WORLD_ID)
			.req("phase", oneOf(WorldState.LOADING, WorldState.READY, WorldState.CLOSING, WorldState.CLOSED))
			.opt("fresh", bool())
			.opt("spawn", BLOCK_POS)
			.opt("office", object()
					.req("origin", BLOCK_POS)
					.req("slots", array(
							object().req("kind", string(1, 32)).req("pos", BLOCK_POS).opt("pcId", string(1, 64)),
							0,
							Integer.MAX_VALUE)))
			.opt("clockTime", NON_NEG_INT)
			.opt("player", World.PLAYER_STATE));

	public static final MessageType<PlayerDied> PLAYER_DIED = register("player.died", Direction.MOD_TO_NODE, PlayerDied.class, object()
			.req("worldId", WORLD_ID)
			.req("cause", string(1, 256))
			.opt("killer", string(1, 128))
			.req("day", POS_INT)
			.req("ticksAlive", NON_NEG_INT));

	public static final MessageType<WorldNext> WORLD_NEXT = register("world.next", Direction.NODE_TO_MOD, WorldNext.class, object()
			.req("worldId", WORLD_ID)
			.req("gen", POS_INT)
			.req("summary", object()
					.req("worldId", WORLD_ID)
					.req("gen", POS_INT)
					.req("day", POS_INT)
					.req("cause", string(1, 256))
					.opt("killer", string(1, 128))
					.req("crewFates", array(
							object()
									.req("agentId", AGENT_ID)
									.req("name", string(1, 32))
									.req("role", string(1, 32))
									.req("fate", oneOf("died", "dismissed", "lost_with_world"))
									.opt("detail", string(0, 256)),
							0,
							Integer.MAX_VALUE))
					.req("vaultCommits", array(
							object().req("mount", string(1, 1024)).req("commits", NON_NEG_INT), 0, Integer.MAX_VALUE))));

	public static final MessageType<ClientStopping> CLIENT_STOPPING = register(
			"client.stopping", Direction.MOD_TO_NODE, ClientStopping.class, object().opt("reason", string(0, 64)));

	public static final MessageType<ServerShutdown> SERVER_SHUTDOWN = register(
			"server.shutdown", Direction.NODE_TO_MOD, ServerShutdown.class, object().opt("reason", string(0, 64)));

	public static final MessageType<UiToast> UI_TOAST = register("ui.toast", Direction.NODE_TO_MOD, UiToast.class, object()
			.req("text", string(1, 512))
			.req("kind", oneOf("info", "success", "warn", "error"))
			.opt("agentId", AGENT_ID)
			.opt("ttlMs", integer(500, 60_000)));

	public static final MessageType<AgentSay> AGENT_SAY = register("agent.say", Direction.NODE_TO_MOD, AgentSay.class, object()
			.req("agentId", AGENT_ID)
			.opt("text", string(1, CHAT_MAX_LENGTH))
			.opt("bark", string(1, 64))
			.req("style", oneOf("speech", "bark", "tell"))
			.req("ttlMs", integer(500, 120_000))
			.refine(o -> o.has("text") || o.has("bark"), "agent.say needs text or bark"));

	public static final MessageType<ChatSend> CHAT_SEND = register("chat.send", Direction.MOD_TO_NODE, ChatSend.class, object()
			.req("to", union(literal("all"), array(AGENT_ID, 1, 16)))
			.req("text", string(1, CHAT_MAX_LENGTH))
			.opt("mode", oneOf("chat", "reply", "task", "interrupt")));

	public static final MessageType<DebugState> DEBUG_STATE =
			register("debug.state", Direction.NODE_TO_MOD, DebugState.class, object());

	public static final MessageType<DebugKillPlayer> DEBUG_KILL_PLAYER =
			register("debug.kill_player", Direction.NODE_TO_MOD, DebugKillPlayer.class, object());

	public static final MessageType<DebugOpenMenu> DEBUG_OPEN_MENU =
			register("debug.open_menu", Direction.NODE_TO_MOD, DebugOpenMenu.class, object());

	public static final MessageType<DebugClickBegin> DEBUG_CLICK_BEGIN =
			register("debug.click_begin", Direction.NODE_TO_MOD, DebugClickBegin.class, object());

	public static final MessageType<Ok> OK = register("ok", Direction.BOTH, Ok.class, object().req("re", MESSAGE_ID));

	public static final MessageType<Err> ERR = register("err", Direction.BOTH, Err.class, object()
			.req("re", MESSAGE_ID)
			.req("code", ERROR_CODE)
			.req("msg", string(0, 2000)));

	static {
		for (List<MessageType<?>> group : List.of(Bodies.TYPES, Skills.TYPES, Seats.TYPES, Ui.TYPES, Pc.TYPES, Org.TYPES, Debug.TYPES)) {
			for (MessageType<?> type : group) register(type);
		}
	}

	/** Envelope-only schema, for messages whose type is unknown. */
	static final Schema.Obj ENVELOPE = object()
			.req("t", TYPE_NAME)
			.req("v", literal(PROTOCOL_VERSION))
			.opt("id", MESSAGE_ID)
			.opt("re", MESSAGE_ID);

	/** Every known type, by wire name. */
	public static Map<String, MessageType<?>> catalog() {
		return Collections.unmodifiableMap(CATALOG);
	}

	public static @Nullable MessageType<?> byName(String name) {
		return CATALOG.get(name);
	}

	/** Error codes used in {@code err} replies (see {@code ERROR_CODES} in envelope.ts). */
	public static final class Codes {
		private Codes() {}

		public static final String BAD_MESSAGE = "BAD_MESSAGE";
		public static final String UNKNOWN_TYPE = "UNKNOWN_TYPE";
		public static final String NOT_HANDLED = "NOT_HANDLED";
		public static final String INTERNAL = "INTERNAL";
		/** Local only: no reply in time. */
		public static final String TIMEOUT = "TIMEOUT";
		/** Local only: the connection closed first. */
		public static final String DISCONNECTED = "DISCONNECTED";
		public static final String NO_SERVER = "NO_SERVER";
		public static final String NOT_READY = "NOT_READY";
		public static final String CHAT_UNKNOWN = "CHAT_UNKNOWN";
		public static final String CHAT_AMBIGUOUS = "CHAT_AMBIGUOUS";
		public static final String CHAT_UNAVAILABLE = "CHAT_UNAVAILABLE";
		public static final String CHAT_INVALID_ANSWER = "CHAT_INVALID_ANSWER";
		public static final String CHAT_REJECTED = "CHAT_REJECTED";
		// Bodies and skills
		public static final String UNKNOWN_AGENT = "UNKNOWN_AGENT";
		public static final String UNKNOWN_SKILL = "UNKNOWN_SKILL";
		public static final String BAD_ARGS = "BAD_ARGS";
		public static final String BUSY = "BUSY";
		public static final String UNKNOWN_JOB = "UNKNOWN_JOB";
		// Seats
		public static final String PC_DOWN = "PC_DOWN";
		public static final String SEAT_CAP = "SEAT_CAP";
		public static final String RESERVED = "RESERVED";
		public static final String OCCUPIED_BY_PLAYER = "OCCUPIED_BY_PLAYER";
		public static final String UNREACHABLE = "UNREACHABLE";
		public static final String NO_SEAT = "NO_SEAT";
		// Cards and rights
		public static final String CARD_GONE = "CARD_GONE";
		public static final String FORBIDDEN = "FORBIDDEN";
		// PCs
		public static final String PC_UNKNOWN = "PC_UNKNOWN";
		public static final String OVER_BUDGET = "OVER_BUDGET";
		public static final String NO_CAPACITY = "NO_CAPACITY";
		public static final String MACOS_SLOTS_FULL = "MACOS_SLOTS_FULL";
		public static final String BAD_MOUNT = "BAD_MOUNT";
		public static final String ENGINE_DOWN = "ENGINE_DOWN";
		// Codex, calendar, meetings
		public static final String CODEX_NOT_FOUND = "CODEX_NOT_FOUND";
		public static final String CODEX_CONFLICT = "CODEX_CONFLICT";
		public static final String CODEX_SIMILAR = "CODEX_SIMILAR";
		public static final String CODEX_TOO_LARGE = "CODEX_TOO_LARGE";
		public static final String CODEX_SECRET = "CODEX_SECRET";
		public static final String CODEX_INVALID = "CODEX_INVALID";
		public static final String CODEX_BUDGET = "CODEX_BUDGET";
		public static final String CALENDAR_NOT_FOUND = "CALENDAR_NOT_FOUND";
		public static final String CALENDAR_INVALID = "CALENDAR_INVALID";
		public static final String CALENDAR_LIMIT = "CALENDAR_LIMIT";
		public static final String MEETING_BUSY = "MEETING_BUSY";
		public static final String MEETING_NOT_FOUND = "MEETING_NOT_FOUND";
		public static final String NO_QUORUM = "NO_QUORUM";
	}
}
