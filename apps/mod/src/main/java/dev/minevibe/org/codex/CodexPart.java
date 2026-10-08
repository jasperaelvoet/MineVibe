package dev.minevibe.org.codex;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.StringRepresentable;
import org.jspecify.annotations.Nullable;

/**
 * One cell of the 2-wide, 3-high {@code minevibe:codex} multiblock. Columns are seen from the front (the side the
 * block's {@code facing} points to): {@code left} is the anchor column, where the player clicked. Rows count up from
 * the floor. The open book rests in the middle row, between the two columns.
 */
public enum CodexPart implements StringRepresentable {
	BOTTOM_LEFT("bottom_left", 0, 0),
	BOTTOM_RIGHT("bottom_right", 1, 0),
	MIDDLE_LEFT("middle_left", 0, 1),
	MIDDLE_RIGHT("middle_right", 1, 1),
	TOP_LEFT("top_left", 0, 2),
	TOP_RIGHT("top_right", 1, 2);

	/** The part every other part is placed relative to (and the only one that drops the item). */
	public static final CodexPart ANCHOR = BOTTOM_LEFT;
	/** The part whose block entity renders the open book. */
	public static final CodexPart BOOK = MIDDLE_LEFT;

	public static final int COLUMNS = 2;
	public static final int ROWS = 3;

	private final String id;
	private final int column;
	private final int row;

	CodexPart(final String id, final int column, final int row) {
		this.id = id;
		this.column = column;
		this.row = row;
	}

	@Override
	public String getSerializedName() {
		return this.id;
	}

	public int column() {
		return this.column;
	}

	public int row() {
		return this.row;
	}

	public static CodexPart at(final int column, final int row) {
		for (CodexPart part : values()) {
			if (part.column == column && part.row == row) {
				return part;
			}
		}
		throw new IllegalArgumentException("no codex part at column " + column + ", row " + row);
	}

	/** The part in the other column of the same row (what a mirror turns this part into). */
	public CodexPart mirrored() {
		return at(1 - this.column, this.row);
	}

	/** The "right" direction of a codex whose front faces {@code facing}, as seen by someone standing in front of it. */
	public static Direction right(final Direction facing) {
		return facing.getCounterClockWise();
	}

	/** Offset of this part from the anchor of a codex facing {@code facing}. */
	public BlockPos offset(final Direction facing) {
		Direction right = right(facing);
		return new BlockPos(right.getStepX() * this.column, this.row, right.getStepZ() * this.column);
	}

	/** The anchor position of the codex this part (at {@code pos}) belongs to. */
	public BlockPos anchorFrom(final BlockPos pos, final Direction facing) {
		return pos.subtract(this.offset(facing));
	}

	/**
	 * The part the multiblock expects next to this one in direction {@code direction}, or null when that neighbour
	 * is outside the multiblock (front, back, the far sides, below the bottom row, above the top row).
	 */
	public @Nullable CodexPart expectedNeighbour(final Direction direction, final Direction facing) {
		Direction right = right(facing);
		if (direction == Direction.UP) {
			return this.row < ROWS - 1 ? at(this.column, this.row + 1) : null;
		}
		if (direction == Direction.DOWN) {
			return this.row > 0 ? at(this.column, this.row - 1) : null;
		}
		if (direction == right) {
			return this.column == 0 ? at(1, this.row) : null;
		}
		if (direction == right.getOpposite()) {
			return this.column == 1 ? at(0, this.row) : null;
		}
		return null;
	}
}
