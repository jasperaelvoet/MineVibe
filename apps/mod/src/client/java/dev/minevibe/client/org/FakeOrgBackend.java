package dev.minevibe.client.org;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.bridge.protocol.ProtocolException;
import dev.minevibe.client.org.calendar.GameClock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.LongSupplier;
import org.jspecify.annotations.Nullable;

/**
 * An in-memory Codex, calendar and meeting room that answers the org screens like Node would (protocol §7.8), and
 * pushes {@code codex.index} / {@code calendar.state} / {@code meeting.state} into an {@link OrgClientState} after
 * every change. For trying the screens without Node ({@code -Dminevibe.org.fake=true}) and for client GameTests; it
 * keeps Node's rules that the screens depend on (rev conflicts, similar titles, the 8 KB cap, append, cancel next/all,
 * one meeting at a time) and none of the rest. Requests complete before they return.
 */
public final class FakeOrgBackend implements OrgBackend {
	private record Page(Org.CodexPageMeta meta, String body, List<Org.CodexHistoryEntry> history) {}

	private final OrgClientState state;
	private final LongSupplier gameTime;
	private final LongSupplier realTime;
	private final Types.Author player;
	private final Map<String, Page> pages = new LinkedHashMap<>();
	private final Map<String, Org.CalendarEvent> events = new LinkedHashMap<>();
	private final List<Messages.CrewMember> crew = new ArrayList<>();
	private Org.@Nullable MeetingState meeting;
	private int seq;
	private boolean online = true;

	public FakeOrgBackend(final OrgClientState state, final LongSupplier gameTime, final LongSupplier realTime, final String playerName) {
		this.state = state;
		this.gameTime = gameTime;
		this.realTime = realTime;
		this.player = new Types.Author("player", playerName, null);
	}

	/** A small crew, a few pages and events, so every part of the screens has something to show. */
	public FakeOrgBackend seed() {
		this.crew.add(new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"));
		this.crew.add(new Messages.CrewMember("bram", "bram", "Bram", "miner", false, "alive"));
		this.crew.add(new Messages.CrewMember("cleo", "cleo", "Cleo", "farmer", false, "alive"));
		this.state.crew().setNodeCrew(this.crew);
		Types.Author bram = new Types.Author("agent", "Bram", "bram");
		Types.Author ada = new Types.Author("agent", "Ada", "ada");
		this.write(this.player, "House rules", "rules", "lasting", List.of("house"), "# House rules\n- Ask before you dig under the office.\n- Never touch the Vault without a plan.", true);
		this.write(bram, "Iron cave", "places", "world", List.of("iron", "cave"), "Iron cave at (120, 40, -80).\n\n- Lava on the east side\n- Bring torches", false);
		this.write(ada, "How to smelt", "howto", "lasting", List.of("furnace"), "Put coal in the bottom slot and ore on top.\n\n```\nfurnace: 8 items per coal\n```", false);
		this.write(ada, "Standup Day 2", "minutes", "world", List.of("standup"), "> Bram found iron.\n\nAction items:\n- Cleo: farm wheat", false);
		long now = this.gameTime.getAsLong();
		int day = GameClock.day(now);
		this.addEvent("Farm wheat", "task", ids("cleo"), "game", GameClock.at(day, 6, 0), "daily", null, 60, "farm", "Harvest and replant the wheat field", "active", "player");
		this.addEvent("Standup", "meeting", new JsonPrimitive("all"), "game", GameClock.at(day, 8, 0), "daily", null, 10, "meeting_table", null, "active", "player");
		this.addEvent("Water the plants", "reminder", ids("bram"), "game", GameClock.at(day, 13, 0), "once", null, 5, null, null, "active", "ada");
		this.addEvent("Mine iron", "task", ids("bram", "ada"), "game", GameClock.at(day, 15, 30), "every_n_days", 2, 120, "Iron cave", "Bring back 16 iron", "active", "ada");
		this.addEvent("Back up the repo", "task", ids("ada"), "real", this.realTime.getAsLong() + 3_600_000L, "weekdays", null, 30, "pc:linux-1", "git push", "active", "player");
		this.addEvent("Old patrol", "task", ids("dora"), "real", this.realTime.getAsLong() + 7_200_000L, "daily", null, 30, null, "Walk the walls", "orphaned", "player");
		this.pushCodex();
		this.pushCalendar();
		return this;
	}

	public void setOnline(final boolean online) {
		this.online = online;
	}

	/** Moves the meeting to its next phase (gathering, open, updates, floor, wrapup, done). */
	public void advanceMeeting() {
		Org.MeetingState m = this.meeting;
		if (m == null) {
			return;
		}
		List<String> phases = List.of("gathering", "open", "updates", "floor", "wrapup", "done");
		String next = phases.get(Math.min(phases.size() - 1, phases.indexOf(m.phase()) + 1));
		List<Org.MeetingAttendee> seated = m.attendees().stream()
			.map(a -> "coming".equals(a.status()) ? new Org.MeetingAttendee(a.agentId(), "seated", null) : a)
			.toList();
		String speaker = switch (next) {
			case "open", "wrapup" -> m.chair();
			case "updates" -> seated.isEmpty() ? null : seated.getLast().agentId();
			case "floor" -> "player";
			default -> null;
		};
		this.setMeeting(new Org.MeetingState(m.meetingId(), m.title(), next, m.chair(), speaker, seated, m.eventId(), m.startedAt(), m.endsBy(), m.quick()));
	}

	@Override
	public boolean online() {
		return this.online;
	}

	// ------------------------------------------------------------------ Codex

	@Override
	public CompletableFuture<Org.CodexSearchResult> codexSearch(final Org.CodexSearch search) {
		return this.attempt(() -> {
			check(Org.CODEX_SEARCH, search);
			String[] words = search.query().toLowerCase(Locale.ROOT).trim().split("\\s+");
			List<Org.CodexHit> hits = new ArrayList<>();
			for (Page page : this.pages.values()) {
				Org.CodexPageMeta m = page.meta();
				if (search.category() != null && !search.category().equals(m.category()) || search.scope() != null && !search.scope().equals(m.scope())) {
					continue;
				}
				if (search.tags() != null && !m.tags().containsAll(search.tags())) {
					continue;
				}
				double score = 0;
				String title = m.title().toLowerCase(Locale.ROOT);
				String body = page.body().toLowerCase(Locale.ROOT);
				for (String w : words) {
					if (!w.isEmpty()) {
						score += (title.contains(w) ? 3 : 0) + (body.contains(w) ? 1 : 0);
					}
				}
				if (score > 0 || search.query().isBlank()) {
					hits.add(new Org.CodexHit(m.id(), m.title(), m.category(), m.scope(), snippet(page.body(), words), score));
				}
			}
			hits.sort((a, b) -> Double.compare(b.score(), a.score()));
			return new Org.CodexSearchResult(hits.subList(0, Math.min(hits.size(), search.limit())));
		});
	}

	@Override
	public CompletableFuture<Org.CodexPage> codexGet(final String pageId) {
		return this.attempt(() -> {
			Page page = this.page(pageId);
			Org.CodexPageMeta m = page.meta();
			return new Org.CodexPage(m.id(), m.title(), m.category(), m.scope(), m.tags(), m.author(), m.created(), m.updated(), m.rev(), m.pinned(),
				page.body(), List.of(), List.copyOf(page.history()));
		});
	}

	@Override
	public CompletableFuture<Org.CodexPutResult> codexPut(final Org.CodexPut put) {
		return this.attempt(() -> {
			check(Org.CODEX_PUT, put);
			Page result = switch (put.mode()) {
				case "create" -> {
					for (Page p : this.pages.values()) {
						if (p.meta().title().equalsIgnoreCase(put.title().trim())) {
							throw new BridgeException(Messages.Codes.CODEX_SIMILAR, "similar page " + p.meta().id() + " exists, use update/append");
						}
					}
					yield this.write(this.player, put.title(), put.category(), put.scope(), put.tags(), put.body(), Boolean.TRUE.equals(put.pinned()));
				}
				case "append" -> {
					Page old = this.page(put.pageId());
					String body = old.body() + "\n\n" + put.body();
					if (body.length() > Org.CODEX_BODY_MAX) {
						throw new BridgeException(Messages.Codes.CODEX_TOO_LARGE, "the page is full; start a new page");
					}
					yield this.replace(old, old.meta().title(), old.meta().category(), old.meta().scope(), old.meta().tags(), body, old.meta().pinned(), "append");
				}
				default -> {
					Page old = this.page(put.pageId());
					if (!old.meta().rev().equals(put.baseRev())) {
						throw new BridgeException(Messages.Codes.CODEX_CONFLICT, "the page changed (rev " + old.meta().rev() + ")");
					}
					yield this.replace(old, put.title(), put.category(), put.scope(), put.tags(), put.body(),
						put.pinned() != null ? put.pinned() : old.meta().pinned(), "update");
				}
			};
			this.pushCodex();
			return new Org.CodexPutResult(result.meta().id(), result.meta().rev());
		});
	}

	@Override
	public CompletableFuture<Void> codexDelete(final Org.CodexDelete delete) {
		return this.attempt(() -> {
			Page page = this.page(delete.pageId());
			if (delete.baseRev() != null && !delete.baseRev().equals(page.meta().rev())) {
				throw new BridgeException(Messages.Codes.CODEX_CONFLICT, "the page changed (rev " + page.meta().rev() + ")");
			}
			this.pages.remove(delete.pageId());
			this.pushCodex();
			return null;
		});
	}

	/** Writes a new page as {@code author} (how the fake "agents" write); returns its id. */
	public String writeAs(final Types.Author author, final String title, final String category, final String scope, final List<String> tags, final String body) {
		return this.write(author, title, category, scope, tags, body, false).meta().id();
	}

	private Page write(final Types.Author author, final String title, final String category, final String scope, final List<String> tags, final String body, final boolean pinned) {
		String id = this.slug(title);
		long now = this.realTime.getAsLong();
		String rev = this.nextRev();
		Org.CodexPageMeta meta = new Org.CodexPageMeta(id, title.trim(), category, scope, List.copyOf(tags), author, now, now, rev, pinned);
		List<Org.CodexHistoryEntry> history = new ArrayList<>();
		history.add(new Org.CodexHistoryEntry(rev, now, author, "create"));
		Page page = new Page(meta, body, history);
		this.pages.put(id, page);
		this.pushCodex();
		return page;
	}

	/** An agent edits a page behind the player's back (for soft-lock tests). */
	public void agentEdit(final String pageId, final String agentName, final String body) {
		Page old = this.page(pageId);
		Types.Author agent = new Types.Author("agent", agentName, agentName.toLowerCase(Locale.ROOT));
		Page edited = this.replace(old, old.meta().title(), old.meta().category(), old.meta().scope(), old.meta().tags(), body, old.meta().pinned(), "update", agent);
		this.pages.put(pageId, edited);
		this.pushCodex();
	}

	private Page replace(final Page old, final String title, final String category, final String scope, final List<String> tags, final String body,
		final boolean pinned, final String summary) {
		return this.replace(old, title, category, scope, tags, body, pinned, summary, this.player);
	}

	private Page replace(final Page old, final String title, final String category, final String scope, final List<String> tags, final String body,
		final boolean pinned, final String summary, final Types.Author author) {
		long now = this.realTime.getAsLong();
		String rev = this.nextRev();
		Org.CodexPageMeta m = old.meta();
		Org.CodexPageMeta meta = new Org.CodexPageMeta(m.id(), title.trim(), category, scope, List.copyOf(tags), author, m.created(), now, rev, pinned);
		List<Org.CodexHistoryEntry> history = new ArrayList<>();
		history.add(new Org.CodexHistoryEntry(rev, now, author, summary));
		history.addAll(old.history());
		Page page = new Page(meta, body, history.subList(0, Math.min(50, history.size())));
		this.pages.put(m.id(), page);
		return page;
	}

	private Page page(final @Nullable String pageId) {
		Page page = pageId == null ? null : this.pages.get(pageId);
		if (page == null) {
			throw new BridgeException(Messages.Codes.CODEX_NOT_FOUND, "no page " + pageId);
		}
		return page;
	}

	private String slug(final String title) {
		String base = title.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
		if (base.isEmpty()) {
			base = "page";
		}
		base = base.substring(0, Math.min(70, base.length()));
		String id = base;
		for (int i = 2; this.pages.containsKey(id); i++) {
			id = base + "-" + i;
		}
		return id;
	}

	private String nextRev() {
		return String.format(Locale.ROOT, "%08x", (++this.seq * 2654435761L) & 0xFFFFFFFFL);
	}

	private static String snippet(final String body, final String[] words) {
		String lower = body.toLowerCase(Locale.ROOT);
		int at = -1;
		for (String w : words) {
			if (!w.isEmpty() && (at = lower.indexOf(w)) >= 0) {
				break;
			}
		}
		int from = Math.max(0, at - 40);
		String s = body.substring(from, Math.min(body.length(), from + 160)).replace('\n', ' ');
		return (from > 0 ? "…" : "") + s;
	}

	private void pushCodex() {
		List<Org.CodexPageMeta> metas = this.pages.values().stream().map(Page::meta).toList();
		this.state.onCodexIndex(new Org.CodexIndex(metas, false));
	}

	// ------------------------------------------------------------------ calendar

	@Override
	public CompletableFuture<Org.CalendarPutResult> calendarPut(final Org.CalendarPut put) {
		return this.attempt(() -> {
			check(Org.CALENDAR_PUT, put);
			String id = put.eventId();
			Org.CalendarEvent old = id == null ? null : this.events.get(id);
			if (id != null && old == null) {
				throw new BridgeException(Messages.Codes.CALENDAR_NOT_FOUND, "no event " + id);
			}
			if (id == null) {
				id = "ev-" + (++this.seq);
			}
			Org.CalendarEvent event = new Org.CalendarEvent(id, put.title(), put.kind(), put.assignees(), put.clock(), put.at(), put.tz(), put.recurrence(),
				put.durationMin(), put.location(), put.task(), put.catchUp(), put.runWhileAway(), old == null ? "player" : old.createdBy(), "active", put.at(),
				old == null ? List.of() : old.occurrences());
			this.events.put(id, event);
			this.pushCalendar();
			return new Org.CalendarPutResult(id);
		});
	}

	@Override
	public CompletableFuture<Void> calendarCancel(final Org.CalendarCancel cancel) {
		return this.attempt(() -> {
			Org.CalendarEvent e = this.events.get(cancel.eventId());
			if (e == null) {
				throw new BridgeException(Messages.Codes.CALENDAR_NOT_FOUND, "no event " + cancel.eventId());
			}
			boolean all = "all".equals(cancel.scope()) || "once".equals(e.recurrence().kind());
			List<Org.Occurrence> log = new ArrayList<>(e.occurrences());
			if (e.nextAt() != null) {
				log.add(new Org.Occurrence(e.nextAt(), "cancelled", all ? "cancelled by you" : "skipped by you", null));
			}
			while (log.size() > 20) {
				log.removeFirst();
			}
			Long next = all || e.nextAt() == null ? null : e.nextAt() + step(e);
			this.events.put(e.id(), new Org.CalendarEvent(e.id(), e.title(), e.kind(), e.assignees(), e.clock(), e.at(), e.tz(), e.recurrence(), e.durationMin(),
				e.location(), e.task(), e.catchUp(), e.runWhileAway(), e.createdBy(), all ? "cancelled" : e.status(), next, log));
			this.pushCalendar();
			return null;
		});
	}

	private static long step(final Org.CalendarEvent e) {
		int n = e.recurrence().n() == null ? 1 : e.recurrence().n();
		return "game".equals(e.clock()) ? GameClock.TICKS_PER_DAY * n : 86_400_000L * n;
	}

	private void addEvent(final String title, final String kind, final JsonElement assignees, final String clock, final long at, final String recurrence,
		final @Nullable Integer n, final int durationMin, final @Nullable String location, final @Nullable String task, final String status, final String createdBy) {
		String id = "ev-" + (++this.seq);
		List<Org.Occurrence> log = new ArrayList<>();
		if ("game".equals(clock) && !"once".equals(recurrence)) {
			log.add(new Org.Occurrence(Math.max(0, at - GameClock.TICKS_PER_DAY), "done", "all good", null));
		}
		this.events.put(id, new Org.CalendarEvent(id, title, kind, assignees, clock, at, null, new Org.Recurrence(recurrence, n), durationMin, location, task,
			"skip", false, createdBy, status, at, log));
	}

	private static JsonArray ids(final String... ids) {
		JsonArray array = new JsonArray();
		for (String id : ids) {
			array.add(id);
		}
		return array;
	}

	private void pushCalendar() {
		this.state.onCalendarState(new Org.CalendarState(List.copyOf(this.events.values()), this.state.tz()));
	}

	// ------------------------------------------------------------------ meetings

	@Override
	public CompletableFuture<Org.MeetingStartResult> meetingStart(final Org.MeetingStart start) {
		return this.attempt(() -> {
			check(Org.MEETING_START, start);
			List<Org.Eta> etas = new ArrayList<>();
			int i = 0;
			for (Messages.CrewMember m : this.crew) {
				long eta = 6L + 9L * i;
				etas.add(new Org.Eta(m.agentId(), eta, eta > 90));
				i++;
			}
			if (start.preview()) {
				return new Org.MeetingStartResult(null, etas);
			}
			if (this.meeting != null) {
				throw new BridgeException(Messages.Codes.MEETING_BUSY, "a meeting is already running");
			}
			if (this.crew.size() < 2) {
				throw new BridgeException(Messages.Codes.NO_QUORUM, "the CEO and one more are needed");
			}
			long now = this.realTime.getAsLong();
			List<Org.MeetingAttendee> attendees = etas.stream().map(e -> new Org.MeetingAttendee(e.agentId(), "coming", e.etaS())).toList();
			String id = "mt-" + (++this.seq);
			String title = start.title() != null ? start.title() : "Meeting";
			this.setMeeting(new Org.MeetingState(id, title, "gathering", this.crew.getFirst().agentId(), null, attendees, start.eventId(), now, now + 600_000L, false));
			return new Org.MeetingStartResult(id, etas);
		});
	}

	@Override
	public CompletableFuture<Void> meetingEnd(final String meetingId) {
		return this.attempt(() -> {
			Org.MeetingState m = this.meeting;
			if (m == null || !m.meetingId().equals(meetingId)) {
				throw new BridgeException(Messages.Codes.MEETING_NOT_FOUND, "no meeting " + meetingId);
			}
			this.setMeeting(new Org.MeetingState(m.meetingId(), m.title(), "done", m.chair(), null, m.attendees(), m.eventId(), m.startedAt(), m.endsBy(), m.quick()));
			return null;
		});
	}

	private void setMeeting(final Org.MeetingState m) {
		this.meeting = "done".equals(m.phase()) ? null : m;
		this.state.onMeetingState(m);
	}

	// ------------------------------------------------------------------ plumbing

	private interface Body<T> {
		T run();
	}

	private <T> CompletableFuture<T> attempt(final Body<T> body) {
		if (!this.online) {
			return CompletableFuture.failedFuture(new BridgeException(Messages.Codes.DISCONNECTED, "MineVibe is not connected"));
		}
		try {
			return CompletableFuture.completedFuture(body.run());
		} catch (RuntimeException e) {
			return CompletableFuture.failedFuture(e);
		}
	}

	/** Rejects a payload Node's schema would reject, as Node does ({@code BAD_MESSAGE}). */
	private static <P> void check(final dev.minevibe.bridge.protocol.MessageType<P> type, final P payload) {
		try {
			ProtocolCodec.encode(type, payload, "m-1", null);
		} catch (ProtocolException e) {
			throw new BridgeException(Messages.Codes.BAD_MESSAGE, e.getMessage());
		}
	}
}
