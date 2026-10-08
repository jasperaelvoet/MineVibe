package dev.minevibe.org.office;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.org.office.OfficePlan.Kind;
import dev.minevibe.org.office.OfficePlan.Piece;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.junit.jupiter.api.Test;

/** The starter office's floor plan (PLAN §7.5), checked without a world. */
class OfficePlanTest {
	private static String key(final int[] c) {
		return c[0] + "," + c[1] + "," + c[2];
	}

	@Test
	void hasEverythingThePlanPromises() {
		assertEquals(13, OfficePlan.WIDTH, "about 13x9");
		assertEquals(9, OfficePlan.DEPTH);
		assertEquals(2, OfficePlan.piecesOf(Kind.BED).size(), "beds");
		assertEquals(1, OfficePlan.piecesOf(Kind.CHEST).size());
		assertEquals(1, OfficePlan.piecesOf(Kind.CRAFTING_TABLE).size());
		assertEquals(1, OfficePlan.piecesOf(Kind.FURNACE).size());
		assertEquals(2, OfficePlan.piecesOf(Kind.WORKSTATION).size(), "workstation slots");
		assertEquals(6, OfficePlan.piecesOf(Kind.MEETING_CHAIR).size(), "a meeting table with 6 chairs");
		assertEquals(1, OfficePlan.piecesOf(Kind.CODEX).size());
		assertEquals(1, OfficePlan.piecesOf(Kind.WALL_CALENDAR).size());
		assertTrue(OfficePlan.piecesOf(Kind.LANTERN).size() >= 4, "lit");
	}

	@Test
	void piecesNeverOverlapAndStayInside() {
		Map<String, Piece> taken = new HashMap<>();
		for (Piece piece : OfficePlan.PIECES) {
			for (int[] cell : piece.cells()) {
				Piece other = taken.put(key(cell), piece);
				assertTrue(other == null, piece + " overlaps " + other + " at " + key(cell));
				boolean inWall = OfficePlan.isWall(cell[0], cell[2]);
				switch (piece.kind()) {
					case DOOR, WINDOW -> {
						assertTrue(inWall && !OfficePlan.isCorner(cell[0], cell[2]), piece + " sits in a wall, not a corner");
						assertTrue(cell[1] >= 1 && cell[1] <= OfficePlan.WALL_TOP, piece + " height");
					}
					case OUTDOOR_TORCH -> assertTrue(OfficePlan.isPorch(cell[0], cell[2]), piece + " on the porch");
					default -> {
						assertTrue(OfficePlan.isInterior(cell[0], cell[2]), piece + " is inside the room at " + key(cell));
						assertTrue(cell[1] >= 1 && cell[1] <= OfficePlan.WALL_TOP, piece + " is between floor and roof");
					}
				}
			}
		}
	}

	@Test
	void theSpawnCellIsFreeAndFacesTheTable() {
		for (Piece piece : OfficePlan.PIECES) {
			for (int[] cell : piece.cells()) {
				boolean spawnColumn = cell[0] == OfficePlan.SPAWN_X && cell[2] == OfficePlan.SPAWN_Z;
				assertFalse(spawnColumn && (cell[1] == OfficePlan.SPAWN_Y || cell[1] == OfficePlan.SPAWN_Y + 1), piece + " blocks the spawn");
			}
		}
		assertTrue(OfficePlan.isInterior(OfficePlan.SPAWN_X, OfficePlan.SPAWN_Z));
		assertEquals(OfficePlan.Facing.NORTH, OfficePlan.SPAWN_FACING);
	}

	@Test
	void meetingChairsFaceTheTable() {
		List<Piece> tables = OfficePlan.piecesOf(Kind.MEETING_TABLE);
		for (Piece chair : OfficePlan.piecesOf(Kind.MEETING_CHAIR)) {
			int tx = chair.x() + chair.facing().dx;
			int tz = chair.z() + chair.facing().dz;
			assertTrue(tables.stream().anyMatch(t -> t.x() == tx && t.z() == tz), chair + " faces a table block");
		}
	}

	@Test
	void theDoorOpensOntoThePorch() {
		Piece door = OfficePlan.piecesOf(Kind.DOOR).getFirst();
		assertEquals(OfficePlan.DOOR_X, door.x());
		assertEquals(OfficePlan.DEPTH - 1, door.z(), "south wall");
		assertTrue(OfficePlan.isPorch(OfficePlan.DOOR_X, OfficePlan.PORCH_Z));
		assertFalse(OfficePlan.isPorch(OfficePlan.DOOR_X + 2, OfficePlan.PORCH_Z));
		assertTrue(OfficePlan.isInterior(OfficePlan.DOOR_X, OfficePlan.DEPTH - 2), "a free cell inside the door");
	}

	@Test
	void theCodexFitsUnderTheRoofAndAgainstTheNorthWall() {
		Piece codex = OfficePlan.piecesOf(Kind.CODEX).getFirst();
		assertEquals(6, codex.cells().size());
		assertTrue(codex.cells().stream().allMatch(c -> c[1] <= OfficePlan.WALL_TOP && c[2] == 1));
		assertEquals(OfficePlan.Facing.EAST, codex.facing().right(), "a south-facing codex grows east");
	}

	@Test
	void workstationSlotsFitThePcDesk() {
		// minevibe:pc_desk: main column at the slot, side column clockwise of the screen's facing
		// (PcDeskBlock#sideDirection), the chair in front of the main column, monitor blocks one above the desk.
		for (OfficePlan.Facing f : OfficePlan.Facing.values()) {
			assertEquals(Direction.valueOf(f.name()).getClockWise(), Direction.valueOf(f.clockWise().name()), "clockwise of " + f);
		}
		Map<String, Piece> taken = new HashMap<>();
		for (Piece piece : OfficePlan.PIECES) {
			for (int[] cell : piece.cells()) {
				taken.put(key(cell), piece);
			}
		}
		for (Piece slot : OfficePlan.piecesOf(Kind.WORKSTATION)) {
			OfficePlan.Facing side = slot.facing().clockWise();
			int[] main = {slot.x(), slot.y(), slot.z()};
			int[] sideCell = {slot.x() + side.dx, slot.y(), slot.z() + side.dz};
			int[] chair = {slot.x() + slot.facing().dx, slot.y(), slot.z() + slot.facing().dz};
			for (int[] cell : List.of(main, sideCell, chair)) {
				assertEquals(slot, taken.get(key(cell)), slot + " reserves " + key(cell));
			}
			for (int[] desk : List.of(main, sideCell)) {
				int[] monitor = {desk[0], desk[1] + 1, desk[2]};
				assertTrue(OfficePlan.isInterior(monitor[0], monitor[2]) && taken.get(key(monitor)) == null, slot + " leaves room for the monitor at " + key(monitor));
				int[] behind = {desk[0] - slot.facing().dx, desk[1], desk[2] - slot.facing().dz};
				assertTrue(OfficePlan.isWall(behind[0], behind[2]), slot + " stands against the wall");
			}
		}
	}

	@Test
	void layoutRoundTripsAndMatchesTheWorldStateSchema() {
		OfficeLayout layout = new OfficeLayout(new BlockPos(-6, 63, -6), new BlockPos(0, 64, 0), 180.0F, List.of(
			new OfficeLayout.Slot(OfficeLayout.WORKSTATION, new BlockPos(-5, 64, -5), "linux-1"),
			new OfficeLayout.Slot(OfficeLayout.MEETING_TABLE, new BlockPos(0, 64, -2), null),
			new OfficeLayout.Slot(OfficeLayout.DOOR, new BlockPos(0, 64, 3), null)));
		assertEquals(layout, OfficeLayout.fromJson(layout.toJson()));
		assertEquals("linux-1", layout.firstSlot(OfficeLayout.WORKSTATION).pcId());
		assertEquals(1, layout.slotsOf(OfficeLayout.DOOR).size());
		JsonObject message = new JsonObject();
		message.addProperty("t", "world.state");
		message.addProperty("v", 1);
		message.addProperty("worldId", "w-7");
		message.addProperty("phase", "ready");
		message.add("office", layout.toWorldState());
		assertEquals(List.of(), Messages.WORLD_STATE.schema().validate(message));
		assertFalse(layout.toWorldState().has("spawn"), "world.state.office has only origin and slots");
	}

	@Test
	void coversTheBuiltOfficeOnly() {
		OfficeLayout office = new OfficeLayout(new BlockPos(-6, 65, -6), new BlockPos(0, 66, 0), 0f, List.of());
		assertTrue(office.covers(new BlockPos(-6, 66, -6)), "the north-west corner post");
		assertTrue(office.covers(new BlockPos(6, 69, 2)), "the south-east corner post, under the roof");
		assertTrue(office.covers(new BlockPos(0, 70, -2)), "the roof");
		assertTrue(office.covers(new BlockPos(0, 66, 3)), "the porch row");
		assertFalse(office.covers(new BlockPos(7, 66, 0)), "east of the walls");
		assertFalse(office.covers(new BlockPos(0, 66, 4)), "south of the porch");
		assertFalse(office.covers(new BlockPos(0, 71, 0)), "above the roof");
		assertFalse(office.covers(new BlockPos(9, 67, -12)), "the oak tree of the acceptance run");
	}
}
