package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Block-level hands for jobs: survival mining with the best tool, and placing a block against a neighbour. */
public final class BlockOps {
	private BlockOps() {
	}

	/** Outcome of one placement attempt. */
	public enum Place {
		PLACED,
		/** Not yet (use cooldown, or the click did not take); try again next tick. */
		RETRY,
		NO_ITEM,
		/** Something solid is already there. */
		OCCUPIED,
		/** No neighbouring block to place against. */
		NO_SUPPORT,
		/** The agent itself stands in the way. */
		SELF_IN_WAY,
		/** Another entity stands in the way. */
		ENTITY_IN_WAY
	}

	/** True when there is nothing to mine at {@code pos} (air, or a fluid, which cannot be mined). */
	public static boolean isClear(final ServerLevel level, final BlockPos pos) {
		BlockState s = level.getBlockState(pos);
		return s.isAir() || s.canBeReplaced() && s.getCollisionShape(level, pos).isEmpty() && !s.getFluidState().isEmpty();
	}

	public static boolean unbreakable(final ServerLevel level, final BlockPos pos) {
		return level.getBlockState(pos).getDestroySpeed(level, pos) < 0.0F;
	}

	/**
	 * Holds attack on {@code pos} for one tick with the best tool, at survival speed. The caller keeps the block in reach.
	 * Returns true once the block is gone.
	 */
	public static boolean mineTick(final AgentPlayer agent, final BlockPos pos) {
		ServerLevel level = agent.level();
		BlockState state = level.getBlockState(pos);
		if (state.isAir()) {
			agent.controls().stopMining();
			return true;
		}
		int tool = AgentInventory.bestToolSlot(agent.getInventory(), state);
		if (tool >= 0) {
			AgentInventory.equip(agent, tool);
		}
		Vec3 center = Vec3.atCenterOf(pos);
		agent.controls().lookAt(center);
		Direction face = Direction.getApproximateNearest(agent.getEyePosition().subtract(center));
		agent.controls().holdAttack(pos, face);
		return level.getBlockState(pos).isAir();
	}

	/** True when the held/best tool cannot get drops from the block (stone with bare hands). */
	public static boolean wouldDropNothing(final AgentPlayer agent, final BlockState state) {
		if (!state.requiresCorrectToolForDrops()) {
			return false;
		}
		int tool = AgentInventory.bestToolSlot(agent.getInventory(), state);
		return tool < 0 || !agent.getInventory().getItem(tool).isCorrectToolForDrops(state);
	}

	/**
	 * One attempt to place an item matching {@code item} at {@code pos}, clicking a neighbouring block's face like a
	 * player (sneaking, so chests and tables are not opened). The caller keeps {@code pos} in reach.
	 */
	public static Place placeTick(final AgentPlayer agent, final BlockPos pos, final Predicate<ItemStack> item) {
		ServerLevel level = agent.level();
		BlockState here = level.getBlockState(pos);
		if (!here.canBeReplaced()) {
			return Place.OCCUPIED;
		}
		AABB box = new AABB(pos);
		if (agent.getBoundingBox().intersects(box)) {
			return Place.SELF_IN_WAY;
		}
		List<Entity> blockers = level.getEntities(agent, box, e -> e.isAlive() && e.blocksBuilding);
		if (!blockers.isEmpty()) {
			return Place.ENTITY_IN_WAY;
		}
		if (!Inv.equip(agent, item)) {
			return Place.NO_ITEM;
		}
		Direction support = null;
		for (Direction d : PLACE_ORDER) {
			BlockPos n = pos.relative(d);
			BlockState s = level.getBlockState(n);
			if (!s.canBeReplaced() && !s.getCollisionShape(level, n).isEmpty()) {
				support = d;
				break;
			}
		}
		if (support == null) {
			return Place.NO_SUPPORT;
		}
		BlockPos against = pos.relative(support);
		Direction face = support.getOpposite();
		Vec3 hit = Vec3.atCenterOf(against).add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
		agent.controls().lookAt(hit);
		boolean wasSneaking = agent.isShiftKeyDown();
		agent.controls().setSneaking(true);
		InteractionResult r = agent.controls().useBlock(against, face);
		agent.controls().setSneaking(wasSneaking);
		if (!level.getBlockState(pos).canBeReplaced() || level.getBlockState(pos) != here && r.consumesAction()) {
			return Place.PLACED;
		}
		return Place.RETRY;
	}

	/** Below first (stand blocks on the ground), then the sides, then above. */
	private static final Direction[] PLACE_ORDER = {
		Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP
	};
}
