package dev.minevibe.client.chat;

import org.jspecify.annotations.Nullable;

/**
 * The inline hint under the chat box (PLAN §6.5): why a line was not sent ("@a matches Ada, Abe"). It belongs to the
 * line it was about and disappears once the player edits that line away. Client thread only.
 */
public final class ChatHint {
	private ChatHint() {}

	private static @Nullable String line;
	private static @Nullable String hint;

	public static void show(String forLine, String text) {
		line = forLine.trim();
		hint = text;
	}

	public static void clear() {
		line = null;
		hint = null;
	}

	/** The hint for what the chat box holds now, or null (a different line clears it). */
	public static @Nullable String current(String boxValue) {
		String l = line;
		if (l == null || hint == null) return null;
		if (!boxValue.trim().equals(l)) {
			clear();
			return null;
		}
		return hint;
	}
}
