package dev.minevibe.gametest.client;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.chat.ChatCompletions;
import dev.minevibe.client.chat.ChatHint;
import dev.minevibe.client.org.BridgeOrgBackend;
import dev.minevibe.client.org.FakeOrgBackend;
import dev.minevibe.client.org.OrgClient;
import dev.minevibe.client.org.OrgClientState;
import dev.minevibe.client.org.meeting.MeetingHudModel;
import dev.minevibe.client.pc.PcChairInteraction;
import dev.minevibe.client.pc.PcSeatWatcher;
import dev.minevibe.client.pc.screen.PcControlScreen;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.HeadIcon;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.pc.PcDeskBlock;
import dev.minevibe.pc.PcRegistry;
import dev.minevibe.pc.PcWorkstation;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Client checks of the integration track (I2), against a fake Node transport and the in-memory org backend:
 * <ol>
 *   <li>{@code @meeting end} typed in chat goes out through T1's interceptor as {@code chat.send} (not refused, the box
 *       closes), {@code @meeting} is a completion while the meeting runs, and the meeting HUD's End button in the chat
 *       screen ends it;</li>
 *   <li>the seat kind reaches the client: an agent on a meeting chair is not "seated at a PC" (no monitor icon), one at
 *       a desk is;</li>
 *   <li>right-clicking a PC chair an agent sits on asks "Kick Bram and sit?"; Yes kicks the agent on the integrated
 *       server, sits the player down and opens PcControlScreen.</li>
 * </ol>
 * Run with {@code ./gradlew runClientGameTest} (opens a window).
 */
public final class IntegrationClientGameTests implements FabricClientGameTest {
	private static final String PC_ID = "gt-client-pc";

	/** Records requests and answers them with an echo. */
	static final class FakeTransport implements UiTransport {
		final List<Object> payloads = new CopyOnWriteArrayList<>();

		@Override
		public boolean configured() {
			return true;
		}

		@Override
		public boolean connected() {
			return true;
		}

		@Override
		public <P> CompletableFuture<JsonObject> request(final MessageType<P> type, final P payload) {
			this.payloads.add(payload);
			JsonObject ok = new JsonObject();
			ok.addProperty("echo", "You → meeting: end");
			return CompletableFuture.completedFuture(ok);
		}
	}

	@Override
	public void runTest(final ClientGameTestContext context) {
		context.waitForScreen(TitleScreen.class);
		FakeTransport transport = new FakeTransport();
		UiTransport.install(transport);
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			singleplayer.getConnection().waitForChunksRender();
			try {
				meetingEndsFromChat(context, transport);
				Chairs chairs = seatKindsReachTheClient(context, singleplayer);
				kickAndSit(context, singleplayer, chairs);
			} finally {
				context.runOnClient(mc -> {
					OrgClient.useBackend(new BridgeOrgBackend());
					OrgClientState.get().clear();
					ChatCompletions.meetingActive(false);
					UiState.get().reset();
				});
				context.setScreen(() -> null);
			}
		} finally {
			UiTransport.install(null);
		}
	}

	private static void meetingEndsFromChat(final ClientGameTestContext context, final FakeTransport transport) {
		context.runOnClient(mc -> {
			UiState state = UiState.get();
			state.reset();
			state.applyCrew(new Bodies.CrewState(List.of(
				new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
				new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"))));
			FakeOrgBackend backend = new FakeOrgBackend(OrgClientState.get(), () -> mc.level == null ? 0 : mc.level.getOverworldClockTime(),
				System::currentTimeMillis, "Player").seed();
			OrgClient.useBackend(backend);
			backend.meetingStart(new Org.MeetingStart(null, "Standup", null, false)).join();
			// What OrgClientInit's meeting.state handler does with Node's push.
			ChatCompletions.meetingActive(MeetingHudModel.isActive(OrgClientState.get().meeting()));
		});
		context.waitTicks(5);
		context.runOnClient(mc -> {
			var suggestions = mc.getConnection().getSuggestionsProvider().getCustomTabSuggestions();
			if (!suggestions.contains("@meeting")) {
				throw new AssertionError("@meeting is no completion during a meeting: " + suggestions);
			}
		});

		// Typed: the interceptor sends it to Node (whose ChatRouter ends the meeting) and the chat box closes.
		context.setScreen(() -> new ChatScreen("", false));
		context.getInput().typeChars("@meeting end");
		context.getInput().pressKey(InputConstants.KEY_RETURN);
		context.waitTicks(2);
		context.runOnClient(mc -> {
			if (mc.gui.screen() instanceof ChatScreen) {
				throw new AssertionError("chat stayed open on @meeting end: " + ChatHint.current("@meeting end"));
			}
			boolean sent = transport.payloads.stream().anyMatch(p -> p instanceof Messages.ChatSend send && "@meeting end".equals(send.text()));
			if (!sent) {
				throw new AssertionError("@meeting end was not sent as chat.send: " + transport.payloads);
			}
		});

		// Clicked: the End button the meeting HUD puts into the chat screen (next to T1's hint line) ends it.
		context.setScreen(() -> new ChatScreen("", false));
		context.waitTicks(2);
		context.clickScreenButton("End meeting");
		context.waitTicks(2);
		if (context.computeOnClient(mc -> MeetingHudModel.isActive(OrgClientState.get().meeting()))) {
			throw new AssertionError("the End button did not end the meeting");
		}
		context.setScreen(() -> null);
		System.out.println("[I2] @meeting end and the End button both work with the chat interceptor");
	}

	/** Where the chairs of the seat checks are. */
	record Chairs(BlockPos meeting, BlockPos pc) {}

	private static Chairs seatKindsReachTheClient(final ClientGameTestContext context, final TestSingleplayerContext singleplayer) {
		Chairs chairs = singleplayer.getServer().computeOnServer(server -> {
			ServerPlayer host = server.getPlayerList().getPlayers().getFirst();
			ServerLevel level = server.overworld();
			BlockPos base = host.blockPosition().offset(3, 0, 3);
			for (int x = -1; x <= 6; x++) {
				for (int z = -2; z <= 2; z++) {
					level.setBlockAndUpdate(base.offset(x, -1, z), Blocks.STONE.defaultBlockState());
					level.setBlockAndUpdate(base.offset(x, 0, z), Blocks.AIR.defaultBlockState());
					level.setBlockAndUpdate(base.offset(x, 1, z), Blocks.AIR.defaultBlockState());
				}
			}
			level.setBlockAndUpdate(base, OrgContent.MEETING_TABLE.defaultBlockState());
			BlockPos meetingChair = base.north();
			level.setBlockAndUpdate(meetingChair, MvWorldContent.OFFICE_CHAIR.defaultBlockState().setValue(OfficeChairBlock.FACING, Direction.SOUTH));
			MeetingTables.relink(level, base);
			BlockPos deskOrigin = base.offset(4, 0, 1);
			PcWorkstation.place(level, deskOrigin, Direction.NORTH, "linux", PC_ID);
			BlockPos pcChair = PcDeskBlock.chairPos(deskOrigin, Direction.NORTH);
			AgentService bodies = AgentService.get(server);
			AgentPlayer ada = bodies.spawn("ada", "Ada", AgentRole.CEO, level, Vec3.atBottomCenterOf(meetingChair), 0.0F);
			AgentPlayer bram = bodies.spawn("bram", "Bram", AgentRole.ENGINEER, level, Vec3.atBottomCenterOf(pcChair), 0.0F);
			ada.brain().setEnabled(false);
			bram.brain().setEnabled(false);
			if (!OfficeChairBlock.trySit(level, meetingChair, ada) || !OfficeChairBlock.trySit(level, pcChair, bram)) {
				throw new AssertionError("the agents could not sit");
			}
			return new Chairs(meetingChair, pcChair);
		});
		context.waitTicks(20);
		context.runOnClient(mc -> {
			Player ada = mc.level.getPlayerByUUID(AgentService.uuidFor("ada"));
			Player bram = mc.level.getPlayerByUUID(AgentService.uuidFor("bram"));
			if (ada == null || bram == null) {
				throw new AssertionError("the bodies are not on the client");
			}
			if (!AgentEntities.onSeat(ada) || AgentEntities.onPcSeat(ada)) {
				throw new AssertionError("Ada sits on a meeting seat (the client must know its kind)");
			}
			if (!AgentEntities.onPcSeat(bram)) {
				throw new AssertionError("Bram sits at a PC");
			}
			AgentView adaView = UiState.get().agent("ada");
			AgentView bramView = UiState.get().agent("bram");
			if (HeadIcon.of(adaView, AgentEntities.atPc(ada, adaView), true) == HeadIcon.SEATED) {
				throw new AssertionError("a meeting seat shows the PC monitor icon");
			}
			if (HeadIcon.of(bramView, AgentEntities.atPc(bram, bramView), true) != HeadIcon.SEATED) {
				throw new AssertionError("a PC seat must show the monitor icon, whatever model the brain is on");
			}
		});
		context.takeScreenshot("minevibe-i2-seats");
		System.out.println("[I2] seat kinds reach the client");
		return chairs;
	}

	private static void kickAndSit(final ClientGameTestContext context, final TestSingleplayerContext singleplayer, final Chairs chairs) {
		InteractionResult result = context.computeOnClient(mc -> PcChairInteraction.onUseBlock(mc.player, mc.level, InteractionHand.MAIN_HAND,
			new BlockHitResult(Vec3.atCenterOf(chairs.pc()), Direction.UP, chairs.pc(), false)));
		if (result != InteractionResult.FAIL) {
			throw new AssertionError("using an occupied PC chair must not reach the server: " + result);
		}
		context.waitForScreen(ConfirmScreen.class);
		String title = context.computeOnClient(mc -> mc.gui.screen().getTitle().getString());
		if (!"Kick Bram and sit?".equals(title)) {
			throw new AssertionError("confirmation " + title);
		}
		context.takeScreenshot("minevibe-i2-kick-confirm");
		context.clickScreenButton("Yes");
		context.waitFor(mc -> mc.gui.screen() instanceof PcControlScreen, 100);
		boolean ok = singleplayer.getServer().computeOnServer(server -> {
			ServerPlayer host = server.getPlayerList().getPlayers().getFirst();
			AgentPlayer bram = AgentService.get(server).agent("bram");
			return bram != null && !bram.isPassenger() && PC_ID.equals(PcRegistry.seatedPc(host.getUUID()));
		});
		if (!ok) {
			throw new AssertionError("Bram was not kicked, or the player does not sit at the PC");
		}
		if (!PC_ID.equals(context.computeOnClient(mc -> PcSeatWatcher.seatedPc()))) {
			throw new AssertionError("the client does not see the player at " + PC_ID);
		}
		context.takeScreenshot("minevibe-i2-kicked-and-sat");
		context.runOnClient(PcSeatWatcher::requestStand);
		context.waitFor(mc -> !(mc.gui.screen() instanceof PcControlScreen) && !mc.player.isPassenger(), 100);
		singleplayer.getServer().runOnServer(server -> {
			for (String id : List.of("ada", "bram")) {
				AgentPlayer agent = AgentService.get(server).agent(id);
				if (agent != null) {
					AgentService.get(server).dismiss(agent);
				}
			}
		});
		System.out.println("[I2] Kick Bram and sit? kicked the agent and seated the player");
	}
}
