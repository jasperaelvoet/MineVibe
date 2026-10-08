package dev.minevibe.gametest.org;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.client.org.BridgeOrgBackend;
import dev.minevibe.client.org.FakeOrgBackend;
import dev.minevibe.client.org.OrgClient;
import dev.minevibe.client.org.OrgClientState;
import dev.minevibe.client.org.calendar.CalendarForm;
import dev.minevibe.client.org.calendar.CalendarScreen;
import dev.minevibe.client.org.codex.CodexEditLock;
import dev.minevibe.client.org.codex.CodexScreen;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficeService;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;

/**
 * Client GameTests for the org tools (PLAN §7.5, §7.8): using the handheld calendar opens CalendarScreen; the
 * calendar, the Codex and the meeting HUD render with data (from the in-memory {@link FakeOrgBackend}); the starter
 * office looks right from its spawn. Screenshots land in {@code build/run/clientGameTest/screenshots/org-*.png}.
 *
 * <p>Run with {@code ./gradlew runClientGameTest -Pminevibe.acceptMinecraftEula=true} (opens a window).
 */
public final class OrgClientGameTests implements FabricClientGameTest {
	@Override
	public void runTest(final ClientGameTestContext context) {
		context.waitForScreen(TitleScreen.class);
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			singleplayer.getConnection().waitForChunksRender();
			try {
				calendarItemOpensCalendarScreen(context, singleplayer);
				screensShowTheirData(context);
				meetingHudShowsAndChatHasEnd(context);
				officeFromItsSpawn(context, singleplayer);
			} finally {
				context.runOnClient(mc -> {
					OrgClient.useBackend(new BridgeOrgBackend());
					OrgClientState.get().clear();
				});
				context.setScreen(() -> null);
			}
		}
	}

	private static void calendarItemOpensCalendarScreen(final ClientGameTestContext context, final TestSingleplayerContext singleplayer) {
		singleplayer.getServer().runOnServer(server -> {
			ServerPlayer player = server.getPlayerList().getPlayers().getFirst();
			player.setItemInHand(InteractionHand.MAIN_HAND, new ItemStack(OrgContent.CALENDAR));
		});
		context.waitTicks(5);
		context.getInput().pressKey(options -> options.keyUse);
		context.waitForScreen(CalendarScreen.class);
		context.takeScreenshot("org-calendar-offline");
		context.setScreen(() -> null);
		System.out.println("[T6] using the calendar item opened CalendarScreen");
	}

	private static void screensShowTheirData(final ClientGameTestContext context) {
		FakeOrgBackend fake = context.computeOnClient(mc -> {
			FakeOrgBackend backend = new FakeOrgBackend(OrgClientState.get(), () -> mc.level == null ? 0 : mc.level.getOverworldClockTime(),
				System::currentTimeMillis, "Player").seed();
			OrgClient.useBackend(backend);
			return backend;
		});
		context.setScreen(CalendarScreen::new);
		context.waitTicks(3);
		context.takeScreenshot("org-calendar-day");
		String eventId = context.computeOnClient(mc -> OrgClientState.get().events().stream()
			.filter(e -> "game".equals(e.clock()) && "meeting".equals(e.kind())).findFirst().map(Org.CalendarEvent::id).orElseThrow());
		context.runOnClient(mc -> ((CalendarScreen)mc.gui.screen()).select(eventId));
		context.waitTicks(3);
		context.takeScreenshot("org-calendar-event");

		// Add an event through the form.
		context.runOnClient(mc -> ((CalendarScreen)mc.gui.screen()).newEvent());
		context.waitTicks(3);
		context.takeScreenshot("org-calendar-form");
		context.runOnClient(mc -> {
			CalendarScreen screen = (CalendarScreen)mc.gui.screen();
			CalendarForm form = screen.form();
			form.title = "Chop trees";
			form.assignees.add("bram");
			form.task = "Bring back 16 logs";
			screen.saveForm();
		});
		context.waitTicks(3);
		boolean saved = context.computeOnClient(mc -> OrgClientState.get().events().stream().anyMatch(e -> "Chop trees".equals(e.title()))
			&& mc.gui.screen() instanceof CalendarScreen screen && screen.form() == null);
		if (!saved) {
			throw new AssertionError("saving the calendar form did not add the event and close the form");
		}
		context.takeScreenshot("org-calendar-saved");
		context.runOnClient(mc -> ((CalendarScreen)mc.gui.screen()).showRealTime(true));
		context.waitTicks(2);
		context.takeScreenshot("org-calendar-real");

		// The Codex: reading, a binding rule, a new page.
		context.setScreen(CodexScreen::new);
		context.waitTicks(2);
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).select("iron-cave"));
		context.waitTicks(3);
		context.takeScreenshot("org-codex-page");
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).select("house-rules"));
		context.waitTicks(3);
		context.takeScreenshot("org-codex-rules");
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).newPage());
		context.waitTicks(3);
		context.takeScreenshot("org-codex-new");

		// The soft lock: an agent saves the page while the player edits it.
		context.setScreen(CodexScreen::new);
		context.waitTicks(2);
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).select("iron-cave"));
		context.waitTicks(3);
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).edit());
		context.waitTicks(2);
		context.runOnClient(mc -> fake.agentEdit("iron-cave", "Bram", "Iron moved to (130, 38, -90)."));
		context.waitTicks(3);
		expectEditState(context, CodexEditLock.State.STALE);
		context.takeScreenshot("org-codex-stale");
		context.runOnClient(mc -> ((CodexScreen)mc.gui.screen()).save());
		context.waitTicks(4);
		expectEditState(context, CodexEditLock.State.CONFLICT);
		boolean overwrite = context.computeOnClient(mc -> mc.gui.screen().children().stream()
			.anyMatch(c -> c instanceof Button b && "Overwrite".equals(b.getMessage().getString())));
		if (!overwrite) {
			throw new AssertionError("a conflict offers Overwrite");
		}
		context.takeScreenshot("org-codex-conflict");
		context.setScreen(() -> null);
	}

	private static void expectEditState(final ClientGameTestContext context, final CodexEditLock.State expected) {
		CodexEditLock.State state = context.computeOnClient(mc -> ((CodexScreen)mc.gui.screen()).editState());
		if (state != expected) {
			throw new AssertionError("edit lock is " + state + ", expected " + expected);
		}
	}

	private static void meetingHudShowsAndChatHasEnd(final ClientGameTestContext context) {
		context.runOnClient(mc -> OrgClient.backend().meetingStart(new Org.MeetingStart(null, "Standup", null, false)).join());
		context.waitTicks(2);
		if (context.computeOnClient(mc -> OrgClientState.get().meeting() == null)) {
			throw new AssertionError("the fake meeting did not start");
		}
		context.takeScreenshot("org-meeting-hud");
		context.setScreen(() -> new ChatScreen("", false));
		context.waitTicks(3);
		boolean hasEnd = context.computeOnClient(mc -> mc.gui.screen() != null && mc.gui.screen().children().stream()
			.anyMatch(c -> c instanceof Button b && "End meeting".equals(b.getMessage().getString())));
		if (!hasEnd) {
			throw new AssertionError("the chat screen has no End meeting button during a meeting");
		}
		context.takeScreenshot("org-meeting-chat");
		context.setScreen(() -> null);
		context.runOnClient(mc -> OrgClient.backend().meetingEnd(OrgClientState.get().meeting().meetingId()).join());
		if (context.computeOnClient(mc -> OrgClientState.get().meeting() != null)) {
			throw new AssertionError("meeting.end did not end the meeting");
		}
	}

	private static void officeFromItsSpawn(final ClientGameTestContext context, final TestSingleplayerContext singleplayer) {
		BlockPos spawn = singleplayer.getServer().computeOnServer(server -> {
			ServerPlayer player = server.getPlayerList().getPlayers().getFirst();
			ServerLevel level = server.overworld();
			OfficeLayout layout = OfficeService.buildAt(level, OfficeBuilder.originForSpawn(level, player.blockPosition()));
			BlockPos at = layout.spawn();
			player.teleportTo(level, at.getX() + 0.5, at.getY(), at.getZ() + 0.5, java.util.Set.of(), layout.spawnYaw(), 10.0F, true);
			return at;
		});
		context.waitTicks(20);
		singleplayer.getConnection().waitForChunksRender();
		context.takeScreenshot("org-office-spawn");
		// Look at the codex from in front of it.
		singleplayer.getServer().runOnServer(server -> {
			ServerPlayer player = server.getPlayerList().getPlayers().getFirst();
			player.teleportTo(server.overworld(), spawn.getX() + 4.0, spawn.getY(), spawn.getZ() - 2.5, java.util.Set.of(), 180.0F, 20.0F, true);
		});
		context.waitTicks(10);
		context.takeScreenshot("org-office-codex");
	}
}
