package dev.minevibe.client.org;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.network.chat.FormattedText;
import net.minecraft.util.FormattedCharSequence;

/** Small drawing and hit-testing helpers shared by the org screens and the meeting HUD. */
public final class OrgUi {
	public static final int WHITE = 0xFFFFFFFF;
	public static final int GREY = 0xFFA0A0A0;
	public static final int DARK = 0xE0101418;
	public static final int PANEL = 0xF0202830;
	public static final int PANEL_LIGHT = 0xF02C3640;
	public static final int BORDER = 0xFF4A5868;
	public static final int ACCENT = 0xFF6FB8FF;
	public static final int RED = 0xFFFF6B6B;
	public static final int GREEN = 0xFF7BD88F;
	public static final int YELLOW = 0xFFFFD166;

	private OrgUi() {
	}

	/** A filled box with a one-pixel border. */
	public static void panel(final GuiGraphicsExtractor g, final int x0, final int y0, final int x1, final int y1, final int fill, final int border) {
		g.fill(x0, y0, x1, y1, fill);
		g.outline(x0, y0, x1 - x0, y1 - y0, border);
	}

	/** {@code text} cut to {@code width} pixels with an ellipsis. */
	public static String clip(final Font font, final String text, final int width) {
		if (width <= 0) {
			return "";
		}
		if (font.width(text) <= width) {
			return text;
		}
		String ellipsis = "…";
		return font.plainSubstrByWidth(text, Math.max(0, width - font.width(ellipsis))) + ellipsis;
	}

	public static List<FormattedCharSequence> wrap(final Font font, final String text, final int width) {
		return font.split(FormattedText.of(text), Math.max(8, width));
	}

	/** "just now", "5 min ago", "3 h ago", "2 days ago". */
	public static String ago(final long thenMs, final long nowMs) {
		long s = Math.max(0, (nowMs - thenMs) / 1000);
		if (s < 60) {
			return "just now";
		}
		if (s < 3600) {
			return s / 60 + " min ago";
		}
		if (s < 86_400) {
			return s / 3600 + " h ago";
		}
		long days = s / 86_400;
		return days + (days == 1 ? " day ago" : " days ago");
	}

	public static boolean inside(final double x, final double y, final int x0, final int y0, final int x1, final int y1) {
		return x >= x0 && x < x1 && y >= y0 && y < y1;
	}

	/** Clickable areas drawn by hand, rebuilt every frame. */
	public static final class Hits {
		private record Hit(int x0, int y0, int x1, int y1, Runnable action) {}

		private final List<Hit> hits = new ArrayList<>();

		public void clear() {
			this.hits.clear();
		}

		public void add(final int x0, final int y0, final int x1, final int y1, final Runnable action) {
			this.hits.add(new Hit(x0, y0, x1, y1, action));
		}

		/** Runs the topmost area under the pointer; false when there is none. */
		public boolean click(final double x, final double y) {
			for (int i = this.hits.size() - 1; i >= 0; i--) {
				Hit hit = this.hits.get(i);
				if (inside(x, y, hit.x0, hit.y0, hit.x1, hit.y1)) {
					hit.action.run();
					return true;
				}
			}
			return false;
		}
	}
}
