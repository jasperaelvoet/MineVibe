package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import org.jspecify.annotations.Nullable;

/**
 * Priority 80: attack a hostile that targets the player (or a fellow agent), or that is within 5 blocks
 * of them.
 */
final class ProtectReflex implements Reflex {
	private static final double ATTACKER_RADIUS = 12.0;
	private static final double CLOSE_RADIUS = 5.0;
	private static final double MAX_CHASE = 20.0;

	private @Nullable Mob target;

	@Override
	public int priority() {
		return 80;
	}

	@Override
	public boolean allowedWhileSeated() {
		return false;
	}

	@Override
	public String name() {
		return "protect";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.target != null && this.target.isAlive() && this.target.distanceTo(agent) < MAX_CHASE) {
			return true;
		}
		this.target = null;
		for (LivingEntity protectee : brain.protectees()) {
			Mob attacker = brain.threats().attackerOf(protectee, ATTACKER_RADIUS, CLOSE_RADIUS);
			if (attacker != null && attacker.distanceTo(agent) < MAX_CHASE) {
				this.target = attacker;
				return true;
			}
		}
		return false;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.target != null) {
			Combat.engage(agent, brain, this.target);
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.target = null;
		Combat.disengage(agent, brain);
	}
}
