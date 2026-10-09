package dev.minevibe.client.pc.input;

import dev.minevibe.bridge.msg.Pc;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Turns the player's keyboard and mouse at a PC into {@code pc.input} events (PLAN 7.7). Pure logic, no Minecraft
 * types, so the mapping is unit-tested.
 *
 * <ul>
 *   <li>Text ({@code charTyped}) goes as {@code text}: layout-correct, so AZERTY and Option-characters work.</li>
 *   <li>Special keys go as {@code key} down/up by scancode; repeats are not re-sent (the guest repeats a held key),
 *       except to a macOS guest, whose spacesd cannot hold a key: there every repeat is another key-down (Node presses
 *       the key once per key-down).</li>
 *   <li>Printable keys with Ctrl or Cmd held go as keys (by keycode, see {@link SdlKeyMap}); their text is
 *       ignored.</li>
 *   <li>Modifiers are sent lazily: right before a key or button that needs them, and released again before text (so a
 *       held Shift never changes what {@code text} types) and when let go.</li>
 *   <li>{@link #releaseAll} clears everything and sends {@code release_all} (screen closed, standing up, focus
 *       lost).</li>
 * </ul>
 */
public final class PcInputTranslator {
	private final PcInputBatcher out;
	private final boolean macGuest;
	/** Non-modifier keys sent down, by scancode, with the name they were sent as. */
	private final Map<Integer, String> keysDown = new HashMap<>();
	/** Modifiers sent down to the guest. */
	private final Set<String> modifiersDown = new LinkedHashSet<>();
	private final Set<String> buttonsDown = new LinkedHashSet<>();

	public PcInputTranslator(final PcInputBatcher out, final boolean macGuest) {
		this.out = out;
		this.macGuest = macGuest;
	}

	/** A key press (or repeat). Returns true when it became guest input. */
	public boolean keyPressed(final int scancode, final int keycode, final int modifiers, final boolean repeat) {
		if (SdlKeyMap.isModifier(scancode) || scancode == SdlKeyMap.SC_CAPSLOCK) {
			return true;
		}
		String key = SdlKeyMap.special(scancode);
		if (key == null && SdlKeyMap.isCommandChord(modifiers)) {
			key = SdlKeyMap.printable(scancode, keycode);
		}
		if (key == null) {
			return false;
		}
		if (this.keysDown.containsKey(scancode)) {
			// A macOS guest cannot hold a key (its spacesd only presses), so the host's repeats press it again there.
			if (this.macGuest) {
				this.out.add(Pc.InputEvent.key(this.keysDown.get(scancode), true));
			}
			return true;
		}
		this.syncModifiers(modifiers);
		this.keysDown.put(scancode, key);
		this.out.add(Pc.InputEvent.key(key, true));
		return true;
	}

	public void keyReleased(final int scancode, final int modifiers) {
		String key = this.keysDown.remove(scancode);
		if (key != null) {
			this.out.add(Pc.InputEvent.key(key, false));
		}
		if (SdlKeyMap.isModifier(scancode)) {
			String name = SdlKeyMap.modifier(scancode, this.macGuest);
			// The key-up's modifier state may still include the key itself: ignore its own bits.
			int remaining = modifiers & ~SdlKeyMap.modifierBits(scancode);
			if (name != null && this.modifiersDown.contains(name) && !this.modifierNames(remaining).contains(name)) {
				this.modifiersDown.remove(name);
				this.out.add(Pc.InputEvent.key(name, false));
			}
		}
	}

	/** A typed character. Control characters and command chords are not text. */
	public void charTyped(final int codepoint, final int modifiers) {
		if (SdlKeyMap.isCommandChord(modifiers) || codepoint < 0x20 || codepoint == 0x7F || !Character.isValidCodePoint(codepoint)) {
			return;
		}
		this.releaseModifiers();
		this.out.add(Pc.InputEvent.text(Character.toString(codepoint)));
	}

	public void mouseMove(final int x, final int y) {
		this.out.add(Pc.InputEvent.move(x, y));
	}

	/** {@code button} is {@code left}, {@code right} or {@code middle}. */
	public void mouseButton(final String button, final boolean down, final int x, final int y, final int modifiers) {
		if (down) {
			this.syncModifiers(modifiers);
			this.buttonsDown.add(button);
		} else if (!this.buttonsDown.remove(button)) {
			return;
		}
		this.out.add(Pc.InputEvent.button(button, down, x, y));
	}

	public void scroll(final int dx, final int dy, final int x, final int y) {
		if (dx != 0 || dy != 0) {
			this.out.add(Pc.InputEvent.scroll(dx, dy, x, y));
		}
	}

	/** Lets go of everything the guest thinks is held. */
	public void releaseAll() {
		this.keysDown.clear();
		this.modifiersDown.clear();
		this.buttonsDown.clear();
		this.out.add(Pc.InputEvent.releaseAll());
	}

	public boolean anythingDown() {
		return !this.keysDown.isEmpty() || !this.modifiersDown.isEmpty() || !this.buttonsDown.isEmpty();
	}

	private void syncModifiers(final int modifiers) {
		for (String name : this.modifierNames(modifiers)) {
			if (this.modifiersDown.add(name)) {
				this.out.add(Pc.InputEvent.key(name, true));
			}
		}
	}

	private void releaseModifiers() {
		for (String name : this.modifiersDown) {
			this.out.add(Pc.InputEvent.key(name, false));
		}
		this.modifiersDown.clear();
	}

	private Set<String> modifierNames(final int modifiers) {
		Set<String> names = new LinkedHashSet<>();
		if ((modifiers & SdlKeyMap.MOD_CTRL) != 0) {
			names.add("KEY_CONTROL");
		}
		if ((modifiers & SdlKeyMap.MOD_GUI) != 0) {
			names.add(this.macGuest ? "KEY_META" : "KEY_CONTROL");
		}
		if ((modifiers & SdlKeyMap.MOD_ALT) != 0) {
			names.add("KEY_ALT");
		}
		if ((modifiers & SdlKeyMap.MOD_SHIFT) != 0) {
			names.add("KEY_SHIFT");
		}
		return names;
	}
}
