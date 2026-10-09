package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.SkillTestSupport.error;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.recorder;
import static dev.minevibe.gametest.agent.SkillTestSupport.result;
import static dev.minevibe.gametest.agent.SkillTestSupport.status;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Provenance;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.animal.cow.Cow;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The v2 skill additions (docs/design/tools-v2-mc.md M1-M9): {@code sequence}, the craft tree with
 * {@code gather_missing}, the gather extensions ({@code make_tools}, animals for drops), the recipe tree observation,
 * the nearest container, and {@code hello.caps}. The incident runs end to end as the v2 tools send it: one
 * {@code sequence[collect oak_log, craft crafting_table]} next to the player's house and an unreachable tree.
 *
 * <p>Layout of {@link #FOREST} (W1's forest_yard: 41x20x41, ground level y 1): the agent at (20, 1, 20), the player's
 * house at (22..26, 1..4, 22..26), an oak on a pillar at (14, 9, 20) out of reach, a reachable oak at (20, 1, 8).
 */
public final class SkillsV2GameTests {
	private static final String FOREST = "minevibe-gametest:forest_yard";
	private static final String WIDE_YARD = "minevibe-gametest:wide_yard";
	private static final String DAY = "minevibe-gametest:day";
	private static final BlockPos AGENT = new BlockPos(20, 1, 20);
	private static final BlockPos HOUSE = new BlockPos(22, 1, 22);
	private static final BlockPos PILLAR_TREE = new BlockPos(14, 9, 20);
	private static final BlockPos TREE = new BlockPos(20, 1, 8);

	// ------------------------------------------------------------------ scenery (as ProtectionGameTests builds it)

	private static Map<BlockPos, BlockState> buildHouse(final GameTestHelper helper, final BlockPos corner) {
		ServerLevel level = helper.getLevel();
		Owner steve = Owner.player(UUID.nameUUIDFromBytes("steve".getBytes(java.nio.charset.StandardCharsets.UTF_8)), "Steve");
		Map<BlockPos, BlockState> house = new LinkedHashMap<>();
		for (int x = 0; x <= 4; x++) {
			for (int z = 0; z <= 4; z++) {
				for (int y = 0; y <= 3; y++) {
					boolean edgeX = x == 0 || x == 4;
					boolean edgeZ = z == 0 || z == 4;
					BlockState state;
					if (y == 3) {
						state = Blocks.SPRUCE_PLANKS.defaultBlockState();
					} else if (edgeX && edgeZ) {
						state = Blocks.STRIPPED_SPRUCE_LOG.defaultBlockState();
					} else if (edgeX || edgeZ) {
						state = Blocks.SPRUCE_PLANKS.defaultBlockState();
					} else {
						continue;
					}
					BlockPos rel = corner.offset(x, y, z);
					helper.setBlock(rel, state);
					BlockPos abs = helper.absolutePos(rel);
					Provenance.mark(level, abs, steve);
					house.put(abs, level.getBlockState(abs));
				}
			}
		}
		return house;
	}

	private static List<BlockPos> plantTree(final GameTestHelper helper, final BlockPos base, final int height, final Block log, final Block leaves) {
		List<BlockPos> logs = new ArrayList<>();
		for (int y = 0; y < height; y++) {
			helper.setBlock(base.above(y), log);
			logs.add(helper.absolutePos(base.above(y)));
		}
		BlockState leaf = leaves.defaultBlockState().setValue(LeavesBlock.DISTANCE, 1).setValue(LeavesBlock.PERSISTENT, false);
		for (int y = height - 2; y < height; y++) {
			for (Direction d : Direction.Plane.HORIZONTAL) {
				helper.setBlock(base.above(y).relative(d), leaf);
			}
		}
		helper.setBlock(base.above(height), leaf);
		return logs;
	}

	private static List<BlockPos> plantPillarTree(final GameTestHelper helper) {
		for (int y = 1; y < PILLAR_TREE.getY(); y++) {
			helper.setBlock(new BlockPos(PILLAR_TREE.getX(), y, PILLAR_TREE.getZ()), Blocks.STONE);
		}
		return plantTree(helper, PILLAR_TREE, 6, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
	}

	private static void assertIntact(final GameTestHelper helper, final Map<BlockPos, BlockState> blocks, final String what) {
		for (Map.Entry<BlockPos, BlockState> e : blocks.entrySet()) {
			BlockState now = helper.getLevel().getBlockState(e.getKey());
			helper.assertTrue(now == e.getValue(), what + " changed at " + e.getKey().toShortString() + ": " + now);
		}
	}

	private static void assertLogs(final GameTestHelper helper, final List<BlockPos> logs, final String what) {
		for (BlockPos p : logs) {
			helper.assertTrue(helper.getLevel().getBlockState(p).is(Blocks.OAK_LOG), what + " lost a log at " + p.toShortString());
		}
	}

	private static CompletableFuture<Map<String, Object>> run(final GameTestHelper helper, final AgentPlayer agent, final String skill, final String args) {
		return SkillTestSupport.run(helper, agent, jobId(skill), skill, args, 240_000);
	}

	private static void assertDone(final GameTestHelper helper, final CompletableFuture<Map<String, Object>> reply, final String what) {
		String s = status(reply);
		if ("failed".equals(s) || "cancelled".equals(s)) {
			helper.fail(what + " " + s + ": " + error(reply) + " " + result(reply));
		}
		helper.assertTrue("done".equals(s), what + " not done yet (" + s + ")");
	}

	private static void assertValid(final GameTestHelper helper, final AgentPlayer agent) {
		List<SkillTestSupport.Sent> bad = recorder(helper).invalid(agent.agentId());
		helper.assertTrue(bad.isEmpty(), "messages failed the protocol schema: " + bad);
	}

	// ------------------------------------------------------------------ the incident, the v2 way

	/**
	 * "collect 10 oak logs and make a crafting table" as v2's {@code do} sends it: one sequence. The agent fells the
	 * reachable oak (not the house, not the tree on the pillar), then crafts the table from one of the logs.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 3000)
	public void sequenceGathersNaturalLogsThenCraftsATable(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		List<BlockPos> pillarTree = plantPillarTree(helper);
		plantTree(helper, TREE, 6, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "sequence", """
			{"steps":[
			  {"skill":"collect","args":{"item":"oak_log","count":6,"radius":48,"make_tools":true}},
			  {"skill":"craft","args":{"item":"crafting_table","count":1,"tree":true}}
			]}""");
		helper.onEachTick(() -> {
			assertIntact(helper, house, "the house");
			assertLogs(helper, pillarTree, "the pillar tree");
		});
		helper.succeedWhen(() -> {
			assertDone(helper, r, "sequence");
			JsonObject res = result(r);
			helper.assertValueEqual(res.get("completed").getAsInt(), 2, "steps completed: " + res);
			JsonArray steps = res.getAsJsonArray("steps");
			JsonObject gather = steps.get(0).getAsJsonObject().getAsJsonObject("result");
			helper.assertTrue(gather.get("got").getAsInt() >= 6, "gathered: " + gather);
			helper.assertTrue("tree".equals(gather.getAsJsonArray("sources").get(0).getAsJsonObject().get("kind").getAsString()),
				"from a tree: " + gather);
			helper.assertTrue(Inv.count(agent, Items.CRAFTING_TABLE) >= 1, "a crafting table");
			helper.assertTrue(Inv.count(agent, Items.OAK_LOG) >= 5, "logs kept: " + Inv.count(agent, Items.OAK_LOG));
			assertIntact(helper, house, "the house");
			assertLogs(helper, pillarTree, "the pillar tree");
			assertValid(helper, agent);
		});
	}

	// ------------------------------------------------------------------ the craft tree

	/** Nothing in the bag: the tree gathers a log from the reachable oak (gather_missing), makes planks, then the table. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 3000)
	public void craftTreeGathersWhatIsMissing(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		plantTree(helper, TREE, 5, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Crafty", AgentRole.BUILDER, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"crafting_table\",\"count\":1,\"tree\":true,\"gather_missing\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "craft tree");
			JsonObject res = result(r);
			helper.assertValueEqual(res.get("crafted").getAsInt(), 1, "crafted: " + res);
			helper.assertTrue(res.has("gathered") && res.getAsJsonObject("gathered").has("oak_log"), "gathered oak logs: " + res);
			helper.assertTrue(res.getAsJsonArray("steps").toString().contains("oak_planks"), "made planks first: " + res);
			helper.assertTrue(Inv.count(agent, Items.CRAFTING_TABLE) == 1, "the table");
			assertIntact(helper, house, "the house");
			assertValid(helper, agent);
		});
	}

	/** Without gather_missing nothing is crafted: MISSING_INGREDIENTS lists the raw materials. */
	@GameTest(maxTicks = 200)
	public void craftTreeListsMissingRawMaterials(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Poor", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.STICK, 2));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"iron_pickaxe\",\"count\":1,\"tree\":true}");
		helper.succeedWhen(() -> {
			helper.assertTrue(r.isDone(), "still running");
			helper.assertTrue("failed".equals(status(r)), "expected failure, got " + status(r));
			helper.assertTrue(error(r).contains("MISSING_INGREDIENTS"), "error " + error(r));
			String missing = result(r).getAsJsonArray("missing").toString();
			helper.assertTrue(missing.contains("raw_iron"), "raw iron is missing: " + missing);
			helper.assertValueEqual(Inv.count(agent, Items.STICK), 2, "sticks untouched");
		});
	}

	/** Logs to iron ingots: the tree smelts in the furnace nearby and crafts sticks and the pickaxe at the table. */
	@GameTest(structure = WIDE_YARD, maxTicks = 2400)
	public void craftTreeSmeltsForAnIronPickaxe(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(23, 1, 20), Blocks.FURNACE);
		helper.setBlock(new BlockPos(20, 1, 23), Blocks.CRAFTING_TABLE);
		AgentPlayer agent = spawnAgent(helper, "Smith", AgentRole.MINER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.RAW_IRON, 3));
		agent.getInventory().setItem(1, new ItemStack(Items.OAK_LOG, 2));
		agent.getInventory().setItem(2, new ItemStack(Items.COAL, 1));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"iron_pickaxe\",\"count\":1,\"tree\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "iron pickaxe");
			helper.assertValueEqual(Inv.count(agent, Items.IRON_PICKAXE), 1, "iron pickaxe");
			helper.assertValueEqual(Inv.count(agent, Items.RAW_IRON), 0, "raw iron smelted");
			helper.assertTrue(result(r).getAsJsonArray("steps").toString().contains("raw_iron 3"), "smelted: " + result(r));
		});
	}

	/** {@code obs.query recipe{tree:true}}: the plan without touching anything. */
	@GameTest(maxTicks = 40)
	public void recipeTreePlansWithoutActing(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Planner", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_LOG, 3));
		JsonObject args = SkillTestSupport.json("{\"item\":\"wooden_pickaxe\",\"count\":1,\"tree\":true}");
		JsonObject plan = dev.minevibe.agent.skill.Observations.query(SkillTestSupport.service(helper), agent, "recipe", args);
		helper.assertTrue(plan.get("ok").getAsBoolean(), "complete from 3 logs: " + plan);
		helper.assertTrue(plan.getAsJsonArray("steps").toString().contains("\"item\":\"stick\""), "sticks in the plan: " + plan);
		helper.assertTrue(plan.getAsJsonObject("stations").has("table"), "a 3x3 recipe names its table: " + plan);
		helper.assertValueEqual(Inv.count(agent, Items.OAK_LOG), 3, "nothing used");
		helper.succeed();
	}

	// ------------------------------------------------------------------ sequence

	/** stop_on_fail (the default): the first failed step fails the sequence with its code; the next step never runs. */
	@GameTest(maxTicks = 300)
	public void sequenceStopsAtTheFirstFailure(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Steps", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 2));
		CompletableFuture<Map<String, Object>> stop = run(helper, agent, "sequence",
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"craft\",\"args\":{\"item\":\"stick\",\"count\":4}}]}");
		helper.succeedWhen(() -> {
			helper.assertTrue(stop.isDone(), "still running");
			helper.assertTrue("failed".equals(status(stop)), "expected failure, got " + status(stop) + " " + result(stop));
			helper.assertTrue(error(stop).contains("step 1/2 eat"), "names the step: " + error(stop));
			JsonObject res = result(stop);
			helper.assertValueEqual(res.get("completed").getAsInt(), 0, "completed");
			helper.assertValueEqual(res.getAsJsonArray("steps").size(), 1, "only the failed step ran");
			helper.assertValueEqual(Inv.count(agent, Items.STICK), 0, "no sticks: the craft never ran");
		});
	}

	/** stop_on_fail false: every step runs; the sequence still reports the failure at the end. */
	@GameTest(maxTicks = 300)
	public void sequenceRunsOnWithoutStopOnFail(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Onward", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 2));
		CompletableFuture<Map<String, Object>> go = run(helper, agent, "sequence",
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"craft\",\"args\":{\"item\":\"stick\",\"count\":4}}],\"stop_on_fail\":false}");
		helper.succeedWhen(() -> {
			helper.assertTrue(go.isDone(), "still running");
			helper.assertTrue("failed".equals(status(go)), "the eat step failed: " + status(go));
			JsonObject res = result(go);
			helper.assertValueEqual(res.get("completed").getAsInt(), 1, "the craft step ran: " + res);
			helper.assertValueEqual(Inv.count(agent, Items.STICK), 4, "sticks");
		});
	}

	/** A bad step rejects the whole sequence before anything runs. */
	@GameTest(maxTicks = 20)
	public void sequenceRejectsABadStepUpFront(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Strict", AgentRole.ENGINEER, 3, 0, 3);
		try {
			run(helper, agent, "sequence", "{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"emote\",\"args\":{\"kind\":\"wave\"}}]}");
			helper.fail("an emote step was accepted");
		} catch (BridgeException e) {
			helper.assertTrue(e.getMessage().contains("step 2"), "names the step: " + e.getMessage());
		}
		try {
			run(helper, agent, "sequence", "{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"craft\",\"args\":{\"count\":2}}]}");
			helper.fail("a craft without item was accepted");
		} catch (BridgeException e) {
			helper.assertTrue(e.getMessage().contains("step 2: craft"), "names the step: " + e.getMessage());
		}
		helper.assertTrue(!agent.jobs().hasJob(), "nothing started");
		helper.succeed();
	}

	// ------------------------------------------------------------------ gather extensions

	/** make_tools: stone needs a pickaxe; one is crafted from the planks and sticks in the bag, then mined. */
	@GameTest(structure = WIDE_YARD, maxTicks = 1200)
	public void collectMakesTheToolItNeeds(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(22, 1, 20), Blocks.STONE);
		helper.setBlock(new BlockPos(20, 1, 22), Blocks.CRAFTING_TABLE);
		AgentPlayer agent = spawnAgent(helper, "Mason", AgentRole.MINER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 3));
		agent.getInventory().setItem(1, new ItemStack(Items.STICK, 2));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"cobblestone\",\"count\":1,\"radius\":8,\"make_tools\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect cobblestone");
			helper.assertTrue(Inv.count(agent, Items.COBBLESTONE) >= 1, "cobblestone");
			helper.assertValueEqual(Inv.count(agent, Items.WOODEN_PICKAXE), 1, "the pickaxe it made");
			helper.assertTrue(result(r).getAsJsonArray("tools_made").toString().contains("wooden_pickaxe"), "says so: " + result(r));
		});
	}

	/** Animals for drops: the free cow is gathered, the named one is left alone. */
	@GameTest(structure = WIDE_YARD, environment = DAY, maxTicks = 1200)
	public void collectBeefFromAnAnimalButNeverANamedOne(final GameTestHelper helper) {
		Cow named = helper.spawn(EntityTypes.COW, new BlockPos(16, 1, 20));
		named.setCustomName(Component.literal("Daisy"));
		Cow free = helper.spawn(EntityTypes.COW, new BlockPos(25, 1, 20));
		AgentPlayer agent = spawnAgent(helper, "Hunter", AgentRole.FARMER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"beef\",\"count\":1,\"radius\":16}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect beef");
			helper.assertTrue(Inv.count(agent, Items.BEEF) >= 1, "beef");
			helper.assertTrue(named.isAlive(), "Daisy lives");
			helper.assertTrue(!free.isAlive(), "the free cow was the one");
			helper.assertTrue(result(r).getAsJsonArray("sources").toString().contains("animal"), "an animal source: " + result(r));
		});
	}

	// ------------------------------------------------------------------ containers and caps

	/** container without pos: the nearest chest; the result says which. */
	@GameTest(maxTicks = 300)
	public void containerUsesTheNearestChest(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(5, 0, 3), Blocks.CHEST);
		AgentPlayer agent = spawnAgent(helper, "Porter", AgentRole.BUILDER, 2, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.COBBLESTONE, 10));
		CompletableFuture<Map<String, Object>> put = run(helper, agent, "container", "{\"action\":\"put\",\"item\":\"cobblestone\"}");
		helper.succeedWhen(() -> {
			assertDone(helper, put, "put");
			BlockPos chest = helper.absolutePos(new BlockPos(5, 0, 3));
			JsonObject pos = result(put).getAsJsonObject("pos");
			helper.assertValueEqual(pos.get("x").getAsInt(), chest.getX(), "the chest's x");
			helper.assertValueEqual(Inv.count(agent, Items.COBBLESTONE), 0, "all stored");
		});
	}

	/** hello lists every v2 cap (Node checks them before using the additive arguments). */
	@GameTest(maxTicks = 1)
	public void helloListsTheCaps(final GameTestHelper helper) {
		List<String> caps = dev.minevibe.agent.skill.SkillCaps.ALL;
		for (String cap : List.of("skill.sequence", "collect.gather", "craft.tree", "obs.recipe.tree", "container.nearest", "give.all", "run.replaced")) {
			helper.assertTrue(caps.contains(cap), "missing cap " + cap);
		}
		String hello = dev.minevibe.bridge.protocol.ProtocolCodec.encode(dev.minevibe.bridge.protocol.Messages.HELLO,
			new dev.minevibe.bridge.protocol.Messages.Hello("0.2.0", "26.3", "boot", null, null, caps), "m-1", null);
		helper.assertTrue(hello.contains("\"caps\":[\"skill.sequence\""), hello);
		helper.succeed();
	}
}
