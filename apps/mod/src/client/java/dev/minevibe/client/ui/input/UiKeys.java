package dev.minevibe.client.ui.input;

import com.mojang.blaze3d.platform.InputConstants;
import dev.minevibe.client.chat.ChatInterceptor;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.UiActions;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.hud.CrewHud;
import dev.minevibe.client.ui.screen.AgentScreen;
import dev.minevibe.client.ui.screen.CrewLogScreen;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import org.jspecify.annotations.Nullable;

/**
 * Keys (PLAN §7.8): G opens the presenter's front card, H toggles the CrewHud, J opens the Crew log (all rebindable),
 * and Alt+1-4 answers the presenter's front card while the crosshair is on it and the player is not in combat.
 * Alt+1-4 is observed, never consumed: the hotbar still switches.
 */
public final class UiKeys {
	private UiKeys() {}

	/** Own category id ({@code minevibe:crew}): other MineVibe features register their own. */
	public static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("minevibe", "crew"));

	private static @Nullable KeyMapping frontCard;
	private static @Nullable KeyMapping crewHud;
	private static @Nullable KeyMapping crewLog;

	public static void register() {
		frontCard = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.minevibe.front_card", InputConstants.KEY_G, CATEGORY));
		crewHud = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.minevibe.crew_hud", InputConstants.KEY_H, CATEGORY));
		crewLog = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.minevibe.crew_log", InputConstants.KEY_J, CATEGORY));
	}

	public static @Nullable KeyMapping frontCardKey() {
		return frontCard;
	}

	/** End of every client tick. */
	public static void tick(Minecraft mc) {
		if (frontCard == null || crewHud == null || crewLog == null) return;
		while (frontCard.consumeClick()) openFrontCard(mc);
		while (crewHud.consumeClick()) CrewHud.toggle();
		while (crewLog.consumeClick()) {
			if (mc.gui.screen() == null) mc.gui.setScreen(new CrewLogScreen());
		}
	}

	/**
	 * G: the presenter's front card; otherwise the agent under the crosshair; otherwise the agent whose card has waited
	 * longest. Opens that agent's AgentScreen on the card.
	 */
	public static void openFrontCard(Minecraft mc) {
		if (mc.gui.screen() != null || mc.player == null) return;
		UiState state = UiState.get();
		AgentView target = state.presenter();
		if (target == null && mc.crosshairPickEntity != null) target = AgentEntities.viewOf(mc.crosshairPickEntity);
		if (target == null) {
			List<AgentView> waiting = state.withCards();
			if (!waiting.isEmpty()) target = waiting.getFirst();
		}
		if (target == null) {
			state.addToast("No cards are waiting", "info", null, 2500);
			return;
		}
		var card = target.frontCard();
		mc.gui.setScreen(new AgentScreen(target.agentId(), card == null ? null : card.id()));
	}

	/** {@code KeyboardHandler#keyPress} (observed): Alt+1-4 answers the presenter's front card. */
	public static void onKey(int action, KeyEvent event) {
		if (action != InputConstants.PRESS || !event.hasAltDown()) return;
		int n = event.input() - InputConstants.KEY_1 + 1;
		if (n < 1 || n > 4) return;
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() != null || mc.player == null) return;
		answerByHotkey(mc, n, mc.crosshairPickEntity);
	}

	/** Answers option {@code n} if the crosshair is on the presenter and the player is not in combat. */
	public static boolean answerByHotkey(Minecraft mc, int n, @Nullable Entity aimedAt) {
		UiState state = UiState.get();
		AgentView presenter = state.presenter();
		AgentView aimed = aimedAt == null ? null : AgentEntities.viewOf(aimedAt);
		if (presenter == null || aimed != presenter) return false;
		if (AgentEntities.playerInCombat(mc)) {
			state.addToast("Not now: you are in combat", "warn", presenter.agentId(), 2500);
			return false;
		}
		CompletableFuture<String> reply = UiActions.answerFront(presenter, n);
		if (reply == null) {
			var card = presenter.frontCard();
			String agentId = presenter.agentId();
			String cardId = card == null ? null : card.id();
			// After this key event: opened now, the screen would also receive the key's character (Alt+2 types into it).
			UiActions.runOnClient(() -> {
				if (mc.gui.screen() == null) mc.gui.setScreen(new AgentScreen(agentId, cardId));
			});
			return true;
		}
		reply.whenComplete((echo, err) -> {
			if (err == null) {
				if (!echo.isEmpty()) ChatInterceptor.echo(echo);
			} else {
				state.addToast(UiActions.errorText(err), "warn", presenter.agentId(), 4000);
			}
		});
		return true;
	}
}
