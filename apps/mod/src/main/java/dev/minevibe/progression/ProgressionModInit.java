package dev.minevibe.progression;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Ui;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * Common entrypoint of the survival start (PLAN 7.5 "Agent Core", 7.9): a new world begins with nothing, and the player
 * earns the crew. Registers the Agent Core and the guide's triggers, answers Node's {@code hire.pay} on the integrated
 * server, and gives the first-join hint. The awakening ritual itself is the core's {@link AgentCoreItem#useOn}. Listed
 * under {@code main} in {@code fabric.mod.json}; the client side (item tooltips) is
 * {@code dev.minevibe.client.progression.ProgressionClientInit}.
 */
public final class ProgressionModInit implements ModInitializer {
	private static volatile @Nullable MinecraftServer server;

	@Override
	public void onInitialize() {
		ProgressionContent.register();
		GuideHint.registerEvents();
		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> server = null);
		MineVibeBridge.onInstall(ProgressionModInit::attach);
	}

	private static void attach(final BridgeClient bridge) {
		bridge.handle(Ui.HIRE_PAY, Route.SERVER, req -> CorePayment.pay(server, req));
	}
}
