package dev.minevibe.pc;

import com.mojang.serialization.Codec;
import dev.minevibe.MineVibeMod;
import dev.minevibe.bridge.msg.Types;
import java.util.Set;
import net.minecraft.core.Registry;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.level.material.PushReaction;

/** The PC blocks, items and data component (PLAN 7.5). Registered once from {@link PcModInit}. */
public final class PcContent {
	/** {@code minevibe:pc_id}: which PC a workstation item is bound to. */
	public static DataComponentType<String> PC_ID;
	public static Block PC_DESK;
	public static BlockEntityType<PcBlockEntity> PC_BLOCK_ENTITY;
	public static Item LINUX_WORKSTATION;
	public static Item MAC_WORKSTATION;

	private static boolean registered;

	private PcContent() {}

	public static void register() {
		if (registered) {
			return;
		}
		registered = true;

		Codec<String> pcIdCodec = Codec.STRING.validate(
			s -> s.matches(Types.PC_ID_REGEX) ? com.mojang.serialization.DataResult.success(s) : com.mojang.serialization.DataResult.error(() -> "bad pc id: " + s)
		);
		PC_ID = Registry.register(
			BuiltInRegistries.DATA_COMPONENT_TYPE,
			MineVibeMod.id("pc_id"),
			DataComponentType.<String>builder().persistent(pcIdCodec).networkSynchronized(ByteBufCodecs.STRING_UTF8).build()
		);

		ResourceKey<Block> deskKey = ResourceKey.create(Registries.BLOCK, MineVibeMod.id("pc_desk"));
		PC_DESK = Registry.register(
			BuiltInRegistries.BLOCK,
			deskKey,
			new PcDeskBlock(
				BlockBehaviour.Properties.of()
					.setId(deskKey)
					.mapColor(MapColor.COLOR_GRAY)
					.strength(2.0F, 6.0F)
					.sound(SoundType.METAL)
					.noOcclusion()
					.pushReaction(PushReaction.IMMOVEABLE)
			)
		);
		PC_BLOCK_ENTITY = Registry.register(
			BuiltInRegistries.BLOCK_ENTITY_TYPE, MineVibeMod.id("pc_desk"), new BlockEntityType<>(PcBlockEntity::new, Set.of(PC_DESK))
		);

		LINUX_WORKSTATION = workstation("linux_workstation", "linux");
		MAC_WORKSTATION = workstation("mac_workstation", "macos");
	}

	private static Item workstation(final String path, final String pcType) {
		ResourceKey<Item> key = ResourceKey.create(Registries.ITEM, MineVibeMod.id(path));
		return Registry.register(BuiltInRegistries.ITEM, key, new WorkstationItem(pcType, new Item.Properties().setId(key).stacksTo(1)));
	}
}
