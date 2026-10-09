package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

/**
 * Priority 10, the default idle mode ("follow"): stay within 3 blocks of the player. Starts moving when
 * the player is more than 4 blocks away (hysteresis), and stops at 3.
 */
final class IdleFollowReflex implements Reflex {
	private static final int REPLAN_TICKS = 10;
	/** After a failed walk to the player, ticks before the next try. */
	private static final int FAILED_BACKOFF_TICKS = 40;
	private int lastReplan = -1000;
	private boolean following;

	@Override
	public int priority() {
		return 10;
	}

	@Override
	public String name() {
		return "follow";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (brain.mode() != IdleMode.FOLLOW) {
			this.following = false;
			return false;
		}
		ServerPlayer player = brain.followTarget();
		if (player == null || player.isSpectator()) {
			this.following = false;
			return false;
		}
		double dist = agent.distanceTo(player);
		double stopAt = brain.followDistance();
		this.following = this.following ? dist > stopAt : dist > stopAt + 1.0;
		return this.following;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		ServerPlayer player = brain.followTarget();
		if (player == null) {
			return;
		}
		Vec3 goal = agent.navigator().goal();
		boolean drifted = goal == null || goal.distanceTo(player.position()) > 2.0;
		if (agent.navigator().status() == AgentNavigator.Status.FAILED && agent.tickCount - this.lastReplan < FAILED_BACKOFF_TICKS) {
			// No way to the player right now: try again in a moment, not every tick (a walk that keeps failing from here is
			// a loop the navigator reports, and in water the WaterEscape reflex takes over).
			return;
		}
		if (!agent.navigator().isMoving() || drifted && agent.tickCount - this.lastReplan >= REPLAN_TICKS) {
			this.lastReplan = agent.tickCount;
			agent.navigator().moveTo(player.position(), brain.followDistance());
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.following = false;
		agent.navigator().stop();
	}
}
