package dev.minevibe.org;

import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.org.codex.Codexes;
import dev.minevibe.org.meeting.MeetingSeatProvider;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.MvWorldContent;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

/**
 * Common entrypoint for the org tools in the world (PLAN §6.6, §7.5): Codex, calendars, meeting tables and the
 * starter office. Separate from the other entrypoints so this track can land on its own; listed under {@code main}
 * in {@code fabric.mod.json}. The client side lives in {@code dev.minevibe.client.org.OrgClientInit}.
 *
 * <p>The meeting tables' chairs serve the skill layer's meeting seats ({@code agent.seat{meeting}}) through
 * {@link MeetingSeatProvider}.
 */
public final class OrgModInit implements ModInitializer {
	@Override
	public void onInitialize() {
		// Meeting chairs are office chairs: make sure they exist whatever order the entrypoints run in.
		MvWorldContent.register();
		OrgContent.register();
		MeetingTables.registerEvents();
		Codexes.registerEvents();
		OfficeService.registerEvents();
		OrgCommands.register();
		MeetingSeatProvider meetingSeats = new MeetingSeatProvider();
		Seats.installMeetingSeats(meetingSeats);
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> meetingSeats.clear());
	}
}
