package dev.minevibe.client;

import dev.minevibe.bridge.BridgeConfig;
import java.nio.file.Path;
import java.util.OptionalLong;
import org.jspecify.annotations.Nullable;

/**
 * JVM system properties the game is launched with (PLAN §5, §9.2). Node passes them; for {@code ./gradlew runClient}
 * the Loom run config fills them from environment variables (see {@code apps/mod/README.md}).
 *
 * @param bridgeFile {@code -Dminevibe.bridgeFile}: Node's {@code run/bridge.json}; no bridge without it
 * @param e2e {@code -Dminevibe.e2e=true}: enables the {@code debug.*} handlers
 * @param dev {@code -Dminevibe.dev=true}: new worlds allow commands
 * @param parentPid {@code -Dminevibe.parentPid}: quit (saving) when this process exits
 * @param gameTest {@code -Dfabric.client.gametest} is set: the screen redirects stay off and no bridge starts
 */
public record ClientConfig(@Nullable Path bridgeFile, boolean e2e, boolean dev, OptionalLong parentPid, boolean gameTest) {
	public static final String E2E_PROPERTY = "minevibe.e2e";
	public static final String DEV_PROPERTY = "minevibe.dev";
	public static final String PARENT_PID_PROPERTY = "minevibe.parentPid";
	public static final String CLIENT_GAMETEST_PROPERTY = "fabric.client.gametest";

	private static volatile @Nullable ClientConfig current;

	/** The configuration read at client start (read lazily if asked earlier, e.g. by a mixin). */
	public static ClientConfig get() {
		ClientConfig c = current;
		if (c == null) {
			c = fromSystemProperties();
			current = c;
		}
		return c;
	}

	public static ClientConfig fromSystemProperties() {
		return new ClientConfig(
				BridgeConfig.fileFromSystemProperties(),
				flag(E2E_PROPERTY),
				flag(DEV_PROPERTY),
				pid(System.getProperty(PARENT_PID_PROPERTY)),
				System.getProperty(CLIENT_GAMETEST_PROPERTY) != null);
	}

	private static boolean flag(String name) {
		String v = System.getProperty(name);
		return v != null && (v.equalsIgnoreCase("true") || v.equals("1") || v.equalsIgnoreCase("yes"));
	}

	private static OptionalLong pid(@Nullable String value) {
		if (value == null || value.isBlank()) return OptionalLong.empty();
		try {
			long pid = Long.parseLong(value.trim());
			return pid > 0 ? OptionalLong.of(pid) : OptionalLong.empty();
		} catch (NumberFormatException e) {
			return OptionalLong.empty();
		}
	}

	/** MineVibe takes over the title, death and pause screens (always, except under client GameTests). */
	public boolean redirectScreens() {
		return !gameTest;
	}
}
