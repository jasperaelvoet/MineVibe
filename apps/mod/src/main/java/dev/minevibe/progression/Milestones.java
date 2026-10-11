package dev.minevibe.progression;

import dev.minevibe.MineVibeMod;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityCombatEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.StatFormatter;
import net.minecraft.stats.Stats;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enemy;
import org.jspecify.annotations.Nullable;

/**
 * The guide's milestones (see {@link Milestone}): counted ones bump their statistic and fire
 * {@link #TRIGGER} with the new total, gauges fire with their current value. Only the human player earns them; a call
 * for an {@link AgentPlayer} does nothing. Server thread. Some are reported from MineVibe code where they happen (a PC
 * seat, a grave, a fed player), the client reports what only it sees go through Node (chat, cards, orders, the Codex,
 * the calendar, meetings, the world number), and {@link #registerEvents} watches the rest.
 */
public final class Milestones {
	/** {@code minevibe:milestone}. */
	public static MilestoneTrigger TRIGGER;

	/** How often the gauges (day, crew size) are re-read, in server ticks. */
	static final int GAUGE_TICKS = 100;
	/** A monster killed this close to the player an agent follows counts as guarding them. */
	static final double GUARD_RANGE = 16.0;

	private static boolean registered;

	private Milestones() {
	}

	static void register() {
		if (registered) {
			return;
		}
		registered = true;
		TRIGGER = Registry.register(BuiltInRegistries.TRIGGER_TYPES, MineVibeMod.id("milestone"), new MilestoneTrigger());
		for (Milestone m : Milestone.values()) {
			if (m.counted()) {
				Registry.register(BuiltInRegistries.CUSTOM_STAT, m.stat(), m.stat());
				Stats.CUSTOM.get(m.stat(), StatFormatter.DEFAULT);
			}
		}
	}

	static void registerEvents() {
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			if (server.getTickCount() % GAUGE_TICKS == 0) {
				readGauges(server);
			}
		});
		ServerEntityCombatEvents.AFTER_KILLED_OTHER_ENTITY.register((level, killer, victim, source) -> {
			if (killer instanceof AgentPlayer agent) {
				onAgentKill(agent, victim);
			}
		});
	}

	/** One more of a counted milestone for {@code player}. */
	public static void award(final ServerPlayer player, final Milestone milestone) {
		if (player instanceof AgentPlayer || !milestone.counted() || TRIGGER == null) {
			return;
		}
		player.awardStat(milestone.stat());
		TRIGGER.trigger(player, milestone, player.getStats().getValue(Stats.CUSTOM.get(milestone.stat())));
	}

	/** A gauge's current value for {@code player}. */
	public static void reach(final ServerPlayer player, final Milestone milestone, final int value) {
		if (player instanceof AgentPlayer || milestone.counted() || TRIGGER == null) {
			return;
		}
		TRIGGER.trigger(player, milestone, value);
	}

	/** {@link #award} for the human player of the integrated server, when one is online. */
	public static void awardLocal(final MinecraftServer server, final Milestone milestone) {
		ServerPlayer player = localPlayer(server);
		if (player != null) {
			award(player, milestone);
		}
	}

	/** The human player of the integrated server (agents are server players too), or null. */
	public static @Nullable ServerPlayer localPlayer(final MinecraftServer server) {
		for (ServerPlayer p : server.getPlayerList().getPlayers()) {
			if (!(p instanceof AgentPlayer)) {
				return p;
			}
		}
		return null;
	}

	/** The in-game day, counted like the Game Over screen and the graves: 1 on the first day. */
	static int day(final MinecraftServer server) {
		return (int) Math.min(Integer.MAX_VALUE, Math.max(0L, server.overworld().getOverworldClockTime()) / 24000L + 1L);
	}

	static void readGauges(final MinecraftServer server) {
		ServerPlayer player = localPlayer(server);
		if (player == null) {
			return;
		}
		reach(player, Milestone.DAY, day(server));
		int crew = (int) AgentService.get(server).agents().stream().filter(LivingEntity::isAlive).count();
		if (crew > 0) {
			reach(player, Milestone.CREW_SIZE, crew);
		}
	}

	static void onAgentKill(final AgentPlayer agent, final LivingEntity victim) {
		if (!(victim instanceof Enemy)) {
			return;
		}
		ServerPlayer player = agent.brain().followTarget();
		if (player != null && !(player instanceof AgentPlayer) && player.distanceTo(victim) <= GUARD_RANGE) {
			award(player, Milestone.GUARDED);
		}
	}
}
