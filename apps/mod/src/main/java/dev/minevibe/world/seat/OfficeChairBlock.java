package dev.minevibe.world.seat;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.StateDefinition;
import net.minecraft.world.level.block.state.properties.EnumProperty;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * {@code minevibe:office_chair}. Using it spawns (or reuses) an invisible {@link SeatEntity} and rides it
 * with a non-forced {@code startRiding}, so a second sitter is rejected by
 * {@link SeatEntity#canAddPassenger}.
 */
public final class OfficeChairBlock extends Block {
	public static final EnumProperty<Direction> FACING = HorizontalDirectionalBlock.FACING;
	public static final EnumProperty<SeatKind> KIND = EnumProperty.create("kind", SeatKind.class);

	private static final VoxelShape SHAPE = Shapes.or(Block.box(2.0, 0.0, 2.0, 14.0, 8.0, 14.0), Block.box(3.0, 8.0, 3.0, 13.0, 9.0, 13.0));

	public OfficeChairBlock(final BlockBehaviour.Properties properties) {
		super(properties);
		this.registerDefaultState(this.stateDefinition.any().setValue(FACING, Direction.NORTH).setValue(KIND, SeatKind.PC));
	}

	@Override
	protected void createBlockStateDefinition(final StateDefinition.Builder<Block, BlockState> builder) {
		builder.add(FACING, KIND);
	}

	@Override
	public @Nullable BlockState getStateForPlacement(final BlockPlaceContext context) {
		return this.defaultBlockState().setValue(FACING, context.getHorizontalDirection().getOpposite());
	}

	@Override
	protected BlockState rotate(final BlockState state, final Rotation rotation) {
		return state.setValue(FACING, rotation.rotate(state.getValue(FACING)));
	}

	@Override
	protected BlockState mirror(final BlockState state, final Mirror mirror) {
		return state.rotate(mirror.getRotation(state.getValue(FACING)));
	}

	@Override
	protected VoxelShape getShape(final BlockState state, final BlockGetter level, final BlockPos pos, final CollisionContext context) {
		return SHAPE;
	}

	@Override
	protected InteractionResult useWithoutItem(final BlockState state, final Level level, final BlockPos pos, final Player player, final BlockHitResult hitResult) {
		if (level instanceof ServerLevel serverLevel) {
			trySit(serverLevel, pos, player);
		}
		return InteractionResult.SUCCESS;
	}

	/** The live seat entity of the chair at {@code pos}, if any. */
	public static @Nullable SeatEntity seatAt(final ServerLevel level, final BlockPos pos) {
		List<SeatEntity> seats = level.getEntitiesOfClass(SeatEntity.class, new AABB(pos).inflate(0.5), s -> pos.equals(s.chairPos()) && !s.isRemoved());
		return seats.isEmpty() ? null : seats.getFirst();
	}

	/**
	 * Sits {@code entity} on the chair at {@code pos} with a non-forced {@code startRiding}. Returns false
	 * when the chair is missing or already occupied.
	 */
	public static boolean trySit(final ServerLevel level, final BlockPos pos, final Entity entity) {
		BlockState state = level.getBlockState(pos);
		if (!(state.getBlock() instanceof OfficeChairBlock)) {
			return false;
		}
		SeatEntity seat = seatAt(level, pos);
		if (seat != null && entity.getVehicle() == seat) {
			return true;
		}
		boolean fresh = false;
		if (seat == null) {
			seat = SeatEntity.create(level, pos, state.getValue(KIND));
			seat.setYRot(state.getValue(FACING).toYRot());
			level.addFreshEntity(seat);
			fresh = true;
		}
		boolean seated = entity.startRiding(seat);
		if (seated) {
			float yaw = state.getValue(FACING).toYRot();
			entity.setYRot(yaw);
			entity.setYHeadRot(yaw);
		} else if (fresh) {
			seat.discard();
		}
		return seated;
	}
}
