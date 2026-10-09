package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.seat.SeatEntity;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.AbstractBedBlock;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Single-action world skills: {@code place}, {@code use_block}, {@code use_item}, {@code attack}, {@code equip},
 * {@code eat}, {@code sleep}, {@code drop}, {@code give}, {@code ride}, {@code dismount}, {@code emote}.
 */
public final class WorldJobs {
	private WorldJobs() {
	}

	/** {@code place{block, pos}}: walk into reach and place the block against a neighbour, like a player. */
	public static final class Place extends SkillJob {
		private final Refs.ItemMatcher item;
		private final BlockPos pos;
		private final Walk walk = new Walk();
		private int attempts;

		public Place(final Refs.ItemMatcher item, final BlockPos pos) {
			super("place");
			this.item = item;
			this.pos = pos;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			Refs.BlockMatcher block = this.item.asBlock();
			BlockState there = agent.level().getBlockState(this.pos);
			if (block != null && block.test(there)) {
				this.put("placed", Refs.blockId(there.getBlock()));
				this.put("pos", this.pos);
				return this.done();
			}
			if (Inv.count(agent, this.item) == 0) {
				return this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
			}
			if (!there.isAir() && there.canBeReplaced()) {
				// W1: placing over a protected plant, snow layer or the like replaces it.
				Protection.Verdict v = Protection.check(agent.level(), this.pos, agent.agentId());
				if (v != null) {
					return this.refuseProtected(agent, v, List.of(this.pos));
				}
			}
			if (this.ticks == 1) {
				// W1: TNT next to the player's build.
				int slot = Inv.find(agent, this.item);
				ItemStack stack = slot < 0 ? ItemStack.EMPTY : agent.getInventory().getItem(slot);
				Protection.Verdict v = Protection.checkPlacement(agent.level(), this.pos, stack, agent.agentId());
				if (v != null) {
					return this.refuseProtected(agent, v, List.of(v.pos()));
				}
			}
			Walk.State s = this.walk.toBlock(agent, this.pos);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED) {
				return this.fail("UNREACHABLE", "cannot get within reach of " + this.pos.toShortString());
			}
			BlockOps.Place r = BlockOps.placeTick(agent, this.pos, this.item);
			return switch (r) {
				case PLACED -> {
					this.put("placed", Refs.blockId(agent.level().getBlockState(this.pos).getBlock()));
					this.put("pos", this.pos);
					yield this.done();
				}
				case RETRY -> ++this.attempts > 40 ? this.fail("CANNOT_PLACE", this.item.ref() + " cannot be placed at " + this.pos.toShortString()) : Status.RUNNING;
				case NO_ITEM -> this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
				case OCCUPIED -> this.fail("OCCUPIED", Refs.blockId(there.getBlock()) + " is already at " + this.pos.toShortString());
				case NO_SUPPORT -> this.fail("NO_SUPPORT", "nothing to place " + this.item.ref() + " against at " + this.pos.toShortString());
				case SELF_IN_WAY -> {
					stepAside(agent, this.pos, this.walk);
					yield ++this.attempts > 200 ? this.fail("BLOCKED", "standing in the way") : Status.RUNNING;
				}
				case ENTITY_IN_WAY -> ++this.attempts > 100 ? this.fail("BLOCKED", "something stands at " + this.pos.toShortString()) : Status.RUNNING;
			};
		}
	}

	/** Walks one or two blocks away from {@code pos} (the agent stands where it wants to build). */
	static void stepAside(final AgentPlayer agent, final BlockPos pos, final Walk walk) {
		Vec3 away = agent.position().subtract(Vec3.atBottomCenterOf(pos)).multiply(1.0, 0.0, 1.0);
		if (away.lengthSqr() < 0.01) {
			away = new Vec3(1.0, 0.0, 0.0);
		}
		walk.to(agent, Vec3.atBottomCenterOf(pos).add(away.normalize().scale(2.0)), 0.6);
	}

	/** {@code use_block{pos}}: right-click a block (door, lever, button, chest, crafting table...). */
	public static final class UseBlock extends SkillJob {
		private final BlockPos pos;
		private final Walk walk = new Walk();
		private int tries;

		public UseBlock(final BlockPos pos) {
			super("use_block");
			this.pos = pos;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			BlockState state = agent.level().getBlockState(this.pos);
			if (state.isAir()) {
				return this.fail("NOT_FOUND", "nothing at " + this.pos.toShortString());
			}
			if (this.ticks == 1) {
				// W1: a right-click that would change or take from a protected block (the held tool's effect, the flower
				// in the player's pot, their repeater's delay) is asked first; doors, levers and chests open as usual.
				Protection.Verdict refusal = Protection.checkUse(agent.level(), this.pos, faceToward(agent, this.pos), agent.getMainHandItem(), agent.agentId());
				if (refusal == null) {
					refusal = Protection.checkInteract(agent.level(), this.pos, agent.agentId());
				}
				if (refusal != null) {
					this.put("block", Refs.blockId(state.getBlock()));
					return this.refuseProtected(agent, refusal, List.of(refusal.pos()));
				}
			}
			Walk.State s = this.walk.toBlock(agent, this.pos);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED) {
				return this.fail("UNREACHABLE", "cannot get within reach of " + this.pos.toShortString());
			}
			agent.controls().lookAt(Vec3.atCenterOf(this.pos));
			dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
			InteractionResult r = agent.controls().useBlock(this.pos, faceToward(agent, this.pos));
			Protection.Verdict guarded = dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
			if (guarded != null) {
				// The backstop refused it (the face the agent clicks from changed after walking).
				this.put("block", Refs.blockId(state.getBlock()));
				return this.refuseProtected(agent, guarded, List.of(guarded.pos()));
			}
			if (r == InteractionResult.PASS && ++this.tries < 10) {
				return Status.RUNNING;
			}
			this.put("block", Refs.blockId(state.getBlock()));
			this.put("result", r.consumesAction() ? "used" : "nothing happened");
			if (agent.containerMenu != agent.inventoryMenu) {
				this.put("menu", MenuView.typeId(agent.containerMenu));
			}
			return this.done();
		}
	}

	/** The face of {@code pos} that looks at the agent. */
	public static Direction faceToward(final AgentPlayer agent, final BlockPos pos) {
		return Direction.getApproximateNearest(agent.getEyePosition().subtract(Vec3.atCenterOf(pos)));
	}

	/** {@code use_item{item?, pos?, entity?}}: use an item on a block, on an entity, or in the air (drink, throw...). */
	public static final class UseItem extends SkillJob {
		private final Refs.@Nullable ItemMatcher item;
		private final @Nullable BlockPos pos;
		private final @Nullable String entityRef;
		private final Walk walk = new Walk();
		private @Nullable Entity entity;
		private boolean using;
		private int tries;

		public UseItem(final Refs.@Nullable ItemMatcher item, final @Nullable BlockPos pos, final @Nullable String entityRef) {
			super("use_item");
			this.item = item;
			this.pos = pos;
			this.entityRef = entityRef;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
			this.using = false;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.item != null && !Inv.equip(agent, this.item)) {
				return this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
			}
			String held = Refs.itemId(agent.getMainHandItem());
			if (this.ticks == 1) {
				Protection.Verdict refusal = this.protectedTarget(agent);
				if (refusal != null) {
					this.put("item", held);
					return this.refuseProtected(agent, refusal, List.of(refusal.pos()));
				}
			}
			if (this.pos != null) {
				Walk.State s = this.walk.toBlock(agent, this.pos);
				if (s == Walk.State.MOVING) {
					return Status.RUNNING;
				}
				if (s == Walk.State.FAILED) {
					return this.fail("UNREACHABLE", "cannot get within reach of " + this.pos.toShortString());
				}
				agent.controls().lookAt(Vec3.atCenterOf(this.pos));
				dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
				InteractionResult r = agent.controls().useBlock(this.pos, faceToward(agent, this.pos));
				Protection.Verdict guarded = dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
				if (guarded != null) {
					this.put("item", held);
					return this.refuseProtected(agent, guarded, List.of(guarded.pos()));
				}
				if (r == InteractionResult.PASS && ++this.tries < 10) {
					return Status.RUNNING;
				}
				this.put("item", held);
				this.put("result", r.consumesAction() ? "used" : "nothing happened");
				return this.done();
			}
			if (this.entityRef != null) {
				if (this.entity == null || !this.entity.isAlive()) {
					this.entity = Refs.entity(agent, this.entityRef, 32.0);
					if (this.entity == null) {
						return this.fail("NOT_FOUND", "cannot find " + this.entityRef);
					}
				}
				Walk.State s = this.walk.toEntity(agent, this.entity, 2.5);
				if (s == Walk.State.MOVING) {
					return Status.RUNNING;
				}
				if (s == Walk.State.FAILED) {
					return this.fail("UNREACHABLE", "cannot reach " + this.entityRef);
				}
				agent.controls().lookAt(this.entity);
				InteractionResult r = agent.interactOn(this.entity, InteractionHand.MAIN_HAND, this.entity.position().add(0.0, this.entity.getBbHeight() / 2.0, 0.0));
				agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
				this.put("item", held);
				this.put("entity", Refs.entityTypeId(this.entity));
				this.put("result", r.consumesAction() ? "used" : "nothing happened");
				return this.done();
			}
			// In the air: hold "use" until the item is used up (potion, bow charge...), at most 5 s.
			if (!this.using) {
				dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
				this.using = agent.controls().useItem(InteractionHand.MAIN_HAND);
				Protection.Verdict guarded = dev.minevibe.agent.skill.ProtectionGuard.takeRefusal(agent.agentId());
				if (guarded != null) {
					this.put("item", held);
					return this.refuseProtected(agent, guarded, List.of(guarded.pos()));
				}
				if (!this.using) {
					if (++this.tries < 10) {
						return Status.RUNNING;
					}
					this.put("item", held);
					this.put("result", "nothing happened");
					return this.done();
				}
				return Status.RUNNING;
			}
			if (agent.isUsingItem() && this.ticks < 5 * SECOND) {
				return Status.RUNNING;
			}
			agent.controls().releaseUse();
			this.put("item", held);
			this.put("result", "used");
			return this.done();
		}

		/**
		 * W1: what this use would change that is protected: the block (a tool that tills, strips or burns it, a bucket
		 * or fire in front of it), a decoration entity, or the block a bucket or fire charge used in the air points at.
		 */
		private Protection.@Nullable Verdict protectedTarget(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			ItemStack stack = agent.getMainHandItem();
			if (this.pos != null) {
				Protection.Verdict v = Protection.checkUse(level, this.pos, faceToward(agent, this.pos), stack, agent.agentId());
				return v != null ? v : Protection.checkInteract(level, this.pos, agent.agentId());
			}
			if (this.entityRef != null) {
				Entity e = this.entity != null ? this.entity : Refs.entity(agent, this.entityRef, 32.0);
				return e == null ? null : Protection.checkEntity(level, e, agent.agentId());
			}
			if (Protection.changesBlocks(stack)) {
				net.minecraft.world.phys.HitResult hit = agent.pick(agent.blockInteractionRange(), 1.0F, true);
				if (hit instanceof net.minecraft.world.phys.BlockHitResult b && hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK) {
					return Protection.checkUse(level, b.getBlockPos(), b.getDirection(), stack, agent.agentId());
				}
			}
			return null;
		}
	}

	/** {@code attack{entity}}: fight one entity until it dies. Players and agents are never targets. */
	public static final class Attack extends SkillJob {
		private final String ref;
		private final Walk walk = new Walk();
		private @Nullable LivingEntity target;

		public Attack(final String ref) {
			super("attack");
			this.ref = ref;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.target == null) {
				Entity e = Refs.entity(agent, this.ref, 32.0);
				if (e == null) {
					return this.fail("NOT_FOUND", "cannot find " + this.ref);
				}
				if (e instanceof Player) {
					return this.fail("BAD_TARGET", "agents never attack players or each other");
				}
				Protection.Verdict deco = Protection.checkEntity(agent.level(), e, agent.agentId());
				if (deco != null) {
					// W1: item frames, paintings and armor stands are the player's decoration.
					return this.refuseProtected(agent, deco, List.of(e.blockPosition()));
				}
				if (Protection.isPetOrNamed(e) && Refs.parseUuid(this.ref) == null) {
					// Asked for a kind ("minecraft:cow"): the nearest one that is nobody's pet.
					Entity other = Refs.nearestOfType(agent, e.getType(), 32.0, x -> !Protection.isPetOrNamed(x) && !Protection.isDecoration(x));
					if (other != null) {
						e = other;
					}
				}
				if (Protection.isPetOrNamed(e)) {
					// W1: tamed animals, name-tagged ones and golems a player built are somebody's; no consent makes hurting
					// them right.
					return this.fail("BAD_TARGET", this.ref + " is somebody's (a pet, a named animal or a golem a player built): agents never hurt those. Ask "
						+ Protection.playerName(agent.level().getServer()) + " if something else should be hunted.");
				}
				if (!(e instanceof LivingEntity living)) {
					return this.fail("BAD_TARGET", this.ref + " cannot be attacked");
				}
				this.target = living;
			}
			if (!this.target.isAlive()) {
				this.put("killed", true);
				this.put("target", Refs.entityTypeId(this.target));
				return this.done();
			}
			if (this.target.level() != agent.level() || this.target.distanceTo(agent) > 48.0) {
				return this.fail("ESCAPED", this.ref + " got away");
			}
			this.progress(null, String.format(java.util.Locale.ROOT, "fighting %s (%.0f hp left)", this.ref, this.target.getHealth()));
			if (!GatherJobs.Fight.tick(agent, this.target, this.walk)) {
				return this.fail("UNREACHABLE", "cannot reach " + this.ref);
			}
			return Status.RUNNING;
		}
	}

	/** {@code equip{item, slot?}}: hold an item, or wear armour. Works while seated. */
	public static final class Equip extends SkillJob {
		private final Refs.ItemMatcher item;
		private final String slot;

		public Equip(final Refs.ItemMatcher item, final @Nullable String slot) {
			super("equip");
			this.item = item;
			this.slot = slot == null ? "mainhand" : slot;
		}

		@Override
		public boolean worksSeated() {
			return true;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			EquipmentSlot target = switch (this.slot) {
				case "offhand" -> EquipmentSlot.OFFHAND;
				case "head" -> EquipmentSlot.HEAD;
				case "chest" -> EquipmentSlot.CHEST;
				case "legs" -> EquipmentSlot.LEGS;
				case "feet" -> EquipmentSlot.FEET;
				default -> EquipmentSlot.MAINHAND;
			};
			if (this.item.test(agent.getItemBySlot(target))) {
				return this.equipped(agent, target);
			}
			if (target == EquipmentSlot.MAINHAND) {
				return Inv.equip(agent, this.item) ? this.equipped(agent, target) : this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
			}
			int from = Inv.find(agent, this.item);
			if (from < 0) {
				return this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
			}
			Inventory inv = agent.getInventory();
			ItemStack stack = inv.getItem(from);
			if (target != EquipmentSlot.OFFHAND && !agent.isEquippableInSlot(stack, target)) {
				return this.fail("BAD_SLOT", this.item.ref() + " cannot be worn on " + this.slot);
			}
			ItemStack old = agent.getItemBySlot(target);
			inv.setItem(from, old.copy());
			agent.setItemSlot(target, stack.copy());
			return this.equipped(agent, target);
		}

		private Status equipped(final AgentPlayer agent, final EquipmentSlot slot) {
			this.put("equipped", Refs.itemId(agent.getItemBySlot(slot)));
			this.put("slot", this.slot);
			return this.done();
		}
	}

	/** {@code eat{item?}}: eat (the given or the best) food until it is consumed. Works while seated. */
	public static final class Eat extends SkillJob {
		private final Refs.@Nullable ItemMatcher item;
		private boolean started;
		private String ate = "";
		private int tries;

		public Eat(final Refs.@Nullable ItemMatcher item) {
			super("eat");
			this.item = item;
		}

		@Override
		public boolean worksSeated() {
			return true;
		}

		@Override
		protected int timeoutTicks() {
			return 30 * SECOND;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.started = false;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			agent.controls().stopMovement();
			if (this.started) {
				if (agent.isUsingItem()) {
					return Status.RUNNING;
				}
				this.put("ate", this.ate);
				this.put("food", agent.getFoodData().getFoodLevel());
				this.put("hp", Math.round(agent.getHealth() * 10.0) / 10.0);
				return this.done();
			}
			int slot;
			if (this.item != null) {
				slot = Inv.find(agent, s -> this.item.test(s) && s.has(DataComponents.FOOD));
				if (slot < 0) {
					return this.fail("NO_FOOD", "no edible " + this.item.ref() + " in the inventory");
				}
			} else {
				slot = AgentInventory.bestFoodSlot(agent, false, agent.getHealth() <= 6.0F);
				if (slot < 0) {
					return agent.getFoodData().needsFood() ? this.fail("NO_FOOD", "no food in the inventory") : this.fail("NOT_HUNGRY", "food is full");
				}
			}
			ItemStack stack = agent.getInventory().getItem(slot);
			FoodProperties food = stack.get(DataComponents.FOOD);
			if (food != null && !agent.canEat(food.canAlwaysEat())) {
				return this.fail("NOT_HUNGRY", "food is full");
			}
			AgentInventory.equip(agent, slot);
			this.ate = Refs.itemId(agent.getMainHandItem());
			if (agent.controls().useItem(InteractionHand.MAIN_HAND) && agent.isUsingItem()) {
				this.started = true;
			} else if (++this.tries > 20) {
				return this.fail("CANNOT_EAT", "could not start eating " + this.ate);
			}
			return Status.RUNNING;
		}
	}

	/** {@code sleep{pos?}}: walk to a bed (the given or the nearest) and sleep until morning. Agents never count toward skipping the night. */
	public static final class Sleep extends SkillJob {
		private final @Nullable BlockPos requested;
		private final Walk walk = new Walk();
		private @Nullable BlockPos bed;
		private boolean slept;

		public Sleep(final @Nullable BlockPos pos) {
			super("sleep");
			this.requested = pos;
		}

		@Override
		protected int timeoutTicks() {
			return 15 * MINUTE;
		}

		@Override
		public void onPreempt(final AgentPlayer agent) {
			if (agent.isSleeping()) {
				agent.stopSleepInBed(true, true);
			}
			super.onPreempt(agent);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected void onFinish(final AgentPlayer agent) {
			if (agent.isSleeping() && !this.slept) {
				agent.stopSleepInBed(true, true);
			}
		}

		@Override
		public void cancel(final AgentPlayer agent) {
			if (agent.isSleeping()) {
				agent.stopSleepInBed(true, true);
			}
			super.cancel(agent);
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			if (agent.isSleeping()) {
				this.progress(null, "sleeping");
				return Status.RUNNING;
			}
			if (this.slept) {
				this.put("slept", true);
				this.put("clockTime", level.getOverworldClockTime());
				return this.done();
			}
			if (this.bed == null) {
				this.bed = this.requested != null ? this.requested : nearestBed(agent);
				if (this.bed == null) {
					return this.fail("NO_BED", "no bed within 32 blocks");
				}
			}
			BlockState state = level.getBlockState(this.bed);
			if (!(state.getBlock() instanceof AbstractBedBlock bedBlock)) {
				return this.fail("NO_BED", "no bed at " + this.bed.toShortString());
			}
			if (bedBlock.getBedRule(level, this.bed).destroyOnUse()) {
				return this.fail("CANNOT_SLEEP_HERE", "beds explode in " + level.dimension().identifier());
			}
			if (!bedBlock.getBedRule(level, this.bed).canSleep(level)) {
				return this.fail("NOT_NIGHT", "you can only sleep at night (or in a thunderstorm)");
			}
			Walk.State s = this.walk.to(agent, Vec3.atBottomCenterOf(this.bed), 1.5);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED && agent.position().distanceTo(Vec3.atBottomCenterOf(this.bed)) > 2.5) {
				return this.fail("UNREACHABLE", "cannot reach the bed at " + this.bed.toShortString());
			}
			BlockPos head = state.getValue(BedBlock.PART) == BedPart.HEAD ? this.bed : this.bed.relative(state.getValue(BedBlock.FACING));
			if (level.getBlockState(head).getValue(BedBlock.OCCUPIED)) {
				return this.fail("OCCUPIED", "someone sleeps in that bed");
			}
			Vec3 c = Vec3.atBottomCenterOf(this.bed);
			if (!level.getEntitiesOfClass(Monster.class, new AABB(c.x - 8.0, c.y - 5.0, c.z - 8.0, c.x + 8.0, c.y + 5.0, c.z + 8.0),
				m -> m.isPreventingPlayerRest(level, agent)).isEmpty()) {
				return this.fail("NOT_SAFE", "monsters nearby");
			}
			agent.controls().lookAt(Vec3.atCenterOf(this.bed));
			agent.controls().useBlock(this.bed, Direction.UP);
			if (agent.isSleeping()) {
				this.slept = true;
				agent.brain().setHome(this.bed);
				return Status.RUNNING;
			}
			return this.ticks > 40 * SECOND ? this.fail("OBSTRUCTED", "could not lie down in the bed") : Status.RUNNING;
		}

		private static @Nullable BlockPos nearestBed(final AgentPlayer agent) {
			List<BlockPos> beds = BlockScan.nearest(agent.level(), agent.blockPosition(), 32, s -> s.is(BlockTags.BEDS),
				p -> !agent.level().getBlockState(p).getValue(BedBlock.OCCUPIED), 1);
			return beds.isEmpty() ? null : beds.getFirst();
		}
	}

	/** {@code drop{item, count?}}: throw items on the ground in front of the agent. */
	public static final class Drop extends SkillJob {
		private final Refs.ItemMatcher item;
		private final int count;

		public Drop(final Refs.ItemMatcher item, final int count) {
			super("drop");
			this.item = item;
			this.count = count;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			int have = Inv.count(agent, this.item);
			if (have == 0) {
				return this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
			}
			int dropped = throwItems(agent, this.item, this.count <= 0 ? have : Math.min(this.count, have), null);
			this.put("dropped", dropped);
			this.put("item", this.item.ref());
			return this.done();
		}
	}

	/** Takes up to {@code count} matching items out of the inventory and throws them (to {@code to}, if given). */
	static int throwItems(final AgentPlayer agent, final java.util.function.Predicate<ItemStack> match, final int count, final @Nullable Entity to) {
		Inventory inv = agent.getInventory();
		List<ItemStack> out = new ArrayList<>();
		int left = count;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE && left > 0; slot++) {
			ItemStack s = inv.getItem(slot);
			if (match.test(s)) {
				ItemStack taken = inv.removeItem(slot, Math.min(left, s.getCount()));
				left -= taken.getCount();
				out.add(taken);
			}
		}
		if (left > 0 && match.test(agent.getOffhandItem())) {
			ItemStack taken = agent.getOffhandItem().split(left);
			left -= taken.getCount();
			out.add(taken);
		}
		for (ItemStack s : out) {
			Tossed.toss(agent, s, to);
		}
		return count - left;
	}

	/** {@code give{item, count, to}}: walk to a player or agent and toss items only they can pick up. */
	public static final class Give extends SkillJob {
		private final Refs.ItemMatcher item;
		private final int count;
		private final String to;
		private final Walk walk = new Walk();
		private final List<ItemEntity> thrown = new ArrayList<>();
		private @Nullable Entity receiver;
		private int given = -1;
		private int waitTicks;

		public Give(final Refs.ItemMatcher item, final int count, final String to) {
			super("give");
			this.item = item;
			this.count = count;
			this.to = to;
		}

		@Override
		protected int timeoutTicks() {
			return 3 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.given >= 0) {
				// Wait a moment to see whether the receiver picked it up.
				this.thrown.removeIf(e -> !e.isAlive());
				if (!this.thrown.isEmpty() && ++this.waitTicks < 3 * SECOND) {
					return Status.RUNNING;
				}
				this.put("given", this.given);
				this.put("to", this.to);
				this.put("received", this.thrown.isEmpty());
				return this.done();
			}
			if (this.receiver == null || !this.receiver.isAlive()) {
				this.receiver = Refs.entity(agent, this.to, 96.0);
				if (this.receiver == null) {
					return this.fail("NOT_FOUND", "cannot find " + this.to);
				}
				if (!(this.receiver instanceof Player) || this.receiver == agent) {
					return this.fail("BAD_TARGET", "give works for the player and other agents");
				}
			}
			int have = Inv.count(agent, this.item);
			// count 0: everything of the item (give.all, tools-v2-mc.md M6).
			int want = this.count > 0 ? this.count : have;
			if (have == 0 || have < want) {
				return this.fail("NO_ITEM", "have only " + have + " " + this.item.ref() + (this.count > 0 ? ", need " + this.count : ""));
			}
			Walk.State s = this.walk.toEntity(agent, this.receiver, 2.2);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED) {
				return this.fail("UNREACHABLE", "cannot reach " + this.to);
			}
			int before = Inv.count(agent, this.item);
			List<ItemEntity> nearby = agent.level().getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(3.0));
			this.given = throwItems(agent, this.item, this.count > 0 ? this.count : Inv.count(agent, this.item), this.receiver);
			for (ItemEntity e : agent.level().getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(3.0))) {
				if (!nearby.contains(e)) {
					this.thrown.add(e);
				}
			}
			if (Inv.count(agent, this.item) != before - this.given) {
				this.given = before - Inv.count(agent, this.item);
			}
			return Status.RUNNING;
		}
	}

	/** {@code ride{entity}}: get into a boat or minecart, or onto a saddled animal. Never a {@code minevibe:seat}. */
	public static final class Ride extends SkillJob {
		private final String ref;
		private final Walk walk = new Walk();
		private @Nullable Entity mount;

		public Ride(final String ref) {
			super("ride");
			this.ref = ref;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.mount == null || !this.mount.isAlive()) {
				this.mount = Refs.entity(agent, this.ref, 32.0);
				if (this.mount == null) {
					return this.fail("NOT_FOUND", "cannot find " + this.ref);
				}
				if (this.mount instanceof SeatEntity) {
					return this.fail("SEAT_EXCLUDED", "chairs are for sit_at_pc, not ride");
				}
				if (this.mount instanceof Player) {
					return this.fail("BAD_TARGET", "cannot ride a player");
				}
			}
			Walk.State s = this.walk.toEntity(agent, this.mount, 2.0);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED) {
				return this.fail("UNREACHABLE", "cannot reach " + this.ref);
			}
			agent.controls().lookAt(this.mount);
			if (agent.startRiding(this.mount)) {
				this.put("riding", Refs.entityTypeId(this.mount));
				return this.done();
			}
			return this.fail("NOT_RIDEABLE", this.ref + " cannot be ridden now (needs a saddle, taming, or a free seat)");
		}
	}

	/** {@code dismount{}}: get off a boat, minecart or animal. A PC or meeting chair is left with stand_up instead. */
	public static final class Dismount extends SkillJob {
		public Dismount() {
			super("dismount");
		}

		@Override
		public boolean worksSeated() {
			return true;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			Entity vehicle = agent.getVehicle();
			if (vehicle == null) {
				this.put("dismounted", false);
				return this.done();
			}
			if (vehicle instanceof SeatEntity) {
				return this.fail("SEATED", "use stand_up to leave a chair");
			}
			agent.stopRiding();
			this.put("dismounted", true);
			this.put("from", Refs.entityTypeId(vehicle));
			return this.done();
		}
	}

	/** {@code emote{kind}}: a short body-language animation (about 1.5 s). Works while seated. */
	public static final class Emote extends SkillJob {
		private final String kind;
		private float baseYaw;
		private float basePitch;

		public Emote(final String kind) {
			super("emote");
			this.kind = kind;
		}

		@Override
		public boolean worksSeated() {
			return true;
		}

		@Override
		public void start(final AgentPlayer agent) {
			this.baseYaw = agent.getYRot();
			this.basePitch = agent.getXRot();
			if ("point".equals(this.kind)) {
				Player player = Refs.player(agent);
				if (player != null) {
					agent.controls().lookAt(player);
					this.baseYaw = agent.getYRot();
					this.basePitch = agent.getXRot();
				}
			}
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			int t = this.ticks - 1;
			switch (this.kind) {
				case "wave" -> {
					if (t % 8 == 0) {
						agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
					}
				}
				case "nod" -> agent.controls().look(this.baseYaw, this.basePitch + (float)(Math.sin(t * Math.PI / 5.0) * 25.0));
				case "shake_head" -> agent.controls().look(this.baseYaw + (float)(Math.sin(t * Math.PI / 5.0) * 30.0), this.basePitch);
				case "point" -> {
					if (t == 2) {
						agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
					}
				}
				case "cheer" -> {
					agent.controls().setJumping(!agent.isPassenger() && (t < 3 || t >= 14 && t < 17));
					if (t % 10 == 0) {
						agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
					}
				}
				case "facepalm" -> {
					agent.controls().look(this.baseYaw, 60.0F);
					if (t == 4) {
						agent.swing(InteractionHand.MAIN_HAND, agent.getMainHandItem().getInteractAnimation(), false);
					}
				}
				default -> {
					return this.fail("BAD_ARGS", "unknown emote " + this.kind);
				}
			}
			if (t >= 30) {
				agent.controls().setJumping(false);
				agent.controls().look(this.baseYaw, this.basePitch);
				this.put("emote", this.kind);
				return this.done();
			}
			return Status.RUNNING;
		}
	}
}
