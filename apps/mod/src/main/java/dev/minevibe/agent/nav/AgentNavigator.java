package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import it.unimi.dsi.fastutil.longs.LongSet;
import java.util.List;
import java.util.Locale;
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
 * Agent navigation (PLAN 7.2), in two tiers.
 *
 * <p><b>Tier 1:</b> vanilla {@link PathFinder} with a {@link WalkNodeEvaluator} (4000 nodes) run against a never-added
 * {@link NavProxyMob}, planned in waypoints of at most 40 blocks and followed by {@link PathExecutor}. Stuck ladder,
 * one rung per {@value #STUCK_TICKS} ticks without progress: jump, replan, a visible "poof" unstuck of at most 3
 * blocks, then a {@code nav.failed} event and {@link Status#FAILED}.
 *
 * <p><b>Tier 2:</b> {@link DigPathPlanner}, an incremental A* (1.5 ms per tick, 20 000 nodes, 96 blocks) whose paths
 * may break natural blocks, pillar and bridge with scaffold, followed by {@link DigPathExecutor}. It runs when Tier 1
 * finds no way to a goal whose caller allows digging ({@link #moveTo(Vec3, double, boolean)},
 * {@link #approachBlock}), and straight away for "reach a block to mine" ({@link #reachBlock}) and "reach a tree trunk"
 * ({@link #reachTrunk}). A step that turns out unsafe or blocked re-plans (at most {@value #MAX_DIG_REPLANS} times).
 * Being stuck behind an entity (a Tier-1 "stuck") never falls back to digging.
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
	/** Tier 2 on or off ({@code -Dminevibe.nav.tier2=false}: Tier 1 only, as before navigation v2). */
	public static boolean tier2Enabled = !"false".equalsIgnoreCase(System.getProperty("minevibe.nav.tier2", "true"));

	public static final int MAX_VISITED_NODES = 4000;
	public static final int WAYPOINT_BLOCKS = 40;
	/** Eye-to-centre distance a Tier-2 "reach a block" path ends within (a little under the hands' 4.0). */
	public static final double PLAN_REACH = 3.75;
	private static final double BLOCK_REACH = 4.0;
	private static final float MAX_SEGMENT_PATH_LENGTH = 64.0F;
	private static final int STUCK_TICKS = 30;
	private static final int MAX_FRUITLESS_SEGMENTS = 4;
	private static final int MAX_DIG_REPLANS = 8;
	/** Ticks a "reach a block" arrival may spend stepping to the middle of its cell before it arrives anyway. */
	private static final int MAX_SETTLE_TICKS = 30;

	private final AgentPlayer agent;
	private final WalkNodeEvaluator evaluator = new WalkNodeEvaluator();
	private final PathFinder pathFinder = new PathFinder(this.evaluator, MAX_VISITED_NODES);
	private final PathExecutor executor = new PathExecutor();
	private @Nullable NavProxyMob proxy;

	private Status status = Status.IDLE;
	private @Nullable Vec3 goal;
	private double reach = 1.0;
	/** Tier 1 also arrives once this block is in hand reach ({@link #approachBlock}). */
	private @Nullable BlockPos reachTarget;

	// Tier 2
	private @Nullable DigGoal digFallback;
	/** The current walk may dig (kept when a moving goal is updated). */
	private boolean digAllowed;
	private @Nullable DigGoal digGoal;
	private @Nullable DigPathPlanner planner;
	private final NavDoors digDoors = new NavDoors();
	private final LongSet forbidden = new LongOpenHashSet();
	private final DigPathExecutor digExecutor = new DigPathExecutor(this.digDoors, this.forbidden);
	private int digReplans;
	private int digWaitTicks;
	/** "Reach a block": the goal cell the body steps to the middle of while its hands do not reach yet ({@link #settle}). */
	private @Nullable BlockPos settleCell;
	private int settleTicks;
	private @Nullable DigPath lastDigPath;
	private int digPlans;
	private int digNodes;
	private long digNanosTotal;
	private long digTickNanosMax;
	private int digPlanTicks;
	private int digTicksOverBudget;
	private final long[] digTickSamples = new long[256];
	private int digTickSampleNext;
	/** One node expansion past the deadline is the most a tick may overrun (timer resolution included). */
	private static final long OVER_BUDGET_SLACK_NANOS = 200_000L;

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

	/**
	 * Starts moving to {@code goal}; arrives when within {@code reach} blocks (horizontally, |dy| <= 1.5). Tier 1 only:
	 * reflexes (following, fleeing, fighting) never dig.
	 */
	public void moveTo(final Vec3 goal, final double reach) {
		this.moveTo(goal, reach, false);
	}

	/**
	 * Like {@link #moveTo(Vec3, double)}; with {@code dig}, a goal Tier 1 cannot reach is tried again with Tier 2
	 * (breaking natural blocks, pillars, bridges).
	 */
	public void moveTo(final Vec3 goal, final double reach, final boolean dig) {
		// Tier 2 tests cells: a cell next to the point is near enough (a body picks items up from there too).
		this.startTier1(goal, reach, null, dig && tier2Enabled ? DigGoal.near(goal, Math.max(1.0, reach)) : null);
	}

	public void moveTo(final BlockPos goal, final double reach) {
		this.moveTo(Vec3.atBottomCenterOf(goal), reach);
	}

	/**
	 * Walks to pick up an item lying at {@code item}: Tier 1 to it; if that finds no way (a drop caught in the leaves of a
	 * tree, on a ledge), Tier 2 to anywhere the pickup box reaches it from.
	 */
	public void moveToItem(final Vec3 item) {
		this.startTier1(item, 0.5, null, tier2Enabled ? DigGoal.pickup(item) : null);
	}

	/**
	 * Walks until {@code block} is in hand reach (to use it, or place next to it): Tier 1 toward it first, Tier 2 if that
	 * finds no way.
	 */
	public void approachBlock(final BlockPos block) {
		this.startTier1(Vec3.atBottomCenterOf(block), 2.0, block.immutable(), tier2Enabled ? DigGoal.block(block, PLAN_REACH) : null);
	}

	/**
	 * "Reach a block to mine": Tier 2 straight away, to a spot with {@code block} in hand reach and one face open toward
	 * the eyes (beside it, above it or below it; never standing on it). Without Tier 2, as {@link #approachBlock}.
	 */
	public void reachBlock(final BlockPos block) {
		if (!tier2Enabled) {
			this.approachBlock(block);
			return;
		}
		this.startTier2(DigGoal.block(block, PLAN_REACH), "mine");
	}

	/** "Reach a tree trunk": Tier 2 to any cell next to the trunk {@code log} belongs to, at any height a pillar reaches. */
	public void reachTrunk(final BlockPos log) {
		DigGoal trunk = DigGoal.trunk(this.agent.level(), log);
		if (!tier2Enabled) {
			this.startTier1(Vec3.atBottomCenterOf(trunk.anchor()), 1.8, null, null);
			return;
		}
		this.startTier2(trunk, "trunk");
	}

	/** Tier 2 to any {@link DigGoal}. */
	public void moveTo(final DigGoal goal) {
		this.startTier2(goal, "goal");
	}

	/** Like {@link #moveTo} but keeps the current path when the goal only moved a little (following). */
	public void updateGoal(final Vec3 goal, final double reach) {
		if (this.status == Status.MOVING && this.goal != null && this.goal.distanceTo(goal) < 1.5 && this.digGoal == null) {
			this.goal = goal;
			this.reach = reach;
			return;
		}
		this.moveTo(goal, reach, this.digAllowed);
	}

	public void stop() {
		this.status = Status.IDLE;
		this.goal = null;
		this.executor.clear(this.agent);
		this.endTier2();
		this.agent.controls().stopMovement();
	}

	private void startTier1(final Vec3 goal, final double reach, final @Nullable BlockPos reachTarget, final @Nullable DigGoal fallback) {
		this.endTier2();
		this.goal = goal;
		this.reach = Math.max(0.5, reach);
		this.reachTarget = reachTarget;
		this.digFallback = fallback;
		this.digAllowed = fallback != null;
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

	private void startTier2(final DigGoal goal, final String why) {
		this.executor.clear(this.agent);
		this.endTier2();
		this.digGoal = goal;
		this.digFallback = null;
		this.digAllowed = true;
		this.reachTarget = null;
		this.goal = Vec3.atBottomCenterOf(goal.anchor());
		this.reach = 1.0;
		this.status = Status.MOVING;
		this.failureReason = null;
		this.digReplans = 0;
		this.digWaitTicks = 0;
		this.forbidden.clear();
		if (NavDebug.ENABLED) {
			// Every mine target starts one: worth a line only when diagnosing (failures are always logged).
			NavDebug.log(this.agent.agentId(), "tier2", "why", why, "goal", goal.describe(), "from", this.agent.blockPosition().toShortString());
		}
		if (this.digArrived()) {
			this.arrive();
		}
	}

	private void endTier2() {
		if (this.planner != null || this.digExecutor.hasPath()) {
			this.digExecutor.clear(this.agent);
		}
		this.planner = null;
		this.digGoal = null;
		this.settleCell = null;
	}

	/** True while Tier 2 (dig planner) drives the agent. */
	public boolean isTier2() {
		return this.digGoal != null;
	}

	/** The last path Tier 2 found (tests, logs). */
	public @Nullable DigPath lastDigPath() {
		return this.lastDigPath;
	}

	/** Tier-2 searches started. */
	public int digPlans() {
		return this.digPlans;
	}

	/** Nodes all Tier-2 searches expanded. */
	public int digNodes() {
		return this.digNodes;
	}

	/** The longest time a Tier-2 search took in one tick (the budget is 1.5 ms). */
	public double digMaxTickMillis() {
		return this.digTickNanosMax / 1.0E6;
	}

	/** Average time per tick a Tier-2 search ran in. */
	public double digAvgTickMillis() {
		return this.digPlanTicks == 0 ? 0.0 : this.digNanosTotal / 1.0E6 / this.digPlanTicks;
	}

	/** Ticks Tier-2 searches ran in. */
	public int digPlanTicks() {
		return this.digPlanTicks;
	}

	/** Ticks in which a Tier-2 search ran more than 0.2 ms past its 1.5 ms budget (a GC pause, or a slow node). */
	public int digTicksOverBudget() {
		return this.digTicksOverBudget;
	}

	/** The time (ms) Tier-2 searches took in each of the last 256 ticks they ran in, oldest first. */
	public double[] digTickMillis() {
		int n = Math.min(this.digTickSampleNext, this.digTickSamples.length);
		double[] out = new double[n];
		int first = this.digTickSampleNext - n;
		for (int i = 0; i < n; i++) {
			out[i] = this.digTickSamples[(first + i) % this.digTickSamples.length] / 1.0E6;
		}
		return out;
	}

	/** Blocks Tier 2 broke and placed on the way. */
	public int digBroken() {
		return this.digExecutor.broken();
	}

	public int digPlaced() {
		return this.digExecutor.placed();
	}

	/**
	 * The pillar blocks Tier 2 placed since the last call, bottom first. A job that cleans up after itself (felling a tree)
	 * takes them to mine them away; nobody else needs to call it.
	 */
	public List<BlockPos> drainPlacedPillars() {
		return this.digExecutor.drainPillars();
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
		this.digDoors.closeBehind(this.agent, this.digExecutor::goesThrough);
		if (this.status != Status.MOVING || this.goal == null) {
			return;
		}
		if (this.digGoal != null) {
			this.tickTier2();
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
					this.tier1Failed("unreachable");
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
		if (this.reachTarget != null && this.inHandReach(this.reachTarget)) {
			return true;
		}
		return this.horizontalDistanceToGoal() <= this.reach && Math.abs(this.goal.y - this.agent.getY()) <= 1.5;
	}

	private boolean inHandReach(final BlockPos block) {
		return this.agent.getEyePosition().distanceTo(Vec3.atCenterOf(block)) <= BLOCK_REACH;
	}

	/** Tier 1 found no way: Tier 2 if the caller allows digging, else a failure. */
	private void tier1Failed(final String reason) {
		DigGoal fallback = this.digFallback;
		if (fallback == null || !tier2Enabled) {
			this.fail(reason);
			return;
		}
		NavDebug.log(this.agent.agentId(), "tier1_failed", "reason", reason, "from", this.agent.blockPosition().toShortString());
		this.startTier2(fallback, "tier1_" + reason);
	}

	// ---------------------------------------------------------------- tier 2

	/**
	 * True once the goal is met where the body stands. Goals are tested on the feet cell by its middle, but the body can
	 * stand anywhere in its cell: it enters the last cell of a path on the side away from a block it walks toward. So a
	 * "reach a block" goal also needs the block in hand reach; arriving half a block short left the miner's walk
	 * {@code out_of_reach} (seed 1350113924: a tree on a 2-block bank given up whole, the next tree called unreachable
	 * 4 blocks away).
	 */
	private boolean digArrived() {
		DigGoal g = this.digGoal;
		if (g == null || !this.digCellReached()) {
			return false;
		}
		return !(g instanceof DigGoal.Block b) || this.inHandReach(b.target());
	}

	/** True if the body stands (or swims, climbs) in a cell that fulfils the goal, tested by the cell's middle. */
	private boolean digCellReached() {
		DigGoal g = this.digGoal;
		if (g == null) {
			return false;
		}
		boolean settled = this.agent.onGround() || this.agent.isInWater() || this.agent.onClimbable();
		return settled && g.satisfiedAt(this.agent.level(), this.agent.blockPosition());
	}

	/** The path is walked out (or there was none to walk): arrive, or step to the middle of the goal cell first. */
	private void arriveOrSettle() {
		if (this.digArrived() || !this.digCellReached()) {
			this.arrive();
			return;
		}
		this.settleCell = this.agent.blockPosition();
		this.settleTicks = 0;
	}

	/**
	 * Steps to the middle of the goal cell, crouched (never off its edge), until the block is in hand reach: from there
	 * the eyes are within the plan's {@value #PLAN_REACH} of it. Arrives anyway after {@value #MAX_SETTLE_TICKS} ticks
	 * (the caller checks the reach itself); a body pushed out of the cell (a current) plans again, which counts as a
	 * re-plan ({@value #MAX_DIG_REPLANS} at most).
	 */
	private void settle() {
		BlockPos cell = this.settleCell;
		var controls = this.agent.controls();
		if (cell == null || !this.agent.blockPosition().equals(cell)) {
			this.settleCell = null;
			controls.stopMovement();
			this.digReplan("pushed_off_goal");
			return;
		}
		Vec3 middle = Vec3.atBottomCenterOf(cell);
		double hd = Math.hypot(middle.x - this.agent.getX(), middle.z - this.agent.getZ());
		if (hd <= 0.1 || ++this.settleTicks > MAX_SETTLE_TICKS) {
			this.arrive();
			return;
		}
		controls.look(controls.yawTo(middle), 10.0F);
		controls.setStrafe(0.0F);
		controls.setSprinting(false);
		if (!this.agent.isShiftKeyDown()) {
			controls.setSneaking(true);
		}
		controls.setForward(hd > 0.3 ? 1.0F : 0.5F);
	}

	private void tickTier2() {
		if (this.digArrived()) {
			this.arrive();
			return;
		}
		if (this.settleCell != null) {
			this.settle();
			return;
		}
		if (this.planner == null && !this.digExecutor.hasPath()) {
			// Plan from where the agent stands (or swims): wait for a landing first.
			boolean settled = this.agent.onGround() || this.agent.isInWater() || this.agent.onClimbable();
			if (!settled && ++this.digWaitTicks < 40) {
				return;
			}
			this.digWaitTicks = 0;
			this.startSearch();
		}
		DigPathPlanner p = this.planner;
		if (p != null) {
			this.agent.controls().stopMovement();
			DigPathPlanner.State s = p.step(DigPathPlanner.TICK_BUDGET_NANOS);
			this.digPlanTicks++;
			long tickNanos = p.lastStepNanos();
			this.digTickNanosMax = Math.max(this.digTickNanosMax, tickNanos);
			if (tickNanos > DigPathPlanner.TICK_BUDGET_NANOS + OVER_BUDGET_SLACK_NANOS) {
				this.digTicksOverBudget++;
			}
			this.digTickSamples[this.digTickSampleNext++ % this.digTickSamples.length] = tickNanos;
			if (s == DigPathPlanner.State.SEARCHING) {
				return;
			}
			this.planner = null;
			this.digNanosTotal += p.nanos();
			this.digNodes += p.expanded();
			if (s == DigPathPlanner.State.FAILED) {
				NavDebug.log(this.agent.agentId(), "tier2_failed", "reason", p.failure(), "goal", p.goal().describe(), "nodes", p.expanded(), "ticks", p.ticks(),
					"ms", String.format(Locale.ROOT, "%.1f", p.nanos() / 1.0E6));
				this.fail(p.failure());
				return;
			}
			DigPath path = p.path();
			this.lastDigPath = path;
			if (path == null || path.isEmpty()) {
				this.arriveOrSettle();
				return;
			}
			AgentEvents.emit(this.agent, "nav.dig", Map.of(
				"goal", p.goal().describe(),
				"steps", Integer.toString(path.steps().size()),
				"breaks", Integer.toString(path.breaks()),
				"places", Integer.toString(path.places()),
				"nodes", Integer.toString(path.nodes()),
				"ticks", Integer.toString(path.ticks()),
				"ms", String.format(Locale.ROOT, "%.1f", path.nanos() / 1.0E6)
			));
			if (debug || NavDebug.ENABLED) {
				NavDebug.log(this.agent.agentId(), "dig_path", "steps", path.steps());
			}
			this.digExecutor.setPath(path);
			return;
		}
		switch (this.digExecutor.tick(this.agent)) {
			case RUNNING -> {
			}
			case DONE -> {
				boolean settled = this.agent.onGround() || this.agent.isInWater() || this.agent.onClimbable();
				if (this.digCellReached()) {
					this.arriveOrSettle();
				} else if (settled || ++this.digWaitTicks >= 40) {
					// Landed (or never will) somewhere that is not the goal after all: plan again from here.
					this.digWaitTicks = 0;
					this.digReplan("done_not_there");
				}
			}
			case REPLAN -> this.digReplan(String.valueOf(this.digExecutor.replanReason()));
		}
	}

	private void digReplan(final String why) {
		NavDebug.log(this.agent.agentId(), "tier2_replan", "why", why, "at", this.agent.blockPosition().toShortString(), "n", this.digReplans + 1);
		this.digExecutor.setPath(null);
		if (++this.digReplans > MAX_DIG_REPLANS) {
			this.fail("stuck");
		}
	}

	private void startSearch() {
		DigGoal g = this.digGoal;
		if (g == null) {
			return;
		}
		ServerLevel level = this.agent.level();
		DigPathPlanner.Config config = DigPathPlanner.Config.standard(this.agent.getHealth(), NavBlocks.scaffoldCount(this.agent.getInventory()))
			.withAgent(this.agent.agentId());
		this.planner = new DigPathPlanner(level, this.agent.getInventory(), this.agent.blockPosition(), g, config, this.forbidden);
		this.digPlans++;
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
		this.endTier2();
		this.agent.controls().stopMovement();
	}

	private void fail(final String reason) {
		String tier = this.digGoal != null ? "2" : "1";
		DigGoal dg = this.digGoal != null ? this.digGoal : this.digFallback;
		String kind = dg != null ? dg.kind() : this.reachTarget != null ? "block" : "walk";
		this.status = Status.FAILED;
		this.failureReason = reason;
		NavDebug.log(this.agent.agentId(), "failed", "reason", reason, "tier", tier, "from", this.agent.blockPosition().toShortString(),
			"goal", this.goal == null ? "-" : BlockPos.containing(this.goal).toShortString(), "fruitless", this.fruitlessSegments);
		if (NavDebug.ENABLED && this.goal != null) {
			BlockPos g = BlockPos.containing(this.goal);
			NavDebug.terrainMap(this.agent.level(), this.agent.agentId(), this.agent.blockPosition(), g);
			NavDebug.column(this.agent.level(), this.agent.agentId(), g, 8, 1);
		}
		this.executor.clear(this.agent);
		this.endTier2();
		this.agent.controls().stopMovement();
		AgentEvents.emit(this.agent, "nav.failed", Map.of("reason", reason, "tier", tier, "kind", kind, "goal", this.goal == null ? "" : this.goal.toString()));
	}

	// ---------------------------------------------------------------- planning

	/** Plans the next waypoint segment. Returns false when navigation stopped. */
	private boolean planSegment() {
		Vec3 pos = this.agent.position();
		double goalDistance = pos.distanceTo(this.goal);
		if (goalDistance >= this.bestGoalDistanceAtSegmentStart - 0.5) {
			if (++this.fruitlessSegments > MAX_FRUITLESS_SEGMENTS) {
				this.tier1Failed("no_path");
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
			this.tier1Failed("no_path");
			return false;
		}
		this.executor.setPath(path, this.agent);
		this.finalApproachTicks = 0;
		if (!path.canReach() && NavDebug.ENABLED) {
			Node end = path.getEndNode();
			NavDebug.log(this.agent.agentId(), "partial", "from", this.agent.blockPosition().toShortString(), "target", target.toShortString(),
				"nodes", path.getNodeCount(), "end", end == null ? "-" : end.asBlockPos().toShortString(),
				"left", String.format(java.util.Locale.ROOT, "%.1f", path.getDistToTarget()), "fruitless", this.fruitlessSegments);
		}
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
				this.tier1Failed("unreachable");
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
