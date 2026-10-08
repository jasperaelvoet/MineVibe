package dev.minevibe.org.meeting;

import dev.minevibe.org.OrgContent;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Keeps a meeting table's chairs linked (see {@link MeetingTables}). It stores nothing: which chairs belong to a
 * table follows from the blocks around it, so a world edit, an explosion or a reload can never leave stale links.
 */
public final class MeetingTableBlockEntity extends BlockEntity {
	/** Relink once a second, spread over ticks by position so many tables do not all work on the same tick. */
	static final int RELINK_INTERVAL = 20;

	public MeetingTableBlockEntity(final BlockPos pos, final BlockState state) {
		super(OrgContent.MEETING_TABLE_BLOCK_ENTITY, pos, state);
	}

	void serverTick(final ServerLevel level) {
		long phase = Math.floorMod(this.worldPosition.asLong(), RELINK_INTERVAL);
		if (level.getGameTime() % RELINK_INTERVAL == phase && MeetingTables.isPrimary(level, this.worldPosition)) {
			MeetingTables.relink(level, this.worldPosition);
		}
	}
}
