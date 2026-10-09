package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.SkillTestSupport.error;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.result;
import static dev.minevibe.gametest.agent.SkillTestSupport.run;
import static dev.minevibe.gametest.agent.SkillTestSupport.status;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.job.Walk;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.nav.DigGoal;
import dev.minevibe.agent.nav.DigPath;
import dev.minevibe.agent.nav.DigPathPlanner;
import dev.minevibe.agent.nav.DigStep;
import dev.minevibe.agent.nav.NavBlocks;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficePlan;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Provenance;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Tier-2 navigation (navigation v2, PLAN 7.2): trees an agent can only reach by digging, pillaring, bridging or
 * swimming, a target nothing natural leads to, and four agents planning at once. Each test builds its terrain on the
 * 33x33 grass field {@code nav_field} (its own batch, environment {@code nav}) and prints {@code [S1] nav_*} numbers.
 */
public final class NavGameTests {
	private static final String FIELD = "minevibe-gametest:nav_field";
	private static final String NAV = "minevibe-gametest:nav";

	// ------------------------------------------------------------------ trees through the mine skill

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeOnLedgeDigs(final GameTestHelper helper) {
		// A 3-high dirt ledge from x=14 on; the tree stands on it. No scaffold: the agent digs itself a staircase.
		fill(helper, 14, 1, 0, 32, 3, 32, Blocks.DIRT);
		tree(helper, 20, 4, 16, 5);
		AgentPlayer agent = spawnAgent(helper, "Ledge", AgentRole.MINER, 4, 1, 16);
		this.mineAndCheck(helper, agent, 2, "nav_ledge_dig", nav -> nav.digBroken() >= 1, "dug a way up the ledge");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeOnLedgePillars(final GameTestHelper helper) {
		// The same ledge, with dirt in the bag: pillaring up beats digging.
		fill(helper, 14, 1, 0, 32, 3, 32, Blocks.DIRT);
		tree(helper, 20, 4, 16, 5);
		AgentPlayer agent = spawnAgent(helper, "Pillar", AgentRole.MINER, 4, 1, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		this.mineAndCheck(helper, agent, 2, "nav_ledge_pillar", nav -> nav.digPlaced() >= 1, "pillared up the ledge");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeAcrossGap(final GameTestHelper helper) {
		// Two dirt plateaus (standing height y=5) with a 2-wide gap, 4 deep, across the whole field. Dirt in the bag.
		fill(helper, 0, 1, 0, 14, 4, 32, Blocks.DIRT);
		fill(helper, 17, 1, 0, 32, 4, 32, Blocks.DIRT);
		tree(helper, 24, 5, 16, 5);
		AgentPlayer agent = spawnAgent(helper, "Bridger", AgentRole.MINER, 6, 5, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		this.mineAndCheck(helper, agent, 2, "nav_gap", nav -> nav.digPlaced() >= 2, "bridged the gap");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeBehindLeafWall(final GameTestHelper helper) {
		// The trunk stands in a tent of leaves: a 3-high ring 3 blocks out under a leaf roof. Nothing in the bag.
		ServerLevel level = helper.getLevel();
		for (int y = 1; y <= 6; y++) {
			helper.setBlock(new BlockPos(20, y, 16), Blocks.OAK_LOG);
		}
		List<BlockPos> wall = new ArrayList<>();
		for (int x = 17; x <= 23; x++) {
			for (int z = 13; z <= 19; z++) {
				boolean ring = x == 17 || x == 23 || z == 13 || z == 19;
				for (int y = 1; y <= 6; y++) {
					boolean roof = y >= 4;
					if ((ring && y <= 3 || roof) && !(x == 20 && z == 16)) {
						BlockPos p = new BlockPos(x, y, z);
						leaf(helper, p);
						if (ring && y <= 3) {
							wall.add(helper.absolutePos(p));
						}
					}
				}
			}
		}
		AgentPlayer agent = spawnAgent(helper, "Leafy", AgentRole.MINER, 4, 1, 16);
		// Leaves cut off from the trunk decay on their own once a neighbour is broken: count what the agent broke instead.
		this.mineAndCheck(helper, agent, 1, "nav_leaf_wall", nav -> {
			long gone = wall.stream().filter(p -> !level.getBlockState(p).is(Blocks.OAK_LEAVES)).count();
			return gone >= 1 && nav.digBroken() >= 1 && nav.digBroken() <= 12;
		}, "broke a way through the wall (a few leaves), not the wall");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeOnHillStep(final GameTestHelper helper) {
		// A grassy hill with a 2-high step at x=14 (too high to jump). Nothing in the bag: the agent cuts one block out of it.
		fill(helper, 14, 1, 0, 32, 1, 32, Blocks.DIRT);
		fill(helper, 14, 2, 0, 32, 2, 32, Blocks.GRASS_BLOCK);
		tree(helper, 20, 3, 16, 5);
		AgentPlayer agent = spawnAgent(helper, "Hiker", AgentRole.MINER, 4, 1, 16);
		this.mineAndCheck(helper, agent, 2, "nav_hill_step", nav -> nav.digBroken() >= 1, "cut a step");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeAcrossWater(final GameTestHelper helper) {
		// Land 2 high with a 5-wide, 2-deep river across it (dammed at both ends). Nothing in the bag: it swims.
		fill(helper, 0, 1, 0, 32, 2, 32, Blocks.DIRT);
		fill(helper, 12, 1, 1, 16, 2, 31, Blocks.WATER);
		fill(helper, 12, 1, 0, 16, 3, 0, Blocks.DIRT);
		fill(helper, 12, 1, 32, 16, 3, 32, Blocks.DIRT);
		tree(helper, 24, 3, 16, 5);
		AgentPlayer agent = spawnAgent(helper, "Swimmer", AgentRole.MINER, 4, 3, 16);
		AtomicBoolean swam = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(1600, () -> {
			if (agent.isInWater()) {
				swam.set(true);
			}
		});
		this.mineAndCheck(helper, agent, 1, "nav_water", nav -> swam.get(), "swam across");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 2000)
	public void navOfficeInHillHasAWayOut(final GameTestHelper helper) {
		// Seeds 42 and minevibe-e2e: the starter office sunk into a hill, its porch opening into the ground. The builder
		// cuts stairs up from the porch (agents may not dig in the Base): the body walks out on Tier 1 alone, then mines the
		// tree on the hilltop, and no block of the office changes.
		ServerLevel level = helper.getLevel();
		fill(helper, 0, 1, 0, 32, 5, 32, Blocks.DIRT);
		fill(helper, 0, 6, 0, 32, 6, 32, Blocks.GRASS_BLOCK);
		BlockPos origin = helper.absolutePos(new BlockPos(6, 1, 4));
		dev.minevibe.org.office.OfficeLayout layout = dev.minevibe.org.office.OfficeBuilder.build(level, origin, null);
		dev.minevibe.org.office.OfficeService.overrideLayout(level.getServer(), layout);
		AgentTestSupport.onTestEnd(helper, () -> dev.minevibe.org.office.OfficeService.overrideLayout(level.getServer(), null));
		List<BlockPos> office = new ArrayList<>();
		List<Block> before = new ArrayList<>();
		for (BlockPos p : BlockPos.betweenClosed(origin, origin.offset(dev.minevibe.org.office.OfficePlan.WIDTH - 1, dev.minevibe.org.office.OfficePlan.ROOF,
			dev.minevibe.org.office.OfficePlan.PORCH_Z))) {
			office.add(p.immutable());
			before.add(level.getBlockState(p).getBlock());
		}
		tree(helper, 24, 7, 27, 5);
		BlockPos porch = new BlockPos(6 + dev.minevibe.org.office.OfficePlan.DOOR_X, 2, 4 + dev.minevibe.org.office.OfficePlan.PORCH_Z);
		AgentPlayer agent = spawnAgent(helper, "Buried", AgentRole.MINER, porch.getX(), porch.getY(), porch.getZ());
		agent.navigator().moveTo(helper.absoluteVec(new net.minecraft.world.phys.Vec3(porch.getX() + 0.5, 7.0, 24.5)), 1.0);
		long start = helper.getTick();
		AtomicReference<CompletableFuture<Map<String, Object>>> mine = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> {
				AgentNavigator nav = agent.navigator();
				helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "no walking way out of the office: " + nav.failureReason());
				helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking out, at " + agent.blockPosition().toShortString());
				helper.assertValueEqual(nav.digPlans(), 0, "Tier 2 plans for the way out");
			})
			.thenExecute(() -> mine.set(run(helper, agent, jobId("hill"), "mine", "{\"block\":\"oak_log\",\"count\":1,\"radius\":32}", 120_000)))
			.thenWaitUntil(() -> {
				String s = status(mine.get());
				if ("failed".equals(s) || "cancelled".equals(s)) {
					helper.fail("mine " + s + ": " + error(mine.get()) + " " + result(mine.get()));
				}
				helper.assertTrue("done".equals(s), "still mining (" + s + ") at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				new AgentTestSupport.Report("nav_office_in_hill").add("ticks", helper.getTick() - start).add("broken", agent.navigator().digBroken()).print();
				for (int i = 0; i < office.size(); i++) {
					Block now = level.getBlockState(office.get(i)).getBlock();
					helper.assertTrue(now == before.get(i), "office block changed at " + office.get(i).toShortString() + ": " + before.get(i) + " -> " + now);
				}
			})
			.thenSucceed();
	}

	/** Runs {@code mine oak_log x count} through the skill API and checks the agent got there by Tier 2, unhurt. */
	private void mineAndCheck(final GameTestHelper helper, final AgentPlayer agent, final int count, final String name,
		final java.util.function.Predicate<AgentNavigator> how, final String what) {
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId(name), "mine", "{\"block\":\"oak_log\",\"count\":" + count + ",\"radius\":32}", 120_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s) || "cancelled".equals(s)) {
				helper.fail("mine " + s + ": " + error(r) + " " + result(r) + " events " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue("done".equals(s), "still mining (" + s + ") at " + agent.blockPosition().toShortString());
			AgentNavigator nav = agent.navigator();
			DigPath path = nav.lastDigPath();
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report(name)
					.add("ticks", helper.getTick() - start)
					.add("mined", result(r).get("mined"))
					.add("unreachable", result(r).get("unreachable"))
					.add("dig_plans", nav.digPlans())
					.add("dig_nodes", nav.digNodes())
					.add("broken", nav.digBroken())
					.add("placed", nav.digPlaced())
					.add("plan_ms_max_tick", String.format(Locale.ROOT, "%.3f", nav.digMaxTickMillis()))
					.add("path", path == null ? "-" : path.steps().stream().map(st -> st.kind().name()).toList())
					.add("hp", agent.getHealth())
					.print();
			}
			helper.assertTrue(result(r).get("mined").getAsInt() >= count, "mined " + result(r));
			helper.assertTrue(nav.digPlans() >= 1, "Tier 2 planned the way");
			helper.assertTrue(how.test(nav), what + " (broke " + nav.digBroken() + ", placed " + nav.digPlaced() + ")");
			helper.assertTrue(agent.getHealth() >= agent.getMaxHealth(), "no fall damage, hp " + agent.getHealth());
		});
	}

	// ------------------------------------------------------------------ doors, ladders, goto

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navTier2ThroughDoor(final GameTestHelper helper) {
		// A 4-high cobblestone wall across the field with one oak door: Tier 2 walks through it (cobblestone is never broken).
		ServerLevel level = helper.getLevel();
		fill(helper, 0, 1, 12, 32, 4, 12, Blocks.COBBLESTONE);
		BlockPos doorLower = helper.absolutePos(new BlockPos(16, 1, 12));
		BlockState door = Blocks.OAK_DOOR.defaultBlockState().setValue(net.minecraft.world.level.block.DoorBlock.FACING, Direction.NORTH)
			.setValue(net.minecraft.world.level.block.DoorBlock.OPEN, false);
		level.setBlock(doorLower.above(), door.setValue(net.minecraft.world.level.block.DoorBlock.HALF, net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER),
			Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
		level.setBlock(doorLower, door.setValue(net.minecraft.world.level.block.DoorBlock.HALF, net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER),
			Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
		AgentPlayer agent = spawnAgent(helper, "Doorman", AgentRole.BUILDER, 10, 1, 4);
		agent.brain().setEnabled(false);
		agent.navigator().moveTo(DigGoal.near(helper.absoluteVec(new net.minecraft.world.phys.Vec3(20.5, 1.0, 20.5)), 1.0));
		AtomicBoolean opened = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(600, () -> {
			BlockState s = level.getBlockState(doorLower);
			if (s.getBlock() instanceof net.minecraft.world.level.block.DoorBlock && s.getValue(net.minecraft.world.level.block.DoorBlock.OPEN)) {
				opened.set(true);
			}
		});
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking, at " + agent.blockPosition().toShortString());
			helper.assertTrue(opened.get(), "the door was opened");
			helper.assertValueEqual(nav.digBroken(), 0, "blocks broken");
			BlockState s = level.getBlockState(doorLower);
			helper.assertTrue(s.getBlock() instanceof net.minecraft.world.level.block.DoorBlock && !s.getValue(net.minecraft.world.level.block.DoorBlock.OPEN),
				"the door is closed again behind the agent");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navTier2ClimbsLadder(final GameTestHelper helper) {
		// A 4-high cobblestone cliff with a ladder up its face: the only way up without scaffold.
		ServerLevel level = helper.getLevel();
		fill(helper, 0, 1, 14, 32, 4, 32, Blocks.COBBLESTONE);
		BlockState ladder = Blocks.LADDER.defaultBlockState().setValue(net.minecraft.world.level.block.LadderBlock.FACING, Direction.NORTH);
		for (int y = 1; y <= 4; y++) {
			level.setBlock(helper.absolutePos(new BlockPos(16, y, 13)), ladder, Block.UPDATE_CLIENTS);
		}
		AgentPlayer agent = spawnAgent(helper, "Climber", AgentRole.BUILDER, 12, 1, 6);
		agent.brain().setEnabled(false);
		BlockPos top = helper.absolutePos(new BlockPos(18, 5, 20));
		agent.navigator().moveTo(DigGoal.near(net.minecraft.world.phys.Vec3.atBottomCenterOf(top), 1.0));
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "climbing, at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.getY() >= top.getY() - 0.01, "on top of the cliff");
			DigPath path = nav.lastDigPath();
			helper.assertTrue(path != null && path.steps().stream().anyMatch(s -> s.kind() == DigStep.Kind.CLIMB_UP), "climbed the ladder: " + path);
			helper.assertValueEqual(nav.digBroken(), 0, "blocks broken");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1000)
	public void navGotoDigsWhenNoWalk(final GameTestHelper helper) {
		// goto a spot on top of the 3-high ledge: Tier 1 finds no way, Tier 2 digs one (the skill's own fallback).
		fill(helper, 14, 1, 0, 32, 3, 32, Blocks.DIRT);
		AgentPlayer agent = spawnAgent(helper, "Goer", AgentRole.BUILDER, 4, 1, 16);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("goto"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 20, 4, 16) + "}", 60_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("goto failed: " + error(r));
			}
			helper.assertTrue("done".equals(s), "still walking (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.navigator().digPlans() >= 1 && agent.navigator().digBroken() >= 1, "Tier 2 dug the way up");
			helper.assertTrue(agent.getY() >= helper.absolutePos(new BlockPos(0, 4, 0)).getY() - 0.01, "on the ledge");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navFetchesDropFromLeaves(final GameTestHelper helper) {
		// A log lies on top of a 3-high stack of leaves (a drop caught in a canopy): no walk leads there, so the pickup
		// skill fetches it with Tier 2 (a short pillar next to the stack).
		for (int y = 1; y <= 3; y++) {
			leaf(helper, new BlockPos(10, y, 10));
		}
		ServerLevel level = helper.getLevel();
		net.minecraft.world.phys.Vec3 at = helper.absoluteVec(new net.minecraft.world.phys.Vec3(10.5, 4.05, 10.5));
		net.minecraft.world.entity.item.ItemEntity drop = new net.minecraft.world.entity.item.ItemEntity(level, at.x, at.y, at.z, new ItemStack(Items.OAK_LOG), 0, 0, 0);
		drop.setNoPickUpDelay();
		level.addFreshEntity(drop);
		AgentPlayer agent = spawnAgent(helper, "Fetcher", AgentRole.MINER, 4, 1, 10);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 8));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("fetch"), "pickup", "{\"item\":\"oak_log\",\"radius\":16}", 60_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(s != null && !"failed".equals(s), "pickup " + s + (r.isDone() ? " " + error(r) : ""));
			helper.assertTrue("done".equals(s), "still fetching (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.getInventory().countItem(Items.OAK_LOG) >= 1, "picked up the log");
			helper.assertTrue(agent.navigator().digPlans() >= 1, "Tier 2 fetched it");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navCollectBreaksLeavesForDrop(final GameTestHelper helper) {
		// collect picks up loose logs first; this one lies on a leaf stack inside a leaf hedge, and the bag is empty:
		// Tier 2 breaks its way through the leaves to reach it (the break must not be undone by the job every tick).
		for (int x = 9; x <= 11; x++) {
			for (int z = 9; z <= 11; z++) {
				for (int y = 1; y <= 2; y++) {
					leaf(helper, new BlockPos(x, y, z));
				}
			}
		}
		leaf(helper, new BlockPos(10, 3, 10));
		ServerLevel level = helper.getLevel();
		net.minecraft.world.phys.Vec3 at = helper.absoluteVec(new net.minecraft.world.phys.Vec3(10.5, 4.05, 10.5));
		net.minecraft.world.entity.item.ItemEntity drop = new net.minecraft.world.entity.item.ItemEntity(level, at.x, at.y, at.z, new ItemStack(Items.OAK_LOG), 0, 0, 0);
		drop.setNoPickUpDelay();
		level.addFreshEntity(drop);
		AgentPlayer agent = spawnAgent(helper, "Hedger", AgentRole.MINER, 4, 1, 10);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("hedge"), "collect", "{\"item\":\"oak_log\",\"count\":1,\"radius\":16}", 60_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(s != null && !"failed".equals(s), "collect " + s + (r.isDone() ? " " + error(r) : ""));
			helper.assertTrue("done".equals(s), "still collecting (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.getInventory().countItem(Items.OAK_LOG) >= 1, "picked up the log");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 400)
	public void navCollectStopsStaleWalk(final GameTestHelper helper) {
		// collect walks (digging) toward a loose log inside a leaf hedge; the log vanishes while the agent breaks the
		// hedge. The job then mines the log beside it: the stale walk must stop, or its held attack on the leaves and the
		// job's on the log abort each other every tick and neither ever breaks.
		for (int x = 14; x <= 18; x++) {
			for (int z = 8; z <= 12; z++) {
				for (int y = 1; y <= 3; y++) {
					boolean inside = x >= 15 && x <= 17 && z >= 9 && z <= 11 && y <= 2;
					if (!inside) {
						leaf(helper, new BlockPos(x, y, z));
					}
				}
			}
		}
		helper.setBlock(new BlockPos(13, 1, 12), Blocks.OAK_LOG);
		ServerLevel level = helper.getLevel();
		net.minecraft.world.phys.Vec3 at = helper.absoluteVec(new net.minecraft.world.phys.Vec3(16.5, 1.05, 10.5));
		net.minecraft.world.entity.item.ItemEntity drop = new net.minecraft.world.entity.item.ItemEntity(level, at.x, at.y, at.z, new ItemStack(Items.OAK_LOG), 0, 0, 0);
		drop.setNoPickUpDelay();
		level.addFreshEntity(drop);
		AgentPlayer agent = spawnAgent(helper, "Stale", AgentRole.MINER, 11, 1, 10);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("stale"), "collect", "{\"item\":\"oak_log\",\"count\":1,\"radius\":16}", 60_000);
		AtomicBoolean gone = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(400, () -> {
			// The moment the walk starts breaking the hedge, the loose log disappears (picked up by someone else).
			if (!gone.get() && agent.controls().isMining() && drop.isAlive()) {
				drop.discard();
				gone.set(true);
			}
		});
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(gone.get(), "the walk never broke into the hedge");
			helper.assertTrue(s != null && !"failed".equals(s), "collect " + s + (r.isDone() ? " " + error(r) : ""));
			helper.assertTrue("done".equals(s), "still collecting (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(level.getBlockState(helper.absolutePos(new BlockPos(13, 1, 12))).isAir(), "mined the log by the hedge");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navPillarNotCutShortByJump(final GameTestHelper helper) {
		// A block 5 up: out of reach from the ground, in reach at the top of a jump, properly in reach from a 1-block
		// pillar. The mine job must let the pillar finish instead of stopping at the jump's top and falling back (a loop).
		helper.setBlock(new BlockPos(10, 6, 10), Blocks.COARSE_DIRT);
		AgentPlayer agent = spawnAgent(helper, "Jumper", AgentRole.MINER, 6, 1, 10);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 8));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("jump"), "mine", "{\"block\":\"coarse_dirt\",\"count\":1,\"radius\":16}", 60_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(s != null && !"failed".equals(s), "mine " + s + (r.isDone() ? " " + error(r) + " " + result(r) : ""));
			helper.assertTrue("done".equals(s), "still mining (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.navigator().digPlaced() >= 1, "pillared");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navCollectStopsAtItsCount(final GameTestHelper helper) {
		// Two trees, collect 3 logs: the first tree is felled whole (5 logs), then the job ends; the second stands.
		// (The job used to pick the next tree in the same tick the last one's chores ended, and felled trees until its
		// timeout.)
		helper.setBlock(new BlockPos(12, 0, 16), Blocks.GRASS_BLOCK);
		tree(helper, 12, 1, 16, 5);
		tree(helper, 24, 1, 16, 5);
		List<BlockPos> second = new ArrayList<>();
		for (int y = 1; y <= 5; y++) {
			second.add(helper.absolutePos(new BlockPos(24, y, 16)));
		}
		AgentPlayer agent = spawnAgent(helper, "Enough", AgentRole.MINER, 8, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("enough"), "collect", "{\"item\":\"oak_log\",\"count\":3,\"radius\":24}", 120_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(s != null && !"failed".equals(s), "collect " + s + (r.isDone() ? " " + error(r) + " " + result(r) : ""));
			helper.assertTrue("done".equals(s), "still collecting (" + s + "), " + agent.getInventory().countItem(Items.OAK_LOG) + " logs");
			for (BlockPos p : second) {
				helper.assertTrue(helper.getLevel().getBlockState(p).is(Blocks.OAK_LOG), "the second tree was cut at " + p.toShortString());
			}
		});
	}

	// ------------------------------------------------------------------ goals and safety

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 300)
	public void navTrunkGoalReachesTrunk(final GameTestHelper helper) {
		// "Reach a tree trunk" on the 3-high ledge: any cell next to the trunk counts, at any height.
		fill(helper, 14, 1, 0, 32, 3, 32, Blocks.DIRT);
		tree(helper, 20, 4, 16, 6);
		AgentPlayer agent = spawnAgent(helper, "Trunk", AgentRole.MINER, 4, 1, 16);
		agent.brain().setEnabled(false);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 8));
		BlockPos log = helper.absolutePos(new BlockPos(20, 6, 16));
		agent.navigator().reachTrunk(log);
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "trunk goal failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking, at " + agent.blockPosition().toShortString());
			BlockPos feet = agent.blockPosition();
			int dx = Math.abs(feet.getX() - log.getX());
			int dz = Math.abs(feet.getZ() - log.getZ());
			helper.assertTrue(dx <= 1 && dz <= 1 && dx + dz > 0, "next to the trunk, at " + feet.toShortString());
			helper.assertTrue(helper.getLevel().getBlockState(feet).getCollisionShape(helper.getLevel(), feet).isEmpty(), "standing in a free cell");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 400)
	public void navReachBlockArrivesInHandReach(final GameTestHelper helper) {
		// Seed 1350113924's tree on a bank, as a block: up a 1-wide glass corridor (z=16) toward a block 3 ahead, 2 to the
		// side and 2 up. The first cell whose middle is in plan reach (x=17, 3.71 blocks) is entered on its far edge, 4.1
		// blocks from the block: "reach a block" must not arrive there, but in hand reach.
		corridor(helper);
		BlockPos rel = new BlockPos(20, 3, 18);
		helper.setBlock(rel, Blocks.OAK_LOG);
		BlockPos block = helper.absolutePos(rel);
		AgentPlayer agent = spawnAgent(helper, "Reacher", AgentRole.MINER, 4, 1, 16);
		agent.brain().setEnabled(false);
		agent.navigator().reachBlock(block);
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "reach failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking, at " + agent.blockPosition().toShortString());
			double eyes = agent.getEyePosition().distanceTo(Vec3.atCenterOf(block));
			helper.assertTrue(Walk.inReach(agent, block), String.format(Locale.ROOT, "arrived %.2f blocks from it (hand reach %.1f), at %.2f %.2f %.2f",
				eyes, Walk.BLOCK_REACH, agent.getX(), agent.getY(), agent.getZ()));
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1600)
	public void navTreeOnLowBankMined(final GameTestHelper helper) {
		// The same, as a tree: it stands on a 2-high dirt bank beyond the corridor's wall. An arrival short of its base log
		// (walk out_of_reach) gave the whole tree up: no walk led there, so it counted as unreachable.
		corridor(helper);
		fill(helper, 0, 1, 18, 32, 2, 32, Blocks.DIRT);
		tree(helper, 20, 3, 18, 5);
		AgentPlayer agent = spawnAgent(helper, "Banker", AgentRole.MINER, 4, 1, 16);
		this.mineAndCheck(helper, agent, 2, "nav_low_bank", nav -> true, "mined from the corridor");
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 400)
	public void navUnreachableFailsCleanly(final GameTestHelper helper) {
		// The tree is sealed in a box of planks, cobblestone and glass: nothing natural leads there, so Tier 2 must give up
		// cleanly (nav.failed no_path) without breaking a single block of the box.
		ServerLevel level = helper.getLevel();
		List<BlockPos> box = new ArrayList<>();
		Block[] kinds = {Blocks.OAK_PLANKS, Blocks.COBBLESTONE, Blocks.GLASS};
		for (int x = 15; x <= 17; x++) {
			for (int z = 15; z <= 17; z++) {
				for (int y = 1; y <= 7; y++) {
					boolean shell = x != 16 || z != 16 || y == 7;
					BlockPos p = new BlockPos(x, y, z);
					if (shell) {
						helper.setBlock(p, kinds[(x + y + z) % 3]);
						box.add(helper.absolutePos(p));
					} else {
						helper.setBlock(p, Blocks.OAK_LOG);
					}
				}
			}
		}
		List<BlockState> before = box.stream().map(level::getBlockState).toList();
		AgentPlayer agent = spawnAgent(helper, "Sealed", AgentRole.MINER, 4, 1, 16);
		agent.brain().setEnabled(false);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		long start = helper.getTick();
		agent.navigator().reachTrunk(helper.absolutePos(new BlockPos(16, 3, 16)));
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() == AgentNavigator.Status.FAILED, "still searching (" + nav.status() + ")");
			helper.assertValueEqual(nav.failureReason(), "no_path", "failure reason");
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report("nav_unreachable")
					.add("ticks", helper.getTick() - start)
					.add("nodes", nav.digNodes())
					.add("plan_ticks", nav.digPlanTicks())
					.add("plan_ms_max_tick", String.format(Locale.ROOT, "%.3f", nav.digMaxTickMillis()))
					.add("plan_ms_avg_tick", String.format(Locale.ROOT, "%.3f", nav.digAvgTickMillis()))
					.print();
			}
			for (int i = 0; i < box.size(); i++) {
				helper.assertTrue(level.getBlockState(box.get(i)) == before.get(i), "box block broken at " + box.get(i).toShortString());
			}
			helper.assertValueEqual(nav.digBroken(), 0, "blocks broken");
			helper.assertValueEqual(nav.digPlaced(), 0, "blocks placed");
			helper.assertTrue(nav.digNodes() >= 1000, "searched before giving up (" + nav.digNodes() + " nodes)");
			helper.assertTrue(AgentEvents.recent(agent.agentId()).stream().anyMatch(e -> e.type().equals("nav.failed") && "2".equals(e.data().get("tier"))),
				"nav.failed from Tier 2");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 40)
	public void navTooFarFailsAtOnce(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Faraway", AgentRole.MINER, 4, 1, 16);
		agent.brain().setEnabled(false);
		agent.navigator().reachBlock(helper.absolutePos(new BlockPos(4, 1, 16 + DigPathPlanner.RADIUS + 30)));
		helper.runAfterDelay(3, () -> {
			helper.assertTrue(agent.navigator().status() == AgentNavigator.Status.FAILED, "status " + agent.navigator().status());
			helper.assertValueEqual(agent.navigator().failureReason(), "too_far", "failure reason");
			helper.succeed();
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 20)
	public void navPlannerSafetyRules(final GameTestHelper helper) {
		// The agent stands in a dirt cell sealed on all sides; the east wall holds back water. Every way out digs, and
		// no plan may open a block next to water, the block under the feet, or anything but natural blocks.
		ServerLevel level = helper.getLevel();
		fill(helper, 3, 1, 3, 9, 4, 9, Blocks.DIRT);
		helper.setBlock(new BlockPos(6, 1, 6), Blocks.AIR);
		helper.setBlock(new BlockPos(6, 2, 6), Blocks.AIR);
		// Water east of the cell, one dirt block away, at body height.
		helper.setBlock(new BlockPos(8, 1, 6), Blocks.WATER);
		helper.setBlock(new BlockPos(8, 2, 6), Blocks.WATER);
		// A cobblestone floor under the start: never mined.
		helper.setBlock(new BlockPos(6, 0, 6), Blocks.COBBLESTONE);
		AgentPlayer agent = spawnAgent(helper, "Boxed", AgentRole.MINER, 6, 1, 6);
		agent.brain().setEnabled(false);
		BlockPos from = helper.absolutePos(new BlockPos(6, 1, 6));
		int[][] goals = {{14, 1, 6}, {6, 1, 14}, {1, 1, 6}, {6, 1, 1}};
		for (int[] g : goals) {
			BlockPos goal = helper.absolutePos(new BlockPos(g[0], g[1], g[2]));
			DigPathPlanner planner = new DigPathPlanner(level, agent.getInventory(), from, DigGoal.near(net.minecraft.world.phys.Vec3.atBottomCenterOf(goal), 1.0),
				DigPathPlanner.Config.standard(20.0F, 0), new LongOpenHashSet());
			helper.assertTrue(planner.runToEnd() == DigPathPlanner.State.FOUND, "a way out to " + goal.toShortString() + ": " + planner.failure() + " after "
				+ planner.expanded() + " nodes");
			for (DigStep step : planner.path().steps()) {
				for (BlockPos b : step.breaks()) {
					helper.assertFalse(b.equals(step.from().below()), "dug straight down at " + b.toShortString());
					helper.assertTrue(level.getBlockState(b).is(Blocks.DIRT) || level.getBlockState(b).is(Blocks.GRASS_BLOCK), "broke a non-natural block " + b);
					for (Direction d : Direction.values()) {
						helper.assertTrue(level.getFluidState(b.relative(d)).isEmpty() || d == Direction.DOWN, "opened a block next to water at " + b.toShortString());
					}
				}
			}
		}
		helper.succeed();
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 300)
	public void navNeverDigsStraightDown(final GameTestHelper helper) {
		// Mining the block the agent stands on: it steps aside first.
		helper.setBlock(new BlockPos(8, 0, 8), Blocks.COARSE_DIRT);
		BlockPos target = helper.absolutePos(new BlockPos(8, 0, 8));
		AgentPlayer agent = spawnAgent(helper, "Steady", AgentRole.MINER, 8, 1, 8);
		AtomicBoolean above = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(300, () -> {
			if (agent.controls().miningPos() != null && agent.controls().miningPos().equals(target)) {
				BlockPos feet = agent.blockPosition();
				if (feet.getX() == target.getX() && feet.getZ() == target.getZ()) {
					above.set(true);
				}
			}
		});
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("down"), "mine", "{\"block\":\"coarse_dirt\",\"count\":1,\"radius\":4}", 60_000);
		helper.succeedWhen(() -> {
			helper.assertTrue("done".equals(status(r)), "mine " + status(r) + (r.isDone() ? " " + error(r) : ""));
			helper.assertFalse(above.get(), "mined the block it stood on");
			helper.assertTrue(helper.getLevel().getBlockState(target).isAir(), "mined");
		});
	}

	// ------------------------------------------------------------------ what stays standing, and falls that stay safe

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 20)
	public void navNeverBreaksCrewBuilds(final GameTestHelper helper) {
		// The agent stands in a ring of planks, glass and bricks the crew placed (provenance: an agent's). A crew build is no
		// scaffold: no plan breaks it, not even where navigation once noted scaffold (a stale note). Scaffold the agent
		// placed to get somewhere (remembered, still a scaffold block) may be broken again.
		ServerLevel level = helper.getLevel();
		Owner crew = Owner.agent("crew_builder", "Builder");
		Block[] kinds = {Blocks.OAK_PLANKS, Blocks.GLASS, Blocks.BRICKS};
		List<BlockPos> ring = new ArrayList<>();
		for (int x = 15; x <= 17; x++) {
			for (int z = 15; z <= 17; z++) {
				for (int y = 1; y <= 2; y++) {
					if (x == 16 && z == 16) {
						continue;
					}
					helper.setBlock(new BlockPos(x, y, z), kinds[(x + y + z) % 3]);
					BlockPos p = helper.absolutePos(new BlockPos(x, y, z));
					Provenance.mark(level, p, crew);
					ring.add(p);
				}
			}
		}
		AgentTestSupport.onTestEnd(helper, () -> ring.forEach(p -> NavBlocks.forgetScaffold(level, p)));
		AgentPlayer agent = spawnAgent(helper, "Ringed", AgentRole.MINER, 16, 1, 16);
		agent.brain().setEnabled(false);
		BlockPos from = helper.absolutePos(new BlockPos(16, 1, 16));
		DigGoal out = DigGoal.near(helper.absoluteVec(new Vec3(24.5, 1.0, 16.5)), 1.0);
		DigPathPlanner.Config config = DigPathPlanner.Config.standard(20.0F, 0).withAgent(agent.agentId());
		DigPathPlanner build = new DigPathPlanner(level, agent.getInventory(), from, out, config, new LongOpenHashSet());
		helper.assertTrue(build.runToEnd() == DigPathPlanner.State.FAILED, "a way out through the crew's build: " + build.path());
		ring.forEach(p -> NavBlocks.noteScaffold(level, p));
		DigPathPlanner stale = new DigPathPlanner(level, agent.getInventory(), from, out, config, new LongOpenHashSet());
		helper.assertTrue(stale.runToEnd() == DigPathPlanner.State.FAILED, "a way out through the crew's build (stale scaffold notes): " + stale.path());
		// The east side is the agent's own scaffold now: cobblestone it placed, remembered.
		List<BlockPos> scaffold = new ArrayList<>();
		for (int y = 1; y <= 2; y++) {
			helper.setBlock(new BlockPos(17, y, 16), Blocks.COBBLESTONE);
			scaffold.add(helper.absolutePos(new BlockPos(17, y, 16)));
		}
		DigPathPlanner own = new DigPathPlanner(level, agent.getInventory(), from, out, config, new LongOpenHashSet());
		helper.assertTrue(own.runToEnd() == DigPathPlanner.State.FOUND, "a way out through its own scaffold: " + own.failure());
		for (DigStep step : own.path().steps()) {
			for (BlockPos b : step.breaks()) {
				helper.assertTrue(scaffold.contains(b), "broke " + level.getBlockState(b).getBlock() + " at " + b.toShortString());
			}
		}
		helper.succeed();
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 2400)
	public void navFellingLeavesEarlierPillarsAlone(final GameTestHelper helper) {
		// A goto pillars up the 3-high ledge (dirt in the bag) and leaves its pillar standing, as walks do; the crew then
		// builds where it stood. A tree felled afterwards clears the pillars of its own job only: it never walks back to the
		// earlier one, nor mines what stands there now.
		ServerLevel level = helper.getLevel();
		fill(helper, 14, 1, 0, 32, 3, 32, Blocks.DIRT);
		AgentPlayer agent = spawnAgent(helper, "Earlier", AgentRole.MINER, 4, 1, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		CompletableFuture<Map<String, Object>> go = run(helper, agent, jobId("ledge"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 20, 4, 16) + "}",
			60_000);
		List<BlockPos> build = new ArrayList<>();
		AtomicReference<CompletableFuture<Map<String, Object>>> fell = new AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> {
				String s = status(go);
				if ("failed".equals(s)) {
					helper.fail("goto failed: " + error(go));
				}
				helper.assertTrue("done".equals(s), "still walking (" + s + ") at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				helper.assertTrue(agent.navigator().digPlaced() >= 1, "the goto pillared (placed " + agent.navigator().digPlaced() + ")");
				// Its pillar stands below the ledge (x < 14): the crew builds there now.
				for (int x = 0; x < 14; x++) {
					for (int z = 0; z <= 32; z++) {
						for (int y = 1; y <= 3; y++) {
							BlockPos rel = new BlockPos(x, y, z);
							if (helper.getBlockState(rel).is(Blocks.DIRT)) {
								helper.setBlock(rel, Blocks.OAK_PLANKS);
								Provenance.mark(level, helper.absolutePos(rel), Owner.agent("crew_builder", "Builder"));
								build.add(helper.absolutePos(rel));
							}
						}
					}
				}
				helper.assertFalse(build.isEmpty(), "found the goto's pillar");
				tree(helper, 22, 4, 16, 5);
				fell.set(run(helper, agent, jobId("fell"), "collect", "{\"item\":\"oak_log\",\"count\":1,\"radius\":16}", 120_000));
			})
			.thenWaitUntil(() -> {
				String s = status(fell.get());
				if ("failed".equals(s) || "cancelled".equals(s)) {
					helper.fail("collect " + s + ": " + error(fell.get()) + " " + result(fell.get()));
				}
				helper.assertTrue("done".equals(s), "still collecting (" + s + ") at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				for (BlockPos p : build) {
					helper.assertTrue(level.getBlockState(p).is(Blocks.OAK_PLANKS), "mined the crew's planks at " + p.toShortString()
						+ " (where an earlier walk's pillar stood)");
				}
			})
			.thenSucceed();
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 1200)
	public void navDropLandingRecheckedBeforeFall(final GameTestHelper helper) {
		// A 6-high dirt platform with a 3-high step beside it: the plan drops 3 onto the step, then 3 to the ground. The
		// step is mined away while the agent walks to the edge: it must not fall the 6 blocks it never planned (3 hearts),
		// but plan again (a staircase dug down the platform).
		fill(helper, 0, 1, 0, 10, 6, 32, Blocks.DIRT);
		fill(helper, 11, 1, 0, 13, 3, 32, Blocks.DIRT);
		AgentPlayer agent = spawnAgent(helper, "Edge", AgentRole.MINER, 2, 7, 16);
		agent.brain().setEnabled(false);
		agent.navigator().moveTo(DigGoal.near(helper.absoluteVec(new Vec3(20.5, 1.0, 16.5)), 1.0));
		AtomicBoolean removed = new AtomicBoolean();
		AtomicReference<Float> lowest = new AtomicReference<>(agent.getHealth());
		helper.startSequence().thenExecuteFor(1200, () -> {
			if (!removed.get() && agent.navigator().lastDigPath() != null) {
				helper.assertTrue(agent.navigator().lastDigPath().steps().stream().anyMatch(st -> st.kind() == DigStep.Kind.DROP),
					"the plan drops onto the step: " + agent.navigator().lastDigPath().steps());
				fill(helper, 11, 1, 0, 13, 3, 32, Blocks.AIR);
				removed.set(true);
			}
			lowest.set(Math.min(lowest.get(), agent.getHealth()));
		});
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(removed.get(), "no plan yet");
			helper.assertTrue(lowest.get() >= agent.getMaxHealth(), "fell further than planned: hp " + lowest.get());
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking, at " + agent.blockPosition().toShortString());
			helper.assertTrue(nav.digPlans() >= 2, "planned again once the landing was gone (" + nav.digPlans() + " plans)");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 400)
	public void navDeepDropIntoWaterStaysOnPath(final GameTestHelper helper) {
		// From an 11-high platform down into a pool: falling 9 blocks takes the body far from both ends of its step, yet it
		// is on its path (it used to count as pushed off and plan again in mid-air). The goal takes in the whole depth of
		// the pool, wherever the plunge ends.
		fill(helper, 0, 1, 0, 10, 11, 32, Blocks.DIRT);
		fill(helper, 11, 1, 11, 16, 3, 21, Blocks.DIRT);
		fill(helper, 11, 1, 12, 15, 3, 20, Blocks.WATER);
		AgentPlayer agent = spawnAgent(helper, "Diver", AgentRole.MINER, 6, 12, 16);
		agent.brain().setEnabled(false);
		agent.navigator().moveTo(DigGoal.near(helper.absoluteVec(new Vec3(13.5, 2.0, 16.5)), 1.0));
		AtomicReference<Float> lowest = new AtomicReference<>(agent.getHealth());
		helper.startSequence().thenExecuteFor(400, () -> lowest.set(Math.min(lowest.get(), agent.getHealth())));
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "failed: " + nav.failureReason());
			helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "on the way, at " + agent.blockPosition().toShortString());
			DigPath path = nav.lastDigPath();
			helper.assertTrue(path != null && path.steps().stream().anyMatch(st -> st.kind() == DigStep.Kind.DROP && st.from().getY() - st.dest().getY() >= 8),
				"dropped into the pool: " + path);
			helper.assertValueEqual(nav.digPlans(), 1, "searches (a fall into water is no reason to plan again)");
			helper.assertTrue(lowest.get() >= agent.getMaxHealth(), "hurt: hp " + lowest.get());
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 300)
	public void navNoScaffoldIntoTorchCell(final GameTestHelper helper) {
		// The agent stands in a torch's cell at the bottom of a 3-deep obsidian shaft, dirt in the bag. A pillar from there
		// would put its block where the torch is, which never places: no such plan is made (one clean no_path), rather than
		// made and made again until the walk gives up stuck.
		for (int x = 15; x <= 17; x++) {
			for (int z = 15; z <= 17; z++) {
				for (int y = 1; y <= 3; y++) {
					if (x != 16 || z != 16) {
						helper.setBlock(new BlockPos(x, y, z), Blocks.OBSIDIAN);
					}
				}
			}
		}
		helper.setBlock(new BlockPos(16, 1, 16), Blocks.TORCH);
		AgentPlayer agent = spawnAgent(helper, "Torchlit", AgentRole.MINER, 16, 1, 16);
		agent.brain().setEnabled(false);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		agent.navigator().moveTo(DigGoal.near(helper.absoluteVec(new Vec3(16.5, 4.0, 16.5)), 1.0));
		helper.succeedWhen(() -> {
			AgentNavigator nav = agent.navigator();
			helper.assertTrue(nav.status() == AgentNavigator.Status.FAILED, "still going (" + nav.status() + ") at " + agent.blockPosition().toShortString());
			helper.assertValueEqual(nav.failureReason(), "no_path", "failure reason");
			helper.assertValueEqual(nav.digPlans(), 1, "searches");
			helper.assertTrue(helper.getBlockState(new BlockPos(16, 1, 16)).is(Blocks.TORCH), "the torch is still there");
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 100)
	public void navOfficeExitSealsWaterAndSand(final GameTestHelper helper) {
		// The office sunk into a hill again, a pond in the hill right beside its exit stairs and sand on the ground above
		// the first step. The stairs are cut with the pond and the sand sealed off: no water pours, no sand falls onto them.
		ServerLevel level = helper.getLevel();
		fill(helper, 0, 1, 0, 32, 5, 32, Blocks.DIRT);
		fill(helper, 0, 6, 0, 32, 6, 32, Blocks.GRASS_BLOCK);
		int doorX = 6 + OfficePlan.DOOR_X;
		int porchZ = 4 + OfficePlan.PORCH_Z;
		fill(helper, doorX + 2, 2, porchZ + 1, doorX + 4, 5, porchZ + 4, Blocks.WATER);
		helper.setBlock(new BlockPos(doorX, 6, porchZ + 1), Blocks.SAND);
		OfficeBuilder.build(level, helper.absolutePos(new BlockPos(6, 1, 4)), null);
		helper.runAfterDelay(20, () -> {
			boolean cut = helper.getBlockState(new BlockPos(doorX, 3, porchZ + 1)).isAir() && helper.getBlockState(new BlockPos(doorX, 4, porchZ + 1)).isAir();
			helper.assertTrue(cut, "the first step was cut");
			for (int x = doorX - 1; x <= doorX + 1; x++) {
				for (int z = porchZ; z <= porchZ + 5; z++) {
					for (int y = 2; y <= 9; y++) {
						BlockState s = helper.getBlockState(new BlockPos(x, y, z));
						helper.assertTrue(s.getFluidState().isEmpty(), "water on the stairs at " + helper.absolutePos(new BlockPos(x, y, z)).toShortString());
						helper.assertFalse(s.is(Blocks.SAND), "sand fell onto the stairs at " + helper.absolutePos(new BlockPos(x, y, z)).toShortString());
					}
				}
			}
			helper.succeed();
		});
	}

	// ------------------------------------------------------------------ tall trees, their drops, and the cliff-side office

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 3000)
	public void navFellsNineLogOakKeepingTheDrops(final GameTestHelper helper) {
		// A 9-log oak: its top logs stand higher than any walk reaches (and than a Tier-2 pillar: base + 7). Nothing but an
		// axe in the bag: the miner digs dirt nearby, pillars in the cut trunk, fells it whole, comes down, picks up the
		// logs, and fills the holes it dug.
		tree(helper, 20, 1, 16, 9);
		List<BlockPos> logs = column(helper, 20, 1, 16, 9);
		AgentPlayer agent = spawnAgent(helper, "Feller", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		this.fellAndCheck(helper, agent, "oak_log", logs, Blocks.OAK_LOG, Items.OAK_LOG, "nav_tall_oak", null);
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 3000)
	public void navClimbBuildsOnlyWithScaffoldItMinesBack(final GameTestHelper helper) {
		// The 9-log oak with cobblestone in the bag but no pickaxe (gathering polish review): mined by hand, cobblestone
		// drops nothing and takes 10 s a block, so the climb digs dirt for its pillar and the cobblestone stays in the bag.
		tree(helper, 20, 1, 16, 9);
		List<BlockPos> logs = column(helper, 20, 1, 16, 9);
		AgentPlayer agent = spawnAgent(helper, "Cobbler", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(1, new ItemStack(Items.COBBLESTONE, 16));
		this.fellAndCheck(helper, agent, "oak_log", logs, Blocks.OAK_LOG, Items.OAK_LOG, "nav_tall_oak_cobble",
			() -> helper.assertValueEqual(agent.getInventory().countItem(Items.COBBLESTONE), 16, "cobblestone kept"));
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 3000)
	public void navFullBagDigsNoHoles(final GameTestHelper helper) {
		// The 9-log oak with a bag that has room for logs but none for dirt (gathering polish review): every block dug for
		// scaffold would drop on the ground and leave a hole, and the climb kept digging all the dirt around. Now it digs
		// none: the low logs are felled, the high ones left (no scaffold), and the ground is whole.
		tree(helper, 20, 1, 16, 9);
		AgentPlayer agent = spawnAgent(helper, "Fullbag", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(1, new ItemStack(Items.OAK_LOG));
		for (int slot = 2; slot < net.minecraft.world.entity.player.Inventory.INVENTORY_SIZE; slot++) {
			agent.getInventory().setItem(slot, new ItemStack(Items.STICK));
		}
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("fullbag"), "mine", "{\"block\":\"oak_log\",\"count\":9,\"radius\":16}", 120_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue("done".equals(s) || "failed".equals(s), "still mining (" + s + ") at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report("nav_full_bag").add("status", s).add("result", result(r)).print();
			}
			helper.assertTrue(result(r).get("mined").getAsInt() >= 5, "the low logs felled: " + result(r));
			for (int x = 4; x <= 32; x++) {
				for (int z = 4; z <= 28; z++) {
					helper.assertFalse(helper.getBlockState(new BlockPos(x, 0, z)).isAir(), "a hole dug at " + helper.absolutePos(new BlockPos(x, 0, z)).toShortString());
				}
			}
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 3000)
	public void navCancelledClimbComesDown(final GameTestHelper helper) {
		// A 14-log oak, dirt in the bag. The job is cancelled while the agent stands on its pillar high in the cut trunk
		// (gathering polish review): the job that would have come down is gone, and no walk comes down a pillar (Tier 1
		// drops 3 blocks at most, Tier 2 never digs straight down). The PillarDown reflex mines it away under the feet:
		// the agent ends on the ground, unhurt, and no scaffold is left.
		tree(helper, 20, 1, 16, 14);
		AgentPlayer agent = spawnAgent(helper, "Stranded", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		int base = helper.absolutePos(BlockPos.ZERO).getY();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("stranded"), "collect", "{\"item\":\"oak_log\",\"count\":14,\"radius\":16}",
			120_000);
		AtomicReference<Float> lowest = new AtomicReference<>(agent.getHealth());
		helper.startSequence().thenExecuteFor(3000, () -> lowest.set(Math.min(lowest.get(), agent.getHealth())));
		AtomicInteger cancelledAt = new AtomicInteger(-1);
		helper.startSequence()
			.thenWaitUntil(() -> {
				helper.assertTrue(agent.onGround() && agent.getBlockY() - base >= 6, "climbing, at " + agent.blockPosition().toShortString());
				BlockPos under = agent.blockPosition().below();
				helper.assertTrue(NavBlocks.isScaffold(helper.getLevel(), under, helper.getLevel().getBlockState(under)), "on the pillar");
			})
			.thenExecute(() -> {
				cancelledAt.set(agent.getBlockY() - base);
				agent.jobs().cancel();
			})
			.thenWaitUntil(() -> {
				helper.assertTrue(agent.onGround() && agent.getBlockY() - base == 1, "coming down, at " + agent.blockPosition().toShortString());
				for (int y = 1; y <= 14; y++) {
					helper.assertFalse(helper.getBlockState(new BlockPos(20, y, 16)).is(Blocks.DIRT), "scaffold left at y " + y);
				}
			})
			.thenExecute(() -> {
				new AgentTestSupport.Report("nav_cancelled_climb").add("cancelled_at", cancelledAt.get()).add("status", status(r))
					.add("hp_min", lowest.get()).print();
				helper.assertTrue(lowest.get() >= agent.getMaxHealth(), "hurt: hp " + lowest.get());
				helper.assertFalse(agent.jobs().hasJob(), "no job");
			})
			.thenSucceed();
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 3000)
	public void navHurtClimbComesDown(final GameTestHelper helper) {
		// The 14-log oak again; once the agent stands 4 blocks up its pillar its health drops to 10 (an arrow, say), and no
		// food heals it. A fall from 4 would leave it at 9: more than the climb allows now (health minus 8 is 2). It must
		// not climb any higher, and must come down to 2 blocks over the ground or less (gathering polish review: the limit
		// was only checked when the climb was planned).
		tree(helper, 20, 1, 16, 14);
		AgentPlayer agent = spawnAgent(helper, "Hurtclimb", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 16));
		int ground = helper.absolutePos(BlockPos.ZERO).getY() + 1;
		run(helper, agent, jobId("hurtclimb"), "collect", "{\"item\":\"oak_log\",\"count\":14,\"radius\":16}", 120_000);
		AtomicInteger hurtAt = new AtomicInteger(-1);
		AtomicInteger highest = new AtomicInteger(Integer.MIN_VALUE);
		AtomicInteger lowestAfter = new AtomicInteger(Integer.MAX_VALUE);
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(agent.onGround() && agent.getBlockY() - ground >= 4, "climbing, at " + agent.blockPosition().toShortString()))
			.thenExecute(() -> {
				hurtAt.set(agent.getBlockY() - ground);
				agent.getFoodData().setFoodLevel(17);
				agent.getFoodData().setSaturation(0.0F);
				agent.setHealth(10.0F);
			})
			.thenExecuteFor(200, () -> {
				int h = agent.getBlockY() - ground;
				// A jump in flight still reads one block up.
				highest.set(Math.max(highest.get(), agent.onGround() ? h : h - 1));
				lowestAfter.set(Math.min(lowestAfter.get(), h));
			})
			.thenExecute(() -> {
				new AgentTestSupport.Report("nav_hurt_climb").add("hurt_at", hurtAt.get()).add("highest_after", highest.get())
					.add("lowest_after", lowestAfter.get()).add("hp", agent.getHealth()).print();
				helper.assertTrue(agent.isAlive(), "alive");
				helper.assertTrue(highest.get() <= hurtAt.get(), "climbed on after the hurt: " + highest.get() + " over " + hurtAt.get());
				helper.assertTrue(lowestAfter.get() <= 2, "came down only to " + lowestAfter.get());
			})
			.thenSucceed();
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 4000)
	public void navClimbKnockedOffItsColumn(final GameTestHelper helper) {
		// The 14-log oak; with the agent 8 blocks up its pillar in the cut trunk, a hit knocks it off onto the ground
		// (gathering polish review). The climb ends (no 6 s of jumping on the spot); the next climb is not planned on top
		// of the old pillar, which no walk reaches, but beside the trunk; the rest of the tree comes down; and the old
		// pillar, whose top is out of reach from the ground, is cleared from a short Tier-2 pillar beside it.
		tree(helper, 20, 1, 16, 14);
		List<BlockPos> logs = column(helper, 20, 1, 16, 14);
		AgentPlayer agent = spawnAgent(helper, "Knocked", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 32));
		int ground = helper.absolutePos(BlockPos.ZERO).getY() + 1;
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(agent.getBlockY() - ground >= 7, "climbing, at " + agent.blockPosition().toShortString()))
			.thenExecute(() -> agent.teleportTo(agent.getX() - 6.0, ground, agent.getZ()));
		this.fellAndCheck(helper, agent, "oak_log", logs, Blocks.OAK_LOG, Items.OAK_LOG, "nav_knocked_off", null);
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 6000)
	public void navFellsBigSpruceKeepingTheDrops(final GameTestHelper helper) {
		// A 2x2 spruce, 12 high (48 logs) in a cone of needles: the top is 11 blocks over the ground. Felled whole from a
		// pillar in its cut trunk, with dirt dug nearby; at least 90% of the logs end up in the bag.
		List<BlockPos> logs = new ArrayList<>();
		for (int x = 20; x <= 21; x++) {
			for (int z = 16; z <= 17; z++) {
				fill(helper, x, 1, z, x, 12, z, Blocks.SPRUCE_LOG);
				logs.addAll(column(helper, x, 1, z, 12));
			}
		}
		for (int y = 6; y <= 13; y++) {
			int r = y == 13 ? 1 : y % 2 == 0 ? 3 : 2;
			for (int x = 20 - r; x <= 21 + r; x++) {
				for (int z = 16 - r; z <= 17 + r; z++) {
					BlockPos p = new BlockPos(x, y, z);
					if (helper.getBlockState(p).isAir() && Math.abs(x - 20.5) + Math.abs(z - 16.5) <= r + 1.5) {
						leaf(helper, p, Blocks.SPRUCE_LEAVES);
					}
				}
			}
		}
		AgentPlayer agent = spawnAgent(helper, "Spruce", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		this.fellAndCheck(helper, agent, "spruce_log", logs, Blocks.SPRUCE_LOG, Items.SPRUCE_LOG, "nav_big_spruce", null);
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 4000)
	public void navTreeWithOneBlockedLogYieldsTheRest(final GameTestHelper helper) {
		// An 8-log oak with a branch at y 3 reaching east over a 2-high obsidian block: no walk gets within reach of its
		// far end (27, 3, 16), and nothing natural leads there. That one log fails; the rest of the tree must not (the
		// miner used to stay "climbing" after one failed walk, and with no dirt gave the trunk's top up as high logs).
		tree(helper, 20, 1, 16, 8);
		fill(helper, 24, 1, 10, 31, 2, 22, Blocks.OBSIDIAN);
		for (int x = 21; x <= 27; x++) {
			helper.setBlock(new BlockPos(x, 3, 16), Blocks.OAK_LOG);
		}
		BlockPos blocked = helper.absolutePos(new BlockPos(27, 3, 16));
		List<BlockPos> logs = new ArrayList<>(column(helper, 20, 1, 16, 8));
		for (int x = 21; x <= 26; x++) {
			logs.add(helper.absolutePos(new BlockPos(x, 3, 16)));
		}
		AgentPlayer agent = spawnAgent(helper, "Blocked", AgentRole.MINER, 12, 1, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.IRON_AXE));
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("blocked"), "collect", "{\"item\":\"oak_log\",\"count\":14,\"radius\":16}", 120_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s) || "cancelled".equals(s)) {
				helper.fail("collect " + s + ": " + error(r) + " " + result(r));
			}
			helper.assertTrue("done".equals(s), "still collecting (" + s + ") at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report("nav_blocked_log").add("ticks", helper.getTick() - start).add("result", result(r)).print();
			}
			ServerLevel level = helper.getLevel();
			for (BlockPos p : logs) {
				helper.assertFalse(level.getBlockState(p).is(Blocks.OAK_LOG), "a log of the rest still stands at " + p.toShortString() + ": " + result(r));
			}
			helper.assertTrue(result(r).get("mined").getAsInt() >= logs.size(), "mined " + result(r));
			helper.assertTrue(agent.getInventory().countItem(Items.OAK_LOG) >= 12, "logs kept: " + agent.getInventory().countItem(Items.OAK_LOG));
			helper.assertTrue(level.getBlockState(blocked).is(Blocks.OAK_LOG) || result(r).get("mined").getAsInt() == logs.size() + 1,
				"the blocked log, if mined, is counted");
		});
	}

	/**
	 * Fells the tree of {@code logs} with {@code collect} and checks the whole tree came down, at least 90% of the logs
	 * were kept, the pillar and the holes dug for its scaffold are gone, and nobody got hurt; then {@code more}, if any.
	 */
	private void fellAndCheck(final GameTestHelper helper, final AgentPlayer agent, final String item, final List<BlockPos> logs, final Block logBlock,
		final net.minecraft.world.item.Item logItem, final String name, final @org.jspecify.annotations.Nullable Runnable more) {
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId(name), "collect",
			"{\"item\":\"" + item + "\",\"count\":" + logs.size() + ",\"radius\":16}", 120_000);
		ServerLevel level = helper.getLevel();
		AtomicReference<Float> lowest = new AtomicReference<>(agent.getHealth());
		AtomicInteger highest = new AtomicInteger(Integer.MIN_VALUE);
		helper.startSequence().thenExecuteFor(6000, () -> {
			lowest.set(Math.min(lowest.get(), agent.getHealth()));
			highest.set(Math.max(highest.get(), agent.getBlockY()));
		});
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s) || "cancelled".equals(s)) {
				helper.fail("collect " + s + ": " + error(r) + " " + result(r));
			}
			helper.assertTrue("done".equals(s), "still felling (" + s + ") at " + agent.blockPosition().toShortString() + ", "
				+ agent.getInventory().countItem(logItem) + " kept");
			int kept = agent.getInventory().countItem(logItem);
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report(name)
					.add("ticks", helper.getTick() - start)
					.add("logs", logs.size())
					.add("mined", result(r).get("mined"))
					.add("kept", kept)
					.add("pillared", result(r).get("pillared"))
					.add("left_high", result(r).get("logsLeftHigh"))
					.add("top_feet", highest.get() - helper.absolutePos(BlockPos.ZERO).getY())
					.add("hp_min", lowest.get())
					.print();
			}
			for (BlockPos p : logs) {
				helper.assertFalse(level.getBlockState(p).is(logBlock), "a log still stands at " + p.toShortString() + ": " + result(r));
			}
			helper.assertValueEqual(result(r).get("mined").getAsInt(), logs.size(), "logs mined");
			helper.assertTrue(kept * 10 >= logs.size() * 9, "kept " + kept + " of " + logs.size() + " logs: " + result(r));
			helper.assertValueEqual(result(r).get("kept").getAsInt(), kept, "kept, as the result says");
			// The pillar is gone and the ground is whole again: no scaffold above it, no hole in it.
			for (int x = 4; x <= 32; x++) {
				for (int z = 4; z <= 28; z++) {
					helper.assertFalse(helper.getBlockState(new BlockPos(x, 0, z)).isAir(), "a hole left at " + helper.absolutePos(new BlockPos(x, 0, z)).toShortString());
					for (int y = 1; y <= 14; y++) {
						BlockState b = helper.getBlockState(new BlockPos(x, y, z));
						helper.assertFalse(b.is(Blocks.DIRT) || b.is(Blocks.COBBLESTONE), "scaffold left at " + helper.absolutePos(new BlockPos(x, y, z)).toShortString());
					}
				}
			}
			helper.assertTrue(lowest.get() >= agent.getMaxHealth(), "hurt: hp " + lowest.get());
			if (more != null) {
				more.run();
			}
		});
	}

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navCliffOfficeHasStairsDown(final GameTestHelper helper) {
		// The office on a 6-high plateau whose edge is its porch (a cliff side): the ground in front lies 7 below the
		// porch. The builder adds stairs down (the mirror of the cut-up stairs of a sunk office): the body walks down them
		// on Tier 1 alone, unhurt, and back up to the porch; no block of the office changes.
		ServerLevel level = helper.getLevel();
		fill(helper, 0, 1, 0, 32, 6, 4 + OfficePlan.PORCH_Z, Blocks.DIRT);
		BlockPos origin = helper.absolutePos(new BlockPos(6, 7, 4));
		dev.minevibe.org.office.OfficeLayout layout = OfficeBuilder.build(level, origin, null);
		dev.minevibe.org.office.OfficeService.overrideLayout(level.getServer(), layout);
		AgentTestSupport.onTestEnd(helper, () -> dev.minevibe.org.office.OfficeService.overrideLayout(level.getServer(), null));
		List<BlockPos> office = new ArrayList<>();
		List<Block> before = new ArrayList<>();
		for (BlockPos p : BlockPos.betweenClosed(origin, origin.offset(OfficePlan.WIDTH - 1, OfficePlan.ROOF, OfficePlan.PORCH_Z))) {
			office.add(p.immutable());
			before.add(level.getBlockState(p).getBlock());
		}
		int doorX = 6 + OfficePlan.DOOR_X;
		int porchZ = 4 + OfficePlan.PORCH_Z;
		// Treads one down per block out: feet 7 (porch 8) at the first step, down to the ground's.
		for (int i = 1; i <= 6; i++) {
			int tread = 7 - i;
			for (int x = doorX - 1; x <= doorX + 1; x++) {
				helper.assertTrue(helper.getBlockState(new BlockPos(x, tread, porchZ + i)).is(Blocks.COBBLESTONE),
					"a tread at " + helper.absolutePos(new BlockPos(x, tread, porchZ + i)).toShortString());
				helper.assertTrue(helper.getBlockState(new BlockPos(x, tread + 1, porchZ + i)).isAir(), "room over the tread " + i);
			}
		}
		helper.assertTrue(helper.getBlockState(new BlockPos(doorX, 1, porchZ + 7)).isAir(), "the stairs end on the ground");
		AgentPlayer agent = spawnAgent(helper, "Cliffy", AgentRole.MINER, doorX, 8, porchZ);
		agent.brain().setEnabled(false);
		AtomicReference<Float> lowest = new AtomicReference<>(agent.getHealth());
		helper.startSequence().thenExecuteFor(600, () -> lowest.set(Math.min(lowest.get(), agent.getHealth())));
		agent.navigator().moveTo(helper.absoluteVec(new Vec3(doorX + 0.5, 1.0, porchZ + 12.5)), 1.0);
		helper.startSequence()
			.thenWaitUntil(() -> {
				AgentNavigator nav = agent.navigator();
				helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "no walking way down: " + nav.failureReason());
				helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking down, at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> agent.navigator().moveTo(helper.absoluteVec(new Vec3(doorX + 0.5, 8.0, porchZ + 0.5)), 1.0))
			.thenWaitUntil(() -> {
				AgentNavigator nav = agent.navigator();
				helper.assertTrue(nav.status() != AgentNavigator.Status.FAILED, "no walking way back up: " + nav.failureReason());
				helper.assertTrue(nav.status() == AgentNavigator.Status.ARRIVED, "walking up, at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				helper.assertValueEqual(agent.navigator().digPlans(), 0, "Tier 2 plans");
				helper.assertTrue(lowest.get() >= agent.getMaxHealth(), "hurt on the way: hp " + lowest.get());
				for (int i = 0; i < office.size(); i++) {
					Block now = level.getBlockState(office.get(i)).getBlock();
					helper.assertTrue(now == before.get(i), "office block changed at " + office.get(i).toShortString() + ": " + before.get(i) + " -> " + now);
				}
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ perf

	@GameTest(environment = NAV, structure = FIELD, maxTicks = 600)
	public void navPerfFourAgentsPlanning(final GameTestHelper helper) {
		// Four agents search for a sealed tree at once (full 20 000-node searches): each stays within 1.5 ms a tick.
		for (int x = 15; x <= 17; x++) {
			for (int z = 15; z <= 17; z++) {
				for (int y = 1; y <= 8; y++) {
					helper.setBlock(new BlockPos(x, y, z), x == 16 && z == 16 && y < 8 ? Blocks.OAK_LOG : Blocks.OBSIDIAN);
				}
			}
		}
		BlockPos log = helper.absolutePos(new BlockPos(16, 4, 16));
		int[][] at = {{3, 3}, {29, 3}, {3, 29}, {29, 29}};
		List<AgentPlayer> agents = new ArrayList<>();
		for (int i = 0; i < at.length; i++) {
			AgentPlayer a = spawnAgent(helper, "Plan" + i, AgentRole.values()[i], at[i][0], 1, at[i][1]);
			a.brain().setEnabled(false);
			a.getInventory().setItem(8, new ItemStack(Items.DIRT, 32));
			agents.add(a);
		}
		long start = helper.getTick();
		agents.forEach(a -> a.navigator().reachTrunk(log));
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			for (AgentPlayer a : agents) {
				helper.assertTrue(a.navigator().status() == AgentNavigator.Status.FAILED, a.getGameProfile().name() + " still planning");
			}
			double max = agents.stream().mapToDouble(a -> a.navigator().digMaxTickMillis()).max().orElse(0);
			double avg = agents.stream().mapToDouble(a -> a.navigator().digAvgTickMillis()).average().orElse(0);
			int over = agents.stream().mapToInt(a -> a.navigator().digTicksOverBudget()).sum();
			int ticks = agents.stream().mapToInt(a -> a.navigator().digPlanTicks()).sum();
			int nodes = agents.stream().mapToInt(a -> a.navigator().digNodes()).sum();
			double[] all = agents.stream().flatMapToDouble(a -> java.util.Arrays.stream(a.navigator().digTickMillis())).sorted().toArray();
			double median = all.length == 0 ? 0 : all[all.length / 2];
			double p90 = all.length == 0 ? 0 : all[Math.min(all.length - 1, (int)(all.length * 0.9))];
			if (reported.getAndIncrement() == 0) {
				new AgentTestSupport.Report("nav_perf")
					.add("agents", agents.size())
					.add("ticks", helper.getTick() - start)
					.add("nodes", nodes)
					.add("plan_ticks", ticks)
					.add("ms_avg_per_agent_tick", String.format(Locale.ROOT, "%.3f", avg))
					.add("ms_median", String.format(Locale.ROOT, "%.3f", median))
					.add("ms_p90", String.format(Locale.ROOT, "%.3f", p90))
					.add("ms_max_per_agent_tick", String.format(Locale.ROOT, "%.3f", max))
					.add("ticks_over_budget", over)
					.print();
			}
			// Every agent searched all it could reach (the GameTest world has no terrain beyond the loaded test area).
			helper.assertTrue(nodes >= 4 * 2_000 && ticks >= 4 * 4, "searches that span ticks (" + nodes + " nodes in " + ticks + " agent ticks)");
			// The search stops before an expansion that would not fit. A GC pause or a busy machine (a game running next
			// to the tests) still stretches a tick now and then, so the check is on the typical tick and the 90th
			// percentile, not the mean or the maximum.
			helper.assertTrue(median <= 1.5, String.format(Locale.ROOT, "median %.3f ms per agent tick exceeds the 1.5 ms budget", median));
			helper.assertTrue(p90 <= 1.5 + 0.2, String.format(Locale.ROOT, "90th percentile %.3f ms per agent tick exceeds the budget", p90));
			helper.assertTrue(over <= Math.max(2, ticks / 10), "ticks over budget: " + over + " of " + ticks);
		});
	}

	// ------------------------------------------------------------------ terrain

	static void fill(final GameTestHelper helper, final int x0, final int y0, final int z0, final int x1, final int y1, final int z1, final Block block) {
		for (int x = x0; x <= x1; x++) {
			for (int y = y0; y <= y1; y++) {
				for (int z = z0; z <= z1; z++) {
					helper.setBlock(new BlockPos(x, y, z), block);
				}
			}
		}
	}

	/** A 1-wide corridor along x at z=16 (x 2..24): 2-high glass walls at z=15 and z=17, open at both ends. */
	static void corridor(final GameTestHelper helper) {
		fill(helper, 2, 1, 15, 24, 2, 15, Blocks.GLASS);
		fill(helper, 2, 1, 17, 24, 2, 17, Blocks.GLASS);
	}

	/** An oak: a {@code height}-log trunk from {@code y}, a two-layer crown of natural leaves around its top. */
	static void tree(final GameTestHelper helper, final int x, final int y, final int z, final int height) {
		for (int i = 0; i < height; i++) {
			helper.setBlock(new BlockPos(x, y + i, z), Blocks.OAK_LOG);
		}
		int top = y + height - 1;
		for (int dy = -1; dy <= 1; dy++) {
			int r = dy == 1 ? 1 : 2;
			for (int dx = -r; dx <= r; dx++) {
				for (int dz = -r; dz <= r; dz++) {
					BlockPos p = new BlockPos(x + dx, top + dy, z + dz);
					if (helper.getBlockState(p).isAir()) {
						leaf(helper, p);
					}
				}
			}
		}
	}

	/**
	 * A natural oak leaf (not persistent) that does not decay during a test: distance 1, set without neighbour or shape
	 * updates (a shape update would recompute the distance, find no log, and let the leaf decay).
	 */
	static void leaf(final GameTestHelper helper, final BlockPos rel) {
		leaf(helper, rel, Blocks.OAK_LEAVES);
	}

	static void leaf(final GameTestHelper helper, final BlockPos rel, final Block kind) {
		BlockState leaf = kind.defaultBlockState().setValue(LeavesBlock.DISTANCE, 1).setValue(LeavesBlock.PERSISTENT, false);
		helper.getLevel().setBlock(helper.absolutePos(rel), leaf, Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
	}

	/** The absolute positions of a column of {@code height} blocks from relative (x, y, z) up. */
	static List<BlockPos> column(final GameTestHelper helper, final int x, final int y, final int z, final int height) {
		List<BlockPos> out = new ArrayList<>();
		for (int i = 0; i < height; i++) {
			out.add(helper.absolutePos(new BlockPos(x, y + i, z)));
		}
		return out;
	}
}
