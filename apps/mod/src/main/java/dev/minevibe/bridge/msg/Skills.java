package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.ERROR_CODE;
import static dev.minevibe.bridge.msg.Types.FRACTION;
import static dev.minevibe.bridge.msg.Types.JOB_ID;
import static dev.minevibe.bridge.msg.Types.JSON_OBJECT;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Messages.BlockPos;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * Skills group (PLAN §5, §7.4): jobs and observations. Mirrors {@code skills.ts}. The {@link Args} records are the
 * per-skill {@code args} ({@code SkillArgs} on the TypeScript side); read them with
 * {@code ProtocolCodec.GSON.fromJson(run.args(), Skills.Args.Mine.class)}.
 */
public final class Skills {
	private Skills() {}

	/** Skills that run in the mod as jobs ({@code SKILL_NAMES}). */
	public static final List<String> SKILL_NAMES = List.of(
			"goto", "mine", "collect", "hunt", "dig", "place", "use_block", "use_item", "attack", "equip", "eat", "sleep",
			"pickup", "drop", "give", "craft", "smelt", "container", "open_menu", "menu_click", "menu_close", "build", "farm",
			"ride", "dismount", "emote");

	/** Observation queries ({@code OBS_QUERIES}). */
	public static final List<String> OBS_QUERIES = List.of(
			"status", "look_around", "inventory", "find", "recipe", "recent_events", "crew", "list_pcs", "job_status", "menu_state");

	public static final String RUNNING = "running";
	public static final String DONE = "done";
	public static final String FAILED = "failed";
	public static final String CANCELLED = "cancelled";

	// -----------------------------------------------------------------------------------------
	// Records
	// -----------------------------------------------------------------------------------------

	/** N→M request. Reply: {@link SkillRunResult}. */
	public record SkillRun(String jobId, String agentId, String skill, JsonObject args, int waitMs, boolean replace) {}

	/** {@code status}: running, done, failed, cancelled. */
	public record SkillRunResult(String jobId, String status, @Nullable JsonObject result, Types.@Nullable Failure error) {}

	/** M→N. */
	public record SkillProgress(String jobId, String agentId, @Nullable Double progress, String text) {}

	/** N→M request. Reply: {@link SkillCancelResult}. Without {@code jobId}: every job of the agent. */
	public record SkillCancel(String agentId, @Nullable String jobId, String reason) {}

	public record SkillCancelResult(List<String> cancelled) {}

	/** M→N. {@code status}: done, failed, cancelled. */
	public record SkillResult(
			String jobId, String agentId, String status, @Nullable JsonObject result, Types.@Nullable Failure error, long durationMs) {}

	/** N→M request. Reply: {@link ObsQueryResult}. */
	public record ObsQuery(String agentId, String query, JsonObject args) {}

	public record ObsQueryResult(JsonObject result) {}

	/** Per-skill {@code args} (validated by Node with {@code SkillArgs}; absent optional keys are null). */
	public static final class Args {
		private Args() {}

		/** Exactly one of {@code pos} / {@code entity}. */
		public record Goto(@Nullable BlockPos pos, @Nullable String entity, @Nullable Double range) {}

		public record Mine(String block, int count, @Nullable BlockPos near, @Nullable Integer radius) {}

		public record Collect(String item, int count, @Nullable Integer radius) {}

		public record Hunt(String entity, int count, @Nullable Integer radius) {}

		public record Dig(BlockPos from, BlockPos to) {}

		public record Place(String block, BlockPos pos) {}

		public record UseBlock(BlockPos pos) {}

		public record UseItem(@Nullable String item, @Nullable BlockPos pos, @Nullable String entity) {}

		public record Attack(String entity) {}

		/** {@code slot}: mainhand, offhand, head, chest, legs, feet. */
		public record Equip(String item, @Nullable String slot) {}

		public record Eat(@Nullable String item) {}

		public record Sleep(@Nullable BlockPos pos) {}

		public record Pickup(@Nullable String item, @Nullable Integer radius) {}

		public record Drop(String item, @Nullable Integer count) {}

		public record Give(String item, int count, String to) {}

		public record Craft(String item, int count, @Nullable BlockPos table) {}

		public record Smelt(String item, int count, @Nullable String fuel, @Nullable BlockPos furnace) {}

		/** {@code action}: list, put, take ({@code item} needed for put and take). */
		public record Container(BlockPos pos, String action, @Nullable String item, @Nullable Integer count) {}

		/** Exactly one of {@code pos} / {@code entity}. */
		public record OpenMenu(@Nullable BlockPos pos, @Nullable String entity) {}

		/** {@code type}: pickup, quick_move, swap, clone, throw, quick_craft, pickup_all. */
		public record MenuClick(int slot, int button, String type) {}

		public record MenuClose() {}

		/** {@code rotation}: 0, 90, 180 or 270. */
		public record Build(String blueprint, BlockPos origin, @Nullable Integer rotation) {}

		public record Farm(BlockPos from, BlockPos to, @Nullable String crop) {}

		public record Ride(String entity) {}

		public record Dismount() {}

		/** {@code kind}: wave, nod, shake_head, point, cheer, facepalm. */
		public record Emote(String kind) {}
	}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Node SKILL_NAME = oneOf(SKILL_NAMES.toArray(String[]::new));
	static final Schema.Obj FAILURE = object().req("code", ERROR_CODE).req("msg", string(0, 2000));

	public static final MessageType<SkillRun> SKILL_RUN = type("skill.run", Direction.NODE_TO_MOD, SkillRun.class, object()
			.req("jobId", JOB_ID)
			.req("agentId", AGENT_ID)
			.req("skill", SKILL_NAME)
			.req("args", JSON_OBJECT)
			.req("waitMs", integer(0, 600_000))
			.req("replace", bool()));

	public static final MessageType<SkillProgress> SKILL_PROGRESS = type("skill.progress", Direction.MOD_TO_NODE, SkillProgress.class, object()
			.req("jobId", JOB_ID)
			.req("agentId", AGENT_ID)
			.opt("progress", FRACTION)
			.req("text", string(1, 256)));

	public static final MessageType<SkillCancel> SKILL_CANCEL = type("skill.cancel", Direction.NODE_TO_MOD, SkillCancel.class, object()
			.req("agentId", AGENT_ID)
			.opt("jobId", JOB_ID)
			.req("reason", string(1, 128)));

	public static final MessageType<SkillResult> SKILL_RESULT = type("skill.result", Direction.MOD_TO_NODE, SkillResult.class, object()
			.req("jobId", JOB_ID)
			.req("agentId", AGENT_ID)
			.req("status", oneOf(DONE, FAILED, CANCELLED))
			.opt("result", JSON_OBJECT)
			.opt("error", FAILURE)
			.req("durationMs", NON_NEG_INT));

	public static final MessageType<ObsQuery> OBS_QUERY = type("obs.query", Direction.NODE_TO_MOD, ObsQuery.class, object()
			.req("agentId", AGENT_ID)
			.req("query", oneOf(OBS_QUERIES.toArray(String[]::new)))
			.req("args", JSON_OBJECT));

	/** Schemas of the {@code ok} results, for tests and for checking replies. */
	public static final Schema.Obj SKILL_RUN_RESULT = object()
			.req("jobId", JOB_ID)
			.req("status", oneOf(RUNNING, DONE, FAILED, CANCELLED))
			.opt("result", JSON_OBJECT)
			.opt("error", FAILURE);

	public static final Schema.Obj SKILL_CANCEL_RESULT = object().req("cancelled", array(JOB_ID, 0, 16));

	public static final Schema.Obj OBS_QUERY_RESULT = object().req("result", JSON_OBJECT);

	public static final List<MessageType<?>> TYPES = List.of(SKILL_RUN, SKILL_PROGRESS, SKILL_CANCEL, SKILL_RESULT, OBS_QUERY);
}
