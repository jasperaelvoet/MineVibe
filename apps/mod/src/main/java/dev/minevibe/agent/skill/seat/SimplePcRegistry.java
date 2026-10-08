package dev.minevibe.agent.skill.seat;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.bridge.msg.Seats.PcSeat;
import dev.minevibe.bridge.msg.Seats.PcUnseat;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * The built-in {@link PcRegistry}: PCs registered by hand (a chair per PC id: {@code /mv pcbind}, GameTests), statuses
 * from {@link #setStatus}, the occupant is whoever rides the chair's seat entity, and changes go to Node as
 * {@code pc.seat} / {@code pc.unseat} through the skill service's outbox (which GameTests record). The PC blocks'
 * registry ({@code dev.minevibe.pc.PcSeatRegistry}) extends it with the desks' chairs, so binding by hand keeps
 * working once it is installed. Server thread only, except {@link #setStatus} / {@link #status} (any thread).
 */
public class SimplePcRegistry implements PcRegistry {
	private final Map<String, Chair> chairs = new LinkedHashMap<>();
	/** Written from bridge threads by the real registry's {@code pc.state} listener. */
	private final Map<String, String> statuses = new ConcurrentHashMap<>();
	private final Map<String, Reservation> reservations = new LinkedHashMap<>();

	/** Binds {@code pcId} to the chair at {@code pos}. */
	public void register(final String pcId, final ResourceKey<Level> dim, final BlockPos chair) {
		this.chairs.put(pcId, new Chair(dim, chair.immutable()));
	}

	public void unregister(final String pcId) {
		this.chairs.remove(pcId);
		this.statuses.remove(pcId);
		this.reservations.remove(pcId);
	}

	/** Forgets one PC's status ({@link #status} then answers null, or what a subclass falls back to). */
	public void clearStatus(final String pcId) {
		this.statuses.remove(pcId);
	}

	@Override
	public @Nullable Chair chair(final MinecraftServer server, final String pcId) {
		return this.chairs.get(pcId);
	}

	@Override
	public @Nullable String status(final String pcId) {
		return this.statuses.get(pcId);
	}

	@Override
	public void setStatus(final String pcId, final String status) {
		this.statuses.put(pcId, status);
	}

	@Override
	public Types.@Nullable Occupant occupant(final MinecraftServer server, final String pcId) {
		// Through chair(): a subclass finds chairs of its own (the PC blocks' desks).
		Chair chair = this.chair(server, pcId);
		if (chair == null) {
			return null;
		}
		ServerLevel level = server.getLevel(chair.dim());
		if (level == null) {
			return null;
		}
		SeatEntity seat = OfficeChairBlock.seatAt(level, chair.pos());
		if (seat == null) {
			return null;
		}
		for (Entity e : seat.getPassengers()) {
			if (e instanceof AgentPlayer agent) {
				return Types.Occupant.agent(agent.agentId());
			}
			if (e instanceof ServerPlayer) {
				return Types.Occupant.player();
			}
		}
		return null;
	}

	@Override
	public @Nullable Reservation reservation(final String pcId) {
		return this.reservations.get(pcId);
	}

	@Override
	public void reserve(final String pcId, final String agentId, final String kind) {
		this.reservations.values().removeIf(r -> r.agentId().equals(agentId));
		this.reservations.put(pcId, new Reservation(agentId, kind));
	}

	@Override
	public void release(final String pcId, final String agentId) {
		Reservation r = this.reservations.get(pcId);
		if (r != null && r.agentId().equals(agentId)) {
			this.reservations.remove(pcId);
		}
	}

	@Override
	public void onSeated(final String pcId, final Types.Occupant occupant, final @Nullable Long seatEpoch) {
		if (occupant.agentId() != null) {
			this.release(pcId, occupant.agentId());
		}
		SkillService service = SkillService.current();
		if (service != null) {
			service.outbox().send(dev.minevibe.bridge.msg.Seats.PC_SEAT, new PcSeat(pcId, occupant, seatEpoch));
		}
	}

	@Override
	public void onUnseated(final String pcId, final Types.Occupant occupant, final String reason, final boolean reserved) {
		SkillService service = SkillService.current();
		if (service != null) {
			service.outbox().send(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, new PcUnseat(pcId, occupant, reason, reserved));
		}
	}

	@Override
	public List<String> pcIds(final MinecraftServer server) {
		return new ArrayList<>(this.chairs.keySet());
	}

	/** PCs a reservation names (a reservation can outlive its desk's chunk; the sweep must still see it). */
	protected List<String> reservedPcIds() {
		return new ArrayList<>(this.reservations.keySet());
	}

	@Override
	public void onServerStopped() {
		this.chairs.clear();
		this.reservations.clear();
		this.statuses.clear();
	}
}
