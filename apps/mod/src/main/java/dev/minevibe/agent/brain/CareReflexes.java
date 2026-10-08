package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.Tossed;
import dev.minevibe.agent.skill.BodyEvents;
import dev.minevibe.agent.skill.Refs;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Walk over to someone and toss them one food item; shared by FeedPlayer (55) and ShareFood (50). */
abstract class TossFoodReflex implements Reflex {
	private static final int GIVE_UP_TICKS = 200;

	protected @Nullable LivingEntity receiver;
	private int startedAt;
	private int replanAt;

	/** Who needs food now, or null. */
	protected abstract @Nullable LivingEntity pick(AgentPlayer agent, ReflexBrain brain);

	/** Called after a toss (or a give-up) with the receiver. */
	protected abstract void done(AgentPlayer agent, LivingEntity receiver, @Nullable ItemStack tossed);

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		if (brain.active() != this && (agent.tickCount + this.priority()) % 10 != 0) {
			return false;
		}
		LivingEntity r = this.pick(agent, brain);
		if (r == null || brain.threats().inCombat(agent, 8.0) || FoodPick.spareSlot(agent) < 0) {
			this.receiver = null;
			return false;
		}
		this.receiver = r;
		return true;
	}

	/** Feeding others never pulls an agent out of its chair: only its own survival (47) or a fight (45) does. */
	@Override
	public boolean allowedWhileSeated() {
		return false;
	}

	@Override
	public void start(final AgentPlayer agent, final ReflexBrain brain) {
		this.startedAt = agent.tickCount;
		this.replanAt = 0;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
		LivingEntity r = this.receiver;
		if (r == null) {
			return;
		}
		if (agent.tickCount - this.startedAt > GIVE_UP_TICKS) {
			this.done(agent, r, null);
			return;
		}
		double dist = agent.distanceTo(r);
		if (dist > 2.3) {
			Vec3 goal = agent.navigator().goal();
			if (!agent.navigator().isMoving() || agent.tickCount >= this.replanAt && (goal == null || goal.distanceTo(r.position()) > 1.5)) {
				this.replanAt = agent.tickCount + 10;
				agent.navigator().moveTo(r.position(), 1.8);
			}
			return;
		}
		agent.navigator().stop();
		int slot = FoodPick.spareSlot(agent);
		if (slot < 0) {
			this.done(agent, r, null);
			return;
		}
		ItemStack one = agent.getInventory().removeItem(slot, 1);
		Tossed.toss(agent, one, r);
		this.done(agent, r, one);
	}

	@Override
	public void stop(final AgentPlayer agent, final ReflexBrain brain) {
		agent.navigator().stop();
	}
}

/** Priority 55: the player's food is at 12 or less: walk over and toss them food (every 15 s at most). */
final class FeedPlayerReflex extends TossFoodReflex {
	static final int HUNGRY = 12;
	private static final int COOLDOWN = 300;
	private int nextAt;

	@Override
	public int priority() {
		return 55;
	}

	@Override
	public String name() {
		return "feed_player";
	}

	@Override
	protected @Nullable LivingEntity pick(final AgentPlayer agent, final ReflexBrain brain) {
		if (agent.tickCount < this.nextAt) {
			return null;
		}
		ServerPlayer player = brain.followTarget();
		if (player == null || player.isCreative() || player.isSpectator() || player.getFoodData().getFoodLevel() > HUNGRY || player.distanceTo(agent) > 16.0) {
			return null;
		}
		return player;
	}

	@Override
	protected void done(final AgentPlayer agent, final LivingEntity receiver, final @Nullable ItemStack tossed) {
		this.nextAt = agent.tickCount + COOLDOWN;
		this.receiver = null;
		if (tossed != null && receiver instanceof ServerPlayer player) {
			BodyEvents.emit(agent, "fed_player", BodyEvents.INFO, "tossed " + Refs.itemId(tossed).replace("minecraft:", "") + " to " + player.getGameProfile().name(),
				Map.of("item", Refs.itemId(tossed), "playerFood", player.getFoodData().getFoodLevel()), 0);
		}
	}
}

/** Priority 50: a teammate within 16 blocks is starving (food 6 or less) with nothing to eat: share one food. */
final class ShareFoodReflex extends TossFoodReflex {
	private static final int COOLDOWN = 400;
	private final Map<UUID, Integer> nextFor = new HashMap<>();

	@Override
	public int priority() {
		return 50;
	}

	@Override
	public String name() {
		return "share_food";
	}

	@Override
	protected @Nullable LivingEntity pick(final AgentPlayer agent, final ReflexBrain brain) {
		if (agent.getFoodData().getFoodLevel() < 8) {
			return null;
		}
		AgentPlayer best = null;
		double bestSq = 16.0 * 16.0;
		for (ServerPlayer p : agent.level().players()) {
			if (!(p instanceof AgentPlayer ally) || ally == agent || !ally.isAlive() || ally.isAgentDead()) {
				continue;
			}
			if (ally.getFoodData().getFoodLevel() > 6 || AgentInventory.hasFood(ally, true)) {
				continue;
			}
			if (agent.tickCount < this.nextFor.getOrDefault(ally.getUUID(), 0)) {
				continue;
			}
			double d = ally.distanceToSqr(agent);
			if (d < bestSq) {
				bestSq = d;
				best = ally;
			}
		}
		return best;
	}

	@Override
	protected void done(final AgentPlayer agent, final LivingEntity receiver, final @Nullable ItemStack tossed) {
		this.nextFor.put(receiver.getUUID(), agent.tickCount + COOLDOWN);
		this.receiver = null;
		if (tossed != null && receiver instanceof AgentPlayer ally) {
			BodyEvents.emit(agent, "shared_food", BodyEvents.INFO, "shared " + Refs.itemId(tossed).replace("minecraft:", "") + " with " + ally.getGameProfile().name(),
				Map.of("item", Refs.itemId(tossed), "with", ally.agentId()), 0);
		}
	}
}

/** Priority 47: sitting, starving (food 6 or less) and nothing to eat: stand up to find food. */
final class UnseatToSurviveReflex implements Reflex {
	@Override
	public int priority() {
		return 47;
	}

	@Override
	public String name() {
		return "unseat_to_survive";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		return agent.isPassenger() && agent.getFoodData().getFoodLevel() <= 6 && !AgentInventory.hasFood(agent, true);
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
	}

	@Override
	public String unseatReason() {
		return "survival";
	}
}

/** Priority 45: sitting, attacked by a hostile, and HP below half: stand up (self-defence takes over). */
final class UnseatToFightReflex implements Reflex {
	@Override
	public int priority() {
		return 45;
	}

	@Override
	public String name() {
		return "unseat_to_fight";
	}

	@Override
	public boolean wants(final AgentPlayer agent, final ReflexBrain brain) {
		return agent.isPassenger() && brain.hurtByHostileWithin(100) && agent.getHealth() < agent.getMaxHealth() * 0.5F;
	}

	@Override
	public void tick(final AgentPlayer agent, final ReflexBrain brain) {
	}

	@Override
	public String unseatReason() {
		return "damage";
	}
}
