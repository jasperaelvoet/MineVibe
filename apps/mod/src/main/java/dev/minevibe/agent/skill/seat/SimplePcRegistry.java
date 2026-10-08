package dev.minevibe.agent.skill.seat;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.bridge.msg.Seats.PcSeat;
import dev.minevibe.bridge.msg.Seats.PcUnseat;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * The built-in {@link PcRegistry}, used until the PC blocks install theirs: PCs are registered by hand (a chair per PC
 * id), statuses come from {@link #setStatus}, the occupant is whoever rides the chair's seat entity, and changes go to
 * Node as {@code pc.seat} / {@code pc.unseat}.
 */
public final class SimplePcRegistry implements PcRegistry {
	private final Map<String, Chair> chairs = new LinkedHashMap<>();
	private final Map<String, String> statuses = new HashMap<>();
	private final Map<String, Reservation> reservations = new HashMap<>();

	/** Binds {@code pcId} to the chair at {@code pos}. */
	public void register(final String pcId, final ResourceKey<Level> dim, final BlockPos chair) {
		this.chairs.put(pcId, new Chair(dim, chair.immutable()));
	}

	public void unregister(final String pcId) {
		this.chairs.remove(pcId);
		this.statuses.remove(pcId);
		this.reservations.remove(pcId);
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
		Chair chair = this.chairs.get(pcId);
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
}
