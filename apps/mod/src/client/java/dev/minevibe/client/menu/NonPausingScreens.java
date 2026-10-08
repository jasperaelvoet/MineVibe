package dev.minevibe.client.menu;

import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;

/**
 * Screens that must never pause the game although vanilla says they do (PLAN §7.9: the world, the crew and their PCs
 * keep running). Every screen opened from {@link MineVibeMenuScreen}, and every screen opened from one of those (the
 * vanilla Options screen and its sub-screens are pause screens by default), is marked here; {@code GuiIsPausingMixin}
 * makes {@code Gui#isPausing} ignore their {@code isPauseScreen()}. Render thread only.
 */
public final class NonPausingScreens {
	private static final Set<Screen> MARKED = Collections.newSetFromMap(new WeakHashMap<>());

	private NonPausingScreens() {}

	/** Called for every {@code Gui#setScreen}: a screen opened from the MineVibe menu (or its subtree) never pauses. */
	public static void onOpen(@Nullable Screen current, @Nullable Screen opened) {
		if (opened != null && opened != current && (current instanceof MineVibeMenuScreen || isMarked(current))) {
			MARKED.add(opened);
		}
	}

	public static boolean isMarked(@Nullable Screen screen) {
		return screen != null && MARKED.contains(screen);
	}
}
