package dev.minevibe.client.pc.screen;

import dev.minevibe.bridge.msg.Pc;

/** Pure helpers of PcConfigScreen's capability toggles (PLAN §8.8): what is on, and the phone's status line. */
public final class PcCapabilityText {
	private PcCapabilityText() {}

	public static boolean virtualizationOn(final Pc.PcInfo info) {
		return info.capabilities() != null && info.capabilities().virtualization().enabled();
	}

	public static boolean androidOn(final Pc.PcInfo info) {
		return info.capabilities() != null && info.capabilities().android().enabled();
	}

	/** "running · android-phone", "preparing 42% · downloading the Android image (45%)", "failed · …". */
	public static String phoneStatus(final Pc.AndroidCapability phone) {
		String s = "error".equals(phone.status()) ? "failed" : phone.status();
		if (phone.progress() != null) {
			s += " " + Math.round(phone.progress() * 100) + "%";
		}
		if ("running".equals(phone.status())) {
			s += " · android-phone";
		} else if (phone.detail() != null) {
			s += " · " + phone.detail();
		}
		return s;
	}
}
