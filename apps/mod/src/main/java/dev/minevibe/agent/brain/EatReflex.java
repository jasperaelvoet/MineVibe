package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.InteractionHand;

/**
 * Eating, in two strengths:
 * <ul>
 *   <li>{@link #critical()} (priority 90): HP at or below 6. Eats anything that helps, golden apples first,
 *       even harmful food when that is all there is.</li>
 *   <li>{@link #normal()} (priority 60): food at or below 14 and not under attack. Eats the best decent food
 *       until food is above 14.</li>
 * </ul>
 * The agent stops moving and holds "use" until the food is consumed (32 ticks for most foods).
 */
final class EatReflex implements Reflex {
	private static final float CRITICAL_HEALTH = 6.0F;
	private static final int HUNGRY_FOOD = 14;

	private final boolean critical;

	private EatReflex(final boolean critical) {
		this.critical = critical;
	}

	static EatReflex critical() {
		return new EatReflex(true);
	}

	static EatReflex normal() {
		return new EatReflex(false);
	}

	@Override
	public int priority() {
		return this.critical ? 90 : 60;
	}

	@Override
	public String name() {
		return this.critical ? "critical_heal" : "eat";
	}

	@Override
	public boolean needsToStand() {
		return false;
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		// Finishing a bite counts only for a bite this reflex started: an eat job's bite belongs to the job.
		boolean eating = brain.active() == this && agent.isUsingItem() && agent.getUseItem().has(DataComponents.FOOD);
		if (this.critical) {
			return agent.getHealth() <= CRITICAL_HEALTH && (eating || AgentInventory.bestFoodSlot(agent, true, true) >= 0);
		}
		if (eating) {
			// Finish the bite we started.
			return true;
		}
		if (agent.getFoodData().getFoodLevel() > HUNGRY_FOOD) {
			return false;
		}
		if (brain.threats().inCombat(agent, 6.0)) {
			return false;
		}
		return this.cachedHasFood(agent);
	}

	private int lastFoodCheckTick = -100;
	private boolean lastHasFood;

	private boolean cachedHasFood(final AgentPlayer agent) {
		if (agent.tickCount - this.lastFoodCheckTick >= 10) {
			this.lastFoodCheckTick = agent.tickCount;
			this.lastHasFood = AgentInventory.hasFood(agent, false);
		}
		return this.lastHasFood;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
		agent.controls().stopMining();
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		agent.controls().stopMovement();
		if (agent.isUsingItem()) {
			return;
		}
		int slot = AgentInventory.bestFoodSlot(agent, this.critical, this.critical);
		if (slot < 0) {
			return;
		}
		AgentInventory.equip(agent, slot);
		agent.controls().useItem(InteractionHand.MAIN_HAND);
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		// Let a bite in progress finish only if we still hold food; otherwise release.
		if (agent.isUsingItem() && !agent.getUseItem().has(DataComponents.FOOD)) {
			agent.controls().releaseUse();
		}
		agent.controls().stopMovement();
	}
}
