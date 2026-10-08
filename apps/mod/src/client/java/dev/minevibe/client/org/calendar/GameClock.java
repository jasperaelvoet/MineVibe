package dev.minevibe.client.org.calendar;

import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * The world clock as the calendar reads it (PLAN §6.6, protocol §7.8): overworld clock ticks, {@code Day =
 * floor(t/24000)+1}, {@code 06:00 = tick 0}, so a game day runs from 06:00 to 06:00. One game hour is 1000 ticks
 * (50 real seconds), one game day 20 real minutes.
 */
public final class GameClock {
	public static final long TICKS_PER_DAY = 24_000;
	public static final long TICKS_PER_HOUR = 1_000;
	/** The clock time at tick 0 of a day. */
	public static final int DAY_START_HOUR = 6;
	public static final int TICKS_PER_SECOND = 20;

	private GameClock() {
	}

	public static int day(final long ticks) {
		return (int)Math.floorDiv(ticks, TICKS_PER_DAY) + 1;
	}

	/** The tick at 06:00 of {@code day} (day 1 starts at tick 0). */
	public static long dayStart(final int day) {
		return (long)(day - 1) * TICKS_PER_DAY;
	}

	public static int hour(final long ticks) {
		return (int)((Math.floorMod(ticks, TICKS_PER_DAY) / TICKS_PER_HOUR + DAY_START_HOUR) % 24);
	}

	public static int minute(final long ticks) {
		return (int)(Math.floorMod(ticks, TICKS_PER_HOUR) * 60 / TICKS_PER_HOUR);
	}

	/**
	 * The tick of {@code hh:mm} on game day {@code day}. Hours before 06:00 belong to the end of that day: Day 3 05:00
	 * is 23 hours after Day 3 06:00.
	 */
	public static long at(final int day, final int hour, final int minute) {
		if (day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
			throw new IllegalArgumentException("not a game time: day " + day + " " + hour + ":" + minute);
		}
		// Round minutes up to a tick so the time reads back as the same minute (a minute is 16.67 ticks).
		long intoDay = (long)Math.floorMod(hour - DAY_START_HOUR, 24) * TICKS_PER_HOUR + (long)Math.ceil(minute * TICKS_PER_HOUR / 60.0);
		return dayStart(day) + intoDay;
	}

	/** {@code Day 3 08:00}. */
	public static String format(final long ticks) {
		return "Day " + day(ticks) + " " + formatTime(ticks);
	}

	/** {@code 08:00}. */
	public static String formatTime(final long ticks) {
		return String.format(Locale.ROOT, "%02d:%02d", hour(ticks), minute(ticks));
	}

	/** How far into its game day {@code ticks} is, 0 (06:00) to just under 1. */
	public static double fractionOfDay(final long ticks) {
		return Math.floorMod(ticks, TICKS_PER_DAY) / (double)TICKS_PER_DAY;
	}

	/** Game minutes to ticks (a game minute is 1000/60 ticks). */
	public static long minutesToTicks(final long minutes) {
		return Math.round(minutes * TICKS_PER_HOUR / 60.0);
	}

	/** Real seconds until {@code target} from {@code now} at 20 ticks a second (0 when it is past). */
	public static long realSecondsUntil(final long now, final long target) {
		return Math.max(0, (target - now) / TICKS_PER_SECOND);
	}

	/** Parses {@code h:mm} or {@code hh:mm} (24 h) into {@code {hour, minute}}, or null. */
	public static int @Nullable [] parseTime(final String text) {
		String s = text.trim();
		int colon = s.indexOf(':');
		if (colon < 1 || colon > 2 || s.length() != colon + 3) {
			return null;
		}
		try {
			int hour = Integer.parseInt(s.substring(0, colon));
			int minute = Integer.parseInt(s.substring(colon + 1));
			return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? new int[] {hour, minute} : null;
		} catch (NumberFormatException e) {
			return null;
		}
	}
}
