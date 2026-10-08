package dev.minevibe.client.org;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.MessageType;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Node pushes {@code codex.index}, {@code calendar.state} and {@code meeting.state} right after {@code hello.ok}; a
 * push that arrives before its handler exists is dropped. {@link OrgClientInit#attach} must therefore work on a bridge
 * that has not started yet (MineVibeClient calls it before {@code start()}), and calling it again (the entrypoint's
 * fallback) must not register anything twice.
 */
class OrgClientInitTest {
	@Test
	void attachRegistersTheOrgPushesBeforeTheBridgeStartsAndOnlyOnce() {
		BridgeClient bridge = BridgeClient.builder()
			.config(() -> {
				throw new IllegalStateException("never started");
			})
			.hello(() -> {
				throw new IllegalStateException("never started");
			})
			.build();
		try {
			OrgClientInit.attach(bridge);
			assertDoesNotThrow(() -> OrgClientInit.attach(bridge), "a second attach (the entrypoint's fallback) is a no-op");
			for (MessageType<?> type : List.of(Org.CODEX_INDEX, Org.CALENDAR_STATE, Org.MEETING_STATE)) {
				assertThrows(IllegalStateException.class, () -> register(bridge, type), type + " already has the org handler");
			}
		} finally {
			bridge.close("test");
		}
	}

	private static <P> void register(final BridgeClient bridge, final MessageType<P> type) {
		bridge.on(type, Route.CLIENT, payload -> {
		});
	}
}
