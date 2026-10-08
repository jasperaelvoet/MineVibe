package dev.minevibe.agent.perception;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.pathfinder.Path;
import org.jspecify.annotations.Nullable;

/**
 * Quick reachability checks for perception and resource picking: one vanilla A* search (the agent's own navigator,
 * at most 4000 nodes and 64 blocks of path) that must end within 2 blocks of the target, the way a player stands
 * next to a tree trunk to chop it. Server thread; a few milliseconds per call at worst, so callers check a handful of
 * candidates, nearest first.
 */
public final class Reach {
	/** Targets farther than this (horizontally) are not checked: one search does not go that far. */
	public static final int MAX_CHECK = 56;

	public enum Result {
		YES,
		NO,
		/** Too far to check with one search. */
		UNKNOWN;

		public String word() {
			return switch (this) {
				case YES -> "reachable";
				case NO -> "unreachable";
				case UNKNOWN -> "far";
			};
		}
	}

	private Reach() {
	}

	/** Whether {@code agent} can walk to within 2 blocks of {@code target} (a block it would then work on). */
	public static Result walkTo(final AgentPlayer agent, final BlockPos target) {
		BlockPos from = agent.blockPosition();
		double dx = target.getX() - from.getX();
		double dz = target.getZ() - from.getZ();
		if (dx * dx + dz * dz > (double)MAX_CHECK * MAX_CHECK) {
			return Result.UNKNOWN;
		}
		if (agent.getEyePosition().distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(target)) <= 4.0) {
			return Result.YES;
		}
		@Nullable Path path = agent.navigator().findPath(target, 2);
		return path != null && path.canReach() ? Result.YES : Result.NO;
	}
}
