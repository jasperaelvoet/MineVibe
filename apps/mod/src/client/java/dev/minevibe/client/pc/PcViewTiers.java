package dev.minevibe.client.pc;

import java.util.HashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The frame tier the player asks for per PC ({@code pc.view}, PLAN 7.6, 8.4): {@code focus} for the PC they sit at or
 * watch, {@code visible} for monitors within {@link #VISIBLE_BLOCKS} blocks (with {@link #HYSTERESIS_BLOCKS} more
 * before it drops back, so walking along the edge does not flap), {@code none} otherwise. Pure logic.
 */
public final class PcViewTiers {
	public static final double VISIBLE_BLOCKS = 32;
	public static final double HYSTERESIS_BLOCKS = 4;

	public static final String FOCUS = "focus";
	public static final String VISIBLE = "visible";
	public static final String NONE = "none";

	private PcViewTiers() {}

	/**
	 * The tiers now.
	 *
	 * @param focused the PC the player sits at or watches, or null
	 * @param distances distance from the camera to each loaded monitor, by pcId
	 * @param previous the tiers sent last time (for hysteresis)
	 */
	public static Map<String, String> compute(
		final @Nullable String focused, final Map<String, Double> distances, final Map<String, String> previous
	) {
		Map<String, String> out = new HashMap<>();
		for (Map.Entry<String, Double> e : distances.entrySet()) {
			String pcId = e.getKey();
			double d = e.getValue();
			boolean wasVisible = !NONE.equals(previous.getOrDefault(pcId, NONE));
			double limit = wasVisible ? VISIBLE_BLOCKS + HYSTERESIS_BLOCKS : VISIBLE_BLOCKS;
			out.put(pcId, d <= limit ? VISIBLE : NONE);
		}
		if (focused != null) {
			out.put(focused, FOCUS);
		}
		return out;
	}

	/** The {@code pc.view} messages to send: every PC whose tier changed; PCs no longer known drop to {@code none}. */
	public static Map<String, String> changes(final Map<String, String> previous, final Map<String, String> now) {
		Map<String, String> out = new HashMap<>();
		for (Map.Entry<String, String> e : now.entrySet()) {
			if (!e.getValue().equals(previous.getOrDefault(e.getKey(), NONE))) {
				out.put(e.getKey(), e.getValue());
			}
		}
		for (Map.Entry<String, String> e : previous.entrySet()) {
			if (!now.containsKey(e.getKey()) && !NONE.equals(e.getValue())) {
				out.put(e.getKey(), NONE);
			}
		}
		return out;
	}
}
