package dev.minevibe.client.e2e;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.msg.Debug;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.client.ClientSession;
import dev.minevibe.client.chat.ChatHint;
import dev.minevibe.client.chat.ChatInterceptor;
import dev.minevibe.client.pc.frame.MonitorTextures;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.Bubble;
import dev.minevibe.client.ui.FrontCards;
import dev.minevibe.client.ui.HeadIcon;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import dev.minevibe.client.boot.GameOverScreen;
import dev.minevibe.client.boot.ScreenRouter;
import dev.minevibe.client.menu.MineVibeMenuScreen;
import dev.minevibe.hardcore.HardcoreHooks;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * E2E hooks (PLAN §5 "debug", §13.7), registered only with {@code -Dminevibe.e2e=true}. Without them the mod
 * answers these requests with {@code err NOT_HANDLED}.
 */
public final class DebugHandlers {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/E2E");

	private DebugHandlers() {}

	public static void register(BridgeClient bridge) {
		LOG.warn("E2E debug handlers are enabled (-Dminevibe.e2e=true)");
		bridge.handle(Messages.DEBUG_STATE, Route.CLIENT, req -> state(Minecraft.getInstance()));
		bridge.handle(Messages.DEBUG_KILL_PLAYER, Route.SERVER, req -> killPlayer());
		bridge.handle(Messages.DEBUG_OPEN_MENU, Route.CLIENT, req -> openMenu(Minecraft.getInstance()));
		bridge.handle(Messages.DEBUG_CLICK_BEGIN, Route.CLIENT, req -> clickBegin(Minecraft.getInstance()));
		bridge.handle(Debug.DEBUG_CHAT, Route.CLIENT, req -> chat(req.text()));
		bridge.handleAsync(Debug.DEBUG_UI_REQUEST, Route.BRIDGE, DebugHandlers::uiRequest);
	}

	/**
	 * A chat line as the player submits it: {@link ChatInterceptor#onAllowChat} (the local mention check, then
	 * {@code chat.send}; Node's echo or refusal lands in the chat log as for a typed line).
	 */
	private static Map<String, Object> chat(String text) {
		ChatInterceptor.onAllowChat(text);
		boolean refused = ChatInterceptor.consumeKeepOpen();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("sent", !refused);
		m.put("hint", refused ? ChatHint.current(text.trim()) : null);
		if (refused) ChatHint.clear();
		return m;
	}

	/** Sends one mod-to-Node request through the UI's transport, as a screen would; the reply is Node's result. */
	private static CompletableFuture<Map<String, Object>> uiRequest(Debug.DebugUiRequest req) {
		MessageType<?> type = Messages.byName(req.type());
		if (type == null || !type.direction().modSends()) {
			return CompletableFuture.failedFuture(
					new BridgeException(Codes.BAD_ARGS, "not a mod-to-Node message type: " + req.type()));
		}
		return send(type, req.payload());
	}

	private static <P> CompletableFuture<Map<String, Object>> send(MessageType<P> type, com.google.gson.JsonObject json) {
		P payload;
		try {
			payload = ProtocolCodec.GSON.fromJson(json, type.payloadClass());
		} catch (RuntimeException e) {
			return CompletableFuture.failedFuture(new BridgeException(Codes.BAD_ARGS, "payload: " + e.getMessage()));
		}
		LOG.info("UI request {} (debug.ui_request)", type.name());
		return UiTransport.current().request(type, payload).handle((reply, err) -> {
			if (err != null) {
				BridgeException be = BridgeClient.unwrap(err);
				throw be != null ? be : new BridgeException(Codes.INTERNAL, String.valueOf(err.getMessage()));
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("reply", reply);
			return m;
		});
	}

	/** The {@code DebugStateResult} snapshot (every key present; null when not applicable). */
	static Map<String, Object> state(Minecraft mc) {
		Map<String, Object> m = new LinkedHashMap<>();
		Screen screen = mc.gui.screen();
		IntegratedServer server = mc.getSingleplayerServer();
		ClientSession session = ClientSession.get();
		boolean inWorld = mc.level != null && mc.player != null;
		String worldId = server != null ? HardcoreHooks.levelId(server) : session.worldId();
		if (screen instanceof GameOverScreen gameOver && !inWorld) worldId = gameOver.worldId();
		m.put("screen", screen == null ? null : ScreenRouter.name(screen));
		m.put("worldId", Messages.isWorldId(worldId) ? worldId : null);
		m.put("gen", session.gen() > 0 && worldId != null && worldId.equals(session.worldId()) ? session.gen() : null);
		m.put("inWorld", inWorld);
		m.put("hardcore", mc.level != null ? mc.level.getLevelData().isHardcore() : null);
		m.put("difficulty", mc.level != null ? mc.level.getLevelData().getDifficulty().getSerializedName() : null);
		m.put("gameMode", mc.gameMode != null && inWorld ? mc.gameMode.getPlayerMode().getSerializedName() : null);
		m.put("allowCommands", server != null ? server.getWorldData().isAllowCommands() : null);
		m.put("paused", mc.isPaused());
		m.put("serverTicks", server != null ? server.getTickCount() : null);
		m.put("serverPaused", server != null ? server.isPaused() : null);
		m.put("hp", mc.player != null ? Math.max(0f, mc.player.getHealth()) : null);
		m.put("dead", mc.player != null ? mc.player.isDeadOrDying() : null);
		m.put("pid", ProcessHandle.current().pid());
		m.put("player", mc.player != null ? pos(mc.player.position()) : null);
		m.put("agents", agents(mc));
		m.put("monitors", MonitorTextures.debugSnapshot());
		return m;
	}

	private static Map<String, Object> pos(Vec3 v) {
		Map<String, Object> p = new LinkedHashMap<>();
		p.put("x", Math.round(v.x * 100) / 100.0);
		p.put("y", Math.round(v.y * 100) / 100.0);
		p.put("z", Math.round(v.z * 100) / 100.0);
		return p;
	}

	/** The crew as the client shows it: body, live bubble, head icon (as BubbleRenderer picks it). */
	private static List<Map<String, Object>> agents(Minecraft mc) {
		UiState ui = UiState.get();
		boolean online = UiTransport.current().connected();
		List<Map<String, Object>> out = new ArrayList<>();
		for (AgentView a : ui.agents()) {
			Player body = mc.level != null ? AgentEntities.body(mc.level, a) : null;
			boolean atPc = body != null && AgentEntities.atPc(body, a);
			Bubble bubble = ui.bubble(a.agentId());
			int cards = 0;
			for (var card : a.cards()) {
				if (!FrontCards.complete(card)) cards++;
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("agentId", a.agentId());
			m.put("handle", a.handle());
			m.put("status", a.status());
			m.put("brain", a.brain());
			m.put("headIcon", HeadIcon.of(a, atPc, online).name());
			m.put("bubble", bubble != null ? bubble.text() : null);
			m.put("cards", cards);
			m.put("pos", body != null ? pos(body.position()) : null);
			m.put("atPc", atPc);
			out.add(m);
		}
		return out;
	}

	/**
	 * Server thread: kills the local player as {@code /kill} would. A player who joined moments ago is invulnerable
	 * until its client reports "loaded" (vanilla, {@code ServerPlayer#isInvulnerableTo}; not even {@code /kill}'s
	 * damage gets through), so that answers NOT_READY instead of silently doing nothing.
	 */
	private static Map<String, Object> killPlayer() {
		IntegratedServer server = Minecraft.getInstance().getSingleplayerServer();
		if (server == null) throw new BridgeException(Codes.NO_SERVER, "no integrated server is running");
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (server.isSingleplayerOwner(player.nameAndId())) {
				if (player.isDeadOrDying()) throw new BridgeException(Codes.NOT_READY, "the player is already dead");
				if (!player.connection.hasClientLoaded()) {
					throw new BridgeException(Codes.NOT_READY, "the player is still loading (invulnerable until then)");
				}
				LOG.info("Killing the player (debug.kill_player)");
				player.kill(player.level());
				if (!player.isDeadOrDying()) throw new BridgeException(Codes.NOT_READY, "the player survived the kill");
				return Map.of();
			}
		}
		throw new BridgeException(Codes.NOT_READY, "the local player is not in the world");
	}

	/** Opens the in-game menu the way Esc does ({@code Minecraft#pauseGame}). */
	private static Map<String, Object> openMenu(Minecraft mc) {
		if (mc.level == null || mc.player == null) throw new BridgeException(Codes.NOT_READY, "not in a world");
		if (!(mc.gui.screen() instanceof MineVibeMenuScreen)) {
			if (mc.gui.screen() != null) mc.gui.setScreen(null);
			mc.pauseGame(false);
		}
		Screen screen = mc.gui.screen();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("screen", screen == null ? null : ScreenRouter.name(screen));
		return m;
	}

	private static Map<String, Object> clickBegin(Minecraft mc) {
		if (!(mc.gui.screen() instanceof GameOverScreen gameOver)) {
			throw new BridgeException(Codes.NOT_READY, "not on the Game Over screen (" + ScreenRouter.name(mc.gui.screen()) + ")");
		}
		if (!gameOver.requestBegin()) throw new BridgeException(Codes.NOT_READY, "Begin is not enabled yet");
		LOG.info("Begin pressed (debug.click_begin)");
		return Map.of();
	}
}
