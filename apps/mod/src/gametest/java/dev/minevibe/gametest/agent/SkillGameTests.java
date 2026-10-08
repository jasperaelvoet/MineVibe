package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;
import static dev.minevibe.gametest.agent.SkillTestSupport.error;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.recorder;
import static dev.minevibe.gametest.agent.SkillTestSupport.rel;
import static dev.minevibe.gametest.agent.SkillTestSupport.result;
import static dev.minevibe.gametest.agent.SkillTestSupport.run;
import static dev.minevibe.gametest.agent.SkillTestSupport.service;
import static dev.minevibe.gametest.agent.SkillTestSupport.status;

import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.brain.IdleMode;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.agent.skill.seat.SimplePcRegistry;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.SeatEntity;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.animal.chicken.Chicken;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.zombie.Zombie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.FarmlandBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * GameTests for the agent skill API (PLAN 7.3, 7.4): the jobs behind {@code skill.run}, the reply / {@code skill.result}
 * semantics, observations, seats, and the care and approach reflexes. Every bridge message the skill layer produces
 * goes to a recorder that also checks it against the protocol schema.
 */
public final class SkillGameTests {
	private static final String ARENA = "minevibe-gametest:arena";
	private static final String NIGHT = "minevibe-gametest:night";
	private static final String DAY = "minevibe-gametest:day";

	private static int count(final AgentPlayer agent, final net.minecraft.world.item.Item item) {
		return Inv.count(agent, item);
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

	// ------------------------------------------------------------------ crafting

	@GameTest(maxTicks = 300)
	public void skillCraftPlanksAndTable(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Crafter", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_LOG, 2));
		CompletableFuture<Map<String, Object>> planks = run(helper, agent, jobId("planks"), "craft", "{\"item\":\"oak_planks\",\"count\":8}", 60_000);
		AtomicReference<CompletableFuture<Map<String, Object>>> table = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, planks, "craft planks"))
			.thenExecute(() -> {
				helper.assertValueEqual(count(agent, Items.OAK_PLANKS), 8, "planks");
				helper.assertValueEqual(count(agent, Items.OAK_LOG), 0, "logs used up");
				helper.assertValueEqual(result(planks).get("crafted").getAsInt(), 8, "crafted");
				helper.assertTrue(result(planks).has("footer"), "results end with the status footer");
				table.set(run(helper, agent, jobId("table"), "craft", "{\"item\":\"crafting_table\",\"count\":1}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, table.get(), "craft table"))
			.thenExecute(() -> {
				helper.assertValueEqual(count(agent, Items.CRAFTING_TABLE), 1, "crafting table");
				helper.assertValueEqual(count(agent, Items.OAK_PLANKS), 4, "planks left");
				helper.assertTrue(agent.inventoryMenu.getCraftSlots().isEmpty(), "the 2x2 grid is empty again");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 400)
	public void skillCraftPlacesATableFor3x3(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Smith", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 3));
		agent.getInventory().setItem(1, new ItemStack(Items.STICK, 2));
		agent.getInventory().setItem(2, new ItemStack(Items.CRAFTING_TABLE, 1));
		CompletableFuture<Map<String, Object>> pick = run(helper, agent, jobId("pick"), "craft", "{\"item\":\"wooden_pickaxe\",\"count\":1}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, pick, "craft pickaxe");
			helper.assertValueEqual(count(agent, Items.WOODEN_PICKAXE), 1, "pickaxe");
			JsonObject r = result(pick);
			helper.assertTrue(r.has("placedTable"), "a table was placed: " + r);
			JsonObject t = r.getAsJsonObject("placedTable");
			BlockPos tablePos = new BlockPos(t.get("x").getAsInt(), t.get("y").getAsInt(), t.get("z").getAsInt());
			helper.assertTrue(helper.getLevel().getBlockState(tablePos).is(Blocks.CRAFTING_TABLE), "the table stands at " + tablePos);
			helper.assertFalse(agent.containerMenu != agent.inventoryMenu, "the crafting menu is closed");
		});
	}

	@GameTest(maxTicks = 100)
	public void skillCraftReportsMissingIngredients(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Poor", AgentRole.ENGINEER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_PLANKS, 1));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("sticks"), "craft", "{\"item\":\"stick\",\"count\":4}", 60_000);
		helper.succeedWhen(() -> {
			helper.assertTrue("failed".equals(status(r)), "expected failure, got " + status(r));
			helper.assertTrue(error(r).contains("MISSING_INGREDIENTS"), "error " + error(r));
			helper.assertValueEqual(count(agent, Items.OAK_PLANKS), 1, "planks untouched");
		});
	}

	// ------------------------------------------------------------------ smelting, containers

	@GameTest(maxTicks = 1500)
	public void skillSmeltRawIron(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(6, 0, 3), Blocks.FURNACE);
		AgentPlayer agent = spawnAgent(helper, "Smelter", AgentRole.MINER, 2, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.RAW_IRON, 2));
		agent.getInventory().setItem(1, new ItemStack(Items.COAL, 1));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("smelt"), "smelt", "{\"item\":\"raw_iron\",\"count\":2}", 120_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "smelt");
			helper.assertValueEqual(count(agent, Items.IRON_INGOT), 2, "iron ingots");
			helper.assertValueEqual(count(agent, Items.RAW_IRON), 0, "raw iron used");
			helper.assertValueEqual(result(r).get("smelted").getAsInt(), 2, "smelted");
		});
	}

	@GameTest(maxTicks = 300)
	public void skillContainerPutAndTake(final GameTestHelper helper) {
		BlockPos chestRel = new BlockPos(5, 0, 3);
		helper.setBlock(chestRel, Blocks.CHEST);
		AgentPlayer agent = spawnAgent(helper, "Porter", AgentRole.BUILDER, 2, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.COBBLESTONE, 10));
		String pos = rel(helper, 5, 0, 3);
		CompletableFuture<Map<String, Object>> put = run(helper, agent, jobId("put"), "container", "{\"pos\":" + pos + ",\"action\":\"put\",\"item\":\"cobblestone\",\"count\":6}", 60_000);
		AtomicReference<CompletableFuture<Map<String, Object>>> take = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, put, "put"))
			.thenExecute(() -> {
				ChestBlockEntity chest = helper.getBlockEntity(chestRel, ChestBlockEntity.class);
				helper.assertValueEqual(chest.countItem(Items.COBBLESTONE), 6, "chest cobblestone");
				helper.assertValueEqual(count(agent, Items.COBBLESTONE), 4, "agent cobblestone");
				helper.assertValueEqual(result(put).get("moved").getAsInt(), 6, "moved");
				take.set(run(helper, agent, jobId("take"), "container", "{\"pos\":" + pos + ",\"action\":\"take\",\"item\":\"cobblestone\",\"count\":3}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, take.get(), "take"))
			.thenExecute(() -> {
				ChestBlockEntity chest = helper.getBlockEntity(chestRel, ChestBlockEntity.class);
				helper.assertValueEqual(chest.countItem(Items.COBBLESTONE), 3, "chest after take");
				helper.assertValueEqual(count(agent, Items.COBBLESTONE), 7, "agent after take");
				helper.assertTrue(result(take.get()).getAsJsonObject("contents").toString().contains("cobblestone"), "contents listed");
				helper.assertFalse(agent.containerMenu != agent.inventoryMenu, "chest closed again");
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 200)
	public void skillGenericMenuClicks(final GameTestHelper helper) {
		BlockPos chestRel = new BlockPos(4, 0, 3);
		helper.setBlock(chestRel, Blocks.CHEST);
		ChestBlockEntity chest = helper.getBlockEntity(chestRel, ChestBlockEntity.class);
		chest.setItem(0, new ItemStack(Items.APPLE, 5));
		AgentPlayer agent = spawnAgent(helper, "Clicker", AgentRole.ENGINEER, 2, 0, 3);
		CompletableFuture<Map<String, Object>> open = run(helper, agent, jobId("open"), "open_menu", "{\"pos\":" + rel(helper, 4, 0, 3) + "}", 60_000);
		AtomicReference<CompletableFuture<Map<String, Object>>> click = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> close = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, open, "open_menu"))
			.thenExecute(() -> {
				helper.assertTrue(result(open).get("type").getAsString().contains("generic_9x3"), "chest menu: " + result(open));
				JsonObject state = service(helper).obs(new Skills.ObsQuery(agent.agentId(), "menu_state", new JsonObject())).get("result") instanceof JsonObject o ? o : null;
				helper.assertTrue(state != null && state.toString().contains("minecraft:apple"), "menu_state shows the apples");
				click.set(run(helper, agent, jobId("click"), "menu_click", "{\"slot\":0,\"button\":0,\"type\":\"quick_move\"}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, click.get(), "menu_click"))
			.thenExecute(() -> {
				helper.assertValueEqual(count(agent, Items.APPLE), 5, "apples shift-clicked into the inventory");
				close.set(run(helper, agent, jobId("close"), "menu_close", "{}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, close.get(), "menu_close"))
			.thenExecute(() -> helper.assertFalse(agent.containerMenu != agent.inventoryMenu, "menu closed"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ gathering

	@GameTest(structure = ARENA, maxTicks = 1200)
	public void skillCollectLogs(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(10, 1, 9), Blocks.OAK_LOG);
		helper.setBlock(new BlockPos(10, 2, 9), Blocks.OAK_LOG);
		helper.setBlock(new BlockPos(5, 1, 12), Blocks.OAK_LOG);
		AgentPlayer agent = spawnAgent(helper, "Lumber", AgentRole.MINER, 3, 1, 3);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("logs"), "collect", "{\"item\":\"oak_log\",\"count\":3,\"radius\":16}", 120_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "collect");
			helper.assertTrue(count(agent, Items.OAK_LOG) >= 3, "logs: " + count(agent, Items.OAK_LOG));
			helper.assertValueEqual(result(r).get("collected").getAsInt(), 3, "collected");
			assertValid(helper, agent);
		});
	}

	@GameTest(maxTicks = 600)
	public void skillMineAndDig(final GameTestHelper helper) {
		for (int x = 4; x <= 5; x++) {
			for (int z = 4; z <= 5; z++) {
				helper.setBlock(new BlockPos(x, 0, z), Blocks.DIRT);
			}
		}
		AgentPlayer agent = spawnAgent(helper, "Digger", AgentRole.MINER, 1, 0, 1);
		CompletableFuture<Map<String, Object>> dig = run(helper, agent, jobId("dig"), "dig", "{\"from\":" + rel(helper, 4, 0, 4) + ",\"to\":" + rel(helper, 5, 0, 5) + "}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, dig, "dig");
			for (int x = 4; x <= 5; x++) {
				for (int z = 4; z <= 5; z++) {
					helper.assertTrue(helper.getBlockState(new BlockPos(x, 0, z)).isAir(), "dug " + x + "," + z);
				}
			}
			helper.assertValueEqual(result(dig).get("dug").getAsInt(), 4, "dug");
			helper.assertTrue(count(agent, Items.DIRT) >= 3, "dirt picked up: " + count(agent, Items.DIRT));
		});
	}

	@GameTest(maxTicks = 800)
	public void skillHuntChicken(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Hunter", AgentRole.GUARD, 2, 0, 2);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
		Chicken chicken = helper.spawn(EntityTypes.CHICKEN, new BlockPos(5, 0, 5));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("hunt"), "hunt", "{\"entity\":\"minecraft:chicken\",\"count\":1,\"radius\":16}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "hunt");
			helper.assertFalse(chicken.isAlive(), "chicken still alive");
			helper.assertValueEqual(result(r).get("killed").getAsInt(), 1, "killed");
			helper.assertTrue(recorder(helper).events(agent.agentId(), "killed").size() >= 1, "agent.event killed");
		});
	}

	@GameTest(maxTicks = 300)
	public void skillPickupItems(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Picker", AgentRole.FARMER, 1, 0, 1);
		ServerLevel level = helper.getLevel();
		ItemEntity e = new ItemEntity(level, helper.absoluteVec(new Vec3(5.5, 0.2, 5.5)).x, helper.absoluteVec(new Vec3(5.5, 0.2, 5.5)).y,
			helper.absoluteVec(new Vec3(5.5, 0.2, 5.5)).z, new ItemStack(Items.WHEAT_SEEDS, 4));
		level.addFreshEntity(e);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("pickup"), "pickup", "{\"item\":\"wheat_seeds\",\"radius\":8}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "pickup");
			helper.assertValueEqual(count(agent, Items.WHEAT_SEEDS), 4, "seeds");
		});
	}

	// ------------------------------------------------------------------ world actions

	@GameTest(maxTicks = 200)
	public void skillPlaceBlock(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Mason", AgentRole.BUILDER, 1, 0, 1);
		agent.getInventory().setItem(5, new ItemStack(Items.COBBLESTONE, 3));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("place"), "place", "{\"block\":\"cobblestone\",\"pos\":" + rel(helper, 4, 0, 4) + "}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "place");
			helper.assertTrue(helper.getBlockState(new BlockPos(4, 0, 4)).is(Blocks.COBBLESTONE), "cobblestone placed");
			helper.assertValueEqual(count(agent, Items.COBBLESTONE), 2, "one used");
		});
	}

	@GameTest(maxTicks = 200)
	public void skillEatEquipEmote(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Diner", AgentRole.FARMER, 3, 0, 3);
		agent.getFoodData().setFoodLevel(16);
		agent.getInventory().setItem(0, new ItemStack(Items.BREAD, 2));
		agent.getInventory().setItem(10, new ItemStack(Items.IRON_HELMET));
		CompletableFuture<Map<String, Object>> eat = run(helper, agent, jobId("eat"), "eat", "{}", 60_000);
		AtomicReference<CompletableFuture<Map<String, Object>>> equip = new AtomicReference<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> emote = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, eat, "eat"))
			.thenExecute(() -> {
				helper.assertTrue(agent.getFoodData().getFoodLevel() > 16, "food " + agent.getFoodData().getFoodLevel());
				helper.assertValueEqual(count(agent, Items.BREAD), 1, "one bread eaten");
				helper.assertValueEqual(result(eat).get("ate").getAsString(), "minecraft:bread", "ate");
				equip.set(run(helper, agent, jobId("equip"), "equip", "{\"item\":\"iron_helmet\",\"slot\":\"head\"}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, equip.get(), "equip"))
			.thenExecute(() -> {
				helper.assertTrue(agent.getItemBySlot(EquipmentSlot.HEAD).is(Items.IRON_HELMET), "helmet worn");
				emote.set(run(helper, agent, jobId("emote"), "emote", "{\"kind\":\"wave\"}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, emote.get(), "emote"))
			.thenExecute(() -> helper.assertTrue(recorder(helper).events(agent.agentId(), "ate").size() >= 1, "agent.event ate"))
			.thenSucceed();
	}

	@GameTest(maxTicks = 300)
	public void skillGiveToAnotherAgent(final GameTestHelper helper) {
		AgentPlayer giver = spawnAgent(helper, "Giver", AgentRole.FARMER, 1, 0, 1);
		AgentPlayer taker = spawnAgent(helper, "Taker", AgentRole.MINER, 6, 0, 6);
		giver.getInventory().setItem(0, new ItemStack(Items.BREAD, 3));
		CompletableFuture<Map<String, Object>> r = run(helper, giver, jobId("give"), "give", "{\"item\":\"bread\",\"count\":2,\"to\":\"" + taker.agentId() + "\"}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "give");
			helper.assertValueEqual(count(taker, Items.BREAD), 2, "taker's bread");
			helper.assertValueEqual(count(giver, Items.BREAD), 1, "giver's bread");
			helper.assertTrue(result(r).get("received").getAsBoolean(), "received");
		});
	}

	@GameTest(structure = ARENA, maxTicks = 800)
	public void skillFarmTillsAndPlants(final GameTestHelper helper) {
		// The field is the arena floor itself, so walking over it never jumps (and never tramples farmland).
		for (int x = 6; x <= 8; x++) {
			for (int z = 6; z <= 8; z++) {
				helper.setBlock(new BlockPos(x, 0, z), Blocks.DIRT);
			}
		}
		helper.setBlock(new BlockPos(9, 0, 7), Blocks.WATER);
		AgentPlayer agent = spawnAgent(helper, "Farmer", AgentRole.FARMER, 3, 1, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.WOODEN_HOE));
		agent.getInventory().setItem(1, new ItemStack(Items.WHEAT_SEEDS, 9));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("farm"), "farm", "{\"from\":" + rel(helper, 6, 0, 6) + ",\"to\":" + rel(helper, 8, 0, 8) + "}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "farm");
			int planted = 0;
			for (int x = 6; x <= 8; x++) {
				for (int z = 6; z <= 8; z++) {
					helper.assertTrue(helper.getBlockState(new BlockPos(x, 0, z)).getBlock() instanceof FarmlandBlock, "farmland at " + x + "," + z);
					if (helper.getBlockState(new BlockPos(x, 1, z)).getBlock() instanceof CropBlock) {
						planted++;
					}
				}
			}
			helper.assertValueEqual(planted, 9, "planted");
			helper.assertValueEqual(result(r).get("tilled").getAsInt(), 9, "tilled");
		});
	}

	@GameTest(structure = ARENA, maxTicks = 1200)
	public void skillBuildTorchRing(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Builder", AgentRole.BUILDER, 8, 1, 8);
		agent.getInventory().setItem(0, new ItemStack(Items.TORCH, 8));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("build"), "build", "{\"blueprint\":\"torch_ring\",\"origin\":" + rel(helper, 8, 1, 8) + "}", 120_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "build");
			helper.assertValueEqual(result(r).get("placed").getAsInt(), 8, "torches placed");
			helper.assertValueEqual(count(agent, Items.TORCH), 0, "torches used");
			helper.assertTrue(helper.getBlockState(new BlockPos(13, 1, 8)).is(Blocks.TORCH), "torch east");
		});
	}

	@GameTest(maxTicks = 100)
	public void skillBuildChecksMaterial(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Planner", AgentRole.BUILDER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.DIRT, 10));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("hut"), "build", "{\"blueprint\":\"shelter\",\"origin\":" + rel(helper, 3, 0, 3) + "}", 60_000);
		helper.succeedWhen(() -> {
			helper.assertTrue("failed".equals(status(r)), "expected failure, got " + status(r));
			helper.assertTrue(error(r).contains("NO_MATERIAL"), "error " + error(r));
			helper.assertValueEqual(count(agent, Items.DIRT), 10, "nothing used");
		});
	}

	// ------------------------------------------------------------------ sleep (night environment)

	@GameTest(environment = NIGHT, maxTicks = 600)
	public void sleepSkipsNightWithAgentsExcluded(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		placeBed(helper, new BlockPos(2, 0, 2));
		placeBed(helper, new BlockPos(6, 0, 2));
		AgentPlayer sleeper = spawnAgent(helper, "Sleeper", AgentRole.ENGINEER, 2, 0, 5);
		AgentPlayer awake = spawnAgent(helper, "Awake", AgentRole.GUARD, 4, 0, 6);
		ServerPlayer human = spawnHumanStandIn(helper, 6, 0, 4);
		CompletableFuture<Map<String, Object>> r = run(helper, sleeper, jobId("sleep"), "sleep", "{\"pos\":" + rel(helper, 2, 0, 2) + "}", 60_000);
		AtomicBoolean agentSlept = new AtomicBoolean();
		AtomicBoolean awakeSlept = new AtomicBoolean();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(sleeper.isSleeping(), "agent not asleep yet: " + status(r) + " " + AgentEvents.recent(sleeper.agentId())))
			.thenExecute(() -> {
				agentSlept.set(true);
				// The night is not skipped while only the agent sleeps: agents never count.
				helper.assertTrue(level.isDarkOutside(), "still night");
				BlockPos bed = helper.absolutePos(new BlockPos(6, 0, 2));
				human.gameMode.useItemOn(human, level, ItemStack.EMPTY, InteractionHand.MAIN_HAND,
					new BlockHitResult(Vec3.atCenterOf(bed).add(0.0, 0.5, 0.0), Direction.UP, bed, false));
				helper.assertTrue(human.isSleeping(), "the human lies down");
			})
			.thenExecuteFor(140, () -> {
				// A stand-in player has no connection to tick it; do what the connection would.
				if (human.isSleeping()) {
					human.doTick();
				}
				awakeSlept.compareAndSet(false, awake.isSleeping());
			})
			.thenWaitUntil(() -> {
				helper.assertFalse(level.isDarkOutside(), "the night was skipped");
				assertDone(helper, r, "sleep");
			})
			.thenExecute(() -> {
				helper.assertTrue(agentSlept.get() && !awakeSlept.get(), "only the sleeper slept");
				helper.assertFalse(sleeper.isSleeping(), "agent woke up");
				helper.assertTrue(result(r).get("slept").getAsBoolean(), "slept");
			})
			.thenSucceed();
	}

	private static void placeBed(final GameTestHelper helper, final BlockPos foot) {
		BlockState footState = Blocks.BED.red().defaultBlockState().setValue(BedBlock.FACING, Direction.NORTH).setValue(BedBlock.PART, BedPart.FOOT);
		BlockState headState = footState.setValue(BedBlock.PART, BedPart.HEAD);
		helper.setBlock(foot.north(), headState);
		helper.setBlock(foot, footState);
	}

	// ------------------------------------------------------------------ care reflexes

	@GameTest(maxTicks = 400)
	public void reflexFeedsThePlayer(final GameTestHelper helper) {
		ServerPlayer human = spawnHumanStandIn(helper, 1, 0, 1);
		human.getFoodData().setFoodLevel(8);
		AgentPlayer agent = spawnAgent(helper, "Feeder", AgentRole.FARMER, 6, 0, 6);
		agent.getInventory().setItem(0, new ItemStack(Items.BREAD, 3));
		agent.brain().setFollowTarget(human.getUUID());
		helper.startSequence()
			.thenExecuteFor(200, human::doTick)
			.thenExecute(() -> {
				int got = 0;
				for (int i = 0; i < human.getInventory().getContainerSize(); i++) {
					if (human.getInventory().getItem(i).is(Items.BREAD)) {
						got += human.getInventory().getItem(i).getCount();
					}
				}
				helper.assertTrue(got >= 1, "the player received bread");
				helper.assertTrue(count(agent, Items.BREAD) <= 2, "the agent gave bread away");
				helper.assertTrue(recorder(helper).events(agent.agentId(), "fed_player").size() >= 1, "agent.event fed_player");
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 400)
	public void reflexSharesFoodWithATeammate(final GameTestHelper helper) {
		AgentPlayer hungry = spawnAgent(helper, "Hungry", AgentRole.MINER, 1, 0, 1);
		hungry.getFoodData().setFoodLevel(4);
		hungry.getFoodData().setSaturation(0.0F);
		AgentPlayer sharer = spawnAgent(helper, "Sharer", AgentRole.FARMER, 6, 0, 6);
		sharer.getInventory().setItem(0, new ItemStack(Items.BREAD, 4));
		helper.succeedWhen(() -> {
			helper.assertTrue(hungry.getFoodData().getFoodLevel() > 4, "the hungry agent ate (food " + hungry.getFoodData().getFoodLevel() + ")");
			helper.assertTrue(recorder(helper).events(sharer.agentId(), "shared_food").size() >= 1, "agent.event shared_food");
			helper.assertTrue(count(sharer, Items.BREAD) <= 3, "bread shared");
		});
	}

	@GameTest(environment = DAY, structure = ARENA, maxTicks = 600)
	public void reflexApproachesThePlayer(final GameTestHelper helper) {
		ServerPlayer human = spawnHumanStandIn(helper, 2, 1, 2);
		AgentPlayer agent = spawnAgent(helper, "Presenter", AgentRole.CEO, 13, 1, 13);
		agent.brain().setFollowTarget(human.getUUID());
		agent.brain().setMode(IdleMode.STAY, null);
		service(helper).approach(new Ui.AgentApproach(agent.agentId(), "card-1", "present"));
		helper.startSequence()
			.thenWaitUntil(() -> {
				helper.assertTrue(agent.distanceTo(human) <= 3.5, "distance " + agent.distanceTo(human));
				helper.assertTrue(recorder(helper).events(agent.agentId(), "arrived").size() >= 1, "agent.event arrived");
			})
			.thenExecute(() -> {
				helper.assertTrue("approach".equals(agent.brain().activeName()), "approach holds the agent: " + agent.brain().activeName());
				service(helper).approach(new Ui.AgentApproach(agent.agentId(), null, "release"));
			})
			.thenIdle(5)
			.thenExecute(() -> helper.assertFalse("approach".equals(agent.brain().activeName()), "released"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ preemption

	@GameTest(structure = ARENA, maxTicks = 1500)
	public void jobPreemptedByZombieThenResumes(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Walker", AgentRole.GUARD, 2, 1, 2);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("walk"), "goto", "{\"pos\":" + rel(helper, 13, 1, 13) + "}", 0);
		AtomicReference<Zombie> zombie = new AtomicReference<>();
		AtomicBoolean preempted = new AtomicBoolean();
		helper.startSequence()
			.thenExecute(() -> helper.assertTrue("running".equals(status(r)), "waitMs 0 answers running at once: " + status(r)))
			.thenIdle(8)
			.thenExecute(() -> {
				// The walk is under way: a zombie steps in.
				helper.assertTrue(agent.jobs().hasJob(), "walking");
				Zombie z = EntityTypes.ZOMBIE.create(helper.getLevel(), net.minecraft.world.entity.EntitySpawnReason.MOB_SUMMONED);
				Vec3 ahead = agent.position().add(agent.getLookAngle().multiply(2.0, 0.0, 2.0));
				z.snapTo(ahead.x, agent.getY(), ahead.z, 0.0F, 0.0F);
				z.setBaby(false);
				z.setItemSlot(EquipmentSlot.HEAD, new ItemStack(Items.LEATHER_HELMET));
				helper.getLevel().addFreshEntity(z);
				z.setTarget(agent);
				zombie.set(z);
			})
			.thenExecuteFor(300, () -> {
				if (agent.jobs().isPreempted()) {
					preempted.set(true);
				}
			})
			.thenWaitUntil(() -> {
				helper.assertFalse(zombie.get().isAlive(), "zombie alive");
				List<Skills.SkillResult> done = recorder(helper).results(String.valueOf(r.join().get("jobId")));
				helper.assertTrue(!done.isEmpty(), "skill.result not sent yet");
				helper.assertValueEqual(done.getFirst().status(), "done", "goto status " + done.getFirst().error());
			})
			.thenExecute(() -> {
				helper.assertTrue(preempted.get(), "the goto was preempted by the fight");
				helper.assertTrue(agent.position().distanceTo(helper.absoluteVec(new Vec3(13.5, 1, 13.5))) < 2.5, "arrived after the fight");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ bridge semantics

	@GameTest(maxTicks = 200)
	public void skillRunRepliesAndErrors(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Replier", AgentRole.ENGINEER, 1, 0, 1);
		SkillService service = service(helper);
		String walk = jobId("walk");
		CompletableFuture<Map<String, Object>> r = service.run(new Skills.SkillRun(walk, agent.agentId(), "goto", SkillTestSupport.json("{\"pos\":" + rel(helper, 6, 0, 6) + "}"), 0, false));
		helper.assertTrue("running".equals(status(r)), "running at once");
		// BUSY without replace, UNKNOWN_SKILL, BAD_ARGS, UNKNOWN_AGENT.
		expectError(helper, "BUSY", () -> service.run(new Skills.SkillRun(jobId("x"), agent.agentId(), "emote", SkillTestSupport.json("{\"kind\":\"wave\"}"), 0, false)));
		expectError(helper, "UNKNOWN_SKILL", () -> service.run(new Skills.SkillRun(jobId("x"), agent.agentId(), "fly", new JsonObject(), 0, true)));
		expectError(helper, "BAD_ARGS", () -> service.run(new Skills.SkillRun(jobId("x"), agent.agentId(), "craft", SkillTestSupport.json("{\"count\":1}"), 0, true)));
		expectError(helper, "BAD_ARGS", () -> service.run(new Skills.SkillRun(jobId("x"), agent.agentId(), "mine", SkillTestSupport.json("{\"block\":\"no_such_block\",\"count\":1}"), 0, true)));
		expectError(helper, "UNKNOWN_AGENT", () -> service.run(new Skills.SkillRun(jobId("x"), "nobody_here", "emote", SkillTestSupport.json("{\"kind\":\"wave\"}"), 0, true)));
		helper.startSequence()
			.thenWaitUntil(() -> {
				List<Skills.SkillResult> results = recorder(helper).results(walk);
				helper.assertValueEqual(results.size(), 1, "one skill.result");
				helper.assertValueEqual(results.getFirst().status(), "done", "status");
				helper.assertTrue(results.getFirst().result().has("footer"), "footer");
			})
			.thenExecute(() -> {
				// A job that ends within waitMs is answered directly, without skill.result.
				String wave = jobId("wave");
				CompletableFuture<Map<String, Object>> w = service.run(new Skills.SkillRun(wave, agent.agentId(), "emote", SkillTestSupport.json("{\"kind\":\"nod\"}"), 30_000, false));
				helper.assertTrue(status(w) == null, "still waiting");
				helper.runAfterDelay(60, () -> {
					helper.assertTrue("done".equals(status(w)), "answered done: " + status(w));
					helper.assertTrue(recorder(helper).results(wave).isEmpty(), "no skill.result for a job answered in time");
					// Cancel: a running job ends as cancelled.
					String far = jobId("far");
					service.run(new Skills.SkillRun(far, agent.agentId(), "goto", SkillTestSupport.json("{\"pos\":" + rel(helper, 1, 0, 7) + "}"), 0, false));
					Map<String, Object> c = service.cancel(new Skills.SkillCancel(agent.agentId(), null, "player said stop"));
					helper.assertTrue(String.valueOf(c.get("cancelled")).contains(far), "cancelled " + c);
					List<Skills.SkillResult> cr = recorder(helper).results(far);
					helper.assertTrue(cr.size() == 1 && "cancelled".equals(cr.getFirst().status()), "cancel reported: " + cr);
					helper.succeed();
				});
			});
	}

	private static void expectError(final GameTestHelper helper, final String code, final Runnable call) {
		try {
			call.run();
		} catch (BridgeException e) {
			helper.assertValueEqual(e.code(), code, "error code (" + e.getMessage() + ")");
			return;
		}
		helper.fail("expected " + code);
	}

	@GameTest(maxTicks = 100)
	public void bodyStateAndObservations(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Observer", AgentRole.ENGINEER, 2, 0, 2);
		agent.getInventory().setItem(0, new ItemStack(Items.OAK_LOG, 2));
		helper.setBlock(new BlockPos(5, 0, 5), Blocks.OAK_LOG);
		SkillService service = service(helper);
		helper.startSequence()
			.thenIdle(45)
			.thenExecute(() -> {
				List<Bodies.AgentState> states = recorder(helper).of(Bodies.AGENT_STATE, s -> s.agents().stream().anyMatch(b -> b.agentId().equals(agent.agentId())));
				helper.assertTrue(!states.isEmpty(), "agent.state with the agent");
				Bodies.AgentBody body = states.getLast().agents().stream().filter(b -> b.agentId().equals(agent.agentId())).findFirst().orElseThrow();
				helper.assertValueEqual(body.mode(), "follow", "mode");
				helper.assertValueEqual(body.food(), 20, "food");
				for (String q : List.of("status", "look_around", "inventory", "crew", "list_pcs", "job_status", "recent_events", "menu_state")) {
					JsonObject r = (JsonObject)service.obs(new Skills.ObsQuery(agent.agentId(), q, new JsonObject())).get("result");
					helper.assertTrue(r.has("footer"), q + " has a footer");
				}
				JsonObject find = (JsonObject)service.obs(new Skills.ObsQuery(agent.agentId(), "find", SkillTestSupport.json("{\"what\":\"oak_log\",\"radius\":8}"))).get("result");
				helper.assertTrue(find.getAsJsonArray("matches").size() >= 1, "find oak_log: " + find);
				JsonObject recipe = (JsonObject)service.obs(new Skills.ObsQuery(agent.agentId(), "recipe", SkillTestSupport.json("{\"item\":\"oak_planks\"}"))).get("result");
				helper.assertTrue(recipe.toString().contains("oak_log") && recipe.toString().contains("canCraftNow"), "recipe: " + recipe);
				JsonObject inv = (JsonObject)service.obs(new Skills.ObsQuery(agent.agentId(), "inventory", new JsonObject())).get("result");
				helper.assertTrue(inv.toString().contains("minecraft:oak_log"), "inventory: " + inv);
				expectError(helper, "BAD_ARGS", () -> service.obs(new Skills.ObsQuery(agent.agentId(), "find", new JsonObject())));
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ seats

	@GameTest(maxTicks = 500)
	public void seatAtPcReserveSitUnseat(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		SimplePcRegistry pcs = (SimplePcRegistry)Seats.pcs();
		String pcId = "pc-" + Long.toString(ThreadLocalRandom.current().nextLong(1_000_000), 36);
		BlockPos chairRel = new BlockPos(5, 0, 5);
		helper.setBlock(chairRel, MvWorldContent.OFFICE_CHAIR.defaultBlockState());
		pcs.register(pcId, level.dimension(), helper.absolutePos(chairRel));
		pcs.setStatus(pcId, "running");
		AgentPlayer agent = spawnAgent(helper, "Coder", AgentRole.ENGINEER, 1, 0, 1);
		AgentPlayer other = spawnAgent(helper, "Rival", AgentRole.ENGINEER, 1, 0, 6);
		AgentTestSupport.onTestEnd(helper, () -> pcs.unregister(pcId));
		SkillService service = service(helper);
		String job = jobId("sit");
		expectError(helper, "PC_UNKNOWN", () -> service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(agent.agentId(), jobId("x"), 1,
			dev.minevibe.bridge.msg.Seats.SeatTarget.pc("no-such-pc"), null)));
		Map<String, Object> reply = service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(agent.agentId(), job, 7, dev.minevibe.bridge.msg.Seats.SeatTarget.pc(pcId), "fix the tests"));
		helper.assertValueEqual(reply.get("status"), "running", "agent.seat answers running");
		helper.assertTrue(pcs.reservation(pcId) != null && "coming".equals(pcs.reservation(pcId).kind()), "reserved: coming");
		expectError(helper, "RESERVED", () -> service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(other.agentId(), jobId("x"), 1,
			dev.minevibe.bridge.msg.Seats.SeatTarget.pc(pcId), null)));
		helper.startSequence()
			.thenWaitUntil(() -> {
				List<Skills.SkillResult> r = recorder(helper).results(job);
				helper.assertTrue(!r.isEmpty(), "skill.result for the seat job");
				helper.assertValueEqual(r.getFirst().status(), "done", "seated: " + r.getFirst().error());
			})
			.thenExecute(() -> {
				helper.assertTrue(agent.getVehicle() instanceof SeatEntity, "agent rides the chair");
				helper.assertTrue(service.seated(agent.agentId()) != null, "seat tracked");
				var seats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_SEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(seats.size() == 1 && Long.valueOf(7).equals(seats.getFirst().seatEpoch()), "pc.seat with the epoch: " + seats);
				helper.assertTrue(pcs.reservation(pcId) == null, "the reservation became the occupant");
				// Stale epoch: ignored.
				service.unseat(new dev.minevibe.bridge.msg.Seats.AgentUnseat(agent.agentId(), 3, "stand", false));
				helper.assertTrue(agent.isPassenger(), "a stale unseat is ignored");
				service.unseat(new dev.minevibe.bridge.msg.Seats.AgentUnseat(agent.agentId(), 7, "away", true));
				helper.assertFalse(agent.isPassenger(), "stood up");
				var unseats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(unseats.size() == 1 && "away".equals(unseats.getFirst().reason()) && unseats.getFirst().reserved(), "pc.unseat away: " + unseats);
				PcRegistry.Reservation res = pcs.reservation(pcId);
				helper.assertTrue(res != null && "away".equals(res.kind()) && agent.agentId().equals(res.agentId()), "chair kept: " + res);
				expectError(helper, "RESERVED", () -> service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(other.agentId(), jobId("x"), 1,
					dev.minevibe.bridge.msg.Seats.SeatTarget.pc(pcId), null)));
				pcs.setStatus(pcId, "off");
				expectError(helper, "PC_DOWN", () -> service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(agent.agentId(), jobId("x"), 8,
					dev.minevibe.bridge.msg.Seats.SeatTarget.pc(pcId), null)));
				service.unseat(new dev.minevibe.bridge.msg.Seats.AgentUnseat(agent.agentId(), 7, "reservation_expired", false));
				helper.assertTrue(pcs.reservation(pcId) == null, "reservation released");
				assertValid(helper, agent);
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 600)
	public void seatedAgentUnseatsToFight(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		SimplePcRegistry pcs = (SimplePcRegistry)Seats.pcs();
		String pcId = "pc-" + Long.toString(ThreadLocalRandom.current().nextLong(1_000_000), 36);
		BlockPos chairRel = new BlockPos(3, 0, 3);
		helper.setBlock(chairRel, MvWorldContent.OFFICE_CHAIR.defaultBlockState());
		pcs.register(pcId, level.dimension(), helper.absolutePos(chairRel));
		AgentTestSupport.onTestEnd(helper, () -> pcs.unregister(pcId));
		AgentPlayer agent = spawnAgent(helper, "Seated", AgentRole.ENGINEER, 3, 0, 1);
		agent.getInventory().setItem(0, new ItemStack(Items.DIAMOND_SWORD));
		agent.setItemSlot(EquipmentSlot.CHEST, new ItemStack(Items.IRON_CHESTPLATE));
		agent.setItemSlot(EquipmentSlot.HEAD, new ItemStack(Items.IRON_HELMET));
		SkillService service = service(helper);
		String job = jobId("sit");
		service.seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(agent.agentId(), job, 1, dev.minevibe.bridge.msg.Seats.SeatTarget.pc(pcId), null));
		AtomicReference<Zombie> zombie = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(service.seated(agent.agentId()) != null, "seated"))
			.thenExecute(() -> {
				agent.setHealth(9.0F);
				Zombie z = helper.spawn(EntityTypes.ZOMBIE, new BlockPos(5, 0, 5));
				z.setBaby(false);
				z.setItemSlot(EquipmentSlot.HEAD, new ItemStack(Items.LEATHER_HELMET));
				z.setTarget(agent);
				zombie.set(z);
			})
			.thenWaitUntil(() -> {
				var unseats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(!unseats.isEmpty(), "pc.unseat not sent");
				helper.assertValueEqual(unseats.getFirst().reason(), "damage", "reason");
			})
			.thenWaitUntil(() -> helper.assertTrue(!zombie.get().isAlive() || zombie.get().getLastHurtByMob() == agent, "the agent fights back"))
			.thenExecute(() -> {
				helper.assertTrue(recorder(helper).events(agent.agentId(), "unseated").size() >= 1, "agent.event unseated");
				helper.assertTrue(service.seated(agent.agentId()) == null, "no longer tracked as seated");
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 300)
	public void idleModeStayReturnsToAnchor(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Stayer", AgentRole.GUARD, 2, 0, 2);
		SkillService service = service(helper);
		service.mode(new Bodies.AgentMode(agent.agentId(), "stay", dev.minevibe.agent.skill.Refs.wire(helper.absolutePos(new BlockPos(2, 0, 2)))));
		helper.assertTrue(agent.brain().mode() == IdleMode.STAY, "mode stay");
		agent.teleportTo(agent.getX() + 4.0, agent.getY(), agent.getZ() + 3.0);
		helper.succeedWhen(() -> helper.assertTrue(agent.position().distanceTo(helper.absoluteVec(new Vec3(2.5, 0, 2.5))) <= 1.5,
			"back at the anchor: " + agent.position()));
	}
}
