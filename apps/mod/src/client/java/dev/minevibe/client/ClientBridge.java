package dev.minevibe.client;

import dev.minevibe.MineVibeMod;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.boot.BootScreen;
import dev.minevibe.client.boot.GameOverScreen;
import dev.minevibe.client.boot.WorldLauncher;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.toasts.SystemToast;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** The client's bridge handlers for the M1 world and UI messages, and the {@code hello} it opens with. */
public final class ClientBridge {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Bridge");

	private ClientBridge() {}

	/** Builds {@code hello}: {@code boot} on BootScreen / Game Over without a world, {@code in_world} otherwise. */
	public static Messages.Hello hello() {
		Minecraft mc = Minecraft.getInstance();
		String mod = FabricLoader.getInstance()
				.getModContainer(MineVibeMod.MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString())
				.orElse("0.0.0");
		String mcVersion = SharedConstants.getCurrentVersion().name();
		String worldId = ClientSession.get().worldId();
		boolean inWorld = mc.level != null && Messages.isWorldId(worldId);
		String name = mc.getUser().getName();
		return new Messages.Hello(
				clip(mod, 64),
				clip(mcVersion, 32),
				inWorld ? Messages.Hello.PHASE_IN_WORLD : Messages.Hello.PHASE_BOOT,
				inWorld ? worldId : null,
				Messages.isPlayerName(name) ? name : null);
	}

	public static void register(BridgeClient bridge) {
		bridge.on(Messages.HELLO_OK, Route.BRIDGE, ok -> LOG.info(
				"MineVibe {} says: world {}",
				ok.server().version(),
				ok.world() == null ? "not decided" : ok.world().id() + " (#" + ok.world().gen() + (ok.world().fresh() ? ", new" : "") + ")"));
		bridge.on(Messages.WORLD_OPEN, Route.CLIENT, ClientBridge::onWorldOpen);
		bridge.on(Messages.WORLD_NEXT, Route.CLIENT, ClientBridge::onWorldNext);
		bridge.on(Messages.UI_TOAST, Route.CLIENT, toast -> SystemToast.add(
				Minecraft.getInstance().gui.toastManager(),
				SystemToast.SystemToastId.PERIODIC_NOTIFICATION,
				Component.literal("MineVibe"),
				Component.literal(toast.text())));
		// Bubbles arrive in M2; until then agent speech is only logged.
		bridge.on(Messages.AGENT_SAY, Route.BRIDGE, say -> LOG.debug("{} says {}", say.agentId(), say.text() != null ? say.text() : say.bark()));
		bridge.on(Messages.SERVER_SHUTDOWN, Route.BRIDGE, s -> LOG.info("MineVibe is shutting down ({})", s.reason()));
	}

	private static void onWorldOpen(Messages.WorldOpen open) {
		Minecraft mc = Minecraft.getInstance();
		ClientSession session = ClientSession.get();
		String id = open.worldId();
		boolean same = id.equals(session.worldId());
		if (same && (session.loading() || mc.level != null)) {
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
		LOG.info("Next world allocated: World #{} ({}) after {}", next.gen(), next.worldId(), next.summary().worldId());
		session.offerNext(next);
		Screen screen = mc.gui.screen();
		if (screen instanceof GameOverScreen gameOver) {
			gameOver.onWorldNext(next);
		} else if (mc.level == null && screen instanceof BootScreen) {
			session.markNextShown();
			mc.gui.setScreen(GameOverScreen.fromNext(next));
		}
	}

	private static String clip(String s, int max) {
		return s.length() <= max ? s : s.substring(0, max);
	}
}
