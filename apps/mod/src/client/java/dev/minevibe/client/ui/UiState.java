package dev.minevibe.client.ui;

import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.jspecify.annotations.Nullable;

/**
 * The client's mirror of the UI pushes from Node (PLAN §7.8): crew ({@code crew.state}), brain indicators
 * ({@code agent.brain}), cards ({@code agent.pending}), bubbles ({@code agent.say}), transcripts
 * ({@code chat.append}, {@code chat.history}), the brain summary ({@code brains.state}) and toasts
 * ({@code ui.toast}).
 *
 * <p>Client thread only: the bridge handlers run on the client task queue, and renderers, HUDs and screens read it on
 * the same thread. Node re-sends everything after each {@code hello}, so a list push simply replaces what was here.
 * {@link #revision()} increases on every change; screens compare it to know when to refresh.
 *
 * <p>Other client features that need the crew (name tags, chat completion, calendar assignees, ...) should read it
 * from here: the bridge allows one handler per message type, and this class owns the UI group's pushes.
 */
public final class UiState {
	private static final UiState INSTANCE = new UiState(System::currentTimeMillis);

	/** At most this many toasts are visible; older ones drop off. */
	static final int MAX_TOASTS = 5;

	private final LongSupplier clock;
	private final Map<String, AgentView> agents = new LinkedHashMap<>();
	private final Map<UUID, String> byUuid = new HashMap<>();
	private final Map<String, Bubble> bubbles = new HashMap<>();
	private final Map<String, Transcript> transcripts = new HashMap<>();
	private final List<ToastEntry> toasts = new ArrayList<>();
	private Messages.@Nullable Brains brains;
	private long revision;

	UiState(LongSupplier clock) {
		this.clock = clock;
	}

	public static UiState get() {
		return INSTANCE;
	}

	/** A fresh, independent state (tests). */
	public static UiState create(LongSupplier clock) {
		return new UiState(clock);
	}

	public long now() {
		return clock.getAsLong();
	}

	public long revision() {
		return revision;
	}

	private void changed() {
		revision++;
	}

	// ---------------------------------------------------------------------------------------------
	// Pushes
	// ---------------------------------------------------------------------------------------------

	/** {@code crew.state}: the full crew list (living, dead and dismissed) in Node's order. */
	public void applyCrew(Bodies.CrewState state) {
		Map<String, AgentView> next = new LinkedHashMap<>();
		for (Messages.CrewMember m : state.crew()) {
			AgentView view = agents.get(m.agentId());
			if (view == null) view = new AgentView(m.agentId(), m.handle(), m.name());
			view.identity(m.handle(), m.name(), m.role(), m.ceo(), m.status());
			next.put(m.agentId(), view);
		}
		agents.clear();
		agents.putAll(next);
		byUuid.clear();
		for (AgentView v : agents.values()) byUuid.put(v.uuid(), v.agentId());
		bubbles.keySet().retainAll(agents.keySet());
		changed();
	}

	/** {@code agent.brain}. Ignored for agents not in the crew list yet (Node sends {@code crew.state} first). */
	public void applyBrain(Ui.AgentBrain brain) {
		AgentView view = agents.get(brain.agentId());
		if (view == null) return;
		view.brain(brain);
		changed();
	}

	/** {@code agent.pending}: replaces the agent's cards. */
	public void applyPending(Ui.AgentPending pending) {
		AgentView view = agents.get(pending.agentId());
		if (view == null) return;
		view.cards(pending.cards());
		changed();
	}

	/** {@code agent.say}: the agent's new bubble (barks come from the {@link Barks} table). */
	public @Nullable Bubble applySay(Messages.AgentSay say) {
		String text = say.text() != null ? say.text() : say.bark() != null ? Barks.text(say.bark()) : null;
		if (text == null || text.isBlank()) return null;
		Bubble bubble = new Bubble(say.agentId(), text, say.style(), now(), say.ttlMs());
		bubbles.put(say.agentId(), bubble);
		changed();
		return bubble;
	}

	/** {@code chat.append}. */
	public void applyChat(Ui.ChatAppend append) {
		transcript(append.agentId()).add(append.entry());
		changed();
	}

	/** A {@code chat.history} page for an agent. */
	public void applyHistory(String agentId, Ui.ChatHistoryResult page) {
		transcript(agentId).addPage(page.entries(), page.more());
		changed();
	}

	/** {@code brains.state}. */
	public void applyBrains(Messages.Brains brains) {
		this.brains = brains;
		changed();
	}

	/** {@code ui.toast}, or a local toast. */
	public void addToast(String text, String kind, @Nullable String agentId, long ttlMs) {
		toasts.add(new ToastEntry(text, kind, agentId, now(), ttlMs > 0 ? ttlMs : ToastEntry.DEFAULT_TTL_MS));
		while (toasts.size() > MAX_TOASTS) toasts.removeFirst();
		changed();
	}

	/** Leaving a world: bubbles and toasts belong to it. The crew stays until Node says otherwise. */
	public void clearTransient() {
		bubbles.clear();
		toasts.clear();
		changed();
	}

	/** Forgets everything (tests, a different Node). */
	public void reset() {
		agents.clear();
		byUuid.clear();
		bubbles.clear();
		transcripts.clear();
		toasts.clear();
		brains = null;
		changed();
	}

	// ---------------------------------------------------------------------------------------------
	// Queries
	// ---------------------------------------------------------------------------------------------

	public Collection<AgentView> agents() {
		return agents.values();
	}

	public List<AgentView> living() {
		return agents.values().stream().filter(AgentView::alive).toList();
	}

	public @Nullable AgentView agent(String agentId) {
		return agents.get(agentId);
	}

	/** The crew member whose body has this player UUID. */
	public @Nullable AgentView byUuid(UUID uuid) {
		String id = byUuid.get(uuid);
		return id == null ? null : agents.get(id);
	}

	public @Nullable AgentView byHandle(String handle) {
		String h = handle.toLowerCase(Locale.ROOT);
		for (AgentView v : agents.values()) if (v.handle().equals(h)) return v;
		return null;
	}

	public @Nullable AgentView ceo() {
		for (AgentView v : agents.values()) if (v.ceo() && v.alive()) return v;
		return null;
	}

	/**
	 * The ApproachQueue presenter (PLAN §6.4: one at a time): the living agent presenting an unparked card; if several
	 * claim it (a stale push), the one with the oldest presented card.
	 */
	public @Nullable AgentView presenter() {
		AgentView best = null;
		long bestAt = Long.MAX_VALUE;
		for (AgentView v : agents.values()) {
			if (!v.alive()) continue;
			for (Ui.PendingCard c : v.cards()) {
				if (c.presenting() && !c.parked() && c.createdAt() < bestAt) {
					best = v;
					bestAt = c.createdAt();
				}
			}
		}
		return best;
	}

	/** Living agents with at least one card, oldest card first (CrewHud, G fallback). */
	public List<AgentView> withCards() {
		return agents.values().stream()
				.filter(v -> v.alive() && v.frontCard() != null)
				.sorted(Comparator.comparingLong(v -> {
					Ui.PendingCard c = v.frontCard();
					return c == null ? Long.MAX_VALUE : c.createdAt();
				}))
				.toList();
	}

	/** The live bubble of an agent, if any. */
	public @Nullable Bubble bubble(String agentId) {
		Bubble b = bubbles.get(agentId);
		if (b == null) return null;
		if (!b.alive(now())) {
			bubbles.remove(agentId);
			return null;
		}
		return b;
	}

	public List<Bubble> liveBubbles() {
		long now = now();
		bubbles.values().removeIf(b -> !b.alive(now));
		return List.copyOf(bubbles.values());
	}

	public Transcript transcript(String agentId) {
		return transcripts.computeIfAbsent(agentId, id -> new Transcript());
	}

	/** Every transcript line the client has, across agents, oldest first (the Crew log). */
	public List<LogLine> crewLog() {
		List<LogLine> out = new ArrayList<>();
		for (Map.Entry<String, Transcript> e : transcripts.entrySet()) {
			for (Ui.ChatEntry entry : e.getValue().entries()) out.add(new LogLine(e.getKey(), entry));
		}
		out.sort(Comparator.comparingLong((LogLine l) -> l.entry().at()).thenComparingLong(l -> l.entry().seq()));
		return out;
	}

	/** One Crew log line. */
	public record LogLine(String agentId, Ui.ChatEntry entry) {}

	public List<ToastEntry> toasts() {
		long now = now();
		if (toasts.removeIf(t -> !t.alive(now))) changed();
		return List.copyOf(toasts);
	}

	public Messages.@Nullable Brains brains() {
		return brains;
	}

	/** The display name of an agent, or its id. */
	public String nameOf(String agentId) {
		AgentView v = agents.get(agentId);
		return v == null ? agentId : v.name();
	}
}
