package dev.minevibe.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** When a stuck agent speaks up again (PLAN 7.3): at once, then after 5, 10 and 20 minutes, and at once after a reset. */
class RepeatBackoffTest {
	@Test
	void firstAtOnceThenEverFurtherApartUpToTheMax() {
		RepeatBackoff b = new RepeatBackoff(6000, 24000);
		assertTrue(b.due(100), "the first time is said at once");
		b.said(100);
		assertFalse(b.due(100 + 5999), "a repeat waits the base gap");
		assertTrue(b.due(100 + 6000));
		b.said(6100);
		assertEquals(12000, b.gap(), "each repeat doubles the gap");
		assertFalse(b.due(6100 + 11999));
		assertTrue(b.due(6100 + 12000));
		b.said(18100);
		b.said(42100);
		b.said(66100);
		assertEquals(24000, b.gap(), "never more than the max");
	}

	@Test
	void resetMakesTheNextImmediate() {
		RepeatBackoff b = new RepeatBackoff(6000, 24000);
		b.said(0);
		b.said(6000);
		assertFalse(b.due(6100));
		b.reset();
		assertTrue(b.due(6100), "a new situation is said at once, whatever was said before");
		b.said(6100);
		assertEquals(6000, b.gap(), "and its repeats start from the base gap");
		assertFalse(b.due(6100 + 5999));
	}
}
