package dev.minevibe.progression;

import dev.minevibe.MineVibeMod;
import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;
import net.minecraft.advancements.triggers.PlayerTrigger;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Rarity;

/**
 * The survival start (PLAN 7.5 "Agent Core"): the {@code agent_core} item, and the criterion triggers of the guide
 * advancements ({@code data/minevibe/advancement/guide/}) that no vanilla trigger covers. Recipes live in
 * {@code data/minevibe/recipe/}. Registered once from {@link ProgressionModInit}.
 */
public final class ProgressionContent {
	/** {@code minevibe:agent_core}: wakes the first CEO (the awakening ritual), and pays for every hire after that. */
	public static Item AGENT_CORE;
	/** {@code minevibe:awakened_agent}: Node accepted the player's awakening ritual ("It's alive!"). */
	public static PlayerTrigger AWAKENED_AGENT;
	/** {@code minevibe:approved_hire}: an approved hire took the player's Agent Core ("Growing the team"). */
	public static PlayerTrigger APPROVED_HIRE;
	/** {@code minevibe:placed_workstation}: a workstation item put down its desk ("A desk job"). */
	public static PlayerTrigger PLACED_WORKSTATION;

	private static boolean registered;

	private ProgressionContent() {
	}

	public static void register() {
		if (registered) {
			return;
		}
		registered = true;

		ResourceKey<Item> coreKey = ResourceKey.create(Registries.ITEM, MineVibeMod.id("agent_core"));
		AGENT_CORE = Registry.register(
			BuiltInRegistries.ITEM,
			coreKey,
			new AgentCoreItem(
				new Item.Properties().setId(coreKey).stacksTo(16).rarity(Rarity.RARE).component(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true)
			)
		);
		CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.TOOLS_AND_UTILITIES).register(output -> output.accept(AGENT_CORE));

		AWAKENED_AGENT = trigger("awakened_agent");
		APPROVED_HIRE = trigger("approved_hire");
		PLACED_WORKSTATION = trigger("placed_workstation");
	}

	private static PlayerTrigger trigger(final String path) {
		return Registry.register(BuiltInRegistries.TRIGGER_TYPES, MineVibeMod.id(path), new PlayerTrigger());
	}
}
