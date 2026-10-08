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
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Natural trees (W1): a tree is a connected cluster of natural log blocks ({@code oak_log}, {@code crimson_stem}... never
 * stripped logs, wood or planks) that touches natural leaves ({@code persistent=false}: leaves a player places are
 * persistent) and that nobody placed (no provenance mark, not in a protected zone). A player's log cabin has no natural
 * leaves on it and is never a tree, even in a world that predates provenance.
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
	 * by someone, protected, or a cluster without natural leaves).
	 */
	public static @Nullable Tree treeAt(final ServerLevel level, final BlockPos pos) {
		BlockState start = level.getBlockState(pos);
		if (!isNaturalLogBlock(start) || Provenance.ownerAt(level, pos) != null || Protection.isProtected(level, pos)) {
			return null;
		}
		List<BlockPos> logs = new ArrayList<>();
		Set<BlockPos> seen = new HashSet<>();
		Set<BlockPos> leaves = new HashSet<>();
		Deque<BlockPos> queue = new ArrayDeque<>();
		queue.add(pos.immutable());
		seen.add(pos.immutable());
		while (!queue.isEmpty() && logs.size() < MAX_LOGS) {
			BlockPos p = queue.removeFirst();
			BlockState s = level.getBlockState(p);
			if (!isNaturalLogBlock(s)) {
				continue;
			}
			if (Provenance.ownerAt(level, p) != null) {
				// A placed log joined to the cluster: part of a build, not a tree.
				return null;
			}
			logs.add(p);
			for (Direction d : Direction.values()) {
				BlockPos n = p.relative(d);
				if (isNaturalLeaf(level.getBlockState(n))) {
					leaves.add(n);
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
		if (leaves.isEmpty() || logs.isEmpty()) {
			return null;
		}
		BlockPos base = logs.stream().min(Comparator.<BlockPos>comparingInt(BlockPos::getY).thenComparingDouble(p -> p.distSqr(pos))).orElseThrow();
		logs.sort(Comparator.<BlockPos>comparingInt(BlockPos::getY).thenComparingDouble(p -> horizontalSq(p, base)));
		return new Tree(base, species(level.getBlockState(base).getBlock()), List.copyOf(logs), leaves.size());
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
			Tree t = treeAt(level, p);
			if (t == null) {
				covered.add(p);
				continue;
			}
			covered.addAll(t.logs());
			trees.add(t);
		}
		return trees;
	}

	private static double horizontalSq(final BlockPos a, final BlockPos b) {
		double dx = a.getX() - b.getX();
		double dz = a.getZ() - b.getZ();
		return dx * dx + dz * dz;
	}
}
