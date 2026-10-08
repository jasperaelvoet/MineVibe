package dev.minevibe.agent.skill.seat;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Where the skill API finds the PC registry and the meeting chairs (installed by the PC and meeting-table blocks). */
public final class Seats {
	/** At most this many agents sit at PCs at once ({@code maxSeated}, PLAN 6.5). Meeting chairs never count. */
	public static final int MAX_SEATED = 2;

	private static volatile PcRegistry pcs = new SimplePcRegistry();
	private static volatile @Nullable MeetingSeats meetings;

	private Seats() {
	}

	public static PcRegistry pcs() {
		return pcs;
	}

	public static @Nullable MeetingSeats meetings() {
		return meetings;
	}

	/** Replaces the built-in {@link SimplePcRegistry} with the PC blocks' registry ({@code PcModInit} does). */
	public static void installPcRegistry(final PcRegistry registry) {
		pcs = registry;
	}

	/** Installs the meeting tables' chairs ({@code OrgModInit} does); without them meeting seats fail with NO_SEAT. */
	public static void installMeetingSeats(final @Nullable MeetingSeats seats) {
		meetings = seats;
	}

	/** The server stopped: the registry forgets that world's chairs, reservations and cooldowns. */
	public static void onServerStopped() {
		pcs.onServerStopped();
	}

	/**
	 * Puts an agent that was just kicked off the chair at {@code chair} on a free cell beside it (not on the chair, not
	 * into the desk), so the player can click the chair (PLAN 7.7.8: the kick "steps it aside"). Every kick does this:
	 * the mod's own ("Kick Bram and sit?") and Node's {@code agent.unseat{kick}} (the Kick buttons). Stays put when no
	 * cell around is free.
	 */
	public static void stepAside(final ServerLevel level, final BlockPos chair, final AgentPlayer agent) {
		List<BlockPos> spots = new ArrayList<>();
		for (Direction d : Direction.Plane.HORIZONTAL) {
			spots.add(chair.relative(d));
		}
		for (Direction d : Direction.Plane.HORIZONTAL) {
			spots.add(chair.relative(d).relative(d.getClockWise()));
		}
		for (BlockPos p : spots) {
			for (int dy = 0; dy >= -1; dy--) {
				BlockPos feet = p.above(dy);
				if (level.isLoaded(feet) && AgentNavigator.isStandable(level, feet)) {
					Vec3 to = Vec3.atBottomCenterOf(feet);
					agent.teleportTo(to.x, to.y, to.z);
					return;
				}
			}
		}
	}
}
