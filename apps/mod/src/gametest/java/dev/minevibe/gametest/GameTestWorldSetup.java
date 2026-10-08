package dev.minevibe.gametest;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.world.level.gamerules.GameRules;

/**
 * Makes the server GameTest world deterministic: no natural monster spawning. Agents are real players, so every agent a
 * test spawns lets the world spawn monsters around it (PLAN 7.1), and with two dozen tests running side by side a
 * stray creeper or zombie walked into other tests now and then. Tests that need a mob spawn it themselves.
 */
public final class GameTestWorldSetup implements ModInitializer {
	@Override
	public void onInitialize() {
		if (System.getProperty("fabric-api.gametest") == null) {
			return;
		}
		ServerLifecycleEvents.SERVER_STARTED.register(server -> server.getGameRules().set(GameRules.SPAWN_MONSTERS, false, server));
	}
}
