package dev.minevibe.agent.job;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.world.provenance.Consents;
import dev.minevibe.world.provenance.Protection;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * A job started through the skill API ({@code skill.run}, {@code agent.seat}; PLAN 7.4). On top of {@link Job} it
 * carries what the bridge reports: a skill-specific {@link #result()}, a typed failure ({@code code} + message, e.g.
 * {@code UNREACHABLE}, {@code NO_ITEM}), throttled progress ("12/20 logs"), and an {@link #outcome()} future that
 * completes exactly once when the job leaves the {@link JobRunner}.
 *
 * <p>Subclasses implement {@link #step}; {@link #tick} adds the timeout (counted in ticks the job was in control,
 * so time spent fighting or eating does not count) and refuses to move a seated or riding body.
 */
public abstract class SkillJob implements Job {
	/** How a job ended. {@code status} is {@code done}, {@code failed} or {@code cancelled}. */
	public record Outcome(String status, JsonObject result, @Nullable String code, @Nullable String message) {
		public boolean done() {
			return "done".equals(this.status);
		}
	}

	protected static final int SECOND = 20;
	protected static final int MINUTE = 60 * SECOND;

	private final String skill;
	private @Nullable String jobId;
	protected final JsonObject result = new JsonObject();
	private @Nullable String failureCode;
	private String failureMessage = "";
	private @Nullable Double progress;
	private String progressText = "";
	private int progressVersion;
	private final CompletableFuture<Outcome> outcome = new CompletableFuture<>();
	protected int ticks;

	protected SkillJob(final String skill) {
		this.skill = skill;
	}

	@Override
	public final String name() {
		return this.skill;
	}

	public final String skill() {
		return this.skill;
	}

	/** The bridge job id, once {@code SkillService} has bound it (null for jobs started otherwise). */
	public @Nullable String jobId() {
		return this.jobId;
	}

	public void bind(final String jobId) {
		this.jobId = jobId;
	}

	/** Completes once, when the job finished or was cancelled. */
	public CompletableFuture<Outcome> outcome() {
		return this.outcome;
	}

	public JsonObject result() {
		return this.result;
	}

	public @Nullable Double progress() {
		return this.progress;
	}

	public String progressText() {
		return this.progressText;
	}

	/** Bumped every time progress changes (the bridge sends at most one {@code skill.progress} a second). */
	public int progressVersion() {
		return this.progressVersion;
	}

	/** Controlled ticks so far. */
	public int ticks() {
		return this.ticks;
	}

	@Override
	public void start(final AgentPlayer agent) {
	}

	/** Upper bound on controlled ticks; past it the job fails with {@code TIMEOUT}. */
	protected int timeoutTicks() {
		return 5 * MINUTE;
	}

	@Override
	public final Status tick(final AgentPlayer agent) {
		if (++this.ticks > this.timeoutTicks()) {
			return this.fail("TIMEOUT", this.skill + " took longer than " + this.timeoutTicks() / SECOND + " s");
		}
		if (agent.isPassenger() && !this.worksSeated()) {
			return this.fail("SEATED", "stand up (or dismount) before " + this.skill);
		}
		try {
			return this.step(agent);
		} catch (dev.minevibe.bridge.BridgeException e) {
			// A reference that turned out to be bad while running (an unknown entity type, say): the job fails, the tick goes on.
			return this.fail(e.code(), String.valueOf(e.getMessage()));
		} catch (RuntimeException e) {
			org.slf4j.LoggerFactory.getLogger("MineVibe/Skills").error("{} job of {} failed", this.skill, agent.agentId(), e);
			return this.fail("INTERNAL", this.skill + " failed: " + e);
		}
	}

	/** One tick of work while the job is in control. */
	protected abstract Status step(AgentPlayer agent);

	protected final Status fail(final String code, final String message) {
		this.failureCode = code;
		this.failureMessage = message;
		return Status.FAILED;
	}

	protected final Status done() {
		return Status.DONE;
	}

	// ---------------------------------------------------------------- protection (W1)

	private boolean allowProtected;
	private boolean consented;
	/** See {@link #pinKind()}. */
	private boolean kindPinned;

	/**
	 * {@code args.allow_protected} as asked, and whether Node's {@code consent} token was valid (then {@code Consents}
	 * holds a grant for this job). Set by {@code SkillService} before the job starts.
	 */
	public void protection(final boolean allowProtected, final boolean consented) {
		this.allowProtected = allowProtected;
		this.consented = consented;
	}

	public boolean consented() {
		return this.consented;
	}

	/**
	 * Fails with {@code PROTECTED}: {@code v} is the nearest protected thing this job would change, {@code all} every
	 * protected position it met (the box a consent covers). Offers a consent token for them ({@code Consents}), which
	 * Node keeps for when the player agrees, and teaches the agent to ask.
	 */
	protected final Status refuseProtected(final AgentPlayer agent, final Protection.Verdict v, final java.util.Collection<BlockPos> all) {
		java.util.List<BlockPos> positions = new java.util.ArrayList<>(all);
		if (!positions.contains(v.pos())) {
			positions.add(v.pos());
		}
		String token = Consents.offer(agent.agentId(), agent.level(), positions);
		JsonObject p = new JsonObject();
		p.add("pos", pos(v.pos()));
		p.addProperty("what", v.what().wire);
		// Clipped to the protocol's bounds (a hand-edited zones.json can hold long names).
		p.addProperty("owner", dev.minevibe.bridge.protocol.ProtocolCodec.clip(v.owner(), 48));
		p.addProperty("block", dev.minevibe.bridge.protocol.ProtocolCodec.clip(v.block(), 128));
		if (v.zone() != null) {
			p.addProperty("zone", dev.minevibe.bridge.protocol.ProtocolCodec.clip(v.zone(), 48));
		}
		p.addProperty("count", positions.size());
		if (token != null) {
			p.addProperty("consentId", token);
		}
		p.addProperty("hint", dev.minevibe.bridge.protocol.ProtocolCodec.clip(v.hint(), 400));
		this.result.add("protected", p);
		String more = positions.size() > 1 ? ", and " + (positions.size() - 1) + " more" : "";
		String where = v.block().replace("minecraft:", "") + " at " + v.pos().getX() + " " + v.pos().getY() + " " + v.pos().getZ();
		String tail = this.allowProtected && !this.consented
			? " allow_protected only works once " + v.owner() + " has agreed: ask " + v.owner() + " first."
			: " Nothing was changed. Ask " + v.owner() + "; only if they agree, retry with allow_protected.";
		return this.fail("PROTECTED", v.hint() + " (" + where + more + ")." + tail);
	}

	/**
	 * The kind asked for is the only one that will do (the craft tree gathers it for a recipe that names it, such as
	 * the oak logs of oak planks): {@code NO_NATURAL_SOURCE} never offers its family then.
	 */
	final SkillJob pinKind() {
		this.kindPinned = true;
		return this;
	}

	/**
	 * Fails with {@code NO_NATURAL_SOURCE}: nothing natural and reachable of {@code what} within {@code radius}. Lists
	 * the nearest sources it saw and why they were no good, and says never to take something else instead: unless
	 * {@code what} is one kind of a material family ({@link Families}, oak logs), when that holds only if the player
	 * named the kind; an ingredient they did not name is gathered as its family, without asking.
	 */
	protected final Status noNaturalSource(
		final AgentPlayer agent, final String what, final int radius, final java.util.List<dev.minevibe.agent.perception.Sources.Candidate> candidates
	) {
		JsonObject d = new JsonObject();
		d.addProperty("what", dev.minevibe.bridge.protocol.ProtocolCodec.clip(what, 160));
		d.addProperty("radius", Math.max(1, Math.min(64, radius)));
		JsonArray arr = new JsonArray();
		for (dev.minevibe.agent.perception.Sources.Candidate c : candidates) {
			arr.add(c.toJson());
		}
		d.add("candidates", arr);
		String player = Protection.playerName(agent.level().getServer());
		String family = this.kindPinned ? null : Families.of(what);
		String hint = family == null
			? "Don't take anything else instead. Tell " + player + " what you found and ask what to do (another place, or permission)."
			: "If " + player + " named this kind, don't take another instead: tell " + player + " what you found and ask. If it is only an ingredient"
				+ " (planks, sticks, tools, a furnace), any kind will do: gather " + family + " (the nearest kind), no need to ask.";
		d.addProperty("hint", hint);
		this.result.add("noNaturalSource", d);
		StringBuilder msg = new StringBuilder("No reachable natural ").append(what).append(" within ").append(radius).append(" blocks");
		if (!candidates.isEmpty()) {
			msg.append(". Seen: ");
			for (int i = 0; i < candidates.size(); i++) {
				msg.append(i == 0 ? "" : "; ").append(candidates.get(i).describe());
			}
		}
		msg.append(". ").append(hint);
		return this.fail("NO_NATURAL_SOURCE", msg.toString());
	}

	protected final void progress(final @Nullable Double fraction, final String text) {
		Double f = fraction == null ? null : Math.max(0.0, Math.min(1.0, fraction));
		if (!text.equals(this.progressText) || !java.util.Objects.equals(f, this.progress)) {
			this.progress = f;
			this.progressText = text;
			this.progressVersion++;
		}
	}

	public @Nullable String failureCode() {
		return this.failureCode;
	}

	/** The message of the failure (empty when there is none). */
	public String failureMessage() {
		return this.failureMessage;
	}

	@Override
	public String failureReason() {
		return this.failureCode == null ? "failed" : this.failureCode + ": " + this.failureMessage;
	}

	@Override
	public void onEnd(final AgentPlayer agent, final Job.@Nullable Status status, final String reason) {
		this.onFinish(agent);
		if (status == Status.DONE) {
			this.outcome.complete(new Outcome("done", this.result, null, null));
		} else if (status == Status.FAILED) {
			String code = this.failureCode == null ? "FAILED" : this.failureCode;
			this.outcome.complete(new Outcome("failed", this.result, code, this.failureMessage.isEmpty() ? reason : this.failureMessage));
		} else {
			this.outcome.complete(new Outcome("cancelled", this.result, "INTERRUPTED", reason));
		}
	}

	/** Clean-up that must happen however the job ends (close a menu, release a reservation). */
	protected void onFinish(final AgentPlayer agent) {
	}

	// ---------------------------------------------------------------- result helpers

	protected final void put(final String key, final @Nullable Object value) {
		this.result.add(key, toJson(value));
	}

	public static JsonElement toJson(final @Nullable Object value) {
		if (value == null) {
			return com.google.gson.JsonNull.INSTANCE;
		}
		if (value instanceof JsonElement e) {
			return e;
		}
		if (value instanceof Number n) {
			return new com.google.gson.JsonPrimitive(n);
		}
		if (value instanceof Boolean b) {
			return new com.google.gson.JsonPrimitive(b);
		}
		if (value instanceof BlockPos p) {
			return pos(p);
		}
		if (value instanceof Vec3 v) {
			JsonObject o = new JsonObject();
			o.addProperty("x", Math.round(v.x * 100.0) / 100.0);
			o.addProperty("y", Math.round(v.y * 100.0) / 100.0);
			o.addProperty("z", Math.round(v.z * 100.0) / 100.0);
			return o;
		}
		if (value instanceof int[] ints) {
			// v1 craft's `ingredients: {name: [need, have]}`.
			JsonArray a = new JsonArray();
			for (int i : ints) {
				a.add(i);
			}
			return a;
		}
		if (value instanceof Iterable<?> it) {
			JsonArray a = new JsonArray();
			for (Object o : it) {
				a.add(toJson(o));
			}
			return a;
		}
		if (value instanceof java.util.Map<?, ?> m) {
			JsonObject o = new JsonObject();
			for (java.util.Map.Entry<?, ?> e : m.entrySet()) {
				o.add(String.valueOf(e.getKey()), toJson(e.getValue()));
			}
			return o;
		}
		return new com.google.gson.JsonPrimitive(String.valueOf(value));
	}

	public static JsonObject pos(final BlockPos p) {
		JsonObject o = new JsonObject();
		o.addProperty("x", p.getX());
		o.addProperty("y", p.getY());
		o.addProperty("z", p.getZ());
		return o;
	}
}
