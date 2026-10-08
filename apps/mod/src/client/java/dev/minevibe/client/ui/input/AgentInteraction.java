package dev.minevibe.client.ui.input;

import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.UiActions;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.screen.AgentScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.EntityHitResult;
import org.jspecify.annotations.Nullable;

/**
 * Right-clicking an agent (PLAN §7.8 "Opening an agent"), through Fabric's client-side {@code UseEntityCallback}:
 *
 * <ul>
 *   <li>Opens its AgentScreen and returns {@code FAIL}, which cancels vanilla and sends nothing to the server
 *       (API_MAP 4.3).</li>
 *   <li>Sneak-right-clicking a seated agent opens a kick confirmation; it never kicks at once.</li>
 *   <li>With food in the main hand the click passes through ({@code PASS}): feeding a hungry agent is the server's
 *       business (the client does not know an agent's hunger).</li>
 * </ul>
 */
public final class AgentInteraction {
	private AgentInteraction() {}

	public static InteractionResult onUseEntity(Player player, Level level, InteractionHand hand, Entity entity, @Nullable EntityHitResult hit) {
		if (!level.isClientSide() || hand != InteractionHand.MAIN_HAND) return InteractionResult.PASS;
		String agentId = AgentEntities.agentIdOf(entity);
		if (agentId == null) return InteractionResult.PASS;
		if (player.getMainHandItem().has(DataComponents.FOOD)) return InteractionResult.PASS;
		Minecraft mc = Minecraft.getInstance();
		if (player.isShiftKeyDown() && AgentEntities.onSeat(entity)) {
			confirmKick(mc, agentId);
			return InteractionResult.FAIL;
		}
		open(mc, agentId);
		return InteractionResult.FAIL;
	}

	/** Opens the agent's screen, on its front card when it has one. */
	public static void open(Minecraft mc, String agentId) {
		AgentView view = UiState.get().agent(agentId);
		var card = view == null ? null : view.frontCard();
		mc.gui.setScreen(new AgentScreen(agentId, card == null ? null : card.id()));
	}

	static void confirmKick(Minecraft mc, String agentId) {
		String name = UiState.get().nameOf(agentId);
		mc.gui.setScreen(new ConfirmScreen(
				yes -> {
					mc.gui.setScreen(null);
					if (!yes) return;
					UiActions.command(agentId, "kick", null, null).whenComplete((echo, err) -> {
						if (err != null) UiState.get().addToast(UiActions.errorText(err), "warn", agentId, 4000);
						else if (!echo.isEmpty()) UiState.get().addToast(echo, "info", agentId, 3000);
					});
				},
				Component.literal("Kick " + name + " off the PC?"),
				Component.literal(name + " stands up and stops what it is doing at the PC.")));
	}
}
