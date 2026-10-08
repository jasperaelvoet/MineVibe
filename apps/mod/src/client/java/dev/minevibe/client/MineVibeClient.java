package dev.minevibe.client;

import dev.minevibe.MineVibeMod;
import net.fabricmc.api.ClientModInitializer;

/**
 * Client entrypoint.
 *
 * <p>Later milestones start {@code BridgeClient} and {@code ParentWatchdog} and register screens,
 * renderers, {@code MonitorTextures} and the HUD here (PLAN 7, full design 6.1).
 */
public final class MineVibeClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		MineVibeMod.LOGGER.info("MineVibe loaded (client)");
	}
}
