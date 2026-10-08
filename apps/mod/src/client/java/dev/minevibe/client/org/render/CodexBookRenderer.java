package dev.minevibe.client.org.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import dev.minevibe.org.codex.CodexBlock;
import dev.minevibe.org.codex.CodexBlockEntity;
import dev.minevibe.org.codex.CodexPart;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.model.object.book.BookModel;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderer;
import net.minecraft.client.renderer.blockentity.BlockEntityRendererProvider;
import net.minecraft.client.renderer.blockentity.EnchantTableRenderer;
import net.minecraft.client.renderer.blockentity.state.BlockEntityRenderState;
import net.minecraft.client.renderer.feature.ModelFeatureRenderer;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.client.resources.model.sprite.SpriteGetter;
import net.minecraft.core.Direction;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The open book of a codex (PLAN §7.5): vanilla's book model lying on the codex's book rest, between its two columns,
 * turned to the reader like a lectern's, its pages turning slowly on the level's game time.
 */
public final class CodexBookRenderer implements BlockEntityRenderer<CodexBlockEntity, CodexBookRenderer.State> {
	/** Ticks for one page to turn. */
	private static final float TICKS_PER_FLIP = 160.0F;

	public static final class State extends BlockEntityRenderState {
		public Direction facing = Direction.NORTH;
		public float time;
	}

	private final SpriteGetter sprites;
	private final BookModel bookModel;

	public CodexBookRenderer(final BlockEntityRendererProvider.Context context) {
		this.sprites = context.sprites();
		this.bookModel = new BookModel(context.bakeLayer(ModelLayers.BOOK));
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public void extractRenderState(
		final CodexBlockEntity blockEntity,
		final State state,
		final float partialTicks,
		final Vec3 cameraPosition,
		final ModelFeatureRenderer.@Nullable CrumblingOverlay breakProgress
	) {
		BlockEntityRenderer.super.extractRenderState(blockEntity, state, partialTicks, cameraPosition, breakProgress);
		state.facing = blockEntity.getBlockState().getValue(CodexBlock.FACING);
		long gameTime = blockEntity.getLevel() == null ? 0 : blockEntity.getLevel().getGameTime();
		state.time = (gameTime % 240_000L) + partialTicks;
	}

	@Override
	public void submit(final State state, final PoseStack poseStack, final SubmitNodeCollector submitNodeCollector, final CameraRenderState camera) {
		Direction right = CodexPart.right(state.facing);
		poseStack.pushPose();
		// The rest is 4 px tall and straddles the edge shared with the right column.
		poseStack.translate(0.5F + right.getStepX() * 0.5F, 0.375F, 0.5F + right.getStepZ() * 0.5F);
		poseStack.rotateDegrees(Axis.YP, -state.facing.getClockWise().toYRot());
		poseStack.rotateDegrees(Axis.ZP, 67.5F);
		poseStack.translate(0.0F, -0.125F, 0.0F);
		float flip = state.time / TICKS_PER_FLIP;
		float page1 = Mth.clamp(Mth.frac(flip + 0.25F) * 1.6F - 0.3F, 0.0F, 1.0F);
		float page2 = Mth.clamp(Mth.frac(flip + 0.75F) * 1.6F - 0.3F, 0.0F, 1.0F);
		BookModel.State book = BookModel.State.forAnimation(state.time, page1, page2, 1.2F);
		submitNodeCollector.submitModel(this.bookModel, book, poseStack, state.lightCoords, OverlayTexture.NO_OVERLAY, -1, EnchantTableRenderer.BOOK_TEXTURE,
			this.sprites, 0);
		poseStack.popPose();
	}
}
