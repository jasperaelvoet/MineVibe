package dev.minevibe.client.org.meeting;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.client.org.OrgClient;
import dev.minevibe.client.org.OrgClientState;
import dev.minevibe.client.org.OrgUi;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.toasts.SystemToast;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * The meeting HUD (PLAN §6.6, §7.8): while a meeting runs, a panel in the top-right corner shows its title, phase,
 * who is speaking, attendance and the time left. The HUD cannot take clicks while the player walks around, so its
 * End button lives where the mouse is free: in the chat screen (T opens it), next to the panel. Typing exactly
 * {@code @meeting end} in chat ends it too (Node's chat routing).
 */
public final class MeetingHud {
	static final int WIDTH = 176;
	private static final int MARGIN = 4;

	private MeetingHud() {
	}

	/** {@code HudElement}: draws the panel while a meeting runs. */
	public static void extract(final GuiGraphicsExtractor g, final DeltaTracker delta) {
		Org.MeetingState meeting = OrgClientState.get().meeting();
		if (!MeetingHudModel.isActive(meeting)) {
			return;
		}
		Minecraft mc = Minecraft.getInstance();
		Font font = mc.font;
		MeetingHudModel m = MeetingHudModel.of(meeting, System.currentTimeMillis(), OrgClientState.get().crew()::name);
		int x1 = g.guiWidth() - MARGIN;
		int x0 = x1 - WIDTH;
		int y0 = MARGIN;
		boolean chatOpen = mc.gui.screen() instanceof ChatScreen;
		int lines = chatOpen ? 3 : 4;
		int y1 = y0 + 6 + lines * 10;
		OrgUi.panel(g, x0, y0, x1, y1, 0xC0101820, 0xFF7BD88F);
		g.fill(x0 + 4, y0 + 6, x0 + 8, y0 + 10, 0xFF7BD88F);
		int w = WIDTH - 16;
		String head = m.title() + " · " + m.phase();
		String left = m.timeLeft();
		g.text(font, OrgUi.clip(font, head, w - font.width(left) - 6), x0 + 11, y0 + 4, OrgUi.WHITE, true);
		g.text(font, left, x1 - 5 - font.width(left), y0 + 4, OrgUi.YELLOW, true);
		g.text(font, OrgUi.clip(font, m.speaker(), w), x0 + 6, y0 + 14, 0xFFE0E0E0, true);
		g.text(font, OrgUi.clip(font, m.attendance(), w), x0 + 6, y0 + 24, OrgUi.GREY, true);
		if (!chatOpen) {
			g.text(font, OrgUi.clip(font, "Open chat to end it", w), x0 + 6, y0 + 34, 0xFF808890, true);
		}
	}

	/** {@code ScreenEvents.AFTER_INIT}: puts an End button under the panel in the chat screen. */
	public static void onScreenInit(final Minecraft mc, final Screen screen, final int width, final int height) {
		if (!(screen instanceof ChatScreen)) {
			return;
		}
		Org.MeetingState meeting = OrgClientState.get().meeting();
		if (!MeetingHudModel.isActive(meeting)) {
			return;
		}
		String meetingId = meeting.meetingId();
		Button end = Button.builder(Component.literal("End meeting"), b -> {
			b.active = false;
			OrgClient.whenDone(OrgClient.backend().meetingEnd(meetingId), ok -> {
			}, error -> SystemToast.add(mc.gui.toastManager(), SystemToast.SystemToastId.PERIODIC_NOTIFICATION, Component.literal("Meeting"),
				Component.literal(OrgClient.describe(error))));
		}).bounds(width - MARGIN - 80, MARGIN + 6 + 3 * 10 + 2, 80, 14).build();
		Screens.getWidgets(screen).add(end);
	}

	public static void register() {
		ScreenEvents.AFTER_INIT.register(MeetingHud::onScreenInit);
	}
}
