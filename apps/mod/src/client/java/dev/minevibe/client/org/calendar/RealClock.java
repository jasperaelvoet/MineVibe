package dev.minevibe.client.org.calendar;

import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * The wall clock as the calendar reads it: epoch milliseconds in an IANA time zone, DST included (a day can be 23 or
 * 25 hours long; a local time skipped by DST moves forward like {@link ZonedDateTime#of}).
 */
public final class RealClock {
	private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("EEE d MMM", Locale.ROOT);
	private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

	private RealClock() {
	}

	/** The zone named {@code tz}, or the host zone when it is null or unknown. */
	public static ZoneId zone(final @Nullable String tz) {
		if (tz != null && !tz.isBlank()) {
			try {
				return ZoneId.of(tz.trim());
			} catch (DateTimeException e) {
				// Fall through to the host zone.
			}
		}
		return ZoneId.systemDefault();
	}

	public static LocalDate date(final long epochMs, final ZoneId zone) {
		return Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate();
	}

	/** Midnight at the start of {@code date} (epoch ms). */
	public static long dayStart(final LocalDate date, final ZoneId zone) {
		return date.atStartOfDay(zone).toInstant().toEpochMilli();
	}

	/** Midnight at the end of {@code date}: 23, 24 or 25 hours after {@link #dayStart}. */
	public static long dayEnd(final LocalDate date, final ZoneId zone) {
		return dayStart(date.plusDays(1), zone);
	}

	public static long at(final LocalDate date, final int hour, final int minute, final ZoneId zone) {
		return ZonedDateTime.of(date, LocalTime.of(hour, minute), zone).toInstant().toEpochMilli();
	}

	public static int hour(final long epochMs, final ZoneId zone) {
		return Instant.ofEpochMilli(epochMs).atZone(zone).getHour();
	}

	public static int minute(final long epochMs, final ZoneId zone) {
		return Instant.ofEpochMilli(epochMs).atZone(zone).getMinute();
	}

	/** {@code Mon 12 Oct 14:30}. */
	public static String format(final long epochMs, final ZoneId zone) {
		ZonedDateTime t = Instant.ofEpochMilli(epochMs).atZone(zone);
		return DAY.format(t) + " " + TIME.format(t);
	}

	/** {@code Mon 12 Oct}. */
	public static String formatDay(final LocalDate date) {
		return DAY.format(date);
	}

	/** {@code 14:30}. */
	public static String formatTime(final long epochMs, final ZoneId zone) {
		return TIME.format(Instant.ofEpochMilli(epochMs).atZone(zone));
	}

	/** Parses {@code yyyy-mm-dd}, or null. */
	public static @Nullable LocalDate parseDate(final String text) {
		try {
			return LocalDate.parse(text.trim());
		} catch (DateTimeParseException e) {
			return null;
		}
	}
}
