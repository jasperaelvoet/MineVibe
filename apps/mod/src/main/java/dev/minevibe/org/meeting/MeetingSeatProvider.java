package dev.minevibe.org.meeting;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.SeatJob;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.seat.SeatEntity;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * The meeting tables' chairs for the skill layer's {@code agent.seat{target: {kind: meeting}}} (PLAN 6.3, 6.6),
 * installed by {@link dev.minevibe.org.OrgModInit} through {@code Seats.installMeetingSeats}.
 *
 * <ul>
 *   <li><b>Which table.</b> The office's meeting table when the world has an office, else the table nearest to the
 *       agent ({@link MeetingSeats#findFreeChair}, within {@value MeetingSeats#SEARCH_RADIUS} blocks). The meeting id
 *       does not name a place: one meeting runs at a time (PLAN 6.6).</li>
 *   <li><b>One chair per walker.</b> A chair handed to an agent stays its claim while that agent walks to it (its job
 *       is the seat job for that chair) or sits on it, so two attendees walking over at once never get the same free
 *       chair. A repeated request for the same agent gets its claimed chair again.</li>
 *   <li><b>None free.</b> Null, which the skill layer answers with {@code NO_SEAT}.</li>
 * </ul>
 * Server thread only.
 */
public final class MeetingSeatProvider implements dev.minevibe.agent.skill.seat.MeetingSeats {
	/** Chairs handed out: agent id to chair. Stale claims (the agent gave up or stood up) are dropped when looked at. */
	private final Map<String, PcRegistry.Chair> claims = new HashMap<>();

	@Override
	public PcRegistry.@Nullable Chair chairFor(final MinecraftServer server, final String meetingId, final String agentId) {
		AgentService bodies = AgentService.get(server);
		this.claims.entrySet().removeIf(e -> !isLive(bodies.agent(e.getKey()), e.getValue()));
		PcRegistry.Chair own = this.claims.get(agentId);
		if (own != null) {
			return own;
		}
		ServerLevel level;
		BlockPos near;
		OfficeLayout office = OfficeService.layout(server);
		OfficeLayout.Slot table = office == null ? null : office.firstSlot(OfficeLayout.MEETING_TABLE);
		AgentPlayer agent = bodies.agent(agentId);
		if (table != null) {
			level = server.overworld();
			near = table.pos();
		} else if (agent != null) {
			level = agent.level();
			near = agent.blockPosition();
		} else {
			return null;
		}
		BlockPos chair = MeetingSeats.findFreeChair(level, near, pos -> this.claimedByOther(level, pos, agentId));
		if (chair == null) {
			return null;
		}
		PcRegistry.Chair claim = new PcRegistry.Chair(level.dimension(), chair.immutable());
		this.claims.put(agentId, claim);
		return claim;
	}

	/** The world ended: nobody walks to a chair any more. */
	public void clear() {
		this.claims.clear();
	}

	private boolean claimedByOther(final ServerLevel level, final BlockPos pos, final String agentId) {
		for (Map.Entry<String, PcRegistry.Chair> e : this.claims.entrySet()) {
			if (!e.getKey().equals(agentId) && e.getValue().dim() == level.dimension() && e.getValue().pos().equals(pos)) {
				return true;
			}
		}
		return false;
	}

	/** A claim holds while its agent walks to that chair (a seat job for it) or sits on it. */
	static boolean isLive(final @Nullable AgentPlayer agent, final PcRegistry.Chair chair) {
		if (agent == null || agent.isRemoved()) {
			return false;
		}
		if (agent.jobs().current() instanceof SeatJob job && job.chair().equals(chair)) {
			return true;
		}
		return agent.level().dimension() == chair.dim() && agent.getVehicle() instanceof SeatEntity seat && chair.pos().equals(seat.chairPos());
	}
}
