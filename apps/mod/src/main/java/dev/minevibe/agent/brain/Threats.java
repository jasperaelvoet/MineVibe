package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.NeutralMob;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/**
 * Hostile mobs around an agent, rescanned every {@value #SCAN_INTERVAL} ticks so reflex checks stay cheap.
 */
public final class Threats {
	public static final double SCAN_RADIUS = 16.0;
	private static final int SCAN_INTERVAL = 5;

	private final List<Mob> hostiles = new ArrayList<>();
	private int nextScan;

	public void update(final AgentPlayer agent) {
		if (agent.tickCount < this.nextScan) {
			this.hostiles.removeIf(m -> !m.isAlive() || m.isRemoved());
			return;
		}
		this.nextScan = agent.tickCount + SCAN_INTERVAL;
		this.hostiles.clear();
		this.hostiles.addAll(
			agent.level().getEntitiesOfClass(Mob.class, agent.getBoundingBox().inflate(SCAN_RADIUS), m -> m instanceof Enemy && m.isAlive() && !m.isRemoved())
		);
	}

	/** Forces a rescan on the next {@link #update}. */
	public void invalidate() {
		this.nextScan = 0;
	}

	public List<Mob> hostiles() {
		return this.hostiles;
	}

	public @Nullable Mob nearest(final LivingEntity to, final double maxDistance) {
		Mob best = null;
		double bestSq = maxDistance * maxDistance;
		for (Mob m : this.hostiles) {
			double d = m.distanceToSqr(to);
			if (d <= bestSq) {
				bestSq = d;
				best = m;
			}
		}
		return best;
	}

	/** A creeper within {@code radius} that is swelling (about to explode), nearest first. */
	public @Nullable Creeper swellingCreeper(final AgentPlayer agent, final double radius) {
		Creeper best = null;
		double bestSq = radius * radius;
		for (Mob m : this.hostiles) {
			if (m instanceof Creeper creeper && (creeper.getSwellDir() > 0 || creeper.getSwelling(1.0F) > 0.0F || creeper.isIgnited())) {
				double d = creeper.distanceToSqr(agent);
				if (d <= bestSq) {
					bestSq = d;
					best = creeper;
				}
			}
		}
		return best;
	}

	/** A hostile that is attacking {@code victim}: targeting it, or very close to it. */
	public @Nullable Mob attackerOf(final LivingEntity victim, final double maxDistance, final double closeDistance) {
		Mob best = null;
		double bestSq = maxDistance * maxDistance;
		for (Mob m : this.hostiles) {
			if (m instanceof Creeper) {
				continue;
			}
			double d = m.distanceToSqr(victim);
			boolean targeting = m.getTarget() == victim;
			if (!targeting && m instanceof NeutralMob && m.getTarget() == null) {
				// Endermen, zombified piglins...: only a threat once angry. Never provoke them.
				continue;
			}
			if ((targeting || d <= closeDistance * closeDistance) && d <= bestSq) {
				bestSq = d;
				best = m;
			}
		}
		return best;
	}

	/** True when a hostile within {@code radius} targets the agent (it is "in combat"). */
	public boolean inCombat(final Player agent, final double radius) {
		for (Mob m : this.hostiles) {
			if (m.getTarget() == agent && m.distanceToSqr(agent) <= radius * radius) {
				return true;
			}
		}
		return false;
	}
}
