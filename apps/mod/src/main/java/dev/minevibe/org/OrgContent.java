package dev.minevibe.org;

import dev.minevibe.MineVibeMod;
import dev.minevibe.org.calendar.CalendarItem;
import dev.minevibe.org.calendar.WallCalendarBlock;
import dev.minevibe.org.codex.CodexBlock;
import dev.minevibe.org.codex.CodexBlockEntity;
import dev.minevibe.org.meeting.MeetingTableBlock;
import dev.minevibe.org.meeting.MeetingTableBlockEntity;
import java.util.Set;
import java.util.function.Function;
import net.fabricmc.fabric.api.creativetab.v1.CreativeModeTabEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.material.PushReaction;

/**
 * Blocks, items and block entities of the org tools (PLAN §6.6, §7.5): the Codex, the wall calendar and the handheld
 * calendar, and the meeting table. Recipes live in {@code data/minevibe/recipe/}.
 */
public final class OrgContent {
	public static Block CODEX;
	public static Item CODEX_ITEM;
	public static BlockEntityType<CodexBlockEntity> CODEX_BLOCK_ENTITY;
	public static Block WALL_CALENDAR;
	public static Item WALL_CALENDAR_ITEM;
	public static Item CALENDAR;
	public static Block MEETING_TABLE;
	public static Item MEETING_TABLE_ITEM;
	public static BlockEntityType<MeetingTableBlockEntity> MEETING_TABLE_BLOCK_ENTITY;

	private static boolean registered;

	private OrgContent() {
	}

	public static void register() {
		if (registered) {
			return;
		}
		registered = true;

		CODEX = block(
			"codex",
			CodexBlock::new,
			BlockBehaviour.Properties.of()
				.mapColor(MapColor.WOOD)
				.strength(2.5F)
				.sound(SoundType.CHISELED_BOOKSHELF)
				.noOcclusion()
				.pushReaction(PushReaction.IMMOVEABLE)
				.ignitedByLava()
		);
		CODEX_ITEM = blockItem("codex", CODEX, new Item.Properties().stacksTo(16));
		CODEX_BLOCK_ENTITY = Registry.register(
			BuiltInRegistries.BLOCK_ENTITY_TYPE, MineVibeMod.id("codex"), new BlockEntityType<>(CodexBlockEntity::new, Set.of(CODEX))
		);

		WALL_CALENDAR = block(
			"wall_calendar",
			WallCalendarBlock::new,
			BlockBehaviour.Properties.of().mapColor(MapColor.WOOL).strength(0.5F).sound(SoundType.WOOD).noCollision().noOcclusion().pushReaction(PushReaction.POPPED)
		);
		WALL_CALENDAR_ITEM = blockItem("wall_calendar", WALL_CALENDAR, new Item.Properties());

		ResourceKey<Item> calendarKey = ResourceKey.create(Registries.ITEM, MineVibeMod.id("calendar"));
		CALENDAR = Registry.register(BuiltInRegistries.ITEM, calendarKey, new CalendarItem(new Item.Properties().setId(calendarKey).stacksTo(1)));

		MEETING_TABLE = block(
			"meeting_table",
			MeetingTableBlock::new,
			BlockBehaviour.Properties.of().mapColor(MapColor.WOOD).strength(2.0F).sound(SoundType.WOOD).noOcclusion().ignitedByLava()
		);
		MEETING_TABLE_ITEM = blockItem("meeting_table", MEETING_TABLE, new Item.Properties());
		MEETING_TABLE_BLOCK_ENTITY = Registry.register(
			BuiltInRegistries.BLOCK_ENTITY_TYPE,
			MineVibeMod.id("meeting_table"),
			new BlockEntityType<>(MeetingTableBlockEntity::new, Set.of(MEETING_TABLE))
		);

		CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.FUNCTIONAL_BLOCKS).register(output -> {
			output.accept(CODEX_ITEM);
			output.accept(WALL_CALENDAR_ITEM);
			output.accept(MEETING_TABLE_ITEM);
		});
		CreativeModeTabEvents.modifyOutputEvent(CreativeModeTabs.TOOLS_AND_UTILITIES).register(output -> output.accept(CALENDAR));
	}

	private static Block block(final String path, final Function<BlockBehaviour.Properties, Block> factory, final BlockBehaviour.Properties properties) {
		ResourceKey<Block> key = ResourceKey.create(Registries.BLOCK, MineVibeMod.id(path));
		return Registry.register(BuiltInRegistries.BLOCK, key, factory.apply(properties.setId(key)));
	}

	private static Item blockItem(final String path, final Block block, final Item.Properties properties) {
		ResourceKey<Item> key = ResourceKey.create(Registries.ITEM, MineVibeMod.id(path));
		BlockItem item = new BlockItem(block, properties.setId(key).useBlockDescriptionPrefix());
		item.registerBlocks(Item.BY_BLOCK, item);
		return Registry.register(BuiltInRegistries.ITEM, key, item);
	}
}
