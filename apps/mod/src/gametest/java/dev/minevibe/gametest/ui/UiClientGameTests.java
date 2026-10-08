package dev.minevibe.gametest.ui;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.chat.ChatCompletions;
import dev.minevibe.client.chat.ChatHint;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.HeadIcon;
import dev.minevibe.client.ui.NameTags;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import dev.minevibe.client.ui.input.UiKeys;
import dev.minevibe.client.ui.render.BubbleRenderer;
import dev.minevibe.client.ui.screen.AgentScreen;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

/**
 * Client checks for the in-game UI (T1, PLAN §6.4, §6.5, §7.8) against a fake Node transport:
 * <ol>
 *   <li>a bubble and head icon are drawn above an agent in view, and its name tag carries the model suffix;</li>
 *   <li>chat is intercepted: an unknown {@code @name} keeps the line in the open chat box with a hint and sends
 *       nothing; a valid line goes out as {@code chat.send} (a 300-character line is not cut to 256) and the box
 *       closes; the echo lands in the chat log;</li>
 *   <li>{@code @name} completions reach the client through the integrated server;</li>
 *   <li>Alt+2 with the crosshair on the presenter answers its front question with option 2;</li>
 *   <li>right-clicking the agent opens AgentScreen (screenshot {@code minevibe-ui-agentscreen});</li>
 *   <li>a failing {@code chat.history} is asked once, not again on every rebuild;</li>
 *   <li>pushes about other agents, bubbles and toasts leave the AgentScreen's focused box and its text alone.</li>
 * </ol>
 * Run with {@code ./gradlew runClientGameTest} (opens a window).
 */
public final class UiClientGameTests implements FabricClientGameTest {
	/** Records requests and answers them with an echo. */
	static final class FakeTransport implements UiTransport {
		final List<String> sent = new CopyOnWriteArrayList<>();
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
		public <P> CompletableFuture<JsonObject> request(MessageType<P> type, P payload) {
			sent.add(type.name());
			payloads.add(payload);
			JsonObject ok = new JsonObject();
			ok.addProperty("echo", "You → test: " + type.name());
			return CompletableFuture.completedFuture(ok);
		}
	}

	@Override
	public void runTest(ClientGameTestContext context) {
		FakeTransport transport = new FakeTransport();
		UiTransport.install(transport);
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			singleplayer.getConnection().waitForChunksRender();
			Vec3 agentPos = singleplayer.getServer().computeOnServer(server -> {
				ServerPlayer host = server.getPlayerList().getPlayers().getFirst();
				Vec3 look = Vec3.directionFromRotation(0.0F, host.getYRot());
				Vec3 pos = host.position().add(look.scale(3.0));
				AgentPlayer agent = AgentService.get(server).spawn("ada", "Ada", AgentRole.CEO, host.level(), pos, host.getYRot() + 180.0F);
				agent.brain().setEnabled(false);
				return pos;
			});
			context.waitTicks(20);
			context.runOnClient(client -> {
				UiState state = UiState.get();
				state.reset();
				state.applyCrew(new Bodies.CrewState(List.of(
						new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
						new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"))));
				state.applyBrain(new Ui.AgentBrain("ada", "opus", "thinking", "Reading the plan", "listen", true, false));
				state.applySay(new Messages.AgentSay("ada", "Hello! I am Ada, your CEO. Tell me what to build first.", null, "speech", 60_000));
				ChatCompletions.update(state.agents());
				client.player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, agentPos.add(0, 1.6, 0));
			});
			context.waitTicks(10);

			// 1. Bubble, icon and name tag.
			context.runOnClient(client -> {
				if (BubbleRenderer.lastSubmitted() < 1) throw new AssertionError("no bubble submitted for Ada");
				Entity body = client.level.getPlayerByUUID(AgentService.uuidFor("ada"));
				if (body == null) throw new AssertionError("Ada's body is not on the client");
				String tag = NameTags.decorate(body, Component.literal("Ada")).getString();
				if (!tag.equals("Ada [O]")) throw new AssertionError("name tag " + tag);
				AgentView ada = UiState.get().agent("ada");
				if (HeadIcon.of(ada, false, true) != HeadIcon.THINKING) throw new AssertionError("icon " + HeadIcon.of(ada, false, true));
				// 3. Completions arrived through ClientboundCustomChatCompletionsPacket.
				var suggestions = client.getConnection().getSuggestionsProvider().getCustomTabSuggestions();
				if (!suggestions.contains("@ada") || !suggestions.contains("@ceo") || !suggestions.contains("@all")) {
					throw new AssertionError("completions " + suggestions);
				}
			});
			context.takeScreenshot("minevibe-ui-bubble");

			// 2. Chat interception: a refused line stays in the box with its hint, and nothing is sent.
			context.setScreen(() -> new ChatScreen("", false));
			context.getInput().typeChars("@zed hello");
			context.getInput().pressKey(InputConstants.KEY_RETURN);
			context.waitTick();
			context.runOnClient(client -> {
				if (!(client.gui.screen() instanceof ChatScreen)) throw new AssertionError("chat closed on a refused line");
				String hint = ChatHint.current("@zed hello");
				if (hint == null || !hint.startsWith("Nobody is called @zed")) throw new AssertionError("hint " + hint);
				if (!transport.sent.isEmpty()) throw new AssertionError("sent " + transport.sent);
			});
			context.takeScreenshot("minevibe-ui-chat-hint");
			context.setScreen(() -> null);
			String longLine = "@ada " + "x".repeat(295);
			context.setScreen(() -> new ChatScreen("", false));
			context.getInput().typeChars(longLine);
			context.getInput().pressKey(InputConstants.KEY_RETURN);
			context.waitTicks(2);
			context.runOnClient(client -> {
				if (client.gui.screen() != null) throw new AssertionError("chat stayed open after a sent line");
				if (!transport.sent.equals(List.of("chat.send"))) throw new AssertionError("sent " + transport.sent);
				Messages.ChatSend send = (Messages.ChatSend) transport.payloads.getFirst();
				if (!send.text().equals(longLine)) throw new AssertionError("line cut to " + send.text().length() + " characters");
				if (!send.to().isJsonPrimitive() || !send.to().getAsString().equals("all")) throw new AssertionError("to " + send.to());
			});

			// 4. Alt+2 answers the presenter's question while the crosshair is on it.
			context.runOnClient(client -> UiState.get().applyPending(new Ui.AgentPending("ada", List.of(new Ui.PendingCard(
					"q-1", "ada", 1, false, true, "question",
					List.of(new Ui.CardQuestion("Which wood?", "Wood", List.of(new Ui.QuestionOption("Oak", null), new Ui.QuestionOption("Spruce", null)), false)),
					List.of(), null, null, null, null, null, null, null, null)))));
			context.waitTicks(2);
			context.runOnClient(client -> {
				Entity aimed = client.crosshairPickEntity;
				if (aimed == null || !aimed.getUUID().equals(AgentService.uuidFor("ada"))) throw new AssertionError("crosshair on " + aimed);
				UiKeys.onKey(InputConstants.PRESS, new KeyEvent(InputConstants.KEY_2, 0, InputConstants.MOD_ALT));
				int last = transport.sent.size() - 1;
				if (!transport.sent.get(last).equals("pending.answer")) throw new AssertionError("sent " + transport.sent);
				Ui.PendingAnswer answer = (Ui.PendingAnswer) transport.payloads.get(last);
				if (!answer.pendingId().equals("q-1") || !answer.answer().picks().equals(List.of(2))) {
					throw new AssertionError("answer " + answer);
				}
				if (HeadIcon.of(UiState.get().agent("ada"), false, true) != HeadIcon.QUESTION) throw new AssertionError("no ? icon");
			});
			context.takeScreenshot("minevibe-ui-card-mode");

			// 5. Right-click opens AgentScreen (UseEntityCallback returns FAIL: nothing reaches the server).
			context.getInput().pressMouse(InputConstants.MOUSE_BUTTON_RIGHT);
			context.waitTicks(5);
			context.runOnClient(client -> {
				if (!(client.gui.screen() instanceof AgentScreen screen) || !screen.agentId().equals("ada")) {
					throw new AssertionError("screen " + client.gui.screen());
				}
			});
			context.takeScreenshot("minevibe-ui-agentscreen");

			// 6. A failed chat.history (this fake's reply is not a history page) is asked once, not in a loop.
			context.waitTicks(20);
			context.runOnClient(client -> {
				long history = transport.sent.stream().filter("chat.history"::equals).count();
				if (history != 1) throw new AssertionError("chat.history sent " + history + " times");
			});

			// 7. Pushes about other agents, bubbles and toasts do not rebuild the screen: the box keeps focus and text.
			context.getInput().typeChars("hello");
			context.runOnClient(client -> {
				UiState state = UiState.get();
				state.applyBrain(new Ui.AgentBrain("bram", "haiku", "thinking", "Digging", "listen", false, false));
				state.applySay(new Messages.AgentSay("bram", "Found iron!", null, "speech", 5_000));
				state.addToast("Bram found iron", "info", "bram", 1);
			});
			context.waitTicks(5);
			context.getInput().typeChars(" world");
			context.runOnClient(client -> {
				if (!(client.gui.screen() instanceof AgentScreen screen)) throw new AssertionError("screen " + client.gui.screen());
				if (!(screen.getFocused() instanceof EditBox box) || !box.getValue().equals("hello world")) {
					throw new AssertionError("focus " + screen.getFocused()
							+ (screen.getFocused() instanceof EditBox b ? " holds '" + b.getValue() + "'" : ""));
				}
			});
			context.setScreen(() -> null);

			singleplayer.getServer().runOnServer(server -> {
				AgentService service = AgentService.get(server);
				for (AgentPlayer agent : service.agents()) service.dismiss(agent);
			});
			context.waitTicks(5);
		} finally {
			UiTransport.install(null);
			context.runOnClient(client -> UiState.get().reset());
		}
	}
}
