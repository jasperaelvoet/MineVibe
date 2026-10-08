package dev.minevibe.agent.job;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Finds blocks around a point by walking loaded chunk sections, skipping sections whose palette cannot hold a match
 * ({@link LevelChunkSection#maybeHas}). Unloaded chunks are never loaded for a scan.
 */
public final class BlockScan {
	private BlockScan() {
	}

	/** Matching blocks within {@code radius} (a sphere) of {@code center}, nearest first, at most {@code limit}. */
	public static List<BlockPos> nearest(
		final ServerLevel level, final BlockPos center, final int radius, final Predicate<BlockState> match, final Predicate<BlockPos> extra, final int limit
	) {
		List<BlockPos> found = new ArrayList<>();
		long r2 = (long)radius * radius;
		int minY = Math.max(level.getMinY(), center.getY() - radius);
		int maxY = Math.min(level.getMaxY(), center.getY() + radius);
		int minSecY = SectionPos.blockToSectionCoord(minY);
		int maxSecY = SectionPos.blockToSectionCoord(maxY);
		int minCx = SectionPos.blockToSectionCoord(center.getX() - radius);
		int maxCx = SectionPos.blockToSectionCoord(center.getX() + radius);
		int minCz = SectionPos.blockToSectionCoord(center.getZ() - radius);
		int maxCz = SectionPos.blockToSectionCoord(center.getZ() + radius);
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int cx = minCx; cx <= maxCx; cx++) {
			for (int cz = minCz; cz <= maxCz; cz++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
				if (chunk == null) {
					continue;
				}
				for (int sy = minSecY; sy <= maxSecY; sy++) {
					int index = chunk.getSectionIndexFromSectionY(sy);
					if (index < 0 || index >= chunk.getSections().length) {
						continue;
					}
					LevelChunkSection section = chunk.getSection(index);
					if (section.hasOnlyAir() && !match.test(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState()) || !section.maybeHas(match)) {
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
								if (dx * dx + dy * dy + dz * dz > r2) {
									continue;
								}
								if (match.test(section.getBlockState(x, y, z))) {
									p.set(wx, wy, wz);
									if (extra.test(p)) {
										found.add(p.immutable());
									}
								}
							}
						}
					}
				}
			}
		}
		found.sort(Comparator.comparingDouble(b -> b.distSqr(center)));
		return found.size() > limit ? new ArrayList<>(found.subList(0, limit)) : found;
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
