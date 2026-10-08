package dev.minevibe.client;

import dev.minevibe.MineVibeMod;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.client.boot.BootScreen;
import dev.minevibe.client.boot.GameOverScreen;
import dev.minevibe.client.boot.WorldLauncher;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** The client's bridge handlers for the M1 world and UI messages, and the {@code hello} it opens with. */
public final class ClientBridge {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Bridge");

	/** Mod and Minecraft versions: constant for the JVM's life, read once on the client thread. */
	private static volatile @Nullable String modVersion;
	private static volatile @Nullable String mcVersion;

	private ClientBridge() {}

	/**
	 * Reads the constants {@code hello} needs on the client thread. Call during client init; {@link #hello()} falls
	 * back to placeholders until then.
	 */
	public static void initHelloConstants() {
		modVersion = FabricLoader.getInstance()
				.getModContainer(MineVibeMod.MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString())
				.orElse("0.0.0");
		mcVersion = SharedConstants.getCurrentVersion().name();
	}

	/**
	 * Builds {@code hello}: {@code boot} on BootScreen / Game Over without a world, {@code in_world} otherwise. Runs
	 * on bridge threads (every new connection), so it reads only the snapshot the client tick publishes in
	 * {@link ClientSession}, never {@code Minecraft} itself.
	 */
	public static Messages.Hello hello() {
		ClientSession session = ClientSession.get();
		String worldId = session.helloWorldId();
		String name = session.playerName();
		String mod = modVersion;
		String mc = mcVersion;
		return new Messages.Hello(
				ProtocolCodec.clip(mod != null ? mod : "0.0.0", 64),
				ProtocolCodec.clip(mc != null ? mc : "unknown", 32),
				worldId != null ? Messages.Hello.PHASE_IN_WORLD : Messages.Hello.PHASE_BOOT,
				worldId,
				Messages.isPlayerName(name) ? name : null);
	}

	public static void register(BridgeClient bridge) {
		bridge.on(Messages.HELLO_OK, Route.BRIDGE, ok -> LOG.info(
				"MineVibe {} says: world {}",
				ok.server().version(),
				ok.world() == null ? "not decided" : ok.world().id() + " (#" + ok.world().gen() + (ok.world().fresh() ? ", new" : "") + ")"));
		bridge.on(Messages.WORLD_OPEN, Route.CLIENT, ClientBridge::onWorldOpen);
		bridge.on(Messages.WORLD_NEXT, Route.CLIENT, ClientBridge::onWorldNext);
		// ui.toast, agent.say and the rest of the UI group: dev.minevibe.client.ui.UiClientInit (one handler per type).
		bridge.on(Messages.SERVER_SHUTDOWN, Route.BRIDGE, s -> LOG.info("MineVibe is shutting down ({})", s.reason()));
	}

	private static void onWorldOpen(Messages.WorldOpen open) {
		Minecraft mc = Minecraft.getInstance();
		ClientSession session = ClientSession.get();
		String id = open.worldId();
		long now = System.nanoTime();
		boolean serverExists = mc.getSingleplayerServer() != null;
		if (mc.level == null && session.clearStaleLoad(serverExists, now)) {
			LOG.warn("Loading {} is no longer in progress (it failed or timed out)", session.worldId());
		}
		boolean same = id.equals(session.worldId());
		if (same && (mc.level != null || session.isLoadInProgress(id, serverExists, now))) {
			LOG.debug("world.open {}: already there", id);
			return;
		}
		if (mc.level != null) {
			// Node expects a different world than the one that is open: close it and boot the right one.
			LOG.warn("Node asks for {} while {} is open; switching", id, session.worldId());
			session.offerOpen(open);
			WorldLauncher.leaveWorld(mc);
			mc.gui.setScreen(new BootScreen());
			return;
		}
		// Without a level the screen is always BootScreen (or Game Over, or the startup screens that lead to
		// BootScreen); BootScreen takes the request from the session when it is ready to act on it.
		LOG.info("Node asks for World #{} ({}, {})", open.gen(), id, open.fresh() ? "new" : "existing");
		session.offerOpen(open);
	}

	private static void onWorldNext(Messages.WorldNext next) {
		Minecraft mc = Minecraft.getInstance();
		ClientSession session = ClientSession.get();
		session.offerNext(next);
		if (session.isClosedWorld(next.summary().worldId())) {
			// This client already closed that dead world (Begin) and is waiting for Node to take the closed.
			LOG.debug("world.next for {}, which is already closed; waiting for World #{}", next.summary().worldId(), next.gen());
			return;
		}
		LOG.info("Next world allocated: World #{} ({}) after {}", next.gen(), next.worldId(), next.summary().worldId());
		Screen screen = mc.gui.screen();
		if (screen instanceof GameOverScreen gameOver) {
			gameOver.onWorldNext(next);
		} else if (mc.level == null && screen instanceof BootScreen) {
			session.markNextShown();
			mc.gui.setScreen(GameOverScreen.fromNext(next));
		}
	}
}
