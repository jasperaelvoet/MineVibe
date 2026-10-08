package dev.minevibe.client.pc.render;

/**
 * Where the screen of a {@code pc_desk} monitor is, in the monitor block's north-facing frame (block units; the side
 * column is at +x, the viewer at -z). Matches {@code models/block/pc_desk_*_upper.json}: the bezel spans x 4..28 px
 * over both columns and y 1..16 px, the screen recess is x 5..27, y 2..15 at z 10.5, and the picture floats at
 * z 10.25.
 */
public final class MonitorGeometry {
	public static final float AREA_X0 = 5f / 16f;
	public static final float AREA_X1 = 27f / 16f;
	public static final float AREA_Y0 = 2f / 16f;
	public static final float AREA_Y1 = 15f / 16f;
	public static final float SCREEN_Z = 10.25f / 16f;
	/** Text and overlays sit this much closer to the viewer than the picture. */
	public static final float OVERLAY_DZ = 0.05f / 16f;

	private MonitorGeometry() {}

	/** The picture rect {@code [x0, y0, x1, y1]} for a guest of {@code w x h}, letterboxed into the screen area. */
	public static float[] screenRect(final int w, final int h) {
		float areaW = AREA_X1 - AREA_X0;
		float areaH = AREA_Y1 - AREA_Y0;
		float aspect = w > 0 && h > 0 ? (float) w / h : 1.6f;
		float sw = areaW;
		float sh = sw / aspect;
		if (sh > areaH) {
			sh = areaH;
			sw = sh * aspect;
		}
		float cx = (AREA_X0 + AREA_X1) / 2;
		float cy = (AREA_Y0 + AREA_Y1) / 2;
		return new float[] {cx - sw / 2, cy - sh / 2, cx + sw / 2, cy + sh / 2};
	}
}
