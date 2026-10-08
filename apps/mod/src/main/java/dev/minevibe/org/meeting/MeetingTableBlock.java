package dev.minevibe.org.meeting;

import dev.minevibe.org.OrgContent;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityTicker;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * {@code minevibe:meeting_table} (PLAN §6.6, §7.5). Table blocks that touch side by side form one table. A table
 * links up to {@value MeetingTables#MAX_CHAIRS} {@code office_chair}s standing next to it and turns them into
 * {@code meeting} seats: no model swap, never a PC seat, never PcControlScreen. Breaking the table turns its chairs back into plain PC-kind chairs. Using the table
 * tells the player how many chairs it has.
 */
public final class MeetingTableBlock extends Block implements EntityBlock {
	private static final VoxelShape SHAPE = Shapes.or(Block.box(0.0, 13.0, 0.0, 16.0, 16.0, 16.0), Block.box(6.0, 0.0, 6.0, 10.0, 13.0, 10.0));

	public MeetingTableBlock(final BlockBehaviour.Properties properties) {
		super(properties);
	}

	@Override
	protected VoxelShape getShape(final BlockState state, final BlockGetter level, final BlockPos pos, final CollisionContext context) {
		return SHAPE;
	}

	@Override
	public BlockEntity newBlockEntity(final BlockPos pos, final BlockState state) {
		return new MeetingTableBlockEntity(pos, state);
	}

	@Override
	@SuppressWarnings("unchecked")
	public <T extends BlockEntity> @Nullable BlockEntityTicker<T> getTicker(final Level level, final BlockState state, final BlockEntityType<T> type) {
		if (level.isClientSide() || type != OrgContent.MEETING_TABLE_BLOCK_ENTITY) {
			return null;
		}
		return (BlockEntityTicker<T>)(BlockEntityTicker<MeetingTableBlockEntity>)(tickLevel, pos, tickState, table) -> table.serverTick((ServerLevel)tickLevel);
	}

	@Override
	protected void affectNeighborsAfterRemoval(final BlockState state, final ServerLevel level, final BlockPos pos, final boolean movedByPiston) {
		super.affectNeighborsAfterRemoval(state, level, pos, movedByPiston);
		MeetingTables.onTableRemoved(level, pos);
	}

	@Override
	protected InteractionResult useWithoutItem(final BlockState state, final Level level, final BlockPos pos, final Player player, final BlockHitResult hitResult) {
		if (level instanceof ServerLevel serverLevel) {
			MeetingTables.relink(serverLevel, pos);
			int chairs = MeetingTables.chairsOf(serverLevel, pos).size();
			player.sendOverlayMessage(Component.literal(chairs == 0
				? "Meeting table: place office chairs next to it (up to " + MeetingTables.MAX_CHAIRS + ")"
				: "Meeting table: " + chairs + "/" + MeetingTables.MAX_CHAIRS + " chairs"));
		}
		return InteractionResult.SUCCESS;
	}
}
