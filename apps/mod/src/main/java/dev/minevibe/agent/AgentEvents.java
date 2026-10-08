package dev.minevibe.agent;

import dev.minevibe.MineVibeMod;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Body events ({@code agent.event} / {@code agent.died} on the bridge, PLAN 5). For S1 there is no
 * bridge yet: events are logged, kept in a small ring buffer (GameTests read it) and offered to
 * listeners, which the bridge client will subscribe to later.
 */
public final class AgentEvents {
	public record Event(String agentId, String type, Map<String, String> data, long gameTime) {
	}

	public interface Listener {
		void onEvent(Event event);
	}

	private static final int RING = 256;
	private static final Deque<Event> RECENT = new ArrayDeque<>();
	private static final List<Listener> LISTENERS = new CopyOnWriteArrayList<>();

	private AgentEvents() {
	}

	public static void addListener(final Listener listener) {
		LISTENERS.add(listener);
	}

	public static void emit(final AgentPlayer agent, final String type, final Map<String, String> data) {
		Event event = new Event(agent.agentId(), type, Map.copyOf(data), agent.level().getGameTime());
		synchronized (RECENT) {
			RECENT.addLast(event);
			while (RECENT.size() > RING) {
				RECENT.removeFirst();
			}
		}
		MineVibeMod.LOGGER.info("[agent {}] {} {}", agent.agentId(), type, data);
		for (Listener listener : LISTENERS) {
			listener.onEvent(event);
		}
	}

	/** Recent events for {@code agentId}, oldest first. */
	public static List<Event> recent(final String agentId) {
		List<Event> out = new ArrayList<>();
		synchronized (RECENT) {
			for (Event e : RECENT) {
				if (e.agentId().equals(agentId)) {
					out.add(e);
				}
			}
		}
		return out;
	}
}
