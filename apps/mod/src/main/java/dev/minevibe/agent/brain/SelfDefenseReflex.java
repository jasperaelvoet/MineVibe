package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import org.jspecify.annotations.Nullable;

/** Priority 70: fight back against a hostile that targets the agent or hit it in the last 5 seconds. */
final class SelfDefenseReflex implements Reflex {
	private static final double RADIUS = 12.0;
	private static final int REVENGE_TICKS = 100;

	private @Nullable LivingEntity target;

	@Override
	public int priority() {
		return 70;
	}

	@Override
	public String name() {
		return "self_defense";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.target != null && this.target.isAlive() && this.target.distanceTo(agent) < RADIUS + 4) {
			if (this.target instanceof Mob mob && mob.getTarget() == agent || this.recentlyHurtBy(agent, this.target)) {
				return true;
			}
		}
		this.target = null;
		LivingEntity attacker = agent.getLastHurtByMob();
		if (attacker != null && attacker.isAlive() && attacker instanceof Enemy && !(attacker instanceof Creeper)
			&& this.recentlyHurtBy(agent, attacker) && attacker.distanceTo(agent) < RADIUS) {
			this.target = attacker;
			return true;
		}
		Mob m = brain.threats().attackerOf(agent, RADIUS, 0.0);
		if (m != null) {
			this.target = m;
			return true;
		}
		return false;
	}

	private boolean recentlyHurtBy(final AgentPlayer agent, final LivingEntity attacker) {
		return agent.getLastHurtByMob() == attacker && agent.tickCount - agent.getLastHurtByMobTimestamp() < REVENGE_TICKS;
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
