package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.seat.Seats;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityCombatEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;

/**
 * Common entrypoint of the agent skill layer (PLAN 7.3, 7.4): the per-server {@link SkillService}, its tick (job
 * replies and progress, seat bookkeeping, {@code agent.state} at 1 Hz, body events, the published overworld clock),
 * the damage and kill hooks behind {@code agent.event}, and the bridge handlers. Listed under {@code main} in
 * {@code fabric.mod.json} after {@code AgentModInit}, so its server events run after the body code's.
 */
public final class SkillsModInit implements ModInitializer {
	@Override
	public void onInitialize() {
		SkillCommands.register();
		ServerLifecycleEvents.SERVER_STARTING.register(server -> {
			SkillService.get(server);
			BodyEvents.reset();
			SkillBridge.ensureRegistered();
		});
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			// Bodies restored from the crew list get their follow target and mode from Node's agent.spawn{restore}.
			SkillService.get(server);
			SkillBridge.ensureRegistered();
			WorldClock.publish(server);
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			SkillService.stopped(server);
			Seats.onServerStopped();
			WorldClock.clear();
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			SkillService s = SkillService.current();
			if (s != null && s.server() == server) {
				s.tick();
			}
		});
		AgentEvents.addListener(event -> {
			SkillService s = SkillService.current();
			if (s != null) {
				s.emitter().onAgentEvent(event);
			}
		});
		ServerLivingEntityEvents.AFTER_DAMAGE.register((entity, source, baseDamage, damageTaken, blocked) -> {
			if (entity instanceof AgentPlayer agent) {
				SkillService s = SkillService.current();
				if (s != null && s.server() == agent.level().getServer()) {
					s.emitter().onDamage(agent, source, damageTaken);
				}
			}
		});
		ServerEntityCombatEvents.AFTER_KILLED_OTHER_ENTITY.register((level, killer, victim, source) -> {
			if (killer instanceof AgentPlayer agent) {
				SkillService s = SkillService.current();
				if (s != null && s.server() == level.getServer()) {
					s.emitter().onKilled(agent, victim);
				}
			}
		});
	}
}
