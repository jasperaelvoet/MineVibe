package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.protocol.Schema.MAX_SAFE_INTEGER;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.decimal;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.nullable;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Schema;
import org.jspecify.annotations.Nullable;

/**
 * Shared value schemas, mirroring {@code packages/protocol/src/messages/common.ts}. This class depends on nothing but
 * {@link Schema}, so every group class (and {@code Messages}) can use it during static initialisation without class
 * initialisation cycles. Regexes are full-match, written without {@code ^…$}.
 */
public final class Types {
	private Types() {}

	public static final int PROTOCOL_VERSION = 1;

	public static final String AGENT_ID_REGEX = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
	public static final String WORLD_ID_REGEX = "[a-z0-9][a-z0-9-]{0,63}";
	public static final String HANDLE_REGEX = "[a-z][a-z0-9]{1,11}";
	public static final String PLAYER_NAME_REGEX = "[A-Za-z0-9_]{1,16}";
	public static final String PC_ID_REGEX = "[a-z0-9][a-z0-9-]{0,63}";
	public static final String OPAQUE_ID_REGEX = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}";
	public static final String CODEX_ID_REGEX = "[a-z0-9][a-z0-9-]{0,79}";
	public static final String MESSAGE_ID_REGEX = "[\\x21-\\x7e]+";
	public static final String TYPE_NAME_REGEX = "[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*)*";
	public static final String ERROR_CODE_REGEX = "[A-Z][A-Z0-9_]{1,63}";

	public static final Schema.Node AGENT_ID = string(1, 64, AGENT_ID_REGEX, "agent id");
	public static final Schema.Node WORLD_ID = string(1, 64, WORLD_ID_REGEX, "world id: 1-64 of [a-z0-9-]");
	public static final Schema.Node HANDLE = string(2, 12, HANDLE_REGEX, "handle");
	public static final Schema.Node PLAYER_NAME = string(1, 16, PLAYER_NAME_REGEX, "Minecraft player name");
	public static final Schema.Node MESSAGE_ID = string(1, 64, MESSAGE_ID_REGEX, "printable ASCII without spaces");
	public static final Schema.Node TYPE_NAME = string(1, 64, TYPE_NAME_REGEX, "dotted lowercase type name");
	public static final Schema.Node ERROR_CODE = string(2, 64, ERROR_CODE_REGEX, "SCREAMING_SNAKE_CASE");

	public static final Schema.Node PC_ID = string(1, 64, PC_ID_REGEX, "pc id");
	public static final Schema.Node PENDING_ID = string(1, 64, OPAQUE_ID_REGEX, "pending id");
	public static final Schema.Node JOB_ID = string(1, 64, OPAQUE_ID_REGEX, "job id");
	public static final Schema.Node EVENT_ID = string(1, 64, OPAQUE_ID_REGEX, "event id");
	public static final Schema.Node MEETING_ID = string(1, 64, OPAQUE_ID_REGEX, "meeting id");
	public static final Schema.Node CONSENT_ID = string(1, 64, OPAQUE_ID_REGEX, "consent id");
	public static final Schema.Node CODEX_ID = string(1, 80, CODEX_ID_REGEX, "codex id");
	public static final Schema.Node REV = string(7, 64, "[0-9a-f]{7,64}", "revision");
	public static final Schema.Node DIMENSION = string(0, 128, "[a-z0-9_.-]+:[a-z0-9_./-]+", "dimension: namespace:path");
	public static final Schema.Node ITEM_ID = string(0, 128, "#?([a-z0-9_.-]+:)?[a-z0-9_./-]+", "item id");
	public static final Schema.Node ENTITY_REF = string(1, 64, "[A-Za-z0-9_:.#-]+", "entity reference");
	public static final Schema.Node TITLE = string(1, 80, "[^\\r\\n]*", "single line");
	public static final Schema.Node DISPLAY_NAME = string(1, 32);
	public static final Schema.Node BARK_KEY = string(1, 64, "[a-z][a-z0-9_]{0,63}", "bark key");
	/** An absolute host path ({@code startsWith('/')}). */
	public static final Schema.Node ABS_PATH = string(1, 1024, "(?s)/.*", "absolute path");

	public static final Schema.Node INT32 = integer(Integer.MIN_VALUE, Integer.MAX_VALUE);
	public static final Schema.Node NON_NEG_INT = integer(0, MAX_SAFE_INTEGER);
	public static final Schema.Node POS_INT = integer(1, MAX_SAFE_INTEGER);
	public static final Schema.Node UINT32 = integer(0, 0xFFFF_FFFFL);
	public static final Schema.Node EPOCH_MS = NON_NEG_INT;
	public static final Schema.Node FRACTION = decimal(0, 1);
	public static final Schema.Node ANY_NUMBER = decimal(-Double.MAX_VALUE, Double.MAX_VALUE);
	public static final Schema.Node NON_NEG_NUMBER = decimal(0, Double.MAX_VALUE);
	/** Pixel coordinates on a guest screen. */
	public static final Schema.Node PIXEL = integer(0, 65_535);

	public static final Schema.Obj BLOCK_POS = object().req("x", INT32).req("y", INT32).req("z", INT32);
	public static final Schema.Obj VEC3 = object().req("x", ANY_NUMBER).req("y", ANY_NUMBER).req("z", ANY_NUMBER);
	public static final Schema.Obj PLACE = object().req("pos", BLOCK_POS).req("dim", DIMENSION);

	public static final Schema.Node AGENT_ROLE = oneOf("ceo", "engineer", "miner", "farmer", "guard", "builder");
	public static final Schema.Node IDLE_MODE = oneOf("follow", "stay", "guard", "wander");
	public static final Schema.Node MODEL_TIER = oneOf("haiku", "opus");
	public static final Schema.Node AUTONOMY = oneOf("listen", "helpful", "proactive");

	public static final Schema.Node OCCUPANT = union(
			object().req("kind", literal("player")),
			object().req("kind", literal("agent")).req("agentId", AGENT_ID));

	public static final Schema.Obj AUTHOR = object()
			.req("kind", oneOf("player", "agent", "system"))
			.req("name", string(1, 48))
			.opt("agentId", AGENT_ID);

	public static final Schema.Obj CREW_MEMBER = object()
			.req("agentId", AGENT_ID)
			.req("handle", HANDLE)
			.req("name", string(1, 32))
			.req("role", string(1, 32))
			.req("ceo", bool())
			.req("status", oneOf("alive", "dead", "dismissed"));

	public static final Schema.Obj BRAINS = object()
			.req("inFlight", NON_NEG_INT)
			.req("queued", NON_NEG_INT)
			.req("max", NON_NEG_INT)
			.req("mode", oneOf("normal", "tired", "asleep"))
			.req("utilization", nullable(decimal(0, 1)))
			.req("resetsAt", nullable(NON_NEG_INT));

	/** A free-form JSON object (skill args and results). */
	public static final Schema.Node JSON_OBJECT = Schema.anyObject();

	/** Envelope keys of message type {@code t}. */
	public static Schema.Obj envelope(String t) {
		return object().req("t", literal(t)).req("v", literal(PROTOCOL_VERSION)).opt("id", MESSAGE_ID).opt("re", MESSAGE_ID);
	}

	/** A message type: the envelope of {@code name} plus {@code payload}'s keys. */
	public static <P> MessageType<P> type(String name, MessageType.Direction direction, Class<P> payloadClass, Schema.Obj payload) {
		return new MessageType<>(name, direction, envelope(name).extend(payload), payloadClass);
	}

	// -----------------------------------------------------------------------------------------
	// Shared records
	// -----------------------------------------------------------------------------------------

	/** An exact position (entity coordinates). */
	public record Vec3(double x, double y, double z) {}

	/** A block position in a dimension. */
	public record Place(dev.minevibe.bridge.protocol.Messages.BlockPos pos, String dim) {}

	/** Who sits on a seat: {@code kind} is {@code player} or {@code agent} (then {@code agentId} is set). */
	public record Occupant(String kind, @Nullable String agentId) {
		public static final String PLAYER = "player";
		public static final String AGENT = "agent";

		public static Occupant player() {
			return new Occupant(PLAYER, null);
		}

		public static Occupant agent(String agentId) {
			return new Occupant(AGENT, agentId);
		}

		public boolean isPlayer() {
			return PLAYER.equals(kind);
		}
	}

	/** Who wrote something: {@code kind} is {@code player}, {@code agent} or {@code system}. */
	public record Author(String kind, String name, @Nullable String agentId) {}

	/** A job or skill failure. */
	public record Failure(String code, String msg) {}
}
