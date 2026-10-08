package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.Steering;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.phys.Vec3;

/** Melee engagement shared by ProtectPlayer and SelfDefense: best weapon, close in, swing when charged. */
final class Combat {
	private static final double CLOSE_RANGE = 3.2;
	private static final int REPLAN_INTERVAL = 10;

	private Combat() {
	}

	static void engage(final AgentPlayer agent, final ReflexBrain brain, final LivingEntity target) {
		AgentControls controls = agent.controls();
		int weapon = AgentInventory.bestWeaponSlot(agent.getInventory());
		if (weapon >= 0) {
			AgentInventory.equip(agent, weapon);
		}
		if (agent.isUsingItem()) {
			controls.releaseUse();
		}
		double dist = agent.distanceTo(target);
		boolean visible = agent.hasLineOfSight(target);
		if (dist > CLOSE_RANGE || !visible) {
			boolean newTarget = brain.lastCombatTarget != target;
			Vec3 goal = agent.navigator().goal();
			boolean moved = goal == null || goal.distanceTo(target.position()) > 1.5;
			if (newTarget || !agent.navigator().isMoving() || moved && agent.tickCount - brain.lastCombatReplanTick >= REPLAN_INTERVAL) {
				brain.lastCombatTarget = target;
				brain.lastCombatReplanTick = agent.tickCount;
				agent.navigator().moveTo(target.position(), 1.5);
			}
			if (dist < 6.0 && visible) {
				controls.lookAt(target);
			}
			return;
		}
		// Close range: steer directly and swing.
		if (agent.navigator().isMoving()) {
			agent.navigator().stop();
		}
		brain.lastCombatTarget = target;
		controls.lookAt(target);
		boolean safe = Steering.safeAhead(agent, controls.yawTo(target.position()));
		controls.setForward(dist > 2.0 && safe ? 1.0F : 0.0F);
		controls.setStrafe(0.0F);
		controls.setSprinting(false);
		controls.setJumping(agent.onGround() && agent.horizontalCollision || agent.isInWater());
		controls.attack(target);
	}

	static void disengage(final AgentPlayer agent, final ReflexBrain brain) {
		brain.lastCombatTarget = null;
		agent.controls().releaseAll();
		agent.navigator().stop();
	}
}
