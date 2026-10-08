package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Priority 100: get out of lava, fire, deep water when out of air, and blocks the agent is stuck in.
 * Steers directly (no A*) toward the nearest safe spot: dry standable ground away from fire and lava,
 * then water (within 6 blocks) to put out burning; when drowning, straight up to air. Burning on dry
 * land with no water nearby does not take control (the fire burns out; the agent can keep fighting).
 */
final class HazardReflex implements Reflex {
	private static final int RETARGET_TICKS = 20;
	private static final int SEARCH_RADIUS = 6;

	private @Nullable Vec3 target;
	private int retargetAt;
	private int lingerTicks;
	private int waterCheckAt;
	private boolean waterNearby;

	@Override
	public int priority() {
		return 100;
	}

	@Override
	public String name() {
		return "hazard";
	}

	/** Lava, fire or magma underfoot, drowning, or suffocating: always worth taking control for. */
	static boolean inAcuteHazard(final AgentPlayer agent) {
		if (agent.isInLava()) {
			return true;
		}
		if (agent.isUnderWater() && agent.getAirSupply() < agent.getMaxAirSupply() / 3) {
			return true;
		}
		ServerLevel level = agent.level();
		BlockState feet = level.getBlockState(agent.blockPosition());
		if (feet.is(BlockTags.FIRE) || feet.is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)) {
			return true;
		}
		return agent.isInWall();
	}

	private static boolean burning(final AgentPlayer agent) {
		return agent.isOnFire() && !agent.isInWater() && !agent.fireImmune();
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (inAcuteHazard(agent)) {
			this.lingerTicks = 10;
			return true;
		}
		if (burning(agent)) {
			// Burning on dry land: only worth control if water is close enough to put the fire out.
			if (agent.tickCount >= this.waterCheckAt) {
				this.waterCheckAt = agent.tickCount + RETARGET_TICKS;
				this.waterNearby = findWater(agent) != null;
			}
			if (this.waterNearby) {
				this.lingerTicks = 10;
				return true;
			}
		}
		// Keep control for a moment so the agent does not step straight back in.
		return this.lingerTicks-- > 0 && this.target != null;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
		this.target = null;
		this.retargetAt = 0;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		AgentControls controls = agent.controls();
		if (agent.isUsingItem()) {
			controls.releaseUse();
		}
		if (this.target == null || agent.tickCount >= this.retargetAt) {
			this.target = this.findRefuge(agent);
			this.retargetAt = agent.tickCount + RETARGET_TICKS;
		}
		boolean drowning = agent.isUnderWater() && agent.getAirSupply() < agent.getMaxAirSupply() / 3;
		boolean inFluid = agent.isInWater() || agent.isInLava();
		if (this.target == null) {
			// Nothing safe in sight: swim up / jump and keep moving forward.
			controls.look(agent.getYRot(), drowning ? -60.0F : 0.0F);
			controls.setForward(1.0F);
			controls.setJumping(true);
			return;
		}
		Vec3 pos = agent.position();
		double dx = this.target.x - pos.x;
		double dz = this.target.z - pos.z;
		double hd = Math.sqrt(dx * dx + dz * dz);
		controls.look(controls.yawTo(this.target), drowning ? -45.0F : 0.0F);
		controls.setForward(hd > 0.3 ? 1.0F : 0.0F);
		controls.setJumping(inFluid || drowning || agent.horizontalCollision || this.target.y > pos.y + 0.5);
		controls.setSprinting(!inFluid && hd > 1.5);
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.target = null;
		agent.controls().stopMovement();
	}

	@Override
	public boolean needsToStand() {
		return true;
	}

	private @Nullable Vec3 findRefuge(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos origin = agent.blockPosition();
		boolean burning = agent.isOnFire() || agent.isInLava();
		boolean drowning = agent.isUnderWater();

		if (drowning && !agent.isInLava()) {
			// Straight up to the first air pocket.
			BlockPos.MutableBlockPos p = origin.mutable();
			for (int dy = 1; dy <= 12; dy++) {
				p.setY(origin.getY() + dy);
				if (level.getFluidState(p).isEmpty() && level.getBlockState(p).getCollisionShape(level, p).isEmpty()) {
					return new Vec3(origin.getX() + 0.5, p.getY(), origin.getZ() + 0.5);
				}
				if (!level.getBlockState(p).getCollisionShape(level, p).isEmpty()) {
					break;
				}
			}
		}

		if (burning && !agent.isInLava()) {
			BlockPos water = findWater(agent);
			if (water != null) {
				return Vec3.atBottomCenterOf(water);
			}
		}
		BlockPos best = null;
		double bestScore = Double.MAX_VALUE;
		for (BlockPos p : BlockPos.betweenClosed(origin.offset(-SEARCH_RADIUS, -2, -SEARCH_RADIUS), origin.offset(SEARCH_RADIUS, 3, SEARCH_RADIUS))) {
			double d = p.distSqr(origin);
			if (d > SEARCH_RADIUS * SEARCH_RADIUS || d >= bestScore) {
				continue;
			}
			if (AgentNavigator.isStandable(level, p) && !nearHeat(level, p)) {
				bestScore = d;
				best = p.immutable();
			}
		}
		return best == null ? null : Vec3.atBottomCenterOf(best);
	}

	/** Nearest water block (to put out fire) within the search radius, or null. */
	private static @Nullable BlockPos findWater(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos origin = agent.blockPosition();
		BlockPos best = null;
		double bestDist = Double.MAX_VALUE;
		for (BlockPos p : BlockPos.betweenClosed(origin.offset(-SEARCH_RADIUS, -2, -SEARCH_RADIUS), origin.offset(SEARCH_RADIUS, 2, SEARCH_RADIUS))) {
			double d = p.distSqr(origin);
			if (d < bestDist && d <= SEARCH_RADIUS * SEARCH_RADIUS && level.getFluidState(p).is(FluidTags.WATER)) {
				bestDist = d;
				best = p.immutable();
			}
		}
		return best;
	}

	private static boolean nearHeat(final ServerLevel level, final BlockPos p) {
		for (BlockPos q : BlockPos.betweenClosed(p.offset(-1, -1, -1), p.offset(1, 1, 1))) {
			BlockState s = level.getBlockState(q);
			if (s.is(BlockTags.FIRE) || level.getFluidState(q).is(FluidTags.LAVA) || s.is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)) {
				return true;
			}
		}
		return false;
	}
}
