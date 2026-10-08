package dev.minevibe.client.pc;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.client.pc.compat.PcFlawlessFrames;
import dev.minevibe.client.pc.demo.PcDemo;
import dev.minevibe.client.pc.frame.FrameDecoder;
import dev.minevibe.client.pc.frame.MonitorTextures;
import dev.minevibe.client.pc.frame.PcStats;
import dev.minevibe.client.pc.render.PcBlockEntityRenderer;
import dev.minevibe.client.pc.screen.PcConfigScreen;
import dev.minevibe.client.pc.screen.PcWatchScreen;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcBridge;
import dev.minevibe.pc.PcClientHooks;
import dev.minevibe.pc.PcContent;
import dev.minevibe.pc.PcDeskBlock;
import dev.minevibe.pc.PcStates;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientBlockEntityEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderers;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import org.jspecify.annotations.Nullable;

/**
 * Client entrypoint for PCs in the world (PLAN 7.6-7.7, track T2): the monitor renderer, the MVF1 frame decoder
 * (installed as the bridge's frame sink), the player-at-a-PC flow (PcSeatWatcher, PcControlScreen, "Kick Bram and
 * sit?"), the frame tiers ({@code pc.view}), the config and watch screens, and the FREX flawless-frames switch.
 *
 * <p>The PC group's bridge handlers ({@code pc.state}, {@code budget.state}, {@code pc.cursor}) are common code
 * ({@code PcBridge}, registered when the bridge is installed). What the client adds to the bridge (the frame sink,
 * the frame-tier resend after each handshake, the texture clean-up for removed PCs) goes in by {@link #attach}, which
 * {@code MineVibeClient} calls before {@code bridge.start()}: frames and the {@code hello.ok} snapshot can arrive
 * before this entrypoint runs.
 */
public final class PcClientInit implements ClientModInitializer {
	private static boolean hadLevel;
	private static boolean attached;

	@Override
	public void onInitializeClient() {
		BlockEntityRenderers.register(PcContent.PC_BLOCK_ENTITY, PcBlockEntityRenderer::new);
		PcClientHooks.install(new PcClientHooks() {
			@Override
			public void openConfig(final String pcId) {
				Minecraft.getInstance().gui.setScreen(new PcConfigScreen(pcId));
			}

			@Override
			public void openWatch(final String pcId) {
				Minecraft.getInstance().gui.setScreen(new PcWatchScreen(pcId));
			}
		});

		// MineVibeClient attaches before it starts the bridge; this is the fallback for any other order.
		attach(MineVibeBridge.get());
		UseBlockCallback.EVENT.register(PcChairInteraction::onUseBlock);

		ClientBlockEntityEvents.BLOCK_ENTITY_LOAD.register((be, level) -> {
			if (be instanceof PcBlockEntity desk) {
				PcClientMonitors.loaded(desk);
			}
		});
		ClientBlockEntityEvents.BLOCK_ENTITY_UNLOAD.register((be, level) -> {
			if (be instanceof PcBlockEntity desk) {
				PcClientMonitors.unloaded(desk);
			}
		});
		ClientTickEvents.END_CLIENT_TICK.register(PcClientInit::tick);
		LevelRenderEvents.END_MAIN.register(context -> PcStats.endFrame(Minecraft.getInstance().getFps()));
		// The monitor's selection box would cut through the picture (its edge sits on the column boundary, in front of
		// the screen): no outline on the monitor blocks; the desk below still shows one.
		LevelRenderEvents.BEFORE_BLOCK_OUTLINE.register((context, outline) -> {
			ClientLevel level = Minecraft.getInstance().level;
			if (level == null) {
				return true;
			}
			BlockState state = level.getBlockState(outline.pos());
			return !(state.getBlock() instanceof PcDeskBlock) || state.getValue(PcDeskBlock.HALF) != DoubleBlockHalf.UPPER;
		});
		PcDemo.init();
	}

	/**
	 * Hooks the PC client into the bridge (null: no bridge, the hooks still go in for the demo): the MVF1 decoder as
	 * the frame sink, the frame-tier resend after each handshake, and freeing the monitor texture of a PC that is
	 * decommissioned or that a {@code hello.ok} snapshot no longer lists. Idempotent; call before {@code start()}.
	 */
	public static synchronized void attach(final @Nullable BridgeClient bridge) {
		if (attached) {
			return;
		}
		attached = true;
		FrameDecoder decoder = new FrameDecoder(
			PcStates::pcIdForSlot,
			MonitorTextures::frameFor,
			(pcId, seq) -> PcBridge.send(Pc.PC_FRAME_ACK, new Pc.PcFrameAck(pcId, seq)),
			2
		);
		MineVibeBridge.setFrameSink(decoder);
		PcBridge.onHandshake(PcViewTracker::resendAll);
		PcStates.addListener(info -> {
			if ("decommissioned".equals(info.status())) {
				Minecraft.getInstance().execute(() -> MonitorTextures.release(info.pcId()));
			}
		});
		// A PC a hello.ok snapshot no longer lists (deleted while the bridge was down): free its GPU texture too.
		PcStates.addRemovalListener(pcId -> Minecraft.getInstance().execute(() -> MonitorTextures.release(pcId)));
	}

	private static void tick(final Minecraft mc) {
		boolean hasLevel = mc.level != null;
		if (hadLevel && !hasLevel) {
			// Left the world: free the monitor textures, forget the trackers (pc.view drops to none below).
			MonitorTextures.releaseAll();
			PcClientMonitors.clear();
			PcSeatWatcher.reset();
		}
		hadLevel = hasLevel;
		PcSeatWatcher.tick(mc);
		PcViewTracker.tick(mc);
		PcFlawlessFrames.set(PcViewTracker.focused() != null);
		PcDemo.tick(mc);
	}
}
