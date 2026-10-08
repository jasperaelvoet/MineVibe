package dev.minevibe.agent.skill;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Debug;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Seats;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages.Codes;
import org.jspecify.annotations.Nullable;

/**
 * Registers the skill layer's bridge handlers (all on the integrated server thread): {@code skill.run} (answered when
 * the job ends or {@code waitMs} passes), {@code skill.cancel}, {@code obs.query}, {@code agent.spawn},
 * {@code agent.despawn}, {@code agent.mode}, {@code agent.seat}, {@code agent.unseat}; observers of the pushes
 * {@code agent.approach} and {@code calendar.fired} (other modules may observe them too); with {@code -Dminevibe.e2e}
 * also {@code debug.kill_agent} and {@code debug.set_clock}.
 *
 * <p>The bridge is created by the client entrypoint, after the common one, so this registers on the first
 * {@code SERVER_STARTING} (once per bridge instance).
 */
public final class SkillBridge {
	private static @Nullable BridgeClient registeredOn;

	private SkillBridge() {
	}

	/** Registers on the installed bridge, once. Safe to call again. */
	public static synchronized void ensureRegistered() {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null || bridge == registeredOn) {
			return;
		}
		registeredOn = bridge;
		register(bridge);
	}

	static void register(final BridgeClient bridge) {
		tryHandle(() -> bridge.handleAsync(Skills.SKILL_RUN, Route.SERVER, req -> service().run(req)));
		tryHandle(() -> bridge.handle(Skills.SKILL_CANCEL, Route.SERVER, req -> service().cancel(req)));
		tryHandle(() -> bridge.handle(Skills.OBS_QUERY, Route.SERVER, req -> service().obs(req)));
		tryHandle(() -> bridge.handle(Bodies.AGENT_SPAWN, Route.SERVER, req -> service().spawn(req)));
		tryHandle(() -> bridge.handle(Bodies.AGENT_DESPAWN, Route.SERVER, req -> service().despawn(req)));
		tryHandle(() -> bridge.handle(Bodies.AGENT_MODE, Route.SERVER, req -> service().mode(req)));
		tryHandle(() -> bridge.handle(Seats.AGENT_SEAT, Route.SERVER, req -> service().seat(req)));
		tryHandle(() -> bridge.handle(Seats.AGENT_UNSEAT, Route.SERVER, req -> service().unseat(req)));
		bridge.observe(Ui.AGENT_APPROACH, Route.SERVER, a -> {
			SkillService s = SkillService.current();
			if (s != null) {
				s.approach(a);
			}
		});
		bridge.observe(Org.CALENDAR_FIRED, Route.SERVER, f -> {
			SkillService s = SkillService.current();
			if (s != null) {
				s.calendarFired(f);
			}
		});
		if (Boolean.getBoolean("minevibe.e2e")) {
			tryHandle(() -> bridge.handle(Debug.DEBUG_KILL_AGENT, Route.SERVER, req -> service().debugKillAgent(req)));
			tryHandle(() -> bridge.handle(Debug.DEBUG_SET_CLOCK, Route.SERVER, req -> service().debugSetClock(req)));
		}
	}

	private static void tryHandle(final Runnable registration) {
		try {
			registration.run();
		} catch (IllegalStateException e) {
			SkillOutbox.LOG.warn("{}: kept the earlier handler", e.getMessage());
		}
	}

	private static SkillService service() {
		SkillService s = SkillService.current();
		if (s == null) {
			throw new BridgeException(Codes.NO_SERVER, "no integrated server is running");
		}
		return s;
	}
}
