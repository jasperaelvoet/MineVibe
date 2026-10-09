package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.nav.NavBlocks;
import dev.minevibe.agent.nav.NavDebug;
import dev.minevibe.agent.perception.Compass;
import dev.minevibe.agent.perception.Reach;
import dev.minevibe.agent.perception.Sources;
import dev.minevibe.agent.perception.Trees;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Provenance;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The engine behind {@code mine} and {@code collect}: pick a source, walk into reach, break it at survival speed with
 * the best tool, then pick up the drops. Unreachable blocks are skipped. Natural sources only (W1):
 *
 * <ul>
 *   <li><b>Blocks</b> that are protected (player-built, in the Base) are never targets; they are remembered so a job
 *       that finds nothing else can say so ({@link #candidates}).</li>
 *   <li><b>Trees</b> ({@code treeMode}: the request is for logs): the nearest natural tree the agent can walk to (a
 *       quick A* per tree; with no walking way to any, the nearest tree at all) is felled whole, bottom-up, the logs in
 *       reach first. A log a walk reaches from the ground is walked to with Tier-2 navigation ({@link Walk#toMine}),
 *       which digs, pillars and bridges where no walk leads. A log higher up is felled from a pillar beside the trunk
 *       ({@link TreeClimb}: dirt dug nearby when the bag has no scaffold, at most {@value TreeClimb#MAX_HEIGHT} blocks
 *       high, never in water or by lava, down again below {@value TreeClimb#RETREAT_HEALTH} health); a log higher than
 *       any climb reaches is left without a search ({@code logsLeftHigh}). A log no walk reaches is tried again from a
 *       climb, then once more when the rest of the tree is down; the other logs go on meanwhile. Three failed walks in
 *       a row (or six on one tree) give up the rest of that tree.</li>
 *   <li><b>After a tree</b> its pillars come down, its logs are picked up all over its crown (a log caught in the
 *       leaves: the leaf under it is broken, so it falls), the holes dug for scaffold are filled again, and a sapling of
 *       the same kind is planted on the stump when asked ({@code replant}).</li>
 * </ul>
 */
public final class Miner {
	public enum Tick {
		WORKING,
		/** No usable matching block is left within the radius. */
		NONE_LEFT,
		FAILED
	}

	private static final int MAX_SKIPS = 8;
	/** Ticks to pick up the drops of a broken block (M2: 100, was 40, which lost drops that bounced away). */
	private static final int COLLECT_TICKS = 100;
	private static final int MAX_REACH_CHECKS = 6;
	private static final int MAX_CANDIDATES = 8;
	/** Logs at most this high above the stump are in reach from the ground beside the trunk. */
	static final int GROUND_REACH = 4;
	/** Logs at most this high above the stump are in reach from a Tier-2 pillar (3 blocks) beside the trunk. */
	static final int TIER2_HIGH = 7;
	/** Failed walks to logs of one tree, in a row, before the rest of the tree is given up. */
	private static final int MAX_WALK_FAILS_IN_A_ROW = 3;
	/** Failed walks to logs of one tree in all (each costs a full Tier-2 search) before the rest is given up. */
	private static final int MAX_WALK_FAILS_PER_TREE = 6;
	private static final int MAX_CLIMBS_PER_TREE = 4;
	/** Drops are looked for this far around a felled tree's logs. */
	private static final int SWEEP_MARGIN = 3;
	/** A drop lying higher than this above the stump is in the canopy: the leaf under it is broken. */
	private static final double CANOPY_DROP = 2.0;

	private final Predicate<BlockState> match;
	private final @Nullable BlockPos center;
	private final int radius;
	/** Null until first asked (block tags are only bound in a running server). */
	private @Nullable Boolean treeMode;
	private final boolean replant;
	private final Set<BlockPos> skip = new HashSet<>();
	private final Walk walk = new Walk();
	private @Nullable BlockPos target;
	private @Nullable BlockPos collectAt;
	private int collectTicks;
	private int mined;
	private int mineTicks;
	private String failureCode = "FAILED";
	private String failure = "";

	/** Sources seen but not used, by position (the trunk base for trees). */
	private final Map<BlockPos, Sources.Candidate> rejected = new LinkedHashMap<>();
	/** Protected matches seen (for PROTECTED and the consent offer). */
	private final List<Protection.Verdict> protectedSeen = new ArrayList<>();

	// tree mode
	private Trees.@Nullable Tree tree;
	private final Set<BlockPos> doneTrees = new HashSet<>();
	/** Trees no walk leads to, picked for Tier 2 to dig its way there: one failed way and the tree is unreachable. */
	private final Set<BlockPos> digOnly = new HashSet<>();
	/** Set by {@link #finishCurrentTree}: no new tree is picked. */
	private boolean lastTree;
	private final Map<BlockPos, Reach.Result> reachable = new HashMap<>();
	private int treesFelled;
	/** Logs left standing because no climb (and no Tier-2 pillar) reaches them. */
	private final Set<BlockPos> leftHigh = new HashSet<>();
	/** Scaffold this job placed (Tier-2 pillars and the climbs'), bottom first: cleared when the tree is down. */
	private final List<BlockPos> pillar = new ArrayList<>();
	/** The pillars earlier walks left (a goto, another job) were dropped: only this job's own are cleared. */
	private boolean pillarBacklogDropped;
	private int choreTicks;
	private boolean cleaning;
	private @Nullable TreeClimb climb;
	/** Holes dug for scaffold, filled again when the tree is down. */
	private final List<BlockPos> dug = new ArrayList<>();
	private @Nullable BlockPos replantAt;
	private @Nullable Item sapling;
	private int replanted;
	private int pillarsBuilt;
	// the tree being felled
	/** Logs no walk reached yet: tried once more when the rest of the tree is down. */
	private final Set<BlockPos> deferred = new HashSet<>();
	/** Logs on their second try: a second failure gives them up. */
	private final Set<BlockPos> retried = new HashSet<>();
	/** Logs a climb was planned for (one plan each). */
	private final Set<BlockPos> climbTried = new HashSet<>();
	/** Logs whose walk failed in this try (counted once toward giving the tree up). */
	private final Set<BlockPos> failedLogs = new HashSet<>();
	private int walkFailsInARow;
	private int walkFails;
	private int climbs;
	/** Climbing is off for this tree (low health, a hazard, no scaffold to be had). */
	private boolean noClimb;
	// the drop sweep after a tree
	private @Nullable AABB sweepBox;
	private int sweepTicks;
	private int sweepStumpY;
	private @Nullable ItemEntity sweepItem;
	private @Nullable BlockPos sweepLeaf;
	private int sweepItemTicks;
	private final Set<ItemEntity> sweepIgnored = Collections.newSetFromMap(new WeakHashMap<>());
	private boolean sweeping;
	/** Where pillar blocks were mined away: their drops are picked up before the holes are filled. */
	private final List<BlockPos> scaffoldDrops = new ArrayList<>();

	public Miner(final Predicate<BlockState> match, final @Nullable BlockPos center, final int radius) {
		this(match, center, radius, null, false);
	}

	/** {@code treeMode} null: decided from {@code match} when first needed ({@link Sources#treeMode}). */
	public Miner(
		final Predicate<BlockState> match, final @Nullable BlockPos center, final int radius, final @Nullable Boolean treeMode, final boolean replant
	) {
		this.match = match;
		this.center = center;
		this.radius = radius;
		this.treeMode = treeMode;
		this.replant = replant;
	}

	/** Blocks broken so far. */
	public int mined() {
		return this.mined;
	}

	/** Targets given up on so far (no way to them, out of every climb's reach, or too slow to break). */
	public int unreachable() {
		return this.skip.size();
	}

	public String failureCode() {
		return this.failureCode;
	}

	public String failure() {
		return this.failure;
	}

	public @Nullable BlockPos target() {
		return this.target;
	}

	public boolean treeMode() {
		Boolean t = this.treeMode;
		if (t == null) {
			t = Sources.treeMode(this.match);
			this.treeMode = t;
		}
		return t;
	}

	public int treesFelled() {
		return this.treesFelled;
	}

	public int replanted() {
		return this.replanted;
	}

	/** Blocks placed to pillar up to high logs (all mined away again). */
	public int pillarsBuilt() {
		return this.pillarsBuilt;
	}

	/** Logs left standing because they were out of reach even after climbing. */
	public int logsLeftHigh() {
		return this.leftHigh.size();
	}

	/**
	 * The job has enough: finish the tree being felled (its pillar, drops and sapling) but start no other. Without it a
	 * job whose count was met while {@link #busy()} never ended: the next tree was picked in the same tick the last one's
	 * chores ended, so the miner was never idle when the job looked (collect 10 logs felled trees until its timeout).
	 */
	public void finishCurrentTree() {
		this.lastTree = true;
	}

	/** True while a tree is half felled (or its pillar, drops, holes or sapling not done): the job should let it finish. */
	public boolean busy() {
		return this.tree != null || this.climb != null || !this.pillar.isEmpty() || this.cleaning || this.sweepBox != null || !this.dug.isEmpty()
			|| !this.scaffoldDrops.isEmpty() || this.replantAt != null || this.treeMode() && this.collectAt != null;
	}

	/** True while it picks up the drops of the block it broke last. */
	public boolean collecting() {
		return this.collectAt != null;
	}

	/** Protected matches the miner left alone, nearest first. */
	public List<Protection.Verdict> protectedSeen() {
		return List.copyOf(this.protectedSeen);
	}

	/**
	 * Where what the miner broke came from (tools-v2-mc.md M2 `sources`): one entry per felled tree ({@code kind} tree,
	 * {@code what} its species, {@code pos} its trunk base) or per block kind ({@code ore} / {@code stone}).
	 */
	public record Source(String kind, String what, BlockPos pos, int n) {
	}

	private final Map<String, Source> sources = new LinkedHashMap<>();
	private int treeStartMined;
	private @Nullable String targetId;
	private @Nullable BlockState toolNeededFor;

	public List<Source> sources() {
		return List.copyOf(this.sources.values());
	}

	/** The block that needed a better tool, when the last failure was {@code NEEDS_TOOL}. */
	public @Nullable BlockState toolNeededFor() {
		return this.toolNeededFor;
	}

	/**
	 * How many of the items a job gained ({@code gained}, item id to count, as {@link Inv#gained}) are blocks the miner
	 * takes ({@code match}): for logs, the logs kept of those felled.
	 */
	public static int kept(final Map<String, Integer> gained, final Predicate<BlockState> match) {
		int n = 0;
		for (Map.Entry<String, Integer> e : gained.entrySet()) {
			Identifier id = Identifier.tryParse(e.getKey());
			Item item = id == null ? null : BuiltInRegistries.ITEM.getValue(id);
			if (item instanceof BlockItem b && match.test(b.getBlock().defaultBlockState())) {
				n += e.getValue();
			}
		}
		return n;
	}

	/** A plain block was broken: counted under its kind. */
	private void countBlock(final BlockPos at) {
		String id = this.targetId;
		if (id == null || this.treeMode()) {
			return;
		}
		String what = id.replace("minecraft:", "");
		String kind = what.endsWith("_ore") ? "ore" : "stone";
		Source prev = this.sources.get(id);
		this.sources.put(id, prev == null ? new Source(kind, what, at, 1) : new Source(kind, what, prev.pos(), prev.n() + 1));
	}

	/** After a preemption: re-plan the walk. */
	public void reset() {
		this.walk.reset();
		this.choreTicks = 0;
	}

	/** Only picks up the drops of the last broken block; false once there are none left (or it gave up). */
	public boolean collecting(final AgentPlayer agent) {
		if (this.collectAt != null) {
			if (this.collectTicks-- > 0 && collectNear(agent, this.walk, this.collectAt, 5.0, s -> true)) {
				return true;
			}
			this.collectAt = null;
		}
		return false;
	}

	public Tick tick(final AgentPlayer agent) {
		if (this.treeMode()) {
			return this.treeTick(agent);
		}
		ServerLevel level = agent.level();
		if (this.collecting(agent)) {
			return Tick.WORKING;
		}
		if (this.target != null && !this.match.test(level.getBlockState(this.target))) {
			// Broken by the held attack at the end of the last tick (or by someone else while we hit it).
			if (this.mineTicks > 0) {
				this.mined++;
				this.countBlock(this.target);
				this.collectAt = this.target;
				this.collectTicks = COLLECT_TICKS;
			}
			this.target = null;
			if (this.collecting(agent)) {
				return Tick.WORKING;
			}
		}
		if (this.target == null) {
			this.target = this.nextBlock(agent);
			if (this.target == null) {
				return Tick.NONE_LEFT;
			}
			this.targetId = Refs.blockId(level.getBlockState(this.target).getBlock());
			this.mineTicks = 0;
			this.walk.reset();
		}
		BlockPos t = this.target;
		if (Protection.check(level, t, agent.agentId()) != null) {
			// Became protected (a zone was added, a player placed it again): never touch it.
			this.noteProtected(level, t);
			this.skipTarget();
			return Tick.WORKING;
		}
		// In reach only at the top of a jump (a pillar being built) is not in reach yet: let the walk finish. The block
		// under the feet is never mined (no digging straight down): the walk steps aside first.
		if (!Walk.inReach(agent, t) || Walk.standsOn(agent, t) || !Walk.settled(agent) && agent.navigator().isMoving()) {
			// Tier 2 straight away ("reach a block to mine"): digs, pillars and bridges where no walk leads.
			Walk.State s = this.walk.toMine(agent, t);
			if (s == Walk.State.MOVING) {
				return Tick.WORKING;
			}
			if (s == Walk.State.FAILED) {
				this.skipTarget();
				return this.skip.size() > MAX_SKIPS ? this.failed("UNREACHABLE", "cannot reach any matching block (" + this.walk.failure() + ")") : Tick.WORKING;
			}
		} else {
			this.walk.stop(agent);
			agent.controls().setJumping(false);
		}
		BlockState state = level.getBlockState(t);
		if (BlockOps.wouldDropNothing(agent, state)) {
			this.toolNeededFor = state;
			return this.failed("NEEDS_TOOL", "breaking " + Refs.blockId(state.getBlock()) + " drops nothing without the right tool");
		}
		if (++this.mineTicks > 20 * 30) {
			this.skipTarget();
			return Tick.WORKING;
		}
		if (BlockOps.mineTick(agent, t)) {
			this.mined++;
			this.countBlock(t);
			this.target = null;
			this.collectAt = t;
			this.collectTicks = COLLECT_TICKS;
		}
		return Tick.WORKING;
	}

	// ---------------------------------------------------------------- plain blocks

	private @Nullable BlockPos nextBlock(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos from = this.center != null ? this.center : agent.blockPosition();
		List<BlockPos> found = BlockScan.nearest(level, from, this.radius, this.match, p -> {
			if (this.skip.contains(p) || !BlockScan.exposed(level, p) || BlockOps.unbreakable(level, p)) {
				return false;
			}
			if (Protection.check(level, p, agent.agentId()) != null) {
				this.noteProtected(level, p);
				return false;
			}
			return true;
		}, 24);
		if (found.isEmpty()) {
			return null;
		}
		// Nearest to the agent among the nearest to the centre.
		found.sort(Comparator.comparingDouble(p -> p.distSqr(agent.blockPosition())));
		return found.getFirst();
	}

	private void noteProtected(final ServerLevel level, final BlockPos p) {
		if (this.protectedSeen.size() >= 32 || this.protectedSeen.stream().anyMatch(v -> v.pos().equals(p))) {
			return;
		}
		Protection.Verdict v = Protection.check(level, p, null);
		if (v != null) {
			this.protectedSeen.add(v);
		}
	}

	// ---------------------------------------------------------------- trees

	private Tick treeTick(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		// Pillars the walk built (Tier 2) are cleared with the tree, like the climbs'. Those built before this job started
		// (any walk's: the navigator keeps them until a felling job takes them) are not this job's to clear: it would walk
		// back to wherever they were and mine whatever stands there by now.
		List<BlockPos> placed = agent.navigator().drainPlacedPillars();
		if (!this.pillarBacklogDropped) {
			this.pillarBacklogDropped = true;
		} else if (!placed.isEmpty()) {
			if (this.cleaning) {
				// Built to reach a pillar block being cleared (the top of a climb's pillar, high above the ground): cleared
				// after the rest. It is under the feet now, and mining it at once dropped the body off before it got
				// there, again and again.
				this.pillar.addAll(0, placed);
			} else {
				this.pillar.addAll(placed);
			}
			this.pillarsBuilt += placed.size();
		}
		if (this.target != null && !this.match.test(level.getBlockState(this.target))) {
			// Broken by the held attack at the end of the last tick (or by someone else while we hit it).
			if (this.mineTicks > 0) {
				this.logMined(this.target);
			}
			this.target = null;
		}
		if (this.tree == null) {
			Tick chores = this.treeChores(agent);
			if (chores != null) {
				return chores;
			}
			if (this.lastTree) {
				// The job has what it asked for: the last tree was the last one.
				return Tick.NONE_LEFT;
			}
			Trees.Tree next = this.pickTree(agent);
			if (next == null) {
				return Tick.NONE_LEFT;
			}
			this.startTree(next);
			debug(agent, "fell", "tree", next.species() + "@" + next.base().toShortString(), "logs", next.logs().size(), "height", next.height());
		}
		TreeClimb c = this.climb;
		if (c != null && c.descending()) {
			if (c.descendTick(agent) == TreeClimb.Result.WORKING) {
				return Tick.WORKING;
			}
			this.climb = null;
		}
		if (this.target == null) {
			BlockPos next = this.nextLog(agent);
			if (next == null) {
				if (this.climb != null) {
					// The tree is down as far as it goes: off the pillar first.
					this.climb.descend();
					return Tick.WORKING;
				}
				this.treeDone(agent);
				return Tick.WORKING;
			}
			this.setTarget(level, next);
		}
		BlockPos t = this.target;
		if (Protection.check(level, t, agent.agentId()) != null) {
			// Became protected (a zone was added, a player placed it again): never touch it.
			this.noteProtected(level, t);
			this.skipTarget();
			return Tick.WORKING;
		}
		// In reach only at the top of a jump (a pillar being built) is not in reach yet: let the walk or climb finish. The
		// block under the feet is never mined (no digging straight down): the walk steps aside first.
		boolean ready = Walk.inReach(agent, t) && !Walk.standsOn(agent, t) && (Walk.settled(agent) || this.climb == null && !agent.navigator().isMoving());
		if (!ready) {
			return this.approach(agent, t);
		}
		this.walk.stop(agent);
		agent.controls().setJumping(false);
		Trees.Tree current = this.tree;
		if (current != null) {
			// Got there: from now on this tree's logs fail one by one, like any other tree's.
			this.digOnly.remove(current.base());
		}
		this.walkFailsInARow = 0;
		BlockState state = level.getBlockState(t);
		if (BlockOps.wouldDropNothing(agent, state)) {
			this.toolNeededFor = state;
			return this.failed("NEEDS_TOOL", "breaking " + Refs.blockId(state.getBlock()) + " drops nothing without the right tool");
		}
		if (++this.mineTicks > 20 * 30) {
			this.skipTarget();
			return Tick.WORKING;
		}
		if (BlockOps.mineTick(agent, t)) {
			this.logMined(t);
			this.target = null;
		}
		return Tick.WORKING;
	}

	private void setTarget(final ServerLevel level, final BlockPos log) {
		this.target = log.immutable();
		this.targetId = Refs.blockId(level.getBlockState(log).getBlock());
		this.mineTicks = 0;
		this.walk.reset();
	}

	private void logMined(final BlockPos log) {
		this.mined++;
		this.countBlock(log);
		this.deferred.remove(log);
		this.skip.remove(log);
		this.leftHigh.remove(log);
	}

	/** Gets {@code t} into reach: from the climb under way, a new climb (a high log), or a Tier-2 walk. */
	private Tick approach(final AgentPlayer agent, final BlockPos t) {
		Trees.Tree tr = this.tree;
		if (tr == null) {
			return Tick.WORKING;
		}
		TreeClimb c = this.climb;
		if (c != null) {
			if (!c.serves(agent, t)) {
				// Out of this column's reach (a low branch to the side): down first, then walk to it.
				c.descend();
				return Tick.WORKING;
			}
			return switch (c.tick(agent, t)) {
				case WORKING, REACHED -> Tick.WORKING;
				case HEAD_LOG -> {
					BlockPos head = c.headLog();
					if (head != null) {
						this.skip.remove(head);
						this.deferred.remove(head);
						this.setTarget(agent.level(), head);
					}
					yield Tick.WORKING;
				}
				case STOPPED -> this.climbStopped(agent, t, c);
				case DONE -> {
					this.climb = null;
					yield Tick.WORKING;
				}
			};
		}
		int stump = tr.base().getY();
		int limit = this.noClimb ? 0 : TreeClimb.limit(agent);
		if (t.getY() > stump + Math.max(TIER2_HIGH, limit == 0 ? 0 : TreeClimb.highestReachable(0, limit))) {
			// Higher than any climb or Tier-2 pillar reaches: no search (each such search ran out at 20 000 nodes).
			debug(agent, "left_high", "log", t.toShortString(), "why", "beyond_any_climb", "limit", limit);
			this.leftHigh(t);
			return Tick.WORKING;
		}
		boolean high = t.getY() > stump + GROUND_REACH;
		if (high && this.startClimb(agent, t)) {
			return Tick.WORKING;
		}
		if (high && (t.getY() > stump + TIER2_HIGH || NavBlocks.scaffoldCount(agent.getInventory()) == 0)) {
			// No column to climb, and no Tier-2 pillar gets there either.
			debug(agent, "left_high", "log", t.toShortString(), "why", "no_column");
			this.leftHigh(t);
			return Tick.WORKING;
		}
		// Tier 2 straight away ("reach a block to mine"): digs, pillars and bridges where no walk leads.
		Walk.State s = this.walk.toMine(agent, t);
		if (s != Walk.State.FAILED) {
			return Tick.WORKING;
		}
		return this.walkFailed(agent, t);
	}

	/** Plans a climb to {@code t} (once per log); true when one is under way. */
	private boolean startClimb(final AgentPlayer agent, final BlockPos t) {
		Trees.Tree tr = this.tree;
		if (tr == null || this.noClimb || this.climbs >= MAX_CLIMBS_PER_TREE || TreeClimb.limit(agent) == 0 || !this.climbTried.add(t)) {
			return false;
		}
		TreeClimb plan = TreeClimb.plan(agent, tr, t, this.remainingLogs(agent.level(), agent), this.walk, this.pillar, this.dug, this.scaffoldDrops,
			() -> this.pillarsBuilt++);
		if (plan == null) {
			debug(agent, "climb_none", "log", t.toShortString());
			return false;
		}
		debug(agent, "climb", "log", t.toShortString(), "plan", plan.describe());
		this.walk.stop(agent);
		this.climb = plan;
		this.climbs++;
		return true;
	}

	/** The climb cannot bring {@code t} into reach. */
	private Tick climbStopped(final AgentPlayer agent, final BlockPos t, final TreeClimb c) {
		String why = c.stopReason();
		debug(agent, "climb_stop", "why", why, "log", t.toShortString(), "at", agent.blockPosition().toShortString());
		if (TreeClimb.fatal(why)) {
			c.descend();
			if ("low_health".equals(why) || "hazard".equals(why)) {
				this.noClimb = true;
			}
		}
		if ("no_scaffold".equals(why)) {
			// Nothing to pillar with and no dirt around: no climb on this tree will do better.
			this.noClimb = true;
		}
		if ("no_way".equals(why)) {
			// The column was out of reach: as a failed walk (a dig-only tree is unreachable after all).
			return this.walkFailed(agent, t);
		}
		if ("below".equals(why)) {
			// Below the pillar's top and out of reach: down, then a walk.
			c.descend();
			return Tick.WORKING;
		}
		if ("off_column".equals(why) || "hurt".equals(why)) {
			// Knocked off its column, or hurt on the way up: no fault of the log's. It may get a new climb (from another
			// column, as high as the health allows now), within the tree's climbs.
			this.climbTried.remove(t);
			this.target = null;
			return Tick.WORKING;
		}
		this.leftHigh(t);
		return Tick.WORKING;
	}

	/** A walk to {@code t} found no way: another standpoint (a climb), else this log waits and the others go on. */
	private Tick walkFailed(final AgentPlayer agent, final BlockPos t) {
		Trees.Tree tr = this.tree;
		if (tr == null) {
			return Tick.WORKING;
		}
		if (this.digOnly.remove(tr.base())) {
			// No walk led there and Tier 2 found no way either: unreachable, like any tree no walk reaches.
			this.reject(agent, tr.base(), "unreachable", tr.species() + " tree");
			this.giveUpTree(agent);
			return Tick.WORKING;
		}
		if (this.failedLogs.add(t)) {
			// Once per log and try: its walk and its climb's walk failing count as one.
			this.walkFailsInARow++;
			this.walkFails++;
		}
		if (t.getY() > agent.getBlockY() && this.startClimb(agent, t)) {
			return Tick.WORKING;
		}
		this.target = null;
		debug(agent, "walk_failed", "log", t.toShortString(), "why", this.walk.failure(), "in_a_row", this.walkFailsInARow, "on_tree", this.walkFails,
			"then", this.retried.contains(t) ? "given_up" : "later");
		if (this.retried.contains(t)) {
			this.skip.add(t);
		} else {
			this.deferred.add(t);
		}
		if (this.walkFailsInARow >= MAX_WALK_FAILS_IN_A_ROW || this.walkFails >= MAX_WALK_FAILS_PER_TREE) {
			// Walled off from here: every further search would run out the same way.
			if (this.mined == this.treeStartMined) {
				this.reject(agent, tr.base(), "unreachable", tr.species() + " tree");
			}
			this.giveUpTree(agent);
		}
		return Tick.WORKING;
	}

	/** Gives up the logs of the tree still standing; its pillars, drops and holes are still seen to. */
	private void giveUpTree(final AgentPlayer agent) {
		Trees.Tree tr = this.tree;
		if (tr == null) {
			return;
		}
		ServerLevel level = agent.level();
		for (BlockPos log : tr.logs()) {
			if (this.match.test(level.getBlockState(log))) {
				this.skip.add(log);
			}
		}
		this.deferred.clear();
		this.target = null;
		debug(agent, "tree_given_up", "tree", tr.base().toShortString());
		TreeClimb c = this.climb;
		if (c != null && !c.descending()) {
			// Off the pillar first; the tree ends once down (no log is left to pick).
			c.descend();
			return;
		}
		if (c != null) {
			return;
		}
		this.treeDone(agent);
	}

	private void leftHigh(final BlockPos t) {
		this.leftHigh.add(t.immutable());
		this.skip.add(t);
		if (t.equals(this.target)) {
			this.target = null;
		}
	}

	/** The tree's logs still to fell, lowest first: not given up, not waiting for a second try, still logs, nobody's. */
	private List<BlockPos> remainingLogs(final ServerLevel level, final AgentPlayer agent) {
		List<BlockPos> out = new ArrayList<>();
		Trees.Tree tr = this.tree;
		if (tr == null) {
			return out;
		}
		for (BlockPos log : tr.logs()) {
			if (!this.skip.contains(log) && !this.deferred.contains(log) && this.match.test(level.getBlockState(log))
				&& Protection.check(level, log, agent.agentId()) == null) {
				out.add(log);
			}
		}
		return out;
	}

	/**
	 * The next log of the tree being felled: one in reach (lowest first), else the lowest one the climb under way serves,
	 * else the lowest. When only logs no walk reached are left, they get a second try. Null when none is left.
	 */
	private @Nullable BlockPos nextLog(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		List<BlockPos> left = this.remainingLogs(level, agent);
		if (left.isEmpty() && !this.deferred.isEmpty()) {
			// The rest is down: once more for the logs no walk reached (a face may be open now, the agent stands elsewhere).
			this.retried.addAll(this.deferred);
			this.deferred.clear();
			this.failedLogs.clear();
			this.walkFailsInARow = 0;
			left = this.remainingLogs(level, agent);
		}
		if (left.isEmpty()) {
			return null;
		}
		for (BlockPos log : left) {
			if (Walk.inReach(agent, log) && !Walk.standsOn(agent, log)) {
				return log;
			}
		}
		TreeClimb c = this.climb;
		if (c != null && !c.descending()) {
			for (BlockPos log : left) {
				if (c.serves(agent, log)) {
					return log;
				}
			}
		}
		return left.getFirst();
	}

	private void startTree(final Trees.Tree next) {
		this.tree = next;
		this.treeStartMined = this.mined;
		this.deferred.clear();
		this.retried.clear();
		this.climbTried.clear();
		this.failedLogs.clear();
		this.walkFailsInARow = 0;
		this.walkFails = 0;
		this.climbs = 0;
		this.noClimb = false;
	}

	/** Chores between trees: clear the pillars, pick up the drops, fill the holes, replant. Null when there are none. */
	private @Nullable Tick treeChores(final AgentPlayer agent) {
		if (this.tree != null) {
			return null;
		}
		ServerLevel level = agent.level();
		// The felling's pillars come down first. Those the sweep's own walks build (a short pillar to a drop on a ledge)
		// wait until it is done: clearing each at once would drop the body off it before it got there, over and over.
		if (!this.pillar.isEmpty() && !this.sweeping) {
			this.cleaning = true;
			BlockPos top = this.pillar.getLast();
			if (!NavBlocks.isScaffoldBlock(level.getBlockState(top))) {
				// Gone (or replaced by something that is no pillar block since): nothing of ours to clear there.
				this.pillar.removeLast();
				if (level.getBlockState(top).isAir()) {
					this.scaffoldDrops.add(top);
				}
				return Tick.WORKING;
			}
			if (!Walk.inReach(agent, top)) {
				Walk.State w = this.walk.toBlock(agent, top);
				if (w == Walk.State.MOVING) {
					return Tick.WORKING;
				}
				if (w == Walk.State.FAILED) {
					// No walk reaches its top: the column stays whole (scaffold, which navigation may break later), rather
					// than a block hanging in the air over the part that was cleared from below.
					debug(agent, "pillar_left", "at", top.toShortString(), "why", this.walk.failure());
					this.pillar.removeIf(p -> p.getX() == top.getX() && p.getZ() == top.getZ() && p.getY() <= top.getY());
					this.choreTicks = 0;
					return Tick.WORKING;
				}
			}
			boolean broke = BlockOps.mineTick(agent, top);
			if (broke || ++this.choreTicks > 20 * 20) {
				if (broke) {
					NavBlocks.forgetScaffold(level, top);
					this.scaffoldDrops.add(top);
				}
				this.pillar.removeLast();
				this.choreTicks = 0;
			}
			return Tick.WORKING;
		}
		if (this.cleaning) {
			this.cleaning = false;
			this.choreTicks = 0;
			agent.controls().stopMining();
		}
		if (!this.scaffoldDrops.isEmpty()) {
			// The cleared blocks' drops: the dirt goes back into the holes it came from.
			BlockPos at = this.scaffoldDrops.getLast();
			ItemEntity drop = ++this.choreTicks <= 20 * 3 ? nearestItem(agent, Vec3.atCenterOf(at), 3.0, NavBlocks::isScaffoldItem) : null;
			if (drop != null && safeToFetch(drop)) {
				if (agent.position().distanceTo(drop.position()) > 0.6) {
					this.walk.toItem(agent, drop.position());
				}
				return Tick.WORKING;
			}
			this.scaffoldDrops.removeLast();
			this.choreTicks = 0;
			return Tick.WORKING;
		}
		if (this.sweepTick(agent)) {
			this.sweeping = true;
			return Tick.WORKING;
		}
		if (this.sweeping) {
			this.sweeping = false;
			if (!this.pillar.isEmpty()) {
				return Tick.WORKING;
			}
		}
		// The holes last: the scaffold is back in the bag by now (a sweep may still need it for a log on a ledge).
		if (this.refillTick(agent)) {
			return Tick.WORKING;
		}
		if (this.replantAt != null) {
			BlockPos at = this.replantAt;
			Item item = this.sapling;
			if (item == null || Inv.count(agent, item) == 0 || !level.getBlockState(at).isAir() || ++this.choreTicks > 20 * 15) {
				this.replantAt = null;
				this.choreTicks = 0;
				return Tick.WORKING;
			}
			if (!Walk.inReach(agent, at) && this.walk.toBlock(agent, at) == Walk.State.MOVING) {
				return Tick.WORKING;
			}
			BlockOps.Place r = BlockOps.placeTick(agent, at, s -> s.is(item));
			if (r == BlockOps.Place.PLACED) {
				this.replanted++;
				this.replantAt = null;
				this.choreTicks = 0;
			} else if (r == BlockOps.Place.SELF_IN_WAY) {
				WorldJobs.stepAside(agent, at, this.walk);
			} else if (r != BlockOps.Place.RETRY) {
				this.replantAt = null;
			}
			return Tick.WORKING;
		}
		return null;
	}

	private void treeDone(final AgentPlayer agent) {
		Trees.Tree t = this.tree;
		this.tree = null;
		this.target = null;
		this.climb = null;
		if (t == null) {
			return;
		}
		this.doneTrees.add(t.base());
		int n = this.mined - this.treeStartMined;
		debug(agent, "tree_done", "tree", t.base().toShortString(), "mined", n, "of", t.logs().size(), "left_high", this.leftHigh.size(), "pillar",
			this.pillar.size(), "holes", this.dug.size());
		if (n > 0) {
			this.treesFelled++;
			this.sources.put("tree@" + t.base().toShortString(), new Source("tree", t.species(), t.base(), n));
		}
		this.deferred.clear();
		agent.controls().setJumping(false);
		this.choreTicks = 0;
		if (n > 0) {
			// Every drop in and under the crown, not only by the stump: a big tree keeps most of them in its leaves.
			int x0 = Integer.MAX_VALUE;
			int x1 = Integer.MIN_VALUE;
			int z0 = Integer.MAX_VALUE;
			int z1 = Integer.MIN_VALUE;
			int y1 = Integer.MIN_VALUE;
			for (BlockPos p : t.logs()) {
				x0 = Math.min(x0, p.getX());
				x1 = Math.max(x1, p.getX());
				z0 = Math.min(z0, p.getZ());
				z1 = Math.max(z1, p.getZ());
				y1 = Math.max(y1, p.getY());
			}
			int y0 = t.base().getY();
			this.sweepBox = new AABB(x0 - SWEEP_MARGIN, y0 - SWEEP_MARGIN, z0 - SWEEP_MARGIN, x1 + 1 + SWEEP_MARGIN, y1 + 1 + SWEEP_MARGIN, z1 + 1 + SWEEP_MARGIN);
			this.sweepTicks = Math.min(20 * 60, 20 * 10 + 30 * n);
			this.sweepStumpY = y0;
			this.sweepItem = null;
			this.sweepLeaf = null;
		}
		if (this.replant) {
			Item s = saplingOf(t.species());
			BlockState below = agent.level().getBlockState(t.base().below());
			if (s != null && (below.is(Blocks.DIRT) || below.is(Blocks.GRASS_BLOCK) || below.is(Blocks.PODZOL)
				|| below.is(Blocks.COARSE_DIRT) || below.is(Blocks.ROOTED_DIRT) || below.is(Blocks.MUD) || below.is(Blocks.MOSS_BLOCK))) {
				// The sapling may still come with the drops: checked when it is time to plant.
				this.sapling = s;
				this.replantAt = t.base();
			}
		}
	}

	/**
	 * One tick of picking up a felled tree's logs (and its sapling, to replant) anywhere in and under its crown. A
	 * drop caught in the canopy is not climbed to: the leaf under it is broken (leaves are natural and break at once),
	 * so it falls, and is picked up below. A drop no walk reaches (inside a block) is left. False once none is left or
	 * the time is up.
	 */
	private boolean sweepTick(final AgentPlayer agent) {
		AABB box = this.sweepBox;
		if (box == null) {
			return false;
		}
		ServerLevel level = agent.level();
		ItemEntity item = this.sweepItem;
		if (this.sweepTicks-- <= 0) {
			debug(agent, "sweep_end", "why", "time", "left", this.nextSweepItem(agent, box) != null);
			this.endSweep(agent);
			return false;
		}
		if (item == null || !item.isAlive() || this.sweepIgnored.contains(item) || !box.contains(item.position())) {
			item = this.nextSweepItem(agent, box);
			this.sweepItem = item;
			this.sweepLeaf = null;
			this.sweepItemTicks = 0;
			this.walk.reset();
			if (item == null) {
				this.endSweep(agent);
				return false;
			}
		}
		if (++this.sweepItemTicks > 20 * 20) {
			this.ignoreSweepItem(agent, item);
			return true;
		}
		BlockPos leaf = this.sweepLeaf;
		if (leaf != null && !Trees.isNaturalLeaf(level.getBlockState(leaf))) {
			agent.controls().stopMining();
			leaf = null;
			this.sweepLeaf = null;
		}
		if (leaf == null && item.getY() - this.sweepStumpY > CANOPY_DROP) {
			BlockPos under = BlockPos.containing(item.getX(), item.getY() - 0.1, item.getZ());
			BlockState s = level.getBlockState(under);
			if (Trees.isNaturalLeaf(s) && NavBlocks.mayBreak(level, under, s, agent.agentId())) {
				leaf = under;
				this.sweepLeaf = under;
			}
		}
		if (leaf != null) {
			if (!Walk.inReach(agent, leaf) || !Walk.settled(agent)) {
				if (this.walk.toMine(agent, leaf) == Walk.State.FAILED) {
					this.ignoreSweepItem(agent, item);
				}
				return true;
			}
			this.walk.stop(agent);
			if (BlockOps.mineTick(agent, leaf)) {
				agent.controls().stopMining();
				this.sweepLeaf = null;
			}
			return true;
		}
		if (agent.position().distanceTo(item.position()) > 0.6 && this.walk.toItem(agent, item.position()) == Walk.State.FAILED) {
			this.ignoreSweepItem(agent, item);
		}
		return true;
	}

	/**
	 * The nearest drop worth fetching: a log the miner takes, the sapling it will plant, or dirt while holes dug for
	 * scaffold wait to be filled (a pillar block's drop that bounced past the 3 blocks looked at when it was mined left a
	 * hole open). Sticks, apples and other saplings are left to the pickup reflex (chasing them through a crown breaks
	 * more leaves, which drop more).
	 */
	private @Nullable ItemEntity nextSweepItem(final AgentPlayer agent, final AABB box) {
		Item plant = this.replantAt != null ? this.sapling : null;
		boolean fill = !this.dug.isEmpty();
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, box,
			e -> e.isAlive() && !this.sweepIgnored.contains(e) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem()) && safeToFetch(e)
				&& (e.getItem().getItem() instanceof BlockItem b && this.match.test(b.getBlock().defaultBlockState()) || plant != null && e.getItem().is(plant)
					|| fill && TreeClimb.isDirtItem(e.getItem())));
		return items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
	}

	/**
	 * A drop worth walking to: not fallen under the ground (into a cave: a walk after it can end in a water pocket with no
	 * air above), nor in water with a roof. Under ground means ground over it: a solid block within 6 above that is no
	 * leaf, log or scaffold. A drop on a hillside below the stump, in a canopy or floating in an open pond is fine.
	 */
	private static boolean safeToFetch(final ItemEntity e) {
		if (!(e.level() instanceof ServerLevel level)) {
			return false;
		}
		BlockPos.MutableBlockPos p = e.blockPosition().mutable();
		if (e.isInWater()) {
			// Floating in open water (air right over the surface) is fine to swim to; water with a roof is not.
			BlockPos.MutableBlockPos up = p.mutable();
			boolean open = false;
			for (int i = 0; i < 3 && !open; i++) {
				up.move(net.minecraft.core.Direction.UP);
				BlockState s = level.getBlockState(up);
				open = s.getFluidState().isEmpty() && s.getCollisionShape(level, up).isEmpty();
			}
			if (!open) {
				return false;
			}
		}
		for (int i = 0; i < 6; i++) {
			p.move(net.minecraft.core.Direction.UP);
			BlockState s = level.getBlockState(p);
			if (!s.getCollisionShape(level, p).isEmpty() && !s.is(net.minecraft.tags.BlockTags.LEAVES) && !s.is(net.minecraft.tags.BlockTags.LOGS)
				&& !NavBlocks.isScaffold(level, p, s)) {
				return false;
			}
		}
		return true;
	}

	private void ignoreSweepItem(final AgentPlayer agent, final ItemEntity item) {
		debug(agent, "drop_left", "item", item.getItem(), "at", item.blockPosition().toShortString(), "why", this.walk.failure());
		this.sweepIgnored.add(item);
		this.sweepItem = null;
		this.sweepLeaf = null;
		agent.controls().stopMining();
		this.walk.stop(agent);
	}

	private void endSweep(final AgentPlayer agent) {
		this.sweepBox = null;
		this.sweepItem = null;
		this.sweepLeaf = null;
		agent.controls().stopMining();
		this.walk.stop(agent);
	}

	/** One tick of filling the holes dug for scaffold with dirt (natural ground again, nobody's); false when done. */
	private boolean refillTick(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		while (!this.dug.isEmpty()) {
			BlockPos hole = this.dug.getLast();
			BlockState s = level.getBlockState(hole);
			boolean open = s.isAir() || s.canBeReplaced() && s.getFluidState().isEmpty();
			if (!open || !NavBlocks.isFloor(level, hole.below(), level.getBlockState(hole.below())) || Inv.count(agent, TreeClimb::isDirtItem) == 0
				|| Protection.checkZoneCell(level, hole, agent.agentId()) != null) {
				if (open) {
					debug(agent, "hole_left", "at", hole.toShortString(), "dirt", Inv.count(agent, TreeClimb::isDirtItem));
				}
				this.dug.removeLast();
				this.choreTicks = 0;
				continue;
			}
			if (++this.choreTicks > 20 * 10) {
				debug(agent, "hole_left", "at", hole.toShortString(), "why", "timeout");
				this.dug.removeLast();
				this.choreTicks = 0;
				return true;
			}
			if (!Walk.inReach(agent, hole) || !Walk.settled(agent)) {
				if (this.walk.toBlock(agent, hole) == Walk.State.FAILED) {
					debug(agent, "hole_left", "at", hole.toShortString(), "why", this.walk.failure());
					this.dug.removeLast();
					this.choreTicks = 0;
				}
				return true;
			}
			this.walk.stop(agent);
			BlockOps.Place r = BlockOps.placeTick(agent, hole, TreeClimb::isDirtItem);
			if (r == BlockOps.Place.PLACED) {
				// The ground as it was: natural, nobody's build.
				Provenance.unmark(level, hole);
				this.dug.removeLast();
				this.choreTicks = 0;
			} else if (r == BlockOps.Place.SELF_IN_WAY) {
				WorldJobs.stepAside(agent, hole, this.walk);
			} else if (r != BlockOps.Place.RETRY) {
				this.dug.removeLast();
				this.choreTicks = 0;
			}
			return true;
		}
		return false;
	}

	/** The nearest natural tree around the centre that the agent can walk to, or null. */
	private Trees.@Nullable Tree pickTree(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos from = this.center != null ? this.center : agent.blockPosition();
		List<BlockPos> logs = BlockScan.nearest(level, from, this.radius, this.match, p -> !this.skip.contains(p), 96);
		List<Trees.Tree> trees = new ArrayList<>();
		Set<BlockPos> covered = new HashSet<>();
		for (BlockPos p : logs) {
			if (covered.contains(p)) {
				continue;
			}
			// The whole cluster at once: a log cabin is searched once, not once per log.
			Trees.Cluster c = Trees.clusterAt(level, p);
			covered.add(p);
			covered.addAll(c.logs());
			Trees.Tree t = c.tree();
			if (t == null) {
				BlockPos prot = null;
				if ("protected".equals(c.notTree()) || "placed".equals(c.notTree())) {
					for (BlockPos log : c.logs()) {
						if (Protection.isProtected(level, log)) {
							prot = log;
							break;
						}
					}
				}
				if (prot != null) {
					this.noteProtected(level, prot);
				} else {
					this.reject(agent, p, "not_natural", null);
				}
				continue;
			}
			if (!this.doneTrees.contains(t.base())) {
				trees.add(t);
			}
		}
		trees.sort(Comparator.comparingDouble(t -> t.base().distSqr(agent.blockPosition())));
		int checks = 0;
		Trees.Tree unknown = null;
		Trees.Tree noWalk = null;
		for (Trees.Tree t : trees) {
			Reach.Result r = this.reachable.get(t.base());
			if (r == null) {
				if (checks >= MAX_REACH_CHECKS) {
					break;
				}
				checks++;
				r = Reach.walkTo(agent, t.base());
				this.reachable.put(t.base(), r);
			}
			if (r == Reach.Result.YES) {
				return t;
			}
			if (r == Reach.Result.NO) {
				if (AgentNavigator.tier2Enabled) {
					// No walking way (a hill, a gap, an office sunk into the ground): the mine walk may still dig there.
					if (noWalk == null) {
						noWalk = t;
					}
					continue;
				}
				this.reject(agent, t.base(), "unreachable", t.species() + " tree");
				this.doneTrees.add(t.base());
			} else if (unknown == null) {
				unknown = t;
			}
		}
		if (unknown != null) {
			// Too far for one search: walk there and see.
			this.reachable.put(unknown.base(), Reach.Result.YES);
			return unknown;
		}
		if (noWalk != null) {
			// The nearest tree no walk leads to: Tier 2 may dig, pillar or bridge there (an office sunk into a hill, a
			// ledge, a gap). If it finds no way either, the tree is reported unreachable like the others.
			this.reachable.put(noWalk.base(), Reach.Result.YES);
			this.digOnly.add(noWalk.base());
			return noWalk;
		}
		return null;
	}

	static @Nullable Item saplingOf(final String species) {
		for (String id : new String[] {species + "_sapling", species + "_propagule", species + "_fungus"}) {
			Identifier key = Identifier.withDefaultNamespace(id);
			if (BuiltInRegistries.ITEM.containsKey(key)) {
				return BuiltInRegistries.ITEM.getValue(key);
			}
		}
		return null;
	}

	// ---------------------------------------------------------------- reporting

	private void reject(final AgentPlayer agent, final BlockPos pos, final String why, final @Nullable String what) {
		if (this.rejected.containsKey(pos) || this.rejected.size() >= 32) {
			return;
		}
		String block = what != null ? what : Refs.blockId(agent.level().getBlockState(pos).getBlock()).replace("minecraft:", "");
		this.rejected.put(pos, new Sources.Candidate(pos, block, Compass.distance(agent.blockPosition(), pos), Compass.dir(agent.blockPosition(), pos), why, null));
	}

	/**
	 * What the miner saw but could not use, nearest first: unreachable trees, logs that are no tree, protected blocks,
	 * and natural sources beyond the radius (one more scan, up to 64 blocks).
	 */
	public List<Sources.Candidate> candidates(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		List<Sources.Candidate> out = new ArrayList<>(this.rejected.values());
		for (Protection.Verdict v : this.protectedSeen) {
			out.add(new Sources.Candidate(v.pos(), v.block().replace("minecraft:", ""), Compass.distance(agent.blockPosition(), v.pos()),
				Compass.dir(agent.blockPosition(), v.pos()), "protected", v.owner()));
		}
		BlockPos from = this.center != null ? this.center : agent.blockPosition();
		int far = Math.min(64, this.radius + 40);
		if (far > this.radius) {
			long r2 = (long)this.radius * this.radius;
			List<BlockPos> beyond = BlockScan.nearest(level, from, far, this.match, p -> p.distSqr(from) > r2 && !Protection.isProtected(level, p), 48);
			if (this.treeMode()) {
				for (Trees.Tree t : Trees.treesOf(level, beyond, 2)) {
					out.add(new Sources.Candidate(t.base(), t.species() + " tree", Compass.distance(agent.blockPosition(), t.base()),
						Compass.dir(agent.blockPosition(), t.base()), "too_far", null));
				}
			} else if (!beyond.isEmpty()) {
				BlockPos p = beyond.getFirst();
				out.add(new Sources.Candidate(p, Refs.blockId(level.getBlockState(p).getBlock()).replace("minecraft:", ""),
					Compass.distance(agent.blockPosition(), p), Compass.dir(agent.blockPosition(), p), "too_far", null));
			}
		}
		out.sort(Comparator.comparingInt(Sources.Candidate::distance));
		// Keep a few of each kind, nearest first.
		List<Sources.Candidate> kept = new ArrayList<>();
		Map<String, Integer> perWhy = new HashMap<>();
		for (Sources.Candidate c : out) {
			if (kept.size() >= MAX_CANDIDATES) {
				break;
			}
			if (perWhy.merge(c.why(), 1, Integer::sum) <= 3) {
				kept.add(c);
			}
		}
		return kept;
	}

	// ---------------------------------------------------------------- helpers

	/** A line about tree felling with {@code MINEVIBE_NAV_DEBUG=1} (how the acceptance runs are diagnosed). */
	static void debug(final AgentPlayer agent, final String what, final Object... kv) {
		if (NavDebug.ENABLED) {
			NavDebug.log(agent.agentId(), what, kv);
		}
	}

	private void skipTarget() {
		if (this.target != null) {
			this.skip.add(this.target);
		}
		this.target = null;
	}

	private Tick failed(final String code, final String msg) {
		this.failureCode = code;
		this.failure = msg;
		return Tick.FAILED;
	}

	/**
	 * Walks to the nearest pickable item entity within {@code radius} of {@code at} that matches {@code what}. Returns
	 * false when there is none left (the agent picks items up by touching them, like a player).
	 */
	public static boolean collectNear(final AgentPlayer agent, final Walk walk, final BlockPos at, final double radius, final Predicate<ItemStack> what) {
		ItemEntity item = nearestItem(agent, Vec3.atCenterOf(at), radius, what);
		if (item == null) {
			return false;
		}
		if (agent.position().distanceTo(item.position()) > 0.6) {
			walk.toItem(agent, item.position());
		}
		return true;
	}

	public static @Nullable ItemEntity nearestItem(final AgentPlayer agent, final Vec3 at, final double radius, final Predicate<ItemStack> what) {
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, new AABB(at, at).inflate(radius),
			e -> e.isAlive() && what.test(e.getItem()) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem()));
		return items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
	}
}
