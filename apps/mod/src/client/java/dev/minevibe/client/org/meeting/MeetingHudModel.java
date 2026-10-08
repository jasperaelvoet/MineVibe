package dev.minevibe.client.org.meeting;

import dev.minevibe.bridge.msg.Org;
import java.util.Locale;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * The text of the meeting HUD (PLAN §6.6, §7.8): title, phase, who speaks, who is there, and the time left before the
 * 10-minute cap. Built from {@code meeting.state}; names come from the crew directory.
 */
public record MeetingHudModel(String title, String phase, String speaker, String attendance, String timeLeft) {
	public static boolean isActive(final Org.@Nullable MeetingState meeting) {
		return meeting != null && !"done".equals(meeting.phase());
	}

	public static MeetingHudModel of(final Org.MeetingState meeting, final long nowMs, final Function<String, String> names) {
		int seated = 0;
		int dialed = 0;
		int coming = 0;
		int away = 0;
		for (Org.MeetingAttendee a : meeting.attendees()) {
			switch (a.status()) {
				case "seated" -> seated++;
				case "dialed_in" -> dialed++;
				case "coming" -> coming++;
				default -> away++;
			}
		}
		StringBuilder attendance = new StringBuilder();
		append(attendance, seated, "seated");
		append(attendance, dialed, "dialed in");
		append(attendance, coming, "coming");
		append(attendance, away, "absent");
		if (attendance.isEmpty()) {
			attendance.append("nobody yet");
		}
		String speaker = meeting.speaker() == null ? (meeting.phase().equals("gathering") ? "Gathering the crew" : "Waiting")
			: who(meeting.speaker(), names) + " speaking";
		return new MeetingHudModel(
			meeting.title(),
			phaseLabel(meeting.phase(), meeting.quick()),
			speaker,
			attendance.toString(),
			timeLeft(meeting.endsBy(), nowMs));
	}

	private static void append(final StringBuilder sb, final int count, final String what) {
		if (count > 0) {
			if (!sb.isEmpty()) {
				sb.append(" · ");
			}
			sb.append(count).append(' ').append(what);
		}
	}

	private static String who(final String id, final Function<String, String> names) {
		return "player".equals(id) ? "You" : names.apply(id);
	}

	public static String phaseLabel(final String phase, final boolean quick) {
		String label = switch (phase) {
			case "gathering" -> "Gathering";
			case "open" -> "Opening";
			case "updates" -> "Updates";
			case "floor" -> "Open floor";
			case "wrapup" -> "Wrap-up";
			case "done" -> "Ended";
			default -> phase;
		};
		return quick && !"done".equals(phase) ? label + " (quick)" : label;
	}

	/** {@code m:ss} until {@code endsBy}, never negative. */
	public static String timeLeft(final long endsBy, final long nowMs) {
		long seconds = Math.max(0, (endsBy - nowMs + 999) / 1000);
		return String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60);
	}
}
