package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Navigation for skill jobs: keeps one goal on the {@link AgentNavigator}, re-issues it after a preemption (the
 * navigator is stopped then) or when a moving goal drifts, and reports arrival or failure.
 */
public final class Walk {
	public enum State {
		ARRIVED,
		MOVING,
		FAILED
	}

	/** Blocks a hand reaches, a little under vanilla's 4.5 so a goal at the edge still counts. */
	public static final double BLOCK_REACH = 4.0;

	private @Nullable Vec3 goal;
	private double reach;
	private @Nullable String failure;

	/** Walks toward {@code goal} until within {@code reach} blocks (horizontally, |dy| at most 1.5). */
	public State to(final AgentPlayer agent, final Vec3 goal, final double reach) {
		AgentNavigator nav = agent.navigator();
		boolean fresh = this.goal == null || Math.abs(reach - this.reach) > 1.0E-3;
		if (fresh || nav.status() == AgentNavigator.Status.IDLE) {
			this.goal = goal;
			this.reach = reach;
			nav.moveTo(goal, reach);
		} else if (this.goal.distanceTo(goal) > 1.0) {
			this.goal = goal;
			if (nav.status() == AgentNavigator.Status.ARRIVED) {
				nav.moveTo(goal, reach);
			} else {
				nav.updateGoal(goal, reach);
			}
		}
		return switch (nav.status()) {
			case ARRIVED -> State.ARRIVED;
			case FAILED -> {
				this.failure = nav.failureReason();
				this.goal = null;
				yield State.FAILED;
			}
			case MOVING, IDLE -> State.MOVING;
		};
	}

	/** Walks until the block at {@code pos} is within hand reach. */
	public State toBlock(final AgentPlayer agent, final BlockPos pos) {
		if (inReach(agent, pos)) {
			this.stop(agent);
			return State.ARRIVED;
		}
		State s = this.to(agent, Vec3.atBottomCenterOf(pos), 2.0);
		if (s == State.ARRIVED && !inReach(agent, pos)) {
			// Arrived as close as the path allows, but the block is still out of reach (e.g. high up).
			this.failure = "out_of_reach";
			this.goal = null;
			return State.FAILED;
		}
		return s;
	}

	/** Walks until {@code entity} is within {@code range} blocks. */
	public State toEntity(final AgentPlayer agent, final Entity entity, final double range) {
		if (agent.distanceTo(entity) <= range && Math.abs(entity.getY() - agent.getY()) <= 1.5) {
			this.stop(agent);
			return State.ARRIVED;
		}
		return this.to(agent, entity.position(), Math.max(0.5, range - 0.3));
	}

	public void stop(final AgentPlayer agent) {
		if (this.goal != null) {
			agent.navigator().stop();
		}
		this.goal = null;
	}

	/** Forget the goal so the next call re-plans (after a preemption). */
	public void reset() {
		this.goal = null;
	}

	public String failure() {
		return this.failure == null ? "no_path" : this.failure;
	}

	public static boolean inReach(final AgentPlayer agent, final BlockPos pos) {
		return agent.getEyePosition().distanceTo(Vec3.atCenterOf(pos)) <= BLOCK_REACH;
	}
}
