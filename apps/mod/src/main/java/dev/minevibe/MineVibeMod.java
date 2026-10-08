package dev.minevibe;

import net.fabricmc.api.ModInitializer;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Common (client + integrated server) entrypoint.
 *
 * <p>Later milestones register blocks, items, entities, {@code AgentService}, {@code PcRegistry},
 * {@code HardcoreHooks} and {@code OfficeBuilder} here (PLAN 7, full design 6.1).
 */
public final class MineVibeMod implements ModInitializer {
	public static final String MOD_ID = "minevibe";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		LOGGER.info("MineVibe loaded");
	}

	/** {@code minevibe:<path>} */
	public static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath(MOD_ID, path);
	}
}
