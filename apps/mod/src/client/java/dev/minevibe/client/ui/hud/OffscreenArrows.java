package dev.minevibe.client.ui.hud;

import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.Bubble;
import dev.minevibe.client.ui.UiState;
import net.minecraft.client.Camera;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;

/**
 * Off-screen arrows (PLAN §7.8): when an agent says something to the player, or presents a card, while it is outside
 * the view, an arrow with its name sits at the screen edge pointing towards it.
 */
public final class OffscreenArrows {
	private OffscreenArrows() {}

	/** Arrows are shown for agents within this distance. */
	static final double MAX_DISTANCE = 96;

	/**
	 * The horizontal angle (degrees, -180..180, positive = to the right) from the view direction to a target, given the
	 * camera yaw (Minecraft convention: 0 = +Z, 90 = -X).
	 */
	public static double relativeYaw(double cameraYaw, Vec3 from, Vec3 to) {
		double dx = to.x - from.x;
		double dz = to.z - from.z;
		double targetYaw = Math.toDegrees(Math.atan2(-dx, dz));
		return Mth.wrapDegrees(targetYaw - cameraYaw);
	}

	/** Vertical angle (degrees, positive = above the view direction) to a target, given the camera pitch. */
	public static double relativePitch(double cameraPitch, Vec3 from, Vec3 to) {
		double dx = to.x - from.x;
		double dy = to.y - from.y;
		double dz = to.z - from.z;
		double targetPitch = -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
		return -(targetPitch - cameraPitch);
	}

	/** True when a target at these relative angles is inside the field of view. */
	public static boolean onScreen(double yaw, double pitch, double vFovDeg, double aspect) {
		double hFov = Math.toDegrees(2 * Math.atan(Math.tan(Math.toRadians(vFovDeg / 2)) * aspect));
		return Math.abs(yaw) < hFov / 2 - 2 && Math.abs(pitch) < vFovDeg / 2 - 2;
	}

	public static void extract(GuiGraphicsExtractor g, DeltaTracker delta) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.level == null || mc.gui.hud.isHidden() || mc.gui.screen() != null) return;
		UiState state = UiState.get();
		AgentView presenter = state.presenter();
		Camera camera = mc.gameRenderer.mainCamera();
		Vec3 eye = camera.position();
		int w = g.guiWidth();
		int h = g.guiHeight();
		double aspect = (double) mc.getWindow().getWidth() / Math.max(1, mc.getWindow().getHeight());
		double fov = mc.options.fov().get();
		Font font = mc.font;
		long now = state.now();
		for (AgentView agent : state.living()) {
			Bubble bubble = state.bubble(agent.agentId());
			boolean speaking = bubble != null && bubble.addressedToPlayer() && bubble.alive(now);
			if (!speaking && agent != presenter) continue;
			Player body = AgentEntities.body(mc.level, agent);
			if (body == null) continue;
			Vec3 target = body.getEyePosition(delta.getGameTimeDeltaPartialTick(false));
			if (target.distanceTo(eye) > MAX_DISTANCE) continue;
			double yaw = relativeYaw(camera.yRot(), eye, target);
			double pitch = relativePitch(camera.xRot(), eye, target);
			if (onScreen(yaw, pitch, fov, aspect)) continue;
			double angle = Math.toRadians(yaw);
			float cx = w / 2f + (float) Math.sin(angle) * (w / 2f - 30);
			float cy = h / 2f - (float) Math.cos(angle) * (h / 2f - 30);
			int color = agent == presenter ? 0xFFFFD84A : 0xFFFFFFFF;
			g.pose().pushMatrix();
			g.pose().translate(cx, cy);
			g.pose().rotate((float) angle);
			g.centeredText(font, "▲", 0, -4, color);
			g.pose().popMatrix();
			String label = agent.name() + (agent == presenter ? " ?" : "");
			int lw = font.width(label);
			int lx = Mth.clamp((int) cx - lw / 2, 2, w - lw - 2);
			int ly = Mth.clamp((int) cy + 8, 2, h - 12);
			g.fill(lx - 2, ly - 1, lx + lw + 2, ly + 9, 0x90000000);
			g.text(font, label, lx, ly, color, false);
		}
	}
}
