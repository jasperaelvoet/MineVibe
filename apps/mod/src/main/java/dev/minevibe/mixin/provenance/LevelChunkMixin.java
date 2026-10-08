package dev.minevibe.mixin.provenance;

import dev.minevibe.world.provenance.Provenance;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Block provenance (W1): {@code LevelChunk#setBlockState} is the one place every block change of a loaded chunk goes
 * through (players, agents, explosions, pistons, growth, commands, structures). Server chunks report each real change
 * to {@link Provenance#onBlockChanged}, which records placements and clears the marks of removed blocks.
 */
@Mixin(LevelChunk.class)
public abstract class LevelChunkMixin {
	@Shadow
	public abstract Level getLevel();

	@Inject(method = "setBlockState", at = @At("RETURN"))
	private void minevibe$trackProvenance(final BlockPos pos, final BlockState state, final int flags, final CallbackInfoReturnable<BlockState> cir) {
		BlockState old = cir.getReturnValue();
		if (old == null || this.getLevel().isClientSide()) {
			return;
		}
		Provenance.onBlockChanged((LevelChunk)(Object)this, pos, old, state);
	}
}
