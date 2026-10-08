package dev.minevibe.client.pc;

import dev.minevibe.client.pc.screen.PcControlScreen;
import dev.minevibe.pc.PcRegistry;
import dev.minevibe.world.seat.SeatEntity;
import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * Client tick: the player at a PC (PLAN 7.7). Sitting on a PC's chair opens PcControlScreen, and it comes back
 * whenever nothing else is on screen (after the chat overlay, say) until the player stands; leaving the chair closes
 * it. Standing up (Shift+Esc) asks the integrated server to dismount the player (UI actions reach the server through
 * {@code server.execute}, PLAN 3 principle 2).
 */
public final class PcSeatWatcher {
	/** After a stand request, PcControlScreen is not reopened for this many ticks while the dismount arrives. */
	private static final int STAND_GRACE_TICKS = 20;

	private static @Nullable String seatedPc;
	private static int standGrace;

	private PcSeatWatcher() {}

	/** The PC the player sits at (client view), or null. */
	public static @Nullable String seatedPc() {
		return seatedPc;
	}

	public static void tick(final Minecraft mc) {
		if (standGrace > 0) {
			standGrace--;
		}
		String pcId = null;
		// A meeting seat never opens PcControlScreen (PLAN 6.3), even on a chair some desk also points at.
		if (mc.player != null && mc.player.getVehicle() instanceof SeatEntity seat && seat.isPcSeat()) {
			pcId = PcClientMonitors.pcForChair(seat.blockPosition());
		}
		seatedPc = pcId;
		Screen screen = mc.gui.screen();
		if (pcId == null) {
			standGrace = 0;
			if (screen instanceof PcControlScreen control) {
				control.closeBecauseStood();
			}
			return;
		}
		if (screen == null && mc.gui.overlay() == null && standGrace == 0 && mc.player.isAlive()) {
			mc.gui.setScreen(new PcControlScreen(pcId));
		}
	}

	/** Shift+Esc: dismount on the integrated server (the screen closes when the client sees it). */
	public static void requestStand(final Minecraft mc) {
		standGrace = STAND_GRACE_TICKS;
		IntegratedServer server = mc.getSingleplayerServer();
		if (server == null || mc.player == null) {
			return;
		}
		UUID id = mc.player.getUUID();
		server.execute(() -> {
			ServerPlayer player = server.getPlayerList().getPlayer(id);
			if (player != null) {
				PcRegistry.standUp(player, "stand");
			}
		});
	}

	public static void reset() {
		seatedPc = null;
		standGrace = 0;
	}
}
