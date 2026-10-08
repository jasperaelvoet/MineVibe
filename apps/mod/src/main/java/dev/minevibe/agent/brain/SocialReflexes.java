package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.job.Tossed;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.skill.BodyEvents;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.world.seat.SeatEntity;
import dev.minevibe.world.seat.SeatKind;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Shared navigation helper for the reflexes below: move toward a goal, re-planning when it drifts. */
final class Goals {
	private Goals() {
	}

	static void walk(final AgentPlayer agent, final Vec3 goal, final double reach) {
		AgentNavigator nav = agent.navigator();
		Vec3 current = nav.goal();
		boolean sameGoal = current != null && current.distanceTo(goal) <= 1.5;
		if (!sameGoal || nav.status() == AgentNavigator.Status.IDLE) {
			nav.moveTo(goal, reach);
		} else if (nav.status() == AgentNavigator.Status.FAILED && agent.tickCount % 40 == 0) {
			// Re-plan a failed walk now and then (the way may have opened), never every tick.
			nav.moveTo(goal, reach);
		}
	}

	static boolean nightOutside(final ServerLevel level, final BlockPos pos) {
		return level.isDarkOutside() && level.canSeeSky(pos.above()) && level.getBrightness(LightLayer.BLOCK, pos) < 8;
	}
}

/**
 * Priority 40: the agent is the ApproachQueue's presenter ({@code agent.approach{role: present}}): walk to 2.5 blocks of
 * the player, face them, wave and chime once, then stay. A queued agent ({@code role: queue}) waits 5-7 blocks behind
 * the player. Held in combat; yields to a meeting. When the player cannot be reached the agent reports
 * {@code approach_blocked{why}} once and stays put, so Node falls back to a ping (PLAN 6.4).
 */
final class ApproachReflex implements Reflex {
	private boolean arrived;
	private @Nullable String blockedWhy;
	private ReflexBrain.@Nullable ApproachRole lastRole;
	private @Nullable String lastPending;

	@Override
	public int priority() {
		return 40;
	}

	@Override
	public String name() {
		return "approach";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		ReflexBrain.ApproachRole role = brain.approachRole();
		if (role != this.lastRole || !java.util.Objects.equals(this.lastPending, brain.approachPendingId())) {
			this.lastRole = role;
			this.lastPending = brain.approachPendingId();
			this.arrived = false;
			this.blockedWhy = null;
		}
		if (role != ReflexBrain.ApproachRole.PRESENT && role != ReflexBrain.ApproachRole.QUEUE) {
			return false;
		}
		ReflexBrain.AttendTarget attend = brain.attend();
		if (attend != null && "meeting".equals(attend.kind())) {
			return false;
		}
		ServerPlayer player = Refs.player(agent);
		if (player == null) {
			player = brain.followTarget();
		}
		String why = blocked(agent, brain, player);
		if (why != null) {
			if (!why.equals(this.blockedWhy)) {
				this.blockedWhy = why;
				Map<String, Object> data = new LinkedHashMap<>();
				data.put("why", why);
				if (brain.approachPendingId() != null) {
					data.put("pendingId", brain.approachPendingId());
				}
				BodyEvents.emit(agent, "approach_blocked", BodyEvents.NOTABLE, "cannot walk over to the player (" + why + ")", data, 0);
			}
			return false;
		}
		this.blockedWhy = null;
		return true;
	}

	/** Why the agent should ping instead of walking, or null. */
	static @Nullable String blocked(final AgentPlayer agent, final ReflexBrain brain, final @Nullable ServerPlayer player) {
		if (player == null) {
			return "dimension";
		}
		if (player.level() != agent.level()) {
			return "dimension";
		}
		if (player.distanceTo(agent) > 48.0) {
			return "far";
		}
		if (brain.hurtByHostileWithin(160) || brain.threats().nearest(player, 12.0) != null
			|| player.getLastHurtByMob() instanceof Enemy && player.tickCount - player.getLastHurtByMobTimestamp() < 160) {
			return "combat";
		}
		if (player.getVehicle() instanceof SeatEntity seat && seat.kind() == SeatKind.PC) {
			return "pc_screen";
		}
		if (Goals.nightOutside(agent.level(), player.blockPosition())) {
			return "night";
		}
		return null;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		ServerPlayer player = Refs.player(agent);
		if (player == null) {
			return;
		}
		if (brain.approachRole() == ReflexBrain.ApproachRole.QUEUE) {
			Vec3 spot = queueSpot(agent, player);
			if (agent.position().distanceTo(spot) > 1.5) {
				Goals.walk(agent, spot, 1.0);
			} else {
				agent.navigator().stop();
				agent.controls().lookAt(player);
			}
			return;
		}
		double dist = agent.distanceTo(player);
		if (dist > 3.2) {
			Goals.walk(agent, player.position(), 2.5);
			return;
		}
		agent.navigator().stop();
		agent.controls().lookAt(player);
		if (!this.arrived) {
			this.arrived = true;
			agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
			agent.level().playSound(null, agent.blockPosition(), SoundEvents.NOTE_BLOCK_BELL.value(), SoundSource.NEUTRAL, 0.8F, 1.4F);
			Map<String, Object> data = new LinkedHashMap<>();
			data.put("for", "approach");
			if (brain.approachPendingId() != null) {
				data.put("pendingId", brain.approachPendingId());
			}
			BodyEvents.emit(agent, "arrived", BodyEvents.INFO, "standing with the player", data, 0);
		}
	}

	/** 6 blocks behind the player, spread sideways by agent so a queue forms an arc. */
	static Vec3 queueSpot(final AgentPlayer agent, final ServerPlayer player) {
		Vec3 look = player.getLookAngle().multiply(1.0, 0.0, 1.0);
		if (look.lengthSqr() < 1.0E-4) {
			look = new Vec3(0.0, 0.0, 1.0);
		}
		look = look.normalize();
		Vec3 side = new Vec3(-look.z, 0.0, look.x);
		int slot = Math.floorMod(agent.agentId().hashCode(), 5) - 2;
		return player.position().subtract(look.scale(6.0)).add(side.scale(slot * 1.5));
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
	}
}

/**
 * Priority 40, from the chair (USER DECISION 2026-10-08): the presenter sits at a PC and the player is near
 * ({@code agent.approach{role: present_seated}}). It stays in its chair: it turns its head and body toward the player
 * and chimes once (the client shows the card-mode bubble), and never dismounts. When the role ends it faces its monitor
 * again. A seated presenter whose player is not near is unseated by Node first ({@code agent.unseat{away}}) and then
 * walks over with {@link ApproachReflex}.
 */
final class SeatedPresentReflex implements Reflex {
	private boolean chimed;
	private @Nullable String lastPending;

	@Override
	public int priority() {
		return 40;
	}

	@Override
	public String name() {
		return "present_seated";
	}

	@Override
	public boolean needsToStand() {
		return false;
	}

	@Override
	public boolean staysSeated() {
		return true;
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (brain.approachRole() != ReflexBrain.ApproachRole.PRESENT_SEATED) {
			this.chimed = false;
			this.lastPending = null;
			return false;
		}
		if (!java.util.Objects.equals(this.lastPending, brain.approachPendingId())) {
			this.lastPending = brain.approachPendingId();
			this.chimed = false;
		}
		if (!(agent.getVehicle() instanceof SeatEntity)) {
			return false;
		}
		ServerPlayer player = Refs.player(agent);
		return player != null && player.level() == agent.level();
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		ServerPlayer player = Refs.player(agent);
		if (player == null) {
			return;
		}
		face(agent, player.getEyePosition());
		if (!this.chimed) {
			this.chimed = true;
			agent.level().playSound(null, agent.blockPosition(), SoundEvents.NOTE_BLOCK_BELL.value(), SoundSource.NEUTRAL, 0.8F, 1.4F);
			Map<String, Object> data = new LinkedHashMap<>();
			data.put("for", "approach");
			data.put("from", "seat");
			if (brain.approachPendingId() != null) {
				data.put("pendingId", brain.approachPendingId());
			}
			BodyEvents.emit(agent, "arrived", BodyEvents.INFO, "asking the player from the chair", data, 0);
		}
	}

	/** Head, look and body toward {@code target}, from the chair (a passenger's rotation is free on a seat). */
	static void face(final AgentPlayer agent, final Vec3 target) {
		agent.controls().lookAt(target);
		agent.setYBodyRot(agent.getYRot());
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.controls().releaseAll();
		if (agent.getVehicle() instanceof SeatEntity seat) {
			// Back to the monitor: the seat faces the way its chair does.
			agent.setYRot(seat.getYRot());
			agent.setYHeadRot(seat.getYRot());
			agent.setYBodyRot(seat.getYRot());
			agent.setXRot(0.0F);
		}
	}
}

/**
 * Priority 38: go to a scheduled task's location or the meeting table once the brain accepted it (set from
 * {@code calendar.fired{walk}}). Reports {@code arrived} and lets go; gives up after 5 minutes.
 */
final class AttendReflex implements Reflex {
	private static final int GIVE_UP_TICKS = 5 * 60 * 20;

	@Override
	public int priority() {
		return 38;
	}

	@Override
	public String name() {
		return "attend";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		ReflexBrain.AttendTarget t = brain.attend();
		if (t == null) {
			return false;
		}
		if (t.dim() != agent.level().dimension() || agent.tickCount - t.setTick() > GIVE_UP_TICKS) {
			brain.setAttend(null);
			BodyEvents.emit(agent, "stuck", BodyEvents.NOTABLE, "could not get to " + t.label(), Map.of("for", t.kind()), 0);
			return false;
		}
		if (agent.position().distanceTo(Vec3.atBottomCenterOf(t.pos())) <= 2.5) {
			brain.setAttend(null);
			agent.navigator().stop();
			BodyEvents.emit(agent, "arrived", BodyEvents.INFO, "arrived at " + t.label(), Map.of("for", t.kind(), "pos", t.pos()), 0);
			return false;
		}
		if (agent.navigator().status() == AgentNavigator.Status.FAILED && brain.active() == this) {
			brain.setAttend(null);
			BodyEvents.emit(agent, "stuck", BodyEvents.NOTABLE, "no path to " + t.label(), Map.of("for", t.kind()), 0);
			return false;
		}
		return true;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		ReflexBrain.AttendTarget t = brain.attend();
		if (t != null) {
			Goals.walk(agent, Vec3.atBottomCenterOf(t.pos()), 2.0);
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
	}
}

/** Priority 30: at dusk an idle agent outdoors (not following the player) walks home (its bed or the office). */
final class ShelterReflex implements Reflex {
	private int retryAt;

	@Override
	public int priority() {
		return 30;
	}

	@Override
	public String name() {
		return "shelter";
	}

	static boolean dusk(final ServerLevel level) {
		long t = Math.floorMod(level.getOverworldClockTime(), 24000L);
		return t >= 12000L && t <= 23500L;
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		BlockPos home = brain.home();
		// The home (office door, bed) is an overworld position, and dusk is the overworld's.
		if (home == null || agent.tickCount < this.retryAt || agent.level().dimension() != net.minecraft.world.level.Level.OVERWORLD || !dusk(agent.level())) {
			return false;
		}
		if (brain.mode() == IdleMode.FOLLOW && brain.followTarget() != null) {
			return false;
		}
		double d = agent.position().distanceTo(Vec3.atBottomCenterOf(home));
		if (d <= 3.0) {
			return false;
		}
		if (brain.active() == this && agent.navigator().status() == AgentNavigator.Status.FAILED) {
			this.retryAt = agent.tickCount + 1200;
			BodyEvents.emit(agent, "stuck", BodyEvents.NOTABLE, "cannot get home for the night", Map.of("home", home), 1200);
			return false;
		}
		return true;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		BlockPos home = brain.home();
		if (home != null) {
			Goals.walk(agent, Vec3.atBottomCenterOf(home), 2.0);
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
	}
}

/** Priority 25: an idle agent picks up loose items lying within 6 blocks in plain sight (not items thrown to others). */
final class PickupReflex implements Reflex {
	private static final double RADIUS = 6.0;
	private final Map<ItemEntity, Integer> ignoreUntil = new HashMap<>();
	private @Nullable ItemEntity target;
	private @Nullable ItemStack targetStack;
	private int targetSince;

	@Override
	public int priority() {
		return 25;
	}

	@Override
	public String name() {
		return "pickup";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.target != null && !this.target.isAlive()) {
			if (this.targetStack != null && agent.distanceTo(this.target) < 2.5) {
				BodyEvents.emit(agent, "picked_up", BodyEvents.INFO, "picked up " + this.targetStack.getCount() + " " + Refs.itemId(this.targetStack).replace("minecraft:", ""),
					Map.of("item", Refs.itemId(this.targetStack), "count", this.targetStack.getCount()), 100);
			}
			this.target = null;
		}
		if (this.target != null) {
			if (agent.tickCount - this.targetSince > 100) {
				this.ignoreUntil.put(this.target, agent.tickCount + 600);
				this.target = null;
				return false;
			}
			return true;
		}
		if (agent.tickCount % 10 != 0) {
			return false;
		}
		this.ignoreUntil.entrySet().removeIf(e -> e.getValue() < agent.tickCount || !e.getKey().isAlive());
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(RADIUS, 2.0, RADIUS),
			e -> e.isAlive() && e.getAge() >= 20 && !this.ignoreUntil.containsKey(e) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem())
				&& agent.hasLineOfSight(e));
		ItemEntity best = items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
		if (best == null) {
			return false;
		}
		this.target = best;
		this.targetStack = best.getItem().copy();
		this.targetSince = agent.tickCount;
		return true;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.target != null && this.target.isAlive()) {
			this.targetStack = this.target.getItem().copy();
			Goals.walk(agent, this.target.position(), 0.5);
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
	}
}

/** Priority 10, idle modes other than follow: stay at the anchor, guard it, or wander around it. */
final class IdleModeReflex implements Reflex {
	private static final double GUARD_RADIUS = 12.0;
	private int nextWanderAt;
	private @Nullable Vec3 wanderGoal;
	private net.minecraft.world.entity.@Nullable Mob guardTarget;

	@Override
	public int priority() {
		return 10;
	}

	@Override
	public String name() {
		return "idle";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (brain.mode() == IdleMode.FOLLOW) {
			return false;
		}
		BlockPos anchor = brain.anchor() != null ? brain.anchor() : agent.blockPosition();
		Vec3 a = Vec3.atBottomCenterOf(anchor);
		switch (brain.mode()) {
			case STAY -> {
				return agent.position().distanceTo(a) > (brain.active() == this ? 1.0 : 2.0);
			}
			case GUARD -> {
				this.guardTarget = null;
				for (var m : brain.threats().hostiles()) {
					if (m.distanceToSqr(a) <= GUARD_RADIUS * GUARD_RADIUS && !(m instanceof net.minecraft.world.entity.monster.Creeper)) {
						this.guardTarget = m;
						break;
					}
				}
				return this.guardTarget != null || agent.position().distanceTo(a) > (brain.active() == this ? 2.0 : 6.0);
			}
			case WANDER -> {
				if (this.wanderGoal != null) {
					AgentNavigator.Status s = agent.navigator().status();
					if (s == AgentNavigator.Status.ARRIVED || s == AgentNavigator.Status.FAILED || agent.position().distanceTo(this.wanderGoal) < 1.2) {
						this.wanderGoal = null;
						this.nextWanderAt = agent.tickCount + 100 + agent.getRandom().nextInt(200);
						return false;
					}
					return true;
				}
				if (agent.tickCount < this.nextWanderAt) {
					return false;
				}
				this.wanderGoal = pickSpot(agent, anchor);
				if (this.wanderGoal == null) {
					this.nextWanderAt = agent.tickCount + 100;
					return false;
				}
				agent.navigator().moveTo(this.wanderGoal, 1.0);
				return true;
			}
			default -> {
				return false;
			}
		}
	}

	private static @Nullable Vec3 pickSpot(final AgentPlayer agent, final BlockPos anchor) {
		ServerLevel level = agent.level();
		for (int i = 0; i < 12; i++) {
			int dx = agent.getRandom().nextInt(21) - 10;
			int dz = agent.getRandom().nextInt(21) - 10;
			for (int dy = 2; dy >= -3; dy--) {
				BlockPos p = anchor.offset(dx, dy, dz);
				if (AgentNavigator.isStandable(level, p)) {
					return Vec3.atBottomCenterOf(p);
				}
			}
		}
		return null;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		BlockPos anchor = brain.anchor() != null ? brain.anchor() : agent.blockPosition();
		switch (brain.mode()) {
			case STAY -> Goals.walk(agent, Vec3.atBottomCenterOf(anchor), 0.8);
			case GUARD -> {
				if (this.guardTarget != null && this.guardTarget.isAlive()) {
					Combat.engage(agent, brain, this.guardTarget);
				} else {
					Goals.walk(agent, Vec3.atBottomCenterOf(anchor), 1.5);
				}
			}
			default -> {
			}
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.guardTarget = null;
		Combat.disengage(agent, brain);
	}
}
