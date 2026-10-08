package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.onTestEnd;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;
import static dev.minevibe.gametest.agent.SkillTestSupport.error;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.recorder;
import static dev.minevibe.gametest.agent.SkillTestSupport.result;
import static dev.minevibe.gametest.agent.SkillTestSupport.service;
import static dev.minevibe.gametest.agent.SkillTestSupport.status;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.job.MineJob;
import dev.minevibe.agent.perception.Sources;
import dev.minevibe.agent.perception.Trees;
import dev.minevibe.agent.skill.ProtectionGuard;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.provenance.ChunkMarks;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Provenance;
import dev.minevibe.world.provenance.Zones;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.ProtoChunk;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import net.minecraft.world.level.chunk.storage.SerializableChunkData;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * W1, world awareness and protection. Reproduces the live incident (the CEO, told to collect oak logs, mined the
 * stripped spruce logs of the player's house because the nearest oak was out of reach) and checks what fixed it:
 * block provenance, protected blocks, natural resource targeting, {@code NO_NATURAL_SOURCE}, the consent flow, the
 * Base and the {@code look_around} scene.
 *
 * <p>Layout of {@link #FOREST} (41x20x41, floor at y 0, ground level y 1): the agent stands at (20, 1, 20); the
 * player's house (stripped spruce log corners, spruce plank walls and roof, all marked as placed by "Steve") fills
 * (22..26, 1..4, 22..26); an oak on an 8-block stone pillar at (14, 9, 20) is the nearest tree but out of reach; a
 * reachable oak stands at (20, 1, 8).
 */
public final class ProtectionGameTests {
	private static final String FOREST = "minevibe-gametest:forest_yard";
	private static final String DAY = "minevibe-gametest:day";
	/** The Base test overrides the world's office: its own batch. */
	private static final String BASE_ENV = "minevibe-gametest:provenance_base";
	private static final BlockPos AGENT = new BlockPos(20, 1, 20);
	private static final BlockPos HOUSE = new BlockPos(22, 1, 22);
	private static final BlockPos PILLAR_TREE = new BlockPos(14, 9, 20);
	private static final BlockPos TREE = new BlockPos(20, 1, 8);

	// ------------------------------------------------------------------ scenery

	/** The player's house: a 5x5 room, 3 high, stripped spruce log corners, spruce plank walls and roof, marked as Steve's. */
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

	/** A natural oak: logs from {@code base} up, natural leaves (persistent=false) around the top two logs and on top. */
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

	/** The tree on a stone pillar: the nearest oak, but nobody can reach it without climbing 8 blocks. */
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

	private static void assertAll(final GameTestHelper helper, final List<BlockPos> logs, final boolean present, final String what) {
		for (BlockPos p : logs) {
			boolean log = helper.getLevel().getBlockState(p).is(Blocks.OAK_LOG);
			helper.assertTrue(log == present, what + (present ? " lost a log at " : " still has a log at ") + p.toShortString());
		}
	}

	private static CompletableFuture<Map<String, Object>> run(final GameTestHelper helper, final AgentPlayer agent, final String skill, final String args) {
		return SkillTestSupport.run(helper, agent, jobId(skill), skill, args, 120_000);
	}

	private static String pos(final BlockPos abs) {
		return "{\"x\":" + abs.getX() + ",\"y\":" + abs.getY() + ",\"z\":" + abs.getZ() + "}";
	}

	private static void assertDone(final GameTestHelper helper, final CompletableFuture<Map<String, Object>> reply, final String what) {
		String s = status(reply);
		if ("failed".equals(s) || "cancelled".equals(s)) {
			helper.fail(what + " " + s + ": " + error(reply) + " " + result(reply));
		}
		helper.assertTrue("done".equals(s), what + " not done yet (" + s + ")");
	}

	private static void assertFailed(final GameTestHelper helper, final CompletableFuture<Map<String, Object>> reply, final String code, final String what) {
		String s = status(reply);
		helper.assertTrue(s != null, what + " still running");
		helper.assertTrue("failed".equals(s) && error(reply).contains(code), what + ": expected " + code + ", got " + s + " " + error(reply) + " " + result(reply));
	}

	private static void assertValid(final GameTestHelper helper, final AgentPlayer agent) {
		List<SkillTestSupport.Sent> bad = recorder(helper).invalid(agent.agentId());
		helper.assertTrue(bad.isEmpty(), "messages failed the protocol schema: " + bad);
	}

	// ------------------------------------------------------------------ the incident

	/**
	 * The incident: "collect 10 oak logs". The nearest logs are the player's house and the nearest oak stands on a
	 * pillar out of reach. The agent fells the reachable oak, whole, and never touches the house or the pillar tree.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 2400)
	public void collectOakLogsFellsTheReachableTreeAndSparesTheHouse(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		List<BlockPos> pillarTree = plantPillarTree(helper);
		List<BlockPos> tree = plantTree(helper, TREE, 6, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"oak_log\",\"count\":6,\"radius\":24}");
		helper.onEachTick(() -> {
			assertIntact(helper, house, "the house");
			assertAll(helper, pillarTree, true, "the pillar tree");
		});
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect oak_log");
			helper.assertTrue(Inv.count(agent, Items.OAK_LOG) >= 6, "oak logs: " + Inv.count(agent, Items.OAK_LOG));
			assertAll(helper, tree, false, "the reachable tree");
			assertIntact(helper, house, "the house");
			assertAll(helper, pillarTree, true, "the pillar tree");
			JsonObject res = result(r);
			helper.assertTrue(res.has("trees") && res.get("trees").getAsInt() >= 1, "felled a tree: " + res);
			helper.assertTrue(ProtectionGuard.lastRefusal(agent.agentId()) == null, "never even tried a protected block: " + ProtectionGuard.lastRefusal(agent.agentId()));
			assertValid(helper, agent);
		});
	}

	/** {@code collect #minecraft:logs}: the tag means tree trunks, never the stripped logs and planks of the house. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 2400)
	public void collectTheLogsTagNeverTouchesTheHouse(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		List<BlockPos> tree = plantTree(helper, TREE, 5, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"#minecraft:logs\",\"count\":4,\"radius\":24}");
		helper.onEachTick(() -> assertIntact(helper, house, "the house"));
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect #minecraft:logs");
			helper.assertTrue(Inv.count(agent, Items.OAK_LOG) >= 4, "oak logs: " + Inv.count(agent, Items.OAK_LOG));
			helper.assertValueEqual(Inv.count(agent, Items.STRIPPED_SPRUCE_LOG), 0, "stripped spruce logs taken");
			assertAll(helper, tree, false, "the tree");
			assertIntact(helper, house, "the house");
		});
	}

	/** No natural tree in range: {@code NO_NATURAL_SOURCE} with what was seen, and the house stays as it is. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 400)
	public void noNaturalTreeInRangeIsNoNaturalSource(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		List<BlockPos> pillarTree = plantPillarTree(helper);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> oak = run(helper, agent, "collect", "{\"item\":\"oak_log\",\"count\":3,\"radius\":16}");
		AtomicReference<CompletableFuture<Map<String, Object>>> tag = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(oak) != null, "collect oak_log still running"))
			.thenExecute(() -> {
				assertFailed(helper, oak, "NO_NATURAL_SOURCE", "collect oak_log with only an unreachable oak");
				JsonObject d = result(oak).getAsJsonObject("noNaturalSource");
				helper.assertTrue(d != null, "result.noNaturalSource: " + result(oak));
				helper.assertValueEqual(Skills.NO_NATURAL_SOURCE.validate(d), List.of(), "noNaturalSource matches the protocol");
				helper.assertTrue(d.toString().contains("unreachable"), "the pillar oak is listed as unreachable: " + d);
				helper.assertTrue(error(oak).contains("Don't take anything else instead"), "teaches not to substitute: " + error(oak));
				tag.set(run(helper, agent, "collect", "{\"item\":\"#minecraft:logs\",\"count\":3,\"radius\":16}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(status(tag.get()) != null, "collect #logs still running"))
			.thenExecute(() -> {
				assertFailed(helper, tag.get(), "NO_NATURAL_SOURCE", "collect #minecraft:logs next to a log house");
				assertIntact(helper, house, "the house");
				assertAll(helper, pillarTree, true, "the pillar tree");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	/** No tree at all, only the log house: {@code NO_NATURAL_SOURCE}, and the house is not offered as a source. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 300)
	public void noTreeAtAllIsNoNaturalSource(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"#minecraft:logs\",\"count\":10,\"radius\":16}");
		helper.succeedWhen(() -> {
			assertFailed(helper, r, "NO_NATURAL_SOURCE", "collect #minecraft:logs with only a log house around");
			helper.assertValueEqual(result(r).get("collected").getAsInt(), 0, "collected");
			JsonArray candidates = result(r).getAsJsonObject("noNaturalSource").getAsJsonArray("candidates");
			for (JsonElement c : candidates) {
				helper.assertTrue(!"not_natural".equals(c.getAsJsonObject().get("why").getAsString()) || !c.toString().contains("stripped"),
					"the house's stripped logs are no candidate: " + candidates);
			}
			assertIntact(helper, house, "the house");
		});
	}

	/**
	 * A tree taller than an agent can reach from the ground: it steps into the cut trunk, pillars up with the
	 * dirt it carries, takes the top log, clears its pillar, picks up the logs and plants a sapling on the stump.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 2400)
	public void aTallTreeIsFelledWholeWithAPillarAndReplanted(final GameTestHelper helper) {
		BlockPos base = new BlockPos(20, 1, 12);
		helper.setBlock(base.below(), Blocks.GRASS_BLOCK);
		// 8 logs: the top one is out of reach from the ground, even jumping, so the agent has to pillar once.
		List<BlockPos> tree = plantTree(helper, base, 8, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		AgentPlayer agent = spawnAgent(helper, "Lumber", AgentRole.MINER, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(1, new ItemStack(Items.DIRT, 4));
		agent.getInventory().setItem(2, new ItemStack(Items.OAK_SAPLING, 1));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"oak_log\",\"count\":8,\"radius\":16,\"replant\":true}");
		BlockPos stump = helper.absolutePos(base);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect a tall oak");
			assertAll(helper, tree, false, "the tall tree");
			helper.assertTrue(Inv.count(agent, Items.OAK_LOG) >= 8, "oak logs: " + Inv.count(agent, Items.OAK_LOG) + " " + result(r));
			for (int y = 0; y < 3; y++) {
				helper.assertFalse(helper.getLevel().getBlockState(stump.above(y)).is(Blocks.DIRT), "the pillar was cleared at " + stump.above(y).toShortString());
			}
			helper.assertTrue(helper.getLevel().getBlockState(stump).is(Blocks.OAK_SAPLING), "a sapling on the stump: " + helper.getLevel().getBlockState(stump) + " " + result(r));
			helper.assertValueEqual(result(r).get("replanted").getAsInt(), 1, "replanted");
			helper.assertTrue(result(r).has("pillared") && result(r).get("pillared").getAsInt() >= 1, "it pillared up to the top log: " + result(r));
		});
	}

	/**
	 * A house log named outright is {@code PROTECTED} with a consent offer and a teaching line; so is digging through a
	 * wall; and even a job that skips the checks cannot break it (the vanilla break is refused).
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void houseBlocksAreProtected(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		BlockPos corner = helper.absolutePos(HOUSE);
		CompletableFuture<Map<String, Object>> log = run(helper, agent, "mine", "{\"block\":\"stripped_spruce_log\",\"count\":1,\"near\":" + pos(corner) + ",\"radius\":6}");
		AtomicReference<CompletableFuture<Map<String, Object>>> planks = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> dig = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(log) != null, "mine still running"))
			.thenExecute(() -> {
				assertFailed(helper, log, "PROTECTED", "mine a house log");
				JsonObject p = result(log).getAsJsonObject("protected");
				helper.assertTrue(p != null, "result.protected: " + result(log));
				helper.assertValueEqual(Skills.PROTECTED_DETAIL.validate(p), List.of(), "protected matches the protocol");
				helper.assertValueEqual(p.get("what").getAsString(), "player-built", "what");
				helper.assertValueEqual(p.get("owner").getAsString(), "Steve", "owner");
				helper.assertTrue(p.get("consentId").getAsString().matches("[0-9a-f]{32}"), "a consent offer");
				helper.assertTrue(error(log).contains("ask Steve before changing it"), "teaches to ask: " + error(log));
				planks.set(run(helper, agent, "mine", "{\"block\":\"spruce_planks\",\"count\":2,\"radius\":10}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(status(planks.get()) != null, "mine planks still running"))
			.thenExecute(() -> {
				assertFailed(helper, planks.get(), "PROTECTED", "mine planks that only the house has");
				dig.set(run(helper, agent, "dig", "{\"from\":" + pos(corner.offset(-1, 0, 0)) + ",\"to\":" + pos(corner.offset(1, 1, 0)) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(status(dig.get()) != null, "dig still running"))
			.thenExecute(() -> {
				assertFailed(helper, dig.get(), "PROTECTED", "dig through the house wall");
				helper.assertTrue(result(dig.get()).get("protectedBlocks").getAsInt() >= 3, "every protected block of the box counted: " + result(dig.get()));
				helper.assertTrue(helper.getLevel().getBlockState(corner.offset(-1, 0, 0)).isAir(), "dig changed nothing (the air stayed air)");
				// The backstop: a raw mining job without any checks.
				agent.jobs().start(new MineJob(corner, false));
			})
			.thenIdle(120)
			.thenExecute(() -> {
				helper.assertTrue(helper.getLevel().getBlockState(corner).is(Blocks.STRIPPED_SPRUCE_LOG), "the raw break was refused");
				Protection.Verdict v = ProtectionGuard.lastRefusal(agent.agentId());
				helper.assertTrue(v != null && v.pos().equals(corner), "the guard refused it: " + v);
				agent.jobs().cancel("test");
				assertIntact(helper, house, "the house");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	/**
	 * Consent: {@code allow_protected} alone does nothing; the token from the PROTECTED offer, passed by Node outside
	 * {@code args}, lets this agent change exactly the offered blocks, once. A forged token is refused.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void consentLetsTheAgentChangeOnlyWhatThePlayerAllowed(final GameTestHelper helper) {
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		BlockPos corner = helper.absolutePos(HOUSE);
		String args = "{\"block\":\"stripped_spruce_log\",\"count\":1,\"near\":" + pos(corner) + ",\"radius\":2,\"allow_protected\":true}";
		CompletableFuture<Map<String, Object>> selfAuthorized = run(helper, agent, "mine", args);
		AtomicReference<CompletableFuture<Map<String, Object>>> allowed = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(selfAuthorized) != null, "mine still running"))
			.thenExecute(() -> {
				assertFailed(helper, selfAuthorized, "PROTECTED", "allow_protected without consent");
				helper.assertTrue(error(selfAuthorized).contains("only works once Steve has agreed"), "explains consent: " + error(selfAuthorized));
				String token = result(selfAuthorized).getAsJsonObject("protected").get("consentId").getAsString();
				expectForgedTokenRefused(helper, agent, args, "00000000000000000000000000000000");
				// Node passes the player's consent outside args.
				allowed.set(service(helper).run(new Skills.SkillRun(jobId("consented"), agent.agentId(), "mine", SkillTestSupport.json(args), 120_000, true,
					new Skills.Consent(token))));
			})
			.thenWaitUntil(() -> assertDone(helper, allowed.get(), "mine with consent"))
			.thenExecute(() -> {
				helper.assertTrue(helper.getLevel().getBlockState(corner).isAir(), "the allowed log is gone");
				Map<BlockPos, BlockState> rest = new LinkedHashMap<>(house);
				rest.remove(corner);
				assertIntact(helper, rest, "the rest of the house");
				helper.assertTrue(!dev.minevibe.world.provenance.Consents.covers(agent.agentId(), helper.getLevel().dimension(), corner.above()),
					"the grant ended with its job");
			})
			.thenSucceed();
	}

	private static void expectForgedTokenRefused(final GameTestHelper helper, final AgentPlayer agent, final String args, final String token) {
		try {
			service(helper).run(new Skills.SkillRun(jobId("forged"), agent.agentId(), "mine", SkillTestSupport.json(args), 0, true, new Skills.Consent(token)));
		} catch (BridgeException e) {
			helper.assertValueEqual(e.code(), "BAD_ARGS", "a forged consent token: " + e.getMessage());
			return;
		}
		helper.fail("a forged consent token was accepted");
	}

	// ------------------------------------------------------------------ the Base and the scene

	/**
	 * The starter office is the Base: its blocks are marked and protected, look_around says "Inside Base" and lists the
	 * reachable tree outside, the footer says "in Base", and a block the agent placed itself stays the agent's to mine.
	 */
	@GameTest(structure = FOREST, environment = BASE_ENV, maxTicks = 900)
	public void theOfficeIsTheProtectedBase(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(2, 1, 2));
		OfficeLayout layout = OfficeBuilder.build(level, origin, null);
		OfficeService.overrideLayout(level.getServer(), layout);
		onTestEnd(helper, () -> OfficeService.overrideLayout(level.getServer(), null));
		plantTree(helper, new BlockPos(32, 1, 24), 5, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		BlockPos spawn = layout.spawn();
		// Not helper.relativePos: in 26.3 it turns an unrotated test's positions by 180 degrees.
		BlockPos spawnRel = spawn.subtract(helper.absolutePos(BlockPos.ZERO));
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, spawnRel.getX(), spawnRel.getY(), spawnRel.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(1, new ItemStack(Items.COBBLESTONE, 4));
		agent.getInventory().setItem(2, new ItemStack(Items.STONE_PICKAXE));
		BlockPos corner = origin.offset(0, 1, 0);
		helper.assertTrue(level.getBlockState(corner).is(Blocks.STRIPPED_SPRUCE_LOG), "the office corner is a stripped spruce log");
		Owner owner = Provenance.ownerAt(level, corner);
		helper.assertTrue(owner != null && owner.isBase(), "office blocks are the Base's own: " + owner);
		Zones.Zone zone = Zones.at(level, spawn);
		helper.assertTrue(zone != null && Zones.BASE.equals(zone.name()), "the spawn cell is in the Base zone: " + zone);
		helper.assertTrue(Zones.at(level, origin.offset(-2, 0, -2)) != null && Zones.at(level, origin.offset(-3, 0, -3)) == null, "two blocks of margin");

		JsonObject brief = (JsonObject)service(helper).obs(new Skills.ObsQuery(agent.agentId(), "look_around", new JsonObject())).get("result");
		String scene = brief.get("scene").getAsString();
		helper.assertTrue(scene.contains("Inside Base"), "look_around says where the agent is: " + scene + "\n(agent at " + agent.position()
			+ ", spawn " + spawn.toShortString() + ", rel " + spawnRel.toShortString() + ", origin " + helper.absolutePos(BlockPos.ZERO).toShortString() + ")");
		helper.assertTrue(scene.length() <= 900, "brief scene within 900 characters: " + scene.length());
		helper.assertTrue(scene.contains("under cover"), "the office has a roof: " + scene);
		helper.assertTrue(brief.get("footer").getAsString().contains("in Base"), "the footer names the zone: " + brief.get("footer"));
		JsonObject check = brief.deepCopy();
		check.remove("footer");
		helper.assertValueEqual(Skills.LOOK_AROUND.validate(check), List.of(), "look_around matches the protocol");
		helper.assertTrue(brief.getAsJsonObject("zone").get("inside").getAsBoolean(), "zone.inside");
		boolean reachableOak = false;
		for (JsonElement e : brief.getAsJsonArray("trees")) {
			JsonObject t = e.getAsJsonObject();
			reachableOak |= "oak".equals(t.get("species").getAsString()) && "reachable".equals(t.get("reachable").getAsString());
		}
		helper.assertTrue(reachableOak, "lists the oak outside as reachable: " + brief.getAsJsonArray("trees") + "\n" + scene);
		helper.assertTrue(scene.contains("Trees (natural): oak"), "the scene names the tree: " + scene);
		JsonObject full = (JsonObject)service(helper).obs(new Skills.ObsQuery(agent.agentId(), "look_around", SkillTestSupport.json("{\"detail\":\"full\"}"))).get("result");
		helper.assertTrue(full.get("scene").getAsString().length() <= 2500, "full scene within 2500 characters");
		System.out.println("[W1] look_around brief (" + scene.length() + " chars):\n" + scene);
		System.out.println("[W1] look_around full (" + full.get("scene").getAsString().length() + " chars):\n" + full.get("scene").getAsString());
		JsonObject status = (JsonObject)service(helper).obs(new Skills.ObsQuery(agent.agentId(), "status", new JsonObject())).get("result");
		helper.assertValueEqual(status.get("zone").getAsString(), "in Base", "status.zone");
		JsonObject find = (JsonObject)service(helper).obs(new Skills.ObsQuery(agent.agentId(), "find", SkillTestSupport.json("{\"what\":\"#minecraft:logs\",\"radius\":40,\"limit\":3}"))).get("result");
		helper.assertTrue(find.toString().contains("\"provenance\":\"base\"") && find.has("protectedNote"), "find labels the office's logs as the Base's: " + find);
		JsonObject natural = (JsonObject)service(helper).obs(new Skills.ObsQuery(agent.agentId(), "find",
			SkillTestSupport.json("{\"what\":\"#minecraft:logs\",\"radius\":40,\"filter\":\"natural\"}"))).get("result");
		JsonArray naturalMatches = natural.getAsJsonArray("matches");
		helper.assertTrue(!naturalMatches.isEmpty(), "filter natural finds the tree: " + natural);
		for (JsonElement m : naturalMatches) {
			helper.assertValueEqual(m.getAsJsonObject().get("provenance").getAsString(), "natural", "filter natural: " + natural);
			helper.assertTrue(m.getAsJsonObject().has("tree"), "a natural log names its tree: " + m);
		}

		CompletableFuture<Map<String, Object>> mine = run(helper, agent, "mine", "{\"block\":\"stripped_spruce_log\",\"count\":1,\"near\":" + pos(corner) + ",\"radius\":4}");
		BlockPos placeAt = spawn.offset(1, 0, 0);
		AtomicReference<CompletableFuture<Map<String, Object>>> place = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> mineOwn = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> ring = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(mine) != null, "mine still running"))
			.thenExecute(() -> {
				assertFailed(helper, mine, "PROTECTED", "mine an office log");
				helper.assertValueEqual(result(mine).getAsJsonObject("protected").get("what").getAsString(), "base", "what");
				helper.assertTrue(level.getBlockState(placeAt).isAir(), "room to place at " + placeAt.toShortString());
				place.set(run(helper, agent, "place", "{\"block\":\"cobblestone\",\"pos\":" + pos(placeAt) + "}"));
			})
			.thenWaitUntil(() -> assertDone(helper, place.get(), "place cobblestone in the Base"))
			.thenExecute(() -> {
				Owner placed = Provenance.ownerAt(level, placeAt);
				helper.assertTrue(placed != null && placed.isAgent() && placed.id().equals(agent.agentId()), "the agent's own block: " + placed);
				mineOwn.set(run(helper, agent, "mine", "{\"block\":\"cobblestone\",\"count\":1,\"near\":" + pos(placeAt) + ",\"radius\":3}"));
			})
			.thenWaitUntil(() -> assertDone(helper, mineOwn.get(), "mine its own cobblestone"))
			.thenExecute(() -> {
				helper.assertTrue(level.getBlockState(placeAt).isAir(), "its own block is gone");
				helper.assertTrue(Provenance.ownerAt(level, placeAt) == null, "and its mark with it");
				helper.assertTrue(level.getBlockState(corner).is(Blocks.STRIPPED_SPRUCE_LOG), "the office is intact");
				// A blueprint inside the Base fills its rooms and doorways even where it only meets air.
				ring.set(run(helper, agent, "build", "{\"blueprint\":\"wall_ring\",\"origin\":" + pos(spawn) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ring.get() != null && status(ring.get()) != null, "build still running"))
			.thenExecute(() -> {
				assertFailed(helper, ring.get(), "PROTECTED", "a wall ring inside the Base");
				helper.assertValueEqual(result(ring.get()).getAsJsonObject("protected").get("what").getAsString(), "base", "what");
				helper.assertTrue(error(ring.get()).contains("Building there changes part of"), "says why: " + error(ring.get()));
				helper.assertValueEqual(Inv.count(agent, Items.COBBLESTONE), 4, "no block placed");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ review fixes: ways round the protection

	/** A null-safe "the job behind {@code ref} has ended" (a failed step before it leaves {@code ref} unset). */
	private static boolean ended(final AtomicReference<CompletableFuture<Map<String, Object>>> ref) {
		return ref.get() != null && status(ref.get()) != null;
	}

	private static Owner steve() {
		return Owner.player(UUID.nameUUIDFromBytes("steve".getBytes(java.nio.charset.StandardCharsets.UTF_8)), "Steve");
	}

	/** Sets {@code state} at the absolute position {@code abs} and records it as Steve's. */
	private static void steves(final GameTestHelper helper, final BlockPos abs, final BlockState state) {
		helper.getLevel().setBlockAndUpdate(abs, state);
		Provenance.mark(helper.getLevel(), abs, steve());
	}

	/**
	 * A log cabin from before provenance (nothing marked) with a real oak growing against its corner, and natural
	 * leaves brushing its wall. The trunk joins the cabin's logs into one cluster that touches natural leaves: that
	 * used to count as a tree and the agent would have felled the cabin. A cluster that touches planks or glass is a
	 * building, so there is no tree to fell and the cabin stands.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void anUnmarkedLogCabinIsNeverATree(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		Map<BlockPos, BlockState> cabin = new LinkedHashMap<>();
		BlockPos corner = new BlockPos(8, 1, 8);
		for (int x = 0; x <= 4; x++) {
			for (int z = 0; z <= 4; z++) {
				for (int y = 0; y <= 2; y++) {
					boolean edgeX = x == 0 || x == 4;
					boolean edgeZ = z == 0 || z == 4;
					BlockState state;
					if (edgeX && edgeZ) {
						state = Blocks.OAK_LOG.defaultBlockState();
					} else if (z == 0 && x == 2 && y == 1) {
						state = Blocks.GLASS_PANE.defaultBlockState();
					} else if (edgeX || edgeZ) {
						state = Blocks.OAK_PLANKS.defaultBlockState();
					} else {
						continue;
					}
					helper.setBlock(corner.offset(x, y, z), state);
					cabin.put(helper.absolutePos(corner.offset(x, y, z)), helper.getLevel().getBlockState(helper.absolutePos(corner.offset(x, y, z))));
				}
			}
		}
		BlockState leaf = Blocks.OAK_LEAVES.defaultBlockState().setValue(LeavesBlock.DISTANCE, 1).setValue(LeavesBlock.PERSISTENT, false);
		helper.setBlock(corner.offset(0, 1, -1), leaf);
		// A natural oak diagonally against the far corner: its trunk joins the cabin's corner logs.
		List<BlockPos> oak = plantTree(helper, corner.offset(5, 0, 5), 5, Blocks.OAK_LOG, Blocks.OAK_LEAVES);
		BlockPos cornerLog = helper.absolutePos(corner);
		helper.assertTrue(Trees.treeAt(level, cornerLog) == null, "the cabin is no tree");
		Trees.Cluster joined = Trees.clusterAt(level, oak.getFirst());
		helper.assertTrue(joined.tree() == null && "building".equals(joined.notTree()), "the oak against the cabin joins it: " + joined.notTree());
		helper.assertTrue(joined.logs().contains(helper.absolutePos(corner.offset(4, 0, 4))), "one cluster with the cabin's corner");
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"oak_log\",\"count\":3,\"radius\":20}");
		// Blocks, not states: the window pane connects to its walls a tick later.
		Runnable standing = () -> cabin.forEach((p, st) -> helper.assertTrue(level.getBlockState(p).is(st.getBlock()), "the cabin changed at " + p.toShortString()));
		helper.onEachTick(standing);
		helper.succeedWhen(() -> {
			assertFailed(helper, r, "NO_NATURAL_SOURCE", "collect oak_log with only a log cabin around");
			standing.run();
			assertAll(helper, oak, true, "the oak grown into the cabin");
			helper.assertValueEqual(Inv.count(agent, Items.OAK_LOG), 0, "oak logs taken");
			assertValid(helper, agent);
		});
	}

	/**
	 * Steve's torch on a natural dirt block and his ladder on a natural stone block: the dirt and the stone are natural,
	 * but breaking them would pop Steve's blocks off, so mining and digging leave them alone.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void naturalBlocksHoldingUpThePlayersBlocksAreLeftAlone(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos dirt = helper.absolutePos(new BlockPos(16, 1, 20));
		level.setBlockAndUpdate(dirt, Blocks.DIRT.defaultBlockState());
		steves(helper, dirt.above(), Blocks.TORCH.defaultBlockState());
		BlockPos stone = helper.absolutePos(new BlockPos(16, 1, 16));
		BlockPos ladderAt = helper.absolutePos(new BlockPos(17, 1, 16));
		level.setBlockAndUpdate(stone, Blocks.STONE.defaultBlockState());
		Direction away = Direction.getNearest(ladderAt.getX() - stone.getX(), 0, ladderAt.getZ() - stone.getZ(), Direction.NORTH);
		steves(helper, ladderAt, Blocks.LADDER.defaultBlockState().setValue(LadderBlock.FACING, away));
		helper.assertTrue(level.getBlockState(ladderAt).is(Blocks.LADDER), "the ladder hangs on the stone");
		Protection.Verdict v = Protection.check(level, dirt, null);
		helper.assertTrue(v != null && v.hint().contains("holds up part of Steve's build (torch at"), "the dirt holds up Steve's torch: " + (v == null ? null : v.hint()));
		helper.assertTrue(Provenance.ownerAt(level, dirt) == null, "the dirt itself stays natural");
		// The natural floor under Steve's roof (a plank three blocks up) and the ground under his wall are his too.
		BlockPos floor = helper.absolutePos(new BlockPos(12, 1, 20));
		level.setBlockAndUpdate(floor, Blocks.DIRT.defaultBlockState());
		steves(helper, floor.above(4), Blocks.OAK_PLANKS.defaultBlockState());
		Protection.Verdict roof = Protection.check(level, floor, null);
		helper.assertTrue(roof != null && roof.hint().contains("inside part of Steve's build, under its roof (oak_planks at"), "the floor under the roof: " + (roof == null ? null : roof.hint()));
		BlockPos footing = helper.absolutePos(new BlockPos(12, 1, 24));
		level.setBlockAndUpdate(footing, Blocks.DIRT.defaultBlockState());
		steves(helper, footing.above(), Blocks.COBBLESTONE.defaultBlockState());
		Protection.Verdict wall = Protection.check(level, footing, null);
		helper.assertTrue(wall != null && wall.hint().contains("holds up part of Steve's build (cobblestone at"), "the ground under the wall: " + (wall == null ? null : wall.hint()));
		BlockPos open = helper.absolutePos(new BlockPos(12, 1, 16));
		level.setBlockAndUpdate(open, Blocks.DIRT.defaultBlockState());
		helper.assertTrue(Protection.check(level, open, null) == null, "dirt under the open sky stays free");
		AgentPlayer agent = spawnAgent(helper, "Digger", AgentRole.MINER, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SHOVEL));
		agent.getInventory().setItem(1, new ItemStack(Items.IRON_PICKAXE));
		CompletableFuture<Map<String, Object>> mine = run(helper, agent, "mine", "{\"block\":\"dirt\",\"count\":2,\"radius\":10}");
		AtomicReference<CompletableFuture<Map<String, Object>>> dig = new AtomicReference<>();
		helper.onEachTick(() -> {
			helper.assertTrue(level.getBlockState(dirt.above()).is(Blocks.TORCH), "Steve's torch fell");
			helper.assertTrue(level.getBlockState(ladderAt).is(Blocks.LADDER), "Steve's ladder fell");
		});
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(mine) != null, "mine still running"))
			.thenExecute(() -> {
				// Only the open dirt was free: one of two, then nothing natural left.
				String s = status(mine);
				helper.assertTrue("failed".equals(s) && (error(mine).contains("PROTECTED") || error(mine).contains("NO_NATURAL_SOURCE")),
					"mine found one free dirt of two: " + s + " " + error(mine) + " " + result(mine));
				helper.assertValueEqual(result(mine).get("mined").getAsInt(), 1, "mined the open dirt");
				helper.assertTrue(level.getBlockState(open).isAir(), "the open dirt was taken");
				helper.assertTrue(level.getBlockState(dirt).is(Blocks.DIRT), "the dirt under the torch is still there");
				helper.assertTrue(level.getBlockState(floor).is(Blocks.DIRT), "the floor under the roof is still there");
				helper.assertTrue(level.getBlockState(footing).is(Blocks.DIRT), "the ground under the wall is still there");
				dig.set(run(helper, agent, "dig", "{\"from\":" + pos(stone) + ",\"to\":" + pos(stone) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ended(dig), "dig still running"))
			.thenExecute(() -> {
				assertFailed(helper, dig.get(), "PROTECTED", "dig out the stone behind the ladder");
				helper.assertTrue(error(dig.get()).contains("holds up part of Steve's build (ladder at"), "says why: " + error(dig.get()));
				helper.assertTrue(level.getBlockState(stone).is(Blocks.STONE), "the stone is still there");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	/**
	 * Fire and lava next to Steve's house: flint and steel on the ground two blocks from it, a lava bucket poured beside
	 * it. Neither touches a protected block itself, but both would burn the house down: refused, by the job and by the
	 * backstop under it.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void fireAndLavaAreRefusedNearThePlayersBuild(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		Map<BlockPos, BlockState> house = buildHouse(helper, HOUSE);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.FLINT_AND_STEEL));
		agent.getInventory().setItem(1, new ItemStack(Items.LAVA_BUCKET));
		BlockPos ground = helper.absolutePos(new BlockPos(20, 0, 21));
		BlockPos pourAt = helper.absolutePos(new BlockPos(21, 0, 19));
		CompletableFuture<Map<String, Object>> flint = run(helper, agent, "use_item", "{\"item\":\"flint_and_steel\",\"pos\":" + pos(ground) + "}");
		AtomicReference<CompletableFuture<Map<String, Object>>> lava = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> tnt = new AtomicReference<>();
		helper.onEachTick(() -> {
			helper.assertFalse(level.getBlockState(ground.above()).is(Blocks.FIRE), "fire was lit next to the house");
			helper.assertTrue(level.getBlockState(pourAt.above()).getFluidState().isEmpty(), "lava was poured next to the house");
		});
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(flint) != null, "use_item still running"))
			.thenExecute(() -> {
				assertFailed(helper, flint, "PROTECTED", "flint and steel next to the house");
				helper.assertTrue(error(flint).contains("Fire or lava there could reach part of Steve's build"), "says why: " + error(flint));
				lava.set(run(helper, agent, "use_item", "{\"item\":\"lava_bucket\",\"pos\":" + pos(pourAt) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ended(lava), "use_item still running"))
			.thenExecute(() -> {
				assertFailed(helper, lava.get(), "PROTECTED", "a lava bucket next to the house");
				helper.assertValueEqual(Inv.count(agent, Items.LAVA_BUCKET), 1, "the lava is still in the bucket");
				agent.getInventory().setItem(2, new ItemStack(Items.TNT));
				tnt.set(run(helper, agent, "place", "{\"block\":\"tnt\",\"pos\":" + pos(ground.above()) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ended(tnt), "place still running"))
			.thenExecute(() -> {
				assertFailed(helper, tnt.get(), "PROTECTED", "TNT next to the house");
				helper.assertTrue(error(tnt.get()).contains("An explosion there could reach part of Steve's build"), "says why: " + error(tnt.get()));
				helper.assertFalse(level.getBlockState(ground.above()).is(Blocks.TNT), "no TNT placed");
				// The backstop: a right-click with flint and steel that no job checked.
				ProtectionGuard.takeRefusal(agent.agentId());
				agent.setItemInHand(InteractionHand.MAIN_HAND, new ItemStack(Items.FLINT_AND_STEEL));
				agent.controls().useBlock(ground, Direction.UP);
				helper.assertTrue(ProtectionGuard.lastRefusal(agent.agentId()) != null, "the guard refused the raw use");
				assertIntact(helper, house, "the house");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	/**
	 * Steve's chest, opened with a plain right-click ({@code use_block}) rather than {@code open_menu}: shift-clicking
	 * his diamonds out is still refused. His flower pot keeps its poppy.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 600)
	public void thePlayersChestAndFlowerPotStayTheirs(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos chestAt = helper.absolutePos(new BlockPos(17, 1, 20));
		steves(helper, chestAt, Blocks.CHEST.defaultBlockState());
		ChestBlockEntity chest = (ChestBlockEntity)level.getBlockEntity(chestAt);
		chest.setItem(0, new ItemStack(Items.DIAMOND, 3));
		BlockPos potAt = helper.absolutePos(new BlockPos(17, 1, 23));
		steves(helper, potAt, Blocks.POTTED_POPPY.defaultBlockState());
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		CompletableFuture<Map<String, Object>> open = run(helper, agent, "use_block", "{\"pos\":" + pos(chestAt) + "}");
		AtomicReference<CompletableFuture<Map<String, Object>>> click = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> pot = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, open, "use_block on the chest"))
			.thenExecute(() -> {
				helper.assertTrue(agent.containerMenu != agent.inventoryMenu, "the chest is open: " + result(open));
				click.set(run(helper, agent, "menu_click", "{\"slot\":0,\"button\":0,\"type\":\"quick_move\"}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ended(click), "menu_click still running"))
			.thenExecute(() -> {
				assertFailed(helper, click.get(), "PROTECTED", "shift-click Steve's diamonds");
				helper.assertValueEqual(chest.countItem(Items.DIAMOND), 3, "diamonds in Steve's chest");
				helper.assertValueEqual(Inv.count(agent, Items.DIAMOND), 0, "diamonds taken");
				agent.closeContainer();
				pot.set(run(helper, agent, "use_block", "{\"pos\":" + pos(potAt) + "}"));
			})
			.thenWaitUntil(() -> helper.assertTrue(ended(pot), "use_block still running"))
			.thenExecute(() -> {
				assertFailed(helper, pot.get(), "PROTECTED", "take the poppy from Steve's pot");
				helper.assertTrue(level.getBlockState(potAt).is(Blocks.POTTED_POPPY), "the poppy is still potted");
				helper.assertValueEqual(Inv.count(agent, Items.POPPY), 0, "poppy taken");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	/** Bessie, a named cow, is nobody's dinner: attacking her is refused, and hunting cows takes the other one. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 1200)
	public void namedAnimalsAreNeverHunted(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Hunter", AgentRole.GUARD, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
		var bessie = helper.spawn(EntityTypes.COW, new BlockPos(18, 1, 20));
		bessie.setCustomName(Component.literal("Bessie"));
		bessie.setNoAi(true);
		var other = helper.spawn(EntityTypes.COW, new BlockPos(14, 1, 20));
		other.setNoAi(true);
		// Pets and the player's golems count too.
		var wolf = helper.spawn(EntityTypes.WOLF, new BlockPos(10, 1, 10));
		wolf.setNoAi(true);
		wolf.tame(spawnHumanStandIn(helper, 8, 1, 8));
		var golem = helper.spawn(EntityTypes.IRON_GOLEM, new BlockPos(30, 1, 30));
		golem.setNoAi(true);
		helper.assertFalse(Protection.isPetOrNamed(golem), "a village's golem is nobody's");
		golem.setPlayerCreated(true);
		helper.assertTrue(Protection.isPetOrNamed(wolf) && Protection.isPetOrNamed(golem) && Protection.isPetOrNamed(bessie), "pets, named animals, built golems");
		helper.assertFalse(Protection.isPetOrNamed(other), "a plain cow is livestock");
		CompletableFuture<Map<String, Object>> attack = run(helper, agent, "attack", "{\"entity\":\"" + bessie.getStringUUID() + "\"}");
		AtomicReference<CompletableFuture<Map<String, Object>>> hunt = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(status(attack) != null, "attack still running"))
			.thenExecute(() -> {
				assertFailed(helper, attack, "BAD_TARGET", "attack a named cow");
				hunt.set(run(helper, agent, "hunt", "{\"entity\":\"minecraft:cow\",\"count\":1,\"radius\":16}"));
			})
			.thenWaitUntil(() -> {
				helper.assertTrue(hunt.get() != null, "hunt not started");
				assertDone(helper, hunt.get(), "hunt a cow");
			})
			.thenExecute(() -> {
				helper.assertTrue(bessie.isAlive(), "Bessie lives");
				helper.assertFalse(other.isAlive(), "the other cow was hunted");
			})
			.thenSucceed();
	}

	/** Planks, stripped logs and wood are crafted: {@code collect oak_planks} never takes them out of a wall. */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 300)
	public void collectingPlanksNeverTakesThemFromAWall(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		List<BlockPos> wall = new ArrayList<>();
		for (int y = 1; y <= 3; y++) {
			BlockPos p = helper.absolutePos(new BlockPos(16, y, 20));
			level.setBlockAndUpdate(p, Blocks.OAK_PLANKS.defaultBlockState());
			wall.add(p);
		}
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, AGENT.getX(), AGENT.getY(), AGENT.getZ());
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "collect", "{\"item\":\"oak_planks\",\"count\":2,\"radius\":16}");
		helper.succeedWhen(() -> {
			assertFailed(helper, r, "NO_NATURAL_SOURCE", "collect oak_planks next to an unmarked plank wall");
			helper.assertTrue(error(r).contains("craft"), "points at crafting: " + error(r));
			for (BlockPos p : wall) {
				helper.assertTrue(level.getBlockState(p).is(Blocks.OAK_PLANKS), "the wall lost a plank at " + p.toShortString());
			}
		});
	}

	/**
	 * A farm plot whose field holds Steve's dirt: the nested farm refuses it, and the build reports that refusal
	 * instead of a success.
	 */
	@GameTest(structure = FOREST, environment = DAY, maxTicks = 1200)
	public void aFarmPlotOnThePlayersSoilFailsTheBuild(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		// The field one block up, on the smooth stone floor (the water goes on top of the floor).
		BlockPos centre = new BlockPos(12, 1, 12);
		for (int x = -4; x <= 4; x++) {
			for (int z = -4; z <= 4; z++) {
				helper.setBlock(centre.offset(x, 0, z), Blocks.DIRT);
			}
		}
		BlockPos stevesDirt = helper.absolutePos(centre.offset(3, 0, 3));
		Provenance.mark(level, stevesDirt, steve());
		AgentPlayer agent = spawnAgent(helper, "Farmer", AgentRole.FARMER, 12, 2, 9);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_HOE));
		agent.getInventory().setItem(1, new ItemStack(Items.WATER_BUCKET));
		agent.getInventory().setItem(2, new ItemStack(Items.WHEAT_SEEDS, 16));
		agent.getInventory().setItem(3, new ItemStack(Items.IRON_SHOVEL));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, "build", "{\"blueprint\":\"farm_plot\",\"origin\":" + pos(helper.absolutePos(centre.above())) + "}");
		helper.succeedWhen(() -> {
			assertFailed(helper, r, "PROTECTED", "a farm plot over Steve's dirt");
			helper.assertTrue(level.getBlockState(stevesDirt).is(Blocks.DIRT), "Steve's dirt is untilled");
			helper.assertTrue(result(r).has("protected"), "the farm's refusal is in the result: " + result(r));
			assertValid(helper, agent);
		});
	}

	// ------------------------------------------------------------------ provenance itself

	/**
	 * Placements are recorded by who placed them (a player, both halves of a door, an agent; never crops), a broken
	 * block loses its mark, and the marks are saved with the chunk and read back by Fabric's chunk loading.
	 */
	@GameTest(structure = FOREST, maxTicks = 200)
	public void provenanceRecordsPlacementsAndSurvivesASave(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = spawnHumanStandIn(helper, 10, 1, 10);
		BlockPos stoneAt = helper.absolutePos(new BlockPos(12, 1, 10));
		helper.assertTrue(use(player, stoneAt.below(), new ItemStack(Items.COBBLESTONE)).consumesAction(), "the player placed cobblestone");
		Owner o = Provenance.ownerAt(level, stoneAt);
		helper.assertTrue(o != null && o.isPlayer() && o.name().equals(player.getGameProfile().name()), "the player's block: " + o);

		BlockPos doorAt = helper.absolutePos(new BlockPos(14, 1, 10));
		use(player, doorAt.below(), new ItemStack(Items.OAK_DOOR));
		helper.assertTrue(level.getBlockState(doorAt).is(Blocks.OAK_DOOR) && level.getBlockState(doorAt.above()).getValue(DoorBlock.HALF) == DoubleBlockHalf.UPPER, "a door");
		helper.assertTrue(Provenance.ownerAt(level, doorAt) != null && Provenance.ownerAt(level, doorAt.above()) != null, "both halves of the door are marked");

		BlockPos field = helper.absolutePos(new BlockPos(16, 0, 10));
		helper.setBlock(new BlockPos(16, 0, 10), Blocks.FARMLAND);
		use(player, field, new ItemStack(Items.WHEAT_SEEDS));
		helper.assertTrue(level.getBlockState(field.above()).is(Blocks.WHEAT), "wheat planted");
		helper.assertTrue(Provenance.ownerAt(level, field.above()) == null, "crops are never marked");

		BlockPos natural = helper.absolutePos(new BlockPos(18, 1, 10));
		helper.setBlock(new BlockPos(18, 1, 10), Blocks.DIRT);
		helper.assertTrue(Provenance.ownerAt(level, natural) == null, "blocks nobody placed are natural");

		// Saved with the chunk and read back through Fabric's chunk loading.
		LevelChunk chunk = level.getChunkAt(stoneAt);
		CompoundTag saved = SerializableChunkData.copyOf(level, chunk).write();
		SerializableChunkData data = SerializableChunkData.parse(level, level.palettedContainerFactory(), saved);
		helper.assertTrue(data != null, "the chunk serialized");
		ProtoChunk loaded = data.read(level, level.getChunkSource().getPoiManager(), new RegionStorageInfo("gametest", level.dimension(), "chunk"), chunk.getPos());
		ChunkMarks marks = loaded.getAttached(Provenance.MARKS);
		helper.assertTrue(marks != null && o.equals(marks.get(stoneAt)), "the mark survived a save and load: " + (marks == null ? null : marks.get(stoneAt)));

		level.destroyBlock(stoneAt, false);
		helper.assertTrue(Provenance.ownerAt(level, stoneAt) == null, "a broken block loses its mark");
		helper.succeed();
	}

	private static InteractionResult use(final ServerPlayer player, final BlockPos onTopOf, final ItemStack stack) {
		player.setItemInHand(InteractionHand.MAIN_HAND, stack);
		BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(onTopOf).add(0.0, 0.5, 0.0), Direction.UP, onTopOf, false);
		return player.gameMode.useItemOn(player, player.level(), stack, InteractionHand.MAIN_HAND, hit);
	}

	/** Tag expansion and tool effects (both need the server's tags). */
	@GameTest(maxTicks = 20)
	public void naturalTargetingAndToolEffectsUseTheTags(final GameTestHelper helper) {
		Predicate<BlockState> logs = Sources.naturalTag(Refs.block("#minecraft:logs"));
		helper.assertTrue(logs.test(Blocks.OAK_LOG.defaultBlockState()) && logs.test(Blocks.CRIMSON_STEM.defaultBlockState()), "trunks are logs");
		helper.assertFalse(logs.test(Blocks.STRIPPED_SPRUCE_LOG.defaultBlockState()), "stripped logs are building material");
		helper.assertFalse(logs.test(Blocks.OAK_WOOD.defaultBlockState()), "wood is building material");
		helper.assertTrue(Sources.treeMode(logs), "#logs works on trees");
		helper.assertTrue(Sources.treeMode(Refs.block("oak_log")), "oak_log works on trees");
		helper.assertFalse(Sources.treeMode(Refs.block("stripped_spruce_log")), "a named stripped log is a plain block request");
		helper.assertTrue(Sources.acceptsNothing(Sources.naturalTag(Refs.block("#minecraft:planks"))), "planks never grow");
		helper.assertTrue(Trees.isNaturalLogBlock(Blocks.BIRCH_LOG.defaultBlockState()), "birch log");
		ItemStack axe = new ItemStack(Items.IRON_AXE);
		helper.assertTrue(Protection.changesBlocks(axe), "an axe changes blocks");
		helper.assertTrue(Protection.checkUse(helper.getLevel(), helper.absolutePos(BlockPos.ZERO), Direction.UP, new ItemStack(Items.BREAD), null) == null, "bread changes nothing");
		helper.succeed();
	}
}
