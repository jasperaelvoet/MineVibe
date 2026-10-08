package dev.minevibe.client;

import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Lifeline to Node (PLAN §9.2): with {@code -Dminevibe.parentPid=<pid>}, the game saves the world and quits when
 * that process exits, so a crashed or killed Node never leaves an orphaned game behind. If the game has not
 * stopped {@link #FORCE_EXIT_AFTER_MS} later, the JVM exits (the shutdown hook still halts the server, saving).
 */
public final class ParentWatchdog {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Lifeline");
	static final long FORCE_EXIT_AFTER_MS = TimeUnit.SECONDS.toMillis(60);
	private static final AtomicBoolean triggered = new AtomicBoolean();

	private ParentWatchdog() {}

	public static void start(long parentPid) {
		Optional<ProcessHandle> parent = ProcessHandle.of(parentPid);
		if (parent.isEmpty() || !parent.get().isAlive()) {
			LOG.warn("Parent process {} is not running; quitting", parentPid);
			stopGame(parentPid);
			return;
		}
		LOG.info("Watching parent process {}", parentPid);
		parent.get().onExit().thenRun(() -> stopGame(parentPid));
	}

	private static void stopGame(long parentPid) {
		if (!triggered.compareAndSet(false, true)) return;
		LOG.warn("Parent process {} exited: saving and quitting", parentPid);
		Minecraft mc = Minecraft.getInstance();
		if (mc != null) {
			mc.execute(mc::stop);
		}
		Thread force = new Thread(() -> {
			try {
				Thread.sleep(FORCE_EXIT_AFTER_MS);
			} catch (InterruptedException e) {
				return;
			}
			LOG.error("Game did not stop {} s after its parent exited; exiting", FORCE_EXIT_AFTER_MS / 1000);
			System.exit(0);
		}, "mv-parent-watchdog");
		force.setDaemon(true);
		force.start();
	}
}
