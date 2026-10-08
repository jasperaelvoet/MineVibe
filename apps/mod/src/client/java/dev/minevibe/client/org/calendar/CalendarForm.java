package dev.minevibe.client.org.calendar;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Types;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The add/edit form of CalendarScreen as plain data (PLAN §6.6): title, kind, assignees, clock, time, recurrence,
 * location, task, catch-up and run-while-away. {@link #validate()} checks what the schema checks and a bit more;
 * {@link #toPut} builds the {@code calendar.put} payload.
 */
public final class CalendarForm {
	public static final List<String> KINDS = List.of("task", "reminder", "meeting");
	public static final List<String> RECURRENCES = List.of("once", "daily", "every_n_days", "weekdays");
	public static final List<String> CATCH_UPS = List.of("skip", "once_late");
	public static final int TITLE_MAX = 80;
	public static final int LOCATION_MAX = 80;
	public static final int TASK_MAX = 2000;

	public @Nullable String eventId;
	public String title = "";
	public String kind = "task";
	public boolean everyone;
	public final Set<String> assignees = new LinkedHashSet<>();
	public String clock = "game";
	/** Game clock: the day and time. */
	public int gameDay = 1;
	public int hour = 8;
	public int minute = 0;
	/** Real clock: the date (the time is {@link #hour}:{@link #minute}). */
	public LocalDate realDate = LocalDate.of(2026, 1, 1);
	public @Nullable String tz;
	public String recurrence = "once";
	public int everyNDays = 2;
	public int durationMin = 30;
	public String location = "";
	public String task = "";
	public String catchUp = "skip";
	public boolean runWhileAway;

	/** A new event: the next whole hour on the game clock, for the whole crew if it is a meeting. */
	public static CalendarForm blank(final long gameNow, final long realNowMs, final ZoneId zone) {
		CalendarForm form = new CalendarForm();
		long next = (Math.floorDiv(gameNow, GameClock.TICKS_PER_HOUR) + 1) * GameClock.TICKS_PER_HOUR;
		form.gameDay = GameClock.day(next);
		form.hour = GameClock.hour(next);
		form.minute = 0;
		form.realDate = RealClock.date(realNowMs, zone);
		return form;
	}

	/** The form for editing {@code event}. */
	public static CalendarForm of(final Org.CalendarEvent event, final ZoneId hostZone) {
		CalendarForm form = new CalendarForm();
		form.eventId = event.id();
		form.title = event.title();
		form.kind = event.kind();
		JsonElement who = event.assignees();
		if (who != null && who.isJsonPrimitive() && "all".equals(who.getAsString())) {
			form.everyone = true;
		} else if (who != null && who.isJsonArray()) {
			for (JsonElement id : who.getAsJsonArray()) {
				form.assignees.add(id.getAsString());
			}
		}
		form.clock = event.clock();
		form.tz = event.tz();
		if ("game".equals(event.clock())) {
			form.gameDay = GameClock.day(event.at());
			form.hour = GameClock.hour(event.at());
			form.minute = GameClock.minute(event.at());
		} else {
			ZoneId zone = event.tz() != null ? RealClock.zone(event.tz()) : hostZone;
			form.realDate = RealClock.date(event.at(), zone);
			form.hour = RealClock.hour(event.at(), zone);
			form.minute = RealClock.minute(event.at(), zone);
		}
		form.recurrence = event.recurrence().kind();
		if (event.recurrence().n() != null) {
			form.everyNDays = event.recurrence().n();
		}
		form.durationMin = event.durationMin();
		form.location = event.location() == null ? "" : event.location();
		form.task = event.task() == null ? "" : event.task();
		form.catchUp = event.catchUp();
		form.runWhileAway = event.runWhileAway();
		return form;
	}

	/** Every problem with the form, in the order the fields appear; empty when it can be saved. */
	public List<String> validate() {
		List<String> errors = new ArrayList<>();
		String t = this.title.trim();
		if (t.isEmpty()) {
			errors.add("Give it a title");
		} else if (t.length() > TITLE_MAX) {
			errors.add("Title: at most " + TITLE_MAX + " characters");
		} else if (t.indexOf('\n') >= 0 || t.indexOf('\r') >= 0) {
			errors.add("Title: one line only");
		}
		if (!KINDS.contains(this.kind)) {
			errors.add("Kind: task, reminder or meeting");
		}
		if (!this.everyone && this.assignees.isEmpty()) {
			errors.add("Pick who it is for (or everyone)");
		}
		if (!this.everyone && this.assignees.size() > 16) {
			errors.add("At most 16 assignees");
		}
		for (String id : this.assignees) {
			if (!id.matches(Types.AGENT_ID_REGEX)) {
				errors.add("Not an agent id: " + id);
			}
		}
		if (!"game".equals(this.clock) && !"real".equals(this.clock)) {
			errors.add("Clock: game or real");
		}
		if ("game".equals(this.clock) && this.gameDay < 1) {
			errors.add("Day: 1 or later");
		}
		if (this.hour < 0 || this.hour > 23 || this.minute < 0 || this.minute > 59) {
			errors.add("Time: hh:mm");
		}
		if (!RECURRENCES.contains(this.recurrence)) {
			errors.add("Repeat: once, daily, every n days or weekdays");
		} else if ("weekdays".equals(this.recurrence) && !"real".equals(this.clock)) {
			errors.add("Weekdays only work on the real clock");
		} else if ("every_n_days".equals(this.recurrence) && (this.everyNDays < 2 || this.everyNDays > 365)) {
			errors.add("Every n days: n is 2 to 365");
		}
		if (this.durationMin < 1 || this.durationMin > 1440) {
			errors.add("Duration: 1 to 1440 minutes");
		}
		if (this.location.trim().length() > LOCATION_MAX) {
			errors.add("Location: at most " + LOCATION_MAX + " characters");
		}
		if (this.task.trim().length() > TASK_MAX) {
			errors.add("Task: at most " + TASK_MAX + " characters");
		}
		if ("task".equals(this.kind) && this.task.isBlank()) {
			errors.add("Say what the task is");
		}
		if (!CATCH_UPS.contains(this.catchUp)) {
			errors.add("Catch-up: skip or once late");
		}
		return errors;
	}

	/** The first due time on the form's clock (overworld ticks or epoch ms). */
	public long at(final ZoneId hostZone) {
		if ("game".equals(this.clock)) {
			return GameClock.at(Math.max(1, this.gameDay), this.hour, this.minute);
		}
		return RealClock.at(this.realDate, this.hour, this.minute, this.tz != null ? RealClock.zone(this.tz) : hostZone);
	}

	/** How many people the event involves ({@code crewSize} for everyone). */
	public int people(final int crewSize) {
		return this.everyone ? Math.max(1, crewSize) : Math.max(1, this.assignees.size());
	}

	public CostEstimator.Estimate estimate(final int crewSize) {
		return CostEstimator.estimate(this.kind, this.people(crewSize), this.clock, this.recurrence, this.everyNDays, false);
	}

	/** The {@code calendar.put} payload. Call {@link #validate()} first. */
	public Org.CalendarPut toPut(final ZoneId hostZone) {
		JsonElement who;
		if (this.everyone) {
			who = new JsonPrimitive("all");
		} else {
			JsonArray ids = new JsonArray();
			this.assignees.forEach(ids::add);
			who = ids;
		}
		String loc = this.location.trim();
		String what = this.task.trim();
		return new Org.CalendarPut(
			this.eventId,
			this.title.trim(),
			this.kind,
			who,
			this.clock,
			this.at(hostZone),
			"real".equals(this.clock) ? this.tz : null,
			new Org.Recurrence(this.recurrence, "every_n_days".equals(this.recurrence) ? this.everyNDays : null),
			this.durationMin,
			loc.isEmpty() ? null : loc,
			what.isEmpty() ? null : what,
			this.catchUp,
			this.runWhileAway);
	}
}
