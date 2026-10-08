package dev.minevibe.client.org.calendar;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.time.LocalDate;
import java.time.ZoneId;
import org.junit.jupiter.api.Test;

/** The calendar's two clocks (PLAN §6.6): the world clock (06:00 = tick 0) and the wall clock with DST. */
class CalendarClocksTest {
	private static final ZoneId BRUSSELS = ZoneId.of("Europe/Brussels");

	@Test
	void gameDaysRunFromSixToSix() {
		assertEquals(1, GameClock.day(0));
		assertEquals(6, GameClock.hour(0));
		assertEquals(0, GameClock.minute(0));
		assertEquals(1, GameClock.day(23_999));
		assertEquals(5, GameClock.hour(23_999));
		assertEquals(59, GameClock.minute(23_999));
		assertEquals(2, GameClock.day(24_000));
		assertEquals("Day 3 08:00", GameClock.format(2 * 24_000 + 2_000));
		assertEquals(18, GameClock.hour(12_000));
	}

	@Test
	void timesBeforeSixBelongToTheEndOfTheDay() {
		assertEquals(23_000, GameClock.at(1, 5, 0));
		assertEquals(2 * 24_000 + 23_000, GameClock.at(3, 5, 0));
		assertEquals(3, GameClock.day(GameClock.at(3, 5, 59)));
		assertEquals(0, GameClock.at(1, 6, 0));
		assertEquals(GameClock.dayStart(4) + 2_500, GameClock.at(4, 8, 30));
	}

	@Test
	void atRoundTripsEveryMinute() {
		for (int hour = 0; hour < 24; hour++) {
			for (int minute = 0; minute < 60; minute++) {
				long t = GameClock.at(7, hour, minute);
				assertEquals(7, GameClock.day(t), hour + ":" + minute);
				assertEquals(hour, GameClock.hour(t), hour + ":" + minute);
				assertEquals(minute, GameClock.minute(t), hour + ":" + minute);
			}
		}
		assertThrows(IllegalArgumentException.class, () -> GameClock.at(0, 6, 0));
		assertThrows(IllegalArgumentException.class, () -> GameClock.at(1, 24, 0));
	}

	@Test
	void parsesClockTimes() {
		assertArrayEquals(new int[] {8, 5}, GameClock.parseTime("08:05"));
		assertArrayEquals(new int[] {8, 5}, GameClock.parseTime(" 8:05 "));
		assertNull(GameClock.parseTime("24:00"));
		assertNull(GameClock.parseTime("8:5"));
		assertNull(GameClock.parseTime("noon"));
		assertNull(GameClock.parseTime(""));
	}

	@Test
	void gameMinutesAndRealSeconds() {
		assertEquals(1_000, GameClock.minutesToTicks(60));
		assertEquals(17, GameClock.minutesToTicks(1));
		assertEquals(50, GameClock.realSecondsUntil(0, 1_000));
		assertEquals(0, GameClock.realSecondsUntil(5_000, 1_000));
	}

	@Test
	void realDaysFollowDaylightSaving() {
		LocalDate spring = LocalDate.of(2026, 3, 29);
		LocalDate autumn = LocalDate.of(2026, 10, 25);
		assertEquals(23 * 3_600_000L, RealClock.dayEnd(spring, BRUSSELS) - RealClock.dayStart(spring, BRUSSELS));
		assertEquals(25 * 3_600_000L, RealClock.dayEnd(autumn, BRUSSELS) - RealClock.dayStart(autumn, BRUSSELS));
		assertEquals(24 * 3_600_000L, RealClock.dayEnd(autumn.plusDays(1), BRUSSELS) - RealClock.dayStart(autumn.plusDays(1), BRUSSELS));
		// 02:30 does not exist on the spring day: it moves forward to 03:30.
		long skipped = RealClock.at(spring, 2, 30, BRUSSELS);
		assertEquals(3, RealClock.hour(skipped, BRUSSELS));
		assertEquals(30, RealClock.minute(skipped, BRUSSELS));
	}

	@Test
	void zonesFallBackToTheHost() {
		assertEquals(BRUSSELS, RealClock.zone("Europe/Brussels"));
		assertEquals(ZoneId.systemDefault(), RealClock.zone("Not/AZone"));
		assertEquals(ZoneId.systemDefault(), RealClock.zone(null));
		assertEquals(LocalDate.of(2026, 10, 8), RealClock.parseDate("2026-10-08"));
		assertNull(RealClock.parseDate("08/10/2026"));
		long t = RealClock.at(LocalDate.of(2026, 10, 12), 14, 30, BRUSSELS);
		assertEquals("Mon 12 Oct 14:30", RealClock.format(t, BRUSSELS));
	}
}
