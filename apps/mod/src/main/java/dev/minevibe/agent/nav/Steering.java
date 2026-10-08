package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Safety check for direct steering (code paths that walk without an A* path: the last metre to a goal,
 * melee, backing off from a creeper). A step is unsafe when it leads into lava or fire, or off a ledge
 * deeper than 3 blocks.
 */
public final class Steering {
	private static final int MAX_DROP = 3;

	private Steering() {
	}

	/** True if walking ~0.8 blocks in direction {@code yawDegrees} is safe. */
	public static boolean safeAhead(final AgentPlayer agent, final float yawDegrees) {
		double rad = Math.toRadians(yawDegrees);
		double dx = -Math.sin(rad);
		double dz = Math.cos(rad);
		ServerLevel level = agent.level();
		BlockPos ahead = BlockPos.containing(agent.getX() + dx * 0.8, agent.getY() + 0.05, agent.getZ() + dz * 0.8);
		if (isHot(level, ahead)) {
			return false;
		}
		if (!level.getBlockState(ahead).getCollisionShape(level, ahead).isEmpty()) {
			// A wall or a step: collision stops us, nothing to fall into.
			return true;
		}
		for (int d = 1; d <= MAX_DROP + 1; d++) {
			BlockPos below = ahead.below(d);
			BlockState state = level.getBlockState(below);
			if (isHot(level, below)) {
				return false;
			}
			if (!state.getCollisionShape(level, below).isEmpty() || !level.getFluidState(below).isEmpty()) {
				// Lands after a drop of d - 1 blocks (at most MAX_DROP here).
				return true;
			}
		}
		return false;
	}

	private static boolean isHot(final ServerLevel level, final BlockPos pos) {
		BlockState state = level.getBlockState(pos);
		return level.getFluidState(pos).is(FluidTags.LAVA) || state.is(BlockTags.FIRE) || state.is(Blocks.MAGMA_BLOCK) || state.is(Blocks.CAMPFIRE);
	}
}
