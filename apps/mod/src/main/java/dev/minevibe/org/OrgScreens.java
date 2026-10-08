package dev.minevibe.org;

import net.minecraft.core.BlockPos;

/**
 * How common code (blocks and items, which run on both sides) opens the org screens. The client entrypoint installs
 * an {@link Opener} that shows CodexScreen and CalendarScreen; without a client (dedicated server, server GameTests)
 * nothing happens. Only call these on the client side of a block or item interaction.
 */
public final class OrgScreens {
	/** Opens the org screens on the client. */
	public interface Opener {
		/** A codex was used; {@code anchor} is that codex's anchor block (they all show the same Codex). */
		void openCodex(BlockPos anchor);

		/** A wall calendar or a handheld calendar was used. */
		void openCalendar();
	}

	private static final Opener NONE = new Opener() {
		@Override
		public void openCodex(final BlockPos anchor) {
		}

		@Override
		public void openCalendar() {
		}
	};

	private static volatile Opener opener = NONE;

	private OrgScreens() {
	}

	public static void install(final Opener clientOpener) {
		opener = clientOpener;
	}

	public static void openCodex(final BlockPos anchor) {
		opener.openCodex(anchor);
	}

	public static void openCalendar() {
		opener.openCalendar();
	}
}
