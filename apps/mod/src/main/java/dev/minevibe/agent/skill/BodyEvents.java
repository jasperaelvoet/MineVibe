package dev.minevibe.agent.skill;

import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * {@code agent.event} (protocol §7.3): notable body events with an urgency (0 info, 1 notable, 2 critical). Each event is
 * also kept in {@link AgentEvents} (so {@code recent_events} sees it) and throttled per agent and kind, so a burning
 * agent does not send twenty "hurt" events a second.
 */
public final class BodyEvents {
	public static final int INFO = 0;
	public static final int NOTABLE = 1;
	public static final int CRITICAL = 2;

	private static final Map<String, Long> LAST = new HashMap<>();

	private BodyEvents() {
	}

	/** Emits unless the same agent emitted the same kind less than {@code cooldownTicks} ago. Returns true when sent. */
	public static boolean emit(
		final AgentPlayer agent, final String kind, final int urgency, final String text, final @Nullable Map<String, ?> data, final int cooldownTicks
	) {
		if (!Bodies.EVENT_KINDS.contains(kind)) {
			throw new IllegalArgumentException("unknown agent.event kind " + kind);
		}
		long now = agent.level().getGameTime();
		String key = agent.agentId() + "/" + kind;
		synchronized (LAST) {
			Long last = LAST.get(key);
			if (cooldownTicks > 0 && last != null && now - last < cooldownTicks && now >= last) {
				return false;
			}
			LAST.put(key, now);
		}
		Map<String, String> log = new LinkedHashMap<>();
		log.put("urgency", Integer.toString(urgency));
		log.put("text", text);
		if (data != null) {
			for (Map.Entry<String, ?> e : data.entrySet()) {
				log.put(e.getKey(), String.valueOf(e.getValue()));
			}
		}
		AgentEvents.emit(agent, "event." + kind, log);
		JsonObject json = null;
		if (data != null && !data.isEmpty()) {
			json = new JsonObject();
			for (Map.Entry<String, ?> e : data.entrySet()) {
				json.add(e.getKey(), dev.minevibe.agent.job.SkillJob.toJson(e.getValue()));
			}
		}
		SkillService service = SkillService.current();
		if (service != null && service.server() == agent.level().getServer()) {
			service.outbox().send(Bodies.AGENT_EVENT, new Bodies.AgentEvent(agent.agentId(), kind, Math.max(0, Math.min(3, urgency)), ProtocolCodec.clip(text.isEmpty() ? kind : text, 256), json));
		}
		return true;
	}

	public static boolean emit(final AgentPlayer agent, final String kind, final int urgency, final String text) {
		return emit(agent, kind, urgency, text, null, 0);
	}

	/** Forget throttling state (tests; a new world). */
	public static void reset() {
		synchronized (LAST) {
			LAST.clear();
		}
	}
}
