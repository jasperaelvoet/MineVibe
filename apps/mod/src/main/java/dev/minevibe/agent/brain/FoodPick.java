package dev.minevibe.agent.brain;

import dev.minevibe.agent.AgentPlayer;
import java.util.Set;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

/** Choosing food to hand out (feeding the player, sharing with a teammate). */
final class FoodPick {
	private static final Set<Item> NOT_FOR_SHARING = Set.of(
		Items.ROTTEN_FLESH, Items.SPIDER_EYE, Items.POISONOUS_POTATO, Items.PUFFERFISH, Items.CHORUS_FRUIT, Items.SUSPICIOUS_STEW,
		Items.GOLDEN_APPLE, Items.ENCHANTED_GOLDEN_APPLE
	);

	private FoodPick() {
	}

	static boolean decent(final ItemStack stack) {
		return stack.has(DataComponents.FOOD) && stack.has(DataComponents.CONSUMABLE) && !NOT_FOR_SHARING.contains(stack.getItem());
	}

	/** Decent food items the agent carries. */
	static int decentCount(final AgentPlayer agent) {
		Inventory inv = agent.getInventory();
		int n = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack s = inv.getItem(slot);
			if (decent(s)) {
				n += s.getCount();
			}
		}
		return n;
	}

	/**
	 * Main slot of the best food the agent can spare: it keeps at least one for itself unless it is well fed. -1 when it
	 * has nothing to spare.
	 */
	static int spareSlot(final AgentPlayer agent) {
		int total = decentCount(agent);
		if (total == 0 || total == 1 && agent.getFoodData().getFoodLevel() < 14) {
			return -1;
		}
		Inventory inv = agent.getInventory();
		int best = -1;
		float bestScore = -1.0F;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack s = inv.getItem(slot);
			if (!decent(s)) {
				continue;
			}
			FoodProperties food = s.get(DataComponents.FOOD);
			float score = food.nutrition() + food.saturation();
			if (score > bestScore) {
				bestScore = score;
				best = slot;
			}
		}
		return best;
	}
}
