package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;
import org.jspecify.annotations.Nullable;

/**
 * Slider limits of the PcConfigScreen (PLAN 8.2): CPU and RAM sliders clamp to what the host budget has free. A
 * running PC's own share is already counted as used, so it may keep what it has plus the free part; a stopped PC
 * starts from the free part alone (never below its current size, so the slider does not jump; Node refuses with
 * {@code OVER_BUDGET} if it really does not fit). CPUs may overcommit up to {@code maxOvercommit} with a warning.
 */
public final class PcBudgetMath {
	public static final int MIN_CPUS = 1;
	public static final int MAX_CPUS = 64;
	public static final int MIN_MEMORY_MIB = 1024;
	public static final int MAX_MEMORY_MIB = 1_048_576;
	public static final int MEMORY_STEP_MIB = 512;

	private PcBudgetMath() {}

	/** Statuses whose CPU and RAM already count as used. */
	public static boolean isActive(final String status) {
		return switch (status) {
			case "running", "booting", "downloading", "awaiting_consent", "stopping", "remounting", "reimaging" -> true;
			default -> false;
		};
	}

	/** The highest CPU count the slider offers. */
	public static int maxCpus(final Pc.PcInfo pc, final Pc.@Nullable Budget budget) {
		if (budget == null) {
			return Math.max(pc.cpus(), MIN_CPUS);
		}
		Pc.CpuBudget cpu = budget.cpu();
		long ceiling = (long) Math.floor(cpu.total() * cpu.maxOvercommit()) - cpu.used();
		long max = isActive(pc.status()) ? pc.cpus() + ceiling : ceiling;
		return (int) clamp(Math.max(max, pc.cpus()), MIN_CPUS, MAX_CPUS);
	}

	/** The CPU count above which the PC overcommits the host (the slider shows a warning). */
	public static int comfortableCpus(final Pc.PcInfo pc, final Pc.@Nullable Budget budget) {
		if (budget == null) {
			return pc.cpus();
		}
		long free = budget.cpu().free();
		long max = isActive(pc.status()) ? pc.cpus() + free : free;
		return (int) clamp(max, MIN_CPUS, MAX_CPUS);
	}

	/** The highest RAM (MiB, a multiple of {@link #MEMORY_STEP_MIB}) the slider offers. */
	public static int maxMemoryMiB(final Pc.PcInfo pc, final Pc.@Nullable Budget budget) {
		if (budget == null) {
			return Math.max(pc.memoryMiB(), MIN_MEMORY_MIB);
		}
		long free = budget.memoryMiB().free();
		long max = isActive(pc.status()) ? pc.memoryMiB() + free : free;
		max = max / MEMORY_STEP_MIB * MEMORY_STEP_MIB;
		return (int) clamp(Math.max(max, pc.memoryMiB()), MIN_MEMORY_MIB, MAX_MEMORY_MIB);
	}

	/** Snaps a slider position (0..1) to a CPU count in {@code [MIN_CPUS, max]}. */
	public static int cpusAt(final double value, final int max) {
		return (int) clamp(Math.round(MIN_CPUS + value * (max - MIN_CPUS)), MIN_CPUS, max);
	}

	/** Snaps a slider position (0..1) to RAM in {@code [MIN_MEMORY_MIB, max]}, in steps of {@link #MEMORY_STEP_MIB}. */
	public static int memoryAt(final double value, final int max) {
		double raw = MIN_MEMORY_MIB + value * (max - MIN_MEMORY_MIB);
		long snapped = Math.round(raw / MEMORY_STEP_MIB) * MEMORY_STEP_MIB;
		return (int) clamp(snapped, MIN_MEMORY_MIB, max);
	}

	/** The slider position of a value in {@code [min, max]}. */
	public static double position(final int value, final int min, final int max) {
		return max <= min ? 1.0 : clamp(value - min, 0, max - min) / (double) (max - min);
	}

	private static long clamp(final long v, final long lo, final long hi) {
		return Math.max(lo, Math.min(hi, v));
	}
}
