package dev.minevibe.client.pc.screen;

/**
 * Where a PC screen is drawn inside a GUI area, and how GUI mouse positions map to guest pixels (PLAN 7.7). Pure
 * arithmetic, unit-tested.
 */
public final class PcLayout {
	private PcLayout() {}

	/** A rectangle in GUI coordinates (doubles: animation and the pose scale make it fractional). */
	public record Rect(double x, double y, double w, double h) {
		public boolean contains(final double px, final double py) {
			return px >= this.x && py >= this.y && px < this.x + this.w && py < this.y + this.h;
		}

		public Rect lerp(final Rect to, final double t) {
			return new Rect(this.x + (to.x - this.x) * t, this.y + (to.y - this.y) * t, this.w + (to.w - this.w) * t, this.h + (to.h - this.h) * t);
		}
	}

	/**
	 * The largest rect of the guest's aspect ({@code guestW x guestH}) that fits {@code fraction} of the area
	 * ({@code areaW x areaH}, starting at {@code areaX, areaY}), centred.
	 */
	public static Rect fit(final double areaX, final double areaY, final double areaW, final double areaH, final int guestW, final int guestH, final double fraction) {
		double maxW = areaW * fraction;
		double maxH = areaH * fraction;
		double aspect = guestW > 0 && guestH > 0 ? (double) guestW / guestH : 16.0 / 10.0;
		double w = maxW;
		double h = w / aspect;
		if (h > maxH) {
			h = maxH;
			w = h * aspect;
		}
		return new Rect(areaX + (areaW - w) / 2, areaY + (areaH - h) / 2, w, h);
	}

	/** The guest pixel under GUI point {@code (gx, gy)} drawn in {@code r}, clamped to the guest screen. */
	public static int[] toGuest(final Rect r, final double gx, final double gy, final int guestW, final int guestH) {
		int x = (int) Math.floor((gx - r.x()) / r.w() * guestW);
		int y = (int) Math.floor((gy - r.y()) / r.h() * guestH);
		return new int[] {clamp(x, 0, Math.max(0, guestW - 1)), clamp(y, 0, Math.max(0, guestH - 1))};
	}

	/** The GUI point where guest pixel {@code (px, py)} is drawn in {@code r}. */
	public static double[] toGui(final Rect r, final int px, final int py, final int guestW, final int guestH) {
		return new double[] {r.x() + (px + 0.5) / guestW * r.w(), r.y() + (py + 0.5) / guestH * r.h()};
	}

	/** Ease-out (cubic) of a 0..1 progress. */
	public static double easeOut(final double t) {
		double c = Math.max(0, Math.min(1, t));
		return 1 - Math.pow(1 - c, 3);
	}

	private static int clamp(final int v, final int lo, final int hi) {
		return Math.max(lo, Math.min(hi, v));
	}
}
