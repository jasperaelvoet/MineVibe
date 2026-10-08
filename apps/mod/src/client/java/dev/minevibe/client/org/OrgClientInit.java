package dev.minevibe.client.org;

import dev.minevibe.MineVibeMod;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.org.calendar.CalendarScreen;
import dev.minevibe.client.org.codex.CodexScreen;
import dev.minevibe.client.org.meeting.MeetingHud;
import dev.minevibe.client.org.render.CodexBookRenderer;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.OrgScreens;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.blockentity.BlockEntityRenderers;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint for the org tools (PLAN §6.6, §7.5, §7.8): opens CodexScreen and CalendarScreen from the blocks
 * and the calendar item, renders the codex's open book and the meeting HUD, keeps {@link OrgClientState} fed from the
 * bridge ({@code codex.index}, {@code calendar.state}, {@code meeting.state}), and reports the office to Node.
 * {@code -Dminevibe.org.fake=true} answers the screens from an in-memory {@link FakeOrgBackend} instead of Node.
 */
public final class OrgClientInit implements ClientModInitializer {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Org");
	/** How often the crew list is refreshed from the integrated server's bodies, in client ticks. */
	private static final int CREW_REFRESH_TICKS = 40;

	private final OfficeReporter office = new OfficeReporter();
	private boolean bridgeRegistered;
	private int ticks;

	@Override
	public void onInitializeClient() {
		OrgScreens.install(new OrgScreens.Opener() {
			@Override
			public void openCodex(final BlockPos anchor) {
				Minecraft.getInstance().gui.setScreen(new CodexScreen());
			}

			@Override
			public void openCalendar() {
				Minecraft.getInstance().gui.setScreen(new CalendarScreen());
			}
		});
		BlockEntityRenderers.register(OrgContent.CODEX_BLOCK_ENTITY, CodexBookRenderer::new);
		HudElementRegistry.attachElementAfter(VanillaHudElements.BOSS_BAR, MineVibeMod.id("meeting_hud"), MeetingHud::extract);
		MeetingHud.register();
		if (OrgClient.fakeRequested()) {
			Minecraft mc = Minecraft.getInstance();
			OrgClient.useBackend(new FakeOrgBackend(OrgClientState.get(),
				() -> mc.level == null ? 0 : mc.level.getOverworldClockTime(), System::currentTimeMillis, "Player").seed());
			LOG.info("Org screens use the in-memory fake backend (-D{}=true)", OrgClient.FAKE_PROPERTY);
		}
		this.registerBridge();
		// The bridge is installed by MineVibeClient's entrypoint; if another entrypoint order ran us first, retry.
		ClientLifecycleEvents.CLIENT_STARTED.register(mc -> this.registerBridge());
		ClientTickEvents.END_CLIENT_TICK.register(this::tick);
		// A meeting ends with its world; the Codex and calendar are re-sent by Node when they change.
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(() -> OrgClientState.get().forgetMeeting()));
	}

	private void registerBridge() {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null || this.bridgeRegistered) {
			return;
		}
		this.bridgeRegistered = true;
		OrgClientState state = OrgClientState.get();
		on(bridge, Org.CODEX_INDEX, state::onCodexIndex);
		on(bridge, Org.CALENDAR_STATE, state::onCalendarState);
		on(bridge, Org.MEETING_STATE, state::onMeetingState);
		bridge.addListener(new BridgeClient.ConnectionListener() {
			@Override
			public void onHandshake(final Messages.HelloOk helloOk) {
				OrgClientInit.this.office.onHandshake();
				List<Messages.CrewMember> crew = List.copyOf(helloOk.crew());
				Minecraft.getInstance().execute(() -> state.crew().setNodeCrew(crew));
			}
		});
	}

	/**
	 * One handler per type is allowed; if another module already took one of these, log it rather than fail (the
	 * screens then miss that push, but the game keeps running).
	 */
	private static <P> void on(final BridgeClient bridge, final MessageType<P> type, final Consumer<P> handler) {
		try {
			bridge.on(type, Route.CLIENT, handler);
		} catch (IllegalStateException e) {
			LOG.warn("{} already has a handler; the org screens will not see it", type);
		}
	}

	private void tick(final Minecraft mc) {
		this.office.tick(mc);
		if (++this.ticks % CREW_REFRESH_TICKS == 0) {
			refreshCrew(mc);
		}
	}

	/** Reads the agent bodies on the integrated server thread and hands the list to the client thread. */
	private static void refreshCrew(final Minecraft mc) {
		IntegratedServer server = mc.getSingleplayerServer();
		if (server == null || !server.isRunning() || server.isStopped()) {
			return;
		}
		server.execute(() -> {
			List<CrewDirectory.Member> bodies = new ArrayList<>();
			for (AgentPlayer agent : AgentService.get(server).agents()) {
				if (!agent.isRemoved() && !agent.isAgentDead()) {
					bodies.add(new CrewDirectory.Member(agent.agentId(), agent.getGameProfile().name(), null, agent.role().id(), agent.role() == AgentRole.CEO,
						"alive"));
				}
			}
			mc.execute(() -> OrgClientState.get().crew().setBodies(bodies));
		});
	}
}
