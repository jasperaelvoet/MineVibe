package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.Steering;
import net.minecraft.world.entity.monster.Creeper;
import org.jspecify.annotations.Nullable;

/** Priority 95: sprint away from a swelling creeper until it is 8+ blocks away or calms down. */
final class CreeperBackoffReflex implements Reflex {
	private static final double TRIGGER_RADIUS = 7.0;
	private static final double SAFE_RADIUS = 8.0;

	private @Nullable Creeper creeper;

	@Override
	public int priority() {
		return 95;
	}

	@Override
	public String name() {
		return "creeper_backoff";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.creeper != null && this.creeper.isAlive() && this.creeper.distanceTo(agent) < SAFE_RADIUS
			&& (this.creeper.getSwellDir() > 0 || this.creeper.getSwelling(1.0F) > 0.0F)) {
			return true;
		}
		this.creeper = brain.threats().swellingCreeper(agent, TRIGGER_RADIUS);
		return this.creeper != null;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
		if (agent.isUsingItem()) {
			agent.controls().releaseUse();
		}
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.creeper == null) {
			return;
		}
		AgentControls controls = agent.controls();
		float away = controls.yawTo(this.creeper.position()) + 180.0F;
		// Straight away if that is safe, else veer up to 90 degrees; never into lava or off a cliff.
		Float heading = null;
		for (float offset : new float[] {0.0F, 45.0F, -45.0F, 90.0F, -90.0F}) {
			if (Steering.safeAhead(agent, away + offset)) {
				heading = away + offset;
				break;
			}
		}
		controls.setStrafe(0.0F);
		if (heading == null) {
			controls.stopMovement();
			return;
		}
		controls.look(heading, 0.0F);
		controls.setForward(1.0F);
		controls.setSprinting(true);
		controls.setJumping(agent.onGround() && agent.horizontalCollision || agent.isInWater());
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.creeper = null;
		agent.controls().stopMovement();
	}
}
