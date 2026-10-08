package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.FarmlandBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * {@code farm{from, to, crop?}}: tends a field in one pass after another until nothing is left to do: harvests ripe
 * crops (and picks up the produce), tills dirt and grass with a hoe, plants seeds on empty farmland, and uses bone meal
 * on growing crops when the agent carries some. {@code crop} picks the seed ({@code wheat_seeds}, {@code carrot},
 * {@code potato}, {@code beetroot_seeds}); by default any seed in the inventory.
 */
public final class FarmJob extends SkillJob {
	public static final int MAX_SIDE = 16;

	private enum Work { HARVEST, TILL, PLANT, BONEMEAL }

	private record Task(Work work, BlockPos pos) {
	}

	private final BlockPos min;
	private final BlockPos max;
	private final Refs.@Nullable ItemMatcher crop;
	private final Walk walk = new Walk();
	private final List<Task> tasks = new ArrayList<>();
	private final Set<BlockPos> skipped = new HashSet<>();
	private @Nullable Task current;
	private @Nullable BlockPos collectAt;
	private int collectTicks;
	private int taskTicks;
	private int harvested;
	private int tilled;
	private int planted;
	private int bonemealed;
	private int passes;

	public FarmJob(final BlockPos a, final BlockPos b, final Refs.@Nullable ItemMatcher crop) {
		super("farm");
		this.min = new BlockPos(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()), Math.min(a.getZ(), b.getZ()));
		this.max = new BlockPos(Math.max(a.getX(), b.getX()), Math.max(a.getY(), b.getY()), Math.max(a.getZ(), b.getZ()));
		this.crop = crop;
	}

	@Override
	protected int timeoutTicks() {
		return 15 * MINUTE;
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.walk.reset();
	}

	private Predicate<ItemStack> seeds() {
		if (this.crop != null) {
			return this.crop;
		}
		return s -> s.is(Items.WHEAT_SEEDS) || s.is(Items.CARROT) || s.is(Items.POTATO) || s.is(Items.BEETROOT_SEEDS);
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (this.collectAt != null) {
			if (this.collectTicks-- > 0 && Miner.collectNear(agent, this.walk, this.collectAt, 3.0, s -> true)) {
				return Status.RUNNING;
			}
			this.collectAt = null;
		}
		if (this.current == null) {
			if (this.tasks.isEmpty()) {
				if (++this.passes > 4 || !this.plan(agent)) {
					return this.finish();
				}
			}
			this.current = this.tasks.removeFirst();
			this.taskTicks = 0;
			this.walk.reset();
		}
		Task t = this.current;
		this.progress(null, this.harvested + " harvested, " + this.tilled + " tilled, " + this.planted + " planted");
		BlockPos target = t.work() == Work.TILL ? t.pos() : t.pos();
		Walk.State s = this.walk.toBlock(agent, target);
		if (s == Walk.State.MOVING) {
			return Status.RUNNING;
		}
		if (s == Walk.State.FAILED || ++this.taskTicks > 20 * SECOND) {
			this.skipped.add(t.pos());
			this.current = null;
			return Status.RUNNING;
		}
		switch (t.work()) {
			case HARVEST -> {
				BlockState state = level.getBlockState(t.pos());
				if (!(state.getBlock() instanceof CropBlock crop) || !crop.isMaxAge(state)) {
					this.current = null;
					return Status.RUNNING;
				}
				if (BlockOps.mineTick(agent, t.pos())) {
					this.harvested++;
					this.collectAt = t.pos();
					this.collectTicks = 30;
					this.current = null;
				}
			}
			case TILL -> {
				if (!Inv.equip(agent, s2 -> s2.is(ItemTags.HOES))) {
					this.current = null;
					return Status.RUNNING;
				}
				agent.controls().lookAt(net.minecraft.world.phys.Vec3.atCenterOf(t.pos()).add(0.0, 0.5, 0.0));
				agent.controls().useBlock(t.pos(), Direction.UP);
				if (level.getBlockState(t.pos()).getBlock() instanceof FarmlandBlock) {
					this.tilled++;
					this.current = null;
				}
			}
			case PLANT -> {
				BlockOps.Place r = BlockOps.placeTick(agent, t.pos().above(), this.seeds());
				if (r == BlockOps.Place.PLACED) {
					this.planted++;
					this.current = null;
				} else if (r != BlockOps.Place.RETRY) {
					if (r == BlockOps.Place.SELF_IN_WAY) {
						WorldJobs.stepAside(agent, t.pos().above(), this.walk);
						return Status.RUNNING;
					}
					this.skipped.add(t.pos());
					this.current = null;
				}
			}
			case BONEMEAL -> {
				if (!Inv.equip(agent, s2 -> s2.is(Items.BONE_MEAL))) {
					this.current = null;
					return Status.RUNNING;
				}
				agent.controls().lookAt(net.minecraft.world.phys.Vec3.atCenterOf(t.pos()));
				if (agent.controls().useBlock(t.pos(), Direction.UP).consumesAction()) {
					this.bonemealed++;
					this.current = null;
				}
			}
		}
		return Status.RUNNING;
	}

	/** Builds the next pass. Returns false when nothing is left to do. */
	private boolean plan(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		boolean hasHoe = Inv.count(agent, s -> s.is(ItemTags.HOES)) > 0;
		int seedCount = Inv.count(agent, this.seeds());
		boolean hasBoneMeal = Inv.count(agent, Items.BONE_MEAL) > 0;
		List<Task> harvest = new ArrayList<>();
		List<Task> till = new ArrayList<>();
		List<Task> plant = new ArrayList<>();
		List<Task> meal = new ArrayList<>();
		for (int x = this.min.getX(); x <= this.max.getX(); x++) {
			for (int z = this.min.getZ(); z <= this.max.getZ(); z++) {
				BlockPos soil = this.soil(level, x, z);
				if (soil == null || this.skipped.contains(soil)) {
					continue;
				}
				BlockPos above = soil.above();
				BlockState up = level.getBlockState(above);
				BlockState ground = level.getBlockState(soil);
				if (up.getBlock() instanceof CropBlock crop) {
					if (crop.isMaxAge(up)) {
						harvest.add(new Task(Work.HARVEST, above));
					} else if (hasBoneMeal && !this.skipped.contains(above)) {
						meal.add(new Task(Work.BONEMEAL, above));
					}
				} else if (up.isAir()) {
					if (ground.getBlock() instanceof FarmlandBlock) {
						if (seedCount > plant.size()) {
							plant.add(new Task(Work.PLANT, soil));
						}
					} else if (hasHoe && seedCount > 0 && (ground.is(Blocks.DIRT) || ground.is(Blocks.GRASS_BLOCK) || ground.is(Blocks.DIRT_PATH) || ground.is(Blocks.COARSE_DIRT))) {
						till.add(new Task(Work.TILL, soil));
					}
				}
			}
		}
		this.tasks.addAll(harvest);
		this.tasks.addAll(till);
		this.tasks.addAll(plant);
		if (harvest.isEmpty() && till.isEmpty() && plant.isEmpty()) {
			this.tasks.addAll(meal.subList(0, Math.min(meal.size(), 8)));
		}
		return !this.tasks.isEmpty();
	}

	/** The topmost soil block (farmland, dirt, grass) of a column inside the box, or null. */
	private @Nullable BlockPos soil(final ServerLevel level, final int x, final int z) {
		for (int y = this.max.getY(); y >= this.min.getY() - 1; y--) {
			BlockPos p = new BlockPos(x, y, z);
			BlockState s = level.getBlockState(p);
			if (s.getBlock() instanceof FarmlandBlock || s.is(Blocks.DIRT) || s.is(Blocks.GRASS_BLOCK) || s.is(Blocks.DIRT_PATH) || s.is(Blocks.COARSE_DIRT)) {
				BlockState up = level.getBlockState(p.above());
				if (up.isAir() || up.getBlock() instanceof CropBlock) {
					return p;
				}
			}
		}
		return null;
	}

	private Status finish() {
		this.put("harvested", this.harvested);
		this.put("tilled", this.tilled);
		this.put("planted", this.planted);
		this.put("bonemealed", this.bonemealed);
		if (this.harvested + this.tilled + this.planted + this.bonemealed == 0) {
			this.put("note", "nothing to do: no ripe crops, no seeds or no hoe for the empty soil");
		}
		return this.done();
	}

	/** True if {@code stack} plants a crop. */
	public static boolean isSeed(final ItemStack stack) {
		return isSeed(stack.getItem());
	}

	/** True if {@code item} plants a crop (wheat seeds, carrot, potato, beetroot seeds...). */
	public static boolean isSeed(final net.minecraft.world.item.Item item) {
		return item instanceof BlockItem bi && bi.getBlock() instanceof CropBlock;
	}
}
