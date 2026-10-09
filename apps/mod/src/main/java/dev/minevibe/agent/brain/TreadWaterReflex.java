package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.WaterMoves;
import java.util.function.BiPredicate;

/**
 * Keeps the head above the water (PLAN 7.3) when nothing else steers the body: a player who lets go of the keys sinks,
 * and an agent beside its player in a lake, or stranded in a pool, would hold its breath until the Hazard reflex pulled
 * it up, over and over. Two of them:
 * <ul>
 *   <li>{@link #stranded}, priority {@value #STRANDED_PRIORITY} (below the job and the pickup reflex): the WaterEscape
 *       reflex found no way out. The agent treads water and waits for the escape's next look, for help, or for a job
 *       from its brain; eating, fighting and fleeing (all higher) still run, and so does picking up a block the player
 *       tossed into the water two blocks off (help it would otherwise watch float), while idle walks that cannot work
 *       stay off.</li>
 *   <li>{@link #afloat}, priority {@value #AFLOAT_PRIORITY} (below the idle modes): nothing else wants the body and it
 *       swims (not standing on the bottom of shallow water with its head out).</li>
 * </ul>
 */
final class TreadWaterReflex implements Reflex {
	static final int STRANDED_PRIORITY = 24;
	static final int AFLOAT_PRIORITY = 5;

	private final int priority;
	private final String name;
	private final BiPredicate<AgentPlayer, ReflexBrain> when;

	private TreadWaterReflex(final int priority, final String name, final BiPredicate<AgentPlayer, ReflexBrain> when) {
		this.priority = priority;
		this.name = name;
		this.when = when;
	}

	/** Treading water while the WaterEscape reflex {@code escape} is stranded. */
	static TreadWaterReflex stranded(final WaterEscapeReflex escape) {
		return new TreadWaterReflex(STRANDED_PRIORITY, "stranded_in_water", (agent, brain) -> escape.stranded() && swimming(agent));
	}

	/** Treading water when nothing else steers a swimming body. */
	static TreadWaterReflex afloat() {
		return new TreadWaterReflex(AFLOAT_PRIORITY, "afloat", (agent, brain) -> swimming(agent) && !WaterMoves.standingInWater(agent));
	}

	private static boolean swimming(final AgentPlayer agent) {
		return WaterMoves.swimming(agent) && !agent.isInLava() && !agent.isPassenger();
	}

	@Override
	public int priority() {
		return this.priority;
	}

	@Override
	public String name() {
		return this.name;
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		return this.when.test(agent, brain);
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		WaterMoves.treadWater(agent);
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		// The navigator is left as it was: a walk that failed in the water is what the WaterEscape reflex looks for.
		agent.controls().stopMovement();
	}
}
