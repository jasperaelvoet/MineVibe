package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.perception.Compass;
import dev.minevibe.agent.perception.Reach;
import dev.minevibe.agent.perception.Sources;
import dev.minevibe.agent.perception.Trees;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.world.provenance.Protection;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
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
 *       quick A* per tree) is felled whole, bottom-up. Logs above reach are reached by stepping into the cut trunk,
 *       then by pillaring up at most {@value #MAX_PILLAR} blocks (with dirt or cobblestone in the bag); the pillar is
 *       mined away afterwards. Drops are picked up when the tree is done, and a sapling of the same kind is planted
 *       on the stump when asked ({@code replant}).</li>
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
	private static final int TREE_COLLECT_TICKS = 100;
	private static final int MAX_PILLAR = 2;
	private static final int MAX_REACH_CHECKS = 6;
	private static final int MAX_CANDIDATES = 8;

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
	private double collectRadius = 5.0;
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
	private final Map<BlockPos, Reach.Result> reachable = new HashMap<>();
	private int treesFelled;
	private int logsLeftHigh;
	private final List<BlockPos> pillar = new ArrayList<>();
	private @Nullable BlockPos pillarFrom;
	private int climbTicks;
	private boolean triedColumn;
	private boolean climbing;
	private boolean finishedJustNow;
	private @Nullable BlockPos pendingCollect;
	private boolean cleaning;
	private @Nullable BlockPos replantAt;
	private @Nullable Item sapling;
	private int replanted;
	private int pillarsBuilt;

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
		return this.logsLeftHigh;
	}

	/** True while a tree is half felled (or its pillar not yet cleared): the job should let it finish. */
	public boolean busy() {
		return this.tree != null || !this.pillar.isEmpty() || this.cleaning || this.pendingCollect != null || this.replantAt != null
			|| this.treeMode() && this.collectAt != null;
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
		this.climbTicks = 0;
	}

	/** Only picks up the drops of the last broken block; false once there are none left (or it gave up). */
	public boolean collecting(final AgentPlayer agent) {
		if (this.collectAt != null) {
			if (this.collectTicks-- > 0 && collectNear(agent, this.walk, this.collectAt, this.collectRadius, s -> true)) {
				return true;
			}
			this.collectAt = null;
		}
		return false;
	}

	public Tick tick(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (this.collecting(agent)) {
			return Tick.WORKING;
		}
		if (this.target != null && !this.match.test(level.getBlockState(this.target))) {
			// Broken by the held attack at the end of the last tick (or by someone else while we hit it).
			if (this.mineTicks > 0) {
				this.mined++;
				this.countBlock(this.target);
				if (!this.treeMode()) {
					this.collectAt = this.target;
					this.collectTicks = COLLECT_TICKS;
				}
			}
			this.target = null;
			if (this.collecting(agent)) {
				return Tick.WORKING;
			}
		}
		if (this.target == null) {
			if (this.treeMode()) {
				Tick t = this.treeChores(agent);
				if (t != null) {
					return t;
				}
				this.target = this.nextTreeLog(agent);
				if (this.target == null && this.finishedJustNow) {
					// A tree was just finished: clear its pillar, pick up its logs and replant before the next one.
					this.finishedJustNow = false;
					return Tick.WORKING;
				}
			} else {
				this.target = this.nextBlock(agent);
			}
			if (this.target == null) {
				return Tick.NONE_LEFT;
			}
			this.targetId = Refs.blockId(level.getBlockState(this.target).getBlock());
			this.mineTicks = 0;
			this.walk.reset();
			this.triedColumn = false;
			this.climbTicks = 0;
		}
		BlockPos t = this.target;
		if (Protection.check(level, t, agent.agentId()) != null) {
			// Became protected (a zone was added, a player placed it again): never touch it.
			this.noteProtected(level, t);
			this.skipTarget();
			return Tick.WORKING;
		}
		if (!Walk.inReach(agent, t)) {
			if (this.climbing) {
				return this.climbToward(agent, t);
			}
			Walk.State s = this.walk.toBlock(agent, t);
			if (s == Walk.State.MOVING) {
				return Tick.WORKING;
			}
			if (s == Walk.State.FAILED) {
				if (this.treeMode() && this.tree != null && t.getY() > agent.getBlockY()) {
					// Stay on this tree: no more walking around under it (that would step off a pillar).
					this.climbing = true;
					return this.climbToward(agent, t);
				}
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
			if (!this.treeMode()) {
				this.collectAt = t;
				this.collectTicks = COLLECT_TICKS;
			}
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

	/** The next log of the tree being felled, or of the nearest reachable natural tree; null when none is left. */
	private @Nullable BlockPos nextTreeLog(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		for (int attempts = 0; attempts < 16; attempts++) {
			if (this.tree != null) {
				for (BlockPos log : this.tree.logs()) {
					if (!this.skip.contains(log) && this.match.test(level.getBlockState(log)) && Protection.check(level, log, agent.agentId()) == null) {
						return log;
					}
				}
				this.treeDone(agent);
				return null;
			}
			Trees.Tree next = this.pickTree(agent);
			if (next == null) {
				return null;
			}
			this.tree = next;
			this.treeStartMined = this.mined;
		}
		return null;
	}

	/** Chores between logs: clear the pillar, pick up the drops, replant. Null when there are none. */
	private @Nullable Tick treeChores(final AgentPlayer agent) {
		if (this.tree != null) {
			return null;
		}
		if (!this.pillar.isEmpty()) {
			this.cleaning = true;
			BlockPos top = this.pillar.getLast();
			if (agent.level().getBlockState(top).isAir()) {
				this.pillar.removeLast();
				return Tick.WORKING;
			}
			if (!Walk.inReach(agent, top) && this.walk.toBlock(agent, top) == Walk.State.MOVING) {
				return Tick.WORKING;
			}
			if (BlockOps.mineTick(agent, top) || ++this.climbTicks > 20 * 20) {
				this.pillar.removeLast();
				this.climbTicks = 0;
			}
			return Tick.WORKING;
		}
		if (this.cleaning) {
			this.cleaning = false;
			agent.controls().stopMining();
		}
		if (this.pendingCollect != null) {
			// Back on the ground: pick up the tree's logs (they fell around the stump).
			this.collectAt = this.pendingCollect;
			this.collectRadius = 5.0;
			this.collectTicks = TREE_COLLECT_TICKS;
			this.pendingCollect = null;
			return Tick.WORKING;
		}
		if (this.replantAt != null) {
			BlockPos at = this.replantAt;
			Item item = this.sapling;
			if (item == null || Inv.count(agent, item) == 0 || !agent.level().getBlockState(at).isAir() || ++this.climbTicks > 20 * 15) {
				this.replantAt = null;
				this.climbTicks = 0;
				return Tick.WORKING;
			}
			if (!Walk.inReach(agent, at) && this.walk.toBlock(agent, at) == Walk.State.MOVING) {
				return Tick.WORKING;
			}
			BlockOps.Place r = BlockOps.placeTick(agent, at, s -> s.is(item));
			if (r == BlockOps.Place.PLACED) {
				this.replanted++;
				this.replantAt = null;
				this.climbTicks = 0;
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
		if (t == null) {
			return;
		}
		this.doneTrees.add(t.base());
		this.treesFelled++;
		this.sources.put("tree@" + t.base().toShortString(), new Source("tree", t.species(), t.base(), Math.max(0, this.mined - this.treeStartMined)));
		this.finishedJustNow = true;
		this.climbing = false;
		agent.controls().setJumping(false);
		this.pillarFrom = null;
		this.climbTicks = 0;
		this.pendingCollect = t.base();
		if (this.replant) {
			Item s = saplingOf(t.species());
			BlockState below = agent.level().getBlockState(t.base().below());
			if (s != null && Inv.count(agent, s) > 0 && (below.is(Blocks.DIRT) || below.is(Blocks.GRASS_BLOCK) || below.is(Blocks.PODZOL)
				|| below.is(Blocks.COARSE_DIRT) || below.is(Blocks.ROOTED_DIRT) || below.is(Blocks.MUD) || below.is(Blocks.MOSS_BLOCK))) {
				this.sapling = s;
				this.replantAt = t.base();
			}
		}
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
		return null;
	}

	/** A log above reach: step into the cut trunk, then pillar up; give the log up when neither helps. */
	private Tick climbToward(final AgentPlayer agent, final BlockPos log) {
		Trees.Tree t = this.tree;
		if (t == null) {
			this.skipTarget();
			return Tick.WORKING;
		}
		ServerLevel level = agent.level();
		if (log.getY() <= agent.getBlockY()) {
			// Not above us (a low branch out of reach): climbing does not help, walking might.
			this.climbing = false;
			agent.controls().setJumping(false);
			return Tick.WORKING;
		}
		BlockPos column = new BlockPos(t.base().getX(), agent.getBlockY(), t.base().getZ());
		boolean inColumn = agent.getBlockX() == column.getX() && agent.getBlockZ() == column.getZ();
		if (!inColumn && !this.triedColumn && level.getBlockState(column).isAir() && level.getBlockState(column.above()).isAir()) {
			Walk.State s = this.walk.to(agent, Vec3.atBottomCenterOf(column), 0.3);
			if (s == Walk.State.MOVING && ++this.climbTicks < 20 * 10) {
				return Tick.WORKING;
			}
			this.triedColumn = true;
			this.climbTicks = 0;
			this.walk.stop(agent);
			return Tick.WORKING;
		}
		if (this.pillar.size() >= MAX_PILLAR || !this.hasPillarBlock(agent)) {
			this.logsLeftHigh++;
			this.skipTarget();
			return Tick.WORKING;
		}
		return this.pillarStep(agent);
	}

	/** One tick of "jump and put a block under your feet". */
	private Tick pillarStep(final AgentPlayer agent) {
		if (++this.climbTicks > 20 * 6) {
			agent.controls().setJumping(false);
			this.pillarFrom = null;
			this.climbTicks = 0;
			this.logsLeftHigh++;
			this.skipTarget();
			return Tick.WORKING;
		}
		if (this.pillarFrom == null) {
			if (!agent.onGround()) {
				return Tick.WORKING;
			}
			this.pillarFrom = agent.blockPosition();
		}
		BlockPos at = this.pillarFrom;
		if (agent.getY() < at.getY() + 1.05) {
			agent.controls().setJumping(true);
			return Tick.WORKING;
		}
		agent.controls().setJumping(false);
		BlockOps.Place r = BlockOps.placeTick(agent, at, Miner::pillarBlock);
		if (r == BlockOps.Place.PLACED) {
			this.pillar.add(at);
			this.pillarsBuilt++;
			this.pillarFrom = null;
			this.climbTicks = 0;
		} else if (r != BlockOps.Place.RETRY && r != BlockOps.Place.SELF_IN_WAY) {
			this.pillarFrom = null;
			this.logsLeftHigh++;
			this.skipTarget();
		}
		return Tick.WORKING;
	}

	private boolean hasPillarBlock(final AgentPlayer agent) {
		return Inv.count(agent, Miner::pillarBlock) > 0;
	}

	/** Cheap full blocks for a pillar: dirt, cobblestone, cobbled deepslate, netherrack. */
	static boolean pillarBlock(final ItemStack s) {
		return s.is(Items.DIRT) || s.is(Items.COBBLESTONE) || s.is(Items.COBBLED_DEEPSLATE) || s.is(Items.NETHERRACK);
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
			walk.to(agent, item.position(), 0.5);
		}
		return true;
	}

	public static @Nullable ItemEntity nearestItem(final AgentPlayer agent, final Vec3 at, final double radius, final Predicate<ItemStack> what) {
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, new AABB(at, at).inflate(radius),
			e -> e.isAlive() && what.test(e.getItem()) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem()));
		return items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
	}
}
