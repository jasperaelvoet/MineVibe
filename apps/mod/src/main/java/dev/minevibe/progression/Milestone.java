package dev.minevibe.progression;

import com.mojang.serialization.Codec;
import dev.minevibe.MineVibeMod;
import net.minecraft.resources.Identifier;
import net.minecraft.util.StringRepresentable;
import org.jspecify.annotations.Nullable;

/**
 * What the guide's {@code minevibe:milestone} criteria count (see {@link MilestoneTrigger}). A <b>counted</b> milestone
 * is a custom statistic ({@code minevibe:<id>}, listed in the Statistics screen) that goes up by one each time it
 * happens, and its criteria compare that running total; a <b>gauge</b> is a value read as it is (the crew size, the
 * in-game day, the world number), so a criterion can ask for "4 agents at once" or "day 30".
 */
public enum Milestone implements StringRepresentable {
	/** A chat line or AgentScreen reply Node accepted. */
	CHAT_SENT("chat_sent", true),
	/** Any card answered: a question, a plan (approved or sent back), a hire (either way) or a calendar request. */
	CARD_ANSWERED("card_answered", true),
	PLAN_APPROVED("plan_approved", true),
	HIRE_DECLINED("hire_declined", true),
	/** Follow, Stay, Guard, Wander or Stop from an AgentScreen. */
	ORDER_GIVEN("order_given", true),
	AGENT_DISMISSED("agent_dismissed", true),
	CODEX_WRITTEN("codex_written", true),
	CALENDAR_BOOKED("calendar_booked", true),
	MEETING_HELD("meeting_held", true),
	/** The player sat down at a PC. */
	PC_SAT("pc_sat", true),
	/** One of the player's agents sat down at a PC. */
	AGENT_AT_PC("agent_at_pc", true),
	/** An agent following the player killed a monster near them. */
	GUARDED("guarded", true),
	/** An agent tossed the hungry player food. */
	FED_BY_AGENT("fed_by_agent", true),
	AGENT_LOST("agent_lost", true),
	GRAVE_OPENED("grave_opened", true),
	// Computer work, reported by Node (progress.milestone; apps/server/src/progress/MilestoneWatcher.ts).
	/** A PC finished booting (any family), and a macOS one. */
	PC_BOOTED("pc_booted", true),
	MAC_BOOTED("mac_booted", true),
	/** An agent's desk session took over at a PC: a fresh one, or one resumed where it left off. */
	DESK_SESSION("desk_session", true),
	DESK_RESUMED("desk_resumed", true),
	/** A foreground command an agent ran at a PC finished, and one that exited non-zero. */
	COMMAND_RUN("command_run", true),
	COMMAND_FAILED("command_failed", true),
	PACKAGE_INSTALLED("package_installed", true),
	TESTS_PASSED("tests_passed", true),
	GIT_COMMIT("git_commit", true),
	GIT_PUSH("git_push", true),
	/** {@code gh pr create} succeeded. */
	PR_OPENED("pr_opened", true),
	FILE_WRITTEN("file_written", true),
	/** WebSearch or WebFetch from a desk session. */
	WEB_USED("web_used", true),
	/** A browser, app, file or URL opened on a PC's screen. */
	APP_OPENED("app_opened", true),
	/** An agent wrote a new Codex page of its own. */
	AGENT_CODEX("agent_codex", true),
	/** A meeting ran to the end with someone there, and its minutes went into the Codex. */
	MEETING_MINUTES("meeting_minutes", true),
	CALENDAR_FIRED("calendar_fired", true),
	/** Input and output tokens the crew used (Node sends each turn's as the amount). */
	TOKENS("tokens", true),
	/** The crew went Tired (usage running low), or fell Asleep (out of usage). */
	BRAINS_TIRED("brains_tired", true),
	BRAINS_ASLEEP("brains_asleep", true),
	/** Gauge: living agents in the crew. */
	CREW_SIZE("crew_size", false),
	/** Gauge: the in-game day of this world (1 on the first day). */
	DAY("day", false),
	/** Gauge: which world this is (World #N). */
	WORLD("world", false);

	public static final Codec<Milestone> CODEC = StringRepresentable.fromEnum(Milestone::values);

	private final String id;
	private final boolean counted;
	/** One instance: the stat registry finds its values by identity. */
	private final Identifier stat;

	Milestone(final String id, final boolean counted) {
		this.id = id;
		this.counted = counted;
		this.stat = MineVibeMod.id(id);
	}

	public String id() {
		return this.id;
	}

	/** True when this is a running total kept as the custom statistic {@link #stat()}. */
	public boolean counted() {
		return this.counted;
	}

	/** The custom statistic of a counted milestone ({@code minevibe:<id>}). */
	public Identifier stat() {
		return this.stat;
	}

	/** The milestone named {@code id}, or null. */
	public static @Nullable Milestone byId(final String id) {
		for (Milestone m : values()) {
			if (m.id.equals(id)) {
				return m;
			}
		}
		return null;
	}

	@Override
	public String getSerializedName() {
		return this.id;
	}
}
