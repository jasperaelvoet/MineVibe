package dev.minevibe.agent.nav;

import java.util.List;

/**
 * A Tier-2 path: its steps from the start to the goal, the estimated cost (ticks) and what the search took (nodes
 * expanded, nanoseconds, ticks it ran in).
 */
public record DigPath(List<DigStep> steps, double cost, int nodes, long nanos, int ticks) {
	public DigPath {
		steps = List.copyOf(steps);
	}

	public int breaks() {
		return this.steps.stream().mapToInt(s -> s.breaks().size()).sum();
	}

	public int places() {
		return (int)this.steps.stream().filter(s -> s.place() != null).count();
	}

	public boolean isEmpty() {
		return this.steps.isEmpty();
	}
}
