package dev.minevibe.client.boot;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ClientSession;
import dev.minevibe.hardcore.DeathRecord;
import dev.minevibe.hardcore.HardcoreHooks;
import java.util.concurrent.TimeUnit;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Replaces the death screen (PLAN §7.9): the world number, the day and the cause of death, and
 * <b>[Begin World #N+1]</b>. The button enables once Node sends {@code world.next} (the next world is durably
 * allocated) or after 10 s with what the mod knows locally. Begin closes the dead world (blocking until the
 * integrated server has stopped), reports it {@code closed}, and creates the next world.
 *
 * <p>Also shown without a loaded world when the game restarts on Game Over: from the world's dead marker, or from
 * Node's {@code world.next}.
 */
public final class GameOverScreen extends Screen {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Boot");
	/** Begin enables after this long even without {@code world.next}. */
	public static final long FALLBACK_NANOS = TimeUnit.SECONDS.toNanos(10);

	private final String worldId;
	private int gen;
	private @Nullable Component cause;
	private int day;
	private Messages.@Nullable WorldNext next;
	private final long since;
	private @Nullable Button begin;
	private boolean beginRequested;
	private boolean beginning;

	private GameOverScreen(String worldId, int gen, @Nullable Component cause, int day, Messages.@Nullable WorldNext next) {
		super(Component.literal("Game Over"));
		this.worldId = worldId;
		this.gen = gen;
		this.cause = cause;
		this.day = day;
		this.next = next;
		this.since = ClientSession.get().gameOverSince(worldId);
	}

	/** In the dead world, replacing vanilla's {@code DeathScreen}. */
	public static GameOverScreen afterDeath(Minecraft mc, @Nullable Component cause) {
		ClientSession session = ClientSession.get();
		String id = session.worldId();
		IntegratedServer server = mc.getSingleplayerServer();
		if (id == null && server != null) id = HardcoreHooks.levelId(server);
		if (id == null) id = "unknown";
		int day = mc.level != null ? (int) Math.min(Integer.MAX_VALUE, Math.max(0L, mc.level.getOverworldClockTime()) / 24000L + 1L) : 0;
		return new GameOverScreen(id, session.gen(), cause, day, session.nextFor(id));
	}

	/** From the dead marker of a world that is not loaded (the game restarted on Game Over). */
	public static GameOverScreen fromMarker(String worldId, int gen, DeathRecord death) {
		return new GameOverScreen(worldId, gen, Component.literal(death.cause()), death.day(), ClientSession.get().nextFor(worldId));
	}

	/** From Node's {@code world.next} (the game restarted on Game Over and Node already knows). */
	public static GameOverScreen fromNext(Messages.WorldNext next) {
		ClientSession.get().markNextShown();
		Messages.WorldNext.Summary s = next.summary();
		return new GameOverScreen(s.worldId(), s.gen(), Component.literal(s.cause()), s.day(), next);
	}

	@Override
	protected void init() {
		int cx = width / 2;
		begin = addRenderableWidget(Button.builder(beginLabel(), b -> requestBegin())
				.bounds(cx - 100, height / 2 + 52, 200, 20)
				.build());
		begin.active = canBegin();
		addRenderableWidget(Button.builder(Component.literal("Quit MineVibe"), b -> minecraft.stop())
				.bounds(cx - 100, height / 2 + 76, 200, 20)
				.build());
	}

	@Override
	public void tick() {
		DeathRecord last = HardcoreHooks.lastDeath();
		if (last != null && last.worldId().equals(worldId)) {
			if (cause == null) cause = Component.literal(last.cause());
			if (day <= 0) day = last.day();
		}
		if (next == null) next = ClientSession.get().nextFor(worldId);
		if (gen <= 0 && next != null) gen = next.summary().gen();
		if (begin != null) {
			begin.active = canBegin();
			begin.setMessage(beginLabel());
		}
		if (beginRequested && !beginning) {
			beginning = true;
			// World transitions run as queued tasks, never inside a screen tick.
			minecraft.schedule(this::doBegin);
		}
	}

	/** Node sent {@code world.next}. */
	public void onWorldNext(Messages.WorldNext worldNext) {
		if (worldNext.summary().worldId().equals(worldId)) {
			next = worldNext;
			ClientSession.get().markNextShown();
		}
	}

	/** Begin is enabled: after {@code world.next}, or 10 s after Game Over first showed. */
	public boolean canBegin() {
		return !beginRequested && (next != null || System.nanoTime() - since >= FALLBACK_NANOS);
	}

	/** Presses Begin (button or E2E). Returns false when it is not enabled. */
	public boolean requestBegin() {
		if (!canBegin()) return false;
		beginRequested = true;
		if (begin != null) begin.active = false;
		return true;
	}

	private void doBegin() {
		Messages.WorldNext n = next != null ? next : ClientSession.get().nextFor(worldId);
		long t0 = System.nanoTime();
		LOG.info("Begin: closing {}", worldId);
		if (minecraft.level != null || minecraft.getSingleplayerServer() != null) {
			WorldLauncher.leaveWorld(minecraft);
		}
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge != null && Messages.isWorldId(worldId)) {
			bridge.send(Messages.WORLD_STATE, Messages.WorldState.phase(worldId, Messages.WorldState.CLOSED));
		}
		ClientSession.get().markClosed(worldId);
		LOG.info("World {} closed in {} ms", worldId, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0));
		if (n != null) {
			WorldLauncher.openOrCreate(minecraft, new Messages.WorldOpen(n.worldId(), n.gen(), true, true, "hard", null));
		} else {
			minecraft.gui.setScreen(new BootScreen(Component.literal("Waiting for the next world…")));
		}
	}

	private Component beginLabel() {
		int nextGen = next != null ? next.gen() : gen > 0 ? gen + 1 : 0;
		return Component.literal(nextGen > 0 ? "Begin World #" + nextGen : "Begin the next world");
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		if (minecraft.level == null) graphics.fill(0, 0, width, height, 0xFF140606);
		graphics.fillGradient(0, 0, width, height, 0x60500000, 0xA0803030);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float a) {
		super.extractRenderState(graphics, mouseX, mouseY, a);
		int cx = width / 2;
		int y = height / 2 - 70;
		graphics.centeredText(font, Component.literal("Game Over").withStyle(ChatFormatting.BOLD), cx, y, 0xFFFF5555);
		y += 20;
		String world = gen > 0 ? "World #" + gen : "This world";
		graphics.centeredText(font, Component.literal(world + " has ended" + (day > 0 ? " on day " + day : "") + "."), cx, y, 0xFFFFFFFF);
		y += 14;
		if (cause != null) {
			graphics.centeredText(font, cause, cx, y, 0xFFE0E0E0);
			y += 14;
		}
		if (next != null && !next.summary().crewFates().isEmpty()) {
			for (Messages.WorldNext.CrewFate fate : next.summary().crewFates()) {
				String line = fate.name() + " (" + fate.role() + "): " + fate.fate().replace('_', ' ')
						+ (fate.detail() != null ? " - " + fate.detail() : "");
				graphics.centeredText(font, Component.literal(line), cx, y, 0xFFB0B0B0);
				y += 11;
			}
		}
		graphics.centeredText(
				font,
				Component.literal("The world and the crew die. Your machines, the Vault and the Codex survive."),
				cx,
				height / 2 + 34,
				0xFFB8B8B8);
		if (beginRequested) {
			graphics.centeredText(font, Component.literal("Closing " + world + "…"), cx, height / 2 + 102, 0xFFB8B8B8);
		}
	}

	@Override
	public boolean shouldCloseOnEsc() {
		return false;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	public String worldId() {
		return worldId;
	}
}
