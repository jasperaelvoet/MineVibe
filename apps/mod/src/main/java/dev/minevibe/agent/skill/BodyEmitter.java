package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.hardcore.HardcoreHooks;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * The body side of the bridge (protocol §7.3): {@code agent.state} once a second (one coalesced message for the whole
 * crew), {@code agent.event} for what Node's Digest and wake rules need (hurt, hp_critical, starving, ate, killed,
 * reflex, stuck, dimension_changed, player_low_hp), and {@code agent.died} (re-sent until acknowledged).
 *
 * <p>Stuck is said out loud (PLAN 7.3): a walk that fails over and over from the same spot ({@code nav.loop}) and an
 * agent that cannot get out of water ({@code nav.stuck_in_water}, the WaterEscape reflex) send an urgency-2
 * {@code stuck} event, whose {@code data.bark} Node says at once while the event wakes the body's brain. A single
 * Tier-1 "stuck" is only notable (the Digest).
 */
final class BodyEmitter {
	private static final int STATE_INTERVAL = 20;
	/** The bark key of a stuck walk ("I'm stuck. Can you help?"). */
	static final String STUCK_BARK = "stuck";
	/** Ticks between two urgency-2 {@code stuck} events of one agent for a walk loop (each wakes the brain). */
	private static final int STUCK_LOOP_COOLDOWN = 2400;
	/**
	 * The same for water the agent cannot get out of: only a guard against bursts, since the WaterEscape reflex spaces its
	 * own speak-ups (5, 10, 20 minutes about one stranding; a new stranding at once). A longer one dropped a second
	 * stranding soon after the first, and the reflex then kept quiet about it for 5 minutes.
	 */
	private static final int STUCK_WATER_COOLDOWN = 200;

	private final SkillService service;
	private final Map<String, Track> tracks = new HashMap<>();
	private final Set<String> diedReported = new HashSet<>();
	private int lastSentCount = -1;
	private long lastPlayerLowTick = -100_000L;

	/** Per-agent polling state. */
	private static final class Track {
		@Nullable ResourceKey<Level> dim;
		boolean eating;
		int foodBefore;
		String eatingItem = "";
	}

	BodyEmitter(final SkillService service) {
		this.service = service;
	}

	private MinecraftServer server() {
		return this.service.server();
	}

	void tick() {
		MinecraftServer server = this.server();
		int tick = server.getTickCount();
		List<AgentPlayer> agents = new ArrayList<>();
		for (AgentPlayer a : AgentService.get(server).agents()) {
			if (!a.isRemoved() && !a.isAgentDead() && a.isAlive()) {
				agents.add(a);
			}
		}
		for (AgentPlayer agent : agents) {
			this.poll(agent, tick);
		}
		this.tracks.keySet().removeIf(id -> agents.stream().noneMatch(a -> a.agentId().equals(id)));
		if (tick % STATE_INTERVAL == 0) {
			if (!agents.isEmpty() || this.lastSentCount > 0) {
				this.sendState(agents, tick);
			}
			this.lastSentCount = agents.size();
			this.playerLowHp(agents, tick);
		}
	}

	private void poll(final AgentPlayer agent, final int tick) {
		Track t = this.tracks.computeIfAbsent(agent.agentId(), k -> new Track());
		// Dimension changes.
		ResourceKey<Level> dim = agent.level().dimension();
		if (t.dim != null && t.dim != dim) {
			BodyEvents.emit(agent, "dimension_changed", BodyEvents.INFO, "now in " + dim.identifier(), Map.of("from", t.dim.identifier().toString(), "to", dim.identifier().toString()), 0);
		}
		t.dim = dim;
		// Finished eating.
		boolean eating = agent.isUsingItem() && agent.getUseItem().has(DataComponents.FOOD);
		if (eating && !t.eating) {
			t.foodBefore = agent.getFoodData().getFoodLevel();
			t.eatingItem = Refs.itemId(agent.getUseItem());
		} else if (!eating && t.eating && agent.getFoodData().getFoodLevel() >= t.foodBefore && !t.eatingItem.isEmpty()) {
			BodyEvents.emit(agent, "ate", BodyEvents.INFO, "ate " + t.eatingItem.replace("minecraft:", "") + " (food " + agent.getFoodData().getFoodLevel() + ")",
				Map.of("item", t.eatingItem, "food", agent.getFoodData().getFoodLevel()), 0);
		}
		t.eating = eating;
		if ((tick + agent.getId()) % 10 != 0) {
			return;
		}
		int food = agent.getFoodData().getFoodLevel();
		if (food == 0 || food <= 6 && !AgentInventory.hasFood(agent, true)) {
			BodyEvents.emit(agent, "starving", BodyEvents.CRITICAL, food == 0 ? "starving: food 0" : "hungry (food " + food + ") with nothing to eat",
				Map.of("food", food), 1200);
		}
		if (agent.getHealth() <= 6.0F) {
			BodyEvents.emit(agent, "hp_critical", BodyEvents.CRITICAL, String.format(java.util.Locale.ROOT, "HP critical: %.0f/%.0f", agent.getHealth(), agent.getMaxHealth()),
				Map.of("hp", Math.round(agent.getHealth())), 600);
		}
	}

	/** The local player under 30% HP: tell the nearest agent within 32 blocks (Node picks whom to wake). */
	private void playerLowHp(final List<AgentPlayer> agents, final int tick) {
		if (agents.isEmpty() || tick - this.lastPlayerLowTick < 1200) {
			return;
		}
		for (ServerPlayer p : this.server().getPlayerList().getPlayers()) {
			if (p instanceof AgentPlayer || !p.isAlive() || p.isSpectator() || p.isCreative() || p.getHealth() >= p.getMaxHealth() * 0.3F) {
				continue;
			}
			AgentPlayer nearest = null;
			double best = 32.0 * 32.0;
			for (AgentPlayer a : agents) {
				if (a.level() == p.level() && a.distanceToSqr(p) < best) {
					best = a.distanceToSqr(p);
					nearest = a;
				}
			}
			if (nearest != null) {
				this.lastPlayerLowTick = tick;
				BodyEvents.emit(nearest, "player_low_hp", BodyEvents.CRITICAL, String.format(java.util.Locale.ROOT, "the player is at %.0f HP", p.getHealth()),
					Map.of("hp", Math.round(p.getHealth()), "distance", Math.round(Math.sqrt(best))), 0);
			}
		}
	}

	private void sendState(final List<AgentPlayer> agents, final int tick) {
		List<Bodies.AgentBody> bodies = new ArrayList<>(agents.size());
		for (AgentPlayer a : agents) {
			try {
				bodies.add(this.body(a));
			} catch (RuntimeException e) {
				SkillOutbox.LOG.warn("agent.state: skipping {}: {}", a.agentId(), e.toString());
			}
		}
		this.service.outbox().send(Bodies.AGENT_STATE, new Bodies.AgentState(Math.max(0, tick), bodies));
	}

	Bodies.AgentBody body(final AgentPlayer a) {
		Job job = a.jobs().current();
		Bodies.BodyJob bodyJob = null;
		if (job instanceof SkillJob sj && sj.jobId() != null && Skills.SKILL_NAMES.contains(sj.skill())) {
			bodyJob = new Bodies.BodyJob(sj.jobId(), sj.skill(), sj.progress());
		}
		SkillService.Seated seated = this.service.seated(a.agentId());
		ServerPlayer player = Refs.player(a);
		String reflex = a.brain().active() == null ? null : ProtocolCodec.clip(a.brain().active().name(), 32);
		String zone = StatusFooter.zone(a);
		return new Bodies.AgentBody(
			a.agentId(),
			new Types.Vec3(a.getX(), a.getY(), a.getZ()),
			a.level().dimension().identifier().toString(),
			clamp(a.getHealth(), 0, 1024),
			clamp(a.getMaxHealth(), 0, 1024),
			Math.max(0, Math.min(20, a.getFoodData().getFoodLevel())),
			clamp(a.getFoodData().getSaturationLevel(), 0, 20),
			a.brain().mode().id(),
			AgentInventory.hasFood(a, true) || dev.minevibe.agent.job.Inv.count(a, s -> s.has(DataComponents.FOOD)) > 0,
			a.brain().threats().inCombat(a, 12.0) || a.brain().hurtByHostileWithin(160),
			reflex,
			bodyJob,
			seated == null ? null : seated.target(),
			player == null ? null : Math.round(a.distanceTo(player) * 10.0) / 10.0,
			a.getMainHandItem().isEmpty() ? null : Refs.itemId(a.getMainHandItem()),
			zone.isEmpty() ? null : ProtocolCodec.clip(zone, 64));
	}

	private static double clamp(final double v, final double min, final double max) {
		return Math.round(Math.max(min, Math.min(max, v)) * 10.0) / 10.0;
	}

	// ---------------------------------------------------------------- hooks (registered by SkillsModInit)

	/** {@link AgentEvents} from the body code: reflexes, navigation, death. */
	void onAgentEvent(final AgentEvents.Event e) {
		AgentPlayer agent = this.find(e.agentId());
		if (agent == null) {
			return;
		}
		switch (e.type()) {
			case "reflex" -> {
				String reflex = e.data().getOrDefault("reflex", "?");
				int urgency = switch (reflex) {
					case "hazard", "water_escape", "creeper_backoff", "flee", "critical_heal" -> BodyEvents.NOTABLE;
					default -> BodyEvents.INFO;
				};
				BodyEvents.emit(agent, "reflex", urgency, reflex.replace('_', ' '), Map.of("reflex", reflex, "priority", e.data().getOrDefault("priority", "0")), 40);
			}
			case "nav.failed" -> {
				if ("stuck".equals(e.data().get("reason"))) {
					BodyEvents.emit(agent, "stuck", BodyEvents.NOTABLE, "stuck at " + agent.blockPosition().toShortString(), Map.of("pos", agent.blockPosition()), 200);
				}
			}
			case "nav.loop" -> {
				String goal = e.data().getOrDefault("goal", "");
				String reason = e.data().getOrDefault("reason", "no_path");
				Map<String, Object> data = new LinkedHashMap<>();
				data.put("why", "nav");
				data.put("reason", reason);
				data.put("pos", agent.blockPosition());
				data.put("tries", e.data().getOrDefault("fails", "0"));
				data.put("bark", STUCK_BARK);
				String text = "I'm stuck at " + agent.blockPosition().toShortString() + ": " + e.data().getOrDefault("fails", "several")
					+ " walks in a row toward " + (goal.isEmpty() ? "my goal" : goal) + " failed (" + reason + "). Ask the player for help, or try another way.";
				BodyEvents.emit(agent, "stuck", BodyEvents.CRITICAL, text, data, STUCK_LOOP_COOLDOWN);
			}
			case "nav.stuck_in_water" -> {
				Map<String, Object> data = new LinkedHashMap<>();
				data.put("why", "water");
				data.put("reason", e.data().getOrDefault("reason", "no_path"));
				data.put("pos", agent.blockPosition());
				data.put("bark", e.data().getOrDefault("bark", "stuck_in_water"));
				BodyEvents.emit(agent, "stuck", BodyEvents.CRITICAL, e.data().getOrDefault("text", "I'm stuck in water."), data, STUCK_WATER_COOLDOWN);
			}
			case "died" -> this.reportDeath(agent, e.data());
			default -> {
			}
		}
	}

	private @Nullable AgentPlayer find(final String agentId) {
		for (AgentPlayer a : AgentService.get(this.server()).agents()) {
			if (a.agentId().equals(agentId)) {
				return a;
			}
		}
		return null;
	}

	private void reportDeath(final AgentPlayer agent, final Map<String, String> data) {
		if (!this.diedReported.add(agent.agentId())) {
			return;
		}
		MinecraftServer server = this.server();
		String worldId = HardcoreHooks.levelId(server).toLowerCase(java.util.Locale.ROOT);
		if (!Messages.isWorldId(worldId)) {
			SkillOutbox.LOG.warn("agent.died for {} not sent: world id {} is not a MineVibe world id", agent.agentId(), worldId);
			return;
		}
		String cause = ProtocolCodec.clip(data.getOrDefault("cause", "died"), 256);
		int day = Math.max(1, (int)(agent.level().getOverworldClockTime() / 24000L) + 1);
		Entity killer = agent.getKillCredit();
		String killerName = killer == null ? null : killer instanceof net.minecraft.world.entity.player.Player p ? p.getGameProfile().name() : Refs.entityTypeId(killer);
		BlockPos grave = AgentService.get(server).gravePos(agent.agentId());
		Bodies.AgentDied died = new Bodies.AgentDied(
			agent.agentId(), worldId, cause.isEmpty() ? "died" : cause, killerName, day, Refs.wire(agent.blockPosition()),
			agent.level().dimension().identifier().toString(), grave == null ? null : Refs.wire(grave));
		this.service.outbox().sendUntilAcked(Bodies.AGENT_DIED, died);
	}

	void onDamage(final AgentPlayer agent, final DamageSource source, final float taken) {
		if (taken <= 0.0F) {
			return;
		}
		Entity attacker = source.getEntity();
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("amount", Math.round(taken * 10.0) / 10.0);
		data.put("source", source.getMsgId());
		if (attacker != null) {
			data.put("attacker", attacker instanceof AgentPlayer a ? a.agentId() : Refs.entityTypeId(attacker));
		}
		data.put("hp", Math.round(agent.getHealth()));
		BodyEvents.emit(agent, "hurt", taken >= 4.0F ? BodyEvents.NOTABLE : BodyEvents.INFO,
			String.format(java.util.Locale.ROOT, "hurt by %s (%.0f HP left)", attacker != null ? data.get("attacker") : source.getMsgId(), agent.getHealth()), data, 100);
		if (agent.getHealth() <= 6.0F && agent.isAlive()) {
			BodyEvents.emit(agent, "hp_critical", BodyEvents.CRITICAL, String.format(java.util.Locale.ROOT, "HP critical: %.0f/%.0f", agent.getHealth(), agent.getMaxHealth()),
				Map.of("hp", Math.round(agent.getHealth())), 600);
		}
	}

	void onKilled(final AgentPlayer agent, final LivingEntity victim) {
		BodyEvents.emit(agent, "killed", BodyEvents.INFO, "killed a " + Refs.entityTypeId(victim).replace("minecraft:", ""), Map.of("entity", Refs.entityTypeId(victim)), 20);
	}
}
