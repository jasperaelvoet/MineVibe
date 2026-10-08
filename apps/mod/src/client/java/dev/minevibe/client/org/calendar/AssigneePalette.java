package dev.minevibe.client.org.calendar;

import java.util.List;

/**
 * Chip colours by assignee. Crew members get distinct colours in crew order (the CEO first); an agent not in the
 * list gets a stable colour from its id; {@code all} is gold.
 */
public final class AssigneePalette {
	public static final int ALL = 0xFFE0B040;
	public static final int NOBODY = 0xFF808080;
	private static final int[] COLOURS = {
		0xFF4FA3E0, // blue
		0xFF5CC46A, // green
		0xFFE0704F, // orange
		0xFFB07CE0, // violet
		0xFF4FD0C8, // teal
		0xFFE05C9A, // pink
		0xFFC8C850, // olive
		0xFF8A9AE8, // periwinkle
	};

	private AssigneePalette() {
	}

	public static int colourFor(final String agentId, final List<String> crewOrder) {
		int index = crewOrder.indexOf(agentId);
		if (index < 0) {
			index = Math.floorMod(agentId.hashCode(), COLOURS.length);
		}
		return COLOURS[index % COLOURS.length];
	}

	/** The colour of an event: {@code all}, its first assignee, or grey without assignees. */
	public static int colourForEvent(final boolean everyone, final List<String> assignees, final List<String> crewOrder) {
		if (everyone) {
			return ALL;
		}
		return assignees.isEmpty() ? NOBODY : colourFor(assignees.getFirst(), crewOrder);
	}

	/** {@code argb} at {@code alpha} (0-255). */
	public static int withAlpha(final int argb, final int alpha) {
		return (alpha & 0xFF) << 24 | argb & 0xFFFFFF;
	}

	/** {@code argb} scaled toward black by {@code factor} (0-1). */
	public static int darker(final int argb, final float factor) {
		int r = (int)((argb >> 16 & 0xFF) * factor);
		int g = (int)((argb >> 8 & 0xFF) * factor);
		int b = (int)((argb & 0xFF) * factor);
		return argb & 0xFF000000 | r << 16 | g << 8 | b;
	}
}
