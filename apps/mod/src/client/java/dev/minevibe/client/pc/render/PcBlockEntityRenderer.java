package dev.minevibe.client.pc.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.math.Axis;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.client.pc.PcStatusText;
import dev.minevibe.client.pc.frame.MonitorTextures;
import dev.minevibe.client.pc.frame.PcStats;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcStates;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderer;
import net.minecraft.client.renderer.blockentity.BlockEntityRendererProvider;
import net.minecraft.client.renderer.blockentity.state.BlockEntityRenderState;
import net.minecraft.client.renderer.feature.ModelFeatureRenderer;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.util.LightCoordsUtil;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Draws a PC monitor's screen (PLAN 7.6) with the render-state API: {@link #extractRenderState} reads the block entity
 * and uploads the PC's newest decoded frame (at most once per frame), {@link #submit} draws an opaque, fullbright quad
 * through vanilla's {@code RenderTypes.text} (the MapRenderer pattern, no custom pipeline). Without a picture (PC off,
 * booting, refused, offline, ...) it draws that state's status screen. A seated agent's cursor is drawn on top (frames
 * carry no cursor, PLAN 8.6).
 *
 * <p>Culling: vanilla 26.3 has no {@code getRenderBoundingBox}; the block entity lives in the monitor block, so section
 * visibility and Entity Culling see the block the picture is on ({@code shouldRenderOffScreen} stays false; the picture
 * reaches 12 px into the side column). View distance 64.
 */
public final class PcBlockEntityRenderer implements BlockEntityRenderer<PcBlockEntity, PcBlockEntityRenderer.State> {
	private static final int FULL_BRIGHT = LightCoordsUtil.FULL_BRIGHT;
	private static final int DEFAULT_W = 1280;
	private static final int DEFAULT_H = 800;

	private final Font font;

	public PcBlockEntityRenderer(final BlockEntityRendererProvider.Context context) {
		this.font = context.font();
	}

	/** Everything {@link #submit} needs, copied on the render thread during extraction. */
	public static final class State extends BlockEntityRenderState {
		Direction facing = Direction.NORTH;
		@Nullable Identifier texture;
		PcStatusText.@Nullable Screen status;
		@Nullable String banner;
		int guestW = DEFAULT_W;
		int guestH = DEFAULT_H;
		boolean cursorVisible;
		int cursorX;
		int cursorY;
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public void extractRenderState(
		final PcBlockEntity be, final State state, final float partialTicks, final Vec3 cameraPosition, final ModelFeatureRenderer.@Nullable CrumblingOverlay breakProgress
	) {
		long t0 = System.nanoTime();
		BlockEntityRenderer.super.extractRenderState(be, state, partialTicks, cameraPosition, breakProgress);
		state.facing = be.facing();
		String pcId = be.pcId();
		Pc.PcInfo info = PcStates.get(pcId);
		Identifier texture = pcId != null ? MonitorTextures.prepare(pcId) : null;
		boolean running = info != null && "running".equals(info.status());
		state.texture = running ? texture : null;
		state.status = PcStatusText.of(pcId, be.isCreating(), be.createError(), info, PcStates.isConnected(), state.texture != null);
		if (state.status != null) {
			state.texture = null;
		}
		state.banner = info != null ? info.banner() : null;
		int[] size = pcId != null ? MonitorTextures.size(pcId) : null;
		if (size != null) {
			state.guestW = size[0];
			state.guestH = size[1];
		} else if (info != null && info.screen() != null) {
			state.guestW = info.screen().w();
			state.guestH = info.screen().h();
		} else {
			state.guestW = DEFAULT_W;
			state.guestH = DEFAULT_H;
		}
		Pc.PcCursor cursor = pcId != null ? PcStates.cursorOf(pcId) : null;
		boolean agentSeated = info != null && info.occupant() != null && !info.occupant().isPlayer();
		state.cursorVisible = state.texture != null && cursor != null && cursor.visible() && agentSeated;
		if (cursor != null) {
			state.cursorX = cursor.x();
			state.cursorY = cursor.y();
		}
		PcStats.work(System.nanoTime() - t0);
	}

	@Override
	public void submit(final State state, final PoseStack poseStack, final SubmitNodeCollector collector, final CameraRenderState camera) {
		long t0 = System.nanoTime();
		this.submitUntimed(state, poseStack, collector);
		PcStats.work(System.nanoTime() - t0);
	}

	private void submitUntimed(final State state, final PoseStack poseStack, final SubmitNodeCollector collector) {
		poseStack.pushPose();
		// Into the north-facing frame of MonitorGeometry: the side column at +x, the viewer at -z.
		poseStack.translate(0.5F, 0.0F, 0.5F);
		poseStack.rotateDegrees(Axis.YP, 180.0F - state.facing.toYRot());
		poseStack.translate(-0.5F, 0.0F, -0.5F);
		float[] r = MonitorGeometry.screenRect(state.guestW, state.guestH);
		float z = MonitorGeometry.SCREEN_Z;
		if (state.texture != null) {
			quad(collector, poseStack, state.texture, r[0], r[1], r[2], r[3], z, 0xFFFFFFFF, 0, 0, 1, 1);
			if (state.cursorVisible) {
				this.cursor(collector, poseStack, state, r);
			}
		} else if (state.status != null) {
			this.statusScreen(collector, poseStack, state.status, r);
		}
		if (state.banner != null && !state.banner.isEmpty()) {
			this.banner(collector, poseStack, state.banner, r);
		}
		poseStack.popPose();
	}

	@Override
	public int getViewDistance() {
		return 64;
	}

	// -----------------------------------------------------------------------------------------
	// Drawing (north-facing frame; the viewer's left is +x, so u = 0 sits at the larger x)
	// -----------------------------------------------------------------------------------------

	/** A front-facing quad from x0..x1 (viewer's right..left), y0..y1 (bottom..top), counter-clockwise for the viewer. */
	private static void quad(
		final SubmitNodeCollector collector,
		final PoseStack poseStack,
		final Identifier texture,
		final float x0,
		final float y0,
		final float x1,
		final float y1,
		final float z,
		final int argb,
		final float u0,
		final float v0,
		final float u1,
		final float v1
	) {
		collector.submitCustomGeometry(poseStack, RenderTypes.text(texture), (pose, buffer) -> {
			vertex(buffer, pose, x1, y0, z, argb, u0, v1);
			vertex(buffer, pose, x0, y0, z, argb, u1, v1);
			vertex(buffer, pose, x0, y1, z, argb, u1, v0);
			vertex(buffer, pose, x1, y1, z, argb, u0, v0);
		});
	}

	private static void vertex(final VertexConsumer buffer, final PoseStack.Pose pose, final float x, final float y, final float z, final int argb, final float u, final float v) {
		buffer.addVertex(pose, x, y, z).setColor(argb).setUv(u, v).setLight(FULL_BRIGHT);
	}

	/** A solid colour rect in screen fractions ({@code fx0..fx1} from the viewer's left, {@code fy0..fy1} from the top). */
	private static void fill(
		final SubmitNodeCollector collector,
		final PoseStack poseStack,
		final float[] r,
		final float fx0,
		final float fy0,
		final float fx1,
		final float fy1,
		final float z,
		final int argb
	) {
		float w = r[2] - r[0];
		float h = r[3] - r[1];
		// Viewer's left edge is r[2] (larger x); top edge is r[3].
		float left = r[2] - fx0 * w;
		float right = r[2] - fx1 * w;
		float top = r[3] - fy0 * h;
		float bottom = r[3] - fy1 * h;
		quad(collector, poseStack, MonitorTextures.white(), right, bottom, left, top, z, argb, 0, 0, 1, 1);
	}

	private void statusScreen(final SubmitNodeCollector collector, final PoseStack poseStack, final PcStatusText.Screen screen, final float[] r) {
		float z = MonitorGeometry.SCREEN_Z;
		float dz = MonitorGeometry.OVERLAY_DZ;
		fill(collector, poseStack, r, 0, 0, 1, 1, z, screen.background());
		fill(collector, poseStack, r, 0, 0, 1, 0.03F, z - dz, screen.accent());
		this.text(collector, poseStack, r, Component.literal(screen.title()), 0.30F, 1.5F / 16F, z - 2 * dz, 0xFFFFFFFF);
		if (screen.detail() != null) {
			this.text(collector, poseStack, r, Component.literal(screen.detail()), 0.55F, 1.0F / 16F, z - 2 * dz, 0xFFCBD5E1);
		}
		if (screen.progress() >= 0) {
			float p = (float) Math.max(0, Math.min(1, screen.progress()));
			fill(collector, poseStack, r, 0.15F, 0.75F, 0.85F, 0.80F, z - dz, 0xFF334155);
			fill(collector, poseStack, r, 0.15F, 0.75F, 0.15F + 0.70F * p, 0.80F, z - 2 * dz, screen.accent());
		}
	}

	private void banner(final SubmitNodeCollector collector, final PoseStack poseStack, final String banner, final float[] r) {
		float z = MonitorGeometry.SCREEN_Z - 3 * MonitorGeometry.OVERLAY_DZ;
		fill(collector, poseStack, r, 0, 0.82F, 1, 1, z, 0xE0111827);
		this.text(collector, poseStack, r, Component.literal(banner), 0.85F, 1.1F / 16F, z - MonitorGeometry.OVERLAY_DZ, 0xFFFDE68A);
	}

	private void cursor(final SubmitNodeCollector collector, final PoseStack poseStack, final State state, final float[] r) {
		float fx = (state.cursorX + 0.5F) / state.guestW;
		float fy = (state.cursorY + 0.5F) / state.guestH;
		float size = 0.012F;
		float aspect = (r[2] - r[0]) / (r[3] - r[1]);
		float z = MonitorGeometry.SCREEN_Z - MonitorGeometry.OVERLAY_DZ;
		fill(collector, poseStack, r, fx - size, fy - size * aspect, fx + size, fy + size * aspect, z, 0xFF000000);
		fill(collector, poseStack, r, fx - size / 2, fy - size * aspect / 2, fx + size / 2, fy + size * aspect / 2, z - MonitorGeometry.OVERLAY_DZ, 0xFFFFFFFF);
	}

	/** One centred line of text, {@code lineHeight} blocks tall, its top at {@code fy} of the screen height. */
	private void text(
		final SubmitNodeCollector collector,
		final PoseStack poseStack,
		final float[] r,
		final Component text,
		final float fy,
		final float lineHeight,
		final float z,
		final int color
	) {
		float s = lineHeight / this.font.lineHeight;
		float maxWidth = (r[2] - r[0]) * 0.92F / s;
		FormattedCharSequence line = this.font.width(text) > maxWidth ? this.font.split(text, (int) maxWidth).getFirst() : text.getVisualOrderText();
		float cx = (r[0] + r[2]) / 2;
		float top = r[3] - fy * (r[3] - r[1]);
		poseStack.pushPose();
		poseStack.translate(cx, top, z);
		poseStack.rotateDegrees(Axis.YP, 180.0F);
		poseStack.scale(s, -s, s);
		collector.submitText(poseStack, -this.font.width(line) / 2.0F, 0, line, false, Font.DisplayMode.POLYGON_OFFSET, FULL_BRIGHT, color, 0, 0);
		poseStack.popPose();
	}
}
