package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.client.pc.PcSeatWatcher;
import dev.minevibe.client.pc.input.PcInputBatcher;
import dev.minevibe.client.pc.input.PcInputTranslator;
import dev.minevibe.client.pc.input.SdlKeyMap;
import dev.minevibe.pc.PcBridge;
import dev.minevibe.pc.PcStates;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.lwjgl.sdl.SDLKeyboard;
import org.lwjgl.sdl.SDLMouse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The player at a PC (PLAN 7.7): the PC's screen at about 92% of the window (animated in from a smaller rect), and
 * every key and mouse event goes to the guest.
 *
 * <ul>
 *   <li>Non-pausing, {@code shouldCloseOnEsc() == false}, input captured; SDL text input is on
 *       ({@code onTextInputFocusChange}), so {@code charTyped} delivers layout-correct text.</li>
 *   <li>Reserved: <b>Shift+Esc</b> stands up (plain Esc goes to the PC), holding the <b>middle mouse button</b> looks
 *       around, <b>Ctrl+Shift+Enter</b> opens the chat/card overlay. F2/F11 stay Minecraft's (screenshot,
 *       fullscreen). Everything else, Tab included, goes to the PC.</li>
 *   <li>The mouse maps onto the picture in guest pixels; the guest cursor is not in the frames (PLAN 8.6), so the
 *       screen draws its own and hides the system one over the picture.</li>
 *   <li>Input is batched into {@code pc.input} at most 60 times a second; closing the screen (standing, the overlay,
 *       death) sends {@code release_all}.</li>
 * </ul>
 */
public final class PcControlScreen extends Screen {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");
	private static final boolean LOG_INPUT = "true".equalsIgnoreCase(System.getProperty("minevibe.pcInputLog"))
		|| "1".equals(System.getenv("MINEVIBE_PC_INPUT_LOG"));
	private static final long ANIMATION_NANOS = 250_000_000L;
	private static final long FLUSH_NANOS = 1_000_000_000L / 60;
	private static final double SIZE = 0.92;
	private static final int HINT_HEIGHT = 14;

	private final String pcId;
	private final PcInputBatcher batcher = new PcInputBatcher();
	private final PcInputTranslator input;
	private final boolean macGuest;
	private long openedNanos;
	private long lastFlushNanos;
	private boolean looking;
	private boolean cursorHidden;
	private boolean closing;
	private PcLayout.Rect picture = new PcLayout.Rect(0, 0, 1, 1);

	public PcControlScreen(final String pcId) {
		super(Component.translatable("screen.minevibe.pc.control"));
		this.pcId = pcId;
		Pc.PcInfo info = PcStates.get(pcId);
		this.macGuest = info != null && "macos".equals(info.type());
		this.input = new PcInputTranslator(this.batcher, this.macGuest);
	}

	public String pcId() {
		return this.pcId;
	}

	@Override
	protected void init() {
		if (this.openedNanos == 0) {
			this.openedNanos = System.nanoTime();
		}
		this.minecraft.onTextInputFocusChange(this, true);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public boolean shouldCloseOnEsc() {
		return false;
	}

	@Override
	public boolean isInputCaptured() {
		return true;
	}

	@Override
	public void removed() {
		this.input.releaseAll();
		this.flush(true);
		this.showSystemCursor();
		this.looking = false;
	}

	/** The player is no longer seated (PcSeatWatcher). */
	public void closeBecauseStood() {
		if (!this.closing) {
			this.closing = true;
			this.onClose();
		}
	}

	private void standUp() {
		this.input.releaseAll();
		this.flush(true);
		PcSeatWatcher.requestStand(this.minecraft);
		this.closeBecauseStood();
	}

	// -----------------------------------------------------------------------------------------
	// Layout and drawing
	// -----------------------------------------------------------------------------------------

	private PcLayout.Rect targetRect() {
		int[] size = PcScreenView.guestSize(this.pcId);
		double top = PcBorderStrip.HEIGHT;
		double h = this.height - PcBorderStrip.HEIGHT - HINT_HEIGHT;
		return PcLayout.fit(0, top, this.width, h, size[0], size[1], SIZE);
	}

	@Override
	public void extractBackground(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		if (!this.looking) {
			g.fill(0, 0, this.width, this.height, 0xB0000000);
		}
	}

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		float hurt = this.minecraft.player != null && this.minecraft.player.hurtTime > 0 ? this.minecraft.player.hurtTime / 10f : 0;
		if (this.looking) {
			g.centeredText(this.font, Component.translatable("screen.minevibe.pc.looking"), this.width / 2, this.height - 24, 0xFFFFFFFF);
			PcBorderStrip.extract(g, this.font, this.width, hurt);
			this.showSystemCursor();
			return;
		}
		PcLayout.Rect target = this.targetRect();
		double t = PcLayout.easeOut((System.nanoTime() - this.openedNanos) / (double) ANIMATION_NANOS);
		PcLayout.Rect start = PcLayout.fit(0, 0, this.width, this.height, (int) target.w(), (int) target.h(), 0.35);
		this.picture = start.lerp(target, t);
		g.fill(
			(int) this.picture.x() - 2, (int) this.picture.y() - 2, (int) (this.picture.x() + this.picture.w()) + 2, (int) (this.picture.y() + this.picture.h()) + 2,
			hurt > 0 ? 0xFFDC2626 : 0xFF1F2937
		);
		boolean live = PcScreenView.draw(g, this.font, this.pcId, this.picture);
		boolean inside = this.picture.contains(mouseX, mouseY);
		if (inside && live) {
			PcScreenView.cursor(g, mouseX, mouseY, 0xFFFFFFFF);
			this.hideSystemCursor();
		} else {
			this.showSystemCursor();
		}
		PcBorderStrip.extract(g, this.font, this.width, hurt);
		g.fill(0, this.height - HINT_HEIGHT, this.width, this.height, 0xC0101418);
		g.centeredText(this.font, this.hint(), this.width / 2, this.height - HINT_HEIGHT + 3, 0xFFD1D5DB);
		this.flush(false);
	}

	/** The longest hint line that fits the window. */
	private Component hint() {
		String[] keys = {
			this.macGuest ? "screen.minevibe.pc.hint.mac" : "screen.minevibe.pc.hint.linux", "screen.minevibe.pc.hint.medium", "screen.minevibe.pc.hint.short"
		};
		for (String key : keys) {
			Component c = Component.translatable(key);
			if (this.font.width(c) <= this.width - 8) {
				return c;
			}
		}
		return Component.translatable(keys[keys.length - 1]);
	}

	@Override
	public void tick() {
		// Focus went elsewhere (Cmd+Tab, a click outside): key-ups may never come, so let go of everything now.
		if (!this.minecraft.isWindowActive() && this.input.anythingDown()) {
			this.input.releaseAll();
			this.flush(true);
		}
	}

	private void hideSystemCursor() {
		if (!this.cursorHidden) {
			SDLMouse.SDL_HideCursor();
			this.cursorHidden = true;
		}
	}

	private void showSystemCursor() {
		if (this.cursorHidden) {
			SDLMouse.SDL_ShowCursor();
			this.cursorHidden = false;
		}
	}

	/** Sends what was batched, at most 60 times a second unless {@code now}. */
	private void flush(final boolean now) {
		if (this.batcher.isEmpty()) {
			return;
		}
		long t = System.nanoTime();
		if (!now && t - this.lastFlushNanos < FLUSH_NANOS) {
			return;
		}
		this.lastFlushNanos = t;
		List<Pc.PcInput> batches = this.batcher.drain(this.pcId);
		for (Pc.PcInput batch : batches) {
			if (LOG_INPUT) {
				LOG.info("[pc-input] -> {}", batch.events());
			}
			PcBridge.send(Pc.PC_INPUT, batch);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Keyboard
	// -----------------------------------------------------------------------------------------

	@Override
	public boolean keyPressed(final KeyEvent event) {
		if (LOG_INPUT) {
			LOG.info("[pc-input] KeyEvent down scancode={} keycode={} mods=0x{}", event.key(), event.keycode(), Integer.toHexString(event.modifiers()));
		}
		int mods = event.modifiers();
		if (event.key() == SdlKeyMap.SC_ESCAPE && (mods & SdlKeyMap.MOD_SHIFT) != 0) {
			this.standUp();
			return true;
		}
		if (event.key() == SdlKeyMap.SC_RETURN && (mods & SdlKeyMap.MOD_CTRL) != 0 && (mods & SdlKeyMap.MOD_SHIFT) != 0) {
			this.input.releaseAll();
			this.flush(true);
			PcBorderStrip.openOverlay();
			return true;
		}
		this.input.keyPressed(event.key(), event.keycode(), mods, false);
		return true;
	}

	@Override
	public boolean keyReleased(final KeyEvent event) {
		if (LOG_INPUT) {
			LOG.info("[pc-input] KeyEvent up scancode={} keycode={} mods=0x{}", event.key(), event.keycode(), Integer.toHexString(event.modifiers()));
		}
		this.input.keyReleased(event.key(), event.modifiers());
		return true;
	}

	@Override
	public boolean charTyped(final CharacterEvent event) {
		int mods = SDLKeyboard.SDL_GetModState() & 0xFFFF;
		if (LOG_INPUT) {
			LOG.info("[pc-input] CharacterEvent codepoint=U+{} '{}' mods=0x{}", Integer.toHexString(event.codepoint()), event.codepointAsString(), Integer.toHexString(mods));
		}
		this.input.charTyped(event.codepoint(), mods);
		return true;
	}

	// -----------------------------------------------------------------------------------------
	// Mouse
	// -----------------------------------------------------------------------------------------

	private int[] guest(final double x, final double y) {
		int[] size = PcScreenView.guestSize(this.pcId);
		return PcLayout.toGuest(this.picture, x, y, size[0], size[1]);
	}

	private static String buttonName(final int button) {
		return switch (button) {
			case 1 -> "left";
			case 3 -> "right";
			case 2 -> "middle";
			default -> "";
		};
	}

	@Override
	public void mouseMoved(final double x, final double y) {
		if (!this.looking && this.picture.contains(x, y)) {
			int[] p = this.guest(x, y);
			this.input.mouseMove(p[0], p[1]);
		}
	}

	@Override
	public boolean mouseClicked(final MouseButtonEvent event, final boolean doubleClick) {
		if (event.button() == 2) {
			this.looking = true;
			return true;
		}
		String name = buttonName(event.button());
		if (!name.isEmpty() && this.picture.contains(event.x(), event.y())) {
			int[] p = this.guest(event.x(), event.y());
			this.input.mouseButton(name, true, p[0], p[1], event.modifiers());
		}
		return true;
	}

	@Override
	public boolean mouseReleased(final MouseButtonEvent event) {
		if (event.button() == 2) {
			this.looking = false;
			return true;
		}
		String name = buttonName(event.button());
		if (!name.isEmpty()) {
			int[] p = this.guest(event.x(), event.y());
			this.input.mouseButton(name, false, p[0], p[1], event.modifiers());
		}
		return true;
	}

	@Override
	public boolean mouseDragged(final MouseButtonEvent event, final double dx, final double dy) {
		if (this.looking) {
			if (this.minecraft.player != null) {
				double s = this.minecraft.options.sensitivity().get() * 0.6 + 0.2;
				double scale = s * s * s * 8.0 * this.minecraft.getWindow().getGuiScale();
				this.minecraft.player.turn(dx * scale, dy * scale);
			}
			return true;
		}
		this.mouseMoved(event.x(), event.y());
		return true;
	}

	@Override
	public boolean mouseScrolled(final double x, final double y, final double scrollX, final double scrollY) {
		if (!this.looking && this.picture.contains(x, y)) {
			int[] p = this.guest(x, y);
			this.input.scroll((int) Math.round(-scrollX * 3), (int) Math.round(-scrollY * 3), p[0], p[1]);
		}
		return true;
	}
}
