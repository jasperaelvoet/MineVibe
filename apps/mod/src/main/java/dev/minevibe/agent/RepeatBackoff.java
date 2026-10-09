package dev.minevibe.agent;

/**
 * When a stuck agent says the same thing again (PLAN 7.3, "stuck is said out loud"): the first time at once, a repeat
 * only {@code base} ticks after it, the next one twice as long after that, and so on up to {@code max} between two.
 * Every time is a bark and a brain turn, so an agent that stays stuck for an hour speaks up a handful of times, not
 * sixty. {@link #reset} (the agent got out of the water, got somewhere) makes the next one immediate again: a new
 * situation is never kept quiet by an old one.
 */
public final class RepeatBackoff {
	private final int base;
	private final int max;
	private int gap;
	private boolean said;
	private int saidAt;

	public RepeatBackoff(final int base, final int max) {
		this.base = base;
		this.max = Math.max(base, max);
		this.gap = base;
	}

	/** True if saying it at tick {@code now} is due: never said since the last {@link #reset}, or the gap has passed. */
	public boolean due(final int now) {
		return !this.said || now - this.saidAt >= this.gap;
	}

	/** Records that it was said at tick {@code now}: a repeat waits the current gap, and each repeat doubles it. */
	public void said(final int now) {
		if (this.said) {
			this.gap = Math.min(this.max, this.gap * 2);
		}
		this.said = true;
		this.saidAt = now;
	}

	/** The situation is over: the next one is said at once, and its repeats start from {@code base} again. */
	public void reset() {
		this.said = false;
		this.gap = this.base;
	}

	/** Ticks a repeat waits now (tests, logs). */
	public int gap() {
		return this.gap;
	}
}
