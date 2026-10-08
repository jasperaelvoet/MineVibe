package dev.minevibe.client;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.hardcore.HardcoreHooks;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reports the world to Node from the client tick: {@code world.state{ready}} once the player is standing in a
 * loaded world, then the overworld clock at 1 Hz (protocol §6.4).
 */
public final class WorldTicker {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/World");
	private static int ticks;

	private WorldTicker() {}

	public static void onEndTick(Minecraft mc) {
		ClientSession session = ClientSession.get();
		IntegratedServer server = mc.getSingleplayerServer();
		if (mc.level == null || mc.player == null || server == null || mc.gui.overlay() != null) {
			if (mc.level == null && !session.loading()) session.leftWorld();
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
				bridge.send(Messages.WORLD_STATE, new Messages.WorldState(
						id,
						Messages.WorldState.READY,
						fresh,
						new Messages.BlockPos(pos.getX(), pos.getY(), pos.getZ()),
						null,
						Math.max(0L, mc.level.getOverworldClockTime())));
			}
			ticks = 0;
			return;
		}
		if (++ticks % 20 == 0 && bridge != null && Messages.isWorldId(id)) {
			bridge.send(Messages.WORLD_STATE, new Messages.WorldState(
					id, Messages.WorldState.READY, null, null, null, Math.max(0L, mc.level.getOverworldClockTime())));
		}
	}
}
