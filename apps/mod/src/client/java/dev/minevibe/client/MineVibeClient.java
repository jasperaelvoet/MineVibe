package dev.minevibe.client;

import dev.minevibe.MineVibeMod;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeConfig;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.TaskQueue;
import dev.minevibe.client.e2e.DebugHandlers;
import dev.minevibe.hardcore.HardcoreHooks;
import java.nio.file.Path;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import org.jspecify.annotations.Nullable;

/**
 * Client entrypoint (PLAN §5, §7.9, §9.2).
 *
 * <ul>
 *   <li>Starts the {@link BridgeClient} when {@code -Dminevibe.bridgeFile} is set, with world/UI messages routed to
 *       the client thread (through a {@link TaskQueue} drained every client tick, which {@code Minecraft#disconnect}
 *       cannot drop) and server-world messages to the integrated server while it is running.</li>
 *   <li>Registers the hardcore hooks (the integrated server's player-death marker; singleplayer only, so this is
 *       the one place they need to be registered), the world ticker and, with {@code -Dminevibe.e2e=true}, the
 *       E2E debug handlers.</li>
 *   <li>Starts the parent watchdog when {@code -Dminevibe.parentPid} is set.</li>
 * </ul>
 * The screen redirects (BootScreen, GameOverScreen, MineVibeMenuScreen) live in {@code GuiSetScreenMixin}.
 */
public final class MineVibeClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ClientConfig config = ClientConfig.get();
		MineVibeMod.LOGGER.info(
				"MineVibe loaded (client): bridge={}, e2e={}, dev={}, screens={}",
				config.bridgeFile() != null && !config.gameTest() ? "configured" : "off",
				config.e2e(),
				config.dev(),
				config.redirectScreens() ? "MineVibe" : "vanilla (client GameTest)");

		HardcoreHooks.register();
		ClientTickEvents.END_CLIENT_TICK.register(WorldTicker::onEndTick);
		// hello is built on bridge threads from a snapshot; fill the parts that never change now (client thread).
		ClientBridge.initHelloConstants();
		publishPlayerName(Minecraft.getInstance());
		ClientLifecycleEvents.CLIENT_STARTED.register(MineVibeClient::publishPlayerName);

		// Client GameTests inherit runClient's -D properties, but drive their own worlds: no bridge there (a dev
		// server that happens to be running must not open or close their worlds).
		Path bridgeFile = config.gameTest() ? null : config.bridgeFile();
		if (bridgeFile != null) {
			TaskQueue clientTasks = new TaskQueue();
			ClientTickEvents.END_CLIENT_TICK.register(mc -> clientTasks.drain());
			BridgeClient bridge = BridgeClient.builder()
					.config(() -> BridgeConfig.load(bridgeFile))
					.clientExecutor(clientTasks)
					.serverExecutor(MineVibeClient::runningServer)
					// MVF1 frames go to whatever a feature module installed with MineVibeBridge.setFrameSink (PC monitors).
					.frameSink(MineVibeBridge.frameSink())
					.hello(ClientBridge::hello)
					.build();
			MineVibeBridge.install(bridge);
			ClientBridge.register(bridge);
			WorldTicker.attach(bridge);
			// Before start(): Node pushes the UI state right after hello.ok, before later entrypoints would run.
			dev.minevibe.client.ui.UiClientInit.attach(bridge);
			// Before start(): Node pushes the Codex, calendar and meeting right after hello.ok, before later entrypoints run.
			dev.minevibe.client.org.OrgClientInit.attach(bridge);
			// Before start(): frames and the hello.ok PC snapshot can arrive before the PC entrypoint runs.
			dev.minevibe.client.pc.PcClientInit.attach(bridge);
			if (config.e2e()) DebugHandlers.register(bridge);
			ClientLifecycleEvents.CLIENT_STARTED.register(mc -> {
				// The game never pauses on focus loss (PLAN §7.9); the launcher also seeds this in options.txt.
				mc.options.pauseOnLostFocus = false;
			});
			ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> bridge.close("quit"));
			bridge.start();
		}

		config.parentPid().ifPresent(ParentWatchdog::start);
	}

	/** The integrated server, while it runs (a stopping or stopped server takes no bridge work). */
	private static @Nullable IntegratedServer runningServer() {
		IntegratedServer server = Minecraft.getInstance().getSingleplayerServer();
		return server != null && server.isRunning() && !server.isStopped() ? server : null;
	}

	/** Client thread: the profile name for {@code hello} (the user is set before mods initialise, but be careful). */
	private static void publishPlayerName(Minecraft mc) {
		try {
			if (mc != null && mc.getUser() != null) ClientSession.get().publishPlayerName(mc.getUser().getName());
		} catch (RuntimeException e) {
			MineVibeMod.LOGGER.debug("Player name not available yet", e);
		}
	}
}
