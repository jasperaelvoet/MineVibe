package dev.minevibe.pc;

import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatKind;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import org.jspecify.annotations.Nullable;

/**
 * Places a workstation: the four {@code pc_desk} blocks and an {@code office_chair} (kind {@code pc}) in front of the
 * main column, facing the desk (PLAN 7.5). Used by the workstation items and by OfficeBuilder (which binds the desk
 * to an existing PC directly).
 */
public final class PcWorkstation {
	private PcWorkstation() {}

	/** The five positions a workstation at {@code origin} occupies: four desk blocks, then the chair. */
	public static List<BlockPos> footprint(final BlockPos origin, final Direction facing) {
		Direction side = PcDeskBlock.sideDirection(facing);
		return List.of(origin, origin.relative(side), origin.above(), origin.relative(side).above(), PcDeskBlock.chairPos(origin, facing));
	}

	/** Every footprint block is replaceable (air, plants, fluids) and inside the build height. */
	public static boolean canPlace(final Level level, final BlockPos origin, final Direction facing) {
		for (BlockPos pos : footprint(origin, facing)) {
			if (level.isOutsideBuildHeight(pos) || !level.getBlockState(pos).canBeReplaced()) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Places the desk and chair (no checks: call {@link #canPlace} first) and returns the desk's block entity, bound to
	 * {@code pcId} when one is given. Sends nothing to Node: the caller creates or plugs the PC.
	 *
	 * @param facing where the screen faces (the chair is on that side)
	 * @param type the PC type ({@code linux}, {@code linux-slim}, {@code macos})
	 */
	public static @Nullable PcBlockEntity place(
		final ServerLevel level, final BlockPos origin, final Direction facing, final String type, final @Nullable String pcId
	) {
		PcDeskBlock desk = (PcDeskBlock) PcContent.PC_DESK;
		Direction side = PcDeskBlock.sideDirection(facing);
		PcLed led = PcLed.OFF;
		// Upper blocks first, then lower: every part's partners exist before shape updates reach it.
		level.setBlock(origin.above(), desk.partState(facing, PcDeskPart.MAIN, DoubleBlockHalf.UPPER, led), Block.UPDATE_CLIENTS);
		level.setBlock(origin.relative(side).above(), desk.partState(facing, PcDeskPart.SIDE, DoubleBlockHalf.UPPER, led), Block.UPDATE_CLIENTS);
		level.setBlock(origin.relative(side), desk.partState(facing, PcDeskPart.SIDE, DoubleBlockHalf.LOWER, led), Block.UPDATE_CLIENTS);
		level.setBlock(origin, desk.partState(facing, PcDeskPart.MAIN, DoubleBlockHalf.LOWER, led), Block.UPDATE_CLIENTS);
		BlockPos chair = PcDeskBlock.chairPos(origin, facing);
		BlockState chairState = MvWorldContent.OFFICE_CHAIR.defaultBlockState()
			.setValue(OfficeChairBlock.FACING, facing.getOpposite())
			.setValue(OfficeChairBlock.KIND, SeatKind.PC);
		level.setBlock(chair, chairState, Block.UPDATE_ALL);
		// Neighbours learn about the finished desk in one go (no partner is missing any more).
		for (BlockPos pos : footprint(origin, facing).subList(0, 4)) {
			level.updateNeighborsAt(pos, desk);
		}
		if (!(level.getBlockEntity(origin.above()) instanceof PcBlockEntity be)) {
			return null;
		}
		be.setup(type, chair, pcId);
		if (pcId != null) {
			be.bind(pcId);
		}
		return be;
	}
}
