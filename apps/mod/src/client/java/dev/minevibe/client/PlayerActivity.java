package dev.minevibe.client;

import java.util.function.LongSupplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

/**
 * When the player last did something (protocol §7.2 {@code world.state.player.idleMs}; Node's AFK rule is 5 min of
 * it, PLAN §6.6). Input is any key event (observed in {@code KeyboardHandler#keyPress}, so typing in chat or at a PC
 * counts), a mouse move, or the player turning. Walking needs a key, so it is covered. Client thread only.
 */
public final class PlayerActivity {
	private static final PlayerActivity INSTANCE = new PlayerActivity(System::nanoTime);

	private final LongSupplier clock;
	private long lastInputNanos;
	private double mouseX = Double.NaN;
	private double mouseY = Double.NaN;
	private float yRot = Float.NaN;
	private float xRot = Float.NaN;

	PlayerActivity(final LongSupplier clock) {
		this.clock = clock;
		this.lastInputNanos = clock.getAsLong();
	}

	public static PlayerActivity get() {
		return INSTANCE;
	}

	/** A key event (press, repeat or release). */
	public void noteInput() {
		this.lastInputNanos = this.clock.getAsLong();
	}

	/** Every client tick: a moved mouse or a turned player counts as input. */
	public void tick(final Minecraft mc) {
		LocalPlayer player = mc.player;
		this.observe(mc.mouseHandler.xpos(), mc.mouseHandler.ypos(), player == null ? Float.NaN : player.getYRot(), player == null ? Float.NaN : player.getXRot());
	}

	/** One observation of the mouse position and the player's rotation (NaN without a player). */
	void observe(final double mx, final double my, final float y, final float x) {
		boolean first = Double.isNaN(this.mouseX);
		boolean moved = !first && (mx != this.mouseX || my != this.mouseY);
		boolean turned = !Float.isNaN(this.yRot) && !Float.isNaN(y) && (y != this.yRot || x != this.xRot);
		this.mouseX = mx;
		this.mouseY = my;
		this.yRot = y;
		this.xRot = x;
		if (moved || turned) {
			this.noteInput();
		}
	}

	/** Milliseconds since the last input. */
	public long idleMs() {
		return Math.max(0L, (this.clock.getAsLong() - this.lastInputNanos) / 1_000_000L);
	}
}
