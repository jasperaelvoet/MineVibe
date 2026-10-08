package dev.minevibe.pc;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.org.office.OfficeBuilder;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.GlobalPos;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The starter office's workstation (PLAN 7.5 "First PC"): OfficeBuilder hands its first workstation slot to this
 * placer, which puts down a desk bound to {@code linux-1} (the PC Node creates on first run), and it clears desks in
 * the office's footprint with {@link PcWorkstation#removeQuietly} (no item drop, no {@code unplug}). Installed by
 * {@link PcModInit}.
 */
public final class OfficeWorkstation implements OfficeBuilder.WorkstationPlacer {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");

	/** The first PC (PLAN 7.5): Node creates it on first run; every new world's office shows it. */
	public static final String FIRST_PC_ID = "linux-1";
	public static final String FIRST_PC_TYPE = "linux";

	@Override
	public @Nullable String place(final ServerLevel level, final BlockPos origin, final Direction facing) {
		if (!PcWorkstation.canPlace(level, origin, facing)) {
			LOG.warn("The office's workstation slot at {} is not free; no desk for {}", origin.toShortString(), FIRST_PC_ID);
			return null;
		}
		GlobalPos elsewhere = PcRegistry.deskOf(FIRST_PC_ID);
		if (elsewhere != null) {
			// One desk per PC: the player has placed linux-1's workstation somewhere else in this world.
			LOG.info("{} already has a desk at {}; the office slot stays empty", FIRST_PC_ID, elsewhere);
			return null;
		}
		Pc.PcInfo info = PcStates.get(FIRST_PC_ID);
		String type = info != null ? info.type() : FIRST_PC_TYPE;
		PcBlockEntity be = PcWorkstation.place(level, origin, facing, type, FIRST_PC_ID);
		if (be == null) {
			return null;
		}
		if (info != null && !info.plugged()) {
			// Its desk was broken in an earlier world (unplugged): this desk plugs it back in, as a bound item would.
			be.requestPlug(level);
		}
		LOG.info("Placed {}'s workstation in the office at {}", FIRST_PC_ID, origin.toShortString());
		return FIRST_PC_ID;
	}

	@Override
	public boolean removeQuietly(final ServerLevel level, final BlockPos pos) {
		return PcWorkstation.removeQuietly(level, pos);
	}
}
