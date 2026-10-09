package dev.minevibe.agent.job;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.core.Holder;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.AbstractCookingRecipe;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.item.crafting.display.RecipeDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.core.component.DataComponents;

/** Recipe lookups for {@code craft}, {@code smelt} and the {@code recipe} observation (the server's RecipeManager). */
public final class Recipes {
	private Recipes() {
	}

	/** The stack a recipe makes (from its display; empty for special recipes such as map cloning). */
	public static ItemStack result(final ServerLevel level, final Recipe<?> recipe) {
		for (RecipeDisplay d : recipe.display()) {
			ItemStack s = d.result().resolveForFirstStack(SlotDisplayContext.fromLevel(level));
			if (!s.isEmpty()) {
				return s;
			}
		}
		return ItemStack.EMPTY;
	}

	/** Crafting recipes whose result is {@code item}, the ones that fit a 2x2 grid first. */
	@SuppressWarnings("unchecked")
	public static List<RecipeHolder<CraftingRecipe>> crafting(final ServerLevel level, final Item item) {
		List<RecipeHolder<CraftingRecipe>> out = new ArrayList<>();
		for (RecipeHolder<?> h : level.getServer().getRecipeManager().getRecipes()) {
			if (h.value().getType() == RecipeType.CRAFTING && !h.value().isSpecial() && result(level, h.value()).is(item)
				&& !h.value().placementInfo().isImpossibleToPlace()) {
				out.add((RecipeHolder<CraftingRecipe>)h);
			}
		}
		out.sort(Comparator.comparing(h -> !fits2x2(h.value())));
		return out;
	}

	/** Furnace recipes that make {@code item}. */
	@SuppressWarnings("unchecked")
	public static List<RecipeHolder<AbstractCookingRecipe>> smeltingTo(final ServerLevel level, final Item item) {
		List<RecipeHolder<AbstractCookingRecipe>> out = new ArrayList<>();
		for (RecipeHolder<?> h : level.getServer().getRecipeManager().getRecipes()) {
			if (h.value().getType() == RecipeType.SMELTING && result(level, h.value()).is(item)) {
				out.add((RecipeHolder<AbstractCookingRecipe>)h);
			}
		}
		return out;
	}

	/** The furnace recipe that smelts {@code input}, if any. */
	@SuppressWarnings("unchecked")
	public static Optional<RecipeHolder<AbstractCookingRecipe>> smeltingFrom(final ServerLevel level, final ItemStack input) {
		for (RecipeHolder<?> h : level.getServer().getRecipeManager().getRecipes()) {
			if (h.value().getType() == RecipeType.SMELTING && h.value() instanceof AbstractCookingRecipe cooking && cooking.input().test(input)) {
				return Optional.of((RecipeHolder<AbstractCookingRecipe>)h);
			}
		}
		return Optional.empty();
	}

	public static boolean fits2x2(final Recipe<?> recipe) {
		if (recipe instanceof ShapedRecipe shaped) {
			return shaped.getWidth() <= 2 && shaped.getHeight() <= 2;
		}
		return recipe.placementInfo().ingredients().size() <= 4;
	}

	/** How many times the agent's inventory can make the recipe right now (at most {@code max}). */
	public static int craftable(final AgentPlayer agent, final Recipe<?> recipe, final int max) {
		StackedItemContents contents = new StackedItemContents();
		agent.getInventory().fillStackedContents(contents);
		return contents.getBiggestCraftableStack(recipe, max, null);
	}

	/** Ingredient → {need, have} per craft, for "missing ingredients" messages. */
	public static Map<String, int[]> ingredients(final AgentPlayer agent, final Recipe<?> recipe) {
		Map<String, int[]> out = new LinkedHashMap<>();
		Map<String, Ingredient> byName = new LinkedHashMap<>();
		for (Ingredient ing : recipe.placementInfo().ingredients()) {
			String name = describe(ing);
			out.computeIfAbsent(name, k -> new int[2])[0]++;
			byName.putIfAbsent(name, ing);
		}
		for (Map.Entry<String, Ingredient> e : byName.entrySet()) {
			out.get(e.getKey())[1] = Inv.count(agent, e.getValue());
		}
		return out;
	}

	/** {@code oak_planks}, or {@code any of oak_planks, spruce_planks...} for a multi-item ingredient. */
	public static String describe(final Ingredient ing) {
		List<String> ids = ing.items().map(Holder::value).map(Refs::itemId).map(s -> s.replace("minecraft:", "")).toList();
		if (ids.size() == 1) {
			return ids.getFirst();
		}
		if (ids.stream().allMatch(s -> s.endsWith("_planks"))) {
			return "any planks";
		}
		if (ids.stream().allMatch(s -> s.endsWith("_log") || s.endsWith("_wood") || s.endsWith("_stem") || s.endsWith("_hyphae"))) {
			return "any log";
		}
		return "any of " + String.join(", ", ids.subList(0, Math.min(4, ids.size()))) + (ids.size() > 4 ? ", ..." : "");
	}

	/** A recipe as the {@code recipe} observation shows it. */
	public static JsonObject describe(final AgentPlayer agent, final RecipeHolder<?> holder) {
		ServerLevel level = agent.level();
		Recipe<?> recipe = holder.value();
		JsonObject o = new JsonObject();
		o.addProperty("id", holder.id().identifier().toString());
		ItemStack result = result(level, recipe);
		o.addProperty("makes", result.getCount());
		o.addProperty("station", recipe.getType() == RecipeType.CRAFTING ? fits2x2(recipe) ? "inventory (2x2)" : "crafting_table" : "furnace");
		JsonArray ings = new JsonArray();
		for (Map.Entry<String, int[]> e : ingredients(agent, recipe).entrySet()) {
			JsonObject i = new JsonObject();
			i.addProperty("item", e.getKey());
			i.addProperty("need", e.getValue()[0]);
			i.addProperty("have", e.getValue()[1]);
			ings.add(i);
		}
		o.add("ingredients", ings);
		if (recipe.getType() == RecipeType.CRAFTING) {
			o.addProperty("canCraftNow", craftable(agent, recipe, 64));
		}
		return o;
	}

	/**
	 * The server's recipes as a {@link RecipeTree.Book} (cached per item: the planner asks for the same items many times
	 * during its dry runs). One per plan; recipes do not change while a job plans.
	 */
	public static RecipeTree.Book book(final ServerLevel level) {
		Map<Item, List<RecipeTree.CraftOption>> crafts = new java.util.HashMap<>();
		Map<Item, List<RecipeTree.SmeltOption>> smelts = new java.util.HashMap<>();
		return new RecipeTree.Book() {
			@Override
			public List<RecipeTree.CraftOption> crafting(final Item item) {
				return crafts.computeIfAbsent(item, it -> {
					List<RecipeTree.CraftOption> out = new ArrayList<>();
					for (RecipeHolder<CraftingRecipe> h : Recipes.crafting(level, it)) {
						List<List<Item>> slots = new ArrayList<>();
						for (Ingredient ing : h.value().placementInfo().ingredients()) {
							slots.add(ing.items().map(Holder::value).toList());
						}
						int makes = Math.max(1, result(level, h.value()).getCount());
						out.add(new RecipeTree.CraftOption(h, it, makes, slots, fits2x2(h.value())));
					}
					return out;
				});
			}

			@Override
			public List<RecipeTree.SmeltOption> smelting(final Item item) {
				return smelts.computeIfAbsent(item, it -> {
					List<RecipeTree.SmeltOption> out = new ArrayList<>();
					for (RecipeHolder<AbstractCookingRecipe> h : Recipes.smeltingTo(level, it)) {
						out.add(new RecipeTree.SmeltOption(h, it, h.value().input().items().map(Holder::value).toList()));
					}
					return out;
				});
			}

			@Override
			public int burnTicks(final Item item) {
				return Recipes.burnTicks(new ItemStack(item));
			}
		};
	}

	/** Item → count over the agent's main slots and offhand (what the recipe tree plans with). */
	public static Map<Item, Integer> inventory(final AgentPlayer agent) {
		Map<Item, Integer> out = new LinkedHashMap<>();
		var inv = agent.getInventory();
		for (int slot = 0; slot < net.minecraft.world.entity.player.Inventory.INVENTORY_SIZE; slot++) {
			ItemStack s = inv.getItem(slot);
			if (!s.isEmpty()) {
				out.merge(s.getItem(), s.getCount(), Integer::sum);
			}
		}
		ItemStack off = agent.getOffhandItem();
		if (!off.isEmpty()) {
			out.merge(off.getItem(), off.getCount(), Integer::sum);
		}
		return out;
	}

	/** Approximate furnace burn time of a fuel in ticks (200 smelts one item); 0 when it is no fuel. */
	public static int burnTicks(final ItemStack stack) {
		if (stack.isEmpty()) {
			return 0;
		}
		if (stack.is(Items.LAVA_BUCKET)) {
			return 20000;
		}
		if (stack.is(Items.COAL_BLOCK)) {
			return 16000;
		}
		if (stack.is(Items.DRIED_KELP_BLOCK)) {
			return 4001;
		}
		if (stack.is(Items.BLAZE_ROD)) {
			return 2400;
		}
		if (stack.is(Items.COAL) || stack.is(Items.CHARCOAL)) {
			return 1600;
		}
		if (stack.is(ItemTags.LOGS) || stack.is(ItemTags.PLANKS) || stack.is(Items.CRAFTING_TABLE) || stack.is(ItemTags.WOODEN_SLABS)) {
			return stack.is(ItemTags.WOODEN_SLABS) ? 150 : 300;
		}
		if (stack.is(Items.STICK) || stack.is(ItemTags.SAPLINGS)) {
			return 100;
		}
		return stack.has(DataComponents.COOKING_FUEL) ? 200 : 0;
	}
}
