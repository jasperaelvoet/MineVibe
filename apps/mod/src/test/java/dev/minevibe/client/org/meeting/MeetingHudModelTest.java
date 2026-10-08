package dev.minevibe.client.org.meeting;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The meeting HUD's text from {@code meeting.state}. */
class MeetingHudModelTest {
	private static final Map<String, String> NAMES = Map.of("ada", "Ada", "bram", "Bram", "cleo", "Cleo");

	private static Org.MeetingState meeting(final String phase, final String speaker, final boolean quick, final List<Org.MeetingAttendee> attendees) {
		return new Org.MeetingState("mt-1", "Standup", phase, "ada", speaker, attendees, null, 0, 600_000, quick);
	}

	@Test
	void readsTheFixture() throws IOException {
		String dir = System.getProperty("minevibe.protocolFixtures");
		Org.MeetingState state = ProtocolCodec.GSON.fromJson(Files.readString(Path.of(dir, "org", "meeting.state.json"), StandardCharsets.UTF_8),
			Org.MeetingState.class);
		MeetingHudModel m = MeetingHudModel.of(state, state.startedAt(), id -> NAMES.getOrDefault(id, id));
		assertEquals(state.title(), m.title());
		assertFalse(m.attendance().isBlank());
		assertTrue(MeetingHudModel.isActive(state) == !"done".equals(state.phase()));
	}

	@Test
	void namesTheSpeakerAndCountsAttendance() {
		List<Org.MeetingAttendee> attendees = List.of(
			new Org.MeetingAttendee("ada", "seated", null),
			new Org.MeetingAttendee("bram", "seated", null),
			new Org.MeetingAttendee("cleo", "dialed_in", null),
			new Org.MeetingAttendee("dora", "coming", 30L),
			new Org.MeetingAttendee("eve", "dead", null));
		MeetingHudModel m = MeetingHudModel.of(meeting("updates", "bram", false, attendees), 120_000, id -> NAMES.getOrDefault(id, id));
		assertEquals("Updates", m.phase());
		assertEquals("Bram speaking", m.speaker());
		assertEquals("2 seated · 1 dialed in · 1 coming · 1 absent", m.attendance());
		assertEquals("8:00", m.timeLeft());
		assertEquals("You speaking", MeetingHudModel.of(meeting("floor", "player", false, attendees), 0, id -> id).speaker());
		assertEquals("Gathering the crew", MeetingHudModel.of(meeting("gathering", null, false, List.of()), 0, id -> id).speaker());
		assertEquals("nobody yet", MeetingHudModel.of(meeting("gathering", null, false, List.of()), 0, id -> id).attendance());
	}

	@Test
	void phasesAndTime() {
		assertEquals("Open floor (quick)", MeetingHudModel.phaseLabel("floor", true));
		assertEquals("Wrap-up", MeetingHudModel.phaseLabel("wrapup", false));
		assertEquals("Ended", MeetingHudModel.phaseLabel("done", true));
		assertEquals("0:00", MeetingHudModel.timeLeft(1_000, 5_000), "never negative");
		assertEquals("0:01", MeetingHudModel.timeLeft(1_500, 1_000), "rounds up");
		assertEquals("10:00", MeetingHudModel.timeLeft(600_000, 0));
		assertFalse(MeetingHudModel.isActive(null));
		assertFalse(MeetingHudModel.isActive(meeting("done", null, false, List.of())));
		assertTrue(MeetingHudModel.isActive(meeting("open", "ada", false, List.of())));
	}
}
