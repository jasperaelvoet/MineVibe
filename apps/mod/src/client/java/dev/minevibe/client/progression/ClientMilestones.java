package dev.minevibe.client.progression;

import dev.minevibe.client.ClientSession;
import dev.minevibe.client.ui.UiActions;
import dev.minevibe.progression.Milestone;
import dev.minevibe.progression.Milestones;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * The guide milestones only the client sees (see {@link Milestone}): what the player sends Node (chat, card answers,
 * orders, Codex pages, calendar events, meetings) and the world number Node opened. Each one is handed to the
 * integrated server (the way UI actions reach it, through {@code server.execute}) only once Node accepted the request,
 * so a refused or failed one earns nothing. Any thread.
 */
public final class ClientMilestones {
	private ClientMilestones() {}

	static void registerEvents() {
		ClientPlayConnectionEvents.JOIN.register((handler, sender, mc) -> {
			int gen = ClientSession.get().gen();
			if (gen > 0) {
				reach(Milestone.WORLD, gen);
			}
		});
	}

	/** {@code reply} unchanged; when it succeeds, each of {@code milestones} counts once more. */
	public static <T> CompletableFuture<T> onSuccess(final CompletableFuture<T> reply, final Milestone... milestones) {
		reply.thenAccept(ok -> {
			for (Milestone m : milestones) {
				award(m);
			}
		});
		return reply;
	}

	/** One more of a counted milestone for the local player. */
	public static void award(final Milestone milestone) {
		onServer(player -> Milestones.award(player, milestone));
	}

	/** A gauge's value for the local player. */
	public static void reach(final Milestone milestone, final int value) {
		onServer(player -> Milestones.reach(player, milestone, value));
	}

	private static void onServer(final Consumer<ServerPlayer> action) {
		UiActions.runOnClient(() -> {
			Minecraft mc = Minecraft.getInstance();
			IntegratedServer server = mc != null ? mc.getSingleplayerServer() : null;
			if (server == null || mc.player == null) {
				return;
			}
			UUID id = mc.player.getUUID();
			server.execute(() -> {
				ServerPlayer player = server.getPlayerList().getPlayer(id);
				if (player != null) {
					action.accept(player);
				}
			});
		});
	}
}
