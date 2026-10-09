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

	/**
	 * True if taking control is reported as a {@code reflex} event (the brain's Digest hears of it): every reflex at
	 * priority 60 and above, and the ones below that say so.
	 */
	default boolean reported() {
		return this.priority() >= 60;
	}

	/** True if this reflex has to stand up from a seat to act (movement or melee). */
	default boolean needsToStand() {
		return true;
	}

	/**
	 * False for reflexes that never pull a sitting agent out of its chair (protecting others, self-defence while HP is
	 * still fine: a seated agent waits for {@code UnseatToFight} at priority 45).
	 */
	default boolean allowedWhileSeated() {
		return true;
	}

	/** The {@code UnseatReason} reported when this reflex stands a sitting agent up. */
	default String unseatReason() {
		return "survival";
	}

	/**
	 * True for a reflex that acts from the chair without ever standing up (USER DECISION 2026-10-08: a seated presenter
	 * turns toward a player who is near). It may run while the agent sits even below
	 * {@link ReflexBrain#SEATED_PRIORITY}; it must also return false from {@link #needsToStand()}.
	 */
	default boolean staysSeated() {
		return false;
	}
}
