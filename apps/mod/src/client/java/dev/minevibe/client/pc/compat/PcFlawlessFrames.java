package dev.minevibe.client.pc.compat;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * The FREX "flawless frames" entrypoint ({@code frex_flawless_frames} in fabric.mod.json, PLAN 10): mods that throttle
 * rendering (Dynamic FPS, ...) call it with a factory; while MineVibe asks for flawless frames (the player sits at or
 * watches a PC), they render every frame at full rate. Without such a mod nothing calls it and it does nothing.
 */
public final class PcFlawlessFrames implements Consumer<Function<String, Consumer<Boolean>>> {
	private static final List<Consumer<Boolean>> ACTIVATORS = new CopyOnWriteArrayList<>();
	private static volatile boolean active;

	@Override
	public void accept(final Function<String, Consumer<Boolean>> factory) {
		Consumer<Boolean> activator = factory.apply("minevibe:pc");
		ACTIVATORS.add(activator);
		activator.accept(active);
	}

	/** Client thread: asks for (or releases) full frame rate. Only calls the activators on a change. */
	public static void set(final boolean on) {
		if (on == active) {
			return;
		}
		active = on;
		for (Consumer<Boolean> activator : ACTIVATORS) {
			activator.accept(on);
		}
	}
}
