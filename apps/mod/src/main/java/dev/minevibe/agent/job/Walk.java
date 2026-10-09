package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.nav.NavDebug;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Navigation for skill jobs: keeps one goal on the {@link AgentNavigator}, re-issues it after a preemption (the
 * navigator is stopped then) or when a moving goal drifts, and reports arrival or failure. Fixed goals may dig: a block
 * ({@link #toBlock}) or place ({@link #toDig}) the walking navigator (Tier 1) cannot reach is tried with Tier 2, which
 * breaks natural blocks and builds pillars and bridges; {@link #toMine} and {@link #toTrunk} use Tier 2 straight away,
 * and a drop no walk leads to is fetched with Tier 2 ({@link #toItem}). Mobs and people ({@link #to},
 * {@link #toEntity}) are walked to only.
 */
public final class Walk {
	public enum State {
		ARRIVED,
		MOVING,
		FAILED
	}

	private enum Mode {
		POINT,
		POINT_DIG,
		ITEM,
		BLOCK,
		MINE,
		TRUNK
	}

	/** Blocks a hand reaches, a little under vanilla's 4.5 so a goal at the edge still counts. */
	public static final double BLOCK_REACH = 4.0;

	private @Nullable Vec3 goal;
	private double reach;
	private @Nullable BlockPos block;
	private Mode mode = Mode.POINT;
	private @Nullable String failure;
	private int reissues;
	private int arrivedTicks;
	/** Ticks an item may lie untouched next to an arrived walk before the walk gives up on it. */
	private static final int PICKUP_WAIT_TICKS = 20;
	/** How often one block goal may be issued again before the walk gives up on it ({@code no_progress}). */
	private static final int MAX_REISSUES = 8;

	/**
	 * Walks toward {@code goal} until within {@code reach} blocks (horizontally, |dy| at most 1.5), on foot only (Tier
	 * 1): mobs and people move, and are not worth digging for.
	 */
	public State to(final AgentPlayer agent, final Vec3 goal, final double reach) {
		return this.point(agent, goal, reach, Mode.POINT);
	}

	/**
	 * Walks to pick up the item lying at {@code item}. Walking first; a drop caught where no walk leads (in a tree's
	 * leaves, on a ledge) is fetched with Tier 2, from anywhere the pickup box reaches it.
	 */
	public State toItem(final AgentPlayer agent, final Vec3 item) {
		AgentNavigator nav = agent.navigator();
		if (this.goal == null || this.mode != Mode.ITEM || nav.status() == AgentNavigator.Status.IDLE
			|| this.goal.distanceTo(item) > 1.0 && nav.status() != AgentNavigator.Status.FAILED) {
			this.goal = item;
			this.reach = 0.5;
			this.mode = Mode.ITEM;
			this.block = null;
			this.arrivedTicks = 0;
			nav.moveToItem(item);
		}
		State s = this.status(nav);
		// Arrived, yet the caller still sees the item (it lies where the pickup box does not reach: inside a block, under
		// a trunk): give up on it rather than stand there until it despawns.
		if (s == State.ARRIVED && ++this.arrivedTicks > PICKUP_WAIT_TICKS) {
			this.failure = "not_picked_up";
			this.goal = null;
			return State.FAILED;
		}
		return s;
	}

	/** Like {@link #to}, but a place the walk cannot reach is tried again breaking natural blocks, pillaring, bridging. */
	public State toDig(final AgentPlayer agent, final Vec3 goal, final double reach) {
		return this.point(agent, goal, reach, Mode.POINT_DIG);
	}

	private State point(final AgentPlayer agent, final Vec3 goal, final double reach, final Mode mode) {
		AgentNavigator nav = agent.navigator();
		boolean dig = mode == Mode.POINT_DIG;
		boolean fresh = this.goal == null || this.mode != mode || Math.abs(reach - this.reach) > 1.0E-3;
		if (fresh || nav.status() == AgentNavigator.Status.IDLE) {
			this.goal = goal;
			this.reach = reach;
			this.mode = mode;
			this.block = null;
			nav.moveTo(goal, reach, dig);
		} else if (this.goal.distanceTo(goal) > 1.0) {
			this.goal = goal;
			if (nav.status() == AgentNavigator.Status.ARRIVED) {
				nav.moveTo(goal, reach, dig);
			} else {
				nav.updateGoal(goal, reach);
			}
		}
		return this.status(nav);
	}

	/** Walks until the block at {@code pos} is within hand reach (to use it or build next to it). */
	public State toBlock(final AgentPlayer agent, final BlockPos pos) {
		if (inReach(agent, pos) && settled(agent)) {
			this.stop(agent);
			return State.ARRIVED;
		}
		State s = this.toward(agent, pos, Mode.BLOCK);
		if (s == State.ARRIVED && !inReach(agent, pos)) {
			// Arrived as close as the path allows, but the block is still out of reach (e.g. high up).
			this.failure = "out_of_reach";
			this.goal = null;
			return State.FAILED;
		}
		return s;
	}

	/**
	 * Walks until the block at {@code pos} can be mined: in hand reach with a face open toward the agent, reached by
	 * breaking natural blocks, pillars or bridges when there is no walking way (never standing on it).
	 */
	public State toMine(final AgentPlayer agent, final BlockPos pos) {
		if (inReach(agent, pos) && !standsOn(agent, pos) && settled(agent)) {
			this.stop(agent);
			return State.ARRIVED;
		}
		State s = this.toward(agent, pos, Mode.MINE);
		if (s == State.ARRIVED && !inReach(agent, pos)) {
			this.failure = "out_of_reach";
			this.goal = null;
			return State.FAILED;
		}
		return s;
	}

	/** Walks (digging, pillaring or bridging if needed) to a spot right next to the trunk of the tree {@code log} is in. */
	public State toTrunk(final AgentPlayer agent, final BlockPos log) {
		return this.toward(agent, log, Mode.TRUNK);
	}

	private State toward(final AgentPlayer agent, final BlockPos pos, final Mode mode) {
		AgentNavigator nav = agent.navigator();
		boolean same = this.mode == mode && pos.equals(this.block);
		if (this.goal == null || !same || nav.status() == AgentNavigator.Status.IDLE) {
			// The same block asked for again and again (arrived, pushed off, back): a livelock, not progress.
			this.reissues = same ? this.reissues + 1 : 0;
			if (NavDebug.ENABLED && same) {
				NavDebug.log(agent.agentId(), "walk_reissue", "mode", mode, "block", pos.toShortString(), "n", this.reissues, "nav", nav.status(),
					"at", agent.blockPosition().toShortString());
			}
			if (this.reissues > MAX_REISSUES) {
				this.reissues = 0;
				this.failure = "no_progress";
				this.goal = null;
				return State.FAILED;
			}
			this.goal = Vec3.atBottomCenterOf(pos);
			this.reach = 0.0;
			this.block = pos.immutable();
			this.mode = mode;
			switch (mode) {
				case BLOCK -> nav.approachBlock(pos);
				case MINE -> nav.reachBlock(pos);
				case TRUNK -> nav.reachTrunk(pos);
				case POINT, POINT_DIG -> nav.moveTo(this.goal, 1.0, mode == Mode.POINT_DIG);
				case ITEM -> nav.moveToItem(this.goal);
			}
		}
		return this.status(nav);
	}

	private State status(final AgentNavigator nav) {
		return switch (nav.status()) {
			case ARRIVED -> State.ARRIVED;
			case FAILED -> {
				this.failure = nav.failureReason();
				this.goal = null;
				yield State.FAILED;
			}
			case MOVING, IDLE -> State.MOVING;
		};
	}

	/** Walks until {@code entity} is within {@code range} blocks. */
	public State toEntity(final AgentPlayer agent, final Entity entity, final double range) {
		if (agent.distanceTo(entity) <= range && Math.abs(entity.getY() - agent.getY()) <= 1.5) {
			this.stop(agent);
			return State.ARRIVED;
		}
		return this.to(agent, entity.position(), Math.max(0.5, range - 0.3));
	}

	/**
	 * Stops walking. A job holds several walks (collect: one for loose items, one in its miner) over one navigator, so
	 * whatever still moves the body stops too: a walk left running for a vanished item would keep digging and steering
	 * while the job works here (each tick's held attack on its own block aborted the other's, and neither ever broke).
	 */
	public void stop(final AgentPlayer agent) {
		if (this.goal != null || agent.navigator().isMoving()) {
			agent.navigator().stop();
		}
		this.goal = null;
	}

	/** Forget the goal so the next call re-plans (after a preemption). */
	public void reset() {
		this.goal = null;
	}

	public String failure() {
		return this.failure == null ? "no_path" : this.failure;
	}

	public static boolean inReach(final AgentPlayer agent, final BlockPos pos) {
		return agent.getEyePosition().distanceTo(Vec3.atCenterOf(pos)) <= BLOCK_REACH;
	}

	/**
	 * Standing (or swimming, climbing, riding): a block that comes into reach at the top of a jump (a pillar being built)
	 * is not reached yet; stopping there would drop the body back out of reach and start the walk over.
	 */
	public static boolean settled(final AgentPlayer agent) {
		return agent.onGround() || agent.isInWater() || agent.onClimbable() || agent.isPassenger();
	}

	/** True if {@code pos} is the block under the agent's feet (never mined: no digging straight down). */
	public static boolean standsOn(final AgentPlayer agent, final BlockPos pos) {
		BlockPos feet = agent.blockPosition();
		return pos.getX() == feet.getX() && pos.getZ() == feet.getZ() && pos.getY() == feet.getY() - 1;
	}
}
