package dev.minevibe.hardcore;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stats;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Server side of the hardcore loop (PLAN §7.9). When the local (human) player dies in a hardcore world:
 * <ol>
 *   <li>the world's {@link HardcoreMarker} is written and flushed to disk at once;</li>
 *   <li>{@code player.died} is sent to Node and re-sent until Node acknowledges it (Node marks the world dead and
 *       allocates the next one before it answers).</li>
 * </ol>
 * Fake players (agents) and other players never trigger it: only the singleplayer owner does.
 */
public final class HardcoreHooks {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Hardcore");

	static final Duration REPORT_TIMEOUT = Duration.ofSeconds(3);
	static final Duration REPORT_RETRY = Duration.ofSeconds(2);

	private static final Set<String> reported = ConcurrentHashMap.newKeySet();
	private static volatile @Nullable DeathRecord lastDeath;
	private static boolean registered;

	private HardcoreHooks() {}

	/** Registers the death hook (idempotent). */
	public static synchronized void register() {
		if (registered) return;
		registered = true;
		ServerLivingEntityEvents.AFTER_DEATH.register(HardcoreHooks::afterDeath);
	}

	/** The last death recorded in this JVM (the Game Over screen reads cause and day from it). */
	public static @Nullable DeathRecord lastDeath() {
		return lastDeath;
	}

	private static void afterDeath(LivingEntity entity, DamageSource source) {
		if (!(entity instanceof ServerPlayer player)) return;
		MinecraftServer server = player.level().getServer();
		if (!server.isSingleplayerOwner(player.nameAndId())) return;
		if (!server.isHardcore()) return;
		try {
			DeathRecord record = recordDeath(server, player, source);
			report(record);
		} catch (RuntimeException e) {
			LOG.error("Could not record the player's death", e);
		}
	}

	/** Writes the dead marker for the server's world and returns the death. Server thread only. */
	public static DeathRecord recordDeath(MinecraftServer server, ServerPlayer player, DamageSource source) {
		String worldId = levelId(server);
		String cause = clip(source.getLocalizedDeathMessage(player).getString(), 256);
		if (cause.isBlank()) cause = player.getGameProfile().name() + " died";
		Entity killerEntity = source.getEntity();
		String killer = killerEntity == null ? null : clip(BuiltInRegistries.ENTITY_TYPE.getKey(killerEntity.getType()).toString(), 128);
		long clock = server.overworld().getOverworldClockTime();
		int day = (int) Math.min(Integer.MAX_VALUE, Math.max(0L, clock) / 24000L + 1L);
		long ticksAlive = Math.max(0, player.getStats().getValue(Stats.CUSTOM.get(Stats.PLAY_TIME)));
		DeathRecord record = new DeathRecord(worldId, cause, killer, day, ticksAlive, System.currentTimeMillis());

		HardcoreMarker marker = server.getDataStorage().computeIfAbsent(HardcoreMarker.TYPE);
		marker.markDead(record);
		server.getDataStorage().saveAndJoin();
		DeathRecord stored = marker.death().orElse(record);
		lastDeath = stored;
		LOG.info("World {} ended on day {}: {}", stored.worldId(), stored.day(), stored.cause());
		return stored;
	}

	/**
	 * Sends {@code player.died} for {@code record} until Node acknowledges it. At most once per world per JVM; a
	 * no-op without a bridge.
	 */
	public static void report(DeathRecord record) {
		lastDeath = record;
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			LOG.warn("No bridge: player.died for {} is not reported", record.worldId());
			return;
		}
		if (!Messages.isWorldId(record.worldId())) {
			LOG.warn("World folder '{}' is not a MineVibe world id; player.died not reported", record.worldId());
			return;
		}
		if (!reported.add(record.worldId())) return;
		Messages.PlayerDied payload = new Messages.PlayerDied(
				record.worldId(), record.cause(), record.killer(), Math.max(1, record.day()), record.ticksAlive());
		bridge.requestUntilAcked(Messages.PLAYER_DIED, () -> payload, REPORT_TIMEOUT, REPORT_RETRY)
				.whenComplete((ok, err) -> {
					if (err == null) {
						LOG.info("Node acknowledged the death in {}", record.worldId());
					} else {
						reported.remove(record.worldId());
						LOG.error("player.died for {} failed: {}", record.worldId(), err.getMessage());
					}
				});
	}

	/** The save-folder name of the server's world, which MineVibe uses as the world id. */
	public static String levelId(MinecraftServer server) {
		return server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize().getFileName().toString();
	}

	private static String clip(String s, int max) {
		return s.length() <= max ? s : s.substring(0, max);
	}
}
