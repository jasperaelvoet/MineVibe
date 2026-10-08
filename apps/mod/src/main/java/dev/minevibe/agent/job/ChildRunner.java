package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import org.jspecify.annotations.Nullable;

/**
 * Runs {@link SkillJob}s one at a time inside a parent job ({@code sequence}, the craft tree): the parent is what the
 * {@link JobRunner} holds, and it hands each child the lifecycle the runner would (start on the first tick, preempt and
 * resume around reflexes, cancel, then {@link SkillJob#onEnd} exactly once), so a child behaves as it does on its own.
 */
public final class ChildRunner {
	private @Nullable SkillJob child;
	private boolean started;
	private SkillJob.@Nullable Outcome last;

	/** Starts {@code job} on the next {@link #tick}. Any child still running is cancelled first. */
	public void begin(final AgentPlayer agent, final SkillJob job) {
		this.cancel(agent, "replaced by " + job.skill());
		this.child = job;
		this.started = false;
		this.last = null;
	}

	public boolean active() {
		return this.child != null;
	}

	public @Nullable SkillJob child() {
		return this.child;
	}

	/** How the last child ended (null while one runs, or before the first). */
	public SkillJob.@Nullable Outcome last() {
		return this.last;
	}

	/** One tick of the child: RUNNING while it works, DONE or FAILED once it ended (then {@link #last} is set). */
	public Job.Status tick(final AgentPlayer agent) {
		SkillJob job = this.child;
		if (job == null) {
			return Job.Status.DONE;
		}
		if (!this.started) {
			this.started = true;
			job.start(agent);
		}
		Job.Status s = job.tick(agent);
		if (s != Job.Status.RUNNING) {
			this.child = null;
			// What the JobRunner does when a job ends: nothing the child held stays pressed.
			agent.controls().releaseAll();
			agent.navigator().stop();
			job.onEnd(agent, s, s == Job.Status.DONE ? "done" : job.failureReason());
			this.last = job.outcome().getNow(null);
		}
		return s;
	}

	public void preempt(final AgentPlayer agent) {
		if (this.child != null && this.started) {
			this.child.onPreempt(agent);
		}
	}

	public void resume(final AgentPlayer agent) {
		if (this.child != null && this.started) {
			this.child.onResume(agent);
		}
	}

	/** Cancels the running child (its outcome is {@code cancelled} with {@code reason}). */
	public void cancel(final AgentPlayer agent, final String reason) {
		SkillJob job = this.child;
		if (job == null) {
			return;
		}
		this.child = null;
		if (this.started) {
			job.cancel(agent);
		}
		job.onEnd(agent, null, reason);
		this.last = job.outcome().getNow(null);
	}
}
