package dev.minevibe.agent.nav;

import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ShortOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import it.unimi.dsi.fastutil.longs.LongSet;
import it.unimi.dsi.fastutil.objects.Reference2IntOpenHashMap;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Tier-2 navigation (PLAN 7.2): an incremental A* over the block grid whose moves may break natural blocks and build
 * with scaffold, after mineflayer-pathfinder's and Baritone's cost model (ticks of game time).
 *
 * <p>Nodes are feet cells. Moves: walk (and through wooden doors), diagonal walk, step up, a staircase step down
 * through dug blocks, drop (3 blocks, 2 at low health, deeper into water), swim, climb ladders and vines, pillar up
 * (jump and place a block under the feet) and bridge (place a block under the next cell). Breaking costs the time the
 * best tool in the inventory takes; leaves are cheap. What may be broken is {@link NavBlocks#mayBreak}; never the
 * block under the feet (no digging straight down), never a block next to water or lava, never one with sand or gravel
 * on top.
 *
 * <p>The search is incremental: {@link #step} expands nodes until its time budget for the tick is spent
 * ({@link #TICK_BUDGET_NANOS}, 1.5 ms) and goes on next tick. It ends {@link State#FOUND} or {@link State#FAILED}
 * ({@code no_path}: nothing left to try within {@link #RADIUS} blocks and {@link #MAX_NODES} nodes; {@code too_far}:
 * the goal lies outside the radius).
 */
public final class DigPathPlanner {
	public enum State {
		SEARCHING,
		FOUND,
		FAILED
	}

	/**
	 * Search limits and abilities. {@code agentId} is whose consents count when a block is protected (null: no
	 * agent's, as perception sees it).
	 */
	public record Config(int maxNodes, int radius, int maxDrop, int scaffold, int maxPillar, boolean dig, boolean build, @Nullable String agentId) {
		/** The defaults for {@code agentHealth} and {@code scaffold} blocks in the inventory. */
		public static Config standard(final float agentHealth, final int scaffold) {
			int drop = agentHealth <= LOW_HEALTH ? 2 : 3;
			return new Config(MAX_NODES, RADIUS, drop, scaffold, drop, true, true, null);
		}

		public Config withAgent(final @Nullable String id) {
			return new Config(this.maxNodes, this.radius, this.maxDrop, this.scaffold, this.maxPillar, this.dig, this.build, id);
		}
	}

	// Costs in ticks (20 per second).
	/** One block at walking speed (4.317 blocks/s). */
	public static final double WALK = 20.0 / 4.317;
	static final double JUMP = 2.0;
	static final double SWIM = 9.0;
	static final double SUBMERGED = 12.0;
	static final double CLIMB_UP = 8.5;
	static final double CLIMB_DOWN = 6.0;
	static final double DOOR = 4.0;
	/** Aiming and switching tools, on top of the break time; also a nudge toward routes that leave the world alone. */
	static final double BREAK_OVERHEAD = 8.0;
	static final double PILLAR = 12.0;
	static final double BRIDGE = 10.0;
	/** Scaffold is spent: keep it for when it pays. */
	static final double SCAFFOLD = 8.0;
	static final double NEAR_LAVA = 40.0;
	/** Weighted A*: a little greed keeps searches short. */
	static final double GREED = 1.25;

	public static final int MAX_NODES = 20_000;
	public static final int RADIUS = 96;
	public static final long TICK_BUDGET_NANOS = 1_500_000L;
	/** Health at or below which drops are limited to 2 blocks. */
	public static final float LOW_HEALTH = 6.0F;
	private static final int MAX_WATER_DROP = 16;
	private static final int MAX_DY = 64;

	// Cell bits.
	private static final short KNOWN = 0x100;
	private static final short PASS = 0x01;
	private static final short FLOOR = 0x02;
	private static final short WATER = 0x04;
	private static final short CLIMB = 0x08;
	private static final short BREAK = 0x10;
	private static final short HAZARD = 0x20;
	private static final short DOOR_CELL = 0x40;
	private static final short UNLOADED = 0x80;
	/** Empty, or a replaceable plant or snow layer nobody placed: scaffold may go here. */
	private static final short PLACE = 0x200;
	private static final double INF = Double.POSITIVE_INFINITY;

	private final NavView view;
	private final ServerLevel level;
	private final Inventory inventory;
	private final DigGoal goal;
	private final Config config;
	private final int sx;
	private final int sy;
	private final int sz;
	private final Int2ObjectOpenHashMap<Node> nodes = new Int2ObjectOpenHashMap<>();
	private final Heap open = new Heap();
	private final Long2ShortOpenHashMap cells = new Long2ShortOpenHashMap();
	private final Reference2IntOpenHashMap<BlockState> breakTicks = new Reference2IntOpenHashMap<>();
	private final LongSet forbidden;
	private final Node start;
	private final BlockPos.MutableBlockPos scratch = new BlockPos.MutableBlockPos();

	private State state = State.SEARCHING;
	private String failure = "";
	private @Nullable DigPath path;
	private int expanded;
	private int ticks;
	private long nanos;
	private long maxTickNanos;
	private long lastStepNanos;

	/**
	 * A search from feet cell {@code from} to {@code goal}. {@code forbidden} lists cells never to break or to place
	 * scaffold in (the executor found them unsafe, or a placement there failed).
	 */
	public DigPathPlanner(final ServerLevel level, final Inventory inventory, final BlockPos from, final DigGoal goal, final Config config,
		final LongSet forbidden) {
		this.level = level;
		this.view = new NavView(level);
		this.inventory = inventory;
		this.goal = goal;
		this.config = config;
		this.forbidden = forbidden;
		this.sx = from.getX();
		this.sy = from.getY();
		this.sz = from.getZ();
		this.cells.defaultReturnValue((short)0);
		this.breakTicks.defaultReturnValue(-1);
		this.start = this.node(this.sx, this.sy, this.sz, false);
		this.start.g = 0.0;
		this.start.f = GREED * goal.heuristic(this.sx, this.sy, this.sz);
		this.start.startNode = true;
		BlockPos anchor = goal.anchor();
		double hx = anchor.getX() - this.sx;
		double hz = anchor.getZ() - this.sz;
		if (hx * hx + hz * hz > (double)(config.radius() + 4) * (config.radius() + 4) || Math.abs(anchor.getY() - this.sy) > MAX_DY) {
			this.state = State.FAILED;
			this.failure = "too_far";
		} else {
			this.open.insert(this.start);
		}
	}

	public State state() {
		return this.state;
	}

	public String failure() {
		return this.failure;
	}

	public @Nullable DigPath path() {
		return this.path;
	}

	public DigGoal goal() {
		return this.goal;
	}

	/** Nodes expanded so far. */
	public int expanded() {
		return this.expanded;
	}

	/** Ticks the search has run in. */
	public int ticks() {
		return this.ticks;
	}

	public long nanos() {
		return this.nanos;
	}

	/** The longest time one {@link #step} took. */
	public long maxTickNanos() {
		return this.maxTickNanos;
	}

	/** The time the last {@link #step} took. */
	public long lastStepNanos() {
		return this.lastStepNanos;
	}

	/** Runs the search for at most {@code budgetNanos} (one tick's share). */
	public State step(final long budgetNanos) {
		if (this.state != State.SEARCHING) {
			return this.state;
		}
		long t0 = System.nanoTime();
		long deadline = t0 + budgetNanos;
		this.ticks++;
		long last = t0;
		long slowest = 0L;
		while (this.state == State.SEARCHING) {
			if (this.open.isEmpty()) {
				this.state = State.FAILED;
				this.failure = "no_path";
				break;
			}
			if (this.expanded >= this.config.maxNodes()) {
				this.state = State.FAILED;
				this.failure = "no_path";
				break;
			}
			Node n = this.open.pop();
			n.closed = true;
			if (this.goal.satisfied(this.view, n.x, n.y, n.z)) {
				this.path = this.build(n);
				this.state = State.FOUND;
				break;
			}
			this.expanded++;
			this.expand(n);
			// Stop when the slowest expansion of this tick would no longer fit: the budget is a ceiling, not a target.
			long now = System.nanoTime();
			slowest = Math.max(slowest, now - last);
			last = now;
			if (now + slowest >= deadline) {
				break;
			}
		}
		long dt = System.nanoTime() - t0;
		this.nanos += dt;
		this.maxTickNanos = Math.max(this.maxTickNanos, dt);
		this.lastStepNanos = dt;
		return this.state;
	}

	/** Runs the search to the end within one call (tests and benchmarks). */
	public State runToEnd() {
		while (this.step(Long.MAX_VALUE / 4) == State.SEARCHING) {
			// keep going
		}
		return this.state;
	}

	// ---------------------------------------------------------------- expansion

	private void expand(final Node n) {
		int x = n.x;
		int y = n.y;
		int z = n.z;
		short here = this.cell(x, y, z);
		boolean inWater = (here & WATER) != 0;
		boolean onClimb = (here & CLIMB) != 0;
		boolean grounded = n.placedFloor || (this.cell(x, y - 1, z) & FLOOR) != 0 || n.startNode && !inWater && !onClimb;
		boolean canAct = grounded || inWater || onClimb;
		if (!canAct) {
			return;
		}
		for (int dir = 0; dir < 4; dir++) {
			int dx = DX[dir];
			int dz = DZ[dir];
			int tx = x + dx;
			int tz = z + dz;
			if (!this.inRadius(tx, tz)) {
				continue;
			}
			// Sideways at the same height: walk / swim, or off an edge (drop), or onto a block placed there (bridge).
			double body = this.bodyCost(tx, y, tz);
			if (body < INF) {
				short dest = this.cell(tx, y, tz);
				if (this.supported(tx, y, tz)) {
					double c = (dest & WATER) == 0 ? WALK : (this.cell(tx, y + 1, tz) & WATER) != 0 ? SWIM + SUBMERGED : SWIM;
					if ((dest & DOOR_CELL) != 0 || (this.cell(tx, y + 1, tz) & DOOR_CELL) != 0) {
						c += DOOR;
					}
					this.offer(n, tx, y, tz, false, 0, n.scaffoldUsed, c + body + this.danger(tx, y, tz), (dest & WATER) != 0 ? DigStep.Kind.SWIM : DigStep.Kind.WALK,
						body > 0 ? this.breaksOf(tx, y + 1, tz, tx, y, tz) : List.of(), null);
				} else if (!inWater || grounded) {
					this.offerDrop(n, tx, y, tz, body);
					if (this.config.build() && grounded && !inWater && n.scaffoldUsed < this.config.scaffold() && this.placeable(tx, y - 1, tz)
						&& !this.lavaBelow(tx, y - 2, tz)) {
						// A bridge keeps the height a pillar built: pillars never climb past the drop limit.
						this.offer(n, tx, y, tz, true, n.pillar, n.scaffoldUsed + 1, WALK + BRIDGE + SCAFFOLD + body + this.danger(tx, y, tz), DigStep.Kind.BRIDGE,
							body > 0 ? this.breaksOf(tx, y + 1, tz, tx, y, tz) : List.of(), new BlockPos(tx, y - 1, tz));
					}
				}
			}
			// One up: jump onto the next block.
			if (y + 2 <= this.level.getMaxY() && Math.abs(y + 1 - this.sy) <= MAX_DY && (grounded || inWater || onClimb)) {
				double head = this.cellCost(x, y + 2, z);
				short floor = this.cell(tx, y, tz);
				if (head < INF && (floor & FLOOR) != 0) {
					double body2 = this.bodyCost(tx, y + 1, tz);
					if (body2 < INF) {
						List<BlockPos> breaks = head + body2 > 0 ? this.breaksOf(x, y + 2, z, tx, y + 2, tz, tx, y + 1, tz) : List.of();
						this.offer(n, tx, y + 1, tz, false, 0, n.scaffoldUsed, WALK + JUMP + head + body2 + this.danger(tx, y + 1, tz), DigStep.Kind.ASCEND, breaks, null);
					}
				}
			}
			// One down through blocks to dig out (a staircase, never straight down).
			if (this.config.dig() && grounded && !inWater && y - 2 > this.level.getMinY()) {
				if ((this.cell(tx, y - 2, tz) & FLOOR) != 0) {
					double a = this.cellCost(tx, y + 1, tz);
					double b = this.cellCost(tx, y, tz);
					double c = this.cellCost(tx, y - 1, tz);
					double sum = a + b + c;
					if (sum < INF && sum > 0) {
						this.offer(n, tx, y - 1, tz, false, 0, n.scaffoldUsed, WALK + 1.5 + sum + this.danger(tx, y - 1, tz), DigStep.Kind.DESCEND,
							this.breaksOf(tx, y + 1, tz, tx, y, tz, tx, y - 1, tz), null);
					}
				}
			}
		}
		// Diagonals: open ground only.
		if (grounded || inWater) {
			for (int dir = 0; dir < 4; dir++) {
				int dx = DX[dir];
				int dz = DZ[dir];
				int ex = DX[(dir + 1) & 3];
				int ez = DZ[(dir + 1) & 3];
				int tx = x + dx + ex;
				int tz = z + dz + ez;
				if (!this.inRadius(tx, tz)) {
					continue;
				}
				if (this.open(x + dx, y, z + dz) && this.open(x + ex, y, z + ez) && this.open(tx, y, tz) && this.supported(tx, y, tz)) {
					boolean water = (this.cell(tx, y, tz) & WATER) != 0;
					if (water != inWater) {
						continue;
					}
					this.offer(n, tx, y, tz, false, 0, n.scaffoldUsed, (water ? SWIM : WALK) * Mth.SQRT_OF_TWO + this.danger(tx, y, tz),
						water ? DigStep.Kind.SWIM : DigStep.Kind.DIAGONAL, List.of(), null);
				}
			}
		}
		// Pillar: jump and place a block under the feet.
		if (this.config.build() && grounded && !inWater && !onClimb && n.scaffoldUsed < this.config.scaffold() && n.pillar < this.config.maxPillar()
			&& y + 2 <= this.level.getMaxY() && Math.abs(y + 1 - this.sy) <= MAX_DY && this.placeable(x, y, z)) {
			double head = this.cellCost(x, y + 2, z);
			if (head < INF) {
				this.offer(n, x, y + 1, z, true, n.pillar + 1, n.scaffoldUsed + 1, PILLAR + SCAFFOLD + head, DigStep.Kind.PILLAR,
					head > 0 ? this.breaksOf(x, y + 2, z) : List.of(), new BlockPos(x, y, z));
			}
		}
		// Ladders and vines.
		short above = this.cell(x, y + 1, z);
		if ((onClimb || grounded) && (above & CLIMB) != 0 && (this.cell(x, y + 2, z) & PASS) != 0) {
			this.offer(n, x, y + 1, z, false, 0, n.scaffoldUsed, CLIMB_UP, DigStep.Kind.CLIMB_UP, List.of(), null);
		}
		if (onClimb && (above & PASS) != 0 && (this.cell(x, y + 2, z) & PASS) != 0 && (above & CLIMB) == 0) {
			// Off the top of a ladder: the cell above is free, the next move steps onto the ground beside it.
			this.offer(n, x, y + 1, z, false, 0, n.scaffoldUsed, CLIMB_UP, DigStep.Kind.CLIMB_UP, List.of(), null);
		}
		if ((onClimb || grounded) && (this.cell(x, y - 1, z) & CLIMB) != 0) {
			this.offer(n, x, y - 1, z, false, 0, n.scaffoldUsed, CLIMB_DOWN, DigStep.Kind.CLIMB_DOWN, List.of(), null);
		}
		// Swimming up and down.
		if (inWater) {
			if ((above & WATER) != 0) {
				this.offer(n, x, y + 1, z, false, 0, n.scaffoldUsed, SWIM, DigStep.Kind.SWIM, List.of(), null);
			}
			if ((this.cell(x, y - 1, z) & WATER) != 0) {
				this.offer(n, x, y - 1, z, false, 0, n.scaffoldUsed, SWIM + SUBMERGED, DigStep.Kind.SWIM, List.of(), null);
			}
		}
	}

	/** Off the edge into (tx, y, tz): falls until it lands; allowed up to the drop limit, or deeper into water. */
	private void offerDrop(final Node n, final int tx, final int y, final int tz, final double body) {
		for (int k = 1; k <= MAX_WATER_DROP; k++) {
			int ly = y - k;
			if (ly <= this.level.getMinY() || Math.abs(ly - this.sy) > MAX_DY) {
				return;
			}
			short c = this.cell(tx, ly, tz);
			if ((c & (UNLOADED | HAZARD)) != 0) {
				return;
			}
			if ((c & WATER) != 0) {
				this.offer(n, tx, ly, tz, false, 0, n.scaffoldUsed, WALK + 2.0 + k * 0.5 + body, DigStep.Kind.DROP,
					body > 0 ? this.breaksOf(tx, y + 1, tz, tx, y, tz) : List.of(), null);
				return;
			}
			if ((c & PASS) == 0) {
				return;
			}
			if ((this.cell(tx, ly - 1, tz) & FLOOR) != 0) {
				if (k > this.config.maxDrop()) {
					return;
				}
				double fall = 1.5 + k + (k >= 3 ? 6.0 : 0.0);
				this.offer(n, tx, ly, tz, false, 0, n.scaffoldUsed, WALK + fall + body + this.danger(tx, ly, tz), DigStep.Kind.DROP,
					body > 0 ? this.breaksOf(tx, y + 1, tz, tx, y, tz) : List.of(), null);
				return;
			}
		}
	}

	private void offer(final Node from, final int x, final int y, final int z, final boolean placedFloor, final int pillar, final int scaffoldUsed,
		final double cost, final DigStep.Kind kind, final List<BlockPos> breaks, final @Nullable BlockPos place) {
		if (cost >= INF || y <= this.level.getMinY() || y >= this.level.getMaxY()) {
			return;
		}
		double g = from.g + cost;
		Node to = this.node(x, y, z, placedFloor);
		if (to.closed || g >= to.g) {
			return;
		}
		to.g = g;
		to.f = g + GREED * this.goal.heuristic(x, y, z);
		to.parent = from;
		to.pillar = pillar;
		to.scaffoldUsed = scaffoldUsed;
		to.via = new DigStep(kind, new BlockPos(from.x, from.y, from.z), new BlockPos(x, y, z), breaks, place);
		if (to.heapIndex >= 0) {
			this.open.update(to);
		} else {
			this.open.insert(to);
		}
	}

	// ---------------------------------------------------------------- cells

	/** Cost to make the cell passable: 0 if it is, the break time if it may be broken, else infinite. */
	private double cellCost(final int x, final int y, final int z) {
		short c = this.cell(x, y, z);
		if ((c & PASS) != 0) {
			return 0.0;
		}
		if ((c & BREAK) != 0 && this.config.dig()) {
			return this.breakTicks(x, y, z) + BREAK_OVERHEAD;
		}
		return INF;
	}

	/** Cost to clear a body's two cells at feet (x, y, z). */
	private double bodyCost(final int x, final int y, final int z) {
		double feet = this.cellCost(x, y, z);
		if (feet >= INF) {
			return INF;
		}
		return feet + this.cellCost(x, y + 1, z);
	}

	/** Passable without breaking, at both body cells. */
	private boolean open(final int x, final int y, final int z) {
		return (this.cell(x, y, z) & PASS) != 0 && (this.cell(x, y + 1, z) & PASS) != 0 && (this.cell(x, y, z) & DOOR_CELL) == 0;
	}

	/** A body with its feet here does not fall: a floor under it, or water, or a ladder. */
	private boolean supported(final int x, final int y, final int z) {
		short c = this.cell(x, y, z);
		return (c & (WATER | CLIMB)) != 0 || (this.cell(x, y - 1, z) & FLOOR) != 0;
	}

	/**
	 * A cell a scaffold block may go into: empty or a replaceable plant nobody placed (not a torch, rail, sign or carpet:
	 * a block there fails to place, and a plan that places there again would only fail again), no fluid, not a ladder or
	 * door, not a cell a placement already failed in, not part of the office or a protected zone.
	 */
	private boolean placeable(final int x, final int y, final int z) {
		short c = this.cell(x, y, z);
		return (c & (PASS | PLACE)) == (PASS | PLACE) && (c & (WATER | CLIMB | DOOR_CELL | HAZARD | UNLOADED)) == 0 && !this.isProtected(x, y, z);
	}

	private boolean lavaBelow(final int x, final int y, final int z) {
		for (int i = 0; i < 4; i++) {
			short c = this.cell(x, y - i, z);
			if ((c & HAZARD) != 0) {
				return true;
			}
			if ((c & PASS) == 0) {
				return false;
			}
		}
		return false;
	}

	/** Extra cost for feet cells beside lava or fire. */
	private double danger(final int x, final int y, final int z) {
		for (int dir = 0; dir < 4; dir++) {
			if ((this.cell(x + DX[dir], y, z + DZ[dir]) & HAZARD) != 0 || (this.cell(x + DX[dir], y + 1, z + DZ[dir]) & HAZARD) != 0) {
				return NEAR_LAVA;
			}
		}
		return 0.0;
	}

	private boolean inRadius(final int x, final int z) {
		long dx = x - this.sx;
		long dz = z - this.sz;
		return dx * dx + dz * dz <= (long)this.config.radius() * this.config.radius();
	}

	/** No scaffold goes into the office, nor into a protected zone such as the Base (its rooms and doorways). */
	private boolean isProtected(final int x, final int y, final int z) {
		this.scratch.set(x, y, z);
		return dev.minevibe.org.office.OfficeService.protects(this.level, this.scratch)
			|| dev.minevibe.world.provenance.Protection.checkZoneCell(this.level, this.scratch, this.config.agentId()) != null;
	}

	private short cell(final int x, final int y, final int z) {
		long key = BlockPos.asLong(x, y, z);
		short c = this.cells.get(key);
		if (c != 0) {
			return c;
		}
		c = this.classify(x, y, z);
		this.cells.put(key, c);
		return c;
	}

	private short classify(final int x, final int y, final int z) {
		if (y < this.level.getMinY() || !this.view.loaded(x, z)) {
			return (short)(KNOWN | UNLOADED);
		}
		BlockPos pos = new BlockPos(x, y, z);
		BlockState state = this.view.state(x, y, z);
		short c = KNOWN;
		if (NavBlocks.isHazard(state)) {
			return (short)(c | HAZARD);
		}
		if (NavBlocks.isPassable(this.view, pos, state)) {
			c |= PASS;
			if (NavBlocks.isWater(state)) {
				c |= WATER;
			}
			if (NavBlocks.isClimbable(state)) {
				c |= CLIMB;
			}
			if (NavBlocks.isOpenableDoor(state)) {
				c |= DOOR_CELL;
			}
			if ((state.isAir() || state.canBeReplaced() && dev.minevibe.world.provenance.Provenance.ownerAt(this.level, pos) == null)
				&& !this.forbidden.contains(pos.asLong())) {
				c |= PLACE;
			}
		} else if (!this.forbidden.contains(pos.asLong()) && NavBlocks.mayBreak(this.level, pos, state, this.config.agentId())
			&& NavBlocks.safeToOpen(this.view, pos)
			&& this.breakTicks(state, pos) <= NavBlocks.MAX_BREAK_TICKS) {
			c |= BREAK;
		}
		if (NavBlocks.isFloor(this.view, pos, state)) {
			c |= FLOOR;
		}
		return c;
	}

	private int breakTicks(final int x, final int y, final int z) {
		BlockPos pos = new BlockPos(x, y, z);
		return this.breakTicks(this.view.state(x, y, z), pos);
	}

	private int breakTicks(final BlockState state, final BlockPos pos) {
		int t = this.breakTicks.getInt(state);
		if (t < 0) {
			t = NavBlocks.breakTicks(this.inventory, state, this.view, pos);
			this.breakTicks.put(state, t);
		}
		return t;
	}

	private List<BlockPos> breaksOf(final int... xyz) {
		List<BlockPos> out = new ArrayList<>(xyz.length / 3);
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			if ((this.cell(xyz[i], xyz[i + 1], xyz[i + 2]) & PASS) == 0) {
				out.add(new BlockPos(xyz[i], xyz[i + 1], xyz[i + 2]));
			}
		}
		return out;
	}

	// ---------------------------------------------------------------- nodes

	private Node node(final int x, final int y, final int z, final boolean placedFloor) {
		int key = ((x - this.sx + 256) & 511) | ((z - this.sz + 256) & 511) << 9 | ((y + 2048) & 4095) << 18 | (placedFloor ? 1 << 30 : 0);
		Node n = this.nodes.get(key);
		if (n == null) {
			n = new Node(x, y, z, placedFloor);
			this.nodes.put(key, n);
		}
		return n;
	}

	private DigPath build(final Node end) {
		List<DigStep> steps = new ArrayList<>();
		double cost = end.g;
		for (Node n = end; n.parent != null; n = n.parent) {
			steps.add(n.via);
		}
		Collections.reverse(steps);
		return new DigPath(steps, cost, this.expanded, this.nanos, this.ticks);
	}

	private static final int[] DX = {0, 1, 0, -1};
	private static final int[] DZ = {-1, 0, 1, 0};

	static final class Node {
		final int x;
		final int y;
		final int z;
		final boolean placedFloor;
		boolean startNode;
		int pillar;
		int scaffoldUsed;
		double g = INF;
		double f;
		@Nullable Node parent;
		@Nullable DigStep via;
		int heapIndex = -1;
		boolean closed;

		Node(final int x, final int y, final int z, final boolean placedFloor) {
			this.x = x;
			this.y = y;
			this.z = z;
			this.placedFloor = placedFloor;
		}
	}

	/** A binary min-heap on {@code f} with decrease-key. */
	static final class Heap {
		private Node[] items = new Node[256];
		private int size;

		boolean isEmpty() {
			return this.size == 0;
		}

		void insert(final Node n) {
			if (this.size == this.items.length) {
				this.items = java.util.Arrays.copyOf(this.items, this.size * 2);
			}
			this.items[this.size] = n;
			n.heapIndex = this.size;
			this.size++;
			this.up(n.heapIndex);
		}

		Node pop() {
			Node top = this.items[0];
			this.size--;
			if (this.size > 0) {
				this.items[0] = this.items[this.size];
				this.items[0].heapIndex = 0;
				this.down(0);
			}
			this.items[this.size] = null;
			top.heapIndex = -1;
			return top;
		}

		void update(final Node n) {
			this.up(n.heapIndex);
		}

		private void up(int i) {
			Node n = this.items[i];
			while (i > 0) {
				int p = (i - 1) >> 1;
				Node parent = this.items[p];
				if (parent.f <= n.f) {
					break;
				}
				this.items[i] = parent;
				parent.heapIndex = i;
				i = p;
			}
			this.items[i] = n;
			n.heapIndex = i;
		}

		private void down(int i) {
			Node n = this.items[i];
			while (true) {
				int l = 2 * i + 1;
				if (l >= this.size) {
					break;
				}
				int r = l + 1;
				int c = r < this.size && this.items[r].f < this.items[l].f ? r : l;
				if (this.items[c].f >= n.f) {
					break;
				}
				this.items[i] = this.items[c];
				this.items[i].heapIndex = i;
				i = c;
			}
			this.items[i] = n;
			n.heapIndex = i;
		}
	}
}
