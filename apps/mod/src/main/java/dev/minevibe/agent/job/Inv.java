package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentInventory;
import dev.minevibe.agent.AgentPlayer;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Predicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;

/** Inventory bookkeeping for jobs: counting, finding and equipping items, and before/after deltas for results. */
public final class Inv {
	private Inv() {
	}

	/** Items matching {@code match} in the 36 main slots and the offhand. */
	public static int count(final AgentPlayer agent, final Predicate<ItemStack> match) {
		Inventory inv = agent.getInventory();
		int n = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack s = inv.getItem(slot);
			if (match.test(s)) {
				n += s.getCount();
			}
		}
		ItemStack off = agent.getOffhandItem();
		if (match.test(off)) {
			n += off.getCount();
		}
		return n;
	}

	public static int count(final AgentPlayer agent, final Item item) {
		return count(agent, s -> s.is(item));
	}

	/** First main slot (hotbar first) holding a match, or -1. */
	public static int find(final AgentPlayer agent, final Predicate<ItemStack> match) {
		Inventory inv = agent.getInventory();
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			if (match.test(inv.getItem(slot))) {
				return slot;
			}
		}
		return -1;
	}

	/** Puts a matching item in the main hand (from the offhand too). Returns false when there is none. */
	public static boolean equip(final AgentPlayer agent, final Predicate<ItemStack> match) {
		if (match.test(agent.getMainHandItem())) {
			return true;
		}
		int slot = find(agent, match);
		if (slot >= 0) {
			AgentInventory.equip(agent, slot);
			return match.test(agent.getMainHandItem());
		}
		if (match.test(agent.getOffhandItem())) {
			agent.controls().swapHands();
			return true;
		}
		return false;
	}

	/** Free main slots. */
	public static int freeSlots(final AgentPlayer agent) {
		Inventory inv = agent.getInventory();
		int n = 0;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			if (inv.getItem(slot).isEmpty()) {
				n++;
			}
		}
		return n;
	}

	/** Whether {@code stack} (or part of it) would fit. */
	public static boolean hasRoomFor(final AgentPlayer agent, final ItemStack stack) {
		return agent.getInventory().getFreeSlot() >= 0 || agent.getInventory().getSlotWithRemainingSpace(stack) >= 0;
	}

	/** Item id → count over the main slots, offhand and armour. */
	public static Map<String, Integer> counts(final AgentPlayer agent) {
		Map<String, Integer> out = new TreeMap<>();
		Inventory inv = agent.getInventory();
		for (int slot = 0; slot < inv.getContainerSize(); slot++) {
			ItemStack s = inv.getItem(slot);
			if (!s.isEmpty()) {
				out.merge(BuiltInRegistries.ITEM.getKey(s.getItem()).toString(), s.getCount(), Integer::sum);
			}
		}
		return out;
	}

	/** Positive differences {@code after - before} (what was gained). */
	public static Map<String, Integer> gained(final Map<String, Integer> before, final Map<String, Integer> after) {
		Map<String, Integer> out = new LinkedHashMap<>();
		for (Map.Entry<String, Integer> e : after.entrySet()) {
			int d = e.getValue() - before.getOrDefault(e.getKey(), 0);
			if (d > 0) {
				out.put(e.getKey(), d);
			}
		}
		return out;
	}

	/** Removes {@code count} matching items from the main slots (offhand last); returns how many were removed. */
	public static int remove(final AgentPlayer agent, final Predicate<ItemStack> match, final int count) {
		Inventory inv = agent.getInventory();
		int left = count;
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE && left > 0; slot++) {
			ItemStack s = inv.getItem(slot);
			if (match.test(s)) {
				int take = Math.min(left, s.getCount());
				inv.removeItem(slot, take);
				left -= take;
			}
		}
		if (left > 0 && match.test(agent.getOffhandItem())) {
			ItemStack off = agent.getOffhandItem();
			int take = Math.min(left, off.getCount());
			off.shrink(take);
			agent.setItemInHand(InteractionHand.OFF_HAND, off.isEmpty() ? ItemStack.EMPTY : off);
			left -= take;
		}
		return count - left;
	}
}
