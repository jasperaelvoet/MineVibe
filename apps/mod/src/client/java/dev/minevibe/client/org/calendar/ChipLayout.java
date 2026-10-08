package dev.minevibe.client.org.calendar;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * Stacks event chips on a timeline into lanes so none overlap: each chip goes into the first lane whose last chip
 * ended before it starts (interval partitioning, in start order). Coordinates are pixels, ends exclusive.
 */
public final class ChipLayout {
	private ChipLayout() {
	}

	/** The lane of each chip ({@code starts[i]..ends[i]}), 0 being the top lane. */
	public static int[] lanes(final int[] starts, final int[] ends) {
		if (starts.length != ends.length) {
			throw new IllegalArgumentException("starts and ends differ in length");
		}
		Integer[] order = new Integer[starts.length];
		for (int i = 0; i < order.length; i++) {
			order[i] = i;
		}
		Arrays.sort(order, Comparator.comparingInt((Integer i) -> starts[i]).thenComparingInt(i -> ends[i]).thenComparingInt(i -> i));
		int[] lane = new int[starts.length];
		List<Integer> laneEnds = new ArrayList<>();
		for (int i : order) {
			int chosen = -1;
			for (int l = 0; l < laneEnds.size(); l++) {
				if (laneEnds.get(l) <= starts[i]) {
					chosen = l;
					break;
				}
			}
			if (chosen < 0) {
				chosen = laneEnds.size();
				laneEnds.add(ends[i]);
			} else {
				laneEnds.set(chosen, ends[i]);
			}
			lane[i] = chosen;
		}
		return lane;
	}

	/** How many lanes {@link #lanes} used. */
	public static int laneCount(final int[] lanes) {
		int max = -1;
		for (int lane : lanes) {
			max = Math.max(max, lane);
		}
		return max + 1;
	}
}
