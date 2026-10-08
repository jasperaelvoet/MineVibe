package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.AGENT_ROLE;
import static dev.minevibe.bridge.msg.Types.AUTONOMY;
import static dev.minevibe.bridge.msg.Types.BRAINS;
import static dev.minevibe.bridge.msg.Types.DISPLAY_NAME;
import static dev.minevibe.bridge.msg.Types.EPOCH_MS;
import static dev.minevibe.bridge.msg.Types.EVENT_ID;
import static dev.minevibe.bridge.msg.Types.HANDLE;
import static dev.minevibe.bridge.msg.Types.MODEL_TIER;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.PENDING_ID;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.nullable;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import com.google.gson.JsonElement;
import com.google.gson.JsonPrimitive;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * UI group (PLAN §5, §6.4, §7.8): brains, cards, approach, transcripts, answers, commands. Mirrors {@code ui.ts};
 * {@code ui.toast}, {@code agent.say} and {@code chat.send} (M1) live in {@code Messages}.
 */
public final class Ui {
	private Ui() {}

	public static final int CHAT_MAX_LENGTH = 2000;

	/** {@code agent.cmd} commands. */
	public static final List<String> COMMANDS = List.of(
			"follow", "stay", "guard", "wander", "stop", "interrupt", "kick", "dismiss", "plan_first", "ping_instead",
			"autonomy", "retry_brain");

	// -----------------------------------------------------------------------------------------
	// Records
	// -----------------------------------------------------------------------------------------

	public record QuestionOption(String label, @Nullable String description) {}

	public record CardQuestion(String question, @Nullable String header, List<QuestionOption> options, boolean multiSelect) {}

	/**
	 * A pending card, flattened over its {@code kind}: {@code question} (questions, answers), {@code plan} (plan),
	 * {@code hire} (role, name, handle, reason, firstTask) or {@code calendar} (eventId, summary).
	 */
	public record PendingCard(
			String id,
			String agentId,
			long createdAt,
			boolean parked,
			boolean presenting,
			String kind,
			@Nullable List<CardQuestion> questions,
			@Nullable List<String> answers,
			@Nullable String plan,
			@Nullable String role,
			@Nullable String name,
			@Nullable String handle,
			@Nullable String reason,
			@Nullable String firstTask,
			@Nullable String eventId,
			@Nullable String summary) {
		public static final String QUESTION = "question";
		public static final String PLAN = "plan";
		public static final String HIRE = "hire";
		public static final String CALENDAR = "calendar";
	}

	/** One transcript line. {@code kind}: player, agent, activity, card, answer, tell, system. */
	public record ChatEntry(long seq, long at, String kind, String text, @Nullable String fromAgentId, @Nullable String cardId) {}

	/** N→M. {@code status}: idle, thinking, queued, waiting_player, asleep, offline. */
	public record AgentBrain(
			String agentId, String model, String status, @Nullable String activity, String autonomy, boolean planFirst, boolean pingInstead) {}

	/** N→M. Replaces the agent's cards. */
	public record AgentPending(String agentId, List<PendingCard> cards) {}

	/**
	 * N→M. {@code role}: present, present_seated (USER DECISION 2026-10-08: a seated agent presents from its chair when
	 * the player is near, never dismounting), queue, ping, release ({@code pendingId} null).
	 */
	public record AgentApproach(String agentId, @Nullable String pendingId, String role) {}

	/** N→M. */
	public record ChatAppend(String agentId, ChatEntry entry) {}

	/** M→N request. Reply: {@link ChatHistoryResult}. */
	public record ChatHistory(String agentId, @Nullable Long beforeSeq, int limit) {}

	public record ChatHistoryResult(List<ChatEntry> entries, boolean more) {}

	/**
	 * An answer, flattened over {@code kind}: {@code options} (picks, 1-based), {@code text} (text), {@code later},
	 * {@code approve}, {@code decline} (note?).
	 */
	public record CardAnswer(String kind, @Nullable List<Integer> picks, @Nullable String text, @Nullable String note) {
		public static CardAnswer options(List<Integer> picks) {
			return new CardAnswer("options", picks, null, null);
		}

		public static CardAnswer text(String text) {
			return new CardAnswer("text", null, text, null);
		}

		public static CardAnswer later() {
			return new CardAnswer("later", null, null, null);
		}
	}

	/** M→N request. Reply: {@code ChatSendResult} ({@code echo}). */
	public record PendingAnswer(String agentId, String pendingId, CardAnswer answer) {}

	/** M→N request. {@code decision}: approve, revise (needs feedback). */
	public record PlanDecision(String agentId, String pendingId, String decision, @Nullable String feedback) {}

	/** M→N request. {@code decision}: approve, decline. */
	public record HireDecision(String pendingId, String decision, @Nullable String note) {}

	/** M→N request. {@code on} for plan_first / ping_instead, {@code level} for autonomy. */
	public record AgentCmd(String agentId, String cmd, @Nullable Boolean on, @Nullable String level) {
		public static AgentCmd of(String agentId, String cmd) {
			return new AgentCmd(agentId, cmd, null, null);
		}
	}

	/** Reply of {@code chat.send}, {@code pending.answer}, {@code plan.decision}, {@code hire.decision}. */
	public record ChatSendResult(String echo) {}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	private static Schema.Obj card(String kind) {
		return object()
				.req("id", PENDING_ID)
				.req("agentId", AGENT_ID)
				.req("createdAt", EPOCH_MS)
				.req("parked", bool())
				.req("presenting", bool())
				.req("kind", literal(kind));
	}

	static final Schema.Obj CARD_QUESTION = object()
			.req("question", string(1, 1000))
			.opt("header", string(1, 40))
			.req("options", array(object().req("label", string(1, 120)).opt("description", string(0, 500)), 0, 10))
			.req("multiSelect", bool());

	/** A {@code PendingCard} (also used by {@code hello.ok.pending}). */
	public static final Schema.Node PENDING_CARD = union(
			card(PendingCard.QUESTION)
					.req("questions", array(CARD_QUESTION, 1, 8))
					.req("answers", array(string(0, CHAT_MAX_LENGTH), 0, 8)),
			card(PendingCard.PLAN).req("plan", string(1, 32_000)),
			card(PendingCard.HIRE)
					.req("role", AGENT_ROLE)
					.req("name", DISPLAY_NAME)
					.req("handle", HANDLE)
					.req("reason", string(0, 500))
					.req("firstTask", string(0, 2000)),
			card(PendingCard.CALENDAR).req("eventId", EVENT_ID).req("summary", string(1, 500)));

	static final Schema.Obj CHAT_ENTRY = object()
			.req("seq", NON_NEG_INT)
			.req("at", EPOCH_MS)
			.req("kind", oneOf("player", "agent", "activity", "card", "answer", "tell", "system"))
			.req("text", string(1, 8000))
			.opt("fromAgentId", AGENT_ID)
			.opt("cardId", PENDING_ID);

	static final Schema.Node CARD_ANSWER = union(
			object().req("kind", literal("options")).req("picks", array(integer(1, 10), 1, 10)),
			object().req("kind", literal("text")).req("text", string(1, CHAT_MAX_LENGTH)),
			object().req("kind", literal("later")),
			object().req("kind", literal("approve")),
			object().req("kind", literal("decline")).opt("note", string(1, 500)));

	public static final MessageType<AgentBrain> AGENT_BRAIN = type("agent.brain", Direction.NODE_TO_MOD, AgentBrain.class, object()
			.req("agentId", AGENT_ID)
			.req("model", MODEL_TIER)
			.req("status", oneOf("idle", "thinking", "queued", "waiting_player", "asleep", "offline"))
			.req("activity", nullable(string(1, 160)))
			.req("autonomy", AUTONOMY)
			.req("planFirst", bool())
			.req("pingInstead", bool()));

	public static final MessageType<AgentPending> AGENT_PENDING = type("agent.pending", Direction.NODE_TO_MOD, AgentPending.class, object()
			.req("agentId", AGENT_ID)
			.req("cards", array(PENDING_CARD, 0, 16)));

	public static final MessageType<AgentApproach> AGENT_APPROACH = type("agent.approach", Direction.NODE_TO_MOD, AgentApproach.class, object()
			.req("agentId", AGENT_ID)
			.req("pendingId", nullable(PENDING_ID))
			.req("role", oneOf("present", "present_seated", "queue", "ping", "release")));

	public static final MessageType<ChatAppend> CHAT_APPEND = type("chat.append", Direction.NODE_TO_MOD, ChatAppend.class, object()
			.req("agentId", AGENT_ID)
			.req("entry", CHAT_ENTRY));

	public static final MessageType<ChatHistory> CHAT_HISTORY = type("chat.history", Direction.MOD_TO_NODE, ChatHistory.class, object()
			.req("agentId", AGENT_ID)
			.opt("beforeSeq", NON_NEG_INT)
			.req("limit", integer(1, 200)));

	public static final MessageType<PendingAnswer> PENDING_ANSWER = type("pending.answer", Direction.MOD_TO_NODE, PendingAnswer.class, object()
			.req("agentId", AGENT_ID)
			.req("pendingId", PENDING_ID)
			.req("answer", CARD_ANSWER));

	public static final MessageType<PlanDecision> PLAN_DECISION = type("plan.decision", Direction.MOD_TO_NODE, PlanDecision.class, object()
			.req("agentId", AGENT_ID)
			.req("pendingId", PENDING_ID)
			.req("decision", oneOf("approve", "revise"))
			.opt("feedback", string(1, CHAT_MAX_LENGTH))
			.refine(o -> !"revise".equals(str(o.get("decision"))) || o.has("feedback"), "revise needs feedback"));

	public static final MessageType<HireDecision> HIRE_DECISION = type("hire.decision", Direction.MOD_TO_NODE, HireDecision.class, object()
			.req("pendingId", PENDING_ID)
			.req("decision", oneOf("approve", "decline"))
			.opt("note", string(1, 500)));

	public static final MessageType<AgentCmd> AGENT_CMD = type("agent.cmd", Direction.MOD_TO_NODE, AgentCmd.class, object()
			.req("agentId", AGENT_ID)
			.req("cmd", oneOf(COMMANDS.toArray(String[]::new)))
			.opt("on", bool())
			.opt("level", AUTONOMY)
			.refine(o -> {
				String cmd = str(o.get("cmd"));
				return !("plan_first".equals(cmd) || "ping_instead".equals(cmd)) || o.has("on");
			}, "plan_first and ping_instead need on")
			.refine(o -> !"autonomy".equals(str(o.get("cmd"))) || o.has("level"), "autonomy needs level"));

	public static final MessageType<Messages.Brains> BRAINS_STATE =
			type("brains.state", Direction.NODE_TO_MOD, Messages.Brains.class, object().extend(BRAINS));

	public static final Schema.Obj CHAT_HISTORY_RESULT = object().req("entries", array(CHAT_ENTRY, 0, 200)).req("more", bool());

	public static final List<MessageType<?>> TYPES = List.of(
			AGENT_BRAIN, AGENT_PENDING, AGENT_APPROACH, CHAT_APPEND, CHAT_HISTORY, PENDING_ANSWER, PLAN_DECISION, HIRE_DECISION,
			AGENT_CMD, BRAINS_STATE);

	static @Nullable String str(@Nullable JsonElement e) {
		return e instanceof JsonPrimitive p && p.isString() ? p.getAsString() : null;
	}
}
