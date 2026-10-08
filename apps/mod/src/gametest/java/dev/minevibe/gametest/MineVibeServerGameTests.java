package dev.minevibe.gametest;

import dev.minevibe.MineVibeMod;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.gametest.framework.GameTestHelper;

/**
 * Server GameTests (Fabric entrypoint {@code fabric-gametest}). Each public, non-static
 * {@link GameTest} method taking a {@link GameTestHelper} becomes test
 * {@code minevibe-gametest:<class_name>_<method_name>}.
 *
 * <p>Run with {@code ./gradlew runGameTest -Pminevibe.acceptMinecraftEula=true}.
 */
public final class MineVibeServerGameTests {
	@GameTest
	public void modIsLoaded(GameTestHelper helper) {
		helper.assertTrue(FabricLoader.getInstance().isModLoaded(MineVibeMod.MOD_ID), "minevibe is not loaded");
		helper.succeed();
	}
}
