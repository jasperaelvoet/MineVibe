package dev.minevibe.agent;

import java.util.Set;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.ItemAttributeModifiers;
import net.minecraft.world.level.block.state.BlockState;

/** Inventory choices an agent makes on its own: best tool, best weapon, best food, and equipping. */
public final class AgentInventory {
	/** Edible but harmful (poison, hunger, nausea, random teleport). Eaten only when starving. */
	private static final Set<Item> BAD_FOOD = Set.of(
		Items.ROTTEN_FLESH, Items.SPIDER_EYE, Items.POISONOUS_POTATO, Items.PUFFERFISH, Items.CHORUS_FRUIT, Items.SUSPICIOUS_STEW
	);

	private AgentInventory() {
	}

	/** Main inventory slot (0..35) of the fastest tool for {@code state}, or -1 when bare hands are as good. */
	public static int bestToolSlot(final Inventory inventory, final BlockState state) {
		boolean needsTool = state.requiresCorrectToolForDrops();
		int best = -1;
		float bestScore = 1.0F;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (stack.isEmpty()) {
				continue;
			}
			float speed = stack.getDestroySpeed(state);
			boolean correct = stack.isCorrectToolForDrops(state);
			if (needsTool && !correct) {
				continue;
			}
			// Prefer tools that are about to break last.
			float durabilityPenalty = stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() < 3 ? 0.5F : 0.0F;
			float score = speed - durabilityPenalty;
			if (score > bestScore) {
				bestScore = score;
				best = slot;
			}
		}
		return best;
	}

	/** Attack damage the stack adds in the main hand (0 for non-weapons). */
	public static double attackDamage(final ItemStack stack) {
		if (stack.isEmpty()) {
			return 0.0;
		}
		ItemAttributeModifiers modifiers = stack.getOrDefault(DataComponents.ATTRIBUTE_MODIFIERS, ItemAttributeModifiers.EMPTY);
		return modifiers.compute(Attributes.ATTACK_DAMAGE, 0.0, EquipmentSlot.MAINHAND);
	}

	/** Main inventory slot of the best melee weapon, or -1. */
	public static int bestWeaponSlot(final Inventory inventory) {
		int best = -1;
		double bestDamage = 0.5;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			double damage = attackDamage(inventory.getItem(slot));
			if (damage > bestDamage) {
				bestDamage = damage;
				best = slot;
			}
		}
		return best;
	}

	/**
	 * Main inventory slot of the best food: the most nutrition plus saturation. Harmful food is skipped
	 * unless {@code desperate}. Golden apples win when {@code healing}. Returns -1 if there is none.
	 */
	public static int bestFoodSlot(final AgentPlayer agent, final boolean desperate, final boolean healing) {
		Inventory inventory = agent.getInventory();
		int best = -1;
		float bestScore = Float.NEGATIVE_INFINITY;
		boolean hungry = agent.getFoodData().needsFood();
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack stack = inventory.getItem(slot);
			FoodProperties food = stack.get(DataComponents.FOOD);
			if (food == null || !stack.has(DataComponents.CONSUMABLE)) {
				continue;
			}
			if (!hungry && !food.canAlwaysEat()) {
				continue;
			}
			boolean bad = BAD_FOOD.contains(stack.getItem());
			if (bad && !desperate) {
				continue;
			}
			float score = food.nutrition() + food.saturation();
			if (bad) {
				score -= 100.0F;
			}
			if (healing && (stack.is(Items.GOLDEN_APPLE) || stack.is(Items.ENCHANTED_GOLDEN_APPLE))) {
				score += 100.0F;
			} else if (!healing && (stack.is(Items.GOLDEN_APPLE) || stack.is(Items.ENCHANTED_GOLDEN_APPLE))) {
				// Too precious for a snack.
				score -= 50.0F;
			}
			if (score > bestScore) {
				bestScore = score;
				best = slot;
			}
		}
		return best;
	}

	public static boolean hasFood(final AgentPlayer agent, final boolean desperate) {
		return bestFoodSlot(agent, desperate, false) >= 0;
	}

	/** Puts the stack in {@code slot} (0..35) into the main hand, like scrolling the hotbar or picking it. */
	public static void equip(final AgentPlayer agent, final int slot) {
		Inventory inventory = agent.getInventory();
		if (slot < 0 || slot >= Inventory.INVENTORY_SIZE || slot == inventory.getSelectedSlot()) {
			return;
		}
		if (Inventory.isHotbarSlot(slot)) {
			inventory.setSelectedSlot(slot);
		} else {
			inventory.pickSlot(slot);
		}
		agent.resetLastActionTime();
	}
}
