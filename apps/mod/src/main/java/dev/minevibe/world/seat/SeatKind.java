package dev.minevibe.world.seat;

import net.minecraft.util.StringRepresentable;

/** What a chair is for (PLAN 6.3): a PC seat swaps the model; a meeting seat never does. */
public enum SeatKind implements StringRepresentable {
	PC("pc"),
	MEETING("meeting");

	private final String id;

	SeatKind(final String id) {
		this.id = id;
	}

	@Override
	public String getSerializedName() {
		return this.id;
	}
}
