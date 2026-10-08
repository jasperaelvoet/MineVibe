package dev.minevibe.pc;

import java.util.EnumMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.RandomSource;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.ScheduledTickAccess;
import net.minecraft.world.level.block.BaseEntityBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.block.state.properties.EnumProperty;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * {@code minevibe:pc_desk} (PLAN 7.5): a 2-wide desk with a monitor on it, four blocks of one type.
 *
 * <pre>
 *   upper:  [MAIN monitor + BE] [SIDE monitor]      the screen spans both, the LED sits on MAIN
 *   lower:  [MAIN desk        ] [SIDE desk   ]      SIDE = MAIN.relative(facing.getClockWise())
 *                 chair                             at MAIN.relative(facing), facing the desk
 * </pre>
 *
 * {@code facing} is where the desk's front (the screen) points. Breaking any part removes the others (the shape
 * update of a missing partner turns a part into air, like a door). Drops never come from loot tables: the
 * {@link PcBlockEntity} drops the workstation item, bound to its PC, when the monitor block goes away. Sneak-using
 * any part opens the PcConfigScreen; using the monitor opens Watch mode.
 */
public final class PcDeskBlock extends BaseEntityBlock {
	public static final EnumProperty<Direction> FACING = HorizontalDirectionalBlock.FACING;
	public static final EnumProperty<PcDeskPart> PART = EnumProperty.create("part", PcDeskPart.class);
	public static final EnumProperty<DoubleBlockHalf> HALF = BlockStateProperties.DOUBLE_BLOCK_HALF;
	public static final EnumProperty<PcLed> LED = EnumProperty.create("led", PcLed.class);

	/** Shapes in the north-facing frame (pixels), rotated per facing at class load. */
	private static final Map<Direction, VoxelShape> MAIN_LOWER = rotations(
		Shapes.or(px(0, 13, 0, 16, 16, 16), px(1, 0, 1, 3, 13, 3), px(1, 0, 13, 3, 13, 15), px(9, 0, 3, 15, 12, 15))
	);
	private static final Map<Direction, VoxelShape> SIDE_LOWER = rotations(
		Shapes.or(px(0, 13, 0, 16, 16, 16), px(13, 0, 1, 15, 13, 3), px(13, 0, 13, 15, 13, 15))
	);
	private static final Map<Direction, VoxelShape> MAIN_UPPER = rotations(Shapes.or(px(4, 1, 10, 16, 16, 12), px(8, 0, 10, 16, 1, 14)));
	private static final Map<Direction, VoxelShape> SIDE_UPPER = rotations(Shapes.or(px(0, 1, 10, 12, 16, 12), px(0, 0, 10, 8, 1, 14)));

	public PcDeskBlock(final BlockBehaviour.Properties properties) {
		super(properties);
		this.registerDefaultState(
			this.stateDefinition.any()
				.setValue(FACING, Direction.NORTH)
				.setValue(PART, PcDeskPart.MAIN)
				.setValue(HALF, DoubleBlockHalf.LOWER)
				.setValue(LED, PcLed.OFF)
		);
	}

	@Override
	protected void createBlockStateDefinition(final StateDefinition.Builder<Block, BlockState> builder) {
		builder.add(FACING, PART, HALF, LED);
	}

	// -----------------------------------------------------------------------------------------
	// Geometry of the four parts
	// -----------------------------------------------------------------------------------------

	/** The column of the side part, seen from the main part. */
	public static Direction sideDirection(final Direction facing) {
		return facing.getClockWise();
	}

	/** The main lower block of the desk {@code state} at {@code pos} belongs to. */
	public static BlockPos origin(final BlockPos pos, final BlockState state) {
		BlockPos p = pos;
		if (state.getValue(PART) == PcDeskPart.SIDE) {
			p = p.relative(sideDirection(state.getValue(FACING)).getOpposite());
		}
		if (state.getValue(HALF) == DoubleBlockHalf.UPPER) {
			p = p.below();
		}
		return p;
	}

	/** Where the block entity lives: the main upper block (the monitor). */
	public static BlockPos monitorPos(final BlockPos origin) {
		return origin.above();
	}

	/** The chair in front of the main column. */
	public static BlockPos chairPos(final BlockPos origin, final Direction facing) {
		return origin.relative(facing);
	}

	/** The position of {@code part}/{@code half} in the desk whose main lower block is {@code origin}. */
	public static BlockPos partPos(final BlockPos origin, final Direction facing, final PcDeskPart part, final DoubleBlockHalf half) {
		BlockPos p = part == PcDeskPart.SIDE ? origin.relative(sideDirection(facing)) : origin;
		return half == DoubleBlockHalf.UPPER ? p.above() : p;
	}

	/** The block state of one part. */
	public BlockState partState(final Direction facing, final PcDeskPart part, final DoubleBlockHalf half, final PcLed led) {
		return this.defaultBlockState().setValue(FACING, facing).setValue(PART, part).setValue(HALF, half).setValue(LED, led);
	}

	private static boolean isPartner(final BlockState self, final BlockState other, final PcDeskPart part, final DoubleBlockHalf half) {
		return other.getBlock() instanceof PcDeskBlock
			&& other.getValue(FACING) == self.getValue(FACING)
			&& other.getValue(PART) == part
			&& other.getValue(HALF) == half;
	}

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
		PcDeskPart part = state.getValue(PART);
		DoubleBlockHalf half = state.getValue(HALF);
		Direction towardsOtherColumn = part == PcDeskPart.MAIN ? sideDirection(facing) : sideDirection(facing).getOpposite();
		Direction towardsOtherHalf = half == DoubleBlockHalf.LOWER ? Direction.UP : Direction.DOWN;
		if (directionToNeighbour == towardsOtherColumn) {
			PcDeskPart other = part == PcDeskPart.MAIN ? PcDeskPart.SIDE : PcDeskPart.MAIN;
			if (!isPartner(state, neighbourState, other, half)) {
				return Blocks.AIR.defaultBlockState();
			}
		} else if (directionToNeighbour == towardsOtherHalf) {
			DoubleBlockHalf other = half == DoubleBlockHalf.LOWER ? DoubleBlockHalf.UPPER : DoubleBlockHalf.LOWER;
			if (!isPartner(state, neighbourState, part, other)) {
				return Blocks.AIR.defaultBlockState();
			}
		}
		return super.updateShape(state, level, ticks, pos, directionToNeighbour, neighbourPos, neighbourState, random);
	}

	@Override
	protected BlockState rotate(final BlockState state, final Rotation rotation) {
		return state.setValue(FACING, rotation.rotate(state.getValue(FACING)));
	}

	@Override
	protected BlockState mirror(final BlockState state, final Mirror mirror) {
		// Mirroring would swap which column is the side one; keep the desk intact and only turn it.
		return state.rotate(mirror.getRotation(state.getValue(FACING)));
	}

	// -----------------------------------------------------------------------------------------
	// Block entity, shapes, interaction
	// -----------------------------------------------------------------------------------------

	@Override
	public @Nullable BlockEntity newBlockEntity(final BlockPos pos, final BlockState state) {
		return state.getValue(PART) == PcDeskPart.MAIN && state.getValue(HALF) == DoubleBlockHalf.UPPER ? new PcBlockEntity(pos, state) : null;
	}

	/** The desk's block entity, from any of its four blocks. */
	public static @Nullable PcBlockEntity blockEntity(final BlockGetter level, final BlockPos pos, final BlockState state) {
		if (!(state.getBlock() instanceof PcDeskBlock)) {
			return null;
		}
		return level.getBlockEntity(monitorPos(origin(pos, state))) instanceof PcBlockEntity be ? be : null;
	}

	@Override
	protected VoxelShape getShape(final BlockState state, final BlockGetter level, final BlockPos pos, final CollisionContext context) {
		Direction facing = state.getValue(FACING);
		boolean main = state.getValue(PART) == PcDeskPart.MAIN;
		if (state.getValue(HALF) == DoubleBlockHalf.LOWER) {
			return (main ? MAIN_LOWER : SIDE_LOWER).get(facing);
		}
		return (main ? MAIN_UPPER : SIDE_UPPER).get(facing);
	}

	@Override
	protected InteractionResult useWithoutItem(final BlockState state, final Level level, final BlockPos pos, final Player player, final BlockHitResult hitResult) {
		PcBlockEntity be = blockEntity(level, pos, state);
		if (be == null) {
			return InteractionResult.PASS;
		}
		if (level instanceof ServerLevel serverLevel) {
			// A desk whose create failed (or never reached Node) tries again on use.
			if (be.pcId() == null && !be.isCreating()) {
				be.requestCreate(serverLevel);
			}
			return InteractionResult.SUCCESS;
		}
		String pcId = be.pcId();
		if (pcId == null) {
			return InteractionResult.SUCCESS;
		}
		if (player.isShiftKeyDown()) {
			PcClientHooks.get().openConfig(pcId);
		} else if (state.getValue(HALF) == DoubleBlockHalf.UPPER) {
			PcClientHooks.get().openWatch(pcId);
		} else {
			return InteractionResult.PASS;
		}
		return InteractionResult.SUCCESS;
	}

	@Override
	public BlockState playerWillDestroy(final Level level, final BlockPos pos, final BlockState state, final Player player) {
		if (!level.isClientSide() && player.preventsBlockDrops()) {
			// Creative: the workstation item is not dropped (it would duplicate the PC's item).
			PcBlockEntity be = blockEntity(level, pos, state);
			if (be != null) {
				be.suppressDrop();
			}
		}
		return super.playerWillDestroy(level, pos, state, player);
	}

	@Override
	protected ItemStack getCloneItemStack(final LevelReader level, final BlockPos pos, final BlockState state, final boolean includeData) {
		PcBlockEntity be = blockEntity(level, pos, state);
		return be != null ? WorkstationItem.stackFor(be.type(), includeData ? be.pcId() : null) : new ItemStack(PcContent.LINUX_WORKSTATION);
	}

	// -----------------------------------------------------------------------------------------
	// Shape helpers
	// -----------------------------------------------------------------------------------------

	private static VoxelShape px(final double x0, final double y0, final double z0, final double x1, final double y1, final double z1) {
		return Block.box(x0, y0, z0, x1, y1, z1);
	}

	private static Map<Direction, VoxelShape> rotations(final VoxelShape north) {
		Map<Direction, VoxelShape> out = new EnumMap<>(Direction.class);
		for (Direction facing : Direction.Plane.HORIZONTAL) {
			VoxelShape[] acc = {Shapes.empty()};
			north.forAllBoxes((x0, y0, z0, x1, y1, z1) -> acc[0] = Shapes.or(acc[0], rotateBox(facing, x0, y0, z0, x1, y1, z1)));
			out.put(facing, acc[0].optimize());
		}
		return out;
	}

	/** Rotates a box given in block units (north-facing frame) about the block centre to {@code facing}. */
	static VoxelShape rotateBox(final Direction facing, final double x0, final double y0, final double z0, final double x1, final double y1, final double z1) {
		return switch (facing) {
			case SOUTH -> Shapes.box(1 - x1, y0, 1 - z1, 1 - x0, y1, 1 - z0);
			case EAST -> Shapes.box(1 - z1, y0, x0, 1 - z0, y1, x1);
			case WEST -> Shapes.box(z0, y0, 1 - x1, z1, y1, 1 - x0);
			default -> Shapes.box(x0, y0, z0, x1, y1, z1);
		};
	}
}
