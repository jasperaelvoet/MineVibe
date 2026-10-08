package dev.minevibe.client.org;

import dev.minevibe.bridge.msg.Org;
import java.time.ZoneId;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * What the client knows about the Codex, the calendar and the running meeting: the latest {@code codex.index},
 * {@code calendar.state} and {@code meeting.state} pushes (Node re-sends all of them after every {@code hello.ok}, so a
 * reconnect is a full resync). Screens read it every frame and redraw when {@link #version()} moves. Client thread
 * only.
 */
public final class OrgClientState {
	private static final OrgClientState INSTANCE = new OrgClientState();

	private List<Org.CodexPageMeta> codexPages = List.of();
	private boolean codexTruncated;
	private boolean codexKnown;
	private List<Org.CalendarEvent> events = List.of();
	private String tz = ZoneId.systemDefault().getId();
	private boolean calendarKnown;
	private Org.@Nullable MeetingState meeting;
	private int version;
	private final CrewDirectory crew = new CrewDirectory();

	/** The client's state. Tests make their own with the constructor. */
	public static OrgClientState get() {
		return INSTANCE;
	}

	public OrgClientState() {
	}

	public void onCodexIndex(final Org.CodexIndex index) {
		this.codexPages = List.copyOf(index.pages());
		this.codexTruncated = index.truncated();
		this.codexKnown = true;
		this.version++;
	}

	public void onCalendarState(final Org.CalendarState state) {
		this.events = List.copyOf(state.events());
		this.tz = state.tz();
		this.calendarKnown = true;
		this.version++;
	}

	/** A meeting changed; {@code phase: done} clears it. */
	public void onMeetingState(final Org.MeetingState state) {
		this.meeting = "done".equals(state.phase()) ? null : state;
		this.version++;
	}

	/** The world was left: its meeting is over (Node re-sends the Codex and calendar when they change). */
	public void forgetMeeting() {
		if (this.meeting != null) {
			this.meeting = null;
			this.version++;
		}
	}

	/** Forget everything. */
	public void clear() {
		this.codexPages = List.of();
		this.codexTruncated = false;
		this.codexKnown = false;
		this.events = List.of();
		this.calendarKnown = false;
		this.meeting = null;
		this.version++;
	}

	public void touch() {
		this.version++;
	}

	public List<Org.CodexPageMeta> codexPages() {
		return this.codexPages;
	}

	public boolean codexTruncated() {
		return this.codexTruncated;
	}

	public boolean codexKnown() {
		return this.codexKnown;
	}

	public List<Org.CalendarEvent> events() {
		return this.events;
	}

	public boolean calendarKnown() {
		return this.calendarKnown;
	}

	public String tz() {
		return this.tz;
	}

	public ZoneId zone() {
		return dev.minevibe.client.org.calendar.RealClock.zone(this.tz);
	}

	public Org.@Nullable MeetingState meeting() {
		return this.meeting;
	}

	public CrewDirectory crew() {
		return this.crew;
	}

	public int version() {
		return this.version;
	}

	public Org.@Nullable CalendarEvent event(final String eventId) {
		for (Org.CalendarEvent e : this.events) {
			if (e.id().equals(eventId)) {
				return e;
			}
		}
		return null;
	}
}
