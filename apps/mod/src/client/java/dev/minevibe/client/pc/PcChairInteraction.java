package dev.minevibe.client.pc;

import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.pc.PcSeatRegistry;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.SeatEntity;
import java.util.List;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import org.jspecify.annotations.Nullable;

/**
 * Right-clicking a PC chair an agent sits on (PLAN 7.7.8): "Kick Bram and sit?". Confirming kicks the agent on the
 * integrated server ({@link PcSeatRegistry#kickAndSit}: the kick is noted before the dismount, so Node gets
 * {@code pc.unseat{kick}} and a {@code kicked} event, then {@code pc.seat{player}}). It never kicks at once. A free or
 * merely reserved chair is left to the chair block (sitting there ends the reservation).
 */
public final class PcChairInteraction {
	private PcChairInteraction() {}

	/** {@code UseBlockCallback} on the client: FAIL (nothing reaches the server) while the confirmation is open. */
	public static InteractionResult onUseBlock(final Player player, final Level level, final InteractionHand hand, final BlockHitResult hit) {
		if (!level.isClientSide() || hand != InteractionHand.MAIN_HAND || player.isSpectator() || player.isShiftKeyDown()) {
			return InteractionResult.PASS;
		}
		BlockPos chair = hit.getBlockPos();
		if (!level.getBlockState(chair).is(MvWorldContent.OFFICE_CHAIR) || PcClientMonitors.pcForChair(chair) == null) {
			return InteractionResult.PASS;
		}
		String agentId = agentOn(level, chair, player);
		if (agentId == null) {
			return InteractionResult.PASS;
		}
		confirm(Minecraft.getInstance(), agentId, chair.immutable());
		return InteractionResult.FAIL;
	}

	/** The agent sitting on the PC seat of the chair at {@code chair} (client view), or null. */
	static @Nullable String agentOn(final Level level, final BlockPos chair, final Player player) {
		List<SeatEntity> seats = level.getEntitiesOfClass(SeatEntity.class, new AABB(chair).inflate(0.5), s -> chair.equals(s.blockPosition()) && s.isPcSeat());
		for (SeatEntity seat : seats) {
			for (Entity sitter : seat.getPassengers()) {
				if (sitter != player) {
					String agentId = AgentEntities.agentIdOf(sitter);
					if (agentId != null) {
						return agentId;
					}
				}
			}
		}
		return null;
	}

	private static void confirm(final Minecraft mc, final String agentId, final BlockPos chair) {
		String name = UiState.get().nameOf(agentId);
		mc.gui.setScreen(new ConfirmScreen(
			yes -> {
				mc.gui.setScreen(null);
				if (yes) {
					kickAndSit(mc, chair);
				}
			},
			Component.literal("Kick " + name + " and sit?"),
			Component.literal(name + " stands up and stops what it is doing at the PC.")));
	}

	/** Runs the kick and the sit on the integrated server (UI actions reach it through {@code server.execute}). */
	static void kickAndSit(final Minecraft mc, final BlockPos chair) {
		IntegratedServer server = mc.getSingleplayerServer();
		if (server == null || mc.player == null) {
			return;
		}
		UUID id = mc.player.getUUID();
		server.execute(() -> {
			ServerPlayer player = server.getPlayerList().getPlayer(id);
			if (player != null) {
				PcSeatRegistry.INSTANCE.kickAndSit(player, chair);
			}
		});
	}
}
