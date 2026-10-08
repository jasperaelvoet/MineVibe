package dev.minevibe.world.provenance;

import dev.minevibe.MineVibeMod;
import java.util.function.Supplier;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.AttachedStemBlock;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.CocoaBlock;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.NetherWartBlock;
import net.minecraft.world.level.block.SaplingBlock;
import net.minecraft.world.level.block.StemBlock;
import net.minecraft.world.level.block.SweetBerryBushBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * Block provenance: which blocks a player, an agent or the base put into the world, so agents can tell a player's
 * house from a forest. Server side only.
 *
 * <ul>
 *   <li><b>Recording.</b> {@code BlockItemMixin} wraps {@code BlockItem#place} for server players (agents are server
 *       players too) in {@link #placingAs}; {@code LevelChunkMixin} reports every block change of a server chunk to
 *       {@link #onBlockChanged}, which marks a new block set while someone is placing (both halves of a door or bed,
 *       not the neighbours whose shape changed). {@code OfficeBuilder} builds the starter office as
 *       {@link Owner#base} the same way.</li>
 *   <li><b>Clearing.</b> A marked block that turns into air or a fluid (broken, exploded, burnt, washed away) loses
 *       its mark. A block that only changes state or kind in place (a door opening, copper weathering, a log stripped,
 *       grass spreading over the player's dirt) keeps it.</li>
 *   <li><b>Not recorded:</b> crops, stems, saplings, berry bushes, cocoa, nether wart and fire. They are planted to be
 *       harvested or to grow; a tree grown from a sapling is natural.</li>
 *   <li><b>Storage.</b> {@link ChunkMarks} per chunk, a persistent Fabric data attachment ({@link #MARKS}) saved with
 *       the chunk.</li>
 * </ul>
 */
public final class Provenance {
	public static final AttachmentType<ChunkMarks> MARKS = AttachmentRegistry.create(
		MineVibeMod.id("provenance"), builder -> builder.persistent(ChunkMarks.CODEC));

	/** Who is placing right now (server thread), or null. */
	private static @Nullable Owner placing;

	private Provenance() {
	}

	/** Loads the class (registers the attachment type) during mod initialisation. */
	public static void init() {
	}

	public static @Nullable Owner placing() {
		return placing;
	}

	/** Runs {@code body} with every block it sets marked as {@code owner}'s (server thread). */
	public static <T> T placingAs(final Owner owner, final Supplier<T> body) {
		Owner previous = placing;
		placing = owner;
		try {
			return body.get();
		} finally {
			placing = previous;
		}
	}

	public static void placingAs(final Owner owner, final Runnable body) {
		placingAs(owner, () -> {
			body.run();
			return null;
		});
	}

	/** The owner of the block at {@code pos}, or null when it is natural (or its chunk is not loaded). */
	public static @Nullable Owner ownerAt(final ServerLevel level, final BlockPos pos) {
		LevelChunk chunk = level.getChunkSource().getChunkNow(SectionPos.blockToSectionCoord(pos.getX()), SectionPos.blockToSectionCoord(pos.getZ()));
		return chunk == null ? null : ownerAt(chunk, pos);
	}

	public static @Nullable Owner ownerAt(final LevelChunk chunk, final BlockPos pos) {
		ChunkMarks marks = chunk.getAttached(MARKS);
		return marks == null ? null : marks.get(pos);
	}

	/** The marks of a loaded chunk, or null (none, or not loaded). Read only. */
	public static @Nullable ChunkMarks marksOf(final ServerLevel level, final int chunkX, final int chunkZ) {
		LevelChunk chunk = level.getChunkSource().getChunkNow(chunkX, chunkZ);
		return chunk == null ? null : chunk.getAttached(MARKS);
	}

	/** Marks the block at {@code pos} as {@code owner}'s (GameTests and hand-made structures). */
	public static void mark(final ServerLevel level, final BlockPos pos, final Owner owner) {
		mark(level.getChunkAt(pos), pos, owner);
	}

	public static void unmark(final ServerLevel level, final BlockPos pos) {
		unmark(level.getChunkAt(pos), pos);
	}

	static void mark(final LevelChunk chunk, final BlockPos pos, final Owner owner) {
		ChunkMarks marks = chunk.getAttached(MARKS);
		if (marks == null) {
			marks = new ChunkMarks();
			marks.put(pos, owner);
			chunk.setAttached(MARKS, marks);
			return;
		}
		if (marks.put(pos, owner)) {
			chunk.markUnsaved();
		}
	}

	static void unmark(final LevelChunk chunk, final BlockPos pos) {
		ChunkMarks marks = chunk.getAttached(MARKS);
		if (marks != null && marks.remove(pos)) {
			if (marks.isEmpty()) {
				chunk.removeAttached(MARKS);
			}
			chunk.markUnsaved();
		}
	}

	/** {@code LevelChunkMixin}: the block at {@code pos} of a server chunk changed from {@code old} to {@code now}. */
	public static void onBlockChanged(final LevelChunk chunk, final BlockPos pos, final BlockState old, final BlockState now) {
		if (now.isAir() || now.getBlock() instanceof LiquidBlock) {
			unmark(chunk, pos);
			return;
		}
		Owner owner = placing;
		if (owner != null && old.getBlock() != now.getBlock()) {
			if (markable(now)) {
				mark(chunk, pos, owner);
			} else {
				unmark(chunk, pos);
			}
		}
	}

	/** False for plants that are meant to be harvested or to grow, and for fire. */
	public static boolean markable(final BlockState state) {
		Block b = state.getBlock();
		return !(b instanceof CropBlock || b instanceof StemBlock || b instanceof AttachedStemBlock || b instanceof SaplingBlock
			|| b instanceof SweetBerryBushBlock || b instanceof NetherWartBlock || b instanceof CocoaBlock || b instanceof BaseFireBlock);
	}
}
