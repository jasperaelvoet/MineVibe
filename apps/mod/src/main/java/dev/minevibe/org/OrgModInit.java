package dev.minevibe.org;

import dev.minevibe.org.codex.Codexes;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.MvWorldContent;
import net.fabricmc.api.ModInitializer;

/**
 * Common entrypoint for the org tools in the world (PLAN §6.6, §7.5): Codex, calendars, meeting tables and the
 * starter office. Separate from the other entrypoints so this track can land on its own; listed under {@code main}
 * in {@code fabric.mod.json}. The client side lives in {@code dev.minevibe.client.org.OrgClientInit}.
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
	}
}
