package dev.minevibe.client.boot;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ClientConfig;
import dev.minevibe.client.ClientSession;
import dev.minevibe.hardcore.DeathRecord;
import dev.minevibe.hardcore.HardcoreHooks;
import dev.minevibe.hardcore.HardcoreMarker;
import java.io.IOException;
import java.util.Optional;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.network.chat.Component;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.minecraft.world.level.storage.LevelStorageSource;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Opens, creates and leaves worlds for BootScreen and GameOverScreen (PLAN §7.9). Client thread only, and never
 * from inside a screen's {@code tick()}: callers queue these through {@code Minecraft#schedule}, the way vanilla
 * opens worlds from queued tasks.
 */
public final class WorldLauncher {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Boot");

	private WorldLauncher() {}

	/**
	 * Acts on {@code world.open}: a world marked dead goes straight to Game Over (and its death is reported again
	 * until Node acknowledges it); an existing world is opened; a missing one is created as a hardcore HARD survival
	 * world with Node's seed, if it sent one. Every way this can fail leaves the session not loading (a thrown
	 * exception is rethrown for the caller, BootScreen, to show).
	 */
	public static void openOrCreate(Minecraft mc, Messages.WorldOpen open) {
		String id = open.worldId();
		LevelStorageSource levels = mc.getLevelSource();
		if (levels.levelExists(id)) {
			Optional<DeathRecord> death;
			try {
				death = HardcoreMarker.readFromWorldDir(levels.getLevelPath(id));
			} catch (IOException e) {
				LOG.error("Could not read the dead marker of {}", id, e);
				mc.gui.setScreen(new BootScreen(Component.literal("World #" + open.gen() + " could not be read.")));
				return;
			}
			if (death.isPresent()) {
				LOG.info("World {} is marked dead: showing Game Over", id);
				ClientSession.get().beginLoading(id, open.gen(), false);
				ClientSession.get().leftWorld();
				mc.gui.setScreen(GameOverScreen.fromMarker(id, open.gen(), death.get()));
				HardcoreHooks.report(death.get());
				return;
			}
			open(mc, id, open.gen());
		} else {
			createFresh(mc, id, open.gen(), open.seed());
		}
	}

	private static void open(Minecraft mc, String id, int gen) {
		LOG.info("Opening World #{} ({})", gen, id);
		ClientSession.get().beginLoading(id, gen, false);
		reportLoading(id, false);
		try {
			mc.createWorldOpenFlows().openWorld(id, () -> {
				LOG.warn("Opening {} was cancelled", id);
				ClientSession.get().loadFailed(id);
				mc.gui.setScreen(new BootScreen(Component.literal("World #" + gen + " could not be opened.")));
			});
		} catch (RuntimeException e) {
			ClientSession.get().loadFailed(id);
			throw e;
		}
	}

	/** Creates world {@code id}: hardcore, HARD (locked), survival, normal world preset, random seed unless given. */
	public static void createFresh(Minecraft mc, String id, int gen, @Nullable String seed) {
		LOG.info("Creating World #{} ({})", gen, id);
		ClientSession.get().beginLoading(id, gen, true);
		reportLoading(id, true);
		boolean allowCommands = ClientConfig.get().dev();
		LevelSettings settings = new LevelSettings(
				gen > 0 ? "MineVibe World #" + gen : "MineVibe " + id,
				GameType.SURVIVAL,
				new LevelSettings.DifficultySettings(Difficulty.HARD, true, true),
				allowCommands,
				WorldDataConfiguration.DEFAULT);
		WorldOptions options = WorldOptions.defaultWithRandomSeed();
		if (seed != null && !seed.isBlank()) options = options.withSeed(WorldOptions.parseSeed(seed));
		try {
			// On a datapack failure vanilla shows this screen (and starts no server); it clears the loading state
			// when it appears, so the next world.open is acted on.
			mc.createWorldOpenFlows().createFreshLevel(
					id,
					settings,
					options,
					WorldPresets::createNormalWorldDimensions,
					new BootScreen(Component.literal("World #" + gen + " could not be created.")));
		} catch (RuntimeException e) {
			ClientSession.get().loadFailed(id);
			throw e;
		}
	}

	/** Leaves the current world, blocking until the integrated server has saved and stopped. */
	public static void leaveWorld(Minecraft mc) {
		if (mc.level != null) mc.level.disconnect(ClientLevel.DEFAULT_QUIT_MESSAGE);
		mc.disconnectWithSavingScreen();
		ClientSession.get().leftWorld();
	}

	private static void reportLoading(String id, boolean fresh) {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge != null) {
			bridge.send(Messages.WORLD_STATE, new Messages.WorldState(id, Messages.WorldState.LOADING, fresh ? Boolean.TRUE : null, null, null, null));
		}
	}
}
