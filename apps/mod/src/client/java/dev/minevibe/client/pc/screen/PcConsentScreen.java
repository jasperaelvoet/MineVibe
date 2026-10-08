package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.pc.PcBridge;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * The consent modal for a PC download (PLAN 7.8, 9.3: macOS images are about 24 GB and need the player's OK): what,
 * how big, how much disk is free. Download / Not now answer {@code pc.consent}; either returns to the config screen.
 */
public final class PcConsentScreen extends Screen {
	private final Screen parent;
	private final String pcId;
	private final Pc.ConsentPrompt prompt;

	public PcConsentScreen(final Screen parent, final String pcId, final Pc.ConsentPrompt prompt) {
		super(Component.translatable("screen.minevibe.pc.consent.title"));
		this.parent = parent;
		this.pcId = pcId;
		this.prompt = prompt;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	protected void init() {
		int y = this.height / 2 + 24;
		boolean fits = this.prompt.bytes() <= this.prompt.freeBytes();
		Button download = this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.consent.accept"), b -> this.answer(true))
			.bounds(this.width / 2 - 104, y, 100, 20)
			.build());
		download.active = fits;
		this.addRenderableWidget(Button.builder(Component.translatable("screen.minevibe.pc.consent.decline"), b -> this.answer(false))
			.bounds(this.width / 2 + 4, y, 100, 20)
			.build());
	}

	private void answer(final boolean accept) {
		PcBridge.request(Pc.PC_CONSENT, new Pc.PcConsent(this.pcId, this.prompt.consentId(), accept), PcBridge.ACTION_TIMEOUT);
		this.minecraft.gui.setScreen(this.parent);
	}

	@Override
	public void onClose() {
		this.minecraft.gui.setScreen(this.parent);
	}

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		int cx = this.width / 2;
		int top = this.height / 2 - 50;
		g.fill(cx - 160, top - 8, cx + 160, top + 100, 0xF0101418);
		g.centeredText(this.font, this.title, cx, top, 0xFFFFFFFF);
		g.centeredText(this.font, Component.literal(this.prompt.what()), cx, top + 16, 0xFFD1D5DB);
		g.centeredText(this.font, Component.translatable("screen.minevibe.pc.consent.size", size(this.prompt.bytes()), size(this.prompt.freeBytes())), cx, top + 30, 0xFFD1D5DB);
		if (this.prompt.bytes() > this.prompt.freeBytes()) {
			g.centeredText(this.font, Component.translatable("screen.minevibe.pc.consent.no_room"), cx, top + 44, 0xFFF87171);
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	static String size(final long bytes) {
		double gb = bytes / 1e9;
		return gb >= 1 ? String.format("%.1f GB", gb) : String.format("%.0f MB", bytes / 1e6);
	}
}
