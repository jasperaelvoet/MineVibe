package dev.minevibe.pc;

import net.minecraft.util.StringRepresentable;
import org.jspecify.annotations.Nullable;

/**
 * The status LED on a PC monitor (PLAN 7.5, 8.1): a blockstate of {@code pc_desk}, driven by {@code pc.state}.
 *
 * <ul>
 *   <li>{@link #OFF}: no PC, off, decommissioned, or unplugged.</li>
 *   <li>{@link #AMBER}: busy (downloading, waiting for consent, booting, stopping, remounting, reimaging) or a
 *       create in flight.</li>
 *   <li>{@link #GREEN}: running.</li>
 *   <li>{@link #RED}: cannot run (no capacity, macOS slots full, engine down, error, or the create failed).</li>
 * </ul>
 */
public enum PcLed implements StringRepresentable {
	OFF("off"),
	AMBER("amber"),
	GREEN("green"),
	RED("red");

	private final String id;

	PcLed(final String id) {
		this.id = id;
	}

	@Override
	public String getSerializedName() {
		return this.id;
	}

	/** The LED for a {@code PcStatus} wire value; unknown or missing statuses are {@link #OFF}. */
	public static PcLed of(final @Nullable String status) {
		if (status == null) {
			return OFF;
		}
		return switch (status) {
			case "running" -> GREEN;
			case "downloading", "awaiting_consent", "booting", "stopping", "remounting", "reimaging" -> AMBER;
			case "no_capacity", "macos_slots_full", "engine_down", "error" -> RED;
			default -> OFF;
		};
	}

	/**
	 * The LED of a desk: {@code creating} (a create request in flight) is amber, a failed create is red, an unbound
	 * desk is off, otherwise the PC's status decides (an unplugged PC is off whatever its status says).
	 */
	public static PcLed forDesk(
		final @Nullable String pcId, final boolean creating, final @Nullable String createError, final @Nullable String status, final boolean plugged
	) {
		if (pcId == null) {
			if (creating) {
				return AMBER;
			}
			return createError != null ? RED : OFF;
		}
		if (!plugged) {
			return OFF;
		}
		return of(status);
	}
}
