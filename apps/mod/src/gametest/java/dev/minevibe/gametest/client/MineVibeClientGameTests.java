package dev.minevibe.gametest.client;

import dev.minevibe.client.menu.MineVibeMenuScreen;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.gui.screens.options.VideoSettingsScreen;

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
		nothingOpenedFromTheMineVibeMenuPauses(context);
	}

	/**
	 * Review finding MINOR 17: vanilla's Options screen (and its sub-screens) are pause screens. Opened from the
	 * MineVibe menu they must not pause the game: the integrated server, and with it the crew, keeps running.
	 */
	private static void nothingOpenedFromTheMineVibeMenuPauses(ClientGameTestContext context) {
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			singleplayer.getConnection().waitForChunksRender();
			context.setScreen(MineVibeMenuScreen::new);
			context.clickScreenButton("menu.options");
			context.waitForScreen(OptionsScreen.class);
			assertKeepsTicking(context, singleplayer, "Options opened from the MineVibe menu");
			context.clickScreenButton("options.video");
			context.waitForScreen(VideoSettingsScreen.class);
			assertKeepsTicking(context, singleplayer, "Video Settings opened from those Options");

			// The same vanilla screen opened from anywhere else still pauses (the rule is scoped to the menu).
			context.setScreen(() -> null);
			context.setScreen(() -> new OptionsScreen(null, context.computeOnClient(mc -> mc.options)));
			context.waitTicks(2);
			if (!context.computeOnClient(mc -> mc.isPaused())) {
				throw new AssertionError("an Options screen not opened from the MineVibe menu should still pause");
			}
			context.setScreen(() -> null);
		}
	}

	private static void assertKeepsTicking(ClientGameTestContext context, TestSingleplayerContext singleplayer, String what) {
		context.waitTicks(2);
		if (context.computeOnClient(mc -> mc.isPaused())) throw new AssertionError(what + " paused the game");
		int before = singleplayer.getServer().computeOnServer(server -> server.getTickCount());
		context.waitTicks(20);
		int after = singleplayer.getServer().computeOnServer(server -> server.getTickCount());
		if (after - before < 10) throw new AssertionError(what + ": the integrated server stopped ticking (" + (after - before) + " ticks)");
		System.out.println("[M1] " + what + ": paused=false, server ticked " + (after - before) + " in 20 client ticks");
	}
}
