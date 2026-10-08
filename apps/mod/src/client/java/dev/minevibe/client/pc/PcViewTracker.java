package dev.minevibe.client.pc;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcBridge;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Sends {@code pc.view} (PLAN 7.6, 8.4): which frame tier the player wants per PC, on change. {@code focus} while
 * seated at or watching a PC, {@code visible} for monitors within 32 blocks, {@code none} otherwise (and for every
 * PC when the player leaves the world). Everything is re-sent after a reconnect (Node forgets on disconnect). Client
 * thread, checked every few ticks.
 */
public final class PcViewTracker {
	private static final int EVERY_TICKS = 5;

	private static Map<String, String> sent = new HashMap<>();
	private static volatile boolean resendAll;
	private static @Nullable String watching;
	private static @Nullable String lastFocused;
	private static int ticks;

	private PcViewTracker() {}

	/** Watch mode on ({@code pcId}) or off (null). */
	public static void setWatching(final @Nullable String pcId) {
		watching = pcId;
		ticks = EVERY_TICKS;
	}

	/** After {@code hello.ok}: every tier goes out again (any thread). */
	public static void resendAll() {
		resendAll = true;
	}

	/** The PC the player looks at full screen (seated or watching), or null. */
	public static @Nullable String focused() {
		String seated = PcSeatWatcher.seatedPc();
		return seated != null ? seated : watching;
	}

	public static void tick(final Minecraft mc) {
		String focused = focused();
		boolean focusChanged = focused != null ? !focused.equals(lastFocused) : lastFocused != null;
		if (!focusChanged && !resendAll && ++ticks < EVERY_TICKS) {
			return;
		}
		ticks = 0;
		lastFocused = focused;
		Map<String, Double> distances = new HashMap<>();
		if (mc.level != null && mc.player != null) {
			Vec3 eye = mc.player.getEyePosition();
			for (PcBlockEntity be : PcClientMonitors.all()) {
				String pcId = be.pcId();
				if (pcId != null) {
					double d = Math.sqrt(Vec3.atCenterOf(be.getBlockPos()).distanceToSqr(eye));
					distances.merge(pcId, d, Math::min);
				}
			}
		} else {
			focused = null;
		}
		Map<String, String> now = PcViewTiers.compute(focused, distances, sent);
		Map<String, String> changes;
		if (resendAll) {
			resendAll = false;
			changes = new HashMap<>(now);
			changes.values().removeIf(PcViewTiers.NONE::equals);
		} else {
			changes = PcViewTiers.changes(sent, now);
		}
		for (Map.Entry<String, String> change : changes.entrySet()) {
			PcBridge.send(Pc.PC_VIEW, new Pc.PcView(change.getKey(), change.getValue()));
		}
		sent = now;
	}

	public static void reset() {
		sent = new HashMap<>();
		watching = null;
		lastFocused = null;
	}
}
