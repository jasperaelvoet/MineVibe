package dev.minevibe.progression;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.Level;

/**
 * {@code minevibe:agent_core} (PLAN 7.5 "Agent Core"). Used on the top of two stacked copper blocks it performs the
 * awakening ritual ({@link Awakening}); anywhere else it does nothing. In the inventory it pays for hires
 * ({@link CorePayment}).
 */
public final class AgentCoreItem extends Item {
	public AgentCoreItem(final Item.Properties properties) {
		super(properties);
	}

	@Override
	public InteractionResult useOn(final UseOnContext context) {
		Level level = context.getLevel();
		BlockPos top = context.getClickedPos();
		if (!Awakening.isAltar(level, top)) {
			return InteractionResult.PASS;
		}
		if (!(level instanceof ServerLevel serverLevel)) {
			return InteractionResult.SUCCESS;
		}
		if (!(context.getPlayer() instanceof ServerPlayer player) || player instanceof AgentPlayer) {
			// Only the player wakes agents up (agents have no use for a core in their hands).
			return InteractionResult.PASS;
		}
		return Awakening.begin(serverLevel, top.below(), player, context.getItemInHand())
			? InteractionResult.SUCCESS_SERVER
			: InteractionResult.FAIL;
	}
}
