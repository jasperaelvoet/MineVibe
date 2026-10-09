package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.RepeatBackoff;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.nav.DigGoal;
import dev.minevibe.agent.nav.NavBlocks;
import dev.minevibe.agent.nav.WaterMoves;
import it.unimi.dsi.fastutil.ints.IntArrayFIFOQueue;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Priority {@value #PRIORITY} (PLAN 7.3): out of water the agent's walk cannot get it out of. A pool whose banks
 * stand a block over the water line, an enclosed pocket in a cave: vanilla lifts a swimmer onto no bank higher than the
 * water line, so a walk (or a reflex following the player) that leads there fails over and over while the body treads
 * water, silently (the CEO of the live report sat in such a pool with no brain running).
 *
 * <p><b>Where it ranks.</b> Above the job and every reflex that walks the agent somewhere for others (feeding the
 * player, sharing food, approaching, attending), so none of them leads it back in mid-escape; below the ones that keep
 * it alive (Hazard, creeper backoff, critical heal, flee, protect, self-defence, eating). An escape takes up to a minute
 * (a step dug into stone by hand is 7.5 s); the agent still eats at 5 HP and fights back meanwhile, and the escape goes
 * on when they let go (review 2026-10-09: at 98 it held the body through all of them).
 *
 * <p><b>When.</b> In water for {@value #STUCK_TICKS} ticks (3 s) without getting {@value #PROGRESS_BLOCKS} blocks from
 * where it was, while the navigator means to move (walking, or its last walk failed; a search that spans ticks does not
 * count, nor a job working in place, nor an agent idling in the water beside the player it follows). Breaking a block
 * for the walk (a Tier-2 step dug into the bank from the bottom of shallow water) is progress too: a job's own way out is
 * never taken over halfway.
 *
 * <p><b>What.</b> Head above the water first (at most {@value #SURFACE_TICKS} ticks), then a Tier-2 walk to the
 * nearest dry land that leads somewhere ({@link DigGoal#ashore}): onto a bank level with the water line, onto a block
 * put in the water from the bag where none is that low, or up a step or staircase dug from a standing cell (never while
 * swimming), with the protection rules of every Tier-2 walk.
 *
 * <p><b>Stranded.</b> If that finds no way, the reflex lets go and the agent is stranded: it treads water at the surface
 * (breathing; {@link TreadWaterReflex#stranded}, below the job and the pickup reflex, so it still eats, fights, flees and
 * fetches a block tossed to it), speaks up (an urgency-2 {@code stuck} event, which wakes its brain, and the "stuck in
 * water" bark), and the escape looks again every {@value #RETRY_TICKS} ticks (the player may have helped), and at once
 * when the bag gains a block to step on. A stranded agent speaks up again only after {@value #SPEAK_AGAIN_TICKS} ticks,
 * then after twice that, up to {@value #SPEAK_AGAIN_MAX_TICKS} (each time is a brain turn); once it is out of the water,
 * the next stranding is said at once again (review 2026-10-09: a second pool within 5 minutes of the first was silent).
 *
 * <p><b>Jobs.</b> The job resumes after an escape. A job that leads the agent into water it cannot leave a third time,
 * or whose escapes failed twice, fails with {@code STUCK_IN_WATER} (and the agent speaks up): no job resumes into the
 * same water forever. Without a job, {@value #LOOP_ESCAPES} escapes within {@value #LOOP_WINDOW} ticks (a reflex that
 * keeps leading back in) are said out loud too, with the same growing gaps while the loop goes on.
 */
final class WaterEscapeReflex implements Reflex {
	static final int PRIORITY = 58;
	/** Ticks in water without progress (while meaning to move) before the escape takes over (3 s). */
	static final int STUCK_TICKS = 60;
	/** Getting this far from where the count started is progress. */
	static final double PROGRESS_BLOCKS = 2.0;
	/** Ticks the escape spends getting the head above the water before it looks for a way out. */
	static final int SURFACE_TICKS = 40;
	/** Ticks one escape may take (the search and the walk) before it counts as failed. */
	static final int ESCAPE_TICKS = 900;
	/** Stranded: ticks between looks for a way out. */
	static final int RETRY_TICKS = 300;
	/** Stranded with a job that gets one more try: ticks before the escape looks again. */
	static final int JOB_RETRY_TICKS = 100;
	/** Stranded: ticks before the agent speaks up again (5 minutes); doubled each time it does, up to the max. */
	static final int SPEAK_AGAIN_TICKS = 6000;
	/** The longest wait between two speak-ups about one stranding, or one loop (20 minutes). */
	static final int SPEAK_AGAIN_MAX_TICKS = 24000;
	/** Escapes a job may need: the next one fails it ({@code STUCK_IN_WATER}), as do this many escapes that failed. */
	static final int MAX_ESCAPES_PER_JOB = 2;
	/** Escapes without a job within {@link #LOOP_WINDOW} ticks that are said out loud. */
	static final int LOOP_ESCAPES = 3;
	static final int LOOP_WINDOW = 3600;
	/** Dry cells a walk reaches from where the escape ends ({@link DigGoal#ashore}). */
	static final int ASHORE_AREA = 12;
	/** The bark key for "I'm stuck in water: can you help, or should I dig out?" (Node says it; the client has the line). */
	static final String BARK = "stuck_in_water";

	private enum Phase {
		SURFACE,
		ESCAPE
	}

	// Progress while not engaged.
	private @Nullable Vec3 anchor;
	private int stuckTicks;
	private int quietUntil;

	// The escape under way.
	private boolean active;
	private Phase phase = Phase.SURFACE;
	private int phaseTicks;
	private int tries;
	private @Nullable Job job;
	private @Nullable BlockPos stuckAt;

	// Stranded: no way out found.
	private boolean stranded;
	private int retryAt;
	/** Blocks to step on in the bag when the agent was stranded: more (a block tossed to it) is a reason to look again. */
	private int strandedSteps;
	/** Speaking up about the water the agent is stuck in: once at once, repeats ever further apart; reset once out. */
	private final RepeatBackoff strandSpeak = new RepeatBackoff(SPEAK_AGAIN_TICKS, SPEAK_AGAIN_MAX_TICKS);
	/** Speaking up about escapes that keep happening without a job; reset after a quiet {@code 2 * LOOP_WINDOW}. */
	private final RepeatBackoff loopSpeak = new RepeatBackoff(SPEAK_AGAIN_TICKS, SPEAK_AGAIN_MAX_TICKS);
	private int lastEscapeAt = Integer.MIN_VALUE / 2;

	/** Per job: escapes started for it, and escapes that found no way out. */
	private final Map<Job, int[]> perJob = new WeakHashMap<>();
	/** When the last escapes without a job started (ticks). */
	private final IntArrayFIFOQueue recent = new IntArrayFIFOQueue();

	@Override
	public int priority() {
		return PRIORITY;
	}

	@Override
	public String name() {
		return "water_escape";
	}

	/** True while no way out of the water was found and the agent waits at the surface ({@link TreadWaterReflex}). */
	boolean stranded() {
		return this.stranded;
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (this.active) {
			return true;
		}
		boolean swimming = WaterMoves.swimming(agent);
		if (!swimming || agent.isInLava() || agent.isPassenger()) {
			this.anchor = null;
			this.stuckTicks = 0;
			if (this.stranded && !swimming) {
				// Out after all (the player built a step, a current carried the body to a bank, a job's walk got there).
				this.stranded = false;
				this.strandSpeak.reset();
				AgentEvents.emit(agent, "water.escaped", Map.of("out", "true", "at", agent.blockPosition().toShortString(), "how", "stranded"));
			}
			return false;
		}
		if (this.stranded) {
			// Look again now and then, or as soon as the bag holds more to step on; a job working in the water keeps the body
			// while it does not mean to move.
			boolean look = agent.tickCount >= this.retryAt || NavBlocks.stepCount(agent.getInventory()) > this.strandedSteps;
			return look && (!agent.jobs().hasJob() || meansToMove(agent));
		}
		Vec3 pos = agent.position();
		if (this.anchor == null || pos.distanceTo(this.anchor) > PROGRESS_BLOCKS) {
			this.anchor = pos;
			this.stuckTicks = 0;
			return false;
		}
		if (agent.tickCount < this.quietUntil || !meansToMove(agent)) {
			return false;
		}
		if (agent.controls().isMining()) {
			// Breaking a block for the walk (a step dug from the bottom of shallow water: 7.5 s for stone by hand) is progress.
			this.stuckTicks = 0;
			return false;
		}
		return ++this.stuckTicks >= STUCK_TICKS;
	}

	/**
	 * The body is meant to be somewhere else: its navigator walks (not merely searching a Tier-2 path, which keeps the
	 * body still for a few ticks), or its last walk failed. A job working in place, or an agent that arrived beside the
	 * player it follows, is where it means to be, in water or not.
	 */
	static boolean meansToMove(final AgentPlayer agent) {
		AgentNavigator nav = agent.navigator();
		if (nav.isPlanning()) {
			return false;
		}
		return nav.status() == AgentNavigator.Status.MOVING || nav.status() == AgentNavigator.Status.FAILED;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
		agent.controls().stopMovement();
		this.phase = Phase.SURFACE;
		this.phaseTicks = 0;
		if (this.active) {
			// Back after a higher reflex (Hazard, eating, a fight) had the body: the same escape goes on.
			return;
		}
		boolean retry = this.stranded;
		this.active = true;
		this.stranded = false;
		this.tries = 0;
		this.stuckAt = agent.blockPosition();
		Job current = agent.jobs().current();
		this.job = current;
		Map<String, String> log = new LinkedHashMap<>();
		log.put("at", agent.blockPosition().toShortString());
		log.put("job", current == null ? "-" : current.name());
		log.put("retry", Boolean.toString(retry));
		if (retry) {
			AgentEvents.emit(agent, "water.escape", log);
			return;
		}
		if (current != null) {
			int[] counts = this.perJob.computeIfAbsent(current, j -> new int[2]);
			counts[0]++;
			log.put("escapes", Integer.toString(counts[0]));
			AgentEvents.emit(agent, "water.escape", log);
			if (counts[0] > MAX_ESCAPES_PER_JOB) {
				this.failJob(agent, current, "it led me into water I could not get out of " + counts[0] + " times");
			}
			return;
		}
		AgentEvents.emit(agent, "water.escape", log);
		int now = agent.tickCount;
		if (now - this.lastEscapeAt > 2 * LOOP_WINDOW) {
			// The last loop (if any) is over.
			this.loopSpeak.reset();
		}
		this.lastEscapeAt = now;
		while (!this.recent.isEmpty() && now - this.recent.firstInt() > LOOP_WINDOW) {
			this.recent.dequeueInt();
		}
		this.recent.enqueue(now);
		if (this.recent.size() >= LOOP_ESCAPES && this.loopSpeak.due(now)) {
			this.recent.clear();
			this.loopSpeak.said(now);
			BlockPos at = agent.blockPosition();
			this.speakUp(agent, "loop", "I keep ending up in water I can't walk out of (" + LOOP_ESCAPES + " times in "
				+ LOOP_WINDOW / 1200 + " minutes, now at " + at.getX() + " " + at.getY() + " " + at.getZ()
				+ "). Ask the player to help, or say if I should dig out or stay put.");
		}
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		if (!this.active) {
			// Chosen again in the tick after it let go (stranded, and the bag just gained a block to step on): the brain only
			// starts a reflex it switches to, so the new look starts here. Without this the walk ran with the escape not
			// engaged, and was dropped half way (on the step it had just put in the water: no longer swimming).
			this.start(agent, brain);
		}
		this.phaseTicks++;
		AgentNavigator nav = agent.navigator();
		switch (this.phase) {
			case SURFACE -> {
				if (!agent.isUnderWater() || this.phaseTicks > SURFACE_TICKS || !airAbove(agent)) {
					// Up (or no air straight above to come up to: the search finds the nearest, within a held breath).
					this.search(agent);
				} else {
					WaterMoves.treadWater(agent);
				}
			}
			case ESCAPE -> {
				if (onDryLand(agent) && nav.status() != AgentNavigator.Status.MOVING) {
					this.end(agent);
					return;
				}
				switch (nav.status()) {
					case ARRIVED -> {
						if (onDryLand(agent)) {
							this.end(agent);
						} else if (++this.tries < 3) {
							this.search(agent);
						} else {
							this.strand(agent, "arrived_wet");
						}
					}
					case FAILED -> {
						String why = String.valueOf(nav.failureReason());
						// A walk knocked off its way (a current, a re-plan limit) may still find one from where it is now; no way
						// at all is final for now.
						if (!"no_path".equals(why) && !"too_far".equals(why) && ++this.tries < 3) {
							this.search(agent);
						} else {
							this.strand(agent, why);
						}
					}
					case IDLE -> this.search(agent);
					case MOVING -> {
						if (this.phaseTicks > ESCAPE_TICKS) {
							nav.stop();
							this.strand(agent, "timeout");
						}
					}
				}
			}
		}
	}

	private void search(final AgentPlayer agent) {
		this.phase = Phase.ESCAPE;
		this.phaseTicks = 0;
		agent.navigator().moveTo(DigGoal.ashore(WaterMoves.swimCell(agent), ASHORE_AREA));
	}

	/**
	 * No way out found: let go, tread water at the surface ({@link TreadWaterReflex}) and look again later. With the job
	 * it found the agent in: the second such failure fails the job (and speaks up); after the first, the job gets the body
	 * back once (its own walk may know better: its goal may lie in the water). Without a job the agent speaks up at once,
	 * and again only after {@value #SPEAK_AGAIN_TICKS} ticks, then ever further apart ({@link #strandSpeak}).
	 */
	private void strand(final AgentPlayer agent, final String why) {
		agent.navigator().stop();
		agent.controls().stopMovement();
		this.active = false;
		this.stranded = true;
		this.strandedSteps = NavBlocks.stepCount(agent.getInventory());
		this.anchor = null;
		this.stuckTicks = 0;
		AgentEvents.emit(agent, "water.escaped", Map.of("out", "false", "why", why, "at", agent.blockPosition().toShortString(),
			"from", this.stuckAt == null ? "-" : this.stuckAt.toShortString()));
		Job current = agent.jobs().current();
		if (current != null && current == this.job) {
			int[] counts = this.perJob.computeIfAbsent(current, j -> new int[2]);
			counts[1]++;
			if (counts[1] >= MAX_ESCAPES_PER_JOB) {
				this.retryAt = agent.tickCount + RETRY_TICKS;
				this.failJob(agent, current, "I found no way out of the water twice (" + why + ")");
			} else {
				this.retryAt = agent.tickCount + JOB_RETRY_TICKS;
			}
			return;
		}
		this.retryAt = agent.tickCount + RETRY_TICKS;
		if (this.strandSpeak.due(agent.tickCount)) {
			this.strandSpeak.said(agent.tickCount);
			BlockPos at = agent.blockPosition();
			this.speakUp(agent, why, "I'm stuck in water at " + at.getX() + " " + at.getY() + " " + at.getZ()
				+ " and found no way out (no bank low enough, nothing to step on, nowhere to stand and dig). Ask the player to help, or say if I should dig out.");
		}
	}

	private void failJob(final AgentPlayer agent, final Job job, final String detail) {
		BlockPos at = agent.blockPosition();
		agent.jobs().fail("STUCK_IN_WATER", "Stuck in water at " + at.getX() + " " + at.getY() + " " + at.getZ() + ": " + detail
			+ ". Ask for help (a block to step on, or a way out), or have me dig out from somewhere I can stand.");
		this.perJob.remove(job);
		this.job = null;
		// Said out loud here; a stranding right after it (no way out found) is not said again.
		this.strandSpeak.said(agent.tickCount);
		this.speakUp(agent, "job_failed", "My " + job.name() + " job kept leading me into water I can't get out of on my own (at " + at.getX() + " " + at.getY()
			+ " " + at.getZ() + "), so I stopped it (STUCK_IN_WATER). Ask the player to help, or say if I should dig out or go another way.");
	}

	/** An urgency-2 {@code stuck} event (the skill layer sends it; Node wakes the brain and says the bark). */
	private void speakUp(final AgentPlayer agent, final String why, final String text) {
		BlockPos at = agent.blockPosition();
		Map<String, String> data = new LinkedHashMap<>();
		data.put("why", "water");
		data.put("reason", why);
		data.put("pos", at.getX() + " " + at.getY() + " " + at.getZ());
		data.put("bark", BARK);
		data.put("text", text);
		AgentEvents.emit(agent, "nav.stuck_in_water", data);
	}

	/** Out of the water: the escape is over. */
	private void end(final AgentPlayer agent) {
		this.active = false;
		this.stranded = false;
		this.strandSpeak.reset();
		this.phase = Phase.SURFACE;
		this.anchor = null;
		this.stuckTicks = 0;
		this.quietUntil = agent.tickCount + 20;
		AgentEvents.emit(agent, "water.escaped", Map.of("out", "true", "at", agent.blockPosition().toShortString(),
			"from", this.stuckAt == null ? "-" : this.stuckAt.toShortString()));
		agent.navigator().stop();
		agent.controls().stopMovement();
	}

	/** True if the water column over the eyes opens into air within 8 blocks (no block on the water there). */
	static boolean airAbove(final AgentPlayer agent) {
		BlockPos.MutableBlockPos p = BlockPos.containing(agent.getX(), agent.getEyeY(), agent.getZ()).mutable();
		for (int i = 0; i < 8; i++) {
			if (!agent.level().getFluidState(p).isEmpty()) {
				p.move(0, 1, 0);
				continue;
			}
			return agent.level().getBlockState(p).getCollisionShape(agent.level(), p).isEmpty();
		}
		return false;
	}

	/** Standing on a dry floor, out of the water. */
	static boolean onDryLand(final AgentPlayer agent) {
		return !agent.isInWater() && agent.onGround();
	}

	@Override
	public boolean reported() {
		// Below the reflexes the brain hears about by priority, but an escape is worth a Digest line.
		return true;
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		// Preempted (Hazard, eating, a fight) or done: the walk stops; an escape under way goes on when control comes back.
		agent.navigator().stop();
		agent.controls().stopMovement();
	}
}
