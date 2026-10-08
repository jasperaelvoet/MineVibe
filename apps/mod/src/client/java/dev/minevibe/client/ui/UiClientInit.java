package dev.minevibe.client.ui;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.chat.ChatCompletions;
import dev.minevibe.client.chat.ChatHint;
import dev.minevibe.client.chat.ChatInterceptor;
import dev.minevibe.client.ui.dev.UiDemo;
import dev.minevibe.client.ui.hud.CrewHud;
import dev.minevibe.client.ui.hud.OffscreenArrows;
import dev.minevibe.client.ui.hud.ToastHud;
import dev.minevibe.client.ui.input.AgentInteraction;
import dev.minevibe.client.ui.input.UiKeys;
import dev.minevibe.client.ui.mixin.ChatScreenAccessor;
import dev.minevibe.client.ui.render.BubbleRenderer;
import java.util.function.Consumer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelExtractionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.Player;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint for the in-game UI and messaging (PLAN §6.4, §6.5, §7.8): bubbles and head icons, name-tag model
 * suffixes, AgentScreen, CrewHud, toasts, the Crew log, keys, chat interception and {@code @name} completion.
 *
 * <p>Listed after {@code MineVibeClient} in {@code fabric.mod.json}, so the bridge exists (and has not finished
 * connecting) when the UI group's handlers are registered here: {@code agent.say}, {@code ui.toast},
 * {@code agent.brain}, {@code agent.pending}, {@code chat.append}, {@code crew.state} and {@code brains.state}, all on
 * the client thread into {@link UiState}. ({@code agent.approach} is left to the body side; the UI reads the presenter
 * from the cards' {@code presenting} flag.)
 */
public final class UiClientInit implements ClientModInitializer {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/UI");

	@Override
	public void onInitializeClient() {
		UiKeys.register();
		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			AgentEntities.tick(mc);
			UiKeys.tick(mc);
			UiDemo.tick(mc);
		});

		LevelExtractionEvents.END_EXTRACTION.register(BubbleRenderer::extract);
		LevelRenderEvents.COLLECT_SUBMITS.register(BubbleRenderer::submit);

		HudElementRegistry.addLast(id("crew_hud"), CrewHud::extract);
		HudElementRegistry.addLast(id("offscreen_arrows"), OffscreenArrows::extract);
		HudElementRegistry.addLast(id("toasts"), ToastHud::extract);

		UseEntityCallback.EVENT.register(AgentInteraction::onUseEntity);
		ClientSendMessageEvents.ALLOW_CHAT.register(ChatInterceptor::onAllowChat);
		ScreenEvents.AFTER_INIT.register((mc, screen, w, h) -> {
			if (screen instanceof ChatScreen chat) {
				ScreenEvents.afterExtract(screen).register((s, g, mx, my, delta) -> {
					String hint = ChatHint.current(((ChatScreenAccessor) chat).minevibe$input().getValue());
					if (hint == null) return;
					int y = s.height - 26;
					g.fill(2, y - 2, 4 + mc.font.width(hint) + 4, y + 10, 0xD0300000);
					g.text(mc.font, hint, 5, y, 0xFFFF8080, false);
				});
			}
		});
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> ChatCompletions.onJoin(handler.player));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(() -> {
			UiState.get().clearTransient();
			ChatHint.clear();
		}));

		BridgeClient bridge = MineVibeBridge.get();
		if (bridge != null) registerHandlers(bridge);
		UiDemo.init();
	}

	private static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath("minevibe", path);
	}

	/** The UI group's pushes, applied to {@link UiState} on the client thread. */
	static void registerHandlers(BridgeClient bridge) {
		UiState state = UiState.get();
		on(bridge, Bodies.CREW_STATE, crew -> {
			state.applyCrew(crew);
			ChatCompletions.update(state.agents());
		});
		on(bridge, Ui.AGENT_BRAIN, state::applyBrain);
		on(bridge, Ui.AGENT_PENDING, state::applyPending);
		on(bridge, Ui.CHAT_APPEND, state::applyChat);
		on(bridge, Ui.BRAINS_STATE, state::applyBrains);
		on(bridge, Messages.AGENT_SAY, UiClientInit::onSay);
		on(bridge, Messages.UI_TOAST, t -> state.addToast(t.text(), t.kind(), t.agentId(), t.ttlMs() == null ? 0 : t.ttlMs()));
	}

	/** A line spoken where the player cannot see the bubble (no body nearby) becomes a toast (PLAN §7.8). */
	static void onSay(Messages.AgentSay say) {
		UiState state = UiState.get();
		Bubble bubble = state.applySay(say);
		if (bubble == null || !bubble.addressedToPlayer()) return;
		Minecraft mc = Minecraft.getInstance();
		AgentView agent = state.agent(say.agentId());
		Player body = agent == null || mc.level == null ? null : AgentEntities.body(mc.level, agent);
		boolean near = body != null && mc.player != null && body.distanceTo(mc.player) <= BubbleLayout.MAX_BUBBLE_DISTANCE;
		if (!near && mc.level != null) {
			state.addToast(BubbleLayout.clip(bubble.text(), 160), "info", say.agentId(), 0);
		}
	}

	private static <P> void on(BridgeClient bridge, MessageType<P> type, Consumer<P> consumer) {
		try {
			bridge.on(type, Route.CLIENT, consumer);
		} catch (IllegalStateException e) {
			// One handler per type: another feature took it. The UI then misses these pushes; say so loudly.
			LOG.error("{} already has a bridge handler; the in-game UI will not see it ({})", type, e.getMessage());
		}
	}
}
