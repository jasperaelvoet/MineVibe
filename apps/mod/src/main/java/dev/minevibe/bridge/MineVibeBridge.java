package dev.minevibe.bridge;

import org.jspecify.annotations.Nullable;

/**
 * The process-wide {@link BridgeClient}. The client entrypoint installs it when {@code -Dminevibe.bridgeFile} is
 * set; common code (the integrated server's hardcore hooks) reaches Node through it. Null without a bridge
 * (client GameTests, a game launched without MineVibe).
 */
public final class MineVibeBridge {
	private static volatile @Nullable BridgeClient instance;

	private MineVibeBridge() {}

	public static @Nullable BridgeClient get() {
		return instance;
	}

	public static void install(@Nullable BridgeClient client) {
		instance = client;
	}
}
