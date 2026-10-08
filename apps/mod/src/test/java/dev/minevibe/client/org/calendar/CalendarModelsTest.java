package dev.minevibe.client.org.calendar;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** Cost estimates, chip lanes and chip colours. */
class CalendarModelsTest {
	@Test
	void remindersAreFree() {
		CostEstimator.Estimate e = CostEstimator.estimate("reminder", 3, "game", "daily", 2, false);
		assertEquals(0, e.turnsPerOccurrence());
		assertTrue(e.text().startsWith("Free"));
	}

	@Test
	void tasksCostTurnsPerAssignee() {
		CostEstimator.Estimate once = CostEstimator.estimate("task", 2, "game", "once", 2, false);
		assertEquals(2 * CostEstimator.TASK_TURNS_PER_ASSIGNEE, once.turnsPerOccurrence());
		assertEquals(0.0, once.occurrencesPerPeriod());
		assertEquals("About 8 brain turns (~24k tokens)", once.text());
		CostEstimator.Estimate daily = CostEstimator.estimate("task", 1, "game", "daily", 2, false);
		assertEquals(3.0, daily.occurrencesPerPeriod(), "a game day is 20 real minutes");
		assertEquals("hour of play", daily.period());
		assertEquals(12.0, daily.turnsPerPeriod());
		CostEstimator.Estimate everyThird = CostEstimator.estimate("task", 1, "game", "every_n_days", 3, false);
		assertEquals(1.0, everyThird.occurrencesPerPeriod());
		CostEstimator.Estimate weekdays = CostEstimator.estimate("task", 1, "real", "weekdays", 2, false);
		assertEquals(5.0 / 7.0, weekdays.occurrencesPerPeriod(), 1e-9);
		assertEquals("day", weekdays.period());
	}

	@Test
	void meetingsCostOpeningUpdatesFloorAndWrapUp() {
		assertEquals(1 + 4 + 2 + 1, CostEstimator.estimate("meeting", 4, "game", "once", 2, false).turnsPerOccurrence());
		assertEquals(1 + 2 + 0 + 1, CostEstimator.estimate("meeting", 4, "game", "once", 2, true).turnsPerOccurrence(), "quick standup");
		assertEquals(1 + 1 + 2 + 1, CostEstimator.estimate("meeting", 0, "game", "once", 2, false).turnsPerOccurrence(), "at least one attendee");
	}

	@Test
	void overlappingChipsGetTheirOwnLanes() {
		int[] lanes = ChipLayout.lanes(new int[] {0, 10, 20, 50}, new int[] {30, 40, 25, 60});
		assertArrayEquals(new int[] {0, 1, 2, 0}, lanes);
		assertEquals(3, ChipLayout.laneCount(lanes));
		// Chips that only touch share a lane.
		assertArrayEquals(new int[] {0, 0}, ChipLayout.lanes(new int[] {0, 10}, new int[] {10, 20}));
		// Lanes follow start order, whatever order the chips come in.
		int[] shuffled = ChipLayout.lanes(new int[] {20, 0, 10}, new int[] {25, 30, 40});
		assertArrayEquals(new int[] {2, 0, 1}, shuffled);
		assertEquals(0, ChipLayout.laneCount(new int[0]));
	}

	@Test
	void crewMembersGetDistinctColoursInCrewOrder() {
		List<String> crew = List.of("ada", "bram", "cleo", "dora");
		long distinct = crew.stream().mapToInt(id -> AssigneePalette.colourFor(id, crew)).distinct().count();
		assertEquals(4, distinct);
		assertEquals(AssigneePalette.colourFor("zed", crew), AssigneePalette.colourFor("zed", List.of()), "an unknown agent keeps its colour");
		assertEquals(AssigneePalette.ALL, AssigneePalette.colourForEvent(true, List.of("ada"), crew));
		assertEquals(AssigneePalette.NOBODY, AssigneePalette.colourForEvent(false, List.of(), crew));
		assertEquals(AssigneePalette.colourFor("bram", crew), AssigneePalette.colourForEvent(false, List.of("bram", "ada"), crew));
		assertNotEquals(AssigneePalette.colourFor("ada", crew), AssigneePalette.darker(AssigneePalette.colourFor("ada", crew), 0.5F));
		assertEquals(0x80123456, AssigneePalette.withAlpha(0xFF123456, 0x80));
	}
}
