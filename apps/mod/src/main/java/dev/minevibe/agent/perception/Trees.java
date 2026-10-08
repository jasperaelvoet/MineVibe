package dev.minevibe.agent.perception;

import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Provenance;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.BarrelBlock;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.CraftingTableBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.IronBarsBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.TransparentBlock;
import net.minecraft.world.level.block.TrapDoorBlock;
import net.minecraft.world.level.block.WallBlock;
import net.minecraft.world.level.block.WoolCarpetBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Natural trees (W1): a tree is a connected cluster of natural log blocks ({@code oak_log}, {@code crimson_stem}... never
 * stripped logs, wood or planks) that touches natural leaves ({@code persistent=false}: leaves a player places are
 * persistent), that nobody placed (no provenance mark, nothing protected), and that touches no building block (planks,
 * glass, doors, stairs, slabs, fences, walls, wool, beds, bricks, chests...). A player's log cabin has no natural leaves
 * of its own and always touches its planks, doors or windows, so it is never a tree, even in a world that predates
 * provenance and even when a real tree's leaves brush against it.
 */
public final class Trees {
	private static final int MAX_LOGS = 128;
	private static final int MAX_SPREAD = 10;
	private static final int MAX_HEIGHT = 40;

	private Trees() {
	}

	/** A natural tree: its trunk base (lowest log), species ({@code oak}), logs (lowest first) and natural leaves seen. */
	public record Tree(BlockPos base, String species, List<BlockPos> logs, int leaves) {
		public int height() {
			int min = Integer.MAX_VALUE;
			int max = Integer.MIN_VALUE;
			for (BlockPos p : this.logs) {
				min = Math.min(min, p.getY());
				max = Math.max(max, p.getY());
			}
			return this.logs.isEmpty() ? 0 : max - min + 1;
		}
	}

	/** Stripped logs, wood (bark on all sides), hyphae and planks: what logs become in buildings. */
	public static boolean isBuildingVariant(final Block block) {
		String path = BuiltInRegistries.BLOCK.getKey(block).getPath();
		return path.startsWith("stripped_") || path.endsWith("_wood") || path.endsWith("_hyphae") || path.endsWith("_planks");
	}

	/** A log block as trees grow it: in {@code #minecraft:logs} and not a building variant. */
	public static boolean isNaturalLogBlock(final BlockState state) {
		return state.is(BlockTags.LOGS) && !isBuildingVariant(state.getBlock());
	}

	public static boolean isNaturalLeaf(final BlockState state) {
		return state.getBlock() instanceof LeavesBlock && state.hasProperty(LeavesBlock.PERSISTENT) && !state.getValue(LeavesBlock.PERSISTENT);
	}

	/** {@code oak} for {@code minecraft:oak_log}, {@code crimson} for {@code crimson_stem}. */
	public static String species(final Block log) {
		String path = BuiltInRegistries.BLOCK.getKey(log).getPath();
		for (String suffix : new String[] {"_log", "_stem"}) {
			if (path.endsWith(suffix)) {
				return path.substring(0, path.length() - suffix.length());
			}
		}
		return path;
	}

	/**
	 * The natural tree the log at {@code pos} belongs to, or null when it is no natural tree (not a natural log, placed
	 * by someone, protected, part of a building, or a cluster without natural leaves).
	 */
	public static @Nullable Tree treeAt(final ServerLevel level, final BlockPos pos) {
		return clusterAt(level, pos).tree();
	}

	/**
	 * The log cluster at {@code pos}: every natural log joined to it (at most {@value #MAX_LOGS}), and the tree they
	 * make, or null with the reason they are none ({@code placed}, {@code protected}, {@code building},
	 * {@code no_leaves}). Callers that look at many logs skip the whole cluster at once instead of searching it again
	 * from each of its logs.
	 */
	public record Cluster(List<BlockPos> logs, @Nullable Tree tree, @Nullable String notTree) {
	}

	public static Cluster clusterAt(final ServerLevel level, final BlockPos pos) {
		BlockState start = level.getBlockState(pos);
		if (!isNaturalLogBlock(start)) {
			return new Cluster(List.of(pos.immutable()), null, "not_a_log");
		}
		List<BlockPos> logs = new ArrayList<>();
		Set<BlockPos> seen = new HashSet<>();
		Set<BlockPos> leaves = new HashSet<>();
		Deque<BlockPos> queue = new ArrayDeque<>();
		queue.add(pos.immutable());
		seen.add(pos.immutable());
		String notTree = null;
		while (!queue.isEmpty() && logs.size() < MAX_LOGS) {
			BlockPos p = queue.removeFirst();
			BlockState s = level.getBlockState(p);
			if (!isNaturalLogBlock(s)) {
				continue;
			}
			logs.add(p);
			if (notTree == null) {
				if (Provenance.ownerAt(level, p) != null) {
					// A placed log joined to the cluster: part of a build, not a tree.
					notTree = "placed";
				} else if (Protection.isProtected(level, p)) {
					notTree = "protected";
				}
			}
			for (Direction d : Direction.values()) {
				BlockPos n = p.relative(d);
				BlockState ns = level.getBlockState(n);
				if (isNaturalLeaf(ns)) {
					leaves.add(n);
				} else if (notTree == null && isBuildingBlock(ns)) {
					notTree = "building";
				}
			}
			for (int dx = -1; dx <= 1; dx++) {
				for (int dy = -1; dy <= 1; dy++) {
					for (int dz = -1; dz <= 1; dz++) {
						if (dx == 0 && dy == 0 && dz == 0) {
							continue;
						}
						BlockPos n = p.offset(dx, dy, dz);
						if (Math.abs(n.getX() - pos.getX()) > MAX_SPREAD || Math.abs(n.getZ() - pos.getZ()) > MAX_SPREAD
							|| Math.abs(n.getY() - pos.getY()) > MAX_HEIGHT || !level.isLoaded(n) || !seen.add(n)) {
							continue;
						}
						if (isNaturalLogBlock(level.getBlockState(n))) {
							queue.addLast(n);
						}
					}
				}
			}
		}
		if (notTree == null && leaves.isEmpty()) {
			notTree = "no_leaves";
		}
		if (notTree != null) {
			return new Cluster(List.copyOf(logs), null, notTree);
		}
		BlockPos base = logs.stream().min(Comparator.<BlockPos>comparingInt(BlockPos::getY).thenComparingDouble(p -> p.distSqr(pos))).orElseThrow();
		logs.sort(Comparator.<BlockPos>comparingInt(BlockPos::getY).thenComparingDouble(p -> horizontalSq(p, base)));
		List<BlockPos> sorted = List.copyOf(logs);
		return new Cluster(sorted, new Tree(base, species(level.getBlockState(base).getBlock()), sorted, leaves.size()), null);
	}

	/**
	 * Blocks of buildings that never grow next to a tree trunk: planks, stripped logs and wood, stairs, slabs, doors,
	 * trapdoors, fences, gates, walls, wool and carpets, beds, glass and panes, bricks, cobblestone, chests, barrels,
	 * crafting tables, furnaces and bookshelves.
	 */
	public static boolean isBuildingBlock(final BlockState state) {
		Block b = state.getBlock();
		if (isBuildingVariant(b) || b instanceof TransparentBlock || b instanceof IronBarsBlock || b instanceof DoorBlock || b instanceof TrapDoorBlock
			|| b instanceof FenceBlock || b instanceof FenceGateBlock || b instanceof StairBlock || b instanceof SlabBlock || b instanceof WallBlock
			|| b instanceof BedBlock || b instanceof ChestBlock || b instanceof BarrelBlock || b instanceof AbstractFurnaceBlock || b instanceof WoolCarpetBlock
			|| b instanceof CraftingTableBlock) {
			return true;
		}
		if (state.is(Blocks.COBBLESTONE) || state.is(Blocks.BOOKSHELF)) {
			return true;
		}
		String path = BuiltInRegistries.BLOCK.getKey(b).getPath();
		return path.endsWith("_wool") || path.endsWith("bricks") || path.endsWith("_concrete") || path.endsWith("_terracotta") && path.contains("glazed");
	}

	/** Distinct natural trees among {@code logs} (positions of logs, nearest first), in the order first met. */
	public static List<Tree> treesOf(final ServerLevel level, final List<BlockPos> logs, final int limit) {
		List<Tree> trees = new ArrayList<>();
		Set<BlockPos> covered = new HashSet<>();
		for (BlockPos p : logs) {
			if (trees.size() >= limit) {
				break;
			}
			if (covered.contains(p)) {
				continue;
			}
			Cluster c = clusterAt(level, p);
			covered.add(p);
			covered.addAll(c.logs());
			if (c.tree() != null) {
				trees.add(c.tree());
			}
		}
		return trees;
	}

	private static double horizontalSq(final BlockPos a, final BlockPos b) {
		double dx = a.getX() - b.getX();
		double dz = a.getZ() - b.getZ();
		return dx * dx + dz * dz;
	}
}
