package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Opens wooden doors on the way and closes them again once the agent is clear (both navigation tiers). */
final class NavDoors {
	private final List<OpenedDoor> opened = new ArrayList<>();

	private record OpenedDoor(BlockPos pos, int tick) {
	}

	/** Opens a closed wooden door in the body cells at {@code feet}, if one is within reach. */
	void openIfClosed(final AgentPlayer agent, final BlockPos feet) {
		ServerLevel level = agent.level();
		for (BlockPos pos : new BlockPos[] {feet, feet.above()}) {
			BlockState state = level.getBlockState(pos);
			if (state.getBlock() instanceof DoorBlock door && door.type().canOpenByHand() && !state.getValue(DoorBlock.OPEN)) {
				Vec3 center = Vec3.atCenterOf(pos);
				if (agent.getEyePosition().distanceTo(center) > 3.5) {
					return;
				}
				Direction face = Direction.getApproximateNearest(agent.getX() - center.x, 0.0, agent.getZ() - center.z);
				agent.controls().lookAt(center);
				agent.controls().useBlock(pos, face);
				if (level.getBlockState(pos).getValue(DoorBlock.OPEN)) {
					BlockPos lower = state.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER ? pos : pos.below();
					this.opened.add(new OpenedDoor(lower, agent.tickCount));
				}
				return;
			}
		}
	}

	/** Closes the doors this agent opened once it is clear of them and its path no longer goes through them. */
	void closeBehind(final AgentPlayer agent, final Predicate<BlockPos> pathGoesThrough) {
		if (this.opened.isEmpty()) {
			return;
		}
		ServerLevel level = agent.level();
		Iterator<OpenedDoor> it = this.opened.iterator();
		while (it.hasNext()) {
			OpenedDoor door = it.next();
			BlockState state = level.getBlockState(door.pos());
			if (!(state.getBlock() instanceof DoorBlock) || !state.getValue(DoorBlock.OPEN)) {
				it.remove();
				continue;
			}
			double dist = agent.position().distanceTo(Vec3.atBottomCenterOf(door.pos()));
			if (dist > 6.0) {
				it.remove();
				continue;
			}
			AABB doorBox = new AABB(door.pos()).expandTowards(0.0, 1.0, 0.0).inflate(0.35, 0.0, 0.35);
			if (dist > 1.6 && !agent.getBoundingBox().intersects(doorBox) && agent.tickCount - door.tick() > 5 && !pathGoesThrough.test(door.pos())) {
				Direction face = Direction.getApproximateNearest(agent.getX() - (door.pos().getX() + 0.5), 0.0, agent.getZ() - (door.pos().getZ() + 0.5));
				agent.controls().useBlock(door.pos(), face);
				if (!level.getBlockState(door.pos()).getValue(DoorBlock.OPEN)) {
					it.remove();
				}
			}
		}
	}
}
