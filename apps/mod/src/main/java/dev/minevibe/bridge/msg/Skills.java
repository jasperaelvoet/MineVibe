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
			"ride", "dismount", "emote", "sequence");

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

	/**
	 * N→M request. Reply: {@link SkillRunResult}. {@code consent} (W1) is the player's consent for changing protected
	 * blocks: Node attaches it, outside {@code args}, only after the player agreed; it counts only together with
	 * {@code args.allow_protected}.
	 */
	public record SkillRun(String jobId, String agentId, String skill, JsonObject args, int waitMs, boolean replace, @Nullable Consent consent) {
		public SkillRun(String jobId, String agentId, String skill, JsonObject args, int waitMs, boolean replace) {
			this(jobId, agentId, skill, args, waitMs, replace, null);
		}
	}

	/** A consent token the mod offered with a {@code PROTECTED} failure ({@code result.protected.consentId}). */
	public record Consent(String token) {}

	/** {@code status}: running, done, failed, cancelled. */
	public record SkillRunResult(
			String jobId, String status, @Nullable JsonObject result, Types.@Nullable Failure error, @Nullable Replaced replaced) {}

	/** The job a {@code replace: true} run cancelled (cap {@code run.replaced}): its id, skill and last progress. */
	public record Replaced(String jobId, String skill, @Nullable String text) {}

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

		/** {@code allow_protected} (W1) counts only with Node's {@code consent} on the {@code skill.run}. */
		public record Mine(String block, int count, @Nullable BlockPos near, @Nullable Integer radius, @Nullable Boolean allow_protected) {}

		/**
		 * {@code replant}: plant a sapling on each stump of a felled tree (when the agent has one). {@code near} and
		 * {@code make_tools}: the v2 gather (cap {@code collect.gather}).
		 */
		public record Collect(
				String item,
				int count,
				@Nullable Integer radius,
				@Nullable Boolean replant,
				@Nullable Boolean allow_protected,
				@Nullable BlockPos near,
				@Nullable Boolean make_tools) {}

		public record Hunt(String entity, int count, @Nullable Integer radius) {}

		public record Dig(BlockPos from, BlockPos to, @Nullable Boolean allow_protected) {}

		public record Place(String block, BlockPos pos, @Nullable Boolean allow_protected) {}

		/** {@code allow_protected} (W1): a right-click that takes from or retunes a protected block, with Node's consent. */
		public record UseBlock(BlockPos pos, @Nullable Boolean allow_protected) {}

		public record UseItem(@Nullable String item, @Nullable BlockPos pos, @Nullable String entity, @Nullable Boolean allow_protected) {}

		public record Attack(String entity, @Nullable Boolean allow_protected) {}

		/** {@code slot}: mainhand, offhand, head, chest, legs, feet. */
		public record Equip(String item, @Nullable String slot) {}

		public record Eat(@Nullable String item) {}

		public record Sleep(@Nullable BlockPos pos) {}

		public record Pickup(@Nullable String item, @Nullable Integer radius) {}

		public record Drop(String item, @Nullable Integer count) {}

		/** Without {@code count}: everything of the item (cap {@code give.all}). */
		public record Give(String item, @Nullable Integer count, String to) {}

		/**
		 * {@code tree} / {@code gather_missing}: the recipe tree (cap {@code craft.tree}); {@code allow_protected} (W1) covers
		 * its child jobs, with Node's {@code consent}.
		 */
		public record Craft(String item, int count, @Nullable BlockPos table, @Nullable Boolean tree, @Nullable Boolean gather_missing,
				@Nullable Boolean allow_protected) {}

		public record Smelt(String item, int count, @Nullable String fuel, @Nullable BlockPos furnace) {}

		/** {@code action}: list, put, take ({@code item} needed for put and take). */
		public record Container(
				@Nullable BlockPos pos, String action, @Nullable String item, @Nullable Integer count, @Nullable Boolean allow_protected) {}

		/** Exactly one of {@code pos} / {@code entity}. */
		public record OpenMenu(@Nullable BlockPos pos, @Nullable String entity) {}

		/**
		 * {@code type}: pickup, quick_move, swap, clone, throw, quick_craft, pickup_all. {@code allow_protected} (W1): a
		 * click that takes from the player's chest, with Node's consent.
		 */
		public record MenuClick(int slot, int button, String type, @Nullable Boolean allow_protected) {}

		public record MenuClose() {}

		/** {@code rotation}: 0, 90, 180 or 270. */
		public record Build(String blueprint, BlockPos origin, @Nullable Integer rotation, @Nullable Boolean allow_protected) {}

		public record Farm(BlockPos from, BlockPos to, @Nullable String crop, @Nullable Boolean allow_protected) {}

		public record Ride(String entity) {}

		public record Dismount() {}

		/** {@code kind}: wave, nod, shake_head, point, cheer, facepalm. */
		public record Emote(String kind) {}

		/** One step of a {@link Sequence}: a skill (not {@code sequence} or {@code emote}) and its args. */
		public record SequenceStep(String skill, JsonObject args) {}

		/** 2-8 skills as one job (cap {@code skill.sequence}); {@code stop_on_fail} defaults to true. */
		public record Sequence(List<SequenceStep> steps, @Nullable Boolean stop_on_fail, @Nullable Boolean allow_protected) {}
	}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Node SKILL_NAME = oneOf(SKILL_NAMES.toArray(String[]::new));
	static final Schema.Obj FAILURE = object().req("code", ERROR_CODE).req("msg", string(0, 2000));

	/** 32 lowercase hex characters, minted by the mod ({@code Consents}). */
	public static final Schema.Node CONSENT_TOKEN = string(32, 32, "[0-9a-f]{32}", "consent token: 32 hex");

	public static final MessageType<SkillRun> SKILL_RUN = type("skill.run", Direction.NODE_TO_MOD, SkillRun.class, object()
			.req("jobId", JOB_ID)
			.req("agentId", AGENT_ID)
			.req("skill", SKILL_NAME)
			.req("args", JSON_OBJECT)
			.req("waitMs", integer(0, 600_000))
			.req("replace", bool())
			.opt("consent", object().req("token", CONSENT_TOKEN)));

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

	// -----------------------------------------------------------------------------------------
	// W1: world awareness and protection (additive; inside the free-form `result` objects)
	// -----------------------------------------------------------------------------------------

	/** {@code result.protected} of a job that failed with {@code PROTECTED}. {@code what}: player-built, base. */
	public record ProtectedDetail(
			BlockPos pos, String what, String owner, String block, @Nullable String zone, int count, @Nullable String consentId, String hint) {}

	/** One source a job saw but could not use. {@code why}: unreachable, too_far, protected, not_natural. */
	public record SourceCandidate(BlockPos pos, String block, int distance, String dir, String why, @Nullable String owner) {}

	/** {@code result.noNaturalSource} of a job that failed with {@code NO_NATURAL_SOURCE}. */
	public record NoNaturalSource(String what, int radius, List<SourceCandidate> candidates, String hint) {}

	/** The {@code result} of {@code obs.query look_around}: the scene text plus a few machine-readable facts. */
	public record LookAround(String scene, String detail, @Nullable ZoneFact zone, @Nullable List<TreeFact> trees) {}

	/** Where the agent is relative to a protected zone ({@code distance} 0 = inside). */
	public record ZoneFact(String name, boolean inside, int distance, String owner) {}

	/** A natural tree seen by {@code look_around}. {@code reachable}: reachable, unreachable, far. */
	public record TreeFact(String species, BlockPos trunk, int distance, String dir, String reachable, int logs) {}

	public static final Schema.Node COMPASS_DIR = oneOf("N", "NE", "E", "SE", "S", "SW", "W", "NW", "here", "above", "below");

	public static final Schema.Obj PROTECTED_DETAIL = object()
			.req("pos", Types.BLOCK_POS)
			.req("what", oneOf("player-built", "base"))
			.req("owner", string(1, 48))
			.req("block", string(1, 128))
			.opt("zone", string(1, 48))
			.req("count", integer(1, 1_000_000))
			.opt("consentId", CONSENT_TOKEN)
			.req("hint", string(1, 400));

	public static final Schema.Obj SOURCE_CANDIDATE = object()
			.req("pos", Types.BLOCK_POS)
			.req("block", string(1, 128))
			.req("distance", integer(0, 100_000))
			.req("dir", COMPASS_DIR)
			.req("why", oneOf("unreachable", "too_far", "protected", "not_natural"))
			.opt("owner", string(1, 48));

	public static final Schema.Obj NO_NATURAL_SOURCE = object()
			.req("what", string(1, 160))
			.req("radius", integer(1, 64))
			.req("candidates", array(SOURCE_CANDIDATE, 0, 8))
			.req("hint", string(1, 400));

	public static final Schema.Obj LOOK_AROUND = object()
			.req("scene", string(1, 2500))
			.req("detail", oneOf("brief", "full"))
			.opt("zone", object().req("name", string(1, 48)).req("inside", bool()).req("distance", integer(0, 100_000_000)).req("owner", string(1, 48)))
			.opt("trees", array(object()
					.req("species", string(1, 64))
					.req("trunk", Types.BLOCK_POS)
					.req("distance", integer(0, 100_000))
					.req("dir", COMPASS_DIR)
					.req("reachable", oneOf("reachable", "unreachable", "far"))
					.req("logs", integer(1, 1000)), 0, 8));

	/** Schemas of the {@code ok} results, for tests and for checking replies. */
	public static final Schema.Obj SKILL_RUN_RESULT = object()
			.req("jobId", JOB_ID)
			.req("status", oneOf(RUNNING, DONE, FAILED, CANCELLED))
			.opt("result", JSON_OBJECT)
			.opt("error", FAILURE)
			.opt("replaced", object().req("jobId", JOB_ID).req("skill", string(1, 32)).opt("text", string(0, 256)));

	public static final Schema.Obj SKILL_CANCEL_RESULT = object().req("cancelled", array(JOB_ID, 0, 16));

	public static final Schema.Obj OBS_QUERY_RESULT = object().req("result", JSON_OBJECT);

	public static final List<MessageType<?>> TYPES = List.of(SKILL_RUN, SKILL_PROGRESS, SKILL_CANCEL, SKILL_RESULT, OBS_QUERY);
}
