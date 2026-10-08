package dev.minevibe.agent.skill.seat;

import dev.minevibe.bridge.msg.Types;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * The mod's view of PC workstations, as the agent skills need it (PLAN 6.3, 7.5): where each PC's chair is, whether the
 * PC runs, who sits there, and the "Bram is coming" / "BRB" reservations. It is the authoritative double check of who
 * sits where; {@code pc.seat} / {@code pc.unseat} report its changes to Node.
 *
 * <p>The PC blocks (track T2: {@code pc_desk}, {@code PcBlockEntity}) implement this and install it with
 * {@link Seats#installPcRegistry}. Until then {@link SimplePcRegistry} serves: PCs registered by hand (dev commands,
 * GameTests), statuses from {@link #setStatus}.
 *
 * <p>All methods run on the server thread.
 */
public interface PcRegistry {
	/** A PC's chair: the {@code office_chair} block an occupant rides. */
	record Chair(ResourceKey<Level> dim, BlockPos pos) {
	}

	/** {@code kind}: {@code coming} (walking to sit) or {@code away} (asking the player, chair kept). */
	record Reservation(String agentId, String kind) {
		public static final String COMING = "coming";
		public static final String AWAY = "away";
	}

	/** The chair of {@code pcId}, or null when no such PC has a workstation in this world. */
	@Nullable Chair chair(MinecraftServer server, String pcId);

	/** The PC's status as Node last pushed it ({@code running}, {@code off}, {@code booting}, ...); null when unknown. */
	@Nullable String status(String pcId);

	/** Node's {@code pc.state} statuses reach the mod through here (the PC block's handler calls it). */
	void setStatus(String pcId, String status);

	/** Who sits on the PC's chair now, or null. */
	Types.@Nullable Occupant occupant(MinecraftServer server, String pcId);

	@Nullable Reservation reservation(String pcId);

	/** Reserves the chair for an agent; replaces that agent's own earlier reservation. */
	void reserve(String pcId, String agentId, String kind);

	/** Drops {@code agentId}'s reservation of the chair, if it holds one. */
	void release(String pcId, String agentId);

	/** An agent sat down (after {@code agent.seat}); the registry records it and sends {@code pc.seat}. */
	void onSeated(String pcId, Types.Occupant occupant, @Nullable Long seatEpoch);

	/**
	 * An occupant left the chair ({@code reason} is an {@code UnseatReason}; {@code reserved}: the chair stays reserved for
	 * it). The registry records it and sends {@code pc.unseat}. Called for every agent that leaves a PC chair, whatever
	 * made it stand: an implementation that already reported the change (a kick it executed itself) may ignore it.
	 */
	void onUnseated(String pcId, Types.Occupant occupant, String reason, boolean reserved);

	/** Every PC id with a workstation in this world. */
	List<String> pcIds(MinecraftServer server);
}
