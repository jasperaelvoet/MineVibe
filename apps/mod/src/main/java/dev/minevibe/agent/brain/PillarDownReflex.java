package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.BlockOps;
import dev.minevibe.agent.nav.NavBlocks;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Priority 41: down from a pillar of agent scaffold the agent was left standing on with no safe way off, as a felling
 * climb leaves it when its job is cancelled, replaced, times out or fails up there (gathering polish review). Nothing
 * else gets it down: walks drop at most 3 blocks, Tier 2 never digs straight down, and the job that would have come
 * down is gone. Like the climb, it mines the scaffold block under the feet and drops one block at a time, until it
 * stands on something that is no pillar block (the whole pillar comes away, nothing is left standing in the world).
 *
 * <p>Only without a job: a felling climb stands up there on purpose, and comes down by itself. Never a block that is
 * not remembered scaffold, that is protected, or that has no floor under it (a bridge over a gap).
 */
final class PillarDownReflex implements Reflex {
	/** A walk steps off at most this high without harm (Tier 1's drop). */
	static final int SAFE_DROP = 3;

	/** Set once stranded: the rest of the pillar comes down too, though a walk could leave it before the end. */
	private boolean engaged;

	@Override
	public int priority() {
		return 41;
	}

	@Override
	public String name() {
		return "pillar_down";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (agent.jobs().hasJob() || agent.isPassenger() || agent.isInWater()) {
			this.engaged = false;
			return false;
		}
		if (!agent.onGround()) {
			// Falling the block between two breaks.
			return this.engaged;
		}
		if (pillarBlockUnder(agent) == null) {
			this.engaged = false;
			return false;
		}
		if (!this.engaged) {
			this.engaged = stranded(agent.level(), agent.blockPosition());
		}
		return this.engaged;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
		agent.controls().stopMovement();
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		BlockPos under = agent.onGround() ? pillarBlockUnder(agent) : null;
		if (under == null) {
			agent.controls().stopMining();
			return;
		}
		agent.controls().setJumping(false);
		if (BlockOps.mineTick(agent, under)) {
			NavBlocks.forgetScaffold(agent.level(), under);
			agent.controls().stopMining();
		}
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		this.engaged = false;
		Reflex.super.stop(agent, brain);
	}

	/**
	 * The scaffold block under the feet when it is one of a pillar: remembered agent scaffold the agent may break, a floor
	 * right under it (so breaking it drops the body one block), no lava or fire beside it. Null otherwise.
	 */
	static @Nullable BlockPos pillarBlockUnder(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos under = agent.blockPosition().below();
		BlockState s = level.getBlockState(under);
		if (!NavBlocks.isScaffold(level, under, s)) {
			return null;
		}
		BlockPos below = under.below();
		if (!NavBlocks.isFloor(level, below, level.getBlockState(below)) || !NavBlocks.mayBreak(level, under, s, agent.agentId())) {
			return null;
		}
		for (Direction d : Direction.Plane.HORIZONTAL) {
			if (NavBlocks.isHazard(level.getBlockState(under.relative(d)))) {
				return null;
			}
		}
		return under.immutable();
	}

	/**
	 * True if no side of the feet cell {@code feet} is a way off: a free cell with ground (or water) at most
	 * {@value #SAFE_DROP} blocks under it, or a step up onto a floor.
	 */
	static boolean stranded(final ServerLevel level, final BlockPos feet) {
		for (Direction d : Direction.Plane.HORIZONTAL) {
			BlockPos n = feet.relative(d);
			BlockState ns = level.getBlockState(n);
			boolean head = NavBlocks.isPassable(level, n.above(), level.getBlockState(n.above()));
			if (!NavBlocks.isPassable(level, n, ns)) {
				// A step up onto that block, with room over it.
				if (NavBlocks.isFloor(level, n, ns) && head && NavBlocks.isPassable(level, n.above(2), level.getBlockState(n.above(2)))
					&& NavBlocks.isPassable(level, feet.above(2), level.getBlockState(feet.above(2)))) {
					return false;
				}
				continue;
			}
			if (!head) {
				continue;
			}
			for (int k = 1; k <= SAFE_DROP + 1; k++) {
				BlockPos b = n.below(k);
				BlockState bs = level.getBlockState(b);
				if (!bs.getFluidState().isEmpty()) {
					if (NavBlocks.isWater(bs)) {
						return false;
					}
					break;
				}
				if (!NavBlocks.isPassable(level, b, bs)) {
					if (NavBlocks.isFloor(level, b, bs)) {
						return false;
					}
					break;
				}
			}
		}
		return true;
	}
}
