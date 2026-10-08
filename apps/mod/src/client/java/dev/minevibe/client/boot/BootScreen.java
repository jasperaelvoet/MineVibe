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
 */
public final class BootScreen extends Screen {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Boot");
	/** Ask Node for the world again if nothing arrived this long after the screen appeared. */
	private static final long RESYNC_AFTER_NANOS = TimeUnit.SECONDS.toNanos(2);
	private static final int BACKGROUND = 0xFF0E1116;

	private final @Nullable Component problem;
	private Component status = Component.literal("Waking up…");
	private long shownAt;
	private boolean resynced;
	private boolean acting;
	private Messages.@Nullable WorldOpen opening;
	private int openDelay;
	private String loggedState = "";

	public BootScreen() {
		this(null);
	}

	/** @param problem shown under the status, e.g. why the previous attempt failed */
	public BootScreen(@Nullable Component problem) {
		super(Component.literal("MineVibe"));
		this.problem = problem;
	}

	@Override
	protected void init() {
		if (shownAt == 0) shownAt = System.nanoTime();
		addRenderableWidget(Button.builder(Component.literal("Quit MineVibe"), b -> minecraft.stop())
				.bounds(width / 2 - 100, height - 36, 200, 20)
				.build());
	}

	@Override
	public void tick() {
		if (acting) return;
		ClientSession session = ClientSession.get();
		if (opening != null) {
			// Let a frame show "Waking up World #N…" before the (blocking) load starts.
			if (--openDelay <= 0) {
				Messages.WorldOpen open = opening;
				opening = null;
				if (session.claimPendingOpen(open)) {
					acting = true;
					LOG.info("Waking up World #{} ({})", open.gen(), open.worldId());
					minecraft.schedule(() -> WorldLauncher.openOrCreate(minecraft, open));
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
				LOG.info("World {} is dead: showing Game Over", next.summary().worldId());
				minecraft.gui.setScreen(GameOverScreen.fromNext(next));
				return;
			}
			Messages.WorldOpen open = session.peekPendingOpen();
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
			if (!resynced && bridge.isHandshaken() && System.nanoTime() - shownAt > RESYNC_AFTER_NANOS) {
				// Node sends world.open after hello; this screen can appear long after the connection's hello
				// (a disconnect, a failed open), so say hello again to get it.
				resynced = true;
				LOG.info("Asking MineVibe for the world again");
				bridge.send(Messages.HELLO, ClientBridge.hello());
			}
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
		if (problem != null) graphics.centeredText(font, problem, width / 2, y + 36, 0xFFFF8080);
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
