package dev.minevibe.world;

import dev.minevibe.MineVibeMod;
import dev.minevibe.world.grave.GraveBlock;
import dev.minevibe.world.grave.GraveBlockEntity;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.util.Set;
import java.util.function.Function;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.material.PushReaction;

/** Blocks, items and entities added by the agent-body spike (S1): office chair, seat, grave. */
public final class MvWorldContent {
	public static Block OFFICE_CHAIR;
	public static Item OFFICE_CHAIR_ITEM;
	public static Block GRAVE;
	public static BlockEntityType<GraveBlockEntity> GRAVE_BLOCK_ENTITY;
	public static EntityType<SeatEntity> SEAT;

	private static boolean registered;

	private MvWorldContent() {
	}

	public static void register() {
		if (registered) {
			return;
		}
		registered = true;

		OFFICE_CHAIR = block(
			"office_chair",
			OfficeChairBlock::new,
			BlockBehaviour.Properties.of().mapColor(MapColor.COLOR_BLACK).strength(1.0F).sound(SoundType.WOOL).noOcclusion()
		);
		OFFICE_CHAIR_ITEM = blockItem("office_chair", OFFICE_CHAIR);

		GRAVE = block(
			"grave",
			GraveBlock::new,
			BlockBehaviour.Properties.of()
				.mapColor(MapColor.STONE)
				.strength(2.0F, 1200.0F)
				.sound(SoundType.STONE)
				.noOcclusion()
				.forceSolidOn()
				.pushReaction(PushReaction.IMMOVEABLE)
		);
		GRAVE_BLOCK_ENTITY = Registry.register(
			BuiltInRegistries.BLOCK_ENTITY_TYPE, MineVibeMod.id("grave"), new BlockEntityType<>(GraveBlockEntity::new, Set.of(GRAVE))
		);

		ResourceKey<EntityType<?>> seatKey = ResourceKey.create(Registries.ENTITY_TYPE, MineVibeMod.id("seat"));
		SEAT = Registry.register(
			BuiltInRegistries.ENTITY_TYPE,
			seatKey,
			EntityType.Builder.<SeatEntity>of(SeatEntity::new, MobCategory.MISC)
				.sized(0.5F, 0.5F)
				.noSummon()
				.clientTrackingRange(10)
				.updateInterval(20)
				.build(seatKey)
		);
	}

	private static Block block(final String path, final Function<BlockBehaviour.Properties, Block> factory, final BlockBehaviour.Properties properties) {
		ResourceKey<Block> key = ResourceKey.create(Registries.BLOCK, MineVibeMod.id(path));
		return Registry.register(BuiltInRegistries.BLOCK, key, factory.apply(properties.setId(key)));
	}

	private static Item blockItem(final String path, final Block block) {
		ResourceKey<Item> key = ResourceKey.create(Registries.ITEM, MineVibeMod.id(path));
		BlockItem item = new BlockItem(block, new Item.Properties().setId(key).useBlockDescriptionPrefix());
		item.registerBlocks(Item.BY_BLOCK, item);
		return Registry.register(BuiltInRegistries.ITEM, key, item);
	}
}
