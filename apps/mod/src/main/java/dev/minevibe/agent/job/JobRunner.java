package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Holds the agent's current {@link Job} and drives its lifecycle. One job at a time. */
public final class JobRunner {
	private final AgentPlayer agent;
	private @Nullable Job current;
	private boolean started;
	private boolean preempted;
	private Job.@Nullable Status lastStatus;
	private @Nullable String lastJobName;
	private int jobTicks;

	public JobRunner(final AgentPlayer agent) {
		this.agent = agent;
	}

	/** Replaces any current job (cancelling it) with {@code job}. It starts on its first controlled tick. */
	public void start(final Job job) {
		this.cancel("replaced by " + job.name());
		this.current = job;
		this.started = false;
		this.preempted = false;
		this.lastStatus = Job.Status.RUNNING;
		this.lastJobName = job.name();
		this.jobTicks = 0;
		AgentEvents.emit(this.agent, "job.started", Map.of("job", job.name()));
	}

	public void cancel() {
		this.cancel("cancelled");
	}

	/** Cancels the current job (if any); its {@link Job#onEnd} hears {@code reason}. */
	public void cancel(final String reason) {
		Job job = this.current;
		if (job != null) {
			if (this.started) {
				job.cancel(this.agent);
			}
			AgentEvents.emit(this.agent, "job.cancelled", Map.of("job", job.name(), "reason", reason));
			this.current = null;
			this.lastStatus = null;
			job.onEnd(this.agent, null, reason);
		}
	}

	public boolean hasJob() {
		return this.current != null;
	}

	public @Nullable Job current() {
		return this.current;
	}

	/** Status of the most recent job: RUNNING while it runs, then DONE/FAILED; null if cancelled or none. */
	public Job.@Nullable Status lastStatus() {
		return this.lastStatus;
	}

	public @Nullable String lastJobName() {
		return this.lastJobName;
	}

	/** Ticks the current (or last) job has been in control. */
	public int jobTicks() {
		return this.jobTicks;
	}

	/** Called by the brain when a reflex above priority 35 takes control. */
	public void preempt() {
		if (this.current != null && this.started && !this.preempted) {
			this.preempted = true;
			this.current.onPreempt(this.agent);
		}
	}

	/** True while the current job was preempted by a reflex and has not had control back yet. */
	public boolean isPreempted() {
		return this.current != null && this.preempted;
	}

	/** Called by the brain when the job is the highest-priority behaviour this tick. */
	public void tick() {
		Job job = this.current;
		if (job == null) {
			return;
		}
		if (!this.started) {
			this.started = true;
			job.start(this.agent);
		} else if (this.preempted) {
			this.preempted = false;
			job.onResume(this.agent);
		}
		this.jobTicks++;
		Job.Status status = job.tick(this.agent);
		if (status != Job.Status.RUNNING && this.current == job) {
			this.current = null;
			this.lastStatus = status;
			this.agent.controls().releaseAll();
			this.agent.navigator().stop();
			if (status == Job.Status.DONE) {
				AgentEvents.emit(this.agent, "job.done", Map.of("job", job.name(), "ticks", Integer.toString(this.jobTicks)));
			} else {
				AgentEvents.emit(this.agent, "job.failed", Map.of("job", job.name(), "reason", job.failureReason()));
			}
			job.onEnd(this.agent, status, status == Job.Status.DONE ? "done" : job.failureReason());
		}
	}
}
