package dev.minevibe.client.org.calendar;

import com.google.gson.JsonElement;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.client.org.CrewDirectory;
import dev.minevibe.client.org.OrgBackend;
import dev.minevibe.client.org.OrgClient;
import dev.minevibe.client.org.OrgClientState;
import dev.minevibe.client.org.OrgUi;
import dev.minevibe.client.org.meeting.MeetingHudModel;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.CycleButton;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

/**
 * CalendarScreen (PLAN §6.6, §7.8), opened by a wall calendar or the handheld calendar.
 *
 * <ul>
 *   <li><b>Day strip.</b> Game days (06:00 to 06:00) or, on the Real time tab, calendar days in the host zone. The
 *       timeline shows each occurrence as a chip coloured by assignee, stacked in lanes; the list below names them.</li>
 *   <li><b>Event.</b> Clicking one shows its details, its occurrence log (last 20) and a cost estimate, with Edit,
 *       Skip next, Cancel and (meetings) Start now.</li>
 *   <li><b>Form.</b> Title, kind, assignees, clock, day/date and time, repeat, duration, location, task, catch-up and
 *       run-while-away, with a live cost estimate; saved as {@code calendar.put}.</li>
 *   <li><b>Start meeting now</b> first asks Node for each attendee's ETA ({@code meeting.start{preview}}), then starts.</li>
 *   <li>Orphaned real-clock events (their assignees died with the last world) are listed at the top for
 *       reassignment. Never pauses the game.</li>
 * </ul>
 */
public final class CalendarScreen extends Screen {
	private static final int LINE = 11;
	private static final int CHIP_H = 11;
	private static final int MAX_LANES = 4;
	private static final int STRIP_DAYS = 7;

	private enum Tab {
		GAME,
		REAL
	}

	private enum Overlay {
		NONE,
		FORM,
		MEETING
	}

	private final OrgClientState state = OrgClientState.get();
	private final OrgBackend backend = OrgClient.backend();
	private final OrgUi.Hits hits = new OrgUi.Hits();

	private Tab tab = Tab.GAME;
	private int gameDay = -1;
	private @Nullable LocalDate realDay;
	private @Nullable String selectedId;
	private Overlay overlay = Overlay.NONE;
	private @Nullable CalendarForm form;
	private List<String> formErrors = List.of();
	private @Nullable List<Org.Eta> etas;
	private @Nullable String meetingEventId;
	private String meetingTitle = "Meeting";
	private @Nullable JsonElement meetingAttendees;
	private boolean busy;
	private String status = "";
	private int statusColour = OrgUi.GREY;
	private int seenVersion = -1;
	private boolean meetingWasActive;
	private int listScroll;
	private int logScroll;

	private int x0;
	private int y0;
	private int x1;
	private int y1;
	private int contentTop;
	private int detailX0;
	private int listTop;
	private int listBottom;
	private int logTop;
	private int logBottom;
	private int fx0;
	private int fy0;
	private int fx1;
	private int fy1;
	private int assigneeRowY;

	public CalendarScreen() {
		super(Component.literal("Calendar"));
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	private long gameNow() {
		return this.minecraft != null && this.minecraft.level != null ? Math.max(0, this.minecraft.level.getOverworldClockTime()) : 0;
	}

	private ZoneId zone() {
		return this.state.zone();
	}

	@Override
	protected void init() {
		if (this.gameDay < 1) {
			this.gameDay = GameClock.day(this.gameNow());
		}
		if (this.realDay == null) {
			this.realDay = RealClock.date(System.currentTimeMillis(), this.zone());
		}
		this.x0 = 6;
		this.y0 = 6;
		this.x1 = this.width - 6;
		this.y1 = this.height - 6;
		this.meetingWasActive = MeetingHudModel.isActive(this.state.meeting());

		// With an overlay open only its own widgets exist, so nothing behind it can be clicked or drawn on top.
		boolean base = this.overlay == Overlay.NONE;
		int bw = 96;
		if (base) {
			this.addRenderableWidget(Button.builder(Component.literal("Start meeting now"), b -> this.openMeeting(null, "Meeting", null))
				.bounds(this.x1 - 6 - bw, this.y0 + 4, bw, 16).build()).active = !this.meetingWasActive;
			this.addRenderableWidget(Button.builder(Component.literal("+ Event"), b -> this.openForm(null))
				.bounds(this.x1 - 6 - bw - 4 - 56, this.y0 + 4, 56, 16).build());
		}

		int y = this.y0 + 34;
		Org.MeetingState meeting = this.state.meeting();
		if (MeetingHudModel.isActive(meeting)) {
			if (base) {
				this.addRenderableWidget(Button.builder(Component.literal("End meeting"), b -> this.endMeeting(meeting.meetingId()))
					.bounds(this.x1 - 6 - 80, y + 1, 80, 14).build());
			}
			y += 18;
		}
		if (!this.orphans().isEmpty()) {
			y += 14;
		}
		this.contentTop = y + 22;
		this.detailX0 = this.selected() != null ? this.x0 + (this.x1 - this.x0) * 3 / 5 : this.x1;
		if (this.overlay == Overlay.NONE && this.selected() != null) {
			this.initDetailButtons(this.selected());
		}
		if (this.overlay == Overlay.FORM && this.form != null) {
			this.initForm(this.form);
		}
		if (this.overlay == Overlay.MEETING) {
			this.initMeetingDialog();
		}
	}

	private void initDetailButtons(final Org.CalendarEvent event) {
		int dx0 = this.detailX0 + 6;
		int w = (this.x1 - 6 - dx0 - 4) / 2;
		int y = this.y1 - 6 - 16;
		boolean meeting = "meeting".equals(event.kind());
		boolean live = Occurrences.isLive(event);
		this.addRenderableWidget(Button.builder(Component.literal("Edit"), b -> this.openForm(event)).bounds(dx0, y - 18, w, 16).build()).active = !this.busy;
		if (meeting) {
			this.addRenderableWidget(Button.builder(Component.literal("Start now"), b -> this.openMeeting(event.id(), event.title(), event.assignees()))
				.bounds(dx0 + w + 4, y - 18, w, 16).build()).active = !this.busy && !MeetingHudModel.isActive(this.state.meeting());
		}
		boolean once = "once".equals(event.recurrence().kind());
		this.addRenderableWidget(Button.builder(Component.literal("Skip next"), b -> this.cancel(event, "next")).bounds(dx0, y, w, 16).build())
			.active = !this.busy && live && !once && event.nextAt() != null;
		this.addRenderableWidget(Button.builder(Component.literal(once ? "Cancel" : "Cancel all"), b -> this.cancel(event, "all"))
			.bounds(dx0 + w + 4, y, w, 16).build()).active = !this.busy && live;
	}

	// ------------------------------------------------------------------ the form

	private void initForm(final CalendarForm f) {
		int w = Math.min(this.width - 30, 400);
		int h = Math.min(this.height - 24, 262);
		this.fx0 = (this.width - w) / 2;
		this.fy0 = (this.height - h) / 2;
		this.fx1 = this.fx0 + w;
		this.fy1 = this.fy0 + h;
		int x = this.fx0 + 8;
		int inner = w - 16;
		int y = this.fy0 + 20;

		EditBox title = this.addRenderableWidget(new EditBox(this.font, x, y, inner, 14, Component.literal("Title")));
		title.setHint(Component.literal("What is it? (one line)").withStyle(ChatFormatting.GRAY));
		title.setMaxLength(CalendarForm.TITLE_MAX);
		title.setValue(f.title);
		title.setResponder(t -> {
			f.title = t;
			this.revalidate();
		});
		y += 18;

		int third = (inner - 8) / 3;
		this.addRenderableWidget(CycleButton.builder((String k) -> Component.literal(cap(k)), f.kind).withValues(CalendarForm.KINDS)
			.create(x, y, third, 16, Component.literal("Kind"), (b, v) -> {
				f.kind = v;
				if ("meeting".equals(v) && f.location.isBlank()) {
					f.location = "meeting_table";
				}
				this.rebuildWidgets();
			}));
		this.addRenderableWidget(CycleButton.builder((String c) -> Component.literal("game".equals(c) ? "Game clock" : "Real clock"), f.clock)
			.withValues(List.of("game", "real"))
			.create(x + third + 4, y, third, 16, Component.literal("Clock"), (b, v) -> {
				f.clock = v;
				if ("weekdays".equals(f.recurrence) && "game".equals(v)) {
					f.recurrence = "daily";
				}
				this.rebuildWidgets();
			}));
		List<String> repeats = "real".equals(f.clock) ? CalendarForm.RECURRENCES : List.of("once", "daily", "every_n_days");
		this.addRenderableWidget(CycleButton.builder((String r) -> Component.literal(repeatLabel(r, f.everyNDays)), f.recurrence).withValues(repeats)
			.create(x + 2 * (third + 4), y, inner - 2 * (third + 4), 16, Component.literal("Repeat"), (b, v) -> {
				f.recurrence = v;
				this.rebuildWidgets();
			}));
		y += 20;

		int lx = x;
		if ("game".equals(f.clock)) {
			lx += this.font.width("Day ") + 2;
			EditBox day = this.addRenderableWidget(new EditBox(this.font, lx, y, 34, 14, Component.literal("Day")));
			day.setValue(Integer.toString(f.gameDay));
			day.setMaxLength(6);
			day.setResponder(t -> {
				f.gameDay = parseInt(t, -1);
				this.revalidate();
			});
			lx += 38;
		} else {
			EditBox date = this.addRenderableWidget(new EditBox(this.font, lx, y, 72, 14, Component.literal("Date")));
			date.setHint(Component.literal("yyyy-mm-dd").withStyle(ChatFormatting.GRAY));
			date.setValue(f.realDate.toString());
			date.setMaxLength(10);
			date.setResponder(t -> {
				LocalDate parsed = RealClock.parseDate(t);
				if (parsed != null) {
					f.realDate = parsed;
				}
				this.formErrors = parsed == null ? List.of("Date: yyyy-mm-dd") : f.validate();
			});
			lx += 76;
		}
		lx += this.font.width("at ") + 2;
		EditBox time = this.addRenderableWidget(new EditBox(this.font, lx, y, 40, 14, Component.literal("Time")));
		time.setValue(String.format(Locale.ROOT, "%02d:%02d", f.hour, f.minute));
		time.setMaxLength(5);
		time.setResponder(t -> {
			int[] hm = GameClock.parseTime(t);
			if (hm != null) {
				f.hour = hm[0];
				f.minute = hm[1];
			}
			this.formErrors = hm == null ? List.of("Time: hh:mm") : f.validate();
		});
		lx += 44;
		if ("every_n_days".equals(f.recurrence)) {
			lx += this.font.width("every ") + 2;
			EditBox n = this.addRenderableWidget(new EditBox(this.font, lx, y, 28, 14, Component.literal("Every n days")));
			n.setValue(Integer.toString(f.everyNDays));
			n.setMaxLength(3);
			n.setResponder(t -> {
				f.everyNDays = parseInt(t, 0);
				this.revalidate();
			});
			lx += 32 + this.font.width(" days") + 4;
		}
		int durX = this.fx1 - 8 - 34 - this.font.width(" min");
		EditBox duration = this.addRenderableWidget(new EditBox(this.font, durX, y, 34, 14, Component.literal("Duration")));
		duration.setValue(Integer.toString(f.durationMin));
		duration.setMaxLength(4);
		duration.setResponder(t -> {
			f.durationMin = parseInt(t, 0);
			this.revalidate();
		});
		y += 18;

		this.assigneeRowY = y + 10;
		y += 10 + this.assigneeRows(f, inner) * 13 + 4;

		int locW = inner / 2 - 2;
		EditBox location = this.addRenderableWidget(new EditBox(this.font, x, y, locW, 14, Component.literal("Location")));
		location.setHint(Component.literal("where: place, pc:<id>, meeting_table").withStyle(ChatFormatting.GRAY));
		location.setMaxLength(CalendarForm.LOCATION_MAX);
		location.setValue(f.location);
		location.setResponder(t -> {
			f.location = t;
			this.revalidate();
		});
		int qx = x + locW + 4;
		int qw = (inner - locW - 8) / 2;
		this.addRenderableWidget(CycleButton.builder((String c) -> Component.literal("skip".equals(c) ? "If missed: skip" : "If missed: run late"), f.catchUp)
			.withValues(CalendarForm.CATCH_UPS)
			.displayOnlyValue()
			.create(qx, y - 1, qw, 16, Component.literal("Catch-up"), (b, v) -> f.catchUp = v));
		this.addRenderableWidget(CycleButton.builder((Boolean on) -> Component.literal(on ? "Runs if AFK" : "Waits if AFK"), f.runWhileAway)
			.withValues(List.of(false, true))
			.displayOnlyValue()
			.create(qx + qw + 4, y - 1, inner - locW - 4 - qw - 4, 16, Component.literal("Away"), (b, v) -> f.runWhileAway = v));
		y += 18;

		int taskBottom = this.fy1 - 44;
		MultiLineEditBox task = MultiLineEditBox.builder().setX(x).setY(y)
			.setPlaceholder(Component.literal("reminder".equals(f.kind) ? "Note (optional)" : "meeting".equals(f.kind) ? "Agenda (optional)" : "What should they do?")
				.withStyle(ChatFormatting.GRAY))
			.build(this.font, inner, Math.max(24, taskBottom - y), Component.literal("Task"));
		task.setCharacterLimit(CalendarForm.TASK_MAX);
		task.setValue(f.task);
		task.setValueListener(t -> {
			f.task = t;
			this.revalidate();
		});
		this.addRenderableWidget(task);

		int half = (inner - 4) / 2;
		this.addRenderableWidget(Button.builder(Component.literal(f.eventId == null ? "Add to calendar" : "Save changes"), b -> this.saveForm())
			.bounds(x, this.fy1 - 22, half, 16).build()).active = !this.busy;
		this.addRenderableWidget(Button.builder(Component.literal("Cancel"), b -> this.closeOverlay()).bounds(x + half + 4, this.fy1 - 22, inner - half - 4, 16).build());
		this.revalidate();
	}

	/** How many rows the assignee chips take (they wrap). */
	private int assigneeRows(final CalendarForm f, final int inner) {
		int rows = 1;
		int x = this.font.width("For: ") + 4;
		for (String label : this.assigneeLabels(f)) {
			int w = this.font.width(label) + 10;
			if (x + w > inner) {
				rows++;
				x = 0;
			}
			x += w + 3;
		}
		return rows;
	}

	private List<String> assigneeLabels(final CalendarForm f) {
		List<String> labels = new ArrayList<>();
		labels.add("Everyone");
		for (String id : this.assigneeIds(f)) {
			labels.add(this.state.crew().name(id));
		}
		return labels;
	}

	/** The crew (alive) plus anyone already on the event (a dead or unknown agent can be unticked). */
	private List<String> assigneeIds(final CalendarForm f) {
		List<String> ids = new ArrayList<>();
		for (CrewDirectory.Member m : this.state.crew().alive()) {
			ids.add(m.agentId());
		}
		for (String id : f.assignees) {
			if (!ids.contains(id)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private void revalidate() {
		CalendarForm f = this.form;
		this.formErrors = f == null ? List.of() : f.validate();
	}

	private void openForm(final Org.@Nullable CalendarEvent event) {
		this.form = event == null ? CalendarForm.blank(this.gameNow(), System.currentTimeMillis(), this.zone()) : CalendarForm.of(event, this.zone());
		if (event == null) {
			if (this.tab == Tab.REAL) {
				this.form.clock = "real";
				this.form.realDate = this.realDay;
			} else if (this.gameDay > GameClock.day(this.gameNow())) {
				this.form.gameDay = this.gameDay;
			}
		}
		this.overlay = Overlay.FORM;
		this.formErrors = List.of();
		this.rebuildWidgets();
	}

	/** The open add/edit form, or null. */
	public @Nullable CalendarForm form() {
		return this.overlay == Overlay.FORM ? this.form : null;
	}

	/** Saves the open form (as its save button does). */
	public void saveForm() {
		CalendarForm f = this.form;
		if (f == null) {
			return;
		}
		this.formErrors = f.validate();
		if (!this.formErrors.isEmpty()) {
			return;
		}
		Org.CalendarPut put = f.toPut(this.zone());
		this.busy = true;
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.calendarPut(put), result -> {
			this.busy = false;
			this.selectedId = result.eventId();
			this.setStatus(f.eventId == null ? "Added \"" + put.title() + "\"" : "Saved", OrgUi.GREEN);
			this.closeOverlay();
		}, error -> {
			this.busy = false;
			this.formErrors = List.of(OrgClient.describe(error));
			this.rebuildIfOpen();
		});
	}

	private void closeOverlay() {
		this.overlay = Overlay.NONE;
		this.form = null;
		this.etas = null;
		this.formErrors = List.of();
		this.rebuildIfOpen();
	}

	// ------------------------------------------------------------------ meetings

	private void openMeeting(final @Nullable String eventId, final String title, final @Nullable JsonElement attendees) {
		this.meetingEventId = eventId;
		this.meetingTitle = title;
		this.meetingAttendees = attendees;
		this.etas = null;
		this.overlay = Overlay.MEETING;
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.meetingStart(new Org.MeetingStart(eventId, eventId == null ? title : null, eventId == null ? attendees : null, true)), result -> {
			this.etas = result.etas();
			this.rebuildIfOpen();
		}, error -> {
			this.etas = List.of();
			this.setStatus(OrgClient.describe(error), OrgUi.RED);
			this.rebuildIfOpen();
		});
	}

	private void initMeetingDialog() {
		int w = Math.min(this.width - 40, 260);
		int h = 70 + 11 * Math.max(1, this.etas == null ? 1 : this.etas.size());
		this.fx0 = (this.width - w) / 2;
		this.fy0 = (this.height - h) / 2;
		this.fx1 = this.fx0 + w;
		this.fy1 = this.fy0 + h;
		int half = (w - 20) / 2;
		this.addRenderableWidget(Button.builder(Component.literal("Start"), b -> this.startMeeting()).bounds(this.fx0 + 8, this.fy1 - 22, half, 16).build())
			.active = this.etas != null && !this.busy;
		this.addRenderableWidget(Button.builder(Component.literal("Cancel"), b -> this.closeOverlay()).bounds(this.fx0 + 12 + half, this.fy1 - 22, half, 16).build());
	}

	private void startMeeting() {
		this.busy = true;
		this.rebuildWidgets();
		String eventId = this.meetingEventId;
		OrgClient.whenDone(this.backend.meetingStart(new Org.MeetingStart(eventId, eventId == null ? this.meetingTitle : null,
			eventId == null ? this.meetingAttendees : null, false)), result -> {
				this.busy = false;
				this.setStatus("Meeting called: the crew is on its way", OrgUi.GREEN);
				this.closeOverlay();
				this.onClose();
			}, error -> {
				this.busy = false;
				this.setStatus(OrgClient.describe(error), OrgUi.RED);
				this.closeOverlay();
			});
	}

	private void endMeeting(final String meetingId) {
		OrgClient.whenDone(this.backend.meetingEnd(meetingId), ok -> this.setStatus("Meeting ended", OrgUi.GREY),
			error -> this.setStatus(OrgClient.describe(error), OrgUi.RED));
	}

	// ------------------------------------------------------------------ other actions

	private void cancel(final Org.CalendarEvent event, final String scope) {
		this.busy = true;
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.calendarCancel(new Org.CalendarCancel(event.id(), scope)), ok -> {
			this.busy = false;
			this.setStatus("next".equals(scope) ? "Skipped the next \"" + event.title() + "\"" : "Cancelled \"" + event.title() + "\"", OrgUi.GREY);
			this.rebuildIfOpen();
		}, error -> {
			this.busy = false;
			this.setStatus(OrgClient.describe(error), OrgUi.RED);
			this.rebuildIfOpen();
		});
	}

	/** Shows the real-time tab ({@code true}) or the game days ({@code false}). */
	public void showRealTime(final boolean real) {
		this.tab = real ? Tab.REAL : Tab.GAME;
		this.listScroll = 0;
	}

	/** Opens the add form for a new event. */
	public void newEvent() {
		this.openForm(null);
	}

	/** Shows {@code eventId}'s details (null hides them). */
	public void select(final @Nullable String eventId) {
		this.selectedId = eventId;
		this.logScroll = 0;
		this.rebuildWidgets();
	}

	private Org.@Nullable CalendarEvent selected() {
		return this.selectedId == null ? null : this.state.event(this.selectedId);
	}

	private List<Org.CalendarEvent> orphans() {
		return this.state.events().stream().filter(e -> "orphaned".equals(e.status())).toList();
	}

	private void setStatus(final String text, final int colour) {
		this.status = text;
		this.statusColour = colour;
	}

	private void rebuildIfOpen() {
		if (this.minecraft != null && this.minecraft.gui.screen() == this) {
			this.rebuildWidgets();
		}
	}

	@Override
	public void tick() {
		super.tick();
		// New pushes from Node: rebuild the buttons that depend on them (not while a form or dialog is open).
		if (this.seenVersion != this.state.version() && this.overlay == Overlay.NONE) {
			this.seenVersion = this.state.version();
			this.rebuildWidgets();
		}
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean mouseClicked(final MouseButtonEvent event, final boolean doubleClick) {
		if (super.mouseClicked(event, doubleClick)) {
			return true;
		}
		return this.hits.click(event.x(), event.y());
	}

	@Override
	public boolean mouseScrolled(final double x, final double y, final double scrollX, final double scrollY) {
		if (this.overlay == Overlay.NONE && OrgUi.inside(x, y, this.x0, this.listTop, this.detailX0, this.listBottom)) {
			this.listScroll = Math.max(0, this.listScroll - (int)Math.signum(scrollY) * LINE);
			return true;
		}
		if (this.overlay == Overlay.NONE && OrgUi.inside(x, y, this.detailX0, this.logTop, this.x1, this.logBottom)) {
			this.logScroll = Math.max(0, this.logScroll - (int)Math.signum(scrollY) * LINE);
			return true;
		}
		return super.mouseScrolled(x, y, scrollX, scrollY);
	}

	// ------------------------------------------------------------------ drawing

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		this.hits.clear();
		OrgUi.panel(g, this.x0, this.y0, this.x1, this.y1, OrgUi.DARK, OrgUi.BORDER);
		this.drawHeader(g);
		int y = this.y0 + 34;
		y = this.drawBanners(g, y);
		this.drawStrip(g, y + 2);
		if (this.overlay == Overlay.NONE) {
			this.drawDay(g, mouseX, mouseY);
			Org.CalendarEvent event = this.selected();
			if (event != null) {
				this.drawDetail(g, event);
			}
		}
		if (this.overlay != Overlay.NONE) {
			g.fill(0, 0, this.width, this.height, 0x80000000);
			if (this.overlay == Overlay.FORM && this.form != null) {
				this.drawForm(g, this.form);
			} else if (this.overlay == Overlay.MEETING) {
				this.drawMeetingDialog(g);
			}
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	private void drawHeader(final GuiGraphicsExtractor g) {
		g.text(this.font, Component.literal("Calendar").withStyle(ChatFormatting.BOLD), this.x0 + 8, this.y0 + 8, OrgUi.WHITE, true);
		int tx = this.x0 + 8 + this.font.width("Calendar") + 16;
		for (Tab t : Tab.values()) {
			String label = t == Tab.GAME ? "Game days" : "Real time";
			int w = this.font.width(label) + 10;
			boolean on = t == this.tab;
			OrgUi.panel(g, tx, this.y0 + 5, tx + w, this.y0 + 19, on ? 0xFF3A5068 : OrgUi.PANEL, on ? OrgUi.ACCENT : OrgUi.BORDER);
			g.text(this.font, label, tx + 5, this.y0 + 8, on ? OrgUi.WHITE : OrgUi.GREY, false);
			if (this.overlay == Overlay.NONE) {
				final Tab target = t;
				this.hits.add(tx, this.y0 + 5, tx + w, this.y0 + 19, () -> {
					this.tab = target;
					this.listScroll = 0;
				});
			}
			tx += w + 3;
		}
		long game = this.gameNow();
		ZoneId zone = this.zone();
		String now = "Now: " + GameClock.format(game) + "   ·   " + RealClock.format(System.currentTimeMillis(), zone) + " (" + zone.getId() + ")";
		g.text(this.font, OrgUi.clip(this.font, now, (this.x1 - this.x0) / 2 - 12), this.x0 + 8, this.y0 + 23, OrgUi.GREY, false);
		String statusText = !this.status.isEmpty() ? this.status : this.backend.online() ? "" : "Offline: changes need MineVibe";
		if (!statusText.isEmpty()) {
			String s = OrgUi.clip(this.font, statusText, (this.x1 - this.x0) / 2);
			g.text(this.font, s, this.x1 - 8 - this.font.width(s), this.y0 + 23, this.status.isEmpty() ? OrgUi.RED : this.statusColour, false);
		}
	}

	private int drawBanners(final GuiGraphicsExtractor g, final int top) {
		int y = top;
		Org.MeetingState meeting = this.state.meeting();
		if (MeetingHudModel.isActive(meeting)) {
			MeetingHudModel m = MeetingHudModel.of(meeting, System.currentTimeMillis(), this.state.crew()::name);
			OrgUi.panel(g, this.x0 + 6, y, this.x1 - 6, y + 16, 0xF0283A28, OrgUi.GREEN);
			String text = "Meeting: " + m.title() + " · " + m.phase() + " · " + m.speaker() + " · " + m.timeLeft() + " left";
			g.text(this.font, OrgUi.clip(this.font, text, this.x1 - this.x0 - 110), this.x0 + 12, y + 4, OrgUi.WHITE, false);
			y += 18;
		}
		List<Org.CalendarEvent> orphans = this.orphans();
		if (!orphans.isEmpty()) {
			OrgUi.panel(g, this.x0 + 6, y, this.x1 - 6, y + 12, 0xF03A2020, OrgUi.RED);
			String names = String.join(", ", orphans.stream().map(Org.CalendarEvent::title).limit(4).toList());
			String text = orphans.size() + (orphans.size() == 1 ? " event lost its" : " events lost their") + " assignees with the last world: " + names
				+ ". Click to reassign.";
			g.text(this.font, OrgUi.clip(this.font, text, this.x1 - this.x0 - 24), this.x0 + 12, y + 2, OrgUi.YELLOW, false);
			if (this.overlay == Overlay.NONE) {
				Org.CalendarEvent first = orphans.getFirst();
				this.hits.add(this.x0 + 6, y, this.x1 - 6, y + 12, () -> {
					this.selectedId = first.id();
					this.openForm(first);
				});
			}
			y += 14;
		}
		return y;
	}

	private void drawStrip(final GuiGraphicsExtractor g, final int y) {
		int stripW = this.x1 - this.x0 - 12;
		int pillW = Math.min(90, (stripW - 40) / STRIP_DAYS);
		int total = pillW * STRIP_DAYS + 4 * (STRIP_DAYS - 1);
		int sx = (this.x0 + this.x1 - total) / 2;
		boolean live = this.overlay == Overlay.NONE;
		// Arrows move the strip a day at a time.
		g.text(this.font, "◀", sx - 14, y + 3, OrgUi.WHITE, false);
		g.text(this.font, "▶", sx + total + 6, y + 3, OrgUi.WHITE, false);
		if (live) {
			this.hits.add(sx - 18, y, sx - 2, y + 14, () -> this.shiftDay(-1));
			this.hits.add(sx + total + 2, y, sx + total + 18, y + 14, () -> this.shiftDay(1));
		}
		long game = this.gameNow();
		LocalDate today = RealClock.date(System.currentTimeMillis(), this.zone());
		int firstGameDay = Math.max(1, this.gameDay - STRIP_DAYS / 2);
		for (int i = 0; i < STRIP_DAYS; i++) {
			int px = sx + i * (pillW + 4);
			String label;
			boolean on;
			boolean isToday;
			Runnable pick;
			int count;
			if (this.tab == Tab.GAME) {
				int day = firstGameDay + i;
				label = "Day " + day;
				on = day == this.gameDay;
				isToday = day == GameClock.day(game);
				pick = () -> this.gameDay = day;
				count = this.countOn(GameClock.dayStart(day), GameClock.dayStart(day + 1), true);
			} else {
				LocalDate d = this.realDay.plusDays(i - 3L);
				label = RealClock.formatDay(d);
				on = d.equals(this.realDay);
				isToday = d.equals(today);
				pick = () -> this.realDay = d;
				count = this.countOn(RealClock.dayStart(d, this.zone()), RealClock.dayEnd(d, this.zone()), false);
			}
			OrgUi.panel(g, px, y, px + pillW, y + 14, on ? 0xFF3A5068 : OrgUi.PANEL, on ? OrgUi.ACCENT : isToday ? OrgUi.YELLOW : OrgUi.BORDER);
			String counted = label + " · " + count;
			String text = OrgUi.clip(this.font, count > 0 && this.font.width(counted) <= pillW - 6 ? counted : label, pillW - 6);
			g.text(this.font, text, px + (pillW - this.font.width(text)) / 2, y + 3, on ? OrgUi.WHITE : OrgUi.GREY, false);
			if (live) {
				this.hits.add(px, y, px + pillW, y + 14, () -> {
					pick.run();
					this.listScroll = 0;
				});
			}
		}
	}

	private void shiftDay(final int delta) {
		if (this.tab == Tab.GAME) {
			this.gameDay = Math.max(1, this.gameDay + delta);
		} else {
			this.realDay = this.realDay.plusDays(delta);
		}
		this.listScroll = 0;
	}

	private int countOn(final long from, final long to, final boolean game) {
		int count = 0;
		for (Org.CalendarEvent e : this.state.events()) {
			if (Occurrences.isGame(e) == game) {
				count += Occurrences.inWindow(e, from, to, this.zone(), 48).size();
			}
		}
		return count;
	}

	/** One drawn occurrence of an event. */
	private record Shown(Org.CalendarEvent event, Occurrences.Occurrence occurrence) {}

	private void drawDay(final GuiGraphicsExtractor g, final int mouseX, final int mouseY) {
		boolean game = this.tab == Tab.GAME;
		ZoneId zone = this.zone();
		long from = game ? GameClock.dayStart(this.gameDay) : RealClock.dayStart(this.realDay, zone);
		long to = game ? GameClock.dayStart(this.gameDay + 1) : RealClock.dayEnd(this.realDay, zone);
		List<Shown> shown = new ArrayList<>();
		for (Org.CalendarEvent e : this.state.events()) {
			if (Occurrences.isGame(e) == game) {
				for (Occurrences.Occurrence o : Occurrences.inWindow(e, from, to, zone, 48)) {
					shown.add(new Shown(e, o));
				}
			}
		}
		shown.sort((p, q) -> Long.compare(p.occurrence().at(), q.occurrence().at()));

		int tx0 = this.x0 + 12;
		int tx1 = this.detailX0 - 8;
		int ty = this.contentTop;
		// Hour axis.
		g.fill(tx0, ty + 10, tx1, ty + 11, OrgUi.BORDER);
		for (int h = 0; h <= 24; h++) {
			int x = tx0 + (tx1 - tx0) * h / 24;
			boolean label = h % 3 == 0 && h < 24;
			g.fill(x, ty + (label ? 7 : 9), x + 1, ty + 11, OrgUi.BORDER);
			if (label && (tx1 - tx0) / 8 > this.font.width("00:00")) {
				int hourOfDay = game ? (h + GameClock.DAY_START_HOUR) % 24 : h;
				g.text(this.font, String.format(Locale.ROOT, "%02d", hourOfDay), x + 1, ty - 1, OrgUi.GREY, false);
			}
		}
		// Chips, stacked in lanes.
		int laneTop = ty + 14;
		int[] starts = new int[shown.size()];
		int[] ends = new int[shown.size()];
		for (int i = 0; i < shown.size(); i++) {
			Shown s = shown.get(i);
			starts[i] = tx0 + (int)((s.occurrence().at() - from) * (tx1 - tx0) / Math.max(1, to - from));
			long durationUnits = game ? GameClock.minutesToTicks(s.event().durationMin()) : s.event().durationMin() * 60_000L;
			int durationPx = (int)(durationUnits * (tx1 - tx0) / Math.max(1, to - from));
			int labelPx = Math.min(70, this.font.width(s.event().title()) + 6);
			ends[i] = Math.min(tx1, starts[i] + Math.max(durationPx, labelPx));
		}
		int[] lanes = ChipLayout.lanes(starts, ends);
		int laneCount = Math.min(MAX_LANES, Math.max(1, ChipLayout.laneCount(lanes)));
		List<String> order = this.state.crew().order();
		String hover = null;
		int hidden = 0;
		for (int i = 0; i < shown.size(); i++) {
			if (lanes[i] >= MAX_LANES) {
				hidden++;
				continue;
			}
			Shown s = shown.get(i);
			int cy = laneTop + lanes[i] * (CHIP_H + 2);
			int colour = this.colourOf(s.event(), order);
			int fill = s.occurrence().upcoming() ? AssigneePalette.darker(colour, 0.6F) : AssigneePalette.darker(colour, 0.35F);
			boolean on = s.event().id().equals(this.selectedId);
			g.fill(starts[i], cy, ends[i], cy + CHIP_H, fill);
			g.outline(starts[i], cy, ends[i] - starts[i], CHIP_H, on ? OrgUi.WHITE : statusColour(s.occurrence().status(), colour));
			g.text(this.font, OrgUi.clip(this.font, s.event().title(), ends[i] - starts[i] - 4), starts[i] + 2, cy + 2, OrgUi.WHITE, false);
			final String id = s.event().id();
			this.hits.add(starts[i], cy, ends[i], cy + CHIP_H, () -> this.select(id));
			if (OrgUi.inside(mouseX, mouseY, starts[i], cy, ends[i], cy + CHIP_H)) {
				hover = s.event().title() + " · " + this.timeOf(s.occurrence().at(), game) + " · " + this.who(s.event()) + " · " + s.occurrence().status();
			}
		}
		if (hidden > 0) {
			g.text(this.font, "+" + hidden + " more", tx1 - this.font.width("+" + hidden + " more"), laneTop + laneCount * (CHIP_H + 2), OrgUi.GREY, false);
		}
		// Now.
		long now = game ? this.gameNow() : System.currentTimeMillis();
		if (now >= from && now < to) {
			int nx = tx0 + (int)((now - from) * (tx1 - tx0) / Math.max(1, to - from));
			g.fill(nx, ty + 4, nx + 1, laneTop + laneCount * (CHIP_H + 2), 0xFFFF5555);
		}

		// The day's list.
		this.listTop = laneTop + laneCount * (CHIP_H + 2) + 12;
		this.listBottom = this.y1 - 8;
		String heading = !shown.isEmpty() ? "This day" : this.state.calendarKnown() ? "Nothing planned this day" : "The calendar has not arrived yet";
		g.text(this.font, Component.literal(heading).withStyle(ChatFormatting.BOLD), tx0, this.listTop - 10, OrgUi.GREY, false);
		int maxScroll = Math.max(0, shown.size() * LINE - (this.listBottom - this.listTop));
		this.listScroll = Math.min(this.listScroll, maxScroll);
		g.enableScissor(tx0, this.listTop, tx1, this.listBottom);
		int y = this.listTop - this.listScroll;
		for (Shown s : shown) {
			if (y + LINE >= this.listTop && y <= this.listBottom) {
				boolean on = s.event().id().equals(this.selectedId);
				if (on) {
					g.fill(tx0, y, tx1, y + LINE, 0x403A5068);
				}
				int colour = this.colourOf(s.event(), order);
				g.fill(tx0 + 1, y + 2, tx0 + 7, y + 8, colour);
				String text = this.timeOf(s.occurrence().at(), game) + "  " + s.event().title() + "  ·  " + this.who(s.event());
				String right = statusLabel(s.event(), s.occurrence());
				int rw = this.font.width(right);
				g.text(this.font, OrgUi.clip(this.font, text, tx1 - tx0 - rw - 16), tx0 + 10, y + 1, OrgUi.WHITE, false);
				g.text(this.font, right, tx1 - rw - 2, y + 1, statusColour(s.occurrence().status(), OrgUi.GREY), false);
				final String id = s.event().id();
				this.hits.add(tx0, Math.max(y, this.listTop), tx1, Math.min(y + LINE, this.listBottom), () -> this.select(id));
			}
			y += LINE;
		}
		g.disableScissor();
		if (hover != null) {
			g.setTooltipForNextFrame(this.font, Component.literal(hover), mouseX, mouseY);
		}
	}

	private void drawDetail(final GuiGraphicsExtractor g, final Org.CalendarEvent e) {
		int dx0 = this.detailX0;
		int dx1 = this.x1 - 6;
		int w = dx1 - dx0 - 12;
		OrgUi.panel(g, dx0, this.contentTop - 4, dx1, this.y1 - 6, OrgUi.PANEL, OrgUi.BORDER);
		int x = dx0 + 6;
		g.text(this.font, "×", dx1 - 10, this.contentTop, OrgUi.GREY, false);
		this.hits.add(dx1 - 14, this.contentTop - 2, dx1 - 2, this.contentTop + 10, () -> this.select(null));
		// Everything above the buttons scrolls as one (the wheel over the panel).
		this.logTop = this.contentTop;
		this.logBottom = this.y1 - 6 - 40;
		g.enableScissor(dx0 + 1, this.logTop, dx1 - 1, this.logBottom);
		int top = this.contentTop - this.logScroll;
		int y = top;
		for (FormattedCharSequence line : this.font.split(Component.literal(e.title()).withStyle(ChatFormatting.BOLD), w - 12)) {
			g.text(this.font, line, x, y, OrgUi.WHITE, false);
			y += LINE;
		}
		StatusText statusText = eventStatus(e);
		String kind = cap(e.kind()) + " · ";
		g.text(this.font, kind, x, y, OrgUi.GREY, false);
		g.text(this.font, OrgUi.clip(this.font, statusText.label(), w - this.font.width(kind)), x + this.font.width(kind), y, statusText.colour(), false);
		y += LINE;
		boolean game = Occurrences.isGame(e);
		ZoneId zone = e.tz() != null ? RealClock.zone(e.tz()) : this.zone();
		y = this.field(g, x, y, w, "For", this.who(e));
		String when = (game ? GameClock.format(e.at()) : RealClock.format(e.at(), zone)) + ", " + repeatLabel(e.recurrence().kind(),
			e.recurrence().n() == null ? 2 : e.recurrence().n()).toLowerCase(Locale.ROOT);
		y = this.field(g, x, y, w, "When", when);
		if (e.nextAt() != null && Occurrences.isLive(e)) {
			y = this.field(g, x, y, w, "Next", game ? GameClock.format(e.nextAt()) + " (in " + realIn(GameClock.realSecondsUntil(this.gameNow(), e.nextAt())) + ")"
				: RealClock.format(e.nextAt(), zone));
		}
		y = this.field(g, x, y, w, "Lasts", e.durationMin() + (game ? " game min" : " min"));
		if (e.location() != null) {
			y = this.field(g, x, y, w, "Where", e.location());
		}
		y = this.field(g, x, y, w, "If missed", ("skip".equals(e.catchUp()) ? "skip it" : "run once, late") + (e.runWhileAway() ? "; runs while you are away" : ""));
		y = this.field(g, x, y, w, "By", "player".equals(e.createdBy()) ? "you" : this.state.crew().name(e.createdBy()));
		if (e.task() != null) {
			int lines = 0;
			for (FormattedCharSequence line : OrgUi.wrap(this.font, e.task(), w)) {
				if (lines++ == 3) {
					g.text(this.font, "…", x, y, OrgUi.GREY, false);
					y += LINE - 2;
					break;
				}
				g.text(this.font, line, x, y, 0xFFD8D8D8, false);
				y += LINE - 2;
			}
		}
		if (!"reminder".equals(e.kind())) {
			int people = e.assignees().isJsonArray() ? e.assignees().getAsJsonArray().size() : this.state.crew().alive().size();
			CostEstimator.Estimate est = CostEstimator.estimate(e.kind(), people, e.clock(), e.recurrence().kind(),
				e.recurrence().n() == null ? 2 : e.recurrence().n(), false);
			for (FormattedCharSequence line : OrgUi.wrap(this.font, "Cost: " + est.text(), w)) {
				g.text(this.font, line, x, y + 2, OrgUi.YELLOW, false);
				y += LINE - 2;
			}
		}
		y += 6;
		g.text(this.font, Component.literal("Occurrences").withStyle(ChatFormatting.BOLD), x, y, OrgUi.GREY, false);
		y += LINE;
		List<Org.Occurrence> log = new ArrayList<>(e.occurrences());
		java.util.Collections.reverse(log);
		if (log.isEmpty()) {
			g.text(this.font, "None yet", x, y, OrgUi.GREY, false);
			y += LINE;
		}
		for (Org.Occurrence o : log) {
			String head = (game ? GameClock.format(o.at()) : RealClock.format(o.at(), zone)) + "  ";
			String tail = o.status() + (o.agentId() != null ? " (" + this.state.crew().name(o.agentId()) + ")" : "") + (o.note() != null ? ": " + o.note() : "");
			g.text(this.font, head, x, y, OrgUi.GREY, false);
			g.text(this.font, OrgUi.clip(this.font, tail, w - this.font.width(head)), x + this.font.width(head), y, statusColour(o.status(), OrgUi.WHITE), false);
			y += LINE;
		}
		g.disableScissor();
		int maxScroll = Math.max(0, y - top - (this.logBottom - this.logTop));
		this.logScroll = Math.min(this.logScroll, maxScroll);
		if (maxScroll > 0) {
			String more = this.logScroll < maxScroll ? "▼" : "▲";
			g.text(this.font, more, dx1 - 10, this.logBottom - 9, OrgUi.GREY, false);
		}
	}

	private int field(final GuiGraphicsExtractor g, final int x, final int y, final int w, final String name, final String value) {
		String label = name + ": ";
		g.text(this.font, label, x, y, OrgUi.GREY, false);
		g.text(this.font, OrgUi.clip(this.font, value, w - this.font.width(label)), x + this.font.width(label), y, OrgUi.WHITE, false);
		return y + LINE - 1;
	}

	private void drawForm(final GuiGraphicsExtractor g, final CalendarForm f) {
		OrgUi.panel(g, this.fx0, this.fy0, this.fx1, this.fy1, 0xF8182028, OrgUi.ACCENT);
		int x = this.fx0 + 8;
		int inner = this.fx1 - this.fx0 - 16;
		g.text(this.font, Component.literal(f.eventId == null ? "New event" : "Edit event").withStyle(ChatFormatting.BOLD), x, this.fy0 + 7, OrgUi.WHITE, false);
		// Labels next to the time row (the widgets sit in init's positions).
		int rowY = this.fy0 + 20 + 18 + 20;
		int lx = x;
		if ("game".equals(f.clock)) {
			g.text(this.font, "Day", lx, rowY + 3, OrgUi.GREY, false);
			lx += this.font.width("Day ") + 2 + 38;
		} else {
			lx += 76;
		}
		g.text(this.font, "at", lx, rowY + 3, OrgUi.GREY, false);
		lx += this.font.width("at ") + 2 + 44;
		if ("every_n_days".equals(f.recurrence)) {
			g.text(this.font, "every", lx, rowY + 3, OrgUi.GREY, false);
			lx += this.font.width("every ") + 2 + 32;
			g.text(this.font, "days", lx, rowY + 3, OrgUi.GREY, false);
		}
		g.text(this.font, "min", this.fx1 - 8 - this.font.width("min"), rowY + 3, OrgUi.GREY, false);
		String hint = "game".equals(f.clock) ? "Game day 06:00-06:00 = 20 real min" : "Real time, " + this.zone().getId();
		g.text(this.font, OrgUi.clip(this.font, hint, inner / 2), this.fx1 - 8 - Math.min(inner / 2, this.font.width(hint)), this.fy0 + 7, OrgUi.GREY, false);

		// Assignee chips.
		int cy = this.assigneeRowY;
		g.text(this.font, "For:", x, cy + 2, OrgUi.GREY, false);
		int cx = x + this.font.width("For: ") + 4;
		List<String> order = this.state.crew().order();
		List<@Nullable String> ids = new ArrayList<>();
		ids.add(null); // Everyone
		ids.addAll(this.assigneeIds(f));
		for (String id : ids) {
			String label = id == null ? "Everyone" : this.state.crew().name(id);
			int w = this.font.width(label) + 10;
			if (cx + w > x + inner) {
				cx = x;
				cy += 13;
			}
			boolean on = id == null ? f.everyone : !f.everyone && f.assignees.contains(id);
			int colour = id == null ? AssigneePalette.ALL : AssigneePalette.colourFor(id, order);
			OrgUi.panel(g, cx, cy, cx + w, cy + 11, on ? AssigneePalette.darker(colour, 0.55F) : OrgUi.PANEL, on ? colour : OrgUi.BORDER);
			g.fill(cx + 2, cy + 3, cx + 6, cy + 7, colour);
			g.text(this.font, label, cx + 8, cy + 2, on ? OrgUi.WHITE : OrgUi.GREY, false);
			this.hits.add(cx, cy, cx + w, cy + 11, () -> {
				if (id == null) {
					f.everyone = !f.everyone;
				} else {
					f.everyone = false;
					if (!f.assignees.remove(id)) {
						f.assignees.add(id);
					}
				}
				this.revalidate();
			});
			cx += w + 3;
		}

		// Cost and problems.
		int crew = Math.max(1, this.state.crew().alive().size());
		CostEstimator.Estimate est = f.estimate(crew);
		int ey = this.fy1 - 40;
		g.text(this.font, OrgUi.clip(this.font, "Cost: " + est.text(), inner), x, ey, OrgUi.YELLOW, false);
		if (!this.formErrors.isEmpty()) {
			g.text(this.font, OrgUi.clip(this.font, this.formErrors.getFirst(), inner), x, ey + 10, OrgUi.RED, false);
		}
	}

	private void drawMeetingDialog(final GuiGraphicsExtractor g) {
		OrgUi.panel(g, this.fx0, this.fy0, this.fx1, this.fy1, 0xF8182028, OrgUi.ACCENT);
		int x = this.fx0 + 8;
		int w = this.fx1 - this.fx0 - 16;
		g.text(this.font, Component.literal("Start \"" + OrgUi.clip(this.font, this.meetingTitle, w - 60) + "\" now?").withStyle(ChatFormatting.BOLD), x,
			this.fy0 + 7, OrgUi.WHITE, false);
		int y = this.fy0 + 22;
		List<Org.Eta> list = this.etas;
		if (list == null) {
			g.text(this.font, "Asking the crew how far away they are…", x, y, OrgUi.GREY, false);
		} else if (list.isEmpty()) {
			g.text(this.font, "Nobody can come right now.", x, y, OrgUi.RED, false);
		} else {
			for (Org.Eta eta : list) {
				String name = this.state.crew().name(eta.agentId());
				String when = eta.dialIn() ? "dials in (too far)" : eta.etaS() == null ? "unknown" : "about " + eta.etaS() + " s away";
				g.text(this.font, name, x, y, OrgUi.WHITE, false);
				g.text(this.font, when, x + w - this.font.width(when), y, eta.dialIn() ? OrgUi.YELLOW : OrgUi.GREY, false);
				y += 11;
			}
		}
		int crew = Math.max(1, list == null ? 1 : list.size());
		g.text(this.font, OrgUi.clip(this.font, "Cost: " + CostEstimator.estimate("meeting", crew, "game", "once", 2, false).text(), w), x, this.fy1 - 34,
			OrgUi.YELLOW, false);
	}

	// ------------------------------------------------------------------ text helpers

	private int colourOf(final Org.CalendarEvent e, final List<String> order) {
		JsonElement who = e.assignees();
		boolean everyone = who != null && who.isJsonPrimitive() && "all".equals(who.getAsString());
		List<String> ids = new ArrayList<>();
		if (who != null && who.isJsonArray()) {
			who.getAsJsonArray().forEach(id -> ids.add(id.getAsString()));
		}
		return AssigneePalette.colourForEvent(everyone, ids, order);
	}

	private String who(final Org.CalendarEvent e) {
		JsonElement who = e.assignees();
		if (who == null || who.isJsonPrimitive() && "all".equals(who.getAsString())) {
			return "everyone";
		}
		List<String> names = new ArrayList<>();
		if (who.isJsonArray()) {
			who.getAsJsonArray().forEach(id -> names.add(this.state.crew().name(id.getAsString())));
		}
		return names.isEmpty() ? "nobody" : String.join(", ", names);
	}

	private String timeOf(final long at, final boolean game) {
		return game ? GameClock.formatTime(at) : RealClock.formatTime(at, this.zone());
	}

	private static String statusLabel(final Org.CalendarEvent e, final Occurrences.Occurrence o) {
		if (o.upcoming()) {
			return switch (e.status()) {
				case "pending_approval" -> "awaiting approval";
				case "paused" -> "paused";
				case "orphaned" -> "orphaned";
				default -> "";
			};
		}
		return o.status();
	}

	private record StatusText(String label, int colour) {}

	private static StatusText eventStatus(final Org.CalendarEvent e) {
		return switch (e.status()) {
			case "active" -> new StatusText("active", OrgUi.GREEN);
			case "pending_approval" -> new StatusText("waiting for your approval (see the agent's card)", OrgUi.YELLOW);
			case "orphaned" -> new StatusText("orphaned: its assignees are gone; edit to reassign", OrgUi.RED);
			default -> new StatusText(e.status(), OrgUi.GREY);
		};
	}

	private static int statusColour(final String status, final int fallback) {
		return switch (status) {
			case "done" -> OrgUi.GREEN;
			case "missed", "failed", "blocked", "orphaned" -> OrgUi.RED;
			case "deferred" -> OrgUi.YELLOW;
			case "cancelled" -> OrgUi.GREY;
			default -> fallback;
		};
	}

	private static String repeatLabel(final String kind, final int n) {
		return switch (kind) {
			case "once" -> "Once";
			case "daily" -> "Daily";
			case "every_n_days" -> "Every " + n + " days";
			case "weekdays" -> "Weekdays";
			default -> kind;
		};
	}

	private static String realIn(final long seconds) {
		return seconds < 60 ? seconds + " s" : seconds / 60 + " min";
	}

	private static String cap(final String s) {
		return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
	}

	private static int parseInt(final String text, final int fallback) {
		try {
			return Integer.parseInt(text.trim());
		} catch (NumberFormatException e) {
			return fallback;
		}
	}
}
