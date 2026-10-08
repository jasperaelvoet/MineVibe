package dev.minevibe.pc;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.skill.seat.SimplePcRegistry;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.GlobalPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The PC blocks' answer to the skill layer's {@link dev.minevibe.agent.skill.seat.PcRegistry} (PLAN 6.3, 7.5, 7.7):
 * {@code agent.seat} / {@code sit_at_pc} find a PC's chair through the desk that shows it, and every agent seat change
 * goes to Node as {@code pc.seat} / {@code pc.unseat}. {@link PcModInit} installs the one instance.
 *
 * <ul>
 *   <li><b>Chairs.</b> A PC's chair is its loaded desk's chair ({@link PcRegistry#chairOf}); chairs bound by hand
 *       ({@code /mv pcbind}, GameTests) still work, the desk wins when both exist.</li>
 *   <li><b>Status.</b> {@code pc.state} reaches {@link #setStatus} through a {@link PcStates} listener (no second
 *       bridge handler: {@code PcBridge} owns {@code pc.state}); a PC nobody set a status for answers what
 *       {@link PcStates} holds.</li>
 *   <li><b>Seat events.</b> Agents only, from the {@code agent.seat} job path ({@code SkillService}: with the seat
 *       epoch). The human player's {@code pc.seat} / {@code pc.unseat} stay {@link PcRegistry}'s.</li>
 *   <li><b>Kick</b> ({@link #kick}): records {@code kick} as the reason ({@code noteStand}) before the dismount, so
 *       the seat bookkeeping reports {@code pc.unseat{kick}} and a {@code kicked} event; the agent steps aside and
 *       cannot sit at that PC again for {@value #RESIT_COOLDOWN_SECONDS} s (also after Node's own
 *       {@code agent.unseat{kick}}).</li>
 *   <li><b>The player takes a reserved chair</b> (the agent is away asking): the reservation ends
 *       ({@link #playerSat}).</li>
 *   <li><b>Reservation sweep.</b> {@link #pcIds} also lists PCs that only a reservation names (a desk whose chunk
 *       unloaded), so the skill layer's once-a-second sweep still releases a dead agent's chair.</li>
 * </ul>
 * Server thread only, except {@link #setStatus} and {@link #status}.
 */
public final class PcSeatRegistry extends SimplePcRegistry {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");

	public static final int RESIT_COOLDOWN_SECONDS = 30;
	private static final long RESIT_COOLDOWN_NANOS = RESIT_COOLDOWN_SECONDS * 1_000_000_000L;

	/** The installed instance. */
	public static final PcSeatRegistry INSTANCE = new PcSeatRegistry();

	/** {@code agentId@pcId} to when the re-sit cooldown of a kick ends ({@link System#nanoTime}). */
	private final Map<String, Long> cooldowns = new HashMap<>();
	private volatile Clock clock = System::nanoTime;

	/** A nano-time source (tests shorten the cooldown with their own). */
	@FunctionalInterface
	public interface Clock {
		long nanoTime();
	}

	PcSeatRegistry() {}

	/** Feeds statuses from Node's {@code pc.state} pushes (and {@code hello.ok} snapshots). Call once. */
	void listenToPcStates() {
		PcStates.addListener(this::onPcState);
		PcStates.addRemovalListener(this::clearStatus);
		for (Pc.PcInfo info : PcStates.all()) {
			this.onPcState(info);
		}
	}

	void onPcState(final Pc.PcInfo info) {
		this.setStatus(info.pcId(), info.status());
	}

	/** Replaces the clock (tests); null restores {@link System#nanoTime}. */
	public void setClock(final @Nullable Clock newClock) {
		this.clock = newClock != null ? newClock : System::nanoTime;
	}

	// ------------------------------------------------------------------ PcRegistry

	@Override
	public @Nullable Chair chair(final MinecraftServer server, final String pcId) {
		GlobalPos desk = PcRegistry.chairOf(server, pcId);
		if (desk != null) {
			return new Chair(desk.dimension(), desk.pos());
		}
		return super.chair(server, pcId);
	}

	@Override
	public @Nullable String status(final String pcId) {
		String status = super.status(pcId);
		if (status != null) {
			return status;
		}
		Pc.PcInfo info = PcStates.get(pcId);
		return info == null ? null : info.status();
	}

	@Override
	public List<String> pcIds(final MinecraftServer server) {
		Set<String> ids = new LinkedHashSet<>();
		List<String> desks = new ArrayList<>(PcRegistry.pcIds());
		desks.sort(null);
		ids.addAll(desks);
		ids.addAll(super.pcIds(server));
		ids.addAll(this.reservedPcIds());
		return new ArrayList<>(ids);
	}

	@Override
	public void onUnseated(final String pcId, final Types.Occupant occupant, final String reason, final boolean reserved) {
		if ("kick".equals(reason) && occupant.agentId() != null) {
			this.cooldowns.put(key(occupant.agentId(), pcId), this.clock.nanoTime() + RESIT_COOLDOWN_NANOS);
		}
		super.onUnseated(pcId, occupant, reason, reserved);
	}

	@Override
	public void onServerStopped() {
		super.onServerStopped();
		this.cooldowns.clear();
	}

	// ------------------------------------------------------------------ kick and re-sit

	/**
	 * Seconds left before {@code agentId} may sit at {@code pcId} again after a kick (0 when it may). The seat
	 * pre-checks answer {@code RESERVED} meanwhile.
	 */
	@Override
	public int resitCooldownSeconds(final String agentId, final String pcId) {
		Long until = this.cooldowns.get(key(agentId, pcId));
		if (until == null) {
			return 0;
		}
		long left = until - this.clock.nanoTime();
		if (left <= 0) {
			this.cooldowns.remove(key(agentId, pcId));
			return 0;
		}
		return (int)Math.max(1, (left + 999_999_999L) / 1_000_000_000L);
	}

	/**
	 * Kicks the agent sitting at {@code pcId} (PLAN 7.7.8): notes {@code kick} as its reason to stand before the
	 * dismount (the seat bookkeeping then sends {@code pc.unseat{kick}} and a {@code kicked} event), steps it aside
	 * and starts the re-sit cooldown. Returns the kicked agent's id, or null when no agent sat there.
	 */
	public @Nullable String kick(final MinecraftServer server, final String pcId) {
		Chair chair = this.chair(server, pcId);
		ServerLevel level = chair == null ? null : server.getLevel(chair.dim());
		if (level == null) {
			return null;
		}
		SeatEntity seat = OfficeChairBlock.seatAt(level, chair.pos());
		if (seat == null) {
			return null;
		}
		for (Entity passenger : List.copyOf(seat.getPassengers())) {
			if (passenger instanceof AgentPlayer agent) {
				agent.brain().noteStand("kick");
				agent.stopRiding();
				stepAside(level, chair.pos(), agent);
				this.cooldowns.put(key(agent.agentId(), pcId), this.clock.nanoTime() + RESIT_COOLDOWN_NANOS);
				LOG.info("Kicked {} off PC {}", agent.agentId(), pcId);
				return agent.agentId();
			}
		}
		return null;
	}

	/**
	 * The player right-clicked an occupied PC chair and confirmed "Kick Bram and sit?": kick the agent, then sit the
	 * player down. Returns false when the chair is not a PC chair or the player could not sit.
	 */
	public boolean kickAndSit(final ServerPlayer player, final BlockPos chairPos) {
		if (!(player.level() instanceof ServerLevel level)) {
			return false;
		}
		String pcId = PcRegistry.pcAtChair(level, chairPos);
		if (pcId == null) {
			return false;
		}
		this.kick(level.getServer(), pcId);
		return OfficeChairBlock.trySit(level, chairPos, player);
	}

	/** The human player sat down at {@code pcId}: a reservation held for an agent (away asking, or coming) ends. */
	void playerSat(final String pcId) {
		Reservation r = this.reservation(pcId);
		if (r != null) {
			LOG.info("The player took PC {}; {}'s reservation ({}) ends", pcId, r.agentId(), r.kind());
			this.release(pcId, r.agentId());
		}
	}

	/** Puts a dismounted agent on a free cell beside the chair (not on it, not into the desk). */
	static void stepAside(final ServerLevel level, final BlockPos chair, final AgentPlayer agent) {
		List<BlockPos> spots = new ArrayList<>();
		for (Direction d : Direction.Plane.HORIZONTAL) {
			spots.add(chair.relative(d));
		}
		for (Direction d : Direction.Plane.HORIZONTAL) {
			spots.add(chair.relative(d).relative(d.getClockWise()));
		}
		for (BlockPos p : spots) {
			for (int dy = 0; dy >= -1; dy--) {
				BlockPos feet = p.above(dy);
				if (level.isLoaded(feet) && AgentNavigator.isStandable(level, feet)) {
					Vec3 to = Vec3.atBottomCenterOf(feet);
					agent.teleportTo(to.x, to.y, to.z);
					return;
				}
			}
		}
	}

	private static String key(final String agentId, final String pcId) {
		return agentId + "@" + pcId;
	}
}
