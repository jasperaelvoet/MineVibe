package dev.minevibe.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The client-thread queue for bridge work, which a disconnect cannot drop (review finding MINOR 6). */
class TaskQueueTest {
	@Test
	void runsQueuedTasksInOrderOnDrainOnly() {
		TaskQueue q = new TaskQueue();
		List<String> ran = new ArrayList<>();
		q.execute(() -> ran.add("a"));
		q.execute(() -> ran.add("b"));
		assertEquals(List.of(), ran, "nothing runs until the owning thread drains");
		assertEquals(2, q.drain());
		assertEquals(List.of("a", "b"), ran);
		assertEquals(0, q.drain());
	}

	@Test
	void aFailingTaskDoesNotStopTheOthers() {
		TaskQueue q = new TaskQueue();
		List<String> ran = new ArrayList<>();
		q.execute(() -> {
			throw new IllegalStateException("boom");
		});
		q.execute(() -> ran.add("after"));
		assertEquals(2, q.drain());
		assertEquals(List.of("after"), ran);
	}

	@Test
	void tasksQueuedWhileDrainingWaitForTheNextDrain() {
		TaskQueue q = new TaskQueue();
		List<String> ran = new ArrayList<>();
		q.execute(() -> {
			ran.add("first");
			q.execute(() -> ran.add("second"));
		});
		assertEquals(1, q.drain());
		assertEquals(List.of("first"), ran);
		assertEquals(1, q.size());
		q.drain();
		assertEquals(List.of("first", "second"), ran);
	}
}
