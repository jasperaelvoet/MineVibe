package dev.minevibe.hardcore;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
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

	/** The {@code player.died} report per world: in flight, or acknowledged (and not ignored) by Node. */
	private static final Map<String, CompletableFuture<JsonObject>> reports = new ConcurrentHashMap<>();
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
	 * Sends {@code player.died} for {@code record} until Node acknowledges it, and returns that acknowledgement. A
	 * report that is in flight or was accepted is not repeated (the same future is returned); one that Node answered
	 * {@code ok {"ignored": true}} (the world was not its current world) or that failed is forgotten, so a later Game
	 * Over for the world reports it again. Without a bridge it fails at once.
	 */
	public static synchronized CompletableFuture<JsonObject> report(DeathRecord record) {
		lastDeath = record;
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			LOG.warn("No bridge: player.died for {} is not reported", record.worldId());
			return CompletableFuture.failedFuture(new BridgeException(Messages.Codes.DISCONNECTED, "no bridge"));
		}
		if (!Messages.isWorldId(record.worldId())) {
			LOG.warn("World folder '{}' is not a MineVibe world id; player.died not reported", record.worldId());
			return CompletableFuture.failedFuture(new BridgeException(Messages.Codes.BAD_MESSAGE, "not a world id"));
		}
		CompletableFuture<JsonObject> existing = reports.get(record.worldId());
		if (existing != null) return existing;
		Messages.PlayerDied payload = new Messages.PlayerDied(
				record.worldId(), record.cause(), record.killer(), Math.max(1, record.day()), record.ticksAlive());
		CompletableFuture<JsonObject> report = bridge.requestUntilAcked(Messages.PLAYER_DIED, () -> payload, REPORT_TIMEOUT, REPORT_RETRY);
		reports.put(record.worldId(), report);
		report.whenComplete((ok, err) -> {
			if (err != null) {
				reports.remove(record.worldId(), report);
				LOG.error("player.died for {} failed: {}", record.worldId(), err.getMessage());
			} else if (isIgnored(ok)) {
				reports.remove(record.worldId(), report);
				LOG.warn("Node ignored player.died for {} (not its current world)", record.worldId());
			} else {
				LOG.info("Node acknowledged the death in {}", record.worldId());
			}
		});
		return report;
	}

	/**
	 * Reports {@code world.state{closed}} for the dead world {@code worldId} after Begin closed it, re-sending until
	 * Node acknowledges it. The death is reported (and acknowledged) first when this JVM recorded it, so Node never
	 * sees the close of a world it does not know is dead. Completes with Node's reply; Node sends the next world's
	 * {@code world.open} right after it. Fails at once without a bridge.
	 */
	public static CompletableFuture<JsonObject> reportClosed(String worldId) {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null || !Messages.isWorldId(worldId)) {
			return CompletableFuture.failedFuture(new BridgeException(Messages.Codes.DISCONNECTED, "no bridge"));
		}
		DeathRecord death = lastDeath;
		CompletableFuture<?> deathAck = death != null && death.worldId().equals(worldId)
				? report(death).handle((ok, err) -> null)
				: CompletableFuture.completedFuture(null);
		return deathAck
				.thenCompose(ignored -> bridge.requestUntilAcked(
						Messages.WORLD_STATE,
						() -> Messages.WorldState.phase(worldId, Messages.WorldState.CLOSED),
						REPORT_TIMEOUT,
						REPORT_RETRY))
				.whenComplete((ok, err) -> {
					if (err != null) {
						LOG.error("world.state{closed} for {} failed: {}", worldId, err.getMessage());
					} else {
						LOG.info("Node took the close of {}{}", worldId, isIgnored(ok) ? " (ignored: it was not its dead world)" : "");
					}
				});
	}

	/** Node answered {@code ok {"ignored": true}}. */
	public static boolean isIgnored(@Nullable JsonObject ok) {
		JsonElement e = ok == null ? null : ok.get("ignored");
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() && e.getAsBoolean();
	}

	/** The save-folder name of the server's world, which MineVibe uses as the world id. */
	public static String levelId(MinecraftServer server) {
		return server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize().getFileName().toString();
	}

	private static String clip(String s, int max) {
		return ProtocolCodec.clip(s, max);
	}
}
