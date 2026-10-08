package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.org.office.OfficeService;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The engine behind {@code mine} and {@code collect}: pick the nearest exposed matching block, walk into reach, break
 * it at survival speed with the best tool, then pick up its drops. One block at a time; unreachable blocks are skipped.
 */
public final class Miner {
	public enum Tick {
		WORKING,
		/** No reachable matching block is left within the radius. */
		NONE_LEFT,
		FAILED
	}

	private static final int MAX_SKIPS = 8;
	private static final int COLLECT_TICKS = 40;

	private final Predicate<BlockState> match;
	private final @Nullable BlockPos center;
	private final int radius;
	private final Set<BlockPos> skip = new HashSet<>();
	private final Walk walk = new Walk();
	private @Nullable BlockPos target;
	private @Nullable BlockPos collectAt;
	private int collectTicks;
	private int mined;
	private int mineTicks;
	private String failureCode = "FAILED";
	private String failure = "";

	public Miner(final Predicate<BlockState> match, final @Nullable BlockPos center, final int radius) {
		this.match = match;
		this.center = center;
		this.radius = radius;
	}

	/** Blocks broken so far. */
	public int mined() {
		return this.mined;
	}

	public String failureCode() {
		return this.failureCode;
	}

	public String failure() {
		return this.failure;
	}

	public @Nullable BlockPos target() {
		return this.target;
	}

	/** After a preemption: re-plan the walk. */
	public void reset() {
		this.walk.reset();
	}

	/** Only picks up the drops of the last broken block; false once there are none left (or it gave up). */
	public boolean collecting(final AgentPlayer agent) {
		if (this.collectAt != null) {
			if (this.collectTicks-- > 0 && collectNear(agent, this.walk, this.collectAt, 3.5, s -> true)) {
				return true;
			}
			this.collectAt = null;
		}
		return false;
	}

	public Tick tick(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (this.collecting(agent)) {
			return Tick.WORKING;
		}
		if (this.target != null && !this.match.test(level.getBlockState(this.target))) {
			// Broken by the held attack at the end of the last tick (or by someone else while we hit it).
			if (this.mineTicks > 0) {
				this.mined++;
				this.collectAt = this.target;
				this.collectTicks = COLLECT_TICKS;
			}
			this.target = null;
			if (this.collecting(agent)) {
				return Tick.WORKING;
			}
		}
		if (this.target == null) {
			BlockPos from = this.center != null ? this.center : agent.blockPosition();
			List<BlockPos> found = BlockScan.nearest(level, from, this.radius, this.match,
				p -> !this.skip.contains(p) && BlockScan.exposed(level, p) && !BlockOps.unbreakable(level, p) && !OfficeService.protects(level, p), 24);
			if (found.isEmpty()) {
				return Tick.NONE_LEFT;
			}
			// Nearest to the agent among the nearest to the centre.
			found.sort(Comparator.comparingDouble(p -> p.distSqr(agent.blockPosition())));
			this.target = found.getFirst();
			this.mineTicks = 0;
			this.walk.reset();
		}
		BlockPos t = this.target;
		Walk.State s = this.walk.toBlock(agent, t);
		if (s == Walk.State.MOVING) {
			return Tick.WORKING;
		}
		if (s == Walk.State.FAILED) {
			this.skipTarget();
			return this.skip.size() > MAX_SKIPS ? this.failed("UNREACHABLE", "cannot reach any " + "matching block (" + this.walk.failure() + ")") : Tick.WORKING;
		}
		BlockState state = level.getBlockState(t);
		if (BlockOps.wouldDropNothing(agent, state)) {
			return this.failed("NEEDS_TOOL", "breaking " + dev.minevibe.agent.skill.Refs.blockId(state.getBlock()) + " drops nothing without the right tool");
		}
		if (++this.mineTicks > 20 * 30) {
			this.skipTarget();
			return Tick.WORKING;
		}
		if (BlockOps.mineTick(agent, t)) {
			this.mined++;
			this.target = null;
			this.collectAt = t;
			this.collectTicks = COLLECT_TICKS;
		}
		return Tick.WORKING;
	}

	private void skipTarget() {
		if (this.target != null) {
			this.skip.add(this.target);
		}
		this.target = null;
	}

	private Tick failed(final String code, final String msg) {
		this.failureCode = code;
		this.failure = msg;
		return Tick.FAILED;
	}

	/**
	 * Walks to the nearest pickable item entity within {@code radius} of {@code at} that matches {@code what}. Returns
	 * false when there is none left (the agent picks items up by touching them, like a player).
	 */
	public static boolean collectNear(final AgentPlayer agent, final Walk walk, final BlockPos at, final double radius, final Predicate<ItemStack> what) {
		ItemEntity item = nearestItem(agent, Vec3.atCenterOf(at), radius, what);
		if (item == null) {
			return false;
		}
		if (agent.position().distanceTo(item.position()) > 0.6) {
			walk.to(agent, item.position(), 0.5);
		}
		return true;
	}

	public static @Nullable ItemEntity nearestItem(final AgentPlayer agent, final Vec3 at, final double radius, final Predicate<ItemStack> what) {
		List<ItemEntity> items = agent.level().getEntitiesOfClass(ItemEntity.class, new AABB(at, at).inflate(radius),
			e -> e.isAlive() && what.test(e.getItem()) && Tossed.pickableBy(e, agent) && Inv.hasRoomFor(agent, e.getItem()));
		return items.stream().min(Comparator.comparingDouble(e -> e.distanceToSqr(agent))).orElse(null);
	}
}
