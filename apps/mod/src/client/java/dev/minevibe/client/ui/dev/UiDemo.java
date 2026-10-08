package dev.minevibe.client.ui.dev;

import com.mojang.blaze3d.platform.InputConstants;
import dev.minevibe.client.chat.ChatHint;
import dev.minevibe.client.chat.ChatInterceptor;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import dev.minevibe.client.ui.input.AgentInteraction;
import dev.minevibe.client.ui.render.BubbleRenderer;
import dev.minevibe.client.ui.screen.AgentScreen;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.PermissionSet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A dev-only walkthrough of the UI against {@code npm run dev -- --scripted-crew}, for visual checks without typing:
 * enabled with {@code -Dminevibe.ui.demo=true} (for example {@code JAVA_TOOL_OPTIONS=-Dminevibe.ui.demo=true
 * ./gradlew runClient}). Once in the world with the crew known it:
 * <ol>
 *   <li>spawns the crew's bodies in front of the player with the dev command ({@code /mv agent spawn}),</li>
 *   <li>sends {@code @ada please ask me a question} and {@code @bram tell me the long story} through the real chat path
 *       (intercepted by {@code ALLOW_CHAT}),</li>
 *   <li>takes in-game screenshots (bubbles, card mode, icons, CrewHud; AgentScreen; a chat hint), and</li>
 *   <li>logs every step as {@code [ui-demo]}; with {@code -Dminevibe.ui.demo.quit=true} it quits at the end.</li>
 * </ol>
 * Screenshots land in {@code <gameDir>/screenshots/minevibe-ui-*.png}.
 */
public final class UiDemo {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/UiDemo");

	private UiDemo() {}

	private static boolean enabled;
	private static int step;
	private static int wait;

	public static void init() {
		enabled = Boolean.getBoolean("minevibe.ui.demo");
		if (enabled) LOG.warn("[ui-demo] UI demo enabled (-Dminevibe.ui.demo=true)");
	}

	public static void tick(Minecraft mc) {
		if (!enabled) return;
		if (wait > 0) {
			wait--;
			return;
		}
		try {
			run(mc);
		} catch (RuntimeException e) {
			LOG.error("[ui-demo] step {} failed", step, e);
			enabled = false;
		}
	}

	private static void run(Minecraft mc) {
		UiState state = UiState.get();
		switch (step) {
			case 0 -> {
				IntegratedServer server = mc.getSingleplayerServer();
				if (mc.player == null || mc.level == null || server == null || state.living().isEmpty() || !UiTransport.current().connected()) {
					wait = 20;
					return;
				}
				LOG.info("[ui-demo] in world with crew {}", state.living().stream().map(AgentView::handle).toList());
				spawnBodies(mc, server, state.living());
				next(60);
			}
			case 1 -> {
				List<String> bodies = new ArrayList<>();
				for (AgentView a : state.living()) if (AgentEntities.body(mc.level, a) != null) bodies.add(a.handle());
				LOG.info("[ui-demo] bodies loaded on the client: {}", bodies);
				mc.player.setXRot(5f);
				say(mc, "@ada please ask me a question");
				say(mc, "@bram tell me the long story");
				next(80);
			}
			case 2 -> {
				for (AgentView a : state.living()) {
					LOG.info("[ui-demo] {} brain={} model={} cards={} presenting={} bubble={}",
							a.handle(), a.brain(), a.model(), a.cards().size(), a.presenting(),
							state.bubble(a.agentId()) == null ? null : state.bubble(a.agentId()).text());
				}
				LOG.info("[ui-demo] bubbles/icons submitted last frame: {}", BubbleRenderer.lastSubmitted());
				shot(mc, "minevibe-ui-1-bubbles.png");
				next(20);
			}
			case 3 -> {
				AgentInteraction.open(mc, "ada");
				next(30);
			}
			case 4 -> {
				LOG.info("[ui-demo] screen: {}", mc.gui.screen() == null ? null : mc.gui.screen().getClass().getSimpleName());
				shot(mc, "minevibe-ui-2-agentscreen.png");
				next(20);
			}
			case 5 -> {
				mc.gui.setScreen(null);
				ChatScreen chat = new ChatScreen("@zed hello", false);
				mc.gui.setScreen(chat);
				chat.keyPressed(new KeyEvent(InputConstants.KEY_RETURN, 13, 0));
				LOG.info("[ui-demo] '@zed hello' -> screen {} hint '{}'",
						mc.gui.screen() == null ? null : mc.gui.screen().getClass().getSimpleName(), ChatHint.current("@zed hello"));
				next(10);
			}
			case 6 -> {
				shot(mc, "minevibe-ui-3-chat-hint.png");
				next(20);
			}
			case 7 -> {
				mc.gui.setScreen(null);
				say(mc, "@ada 2");
				next(60);
			}
			case 8 -> {
				AgentView ada = state.agent("ada");
				LOG.info("[ui-demo] after '@ada 2': ada cards={} bubble={}", ada == null ? -1 : ada.cards().size(),
						state.bubble("ada") == null ? null : state.bubble("ada").text());
				shot(mc, "minevibe-ui-4-answered.png");
				next(40);
			}
			default -> {
				LOG.info("[ui-demo] done");
				enabled = false;
				if (Boolean.getBoolean("minevibe.ui.demo.quit")) mc.stop();
			}
		}
	}

	private static void next(int ticks) {
		step++;
		wait = ticks;
	}

	/** Sends a chat line the way the chat box does (ClientPacketListener#sendChat, where ALLOW_CHAT intercepts). */
	private static void say(Minecraft mc, String line) {
		if (mc.player == null) return;
		mc.gui.hud.getChat().addRecentChat(line);
		mc.player.connection.sendChat(line);
		LOG.info("[ui-demo] sent '{}' (intercepted: {})", line, ChatInterceptor.active());
	}

	private static void spawnBodies(Minecraft mc, IntegratedServer server, List<AgentView> crew) {
		List<String> commands = new ArrayList<>();
		double offset = (crew.size() - 1) * 1.25;
		for (AgentView a : crew) {
			if (AgentEntities.body(mc.level, a) == null) {
				String role = a.ceo() ? "ceo" : a.role();
				String name = a.name().replaceAll("[^A-Za-z0-9_]", "");
				commands.add(String.format(Locale.ROOT,
						"execute positioned ^%.2f ^ ^3 rotated ~180 0 run mv agent spawn %s %s", offset, name, role));
			}
			offset -= 2.5;
		}
		String playerName = mc.player.getGameProfile().name();
		server.execute(() -> {
			ServerPlayer player = server.getPlayerList().getPlayerByName(playerName);
			if (player == null) return;
			for (String cmd : commands) {
				server.getCommands().performPrefixedCommand(player.createCommandSourceStack().withPermission(PermissionSet.ALL_PERMISSIONS), cmd);
				LOG.info("[ui-demo] /{}", cmd);
			}
		});
	}

	private static void shot(Minecraft mc, String name) {
		Screenshot.grab(mc.gameDirectory, name, mc.gameRenderer.mainRenderTarget(), 1,
				message -> LOG.info("[ui-demo] screenshot {}: {}", name, message.getString()));
	}
}
