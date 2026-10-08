package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.SkillJob;
import java.util.Locale;
import net.minecraft.world.item.ItemStack;

/**
 * The status footer every {@code mc} tool result ends with (PLAN 6.5 layer 2): about 25 tokens with HP, food, the
 * clock, the position and what the body is doing, e.g.
 * {@code HP 18/20 food 15 | day 3 08:12 | 120 64 -80 overworld | mining 12/20 oak_log | iron_sword}.
 */
public final class StatusFooter {
	private StatusFooter() {
	}

	public static String line(final AgentPlayer agent) {
		StringBuilder sb = new StringBuilder(96);
		sb.append(String.format(Locale.ROOT, "HP %.0f/%.0f food %d", Math.ceil(agent.getHealth()), agent.getMaxHealth(), agent.getFoodData().getFoodLevel()));
		sb.append(" | ").append(WorldClock.dayAndTime(agent.level().getOverworldClockTime()));
		sb.append(String.format(Locale.ROOT, " | %d %d %d %s", agent.getBlockX(), agent.getBlockY(), agent.getBlockZ(), agent.level().dimension().identifier().getPath()));
		sb.append(" | ").append(activity(agent));
		ItemStack held = agent.getMainHandItem();
		if (!held.isEmpty()) {
			sb.append(" | ").append(Refs.itemId(held).replace("minecraft:", ""));
		}
		return sb.toString();
	}

	/** What the body is doing: a reflex, the job (with its progress), sitting, or the idle mode. */
	public static String activity(final AgentPlayer agent) {
		Job job = agent.jobs().current();
		if (agent.brain().active() != null) {
			String reflex = agent.brain().active().name();
			return job != null ? reflex + " (" + job.name() + " paused)" : reflex;
		}
		if (job instanceof SkillJob sj) {
			return sj.progressText().isEmpty() ? sj.skill() : sj.skill() + " " + sj.progressText();
		}
		if (job != null) {
			return job.name();
		}
		if (agent.isPassenger()) {
			return "seated";
		}
		return "idle (" + agent.brain().mode().id() + ")";
	}
}
