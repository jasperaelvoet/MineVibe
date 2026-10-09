package dev.minevibe.client.ui;

import static dev.minevibe.client.ui.UiTestCards.calendar;
import static dev.minevibe.client.ui.UiTestCards.hire;
import static dev.minevibe.client.ui.UiTestCards.multi;
import static dev.minevibe.client.ui.UiTestCards.plan;
import static dev.minevibe.client.ui.UiTestCards.question;
import static dev.minevibe.client.ui.UiTestCards.single;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class BubbleLayoutTest {
	@Test
	void shortTextIsOneLine() {
		BubbleLayout.Layout layout = BubbleLayout.bubble("  On it!  ");
		assertEquals(List.of("On it!"), layout.lines());
		assertFalse(layout.truncated());
	}

	@Test
	void wrapsOnWordsAtThirtyTwoCharacters() {
		BubbleLayout.Layout layout = BubbleLayout.bubble("I found iron near the river bend and planted wheat");
		assertEquals(List.of("I found iron near the river bend", "and planted wheat"), layout.lines());
		layout.lines().forEach(l -> assertTrue(l.length() <= BubbleLayout.BUBBLE_CHARS, l));
	}

	@Test
	void longRepliesAreCutAtThreeLinesWithTheGHint() {
		String text = "word ".repeat(60);
		BubbleLayout.Layout layout = BubbleLayout.bubble(text);
		assertEquals(3, layout.lines().size());
		assertTrue(layout.truncated());
		String last = layout.lines().get(2);
		assertTrue(last.endsWith("… (G)"), last);
		assertTrue(last.length() <= BubbleLayout.BUBBLE_CHARS, last);
	}

	@Test
	void splitsWordsLongerThanALineAndKeepsParagraphs() {
		List<String> lines = BubbleLayout.wrapAll("x".repeat(70) + "\n\nnext", 32);
		assertEquals(List.of("x".repeat(32), "x".repeat(32), "x".repeat(6), "", "next"), lines);
		assertEquals(List.of(""), BubbleLayout.wrapAll("   ", 32));
	}

	@Test
	void questionCardModeShowsProgressOptionsAndHowToAnswer() {
		var card = question("q", "ada", 1, List.of(single("Which wood?", "Oak", "Spruce", "Birch"), multi("Extras?", "Chest", "Bed")), List.of());
		List<String> lines = BubbleLayout.card(card, "ada");
		assertEquals(List.of("Q1/2 Which wood?", "1 Oak", "2 Spruce", "3 Birch", "Alt+1-4 · @ada 2 · G"), lines);
		var second = question("q", "ada", 1, card.questions(), List.of("Oak"));
		assertEquals("Q2/2 Extras?", BubbleLayout.card(second, "ada").getFirst());
		assertEquals("@ada 1,3 · G to answer", BubbleLayout.card(second, "ada").getLast());
	}

	@Test
	void cardModeStaysWithinEightLinesOfFortyCharacters() {
		var many = question("q", "ada", 1,
				List.of(single("A very long question that goes on and on about which of these many options to pick today",
						"One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten")), List.of());
		List<String> lines = BubbleLayout.card(many, "ada");
		assertTrue(lines.size() <= BubbleLayout.CARD_LINES, lines.toString());
		lines.forEach(l -> assertTrue(l.length() <= BubbleLayout.CARD_CHARS, l));
		List<String> planLines = BubbleLayout.card(plan("p", "bram", 1, "# Fix it\n" + "step ".repeat(100)), "bram");
		assertTrue(planLines.size() <= BubbleLayout.CARD_LINES);
		assertEquals("Plan ready:", planLines.getFirst());
		assertEquals("@bram approve · G to review", planLines.getLast());
		assertEquals("Fix it", planLines.get(1));
	}

	@Test
	void hireAndCalendarCards() {
		assertEquals(
				List.of("Hire Dana (miner)?", "We need iron.", "Costs 1 Agent Core", "@ada yes · @ada no"),
				BubbleLayout.card(hire("h", "ada", 1), "ada"));
		assertEquals(List.of("Approve this event?", "Daily standup", "G to approve or decline"), BubbleLayout.card(calendar("c", "ada", 1), "ada"));
	}

	@Test
	void seatedPresenterShowsItsCardFromTheChair() {
		// USER DECISION 2026-10-08: seated agents ask from the chair when the player is within 8 blocks.
		assertEquals(BubbleLayout.CARD_MODE_DISTANCE, BubbleLayout.cardModeDistance(false));
		assertTrue(BubbleLayout.cardModeDistance(true) >= 8.0, "covers Node's seatedNearBlocks (8)");
		assertTrue(BubbleLayout.cardModeDistance(true) < BubbleLayout.MAX_BUBBLE_DISTANCE);
	}

	@Test
	void clipEndsWithAnEllipsis() {
		assertEquals("abc", BubbleLayout.clip("abc", 5));
		assertEquals("abcd…", BubbleLayout.clip("abcdefgh", 5));
	}
}
