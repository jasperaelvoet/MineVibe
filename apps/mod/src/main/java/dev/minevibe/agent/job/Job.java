package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import org.jspecify.annotations.Nullable;

/**
 * A long-running unit of work issued by the brain (LLM) through the skill API (PLAN 7.4), e.g.
 * {@code mc__goto} or {@code mc__mine}. Jobs run at reflex priority 35: any higher reflex (hazard,
 * combat, eating) preempts them, and they resume afterwards.
 *
 * <p>Lifecycle: {@link #start} once, then {@link #tick} every tick it is in control. When a reflex takes
 * over, {@link #onPreempt} is called; when control returns, {@link #onResume}. {@link #cancel} is called
 * when the job is replaced or stopped before finishing.
 */
public interface Job {
	enum Status {
		RUNNING,
		DONE,
		FAILED
	}

	String name();

	void start(AgentPlayer agent);

	Status tick(AgentPlayer agent);

	/** A reflex took control. Release controls the job was holding. */
	default void onPreempt(final AgentPlayer agent) {
		agent.controls().releaseAll();
		agent.navigator().stop();
	}

	/** Control returned after a preemption. Re-issue navigation or held inputs. */
	default void onResume(final AgentPlayer agent) {
	}

	default void cancel(final AgentPlayer agent) {
		agent.controls().releaseAll();
		agent.navigator().stop();
	}

	/** Why the job failed, for the {@code job.failed} event. */
	default String failureReason() {
		return "failed";
	}

	/**
	 * Called exactly once when the job leaves the {@link JobRunner}: with {@link Status#DONE} or {@link Status#FAILED}
	 * when it finished, or with a null status when it was cancelled (replaced, stopped, the agent died or left) before it
	 * did; {@code reason} says why. Called after {@link #cancel}, whether or not the job had started.
	 */
	default void onEnd(final AgentPlayer agent, final @Nullable Status status, final String reason) {
	}

	/** True if the job may run while the agent sits (eat, equip, emote); others fail while seated or riding. */
	default boolean worksSeated() {
		return false;
	}
}
