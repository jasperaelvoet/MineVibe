package dev.minevibe.client.chat;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.client.ui.AgentView;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.protocol.game.ClientboundCustomChatCompletionsPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * {@code @name} Tab completion in the chat box (PLAN §6.5): whenever the crew changes, the integrated server sends the
 * local player a {@code ClientboundCustomChatCompletionsPacket(SET, ["@ada","@bram","@ceo","@all","@everyone"])},
 * and again when the player joins a world. The list mirrors Node's {@code chatCompletions} (living handles, the CEO
 * alias, the broadcast words).
 */
public final class ChatCompletions {
	private ChatCompletions() {}

	/** Read on the server thread (join), written on the client thread. */
	private static volatile List<String> entries = List.of();

	/** The completion entries for a crew. */
	public static List<String> entriesFor(Collection<AgentView> crew) {
		List<String> out = new ArrayList<>();
		boolean ceo = false;
		for (AgentView a : crew) {
			if (!a.alive()) continue;
			out.add("@" + a.handle());
			ceo |= a.ceo();
		}
		if (ceo) out.add("@ceo");
		out.add("@all");
		out.add("@everyone");
		return List.copyOf(out);
	}

	public static List<String> entries() {
		return entries;
	}

	/** Client thread: recompute from the crew and push to the integrated server's players when it changed. */
	public static void update(Collection<AgentView> crew) {
		List<String> next = entriesFor(crew);
		if (next.equals(entries)) return;
		entries = next;
		IntegratedServer server = Minecraft.getInstance().getSingleplayerServer();
		if (server != null && server.isRunning()) server.execute(() -> sendAll(server));
	}

	/** Server thread: a player joined. */
	public static void onJoin(ServerPlayer player) {
		if (!(player instanceof AgentPlayer) && !entries.isEmpty()) send(player);
	}

	private static void sendAll(MinecraftServer server) {
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (!(player instanceof AgentPlayer)) send(player);
		}
	}

	private static void send(ServerPlayer player) {
		player.connection.send(new ClientboundCustomChatCompletionsPacket(ClientboundCustomChatCompletionsPacket.Action.SET, entries));
	}
}
