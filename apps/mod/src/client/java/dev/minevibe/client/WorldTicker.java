package dev.minevibe.client;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.msg.World;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.ProtocolException;
import dev.minevibe.client.pc.PcSeatWatcher;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.hardcore.HardcoreHooks;
import dev.minevibe.org.office.OfficeService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reports the world to Node from the client tick (protocol §6.4, §7.2): {@code world.state{ready}} once the player is
 * standing in a loaded world, then a push every second with the overworld clock and the {@code player} snapshot
 * (position, HP, food, combat, idle time, open screen, the PC the player sits at). The office layout
 * ({@code office}, slot kinds as in {@link dev.minevibe.org.office.OfficeLayout}, {@code workstation} included) rides
 * on the first push of each connection and again whenever it changes, so Node always has it without a separate
 * message. It also keeps {@link ClientSession} honest: the {@code hello} snapshot, and a "loading" flag that outlived
 * {@link ClientSession#LOAD_TIMEOUT_NANOS} is dropped, so the next {@code world.open} is acted on.
 */
public final class WorldTicker {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/World");
	private static int ticks;
	/** Bumped on every handshake (bridge threads): the office goes out again on each new connection. */
	private static final AtomicInteger CONNECTION = new AtomicInteger();
	private static final OfficeReport OFFICE = new OfficeReport();
	private static @Nullable BridgeClient attachedTo;

	private WorldTicker() {}

	/** Counts handshakes on {@code bridge} (MineVibeClient calls this before {@code bridge.start()}). Idempotent. */
	public static synchronized void attach(BridgeClient bridge) {
		if (attachedTo == bridge) return;
		attachedTo = bridge;
		bridge.addListener(new BridgeClient.ConnectionListener() {
			@Override
			public void onHandshake(Messages.HelloOk helloOk) {
				CONNECTION.incrementAndGet();
			}
		});
	}

	public static void onEndTick(Minecraft mc) {
		ClientSession session = ClientSession.get();
		IntegratedServer server = mc.getSingleplayerServer();
		// The hello snapshot (bridge threads build hello from it, never from Minecraft itself).
		session.publishLevelLoaded(mc.level != null);
		PlayerActivity.get().tick(mc);
		if (mc.level == null || mc.player == null || server == null || mc.gui.overlay() != null) {
			if (mc.level == null) {
				// No world yet is not a failed load: opening an existing world resumes on a background executor
				// (WorldOpenFlows#openWorld) with no integrated server for a while. Only the timeout ends a load here.
				if (session.expireLoad(System.nanoTime())) {
					LOG.warn("Loading {} ended without a world (failed or timed out)", session.worldId());
				} else if (!session.loading()) {
					session.leftWorld();
				}
			}
			return;
		}
		// The save folder name is the world id (worlds are created with levelId = worldId).
		String id = HardcoreHooks.levelId(server);
		BridgeClient bridge = MineVibeBridge.get();
		if (!session.isReady(id)) {
			boolean fresh = session.fresh();
			long startedNanos = session.loadStartedNanos();
			session.markReady(id);
			BlockPos pos = mc.player.blockPosition();
			LOG.info(
					"World {} ready{} in {} ms (hardcore={}, difficulty={}, mode={})",
					id,
					fresh ? " (new)" : "",
					startedNanos == 0 ? -1 : TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos),
					mc.level.getLevelData().isHardcore(),
					mc.level.getLevelData().getDifficulty().getSerializedName(),
					mc.gameMode != null ? mc.gameMode.getPlayerMode().getSerializedName() : "?");
			if (bridge != null && Messages.isWorldId(id)) {
				send(mc, bridge, id, fresh, new Messages.BlockPos(pos.getX(), pos.getY(), pos.getZ()));
			}
			ticks = 0;
			return;
		}
		if (++ticks % 20 == 0 && bridge != null && Messages.isWorldId(id)) {
			send(mc, bridge, id, null, null);
		}
	}

	/** One {@code world.state{ready}}: the clock and the player always, the office when Node may not have it yet. */
	private static void send(Minecraft mc, BridgeClient bridge, String id, @Nullable Boolean fresh, Messages.@Nullable BlockPos spawn) {
		OfficeService.Published office = OfficeService.published();
		String officeKey = office == null || !office.levelId().equals(id) ? null : OfficeReport.key(id, CONNECTION.get(), office.layout().hashCode());
		JsonObject officeJson = OFFICE.due(officeKey) ? office.layout().toWorldState() : null;
		long clock = dev.minevibe.agent.skill.WorldClock.overworldClockTime(mc.level.getOverworldClockTime());
		boolean sent;
		try {
			sent = bridge.send(Messages.WORLD_STATE, new Messages.WorldState(id, Messages.WorldState.READY, fresh, spawn, officeJson, clock, player(mc)));
		} catch (ProtocolException e) {
			// Never lose the ready/clock push over a snapshot the schema refuses: send it without the extras.
			LOG.warn("world.state with the player snapshot did not validate ({}); sending it without", e.getMessage());
			sent = bridge.send(Messages.WORLD_STATE, new Messages.WorldState(id, Messages.WorldState.READY, fresh, spawn, null, clock, null));
			officeJson = null;
		}
		if (sent && officeJson != null) {
			OFFICE.sent(officeKey);
			LOG.info("Told Node where the office of {} is ({} slots)", id, office.layout().slots().size());
		}
	}

	/** The {@code world.state.player} snapshot (client thread), or null without a player. */
	static World.@Nullable PlayerState player(Minecraft mc) {
		LocalPlayer p = mc.player;
		if (p == null || mc.level == null) return null;
		String seatedPc = PcSeatWatcher.seatedPc();
		return new World.PlayerState(
				new Types.Vec3(p.getX(), p.getY(), p.getZ()),
				mc.level.dimension().identifier().toString(),
				clamp(p.getHealth(), 0, 1024),
				clamp(p.getMaxHealth(), 0, 1024),
				Math.clamp(p.getFoodData().getFoodLevel(), 0, 20),
				AgentEntities.playerInCombat(mc),
				PlayerActivity.get().idleMs(),
				screenName(mc.gui.screen()),
				seatedPc != null && seatedPc.matches(Types.PC_ID_REGEX) ? seatedPc : null);
	}

	/** The open screen's simple class name ({@code PcControlScreen}), or null in game. */
	static @Nullable String screenName(@Nullable Screen screen) {
		return screen == null ? null : screenName(screen.getClass());
	}

	static @Nullable String screenName(Class<?> type) {
		String name = type.getSimpleName();
		if (name.isEmpty()) {
			// An anonymous screen: its class name after the package ("Outer$1").
			String full = type.getName();
			name = full.substring(full.lastIndexOf('.') + 1);
		}
		return name.isEmpty() ? null : name.length() > 64 ? name.substring(0, 64) : name;
	}

	private static double clamp(float v, double min, double max) {
		return Float.isFinite(v) ? Math.clamp(v, min, max) : min;
	}

	/** Which office layout Node already has on the current connection. */
	static final class OfficeReport {
		private @Nullable String sentKey;

		static String key(String worldId, int connection, int layoutHash) {
			return worldId + "#" + connection + "#" + layoutHash;
		}

		/** True when the office with this key ({@code null}: none) still has to go out. */
		boolean due(@Nullable String key) {
			return key != null && !key.equals(this.sentKey);
		}

		void sent(String key) {
			this.sentKey = key;
		}
	}
}
