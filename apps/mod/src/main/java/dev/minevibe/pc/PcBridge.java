package dev.minevibe.pc;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The PC group on the bridge (protocol 7.7), common side: Node's {@code pc.state}, {@code budget.state} and
 * {@code pc.cursor} land in {@link PcStates} (directly on the listener thread, it is thread-safe), and the PC
 * requests the mod makes ({@code pc.action}, {@code pc.config}, {@code pc.consent}, {@code host.pick_folder}) go out
 * through {@link #request}. Registered from {@link PcModInit} through {@link MineVibeBridge#onInstall}, so the
 * handlers exist before the bridge connects (the {@code hello.ok} snapshot must not be missed).
 */
public final class PcBridge {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");

	/** Long enough for a {@code create} that pulls nothing (Node admits it, then boots in the background). */
	public static final Duration ACTION_TIMEOUT = Duration.ofSeconds(30);
	/** The native folder picker waits for the player. */
	public static final Duration PICK_FOLDER_TIMEOUT = Duration.ofMinutes(10);

	/** Runs (on a bridge thread) after every {@code hello.ok}: the client re-sends its frame tiers. */
	private static final List<Runnable> HANDSHAKE_HOOKS = new CopyOnWriteArrayList<>();

	private PcBridge() {}

	public static void register(final BridgeClient bridge) {
		bridge.on(Pc.PC_STATE, Route.BRIDGE, PcStates::put);
		bridge.on(Pc.BUDGET_STATE, Route.BRIDGE, PcStates::budget);
		bridge.on(Pc.PC_CURSOR, Route.BRIDGE, PcStates::cursor);
		bridge.addListener(new BridgeClient.ConnectionListener() {
			@Override
			public void onHandshake(final Messages.HelloOk helloOk) {
				PcStates.replaceAll(helloOk.pcs(), helloOk.budget());
				for (Runnable hook : HANDSHAKE_HOOKS) {
					try {
						hook.run();
					} catch (RuntimeException e) {
						LOG.error("PC handshake hook failed", e);
					}
				}
			}

			@Override
			public void onDisconnected(final String reason) {
				PcStates.connected(false);
			}
		});
	}

	public static void onHandshake(final Runnable hook) {
		HANDSHAKE_HOOKS.add(hook);
	}

	/** Sends a fire-and-forget PC message; false when there is no bridge or it is down. */
	public static <P> boolean send(final MessageType<P> type, final P payload) {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			return false;
		}
		try {
			return bridge.send(type, payload);
		} catch (RuntimeException e) {
			LOG.warn("Could not send {}: {}", type, e.getMessage());
			return false;
		}
	}

	/**
	 * Sends a PC request. Fails with a {@link BridgeException}: Node's {@code err} code, {@code TIMEOUT},
	 * {@code DISCONNECTED}, or {@code OFFLINE} when the game runs without a bridge (GameTests, a bare client).
	 */
	public static <P> CompletableFuture<JsonObject> request(final MessageType<P> type, final P payload, final Duration timeout) {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			return CompletableFuture.failedFuture(new BridgeException(OFFLINE, "MineVibe is not connected"));
		}
		return bridge.request(type, payload, timeout);
	}

	/** {@code pc.action} with the default timeout. */
	public static CompletableFuture<JsonObject> action(
		final String action, final @Nullable String pcId, final @Nullable String type, final Messages.@Nullable BlockPos pos
	) {
		return request(Pc.PC_ACTION, new Pc.PcAction(action, pcId, type, pos), ACTION_TIMEOUT);
	}

	/** The error code of a failed request ({@code err} code, {@code TIMEOUT}, ...), or {@code INTERNAL}. */
	public static String codeOf(final Throwable error) {
		BridgeException be = BridgeClient.unwrap(error);
		return be != null ? be.code() : Messages.Codes.INTERNAL;
	}

	/** Local code: the game has no bridge at all. */
	public static final String OFFLINE = "OFFLINE";
}
