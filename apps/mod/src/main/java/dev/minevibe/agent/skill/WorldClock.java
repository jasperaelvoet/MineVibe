package dev.minevibe.agent.skill;

import net.minecraft.server.MinecraftServer;

/**
 * The overworld clock as the integrated server sees it ({@code server.overworld().getOverworldClockTime()}, PLAN 6.6),
 * published once a second from the server tick so {@code world.state} carries the real calendar clock even while the
 * player is in another dimension and no agent is alive. The client's 1 Hz {@code world.state} push reads it here.
 */
public final class WorldClock {
	private static final long STALE_NANOS = 5_000_000_000L;

	private static volatile long clockTime = -1L;
	private static volatile long publishedAt;

	private WorldClock() {
	}

	/** Server thread: publish the current overworld clock. */
	public static void publish(final MinecraftServer server) {
		clockTime = Math.max(0L, server.overworld().getOverworldClockTime());
		publishedAt = System.nanoTime();
	}

	public static void clear() {
		clockTime = -1L;
	}

	/** The overworld clock in ticks, or {@code fallback} when the server has not published one in the last 5 s. */
	public static long overworldClockTime(final long fallback) {
		long t = clockTime;
		return t >= 0 && System.nanoTime() - publishedAt < STALE_NANOS ? t : Math.max(0L, fallback);
	}

	/** Day number (06:00 starts a day; day 1 at tick 0) and HH:MM for a clock time. */
	public static String dayAndTime(final long t) {
		long day = t / 24000L + 1;
		long inDay = Math.floorMod(t, 24000L);
		long hour = (inDay / 1000L + 6) % 24;
		long minute = inDay % 1000L * 60 / 1000;
		return String.format(java.util.Locale.ROOT, "day %d %02d:%02d", day, hour, minute);
	}
}
