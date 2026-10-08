package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import org.jspecify.annotations.Nullable;

/**
 * Per-tick reflex arbitration (PLAN 7.3). The highest-priority reflex that wants control runs; a reflex
 * above {@link #JOB_PRIORITY} preempts the current job, which resumes when the reflex lets go. When no
 * reflex above the job wants control and there is no job, the idle reflex (follow, priority 10) runs.
 *
 * <p>Implemented for S1: Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, ProtectPlayer 80,
 * SelfDefense 70, Eat 60, Job 35, IdleFollow 10.
 */
public final class ReflexBrain {
	public static final int JOB_PRIORITY = 35;

	private final AgentPlayer agent;
	private final List<Reflex> reflexes = new ArrayList<>();
	private final Threats threats = new Threats();
	private @Nullable Reflex active;
	private boolean enabled = true;
	private @Nullable UUID followTarget;
	private double followDistance = 3.0;

	// Shared combat state (replan throttling), used by Combat.
	int lastCombatReplanTick = -1000;
	@Nullable LivingEntity lastCombatTarget;

	public ReflexBrain(final AgentPlayer agent) {
		this.agent = agent;
		this.reflexes.add(new HazardReflex());
		this.reflexes.add(new CreeperBackoffReflex());
		this.reflexes.add(EatReflex.critical());
		this.reflexes.add(new FleeReflex());
		this.reflexes.add(new ProtectReflex());
		this.reflexes.add(new SelfDefenseReflex());
		this.reflexes.add(EatReflex.normal());
		this.reflexes.add(new IdleFollowReflex());
		this.reflexes.sort(Comparator.comparingInt(Reflex::priority).reversed());
	}

	public Threats threats() {
		return this.threats;
	}

	public @Nullable Reflex active() {
		return this.active;
	}

	public @Nullable String activeName() {
		return this.active == null ? (this.agent.jobs().hasJob() ? "job" : null) : this.active.name();
	}

	/** Reflexes can be switched off (GameTests that drive the body directly, or a "stay" mode). */
	public void setEnabled(final boolean enabled) {
		if (!enabled && this.active != null) {
			this.active.stop(this.agent, this);
			this.active = null;
		}
		this.enabled = enabled;
	}

	public boolean isEnabled() {
		return this.enabled;
	}

	/** The player this agent follows when idle and protects first. */
	public void setFollowTarget(final @Nullable UUID player) {
		this.followTarget = player;
	}

	public @Nullable UUID followTargetId() {
		return this.followTarget;
	}

	public double followDistance() {
		return this.followDistance;
	}

	public void setFollowDistance(final double distance) {
		this.followDistance = distance;
	}

	/** The follow target if it is online and in the agent's level. */
	public @Nullable ServerPlayer followTarget() {
		if (this.followTarget == null) {
			return null;
		}
		ServerPlayer player = this.agent.level().getServer().getPlayerList().getPlayer(this.followTarget);
		return player != null && player.isAlive() && player.level() == this.agent.level() ? player : null;
	}

	/** Who this agent protects: its follow target and nearby fellow agents. */
	public List<LivingEntity> protectees() {
		List<LivingEntity> out = new ArrayList<>(4);
		ServerPlayer player = this.followTarget();
		if (player != null && player.distanceToSqr(this.agent) < 24 * 24) {
			out.add(player);
		}
		for (ServerPlayer p : this.agent.level().players()) {
			if (p != this.agent && p instanceof AgentPlayer ally && ally.isAlive() && ally.distanceToSqr(this.agent) < 12 * 12) {
				out.add(ally);
			}
		}
		return out;
	}

	public void tick() {
		if (!this.enabled || !this.agent.isAlive()) {
			return;
		}
		this.threats.update(this.agent);
		boolean hasJob = this.agent.jobs().hasJob();
		Reflex chosen = null;
		for (Reflex reflex : this.reflexes) {
			if (hasJob && reflex.priority() <= JOB_PRIORITY) {
				break;
			}
			if (this.agent.isPassenger() && reflex.priority() < 45) {
				// Seated (at a PC or a meeting): only survival reflexes may stand the agent up.
				break;
			}
			if (reflex.wants(this.agent, this)) {
				chosen = reflex;
				break;
			}
		}
		if (chosen != this.active) {
			if (this.active != null) {
				this.active.stop(this.agent, this);
			}
			if (chosen != null) {
				if (chosen.priority() > JOB_PRIORITY) {
					this.agent.jobs().preempt();
				}
				if (chosen.needsToStand() && this.agent.isPassenger()) {
					this.agent.stopRiding();
				}
				chosen.start(this.agent, this);
				if (chosen.priority() >= 60) {
					AgentEvents.emit(this.agent, "reflex", Map.of("reflex", chosen.name(), "priority", Integer.toString(chosen.priority())));
				}
			}
			this.active = chosen;
		}
		if (this.active != null) {
			this.active.tick(this.agent, this);
		} else if (hasJob) {
			this.agent.jobs().tick();
		}
	}
}
