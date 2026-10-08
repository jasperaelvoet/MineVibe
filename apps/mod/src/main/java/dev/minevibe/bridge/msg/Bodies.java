package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.AGENT_ROLE;
import static dev.minevibe.bridge.msg.Types.BARK_KEY;
import static dev.minevibe.bridge.msg.Types.BLOCK_POS;
import static dev.minevibe.bridge.msg.Types.CREW_MEMBER;
import static dev.minevibe.bridge.msg.Types.DIMENSION;
import static dev.minevibe.bridge.msg.Types.DISPLAY_NAME;
import static dev.minevibe.bridge.msg.Types.FRACTION;
import static dev.minevibe.bridge.msg.Types.HANDLE;
import static dev.minevibe.bridge.msg.Types.IDLE_MODE;
import static dev.minevibe.bridge.msg.Types.ITEM_ID;
import static dev.minevibe.bridge.msg.Types.JOB_ID;
import static dev.minevibe.bridge.msg.Types.JSON_OBJECT;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.NON_NEG_NUMBER;
import static dev.minevibe.bridge.msg.Types.PLACE;
import static dev.minevibe.bridge.msg.Types.POS_INT;
import static dev.minevibe.bridge.msg.Types.VEC3;
import static dev.minevibe.bridge.msg.Types.WORLD_ID;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.decimal;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** Bodies group (PLAN §5): spawn, despawn, 1 Hz state, events, deaths, idle modes, crew. Mirrors {@code bodies.ts}. */
public final class Bodies {
	private Bodies() {}

	/** {@code agent.event} kinds, as in {@code AGENT_EVENT_KINDS}. */
	public static final List<String> EVENT_KINDS = List.of(
			"hurt", "hp_critical", "starving", "ate", "killed", "reflex", "stuck", "unseated", "kicked", "player_low_hp",
			"dimension_changed", "arrived", "approach_blocked", "fed_player", "shared_food", "picked_up", "advancement");

	// -----------------------------------------------------------------------------------------
	// Records
	// -----------------------------------------------------------------------------------------

	/** N→M request. Reply: {@link AgentSpawnResult}. */
	public record AgentSpawn(
			String agentId,
			String handle,
			String name,
			String role,
			boolean ceo,
			@Nullable String skin,
			Types.@Nullable Place at,
			boolean restore,
			String mode,
			@Nullable String bark) {}

	public record AgentSpawnResult(Types.Vec3 pos, String dim, boolean restored) {}

	/** N→M request. {@code reason}: dismissed, world_end, shutdown. */
	public record AgentDespawn(String agentId, String reason, boolean farewell) {}

	/** The running job of a body. */
	public record BodyJob(String jobId, String skill, @Nullable Double progress) {}

	/** One agent body in {@code agent.state}. {@code seat} is a {@link Seats.SeatTarget}. */
	public record AgentBody(
			String agentId,
			Types.Vec3 pos,
			String dim,
			double hp,
			double maxHp,
			int food,
			double saturation,
			String mode,
			boolean hasFood,
			boolean inCombat,
			@Nullable String reflex,
			@Nullable BodyJob job,
			Seats.@Nullable SeatTarget seat,
			@Nullable Double playerDistance,
			@Nullable String held) {}

	/** M→N, 1 Hz. */
	public record AgentState(long tick, List<AgentBody> agents) {}

	/** M→N. {@code urgency}: 0 info, 1 notable, 2 critical, 3 emergency. */
	public record AgentEvent(String agentId, String kind, int urgency, String text, @Nullable JsonObject data) {}

	/** M→N request, re-sent until acked. */
	public record AgentDied(
			String agentId,
			String worldId,
			String cause,
			@Nullable String killer,
			int day,
			Messages.BlockPos pos,
			String dim,
			Messages.@Nullable BlockPos grave) {}

	/** N→M request. */
	public record AgentMode(String agentId, String mode, Messages.@Nullable BlockPos anchor) {}

	/** N→M. */
	public record CrewState(List<Messages.CrewMember> crew) {}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Obj AGENT_BODY = object()
			.req("agentId", AGENT_ID)
			.req("pos", VEC3)
			.req("dim", DIMENSION)
			.req("hp", decimal(0, 1024))
			.req("maxHp", decimal(0, 1024))
			.req("food", integer(0, 20))
			.req("saturation", decimal(0, 20))
			.req("mode", IDLE_MODE)
			.req("hasFood", bool())
			.req("inCombat", bool())
			.opt("reflex", string(1, 32))
			.opt("job", object().req("jobId", JOB_ID).req("skill", Skills.SKILL_NAME).opt("progress", FRACTION))
			.opt("seat", Seats.SEAT_TARGET)
			.opt("playerDistance", NON_NEG_NUMBER)
			.opt("held", ITEM_ID);

	public static final MessageType<AgentSpawn> AGENT_SPAWN = type("agent.spawn", Direction.NODE_TO_MOD, AgentSpawn.class, object()
			.req("agentId", AGENT_ID)
			.req("handle", HANDLE)
			.req("name", DISPLAY_NAME)
			.req("role", AGENT_ROLE)
			.req("ceo", bool())
			.opt("skin", string(1, 64))
			.opt("at", PLACE)
			.req("restore", bool())
			.req("mode", IDLE_MODE)
			.opt("bark", BARK_KEY));

	public static final MessageType<AgentDespawn> AGENT_DESPAWN = type("agent.despawn", Direction.NODE_TO_MOD, AgentDespawn.class, object()
			.req("agentId", AGENT_ID)
			.req("reason", oneOf("dismissed", "world_end", "shutdown"))
			.req("farewell", bool()));

	public static final MessageType<AgentState> AGENT_STATE = type("agent.state", Direction.MOD_TO_NODE, AgentState.class, object()
			.req("tick", NON_NEG_INT)
			.req("agents", array(AGENT_BODY, 0, 64)));

	public static final MessageType<AgentEvent> AGENT_EVENT = type("agent.event", Direction.MOD_TO_NODE, AgentEvent.class, object()
			.req("agentId", AGENT_ID)
			.req("kind", oneOf(EVENT_KINDS.toArray(String[]::new)))
			.req("urgency", integer(0, 3))
			.req("text", string(1, 256))
			.opt("data", JSON_OBJECT));

	public static final MessageType<AgentDied> AGENT_DIED = type("agent.died", Direction.MOD_TO_NODE, AgentDied.class, object()
			.req("agentId", AGENT_ID)
			.req("worldId", WORLD_ID)
			.req("cause", string(1, 256))
			.opt("killer", string(1, 128))
			.req("day", POS_INT)
			.req("pos", BLOCK_POS)
			.req("dim", DIMENSION)
			.opt("grave", BLOCK_POS));

	public static final MessageType<AgentMode> AGENT_MODE = type("agent.mode", Direction.NODE_TO_MOD, AgentMode.class, object()
			.req("agentId", AGENT_ID)
			.req("mode", IDLE_MODE)
			.opt("anchor", BLOCK_POS));

	public static final MessageType<CrewState> CREW_STATE = type("crew.state", Direction.NODE_TO_MOD, CrewState.class, object()
			.req("crew", array(CREW_MEMBER, 0, 64)));

	/** Every type of this group, registered by {@code Messages}. */
	public static final List<MessageType<?>> TYPES =
			List.of(AGENT_SPAWN, AGENT_DESPAWN, AGENT_STATE, AGENT_EVENT, AGENT_DIED, AGENT_MODE, CREW_STATE);
}
