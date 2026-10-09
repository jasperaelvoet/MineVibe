package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.perception.Sources;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Zones;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Gathering skills: {@code mine}, {@code collect}, {@code hunt}, {@code dig}, {@code pickup}. */
public final class GatherJobs {
	private GatherJobs() {
	}

	/**
	 * {@code mine{block, count, near?, radius?}}: break {@code count} matching blocks and pick up what they drop. Natural
	 * sources only (W1): a tag leaves out building variants, logs come from whole natural trees, and protected blocks
	 * (player-built, the Base) are never touched. Nothing natural in reach: {@code NO_NATURAL_SOURCE}; only protected
	 * matches (or {@code near} names a protected block): {@code PROTECTED}.
	 */
	public static final class Mine extends SkillJob {
		private final Refs.BlockMatcher block;
		private final Predicate<BlockState> match;
		private final int count;
		private final int radius;
		private final @Nullable BlockPos near;
		private final Miner miner;
		private Map<String, Integer> before = Map.of();

		public Mine(final Refs.BlockMatcher block, final int count, final @Nullable BlockPos near, final int radius) {
			super("mine");
			this.block = block;
			this.match = block.tag() != null ? Sources.naturalTag(block) : block;
			this.count = count;
			this.radius = radius;
			this.near = near;
			this.miner = new Miner(this.match, near, radius);
		}

		@Override
		protected int timeoutTicks() {
			return Math.min(30 * MINUTE, MINUTE + this.count * 30 * SECOND);
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.before = Inv.counts(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.miner.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.ticks == 1) {
				Status pre = this.precheck(agent);
				if (pre != null) {
					return pre;
				}
			}
			if (this.miner.mined() >= this.count && !this.miner.busy()) {
				// Let the last drops be picked up (the miner collects right after each break).
				return this.miner.collecting(agent) ? Status.RUNNING : this.finish(agent, false);
			}
			Miner.Tick t = this.miner.tick(agent);
			this.progress((double)Math.min(this.miner.mined(), this.count) / this.count, this.miner.mined() + "/" + this.count + " " + this.block.ref());
			return switch (t) {
				case WORKING -> Status.RUNNING;
				case NONE_LEFT -> this.finish(agent, true);
				case FAILED -> {
					this.finish(agent, false);
					yield this.fail(this.miner.failureCode(), this.miner.failure());
				}
			};
		}

		/** {@code near} on a protected block of the asked kind, or a tag of building variants only. */
		private @Nullable Status precheck(final AgentPlayer agent) {
			if (this.near != null && this.block.test(agent.level().getBlockState(this.near))) {
				Protection.Verdict v = Protection.check(agent.level(), this.near, agent.agentId());
				if (v != null) {
					this.put("mined", 0);
					return this.refuseProtected(agent, v, List.of(this.near));
				}
			}
			if (Sources.acceptsNothing(this.match)) {
				this.put("mined", 0);
				return this.noNaturalSource(agent, this.block.ref() + " (only building variants: craft them, or name the block)", this.radius, List.of());
			}
			return null;
		}

		private Status finish(final AgentPlayer agent, final boolean ranOut) {
			agent.controls().stopMining();
			this.put("mined", this.miner.mined());
			this.put("items", Inv.gained(this.before, Inv.counts(agent)));
			if (this.miner.treeMode()) {
				this.put("trees", this.miner.treesFelled());
				if (this.miner.logsLeftHigh() > 0) {
					this.put("logsLeftHigh", this.miner.logsLeftHigh());
				}
			}
			if (ranOut && this.miner.mined() < this.count) {
				return shortOfSources(this, agent, this.miner, this.block.ref(), this.radius);
			}
			return this.done();
		}
	}

	/** {@code mine} / {@code collect} found too little: {@code PROTECTED} when only protected blocks matched, else {@code NO_NATURAL_SOURCE}. */
	static Job.Status shortOfSources(final SkillJob job, final AgentPlayer agent, final Miner miner, final String what, final int radius) {
		List<Sources.Candidate> candidates = miner.candidates(agent);
		List<Protection.Verdict> prot = miner.protectedSeen();
		boolean onlyProtected = !prot.isEmpty() && candidates.stream().allMatch(c -> "protected".equals(c.why()));
		if (!miner.treeMode() && miner.mined() == 0 && onlyProtected) {
			List<BlockPos> positions = new ArrayList<>();
			for (Protection.Verdict v : prot) {
				positions.add(v.pos());
			}
			return job.refuseProtected(agent, prot.stream().min(Comparator.comparingDouble(v -> v.pos().distSqr(agent.blockPosition()))).orElseThrow(), positions);
		}
		return job.noNaturalSource(agent, what.replace("minecraft:", ""), radius, candidates);
	}

	/**
	 * {@code collect{item, count, radius?}}: end up with {@code count} more of an item: pick up loose items first, then
	 * break the blocks that drop it (logs for {@code oak_log}, stone for {@code cobblestone}, ores for raw metals).
	 */
	public static final class Collect extends SkillJob {
		private final Refs.ItemMatcher item;
		private final int count;
		private final int radius;
		private final boolean replant;
		private final @Nullable BlockPos near;
		private final boolean makeTools;
		private final @Nullable Predicate<BlockState> sources;
		/**
		 * Animals whose drops are the item (M2): beef and leather from cows, wool from sheep... Empty for most items. Known
		 * once the job starts (item components and tags are bound only in a running server).
		 */
		private Set<EntityType<?>> animals = Set.of();
		private final Walk walk = new Walk();
		private final Set<ItemEntity> ignored = new HashSet<>();
		private final ChildRunner toolMaker = new ChildRunner();
		private final List<String> toolsMade = new ArrayList<>();
		private final Map<String, Miner.Source> animalSources = new LinkedHashMap<>();
		private int lastLooks;
		private @Nullable Miner miner;
		private int startCount;
		private Map<String, Integer> before = Map.of();
		private @Nullable LivingEntity prey;
		private @Nullable Vec3 lastDeath;
		private int collectTicks;
		private boolean triedTool;
		private int skippedAnimals;

		public Collect(final Refs.ItemMatcher item, final int count, final int radius) {
			this(item, count, radius, false);
		}

		/** {@code replant}: plant a sapling of the same kind on each stump (when one is in the bag). */
		public Collect(final Refs.ItemMatcher item, final int count, final int radius, final boolean replant) {
			this(item, count, radius, replant, null, false);
		}

		/**
		 * The v2 gather (tools-v2-mc.md M2): {@code near} searches around a spot instead of the agent; {@code makeTools}
		 * crafts a tool the source needs from the inventory (the recipe tree, no gathering) instead of failing
		 * {@code NEEDS_TOOL}.
		 */
		public Collect(final Refs.ItemMatcher item, final int count, final int radius, final boolean replant, final @Nullable BlockPos near,
			final boolean makeTools) {
			super("collect");
			this.item = item;
			this.count = count;
			this.radius = radius;
			this.replant = replant;
			this.near = near;
			this.makeTools = makeTools;
			this.sources = sourcesOf(item);
		}

		@Override
		protected int timeoutTicks() {
			return Math.min(30 * MINUTE, MINUTE + this.count * 30 * SECOND);
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.startCount = Inv.count(agent, this.item);
			this.before = Inv.counts(agent);
			this.animals = animalsFor(this.item);
		}

		@Override
		public void onPreempt(final AgentPlayer agent) {
			super.onPreempt(agent);
			this.toolMaker.preempt(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
			this.toolMaker.resume(agent);
			if (this.miner != null) {
				this.miner.reset();
			}
		}

		@Override
		public void cancel(final AgentPlayer agent) {
			super.cancel(agent);
			this.toolMaker.cancel(agent, "cancelled");
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			int got = Inv.count(agent, this.item) - this.startCount;
			this.progress((double)Math.min(this.count, Math.max(0, got)) / this.count, Math.max(0, got) + "/" + this.count + " " + this.item.ref());
			if (this.toolMaker.active()) {
				return this.makeTool(agent);
			}
			if (this.lastDeath != null) {
				// The drops of an animal: picked up where it fell.
				if (this.collectTicks-- > 0 && Miner.collectNear(agent, this.walk, BlockPos.containing(this.lastDeath), 5.0, s -> true)) {
					return Status.RUNNING;
				}
				this.lastDeath = null;
			}
			boolean busy = this.miner != null && this.miner.busy();
			if (got >= this.count && !busy) {
				agent.controls().stopMining();
				this.report(agent, got);
				return this.done();
			}
			if (Inv.freeSlots(agent) == 0 && !Inv.hasRoomFor(agent, new ItemStack(this.item.item() != null ? this.item.item() : Items.STONE))) {
				this.report(agent, got);
				return this.fail("INVENTORY_FULL", "no room for more " + this.item.ref());
			}
			if (this.ticks == 1 && this.sources != null && this.animals.isEmpty() && Sources.acceptsNothing(this.sources)) {
				this.report(agent, got);
				return this.noNaturalSource(agent, this.item.ref() + " (not found in nature: craft it from what is)", this.radius, List.of());
			}
			// Loose items first (only while not in the middle of breaking a block or felling a tree).
			if (this.prey == null && (this.miner == null || this.miner.target() == null && !busy)) {
				ItemEntity loose = Miner.nearestItem(agent, agent.position(), Math.min(this.radius, 16), s -> this.item.test(s));
				if (loose != null && !this.ignored.contains(loose)) {
					if (agent.position().distanceTo(loose.position()) > 0.6 && this.walk.to(agent, loose.position(), 0.5) == Walk.State.FAILED) {
						this.ignored.add(loose);
					}
					return Status.RUNNING;
				}
			}
			if (this.sources == null) {
				if (!this.animals.isEmpty()) {
					return this.hunt(agent, got);
				}
				this.report(agent, got);
				return this.fail("NOT_FOUND", "no loose " + this.item.ref() + " nearby, and it is not dropped by any block MineVibe knows");
			}
			if (this.miner == null) {
				this.miner = new Miner(this.sources, this.near, this.radius, null, this.replant);
			}
			Miner.Tick t = this.miner.tick(agent);
			return switch (t) {
				case WORKING -> Status.RUNNING;
				case NONE_LEFT -> {
					if (Miner.nearestItem(agent, agent.position(), Math.min(this.radius, 16), s -> this.item.test(s)) != null && ++this.lastLooks < 200) {
						yield Status.RUNNING;
					}
					this.report(agent, got);
					if (got >= this.count) {
						yield this.done();
					}
					yield shortOfSources(this, agent, this.miner, this.item.ref(), this.radius);
				}
				case FAILED -> {
					if ("NEEDS_TOOL".equals(this.miner.failureCode()) && this.makeTools && !this.triedTool) {
						this.triedTool = true;
						BlockState needs = this.miner.toolNeededFor();
						Item tool = needs == null ? null : craftableToolFor(agent, needs);
						if (tool != null) {
							this.toolMaker.begin(agent, new CraftTreeJob(tool, 1, null, false));
							this.toolsMade.add(Refs.itemId(tool).replace("minecraft:", ""));
							yield Status.RUNNING;
						}
					}
					this.report(agent, got);
					yield this.fail(this.miner.failureCode(), this.miner.failure());
				}
			};
		}

		/** Runs the child craft of a missing tool; then mining starts over with it in the bag. */
		private Status makeTool(final AgentPlayer agent) {
			Status s = this.toolMaker.tick(agent);
			if (s == Status.RUNNING) {
				return Status.RUNNING;
			}
			SkillJob.Outcome o = this.toolMaker.last();
			if (o == null || !o.done()) {
				this.toolsMade.clear();
				this.report(agent, Inv.count(agent, this.item) - this.startCount);
				return this.fail("NEEDS_TOOL", (this.miner == null ? "" : this.miner.failure()) + "; making the tool failed: "
					+ (o == null ? "?" : o.code() + " " + o.message()));
			}
			this.miner = new Miner(this.sources, this.near, this.radius, null, this.replant);
			return Status.RUNNING;
		}

		/** Animals for drops (M2): the nearest one outside protected zones that is no pet, named, leashed or baby. */
		private Status hunt(final AgentPlayer agent, final int got) {
			if (this.prey != null && (!this.prey.isAlive() || this.prey.isRemoved())) {
				if (this.prey.isDeadOrDying()) {
					this.lastDeath = this.prey.position();
					this.collectTicks = 100;
					String what = Refs.entityTypeId(this.prey).replace("minecraft:", "");
					Miner.Source prev = this.animalSources.get(what);
					this.animalSources.put(what, prev == null ? new Miner.Source("animal", what, this.prey.blockPosition(), 1)
						: new Miner.Source("animal", what, prev.pos(), prev.n() + 1));
				}
				this.prey = null;
				return Status.RUNNING;
			}
			if (this.prey == null) {
				ServerLevel level = agent.level();
				BlockPos from = this.near != null ? this.near : agent.blockPosition();
				List<LivingEntity> found = level.getEntitiesOfClass(LivingEntity.class, new net.minecraft.world.phys.AABB(from).inflate(this.radius),
					e -> e.isAlive() && this.animals.contains(e.getType()));
				found.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
				this.skippedAnimals = 0;
				for (LivingEntity e : found) {
					if (Protection.isPetOrNamed(e) || e.isBaby() || e instanceof net.minecraft.world.entity.Leashable l && l.isLeashed()
						|| Zones.at(level, e.blockPosition()) != null) {
						this.skippedAnimals++;
						continue;
					}
					this.prey = e;
					this.walk.reset();
					break;
				}
				if (this.prey == null) {
					this.report(agent, got);
					String why = this.skippedAnimals > 0
						? " (" + this.skippedAnimals + " left alone: in the Base, pets, named, leashed or young)"
						: "";
					return this.noNaturalSource(agent, this.item.ref() + why, this.radius, List.of());
				}
			}
			if (!Fight.tick(agent, this.prey, this.walk)) {
				this.prey = null;
				this.report(agent, got);
				return this.fail("UNREACHABLE", "cannot reach the animal (" + this.walk.failure() + ")");
			}
			return Status.RUNNING;
		}

		private void report(final AgentPlayer agent, final int got) {
			this.put("item", this.item.item() != null ? Refs.itemId(this.item.item()) : this.item.ref());
			this.put("got", Math.max(0, got));
			this.put("collected", Math.max(0, got));
			this.put("have", Inv.count(agent, this.item));
			this.put("items", Inv.gained(this.before, Inv.counts(agent)));
			com.google.gson.JsonArray src = new com.google.gson.JsonArray();
			List<Miner.Source> all = new ArrayList<>(this.miner == null ? List.of() : this.miner.sources());
			all.addAll(this.animalSources.values());
			for (Miner.Source s : all) {
				com.google.gson.JsonObject o = new com.google.gson.JsonObject();
				o.addProperty("kind", s.kind());
				o.addProperty("what", s.what());
				o.add("pos", SkillJob.pos(s.pos()));
				o.addProperty("n", s.n());
				src.add(o);
			}
			this.put("sources", src);
			if (!this.toolsMade.isEmpty()) {
				this.put("tools_made", this.toolsMade);
			}
			if (this.miner != null && this.miner.treeMode()) {
				this.put("trees", this.miner.treesFelled());
				if (this.miner.replanted() > 0) {
					this.put("replanted", this.miner.replanted());
				}
				if (this.miner.pillarsBuilt() > 0) {
					this.put("pillared", this.miner.pillarsBuilt());
				}
				if (this.miner.logsLeftHigh() > 0) {
					this.put("logsLeftHigh", this.miner.logsLeftHigh());
				}
			}
		}
	}

	/**
	 * The best tool tier the agent can craft from its inventory (no gathering) that harvests {@code state}, or null:
	 * iron, then stone, then wooden.
	 */
	static @Nullable Item craftableToolFor(final AgentPlayer agent, final BlockState state) {
		String kind = state.is(BlockTags.MINEABLE_WITH_PICKAXE) ? "pickaxe"
			: state.is(BlockTags.MINEABLE_WITH_AXE) ? "axe"
			: state.is(BlockTags.MINEABLE_WITH_SHOVEL) ? "shovel"
			: state.is(BlockTags.MINEABLE_WITH_HOE) ? "hoe" : null;
		if (kind == null) {
			return null;
		}
		ServerLevel level = agent.level();
		RecipeTree.Stations stations = CraftTreeJob.stations(agent, null);
		for (String tier : List.of("iron", "stone", "wooden")) {
			Item tool = net.minecraft.core.registries.BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.withDefaultNamespace(tier + "_" + kind));
			if (tool == null || tool == Items.AIR || !new ItemStack(tool).isCorrectToolForDrops(state)) {
				continue;
			}
			RecipeTree.Plan plan = RecipeTree.plan(Recipes.book(level), tool, 1, Recipes.inventory(agent), stations);
			if (plan.complete()) {
				return tool;
			}
		}
		return null;
	}

	/** Animals whose drops are {@code item} (M2): meat, leather, wool, feathers. */
	static Set<EntityType<?>> animalsFor(final Refs.ItemMatcher item) {
		Set<EntityType<?>> out = new HashSet<>();
		java.util.function.BiConsumer<Item, EntityType<?>> add = (it, type) -> {
			if (item.test(new ItemStack(it))) {
				out.add(type);
			}
		};
		add.accept(Items.BEEF, net.minecraft.world.entity.EntityTypes.COW);
		add.accept(Items.LEATHER, net.minecraft.world.entity.EntityTypes.COW);
		add.accept(Items.PORKCHOP, net.minecraft.world.entity.EntityTypes.PIG);
		add.accept(Items.MUTTON, net.minecraft.world.entity.EntityTypes.SHEEP);
		if (item.item() != null && new ItemStack(item.item()).is(net.minecraft.tags.ItemTags.WOOL)
			|| item.tag() != null && item.tag().equals(net.minecraft.tags.ItemTags.WOOL)) {
			out.add(net.minecraft.world.entity.EntityTypes.SHEEP);
		}
		add.accept(Items.CHICKEN, net.minecraft.world.entity.EntityTypes.CHICKEN);
		add.accept(Items.FEATHER, net.minecraft.world.entity.EntityTypes.CHICKEN);
		add.accept(Items.RABBIT, net.minecraft.world.entity.EntityTypes.RABBIT);
		add.accept(Items.RABBIT_HIDE, net.minecraft.world.entity.EntityTypes.RABBIT);
		return out;
	}

	/**
	 * Blocks that drop {@code item} when mined: the item's own block (or a block tag of the same name), plus common
	 * drops. A tag leaves out building variants (stripped logs, wood, planks: W1), so {@code #minecraft:logs} means
	 * tree trunks.
	 */
	static @Nullable Predicate<BlockState> sourcesOf(final Refs.ItemMatcher item) {
		List<Predicate<BlockState>> out = new ArrayList<>();
		Refs.BlockMatcher self = item.asBlock();
		if (self != null) {
			// Planks, stripped logs and wood are made, not found: collecting them would take them out of buildings (W1).
			out.add(Sources.naturalTag(self));
		}
		if (item.item() != null) {
			Set<Block> extra = DROPS.getOrDefault(item.item(), Set.of());
			if (!extra.isEmpty()) {
				out.add(s -> extra.contains(s.getBlock()));
			}
		} else if (item.tag() != null && item.tag().location().getPath().equals("logs")) {
			out.add(Sources.naturalTag(s -> s.is(BlockTags.LOGS)));
		}
		if (out.isEmpty()) {
			return null;
		}
		return s -> {
			for (Predicate<BlockState> p : out) {
				if (p.test(s)) {
					return true;
				}
			}
			return false;
		};
	}

	/** Items whose block is not the item itself. */
	private static final Map<Item, Set<Block>> DROPS = Map.ofEntries(
		Map.entry(Items.COBBLESTONE, Set.of(Blocks.STONE, Blocks.COBBLESTONE)),
		Map.entry(Items.COBBLED_DEEPSLATE, Set.of(Blocks.DEEPSLATE, Blocks.COBBLED_DEEPSLATE)),
		Map.entry(Items.COAL, Set.of(Blocks.COAL_ORE, Blocks.DEEPSLATE_COAL_ORE)),
		Map.entry(Items.RAW_IRON, Set.of(Blocks.IRON_ORE, Blocks.DEEPSLATE_IRON_ORE)),
		Map.entry(Items.RAW_COPPER, Set.of(Blocks.COPPER_ORE, Blocks.DEEPSLATE_COPPER_ORE)),
		Map.entry(Items.RAW_GOLD, Set.of(Blocks.GOLD_ORE, Blocks.DEEPSLATE_GOLD_ORE)),
		Map.entry(Items.DIAMOND, Set.of(Blocks.DIAMOND_ORE, Blocks.DEEPSLATE_DIAMOND_ORE)),
		Map.entry(Items.EMERALD, Set.of(Blocks.EMERALD_ORE, Blocks.DEEPSLATE_EMERALD_ORE)),
		Map.entry(Items.REDSTONE, Set.of(Blocks.REDSTONE_ORE, Blocks.DEEPSLATE_REDSTONE_ORE)),
		Map.entry(Items.LAPIS_LAZULI, Set.of(Blocks.LAPIS_ORE, Blocks.DEEPSLATE_LAPIS_ORE)),
		Map.entry(Items.QUARTZ, Set.of(Blocks.NETHER_QUARTZ_ORE)),
		Map.entry(Items.FLINT, Set.of(Blocks.GRAVEL)),
		Map.entry(Items.CLAY_BALL, Set.of(Blocks.CLAY)),
		Map.entry(Items.GLOWSTONE_DUST, Set.of(Blocks.GLOWSTONE)),
		Map.entry(Items.WHEAT_SEEDS, Set.of(Blocks.SHORT_GRASS, Blocks.TALL_GRASS)),
		Map.entry(Items.SNOWBALL, Set.of(Blocks.SNOW_BLOCK)),
		Map.entry(Items.DIRT, Set.of(Blocks.DIRT, Blocks.GRASS_BLOCK, Blocks.PODZOL, Blocks.MYCELIUM)),
		Map.entry(Items.SAND, Set.of(Blocks.SAND)),
		Map.entry(Items.GRAVEL, Set.of(Blocks.GRAVEL))
	);

	/** {@code hunt{entity, count, radius?}}: chase and kill {@code count} mobs of a type, then pick up their drops. */
	public static final class Hunt extends SkillJob {
		private final EntityType<?> type;
		private final String ref;
		private final int count;
		private final int radius;
		private final Walk walk = new Walk();
		private @Nullable LivingEntity target;
		private @Nullable Vec3 lastDeath;
		private int collectTicks;
		private int killed;
		private Map<String, Integer> before = Map.of();

		public Hunt(final EntityType<?> type, final String ref, final int count, final int radius) {
			super("hunt");
			this.type = type;
			this.ref = ref;
			this.count = count;
			this.radius = radius;
		}

		@Override
		protected int timeoutTicks() {
			return Math.min(20 * MINUTE, MINUTE + this.count * MINUTE);
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.before = Inv.counts(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.lastDeath != null) {
				if (this.collectTicks-- > 0 && Miner.collectNear(agent, this.walk, BlockPos.containing(this.lastDeath), 4.0, s -> true)) {
					return Status.RUNNING;
				}
				this.lastDeath = null;
			}
			if (this.killed >= this.count) {
				return this.finish(agent);
			}
			if (this.target == null || !this.target.isAlive() || this.target.isRemoved()) {
				if (this.target != null && this.target.isDeadOrDying()) {
					this.killed++;
					this.lastDeath = this.target.position();
					this.collectTicks = 60;
					this.target = null;
					return Status.RUNNING;
				}
				Entity e = Refs.nearestOfType(agent, this.type, this.radius,
					x -> x instanceof LivingEntity && !(x instanceof Player) && !Protection.isDecoration(x) && !Protection.isPetOrNamed(x));
				if (e == null) {
					this.finish(agent);
					return this.fail("NOT_FOUND", "killed " + this.killed + " of " + this.count + "; no " + this.ref + " within " + this.radius + " blocks");
				}
				this.target = (LivingEntity)e;
				this.walk.reset();
			}
			this.progress((double)this.killed / this.count, this.killed + "/" + this.count + " " + this.ref);
			if (this.target.distanceTo(agent) > this.radius + 16) {
				this.target = null;
				return Status.RUNNING;
			}
			if (!Fight.tick(agent, this.target, this.walk)) {
				this.finish(agent);
				return this.fail("UNREACHABLE", "cannot reach the " + this.ref + " (" + this.walk.failure() + ")");
			}
			return Status.RUNNING;
		}

		private Status finish(final AgentPlayer agent) {
			this.put("killed", this.killed);
			this.put("items", Inv.gained(this.before, Inv.counts(agent)));
			return this.done();
		}
	}

	/** {@code dig{from, to}}: clear every breakable block in the box, top layer first, then pick up the drops. */
	public static final class Dig extends SkillJob {
		public static final int MAX_BLOCKS = 1024;
		private final BlockPos min;
		private final BlockPos max;
		private final Walk walk = new Walk();
		private final Set<BlockPos> skipped = new HashSet<>();
		private @Nullable BlockPos target;
		private int dug;
		private int mineTicks;
		private int collectTicks = -1;
		private Map<String, Integer> before = Map.of();

		public Dig(final BlockPos a, final BlockPos b) {
			super("dig");
			this.min = new BlockPos(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()), Math.min(a.getZ(), b.getZ()));
			this.max = new BlockPos(Math.max(a.getX(), b.getX()), Math.max(a.getY(), b.getY()), Math.max(a.getZ(), b.getZ()));
		}

		/** Blocks in the box, in longs: int coordinates far apart would overflow an int product (and pass a size check). */
		public static long volume(final BlockPos a, final BlockPos b) {
			return (Math.abs((long)a.getX() - b.getX()) + 1) * (Math.abs((long)a.getY() - b.getY()) + 1) * (Math.abs((long)a.getZ() - b.getZ()) + 1);
		}

		@Override
		protected int timeoutTicks() {
			return (int)Math.min(40L * MINUTE, MINUTE + volume(this.min, this.max) * 5L * SECOND);
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.before = Inv.counts(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			if (this.ticks == 1) {
				// W1: a box that holds player-built or Base blocks is refused before anything is dug.
				List<BlockPos> prot = new ArrayList<>();
				Protection.Verdict nearest = null;
				for (BlockPos p : BlockPos.betweenClosed(this.min, this.max)) {
					Protection.Verdict v = Protection.check(level, p, agent.agentId());
					if (v != null) {
						prot.add(p.immutable());
						if (nearest == null || p.distSqr(agent.blockPosition()) < nearest.pos().distSqr(agent.blockPosition())) {
							nearest = v;
						}
					}
				}
				if (nearest != null) {
					this.put("dug", 0);
					this.put("protectedBlocks", prot.size());
					return this.refuseProtected(agent, nearest, prot);
				}
			}
			if (this.collectTicks >= 0) {
				BlockPos mid = BlockPos.containing((this.min.getX() + this.max.getX()) / 2.0, this.min.getY(), (this.min.getZ() + this.max.getZ()) / 2.0);
				double r = Math.max(4.0, Math.sqrt(this.min.distSqr(this.max)) / 2.0 + 2.0);
				if (this.collectTicks-- > 0 && Miner.collectNear(agent, this.walk, mid, r, s -> true)) {
					return Status.RUNNING;
				}
				this.put("dug", this.dug);
				this.put("skipped", this.skipped.size());
				this.put("items", Inv.gained(this.before, Inv.counts(agent)));
				return this.done();
			}
			if (this.target != null && BlockOps.isClear(level, this.target)) {
				// Broken by the held attack at the end of the last tick.
				if (this.mineTicks > 0) {
					this.dug++;
				}
				this.target = null;
			}
			if (this.target == null) {
				this.target = this.next(agent);
				this.mineTicks = 0;
				if (this.target == null) {
					agent.controls().stopMining();
					this.collectTicks = 100;
					return Status.RUNNING;
				}
			}
			BlockPos t = this.target;
			long total = volume(this.min, this.max);
			this.progress((double)this.dug / total, this.dug + " blocks dug");
			Walk.State s = this.walk.toBlock(agent, t);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED || ++this.mineTicks > 30 * SECOND) {
				this.skipped.add(t);
				this.target = null;
				return Status.RUNNING;
			}
			if (BlockOps.mineTick(agent, t)) {
				this.dug++;
				this.target = null;
			}
			return Status.RUNNING;
		}

		/** Highest layer first; nearest to the agent within it. */
		private @Nullable BlockPos next(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			for (int y = this.max.getY(); y >= this.min.getY(); y--) {
				BlockPos best = null;
				double bestD = Double.MAX_VALUE;
				for (int x = this.min.getX(); x <= this.max.getX(); x++) {
					for (int z = this.min.getZ(); z <= this.max.getZ(); z++) {
						BlockPos p = new BlockPos(x, y, z);
						if (this.skipped.contains(p) || BlockOps.isClear(level, p) || BlockOps.unbreakable(level, p)
							|| Protection.check(level, p, agent.agentId()) != null) {
							continue;
						}
						double d = p.distSqr(agent.blockPosition());
						if (d < bestD) {
							bestD = d;
							best = p;
						}
					}
				}
				if (best != null) {
					return best;
				}
			}
			return null;
		}
	}

	/** {@code pickup{item?, radius?}}: pick up loose items (optionally only one kind) until none are left in range. */
	public static final class Pickup extends SkillJob {
		private final Refs.@Nullable ItemMatcher item;
		private final int radius;
		private final Walk walk = new Walk();
		private final Set<ItemEntity> unreachable = new HashSet<>();
		private @Nullable ItemEntity target;
		private int targetTicks;
		private Map<String, Integer> before = Map.of();

		public Pickup(final Refs.@Nullable ItemMatcher item, final int radius) {
			super("pickup");
			this.item = item;
			this.radius = radius;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.before = Inv.counts(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			Predicate<ItemStack> what = this.item == null ? s -> true : this.item;
			if (this.target == null || !this.target.isAlive()) {
				List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(this.radius),
					e -> e.isAlive() && !this.unreachable.contains(e) && what.test(e.getItem()) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem()));
				this.target = items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
				this.targetTicks = 0;
				if (this.target == null) {
					Map<String, Integer> got = Inv.gained(this.before, Inv.counts(agent));
					this.put("picked", got);
					if (got.isEmpty()) {
						return this.fail("NOT_FOUND", "no " + (this.item == null ? "items" : this.item.ref()) + " to pick up within " + this.radius + " blocks");
					}
					return this.done();
				}
			}
			if (++this.targetTicks > 15 * SECOND || this.walk.to(agent, this.target.position(), 0.5) == Walk.State.FAILED) {
				this.unreachable.add(this.target);
				this.target = null;
			}
			this.progress(null, "picking up " + Refs.itemId(this.target == null ? ItemStack.EMPTY : this.target.getItem()).replace("minecraft:", ""));
			return Status.RUNNING;
		}
	}

	/** Shared melee: best weapon, close in with the navigator, swing when charged. Returns false if unreachable. */
	public static final class Fight {
		private Fight() {
		}

		public static boolean tick(final AgentPlayer agent, final LivingEntity target, final Walk walk) {
			int weapon = AgentInventory.bestWeaponSlot(agent.getInventory());
			if (weapon >= 0) {
				AgentInventory.equip(agent, weapon);
			}
			double dist = agent.distanceTo(target);
			if (dist > 2.8 || !agent.hasLineOfSight(target)) {
				Walk.State s = walk.to(agent, target.position(), 1.8);
				if (s == Walk.State.FAILED) {
					return false;
				}
				if (dist < 6.0) {
					agent.controls().lookAt(target);
				}
				return true;
			}
			walk.stop(agent);
			agent.controls().lookAt(target);
			agent.controls().setForward(dist > 2.0 ? 0.6F : 0.0F);
			agent.controls().attack(target);
			return true;
		}
	}

	static String lower(final String s) {
		return s.toLowerCase(Locale.ROOT);
	}
}
