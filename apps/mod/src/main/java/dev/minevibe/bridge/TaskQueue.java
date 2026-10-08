package dev.minevibe.bridge;

import java.util.Objects;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Bridge work for one thread, run when that thread calls {@link #drain()}. The game uses it for
 * {@link BridgeClient.Route#CLIENT} handlers instead of {@code Minecraft#execute}: {@code Minecraft#disconnect}
 * clears vanilla's task queue ({@code dropAllTasks}), which silently dropped bridge messages that arrived while a
 * world was being left ({@code world.next}, toasts, debug replies). This queue is only emptied by running it.
 */
public final class TaskQueue implements Executor {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Bridge");

	private final ConcurrentLinkedQueue<Runnable> queue = new ConcurrentLinkedQueue<>();

	@Override
	public void execute(Runnable task) {
		queue.add(Objects.requireNonNull(task, "task"));
	}

	/**
	 * Runs the tasks queued so far, in order; tasks queued while draining wait for the next drain. A task that throws
	 * is logged and does not stop the others. Returns how many ran.
	 */
	public int drain() {
		int ran = 0;
		for (int n = queue.size(); n > 0; n--) {
			Runnable task = queue.poll();
			if (task == null) break;
			try {
				task.run();
			} catch (RuntimeException e) {
				LOG.error("Bridge task failed", e);
			}
			ran++;
		}
		return ran;
	}

	public int size() {
		return queue.size();
	}
}
