package dev.minevibe.agent.skill;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.ProtocolException;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Where the skill layer's mod-to-Node messages go ({@code agent.state}, {@code agent.event}, {@code skill.progress},
 * {@code skill.result}, {@code pc.seat}, {@code agent.died}). {@link #BRIDGE} is the real bridge; GameTests install a
 * recording outbox instead.
 */
public interface SkillOutbox {
	Logger LOG = LoggerFactory.getLogger("MineVibe/Skills");

	/** Fire and forget; dropped while Node is not connected (Node resyncs on the next {@code hello}). */
	<P> void send(MessageType<P> type, P payload);

	/** A request that must arrive: re-sent until Node answers {@code ok} ({@code agent.died}). */
	<P> void sendUntilAcked(MessageType<P> type, P payload);

	/** True while {@link #send} reaches Node (the bridge is handshaken); job outcomes wait for the next connection otherwise. */
	default boolean connected() {
		return true;
	}

	SkillOutbox BRIDGE = new SkillOutbox() {
		@Override
		public <P> void send(final MessageType<P> type, final P payload) {
			BridgeClient bridge = MineVibeBridge.get();
			if (bridge == null || !bridge.isHandshaken()) {
				return;
			}
			try {
				bridge.send(type, payload);
			} catch (ProtocolException e) {
				LOG.error("Dropping an invalid {}: {}", type, e.getMessage());
			}
		}

		@Override
		public boolean connected() {
			BridgeClient bridge = MineVibeBridge.get();
			return bridge != null && bridge.isHandshaken();
		}

		@Override
		public <P> void sendUntilAcked(final MessageType<P> type, final P payload) {
			BridgeClient bridge = MineVibeBridge.get();
			if (bridge == null) {
				return;
			}
			bridge.requestUntilAcked(type, () -> payload, Duration.ofSeconds(5), Duration.ofSeconds(2)).exceptionally(err -> {
				LOG.warn("{} was not acknowledged: {}", type, err.getMessage());
				return null;
			});
		}
	};
}
