package dev.minevibe.client.org.calendar;

import java.util.Locale;

/**
 * The rough cost CalendarScreen shows next to a meeting or a recurring task (PLAN §6.6), in brain turns: what an
 * event costs on the player's Claude subscription. It is deliberately simple and errs high.
 *
 * <ul>
 *   <li><b>Reminder:</b> 0 turns (a bubble and a toast, no LLM).</li>
 *   <li><b>Task:</b> {@value #TASK_TURNS_PER_ASSIGNEE} turns per assignee (accept, work, report).</li>
 *   <li><b>Meeting:</b> 1 opening turn, one update per attendee (a quick standup only gives agents with blockers a
 *       turn: about a third), up to 2 floor turns (none when quick), 1 wrap-up turn.</li>
 *   <li><b>How often:</b> a game day is 20 real minutes, so a daily game-clock event runs 3 times an hour while the
 *       world is open; real-clock events count per real day.</li>
 * </ul>
 */
public final class CostEstimator {
	public static final int TASK_TURNS_PER_ASSIGNEE = 4;
	/** A rough average turn on a cached session: prompt mostly cached, a short answer. */
	public static final int TOKENS_PER_TURN = 3_000;
	public static final double GAME_DAYS_PER_REAL_HOUR = 3.0;

	/** Turns per occurrence, how often it happens, and the line CalendarScreen shows. */
	public record Estimate(int turnsPerOccurrence, double occurrencesPerPeriod, String period, String text) {
		public double turnsPerPeriod() {
			return this.turnsPerOccurrence * this.occurrencesPerPeriod;
		}
	}

	private CostEstimator() {
	}

	/**
	 * @param kind task, reminder or meeting
	 * @param people assignees (task) or attendees (meeting); for "everyone" pass the crew size
	 * @param clock game or real
	 * @param recurrence once, daily, every_n_days or weekdays
	 * @param n the {@code every_n_days} interval (ignored otherwise)
	 * @param quick a quick standup (meetings only)
	 */
	public static Estimate estimate(final String kind, final int people, final String clock, final String recurrence, final int n, final boolean quick) {
		int who = Math.max(1, people);
		int turns = switch (kind) {
			case "reminder" -> 0;
			case "meeting" -> 1 + (quick ? (who + 2) / 3 : who) + (quick ? 0 : 2) + 1;
			default -> TASK_TURNS_PER_ASSIGNEE * who;
		};
		boolean game = "game".equals(clock);
		String period = game ? "hour of play" : "day";
		double perPeriod = switch (recurrence) {
			case "daily" -> game ? GAME_DAYS_PER_REAL_HOUR : 1.0;
			case "every_n_days" -> (game ? GAME_DAYS_PER_REAL_HOUR : 1.0) / Math.max(2, n);
			case "weekdays" -> 5.0 / 7.0;
			default -> 0.0;
		};
		String text;
		if (turns == 0) {
			text = "Free: reminders use no brain turns";
		} else if (perPeriod == 0.0) {
			text = String.format(Locale.ROOT, "About %d brain turns (~%s tokens)", turns, tokens(turns));
		} else {
			double total = turns * perPeriod;
			text = String.format(Locale.ROOT, "About %d turns each, ~%s turns per %s (~%s tokens)", turns, oneDecimal(total), period, tokens(Math.round(total)));
		}
		return new Estimate(turns, perPeriod, period, text);
	}

	private static String tokens(final long turns) {
		long tokens = turns * TOKENS_PER_TURN;
		return tokens >= 1_000_000 ? oneDecimal(tokens / 1_000_000.0) + "M" : tokens >= 1_000 ? Math.round(tokens / 1_000.0) + "k" : Long.toString(tokens);
	}

	private static String oneDecimal(final double value) {
		return value == Math.rint(value) ? Long.toString(Math.round(value)) : String.format(Locale.ROOT, "%.1f", value);
	}
}
