package dev.minevibe.client.ui.hud;

import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.BubbleLayout;
import dev.minevibe.client.ui.HeadIcon;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/**
 * CrewHud (PLAN §7.8), toggled with H: the crew at a glance in the top-left corner. One row per living agent: head
 * icon, name, model suffix, pending cards and the last activity; the header shows the brain slots and usage
 * (Tired, Asleep until …) or that MineVibe is offline.
 */
public final class CrewHud {
	private CrewHud() {}

	private static boolean visible = true;

	public static boolean visible() {
		return visible;
	}

	public static void toggle() {
		visible = !visible;
	}

	public static void setVisible(boolean on) {
		visible = on;
	}

	/** The header line. */
	static String header(Messages.@Nullable Brains brains, boolean online, int living) {
		if (!online) return "Crew · MineVibe offline";
		if (brains == null) return "Crew (" + living + ")";
		String slots = "brains " + brains.inFlight() + "/" + brains.max() + (brains.queued() > 0 ? " +" + brains.queued() + " queued" : "");
		String mode = switch (brains.mode()) {
			case "tired" -> " · Tired";
			case "asleep" -> brains.resetsAt() != null
					? " · Asleep until " + DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(brains.resetsAt()))
					: " · Asleep";
			default -> "";
		};
		return "Crew (" + living + ") · " + slots + mode;
	}

	/** One row's text (without the icon). */
	static String row(AgentView a) {
		StringBuilder sb = new StringBuilder(a.name()).append(' ').append(a.modelSuffix());
		int cards = a.cards().size();
		if (cards > 0) sb.append(" · ").append(cards).append(cards == 1 ? " card" : " cards");
		if (a.activity() != null) sb.append(" · ").append(a.activity());
		else if (!"idle".equals(a.brain())) sb.append(" · ").append(a.brain().replace('_', ' '));
		return BubbleLayout.clip(sb.toString(), 48);
	}

	public static void extract(GuiGraphicsExtractor g, DeltaTracker delta) {
		Minecraft mc = Minecraft.getInstance();
		if (!visible || mc.player == null || mc.level == null || mc.gui.hud.isHidden()) return;
		UiState state = UiState.get();
		List<AgentView> living = state.living();
		if (living.isEmpty() && state.agents().isEmpty()) return;
		Font font = mc.font;
		boolean online = UiTransport.current().connected();
		List<String> rows = new ArrayList<>();
		List<HeadIcon> icons = new ArrayList<>();
		for (AgentView a : living) {
			Player body = AgentEntities.body(mc.level, a);
			icons.add(HeadIcon.of(a, body != null && AgentEntities.atPc(body, a), online));
			rows.add(row(a));
		}
		String head = header(state.brains(), online, living.size());
		int width = font.width(head);
		for (String r : rows) width = Math.max(width, 12 + font.width(r));
		int x = 4;
		int y = 4;
		int height = 12 + rows.size() * 10;
		g.fill(x - 2, y - 2, x + width + 4, y + height, 0xC0101018);
		g.text(font, head, x, y, online ? 0xFFFFE08A : 0xFFB0B0C8, true);
		y += 12;
		for (int i = 0; i < rows.size(); i++) {
			HeadIcon icon = icons.get(i);
			if (icon != HeadIcon.NONE) g.text(font, icon.glyph(), x, y, icon.color(), true);
			g.text(font, rows.get(i), x + 12, y, 0xFFFFFFFF, true);
			y += 10;
		}
	}
}
