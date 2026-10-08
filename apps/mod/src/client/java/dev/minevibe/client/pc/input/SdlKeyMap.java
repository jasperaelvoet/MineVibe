package dev.minevibe.client.pc.input;

import org.jspecify.annotations.Nullable;

/**
 * SDL3 keys to cua {@code KEY_*} names (PLAN 7.7). Minecraft 26.3 reports keys as SDL scancodes (physical position,
 * {@code KeyEvent#key()}) and SDL keycodes (the layout's symbol, {@code KeyEvent#keycode()}).
 *
 * <ul>
 *   <li><b>Special keys</b> (Enter, Esc, Tab, arrows, F-keys, Home/End, ...) are mapped by scancode and sent as key
 *       down/up: their meaning does not depend on the layout.</li>
 *   <li><b>Printable keys</b> normally travel as text ({@code charTyped}, layout-correct, so AZERTY works). With Ctrl
 *       or Cmd held there is no text; the chord is sent as keys, mapped by <em>keycode</em> so that AZERTY's
 *       Ctrl+A is the guest's Ctrl+A (the guest uses a US layout), falling back to the scancode.</li>
 *   <li><b>Modifiers</b>: Shift, Ctrl, Alt; Cmd (GUI) is Ctrl on Linux guests and Meta (Cmd) on macOS guests.
 *       Caps Lock is never sent (text already carries the case).</li>
 * </ul>
 */
public final class SdlKeyMap {
	private SdlKeyMap() {}

	// SDL3 scancodes (USB HID usage ids).
	public static final int SC_A = 4;
	public static final int SC_Z = 29;
	public static final int SC_1 = 30;
	public static final int SC_0 = 39;
	public static final int SC_RETURN = 40;
	public static final int SC_ESCAPE = 41;
	public static final int SC_BACKSPACE = 42;
	public static final int SC_TAB = 43;
	public static final int SC_SPACE = 44;
	public static final int SC_CAPSLOCK = 57;
	public static final int SC_F1 = 58;
	public static final int SC_F12 = 69;
	public static final int SC_F13 = 104;
	public static final int SC_F24 = 115;
	public static final int SC_KP_DIVIDE = 84;
	public static final int SC_KP_PERIOD = 99;
	public static final int SC_LCTRL = 224;
	public static final int SC_LSHIFT = 225;
	public static final int SC_LALT = 226;
	public static final int SC_LGUI = 227;
	public static final int SC_RCTRL = 228;
	public static final int SC_RSHIFT = 229;
	public static final int SC_RALT = 230;
	public static final int SC_RGUI = 231;

	/** SDL_Keymod bits (InputConstants.MOD_*). */
	public static final int MOD_SHIFT = 0x0003;
	public static final int MOD_CTRL = 0x00C0;
	public static final int MOD_ALT = 0x0300;
	public static final int MOD_GUI = 0x0C00;

	/** The cua modifier a modifier scancode stands for, or null. {@code macGuest} decides what Cmd is. */
	public static @Nullable String modifier(final int scancode, final boolean macGuest) {
		return switch (scancode) {
			case SC_LSHIFT, SC_RSHIFT -> "KEY_SHIFT";
			case SC_LCTRL, SC_RCTRL -> "KEY_CONTROL";
			case SC_LALT, SC_RALT -> "KEY_ALT";
			case SC_LGUI, SC_RGUI -> macGuest ? "KEY_META" : "KEY_CONTROL";
			default -> null;
		};
	}

	/** The SDL_Keymod bits a modifier scancode sets (both sides), 0 for other keys. */
	public static int modifierBits(final int scancode) {
		return switch (scancode) {
			case SC_LSHIFT, SC_RSHIFT -> MOD_SHIFT;
			case SC_LCTRL, SC_RCTRL -> MOD_CTRL;
			case SC_LALT, SC_RALT -> MOD_ALT;
			case SC_LGUI, SC_RGUI -> MOD_GUI;
			default -> 0;
		};
	}

	public static boolean isModifier(final int scancode) {
		return scancode >= SC_LCTRL && scancode <= SC_RGUI;
	}

	/** A key whose meaning does not depend on the layout and that never produces text: always sent as a key. */
	public static @Nullable String special(final int scancode) {
		if (scancode >= SC_F1 && scancode <= SC_F12) {
			return "KEY_F" + (scancode - SC_F1 + 1);
		}
		if (scancode >= SC_F13 && scancode <= SC_F24) {
			return "KEY_F" + (scancode - SC_F13 + 13);
		}
		return switch (scancode) {
			case SC_RETURN -> "KEY_ENTER";
			case SC_ESCAPE -> "KEY_ESCAPE";
			case SC_BACKSPACE -> "KEY_BACKSPACE";
			case SC_TAB -> "KEY_TAB";
			case 70 -> "KEY_PRINT_SCREEN";
			case 71 -> "KEY_SCROLL_LOCK";
			case 72 -> "KEY_PAUSE";
			case 73 -> "KEY_INSERT";
			case 74 -> "KEY_HOME";
			case 75 -> "KEY_PAGE_UP";
			case 76 -> "KEY_DELETE";
			case 77 -> "KEY_END";
			case 78 -> "KEY_PAGE_DOWN";
			case 79 -> "KEY_ARROW_RIGHT";
			case 80 -> "KEY_ARROW_LEFT";
			case 81 -> "KEY_ARROW_DOWN";
			case 82 -> "KEY_ARROW_UP";
			case 83 -> "KEY_NUM_LOCK";
			case 88 -> "KEY_NUMPAD_ENTER";
			case 101 -> "KEY_CONTEXT_MENU";
			case 117 -> "KEY_HELP";
			default -> null;
		};
	}

	/**
	 * A printable key as a cua key name, for chords (Ctrl/Cmd held). Uses the SDL keycode first (the layout's letter,
	 * digit or ASCII symbol), then the scancode's US position.
	 */
	public static @Nullable String printable(final int scancode, final int keycode) {
		String byKeycode = fromKeycode(keycode);
		return byKeycode != null ? byKeycode : fromScancode(scancode);
	}

	/** SDL keycodes of printable keys are their (lower-case) ASCII / Unicode character. */
	static @Nullable String fromKeycode(final int keycode) {
		if (keycode >= 'a' && keycode <= 'z') {
			return "KEY_" + (char) (keycode - 'a' + 'A');
		}
		if (keycode >= '0' && keycode <= '9') {
			return "KEY_DIGIT_" + (char) keycode;
		}
		return switch (keycode) {
			case ' ' -> "KEY_SPACE";
			case '-' -> "KEY_MINUS";
			case '=' -> "KEY_EQUAL";
			case '[' -> "KEY_BRACKET_LEFT";
			case ']' -> "KEY_BRACKET_RIGHT";
			case '\\' -> "KEY_BACKSLASH";
			case ';' -> "KEY_SEMICOLON";
			case '\'' -> "KEY_QUOTE";
			case '`' -> "KEY_BACKQUOTE";
			case ',' -> "KEY_COMMA";
			case '.' -> "KEY_PERIOD";
			case '/' -> "KEY_SLASH";
			default -> null;
		};
	}

	/** The US-layout key at a printable scancode. */
	static @Nullable String fromScancode(final int scancode) {
		if (scancode >= SC_A && scancode <= SC_Z) {
			return "KEY_" + (char) ('A' + scancode - SC_A);
		}
		if (scancode >= SC_1 && scancode < SC_0) {
			return "KEY_DIGIT_" + (scancode - SC_1 + 1);
		}
		if (scancode >= 89 && scancode <= 97) {
			return "KEY_NUMPAD_" + (scancode - 89 + 1);
		}
		return switch (scancode) {
			case SC_0 -> "KEY_DIGIT_0";
			case SC_SPACE -> "KEY_SPACE";
			case 45 -> "KEY_MINUS";
			case 46 -> "KEY_EQUAL";
			case 47 -> "KEY_BRACKET_LEFT";
			case 48 -> "KEY_BRACKET_RIGHT";
			case 49, 50 -> "KEY_BACKSLASH";
			case 51 -> "KEY_SEMICOLON";
			case 52 -> "KEY_QUOTE";
			case 53 -> "KEY_BACKQUOTE";
			case 54 -> "KEY_COMMA";
			case 55 -> "KEY_PERIOD";
			case 56 -> "KEY_SLASH";
			case SC_KP_DIVIDE -> "KEY_NUMPAD_DIVIDE";
			case 85 -> "KEY_NUMPAD_MULTIPLY";
			case 86 -> "KEY_NUMPAD_SUBTRACT";
			case 87 -> "KEY_NUMPAD_ADD";
			case 98 -> "KEY_NUMPAD_0";
			case SC_KP_PERIOD -> "KEY_NUMPAD_DECIMAL";
			case 100 -> "KEY_INTL_BACKSLASH";
			case 103 -> "KEY_NUMPAD_EQUAL";
			default -> null;
		};
	}

	/** Ctrl or Cmd is held: printable keys have no text and go as chords. */
	public static boolean isCommandChord(final int modifiers) {
		return (modifiers & (MOD_CTRL | MOD_GUI)) != 0;
	}
}
