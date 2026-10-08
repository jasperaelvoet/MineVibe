package dev.minevibe.pc;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.bridge.msg.Seats;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.seat.SeatEntity;
import java.util.HashMap;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.core.BlockPos;
import net.minecraft.core.GlobalPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The integrated server's view of the PCs in the world (PLAN 7.5, 7.7; protocol 7.5): which desk shows which PC,
 * which chair belongs to which PC, and who of the players sits at one. Server thread only, except
 * {@link #onStatusChanged}, which hops onto it.
 *
 * <ul>
 *   <li>Desks register when their block entity loads or is bound, and unregister when it unloads or is removed. A desk
 *       whose chunk unloads (not removed) is remembered for the rest of the session: agents far from it can still be
 *       sent to its chair ({@link #chairOf}), and the walk loads it again. Removing the desk forgets it.</li>
 *   <li>Every server tick, each human player's vehicle is checked: riding the {@link SeatEntity} of a PC chair sends
 *       {@code pc.seat{occupant: player}}; leaving it sends {@code pc.unseat} with the reason noted by
 *       {@link #standUp} (default {@code stand}, {@code death} for a dead player, {@code world_end} on stop).</li>
 *   <li>Agents at PCs are the agent seat job's business ({@code agent.seat}, with its seat epoch): it can look the
 *       chair up here ({@link #chairOf}) and report through {@link #seatSink()}.</li>
 * </ul>
 */
public final class PcRegistry {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");

	/** Receives seat changes; the default sends {@code pc.seat} / {@code pc.unseat} to Node. */
	public interface SeatSink {
		void seat(String pcId, Types.Occupant occupant);

		void unseat(String pcId, Types.Occupant occupant, String reason);
	}

	public static final SeatSink BRIDGE_SINK = new SeatSink() {
		@Override
		public void seat(final String pcId, final Types.Occupant occupant) {
			PcBridge.send(Seats.PC_SEAT, new Seats.PcSeat(pcId, occupant, null));
		}

		@Override
		public void unseat(final String pcId, final Types.Occupant occupant, final String reason) {
			PcBridge.send(Seats.PC_UNSEAT, new Seats.PcUnseat(pcId, occupant, reason, false));
		}
	};

	private static final Map<String, GlobalPos> DESKS = new HashMap<>();
	private static final Map<GlobalPos, String> CHAIRS = new HashMap<>();
	/** Desks seen this session whose chunk has unloaded since (never removed): pcId to the desk and its chair. */
	private static final Map<String, Remembered> UNLOADED = new HashMap<>();

	/** Where an unloaded desk and its chair are. */
	private record Remembered(GlobalPos desk, GlobalPos chair) {}
	/** Human players seated at a PC: player UUID to pcId. */
	private static final Map<UUID, String> SEATED = new HashMap<>();
	/** Why a player is about to stand (set just before the dismount). */
	private static final Map<UUID, String> UNSEAT_REASONS = new ConcurrentHashMap<>();
	private static final Queue<GlobalPos> PENDING_LEDS = new ConcurrentLinkedQueue<>();
	private static volatile SeatSink sink = BRIDGE_SINK;

	private PcRegistry() {}

	// -----------------------------------------------------------------------------------------
	// Desks and chairs
	// -----------------------------------------------------------------------------------------

	public static void registerDesk(final ServerLevel level, final PcBlockEntity be) {
		String pcId = be.pcId();
		if (pcId == null) {
			return;
		}
		GlobalPos desk = GlobalPos.of(level.dimension(), be.getBlockPos());
		UNLOADED.remove(pcId);
		GlobalPos previous = DESKS.put(pcId, desk);
		if (previous != null && !previous.equals(desk)) {
			LOG.warn("PC {} has desks at {} and {}; the newer one wins", pcId, previous, desk);
		}
		BlockPos seat = be.seatPos();
		if (seat != null) {
			CHAIRS.put(GlobalPos.of(level.dimension(), seat), pcId);
		}
	}

	/** The desk is gone (removed, or unbound from its PC): forgotten, also as an unloaded desk. */
	public static void unregisterDesk(final ServerLevel level, final PcBlockEntity be) {
		GlobalPos desk = GlobalPos.of(level.dimension(), be.getBlockPos());
		DESKS.values().removeIf(desk::equals);
		UNLOADED.values().removeIf(r -> r.desk().equals(desk));
		BlockPos seat = be.seatPos();
		if (seat != null) {
			CHAIRS.remove(GlobalPos.of(level.dimension(), seat));
		}
	}

	/**
	 * The desk's block entity is unloading ({@code BLOCK_ENTITY_UNLOAD}). That event also follows a removal, which has
	 * already unregistered the desk ({@code preRemoveSideEffects}); a desk still registered here, still standing when
	 * its chunk can be looked at, is only leaving memory with its chunk: remember where its chair is.
	 */
	public static void unloadDesk(final ServerLevel level, final PcBlockEntity be) {
		String pcId = be.pcId();
		GlobalPos desk = GlobalPos.of(level.dimension(), be.getBlockPos());
		BlockPos seat = be.seatPos();
		boolean registered = pcId != null && desk.equals(DESKS.get(pcId));
		unregisterDesk(level, be);
		if (!registered || seat == null) {
			return;
		}
		// Never loads anything: the chunk as it is now, if it is still reachable at all.
		net.minecraft.world.level.chunk.LevelChunk chunk = level.getChunkSource().getChunkNow(desk.pos().getX() >> 4, desk.pos().getZ() >> 4);
		if (chunk != null && !(chunk.getBlockState(desk.pos()).getBlock() instanceof PcDeskBlock)) {
			return; // removed without side effects (flag 256): not a desk any more
		}
		UNLOADED.put(pcId, new Remembered(desk, GlobalPos.of(level.dimension(), seat)));
	}

	/** The monitor block of {@code pcId}'s desk, if one is loaded. */
	public static @Nullable GlobalPos deskOf(final String pcId) {
		return DESKS.get(pcId);
	}

	/** The monitor block of {@code pcId}'s desk, loaded or seen this session in a chunk that has unloaded since. */
	public static @Nullable GlobalPos knownDeskOf(final String pcId) {
		GlobalPos desk = DESKS.get(pcId);
		if (desk != null) {
			return desk;
		}
		Remembered r = UNLOADED.get(pcId);
		return r == null ? null : r.desk();
	}

	/**
	 * The chair of {@code pcId}'s desk: a loaded desk's, else the one remembered from a desk whose chunk unloaded this
	 * session (the agent walks there and the chunk loads again), else null.
	 */
	public static @Nullable GlobalPos chairOf(final MinecraftServer server, final String pcId) {
		GlobalPos desk = DESKS.get(pcId);
		if (desk == null) {
			Remembered r = UNLOADED.get(pcId);
			return r == null ? null : r.chair();
		}
		ServerLevel level = server.getLevel(desk.dimension());
		if (level != null && level.getBlockEntity(desk.pos()) instanceof PcBlockEntity be && be.seatPos() != null) {
			return GlobalPos.of(desk.dimension(), be.seatPos());
		}
		return null;
	}

	/** The PC whose chair is at {@code chairPos}, if any. */
	public static @Nullable String pcAtChair(final ServerLevel level, final BlockPos chairPos) {
		return CHAIRS.get(GlobalPos.of(level.dimension(), chairPos));
	}

	/**
	 * The PC whose chair {@code entity} sits on, if any. A meeting seat is never a PC seat (PLAN 6.3: no PcControlScreen,
	 * no model swap, no {@code maxSeated} count), even on a chair that is also some desk's chair.
	 */
	public static @Nullable String pcSeatedAt(final Entity entity) {
		if (entity.getVehicle() instanceof SeatEntity seat && seat.isPcSeat() && seat.chairPos() != null && entity.level() instanceof ServerLevel level) {
			return pcAtChair(level, seat.chairPos());
		}
		return null;
	}

	/** Every PC with a desk in this world: loaded, or seen this session in a chunk that has unloaded since. */
	public static java.util.Set<String> pcIds() {
		java.util.Set<String> ids = new java.util.HashSet<>(DESKS.keySet());
		ids.addAll(UNLOADED.keySet());
		return java.util.Set.copyOf(ids);
	}

	// -----------------------------------------------------------------------------------------
	// LED
	// -----------------------------------------------------------------------------------------

	/** Refreshes the LED of the desk at {@code pos} on the next server tick (safe to call while a chunk loads). */
	public static void queueLedRefresh(final ServerLevel level, final BlockPos pos) {
		PENDING_LEDS.add(GlobalPos.of(level.dimension(), pos.immutable()));
	}

	private static void refreshQueuedLeds(final MinecraftServer server) {
		for (GlobalPos p = PENDING_LEDS.poll(); p != null; p = PENDING_LEDS.poll()) {
			ServerLevel level = server.getLevel(p.dimension());
			if (level != null && level.isLoaded(p.pos()) && level.getBlockEntity(p.pos()) instanceof PcBlockEntity be) {
				be.refreshLed();
			}
		}
	}

	/** A PC's state changed (any thread): update its desk's LED on the server thread. */
	public static void onStatusChanged(final @Nullable MinecraftServer server, final String pcId) {
		if (server == null || !server.isRunning()) {
			return;
		}
		server.execute(() -> refreshLed(server, pcId));
	}

	public static void refreshLed(final MinecraftServer server, final String pcId) {
		GlobalPos desk = DESKS.get(pcId);
		if (desk == null) {
			return;
		}
		ServerLevel level = server.getLevel(desk.dimension());
		if (level != null && level.isLoaded(desk.pos()) && level.getBlockEntity(desk.pos()) instanceof PcBlockEntity be) {
			be.refreshLed();
		}
	}

	// -----------------------------------------------------------------------------------------
	// Players at PCs
	// -----------------------------------------------------------------------------------------

	public static SeatSink seatSink() {
		return sink;
	}

	/** Replaces the seat sink (GameTests capture seat events); null restores the bridge. */
	public static void setSeatSink(final @Nullable SeatSink newSink) {
		sink = newSink != null ? newSink : BRIDGE_SINK;
	}

	/** Stands {@code player} up from a PC chair, reporting {@code reason} (an {@code UnseatReason}). */
	public static void standUp(final ServerPlayer player, final String reason) {
		if (player.getVehicle() instanceof SeatEntity) {
			UNSEAT_REASONS.put(player.getUUID(), reason);
			player.stopRiding();
		}
	}

	/** Server tick: queued LED refreshes, then human players sitting down at, or leaving, a PC chair. */
	public static void tick(final MinecraftServer server) {
		refreshQueuedLeds(server);
		Map<UUID, String> now = new HashMap<>();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			if (player instanceof AgentPlayer) {
				continue;
			}
			String pcId = pcSeatedAt(player);
			if (pcId != null) {
				now.put(player.getUUID(), pcId);
			}
		}
		for (Map.Entry<UUID, String> was : Map.copyOf(SEATED).entrySet()) {
			String pcId = now.get(was.getKey());
			if (!was.getValue().equals(pcId)) {
				ServerPlayer player = server.getPlayerList().getPlayer(was.getKey());
				String reason = UNSEAT_REASONS.remove(was.getKey());
				if (reason == null) {
					reason = player == null ? "app_restart" : player.isDeadOrDying() ? "death" : "stand";
				}
				SEATED.remove(was.getKey());
				LOG.info("Player left PC {} ({})", was.getValue(), reason);
				sink.unseat(was.getValue(), Types.Occupant.player(), reason);
			}
		}
		for (Map.Entry<UUID, String> is : now.entrySet()) {
			if (!is.getValue().equals(SEATED.get(is.getKey()))) {
				SEATED.put(is.getKey(), is.getValue());
				UNSEAT_REASONS.remove(is.getKey());
				LOG.info("Player sat down at PC {}", is.getValue());
				// A chair kept for an agent (away asking the player, or walking over) is the player's now.
				PcSeatRegistry.INSTANCE.playerSat(is.getValue());
				sink.seat(is.getValue(), Types.Occupant.player());
			}
		}
	}

	/** The PC a human player sits at, as last reported. */
	public static @Nullable String seatedPc(final UUID player) {
		return SEATED.get(player);
	}

	/** Server stopping: seated players leave with {@code world_end}; everything is forgotten. */
	public static void onServerStopping() {
		for (Map.Entry<UUID, String> was : SEATED.entrySet()) {
			sink.unseat(was.getValue(), Types.Occupant.player(), "world_end");
		}
		reset();
	}

	public static void reset() {
		DESKS.clear();
		CHAIRS.clear();
		UNLOADED.clear();
		SEATED.clear();
		UNSEAT_REASONS.clear();
		PENDING_LEDS.clear();
	}
}
