package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.NavBlocks;
import dev.minevibe.agent.perception.Trees;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.provenance.Protection;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * "Pillar beside the trunk": how the {@link Miner} fells the logs of a tree that stand higher than a walk reaches (W1
 * fells a tree whole). It picks a column next to the log, or the cut trunk under it, digs a few blocks of dirt nearby
 * when the bag has too little scaffold, walks into the column and pillars up with scaffold (jump, place a block under
 * the feet), breaking the leaves over its head, until the log is in hand reach. On the way up the miner fells every log
 * that comes into reach; at the end the climb comes down the way a player does, mining the pillar from the top (the
 * miner fills the dug holes again once the tree is down).
 *
 * <p><b>Safety.</b> The pillar rises at most {@value #MAX_HEIGHT} blocks above the ground at full health, less when
 * hurt (a fall from the top must leave the agent alive: health minus 8), never in water or lava, beside lava or fire,
 * or into a protected zone. Below {@value #RETREAT_HEALTH} health it stops and comes down. Logs no climb can reach
 * (higher than the limit allows) are never searched for at all.
 */
final class TreeClimb {
	/** What one tick of the climb came to. */
	enum Result {
		WORKING,
		/** The log asked for is in hand reach, standing: mine it. */
		REACHED,
		/** A log of the tree is in the way over the head ({@link #headLog()}): mine that one first. */
		HEAD_LOG,
		/** This log is out of the climb's reach ({@link #stopReason()}). The climb may still serve other logs. */
		STOPPED,
		/** Back down (or nothing to come down from): the climb is over. */
		DONE
	}

	private enum Phase {
		GATHER,
		WALK,
		CLIMB,
		DESCEND,
		DONE
	}

	/** Most blocks a felling pillar rises above the ground, at full health (a fall from there costs 9 health). */
	static final int MAX_HEIGHT = 12;
	/** Health at or below which the climb stops and comes down. */
	static final float RETREAT_HEALTH = 8.0F;
	/** Eye-to-centre distance a climb aims for (a little under the hands' 4.0). */
	static final double PLAN_REACH = 3.9;
	/** Logs within this horizontal distance of the column can be reached from it at some height. */
	private static final double SERVE = 2.9;
	private static final double EYE = 1.62;
	private static final int NONE = Integer.MIN_VALUE;
	/** Dirt for scaffold is dug within this many blocks of the column. */
	private static final int GATHER_RADIUS = 8;
	private static final int MAX_GATHER_FAILS = 3;

	private final Trees.Tree tree;
	private final int x;
	private final int z;
	/** The feet cell the column starts at (the ground, or the top of the agent's own pillar). */
	private final int start;
	/** Highest feet height of this climb. */
	private final int top;
	/** Scaffold blocks the climb expects to place. */
	private final int blocks;
	private final Walk walk;
	private final List<BlockPos> pillar;
	private final List<BlockPos> dug;
	private final List<BlockPos> cleared;
	private final Runnable onPlaced;
	private Phase phase;
	private @Nullable String stopReason;
	private @Nullable BlockPos headLog;
	private @Nullable BlockPos pillarFrom;
	private int ticks;
	private int walkTicks;
	private @Nullable BlockPos gatherAt;
	private boolean gatherHit;
	private int gatherTicks;
	private int gatherFails;
	private int dropTicks;
	private final Set<BlockPos> badDirt = new HashSet<>();

	private TreeClimb(final Trees.Tree tree, final int x, final int z, final int start, final int top, final int blocks, final Walk walk,
		final List<BlockPos> pillar, final List<BlockPos> dug, final List<BlockPos> cleared, final Runnable onPlaced) {
		this.tree = tree;
		this.x = x;
		this.z = z;
		this.start = start;
		this.top = top;
		this.blocks = blocks;
		this.walk = walk;
		this.pillar = pillar;
		this.dug = dug;
		this.cleared = cleared;
		this.onPlaced = onPlaced;
		this.phase = Phase.GATHER;
	}

	// ---------------------------------------------------------------- limits

	/** How high a felling pillar may rise for {@code agent} now: a fall from its top leaves 8 health or more. */
	static int limit(final AgentPlayer agent) {
		return limit(agent.getHealth());
	}

	/** How high a felling pillar may rise at {@code health}: at most {@value #MAX_HEIGHT}, health minus 8. */
	static int limit(final float health) {
		return Math.clamp((int)health - 8, 0, MAX_HEIGHT);
	}

	/** The highest log a climb from {@code ground} with {@code limit} can reach (from the column right under it). */
	static int highestReachable(final int ground, final int limit) {
		return ground + limit + 5;
	}

	/** The lowest feet height from which a column {@code h} blocks (horizontally) from {@code log} has it in reach. */
	static int minFeet(final BlockPos log, final double h) {
		double vertical = Math.sqrt(Math.max(0.0, PLAN_REACH * PLAN_REACH - h * h));
		return (int)Math.ceil(log.getY() + 0.5 - EYE - vertical);
	}

	/**
	 * The cell the agent's feet stand in, above the block it stands on: a body on a dirt path, farmland or soul sand
	 * (lower than a full block) is inside that block's cell by its block position, one below where a pillar block goes.
	 */
	static BlockPos feetCell(final AgentPlayer agent) {
		return new BlockPos(agent.getBlockX(), Mth.ceil(agent.getY() - 0.25), agent.getBlockZ());
	}

	/** A climb that ended for this reason is over: the climb comes down, and the tree gets no more climbs for some. */
	static boolean fatal(final @Nullable String why) {
		return "low_health".equals(why) || "hazard".equals(why) || "off_column".equals(why) || "no_way".equals(why);
	}

	// ---------------------------------------------------------------- planning

	/**
	 * Plans a climb to {@code log}: the best column among the nine around it (the cut trunk under it, or beside it),
	 * the one with the fewest blocks to place, where the agent already stands, or the nearest. Null when no column works
	 * (all too high for the limit, in water, beside lava, protected, or blocked by something that is no leaf).
	 * {@code remaining} are the tree's logs still to fell: the climb brings scaffold for the highest one it can serve.
	 * The miner's lists: {@code pillar} (scaffold to clear), {@code dug} (holes to fill), {@code cleared} (where scaffold
	 * was mined away, its drop to pick up).
	 */
	static @Nullable TreeClimb plan(final AgentPlayer agent, final Trees.Tree tree, final BlockPos log, final List<BlockPos> remaining, final Walk walk,
		final List<BlockPos> pillar, final List<BlockPos> dug, final List<BlockPos> cleared, final Runnable onPlaced) {
		ServerLevel level = agent.level();
		int limit = limit(agent);
		BlockPos feet = feetCell(agent);
		int bestX = 0;
		int bestZ = 0;
		int bestStart = NONE;
		int bestTop = 0;
		double bestScore = Double.MAX_VALUE;
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				int cx = log.getX() + dx;
				int cz = log.getZ() + dz;
				double h = Math.sqrt(dx * dx + dz * dz);
				boolean here = feet.getX() == cx && feet.getZ() == cz && Walk.settled(agent) && feet.getY() < log.getY();
				int from = here ? feet.getY() : standY(level, cx, cz, log.getY() - 1, tree.base().getY());
				if (from == NONE) {
					continue;
				}
				int ground = from;
				while (ground > level.getMinY() && pillar.contains(new BlockPos(cx, ground - 1, cz))) {
					ground--;
				}
				int colTop = ground + limit;
				int need = Math.max(from, minFeet(log, h));
				if (need > colTop || !climbable(level, cx, cz, from, need + 1, agent.agentId())) {
					continue;
				}
				double walkCost = here ? 0.0 : 4.0 + Math.hypot(cx + 0.5 - agent.getX(), cz + 0.5 - agent.getZ());
				// The cut trunk is best: every log mined above drops onto the agent.
				double score = (need - from) * 10.0 + walkCost + (h == 0.0 ? 0.0 : 2.0);
				if (score < bestScore) {
					bestScore = score;
					bestX = cx;
					bestZ = cz;
					bestStart = from;
					bestTop = colTop;
				}
			}
		}
		if (bestStart == NONE) {
			return null;
		}
		// Scaffold for the highest log this column serves, not only this one: a climb that runs out halfway helps nobody.
		int highest = Math.max(bestStart, minFeet(log, Math.hypot(log.getX() - bestX, log.getZ() - bestZ)));
		for (BlockPos l : remaining) {
			double hl = Math.hypot(l.getX() - bestX, l.getZ() - bestZ);
			if (hl <= SERVE) {
				int n = minFeet(l, hl);
				if (n <= bestTop) {
					highest = Math.max(highest, n);
				}
			}
		}
		return new TreeClimb(tree, bestX, bestZ, bestStart, bestTop, highest - bestStart, walk, pillar, dug, cleared, onPlaced);
	}

	/**
	 * The feet cell a column at (cx, cz) starts at below {@code from}: the first floor under it, through air, plants and
	 * natural leaves (a bush is cut on the way), when that floor is ground: natural ground (a hillside beside the tree),
	 * any floor at most a step above the stump, or scaffold an agent placed; never a block with a block entity (a bee
	 * nest up in the crown). None when the column holds a log, water or lava.
	 */
	private static int standY(final ServerLevel level, final int cx, final int cz, final int from, final int stumpY) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int y = from; y > level.getMinY() && y >= from - 32; y--) {
			p.set(cx, y, cz);
			BlockState s = level.getBlockState(p);
			if (!s.getFluidState().isEmpty() || NavBlocks.isHazard(s) || s.is(BlockTags.LOGS)) {
				return NONE;
			}
			if (NavBlocks.isPassable(level, p, s) || Trees.isNaturalLeaf(s)) {
				continue;
			}
			boolean ground = !s.hasBlockEntity() && (NavBlocks.isNaturalMaterial(s) && !s.is(BlockTags.LEAVES) || y < stumpY + 1
				|| NavBlocks.isScaffold(level, p, s));
			return ground && NavBlocks.isFloor(level, p, s) ? y + 1 : NONE;
		}
		return NONE;
	}

	/**
	 * True if a body can rise through the column (cx, cz) from feet {@code from} to cells {@code to}: every cell free, a
	 * plant, or natural leaves to cut; no fluid in it, no lava or fire beside it; the cells that take scaffold outside
	 * protected zones and the office.
	 */
	private static boolean climbable(final ServerLevel level, final int cx, final int cz, final int from, final int to, final @Nullable String agentId) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int y = from; y <= to; y++) {
			p.set(cx, y, cz);
			BlockState s = level.getBlockState(p);
			if (!s.getFluidState().isEmpty() || NavBlocks.isHazard(s)) {
				return false;
			}
			boolean free = NavBlocks.isPassable(level, p, s) && (s.isAir() || s.canBeReplaced());
			if (!free && !breakable(level, p, s, agentId)) {
				return false;
			}
			if (hazardBeside(level, p)) {
				return false;
			}
			if (y < to - 1 && (OfficeService.protects(level, p) || Protection.checkZoneCell(level, p, agentId) != null)) {
				return false;
			}
		}
		return true;
	}

	/** Natural leaves or snow nobody placed: cut on the way up. */
	static boolean breakable(final ServerLevel level, final BlockPos p, final BlockState s, final @Nullable String agentId) {
		return (Trees.isNaturalLeaf(s) || s.is(BlockTags.SNOW)) && NavBlocks.mayBreak(level, p, s, agentId);
	}

	private static boolean hazardBeside(final ServerLevel level, final BlockPos p) {
		for (Direction d : Direction.values()) {
			if (d != Direction.DOWN && NavBlocks.isHazard(level.getBlockState(p.relative(d)))) {
				return true;
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- state

	/** The column, where it starts, how high it may go and the scaffold it brings (logs). */
	String describe() {
		return this.x + "," + this.z + " from y " + this.start + " top " + this.top + " blocks " + this.blocks;
	}

	/** The log over the head after {@link Result#HEAD_LOG}. */
	@Nullable BlockPos headLog() {
		return this.headLog;
	}

	@Nullable String stopReason() {
		return this.stopReason;
	}

	boolean descending() {
		return this.phase == Phase.DESCEND || this.phase == Phase.DONE;
	}

	/**
	 * True if a log at {@code log} can be brought into reach from this column: close enough to it, within the limit, and,
	 * once climbing, in reach already or higher up (climbing never helps with a log out of reach below).
	 */
	boolean serves(final AgentPlayer agent, final BlockPos log) {
		double h = Math.hypot(log.getX() - this.x, log.getZ() - this.z);
		int need = minFeet(log, h);
		if (h > SERVE || need > this.top) {
			return false;
		}
		return this.phase != Phase.CLIMB || Walk.inReach(agent, log) || need >= agent.getBlockY();
	}

	/** Comes down: the pillar under the agent is mined from the top. */
	void descend() {
		this.phase = Phase.DESCEND;
		this.pillarFrom = null;
		this.ticks = 0;
	}

	// ---------------------------------------------------------------- ticking

	/** One tick toward having {@code log} in reach. */
	Result tick(final AgentPlayer agent, final BlockPos log) {
		return switch (this.phase) {
			case GATHER -> this.gather(agent);
			case WALK -> this.walkIn(agent);
			case CLIMB -> this.climb(agent, log);
			case DESCEND -> this.descendTick(agent);
			case DONE -> Result.DONE;
		};
	}

	/** One tick of coming down; {@link Result#DONE} once down. */
	Result descendTick(final AgentPlayer agent) {
		if (this.phase != Phase.DESCEND) {
			this.phase = Phase.DONE;
			return Result.DONE;
		}
		ServerLevel level = agent.level();
		agent.controls().setJumping(false);
		if (!Walk.settled(agent)) {
			// Falling onto the next block of the pillar.
			if (++this.ticks > 60) {
				this.phase = Phase.DONE;
				return Result.DONE;
			}
			return Result.WORKING;
		}
		BlockPos feet = feetCell(agent);
		// Blocks of this column the held attack broke at the end of a tick are air now: no longer ours to clear.
		this.pillar.removeIf(p -> {
			boolean gone = p.getX() == this.x && p.getZ() == this.z && p.getY() >= feet.getY() && level.getBlockState(p).isAir();
			if (gone) {
				this.cleared.add(p);
			}
			return gone;
		});
		BlockPos below = feet.below();
		if (this.pillar.contains(below) && NavBlocks.isScaffoldBlock(level.getBlockState(below)) && ++this.ticks <= 20 * 10) {
			if (BlockOps.mineTick(agent, below)) {
				this.pillar.remove(below);
				this.cleared.add(below);
				NavBlocks.forgetScaffold(level, below);
				this.ticks = 0;
			}
			return Result.WORKING;
		}
		agent.controls().stopMining();
		this.phase = Phase.DONE;
		return Result.DONE;
	}

	private Result stop(final String why) {
		this.stopReason = why;
		return Result.STOPPED;
	}

	private void toPhase(final AgentPlayer agent, final Phase next) {
		Miner.debug(agent, "climb_phase", "phase", next, "at", agent.blockPosition().toShortString(), "scaffold",
			NavBlocks.scaffoldCount(agent.getInventory()), "dug", this.dug.size());
		this.phase = next;
	}

	/** Digs dirt nearby until the bag holds the scaffold the climb needs (or there is none to dig). */
	private Result gather(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos at = this.gatherAt;
		if (at != null && !isDirt(level.getBlockState(at))) {
			if (this.gatherHit && !this.dug.contains(at)) {
				// Broken by the held attack: a hole to fill again once the tree is down.
				this.dug.add(at);
				this.dropTicks = 40;
			}
			this.gatherHit = false;
			if (this.dropTicks-- > 0 && Miner.collectNear(agent, this.walk, at, 2.5, NavBlocks::isScaffoldItem)) {
				return Result.WORKING;
			}
			this.gatherAt = null;
			at = null;
		}
		if (at == null) {
			if (NavBlocks.scaffoldCount(agent.getInventory()) >= this.blocks || this.gatherFails >= MAX_GATHER_FAILS) {
				this.toWalk(agent);
				return Result.WORKING;
			}
			at = this.nextDirt(agent);
			if (at == null) {
				// None around: climb as far as the bag allows.
				this.toWalk(agent);
				return Result.WORKING;
			}
			this.gatherAt = at;
			this.gatherTicks = 0;
		}
		if (++this.gatherTicks > 20 * 15) {
			this.giveUpDirt(agent, at);
			return Result.WORKING;
		}
		if (!Walk.inReach(agent, at) || Walk.standsOn(agent, at) || !Walk.settled(agent)) {
			if (this.walk.toMine(agent, at) == Walk.State.FAILED) {
				this.giveUpDirt(agent, at);
			}
			return Result.WORKING;
		}
		this.walk.stop(agent);
		this.gatherHit = true;
		if (BlockOps.mineTick(agent, at)) {
			this.dug.add(at);
			this.dropTicks = 40;
			this.gatherHit = false;
		}
		return Result.WORKING;
	}

	private void giveUpDirt(final AgentPlayer agent, final BlockPos at) {
		agent.controls().stopMining();
		this.badDirt.add(at);
		this.gatherAt = null;
		this.gatherHit = false;
		this.gatherFails++;
	}

	private void toWalk(final AgentPlayer agent) {
		this.walk.stop(agent);
		agent.controls().stopMining();
		this.toPhase(agent, Phase.WALK);
		this.ticks = 0;
	}

	/**
	 * The nearest natural dirt or grass at the surface around the column: open above, nobody's, not protected, nothing
	 * to let in beside or above it, and solid ground under it, so the hole is one block deep with a floor. Never the
	 * column's own floor, the ground under the stump (the sapling's) or under the agent, and never the floor of a hole
	 * dug before (a hole deepened block by block opened a water pocket under seed 3207449953's oak, and the agent fell in
	 * and drowned).
	 */
	private @Nullable BlockPos nextDirt(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos floor = new BlockPos(this.x, this.start - 1, this.z);
		Set<Long> stump = new HashSet<>();
		int baseY = this.tree.base().getY();
		for (BlockPos l : this.tree.logs()) {
			if (l.getY() == baseY) {
				stump.add(BlockPos.asLong(l.getX(), 0, l.getZ()));
			}
		}
		BlockPos feet = feetCell(agent);
		List<BlockPos> found = new ArrayList<>(BlockScan.nearest(level, floor, GATHER_RADIUS, TreeClimb::isDirt, p -> {
			if (this.badDirt.contains(p) || Math.abs(p.getY() - floor.getY()) > 1 || this.dug.contains(p) || this.dug.contains(p.above())) {
				return false;
			}
			BlockPos under = p.below();
			BlockState u = level.getBlockState(under);
			if (!u.getFluidState().isEmpty() || !NavBlocks.isFloor(level, under, u) || NavBlocks.isFalling(u)) {
				return false;
			}
			if (p.getX() == this.x && p.getZ() == this.z || p.getY() < baseY && stump.contains(BlockPos.asLong(p.getX(), 0, p.getZ()))) {
				return false;
			}
			if (p.getX() == feet.getX() && p.getZ() == feet.getZ() && p.getY() == feet.getY() - 1) {
				return false;
			}
			BlockState above = level.getBlockState(p.above());
			if (!above.getFluidState().isEmpty() || !(above.isAir() || above.canBeReplaced() && above.getCollisionShape(level, p.above()).isEmpty())) {
				return false;
			}
			return NavBlocks.mayBreak(level, p, level.getBlockState(p), agent.agentId()) && NavBlocks.safeToOpen(level, p);
		}, 12));
		found.sort(java.util.Comparator.comparingDouble(p -> p.distSqr(feet)));
		return found.isEmpty() ? null : found.getFirst();
	}

	/** Ground that drops a dirt block (grass, podzol and mycelium included). */
	static boolean isDirt(final BlockState s) {
		return s.is(Blocks.DIRT) || s.is(Blocks.GRASS_BLOCK) || s.is(Blocks.COARSE_DIRT) || s.is(Blocks.PODZOL) || s.is(Blocks.MYCELIUM);
	}

	/** Dirt to fill a dug hole with. */
	static boolean isDirtItem(final ItemStack s) {
		return s.is(Items.DIRT) || s.is(Items.COARSE_DIRT);
	}

	/** Walks into the column and stands in its middle. */
	private Result walkIn(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos feet = feetCell(agent);
		Vec3 middle = new Vec3(this.x + 0.5, this.start, this.z + 0.5);
		double hd = Math.hypot(middle.x - agent.getX(), middle.z - agent.getZ());
		if (feet.getX() == this.x && feet.getZ() == this.z && feet.getY() >= this.start && Walk.settled(agent)) {
			// In the column: to its middle first (crouched, never off a pillar's edge), so the first jump lands on the block.
			if (hd > 0.2 && ++this.ticks <= 30) {
				steer(agent, middle, true);
				return Result.WORKING;
			}
			agent.controls().stopMovement();
			this.toPhase(agent, Phase.CLIMB);
			this.ticks = 0;
			return Result.WORKING;
		}
		if (++this.walkTicks > 20 * 40) {
			return this.stop("no_way");
		}
		// A bush in the column's lowest cells: cut it once in reach.
		for (int dy = 0; dy <= 1; dy++) {
			BlockPos cell = new BlockPos(this.x, this.start + dy, this.z);
			BlockState s = level.getBlockState(cell);
			if (!NavBlocks.isPassable(level, cell, s) && breakable(level, cell, s, agent.agentId()) && Walk.inReach(agent, cell) && Walk.settled(agent)
				&& hd < 2.5) {
				this.walk.stop(agent);
				if (BlockOps.mineTick(agent, cell)) {
					agent.controls().stopMining();
				}
				return Result.WORKING;
			}
		}
		if (hd < 1.6 && Math.abs(agent.getY() - this.start) < 0.6 && Walk.settled(agent)) {
			// Right next to it: one step in.
			this.walk.stop(agent);
			steer(agent, middle, false);
			if (++this.ticks > 40) {
				return this.stop("no_way");
			}
			return Result.WORKING;
		}
		if (this.walk.toDig(agent, middle, 0.4) == Walk.State.FAILED) {
			return this.stop("no_way");
		}
		return Result.WORKING;
	}

	private static void steer(final AgentPlayer agent, final Vec3 to, final boolean careful) {
		var controls = agent.controls();
		double hd = Math.hypot(to.x - agent.getX(), to.z - agent.getZ());
		controls.look(controls.yawTo(to), 10.0F);
		controls.setStrafe(0.0F);
		controls.setSprinting(false);
		if (careful != agent.isShiftKeyDown()) {
			controls.setSneaking(careful);
		}
		controls.setForward(hd > 0.3 ? 0.8F : 0.4F);
		controls.setJumping(!careful && agent.onGround() && agent.horizontalCollision);
	}

	/** Up the column until {@code log} is in reach: cut leaves overhead, jump and place scaffold under the feet. */
	private Result climb(final AgentPlayer agent, final BlockPos log) {
		ServerLevel level = agent.level();
		if (agent.getHealth() <= RETREAT_HEALTH) {
			agent.controls().setJumping(false);
			this.pillarFrom = null;
			return this.stop("low_health");
		}
		if (this.pillarFrom != null) {
			return this.pillarStep(agent);
		}
		BlockPos feet = feetCell(agent);
		if (feet.getX() != this.x || feet.getZ() != this.z) {
			return this.stop("off_column");
		}
		if (!Walk.settled(agent)) {
			return ++this.ticks > 60 ? this.stop("off_column") : Result.WORKING;
		}
		this.ticks = 0;
		agent.controls().stopMovement();
		if (Walk.inReach(agent, log) && !Walk.standsOn(agent, log)) {
			return Result.REACHED;
		}
		if (minFeet(log, Math.hypot(log.getX() - this.x, log.getZ() - this.z)) < feet.getY()) {
			return this.stop("below");
		}
		if (feet.getY() >= this.top) {
			return this.stop("limit");
		}
		BlockPos head = feet.above(2);
		BlockState hs = level.getBlockState(head);
		if (!NavBlocks.isPassable(level, head, hs) || !hs.getFluidState().isEmpty()) {
			if (this.tree.logs().contains(head) && Trees.isNaturalLogBlock(hs)) {
				this.headLog = head.immutable();
				return Result.HEAD_LOG;
			}
			if (hs.getFluidState().isEmpty() && breakable(level, head, hs, agent.agentId())) {
				if (BlockOps.mineTick(agent, head)) {
					agent.controls().stopMining();
				}
				return Result.WORKING;
			}
			return this.stop("blocked");
		}
		if (hazardBeside(level, feet) || hazardBeside(level, feet.above()) || hazardBeside(level, head)) {
			return this.stop("hazard");
		}
		if (OfficeService.protects(level, feet) || Protection.checkZoneCell(level, feet, agent.agentId()) != null) {
			return this.stop("blocked");
		}
		if (NavBlocks.scaffoldCount(agent.getInventory()) == 0) {
			return this.stop("no_scaffold");
		}
		agent.controls().stopMining();
		this.pillarFrom = feet.immutable();
		return this.pillarStep(agent);
	}

	/** One tick of "jump and put a block under your feet". */
	private Result pillarStep(final AgentPlayer agent) {
		BlockPos at = this.pillarFrom;
		if (at == null) {
			return Result.WORKING;
		}
		if (++this.ticks > 20 * 6) {
			agent.controls().setJumping(false);
			this.pillarFrom = null;
			this.ticks = 0;
			return this.stop("pillar_failed");
		}
		if (agent.getY() < at.getY() + 1.05) {
			agent.controls().setJumping(true);
			return Result.WORKING;
		}
		agent.controls().setJumping(false);
		BlockOps.Place r = BlockOps.placeTick(agent, at, NavBlocks::isScaffoldItem);
		if (r == BlockOps.Place.PLACED) {
			// Scaffold: if it is ever left standing, navigation may break it again (never a crew build).
			NavBlocks.noteScaffold(agent.level(), at);
			this.pillar.add(at);
			this.onPlaced.run();
			this.pillarFrom = null;
			this.ticks = 0;
		} else if (r != BlockOps.Place.RETRY && r != BlockOps.Place.SELF_IN_WAY) {
			this.pillarFrom = null;
			this.ticks = 0;
			Miner.debug(agent, "pillar_place", "result", r, "at", at.toShortString());
			return this.stop(r == BlockOps.Place.NO_ITEM ? "no_scaffold" : "pillar_failed");
		}
		return Result.WORKING;
	}
}
