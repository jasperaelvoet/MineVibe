package dev.minevibe.gametest.agent;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.SkillOutbox;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.bridge.protocol.ProtocolException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Predicate;
import net.minecraft.gametest.framework.GameTestHelper;

/**
 * Skill GameTest helpers: a recording outbox that also validates every message against the protocol schema (so a
 * payload the bridge would refuse fails the test), and {@code skill.run} shortcuts.
 */
final class SkillTestSupport {
	private SkillTestSupport() {
	}

	/** One message the skill layer sent; {@code error} is set when it did not match its schema. */
	record Sent(MessageType<?> type, Object payload, String json, String error) {
	}

	/** Records everything instead of sending it; shared by all tests (they filter by agent or job id). */
	static final class Recorder implements SkillOutbox {
		private final List<Sent> sent = new ArrayList<>();
		private volatile boolean connected = true;

		/** While false, {@link #send} drops messages like a bridge without Node (only the reconnect test's own batch). */
		void setConnected(final boolean connected) {
			this.connected = connected;
		}

		@Override
		public boolean connected() {
			return this.connected;
		}

		@Override
		public <P> void send(final MessageType<P> type, final P payload) {
			if (!this.connected) {
				return;
			}
			String json = null;
			String error = null;
			try {
				json = ProtocolCodec.encode(type, payload, null, null);
			} catch (ProtocolException e) {
				error = e.getMessage();
			}
			synchronized (this.sent) {
				this.sent.add(new Sent(type, payload, json, error));
			}
		}

		@Override
		public <P> void sendUntilAcked(final MessageType<P> type, final P payload) {
			this.send(type, payload);
		}

		List<Sent> all() {
			synchronized (this.sent) {
				return List.copyOf(this.sent);
			}
		}

		<P> List<P> of(final MessageType<P> type, final Predicate<P> filter) {
			List<P> out = new ArrayList<>();
			for (Sent s : this.all()) {
				if (s.type() == type) {
					@SuppressWarnings("unchecked")
					P p = (P)s.payload();
					if (filter.test(p)) {
						out.add(p);
					}
				}
			}
			return out;
		}

		/** Messages about {@code agentId} that failed schema validation. */
		List<Sent> invalid(final String agentId) {
			List<Sent> out = new ArrayList<>();
			for (Sent s : this.all()) {
				if (s.error() != null && String.valueOf(s.payload()).contains(agentId)) {
					out.add(s);
				}
			}
			return out;
		}

		List<Bodies.AgentEvent> events(final String agentId, final String kind) {
			return this.of(Bodies.AGENT_EVENT, e -> e.agentId().equals(agentId) && e.kind().equals(kind));
		}

		List<Skills.SkillResult> results(final String jobId) {
			return this.of(Skills.SKILL_RESULT, r -> r.jobId().equals(jobId));
		}
	}

	private static final Recorder RECORDER = new Recorder();
	private static final AtomicLong JOB_SEQ = new AtomicLong();

	static Recorder recorder(final GameTestHelper helper) {
		SkillService service = SkillService.get(helper.getLevel().getServer());
		if (service.outbox() != RECORDER) {
			service.setOutbox(RECORDER);
		}
		return RECORDER;
	}

	static SkillService service(final GameTestHelper helper) {
		recorder(helper);
		return SkillService.get(helper.getLevel().getServer());
	}

	static String jobId(final String prefix) {
		return prefix + "-" + JOB_SEQ.incrementAndGet();
	}

	static JsonObject json(final String text) {
		return JsonParser.parseString(text).getAsJsonObject();
	}

	/** {@code skill.run} as the bridge would deliver it; the future is the reply. */
	static CompletableFuture<Map<String, Object>> run(
		final GameTestHelper helper, final AgentPlayer agent, final String jobId, final String skill, final String args, final int waitMs
	) {
		return service(helper).run(new Skills.SkillRun(jobId, agent.agentId(), skill, json(args), waitMs, true));
	}

	/** The reply's status, or null while it is pending. */
	static String status(final CompletableFuture<Map<String, Object>> reply) {
		if (!reply.isDone()) {
			return null;
		}
		return String.valueOf(reply.join().get("status"));
	}

	static JsonObject result(final CompletableFuture<Map<String, Object>> reply) {
		Object r = reply.join().get("result");
		return r instanceof JsonObject o ? o : new JsonObject();
	}

	static String error(final CompletableFuture<Map<String, Object>> reply) {
		Object e = reply.join().get("error");
		return e == null ? "" : e.toString();
	}

	static String rel(final GameTestHelper helper, final int x, final int y, final int z) {
		var p = helper.absolutePos(new net.minecraft.core.BlockPos(x, y, z));
		return "{\"x\":" + p.getX() + ",\"y\":" + p.getY() + ",\"z\":" + p.getZ() + "}";
	}
}
