package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import java.util.Comparator;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * {@code mc__mine{pos}}: walk into reach, take the best tool, hold attack until the block breaks (vanilla
 * survival speed), then pick up the drops.
 */
public final class MineJob implements Job {
	private static final int TIMEOUT_TICKS = 20 * 90;
	private static final int COLLECT_TICKS = 60;
	private static final double REACH = 4.0;

	private final BlockPos pos;
	private final boolean collect;
	private int ticks;
	private int brokenAtTick = -1;
	private int miningStartTick = -1;
	private int collectTicks;
	private String failure = "failed";

	public MineJob(final BlockPos pos, final boolean collect) {
		this.pos = pos.immutable();
		this.collect = collect;
	}

	@Override
	public String name() {
		return "mine";
	}

	public BlockPos pos() {
		return this.pos;
	}

	/** Ticks between the first swing and the break, or -1. */
	public int miningTicks() {
		return this.brokenAtTick < 0 || this.miningStartTick < 0 ? -1 : this.brokenAtTick - this.miningStartTick;
	}

	@Override
	public void start(final AgentPlayer agent) {
		this.approach(agent);
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.approach(agent);
	}

	private void approach(final AgentPlayer agent) {
		if (!this.inReach(agent)) {
			agent.navigator().moveTo(Vec3.atBottomCenterOf(this.pos), 2.5);
		}
	}

	private boolean inReach(final AgentPlayer agent) {
		return agent.getEyePosition().distanceTo(Vec3.atCenterOf(this.pos)) <= REACH;
	}

	@Override
	public Status tick(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (++this.ticks > TIMEOUT_TICKS) {
			this.failure = "timeout";
			return Status.FAILED;
		}
		BlockState state = level.getBlockState(this.pos);
		if (state.isAir() || this.brokenAtTick >= 0) {
			if (this.brokenAtTick < 0) {
				this.brokenAtTick = agent.tickCount;
			}
			return this.collect ? this.collectDrops(agent) : Status.DONE;
		}
		if (state.getDestroySpeed(level, this.pos) < 0.0F) {
			this.failure = "unbreakable";
			return Status.FAILED;
		}
		if (!this.inReach(agent)) {
			agent.controls().stopMining();
			if (!agent.navigator().isMoving()) {
				agent.navigator().moveTo(Vec3.atBottomCenterOf(this.pos), 2.5);
				if (agent.navigator().status() == dev.minevibe.agent.nav.AgentNavigator.Status.FAILED) {
					this.failure = "unreachable";
					return Status.FAILED;
				}
			}
			return Status.RUNNING;
		}
		agent.navigator().stop();
		int tool = AgentInventory.bestToolSlot(agent.getInventory(), state);
		if (tool >= 0) {
			AgentInventory.equip(agent, tool);
		}
		Vec3 center = Vec3.atCenterOf(this.pos);
		agent.controls().lookAt(center);
		Direction face = Direction.getApproximateNearest(agent.getEyePosition().subtract(center));
		if (this.miningStartTick < 0) {
			this.miningStartTick = agent.tickCount;
		}
		agent.controls().holdAttack(this.pos, face);
		if (level.getBlockState(this.pos).isAir()) {
			this.brokenAtTick = agent.tickCount;
		}
		return Status.RUNNING;
	}

	private Status collectDrops(final AgentPlayer agent) {
		agent.controls().stopMining();
		if (++this.collectTicks > COLLECT_TICKS) {
			return Status.DONE;
		}
		ItemEntity item = this.nearestDrop(agent);
		if (item == null) {
			return Status.DONE;
		}
		if (agent.position().distanceTo(item.position()) > 0.8) {
			agent.navigator().updateGoal(item.position(), 0.5);
		}
		return Status.RUNNING;
	}

	private @Nullable ItemEntity nearestDrop(final AgentPlayer agent) {
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, new AABB(this.pos).inflate(3.0), e -> e.isAlive());
		return items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
	}

	@Override
	public String failureReason() {
		return this.failure;
	}
}
