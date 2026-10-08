package dev.minevibe.client.boot;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ClientBridge;
import dev.minevibe.client.ClientSession;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The only way into a world (PLAN §3 principle 4, §7.9). It replaces the title screen and the disconnected
 * screen, waits for Node's {@code world.open} and then opens or creates that world; a {@code world.next} for a
 * dead world (the game restarted on Game Over) goes to the Game Over screen instead.
 *
 * <p>It never waits forever on one message: while nothing arrives it says {@code hello} again every
 * {@link #RESYNC_EVERY_NANOS} (Node answers with the world to open), and an attempt to open a world that neither
 * changed the screen nor started the integrated server is given up after {@link #ACTING_TIMEOUT_NANOS}.
 */
public final class BootScreen extends Screen {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Boot");
	/** The first resync, when nothing arrived this long after the screen appeared. */
	static final long FIRST_RESYNC_NANOS = TimeUnit.SECONDS.toNanos(2);
	/** Later resyncs while still waiting. */
	static final long RESYNC_EVERY_NANOS = TimeUnit.SECONDS.toNanos(5);
	/** An open/create attempt that left this screen in place with no server running is over after this long. */
	static final long ACTING_TIMEOUT_NANOS = TimeUnit.SECONDS.toNanos(10);
	private static final int BACKGROUND = 0xFF0E1116;

	private final @Nullable Component note;
	private final @Nullable Component problem;
	private Component status = Component.literal("Waking up…");
	private long shownAt;
	private long lastResyncAt;
	private int resyncs;
	private boolean acting;
	private long actingSince;
	private Messages.@Nullable WorldOpen opening;
	private int openDelay;
	private String loggedState = "";

	public BootScreen() {
		this(null, null);
	}

	/** @param problem shown under the status, e.g. why the previous attempt failed */
	public BootScreen(@Nullable Component problem) {
		this(null, problem);
	}

	private BootScreen(@Nullable Component note, @Nullable Component problem) {
		super(Component.literal("MineVibe"));
		this.note = note;
		this.problem = problem;
	}

	/** A BootScreen with a neutral line under the status, e.g. "Waking up World #3…" after Begin. */
	public static BootScreen waiting(Component note) {
		return new BootScreen(note, null);
	}

	@Override
	protected void init() {
		if (shownAt == 0) {
			shownAt = System.nanoTime();
			// Shown without a world: whatever load was under way has ended (vanilla falls back to a screen like this
			// one when creating or opening fails), so a new world.open for the same world must not count as
			// "already loading".
			if (minecraft.level == null && ClientSession.get().clearStaleLoad(minecraft.getSingleplayerServer() != null, shownAt)) {
				LOG.warn("The last world load ended without a world");
			}
		}
		addRenderableWidget(Button.builder(Component.literal("Quit MineVibe"), b -> minecraft.stop())
				.bounds(width / 2 - 100, height - 36, 200, 20)
				.build());
	}

	@Override
	public void tick() {
		long now = System.nanoTime();
		if (acting) {
			// The open/create normally replaces this screen (loading screen, world, Game Over, or a new BootScreen on
			// failure). Still here, with no server and no world, long after: the attempt died quietly. Try again.
			if (now - actingSince > ACTING_TIMEOUT_NANOS && minecraft.level == null && minecraft.getSingleplayerServer() == null) {
				LOG.warn("Opening the world did not start; asking MineVibe again");
				acting = false;
				lastResyncAt = 0;
			}
			return;
		}
		ClientSession session = ClientSession.get();
		if (opening != null) {
			// Let a frame show "Waking up World #N…" before the (blocking) load starts.
			if (--openDelay <= 0) {
				Messages.WorldOpen open = opening;
				opening = null;
				if (session.claimPendingOpen(open)) {
					acting = true;
					actingSince = now;
					LOG.info("Waking up World #{} ({})", open.gen(), open.worldId());
					minecraft.schedule(() -> launch(open));
				}
			}
			return;
		}
		if (minecraft.gui.overlay() != null) {
			status = Component.literal("Loading…");
			logState("waiting for the loading overlay");
			return;
		}
		if (minecraft.level == null) {
			Messages.WorldNext next = session.takeUnshownNext();
			if (next != null) {
				acting = true;
				actingSince = now;
				LOG.info("World {} is dead: showing Game Over", next.summary().worldId());
				minecraft.gui.setScreen(GameOverScreen.fromNext(next));
				return;
			}
			Messages.WorldOpen open = session.peekPendingOpen();
			if (open != null && session.isAwaitingCloseAck(open.worldId())) {
				// Node has not taken the close of this dead world yet (it may still be processing the death); the
				// next world's world.open follows the acknowledgement.
				session.claimPendingOpen(open);
				LOG.info("Not reopening {}: it was just closed and Node has not acknowledged that yet", open.worldId());
				open = null;
			}
			if (open != null) {
				status = Component.literal("Waking up World #" + open.gen() + "…");
				opening = open;
				openDelay = 2;
				return;
			}
		}

		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			status = Component.literal("Not connected to MineVibe (no -Dminevibe.bridgeFile).");
			logState("no bridge configured");
		} else if (!bridge.isConnected()) {
			status = Component.literal("Waiting for MineVibe…");
			logState("waiting for the bridge");
		} else {
			logState("waiting for world.open");
			status = Component.literal("Waking up…");
			if (bridge.isHandshaken() && dueForResync(now)) {
				// Node sends world.open (or world.next) after every hello. This screen can appear long after the
				// connection's hello (a disconnect, a failed open), and a message can be lost, so ask again until
				// something arrives.
				lastResyncAt = now;
				resyncs++;
				if (resyncs == 1 || resyncs % 12 == 0) LOG.info("Asking MineVibe for the world again (#{})", resyncs);
				bridge.send(Messages.HELLO, ClientBridge.hello());
			}
		}
	}

	private boolean dueForResync(long now) {
		if (now - shownAt < FIRST_RESYNC_NANOS) return false;
		return lastResyncAt == 0 || now - lastResyncAt >= RESYNC_EVERY_NANOS;
	}

	/** Runs as a queued client task: opens or creates the world, and never leaves this screen stuck on failure. */
	private void launch(Messages.WorldOpen open) {
		try {
			WorldLauncher.openOrCreate(minecraft, open);
		} catch (RuntimeException e) {
			LOG.error("Could not open World #{} ({})", open.gen(), open.worldId(), e);
			ClientSession.get().loadFailed(open.worldId());
			String why = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
			minecraft.gui.setScreen(new BootScreen(Component.literal("World #" + open.gen() + " could not be opened: " + why)));
		}
	}

	/** Logs what the screen waits for, once per change. */
	private void logState(String state) {
		if (!state.equals(loggedState)) {
			loggedState = state;
			LOG.info("BootScreen: {}", state);
		}
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		graphics.fill(0, 0, width, height, BACKGROUND);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		super.extractRenderState(graphics, mouseX, mouseY, a);
		int y = height / 2 - 24;
		graphics.centeredText(font, title, width / 2, y, 0xFFFFFFFF);
		graphics.centeredText(font, status, width / 2, y + 20, 0xFFB8C0CC);
		if (note != null) graphics.centeredText(font, note, width / 2, y + 36, 0xFFB8C0CC);
		if (problem != null) graphics.centeredText(font, problem, width / 2, y + (note != null ? 52 : 36), 0xFFFF8080);
	}

	@Override
	public boolean shouldCloseOnEsc() {
		return false;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	/** The status line (for E2E snapshots and logs). */
	public Component status() {
		return status;
	}
}
