package dev.minevibe.gametest.client;

import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.minecraft.client.gui.screens.TitleScreen;

/**
 * Client GameTests (Fabric entrypoint {@code fabric-client-gametest}). Fabric's runner requires
 * every client test to finish on {@link TitleScreen} with no world open.
 *
 * <p>Run with {@code ./gradlew runClientGameTest -Pminevibe.acceptMinecraftEula=true} (opens a window).
 */
public final class MineVibeClientGameTests implements FabricClientGameTest {
	@Override
	public void runTest(ClientGameTestContext context) {
		context.waitForScreen(TitleScreen.class);
	}
}
