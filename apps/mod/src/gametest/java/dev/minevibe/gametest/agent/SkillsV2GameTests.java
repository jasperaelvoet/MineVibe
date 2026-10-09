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
import dev.minevibe.agent.job.CraftJobs;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.skill.SkillFactory;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Provenance;
import dev.minevibe.world.provenance.Zones;
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
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

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

	/**
	 * Any wood makes a wooden pickaxe: with only a birch in reach (no oak anywhere) the tree gathers the logs as their
	 * family and makes birch planks; it does not stop at "no oak" (the live run asked "Use birch?").
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 3000)
	public void craftTreeTakesAnyWoodInReach(final GameTestHelper helper) {
		List<BlockPos> birch = plantTree(helper, TREE, 5, Blocks.BIRCH_LOG, Blocks.BIRCH_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Woody", AgentRole.BUILDER, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"wooden_pickaxe\",\"count\":1,\"tree\":true,\"gather_missing\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "craft tree");
			JsonObject res = result(r);
			helper.assertValueEqual(Inv.count(agent, Items.WOODEN_PICKAXE), 1, "the pickaxe: " + res);
			helper.assertTrue(res.getAsJsonObject("gathered").has("birch_log"), "gathered birch logs: " + res);
			helper.assertTrue(res.getAsJsonArray("steps").toString().contains("birch_planks"), "birch planks: " + res);
			helper.assertTrue(!helper.getLevel().getBlockState(birch.getFirst()).is(Blocks.BIRCH_LOG), "the birch was felled");
			assertValid(helper, agent);
		});
	}

	/** Stone tools take cobblestone, blackstone or cobbled deepslate: with only blackstone around, blackstone it is. */
	@GameTest(structure = WIDE_YARD, maxTicks = 2400)
	public void craftTreeMakesStoneToolsFromBlackstone(final GameTestHelper helper) {
		for (int i = 0; i < 4; i++) {
			helper.setBlock(new BlockPos(22 + i, 1, 18), Blocks.BLACKSTONE);
		}
		helper.setBlock(new BlockPos(20, 1, 23), Blocks.CRAFTING_TABLE);
		AgentPlayer agent = spawnAgent(helper, "Mason", AgentRole.MINER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.WOODEN_PICKAXE));
		agent.getInventory().setItem(1, new ItemStack(Items.STICK, 2));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"stone_pickaxe\",\"count\":1,\"tree\":true,\"gather_missing\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "stone pickaxe");
			JsonObject res = result(r);
			helper.assertValueEqual(Inv.count(agent, Items.STONE_PICKAXE), 1, "the stone pickaxe: " + res);
			helper.assertTrue(res.getAsJsonObject("gathered").has("blackstone"), "gathered blackstone: " + res);
			helper.assertTrue(res.getAsJsonArray("steps").toString().contains("blackstone 3"), "made of blackstone: " + res);
			assertValid(helper, agent);
		});
	}

	/**
	 * A kind the recipe names stays that kind: oak planks need oak logs, so with only a birch in reach the tree fails
	 * NO_NATURAL_SOURCE (a question for the player) and the birch stands.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 1200)
	public void craftTreeKeepsTheKindTheRecipeNames(final GameTestHelper helper) {
		List<BlockPos> birch = plantTree(helper, TREE, 5, Blocks.BIRCH_LOG, Blocks.BIRCH_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Picky", AgentRole.BUILDER, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"oak_planks\",\"count\":4,\"tree\":true,\"gather_missing\":true}");
		helper.succeedWhen(() -> {
			helper.assertTrue(r.isDone(), "still running");
			helper.assertTrue("failed".equals(status(r)), "expected failure, got " + status(r) + " " + result(r));
			helper.assertTrue(error(r).contains("NO_NATURAL_SOURCE") && error(r).contains("oak_log"), "no oak: " + error(r));
			// The recipe pins the kind: no "any kind will do" here, the player decides.
			helper.assertTrue(error(r).contains("Don't take anything else instead") && !error(r).contains("any kind"), "a hard stop: " + error(r));
			for (BlockPos p : birch) {
				helper.assertTrue(helper.getLevel().getBlockState(p).is(Blocks.BIRCH_LOG), "the birch lost a log at " + p.toShortString());
			}
			helper.assertValueEqual(Inv.count(agent, Items.BIRCH_LOG), 0, "no birch taken");
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

	/**
	 * The tree's gathering makes the tool a source needs, as gather does: a furnace from nothing but planks and sticks
	 * mines its cobblestone with a wooden pickaxe crafted on the way (it used to fail NEEDS_TOOL).
	 */
	@GameTest(structure = WIDE_YARD, maxTicks = 2400)
	public void craftTreeMakesTheToolItsGatheringNeeds(final GameTestHelper helper) {
		for (int i = 0; i < 8; i++) {
			helper.setBlock(new BlockPos(22 + i % 4, 1, 18 + i / 4), Blocks.STONE);
		}
		helper.setBlock(new BlockPos(20, 1, 23), Blocks.CRAFTING_TABLE);
		AgentPlayer agent = spawnAgent(helper, "Stoker", AgentRole.BUILDER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 3));
		agent.getInventory().setItem(1, new ItemStack(Items.STICK, 2));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "craft", "{\"item\":\"furnace\",\"count\":1,\"tree\":true,\"gather_missing\":true}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "furnace");
			helper.assertValueEqual(Inv.count(agent, Items.FURNACE), 1, "the furnace");
			helper.assertValueEqual(Inv.count(agent, Items.WOODEN_PICKAXE), 1, "the pickaxe it made to mine the stone");
			helper.assertTrue(result(r).getAsJsonObject("gathered").has("cobblestone"), "gathered cobblestone: " + result(r));
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

	/** Cancelled between two steps (the first ended, the next not begun): the result lists only the step that ran. */
	@GameTest(maxTicks = 20)
	public void sequenceCancelledBetweenStepsListsOnlyWhatRan(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Between", AgentRole.ENGINEER, 3, 0, 3);
		SkillJob seq = SkillFactory.create("sequence", SkillTestSupport.json(
			"{\"steps\":[{\"skill\":\"eat\",\"args\":{}},{\"skill\":\"eat\",\"args\":{}}],\"stop_on_fail\":false}"));
		seq.start(agent);
		// Nothing to eat: step 1 fails on its first tick; step 2 begins on the next one.
		helper.assertTrue(seq.tick(agent) == Job.Status.RUNNING, "still running after step 1");
		seq.cancel(agent);
		seq.onEnd(agent, null, "stop");
		SkillJob.Outcome o = seq.outcome().getNow(null);
		helper.assertTrue(o != null && "cancelled".equals(o.status()), "cancelled: " + o);
		JsonArray steps = o.result().getAsJsonArray("steps");
		helper.assertValueEqual(steps.size(), 1, "only the step that ran: " + steps);
		helper.assertValueEqual(steps.get(0).getAsJsonObject().get("status").getAsString(), "failed", "step 1: " + steps);
		helper.succeed();
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

	/**
	 * collect of a block that drops something else (stone: cobblestone) stops after as many blocks as asked, as mine
	 * does; it used to break every stone in reach until the timeout, for an item that never lands in the bag.
	 */
	@GameTest(structure = WIDE_YARD, maxTicks = 1200)
	public void collectOfABlockThatDropsSomethingElseStopsAtTheCount(final GameTestHelper helper) {
		List<BlockPos> stones = List.of(new BlockPos(22, 1, 20), new BlockPos(23, 1, 20), new BlockPos(22, 1, 21), new BlockPos(23, 1, 21));
		for (BlockPos p : stones) {
			helper.setBlock(p, Blocks.STONE);
		}
		AgentPlayer agent = spawnAgent(helper, "Quarry", AgentRole.MINER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.WOODEN_PICKAXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"stone\",\"count\":2,\"radius\":8}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect stone");
			long left = stones.stream().filter(p -> helper.getBlockState(p).is(Blocks.STONE)).count();
			helper.assertValueEqual((int)left, 2, "stones left of four");
			helper.assertTrue(Inv.count(agent, Items.COBBLESTONE) >= 1, "its drops: " + result(r));
			helper.assertTrue(result(r).get("note").getAsString().contains("broke 2"), "says so: " + result(r));
		});
	}

	/** Wool: no natural wool block exists, so once the blocks come up empty the animal that drops it is next. */
	@GameTest(structure = WIDE_YARD, environment = DAY, maxTicks = 1200)
	public void collectWoolFromASheep(final GameTestHelper helper) {
		var sheep = helper.spawn(EntityTypes.SHEEP, new BlockPos(25, 1, 20));
		sheep.setColor(DyeColor.WHITE);
		AgentPlayer agent = spawnAgent(helper, "Shepherd", AgentRole.FARMER, 20, 1, 20);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"white_wool\",\"count\":1,\"radius\":16}");
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect wool");
			helper.assertTrue(Inv.count(agent, Items.WOOL.pick(DyeColor.WHITE)) >= 1, "wool");
			helper.assertTrue(result(r).getAsJsonArray("sources").toString().contains("sheep"), "from the sheep: " + result(r));
		});
	}

	// ------------------------------------------------------------------ stations and protected zones

	/**
	 * A station is put down outside a protected zone when there is room: the craft tree walks out of the Base first and
	 * must not then put the table back inside, one block over the edge. Inside a zone with no room outside it, the old
	 * behaviour stays (the v1 craft).
	 */
	@GameTest(maxTicks = 20)
	public void stationSpotPrefersOutsideProtectedZones(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		AgentPlayer agent = spawnAgent(helper, "Edge", AgentRole.BUILDER, 3, 0, 3);
		String name = "Spot test " + Integer.toHexString(System.identityHashCode(helper));
		// North of the agent (z < 3, the first direction tried) is the zone.
		Zones.add(level.getServer(), new Zones.Zone(name, level.dimension(),
			BoundingBox.fromCorners(helper.absolutePos(new BlockPos(0, 0, 0)), helper.absolutePos(new BlockPos(6, 3, 2))), "Steve"));
		try {
			BlockPos spot = CraftJobs.freeSpotNear(agent);
			helper.assertTrue(spot != null && Zones.at(level, spot) == null, "outside the zone: " + spot);
			Zones.add(level.getServer(), new Zones.Zone(name, level.dimension(),
				BoundingBox.fromCorners(helper.absolutePos(new BlockPos(0, 0, 0)), helper.absolutePos(new BlockPos(6, 3, 6))), "Steve"));
			BlockPos inside = CraftJobs.freeSpotNear(agent);
			helper.assertTrue(inside != null && Zones.at(level, inside) != null, "no room outside: still a spot: " + inside);
		} finally {
			Zones.remove(level.getServer(), name);
		}
		helper.succeed();
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
