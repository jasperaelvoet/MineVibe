package dev.minevibe.agent.job;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Finds blocks around a point by walking loaded chunk sections nearest first, skipping sections whose palette cannot
 * hold a match ({@link LevelChunkSection#maybeHas}) and stopping as soon as no farther section can beat the matches
 * found, so looking for something common (stone, dirt, logs in a forest) reads a few sections instead of every block in
 * range. Unloaded chunks are never loaded for a scan.
 */
public final class BlockScan {
	private BlockScan() {
	}

	/** Matching blocks within {@code radius} (a sphere) of {@code center}, nearest first, at most {@code limit}. */
	public static List<BlockPos> nearest(
		final ServerLevel level, final BlockPos center, final int radius, final Predicate<BlockState> match, final Predicate<BlockPos> extra, final int limit
	) {
		if (limit <= 0) {
			return new ArrayList<>();
		}
		long r2 = (long)radius * radius;
		int minY = Math.max(level.getMinY(), center.getY() - radius);
		int maxY = Math.min(level.getMaxY(), center.getY() + radius);
		int minSecY = SectionPos.blockToSectionCoord(minY);
		int maxSecY = SectionPos.blockToSectionCoord(maxY);
		int minCx = SectionPos.blockToSectionCoord(center.getX() - radius);
		int maxCx = SectionPos.blockToSectionCoord(center.getX() + radius);
		int minCz = SectionPos.blockToSectionCoord(center.getZ() - radius);
		int maxCz = SectionPos.blockToSectionCoord(center.getZ() + radius);
		// Sections in range, by the squared distance from the centre to their nearest block.
		List<long[]> sections = new ArrayList<>();
		for (int cx = minCx; cx <= maxCx; cx++) {
			for (int cz = minCz; cz <= maxCz; cz++) {
				for (int sy = minSecY; sy <= maxSecY; sy++) {
					long d = gap(center.getX(), cx << 4) + gap(center.getY(), sy << 4) + gap(center.getZ(), cz << 4);
					if (d <= r2) {
						sections.add(new long[] {d, cx, sy, cz});
					}
				}
			}
		}
		sections.sort(Comparator.comparingLong(a -> a[0]));
		// The best matches so far, the farthest on top.
		PriorityQueue<BlockPos> best = new PriorityQueue<>(limit + 1, Comparator.comparingLong((BlockPos b) -> distSq(b, center)).reversed());
		long worst = Long.MAX_VALUE;
		boolean airMatches = match.test(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState());
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (long[] sec : sections) {
			if (best.size() >= limit && sec[0] > worst) {
				break;
			}
			int cx = (int)sec[1];
			int sy = (int)sec[2];
			int cz = (int)sec[3];
			LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
			if (chunk == null) {
				continue;
			}
			int index = chunk.getSectionIndexFromSectionY(sy);
			if (index < 0 || index >= chunk.getSections().length) {
				continue;
			}
			LevelChunkSection section = chunk.getSection(index);
			if (section.hasOnlyAir() && !airMatches || !section.maybeHas(match)) {
				continue;
			}
			int bx = cx << 4;
			int by = sy << 4;
			int bz = cz << 4;
			for (int y = 0; y < 16; y++) {
				int wy = by + y;
				if (wy < minY || wy > maxY) {
					continue;
				}
				for (int z = 0; z < 16; z++) {
					for (int x = 0; x < 16; x++) {
						int wx = bx + x;
						int wz = bz + z;
						long dx = wx - center.getX();
						long dy = wy - center.getY();
						long dz = wz - center.getZ();
						long d = dx * dx + dy * dy + dz * dz;
						if (d > r2 || best.size() >= limit && d >= worst) {
							continue;
						}
						if (match.test(section.getBlockState(x, y, z))) {
							p.set(wx, wy, wz);
							if (extra.test(p)) {
								best.add(p.immutable());
								if (best.size() > limit) {
									best.poll();
								}
								if (best.size() >= limit) {
									worst = distSq(best.peek(), center);
								}
							}
						}
					}
				}
			}
		}
		List<BlockPos> found = new ArrayList<>(best);
		found.sort(Comparator.comparingLong(b -> distSq(b, center)));
		return found;
	}

	/** Squared distance along one axis from {@code c} to the 16-block span starting at {@code lo} (0 inside it). */
	private static long gap(final int c, final int lo) {
		long d = c < lo ? lo - c : c > lo + 15 ? c - (lo + 15) : 0;
		return d * d;
	}

	private static long distSq(final BlockPos b, final BlockPos c) {
		long dx = b.getX() - c.getX();
		long dy = b.getY() - c.getY();
		long dz = b.getZ() - c.getZ();
		return dx * dx + dy * dy + dz * dz;
	}

	/** True when at least one face of {@code pos} touches air or a fluid (a block a player can see and hit). */
	public static boolean exposed(final ServerLevel level, final BlockPos pos) {
		for (Direction d : Direction.values()) {
			BlockPos n = pos.relative(d);
			BlockState s = level.getBlockState(n);
			if (s.isAir() || !s.getFluidState().isEmpty() || s.getCollisionShape(level, n).isEmpty()) {
				return true;
			}
		}
		return false;
	}
}
