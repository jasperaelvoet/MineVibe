package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Swimming, and climbing out of water, with player controls (PLAN 7.2 "Water"). Both tiers steer through here: Tier 1's
 * {@link PathExecutor} when a path node lies in water or is the bank after it, Tier 2's {@link DigPathExecutor} for its
 * {@link DigStep.Kind#SWIM} and {@link DigStep.Kind#EXIT_WATER} steps, and the WaterEscape reflex.
 *
 * <p>Vanilla's physics ({@code LivingEntity#travelInWater}, {@code #aiStep}), which this follows:
 * <ul>
 *   <li>Holding jump in water adds 0.04 upward a tick; with the water's drag the body rises at about 0.13 blocks a tick
 *       and then bobs with its feet just under the surface. A full jump only happens on the ground in water shallower
 *       than 0.4: swimming, there is none.</li>
 *   <li>Pushing against a bank while in water lifts the body 0.3 (about 0.7 blocks) once its box, 0.6 higher, would
 *       be free ({@code jumpOutOfFluid}). So a bank whose top is at most one block above the water's cell (level with
 *       the water line) is climbed out onto; a bank one block higher never is. Out of such water the agent needs a block
 *       placed in the water to step on, or a step dug from the bottom of water at most one deep
 *       ({@link DigPathPlanner}).</li>
 *   <li>Sprinting under water switches to the swimming pose, which follows the pitch and rams walls: agents never
 *       sprint in water.</li>
 *   <li>Flowing water pushes the body along its flow (0.014 a tick, about 0.07 blocks a tick of drift) against 0.1 for
 *       swimming: the agent aims upstream of its target so the drift cancels, and a current never carries it off its
 *       line.</li>
 * </ul>
 */
public final class WaterMoves {
	/** Swimming speed at full drift, blocks a tick (input 0.02 a tick against the water's drag of 0.8). */
	static final double SWIM_SPEED = 0.1;
	/** Drift a current gives a body at full flow, blocks a tick (0.014 a tick against the same drag). */
	static final double CURRENT_DRIFT = 0.07;
	/**
	 * Least height of the water in the swimmer's cell for climbing out onto a bank one above it: the feet bob up to the
	 * water's surface, and the lift needs them within about 0.7 of the bank's top.
	 */
	public static final double MIN_EXIT_WATER = 0.35;

	private WaterMoves() {
	}

	/** True if the block at {@code pos} holds water (a source, flowing water, a waterlogged plant). */
	public static boolean isWater(final BlockGetter level, final BlockPos pos) {
		return level.getFluidState(pos).is(FluidTags.WATER);
	}

	/**
	 * The water cell a swimming body is in: its feet cell, or the one under it while it bobs with its feet just above
	 * the surface. Not in water: the feet cell.
	 */
	public static BlockPos swimCell(final AgentPlayer agent) {
		BlockPos feet = agent.blockPosition();
		if (agent.isInWater() && !isWater(agent.level(), feet) && isWater(agent.level(), feet.below())) {
			return feet.below();
		}
		return feet;
	}

	/**
	 * True if the body swims: in water, or bobbing just over its surface (a swimmer holding jump leaves the water for a
	 * few ticks at a time, its feet within half a block over the water's cell).
	 */
	public static boolean swimming(final AgentPlayer agent) {
		if (agent.isInWater()) {
			return true;
		}
		return !agent.onGround() && isWater(agent.level(), BlockPos.containing(agent.getX(), agent.getY() - 0.5, agent.getZ()));
	}

	/** True if the body stands on the bottom of shallow water with its eyes above it: mining there is at full speed. */
	public static boolean standingInWater(final AgentPlayer agent) {
		return agent.isInWater() && agent.onGround() && !agent.isEyeInFluid(FluidTags.WATER);
	}

	/**
	 * One tick of swimming toward {@code target} (a feet cell's bottom centre): never sprinting, aiming upstream of a
	 * current, holding jump to rise to a target level with or above the feet (or to breathe), letting go to sink toward a
	 * lower one.
	 */
	public static void swim(final AgentPlayer agent, final Vec3 target) {
		AgentControls controls = agent.controls();
		controls.setSprinting(false);
		if (agent.isShiftKeyDown()) {
			controls.setSneaking(false);
		}
		double hd = horizontal(agent.position(), target);
		controls.look(controls.yawTo(upstreamAim(agent, target)), 0.0F);
		controls.setStrafe(0.0F);
		controls.setForward(hd > 0.15 ? hd < 0.5 ? 0.5F : 1.0F : 0.0F);
		boolean rise = target.y > agent.getY() - 0.4 || needsAir(agent);
		controls.setJumping(rise);
	}

	/**
	 * One tick of climbing out of water onto the feet cell {@code shore}, whose floor's top is at most one above the
	 * water's cell (or a block just placed in the water there): hold jump to rise to the surface and press against the
	 * bank, which lifts the body out once its feet are near the top. Also walks out of shallow water onto level ground.
	 */
	public static void exit(final AgentPlayer agent, final BlockPos shore) {
		AgentControls controls = agent.controls();
		controls.setSprinting(false);
		if (agent.isShiftKeyDown()) {
			controls.setSneaking(false);
		}
		Vec3 target = Vec3.atBottomCenterOf(shore);
		double hd = horizontal(agent.position(), target);
		controls.look(controls.yawTo(agent.isInWater() ? upstreamAim(agent, target) : target), 0.0F);
		controls.setStrafe(0.0F);
		controls.setForward(hd > 0.1 ? hd < 0.4 && !agent.isInWater() ? 0.5F : 1.0F : 0.0F);
		boolean below = agent.getY() < shore.getY() - 0.05;
		controls.setJumping(agent.isInWater() || below && agent.onGround() && hd < 1.5);
	}

	/** One tick of treading water: no way to go, the head kept above the surface (breathing). */
	public static void treadWater(final AgentPlayer agent) {
		AgentControls controls = agent.controls();
		controls.setSprinting(false);
		controls.setForward(0.0F);
		controls.setStrafe(0.0F);
		controls.setJumping(agent.isInWater());
	}

	/** True if the body is under water with less than half its air left: it rises whatever it swims to. */
	static boolean needsAir(final AgentPlayer agent) {
		return agent.isUnderWater() && agent.getAirSupply() < agent.getMaxAirSupply() / 2;
	}

	/**
	 * Where to look so that swimming toward it, plus the current's drift, heads straight for {@code target}: the swim
	 * vector's sideways part cancels the drift's (as far as swimming is faster), the rest goes forward. No current: the
	 * target itself.
	 */
	static Vec3 upstreamAim(final AgentPlayer agent, final Vec3 target) {
		Vec3 flow = currentAt(agent);
		double dx = target.x - agent.getX();
		double dz = target.z - agent.getZ();
		double len = Math.sqrt(dx * dx + dz * dz);
		if (flow.lengthSqr() < 1.0E-4 || len < 1.0E-3) {
			return target;
		}
		dx /= len;
		dz /= len;
		double driftX = flow.x * CURRENT_DRIFT;
		double driftZ = flow.z * CURRENT_DRIFT;
		double along = driftX * dx + driftZ * dz;
		double latX = driftX - along * dx;
		double latZ = driftZ - along * dz;
		double lat = Math.sqrt(latX * latX + latZ * latZ);
		double maxLat = SWIM_SPEED * 0.95;
		if (lat > maxLat) {
			latX *= maxLat / lat;
			latZ *= maxLat / lat;
			lat = maxLat;
		}
		double forward = Math.sqrt(SWIM_SPEED * SWIM_SPEED - lat * lat);
		double sx = dx * forward - latX;
		double sz = dz * forward - latZ;
		return new Vec3(agent.getX() + sx * 10.0, target.y, agent.getZ() + sz * 10.0);
	}

	/**
	 * The horizontal current on the body, as vanilla sums it ({@code EntityFluidInteraction}): the flow of every water
	 * cell its box touches (a cell shallower than 0.4 under the feet pushes less), averaged over those cells. About length
	 * 1 in a full current, zero in still water; the push is this times 0.014 a tick.
	 */
	static Vec3 currentAt(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		AABB box = agent.getBoundingBox().deflate(0.001);
		int x0 = Mth.floor(box.minX);
		int y0 = Mth.floor(box.minY);
		int z0 = Mth.floor(box.minZ);
		int x1 = Mth.ceil(box.maxX) - 1;
		int y1 = Mth.ceil(box.maxY) - 1;
		int z1 = Mth.ceil(box.maxZ) - 1;
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		double x = 0.0;
		double z = 0.0;
		double depth = 0.0;
		int n = 0;
		for (int bx = x0; bx <= x1; bx++) {
			for (int by = y0; by <= y1; by++) {
				for (int bz = z0; bz <= z1; bz++) {
					p.set(bx, by, bz);
					FluidState fluid = level.getFluidState(p);
					if (!fluid.is(FluidTags.WATER)) {
						continue;
					}
					double top = by + fluid.getHeight(level, p);
					if (top < box.minY) {
						continue;
					}
					depth = Math.max(depth, top - box.minY);
					Vec3 f = fluid.getFlow(level, p);
					double scale = depth < 0.4 ? depth : 1.0;
					x += f.x * scale;
					z += f.z * scale;
					n++;
				}
			}
		}
		return n == 0 ? Vec3.ZERO : new Vec3(x / n, 0.0, z / n);
	}

	static double horizontal(final Vec3 a, final Vec3 b) {
		double dx = a.x - b.x;
		double dz = a.z - b.z;
		return Math.sqrt(dx * dx + dz * dz);
	}
}
