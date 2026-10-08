package dev.minevibe.org.meeting;

import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Meeting seats for other code (PLAN §6.3, §6.6): skills seating agents for a meeting ({@code agent.seat{meeting}}),
 * and PC code that must leave meeting chairs alone.
 *
 * <ul>
 *   <li>A meeting chair is an {@code office_chair} with {@code kind=meeting}. Its seat entity has
 *       {@link dev.minevibe.world.seat.SeatKind#MEETING}: sitting there never opens PcControlScreen, never swaps the
 *       model and never counts toward the seated-at-a-PC cap.</li>
 *   <li>Single occupancy comes from the seat entity itself ({@link SeatEntity} accepts one passenger).</li>
 * </ul>
 * Server thread only.
 */
public final class MeetingSeats {
	/** How far {@link #findFreeChair} looks for a table. */
	public static final int SEARCH_RADIUS = 96;

	private MeetingSeats() {
	}

	/** True for an {@code office_chair} that a meeting table has linked. */
	public static boolean isMeetingChair(final BlockState state) {
		return MeetingTables.isMeetingChair(state);
	}

	/** True when someone sits on the chair at {@code chair}. */
	public static boolean isOccupied(final ServerLevel level, final BlockPos chair) {
		SeatEntity seat = OfficeChairBlock.seatAt(level, chair);
		return seat != null && !seat.getPassengers().isEmpty();
	}

	/** The linked chairs of the table at {@code tablePos} nobody sits on, in link order. */
	public static List<BlockPos> freeChairs(final ServerLevel level, final BlockPos tablePos) {
		List<BlockPos> free = new ArrayList<>();
		for (BlockPos chair : MeetingTables.chairsOf(level, tablePos)) {
			if (!isOccupied(level, chair)) {
				free.add(chair);
			}
		}
		return free;
	}

	/** The nearest loaded meeting table (its primary block) within {@link #SEARCH_RADIUS} of {@code near}, or null. */
	public static @Nullable BlockPos nearestTable(final ServerLevel level, final BlockPos near) {
		List<BlockPos> tables = MeetingTables.tablesNear(level, near, SEARCH_RADIUS);
		return tables.isEmpty() ? null : tables.getFirst();
	}

	/**
	 * A free meeting chair at the nearest table that has one, or null when every loaded table within
	 * {@link #SEARCH_RADIUS} is full (the mod answers {@code agent.seat} with {@code NO_SEAT} then).
	 */
	public static @Nullable BlockPos findFreeChair(final ServerLevel level, final BlockPos near) {
		for (BlockPos table : MeetingTables.tablesNear(level, near, SEARCH_RADIUS)) {
			List<BlockPos> free = freeChairs(level, table);
			if (!free.isEmpty()) {
				return free.getFirst();
			}
		}
		return null;
	}
}
