package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import it.unimi.dsi.fastutil.longs.LongSet;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Follows a {@link DigPath} with player controls, one {@link DigStep} at a time: break the step's blocks at survival
 * speed with the best tool, place its scaffold (a jump-and-place pillar, or a sneaking bridge), then move to the next
 * cell (walk, jump, drop, swim, climb, through wooden doors).
 *
 * <p>Every step is checked again before it runs, and every block again before it is broken: a block that is no
 * longer natural, has water or lava next to it, gravel on top, or carries the agent is never broken; the executor asks
 * for a new plan instead ({@link Result#REPLAN}) and remembers the cell in {@code forbidden} for it (so is a cell a
 * scaffold block failed to go into). A drop is only taken while it still lands within the safe fall (or in water) on
 * something that does not hurt: a landing mined away since the plan re-plans rather than fall further. A step that
 * takes too long, or an agent pushed off its path, also re-plans.
 */
final class DigPathExecutor {
	enum Result {
		RUNNING,
		DONE,
		REPLAN
	}

	private enum Phase {
		START,
		BREAK,
		CENTER,
		PLACE,
		MOVE
	}

	private static final double ARRIVE = 0.35;
	private static final double PASS_THROUGH = 0.6;
	private static final int MOVE_TIMEOUT = 120;
	private static final int PLACE_TIMEOUT = 60;
	private static final double HAND_REACH = 4.4;
	/** Pillar blocks kept for a job to clear; older ones (walks no job cleans up after) are forgotten. */
	private static final int MAX_PILLARS_KEPT = 64;
	/** How far below a drop's edge the landing is looked for (the planner drops at most 16 into water). */
	private static final int MAX_DROP_SCAN = 17;

	private final NavDoors doors;
	private final LongSet forbidden;
	private @Nullable DigPath path;
	private int index;
	private Phase phase = Phase.START;
	private int phaseTicks;
	private int breakTicks;
	/** Ticks the held attack was on the block being broken (diagnostics for a break that never ends). */
	private int miningTicks;
	/** Ticks spent waiting to stand clear of (or in reach of) the block to break. */
	private int waitTicks;
	private @Nullable BlockPos breaking;
	private @Nullable String replanReason;
	private int broken;
	private int placed;
	private final List<BlockPos> pillars = new java.util.ArrayList<>();

	DigPathExecutor(final NavDoors doors, final LongSet forbidden) {
		this.doors = doors;
		this.forbidden = forbidden;
	}

	void setPath(final @Nullable DigPath path) {
		this.path = path;
		this.index = 0;
		this.enter(Phase.START);
		this.breaking = null;
		this.replanReason = null;
	}

	@Nullable DigPath path() {
		return this.path;
	}

	boolean hasPath() {
		return this.path != null;
	}

	/** Why the last {@link Result#REPLAN} happened. */
	@Nullable String replanReason() {
		return this.replanReason;
	}

	int broken() {
		return this.broken;
	}

	int placed() {
		return this.placed;
	}

	/** Pillar blocks placed since the last call, bottom first (a job may clear them away again). */
	List<BlockPos> drainPillars() {
		List<BlockPos> out = List.copyOf(this.pillars);
		this.pillars.clear();
		return out;
	}

	/** True if the remaining path walks through the door at {@code doorLower}. */
	boolean goesThrough(final BlockPos doorLower) {
		if (this.path == null) {
			return false;
		}
		List<DigStep> steps = this.path.steps();
		for (int i = this.index; i < steps.size(); i++) {
			BlockPos d = steps.get(i).dest();
			if (d.getX() == doorLower.getX() && d.getZ() == doorLower.getZ() && Math.abs(d.getY() - doorLower.getY()) <= 1) {
				return true;
			}
		}
		return false;
	}

	void clear(final AgentPlayer agent) {
		agent.controls().stopMining();
		this.path = null;
	}

	Result tick(final AgentPlayer agent) {
		if (this.path == null || this.index >= this.path.steps().size()) {
			agent.controls().stopMovement();
			return Result.DONE;
		}
		DigStep step = this.path.steps().get(this.index);
		this.phaseTicks++;
		if (this.phase != Phase.START && this.offPath(agent, step)) {
			return this.replan(agent, "off_path");
		}
		return switch (this.phase) {
			case START -> this.start(agent, step);
			case BREAK -> this.breakBlocks(agent, step);
			case CENTER -> this.center(agent, step);
			case PLACE -> this.place(agent, step);
			case MOVE -> this.move(agent, step);
		};
	}

	// ---------------------------------------------------------------- phases

	private Result start(final AgentPlayer agent, final DigStep step) {
		ServerLevel level = agent.level();
		for (BlockPos b : step.breaks()) {
			BlockState s = level.getBlockState(b);
			if (NavBlocks.isPassable(level, b, s)) {
				continue;
			}
			if (!this.mayBreakNow(agent, b, s)) {
				this.forbidden.add(b.asLong());
				return this.replan(agent, "unsafe_break");
			}
		}
		if (step.place() != null) {
			BlockState s = level.getBlockState(step.place());
			boolean already = NavBlocks.isFloor(level, step.place(), s);
			if (!already && !s.canBeReplaced()) {
				this.forbidden.add(step.place().asLong());
				return this.replan(agent, "place_blocked");
			}
			if (!already && NavBlocks.scaffoldCount(agent.getInventory()) == 0) {
				return this.replan(agent, "no_scaffold");
			}
		} else if (step.kind() == DigStep.Kind.DROP ? !dropSafe(level, step, agent.getHealth()) : !this.destSupported(level, step)) {
			return this.replan(agent, "floor_gone");
		}
		this.enter(Phase.BREAK);
		return this.breakBlocks(agent, step);
	}

	private Result breakBlocks(final AgentPlayer agent, final DigStep step) {
		ServerLevel level = agent.level();
		AgentControls controls = agent.controls();
		if (this.breaking != null && NavBlocks.isPassable(level, this.breaking, level.getBlockState(this.breaking))) {
			// Broken by last tick's held attack.
			this.broken++;
			NavBlocks.forgetScaffold(level, this.breaking);
			this.breaking = null;
		}
		BlockPos next = null;
		for (BlockPos b : step.breaks()) {
			if (!NavBlocks.isPassable(level, b, level.getBlockState(b))) {
				next = b;
				break;
			}
		}
		if (next == null) {
			controls.stopMining();
			this.breaking = null;
			this.enter(step.kind() == DigStep.Kind.PILLAR ? Phase.CENTER : step.kind() == DigStep.Kind.BRIDGE ? Phase.PLACE : Phase.MOVE);
			return Result.RUNNING;
		}
		if (!next.equals(this.breaking)) {
			BlockState s = level.getBlockState(next);
			if (!this.mayBreakNow(agent, next, s)) {
				this.forbidden.add(next.asLong());
				return this.replan(agent, "unsafe_break");
			}
			this.breaking = next;
			this.breakTicks = 0;
			this.miningTicks = 0;
		}
		Vec3 center = Vec3.atCenterOf(next);
		boolean underfoot = this.carries(agent, next);
		if (underfoot || agent.getEyePosition().distanceTo(center) > HAND_REACH) {
			// Standing on it (half over the edge) or drifted away: back to the middle of the step's cell first.
			controls.stopMining();
			if (++this.waitTicks > PLACE_TIMEOUT) {
				// Plan around it next time rather than wait here again.
				this.forbidden.add(next.asLong());
				return this.replan(agent, underfoot ? "underfoot" : "out_of_reach");
			}
			this.steer(agent, Vec3.atBottomCenterOf(step.from()), true);
			return Result.RUNNING;
		}
		this.waitTicks = 0;
		controls.stopMovement();
		BlockState state = level.getBlockState(next);
		int tool = AgentInventory.bestToolSlot(agent.getInventory(), state);
		if (tool >= 0) {
			AgentInventory.equip(agent, tool);
		}
		controls.lookAt(center);
		Direction face = Direction.getApproximateNearest(agent.getEyePosition().subtract(center));
		controls.holdAttack(next, face);
		int expected = NavBlocks.breakTicks(agent.getInventory(), state, level, next);
		if (next.equals(controls.miningPos())) {
			this.miningTicks++;
		}
		if (++this.breakTicks > Math.max(100, expected * 3)) {
			controls.stopMining();
			this.forbidden.add(next.asLong());
			return this.replan(agent, "break_timeout " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath() + " at "
				+ next.toShortString() + " (expected " + expected + " ticks, held " + this.miningTicks + " of " + this.breakTicks + ", ground "
				+ agent.onGround() + ", water " + agent.isInWater() + ", eye " + String.format(java.util.Locale.ROOT, "%.2f", agent.getEyePosition().distanceTo(center))
				+ ", hand " + agent.getMainHandItem().getItem() + ")");
		}
		return Result.RUNNING;
	}

	/** Pillar: stand in the middle of the cell first, so the jump lands on the new block. */
	private Result center(final AgentPlayer agent, final DigStep step) {
		Vec3 c = Vec3.atBottomCenterOf(step.from());
		if (horizontal(agent.position(), c) <= 0.2 && agent.onGround()) {
			agent.controls().stopMovement();
			this.enter(Phase.PLACE);
			return Result.RUNNING;
		}
		this.steer(agent, c, true);
		if (this.phaseTicks > PLACE_TIMEOUT) {
			return this.replan(agent, "cannot_center");
		}
		return Result.RUNNING;
	}

	private Result place(final AgentPlayer agent, final DigStep step) {
		ServerLevel level = agent.level();
		AgentControls controls = agent.controls();
		BlockPos at = step.place();
		if (at == null) {
			this.enter(Phase.MOVE);
			return Result.RUNNING;
		}
		if (NavBlocks.isFloor(level, at, level.getBlockState(at))) {
			controls.setJumping(false);
			controls.setSneaking(false);
			this.enter(Phase.MOVE);
			return Result.RUNNING;
		}
		if (this.phaseTicks > PLACE_TIMEOUT) {
			controls.setJumping(false);
			controls.setSneaking(false);
			// Something keeps the block out (a protection refusal, a body in the way): plan around this cell next time.
			this.forbidden.add(at.asLong());
			return this.replan(agent, "place_timeout");
		}
		if (step.kind() == DigStep.Kind.PILLAR) {
			controls.setForward(0.0F);
			controls.setStrafe(0.0F);
			controls.look(agent.getYRot(), 90.0F);
			// Jump, and place under the feet once they are above the block's top.
			controls.setJumping(agent.onGround());
			if (agent.getY() < at.getY() + 1.0) {
				return Result.RUNNING;
			}
		} else {
			// Bridge: crouch on the edge (sneaking never walks off it) and click the side of the block underfoot.
			controls.stopMovement();
			controls.setSneaking(true);
		}
		InteractionResult r = this.placeScaffold(agent, at);
		if (r == null) {
			controls.setJumping(false);
			controls.setSneaking(false);
			return this.replan(agent, "no_scaffold");
		}
		if (NavBlocks.isFloor(level, at, level.getBlockState(at))) {
			NavBlocks.noteScaffold(level, at);
			this.placed++;
			if (step.kind() == DigStep.Kind.PILLAR) {
				if (this.pillars.size() >= MAX_PILLARS_KEPT) {
					this.pillars.removeFirst();
				}
				this.pillars.add(at.immutable());
			}
			controls.setJumping(false);
			this.enter(Phase.MOVE);
		}
		return Result.RUNNING;
	}

	private Result move(final AgentPlayer agent, final DigStep step) {
		AgentControls controls = agent.controls();
		ServerLevel level = agent.level();
		this.doors.openIfClosed(agent, step.dest());
		Vec3 target = Vec3.atBottomCenterOf(step.dest());
		if (this.arrived(agent, step)) {
			this.index++;
			this.enter(Phase.START);
			DigStep next = this.index < this.path.steps().size() ? this.path.steps().get(this.index) : null;
			if (next == null || next.breaksOrPlaces() || next.kind() == DigStep.Kind.PILLAR || next.kind() == DigStep.Kind.CLIMB_UP
				|| next.kind() == DigStep.Kind.CLIMB_DOWN) {
				controls.stopMovement();
			}
			return next == null ? Result.DONE : Result.RUNNING;
		}
		if (this.phaseTicks > MOVE_TIMEOUT) {
			return this.replan(agent, "stuck");
		}
		// The way must still be open (a block placed or water flowing in since the plan).
		if (!NavBlocks.isPassable(level, step.dest(), level.getBlockState(step.dest())) && !NavBlocks.isWater(level.getBlockState(step.dest()))
			|| !NavBlocks.isPassable(level, step.dest().above(), level.getBlockState(step.dest().above()))) {
			return this.replan(agent, "blocked");
		}
		if (step.kind() == DigStep.Kind.DROP && agent.onGround() && agent.getY() > step.from().getY() - 0.5 && !dropSafe(level, step, agent.getHealth())) {
			// Still on the edge, and the landing went away while walking up to it.
			return this.replan(agent, "floor_gone");
		}
		switch (step.kind()) {
			case PILLAR -> {
				// Waiting to land on the block just placed.
				controls.setForward(0.0F);
				controls.setJumping(false);
				this.nudge(agent, target);
			}
			case CLIMB_UP -> {
				// Climb with the jump key; off the top, already lean toward where the next step goes.
				DigStep next = this.index + 1 < this.path.steps().size() ? this.path.steps().get(this.index + 1) : null;
				Vec3 aim = next != null && next.kind() != DigStep.Kind.CLIMB_UP ? Vec3.atBottomCenterOf(next.dest()) : target;
				this.steer(agent, aim, false);
				controls.setForward(horizontal(agent.position(), aim) > 0.15 ? 0.6F : 0.3F);
				controls.setJumping(true);
			}
			case CLIMB_DOWN -> {
				if (horizontal(agent.position(), target) > 0.25) {
					this.steer(agent, target, true);
				} else {
					controls.stopMovement();
				}
				controls.setJumping(false);
			}
			case SWIM -> {
				this.steer(agent, target, false);
				controls.setJumping(target.y >= agent.getY() - 0.3 || agent.horizontalCollision);
			}
			case ASCEND -> {
				this.steer(agent, target, false);
				double hd = horizontal(agent.position(), target);
				boolean below = agent.getY() < target.y - 0.2;
				controls.setJumping(below && (agent.onGround() || agent.isInWater()) && (hd < 1.4 || agent.horizontalCollision));
			}
			default -> {
				boolean last = this.index == this.path.steps().size() - 1;
				this.steer(agent, target, last);
				controls.setJumping(agent.isInWater() || agent.onGround() && agent.horizontalCollision && target.y >= agent.getY() - 0.1);
			}
		}
		return Result.RUNNING;
	}

	// ---------------------------------------------------------------- helpers

	private void enter(final Phase phase) {
		this.phase = phase;
		this.phaseTicks = 0;
		this.waitTicks = 0;
	}

	private Result replan(final AgentPlayer agent, final String why) {
		AgentControls controls = agent.controls();
		controls.stopMining();
		controls.stopMovement();
		this.replanReason = why;
		this.path = null;
		return Result.REPLAN;
	}

	private boolean arrived(final AgentPlayer agent, final DigStep step) {
		Vec3 c = Vec3.atBottomCenterOf(step.dest());
		double hd = horizontal(agent.position(), c);
		double dy = agent.getY() - c.y;
		boolean last = this.index == this.path.steps().size() - 1;
		DigStep next = last ? null : this.path.steps().get(this.index + 1);
		boolean through = next != null && !next.breaksOrPlaces() && (next.kind() == DigStep.Kind.WALK || next.kind() == DigStep.Kind.DIAGONAL
			|| next.kind() == DigStep.Kind.SWIM || next.kind() == DigStep.Kind.DROP || next.kind() == DigStep.Kind.ASCEND);
		double tol = through ? PASS_THROUGH : ARRIVE;
		return switch (step.kind()) {
			// The last swim ends in its own cell (the goal is checked by cell): 0.6 off is the next cell over.
			case SWIM -> hd <= (last ? ARRIVE : Math.max(tol, 0.6)) && Math.abs(dy) < 1.2;
			case CLIMB_UP -> dy >= -0.05 && hd <= 0.6;
			case CLIMB_DOWN -> dy <= 0.2 && hd <= 0.6;
			case PILLAR -> agent.onGround() && dy >= -0.05 && dy < 0.6;
			case DROP -> hd <= tol && (agent.onGround() || agent.isInWater()) && Math.abs(dy) < 0.6;
			default -> hd <= tol && Math.abs(dy) < 0.6 && (agent.onGround() || agent.isInWater() || through);
		};
	}

	/** Walks toward {@code target}: look, forward, slower (and crouched, never off an edge) on the last bit if asked. */
	private void steer(final AgentPlayer agent, final Vec3 target, final boolean careful) {
		AgentControls controls = agent.controls();
		double hd = horizontal(agent.position(), target);
		controls.look(controls.yawTo(target), agent.isInWater() ? -10.0F : 10.0F);
		controls.setStrafe(0.0F);
		controls.setSprinting(false);
		boolean crouch = careful && hd < 1.0 && agent.onGround();
		if (crouch != agent.isShiftKeyDown()) {
			controls.setSneaking(crouch);
		}
		controls.setForward(hd > 0.05 ? (careful && hd < 0.5 ? 0.5F : 1.0F) : 0.0F);
	}

	/** Small corrections toward the cell centre while airborne on a pillar jump. */
	private void nudge(final AgentPlayer agent, final Vec3 target) {
		double hd = horizontal(agent.position(), target);
		if (hd > 0.25) {
			agent.controls().look(agent.controls().yawTo(target), 60.0F);
			agent.controls().setForward(0.3F);
		}
	}

	private boolean offPath(final AgentPlayer agent, final DigStep step) {
		Vec3 p = agent.position();
		Vec3 a = Vec3.atBottomCenterOf(step.from());
		Vec3 b = Vec3.atBottomCenterOf(step.dest());
		if (step.kind() == DigStep.Kind.DROP) {
			// Falling (up to 16 blocks into water): far from both ends on the way down, not off the path.
			return horizontal(p, a) > 3.0 && horizontal(p, b) > 3.0;
		}
		return p.distanceTo(a) > 3.0 && p.distanceTo(b) > 3.0;
	}

	private boolean destSupported(final ServerLevel level, final DigStep step) {
		BlockPos d = step.dest();
		BlockState feet = level.getBlockState(d);
		if (NavBlocks.isWater(feet) || NavBlocks.isClimbable(feet)) {
			return true;
		}
		BlockPos below = d.below();
		BlockState floor = level.getBlockState(below);
		// The floor may itself be in the way right now only if this step breaks it (it never does).
		return NavBlocks.isFloor(level, below, floor) || step.kind() == DigStep.Kind.CLIMB_UP || step.kind() == DigStep.Kind.SWIM;
	}

	/**
	 * True if stepping off the edge for {@code step} (a drop) lands safely now: through free cells, in water or on a
	 * floor at most the safe fall below the edge (3 blocks, 2 at low health; landing higher than planned is fine), never
	 * on or through lava, fire, magma or anything else that hurts. The planner checked it; the world may have changed
	 * since (the landing mined away, lava flowed in).
	 */
	static boolean dropSafe(final ServerLevel level, final DigStep step, final float health) {
		BlockPos d = step.dest();
		int edge = step.from().getY();
		int maxFall = health <= DigPathPlanner.LOW_HEALTH ? 2 : 3;
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int y = edge - 1; y >= edge - MAX_DROP_SCAN && y > level.getMinY(); y--) {
			p.set(d.getX(), y, d.getZ());
			BlockState s = level.getBlockState(p);
			if (NavBlocks.isHazard(s)) {
				return false;
			}
			if (NavBlocks.isWater(s)) {
				return true;
			}
			if (!NavBlocks.isPassable(level, p, s)) {
				// Lands on top of this block.
				return NavBlocks.isFloor(level, p, s) && edge - (y + 1) <= maxFall;
			}
		}
		return false;
	}

	/** Policy and safety, now: natural, not protected, no fluid to let in, no gravel or sand on top. */
	private boolean mayBreakNow(final AgentPlayer agent, final BlockPos pos, final BlockState state) {
		ServerLevel level = agent.level();
		return NavBlocks.mayBreak(level, pos, state, agent.agentId()) && NavBlocks.safeToOpen(level, pos);
	}

	/**
	 * True if breaking {@code pos} now would pull the ground from under the agent (no digging straight down) or from
	 * under another body standing on it.
	 */
	private boolean carries(final AgentPlayer agent, final BlockPos pos) {
		double top = pos.getY() + 1.0;
		AABB bb = agent.getBoundingBox();
		if (top <= agent.getY() + 0.05 && top >= agent.getY() - 0.3 && bb.maxX > pos.getX() && bb.minX < pos.getX() + 1.0 && bb.maxZ > pos.getZ()
			&& bb.minZ < pos.getZ() + 1.0) {
			return true;
		}
		AABB above = new AABB(pos.above()).inflate(0.0, 0.5, 0.0);
		// Bodies only: an item or an arrow lying on the block just drops when it goes.
		for (Entity e : agent.level().getEntities(agent, above, e -> e.isAlive() && !e.isSpectator() && e instanceof net.minecraft.world.entity.LivingEntity)) {
			if (e.getBoundingBox().minY >= pos.getY() + 0.9 && e.getBoundingBox().minY <= pos.getY() + 1.2) {
				return true;
			}
		}
		return false;
	}

	/** One attempt to place scaffold at {@code at}, sneaking, against a solid neighbour. Null when there is none to place. */
	private @Nullable InteractionResult placeScaffold(final AgentPlayer agent, final BlockPos at) {
		Inventory inv = agent.getInventory();
		if (!NavBlocks.isScaffoldItem(agent.getMainHandItem())) {
			int slot = -1;
			for (int i = 0; i < Inventory.INVENTORY_SIZE; i++) {
				if (NavBlocks.isScaffoldItem(inv.getItem(i))) {
					slot = i;
					break;
				}
			}
			if (slot < 0) {
				return null;
			}
			AgentInventory.equip(agent, slot);
			if (!NavBlocks.isScaffoldItem(agent.getMainHandItem())) {
				return null;
			}
		}
		ServerLevel level = agent.level();
		if (agent.getBoundingBox().intersects(new AABB(at))) {
			return InteractionResult.PASS;
		}
		for (Direction d : PLACE_ORDER) {
			BlockPos against = at.relative(d);
			BlockState s = level.getBlockState(against);
			if (s.canBeReplaced() || s.getCollisionShape(level, against).isEmpty()) {
				continue;
			}
			Direction face = d.getOpposite();
			Vec3 hit = Vec3.atCenterOf(against).add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
			AgentControls controls = agent.controls();
			controls.lookAt(hit);
			boolean wasSneaking = agent.isShiftKeyDown();
			controls.setSneaking(true);
			InteractionResult r = controls.useBlock(against, face);
			controls.setSneaking(wasSneaking);
			return r;
		}
		return InteractionResult.FAIL;
	}

	private static final Direction[] PLACE_ORDER = {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST};

	static double horizontal(final Vec3 a, final Vec3 b) {
		double dx = a.x - b.x;
		double dz = a.z - b.z;
		return Math.sqrt(dx * dx + dz * dz);
	}
}
