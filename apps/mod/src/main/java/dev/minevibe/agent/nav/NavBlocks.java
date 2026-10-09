package dev.minevibe.agent.nav;

import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Provenance;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CactusBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.MagmaBlock;
import net.minecraft.world.level.block.PowderSnowBlock;
import net.minecraft.world.level.block.SweetBerryBushBlock;
import net.minecraft.world.level.block.WebBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * What the navigator may walk through, stand on, break and build with (Tier 2, {@link DigPathPlanner}).
 *
 * <p><b>Breaking.</b> Only natural material nobody placed is ever broken (ground, stone, sand and gravel, ores,
 * natural, non persistent leaves, huge mushrooms, snow), and the scaffold agents placed to get somewhere (remembered
 * here, and still a scaffold block). Never anything else an agent placed (what the crew built stays standing), a block
 * with a block entity, an unbreakable one, the office ({@link OfficeService#protects}),
 * or anything {@link Protection#check} protects: player-built blocks, the Base zone, what holds those up, and the floor
 * under a player's roof. Logs are not broken to make way (they are what jobs mine, and cabins are built of them).
 *
 * <p><b>Building.</b> Pillars and bridges use plain blocks from the inventory: dirt, cobblestone and the like.
 */
public final class NavBlocks {
	/** A full block's top face must be at least this high to stand on (stairs, farmland and paths count; slabs do not). */
	private static final double MIN_FLOOR_TOP = 0.8;
	/** Feet cells may hold blocks this low (carpets, a thin snow layer): the step-up walks over them. */
	private static final double MAX_LOW_BLOCK = 0.2;
	/** Breaking slower than this (ticks, with the best tool at hand) is not worth a path. */
	public static final int MAX_BREAK_TICKS = 200;

	private static final Map<ServerLevel, Set<Long>> SCAFFOLD = new WeakHashMap<>();
	private static final int MAX_SCAFFOLD_REMEMBERED = 4096;

	private NavBlocks() {
	}

	// ---------------------------------------------------------------- classification

	/** Lava, fire and blocks that hurt or trap whoever enters them: never walked into, stood on or broken. */
	public static boolean isHazard(final BlockState state) {
		FluidState fluid = state.getFluidState();
		if (fluid.is(FluidTags.LAVA)) {
			return true;
		}
		Block b = state.getBlock();
		return state.is(BlockTags.FIRE) || state.is(BlockTags.CAMPFIRES) || b instanceof MagmaBlock || b instanceof CactusBlock
			|| b instanceof SweetBerryBushBlock || b instanceof PowderSnowBlock || b instanceof WebBlock || b == Blocks.WITHER_ROSE
			|| b == Blocks.POINTED_DRIPSTONE;
	}

	public static boolean isWater(final BlockState state) {
		return state.getFluidState().is(FluidTags.WATER);
	}

	public static boolean isClimbable(final BlockState state) {
		return state.is(BlockTags.CLIMBABLE) && !state.is(Blocks.SCAFFOLDING);
	}

	/** A wooden door (open or not): the executor opens it on the way. */
	public static boolean isOpenableDoor(final BlockState state) {
		return state.getBlock() instanceof DoorBlock door && door.type().canOpenByHand();
	}

	/** True if a body can occupy this cell without breaking anything (air, plants, water, ladders, open doors...). */
	public static boolean isPassable(final BlockGetter level, final BlockPos pos, final BlockState state) {
		if (isHazard(state)) {
			return false;
		}
		if (isOpenableDoor(state) || isClimbable(state)) {
			return true;
		}
		VoxelShape shape = state.getCollisionShape(level, pos);
		return shape.isEmpty() || shape.max(Direction.Axis.Y) <= MAX_LOW_BLOCK;
	}

	/** True if feet can stand on top of this block (a near-full collision box, not a fence or wall). */
	public static boolean isFloor(final BlockGetter level, final BlockPos pos, final BlockState state) {
		if (state.getBlock() instanceof MagmaBlock || isHazard(state) || isOpenableDoor(state)) {
			return false;
		}
		VoxelShape shape = state.getCollisionShape(level, pos);
		if (shape.isEmpty()) {
			return false;
		}
		double top = shape.max(Direction.Axis.Y);
		return top >= MIN_FLOOR_TOP && top <= 1.0;
	}

	/** Gravity blocks (sand, gravel, concrete powder): breaking what holds them up drops them on the agent. */
	public static boolean isFalling(final BlockState state) {
		return state.getBlock() instanceof FallingBlock;
	}

	/** The natural-material allowlist (without the position checks of {@link #mayBreak}). */
	public static boolean isNaturalMaterial(final BlockState state) {
		if (state.hasBlockEntity()) {
			return false;
		}
		if (state.getBlock() instanceof LeavesBlock) {
			return !state.getValue(LeavesBlock.PERSISTENT);
		}
		// In 26.3 #dirt is only dirt, coarse and rooted dirt: grass, podzol and mycelium are #grass_blocks, and
		// #substrate_overworld gathers all of them with mud and moss.
		if (state.is(BlockTags.SUBSTRATE_OVERWORLD) || state.is(BlockTags.DIRT) || state.is(BlockTags.GRASS_BLOCKS) || state.is(BlockTags.SAND)
			|| state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.BASE_STONE_NETHER) || state.is(BlockTags.NYLIUM) || state.is(BlockTags.SNOW)
			|| state.is(BlockTags.MUD) || state.is(BlockTags.MOSS_BLOCKS) || state.is(BlockTags.BADLANDS_TERRACOTTA) || state.is(BlockTags.ORES)) {
			return state.getBlock() != Blocks.SUSPICIOUS_SAND && state.getBlock() != Blocks.SUSPICIOUS_GRAVEL;
		}
		Block b = state.getBlock();
		if (b == Blocks.GRAVEL || b == Blocks.CLAY || b == Blocks.SANDSTONE || b == Blocks.RED_SANDSTONE || b == Blocks.END_STONE
			|| b == Blocks.SOUL_SAND || b == Blocks.SOUL_SOIL || b == Blocks.CALCITE || b == Blocks.DRIPSTONE_BLOCK || b == Blocks.SMOOTH_BASALT
			|| b == Blocks.BROWN_MUSHROOM_BLOCK || b == Blocks.RED_MUSHROOM_BLOCK || b == Blocks.MUSHROOM_STEM || b == Blocks.PACKED_MUD) {
			return true;
		}
		return BuiltInRegistries.BLOCK.getKey(b).getPath().endsWith("_ore");
	}

	/**
	 * May {@code agentId} (null: any agent) break the block at {@code pos} to make way (policy only: natural and nobody's,
	 * or an agent's scaffold; not protected)? Safety (fluids next to it, gravity blocks above it, the block under the
	 * agent) is checked separately. {@link Protection#check} reads the neighbours too, so a block at the edge of the
	 * loaded world is left alone rather than loading a chunk for it.
	 */
	public static boolean mayBreak(final ServerLevel level, final BlockPos pos, final BlockState state, final @Nullable String agentId) {
		if (state.isAir() || isHazard(state) || !state.getFluidState().isEmpty()) {
			return false;
		}
		if (state.getDestroySpeed(level, pos) < 0.0F) {
			return false;
		}
		Owner owner = Provenance.ownerAt(level, pos);
		if (owner != null) {
			// A placed block: only scaffold navigation put there itself. Never what the crew built (a shelter's walls, a
			// plank house, a crafting table; a build job's walk would otherwise tunnel through the walls it just built),
			// nor a player's or the Base's.
			if (!owner.isAgent() || !isScaffold(level, pos, state)) {
				return false;
			}
		} else if (!isNaturalMaterial(state)) {
			return false;
		}
		if (OfficeService.protects(level, pos)) {
			return false;
		}
		for (Direction d : Direction.values()) {
			BlockPos n = pos.relative(d);
			if (level.getChunkSource().getChunkNow(n.getX() >> 4, n.getZ() >> 4) == null) {
				return false;
			}
		}
		return Protection.check(level, pos, agentId) == null;
	}

	/**
	 * Breaking {@code pos} must not let a fluid in or drop a gravity block: no water or lava above or beside it, and no
	 * sand or gravel resting on it.
	 */
	public static boolean safeToOpen(final BlockGetter level, final BlockPos pos) {
		for (Direction d : Direction.values()) {
			if (d == Direction.DOWN) {
				continue;
			}
			BlockState n = level.getBlockState(pos.relative(d));
			if (!n.getFluidState().isEmpty()) {
				return false;
			}
		}
		return !isFalling(level.getBlockState(pos.above()));
	}

	/**
	 * Ticks to break {@code state} with the best tool in {@code inventory} (vanilla's survival formula, without
	 * enchantments or effects), or {@link Integer#MAX_VALUE} if it cannot be broken.
	 */
	public static int breakTicks(final Inventory inventory, final BlockState state, final BlockGetter level, final BlockPos pos) {
		float hardness = state.getDestroySpeed(level, pos);
		if (hardness < 0.0F) {
			return Integer.MAX_VALUE;
		}
		if (hardness == 0.0F) {
			return 1;
		}
		float speed = 1.0F;
		boolean correct = !state.requiresCorrectToolForDrops();
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (stack.isEmpty()) {
				continue;
			}
			speed = Math.max(speed, stack.getDestroySpeed(state));
			correct |= stack.isCorrectToolForDrops(state);
		}
		float perTick = speed / hardness / (correct ? 30.0F : 100.0F);
		return (int)Math.ceil(1.0F / perTick);
	}

	// ---------------------------------------------------------------- scaffold

	/** Plain blocks an agent builds pillars and bridges with. */
	public static boolean isScaffoldItem(final ItemStack stack) {
		if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem)) {
			return false;
		}
		return stack.is(Items.DIRT) || stack.is(Items.COARSE_DIRT) || stack.is(Items.COBBLESTONE) || stack.is(Items.COBBLED_DEEPSLATE)
			|| stack.is(Items.NETHERRACK) || stack.is(Items.STONE) || stack.is(Items.ANDESITE) || stack.is(Items.DIORITE)
			|| stack.is(Items.GRANITE) || stack.is(Items.TUFF) || stack.is(Items.DEEPSLATE) || stack.is(Items.END_STONE);
	}

	/**
	 * True if mining the block {@code stack} places gives the item back with what {@code inventory} holds: dirt always,
	 * stone kinds (cobblestone, stone, deepslate...) only with a pickaxe that harvests them. Scaffold that is mined away
	 * again is placed from these first: cobblestone mined by hand drops nothing (and takes 10 s a block).
	 */
	public static boolean minedBack(final Inventory inventory, final ItemStack stack) {
		if (!(stack.getItem() instanceof BlockItem item)) {
			return false;
		}
		BlockState state = item.getBlock().defaultBlockState();
		if (!state.requiresCorrectToolForDrops()) {
			return true;
		}
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			if (inventory.getItem(slot).isCorrectToolForDrops(state)) {
				return true;
			}
		}
		return false;
	}

	public static int scaffoldCount(final Inventory inventory) {
		int n = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (isScaffoldItem(stack)) {
				n += stack.getCount();
			}
		}
		return n;
	}

	/**
	 * A block an agent stuck in water may put down as a step to climb out on (water exits, PLAN 7.2): scaffold first, else
	 * a plain building block from the bag (logs, planks, dirt and stone kinds, stone bricks, terracotta, wool), a full
	 * cube. Never a block with a block entity (a chest, a furnace), a falling block (it would sink), one that is not a
	 * full cube (slabs, stairs, fences: no step to stand on), one that hurts (magma), nor anything precious (ores, metal
	 * and gem blocks). Getting out of the water is worth a log.
	 */
	public static boolean isStepItem(final ItemStack stack) {
		if (isScaffoldItem(stack)) {
			return true;
		}
		if (stack.isEmpty() || !(stack.getItem() instanceof BlockItem item)) {
			return false;
		}
		Block block = item.getBlock();
		BlockState state = block.defaultBlockState();
		if (state.hasBlockEntity() || block instanceof FallingBlock || isHazard(state) || block instanceof LeavesBlock || block instanceof MagmaBlock) {
			return false;
		}
		if (!(state.is(BlockTags.LOGS) || state.is(BlockTags.PLANKS) || state.is(BlockTags.DIRT) || state.is(BlockTags.BASE_STONE_OVERWORLD)
			|| state.is(BlockTags.BASE_STONE_NETHER) || state.is(BlockTags.STONE_BRICKS) || state.is(BlockTags.TERRACOTTA) || state.is(BlockTags.WOOL))) {
			return false;
		}
		return state.isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
			&& state.isRedstoneConductor(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
	}

	/**
	 * Which step block goes first ({@link #isStepItem}), lowest first: scaffold, then dirt kinds, stone kinds, planks,
	 * logs, stone bricks, terracotta and wool last (what a player hands over for a build). {@link Integer#MAX_VALUE} for
	 * anything that is no step.
	 */
	public static int stepRank(final ItemStack stack) {
		if (!isStepItem(stack)) {
			return Integer.MAX_VALUE;
		}
		if (isScaffoldItem(stack)) {
			return 0;
		}
		BlockState state = ((BlockItem)stack.getItem()).getBlock().defaultBlockState();
		if (state.is(BlockTags.DIRT)) {
			return 1;
		}
		if (state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.BASE_STONE_NETHER)) {
			return 2;
		}
		if (state.is(BlockTags.PLANKS)) {
			return 3;
		}
		if (state.is(BlockTags.LOGS)) {
			return 4;
		}
		if (state.is(BlockTags.STONE_BRICKS)) {
			return 5;
		}
		return state.is(BlockTags.TERRACOTTA) ? 6 : 7;
	}

	/** Blocks in the bag an agent may step out of water on ({@link #isStepItem}): scaffold and other plain full cubes. */
	public static int stepCount(final Inventory inventory) {
		int n = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (isStepItem(stack)) {
				n += stack.getCount();
			}
		}
		return n;
	}

	/**
	 * A block a scaffold item places, or a dirt block grass has grown over since: what a pillar or bridge is made of. The
	 * pillar a job clears is checked against it, so a position that holds something else by now is left alone.
	 */
	public static boolean isScaffoldBlock(final BlockState state) {
		Block b = state.getBlock();
		return b == Blocks.DIRT || b == Blocks.COARSE_DIRT || b == Blocks.GRASS_BLOCK || b == Blocks.COBBLESTONE || b == Blocks.COBBLED_DEEPSLATE
			|| b == Blocks.NETHERRACK || b == Blocks.STONE || b == Blocks.ANDESITE || b == Blocks.DIORITE || b == Blocks.GRANITE || b == Blocks.TUFF
			|| b == Blocks.DEEPSLATE || b == Blocks.END_STONE;
	}

	/** Remembers a block an agent placed as scaffold, so navigation may break it again later. */
	public static void noteScaffold(final ServerLevel level, final BlockPos pos) {
		synchronized (SCAFFOLD) {
			Set<Long> set = SCAFFOLD.computeIfAbsent(level, l -> new LinkedHashSet<>());
			set.add(pos.asLong());
			if (set.size() > MAX_SCAFFOLD_REMEMBERED) {
				var it = set.iterator();
				it.next();
				it.remove();
			}
		}
	}

	/** Forgets the scaffold at {@code pos} (it was broken): whatever is built there later is not scaffold. */
	public static void forgetScaffold(final ServerLevel level, final BlockPos pos) {
		synchronized (SCAFFOLD) {
			Set<Long> set = SCAFFOLD.get(level);
			if (set != null) {
				set.remove(pos.asLong());
			}
		}
	}

	/**
	 * True if the block at {@code pos} ({@code state}) is scaffold an agent placed to get somewhere: remembered, and
	 * still a scaffold block (a crew build put at a former scaffold position is not).
	 */
	public static boolean isScaffold(final ServerLevel level, final BlockPos pos, final BlockState state) {
		if (!isScaffoldBlock(state)) {
			return false;
		}
		synchronized (SCAFFOLD) {
			Set<Long> set = SCAFFOLD.get(level);
			return set != null && set.contains(pos.asLong());
		}
	}
}
