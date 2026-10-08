package dev.minevibe.client.ui.render;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.Bubble;
import dev.minevibe.client.ui.BubbleLayout;
import dev.minevibe.client.ui.HeadIcon;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.client.rendering.v1.RenderStateDataKey;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelExtractionContext;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderContext;
import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.culling.Frustum;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.network.chat.Style;
import net.minecraft.util.ARGB;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.LightCoordsUtil;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Speech bubbles and head icons (PLAN §7.8), drawn independently of the entity renderer so Entity Culling, Iris and
 * ImmediatelyFast cannot hide or break them.
 *
 * <ol>
 *   <li>{@code LevelExtractionEvents.END_EXTRACTION}: for each living crew member whose body is loaded, our own frustum
 *       test on an AABB that includes the bubble height, then plain data (camera-relative position, wrapped lines,
 *       colors, alpha) stored on the level render state. Nothing non-thread-safe is kept.</li>
 *   <li>{@code LevelRenderEvents.COLLECT_SUBMITS}: vanilla text and text-background submits, billboarded like name
 *       tags, above the name tag.</li>
 * </ol>
 * Plain bubbles wrap at 32 characters and 3 lines and fade with distance (gone beyond 32 blocks); the presenter's bubble
 * switches to card mode within 5 blocks.
 */
public final class BubbleRenderer {
	private BubbleRenderer() {}

	private static final RenderStateDataKey<List<Draw>> KEY = RenderStateDataKey.create(() -> "minevibe:bubbles");
	/** Extra height above the body included in the frustum test (name tag, icon and up to 8 lines). */
	private static final double BUBBLE_HEIGHT = 2.6;
	private static final int LINE_HEIGHT = 10;
	private static final float SCALE = 0.02f;

	/** One bubble to draw (camera-relative position of its bottom center). */
	record Draw(double x, double y, double z, List<String> lines, int textColor, int backgroundColor, HeadIcon icon, float alpha) {}

	/** Count of bubbles and icons submitted in the last frame (tests and the dev demo read it). */
	private static volatile int lastSubmitted;

	public static int lastSubmitted() {
		return lastSubmitted;
	}

	public static void extract(LevelExtractionContext context) {
		ClientLevel level = context.level();
		Camera camera = context.camera();
		UiState state = UiState.get();
		if (state.agents().isEmpty()) {
			context.levelState().setData(KEY, List.of());
			return;
		}
		Vec3 cam = camera.position();
		float partialTick = context.deltaTracker().getGameTimeDeltaPartialTick(false);
		Frustum frustum = camera.getCullFrustum();
		boolean online = UiTransport.current().connected();
		AgentView presenter = state.presenter();
		long now = state.now();
		List<Draw> draws = new ArrayList<>();
		for (AgentView agent : state.agents()) {
			if (!agent.alive()) continue;
			Player body = AgentEntities.body(level, agent);
			if (body == null || body.isInvisible()) continue;
			Vec3 pos = body.getPosition(partialTick);
			double distance = pos.distanceTo(cam);
			if (distance > BubbleLayout.MAX_BUBBLE_DISTANCE) continue;
			AABB box = body.getBoundingBox().move(pos.subtract(body.position())).expandTowards(0, BUBBLE_HEIGHT, 0);
			if (!frustum.isVisible(box)) continue;

			HeadIcon icon = HeadIcon.of(agent, AgentEntities.atPc(body, agent), online);
			Ui.PendingCard front = agent.frontCard();
			Bubble bubble = state.bubble(agent.agentId());
			List<String> lines;
			float alpha = Bubble.distanceAlpha(distance);
			// USER DECISION 2026-10-08: a presenter seated at a PC asks from its chair, so its card reaches farther.
			boolean card = agent == presenter && front != null
					&& distance <= BubbleLayout.cardModeDistance(AgentEntities.atPc(body, agent));
			if (card) {
				lines = BubbleLayout.card(front, agent.handle());
			} else if (bubble != null) {
				lines = BubbleLayout.bubble(bubble.text()).lines();
				alpha *= bubble.alpha(now);
			} else {
				lines = List.of();
			}
			if (lines.isEmpty() && icon == HeadIcon.NONE) continue;
			int text = card ? 0xFFFFF4C2 : bubble != null && "bark".equals(bubble.style()) ? 0xFFDDDDDD : 0xFFFFFFFF;
			int background = card ? 0xC0302810 : 0x90000000;
			// Just above the vanilla name tag, which spans [height + 0.275, height + 0.5].
			double y = pos.y + body.getBbHeight() + 0.6;
			draws.add(new Draw(pos.x - cam.x, y - cam.y, pos.z - cam.z, lines, text, background, icon, alpha));
		}
		context.levelState().setData(KEY, List.copyOf(draws));
	}

	public static void submit(LevelRenderContext context) {
		List<Draw> draws = context.levelState().getData(KEY);
		if (draws == null || draws.isEmpty()) {
			lastSubmitted = 0;
			return;
		}
		PoseStack pose = context.poseStack();
		SubmitNodeCollector collector = context.submitNodeCollector();
		CameraRenderState camera = context.levelState().cameraRenderState;
		Font font = Minecraft.getInstance().font;
		int light = LightCoordsUtil.FULL_BRIGHT;
		for (Draw d : draws) {
			if (d.alpha() <= 0.02f) continue;
			pose.pushPose();
			pose.translate(d.x(), d.y(), d.z());
			pose.rotate(camera.orientation);
			pose.scale(SCALE, -SCALE, SCALE);
			int width = 0;
			for (String line : d.lines()) width = Math.max(width, font.width(line));
			float top = -d.lines().size() * LINE_HEIGHT;
			if (!d.lines().isEmpty()) {
				int bg = ARGB.multiplyAlpha(d.backgroundColor(), d.alpha());
				collector.submitTextBackground(pose, -width / 2f - 3, top - 2, width / 2f + 3, 1, bg, Font.DisplayMode.NORMAL, light);
				int color = ARGB.multiplyAlpha(d.textColor(), Math.max(0.1f, d.alpha()));
				float y = top;
				for (String line : d.lines()) {
					collector.submitText(pose, -font.width(line) / 2f, y, text(line), false, Font.DisplayMode.NORMAL, light, color, 0, 0);
					y += LINE_HEIGHT;
				}
			}
			if (d.icon() != HeadIcon.NONE) {
				String glyph = d.icon().glyph();
				float iconY = top - (d.lines().isEmpty() ? 9 : 12);
				int color = ARGB.multiplyAlpha(d.icon().color(), Math.max(0.1f, d.alpha()));
				collector.submitText(
						pose, -font.width(glyph) / 2f, iconY, text(glyph), true, Font.DisplayMode.NORMAL, light, color, 0, 0);
			}
			pose.popPose();
		}
		lastSubmitted = draws.size();
	}

	private static FormattedCharSequence text(String s) {
		return FormattedCharSequence.forward(s, Style.EMPTY);
	}

	/** Test hook: the bubble lines that would be drawn for an agent right now (null when none). */
	public static @Nullable List<String> linesFor(AgentView agent, double distance) {
		return linesFor(agent, distance, false);
	}

	/** Test hook: as {@link #linesFor(AgentView, double)}, for a presenter that sits at a PC or not. */
	public static @Nullable List<String> linesFor(AgentView agent, double distance, boolean seatedAtPc) {
		UiState state = UiState.get();
		Ui.PendingCard front = agent.frontCard();
		if (agent == state.presenter() && front != null && distance <= BubbleLayout.cardModeDistance(seatedAtPc)) {
			return BubbleLayout.card(front, agent.handle());
		}
		Bubble bubble = state.bubble(agent.agentId());
		return bubble == null ? null : BubbleLayout.bubble(bubble.text()).lines();
	}
}
