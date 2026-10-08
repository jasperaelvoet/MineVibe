package dev.minevibe.client.menu;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.network.chat.Component;

/**
 * The Esc menu (PLAN §7.8, §7.9). It replaces vanilla's pause screen and never pauses the game: the world, the
 * crew and their PCs keep running while it is open, and so do the screens opened from it (vanilla's Options is a
 * pause screen of its own; {@link NonPausingScreens} overrides that). M1 has Resume, Options and Quit MineVibe; there
 * is no Save &amp; Quit, LAN, multiplayer or feedback, because the app is either open (you are in) or closed.
 */
public final class MineVibeMenuScreen extends Screen {
	public MineVibeMenuScreen() {
		super(Component.literal("MineVibe"));
	}

	@Override
	protected void init() {
		int cx = width / 2;
		int y = height / 4 + 32;
		addRenderableWidget(Button.builder(Component.translatable("menu.returnToGame"), b -> resume())
				.bounds(cx - 102, y, 204, 20)
				.build());
		addRenderableWidget(Button.builder(Component.translatable("menu.options"), b -> minecraft.gui.setScreen(new OptionsScreen(this, minecraft.options)))
				.bounds(cx - 102, y + 24, 204, 20)
				.build());
		addRenderableWidget(Button.builder(Component.literal("Quit MineVibe"), b -> quit())
				.bounds(cx - 102, y + 48, 204, 20)
				.build());
	}

	private void resume() {
		minecraft.gui.setScreen(null);
		minecraft.mouseHandler.grabMouse();
	}

	private void quit() {
		// Minecraft#stop ends the main loop; Main then saves the world and closes the game (exitWorldAndClose).
		minecraft.stop();
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		super.extractRenderState(graphics, mouseX, mouseY, a);
		graphics.centeredText(font, title, width / 2, height / 4 + 8, 0xFFFFFFFF);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}
}
