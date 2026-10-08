package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * Per-tick reflex arbitration (PLAN 7.3). The highest-priority reflex that wants control runs; a reflex
 * above {@link #JOB_PRIORITY} preempts the current job, which resumes when the reflex lets go. When no
 * reflex above the job wants control and there is no job, the idle mode runs (priority 10).
 *
 * <p>Priorities: Hazard 100, CreeperBackoff 95, CriticalHeal 90, Flee 85, ProtectPlayer 80, SelfDefense 70, Eat 60,
 * FeedPlayer 55, ShareFood 50, UnseatToSurvive 47, UnseatToFight 45, Approach 40, Attend 38, Job 35, Shelter 30,
 * Pickup 25, idle mode 10 (follow, stay, guard, wander).
 *
 * <p>While the agent sits (a PC or meeting chair, or any vehicle) only reflexes at 45 and above may run, and the ones
 * that would only protect others or fight back at good health ({@link Reflex#allowedWhileSeated}) wait: a seated agent
 * stands up to fight at priority 45, once its HP is below half.
 */
public final class ReflexBrain {
	public static final int JOB_PRIORITY = 35;
	/** Reflexes at or above this priority may run while the agent sits. */
	public static final int SEATED_PRIORITY = 45;

	/** {@code agent.approach} roles (PLAN 6.4). */
	public enum ApproachRole {
		PRESENT,
		QUEUE,
		PING,
		RELEASE
	}

	/** Where {@link AttendReflex} takes the agent: a scheduled task's location or a meeting table. */
	public record AttendTarget(ResourceKey<Level> dim, BlockPos pos, String kind, String label, int setTick) {
	}

	private final AgentPlayer agent;
	private final List<Reflex> reflexes = new ArrayList<>();
	private final Threats threats = new Threats();
	private @Nullable Reflex active;
	private boolean enabled = true;
	private @Nullable UUID followTarget;
	private double followDistance = 3.0;
	private IdleMode mode = IdleMode.FOLLOW;
	private @Nullable BlockPos anchor;
	private @Nullable BlockPos home;
	private ApproachRole approachRole = ApproachRole.RELEASE;
	private @Nullable String approachPendingId;
	private int approachSince;
	private @Nullable AttendTarget attend;
	private @Nullable String lastStandReason;
	private int lastStandTick = -1000;

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
		this.reflexes.add(new FeedPlayerReflex());
		this.reflexes.add(new ShareFoodReflex());
		this.reflexes.add(new UnseatToSurviveReflex());
		this.reflexes.add(new UnseatToFightReflex());
		this.reflexes.add(new ApproachReflex());
		this.reflexes.add(new AttendReflex());
		this.reflexes.add(new ShelterReflex());
		this.reflexes.add(new PickupReflex());
		this.reflexes.add(new IdleFollowReflex());
		this.reflexes.add(new IdleModeReflex());
		this.reflexes.sort(Comparator.comparingInt(Reflex::priority).reversed());
	}

	public AgentPlayer agent() {
		return this.agent;
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

	// ---------------------------------------------------------------- idle mode, home

	public IdleMode mode() {
		return this.mode;
	}

	/** The anchor of stay/guard/wander (null: where the agent stood when the mode was set). */
	public @Nullable BlockPos anchor() {
		return this.anchor;
	}

	public void setMode(final IdleMode mode, final @Nullable BlockPos anchor) {
		this.mode = mode;
		this.anchor = anchor != null ? anchor.immutable() : mode == IdleMode.FOLLOW ? null : this.agent.blockPosition();
	}

	/** Where the agent goes for the night (a bed or the office); null: no shelter reflex. */
	public @Nullable BlockPos home() {
		return this.home;
	}

	public void setHome(final @Nullable BlockPos home) {
		this.home = home == null ? null : home.immutable();
	}

	// ---------------------------------------------------------------- approach (PLAN 6.4)

	public ApproachRole approachRole() {
		return this.approachRole;
	}

	public @Nullable String approachPendingId() {
		return this.approachPendingId;
	}

	/** Ticks since the current approach role was set. */
	public int approachAge() {
		return this.agent.tickCount - this.approachSince;
	}

	public void setApproach(final ApproachRole role, final @Nullable String pendingId) {
		if (role != this.approachRole || !java.util.Objects.equals(pendingId, this.approachPendingId)) {
			this.approachSince = this.agent.tickCount;
		}
		this.approachRole = role;
		this.approachPendingId = role == ApproachRole.RELEASE ? null : pendingId;
	}

	// ---------------------------------------------------------------- attend

	public @Nullable AttendTarget attend() {
		return this.attend;
	}

	public void setAttend(final @Nullable AttendTarget target) {
		this.attend = target;
	}

	// ---------------------------------------------------------------- standing up

	/** Why the agent last left a seat on its own (a reflex), and when; read by the seat bookkeeping. */
	public @Nullable String lastStandReason(final int withinTicks) {
		return this.agent.tickCount - this.lastStandTick <= withinTicks ? this.lastStandReason : null;
	}

	/** Records why the agent is about to leave its seat (a reflex, or a kick by the PC registry). */
	public void noteStand(final String reason) {
		this.lastStandReason = reason;
		this.lastStandTick = this.agent.tickCount;
	}

	/** Hurt by a hostile within the last {@code ticks}. */
	public boolean hurtByHostileWithin(final int ticks) {
		LivingEntity attacker = this.agent.getLastHurtByMob();
		return attacker instanceof Enemy && this.agent.tickCount - this.agent.getLastHurtByMobTimestamp() < ticks;
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
		boolean seated = this.agent.isPassenger();
		Reflex chosen = null;
		for (Reflex reflex : this.reflexes) {
			if (hasJob && reflex.priority() <= JOB_PRIORITY) {
				break;
			}
			if (seated && reflex.priority() < SEATED_PRIORITY) {
				// Seated (at a PC, a meeting or in a vehicle): only survival reflexes may stand the agent up.
				break;
			}
			if (seated && !reflex.allowedWhileSeated()) {
				continue;
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
					this.noteStand(chosen.unseatReason());
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
