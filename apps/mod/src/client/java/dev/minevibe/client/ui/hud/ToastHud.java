package dev.minevibe.client.ui.hud;

import dev.minevibe.client.ui.BubbleLayout;
import dev.minevibe.client.ui.ToastEntry;
import dev.minevibe.client.ui.UiState;
import java.util.List;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.util.ARGB;

/**
 * MineVibe toasts ({@code ui.toast}, PLAN §5 "UI"): stacked in the bottom-left corner, just above the chat area so they
 * never cover chat lines, newest at the bottom, each with a colored bar for its kind and the agent's name when it is
 * about one. They fade out at the end of their time.
 */
public final class ToastHud {
	private ToastHud() {}

	static final int WIDTH = 220;

	public static void extract(GuiGraphicsExtractor g, DeltaTracker delta) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.gui.hud.isHidden()) return;
		UiState state = UiState.get();
		List<ToastEntry> toasts = state.toasts();
		if (toasts.isEmpty()) return;
		Font font = mc.font;
		long now = state.now();
		double chatScale = mc.options.chatScale().get();
		int chatHeight = (int) (ChatComponent.getHeight(mc.options.chatHeightUnfocused().get()) * chatScale);
		int bottom = Math.max(60, g.guiHeight() - 44 - chatHeight);
		int y = bottom;
		for (int i = toasts.size() - 1; i >= 0 && y > 20; i--) {
			ToastEntry t = toasts.get(i);
			String prefix = t.agentId() != null ? state.nameOf(t.agentId()) + ": " : "";
			List<String> lines = BubbleLayout.wrap(prefix + t.text(), 40, 3).lines();
			int h = lines.size() * 10 + 6;
			y -= h;
			float alpha = t.alpha(now);
			g.fill(4, y, 4 + WIDTH, y + h - 2, ARGB.multiplyAlpha(0xC0101018, alpha));
			g.fill(4, y, 6, y + h - 2, ARGB.multiplyAlpha(t.accent(), alpha));
			int ty = y + 3;
			for (String line : lines) {
				g.text(font, line, 10, ty, ARGB.multiplyAlpha(0xFFFFFFFF, Math.max(0.1f, alpha)), false);
				ty += 10;
			}
			y -= 2;
		}
	}
}
