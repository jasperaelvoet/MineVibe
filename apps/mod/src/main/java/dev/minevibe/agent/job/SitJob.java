package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.world.seat.OfficeChairBlock;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/** Walks to an {@code office_chair} and sits with a non-forced {@code startRiding} (never Carpet's mount). */
public final class SitJob implements Job {
	private static final int TIMEOUT_TICKS = 20 * 60;

	private final BlockPos chair;
	private int ticks;
	private String failure = "failed";

	public SitJob(final BlockPos chair) {
		this.chair = chair.immutable();
	}

	@Override
	public String name() {
		return "sit";
	}

	@Override
	public void start(final AgentPlayer agent) {
		agent.navigator().moveTo(Vec3.atBottomCenterOf(this.chair), 1.6);
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.start(agent);
	}

	@Override
	public Status tick(final AgentPlayer agent) {
		if (++this.ticks > TIMEOUT_TICKS) {
			this.failure = "timeout";
			return Status.FAILED;
		}
		if (!(agent.level().getBlockState(this.chair).getBlock() instanceof OfficeChairBlock)) {
			this.failure = "no_chair";
			return Status.FAILED;
		}
		double dist = agent.position().distanceTo(Vec3.atBottomCenterOf(this.chair));
		if (dist > 2.0) {
			AgentNavigator nav = agent.navigator();
			if (nav.status() == AgentNavigator.Status.FAILED) {
				this.failure = "unreachable";
				return Status.FAILED;
			}
			if (!nav.isMoving()) {
				nav.moveTo(Vec3.atBottomCenterOf(this.chair), 1.6);
			}
			return Status.RUNNING;
		}
		agent.navigator().stop();
		agent.controls().lookAt(Vec3.atCenterOf(this.chair));
		if (OfficeChairBlock.trySit(agent.level(), this.chair, agent)) {
			return Status.DONE;
		}
		this.failure = "occupied";
		return Status.FAILED;
	}

	@Override
	public String failureReason() {
		return this.failure;
	}
}
