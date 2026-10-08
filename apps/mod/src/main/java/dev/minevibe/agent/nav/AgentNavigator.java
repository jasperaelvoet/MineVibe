package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.pathfinder.Node;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.level.pathfinder.PathFinder;
import net.minecraft.world.level.pathfinder.WalkNodeEvaluator;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Tier-1 navigation (PLAN 7.2): vanilla {@link PathFinder} with a {@link WalkNodeEvaluator} (4000 nodes)
 * run against a never-added {@link NavProxyMob}, planned in waypoints of at most 40 blocks and followed by
 * {@link PathExecutor}.
 *
 * <p>Stuck ladder, one rung per {@value #STUCK_TICKS} ticks without progress: jump, replan, a visible
 * "poof" unstuck of at most 3 blocks, then a {@code nav.failed} event and {@link Status#FAILED}.
 */
public final class AgentNavigator {
	public enum Status {
		IDLE,
		MOVING,
		ARRIVED,
		FAILED
	}

	/** Emits nav.plan / nav.stuck events (noisy; for debugging and GameTests). */
	public static boolean debug = Boolean.getBoolean("minevibe.navDebug");

	public static final int MAX_VISITED_NODES = 4000;
	public static final int WAYPOINT_BLOCKS = 40;
	private static final float MAX_SEGMENT_PATH_LENGTH = 64.0F;
	private static final int STUCK_TICKS = 30;
	private static final int MAX_FRUITLESS_SEGMENTS = 4;

	private final AgentPlayer agent;
	private final WalkNodeEvaluator evaluator = new WalkNodeEvaluator();
	private final PathFinder pathFinder = new PathFinder(this.evaluator, MAX_VISITED_NODES);
	private final PathExecutor executor = new PathExecutor();
	private @Nullable NavProxyMob proxy;

	private Status status = Status.IDLE;
	private @Nullable Vec3 goal;
	private double reach = 1.0;
	private boolean finalSegment;
	private int finalApproachTicks;
	private int fruitlessSegments;
	private double bestGoalDistanceAtSegmentStart = Double.MAX_VALUE;

	// stuck detection
	private double bestProgress = Double.MAX_VALUE;
	private int ticksWithoutProgress;
	private int stuckRung;
	private int forcedJumpTicks;
	private @Nullable String failureReason;

	// stats (S1 numbers)
	private int plans;
	private long planNanosTotal;
	private long planNanosMax;
	private int poofs;

	public AgentNavigator(final AgentPlayer agent) {
		this.agent = agent;
		this.evaluator.setCanPassDoors(true);
		this.evaluator.setCanOpenDoors(true);
		this.evaluator.setCanFloat(true);
	}

	// ---------------------------------------------------------------- API

	/** Starts moving to {@code goal}; arrives when within {@code reach} blocks (horizontally, |dy| <= 1.5). */
	public void moveTo(final Vec3 goal, final double reach) {
		this.goal = goal;
		this.reach = Math.max(0.5, reach);
		this.status = Status.MOVING;
		this.failureReason = null;
		this.fruitlessSegments = 0;
		this.finalApproachTicks = 0;
		this.bestGoalDistanceAtSegmentStart = Double.MAX_VALUE;
		this.resetStuck();
		this.executor.setPath(null, this.agent);
		if (this.hasArrived()) {
			this.arrive();
		}
	}

	public void moveTo(final BlockPos goal, final double reach) {
		this.moveTo(Vec3.atBottomCenterOf(goal), reach);
	}

	/** Like {@link #moveTo} but keeps the current path when the goal only moved a little (following). */
	public void updateGoal(final Vec3 goal, final double reach) {
		if (this.status == Status.MOVING && this.goal != null && this.goal.distanceTo(goal) < 1.5) {
			this.goal = goal;
			this.reach = reach;
			return;
		}
		this.moveTo(goal, reach);
	}

	public void stop() {
		this.status = Status.IDLE;
		this.goal = null;
		this.executor.clear(this.agent);
		this.agent.controls().stopMovement();
	}

	public Status status() {
		return this.status;
	}

	public boolean isMoving() {
		return this.status == Status.MOVING;
	}

	public @Nullable Vec3 goal() {
		return this.goal;
	}

	public @Nullable String failureReason() {
		return this.failureReason;
	}

	public @Nullable Path currentPath() {
		return this.executor.path();
	}

	public int plans() {
		return this.plans;
	}

	public double avgPlanMillis() {
		return this.plans == 0 ? 0.0 : this.planNanosTotal / 1.0E6 / this.plans;
	}

	public double maxPlanMillis() {
		return this.planNanosMax / 1.0E6;
	}

	public int poofs() {
		return this.poofs;
	}

	// ---------------------------------------------------------------- tick

	public void tick() {
		this.executor.maintainDoors(this.agent);
		if (this.status != Status.MOVING || this.goal == null) {
			return;
		}
		if (this.hasArrived()) {
			this.arrive();
			return;
		}
		if (this.executor.isDone() || this.executor.isBlocked()) {
			if (this.finalSegment && !this.executor.isBlocked() && this.executor.path() != null && this.horizontalDistanceToGoal() <= this.reach + 1.5
				&& Math.abs(this.goal.y - this.agent.getY()) <= 1.5) {
				// The path ends next to the goal (A* stops within reach of the target block): walk the last bit straight.
				if (++this.finalApproachTicks > 40) {
					this.fail("unreachable");
					return;
				}
				if (!this.steerDirect(this.goal)) {
					this.fail("unsafe");
				}
				return;
			}
			if (!this.planSegment()) {
				return;
			}
		}
		this.executor.tick(this.agent);
		if (this.forcedJumpTicks > 0) {
			this.forcedJumpTicks--;
			this.agent.controls().setJumping(true);
		}
		this.checkStuck();
	}

	private boolean hasArrived() {
		return this.horizontalDistanceToGoal() <= this.reach && Math.abs(this.goal.y - this.agent.getY()) <= 1.5;
	}

	private double horizontalDistanceToGoal() {
		double dx = this.goal.x - this.agent.getX();
		double dz = this.goal.z - this.agent.getZ();
		return Math.sqrt(dx * dx + dz * dz);
	}

	/** Walks straight at {@code target}. Returns false (and stands still) if the step ahead is unsafe. */
	private boolean steerDirect(final Vec3 target) {
		var controls = this.agent.controls();
		float yaw = controls.yawTo(target);
		controls.look(yaw, 10.0F);
		controls.setStrafe(0.0F);
		controls.setSprinting(false);
		if (!Steering.safeAhead(this.agent, yaw)) {
			controls.stopMovement();
			return false;
		}
		controls.setForward(1.0F);
		controls.setJumping(this.agent.isInWater() || this.agent.onGround() && this.agent.horizontalCollision);
		return true;
	}

	private void arrive() {
		this.status = Status.ARRIVED;
		this.executor.clear(this.agent);
		this.agent.controls().stopMovement();
	}

	private void fail(final String reason) {
		this.status = Status.FAILED;
		this.failureReason = reason;
		this.executor.clear(this.agent);
		this.agent.controls().stopMovement();
		AgentEvents.emit(this.agent, "nav.failed", Map.of("reason", reason, "goal", this.goal == null ? "" : this.goal.toString()));
	}

	// ---------------------------------------------------------------- planning

	/** Plans the next waypoint segment. Returns false when navigation stopped. */
	private boolean planSegment() {
		Vec3 pos = this.agent.position();
		double goalDistance = pos.distanceTo(this.goal);
		if (goalDistance >= this.bestGoalDistanceAtSegmentStart - 0.5) {
			if (++this.fruitlessSegments > MAX_FRUITLESS_SEGMENTS) {
				this.fail("no_path");
				return false;
			}
		} else {
			this.fruitlessSegments = 0;
		}
		this.bestGoalDistanceAtSegmentStart = Math.min(this.bestGoalDistanceAtSegmentStart, goalDistance);

		BlockPos target;
		int reachRange;
		Vec3 flat = new Vec3(this.goal.x - pos.x, 0.0, this.goal.z - pos.z);
		if (flat.length() <= WAYPOINT_BLOCKS) {
			target = BlockPos.containing(this.goal);
			reachRange = Mth.floor(this.reach);
			this.finalSegment = true;
		} else {
			Vec3 step = flat.normalize().scale(WAYPOINT_BLOCKS);
			int x = Mth.floor(pos.x + step.x);
			int z = Mth.floor(pos.z + step.z);
			ServerLevel level = this.agent.level();
			int y = level.isLoaded(new BlockPos(x, 0, z))
				? level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z)
				: Mth.floor(pos.y + (this.goal.y - pos.y) * (WAYPOINT_BLOCKS / flat.length()));
			target = new BlockPos(x, y, z);
			reachRange = 2;
			this.finalSegment = false;
		}
		Path path = this.findPath(target, reachRange);
		if (path == null || path.getNodeCount() == 0) {
			this.fail("no_path");
			return false;
		}
		this.executor.setPath(path, this.agent);
		this.finalApproachTicks = 0;
		if (debug) {
			Node end = path.getEndNode();
			AgentEvents.emit(this.agent, "nav.plan", Map.of(
				"target", target.toShortString(),
				"nodes", Integer.toString(path.getNodeCount()),
				"reach", Boolean.toString(path.canReach()),
				"end", end == null ? "" : end.asBlockPos().toShortString(),
				"from", this.agent.blockPosition().toShortString(),
				"fruitless", Integer.toString(this.fruitlessSegments)
			));
		}
		// A new path restarts progress tracking; the stuck rung carries over so the ladder still escalates.
		this.bestProgress = Double.MAX_VALUE;
		this.ticksWithoutProgress = 0;
		if (this.executor.isDone()) {
			// The best we can do is where we stand.
			if (this.finalSegment && !path.canReach()) {
				this.fail("unreachable");
				return false;
			}
		}
		return true;
	}

	/** Runs vanilla A* with the proxy mob standing in for the agent. */
	public @Nullable Path findPath(final BlockPos target, final int reachRange) {
		long t0 = System.nanoTime();
		ServerLevel level = this.agent.level();
		if (this.proxy == null || this.proxy.level() != level) {
			this.proxy = new NavProxyMob(NavProxyMob.TYPE, level);
		}
		this.proxy.syncFrom(this.agent);
		BlockPos from = this.agent.blockPosition();
		int radius = (int)(MAX_SEGMENT_PATH_LENGTH + 8);
		PathNavigationRegion region = new PathNavigationRegion(level, from.offset(-radius, -radius, -radius), from.offset(radius, radius, radius));
		Path path = this.pathFinder.findPath(region, this.proxy, Set.of(target), MAX_SEGMENT_PATH_LENGTH, reachRange, 1.0F);
		long dt = System.nanoTime() - t0;
		this.plans++;
		this.planNanosTotal += dt;
		this.planNanosMax = Math.max(this.planNanosMax, dt);
		return path;
	}

	// ---------------------------------------------------------------- stuck ladder

	private void resetStuck() {
		this.bestProgress = Double.MAX_VALUE;
		this.ticksWithoutProgress = 0;
		this.stuckRung = 0;
		this.forcedJumpTicks = 0;
	}

	private void checkStuck() {
		if (this.status != Status.MOVING) {
			return;
		}
		double progress = this.executor.remainingDistance(this.agent.position());
		if (this.bestProgress == Double.MAX_VALUE) {
			// Fresh baseline (new path): measure from here, keep the current rung.
			this.bestProgress = progress;
			this.ticksWithoutProgress = 0;
			return;
		}
		if (progress < this.bestProgress - 0.15) {
			this.bestProgress = progress;
			this.ticksWithoutProgress = 0;
			this.stuckRung = 0;
			return;
		}
		if (++this.ticksWithoutProgress < STUCK_TICKS) {
			return;
		}
		this.ticksWithoutProgress = 0;
		this.stuckRung++;
		if (debug) {
			AgentEvents.emit(this.agent, "nav.stuck", Map.of("rung", Integer.toString(this.stuckRung), "at", this.agent.position().toString()));
		}
		switch (this.stuckRung) {
			case 1 -> this.forcedJumpTicks = 10;
			case 2 -> {
				this.bestProgress = Double.MAX_VALUE;
				this.executor.setPath(null, this.agent);
			}
			case 3 -> {
				this.bestProgress = Double.MAX_VALUE;
				if (!this.poofUnstuck()) {
					this.fail("stuck");
				} else {
					this.executor.setPath(null, this.agent);
				}
			}
			default -> this.fail("stuck");
		}
	}

	/**
	 * Teleports the agent at most 3 blocks along its path (or, failing that, to the free spot within 3 blocks
	 * that is closest to the goal) with a puff of smoke. The destination must be standable, free of
	 * colliding entities, and closer to the goal than where the agent is now.
	 */
	private boolean poofUnstuck() {
		ServerLevel level = this.agent.level();
		Vec3 from = this.agent.position();
		double fromGoal = from.distanceTo(this.goal);
		Vec3 dest = null;
		Path path = this.executor.path();
		if (path != null) {
			for (int i = path.getNodeCount() - 1; i >= this.executor.index(); i--) {
				Node n = path.getNode(i);
				Vec3 c = new Vec3(n.x + 0.5, n.y, n.z + 0.5);
				if (this.isPoofTarget(level, from, fromGoal, c, n.asBlockPos())) {
					dest = c;
					break;
				}
			}
		}
		if (dest == null) {
			double bestDist = Double.MAX_VALUE;
			BlockPos origin = this.agent.blockPosition();
			Vec3 eye = this.agent.getEyePosition();
			for (BlockPos p : BlockPos.betweenClosed(origin.offset(-3, -2, -3), origin.offset(3, 2, 3))) {
				Vec3 c = Vec3.atBottomCenterOf(p);
				double d = c.distanceTo(this.goal);
				// Off the path, only hop to places in plain sight (never through walls).
				if (d < bestDist && this.isPoofTarget(level, from, fromGoal, c, p) && this.inSight(level, eye, c.add(0.0, this.agent.getEyeHeight(), 0.0))) {
					bestDist = d;
					dest = c;
				}
			}
		}
		if (dest == null) {
			return false;
		}
		level.sendParticles(ParticleTypes.POOF, from.x, from.y + 0.8, from.z, 12, 0.3, 0.5, 0.3, 0.02);
		this.agent.teleportTo(dest.x, dest.y, dest.z);
		level.sendParticles(ParticleTypes.POOF, dest.x, dest.y + 0.8, dest.z, 12, 0.3, 0.5, 0.3, 0.02);
		this.poofs++;
		AgentEvents.emit(this.agent, "nav.poof", Map.of("from", from.toString(), "to", dest.toString()));
		return true;
	}

	private boolean inSight(final ServerLevel level, final Vec3 from, final Vec3 to) {
		return level.clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, this.agent)).getType() == HitResult.Type.MISS;
	}

	private boolean isPoofTarget(final ServerLevel level, final Vec3 from, final double fromGoal, final Vec3 c, final BlockPos feet) {
		double hop = c.distanceTo(from);
		if (hop > 3.0 || hop < 0.9 || c.distanceTo(this.goal) >= fromGoal - 0.5) {
			return false;
		}
		if (!isStandable(level, feet)) {
			return false;
		}
		// No mobs, minecarts or other colliding entities where we would land.
		return level.noCollision(this.agent, this.agent.getBoundingBox().move(c.subtract(from)));
	}

	/** Two blocks of non-colliding space above a block with a sturdy top. */
	public static boolean isStandable(final ServerLevel level, final BlockPos feet) {
		BlockPos below = feet.below();
		return level.getBlockState(below).isFaceSturdy(level, below, net.minecraft.core.Direction.UP)
			&& level.getBlockState(feet).getCollisionShape(level, feet).isEmpty()
			&& level.getBlockState(feet.above()).getCollisionShape(level, feet.above()).isEmpty()
			&& level.getFluidState(feet).isEmpty()
			&& level.getFluidState(feet.above()).isEmpty();
	}
}
