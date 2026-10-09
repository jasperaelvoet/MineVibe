package dev.minevibe.agent.job;

import dev.minevibe.agent.perception.Trees;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.Holder;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.TagKey;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import org.jspecify.annotations.Nullable;

/**
 * Material families: vanilla item tags whose members stand in for each other as ingredients. Any log makes planks of
 * its kind, and any planks make sticks, a crafting table or wooden tools; cobblestone, blackstone or cobbled deepslate
 * make stone tools and a furnace; coal or charcoal; wool where the color does not matter. The craft tree gathers the
 * whole family instead of the one member it planned with when every member would do ({@link RecipeTree#gatherRef});
 * a member the recipe pins (the oak planks of an oak door, the white wool of a white bed) stays itself. Building
 * variants (stripped logs, wood) are left out: they are made, not found.
 *
 * <p>{@code #minecraft:logs} holds the nether stems too, whose planks do not burn: a plan that smelts (an iron
 * pickaxe, with the spare planks as fuel) or takes burnable logs (a campfire, charcoal) fails with a stem, so
 * {@code #minecraft:logs_that_burn} comes next and every tree log still serves there.
 */
public final class Families {
	/** In the order they are tried: the first family whose every member serves wins. */
	public static final List<String> TAGS = List.of("#minecraft:logs", "#minecraft:logs_that_burn", "#minecraft:stone_tool_materials",
		"#minecraft:stone_crafting_materials", "#minecraft:coals", "#minecraft:wool");

	private Families() {
	}

	/** Each family's natural members, as the server's tags hold them now (families of one member are left out). */
	public static Map<String, List<Item>> members() {
		Map<String, List<Item>> out = new LinkedHashMap<>();
		for (String ref : TAGS) {
			Identifier id = Refs.id(ref);
			if (id == null) {
				continue;
			}
			List<Item> items = new ArrayList<>();
			for (Holder<Item> h : BuiltInRegistries.ITEM.getTagOrEmpty(TagKey.create(Registries.ITEM, id))) {
				Item it = h.value();
				if (it instanceof BlockItem b && Trees.isBuildingVariant(b.getBlock()) || items.contains(it)) {
					continue;
				}
				items.add(it);
			}
			if (items.size() > 1) {
				out.put(ref, List.copyOf(items));
			}
		}
		return out;
	}

	/**
	 * The family of an item reference ({@code oak_log} or {@code minecraft:oak_log ...} → {@code #minecraft:logs}), or
	 * null: a tag, an unknown id, or an item of no family. Only the first word counts (a job's "what" may say more).
	 */
	public static @Nullable String of(final String what) {
		String first = what.strip().split("\\s+", 2)[0];
		if (first.isEmpty() || first.startsWith("#")) {
			return null;
		}
		Identifier id = Refs.id(first);
		if (id == null || !BuiltInRegistries.ITEM.containsKey(id)) {
			return null;
		}
		Item item = BuiltInRegistries.ITEM.getValue(id);
		if (item == Items.AIR) {
			return null;
		}
		for (Map.Entry<String, List<Item>> e : members().entrySet()) {
			if (e.getValue().contains(item)) {
				return e.getKey();
			}
		}
		return null;
	}
}
