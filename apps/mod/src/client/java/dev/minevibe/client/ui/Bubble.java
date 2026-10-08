package dev.minevibe.client.ui;

/**
 * One speech bubble above an agent ({@code agent.say}). The newest bubble of an agent replaces the older one.
 *
 * @param style {@code speech} (the agent's own words, addressed to the player), {@code bark} (scripted line) or
 *     {@code tell} (to another agent)
 */
public record Bubble(String agentId, String text, String style, long shownAtMs, long ttlMs) {
	/** Fade-in and fade-out times. */
	static final long FADE_IN_MS = 150;
	static final long FADE_OUT_MS = 600;

	public boolean alive(long nowMs) {
		return nowMs < shownAtMs + ttlMs;
	}

	/** Opacity over time: a short fade-in, fully visible, then a fade-out at the end of its life. */
	public float alpha(long nowMs) {
		long age = nowMs - shownAtMs;
		if (age < 0 || age >= ttlMs) return 0f;
		float in = Math.min(1f, (age + 1f) / FADE_IN_MS);
		long left = ttlMs - age;
		float out = Math.min(1f, left / (float) FADE_OUT_MS);
		return Math.max(0f, Math.min(in, out));
	}

	/** The agent's own words to the player (these get an off-screen arrow and may be truncated with "… (G)"). */
	public boolean addressedToPlayer() {
		return "speech".equals(style);
	}

	/**
	 * Opacity by distance (PLAN §7.8 "fade with distance"): full up to {@code 16} blocks, fading out towards 32;
	 * beyond 32 blocks the bubble is not drawn (the line arrives as a toast instead).
	 */
	public static float distanceAlpha(double distance) {
		if (distance <= 16) return 1f;
		if (distance >= BubbleLayout.MAX_BUBBLE_DISTANCE) return 0f;
		return (float) ((BubbleLayout.MAX_BUBBLE_DISTANCE - distance) / (BubbleLayout.MAX_BUBBLE_DISTANCE - 16));
	}
}
