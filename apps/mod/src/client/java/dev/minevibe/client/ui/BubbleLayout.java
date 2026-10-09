package dev.minevibe.client.ui;

import dev.minevibe.bridge.msg.Ui;
import java.util.ArrayList;
import java.util.List;

/**
 * Bubble text layout (PLAN §7.8): plain bubbles wrap at about 32 characters and show at most 3 lines; a truncated
 * reply ends with "… (G)" (G opens the agent's card or transcript). Within 5 blocks the presenter's bubble switches
 * to <b>card mode</b>: up to 8 lines of 40 characters with the question and its numbered options. Pure: no Minecraft
 * classes, so it is unit-tested directly.
 */
public final class BubbleLayout {
	private BubbleLayout() {}

	public static final int BUBBLE_CHARS = 32;
	public static final int BUBBLE_LINES = 3;
	public static final int CARD_CHARS = 40;
	public static final int CARD_LINES = 8;
	/** The presenter's bubble shows its card within this distance (blocks). */
	public static final double CARD_MODE_DISTANCE = 5.0;
	/**
	 * USER DECISION 2026-10-08: a presenter that sits at a PC asks from its chair whenever the player is within 8 blocks
	 * (Node's {@code seatedNearBlocks}) and never walks closer, so its card shows from a little farther away (the camera
	 * sits above the player's feet).
	 */
	public static final double SEATED_CARD_MODE_DISTANCE = 9.0;
	/** Bubbles are not drawn beyond this distance; the line becomes a toast. */
	public static final double MAX_BUBBLE_DISTANCE = 32.0;
	public static final String MORE = "… (G)";

	/** How close the camera must be for the presenter's bubble to show its card. */
	public static double cardModeDistance(boolean presenterSeatedAtPc) {
		return presenterSeatedAtPc ? SEATED_CARD_MODE_DISTANCE : CARD_MODE_DISTANCE;
	}

	/** Wrapped lines, and whether text was cut off. */
	public record Layout(List<String> lines, boolean truncated) {}

	/** A plain bubble: {@value #BUBBLE_CHARS} characters, {@value #BUBBLE_LINES} lines. */
	public static Layout bubble(String text) {
		return wrap(text, BUBBLE_CHARS, BUBBLE_LINES);
	}

	/**
	 * Word-wraps {@code text} at {@code maxChars} (long words are split), collapsing whitespace. When more than
	 * {@code maxLines} lines would be needed, the last line is shortened to end with {@value #MORE}.
	 */
	public static Layout wrap(String text, int maxChars, int maxLines) {
		List<String> all = wrapAll(text, maxChars);
		if (all.size() <= maxLines) return new Layout(all, false);
		List<String> lines = new ArrayList<>(all.subList(0, maxLines));
		String last = lines.get(maxLines - 1);
		int room = Math.max(0, maxChars - MORE.length());
		String cut = last.length() > room ? last.substring(0, room) : last;
		lines.set(maxLines - 1, cut.stripTrailing() + MORE);
		return new Layout(List.copyOf(lines), true);
	}

	/** Every wrapped line, without a line limit. */
	public static List<String> wrapAll(String text, int maxChars) {
		List<String> lines = new ArrayList<>();
		for (String paragraph : text.replace("\r", "").split("\n")) {
			wrapParagraph(paragraph.replaceAll("\\s+", " ").trim(), maxChars, lines);
		}
		while (!lines.isEmpty() && lines.getLast().isEmpty()) lines.removeLast();
		return lines.isEmpty() ? List.of("") : List.copyOf(lines);
	}

	private static void wrapParagraph(String paragraph, int maxChars, List<String> out) {
		if (paragraph.isEmpty()) {
			if (!out.isEmpty()) out.add("");
			return;
		}
		StringBuilder line = new StringBuilder();
		for (String word : paragraph.split(" ")) {
			while (word.codePointCount(0, word.length()) > maxChars) {
				if (!line.isEmpty()) {
					out.add(line.toString());
					line.setLength(0);
				}
				int cut = word.offsetByCodePoints(0, maxChars);
				out.add(word.substring(0, cut));
				word = word.substring(cut);
			}
			int needed = line.isEmpty() ? word.length() : line.length() + 1 + word.length();
			if (needed > maxChars && !line.isEmpty()) {
				out.add(line.toString());
				line.setLength(0);
			}
			if (!line.isEmpty()) line.append(' ');
			line.append(word);
		}
		if (!line.isEmpty()) out.add(line.toString());
	}

	/**
	 * Card mode: the front card as a large bubble of {@value #CARD_LINES} lines of {@value #CARD_CHARS} characters.
	 * Questions show "Q1/3", the question and numbered options (Alt+1-4 or {@code @handle 2} answer them); plans,
	 * hires and calendar approvals show what is asked and how to answer.
	 */
	public static List<String> card(Ui.PendingCard card, String handle) {
		List<String> lines = new ArrayList<>();
		switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> {
				Ui.CardQuestion q = FrontCards.currentQuestion(card);
				if (q == null) break;
				String head = card.questions().size() > 1 ? FrontCards.progress(card) + " " : "";
				lines.addAll(wrap(head + q.question(), CARD_CHARS, 3).lines());
				int n = 1;
				for (Ui.QuestionOption option : q.options()) {
					if (lines.size() >= CARD_LINES - 1) break;
					lines.add(clip(n + " " + option.label(), CARD_CHARS));
					n++;
				}
				lines.add(clip(q.multiSelect() ? "@" + handle + " 1,3 · G to answer" : "Alt+1-4 · @" + handle + " 2 · G", CARD_CHARS));
			}
			case Ui.PendingCard.PLAN -> {
				lines.add("Plan ready:");
				String plan = card.plan() == null ? "" : card.plan().replaceAll("(?m)^#+\\s*", "");
				lines.addAll(wrap(plan, CARD_CHARS, CARD_LINES - 2).lines());
				lines.add(clip("@" + handle + " approve · G to review", CARD_CHARS));
			}
			case Ui.PendingCard.HIRE -> {
				lines.add(clip("Hire " + card.name() + " (" + card.role() + ")?", CARD_CHARS));
				if (card.reason() != null && !card.reason().isBlank()) lines.addAll(wrap(card.reason(), CARD_CHARS, 3).lines());
				// Approving a hire costs the player an Agent Core (PLAN 7.5).
				lines.add("Costs 1 Agent Core");
				lines.add(clip("@" + handle + " yes · @" + handle + " no", CARD_CHARS));
			}
			case Ui.PendingCard.CALENDAR -> {
				lines.add("Approve this event?");
				lines.addAll(wrap(card.summary() == null ? "" : card.summary(), CARD_CHARS, 4).lines());
				lines.add("G to approve or decline");
			}
			default -> lines.add(clip(FrontCards.summary(card), CARD_CHARS));
		}
		return lines.size() > CARD_LINES ? List.copyOf(lines.subList(0, CARD_LINES)) : List.copyOf(lines);
	}

	/** Cuts {@code text} to {@code max} characters, ending with "…" when cut. */
	public static String clip(String text, int max) {
		if (text.length() <= max) return text;
		return text.substring(0, Math.max(0, max - 1)).stripTrailing() + "…";
	}
}
