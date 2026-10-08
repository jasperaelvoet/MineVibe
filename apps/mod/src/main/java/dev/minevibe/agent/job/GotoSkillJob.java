package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Places;
import dev.minevibe.agent.skill.Refs;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * {@code goto{pos | entity, range}}: walk to a block position, or to an entity ({@code player}, an agent, a UUID, the
 * nearest of an entity type) and keep tracking it while it moves. {@code entity} may also name a place: {@code office},
 * {@code home}, {@code spawn}, the nearest {@code bed} / {@code chest} / {@code crafting_table} / {@code furnace}, or
 * {@code pc:<id>} (see {@link Places}).
 */
public final class GotoSkillJob extends SkillJob {
	private final @Nullable BlockPos pos;
	private final @Nullable String entityRef;
	private final double range;
	private final Walk walk = new Walk();
	private @Nullable Entity entity;
	private @Nullable BlockPos place;
	private int resolveAt;

	public GotoSkillJob(final @Nullable BlockPos pos, final @Nullable String entityRef, final double range) {
		super("goto");
		this.pos = pos;
		this.entityRef = entityRef;
		this.range = Math.max(0.5, range);
	}

	@Override
	protected int timeoutTicks() {
		return 6 * MINUTE;
	}

	@Override
	public void start(final AgentPlayer agent) {
		this.walk.reset();
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.walk.reset();
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		if (this.pos == null && this.place == null && Places.isPlace(this.entityRef)) {
			this.place = Places.resolve(agent, this.entityRef);
			if (this.place == null) {
				return this.fail("NOT_FOUND", "no " + this.entityRef + " near " + agent.blockPosition().toShortString());
			}
			this.put("place", this.entityRef);
		}
		BlockPos target = this.pos != null ? this.pos : this.place;
		if (target != null) {
			Vec3 goal = Vec3.atBottomCenterOf(target);
			Walk.State s = this.walk.to(agent, goal, this.range);
			this.progress(null, String.format(Locale.ROOT, "%.0f blocks to go", agent.position().distanceTo(goal)));
			return switch (s) {
				case ARRIVED -> this.arrived(agent, goal);
				case FAILED -> this.fail("UNREACHABLE", "no path to " + target.toShortString() + " (" + this.walk.failure() + ")");
				case MOVING -> Status.RUNNING;
			};
		}
		if (this.entity == null || this.ticks >= this.resolveAt || !this.entity.isAlive()) {
			this.resolveAt = this.ticks + 20;
			Entity e = Refs.entity(agent, this.entityRef, 96.0);
			if (e == null || e.isRemoved()) {
				return this.fail("NOT_FOUND", "cannot find " + this.entityRef);
			}
			this.entity = e;
		}
		if (this.entity.level() != agent.level()) {
			return this.fail("OTHER_DIMENSION", this.entityRef + " is in " + this.entity.level().dimension().identifier());
		}
		Walk.State s = this.walk.toEntity(agent, this.entity, this.range);
		this.progress(null, String.format(Locale.ROOT, "%.0f blocks from %s", agent.distanceTo(this.entity), this.entityRef));
		return switch (s) {
			case ARRIVED -> this.arrived(agent, this.entity.position());
			case FAILED -> this.fail("UNREACHABLE", "no path to " + this.entityRef + " (" + this.walk.failure() + ")");
			case MOVING -> Status.RUNNING;
		};
	}

	private Status arrived(final AgentPlayer agent, final Vec3 goal) {
		agent.controls().lookAt(this.entity != null ? this.entity.getEyePosition() : goal.add(0.0, 1.0, 0.0));
		this.put("pos", agent.blockPosition());
		this.put("distance", Math.round(agent.position().distanceTo(goal) * 10.0) / 10.0);
		return this.done();
	}
}
