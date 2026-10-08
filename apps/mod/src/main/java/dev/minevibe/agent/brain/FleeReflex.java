package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Priority 85: at low HP with a hostile within 10 blocks, run 12+ blocks away from it. If the player is
 * also low, the agent stands and fights instead (the combat reflexes below take over).
 */
final class FleeReflex implements Reflex {
	private static final float LOW_HEALTH = 6.0F;
	private static final double DANGER_RADIUS = 10.0;
	private static final double SAFE_RADIUS = 16.0;
	private static final int REPLAN_TICKS = 20;

	private @Nullable Mob threat;
	private int replanAt;

	@Override
	public int priority() {
		return 85;
	}

	@Override
	public String name() {
		return "flee";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (agent.getHealth() > LOW_HEALTH) {
			return false;
		}
		ServerPlayer player = brain.followTarget();
		if (player != null && player.getHealth() <= LOW_HEALTH && player.distanceTo(agent) < 16.0) {
			return false;
		}
		boolean fleeing = this.threat != null && this.threat.isAlive() && this.threat.distanceTo(agent) < SAFE_RADIUS;
		if (fleeing) {
			return true;
		}
		this.threat = brain.threats().nearest(agent, DANGER_RADIUS);
		return this.threat != null;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		this.replanAt = 0;
		if (agent.isUsingItem()) {
			agent.controls().releaseUse();
		}
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.threat == null) {
			return;
		}
		if (agent.tickCount >= this.replanAt || !agent.navigator().isMoving()) {
			this.replanAt = agent.tickCount + REPLAN_TICKS;
			Vec3 away = agent.position().subtract(this.threat.position()).multiply(1.0, 0.0, 1.0);
			if (away.lengthSqr() < 1.0E-4) {
				away = new Vec3(1.0, 0.0, 0.0);
			}
			Vec3 goal = agent.position().add(away.normalize().scale(12.0));
			agent.navigator().moveTo(goal, 2.0);
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.threat = null;
		agent.navigator().stop();
	}
}
