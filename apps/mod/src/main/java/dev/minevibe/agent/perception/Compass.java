package dev.minevibe.agent.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;

/**
 * Compass directions for perception: north is -Z, east is +X (as on the F3 screen). Eight points, plus {@code here},
 * {@code above} and {@code below} for targets less than 1.5 blocks away horizontally.
 */
public final class Compass {
	private static final String[] POINTS = {"S", "SW", "W", "NW", "N", "NE", "E", "SE"};

	private Compass() {
	}

	/** The direction from {@code from} to {@code to}. */
	public static String dir(final Vec3i from, final Vec3i to) {
		return dir(to.getX() - from.getX(), to.getY() - from.getY(), to.getZ() - from.getZ());
	}

	public static String dir(final double dx, final double dy, final double dz) {
		if (dx * dx + dz * dz < 1.5 * 1.5) {
			return dy > 1.5 ? "above" : dy < -1.5 ? "below" : "here";
		}
		// Minecraft yaw: 0 = south (+Z), 90 = west (-X), 180 = north, 270 = east.
		double yaw = Math.toDegrees(Math.atan2(-dx, dz));
		int index = (int)Math.floor(((yaw % 360.0 + 360.0) % 360.0 + 22.5) / 45.0) % 8;
		return POINTS[index];
	}

	/** Whole-block distance, rounded. */
	public static int distance(final BlockPos a, final BlockPos b) {
		return (int)Math.round(Math.sqrt(a.distSqr(b)));
	}

	/** {@code 14m NE} */
	public static String where(final BlockPos from, final BlockPos to) {
		String d = dir(from, to);
		int m = distance(from, to);
		return "here".equals(d) ? "here" : m + "m " + d;
	}

	/** {@code 102 64 -37} */
	public static String xyz(final BlockPos p) {
		return p.getX() + " " + p.getY() + " " + p.getZ();
	}
}
