package dev.minevibe.client.org.calendar;

import dev.minevibe.bridge.msg.Org;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * When an event happens, for drawing it on a timeline. Past occurrences come from the event's log; upcoming ones are
 * projected from its recurrence, starting at {@code nextAt} (Node's next due time). Times are on the event's clock:
 * overworld ticks for {@code game}, epoch ms for {@code real}.
 */
public final class Occurrences {
	/** A drawn occurrence: {@code status} is a log status ({@code fired}, {@code done}, ...) or {@code upcoming}. */
	public record Occurrence(long at, String status) {
		public static final String UPCOMING = "upcoming";

		public boolean upcoming() {
			return UPCOMING.equals(this.status);
		}
	}

	private Occurrences() {
	}

	public static boolean isGame(final Org.CalendarEvent event) {
		return "game".equals(event.clock());
	}

	/** True while Node still schedules the event. */
	public static boolean isLive(final Org.CalendarEvent event) {
		return !"cancelled".equals(event.status()) && !"done".equals(event.status());
	}

	/** Every occurrence of {@code event} in {@code [from, to)}: the logged ones and up to {@code max} upcoming ones. */
	public static List<Occurrence> inWindow(final Org.CalendarEvent event, final long from, final long to, final ZoneId zone, final int max) {
		List<Occurrence> out = new ArrayList<>();
		for (Org.Occurrence logged : event.occurrences()) {
			if (logged.at() >= from && logged.at() < to) {
				out.add(new Occurrence(logged.at(), logged.status()));
			}
		}
		if (isLive(event) && event.nextAt() != null) {
			for (long at : upcoming(event, event.nextAt(), from, to, zone, max)) {
				final long t = at;
				if (out.stream().noneMatch(o -> o.at() == t)) {
					out.add(new Occurrence(at, Occurrence.UPCOMING));
				}
			}
		}
		out.sort((a, b) -> Long.compare(a.at(), b.at()));
		return out;
	}

	/**
	 * The due times of the series that starts at {@code start} and falls in {@code [from, to)}, at most {@code max}.
	 * Game clock: every {@code 24000 * n} ticks. Real clock: the same local time every day / n days / weekday, so DST
	 * never shifts it.
	 */
	public static List<Long> upcoming(final Org.CalendarEvent event, final long start, final long from, final long to, final ZoneId zone, final int max) {
		List<Long> out = new ArrayList<>();
		String kind = event.recurrence().kind();
		int n = "every_n_days".equals(kind) && event.recurrence().n() != null ? event.recurrence().n() : 1;
		if ("once".equals(kind)) {
			if (start >= from && start < to) {
				out.add(start);
			}
			return out;
		}
		if (isGame(event)) {
			long step = GameClock.TICKS_PER_DAY * n;
			long k = start >= from ? 0 : Math.ceilDiv(from - start, step);
			for (long at = start + k * step; at < to && out.size() < max; at += step) {
				out.add(at);
			}
			return out;
		}
		ZoneId tz = event.tz() != null ? RealClock.zone(event.tz()) : zone;
		ZonedDateTime first = Instant.ofEpochMilli(start).atZone(tz);
		boolean weekdays = "weekdays".equals(kind);
		// Real-clock series are short over any window we draw (days to weeks), so stepping day by day is cheap.
		int guard = 0;
		for (ZonedDateTime t = first; out.size() < max && guard < 4000; guard++) {
			long at = t.toInstant().toEpochMilli();
			if (at >= to) {
				break;
			}
			boolean weekend = t.getDayOfWeek() == DayOfWeek.SATURDAY || t.getDayOfWeek() == DayOfWeek.SUNDAY;
			if (at >= from && !(weekdays && weekend)) {
				out.add(at);
			}
			t = weekdays ? t.plusDays(1) : t.plusDays(n);
		}
		return out;
	}
}
