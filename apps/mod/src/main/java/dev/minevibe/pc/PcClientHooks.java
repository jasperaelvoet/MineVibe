package dev.minevibe.pc;

/**
 * What common PC code (blocks, items) asks of the client: open a screen. The client entrypoint installs the real
 * implementation ({@code dev.minevibe.client.pc.PcClientInit}); on a dedicated server or in GameTests it stays a
 * no-op. Called on the client thread only.
 */
public interface PcClientHooks {
	/** PcConfigScreen for {@code pcId} (sneak-use on the desk or monitor). */
	void openConfig(String pcId);

	/** Watch mode: the PC's screen full size, read-only (use on the monitor). */
	void openWatch(String pcId);

	PcClientHooks NOOP = new PcClientHooks() {
		@Override
		public void openConfig(final String pcId) {
		}

		@Override
		public void openWatch(final String pcId) {
		}
	};

	static PcClientHooks get() {
		return Holder.hooks;
	}

	static void install(final PcClientHooks hooks) {
		Holder.hooks = hooks != null ? hooks : NOOP;
	}

	/** Mutable slot for the installed hooks. */
	final class Holder {
		private static volatile PcClientHooks hooks = NOOP;

		private Holder() {}
	}
}
