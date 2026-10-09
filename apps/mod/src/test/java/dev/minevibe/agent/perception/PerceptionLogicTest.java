package dev.minevibe.agent.perception;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.bridge.msg.Skills;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** W1 perception without a world: compass words, natural tag expansion, tree mode, clustering, result shapes. */
class PerceptionLogicTest {
	@BeforeAll
	static void bootstrap() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void compassPointsNorthToMinusZ() {
		BlockPos o = new BlockPos(0, 64, 0);
		assertEquals("N", Compass.dir(o, new BlockPos(0, 64, -10)));
		assertEquals("S", Compass.dir(o, new BlockPos(0, 64, 10)));
		assertEquals("E", Compass.dir(o, new BlockPos(10, 64, 0)));
		assertEquals("W", Compass.dir(o, new BlockPos(-10, 64, 0)));
		assertEquals("NE", Compass.dir(o, new BlockPos(7, 64, -7)));
		assertEquals("SW", Compass.dir(o, new BlockPos(-7, 64, 7)));
		assertEquals("above", Compass.dir(o, new BlockPos(1, 70, 0)));
		assertEquals("below", Compass.dir(o, new BlockPos(0, 50, 0)));
		assertEquals("here", Compass.dir(o, new BlockPos(1, 64, 0)));
		assertEquals("14m NE", Compass.where(o, new BlockPos(10, 64, -10)));
	}

	@Test
	void buildingVariantsAreNotTreeParts() {
		// Tags are only bound in a running server (the GameTests check #minecraft:logs itself); the names are checked here.
		assertTrue(Trees.isBuildingVariant(Blocks.STRIPPED_SPRUCE_LOG), "stripped logs are building material");
		assertTrue(Trees.isBuildingVariant(Blocks.OAK_WOOD), "wood is building material");
		assertTrue(Trees.isBuildingVariant(Blocks.STRIPPED_OAK_WOOD));
		assertTrue(Trees.isBuildingVariant(Blocks.CRIMSON_HYPHAE));
		assertTrue(Trees.isBuildingVariant(Blocks.SPRUCE_PLANKS));
		assertFalse(Trees.isBuildingVariant(Blocks.OAK_LOG));
		assertFalse(Trees.isBuildingVariant(Blocks.CRIMSON_STEM));
		Predicate<BlockState> anyLog = s -> s.is(Blocks.OAK_LOG) || s.is(Blocks.STRIPPED_OAK_LOG) || s.is(Blocks.OAK_WOOD);
		Predicate<BlockState> natural = Sources.naturalTag(anyLog);
		assertTrue(natural.test(Blocks.OAK_LOG.defaultBlockState()));
		assertFalse(natural.test(Blocks.STRIPPED_OAK_LOG.defaultBlockState()));
		assertFalse(natural.test(Blocks.OAK_WOOD.defaultBlockState()));
		assertTrue(Sources.acceptsNothing(Sources.naturalTag(s -> s.is(Blocks.OAK_PLANKS) || s.is(Blocks.BIRCH_PLANKS))), "planks are never natural");
		assertFalse(Sources.acceptsNothing(s -> s.is(Blocks.OAK_PLANKS)), "named planks still mean planks");
		assertEquals("dark_oak", Trees.species(Blocks.DARK_OAK_LOG));
		assertEquals("warped", Trees.species(Blocks.WARPED_STEM));
		assertTrue(Trees.isNaturalLeaf(Blocks.OAK_LEAVES.defaultBlockState()));
		assertFalse(Trees.isNaturalLeaf(Blocks.OAK_LEAVES.defaultBlockState().setValue(net.minecraft.world.level.block.LeavesBlock.PERSISTENT, true)),
			"leaves a player placed are persistent");
	}

	@Test
	void builtBlocksClusterByProximity() {
		List<BlockPos> blocks = new ArrayList<>();
		for (int x = 0; x < 5; x++) {
			blocks.add(new BlockPos(x, 64, 0));
		}
		blocks.add(new BlockPos(40, 64, 40));
		blocks.add(new BlockPos(41, 65, 40));
		List<List<BlockPos>> groups = Scene.cluster(blocks);
		assertEquals(2, groups.size());
		assertTrue(groups.stream().anyMatch(g -> g.size() == 5));
		assertTrue(groups.stream().anyMatch(g -> g.size() == 2));
	}

	/** The People line says whether a player is indoors: what an agent checks before calling them safe at night. */
	@Test
	void playersAreInsideOrInTheOpen() {
		assertEquals("in Base, under cover", Scene.shelterWords("Base", true));
		assertEquals("in Base, in the open", Scene.shelterWords("Base", false));
		assertEquals("under cover", Scene.shelterWords(null, true));
		assertEquals("in the open", Scene.shelterWords(null, false));
	}

	@Test
	void detailShapesMatchTheProtocol() {
		JsonObject prot = JsonParser.parseString("""
			{"pos":{"x":1,"y":64,"z":2},"what":"base","owner":"Steve","block":"minecraft:stripped_spruce_log","zone":"Base","count":3,
			 "consentId":"0123456789abcdef0123456789abcdef","hint":"That's part of Steve's base — ask Steve before changing it."}""").getAsJsonObject();
		assertEquals(List.of(), Skills.PROTECTED_DETAIL.validate(prot));
		prot.addProperty("what", "house");
		assertFalse(Skills.PROTECTED_DETAIL.validate(prot).isEmpty());

		Sources.Candidate c = new Sources.Candidate(new BlockPos(3, 70, -2), "oak tree", 9, "W", "unreachable", null);
		assertEquals("oak tree 9m W at 3 70 -2 (unreachable)", c.describe());
		JsonObject nns = new JsonObject();
		nns.addProperty("what", "oak_log");
		nns.addProperty("radius", 24);
		com.google.gson.JsonArray arr = new com.google.gson.JsonArray();
		arr.add(c.toJson());
		nns.add("candidates", arr);
		nns.addProperty("hint", "Don't take anything else instead.");
		assertEquals(List.of(), Skills.NO_NATURAL_SOURCE.validate(nns));
	}

	/** What a log may never touch to count as a tree (a cabin's planks, windows, doors), and what trees do touch. */
	@Test
	void buildingBlocksAreNotWhatTreesGrowAgainst() {
		for (net.minecraft.world.level.block.Block b : List.of(Blocks.OAK_PLANKS, Blocks.STRIPPED_OAK_LOG, Blocks.GLASS, Blocks.GLASS_PANE, Blocks.STAINED_GLASS.pick(DyeColor.WHITE),
			Blocks.OAK_DOOR, Blocks.SPRUCE_TRAPDOOR, Blocks.OAK_STAIRS, Blocks.COBBLESTONE_SLAB, Blocks.OAK_FENCE, Blocks.OAK_FENCE_GATE, Blocks.COBBLESTONE_WALL,
			Blocks.COBBLESTONE, Blocks.STONE_BRICKS, Blocks.BRICKS, Blocks.WOOL.pick(DyeColor.WHITE), Blocks.CARPET.pick(DyeColor.RED), Blocks.BED.pick(DyeColor.RED), Blocks.CHEST, Blocks.BARREL,
			Blocks.CRAFTING_TABLE, Blocks.FURNACE, Blocks.BOOKSHELF, Blocks.CONCRETE.pick(DyeColor.WHITE))) {
			assertTrue(Trees.isBuildingBlock(b.defaultBlockState()), b + " is a building block");
		}
		for (net.minecraft.world.level.block.Block b : List.of(Blocks.OAK_LOG, Blocks.OAK_LEAVES, Blocks.GRASS_BLOCK, Blocks.DIRT, Blocks.PODZOL, Blocks.VINE,
			Blocks.MOSS_CARPET, Blocks.PALE_MOSS_CARPET, Blocks.BEE_NEST, Blocks.COCOA, Blocks.MANGROVE_ROOTS, Blocks.MUD, Blocks.SNOW, Blocks.MOSSY_COBBLESTONE,
			Blocks.SHROOMLIGHT, Blocks.CREAKING_HEART, Blocks.TERRACOTTA, Blocks.SHORT_GRASS, Blocks.STONE)) {
			assertFalse(Trees.isBuildingBlock(b.defaultBlockState()), b + " grows or lies next to trees");
		}
	}
}
