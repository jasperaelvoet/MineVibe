package dev.minevibe.org.codex;

import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerBlockEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * Where the loaded codex blocks are, for agents that walk over to "file" what they wrote (PLAN §6.6: an idle agent
 * within 16 blocks of a codex goes to it). Every codex reaches the same Codex; this is only about the physical
 * block. Tracks each codex by its anchor. Server thread only.
 */
public final class Codexes {
	/** Book parts of loaded codexes per dimension. */
	private static final Map<ResourceKey<Level>, Set<BlockPos>> LOADED = new HashMap<>();

	private Codexes() {
	}

	public static void registerEvents() {
		ServerBlockEntityEvents.BLOCK_ENTITY_LOAD.register((blockEntity, level) -> {
			if (blockEntity instanceof CodexBlockEntity) {
				LOADED.computeIfAbsent(level.dimension(), k -> new LinkedHashSet<>()).add(blockEntity.getBlockPos().immutable());
			}
		});
		ServerBlockEntityEvents.BLOCK_ENTITY_UNLOAD.register((blockEntity, level) -> {
			if (blockEntity instanceof CodexBlockEntity) {
				Set<BlockPos> set = LOADED.get(level.dimension());
				if (set != null) {
					set.remove(blockEntity.getBlockPos());
				}
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> LOADED.clear());
	}

	/**
	 * The anchor of the complete codex nearest to {@code near} within {@code radius} blocks, or null. The spot to walk
	 * to is in front of it: {@code anchor.relative(facing)}.
	 */
	public static @Nullable BlockPos nearest(final ServerLevel level, final BlockPos near, final int radius) {
		long max = (long)radius * radius;
		return List.copyOf(LOADED.getOrDefault(level.dimension(), Set.of())).stream()
			.filter(book -> book.distSqr(near) <= max && CodexBlock.isComplete(level, book))
			.min(Comparator.comparingDouble((BlockPos book) -> book.distSqr(near)))
			.map(book -> CodexBlock.anchorOf(book, level.getBlockState(book)))
			.orElse(null);
	}
}
