package dev.minevibe.client.boot;

import dev.minevibe.client.ClientConfig;
import dev.minevibe.client.menu.MineVibeMenuScreen;
import dev.minevibe.client.mixin.DeathScreenAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decides which screen is really shown. {@code GuiSetScreenMixin} calls it for the argument of
 * {@code Gui#setScreen} and for the screens {@code setScreen(null)} makes up (a {@code TitleScreen} for "no
 * level", a {@code DeathScreen} for a dead player):
 *
 * <ul>
 *   <li>{@link TitleScreen}, {@link DisconnectedScreen} -> {@link BootScreen}</li>
 *   <li>{@link DeathScreen} -> {@link GameOverScreen}</li>
 *   <li>{@link PauseScreen} -> {@link MineVibeMenuScreen} (never pauses)</li>
 * </ul>
 *
 * Off under Fabric's client GameTests ({@code -Dfabric.client.gametest}), whose runner expects TitleScreen.
 * Every screen change is logged as {@code [screen] Shown (requested Requested)}, which the S7 run reads.
 */
public final class ScreenRouter {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Screen");

	private ScreenRouter() {}

	/** What the last {@code setScreen} asked for (render thread only), for the log line. */
	private static String lastRequested = "none";

	/**
	 * Returns the screen to show instead of {@code requested}.
	 *
	 * @param fromCaller true for the argument of {@code setScreen}, false for a screen vanilla made up for
	 *     {@code setScreen(null)}
	 */
	public static @Nullable Screen route(@Nullable Screen requested, boolean fromCaller) {
		if (fromCaller || requested != null) lastRequested = name(requested);
		if (requested == null || !ClientConfig.get().redirectScreens()) return requested;
		return replacement(requested);
	}

	/** Logs the screen {@code Gui#setScreen} ended up storing. */
	public static void shown(@Nullable Screen screen) {
		String shown = name(screen);
		if (!shown.equals(lastRequested)) {
			LOG.info("[screen] {} (requested {})", shown, lastRequested);
		} else {
			LOG.info("[screen] {}", shown);
		}
		lastRequested = "none";
	}

	private static Screen replacement(Screen requested) {
		if (requested instanceof TitleScreen) return new BootScreen();
		if (requested instanceof DisconnectedScreen disconnected) return new BootScreen(disconnected.getTitle());
		if (requested instanceof DeathScreen death) {
			return GameOverScreen.afterDeath(Minecraft.getInstance(), ((DeathScreenAccessor) death).minevibe$causeOfDeath());
		}
		if (requested instanceof PauseScreen) return new MineVibeMenuScreen();
		return requested;
	}

	/** Simple class name, or the full name for anonymous classes; "none" for no screen. */
	public static String name(@Nullable Screen screen) {
		if (screen == null) return "none";
		String simple = screen.getClass().getSimpleName();
		return simple.isEmpty() ? screen.getClass().getName() : simple;
	}
}
