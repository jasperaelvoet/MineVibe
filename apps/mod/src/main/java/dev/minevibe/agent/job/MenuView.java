package dev.minevibe.agent.job;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.BrewingStandMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.inventory.StonecutterMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.trading.MerchantOffer;

/**
 * The generic menu skills' view of the agent's open menu ({@code menu_state}) and their clicks
 * ({@code menu_click}), plus item transfers built from real clicks for {@code container}, {@code smelt} and
 * {@code craft}. Covers chests and every vanilla workstation menu: trading, enchanting, anvil, brewing, smithing,
 * stonecutter, furnaces.
 *
 * <p>{@code menu_click} keeps vanilla's slot numbering ({@code -999} = outside the window). A slot of {@code -2} or
 * less presses menu button {@code -slot - 2}: a trade offer (merchant), an enchantment option (0-2), a stonecutter
 * recipe, a loom pattern; things a player clicks that are not slots.
 */
public final class MenuView {
	private MenuView() {
	}

	/** {@code minecraft:generic_9x3}, {@code minecraft:crafting}, ... ({@code inventory} for the player's own). */
	public static String typeId(final AbstractContainerMenu menu) {
		if (menu instanceof InventoryMenu) {
			return "inventory";
		}
		try {
			Identifier id = BuiltInRegistries.MENU.getKey(menu.getType());
			return id == null ? "unknown" : id.toString();
		} catch (UnsupportedOperationException e) {
			return "unknown";
		}
	}

	public static boolean isOpen(final AgentPlayer agent) {
		return agent.containerMenu != agent.inventoryMenu;
	}

	/** Slots of the menu that belong to the agent's inventory. */
	public static List<Integer> playerSlots(final AgentPlayer agent, final AbstractContainerMenu menu) {
		List<Integer> out = new ArrayList<>();
		for (int i = 0; i < menu.slots.size(); i++) {
			if (menu.slots.get(i).container == agent.getInventory()) {
				out.add(i);
			}
		}
		// Hotbar last, so tools stay at hand when stacks are pulled out of the bag.
		out.sort((a, b) -> Boolean.compare(isHotbar(menu.slots.get(a)), isHotbar(menu.slots.get(b))));
		return out;
	}

	/** Slots of the menu that are not the agent's inventory (the chest, the furnace...). */
	public static List<Integer> containerSlots(final AgentPlayer agent, final AbstractContainerMenu menu) {
		List<Integer> out = new ArrayList<>();
		for (int i = 0; i < menu.slots.size(); i++) {
			if (menu.slots.get(i).container != agent.getInventory()) {
				out.add(i);
			}
		}
		return out;
	}

	private static boolean isHotbar(final Slot slot) {
		return slot.getContainerSlot() < 9;
	}

	/** {@code menu_state}: type, non-empty slots, the carried stack, and per-type details. */
	public static JsonObject snapshot(final AgentPlayer agent) {
		AbstractContainerMenu menu = agent.containerMenu;
		JsonObject o = new JsonObject();
		o.addProperty("open", isOpen(agent));
		o.addProperty("type", typeId(menu));
		JsonArray slots = new JsonArray();
		for (int i = 0; i < menu.slots.size(); i++) {
			Slot slot = menu.slots.get(i);
			ItemStack s = slot.getItem();
			if (s.isEmpty()) {
				continue;
			}
			JsonObject e = new JsonObject();
			e.addProperty("slot", i);
			e.addProperty("item", Refs.itemId(s));
			e.addProperty("count", s.getCount());
			if (slot.container == agent.getInventory()) {
				e.addProperty("own", true);
			}
			if (s.isDamageableItem()) {
				e.addProperty("durability", s.getMaxDamage() - s.getDamageValue());
			}
			slots.add(e);
		}
		o.addProperty("slotCount", menu.slots.size());
		o.add("slots", slots);
		ItemStack carried = menu.getCarried();
		if (!carried.isEmpty()) {
			o.addProperty("carried", Refs.itemId(carried) + " x" + carried.getCount());
		}
		switch (menu) {
			case MerchantMenu m -> {
				JsonArray offers = new JsonArray();
				int i = 0;
				for (MerchantOffer offer : m.getOffers()) {
					JsonObject e = new JsonObject();
					e.addProperty("button", -2 - i);
					e.addProperty("costA", Refs.itemId(offer.getCostA()) + " x" + offer.getCostA().getCount());
					if (!offer.getCostB().isEmpty()) {
						e.addProperty("costB", Refs.itemId(offer.getCostB()) + " x" + offer.getCostB().getCount());
					}
					e.addProperty("result", Refs.itemId(offer.getResult()) + " x" + offer.getResult().getCount());
					e.addProperty("outOfStock", offer.isOutOfStock());
					offers.add(e);
					i++;
				}
				o.add("offers", offers);
				o.addProperty("hint", "select an offer with menu_click{slot: offer.button}, then take slot 2");
			}
			case EnchantmentMenu m -> {
				JsonArray costs = new JsonArray();
				for (int c : m.costs) {
					costs.add(c);
				}
				o.add("levelCosts", costs);
				o.addProperty("hint", "put the item in slot 0 and lapis in slot 1, then menu_click{slot: -2, -3 or -4} for option 0, 1 or 2");
			}
			case AnvilMenu m -> o.addProperty("levelCost", m.getCost());
			case BrewingStandMenu m -> {
				o.addProperty("fuel", m.getFuel());
				o.addProperty("brewTicks", m.getBrewingTicks());
			}
			case StonecutterMenu m -> {
				o.addProperty("recipes", m.getNumberOfVisibleRecipes());
				o.addProperty("selected", m.getSelectedRecipeIndex());
				o.addProperty("hint", "menu_click{slot: -2 - recipeIndex} picks a recipe; the result is slot 1");
			}
			case AbstractFurnaceMenu m -> {
				o.addProperty("lit", m.isLit());
				o.addProperty("progress", Math.round(m.getBurnProgress() * 100.0) / 100.0);
			}
			default -> {
			}
		}
		o.addProperty("level", agent.experienceLevel);
		return o;
	}

	/**
	 * One {@code menu_click} on the open menu, as the server applies a client's click packet. A {@code slot} at or below
	 * -2 presses menu button {@code -slot - 2}. Returns an error message, or null when the click was applied.
	 */
	public static @org.jspecify.annotations.Nullable String click(final AgentPlayer agent, final int slot, final int button, final ContainerInput input) {
		AbstractContainerMenu menu = agent.containerMenu;
		if (!menu.stillValid(agent)) {
			return "the menu is out of reach";
		}
		if (slot <= -2 && slot != AbstractContainerMenu.SLOT_CLICKED_OUTSIDE) {
			int index = -slot - 2;
			if (menu instanceof MerchantMenu merchant) {
				if (index >= merchant.getOffers().size()) {
					return "no trade offer " + index;
				}
				merchant.setSelectionHint(index);
				merchant.tryMoveItems(index);
			} else if (!menu.clickMenuButton(agent, index)) {
				return "menu button " + index + " did nothing";
			}
			menu.broadcastChanges();
			return null;
		}
		if (!menu.isValidSlotIndex(slot)) {
			return "slot " + slot + " is not in this menu (0-" + (menu.slots.size() - 1) + ")";
		}
		agent.resetLastActionTime();
		menu.clicked(slot, button, input, agent);
		menu.broadcastChanges();
		return null;
	}

	/**
	 * Moves up to {@code count} matching items from {@code from} slots to {@code to} slots with left and right clicks (a
	 * whole stack where it fits, one at a time otherwise). Leftovers go back where they came from. Returns how many moved.
	 */
	public static int transfer(
		final AgentPlayer agent, final AbstractContainerMenu menu, final List<Integer> from, final List<Integer> to, final Predicate<ItemStack> match, final int count
	) {
		int moved = 0;
		for (int src : from) {
			if (moved >= count) {
				break;
			}
			Slot source = menu.getSlot(src);
			if (!match.test(source.getItem()) || !source.mayPickup(agent)) {
				continue;
			}
			menu.clicked(src, 0, ContainerInput.PICKUP, agent);
			for (int dst : to) {
				ItemStack carried = menu.getCarried();
				if (carried.isEmpty() || moved >= count) {
					break;
				}
				Slot target = menu.getSlot(dst);
				ItemStack there = target.getItem();
				if (!target.mayPlace(carried) || !there.isEmpty() && (!ItemStack.isSameItemSameComponents(there, carried) || there.getCount() >= target.getMaxStackSize(carried))) {
					continue;
				}
				int remaining = count - moved;
				if (carried.getCount() <= remaining) {
					int before = carried.getCount();
					menu.clicked(dst, 0, ContainerInput.PICKUP, agent);
					moved += before - menu.getCarried().getCount();
				} else {
					while (!menu.getCarried().isEmpty() && moved < count) {
						int before = menu.getCarried().getCount();
						menu.clicked(dst, 1, ContainerInput.PICKUP, agent);
						if (menu.getCarried().getCount() == before) {
							break;
						}
						moved++;
					}
				}
			}
			if (!menu.getCarried().isEmpty()) {
				menu.clicked(src, 0, ContainerInput.PICKUP, agent);
			}
			if (!menu.getCarried().isEmpty()) {
				ItemStack rest = menu.getCarried();
				menu.setCarried(ItemStack.EMPTY);
				agent.getInventory().placeItemBackInInventory(rest, net.minecraft.util.Prediction.SERVER_ONLY);
			}
		}
		menu.broadcastChanges();
		return moved;
	}

	/** Shift-clicks a slot (a crafting or furnace result) into the inventory; returns how many items arrived. */
	public static int takeAll(final AgentPlayer agent, final AbstractContainerMenu menu, final int slot) {
		ItemStack s = menu.getSlot(slot).getItem();
		if (s.isEmpty()) {
			return 0;
		}
		ItemStack proto = s.copy();
		int before = Inv.count(agent, x -> ItemStack.isSameItemSameComponents(x, proto));
		menu.clicked(slot, 0, ContainerInput.QUICK_MOVE, agent);
		menu.broadcastChanges();
		return Inv.count(agent, x -> ItemStack.isSameItemSameComponents(x, proto)) - before;
	}
}
