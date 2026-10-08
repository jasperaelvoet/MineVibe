package dev.minevibe.agent.skill.seat;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.job.Walk;
import dev.minevibe.bridge.msg.Seats.SeatTarget;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * {@code sit_at_pc} / a meeting chair ({@code agent.seat}, PLAN 6.3): walk to the reserved chair and sit with a
 * non-forced {@code startRiding}. Fails with a typed code while walking when the situation changes: the player sat
 * down ({@code OCCUPIED_BY_PLAYER}), another agent took or reserved it ({@code RESERVED}), the PC went down
 * ({@code PC_DOWN}), the chair is gone ({@code NO_SEAT}) or there is no way there ({@code UNREACHABLE}).
 */
public final class SeatJob extends SkillJob {
	private final SeatTarget target;
	private final PcRegistry.Chair chair;
	private final long epoch;
	private final @Nullable String purpose;
	private final Walk walk = new Walk();
	private int tries;

	public SeatJob(final SeatTarget target, final PcRegistry.Chair chair, final long epoch, final @Nullable String purpose) {
		super(SeatTarget.PC.equals(target.kind()) ? "sit_at_pc" : "sit_meeting");
		this.target = target;
		this.chair = chair;
		this.epoch = epoch;
		this.purpose = purpose;
	}

	public SeatTarget target() {
		return this.target;
	}

	public PcRegistry.Chair chair() {
		return this.chair;
	}

	public long epoch() {
		return this.epoch;
	}

	@Override
	public boolean worksSeated() {
		return true;
	}

	@Override
	protected int timeoutTicks() {
		return 5 * MINUTE;
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.walk.reset();
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (agent.getVehicle() instanceof SeatEntity seat && this.chair.pos().equals(seat.chairPos()) && level.dimension() == this.chair.dim()) {
			return this.seated(agent);
		}
		if (agent.isPassenger()) {
			agent.stopRiding();
		}
		if (level.dimension() != this.chair.dim()) {
			return this.fail("UNREACHABLE", "the chair is in " + this.chair.dim().identifier());
		}
		if (!(level.getBlockState(this.chair.pos()).getBlock() instanceof OfficeChairBlock)) {
			return this.fail("NO_SEAT", "no chair at " + this.chair.pos().toShortString());
		}
		if (SeatTarget.PC.equals(this.target.kind())) {
			PcRegistry pcs = Seats.pcs();
			String pcId = this.target.pcId();
			String status = pcs.status(pcId);
			if (status != null && !"running".equals(status)) {
				return this.fail("PC_DOWN", pcId + " is " + status);
			}
			Types.Occupant occupant = pcs.occupant(level.getServer(), pcId);
			if (occupant != null && occupant.isPlayer()) {
				return this.fail("OCCUPIED_BY_PLAYER", "the player sits at " + pcId);
			}
			if (occupant != null && !agent.agentId().equals(occupant.agentId())) {
				return this.fail("RESERVED", occupant.agentId() + " sits at " + pcId);
			}
			PcRegistry.Reservation r = pcs.reservation(pcId);
			if (r != null && !agent.agentId().equals(r.agentId())) {
				return this.fail("RESERVED", pcId + " is reserved for " + r.agentId());
			}
		}
		Vec3 goal = Vec3.atBottomCenterOf(this.chair.pos());
		Walk.State s = agent.position().distanceTo(goal) <= 2.0 ? Walk.State.ARRIVED : this.walk.to(agent, goal, 1.2);
		if (s == Walk.State.MOVING) {
			this.progress(null, String.format(java.util.Locale.ROOT, "%.0f blocks to the chair", agent.position().distanceTo(goal)));
			return Status.RUNNING;
		}
		if (s == Walk.State.FAILED && agent.position().distanceTo(goal) > 2.5) {
			return this.fail("UNREACHABLE", "no path to the chair at " + this.chair.pos().toShortString());
		}
		this.walk.stop(agent);
		agent.controls().lookAt(Vec3.atCenterOf(this.chair.pos()));
		if (OfficeChairBlock.trySit(level, this.chair.pos(), agent)) {
			return this.seated(agent);
		}
		return ++this.tries > 20 ? this.fail("RESERVED", "someone else sits there") : Status.RUNNING;
	}

	private Status seated(final AgentPlayer agent) {
		this.put("seated", true);
		this.put("chair", this.chair.pos());
		if (SeatTarget.PC.equals(this.target.kind())) {
			this.put("pcId", this.target.pcId());
			this.put("note", "Seated at " + this.target.pcId() + ". End your turn now; the PC session starts next turn.");
		} else {
			this.put("meetingId", this.target.meetingId());
		}
		if (this.purpose != null) {
			this.put("purpose", this.purpose);
		}
		return this.done();
	}
}
