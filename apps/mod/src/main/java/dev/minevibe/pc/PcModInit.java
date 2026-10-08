package dev.minevibe.pc;

import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.world.MvWorldContent;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerBlockEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.CreativeModeTabs;
import org.jspecify.annotations.Nullable;

/**
 * Common entrypoint for PCs in the world (PLAN 7.5-7.7, track T2): the desk, monitor block entity and workstation
 * items, the server-side {@link PcRegistry} (desks, chairs, the player at a PC, LEDs) and the PC messages on the
 * bridge ({@link PcBridge}, registered before the bridge connects).
 *
 * <p>It also plugs the PCs into the other modules (listed last under {@code main}, so theirs are initialised):
 * <ul>
 *   <li>the skill layer's seats use {@link PcSeatRegistry} (desk chairs, statuses from {@code pc.state}, the kick);</li>
 *   <li>the starter office puts {@code linux-1}'s workstation into its first slot and clears desks quietly
 *       ({@link OfficeWorkstation}).</li>
 * </ul>
 */
public final class PcModInit implements ModInitializer {
	private static volatile @Nullable MinecraftServer server;

	@Override
	public void onInitialize() {
		MvWorldContent.register();
		PcContent.register();
		MineVibeBridge.onInstall(PcBridge::register);
		PcSeatRegistry.INSTANCE.listenToPcStates();
		Seats.installPcRegistry(PcSeatRegistry.INSTANCE);
		OfficeBuilder.installWorkstationPlacer(new OfficeWorkstation());

		ServerLifecycleEvents.SERVER_STARTED.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> PcRegistry.onServerStopping());
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			PcRegistry.reset();
		});
		ServerTickEvents.END_SERVER_TICK.register(PcRegistry::tick);
		ServerBlockEntityEvents.BLOCK_ENTITY_LOAD.register((be, level) -> {
			if (be instanceof PcBlockEntity desk) {
				PcRegistry.registerDesk(level, desk);
				// The PC's state may have changed while the chunk was unloaded. Not now: this runs while the chunk
				// loads (and server.execute would run it inline on the server thread); the next server tick does it.
				PcRegistry.queueLedRefresh(level, desk.getBlockPos());
			}
		});
		ServerBlockEntityEvents.BLOCK_ENTITY_UNLOAD.register((be, level) -> {
			if (be instanceof PcBlockEntity desk) {
				PcRegistry.unregisterDesk(level, desk);
			}
		});
		PcStates.addListener(info -> PcRegistry.onStatusChanged(server, info.pcId()));
		// A PC Node no longer knows: its desk's LED goes off.
		PcStates.addRemovalListener(pcId -> PcRegistry.onStatusChanged(server, pcId));

		CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.FUNCTIONAL_BLOCKS).register(output -> {
			output.accept(PcContent.LINUX_WORKSTATION);
			output.accept(PcContent.MAC_WORKSTATION);
		});
	}

	/** The integrated server while it runs. */
	public static @Nullable MinecraftServer server() {
		return server;
	}
}
