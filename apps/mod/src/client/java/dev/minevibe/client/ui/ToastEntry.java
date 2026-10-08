package dev.minevibe.client.ui;

import org.jspecify.annotations.Nullable;

/**
 * One toast in the bottom-left corner ({@code ui.toast}, or an agent line spoken more than 32 blocks away).
 *
 * @param kind {@code info}, {@code success}, {@code warn} or {@code error}
 */
public record ToastEntry(String text, String kind, @Nullable String agentId, long shownAtMs, long ttlMs) {
	public static final long DEFAULT_TTL_MS = 6000;

	public boolean alive(long nowMs) {
		return nowMs < shownAtMs + ttlMs;
	}

	/** Slides out over the last 500 ms. */
	public float alpha(long nowMs) {
		long left = shownAtMs + ttlMs - nowMs;
		if (left <= 0) return 0f;
		return Math.min(1f, left / 500f);
	}

	/** The accent color (ARGB) of the toast's kind. */
	public int accent() {
		return switch (kind) {
			case "success" -> 0xFF55D17A;
			case "warn" -> 0xFFFFB13B;
			case "error" -> 0xFFFF5555;
			default -> 0xFF7FB2FF;
		};
	}
}
