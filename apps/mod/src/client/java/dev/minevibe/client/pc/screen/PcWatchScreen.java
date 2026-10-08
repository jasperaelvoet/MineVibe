package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.client.pc.PcViewTracker;
import dev.minevibe.pc.PcBridge;
import dev.minevibe.pc.PcStates;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * Watch mode (PLAN 7.7 step 7): a PC's screen nearly full size, read-only, with the seated agent's cursor. Opened by
 * using a monitor or from PcConfigScreen; it asks for the focus frame tier ({@code pc.view}) and tells Node
 * ({@code pc.action watch} / {@code unwatch}). Esc closes it; it never pauses.
 */
public final class PcWatchScreen extends Screen {
	private final String pcId;
	/** {@code watch} was sent and {@code unwatch} not yet: init runs again on every resize, removed only once. */
	private boolean watching;

	public PcWatchScreen(final String pcId) {
		super(Component.translatable("screen.minevibe.pc.watch"));
		this.pcId = pcId;
	}

	@Override
	protected void init() {
		if (!this.watching) {
			this.watching = true;
			PcViewTracker.setWatching(this.pcId);
			PcBridge.action("watch", this.pcId, null, null);
		}
	}

	@Override
	public void removed() {
		if (this.watching) {
			this.watching = false;
			PcViewTracker.setWatching(null);
			PcBridge.action("unwatch", this.pcId, null, null);
		}
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void extractBackground(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		g.fill(0, 0, this.width, this.height, 0xE0000000);
	}

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		int[] size = PcScreenView.guestSize(this.pcId);
		PcLayout.Rect r = PcLayout.fit(0, 12, this.width, this.height - 24, size[0], size[1], 0.96);
		boolean live = PcScreenView.draw(g, this.font, this.pcId, r);
		Pc.PcCursor cursor = PcStates.cursorOf(this.pcId);
		if (live && cursor != null && cursor.visible()) {
			double[] p = PcLayout.toGui(r, cursor.x(), cursor.y(), size[0], size[1]);
			PcScreenView.cursor(g, (int) p[0], (int) p[1], 0xFFFBBF24);
		}
		Pc.PcInfo info = PcStates.get(this.pcId);
		String name = info != null ? info.name() : this.pcId;
		g.centeredText(this.font, Component.translatable("screen.minevibe.pc.watch.title", name), this.width / 2, 2, 0xFFFFFFFF);
		g.centeredText(this.font, Component.translatable("screen.minevibe.pc.watch.hint"), this.width / 2, this.height - 11, 0xFF9CA3AF);
		super.extractRenderState(g, mouseX, mouseY, a);
	}
}
