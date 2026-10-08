package dev.minevibe.org.codex;

import dev.minevibe.org.OrgContent;
import dev.minevibe.org.OrgScreens;
import java.util.EnumMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.RandomSource;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.ScheduledTickAccess;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.properties.EnumProperty;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * {@code minevibe:codex} (PLAN §7.5): a 2-wide, 3-high library with an open book, the world's door into the shared
 * Codex. Every placed codex opens the same Codex (CodexScreen on the client).
 *
 * <ul>
 *   <li><b>Placing</b> needs all six cells free: the clicked cell is the bottom-left (anchor) part, the multiblock
 *       grows to the player's right and two blocks up.</li>
 *   <li><b>Breaking</b> any part removes the whole multiblock (each part turns to air when a partner goes missing,
 *       like doors and beds). Only the anchor's loot table drops the item, so it drops exactly once; in creative,
 *       the anchor is removed silently first.</li>
 *   <li>Pistons cannot move it.</li>
 * </ul>
 */
public final class CodexBlock extends Block implements EntityBlock {
	public static final EnumProperty<Direction> FACING = HorizontalDirectionalBlock.FACING;
	public static final EnumProperty<CodexPart> PART = EnumProperty.create("part", CodexPart.class);

	/** Middle row seen with its front to the north: the back panel full of books, and the outer post. */
	private static final VoxelShape MIDDLE_LEFT_NORTH = Shapes.or(Block.box(0.0, 0.0, 13.0, 16.0, 16.0, 16.0), Block.box(14.0, 0.0, 0.0, 16.0, 16.0, 13.0));
	private static final VoxelShape MIDDLE_RIGHT_NORTH = Shapes.or(Block.box(0.0, 0.0, 13.0, 16.0, 16.0, 16.0), Block.box(0.0, 0.0, 0.0, 2.0, 16.0, 13.0));
	private static final Map<Direction, VoxelShape> MIDDLE_LEFT = Shapes.rotateHorizontal(MIDDLE_LEFT_NORTH);
	private static final Map<Direction, VoxelShape> MIDDLE_RIGHT = Shapes.rotateHorizontal(MIDDLE_RIGHT_NORTH);
	private static final Map<CodexPart, Map<Direction, VoxelShape>> SHAPES = new EnumMap<>(CodexPart.class);

	static {
		SHAPES.put(CodexPart.MIDDLE_LEFT, MIDDLE_LEFT);
		SHAPES.put(CodexPart.MIDDLE_RIGHT, MIDDLE_RIGHT);
	}

	public CodexBlock(final BlockBehaviour.Properties properties) {
		super(properties);
		this.registerDefaultState(this.stateDefinition.any().setValue(FACING, Direction.NORTH).setValue(PART, CodexPart.ANCHOR));
	}

	@Override
	protected void createBlockStateDefinition(final StateDefinition.Builder<Block, BlockState> builder) {
		builder.add(FACING, PART);
	}

	@Override
	protected VoxelShape getShape(final BlockState state, final BlockGetter level, final BlockPos pos, final CollisionContext context) {
		Map<Direction, VoxelShape> byFacing = SHAPES.get(state.getValue(PART));
		return byFacing == null ? Shapes.block() : byFacing.get(state.getValue(FACING));
	}

	// ------------------------------------------------------------------ placing

	@Override
	public @Nullable BlockState getStateForPlacement(final BlockPlaceContext context) {
		Direction facing = context.getHorizontalDirection().getOpposite();
		BlockPos anchor = context.getClickedPos();
		Level level = context.getLevel();
		for (CodexPart part : CodexPart.values()) {
			if (part == CodexPart.ANCHOR) {
				continue;
			}
			BlockPos pos = anchor.offset(part.offset(facing));
			if (!level.isInsideBuildHeight(pos) || !level.getWorldBorder().isWithinBounds(pos)) {
				return null;
			}
			BlockState there = level.getBlockState(pos);
			BlockState partState = this.defaultBlockState().setValue(FACING, facing).setValue(PART, part);
			if (!there.canBeReplaced(context) || !level.isUnobstructed(partState, pos, CollisionContext.placementContext(context.getPlayer()))) {
				return null;
			}
		}
		return this.defaultBlockState().setValue(FACING, facing).setValue(PART, CodexPart.ANCHOR);
	}

	@Override
	public void setPlacedBy(final Level level, final BlockPos pos, final BlockState state, final @Nullable LivingEntity by, final ItemStack itemStack) {
		if (!level.isClientSide()) {
			placeRest(level, pos, state.getValue(FACING), Block.UPDATE_ALL);
		}
	}

	/**
	 * Places a whole codex with its anchor (bottom-left part) at {@code anchor}, its front facing {@code facing}.
	 * Returns false (and places nothing) when any of the six cells is not replaceable. Used by OfficeBuilder and tests.
	 */
	public static boolean placeAt(final Level level, final BlockPos anchor, final Direction facing, final @Block.UpdateFlags int flags) {
		for (CodexPart part : CodexPart.values()) {
			BlockPos pos = anchor.offset(part.offset(facing));
			if (!level.isInsideBuildHeight(pos) || !level.getBlockState(pos).canBeReplaced()) {
				return false;
			}
		}
		level.setBlock(anchor, OrgContent.CODEX.defaultBlockState().setValue(FACING, facing).setValue(PART, CodexPart.ANCHOR), flags);
		placeRest(level, anchor, facing, flags);
		return true;
	}

	/**
	 * Places every part but the anchor, row by row: each new part only triggers shape updates on parts already in
	 * place, which see their expected partner and stay.
	 */
	private static void placeRest(final Level level, final BlockPos anchor, final Direction facing, final @Block.UpdateFlags int flags) {
		BlockState anchorState = level.getBlockState(anchor);
		if (!(anchorState.getBlock() instanceof CodexBlock)) {
			return;
		}
		for (CodexPart part : CodexPart.values()) {
			if (part != CodexPart.ANCHOR) {
				level.setBlock(anchor.offset(part.offset(facing)), anchorState.setValue(FACING, facing).setValue(PART, part), flags);
			}
		}
	}

	/** The anchor position of the codex the part at {@code pos} belongs to. */
	public static BlockPos anchorOf(final BlockPos pos, final BlockState state) {
		return state.getValue(PART).anchorFrom(pos, state.getValue(FACING));
	}

	/** True when all six parts of the codex whose part sits at {@code pos} are in place. */
	public static boolean isComplete(final BlockGetter level, final BlockPos pos) {
		BlockState state = level.getBlockState(pos);
		if (!(state.getBlock() instanceof CodexBlock)) {
			return false;
		}
		Direction facing = state.getValue(FACING);
		BlockPos anchor = anchorOf(pos, state);
		for (CodexPart part : CodexPart.values()) {
			BlockState there = level.getBlockState(anchor.offset(part.offset(facing)));
			if (!(there.getBlock() instanceof CodexBlock) || there.getValue(FACING) != facing || there.getValue(PART) != part) {
				return false;
			}
		}
		return true;
	}

	// ------------------------------------------------------------------ staying whole

	@Override
	protected BlockState updateShape(
		final BlockState state,
		final LevelReader level,
		final ScheduledTickAccess ticks,
		final BlockPos pos,
		final Direction directionToNeighbour,
		final BlockPos neighbourPos,
		final BlockState neighbourState,
		final RandomSource random
	) {
		Direction facing = state.getValue(FACING);
		CodexPart expected = state.getValue(PART).expectedNeighbour(directionToNeighbour, facing);
		if (expected != null
			&& !(neighbourState.getBlock() instanceof CodexBlock && neighbourState.getValue(FACING) == facing && neighbourState.getValue(PART) == expected)) {
			return Blocks.AIR.defaultBlockState();
		}
		return super.updateShape(state, level, ticks, pos, directionToNeighbour, neighbourPos, neighbourState, random);
	}

	@Override
	public BlockState playerWillDestroy(final Level level, final BlockPos pos, final BlockState state, final Player player) {
		if (!level.isClientSide() && (player.preventsBlockDrops() || !player.hasCorrectToolForDrops(state)) && state.getValue(PART) != CodexPart.ANCHOR) {
			// Remove the anchor (the only part that drops the item) silently, as doors do with their lower half.
			BlockPos anchor = anchorOf(pos, state);
			BlockState anchorState = level.getBlockState(anchor);
			if (anchorState.is(this) && anchorState.getValue(PART) == CodexPart.ANCHOR) {
				level.setBlock(anchor, Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL | Block.UPDATE_SUPPRESS_DROPS);
				level.levelEvent(player, 2001, anchor, Block.getId(anchorState));
			}
		}
		return super.playerWillDestroy(level, pos, state, player);
	}

	@Override
	protected BlockState rotate(final BlockState state, final Rotation rotation) {
		return state.setValue(FACING, rotation.rotate(state.getValue(FACING)));
	}

	@Override
	protected BlockState mirror(final BlockState state, final Mirror mirror) {
		// Any mirror swaps what is left and right of the front.
		return mirror == Mirror.NONE ? state : state.setValue(FACING, mirror.mirror(state.getValue(FACING))).setValue(PART, state.getValue(PART).mirrored());
	}

	// ------------------------------------------------------------------ using

	@Override
	protected InteractionResult useWithoutItem(final BlockState state, final Level level, final BlockPos pos, final Player player, final BlockHitResult hitResult) {
		if (level.isClientSide()) {
			OrgScreens.openCodex(anchorOf(pos, state));
		}
		return InteractionResult.SUCCESS;
	}

	@Override
	public @Nullable BlockEntity newBlockEntity(final BlockPos pos, final BlockState state) {
		return state.getValue(PART) == CodexPart.BOOK ? new CodexBlockEntity(pos, state) : null;
	}
}
