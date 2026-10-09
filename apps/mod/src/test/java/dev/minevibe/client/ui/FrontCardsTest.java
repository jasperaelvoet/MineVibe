package dev.minevibe.client.ui;

import static dev.minevibe.client.ui.UiTestCards.calendar;
import static dev.minevibe.client.ui.UiTestCards.hire;
import static dev.minevibe.client.ui.UiTestCards.multi;
import static dev.minevibe.client.ui.UiTestCards.plan;
import static dev.minevibe.client.ui.UiTestCards.question;
import static dev.minevibe.client.ui.UiTestCards.single;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Ui;
import java.util.List;
import org.junit.jupiter.api.Test;

class FrontCardsTest {
	private final Ui.PendingCard q = question("q", "ada", 30, List.of(single("Wood?", "Oak", "Spruce"), multi("Extras?", "Bed", "Chest")), List.of());
	private final Ui.PendingCard p = plan("p", "ada", 20, "do it");
	private final Ui.PendingCard h = hire("h", "ada", 5);
	private final Ui.PendingCard c = calendar("c", "ada", 1);

	@Test
	void blockingCardsComeFirstThenOldest() {
		assertSame(p, FrontCards.front(List.of(h, q, p, c)));
		assertSame(q, FrontCards.front(List.of(h, q, c)));
		assertSame(c, FrontCards.front(List.of(h, c)));
		assertNull(FrontCards.front(List.of()));
	}

	@Test
	void answeredQuestionCardsAreSkipped() {
		Ui.PendingCard done = question("done", "ada", 1, List.of(single("Wood?", "Oak")), List.of("Oak"));
		assertTrue(FrontCards.complete(done));
		assertSame(h, FrontCards.front(List.of(done, h)));
	}

	@Test
	void multiQuestionCardsAskOneAtATime() {
		assertEquals("Q1/2", FrontCards.progress(q));
		assertEquals("Wood?", FrontCards.currentQuestion(q).question());
		Ui.PendingCard second = question("q", "ada", 30, q.questions(), List.of("Oak"));
		assertEquals("Q2/2", FrontCards.progress(second));
		assertEquals(1, FrontCards.questionIndex(second));
		assertEquals("Extras?", FrontCards.currentQuestion(second).question());
		assertEquals("", FrontCards.progress(p));
		assertNull(FrontCards.currentQuestion(p));
	}

	@Test
	void summaries() {
		assertEquals("Q1/2 Wood?", FrontCards.summary(q));
		assertEquals("Plan ready for approval", FrontCards.summary(p));
		assertEquals("Hire Dana (miner)? Costs 1 Agent Core", FrontCards.summary(h));
		assertEquals("Daily standup", FrontCards.summary(c));
	}
}
