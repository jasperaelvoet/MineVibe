package dev.minevibe.bridge;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The process-wide {@link BridgeClient}. The client entrypoint installs it when {@code -Dminevibe.bridgeFile} is
 * set; common code (the integrated server's hardcore hooks) reaches Node through it. Null without a bridge
 * (client GameTests, a game launched without MineVibe).
 *
 * <p>Feature modules with their own entrypoints register their handlers through {@link #onInstall}: a {@code main}
 * entrypoint runs before the client entrypoint builds the bridge, so its callback runs at {@link #install}, before
 * the bridge connects and before {@code hello.ok} can arrive. Binary frames go to {@link #frameSink()}, a delegate
 * whose target a module sets with {@link #setFrameSink} (frames are dropped until then).
 */
public final class MineVibeBridge {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Bridge");

	private static volatile @Nullable BridgeClient instance;
	private static final List<Consumer<BridgeClient>> INSTALL_HOOKS = new CopyOnWriteArrayList<>();
	private static volatile FrameSink frameTarget = FrameSink.DISCARD;
	private static final FrameSink FRAME_DELEGATE = frame -> frameTarget.onFrame(frame);

	private MineVibeBridge() {}

	public static @Nullable BridgeClient get() {
		return instance;
	}

	/** Installs the bridge and runs every {@link #onInstall} callback (call before {@link BridgeClient#start()}). */
	public static void install(@Nullable BridgeClient client) {
		instance = client;
		if (client == null) return;
		for (Consumer<BridgeClient> hook : INSTALL_HOOKS) {
			runHook(hook, client);
		}
	}

	/** Runs {@code hook} with the bridge when it is installed, or now if it already is. */
	public static void onInstall(Consumer<BridgeClient> hook) {
		INSTALL_HOOKS.add(hook);
		BridgeClient client = instance;
		if (client != null) runHook(hook, client);
	}

	private static void runHook(Consumer<BridgeClient> hook, BridgeClient client) {
		try {
			hook.accept(client);
		} catch (RuntimeException e) {
			LOG.error("Bridge install hook failed", e);
		}
	}

	/** The sink to pass to {@link BridgeClient.Builder#frameSink}; it forwards to the target set by {@link #setFrameSink}. */
	public static FrameSink frameSink() {
		return FRAME_DELEGATE;
	}

	/** Where binary frames go from now on ({@link FrameSink#DISCARD} to drop them again). */
	public static void setFrameSink(FrameSink sink) {
		frameTarget = sink != null ? sink : FrameSink.DISCARD;
	}
}
