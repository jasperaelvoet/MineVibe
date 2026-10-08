package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.client.pc.PcClientMonitors;
import dev.minevibe.client.pc.PcStatusText;
import dev.minevibe.client.pc.frame.MonitorTextures;
import dev.minevibe.client.pc.frame.PcStats;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcStates;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.texture.AbstractTexture;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;

/**
 * Draws one PC's screen into a GUI rect (PcControlScreen, Watch mode): the newest frame when the PC runs, else its
 * status screen, plus a cursor. Render thread.
 */
public final class PcScreenView {
	private PcScreenView() {}

	/** The guest screen size: the last frame, else {@code pc.state}'s screen, else 1280x800. */
	public static int[] guestSize(final String pcId) {
		int[] size = MonitorTextures.size(pcId);
		if (size != null) {
			return size;
		}
		Pc.PcInfo info = PcStates.get(pcId);
		if (info != null && info.screen() != null) {
			return new int[] {info.screen().w(), info.screen().h()};
		}
		return new int[] {1280, 800};
	}

	/** Draws the picture or the status screen. Returns true when a live picture was drawn. */
	public static boolean draw(final GuiGraphicsExtractor g, final Font font, final String pcId, final PcLayout.Rect r) {
		long t0 = System.nanoTime();
		try {
			return drawUntimed(g, font, pcId, r);
		} finally {
			PcStats.work(System.nanoTime() - t0);
		}
	}

	private static boolean drawUntimed(final GuiGraphicsExtractor g, final Font font, final String pcId, final PcLayout.Rect r) {
		int x0 = (int) Math.round(r.x());
		int y0 = (int) Math.round(r.y());
		int x1 = (int) Math.round(r.x() + r.w());
		int y1 = (int) Math.round(r.y() + r.h());
		Pc.PcInfo info = PcStates.get(pcId);
		Identifier texture = MonitorTextures.prepare(pcId);
		boolean running = info != null && "running".equals(info.status());
		if (texture != null && running) {
			AbstractTexture tex = Minecraft.getInstance().getTextureManager().getTexture(texture);
			g.blit(tex.getTextureView(), tex.getSampler(), x0, y0, x1, y1, 0, 1, 0, 1);
			return true;
		}
		PcBlockEntity desk = PcClientMonitors.desk(pcId);
		PcStatusText.Screen status = PcStatusText.of(
			pcId, desk != null && desk.isCreating(), desk != null ? desk.createError() : null, info, PcStates.isConnected(), false
		);
		if (status == null) {
			status = new PcStatusText.Screen("Starting display…", null, -1, PcStatusText.BG_BLUE, PcStatusText.ACCENT_GREEN);
		}
		g.fill(x0, y0, x1, y1, status.background());
		g.fill(x0, y0, x1, y0 + 2, status.accent());
		int cx = (x0 + x1) / 2;
		int cy = (y0 + y1) / 2;
		g.centeredText(font, Component.literal(status.title()), cx, cy - 12, 0xFFFFFFFF);
		if (status.detail() != null) {
			g.centeredText(font, Component.literal(status.detail()), cx, cy + 2, 0xFFCBD5E1);
		}
		if (status.progress() >= 0) {
			int bw = (x1 - x0) * 2 / 3;
			int bx = cx - bw / 2;
			g.fill(bx, cy + 16, bx + bw, cy + 20, 0xFF334155);
			g.fill(bx, cy + 16, bx + (int) (bw * Math.max(0, Math.min(1, status.progress()))), cy + 20, status.accent());
		}
		return false;
	}

	/** A small arrow cursor with its tip at {@code (x, y)}. */
	public static void cursor(final GuiGraphicsExtractor g, final int x, final int y, final int fill) {
		for (int row = 0; row < 10; row++) {
			int len = Math.min(row + 1, 7);
			g.fill(x - 1, y + row - 1, x + len + 1, y + row + 1, 0xFF000000);
		}
		for (int row = 0; row < 9; row++) {
			int len = Math.min(row, 6);
			if (len > 0) {
				g.fill(x, y + row, x + len, y + row + 1, fill);
			}
		}
	}
}
