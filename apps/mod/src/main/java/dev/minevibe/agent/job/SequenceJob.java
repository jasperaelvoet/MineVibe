package dev.minevibe.agent.job;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * {@code sequence{steps:[{skill, args}], stop_on_fail?}} (docs/design/tools-v2-mc.md M1): 2-8 skills as one job, in
 * order, under one job id, so the agent is not woken between them. Every step was built up front (a bad step fails the
 * whole request with {@code BAD_ARGS} before anything runs); they run through a {@link ChildRunner}, so reflexes pause
 * and resume the running step, and a cancel cancels it.
 *
 * <p>With {@code stop_on_fail} (the default) the first failed step fails the sequence with that step's code and the
 * message {@code step i/n <skill>: <msg>}; without it the rest still run and the sequence fails at the end if any step
 * did. The result is {@code {completed, steps:[{skill, status, code?, msg?, result}]}} (steps that never ran are
 * absent). Progress reads {@code step i/n <the step's progress>}.
 */
public final class SequenceJob extends SkillJob {
	/** One step: the skill name and its job. */
	public record Step(String skill, SkillJob job) {
	}

	/** The longest a sequence may run (in controlled ticks). */
	public static final int MAX_TICKS = 40 * MINUTE;
	public static final int MIN_STEPS = 2;
	public static final int MAX_STEPS = 8;
	/** Skills that cannot be steps: no nesting, and emotes run beside jobs. */
	public static final java.util.Set<String> EXCLUDED = java.util.Set.of("sequence", "emote");

	private final List<Step> steps;
	private final boolean stopOnFail;
	private final ChildRunner runner = new ChildRunner();
	private final JsonArray done = new JsonArray();
	private int index;
	private int completed;
	private @Nullable String firstCode;
	private @Nullable String firstMessage;

	public SequenceJob(final List<Step> steps, final boolean stopOnFail) {
		super("sequence");
		this.steps = List.copyOf(steps);
		this.stopOnFail = stopOnFail;
	}

	public List<Step> steps() {
		return this.steps;
	}

	@Override
	protected int timeoutTicks() {
		long sum = 0;
		for (Step s : this.steps) {
			sum += s.job().timeoutTicks();
		}
		return (int)Math.min(MAX_TICKS, sum);
	}

	@Override
	public void onPreempt(final AgentPlayer agent) {
		super.onPreempt(agent);
		this.runner.preempt(agent);
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.runner.resume(agent);
	}

	@Override
	public void cancel(final AgentPlayer agent) {
		super.cancel(agent);
		this.runner.cancel(agent, "cancelled");
		this.record(this.runner.last());
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		int n = this.steps.size();
		if (!this.runner.active()) {
			if (this.index >= n) {
				return this.finish();
			}
			this.runner.begin(agent, this.steps.get(this.index).job());
		}
		SkillJob child = this.runner.child();
		Status s = this.runner.tick(agent);
		String childProgress = child == null ? "" : child.progressText();
		this.progress((this.index + (child != null && child.progress() != null ? child.progress() : 0.0)) / n,
			("step " + (this.index + 1) + "/" + n + " " + (childProgress.isEmpty() ? this.steps.get(Math.min(this.index, n - 1)).skill() : childProgress)).trim());
		if (s == Status.RUNNING) {
			return Status.RUNNING;
		}
		Outcome o = this.runner.last();
		this.record(o);
		Step step = this.steps.get(this.index);
		this.index++;
		if (o != null && o.done()) {
			this.completed++;
		} else {
			String code = o == null || o.code() == null ? "FAILED" : o.code();
			String msg = "step " + this.index + "/" + n + " " + step.skill() + ": " + (o == null || o.message() == null ? "failed" : o.message());
			if (this.firstCode == null) {
				this.firstCode = code;
				this.firstMessage = msg;
			}
			if (this.stopOnFail) {
				this.summarize();
				return this.fail(code, msg);
			}
		}
		return this.index >= n ? this.finish() : Status.RUNNING;
	}

	private Status finish() {
		this.summarize();
		if (this.firstCode != null) {
			return this.fail(this.firstCode, this.completed + "/" + this.steps.size() + " steps done; " + this.firstMessage);
		}
		return this.done();
	}

	/** Adds the step that just ended to the result list. */
	private void record(final @Nullable Outcome o) {
		if (o == null || this.done.size() > this.index) {
			return;
		}
		JsonObject e = new JsonObject();
		e.addProperty("skill", this.steps.get(Math.min(this.index, this.steps.size() - 1)).skill());
		e.addProperty("status", o.status());
		if (o.code() != null && !o.done()) {
			e.addProperty("code", o.code());
		}
		if (o.message() != null && !o.done()) {
			e.addProperty("msg", o.message().length() > 300 ? o.message().substring(0, 300) : o.message());
		}
		JsonObject r = o.result().deepCopy();
		r.remove("footer");
		e.add("result", r);
		this.done.add(e);
	}

	private void summarize() {
		this.put("completed", this.completed);
		this.put("steps", this.done);
	}

	@Override
	protected void onFinish(final AgentPlayer agent) {
		this.summarize();
	}
}
