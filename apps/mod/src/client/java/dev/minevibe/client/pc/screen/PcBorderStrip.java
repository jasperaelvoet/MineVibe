package dev.minevibe.client.pc.screen;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * The strip along the top of PcControlScreen (PLAN 7.7 step 5): pending cards, new direct replies, meeting calls, and
 * a red flash when the player takes damage. This is the placeholder the UI track fills in: it registers item providers
 * with {@link #addProvider} and the overlay (chat plus card answerer, Ctrl+Shift+Enter or a click on an item) with
 * {@link #setOverlay}. Until then the strip shows a hint and the overlay is vanilla chat.
 */
public final class PcBorderStrip {
	public static final int HEIGHT = 14;

	/** One item: its text and colour (ARGB). */
	public record Item(Component text, int color) {}

	private static final List<Supplier<List<Item>>> PROVIDERS = new CopyOnWriteArrayList<>();
	private static volatile Supplier<Screen> overlay = () -> new ChatScreen("", false);

	private PcBorderStrip() {}

	public static void addProvider(final Supplier<List<Item>> provider) {
		PROVIDERS.add(provider);
	}

	public static void setOverlay(final @Nullable Supplier<Screen> newOverlay) {
		overlay = newOverlay != null ? newOverlay : () -> new ChatScreen("", false);
	}

	/** Opens the overlay over the PC; closing it returns to the PC (PcSeatWatcher reopens PcControlScreen). */
	public static void openOverlay() {
		Minecraft.getInstance().gui.setScreen(overlay.get());
	}

	public static List<Item> items() {
		List<Item> out = new ArrayList<>();
		for (Supplier<List<Item>> provider : PROVIDERS) {
			try {
				out.addAll(provider.get());
			} catch (RuntimeException e) {
				// A broken provider must not take the PC screen down.
			}
		}
		return out;
	}

	/** Draws the strip at the top; {@code hurt} (0..1) tints it red. */
	public static void extract(final GuiGraphicsExtractor g, final Font font, final int width, final float hurt) {
		g.fill(0, 0, width, HEIGHT, 0xC0101418);
		if (hurt > 0) {
			int alpha = (int) (Math.min(1f, hurt) * 0xB0);
			g.fill(0, 0, width, HEIGHT, (alpha << 24) | 0xDC2626);
		}
		List<Item> items = items();
		int x = 6;
		if (items.isEmpty()) {
			g.text(font, Component.translatable("screen.minevibe.pc.strip.empty"), x, 3, 0xFF9CA3AF, false);
			return;
		}
		for (Item item : items) {
			int w = font.width(item.text());
			if (x + w > width - 6) {
				break;
			}
			g.text(font, item.text(), x, 3, item.color(), false);
			x += w + 12;
		}
	}
}
