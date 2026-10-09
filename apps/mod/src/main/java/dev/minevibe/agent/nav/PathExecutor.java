package dev.minevibe.agent.nav;

import dev.minevibe.agent.AgentControls;
import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.pathfinder.Node;
import net.minecraft.world.level.pathfinder.Path;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Follows one {@link Path} with player controls: look at the next node, walk forward, jump on step-ups
 * and collisions, swim, open (and close behind) wooden doors, and sprint on long straight runs when
 * food allows. It never steers into a drop deeper than 3 blocks; it reports that as {@link #isBlocked()}.
 */
public final class PathExecutor {
	private static final double REACH_XZ = 0.45;
	private static final int MAX_DROP = 3;

	private @Nullable Path path;
	private int index;
	private boolean blocked;
	private final NavDoors doors = new NavDoors();

	public void setPath(final @Nullable Path path, final AgentPlayer agent) {
		this.path = path;
		this.index = 0;
		this.blocked = false;
		if (path != null && path.getNodeCount() > 1) {
			// Skip the start node when we are already standing on it.
			Node first = path.getNode(0);
			if (horizontalDistance(agent.position(), first) < 0.7 && Math.abs(first.y - agent.getY()) < 1.0) {
				this.index = 1;
			}
		}
	}

	public @Nullable Path path() {
		return this.path;
	}

	public boolean isDone() {
		return this.path == null || this.index >= this.path.getNodeCount();
	}

	public boolean isBlocked() {
		return this.blocked;
	}

	/** Index of the next node to reach. */
	public int index() {
		return this.index;
	}

	public @Nullable Node nextNode() {
		return this.isDone() ? null : this.path.getNode(this.index);
	}

	/** Remaining path length from the agent, through all remaining nodes. */
	public double remainingDistance(final Vec3 from) {
		if (this.isDone()) {
			return 0.0;
		}
		double total = 0.0;
		Vec3 prev = from;
		for (int i = this.index; i < this.path.getNodeCount(); i++) {
			Node n = this.path.getNode(i);
			Vec3 c = new Vec3(n.x + 0.5, n.y, n.z + 0.5);
			total += prev.distanceTo(c);
			prev = c;
		}
		return total;
	}

	/** Drops the path. Doors opened on the way are still closed once the agent is clear of them. */
	public void clear(final AgentPlayer agent) {
		this.path = null;
		this.index = 0;
	}

	/** Closes doors this executor opened once the agent is clear of them. Called every tick, moving or not. */
	public void maintainDoors(final AgentPlayer agent) {
		this.doors.closeBehind(agent, this::pathGoesThrough);
	}

	/** One tick of path following. Sets movement intentions on the agent's controls. */
	public void tick(final AgentPlayer agent) {
		AgentControls controls = agent.controls();
		if (this.isDone()) {
			controls.stopMovement();
			return;
		}
		Vec3 pos = agent.position();
		this.advance(agent, pos);
		if (this.isDone()) {
			controls.stopMovement();
			return;
		}
		Node node = this.path.getNode(this.index);
		if (node.y < Math.floor(pos.y) - MAX_DROP && !agent.isInWater()) {
			this.blocked = true;
			controls.stopMovement();
			return;
		}
		Vec3 target = new Vec3(node.x + 0.5, node.y, node.z + 0.5);
		double hd = horizontalDistance(pos, node);

		// Doors in the next two nodes: open them (wooden only; the evaluator already avoids iron doors).
		for (int i = this.index; i < Math.min(this.index + 2, this.path.getNodeCount()); i++) {
			Node n = this.path.getNode(i);
			this.doors.openIfClosed(agent, new BlockPos(n.x, n.y, n.z));
		}

		controls.look(controls.yawTo(target), agent.isInWater() ? -10.0F : 10.0F);
		controls.setStrafe(0.0F);
		controls.setForward(hd > 0.05 ? 1.0F : 0.0F);

		boolean inFluid = agent.isInWater() || agent.isInLava();
		boolean jump;
		if (inFluid) {
			// Swim: keep the head up, and climb out at the far bank.
			jump = node.y >= pos.y - 0.2 || agent.horizontalCollision;
		} else {
			boolean stepUp = node.y > pos.y + 0.6 && hd < 1.8;
			jump = agent.onGround() && (stepUp || agent.horizontalCollision && hd > 0.3);
		}
		controls.setJumping(jump);

		double remaining = this.remainingDistance(pos);
		boolean straight = this.isStraightAhead(4);
		controls.setSprinting(!inFluid && remaining > 6.0 && straight && agent.getFoodData().getFoodLevel() > 6);
	}

	private void advance(final AgentPlayer agent, final Vec3 pos) {
		boolean swimming = agent.isInWater();
		while (this.index < this.path.getNodeCount()) {
			Node n = this.path.getNode(this.index);
			double hd = horizontalDistance(pos, n);
			double dy = n.y - pos.y;
			boolean reached = swimming ? hd < 0.7 && Math.abs(dy) < 1.6 : hd < REACH_XZ && dy > -1.25 && dy < 0.75;
			if (!reached && this.index + 1 < this.path.getNodeCount()) {
				// Overshot: closer to the following node than this node is to it (cut corners on flat ground).
				Node m = this.path.getNode(this.index + 1);
				double toNext = horizontalDistance(pos, m);
				double between = Math.sqrt((m.x - n.x) * (m.x - n.x) + (m.z - n.z) * (m.z - n.z));
				if (m.y == n.y && Math.abs(n.y - pos.y) < 0.75 && toNext < between && hd < 1.0) {
					reached = true;
				}
			}
			if (!reached) {
				return;
			}
			this.index++;
		}
	}

	private boolean isStraightAhead(final int lookahead) {
		if (this.isDone()) {
			return false;
		}
		int end = Math.min(this.path.getNodeCount() - 1, this.index + lookahead);
		Node a = this.path.getNode(this.index);
		Node b = this.path.getNode(end);
		if (end - this.index < 2) {
			return false;
		}
		int dx = Integer.signum(b.x - a.x);
		int dz = Integer.signum(b.z - a.z);
		for (int i = this.index + 1; i <= end; i++) {
			Node p = this.path.getNode(i - 1);
			Node q = this.path.getNode(i);
			if (q.y != p.y) {
				return false;
			}
			if (dx != 0 && Integer.signum(q.x - p.x) == -dx || dz != 0 && Integer.signum(q.z - p.z) == -dz) {
				return false;
			}
		}
		return true;
	}

	private boolean pathGoesThrough(final BlockPos doorLower) {
		if (this.isDone()) {
			return false;
		}
		for (int i = this.index; i < this.path.getNodeCount(); i++) {
			Node n = this.path.getNode(i);
			if (n.x == doorLower.getX() && n.z == doorLower.getZ() && Math.abs(n.y - doorLower.getY()) <= 1) {
				return true;
			}
		}
		return false;
	}

	private static double horizontalDistance(final Vec3 pos, final Node node) {
		double dx = node.x + 0.5 - pos.x;
		double dz = node.z + 0.5 - pos.z;
		return Math.sqrt(dx * dx + dz * dz);
	}
}
