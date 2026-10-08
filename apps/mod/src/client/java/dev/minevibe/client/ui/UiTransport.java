package dev.minevibe.client.ui;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages.Codes;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * How the UI reaches Node: the process-wide {@link BridgeClient} by default. Client GameTests install a fake, so chat
 * interception and AgentScreen actions can be tested without a running Node.
 */
public interface UiTransport {
	/** UI requests time out after this long. */
	Duration TIMEOUT = Duration.ofSeconds(10);

	/** MineVibe runs with a bridge (chat is intercepted). False in a game started without MineVibe. */
	boolean configured();

	/** The bridge is connected and handshaken, so requests can go out now. */
	boolean connected();

	/** Sends a request; completes (on a bridge thread) with the {@code ok} result keys, or fails with a {@link BridgeException}. */
	<P> CompletableFuture<JsonObject> request(MessageType<P> type, P payload);

	static UiTransport current() {
		return Holder.current;
	}

	/** Replaces the transport; {@code null} restores the bridge. */
	static void install(@Nullable UiTransport transport) {
		Holder.current = transport != null ? transport : Holder.BRIDGE;
	}

	/** The holder of the current transport. */
	final class Holder {
		private Holder() {}

		static final UiTransport BRIDGE = new UiTransport() {
			@Override
			public boolean configured() {
				return MineVibeBridge.get() != null;
			}

			@Override
			public boolean connected() {
				BridgeClient bridge = MineVibeBridge.get();
				return bridge != null && bridge.isHandshaken();
			}

			@Override
			public <P> CompletableFuture<JsonObject> request(MessageType<P> type, P payload) {
				BridgeClient bridge = MineVibeBridge.get();
				if (bridge == null) {
					return CompletableFuture.failedFuture(new BridgeException(Codes.DISCONNECTED, "MineVibe is not running"));
				}
				return bridge.request(type, payload, TIMEOUT);
			}
		};

		static volatile UiTransport current = BRIDGE;
	}
}
