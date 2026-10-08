package dev.minevibe.org.office;

import java.util.ArrayList;
import java.util.List;

/**
 * The starter office's floor plan (PLAN §7.5), as plain data so it can be checked without a world. OfficeBuilder
 * turns it into blocks.
 *
 * <p>Local coordinates: {@code x} 0..{@value #WIDTH}-1 west to east, {@code z} 0..{@value #DEPTH}-1 north to south,
 * {@code y} 0 is the floor, 1..{@value #WALL_TOP} the room, {@value #ROOF} the roof. The outer ring of cells is wall;
 * the door is in the middle of the south wall, with a small porch ({@link #isPorch}) in front of it. The orientation is
 * fixed, so the same spawn always gives the same office.
 *
 * <pre>
 *   x: 0 1 2 3 4 5 6 7 8 9 10 11 12
 * z=0  # # # w # # # # # # #  #  #     # wall, w window, = window/door in the south wall
 *   1  # d D . d D . c . X X  .  #     D desk main column (the slot), d its side column, c wall calendar (y=2), X codex
 *   2  w s s . s s . . . . .  .  w     s workstation chair row (the chair stands in front of D)
 *   3  w . . . . . C C . . .  .  w     C meeting chair, T meeting table
 *   4  w . . . . C T T C . .  .  #
 *   5  # . . . . . C C . . .  F  #     F furnace
 *   6  # B B . . . @ . . . .  W  #     B bed (foot), @ spawn, W crafting table
 *   7  # B B . . . . . . . .  H  #     B bed (head), H chest
 *   8  # # # w # # d # # w #  #  #     d door
 *   9            p p p                 p porch
 * </pre>
 */
public final class OfficePlan {
	public static final int WIDTH = 13;
	public static final int DEPTH = 9;
	/** Walls stand on y 1..WALL_TOP; the room is that tall inside. */
	public static final int WALL_TOP = 4;
	public static final int ROOF = 5;
	public static final int DOOR_X = 6;
	/** The porch row in front of the door (outside the walls). */
	public static final int PORCH_Z = DEPTH;
	public static final int PORCH_HEIGHT = 3;
	/** The foundation fills at most this far down below the floor. */
	public static final int MAX_FOUNDATION_DEPTH = 24;

	/** Where the player stands when they first arrive, looking north at the meeting table. */
	public static final int SPAWN_X = 6;
	public static final int SPAWN_Y = 1;
	public static final int SPAWN_Z = 6;
	public static final Facing SPAWN_FACING = Facing.NORTH;

	/** Horizontal directions, without Minecraft classes. */
	public enum Facing {
		NORTH(0, -1),
		EAST(1, 0),
		SOUTH(0, 1),
		WEST(-1, 0);

		public final int dx;
		public final int dz;

		Facing(final int dx, final int dz) {
			this.dx = dx;
			this.dz = dz;
		}

		/** The next direction clockwise seen from above (as Direction#getClockWise). */
		public Facing clockWise() {
			return switch (this) {
				case NORTH -> EAST;
				case EAST -> SOUTH;
				case SOUTH -> WEST;
				case WEST -> NORTH;
			};
		}

		/** The "right" of something whose front faces this way (as Direction#getCounterClockWise). */
		public Facing right() {
			return switch (this) {
				case NORTH -> WEST;
				case EAST -> NORTH;
				case SOUTH -> EAST;
				case WEST -> SOUTH;
			};
		}

		public Facing opposite() {
			return switch (this) {
				case NORTH -> SOUTH;
				case EAST -> WEST;
				case SOUTH -> NORTH;
				case WEST -> EAST;
			};
		}
	}

	/** What a piece of the plan is. */
	public enum Kind {
		/** 2 wide (to its right), 3 high; anchor is the bottom-left cell. */
		CODEX,
		/** Hangs on the wall behind it ({@code facing} points into the room). */
		WALL_CALENDAR,
		MEETING_TABLE,
		/** A chair linked to the meeting table; {@code facing} points at the table. */
		MEETING_CHAIR,
		/** 2 long: foot at the cell, head one step toward {@code facing}. */
		BED,
		CHEST,
		CRAFTING_TABLE,
		FURNACE,
		/**
		 * A 2x2 slot for a PC workstation, laid out like {@code minevibe:pc_desk}: the desk's main column at the cell,
		 * its side column one step {@link Facing#clockWise() clockwise} of {@code facing} (PcDeskBlock#sideDirection),
		 * the screen facing {@code facing}, and the chair row one step toward {@code facing}.
		 */
		WORKSTATION,
		/** Hangs from the roof. */
		LANTERN,
		/** 2 high. */
		DOOR,
		WINDOW,
		/** A torch on the outside of the wall behind it. */
		OUTDOOR_TORCH
	}

	/** One piece at local {@code (x, y, z)}. */
	public record Piece(Kind kind, int x, int y, int z, Facing facing) {
		/** Every local cell the piece takes ({x, y, z} triples). */
		public List<int[]> cells() {
			List<int[]> cells = new ArrayList<>();
			Facing right = this.facing.right();
			switch (this.kind) {
				case CODEX -> {
					for (int column = 0; column < 2; column++) {
						for (int row = 0; row < 3; row++) {
							cells.add(new int[] {this.x + right.dx * column, this.y + row, this.z + right.dz * column});
						}
					}
				}
				case BED -> {
					cells.add(new int[] {this.x, this.y, this.z});
					cells.add(new int[] {this.x + this.facing.dx, this.y, this.z + this.facing.dz});
				}
				case DOOR -> {
					cells.add(new int[] {this.x, this.y, this.z});
					cells.add(new int[] {this.x, this.y + 1, this.z});
				}
				case WORKSTATION -> {
					Facing side = this.facing.clockWise();
					for (int column = 0; column < 2; column++) {
						for (int depth = 0; depth < 2; depth++) {
							cells.add(new int[] {
								this.x + side.dx * column + this.facing.dx * depth, this.y, this.z + side.dz * column + this.facing.dz * depth
							});
						}
					}
				}
				default -> cells.add(new int[] {this.x, this.y, this.z});
			}
			return cells;
		}
	}

	public static final List<Piece> PIECES = List.of(
		// North wall: two workstation slots (main columns at x 2 and 5, side columns to their west), the wall calendar
		// and the Codex.
		new Piece(Kind.WORKSTATION, 2, 1, 1, Facing.SOUTH),
		new Piece(Kind.WORKSTATION, 5, 1, 1, Facing.SOUTH),
		new Piece(Kind.WALL_CALENDAR, 7, 2, 1, Facing.SOUTH),
		new Piece(Kind.CODEX, 9, 1, 1, Facing.SOUTH),
		// The meeting table (2 blocks) with 6 chairs around it.
		new Piece(Kind.MEETING_TABLE, 6, 1, 4, Facing.NORTH),
		new Piece(Kind.MEETING_TABLE, 7, 1, 4, Facing.NORTH),
		new Piece(Kind.MEETING_CHAIR, 6, 1, 3, Facing.SOUTH),
		new Piece(Kind.MEETING_CHAIR, 7, 1, 3, Facing.SOUTH),
		new Piece(Kind.MEETING_CHAIR, 6, 1, 5, Facing.NORTH),
		new Piece(Kind.MEETING_CHAIR, 7, 1, 5, Facing.NORTH),
		new Piece(Kind.MEETING_CHAIR, 5, 1, 4, Facing.EAST),
		new Piece(Kind.MEETING_CHAIR, 8, 1, 4, Facing.WEST),
		// Beds in the south-west corner, heads against the south wall.
		new Piece(Kind.BED, 1, 1, 6, Facing.SOUTH),
		new Piece(Kind.BED, 2, 1, 6, Facing.SOUTH),
		// Supplies along the east wall.
		new Piece(Kind.FURNACE, 11, 1, 5, Facing.WEST),
		new Piece(Kind.CRAFTING_TABLE, 11, 1, 6, Facing.WEST),
		new Piece(Kind.CHEST, 11, 1, 7, Facing.WEST),
		// Door, windows, light.
		new Piece(Kind.DOOR, DOOR_X, 1, 8, Facing.NORTH),
		new Piece(Kind.WINDOW, 3, 2, 0, Facing.SOUTH),
		new Piece(Kind.WINDOW, 3, 3, 0, Facing.SOUTH),
		new Piece(Kind.WINDOW, 0, 2, 2, Facing.EAST),
		new Piece(Kind.WINDOW, 0, 3, 2, Facing.EAST),
		new Piece(Kind.WINDOW, 0, 2, 3, Facing.EAST),
		new Piece(Kind.WINDOW, 0, 3, 3, Facing.EAST),
		new Piece(Kind.WINDOW, 12, 2, 2, Facing.WEST),
		new Piece(Kind.WINDOW, 12, 3, 2, Facing.WEST),
		new Piece(Kind.WINDOW, 12, 2, 3, Facing.WEST),
		new Piece(Kind.WINDOW, 12, 3, 3, Facing.WEST),
		new Piece(Kind.WINDOW, 3, 2, 8, Facing.NORTH),
		new Piece(Kind.WINDOW, 3, 3, 8, Facing.NORTH),
		new Piece(Kind.WINDOW, 9, 2, 8, Facing.NORTH),
		new Piece(Kind.WINDOW, 9, 3, 8, Facing.NORTH),
		new Piece(Kind.LANTERN, 3, WALL_TOP, 3, Facing.NORTH),
		new Piece(Kind.LANTERN, 9, WALL_TOP, 3, Facing.NORTH),
		new Piece(Kind.LANTERN, 3, WALL_TOP, 6, Facing.NORTH),
		new Piece(Kind.LANTERN, 9, WALL_TOP, 6, Facing.NORTH),
		new Piece(Kind.LANTERN, 7, WALL_TOP, 4, Facing.NORTH),
		new Piece(Kind.OUTDOOR_TORCH, DOOR_X - 1, 2, PORCH_Z, Facing.SOUTH),
		new Piece(Kind.OUTDOOR_TORCH, DOOR_X + 1, 2, PORCH_Z, Facing.SOUTH)
	);

	private OfficePlan() {
	}

	public static boolean isWall(final int x, final int z) {
		return inFootprint(x, z) && (x == 0 || z == 0 || x == WIDTH - 1 || z == DEPTH - 1);
	}

	public static boolean isCorner(final int x, final int z) {
		return (x == 0 || x == WIDTH - 1) && (z == 0 || z == DEPTH - 1);
	}

	public static boolean isInterior(final int x, final int z) {
		return x > 0 && z > 0 && x < WIDTH - 1 && z < DEPTH - 1;
	}

	public static boolean inFootprint(final int x, final int z) {
		return x >= 0 && z >= 0 && x < WIDTH && z < DEPTH;
	}

	/** The cells in front of the door that are cleared and floored so the door never opens into a hill. */
	public static boolean isPorch(final int x, final int z) {
		return z == PORCH_Z && Math.abs(x - DOOR_X) <= 1;
	}

	public static List<Piece> piecesOf(final Kind kind) {
		return PIECES.stream().filter(p -> p.kind() == kind).toList();
	}
}
