package dev.minevibe.client.pc;

import dev.minevibe.bridge.msg.Pc;
import org.jspecify.annotations.Nullable;

/**
 * What a monitor (or the PcConfigScreen) says when it has no picture to show (PLAN 7.6: "without a frame it draws
 * status screens, one per PC state"). Pure logic: the headline, an optional detail line, an optional progress bar and
 * the screen's background colour.
 */
public final class PcStatusText {
	/** One status screen. {@code progress} is 0..1 or negative for none; colours are ARGB. */
	public record Screen(String title, @Nullable String detail, double progress, int background, int accent) {}

	public static final int BG_DARK = 0xFF101418;
	public static final int BG_BLUE = 0xFF0F2742;
	public static final int BG_RED = 0xFF3A0E12;
	public static final int ACCENT_GREEN = 0xFF4ADE80;
	public static final int ACCENT_AMBER = 0xFFFBBF24;
	public static final int ACCENT_RED = 0xFFF87171;
	public static final int ACCENT_GREY = 0xFF9CA3AF;

	private PcStatusText() {}

	/**
	 * The status screen of a desk.
	 *
	 * @param pcId the bound PC, or null
	 * @param creating a create request is in flight
	 * @param createError why the last create (or plug) failed, or null
	 * @param info what Node said about the PC, or null
	 * @param connected the bridge is up
	 * @param hasFrame a picture exists (then a running PC needs no status screen)
	 */
	public static @Nullable Screen of(
		final @Nullable String pcId,
		final boolean creating,
		final @Nullable String createError,
		final Pc.@Nullable PcInfo info,
		final boolean connected,
		final boolean hasFrame
	) {
		if (pcId == null) {
			if (creating) {
				return new Screen("Creating PC…", "Asking MineVibe for room", -1, BG_BLUE, ACCENT_AMBER);
			}
			if (createError != null) {
				return createFailed(createError);
			}
			return new Screen("No PC", "Use the desk to create one", -1, BG_DARK, ACCENT_GREY);
		}
		if (!connected) {
			return new Screen("MineVibe offline", "Waiting for MineVibe…", -1, BG_DARK, ACCENT_GREY);
		}
		if (info == null) {
			return new Screen("Connecting…", pcId, -1, BG_DARK, ACCENT_GREY);
		}
		double progress = info.progress() != null ? info.progress() : -1;
		String detail = info.detail();
		return switch (info.status()) {
			case "running" -> hasFrame ? null : new Screen("Starting display…", info.name(), -1, BG_BLUE, ACCENT_GREEN);
			case "off" -> new Screen("Off", info.plugged() ? "Sneak-use the desk to start it" : "Unplugged", -1, BG_DARK, ACCENT_GREY);
			case "downloading" -> new Screen(percent("Downloading", progress), detail, progress, BG_BLUE, ACCENT_AMBER);
			case "awaiting_consent" -> new Screen("Download needs your OK", "Sneak-use the desk", -1, BG_BLUE, ACCENT_AMBER);
			case "booting" -> new Screen(percent("Booting", progress), detail, progress, BG_BLUE, ACCENT_AMBER);
			case "stopping" -> new Screen("Stopping…", detail, -1, BG_DARK, ACCENT_AMBER);
			case "remounting" -> new Screen("Remounting the Vault…", detail, progress, BG_BLUE, ACCENT_AMBER);
			case "reimaging" -> new Screen(percent("Reimaging", progress), detail, progress, BG_BLUE, ACCENT_AMBER);
			case "no_capacity" -> new Screen("Not enough resources", detail != null ? detail : "Free some CPU or RAM", -1, BG_RED, ACCENT_RED);
			case "macos_slots_full" -> new Screen("Apple allows 2 macOS VMs", "Stop another Mac first", -1, BG_RED, ACCENT_RED);
			case "engine_down" -> new Screen("PC engine is down", detail, -1, BG_RED, ACCENT_RED);
			case "error" -> new Screen("Error", detail, -1, BG_RED, ACCENT_RED);
			case "decommissioned" -> new Screen("Decommissioned", null, -1, BG_DARK, ACCENT_GREY);
			default -> new Screen(info.status(), detail, -1, BG_DARK, ACCENT_GREY);
		};
	}

	/** The screen of a desk whose create (or plug) was refused with {@code code}. */
	public static Screen createFailed(final String code) {
		return switch (code) {
			case "NO_CAPACITY", "OVER_BUDGET" -> new Screen("Not enough resources", "Use the desk to try again", -1, BG_RED, ACCENT_RED);
			case "MACOS_SLOTS_FULL" -> new Screen("Apple allows 2 macOS VMs", "Use the desk to try again", -1, BG_RED, ACCENT_RED);
			case "ENGINE_DOWN" -> new Screen("PC engine is down", "Use the desk to try again", -1, BG_RED, ACCENT_RED);
			case "PC_UNKNOWN" -> new Screen("This PC no longer exists", "Use the desk to create a new one", -1, BG_RED, ACCENT_RED);
			case "OFFLINE", "DISCONNECTED", "TIMEOUT" -> new Screen("MineVibe did not answer", "Use the desk to try again", -1, BG_DARK, ACCENT_GREY);
			default -> new Screen("Could not create the PC", code, -1, BG_RED, ACCENT_RED);
		};
	}

	private static String percent(final String what, final double progress) {
		return progress >= 0 ? what + " " + Math.round(progress * 100) + "%" : what + "…";
	}
}
