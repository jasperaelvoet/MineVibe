package dev.minevibe.agent.skill.seat;

import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * Meeting chairs for {@code agent.seat{target: {kind: meeting}}} (PLAN 6.6). The meeting table (track T6) implements this
 * and installs it with {@link Seats#installMeetingSeats}: it hands each attendee a free chair linked to the table.
 * Without an implementation every meeting seat request fails with {@code NO_SEAT}.
 */
@FunctionalInterface
public interface MeetingSeats {
	/** A free chair for {@code agentId} at the meeting {@code meetingId}, or null when there is none. */
	PcRegistry.@Nullable Chair chairFor(MinecraftServer server, String meetingId, String agentId);
}
