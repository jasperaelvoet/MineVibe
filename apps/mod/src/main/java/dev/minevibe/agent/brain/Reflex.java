package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;

/**
 * A zero-token, tick-level behaviour (PLAN 7.3). Every tick the {@link ReflexBrain} asks reflexes in
 * priority order whether they {@link #wants want} control; the first that does runs, and it preempts
 * the current job when its priority is above {@link ReflexBrain#JOB_PRIORITY}.
 */
public interface Reflex {
	int priority();

	String name();

	/** Cheap check, called every tick while no higher reflex wants control. */
	boolean wants(AgentPlayer agent, ReflexBrain brain);

	default void start(final AgentPlayer agent, final ReflexBrain brain) {
	}

	void tick(AgentPlayer agent, ReflexBrain brain);

	default void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.controls().releaseAll();
		agent.navigator().stop();
	}

	/** True if this reflex has to stand up from a seat to act (movement or melee). */
	default boolean needsToStand() {
		return true;
	}
}
