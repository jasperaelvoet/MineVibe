package dev.minevibe.mixin.provenance;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Provenance;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.context.BlockPlaceContext;
import org.spongepowered.asm.mixin.Mixin;

/**
 * Block provenance (W1): every block a server player places through a block item ({@code BlockItem#place}, which
 * every block item uses: doors, beds, torches, signs, seeds...) is recorded as that player's, or as the agent's when an
 * agent placed it. The blocks set while placing are marked by {@code LevelChunkMixin} through
 * {@link Provenance#placingAs}.
 */
@Mixin(BlockItem.class)
public abstract class BlockItemMixin {
	@WrapMethod(method = "place")
	private InteractionResult minevibe$recordPlacer(final BlockPlaceContext context, final Operation<InteractionResult> original) {
		if (context.getLevel().isClientSide() || !(context.getPlayer() instanceof ServerPlayer player)) {
			return original.call(context);
		}
		Owner owner = player instanceof AgentPlayer agent
			? Owner.agent(agent.agentId(), agent.getGameProfile().name())
			: Owner.player(player.getUUID(), player.getGameProfile().name());
		return Provenance.placingAs(owner, () -> original.call(context));
	}
}
