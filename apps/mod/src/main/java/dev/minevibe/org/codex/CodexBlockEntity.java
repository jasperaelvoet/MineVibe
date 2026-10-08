package dev.minevibe.org.codex;

import dev.minevibe.org.OrgContent;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The block entity of a codex's book part ({@link CodexPart#BOOK}). It holds no data: it exists so the client can
 * render the animated open book (CodexBookRenderer), which turns its pages on the level's game time.
 */
public final class CodexBlockEntity extends BlockEntity {
	public CodexBlockEntity(final BlockPos pos, final BlockState state) {
		super(OrgContent.CODEX_BLOCK_ENTITY, pos, state);
	}
}
