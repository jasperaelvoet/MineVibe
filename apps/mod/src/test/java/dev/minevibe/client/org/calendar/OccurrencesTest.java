package dev.minevibe.client.org.calendar;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.msg.Org;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** Projecting an event's occurrences onto a day of the timeline. */
class OccurrencesTest {
	private static final ZoneId BRUSSELS = ZoneId.of("Europe/Brussels");

	static Org.CalendarEvent event(final String clock, final long at, final String recurrence, final @Nullable Integer n, final String status,
		final @Nullable Long nextAt, final List<Org.Occurrence> log) {
		return new Org.CalendarEvent("ev-1", "Farm", "task", new JsonPrimitive("all"), clock, at, "real".equals(clock) ? "Europe/Brussels" : null,
			new Org.Recurrence(recurrence, n), 30, null, "farm", "skip", false, "player", status, nextAt, log);
	}

	@Test
	void dailyGameEventsShowOncePerDay() {
		long at = GameClock.at(2, 8, 0);
		Org.CalendarEvent e = event("game", at, "daily", null, "active", at, List.of());
		for (int day = 2; day <= 6; day++) {
			List<Occurrences.Occurrence> shown = Occurrences.inWindow(e, GameClock.dayStart(day), GameClock.dayStart(day + 1), BRUSSELS, 10);
			assertEquals(1, shown.size(), "day " + day);
			assertEquals(GameClock.at(day, 8, 0), shown.getFirst().at());
			assertTrue(shown.getFirst().upcoming());
		}
		assertEquals(0, Occurrences.inWindow(e, GameClock.dayStart(1), GameClock.dayStart(2), BRUSSELS, 10).size(), "nothing before it starts");
	}

	@Test
	void everyNDaysSkipsDays() {
		long at = GameClock.at(1, 9, 0);
		Org.CalendarEvent e = event("game", at, "every_n_days", 3, "active", at, List.of());
		List<Long> times = Occurrences.upcoming(e, at, 0, GameClock.dayStart(11), BRUSSELS, 10);
		assertEquals(List.of(GameClock.at(1, 9, 0), GameClock.at(4, 9, 0), GameClock.at(7, 9, 0), GameClock.at(10, 9, 0)), times);
	}

	@Test
	void onceIsOnce() {
		long at = GameClock.at(3, 12, 0);
		Org.CalendarEvent e = event("game", at, "once", null, "active", at, List.of());
		assertEquals(1, Occurrences.inWindow(e, 0, GameClock.dayStart(30), BRUSSELS, 10).size());
	}

	@Test
	void loggedOccurrencesAreShownWithTheirStatusAndCancelledEventsStop() {
		long at = GameClock.at(1, 8, 0);
		List<Org.Occurrence> log = List.of(new Org.Occurrence(at, "done", "ok", null), new Org.Occurrence(at + 24_000, "missed", null, "bram"));
		Org.CalendarEvent live = event("game", at, "daily", null, "active", at + 48_000, log);
		List<Occurrences.Occurrence> shown = Occurrences.inWindow(live, 0, GameClock.dayStart(4), BRUSSELS, 10);
		assertEquals(List.of("done", "missed", Occurrences.Occurrence.UPCOMING), shown.stream().map(Occurrences.Occurrence::status).toList());
		Org.CalendarEvent cancelled = event("game", at, "daily", null, "cancelled", null, log);
		assertEquals(2, Occurrences.inWindow(cancelled, 0, GameClock.dayStart(10), BRUSSELS, 10).size(), "only the log");
	}

	@Test
	void weekdaysSkipWeekendsAndKeepTheirLocalTimeOverDaylightSaving() {
		// Friday 23 Oct 2026, 09:00 in Brussels; DST ends on Sunday 25 Oct.
		long start = RealClock.at(LocalDate.of(2026, 10, 23), 9, 0, BRUSSELS);
		Org.CalendarEvent e = event("real", start, "weekdays", null, "active", start, List.of());
		long to = RealClock.dayEnd(LocalDate.of(2026, 10, 28), BRUSSELS);
		List<Long> times = Occurrences.upcoming(e, start, start, to, BRUSSELS, 20);
		List<LocalDate> days = times.stream().map(t -> Instant.ofEpochMilli(t).atZone(BRUSSELS).toLocalDate()).toList();
		assertEquals(List.of(LocalDate.of(2026, 10, 23), LocalDate.of(2026, 10, 26), LocalDate.of(2026, 10, 27), LocalDate.of(2026, 10, 28)), days);
		for (long t : times) {
			assertEquals(9, RealClock.hour(t, BRUSSELS));
			DayOfWeek dow = Instant.ofEpochMilli(t).atZone(BRUSSELS).getDayOfWeek();
			assertTrue(dow != DayOfWeek.SATURDAY && dow != DayOfWeek.SUNDAY);
		}
	}

	@Test
	void dailyRealEventsInTheirWindow() {
		long start = RealClock.at(LocalDate.of(2026, 10, 24), 7, 30, BRUSSELS);
		Org.CalendarEvent e = event("real", start, "daily", null, "active", start, List.of());
		LocalDate sunday = LocalDate.of(2026, 10, 25);
		List<Occurrences.Occurrence> shown = Occurrences.inWindow(e, RealClock.dayStart(sunday, BRUSSELS), RealClock.dayEnd(sunday, BRUSSELS), BRUSSELS, 10);
		assertEquals(1, shown.size());
		assertEquals(7, RealClock.hour(shown.getFirst().at(), BRUSSELS));
	}
}
