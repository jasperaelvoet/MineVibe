package dev.minevibe.pc;

import net.minecraft.util.StringRepresentable;

/**
 * Which column of the 2-wide {@code pc_desk} a block is. {@link #MAIN} holds the {@link PcBlockEntity} (in its upper
 * half, the monitor) and has the chair in front of it; {@link #SIDE} is the column to its side
 * ({@code facing.getClockWise()} of the main column).
 */
public enum PcDeskPart implements StringRepresentable {
	MAIN("main"),
	SIDE("side");

	private final String id;

	PcDeskPart(final String id) {
		this.id = id;
	}

	@Override
	public String getSerializedName() {
		return this.id;
	}
}
