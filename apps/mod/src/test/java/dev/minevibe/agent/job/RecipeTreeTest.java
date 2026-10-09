package dev.minevibe.agent.job;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The recipe tree planner (tools-v2-mc.md M4) over a small hand-written recipe book. */
class RecipeTreeTest {
	@BeforeAll
	static void bootstrap() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** A few vanilla recipes, the way the server's book would list them (2x2 first). */
	static final class TestBook implements RecipeTree.Book {
		private final Map<Item, List<RecipeTree.CraftOption>> crafts = new HashMap<>();
		private final Map<Item, List<RecipeTree.SmeltOption>> smelts = new HashMap<>();

		void craft(final Item result, final int makes, final boolean fits2x2, final List<List<Item>> slots) {
			this.crafts.computeIfAbsent(result, k -> new ArrayList<>()).add(new RecipeTree.CraftOption(result + "/" + slots.size(), result, makes, slots, fits2x2));
			this.crafts.get(result).sort((a, b) -> Boolean.compare(!a.fits2x2(), !b.fits2x2()));
		}

		void smelt(final Item result, final Item... inputs) {
			this.smelts.computeIfAbsent(result, k -> new ArrayList<>()).add(new RecipeTree.SmeltOption("smelt " + result, result, List.of(inputs)));
		}

		@Override
		public List<RecipeTree.CraftOption> crafting(final Item item) {
			return this.crafts.getOrDefault(item, List.of());
		}

		@Override
		public List<RecipeTree.SmeltOption> smelting(final Item item) {
			return this.smelts.getOrDefault(item, List.of());
		}

		@Override
		public int burnTicks(final Item item) {
			if (item == Items.COAL || item == Items.CHARCOAL) {
				return 1600;
			}
			if (item == Items.OAK_LOG || item == Items.OAK_PLANKS || item == Items.BIRCH_LOG) {
				return 300;
			}
			return item == Items.STICK ? 100 : 0;
		}
	}

	static List<List<Item>> n(final int count, final Item... options) {
		List<List<Item>> out = new ArrayList<>();
		for (int i = 0; i < count; i++) {
			out.add(List.of(options));
		}
		return out;
	}

	static List<List<Item>> concat(final List<List<Item>> a, final List<List<Item>> b) {
		List<List<Item>> out = new ArrayList<>(a);
		out.addAll(b);
		return out;
	}

	static TestBook book() {
		TestBook b = new TestBook();
		b.craft(Items.OAK_PLANKS, 4, true, n(1, Items.OAK_LOG, Items.OAK_WOOD, Items.STRIPPED_OAK_LOG));
		b.craft(Items.BIRCH_PLANKS, 4, true, n(1, Items.BIRCH_LOG));
		b.craft(Items.OAK_WOOD, 3, true, n(4, Items.OAK_LOG));
		b.craft(Items.STICK, 4, true, n(2, Items.OAK_PLANKS, Items.BIRCH_PLANKS));
		b.craft(Items.CRAFTING_TABLE, 1, true, n(4, Items.OAK_PLANKS, Items.BIRCH_PLANKS));
		b.craft(Items.WOODEN_PICKAXE, 1, false, concat(n(3, Items.OAK_PLANKS, Items.BIRCH_PLANKS), n(2, Items.STICK)));
		// The book's order, as the server lists them: the stone tag sorts blackstone first, the ore recipe comes first.
		b.craft(Items.FURNACE, 1, false, n(8, Items.BLACKSTONE, Items.COBBLED_DEEPSLATE, Items.COBBLESTONE));
		b.craft(Items.IRON_PICKAXE, 1, false, concat(n(3, Items.IRON_INGOT), n(2, Items.STICK)));
		b.craft(Items.IRON_INGOT, 1, false, n(9, Items.IRON_NUGGET));
		b.craft(Items.IRON_INGOT, 9, true, n(1, Items.IRON_BLOCK));
		b.craft(Items.IRON_NUGGET, 9, true, n(1, Items.IRON_INGOT));
		b.craft(Items.IRON_BLOCK, 1, false, n(9, Items.IRON_INGOT));
		b.smelt(Items.IRON_INGOT, Items.IRON_ORE, Items.DEEPSLATE_IRON_ORE);
		b.smelt(Items.IRON_INGOT, Items.RAW_IRON);
		return b;
	}

	static Map<Item, Integer> inv(final Object... pairs) {
		Map<Item, Integer> m = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			m.put((Item)pairs[i], (Integer)pairs[i + 1]);
		}
		return m;
	}

	static final RecipeTree.Stations NONE = new RecipeTree.Stations(false, false);
	static final RecipeTree.Stations BOTH = new RecipeTree.Stations(true, true);

	static List<String> texts(final RecipeTree.Plan p) {
		return p.steps().stream().map(RecipeTree.Step::text).toList();
	}

	@Test
	void aCraftingTableFromLogsGoesThroughPlanks() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.CRAFTING_TABLE, 1, inv(Items.OAK_LOG, 10), NONE);
		assertTrue(p.complete(), p.missing().toString());
		assertEquals(List.of("oak_log 1 → oak_planks 4", "oak_planks 4 → crafting_table 1"), texts(p));
		assertFalse(p.needsTable(), "both recipes fit the 2x2 grid");
	}

	@Test
	void missingRawMaterialsArePlainLogsOfTheMostCommonKind() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.CRAFTING_TABLE, 1, inv(), NONE);
		assertFalse(p.complete());
		assertEquals(1, p.missing().size());
		RecipeTree.Missing m = p.missing().getFirst();
		assertEquals(Items.OAK_LOG, m.item(), "an oak log, not stripped logs or wood: " + m);
		assertEquals(1, m.need());
		assertEquals(Items.OAK_PLANKS, m.forItem());
	}

	@Test
	void theInventoryDecidesWhichWoodIsUsed() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.STICK, 4, inv(Items.BIRCH_LOG, 1), NONE);
		assertTrue(p.complete(), p.missing().toString());
		assertEquals(List.of("birch_log 1 → birch_planks 4", "birch_planks 2 → stick 4"), texts(p));
	}

	@Test
	void aThreeByThreeRecipeWithoutAStationCraftsATableFirstFromTheSameLogs() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.WOODEN_PICKAXE, 1, inv(Items.OAK_LOG, 3), NONE);
		assertTrue(p.complete(), p.missing().toString());
		assertTrue(p.makesTable());
		assertEquals("oak_planks 4 → crafting_table 1", texts(p).get(1));
		assertEquals(Items.WOODEN_PICKAXE, p.steps().getLast().item());
		int planks = p.steps().stream().filter(s -> s.item() == Items.OAK_PLANKS).mapToInt(RecipeTree.Step::made).sum();
		assertEquals(12, planks, "4 for the table, 3 for the head, 2 for the sticks, rounded up to whole crafts");
		// A table nearby: no table is made.
		RecipeTree.Plan near = RecipeTree.plan(book(), Items.WOODEN_PICKAXE, 1, inv(Items.OAK_LOG, 3), BOTH);
		assertFalse(near.makesTable());
		assertTrue(near.needsTable());
	}

	@Test
	void ingotsAreSmeltedNotCraftedFromNuggetsOrBlocksTheAgentDoesNotHave() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_PICKAXE, 1, inv(Items.RAW_IRON, 3, Items.COAL, 1, Items.STICK, 2), BOTH);
		assertTrue(p.complete(), p.missing().toString());
		assertEquals(List.of("raw_iron 3 → iron_ingot 3", "iron_ingot 3 + stick 2 → iron_pickaxe 1"), texts(p));
		assertTrue(p.needsFurnace());
		assertEquals(3, p.smelts());
	}

	@Test
	void withoutRawIronTheLeafIsRawIronAndTheFurnaceIsPlannedFromCobblestone() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_PICKAXE, 1, inv(Items.STICK, 2, Items.COAL, 2), new RecipeTree.Stations(true, false));
		assertFalse(p.complete());
		Map<Item, Integer> need = new HashMap<>();
		for (RecipeTree.Missing m : p.missing()) {
			need.put(m.item(), m.need());
		}
		assertEquals(3, need.get(Items.RAW_IRON), p.missing().toString());
		assertEquals(8, need.get(Items.COBBLESTONE), "a furnace first: " + p.missing());
		assertTrue(p.makesFurnace());
	}

	@Test
	void withNothingCarriedTheLeavesAreTheEverydayMaterials() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_PICKAXE, 1, inv(Items.STICK, 2), NONE);
		List<Item> leaves = p.missing().stream().map(RecipeTree.Missing::item).filter(java.util.Objects::nonNull).toList();
		assertTrue(leaves.contains(Items.RAW_IRON), "raw iron, not ore blocks: " + p.missing());
		assertTrue(leaves.contains(Items.COBBLESTONE), "cobblestone, not blackstone: " + p.missing());
		assertFalse(leaves.contains(Items.DEEPSLATE_IRON_ORE) || leaves.contains(Items.BLACKSTONE), p.missing().toString());
	}

	@Test
	void theSmeltsBurnTheCarriedCoalNotTheLogsForTheSticks() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_PICKAXE, 1, inv(Items.RAW_IRON, 3, Items.OAK_LOG, 2, Items.COAL, 1), BOTH);
		assertTrue(p.complete(), p.missing().toString());
		assertEquals(Map.of(Items.COAL, 1), p.fuel(), "one coal burns 1600 ticks");
		assertTrue(texts(p).contains("oak_log 1 → oak_planks 4"), texts(p).toString());
		// Without coal, the planks the sticks leave over are the fuel: the smelt waits until they are made.
		RecipeTree.Plan planks = RecipeTree.plan(book(), Items.IRON_PICKAXE, 1, inv(Items.RAW_IRON, 3, Items.OAK_LOG, 1), BOTH);
		assertTrue(planks.complete(), planks.missing().toString());
		assertEquals(Map.of(Items.OAK_PLANKS, 2), planks.fuel());
		assertEquals(List.of("oak_log 1 → oak_planks 4", "oak_planks 2 → stick 4", "raw_iron 3 → iron_ingot 3",
			"iron_ingot 3 + stick 2 → iron_pickaxe 1"), texts(planks));
	}

	@Test
	void aCarriedBlockOfIronIsUsed() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_INGOT, 3, inv(Items.IRON_BLOCK, 1), BOTH);
		assertTrue(p.complete(), p.missing().toString());
		assertEquals(List.of("iron_block 1 → iron_ingot 9"), texts(p));
	}

	@Test
	void smeltingWithoutFuelAsksForLogs() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_INGOT, 3, inv(Items.RAW_IRON, 3), BOTH);
		assertFalse(p.complete());
		RecipeTree.Missing fuel = p.missing().getFirst();
		assertEquals(RecipeTree.FUEL_REF, fuel.ref());
		assertEquals(2, fuel.need(), "600 ticks of smelting = 2 logs of 300");
		RecipeTree.Plan withPlanks = RecipeTree.plan(book(), Items.IRON_INGOT, 3, inv(Items.RAW_IRON, 3, Items.OAK_PLANKS, 2), BOTH);
		assertTrue(withPlanks.complete(), "two planks burn 600 ticks: " + withPlanks.missing());
	}

	/**
	 * Six kinds of wood, more than the planner tries per slot: planks, sticks, a table and wooden tools take any planks,
	 * an oak door only oak planks; stone tools take any of the three stones.
	 */
	static TestBook woodBook() {
		TestBook b = new TestBook();
		Item[][] woods = {
			{Items.OAK_PLANKS, Items.OAK_LOG}, {Items.ACACIA_PLANKS, Items.ACACIA_LOG}, {Items.BIRCH_PLANKS, Items.BIRCH_LOG},
			{Items.CHERRY_PLANKS, Items.CHERRY_LOG}, {Items.JUNGLE_PLANKS, Items.JUNGLE_LOG}, {Items.SPRUCE_PLANKS, Items.SPRUCE_LOG},
		};
		List<Item> planks = new ArrayList<>();
		for (Item[] w : woods) {
			b.craft(w[0], 4, true, n(1, w[1]));
			planks.add(w[0]);
		}
		Item[] any = planks.toArray(Item[]::new);
		b.craft(Items.STICK, 4, true, n(2, any));
		b.craft(Items.CRAFTING_TABLE, 1, true, n(4, any));
		b.craft(Items.WOODEN_PICKAXE, 1, false, concat(n(3, any), n(2, Items.STICK)));
		b.craft(Items.OAK_DOOR, 3, false, n(6, Items.OAK_PLANKS));
		b.craft(Items.STONE_PICKAXE, 1, false, concat(n(3, Items.BLACKSTONE, Items.COBBLED_DEEPSLATE, Items.COBBLESTONE), n(2, Items.STICK)));
		return b;
	}

	/** The families as the server's tags hold them (natural members only). */
	static Map<String, List<Item>> families() {
		return Map.of(
			"#minecraft:logs", List.of(Items.OAK_LOG, Items.ACACIA_LOG, Items.BIRCH_LOG, Items.CHERRY_LOG, Items.JUNGLE_LOG, Items.SPRUCE_LOG),
			"#minecraft:stone_tool_materials", List.of(Items.COBBLESTONE, Items.BLACKSTONE, Items.COBBLED_DEEPSLATE));
	}

	/** The gather ref of the plan's one missing material, the plan made with {@code stations}. */
	static String gatherRef(final TestBook book, final RecipeTree.Plan p, final Map<Item, Integer> inv, final RecipeTree.Stations stations) {
		assertEquals(1, p.missing().size(), p.missing().toString());
		return RecipeTree.gatherRef(book, p, p.missing().getFirst(), inv, stations, families());
	}

	@Test
	void aCarriedKindIsUsedEvenWhenTheFamilyHasMoreKindsThanTheCandidates() {
		// Spruce sorts last: before, only oak, acacia, birch and cherry planks were tried, and spruce logs went unused.
		RecipeTree.Plan p = RecipeTree.plan(woodBook(), Items.WOODEN_PICKAXE, 1, inv(Items.SPRUCE_LOG, 3), NONE);
		assertTrue(p.complete(), p.missing().toString());
		assertTrue(texts(p).contains("spruce_log 1 → spruce_planks 4"), texts(p).toString());
		assertFalse(texts(p).toString().contains("oak"), texts(p).toString());
	}

	@Test
	void anIngredientAnyWoodMakesIsGatheredAsTheFamily() {
		// Nothing carried: the plan names oak logs, but any log makes the planks, sticks and table of a wooden pickaxe.
		RecipeTree.Plan p = RecipeTree.plan(woodBook(), Items.WOODEN_PICKAXE, 1, inv(), NONE);
		assertEquals(Items.OAK_LOG, p.missing().getFirst().item());
		assertEquals("#minecraft:logs", gatherRef(woodBook(), p, inv(), NONE));
		// What the family gathered (birch, the nearest tree) completes the plan.
		RecipeTree.Plan birch = RecipeTree.plan(woodBook(), Items.WOODEN_PICKAXE, 1, inv(Items.BIRCH_LOG, 3), NONE);
		assertTrue(birch.complete(), birch.missing().toString());
		assertTrue(texts(birch).contains("birch_log 1 → birch_planks 4"), texts(birch).toString());
	}

	@Test
	void aKindTheRecipePinsStaysThatKind() {
		// An oak door takes oak planks only: birch logs would not do, so oak logs are gathered (or the player asked).
		RecipeTree.Plan p = RecipeTree.plan(woodBook(), Items.OAK_DOOR, 3, inv(), BOTH);
		assertEquals("oak_log", gatherRef(woodBook(), p, inv(), BOTH));
	}

	@Test
	void stoneToolsTakeAnyOfTheThreeStones() {
		Map<Item, Integer> sticks = inv(Items.STICK, 2);
		RecipeTree.Plan p = RecipeTree.plan(woodBook(), Items.STONE_PICKAXE, 1, sticks, BOTH);
		assertEquals(Items.COBBLESTONE, p.missing().getFirst().item(), "cobblestone, the everyday stone: " + p.missing());
		assertEquals("#minecraft:stone_tool_materials", gatherRef(woodBook(), p, sticks, BOTH));
		RecipeTree.Plan blackstone = RecipeTree.plan(woodBook(), Items.STONE_PICKAXE, 1, inv(Items.STICK, 2, Items.BLACKSTONE, 3), BOTH);
		assertTrue(blackstone.complete(), blackstone.missing().toString());
		assertEquals(List.of("blackstone 3 + stick 2 → stone_pickaxe 1"), texts(blackstone));
	}

	@Test
	void fuelIsAlreadyAnyLog() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.IRON_INGOT, 3, inv(Items.RAW_IRON, 3), BOTH);
		assertEquals(RecipeTree.FUEL_REF, gatherRef(book(), p, inv(Items.RAW_IRON, 3), BOTH));
	}

	@Test
	void theTargetIsMadeFreshAndSurplusIsKept() {
		RecipeTree.Plan p = RecipeTree.plan(book(), Items.STICK, 2, inv(Items.STICK, 5, Items.OAK_PLANKS, 2), NONE);
		assertTrue(p.complete());
		assertEquals(List.of("oak_planks 2 → stick 4"), texts(p), "two new sticks (one craft makes four)");
	}
}
