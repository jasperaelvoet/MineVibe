package dev.minevibe.agent.job;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** The numbers behind "pillar beside the trunk": how high a climb may go, and from where a log is in reach. */
class TreeClimbTest {
	private static final double EYE = 1.62;

	@Test
	void theLimitLeavesAFallSurvivable() {
		assertEquals(TreeClimb.MAX_HEIGHT, TreeClimb.limit(20.0F));
		assertEquals(7, TreeClimb.limit(15.0F));
		assertEquals(0, TreeClimb.limit(8.0F));
		assertEquals(0, TreeClimb.limit(2.0F));
		for (float hp = 1.0F; hp <= 20.0F; hp += 1.0F) {
			// A fall of h blocks costs h - 3 health; from the top of the limit the agent keeps at least 8.
			int h = TreeClimb.limit(hp);
			assertTrue(h == 0 || hp - Math.max(0, h - 3) >= 8.0F, "health " + hp + " limit " + h);
		}
	}

	@Test
	void minFeetPutsTheLogInReach() {
		BlockPos log = new BlockPos(0, 20, 0);
		for (double h : new double[] {0.0, 1.0, Math.sqrt(2.0), 2.0, 2.5}) {
			int feet = TreeClimb.minFeet(log, h);
			double eye = feet + EYE;
			double d = Math.hypot(h, log.getY() + 0.5 - eye);
			assertTrue(d <= TreeClimb.PLAN_REACH + 1.0E-9, "h " + h + ": feet " + feet + " is " + d + " from the log");
			// One lower is out of the plan's reach: it is the lowest.
			double lower = Math.hypot(h, log.getY() + 0.5 - (eye - 1.0));
			assertTrue(lower > TreeClimb.PLAN_REACH, "h " + h + ": feet " + (feet - 1) + " would do too");
		}
		// From the cut trunk under a log, the log 5 above the feet is in reach; beside the trunk, 4 above.
		assertEquals(15, TreeClimb.minFeet(log, 0.0));
		assertEquals(16, TreeClimb.minFeet(log, 1.0));
	}

	@Test
	void theHighestLogAClimbReaches() {
		int ground = 64;
		int top = TreeClimb.highestReachable(ground, TreeClimb.limit(20.0F));
		assertEquals(ground + TreeClimb.MAX_HEIGHT + 5, top);
		assertTrue(TreeClimb.minFeet(new BlockPos(0, top, 0), 0.0) <= ground + TreeClimb.MAX_HEIGHT);
		assertFalse(TreeClimb.minFeet(new BlockPos(0, top + 1, 0), 0.0) <= ground + TreeClimb.MAX_HEIGHT);
	}

	@Test
	void fatalReasonsEndTheClimb() {
		assertTrue(TreeClimb.fatal("low_health"));
		assertTrue(TreeClimb.fatal("hazard"));
		assertTrue(TreeClimb.fatal("no_way"));
		assertTrue(TreeClimb.fatal("off_column"));
		assertFalse(TreeClimb.fatal("limit"));
		assertFalse(TreeClimb.fatal("no_scaffold"));
		assertFalse(TreeClimb.fatal(null));
	}
}
