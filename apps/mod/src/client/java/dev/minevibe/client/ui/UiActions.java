package dev.minevibe.client.ui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * The UI's requests to Node (PLAN §6.4, §7.8), shared by the chat interceptor, AgentScreen, the G card and Alt+1-4.
 * Each returns a future that completes <b>on the client thread</b> with the echo line ("You → Ada: Q1 = 2 (Spruce)")
 * or fails with a {@link BridgeException} whose message is the hint to show.
 */
public final class UiActions {
	private UiActions() {}

	/** Results are handed back on the client thread. */
	private static Executor client() {
		return Minecraft.getInstance();
	}

	/** A raw chat line ({@code to: "all"}): Node parses its leading {@code @mentions}. */
	public static CompletableFuture<String> chatLine(String text) {
		return chat(new JsonPrimitive("all"), text, null);
	}

	/** A line to one agent from AgentScreen: {@code reply}, {@code task} (New task) or {@code interrupt}. */
	public static CompletableFuture<String> chatTo(String agentId, String text, String mode) {
		JsonArray to = new JsonArray();
		to.add(agentId);
		return chat(to, text, mode);
	}

	private static CompletableFuture<String> chat(JsonElement to, String text, @Nullable String mode) {
		return echo(UiTransport.current().request(Messages.CHAT_SEND, new Messages.ChatSend(to, text, mode)));
	}

	public static CompletableFuture<String> answer(String agentId, String pendingId, Ui.CardAnswer answer) {
		return echo(UiTransport.current().request(Ui.PENDING_ANSWER, new Ui.PendingAnswer(agentId, pendingId, answer)));
	}

	public static CompletableFuture<String> plan(String agentId, String pendingId, boolean approve, @Nullable String feedback) {
		return echo(UiTransport.current().request(
				Ui.PLAN_DECISION, new Ui.PlanDecision(agentId, pendingId, approve ? "approve" : "revise", approve ? null : feedback)));
	}

	public static CompletableFuture<String> hire(String pendingId, boolean approve, @Nullable String note) {
		return echo(UiTransport.current().request(
				Ui.HIRE_DECISION, new Ui.HireDecision(pendingId, approve ? "approve" : "decline", approve ? null : blankToNull(note))));
	}

	public static CompletableFuture<String> command(String agentId, String cmd, @Nullable Boolean on, @Nullable String level) {
		return echo(UiTransport.current().request(Ui.AGENT_CMD, new Ui.AgentCmd(agentId, cmd, on, level)));
	}

	/** A page of an agent's transcript; the page is also merged into {@link UiState}. */
	public static CompletableFuture<Ui.ChatHistoryResult> history(String agentId, @Nullable Long beforeSeq, int limit) {
		return UiTransport.current()
				.request(Ui.CHAT_HISTORY, new Ui.ChatHistory(agentId, beforeSeq, limit))
				.thenApplyAsync(json -> {
					List<String> problems = Ui.CHAT_HISTORY_RESULT.validate(json);
					if (!problems.isEmpty()) throw new BridgeException(Codes.BAD_MESSAGE, "chat.history reply: " + problems.getFirst());
					Ui.ChatHistoryResult page = ProtocolCodec.GSON.fromJson(json, Ui.ChatHistoryResult.class);
					UiState.get().applyHistory(agentId, page);
					return page;
				}, client());
	}

	/**
	 * Answers an agent's front card with option {@code n} (1-based): Alt+1-4 and the G card's number buttons. Questions
	 * pick option {@code n}; plans, hires and calendar approvals take 1 = approve, 2 = decline (a plan revision needs
	 * words, so 2 returns null and the caller opens AgentScreen).
	 */
	public static @Nullable CompletableFuture<String> answerFront(AgentView agent, int n) {
		Ui.PendingCard card = agent.frontCard();
		if (card == null) return null;
		return switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> answer(agent.agentId(), card.id(), Ui.CardAnswer.options(List.of(n)));
			case Ui.PendingCard.PLAN -> n == 1 ? plan(agent.agentId(), card.id(), true, null) : null;
			case Ui.PendingCard.HIRE -> n <= 2 ? hire(card.id(), n == 1, null) : null;
			case Ui.PendingCard.CALENDAR -> n <= 2
					? answer(agent.agentId(), card.id(), new Ui.CardAnswer(n == 1 ? "approve" : "decline", null, null, null))
					: null;
			default -> null;
		};
	}

	/** The hint to show for a failed request. */
	public static String errorText(Throwable err) {
		BridgeException be = BridgeClient.unwrap(err);
		if (be == null) return "Something went wrong: " + err.getMessage();
		return switch (be.code()) {
			case Codes.DISCONNECTED -> "MineVibe is offline: nothing was sent";
			case Codes.TIMEOUT -> "MineVibe did not answer in time";
			case Codes.NOT_HANDLED -> "MineVibe cannot do that yet";
			default -> be.getMessage();
		};
	}

	private static CompletableFuture<String> echo(CompletableFuture<JsonObject> reply) {
		return reply.thenApplyAsync(UiActions::echoOf, client());
	}

	static String echoOf(JsonObject result) {
		JsonElement echo = result.get("echo");
		return echo != null && echo.isJsonPrimitive() ? echo.getAsString() : "";
	}

	private static @Nullable String blankToNull(@Nullable String s) {
		return s == null || s.isBlank() ? null : s.trim();
	}
}
