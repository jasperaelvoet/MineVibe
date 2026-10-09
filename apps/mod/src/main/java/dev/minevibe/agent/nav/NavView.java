package dev.minevibe.agent.nav;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.FluidState;
import org.jspecify.annotations.Nullable;

/**
 * A read-only view of the loaded chunks of a level for path searches: it never loads or generates a chunk (an
 * unloaded one reads as air here; {@link #loaded} tells them apart) and caches the chunk lookups of one search.
 */
final class NavView implements BlockGetter {
	private static final LevelChunk MISSING = null;

	private final ServerLevel level;
	private final Long2ObjectOpenHashMap<LevelChunk> chunks = new Long2ObjectOpenHashMap<>();
	private final it.unimi.dsi.fastutil.longs.LongOpenHashSet missing = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
	private long lastKey = Long.MIN_VALUE;
	private @Nullable LevelChunk lastChunk;

	NavView(final ServerLevel level) {
		this.level = level;
	}

	ServerLevel level() {
		return this.level;
	}

	private @Nullable LevelChunk chunk(final int x, final int z) {
		int cx = SectionPos.blockToSectionCoord(x);
		int cz = SectionPos.blockToSectionCoord(z);
		long key = ChunkPos.pack(cx, cz);
		if (key == this.lastKey) {
			return this.lastChunk;
		}
		LevelChunk chunk = this.chunks.get(key);
		if (chunk == null && !this.missing.contains(key)) {
			chunk = this.level.getChunkSource().getChunkNow(cx, cz);
			if (chunk == null) {
				this.missing.add(key);
			} else {
				this.chunks.put(key, chunk);
			}
		}
		this.lastKey = key;
		this.lastChunk = chunk;
		return chunk == null ? MISSING : chunk;
	}

	boolean loaded(final int x, final int z) {
		return this.chunk(x, z) != null;
	}

	BlockState state(final int x, final int y, final int z) {
		if (y < this.level.getMinY() || y > this.level.getMaxY()) {
			return Blocks.AIR.defaultBlockState();
		}
		LevelChunk chunk = this.chunk(x, z);
		if (chunk == null) {
			return Blocks.AIR.defaultBlockState();
		}
		return chunk.getBlockState(new BlockPos(x, y, z));
	}

	@Override
	public BlockState getBlockState(final BlockPos pos) {
		return this.state(pos.getX(), pos.getY(), pos.getZ());
	}

	@Override
	public FluidState getFluidState(final BlockPos pos) {
		return this.getBlockState(pos).getFluidState();
	}

	@Override
	public @Nullable BlockEntity getBlockEntity(final BlockPos pos) {
		return null;
	}

	@Override
	public int getHeight() {
		return this.level.getHeight();
	}

	@Override
	public int getMinY() {
		return this.level.getMinY();
	}
}
