package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.object;

import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import java.util.List;

/**
 * Debug additions (E2E only, mirrors {@code debug.ts}); the M1 debug requests live in {@code Messages}. The mod handles
 * them only with {@code -Dminevibe.e2e=true}, otherwise it answers {@code err NOT_HANDLED}.
 */
public final class Debug {
	private Debug() {}

	/** N→M request. Kills an agent body as {@code /kill} would; {@code err UNKNOWN_AGENT}. */
	public record DebugKillAgent(String agentId) {}

	/** N→M request. Sets the overworld clock. */
	public record DebugSetClock(long clockTime) {}

	public static final MessageType<DebugKillAgent> DEBUG_KILL_AGENT =
			type("debug.kill_agent", Direction.NODE_TO_MOD, DebugKillAgent.class, object().req("agentId", AGENT_ID));

	public static final MessageType<DebugSetClock> DEBUG_SET_CLOCK =
			type("debug.set_clock", Direction.NODE_TO_MOD, DebugSetClock.class, object().req("clockTime", NON_NEG_INT));

	public static final List<MessageType<?>> TYPES = List.of(DEBUG_KILL_AGENT, DEBUG_SET_CLOCK);
}
