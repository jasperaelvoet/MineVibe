package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import net.minecraft.world.phys.Vec3;

/** {@code mc__goto{pos}}: walk to a position with tier-1 navigation. */
public final class GotoJob implements Job {
	private final Vec3 target;
	private final double reach;
	private String failure = "failed";

	public GotoJob(final Vec3 target, final double reach) {
		this.target = target;
		this.reach = reach;
	}

	@Override
	public String name() {
		return "goto";
	}

	public Vec3 target() {
		return this.target;
	}

	@Override
	public void start(final AgentPlayer agent) {
		agent.navigator().moveTo(this.target, this.reach);
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		agent.navigator().moveTo(this.target, this.reach);
	}

	@Override
	public Status tick(final AgentPlayer agent) {
		AgentNavigator nav = agent.navigator();
		return switch (nav.status()) {
			case ARRIVED -> Status.DONE;
			case FAILED -> {
				this.failure = String.valueOf(nav.failureReason());
				yield Status.FAILED;
			}
			case IDLE -> {
				nav.moveTo(this.target, this.reach);
				yield Status.RUNNING;
			}
			case MOVING -> Status.RUNNING;
		};
	}

	@Override
	public String failureReason() {
		return this.failure;
	}
}
