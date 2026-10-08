package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.DIMENSION;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.PC_ID;
import static dev.minevibe.bridge.msg.Types.VEC3;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.decimal;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.string;

import dev.minevibe.bridge.protocol.Schema;
import org.jspecify.annotations.Nullable;

/**
 * World group additions (mirrors {@code world.ts}). The M1 world and session records ({@code hello}, {@code world.*},
 * {@code player.died}) live in {@code Messages}; this holds what later milestones add to them.
 */
public final class World {
	private World() {}

	/**
	 * The local player in {@code world.state.player} (1 Hz pushes while ready): ApproachQueue, meetings, the calendar's
	 * AFK rule and the player-HP wake read it.
	 */
	public record PlayerState(
			Types.Vec3 pos,
			String dim,
			double hp,
			double maxHp,
			int food,
			boolean inCombat,
			long idleMs,
			@Nullable String screen,
			@Nullable String seatedPc) {}

	public static final Schema.Obj PLAYER_STATE = object()
			.req("pos", VEC3)
			.req("dim", DIMENSION)
			.req("hp", decimal(0, 1024))
			.req("maxHp", decimal(0, 1024))
			.req("food", integer(0, 20))
			.req("inCombat", bool())
			.req("idleMs", NON_NEG_INT)
			.opt("screen", string(1, 64))
			.opt("seatedPc", PC_ID);
}
