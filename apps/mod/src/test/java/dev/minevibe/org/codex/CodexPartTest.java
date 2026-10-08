package dev.minevibe.org.codex;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.HashSet;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.junit.jupiter.api.Test;

/** The geometry of the 2x3 codex multiblock. */
class CodexPartTest {
	@Test
	void growsToTheRightAndUp() {
		// Facing south (its front toward +z), a viewer in front looks north; their right is east.
		assertEquals(Direction.EAST, CodexPart.right(Direction.SOUTH));
		assertEquals(Direction.WEST, CodexPart.right(Direction.NORTH));
		assertEquals(new BlockPos(1, 2, 0), CodexPart.TOP_RIGHT.offset(Direction.SOUTH));
		assertEquals(new BlockPos(-1, 1, 0), CodexPart.MIDDLE_RIGHT.offset(Direction.NORTH));
		assertEquals(new BlockPos(0, 1, -1), CodexPart.MIDDLE_RIGHT.offset(Direction.EAST));
		assertEquals(BlockPos.ZERO, CodexPart.ANCHOR.offset(Direction.WEST));
	}

	@Test
	void everyFacingCoversSixDistinctCellsAndFindsItsAnchor() {
		BlockPos anchor = new BlockPos(10, 64, -3);
		for (Direction facing : Direction.Plane.HORIZONTAL) {
			Set<BlockPos> cells = new HashSet<>();
			for (CodexPart part : CodexPart.values()) {
				BlockPos at = anchor.offset(part.offset(facing));
				cells.add(at);
				assertEquals(anchor, part.anchorFrom(at, facing), part + " facing " + facing);
			}
			assertEquals(6, cells.size(), "facing " + facing);
		}
	}

	@Test
	void neighboursAreSymmetricAndStayInside() {
		for (Direction facing : Direction.Plane.HORIZONTAL) {
			for (CodexPart part : CodexPart.values()) {
				for (Direction d : Direction.values()) {
					CodexPart expected = part.expectedNeighbour(d, facing);
					if (expected == null) {
						continue;
					}
					assertEquals(part.offset(facing).relative(d), expected.offset(facing), part + " -> " + d);
					assertEquals(part, expected.expectedNeighbour(d.getOpposite(), facing), "symmetric: " + part + " " + d);
				}
				assertNull(part.expectedNeighbour(facing, facing), "nothing in front");
				assertNull(part.expectedNeighbour(facing.getOpposite(), facing), "nothing behind");
			}
		}
		assertNull(CodexPart.TOP_LEFT.expectedNeighbour(Direction.UP, Direction.NORTH));
		assertNull(CodexPart.BOTTOM_RIGHT.expectedNeighbour(Direction.DOWN, Direction.NORTH));
		assertEquals(CodexPart.MIDDLE_LEFT, CodexPart.MIDDLE_RIGHT.mirrored());
		assertEquals(CodexPart.BOOK, CodexPart.at(0, 1));
	}
}
