package dev.minevibe.client.org.calendar;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

/** CalendarScreen's add/edit form: validation, the {@code calendar.put} it builds, and editing existing events. */
class CalendarFormTest {
	private static final ZoneId BRUSSELS = ZoneId.of("Europe/Brussels");

	private static CalendarForm task() {
		CalendarForm f = new CalendarForm();
		f.title = "Farm wheat";
		f.assignees.add("bram");
		f.gameDay = 3;
		f.hour = 6;
		f.task = "Harvest and replant";
		return f;
	}

	private static void assertValidPut(final Org.CalendarPut put) {
		assertDoesNotThrow(() -> ProtocolCodec.encode(Org.CALENDAR_PUT, put, "m-1", null), "the schema accepts " + put);
	}

	@Test
	void aNewEventStartsAtTheNextWholeHour() {
		CalendarForm f = CalendarForm.blank(GameClock.at(4, 14, 20), 0, BRUSSELS);
		assertEquals(4, f.gameDay);
		assertEquals(15, f.hour);
		assertEquals(0, f.minute);
		CalendarForm late = CalendarForm.blank(GameClock.at(4, 5, 30), 0, BRUSSELS);
		assertEquals(5, late.gameDay, "05:30 on day 4 is followed by 06:00 on day 5");
		assertEquals(6, late.hour);
	}

	@Test
	void aGoodTaskBuildsASchemaValidPut() {
		CalendarForm f = task();
		assertEquals(List.of(), f.validate());
		Org.CalendarPut put = f.toPut(BRUSSELS);
		assertValidPut(put);
		assertEquals(GameClock.at(3, 6, 0), put.at());
		assertEquals("bram", put.assignees().getAsJsonArray().get(0).getAsString());
		assertNull(put.eventId());
		assertNull(put.tz(), "game-clock events carry no zone");
		assertNull(put.recurrence().n());
	}

	@Test
	void everyKindClockAndRepeatComboThatValidatesAlsoPassesTheSchema() {
		for (String kind : CalendarForm.KINDS) {
			for (String clock : List.of("game", "real")) {
				for (String repeat : CalendarForm.RECURRENCES) {
					CalendarForm f = task();
					f.kind = kind;
					f.clock = clock;
					f.recurrence = repeat;
					f.everyNDays = 4;
					f.realDate = LocalDate.of(2026, 11, 2);
					f.tz = "Europe/Brussels";
					f.everyone = "meeting".equals(kind);
					if (f.validate().isEmpty()) {
						assertValidPut(f.toPut(BRUSSELS));
					} else {
						assertEquals("weekdays", repeat, kind + "/" + clock + "/" + repeat + ": " + f.validate());
						assertEquals("game", clock);
					}
				}
			}
		}
	}

	@Test
	void problemsAreNamed() {
		CalendarForm f = new CalendarForm();
		List<String> errors = f.validate();
		assertTrue(errors.contains("Give it a title"), errors.toString());
		assertTrue(errors.contains("Pick who it is for (or everyone)"), errors.toString());
		assertTrue(errors.contains("Say what the task is"), errors.toString());

		CalendarForm weekdaysOnGame = task();
		weekdaysOnGame.recurrence = "weekdays";
		assertEquals(List.of("Weekdays only work on the real clock"), weekdaysOnGame.validate());

		CalendarForm everyOne = task();
		everyOne.recurrence = "every_n_days";
		everyOne.everyNDays = 1;
		assertEquals(List.of("Every n days: n is 2 to 365"), everyOne.validate());

		CalendarForm badTitle = task();
		badTitle.title = "a".repeat(81);
		assertEquals(List.of("Title: at most 80 characters"), badTitle.validate());

		CalendarForm badDuration = task();
		badDuration.durationMin = 0;
		assertEquals(List.of("Duration: 1 to 1440 minutes"), badDuration.validate());

		CalendarForm badAgent = task();
		badAgent.assignees.add("no spaces");
		assertEquals(List.of("Not an agent id: no spaces"), badAgent.validate());

		CalendarForm reminder = task();
		reminder.kind = "reminder";
		reminder.task = "";
		assertEquals(List.of(), reminder.validate(), "a reminder needs no task text");
	}

	@Test
	void realClockEventsUseTheirZone() {
		CalendarForm f = task();
		f.clock = "real";
		f.realDate = LocalDate.of(2026, 10, 26);
		f.hour = 9;
		f.recurrence = "weekdays";
		f.tz = "Europe/Brussels";
		Org.CalendarPut put = f.toPut(ZoneId.of("UTC"));
		assertValidPut(put);
		assertEquals(RealClock.at(LocalDate.of(2026, 10, 26), 9, 0, BRUSSELS), put.at());
		assertEquals("Europe/Brussels", put.tz());
	}

	@Test
	void editingAnEventRoundTrips() throws IOException {
		String dir = System.getProperty("minevibe.protocolFixtures");
		Org.CalendarState state = ProtocolCodec.GSON.fromJson(
			Files.readString(Path.of(dir, "org", "calendar.state.json"), StandardCharsets.UTF_8), Org.CalendarState.class);
		for (Org.CalendarEvent event : state.events()) {
			CalendarForm form = CalendarForm.of(event, BRUSSELS);
			Org.CalendarPut put = form.toPut(BRUSSELS);
			assertEquals(event.id(), put.eventId());
			assertEquals(event.title(), put.title());
			assertEquals(event.kind(), put.kind());
			assertEquals(event.assignees(), put.assignees());
			assertEquals(event.clock(), put.clock());
			assertEquals(event.at() / 60_000, put.at() / 60_000, "the time survives to the minute: " + event.title());
			assertEquals(event.recurrence(), put.recurrence());
			assertEquals(event.durationMin(), put.durationMin());
			assertEquals(event.location(), put.location());
			assertEquals(event.catchUp(), put.catchUp());
			assertEquals(event.runWhileAway(), put.runWhileAway());
		}
	}

	@Test
	void everyoneSendsAll() {
		CalendarForm f = task();
		f.everyone = true;
		f.kind = "meeting";
		Org.CalendarPut put = f.toPut(BRUSSELS);
		assertInstanceOf(JsonPrimitive.class, put.assignees());
		assertEquals("all", put.assignees().getAsString());
		assertEquals(3, f.people(3));
		assertEquals(1 + 3 + 2 + 1, f.estimate(3).turnsPerOccurrence());
	}
}
