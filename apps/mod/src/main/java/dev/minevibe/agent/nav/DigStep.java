package dev.minevibe.agent.nav;

import java.util.List;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * One move of a Tier-2 path ({@link DigPathPlanner}): from the feet cell {@code from} to the feet cell {@code dest}.
 * The blocks in {@code breaks} are broken first, in order; {@code place} (a pillar or bridge block) is placed next.
 */
public record DigStep(Kind kind, BlockPos from, BlockPos dest, List<BlockPos> breaks, @Nullable BlockPos place) {
	public enum Kind {
		/** One block sideways, same height (through a wooden door too). */
		WALK,
		/** One block diagonally, same height; never breaks anything. */
		DIAGONAL,
		/** One block sideways and one up (a jump). */
		ASCEND,
		/** One block sideways and one down through dug-out blocks (a staircase down; never straight down). */
		DESCEND,
		/** Off an edge: one block sideways, then a fall of 1 to 3 blocks (2 at low health), or deeper into water. */
		DROP,
		/** Through water, sideways, up or down. */
		SWIM,
		/**
		 * Out of water onto the bank beside it: one block sideways and up, onto a floor whose top is level with the water
		 * line (vanilla lifts a swimmer pressing against such a bank). With {@code place}, a block is first put in the
		 * water there to step on (the bank is too high); with {@code breaks}, a step is dug into the bank from the bottom
		 * of water at most one deep (standing, the head above the water: never while swimming).
		 */
		EXIT_WATER,
		/** Up a ladder or vines. */
		CLIMB_UP,
		/** Down a ladder or vines. */
		CLIMB_DOWN,
		/** Jump and place a block under the feet. */
		PILLAR,
		/** Place a block in front of the feet, below the next cell, then walk onto it. */
		BRIDGE;

		/** True for a move made in or out of water ({@link WaterMoves} steers it). */
		public boolean water() {
			return this == SWIM || this == EXIT_WATER;
		}
	}

	public DigStep {
		breaks = List.copyOf(breaks);
	}

	public boolean breaksOrPlaces() {
		return !this.breaks.isEmpty() || this.place != null;
	}

	@Override
	public String toString() {
		return this.kind + " " + this.dest.toShortString() + (this.breaks.isEmpty() ? "" : " breaks " + this.breaks.size())
			+ (this.place == null ? "" : " place " + this.place.toShortString());
	}
}
