package dev.minevibe.agent.nav;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.phys.Vec3;

/**
 * Where a Tier-2 search ({@link DigPathPlanner}) may end. A goal is tested on a feet cell: the block the agent's feet
 * are in while it stands there.
 *
 * <ul>
 *   <li>{@link #near}: within a radius of a point (what {@code moveTo} asks for).</li>
 *   <li>{@link #block}: "reach a block to mine or use": the block's centre within hand reach of the eyes, with one face
 *       open toward them. Standing beside it, on top of the next block, or under it all count; standing on it never
 *       does (no digging straight down), nor standing in it.</li>
 *   <li>{@link #trunk}: "reach a tree trunk": any standable cell next to any log of the trunk, at any height a pillar
 *       can reach.</li>
 * </ul>
 */
public abstract class DigGoal {
	/** Eye height of a standing player. */
	static final double EYE = 1.62;

	DigGoal() {
	}

	/** True if standing with the feet in cell (x, y, z) fulfils the goal. {@code level} answers block questions. */
	public abstract boolean satisfied(BlockGetter level, int x, int y, int z);

	/** An estimate of the cost (ticks) from feet cell (x, y, z) to the goal. */
	public abstract double heuristic(int x, int y, int z);

	/** A representative point of the goal, for the search radius and the logs. */
	public abstract BlockPos anchor();

	public abstract String describe();

	/** {@code near}, {@code pickup}, {@code block} or {@code trunk} (the {@code kind} of a {@code nav.failed} event). */
	public abstract String kind();

	@Override
	public String toString() {
		return this.describe();
	}

	/** True if the agent standing at {@code feet} now fulfils the goal. */
	public boolean satisfiedAt(final ServerLevel level, final BlockPos feet) {
		return this.satisfied(level, feet.getX(), feet.getY(), feet.getZ());
	}

	// ---------------------------------------------------------------- factories

	/** Within {@code reach} blocks of {@code point} horizontally, and at most 1.5 above or below it. */
	public static DigGoal near(final Vec3 point, final double reach) {
		return new Near(point, reach);
	}

	/**
	 * Close enough to pick up an item lying at {@code item}: a player picks up what touches its box grown by 1 block
	 * sideways and 0.5 up and down, so within about a block sideways and from half a block under the feet to two above.
	 */
	public static DigGoal pickup(final Vec3 item) {
		return new Pickup(item);
	}

	/** In hand reach ({@code reach}, eye to centre) of {@code block}, with a face of it open toward the eyes. */
	public static DigGoal block(final BlockPos block, final double reach) {
		return new Block(block.immutable(), reach);
	}

	/** Next to the trunk that {@code log} belongs to (all its logs, from the bottom of its column(s) to the top). */
	public static DigGoal trunk(final BlockGetter level, final BlockPos log) {
		return new Trunk(trunkOf(level, log));
	}

	static double flatCost(final double dx, final double dz) {
		double ax = Math.abs(dx);
		double az = Math.abs(dz);
		double diag = Math.min(ax, az);
		// Octile distance in walking ticks.
		return DigPathPlanner.WALK * (Math.max(ax, az) - diag) + DigPathPlanner.WALK * Mth.SQRT_OF_TWO * diag;
	}

	// ---------------------------------------------------------------- near

	static final class Near extends DigGoal {
		private final Vec3 point;
		private final double reach;

		Near(final Vec3 point, final double reach) {
			this.point = point;
			// Cells are tested by their centres: any point is within 0.71 of its own cell's centre.
			this.reach = Math.max(0.75, reach);
		}

		@Override
		public boolean satisfied(final BlockGetter level, final int x, final int y, final int z) {
			double dx = x + 0.5 - this.point.x;
			double dz = z + 0.5 - this.point.z;
			return dx * dx + dz * dz <= this.reach * this.reach && Math.abs(y - this.point.y) <= 1.5;
		}

		@Override
		public double heuristic(final int x, final int y, final int z) {
			double dx = Math.max(0.0, Math.abs(x + 0.5 - this.point.x) - this.reach);
			double dz = Math.max(0.0, Math.abs(z + 0.5 - this.point.z) - this.reach);
			return flatCost(dx, dz) + Math.max(0.0, Math.abs(y - this.point.y) - 1.5) * 2.0;
		}

		@Override
		public BlockPos anchor() {
			return BlockPos.containing(this.point);
		}

		@Override
		public String describe() {
			return "near " + anchor().toShortString();
		}

		@Override
		public String kind() {
			return "near";
		}
	}

	// ---------------------------------------------------------------- pickup

	static final class Pickup extends DigGoal {
		private final Vec3 item;

		Pickup(final Vec3 item) {
			this.item = item;
		}

		/**
		 * The pickup box is the body's box grown by 1 (an axis-aligned box: 1.3 out from the middle on each axis, plus the
		 * item's own 0.125); a cell counts if the item is within 1.05 of its middle on both axes, which leaves room for
		 * standing up to 0.35 off the middle.
		 */
		@Override
		public boolean satisfied(final BlockGetter level, final int x, final int y, final int z) {
			double dx = Math.abs(x + 0.5 - this.item.x);
			double dz = Math.abs(z + 0.5 - this.item.z);
			double dy = this.item.y - y;
			return dx <= REACH && dz <= REACH && dy >= -0.6 && dy <= 2.1;
		}

		@Override
		public double heuristic(final int x, final int y, final int z) {
			double dx = Math.max(0.0, Math.abs(x + 0.5 - this.item.x) - REACH);
			double dz = Math.max(0.0, Math.abs(z + 0.5 - this.item.z) - REACH);
			double dy = this.item.y - y;
			return flatCost(dx, dz) + (dy > 2.1 ? dy - 2.1 : dy < -0.6 ? -0.6 - dy : 0.0) * 2.0;
		}

		private static final double REACH = 1.05;

		@Override
		public BlockPos anchor() {
			return BlockPos.containing(this.item);
		}

		@Override
		public String describe() {
			return "pickup " + this.anchor().toShortString();
		}

		@Override
		public String kind() {
			return "pickup";
		}
	}

	// ---------------------------------------------------------------- block

	static final class Block extends DigGoal {
		private final BlockPos target;
		private final double reach;

		Block(final BlockPos target, final double reach) {
			this.target = target;
			this.reach = reach;
		}

		public BlockPos target() {
			return this.target;
		}

		@Override
		public boolean satisfied(final BlockGetter level, final int x, final int y, final int z) {
			int tx = this.target.getX();
			int ty = this.target.getY();
			int tz = this.target.getZ();
			if (tx == x && tz == z && (ty == y || ty == y + 1 || ty == y - 1)) {
				// In the body, or the block under the feet (never dug straight down).
				return false;
			}
			double ex = x + 0.5;
			double ey = y + EYE;
			double ez = z + 0.5;
			double cx = tx + 0.5;
			double cy = ty + 0.5;
			double cz = tz + 0.5;
			double d2 = (ex - cx) * (ex - cx) + (ey - cy) * (ey - cy) + (ez - cz) * (ez - cz);
			if (d2 > this.reach * this.reach) {
				return false;
			}
			return openFaceToward(level, this.target, ex - cx, ey - cy, ez - cz, x, y, z);
		}

		@Override
		public double heuristic(final int x, final int y, final int z) {
			double dx = Math.max(0.0, Math.abs(x + 0.5 - (this.target.getX() + 0.5)) - 1.0);
			double dz = Math.max(0.0, Math.abs(z + 0.5 - (this.target.getZ() + 0.5)) - 1.0);
			double dy = Math.max(0.0, Math.abs(y + EYE - (this.target.getY() + 0.5)) - 2.5);
			return flatCost(dx, dz) + dy * 2.0;
		}

		@Override
		public BlockPos anchor() {
			return this.target;
		}

		@Override
		public String describe() {
			return "block " + this.target.toShortString();
		}

		@Override
		public String kind() {
			return "block";
		}
	}

	/**
	 * True if one face of {@code target} that looks toward the eye (offset {@code ox, oy, oz} from the block centre) opens
	 * into a cell a hand can reach through: not solid, or one of the cells the agent's body takes at feet (fx, fy, fz).
	 */
	static boolean openFaceToward(final BlockGetter level, final BlockPos target, final double ox, final double oy, final double oz,
		final int fx, final int fy, final int fz) {
		BlockPos.MutableBlockPos n = new BlockPos.MutableBlockPos();
		for (Direction d : Direction.values()) {
			double dot = d.getStepX() * ox + d.getStepY() * oy + d.getStepZ() * oz;
			if (dot <= 0.0) {
				continue;
			}
			n.setWithOffset(target, d);
			if (n.getX() == fx && n.getZ() == fz && (n.getY() == fy || n.getY() == fy + 1)) {
				return true;
			}
			var state = level.getBlockState(n);
			if (state.getCollisionShape(level, n).isEmpty() || state.is(BlockTags.LEAVES)) {
				return true;
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- trunk

	static final class Trunk extends DigGoal {
		private final List<BlockPos> logs;
		private final int minX;
		private final int maxX;
		private final int minZ;
		private final int maxZ;
		private final int minY;
		private final int maxY;

		Trunk(final List<BlockPos> logs) {
			this.logs = List.copyOf(logs);
			int x0 = Integer.MAX_VALUE;
			int x1 = Integer.MIN_VALUE;
			int z0 = Integer.MAX_VALUE;
			int z1 = Integer.MIN_VALUE;
			int y0 = Integer.MAX_VALUE;
			int y1 = Integer.MIN_VALUE;
			for (BlockPos p : logs) {
				x0 = Math.min(x0, p.getX());
				x1 = Math.max(x1, p.getX());
				z0 = Math.min(z0, p.getZ());
				z1 = Math.max(z1, p.getZ());
				y0 = Math.min(y0, p.getY());
				y1 = Math.max(y1, p.getY());
			}
			this.minX = x0;
			this.maxX = x1;
			this.minZ = z0;
			this.maxZ = z1;
			this.minY = y0;
			this.maxY = y1;
		}

		public List<BlockPos> logs() {
			return this.logs;
		}

		@Override
		public boolean satisfied(final BlockGetter level, final int x, final int y, final int z) {
			if (x < this.minX - 1 || x > this.maxX + 1 || z < this.minZ - 1 || z > this.maxZ + 1 || y + 1 < this.minY || y > this.maxY) {
				return false;
			}
			for (BlockPos p : this.logs) {
				int dx = Math.abs(p.getX() - x);
				int dz = Math.abs(p.getZ() - z);
				if (dx <= 1 && dz <= 1 && dx + dz > 0 && (p.getY() == y || p.getY() == y + 1)) {
					// Still a log there (a trunk being cut down shrinks).
					return level.getBlockState(p).is(BlockTags.LOGS);
				}
			}
			return false;
		}

		@Override
		public double heuristic(final int x, final int y, final int z) {
			double dx = x < this.minX - 1 ? this.minX - 1 - x : x > this.maxX + 1 ? x - this.maxX - 1 : 0;
			double dz = z < this.minZ - 1 ? this.minZ - 1 - z : z > this.maxZ + 1 ? z - this.maxZ - 1 : 0;
			double dy = y + 1 < this.minY ? this.minY - y - 1 : y > this.maxY ? y - this.maxY : 0;
			return flatCost(dx, dz) + dy * 2.0;
		}

		@Override
		public BlockPos anchor() {
			return this.logs.getFirst();
		}

		@Override
		public String describe() {
			return "trunk " + this.anchor().toShortString() + " (" + this.logs.size() + " logs)";
		}

		@Override
		public String kind() {
			return "trunk";
		}
	}

	/**
	 * The trunk {@code log} belongs to: down its column to the lowest log, then up every column of the trunk's footprint
	 * (1x1, or 2x2 for big trees) while there are logs. At most 64 logs.
	 */
	static List<BlockPos> trunkOf(final BlockGetter level, final BlockPos log) {
		BlockPos base = log;
		for (int i = 0; i < 48 && level.getBlockState(base.below()).is(BlockTags.LOGS); i++) {
			base = base.below();
		}
		List<BlockPos> columns = new ArrayList<>();
		columns.add(base);
		// A 2x2 trunk: neighbours that are logs at the same height and stand on the same ground.
		for (Direction d : Direction.Plane.HORIZONTAL) {
			BlockPos n = base.relative(d);
			if (level.getBlockState(n).is(BlockTags.LOGS) && !level.getBlockState(n.below()).is(BlockTags.LOGS)) {
				columns.add(n);
			}
		}
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos c : columns) {
			BlockPos p = c;
			for (int i = 0; i < 48 && out.size() < 64 && level.getBlockState(p).is(BlockTags.LOGS); i++) {
				out.add(p);
				p = p.above();
			}
		}
		if (out.isEmpty()) {
			out.add(log.immutable());
		}
		return out;
	}
}
