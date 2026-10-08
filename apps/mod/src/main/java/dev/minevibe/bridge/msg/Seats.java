package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.JOB_ID;
import static dev.minevibe.bridge.msg.Types.MEETING_ID;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.OCCUPANT;
import static dev.minevibe.bridge.msg.Types.PC_ID;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** Seats group (PLAN §5, §6.3): agents sent to PC and meeting chairs, and PC chair occupancy. Mirrors {@code seats.ts}. */
public final class Seats {
	private Seats() {}

	/** {@code UnseatReason} values. */
	public static final List<String> UNSEAT_REASONS = List.of(
			"stand", "kick", "damage", "survival", "death", "pc_down", "meeting", "world_end", "dismiss", "app_restart",
			"worker_restart", "away", "player_took", "reservation_expired");

	// -----------------------------------------------------------------------------------------
	// Records
	// -----------------------------------------------------------------------------------------

	/** {@code kind} {@code pc} (with {@code pcId}) or {@code meeting} (with {@code meetingId}). */
	public record SeatTarget(String kind, @Nullable String pcId, @Nullable String meetingId) {
		public static final String PC = "pc";
		public static final String MEETING = "meeting";

		public static SeatTarget pc(String pcId) {
			return new SeatTarget(PC, pcId, null);
		}

		public static SeatTarget meeting(String meetingId) {
			return new SeatTarget(MEETING, null, meetingId);
		}
	}

	/** N→M request: reserve, walk, sit (a job). Reply: {@link AgentSeatResult}; outcome as {@code skill.result}. */
	public record AgentSeat(String agentId, String jobId, long seatEpoch, SeatTarget target, @Nullable String purpose) {}

	/** {@code status} is always {@code running}. */
	public record AgentSeatResult(String jobId, String status) {}

	/** N→M request. */
	public record AgentUnseat(String agentId, long seatEpoch, String reason, boolean keepReservation) {}

	/** M→N. */
	public record PcSeat(String pcId, Types.Occupant occupant, @Nullable Long seatEpoch) {}

	/** M→N. */
	public record PcUnseat(String pcId, Types.Occupant occupant, String reason, boolean reserved) {}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Node SEAT_TARGET = union(
			object().req("kind", literal(SeatTarget.PC)).req("pcId", PC_ID),
			object().req("kind", literal(SeatTarget.MEETING)).req("meetingId", MEETING_ID));

	static final Schema.Node UNSEAT_REASON = oneOf(UNSEAT_REASONS.toArray(String[]::new));

	public static final MessageType<AgentSeat> AGENT_SEAT = type("agent.seat", Direction.NODE_TO_MOD, AgentSeat.class, object()
			.req("agentId", AGENT_ID)
			.req("jobId", JOB_ID)
			.req("seatEpoch", NON_NEG_INT)
			.req("target", SEAT_TARGET)
			.opt("purpose", string(1, 200)));

	public static final MessageType<AgentUnseat> AGENT_UNSEAT = type("agent.unseat", Direction.NODE_TO_MOD, AgentUnseat.class, object()
			.req("agentId", AGENT_ID)
			.req("seatEpoch", NON_NEG_INT)
			.req("reason", UNSEAT_REASON)
			.req("keepReservation", bool()));

	public static final MessageType<PcSeat> PC_SEAT = type("pc.seat", Direction.MOD_TO_NODE, PcSeat.class, object()
			.req("pcId", PC_ID)
			.req("occupant", OCCUPANT)
			.opt("seatEpoch", NON_NEG_INT));

	public static final MessageType<PcUnseat> PC_UNSEAT = type("pc.unseat", Direction.MOD_TO_NODE, PcUnseat.class, object()
			.req("pcId", PC_ID)
			.req("occupant", OCCUPANT)
			.req("reason", UNSEAT_REASON)
			.req("reserved", bool()));

	public static final Schema.Obj AGENT_SEAT_RESULT = object().req("jobId", JOB_ID).req("status", literal("running"));

	public static final List<MessageType<?>> TYPES = List.of(AGENT_SEAT, AGENT_UNSEAT, PC_SEAT, PC_UNSEAT);
}
