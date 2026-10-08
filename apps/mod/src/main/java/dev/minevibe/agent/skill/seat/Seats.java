package dev.minevibe.agent.skill.seat;

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
}
