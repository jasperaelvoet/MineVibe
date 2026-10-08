package dev.minevibe.client.ui.screen;

import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.client.ui.UiState;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;

/**
 * The Crew log (PLAN §7.8): every agent's messages in one scrollable list, oldest at the top, newest at the bottom.
 * It shows what this client has received (live lines and pages loaded in AgentScreen). Opened with J.
 */
public final class CrewLogScreen extends Screen {
	private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault());
	private int scroll;
	private long seenRevision = -1;
	private List<FormattedCharSequence> lines = List.of();
	private List<Integer> colors = List.of();

	public CrewLogScreen() {
		super(Component.literal("Crew log"));
	}

	@Override
	protected void init() {
		addRenderableWidget(Button.builder(Component.literal("Close"), b -> onClose()).bounds(width - 58, 4, 50, 14).build());
		rebuildLines();
	}

	private void rebuildLines() {
		UiState state = UiState.get();
		seenRevision = state.revision();
		List<FormattedCharSequence> out = new ArrayList<>();
		List<Integer> cs = new ArrayList<>();
		for (UiState.LogLine line : state.crewLog()) {
			Ui.ChatEntry e = line.entry();
			String who = state.nameOf(line.agentId());
			String text = switch (e.kind()) {
				case "player" -> "You → " + who + ": " + e.text();
				case "agent" -> who + ": " + e.text();
				case "tell" -> (e.fromAgentId() != null ? state.nameOf(e.fromAgentId()) : "?") + " → " + who + ": " + e.text();
				case "activity" -> who + " · " + e.text();
				default -> who + " [" + e.kind() + "] " + e.text();
			};
			int color = switch (e.kind()) {
				case "player" -> 0xFF9AD0FF;
				case "agent" -> 0xFFFFFFFF;
				case "tell" -> 0xFFD7B5FF;
				case "card" -> 0xFFFFD84A;
				default -> 0xFF909090;
			};
			for (FormattedCharSequence part : font.split(Component.literal(TIME.format(Instant.ofEpochMilli(e.at())) + " " + text), width - 24)) {
				out.add(part);
				cs.add(color);
			}
		}
		lines = out;
		colors = cs;
	}

	@Override
	public void tick() {
		if (UiState.get().revision() != seenRevision) rebuildLines();
	}

	@Override
	public boolean mouseScrolled(double x, double y, double scrollX, double scrollY) {
		scroll = Math.max(0, scroll + (int) Math.signum(scrollY) * 3);
		return true;
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		g.text(font, "Crew log", 10, 7, 0xFFFFFFFF, true);
		g.fill(8, 22, width - 8, height - 8, 0x80000000);
		int visible = Math.max(1, (height - 34) / 10);
		scroll = Math.min(scroll, Math.max(0, lines.size() - visible));
		int end = lines.size() - scroll;
		int start = Math.max(0, end - visible);
		int y = height - 12 - (end - start) * 10;
		if (lines.isEmpty()) g.text(font, "Nothing yet. Agent messages appear here.", 12, 28, 0xFF808080, false);
		for (int i = start; i < end; i++) {
			g.text(font, lines.get(i), 12, y, colors.get(i), false);
			y += 10;
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}
}
