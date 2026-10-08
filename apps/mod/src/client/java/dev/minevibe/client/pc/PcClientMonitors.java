package dev.minevibe.client.pc;

import dev.minevibe.pc.PcBlockEntity;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * The PC monitors in the client's loaded chunks (Fabric's client block entity load/unload events). Client thread.
 * Lets the client find the PC of a chair the player sits on and the monitors near the camera ({@code pc.view}).
 */
public final class PcClientMonitors {
	private static final Set<PcBlockEntity> LOADED = Collections.newSetFromMap(new ConcurrentHashMap<>());

	private PcClientMonitors() {}

	public static void loaded(final PcBlockEntity be) {
		LOADED.add(be);
	}

	public static void unloaded(final PcBlockEntity be) {
		LOADED.remove(be);
	}

	public static void clear() {
		LOADED.clear();
	}

	public static List<PcBlockEntity> all() {
		List<PcBlockEntity> out = new ArrayList<>();
		for (PcBlockEntity be : LOADED) {
			if (!be.isRemoved()) {
				out.add(be);
			}
		}
		return out;
	}

	/** The PC whose chair is at {@code chairPos}, if its desk is loaded and bound. */
	public static @Nullable String pcForChair(final BlockPos chairPos) {
		for (PcBlockEntity be : LOADED) {
			if (!be.isRemoved() && chairPos.equals(be.seatPos()) && be.pcId() != null) {
				return be.pcId();
			}
		}
		return null;
	}

	/** The loaded desk of {@code pcId}, if any. */
	public static @Nullable PcBlockEntity desk(final String pcId) {
		for (PcBlockEntity be : LOADED) {
			if (!be.isRemoved() && pcId.equals(be.pcId())) {
				return be;
			}
		}
		return null;
	}
}
