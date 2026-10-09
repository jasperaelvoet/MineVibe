package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;
import static dev.minevibe.gametest.agent.NavGameTests.fill;
import static dev.minevibe.gametest.agent.SkillTestSupport.error;
import static dev.minevibe.gametest.agent.SkillTestSupport.jobId;
import static dev.minevibe.gametest.agent.SkillTestSupport.run;
import static dev.minevibe.gametest.agent.SkillTestSupport.status;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.job.Walk;
import dev.minevibe.agent.nav.AgentNavigator;
import dev.minevibe.agent.nav.DigGoal;
import dev.minevibe.agent.nav.DigPath;
import dev.minevibe.agent.nav.DigPathPlanner;
import dev.minevibe.agent.nav.DigStep;
import dev.minevibe.agent.nav.NavBlocks;
import dev.minevibe.agent.nav.WaterMoves;
import dev.minevibe.bridge.msg.Bodies;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;

/**
 * Water (PLAN 7.2 water exits, 7.3 WaterEscape): getting out of pools and pockets a swimmer cannot climb out of, never
 * breaking a block while swimming, crossing a river's current, following the player through a lake, and a job that
 * keeps leading into water failing {@code STUCK_IN_WATER} with the agent speaking up. Terrain is built on the 33x33
 * {@code nav_field}, as in {@link NavGameTests}, in a batch of their own (environment {@code water}).
 *
 * <p>Vanilla lifts a swimmer onto a bank level with the water line and never onto one a block higher (the live report:
 * the CEO in a cave pool whose ledge stood a block over the water, its brain idle).
 */
public final class WaterNavGameTests {
	private static final String FIELD = "minevibe-gametest:nav_field";
	/** Their own batch (noon, like {@code nav}), apart from the nav batch's tests and the offices some of them install. */
	private static final String WATER = "minevibe-gametest:water";
	/** Air (of 300) an agent must never drop under in these tests: nobody holds its breath for long. */
	private static final int AIR_FLOOR = 200;

	// ------------------------------------------------------------------ (a) the live report's pool

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterPoolLedgeExit(final GameTestHelper helper) {
		// A stone cave with a pool on its floor: water one deep, the ledge around it a block over the water line, the
		// ceiling 3 over the water. Ada follows the player, who stands on the ledge out of reach. No walk gets her out and
		// nothing is in her bag: WaterEscape digs a step into the ledge from the pool's bottom (standing, head dry) and
		// climbs out, then the follow goes on.
		fill(helper, 2, 1, 2, 30, 8, 30, Blocks.STONE);
		fill(helper, 6, 4, 10, 26, 5, 22, Blocks.AIR);
		fill(helper, 8, 3, 12, 13, 3, 20, Blocks.AIR);
		fill(helper, 8, 2, 12, 13, 2, 20, Blocks.WATER);
		ServerPlayer human = spawnHumanStandIn(helper, 22, 4, 16);
		AgentPlayer agent = spawnAgent(helper, "Ada", AgentRole.CEO, 10, 2, 16);
		agent.brain().setFollowTarget(human.getUUID());
		Watch watch = Watch.start(helper, agent, 1200);
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.isAlive(), "drowned");
			helper.assertFalse(agent.isInWater(), "still in the pool at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.onGround() && agent.getY() >= helper.absolutePos(new BlockPos(0, 4, 0)).getY() - 0.01, "not up on the ledge: "
				+ agent.blockPosition().toShortString());
			helper.assertTrue(agent.distanceTo(human) <= 5.0, "not back with the player: " + String.format(Locale.ROOT, "%.1f", agent.distanceTo(human)));
			if (reported.getAndIncrement() == 0) {
				watch.report("water_pool_ledge", helper.getTick() - start);
			}
			watch.assertSafe(helper);
			helper.assertTrue(watch.escapes() >= 1, "WaterEscape got it out");
			helper.assertTrue(agent.navigator().digBroken() >= 1, "dug a step (broke " + agent.navigator().digBroken() + ")");
		});
	}

	// ------------------------------------------------------------------ (b) a pocket whose way out is a 2-high step

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterPocketTwoHighStep(final GameTestHelper helper) {
		// An enclosed cave pocket, water two deep, its walls two blocks over the water line; a passage leads on from the
		// top of one wall. 8 dirt in the bag: a block put in the water to step on, a pillar block (or a step dug into the
		// wall from the dry block), and out.
		fill(helper, 2, 1, 2, 30, 12, 30, Blocks.STONE);
		fill(helper, 8, 2, 13, 12, 3, 19, Blocks.WATER);
		fill(helper, 8, 4, 13, 12, 7, 19, Blocks.AIR);
		fill(helper, 13, 6, 14, 26, 7, 18, Blocks.AIR);
		ServerPlayer human = spawnHumanStandIn(helper, 22, 6, 16);
		AgentPlayer agent = spawnAgent(helper, "Pocket", AgentRole.MINER, 10, 3, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 8));
		agent.brain().setFollowTarget(human.getUUID());
		Watch watch = Watch.start(helper, agent, 1200);
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.isAlive(), "drowned");
			helper.assertFalse(agent.isInWater(), "still in the pocket at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.getBlockX() >= helper.absolutePos(new BlockPos(13, 0, 0)).getX() && agent.onGround(), "not in the passage: "
				+ agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_pocket_step", helper.getTick() - start);
			}
			watch.assertSafe(helper);
			helper.assertTrue(watch.escapes() >= 1, "WaterEscape got it out");
			helper.assertTrue(agent.navigator().digPlaced() >= 1, "put a block in the water to step on (placed " + agent.navigator().digPlaced() + ")");
		});
	}

	// ------------------------------------------------------------------ (c) a sealed pocket

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 2400)
	public void waterSealedPocketDigsOut(final GameTestHelper helper) {
		// A water pocket sealed in dirt: water two deep, two blocks of air over it, 6 blocks of dirt and the grass above;
		// glass walls around the dirt (nothing an agent breaks) leave no way out sideways. No walk leads anywhere. Two dirt
		// in the bag: a step in the water to stand on, then a staircase dug up to the grass, from standing cells only; the
		// agent never holds its breath for long.
		fill(helper, 1, 1, 1, 31, 12, 31, Blocks.GLASS);
		fill(helper, 2, 1, 2, 30, 11, 30, Blocks.DIRT);
		fill(helper, 2, 12, 2, 30, 12, 30, Blocks.GRASS_BLOCK);
		fill(helper, 12, 2, 13, 16, 3, 19, Blocks.WATER);
		fill(helper, 12, 4, 13, 16, 5, 19, Blocks.AIR);
		AgentPlayer agent = spawnAgent(helper, "Sealed", AgentRole.MINER, 14, 3, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 2));
		// No one to follow and no job: the agent means to be on land (the walk that put it here failed).
		agent.navigator().moveTo(helper.absoluteVec(new Vec3(24.5, 13.0, 16.5)), 1.0);
		Watch watch = Watch.start(helper, agent, 2400);
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		int grass = helper.absolutePos(new BlockPos(0, 12, 0)).getY();
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.isAlive(), "drowned");
			// Out on the grass, or in the top step of its staircase (open to the sky, the grass a step up).
			helper.assertTrue(!agent.isInWater() && agent.onGround() && agent.getBlockY() >= grass && helper.getLevel().canSeeSky(agent.blockPosition()),
				"not out under the sky, at " + agent.blockPosition().toShortString() + " (" + agent.brain().activeName() + ", water " + agent.isInWater()
					+ ", ground " + agent.onGround() + ")");
			if (reported.getAndIncrement() == 0) {
				watch.report("water_sealed_pocket", helper.getTick() - start);
			}
			watch.assertSafe(helper);
			helper.assertTrue(watch.escapes() >= 1, "WaterEscape got it out");
		});
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterFloodedTunnelSwimsToAir(final GameTestHelper helper) {
		// A flooded tunnel in stone, two high, its ceiling right on the water: no air over the agent. Three blocks on it
		// opens into a cave pool with air over it and a bank level with the water line, and a dry room past the bank. The
		// escape does not wait to surface where there is no air above: it swims under the stone to the pool (within a held
		// breath) and climbs out, before the Hazard reflex is ever needed.
		fill(helper, 2, 1, 8, 30, 7, 24, Blocks.STONE);
		fill(helper, 10, 2, 15, 20, 3, 17, Blocks.WATER);
		fill(helper, 21, 2, 13, 24, 3, 19, Blocks.WATER);
		fill(helper, 21, 4, 13, 24, 5, 19, Blocks.AIR);
		fill(helper, 25, 4, 13, 29, 5, 19, Blocks.AIR);
		AgentPlayer agent = spawnAgent(helper, "Diver", AgentRole.MINER, 17, 2, 16);
		// A walk that cannot work (to the top of the stone): the agent means to be somewhere else.
		agent.navigator().moveTo(helper.absoluteVec(new Vec3(5.5, 8.0, 5.5)), 1.0);
		Watch watch = Watch.start(helper, agent, 1200);
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.isAlive(), "drowned");
			helper.assertTrue(!agent.isInWater() && agent.onGround() && agent.getBlockX() >= helper.absolutePos(new BlockPos(25, 0, 0)).getX(),
				"not out in the dry room, at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_flooded_tunnel", helper.getTick() - start);
			}
			helper.assertTrue(watch.escapes() >= 1, "WaterEscape got it out");
			// Never down to the third of its air where the Hazard reflex takes over.
			helper.assertTrue(watch.minAir() >= agent.getMaxAirSupply() / 3, "air dropped to " + watch.minAir());
			helper.assertTrue(watch.minHp() >= agent.getMaxHealth(), "hurt: hp " + watch.minHp());
		});
	}

	// ------------------------------------------------------------------ (d) following the player into a lake and out

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterFollowsPlayerThroughLake(final GameTestHelper helper) {
		// A lake two deep with banks level with the water. The player wades in to the middle, then climbs out on the far
		// side: the agent follows in, treads water beside the player (no escape: it is where it means to be), and follows
		// out again.
		fill(helper, 0, 1, 0, 32, 2, 32, Blocks.DIRT);
		fill(helper, 10, 1, 8, 22, 2, 24, Blocks.WATER);
		ServerPlayer human = spawnHumanStandIn(helper, 5, 3, 16);
		AgentPlayer agent = spawnAgent(helper, "Swimmer", AgentRole.ENGINEER, 4, 3, 13);
		agent.brain().setFollowTarget(human.getUUID());
		Watch watch = Watch.start(helper, agent, 1200);
		AtomicBoolean swam = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(1200, () -> swam.compareAndSet(false, agent.isInWater()));
		Vec3 inLake = helper.absoluteVec(new Vec3(16.5, 2.3, 16.5));
		Vec3 farBank = helper.absoluteVec(new Vec3(28.5, 3.0, 16.5));
		long start = helper.getTick();
		helper.startSequence()
			.thenExecute(() -> human.teleportTo(inLake.x, inLake.y, inLake.z))
			.thenWaitUntil(() -> helper.assertTrue(agent.isInWater() && agent.distanceTo(human) <= 4.0, "following into the lake, at "
				+ agent.blockPosition().toShortString()))
			// Some time beside the player in the water: no escape, it means to be there.
			.thenIdle(100)
			.thenExecute(() -> {
				helper.assertTrue(agent.isInWater(), "still beside the player in the water");
				helper.assertValueEqual(watch.escapes(), 0, "WaterEscape takeovers beside the player");
				human.teleportTo(farBank.x, farBank.y, farBank.z);
			})
			.thenWaitUntil(() -> {
				helper.assertFalse(agent.isInWater(), "still swimming, at " + agent.blockPosition().toShortString());
				helper.assertTrue(agent.onGround() && agent.distanceTo(human) <= 4.0, "following out, at " + agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				watch.report("water_follow_lake", helper.getTick() - start);
				helper.assertTrue(swam.get(), "swam");
				watch.assertSafe(helper);
				helper.assertValueEqual(watch.escapes(), 0, "WaterEscape takeovers");
				helper.assertFalse(watch.stuck(), "spoke up as stuck");
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ (e) a river with a current

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1000)
	public void waterCrossesFlowingRiver(final GameTestHelper helper) {
		// Land 2 high and a stream 5 wide across it, a block deep: a row of sources at its head (z=1) and flowing water
		// from there, so it runs along +z where the agent crosses (z=4, level 5 of 8). Past where the water stops, and at
		// the head, glass walls 5 high leave no dry way around. goto the far bank: the agent wades across, aiming upstream
		// so the current does not carry it off its line, and climbs out.
		fill(helper, 0, 1, 0, 32, 2, 32, Blocks.DIRT);
		fill(helper, 12, 2, 1, 16, 2, 8, Blocks.AIR);
		fill(helper, 12, 2, 1, 16, 2, 1, Blocks.WATER);
		fill(helper, 12, 2, 0, 16, 6, 0, Blocks.GLASS);
		fill(helper, 12, 2, 9, 16, 6, 32, Blocks.GLASS);
		AgentPlayer agent = spawnAgent(helper, "Rafter", AgentRole.ENGINEER, 5, 3, 4);
		Watch watch = Watch.start(helper, agent, 1000);
		AtomicReference<Double> drift = new AtomicReference<>(0.0);
		AtomicBoolean current = new AtomicBoolean();
		double line = helper.absoluteVec(new Vec3(0, 0, 4.5)).z;
		AtomicReference<CompletableFuture<Map<String, Object>>> go = new AtomicReference<>();
		long[] start = {0};
		AtomicInteger reported = new AtomicInteger();
		helper.startSequence()
			// The stream spreads 7 blocks from its sources (5 ticks a block).
			.thenIdle(60)
			.thenExecute(() -> {
				BlockPos mid = helper.absolutePos(new BlockPos(14, 2, 4));
				helper.assertTrue(WaterMoves.isWater(helper.getLevel(), mid) && !helper.getLevel().getFluidState(mid).isSource(), "flowing water at the crossing");
				start[0] = helper.getTick();
				go.set(run(helper, agent, jobId("river"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 24, 3, 4) + "}", 60_000));
			})
			.thenExecuteFor(900, () -> {
				if (agent.isInWater()) {
					drift.set(Math.max(drift.get(), Math.abs(agent.getZ() - line)));
					BlockPos feet = agent.blockPosition();
					if (helper.getLevel().getFluidState(feet).getFlow(helper.getLevel(), feet).horizontalDistanceSqr() > 0.01) {
						current.set(true);
					}
				}
			});
		helper.succeedWhen(() -> {
			CompletableFuture<Map<String, Object>> r = go.get();
			helper.assertTrue(r != null, "not started");
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("goto failed: " + error(r));
			}
			helper.assertTrue("done".equals(s), "still crossing (" + s + ") at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_river", helper.getTick() - start[0]);
				new AgentTestSupport.Report("water_river_drift").add("max_drift", String.format(Locale.ROOT, "%.2f", drift.get())).add("current", current.get()).print();
			}
			helper.assertTrue(current.get(), "swam through flowing water");
			helper.assertTrue(drift.get() <= 0.25, String.format(Locale.ROOT, "carried %.2f blocks off its line by the current", drift.get()));
			watch.assertSafe(helper);
		});
	}

	// ------------------------------------------------------------------ (f) a goto across a pond

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1400)
	public void waterGotoAcrossPondHighBank(final GameTestHelper helper) {
		// A pond two deep across the whole field; the far bank stands a block over the water line, so no swimmer climbs
		// out there and Tier 1 finds no way. goto falls back to Tier 2, which swims across and puts a dirt block in the
		// water to step out on (never breaking a block while swimming).
		fill(helper, 0, 1, 0, 32, 2, 9, Blocks.DIRT);
		fill(helper, 0, 1, 10, 0, 4, 20, Blocks.DIRT);
		fill(helper, 32, 1, 10, 32, 4, 20, Blocks.DIRT);
		fill(helper, 1, 1, 10, 31, 2, 20, Blocks.WATER);
		fill(helper, 0, 1, 21, 32, 3, 32, Blocks.DIRT);
		AgentPlayer agent = spawnAgent(helper, "Ponder", AgentRole.BUILDER, 16, 3, 5);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 8));
		Watch watch = Watch.start(helper, agent, 1400);
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("pond"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 16, 4, 25) + "}", 60_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("goto failed: " + error(r) + " " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue("done".equals(s), "still on the way (" + s + ") at " + agent.blockPosition().toShortString());
			DigPath path = agent.navigator().lastDigPath();
			if (reported.getAndIncrement() == 0) {
				watch.report("water_goto_pond", helper.getTick() - start);
				new AgentTestSupport.Report("water_goto_pond_path").add("path", path == null ? "-" : path.steps().stream().map(st -> st.kind().name()).toList()).print();
			}
			helper.assertTrue(agent.getBlockZ() >= helper.absolutePos(new BlockPos(0, 0, 21)).getZ(), "on the far bank");
			helper.assertTrue(agent.navigator().digPlans() >= 1, "Tier 2 planned the way");
			helper.assertTrue(watch.placedStep(), "stepped out of the water on a placed block");
			watch.assertSafe(helper);
		});
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1000)
	public void waterPickupAcrossPond(final GameTestHelper helper) {
		// A log lies across a pond two deep whose banks are level with the water: pickup swims there and climbs out.
		fill(helper, 0, 1, 0, 32, 2, 32, Blocks.DIRT);
		fill(helper, 0, 1, 10, 32, 2, 20, Blocks.WATER);
		fill(helper, 0, 1, 10, 0, 3, 20, Blocks.DIRT);
		fill(helper, 32, 1, 10, 32, 3, 20, Blocks.DIRT);
		ServerLevel level = helper.getLevel();
		Vec3 at = helper.absoluteVec(new Vec3(16.5, 3.05, 25.5));
		net.minecraft.world.entity.item.ItemEntity drop = new net.minecraft.world.entity.item.ItemEntity(level, at.x, at.y, at.z, new ItemStack(Items.OAK_LOG), 0, 0, 0);
		drop.setNoPickUpDelay();
		level.addFreshEntity(drop);
		AgentPlayer agent = spawnAgent(helper, "Fetch", AgentRole.MINER, 16, 3, 5);
		Watch watch = Watch.start(helper, agent, 1000);
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("pondlog"), "pickup", "{\"item\":\"oak_log\",\"radius\":32}", 60_000);
		AtomicBoolean swam = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(1000, () -> swam.compareAndSet(false, agent.isInWater()));
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			helper.assertTrue(s != null && !"failed".equals(s), "pickup " + s + (r.isDone() ? " " + error(r) : ""));
			helper.assertTrue("done".equals(s), "still fetching (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertTrue(agent.getInventory().countItem(Items.OAK_LOG) >= 1, "picked up the log");
			if (reported.getAndIncrement() == 0) {
				watch.report("water_pickup_pond", helper.getTick() - start);
			}
			helper.assertTrue(swam.get(), "swam across");
			watch.assertSafe(helper);
		});
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1600)
	public void waterCollectTreeAcrossPondHighBank(final GameTestHelper helper) {
		// An oak on the far side of a pond two deep, whose far bank stands a block over the water line. collect 2 logs: the
		// walk to the trunk (Tier 2) crosses the water and gets up the bank (a dirt block from the bag put in the water to
		// step on, or a short pillar), never breaking a block while swimming; then it fells the logs.
		fill(helper, 0, 1, 0, 32, 2, 9, Blocks.DIRT);
		fill(helper, 0, 1, 10, 0, 4, 20, Blocks.DIRT);
		fill(helper, 32, 1, 10, 32, 4, 20, Blocks.DIRT);
		fill(helper, 1, 1, 10, 31, 2, 20, Blocks.WATER);
		fill(helper, 0, 1, 21, 32, 3, 32, Blocks.DIRT);
		NavGameTests.tree(helper, 16, 4, 26, 5);
		AgentPlayer agent = spawnAgent(helper, "Logger", AgentRole.MINER, 16, 3, 5);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 4));
		Watch watch = Watch.start(helper, agent, 1600);
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("pondtree"), "collect", "{\"item\":\"oak_log\",\"count\":2,\"radius\":32}", 120_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("collect failed: " + error(r) + " " + SkillTestSupport.result(r));
			}
			helper.assertTrue("done".equals(s), "still collecting (" + s + ") at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_collect_tree_pond", helper.getTick() - start);
			}
			helper.assertTrue(agent.getInventory().countItem(Items.OAK_LOG) >= 2, "kept 2 logs: " + SkillTestSupport.result(r));
			helper.assertTrue(agent.navigator().digPlans() >= 1, "Tier 2 planned the way");
			watch.assertSafe(helper);
		});
	}

	// ------------------------------------------------------------------ (g) a job that keeps leading into water

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 3000)
	public void waterJobLoopFailsStuckInWater(final GameTestHelper helper) {
		// A moat two deep around a dirt pillar, its banks a block over the water line. The job swims out to a spot in the
		// moat beside the pillar, then walks (on foot only) to the pillar's top, which no walk reaches from the water, and
		// walks again whenever that walk fails: the loop of the live report. WaterEscape gets the agent out (a dirt step at
		// the bank, later the same step), the job resumes and leads it in again; the third time the job fails
		// STUCK_IN_WATER, and the agent speaks up (an urgency-2 stuck event with the stuck-in-water bark), then gets out once
		// more.
		fill(helper, 0, 1, 0, 32, 3, 32, Blocks.DIRT);
		fill(helper, 8, 1, 8, 24, 2, 24, Blocks.WATER);
		fill(helper, 8, 3, 8, 24, 3, 24, Blocks.AIR);
		fill(helper, 16, 1, 16, 16, 3, 16, Blocks.DIRT);
		SkillTestSupport.Recorder recorder = SkillTestSupport.recorder(helper);
		AgentPlayer agent = spawnAgent(helper, "Looper", AgentRole.MINER, 4, 4, 16);
		agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 4));
		Watch watch = Watch.start(helper, agent, 3000);
		BackIntoWater job = new BackIntoWater(helper.absoluteVec(new Vec3(13.5, 2.5, 16.5)), helper.absoluteVec(new Vec3(16.5, 4.0, 16.5)));
		agent.jobs().start(job);
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.isAlive(), "drowned");
			helper.assertTrue(job.outcome().isDone(), "the job still runs (" + watch.escapes() + " escapes) at " + agent.blockPosition().toShortString());
			SkillJob.Outcome outcome = job.outcome().join();
			helper.assertValueEqual(outcome.status(), "failed", "job status");
			helper.assertValueEqual(outcome.code(), "STUCK_IN_WATER", "failure code (" + outcome.message() + ")");
			List<Bodies.AgentEvent> stuck = recorder.events(agent.agentId(), "stuck");
			helper.assertTrue(stuck.stream().anyMatch(e -> e.urgency() == 2 && e.data() != null && e.data().has("bark")
				&& "stuck_in_water".equals(e.data().get("bark").getAsString()) && "water".equals(e.data().get("why").getAsString())),
				"an urgency-2 stuck event with the stuck-in-water bark: " + stuck);
			helper.assertTrue(recorder.invalid(agent.agentId()).isEmpty(), "every message fits the protocol: " + recorder.invalid(agent.agentId()));
			helper.assertFalse(agent.isInWater(), "out of the water in the end, at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_job_loop", helper.getTick() - start);
			}
			helper.assertTrue(watch.escapes() >= 3, "escapes: " + watch.escapes());
			watch.assertSafe(helper);
		});
	}

	/**
	 * Swims to {@code swim} (a spot in the water), then walks on foot to {@code target} and walks again whenever the walk
	 * fails; after a preemption it starts over with the swim. Never done by itself.
	 */
	static final class BackIntoWater extends SkillJob {
		private final Vec3 swim;
		private final Vec3 target;
		private final Walk walk = new Walk();
		private boolean swum;
		private int retryAt;

		BackIntoWater(final Vec3 swim, final Vec3 target) {
			super("test_back_into_water");
			this.swim = swim;
			this.target = target;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.ticks < this.retryAt) {
				return Status.RUNNING;
			}
			Walk.State s = this.walk.to(agent, this.swum ? this.target : this.swim, this.swum ? 0.5 : 0.8);
			if (!this.swum && s == Walk.State.ARRIVED) {
				this.swum = true;
				this.walk.reset();
			} else if (s == Walk.State.FAILED) {
				this.walk.reset();
				this.retryAt = this.ticks + 10;
			}
			return Status.RUNNING;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.walk.reset();
			this.swum = false;
		}
	}

	// ------------------------------------------------------------------ stranded: no way out at all

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1600)
	public void waterStrandedTreadsWaterAndSpeaksUp(final GameTestHelper helper) {
		// A well in a block of stone: water three deep, its walls three blocks over the water line, the sky open. Nothing in
		// the bag: no bank to climb, nothing to step on, no bottom to stand on and dig from. The escape finds no way out,
		// so the agent treads water at the surface (breathing), speaks up once (an urgency-2 stuck event with the
		// stuck-in-water bark) and looks again now and then. Handed two dirt blocks, its next look gets it out: a step in the
		// water, a pillar block, up onto the wall.
		fill(helper, 8, 1, 8, 24, 5, 24, Blocks.STONE);
		fill(helper, 14, 1, 14, 18, 3, 18, Blocks.WATER);
		fill(helper, 14, 4, 14, 18, 5, 18, Blocks.AIR);
		SkillTestSupport.Recorder recorder = SkillTestSupport.recorder(helper);
		ServerPlayer human = spawnHumanStandIn(helper, 3, 1, 16);
		AgentPlayer agent = spawnAgent(helper, "Well", AgentRole.CEO, 16, 3, 16);
		agent.brain().setFollowTarget(human.getUUID());
		Watch watch = Watch.start(helper, agent, 1600);
		AtomicBoolean treading = new AtomicBoolean();
		AtomicInteger stuckEvents = new AtomicInteger();
		long start = helper.getTick();
		helper.startSequence()
			.thenWaitUntil(() -> {
				helper.assertTrue(this.waterStuck(recorder, agent).size() == 1, "spoke up: " + recorder.events(agent.agentId(), "stuck"));
				helper.assertValueEqual(agent.brain().activeName(), "stranded_in_water", "the active reflex");
			})
			// Stranded a while: the head stays above the water, nothing more is said, the escape looks again (silently).
			.thenExecuteFor(400, () -> treading.compareAndSet(false, "stranded_in_water".equals(agent.brain().activeName()) && !agent.isUnderWater()))
			.thenExecute(() -> {
				helper.assertTrue(WaterMoves.swimming(agent), "still in the well");
				helper.assertTrue(treading.get(), "treading water at the surface");
				stuckEvents.set(this.waterStuck(recorder, agent).size());
				helper.assertValueEqual(stuckEvents.get(), 1, "times it spoke up while stranded");
				helper.assertTrue(watch.escapes() >= 2, "looked again: " + watch.escapes() + " escapes");
				agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 2));
			})
			.thenWaitUntil(() -> {
				helper.assertFalse(agent.isInWater(), "still in the well at " + agent.blockPosition().toShortString());
				helper.assertTrue(agent.onGround() && agent.getBlockY() >= helper.absolutePos(new BlockPos(0, 6, 0)).getY(), "not up on the stone at "
					+ agent.blockPosition().toShortString());
			})
			.thenExecute(() -> {
				watch.report("water_stranded", helper.getTick() - start);
				watch.assertSafe(helper);
				helper.assertTrue(agent.navigator().digPlaced() >= 2, "a step and a pillar block (placed " + agent.navigator().digPlaced() + ")");
				helper.assertTrue(recorder.invalid(agent.agentId()).isEmpty(), "every message fits the protocol: " + recorder.invalid(agent.agentId()));
			})
			.thenSucceed();
	}

	private List<Bodies.AgentEvent> waterStuck(final SkillTestSupport.Recorder recorder, final AgentPlayer agent) {
		return recorder.events(agent.agentId(), "stuck").stream()
			.filter(e -> e.urgency() == 2 && e.data() != null && e.data().has("why") && "water".equals(e.data().get("why").getAsString()))
			.toList();
	}

	// ------------------------------------------------------------------ Tier 1 stays out of water with no way out

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterFollowStaysOutOfDeadEndPool(final GameTestHelper helper) {
		// A pool two deep across the field; past it a stone ledge three high, where the player stands: no walk reaches the
		// player. The path vanilla finds toward the player ends in the water at the foot of the ledge, a dead end (no bank
		// there is low enough to climb out on). Following, the agent walks to the near bank and stops there, never setting
		// foot in the water; after a few failed walks it speaks up (an urgency-2 stuck event with the stuck bark).
		fill(helper, 0, 1, 0, 32, 2, 32, Blocks.DIRT);
		fill(helper, 10, 1, 0, 18, 2, 32, Blocks.WATER);
		fill(helper, 19, 1, 0, 32, 5, 32, Blocks.STONE);
		SkillTestSupport.Recorder recorder = SkillTestSupport.recorder(helper);
		ServerPlayer human = spawnHumanStandIn(helper, 24, 6, 16);
		AgentPlayer agent = spawnAgent(helper, "Shore", AgentRole.CEO, 4, 3, 16);
		agent.brain().setFollowTarget(human.getUUID());
		Watch watch = Watch.start(helper, agent, 1200);
		AtomicBoolean wet = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(1200, () -> wet.compareAndSet(false, agent.isInWater()));
		long start = helper.getTick();
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			helper.assertFalse(wet.get(), "waded into the pool");
			List<Bodies.AgentEvent> stuck = recorder.events(agent.agentId(), "stuck").stream()
				.filter(e -> e.urgency() == 2 && e.data() != null && e.data().has("bark") && "stuck".equals(e.data().get("bark").getAsString())
					&& "nav".equals(e.data().get("why").getAsString()))
				.toList();
			helper.assertFalse(stuck.isEmpty(), "spoke up as stuck: " + recorder.events(agent.agentId(), "stuck"));
			helper.assertTrue(agent.getBlockX() >= helper.absolutePos(new BlockPos(7, 0, 0)).getX(), "walked up to the bank, at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_dead_end_follow", helper.getTick() - start);
			}
			helper.assertValueEqual(watch.escapes(), 0, "WaterEscape takeovers");
			helper.assertTrue(recorder.invalid(agent.agentId()).isEmpty(), "every message fits the protocol: " + recorder.invalid(agent.agentId()));
		});
	}

	// ------------------------------------------------------------------ the planner alone

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 20)
	public void waterPlannerNeverBreaksWhileSwimming(final GameTestHelper helper) {
		// DEBT's drowning: a water pocket under a dirt roof, nothing in the bag. From two-deep water no plan breaks a block
		// (the roof was broken while swimming, 25 times slower, until the agent drowned): no way out. In a pool one deep the
		// planner digs, but only from the bottom with the head above the water.
		ServerLevel level = helper.getLevel();
		fill(helper, 2, 1, 2, 30, 8, 30, Blocks.DIRT);
		fill(helper, 10, 2, 10, 14, 3, 14, Blocks.WATER);
		fill(helper, 10, 4, 10, 14, 4, 14, Blocks.AIR);
		AgentPlayer agent = spawnAgent(helper, "Roofed", AgentRole.MINER, 2, 9, 2);
		agent.brain().setEnabled(false);
		BlockPos from = helper.absolutePos(new BlockPos(12, 3, 12));
		DigGoal up = DigGoal.near(helper.absoluteVec(new Vec3(20.5, 9.0, 20.5)), 1.0);
		DigPathPlanner deep = new DigPathPlanner(level, agent.getInventory(), from, up, DigPathPlanner.Config.standard(20.0F, 0), new LongOpenHashSet());
		helper.assertTrue(deep.runToEnd() == DigPathPlanner.State.FAILED, "a way out of two-deep water: " + deep.path());
		// One deep: the bottom at y=2.
		fill(helper, 10, 2, 10, 14, 2, 14, Blocks.DIRT);
		BlockPos shallow = helper.absolutePos(new BlockPos(12, 3, 12));
		DigPathPlanner dig = new DigPathPlanner(level, agent.getInventory(), shallow, up, DigPathPlanner.Config.standard(20.0F, 0), new LongOpenHashSet());
		helper.assertTrue(dig.runToEnd() == DigPathPlanner.State.FOUND, "a way out of one-deep water: " + dig.failure());
		for (DigStep step : dig.path().steps()) {
			if (step.breaks().isEmpty()) {
				continue;
			}
			BlockPos f = step.from();
			if (WaterMoves.isWater(level, f)) {
				helper.assertFalse(WaterMoves.isWater(level, f.above()), "broke with the head under water: " + step);
				helper.assertTrue(level.getBlockState(f.below()).isSolid(), "broke while swimming (no bottom underfoot): " + step);
			}
		}
		helper.assertTrue(dig.path().steps().stream().anyMatch(st -> st.kind() == DigStep.Kind.EXIT_WATER), "climbed out: " + dig.path().steps());
		helper.succeed();
	}

	// ------------------------------------------------------------------ review: survival, false escapes, help, rare blocks

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1600)
	public void waterEscapeLetsCriticalHealEat(final GameTestHelper helper) {
		// The live report's pool: the escape digs a step into the stone ledge by hand (7.5 s). Hurt to 5 HP while it digs,
		// with bread in the bag, the agent eats at once (critical heal, priority 90, outranks the escape), then the escape
		// goes on and gets it out.
		fill(helper, 2, 1, 2, 30, 8, 30, Blocks.STONE);
		fill(helper, 6, 4, 10, 26, 5, 22, Blocks.AIR);
		fill(helper, 8, 3, 12, 13, 3, 20, Blocks.AIR);
		fill(helper, 8, 2, 12, 13, 2, 20, Blocks.WATER);
		ServerPlayer human = spawnHumanStandIn(helper, 22, 4, 16);
		AgentPlayer agent = spawnAgent(helper, "Hungry", AgentRole.CEO, 10, 2, 16);
		agent.getInventory().setItem(0, new ItemStack(Items.BREAD, 4));
		agent.brain().setFollowTarget(human.getUUID());
		AtomicBoolean ate = new AtomicBoolean();
		int ledge = helper.absolutePos(new BlockPos(0, 4, 0)).getY();
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue("water_escape".equals(agent.brain().activeName()) && agent.controls().isMining(),
				"digging its way out (" + agent.brain().activeName() + ")"))
			.thenExecute(() -> {
				agent.setHealth(5.0F);
				agent.getFoodData().setFoodLevel(10);
			})
			.thenExecuteFor(40, () -> ate.compareAndSet(false, "critical_heal".equals(agent.brain().activeName())))
			.thenExecute(() -> helper.assertTrue(ate.get(), "ate at 5 HP within 2 s (the active reflex stayed " + agent.brain().activeName() + ")"))
			.thenWaitUntil(() -> {
				helper.assertFalse(agent.isInWater(), "still in the pool at " + agent.blockPosition().toShortString());
				helper.assertTrue(agent.onGround() && agent.getY() >= ledge - 0.01, "not up on the ledge: " + agent.blockPosition().toShortString());
			})
			.thenSucceed();
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1200)
	public void waterJobDigsStepWithoutFalseEscape(final GameTestHelper helper) {
		// goto out of the live report's pool onto the cave floor: Tier 2 digs a step into the stone ledge by hand from the
		// pool's bottom (7.5 s standing still in the water). The body breaking a block for its walk is progress: no
		// WaterEscape takeover (each counts toward STUCK_IN_WATER for the job).
		fill(helper, 2, 1, 2, 30, 8, 30, Blocks.STONE);
		fill(helper, 6, 4, 10, 26, 5, 22, Blocks.AIR);
		fill(helper, 8, 3, 12, 13, 3, 20, Blocks.AIR);
		fill(helper, 8, 2, 12, 13, 2, 20, Blocks.WATER);
		AgentPlayer agent = spawnAgent(helper, "Digger", AgentRole.MINER, 10, 2, 16);
		Watch watch = Watch.start(helper, agent, 1200);
		long start = helper.getTick();
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("ledge"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 22, 4, 16) + "}", 60_000);
		AtomicInteger reported = new AtomicInteger();
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("goto failed: " + error(r));
			}
			helper.assertTrue("done".equals(s), "still on the way (" + s + ") at " + agent.blockPosition().toShortString());
			if (reported.getAndIncrement() == 0) {
				watch.report("water_job_digs_step", helper.getTick() - start);
			}
			helper.assertTrue(agent.navigator().digBroken() >= 1, "dug a step (broke " + agent.navigator().digBroken() + ")");
			helper.assertValueEqual(watch.escapes(), 0, "WaterEscape takeovers while the job dug its step");
			watch.assertSafe(helper);
		});
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1600)
	public void waterStrandedPicksUpTossedBlocks(final GameTestHelper helper) {
		// The well of the stranded test. Once stranded, the player's help lands two blocks off (dirt tossed into the water):
		// the agent swims over and picks it up (the pickup reflex is not held off by treading water), looks again at once,
		// and climbs out on it.
		fill(helper, 8, 1, 8, 24, 5, 24, Blocks.STONE);
		fill(helper, 14, 1, 14, 18, 3, 18, Blocks.WATER);
		fill(helper, 14, 4, 14, 18, 5, 18, Blocks.AIR);
		ServerPlayer human = spawnHumanStandIn(helper, 3, 1, 16);
		AgentPlayer agent = spawnAgent(helper, "Helped", AgentRole.CEO, 16, 3, 16);
		agent.brain().setFollowTarget(human.getUUID());
		long[] tossed = {0};
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue("stranded_in_water".equals(agent.brain().activeName()), "stranded (" + agent.brain().activeName() + ")"))
			.thenExecute(() -> {
				Vec3 at = helper.absoluteVec(new Vec3(14.5, 3.2, 14.5));
				net.minecraft.world.entity.item.ItemEntity dirt = new net.minecraft.world.entity.item.ItemEntity(helper.getLevel(), at.x, at.y, at.z,
					new ItemStack(Items.DIRT, 2), 0, 0, 0);
				dirt.setPickUpDelay(10);
				helper.getLevel().addFreshEntity(dirt);
				tossed[0] = helper.getTick();
			})
			.thenWaitUntil(() -> helper.assertTrue(agent.getInventory().countItem(Items.DIRT) > 0 || agent.navigator().digPlaced() > 0,
				"picked up the dirt tossed two blocks off"))
			.thenWaitUntil(() -> {
				helper.assertFalse(agent.isInWater(), "still in the well at " + agent.blockPosition().toShortString());
				helper.assertTrue(agent.onGround() && agent.getBlockY() >= helper.absolutePos(new BlockPos(0, 6, 0)).getY(), "not up on the stone at "
					+ agent.blockPosition().toShortString());
			})
			.thenExecute(() -> helper.assertTrue(helper.getTick() - tossed[0] <= 400, "out " + (helper.getTick() - tossed[0]) + " ticks after the toss"))
			.thenSucceed();
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 1400)
	public void waterStepSparesPreciousBlocks(final GameTestHelper helper) {
		// The pond with the high far bank, no scaffold in the bag: white wool first in the bag, oak planks after it. The
		// step put in the water is the planks (the plainer block); the wool is kept.
		fill(helper, 0, 1, 0, 32, 2, 9, Blocks.DIRT);
		fill(helper, 0, 1, 10, 0, 4, 20, Blocks.DIRT);
		fill(helper, 32, 1, 10, 32, 4, 20, Blocks.DIRT);
		fill(helper, 1, 1, 10, 31, 2, 20, Blocks.WATER);
		fill(helper, 0, 1, 21, 32, 3, 32, Blocks.DIRT);
		AgentPlayer agent = spawnAgent(helper, "Thrifty", AgentRole.BUILDER, 16, 3, 5);
		agent.getInventory().setItem(0, new ItemStack(Items.WOOL.pick(DyeColor.WHITE), 1));
		agent.getInventory().setItem(1, new ItemStack(Items.OAK_PLANKS, 1));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("thrift"), "goto", "{\"pos\":" + SkillTestSupport.rel(helper, 16, 4, 25) + "}", 60_000);
		helper.succeedWhen(() -> {
			String s = status(r);
			if ("failed".equals(s)) {
				helper.fail("goto failed: " + error(r));
			}
			helper.assertTrue("done".equals(s), "still on the way (" + s + ") at " + agent.blockPosition().toShortString());
			helper.assertValueEqual(agent.getInventory().countItem(Items.WOOL.pick(DyeColor.WHITE)), 1, "wool kept");
			helper.assertValueEqual(agent.getInventory().countItem(Items.OAK_PLANKS), 0, "planks used as the step");
		});
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 2400)
	public void waterStrandedAgainSpeaksUpAgain(final GameTestHelper helper) {
		// The well of the stranded test: stranded, the agent speaks up; handed two dirt, it climbs out. Back in the well a
		// moment later (its step and pillar block gone again, nothing left in the bag), it is stranded anew and says so at
		// once: a new stranding is never kept quiet by the last one (it waited 5 minutes before the review).
		fill(helper, 8, 1, 8, 24, 5, 24, Blocks.STONE);
		fill(helper, 14, 1, 14, 18, 3, 18, Blocks.WATER);
		fill(helper, 14, 4, 14, 18, 5, 18, Blocks.AIR);
		ServerPlayer human = spawnHumanStandIn(helper, 3, 1, 16);
		AgentPlayer agent = spawnAgent(helper, "Twice", AgentRole.CEO, 16, 3, 16);
		agent.brain().setFollowTarget(human.getUUID());
		AtomicInteger spoke = new AtomicInteger();
		AgentEvents.addListener(e -> {
			if (e.agentId().equals(agent.agentId()) && "nav.stuck_in_water".equals(e.type())) {
				spoke.incrementAndGet();
			}
		});
		long[] first = {0};
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertValueEqual(spoke.get(), 1, "times it spoke up"))
			.thenExecute(() -> {
				first[0] = helper.getTick();
				agent.getInventory().setItem(8, new ItemStack(Items.DIRT, 2));
			})
			.thenWaitUntil(() -> helper.assertTrue(!agent.isInWater() && agent.onGround() && agent.getBlockY() >= helper.absolutePos(new BlockPos(0, 6, 0)).getY(),
				"not out on the stone, at " + agent.blockPosition().toShortString()))
			.thenExecute(() -> {
				helper.assertValueEqual(spoke.get(), 1, "times it spoke up before it got out");
				fill(helper, 14, 1, 14, 18, 3, 18, Blocks.WATER);
				fill(helper, 14, 4, 14, 18, 5, 18, Blocks.AIR);
				Vec3 in = helper.absoluteVec(new Vec3(16.5, 3.0, 16.5));
				agent.teleportTo(in.x, in.y, in.z);
			})
			.thenWaitUntil(() -> helper.assertValueEqual(spoke.get(), 2, "times it spoke up (the second stranding)"))
			// Well within the 5 minutes (6000 ticks) a repeat about the same stranding waits.
			.thenExecute(() -> helper.assertTrue(helper.getTick() - first[0] < 2000, "said " + (helper.getTick() - first[0]) + " ticks after the first time"))
			.thenSucceed();
	}

	@GameTest(environment = WATER, structure = FIELD, maxTicks = 20)
	public void waterStepItemsArePlainBlocks(final GameTestHelper helper) {
		// What an agent stuck in water may put down to step on (PLAN 7.2 "Water"): plain full cubes, the plainest first;
		// never ores, metal or gem blocks, containers, falling blocks, slabs, leaves or glazed terracotta.
		for (Item item : List.of(Items.DIRT, Items.COBBLESTONE, Items.ROOTED_DIRT, Items.STONE, Items.DEEPSLATE, Items.OAK_PLANKS, Items.SPRUCE_LOG,
			Items.STONE_BRICKS, Items.TERRACOTTA, Items.WOOL.pick(DyeColor.WHITE))) {
			helper.assertTrue(NavBlocks.isStepItem(new ItemStack(item)), item + " is a step");
		}
		for (Item item : List.of(Items.IRON_ORE, Items.DIAMOND_ORE, Items.DEEPSLATE_GOLD_ORE, Items.IRON_BLOCK, Items.GOLD_BLOCK, Items.DIAMOND_BLOCK,
			Items.EMERALD_BLOCK, Items.COAL_BLOCK, Items.CHEST, Items.FURNACE, Items.CRAFTING_TABLE, Items.SAND, Items.GRAVEL, Items.MAGMA_BLOCK,
			Items.OAK_LEAVES, Items.OAK_SLAB, Items.OAK_STAIRS, Items.GLASS, Items.TNT, Items.MUD, Items.OBSIDIAN, Items.BREAD,
			Items.GLAZED_TERRACOTTA.pick(DyeColor.BLUE), Items.WOOL_SLAB.pick(DyeColor.WHITE))) {
			helper.assertFalse(NavBlocks.isStepItem(new ItemStack(item)), item + " is no step");
			helper.assertValueEqual(NavBlocks.stepRank(new ItemStack(item)), Integer.MAX_VALUE, item + " step rank");
		}
		List<Item> order = List.of(Items.COBBLESTONE, Items.ROOTED_DIRT, Items.BASALT, Items.OAK_PLANKS, Items.OAK_LOG, Items.MOSSY_STONE_BRICKS,
			Items.DYED_TERRACOTTA.pick(DyeColor.RED), Items.WOOL.pick(DyeColor.WHITE));
		for (int i = 1; i < order.size(); i++) {
			helper.assertTrue(NavBlocks.stepRank(new ItemStack(order.get(i - 1))) < NavBlocks.stepRank(new ItemStack(order.get(i))),
				order.get(i - 1) + " goes before " + order.get(i));
		}
		helper.succeed();
	}

	// ------------------------------------------------------------------ watching

	/** Per-tick watch over an agent: lowest air and health, mining while swimming, WaterEscape takeovers, steps placed. */
	static final class Watch {
		private final AgentPlayer agent;
		private int minAir = Integer.MAX_VALUE;
		private float minHp = Float.MAX_VALUE;
		private int swimMining;
		private String swimMiningAt = "";
		private boolean stepPlanned;
		private final long sinceTime;

		private Watch(final AgentPlayer agent, final long sinceTime) {
			this.agent = agent;
			this.sinceTime = sinceTime;
		}

		static Watch start(final GameTestHelper helper, final AgentPlayer agent, final int ticks) {
			Watch w = new Watch(agent, agent.level().getGameTime());
			helper.startSequence().thenExecuteFor(ticks, () -> {
				w.minAir = Math.min(w.minAir, agent.getAirSupply());
				w.minHp = Math.min(w.minHp, agent.getHealth());
				if (agent.controls().isMining() && agent.isInWater() && !WaterMoves.standingInWater(agent)) {
					w.swimMining++;
					w.swimMiningAt = agent.blockPosition().toShortString();
				}
				DigPath p = agent.navigator().lastDigPath();
				if (p != null && p.steps().stream().anyMatch(st -> st.kind() == DigStep.Kind.EXIT_WATER && st.place() != null)) {
					w.stepPlanned = true;
				}
			});
			return w;
		}

		private List<AgentEvents.Event> events(final String type) {
			return AgentEvents.recent(this.agent.agentId()).stream().filter(e -> e.type().equals(type) && e.gameTime() >= this.sinceTime).toList();
		}

		int minAir() {
			return this.minAir;
		}

		float minHp() {
			return this.minHp;
		}

		int escapes() {
			return this.events("water.escape").size();
		}

		boolean stuck() {
			return !this.events("event.stuck").isEmpty();
		}

		/** True once a Tier-2 path stepped out of the water on a block it put there, and a block was placed. */
		boolean placedStep() {
			return this.stepPlanned && this.agent.navigator().digPlaced() >= 1;
		}

		void assertSafe(final GameTestHelper helper) {
			helper.assertTrue(this.minAir >= AIR_FLOOR, "air dropped to " + this.minAir);
			helper.assertTrue(this.minHp >= this.agent.getMaxHealth(), "hurt: hp " + this.minHp);
			helper.assertValueEqual(this.swimMining, 0, "ticks mining while swimming (last at " + this.swimMiningAt + ")");
		}

		void report(final String name, final long ticks) {
			AgentNavigator nav = this.agent.navigator();
			new AgentTestSupport.Report(name)
				.add("ticks", ticks)
				.add("escapes", this.escapes())
				.add("air_min", this.minAir)
				.add("hp_min", this.minHp)
				.add("dig_plans", nav.digPlans())
				.add("dig_nodes", nav.digNodes())
				.add("broken", nav.digBroken())
				.add("placed", nav.digPlaced())
				.add("plan_ms_max_tick", String.format(Locale.ROOT, "%.3f", nav.digMaxTickMillis()))
				.add("path", nav.lastDigPath() == null ? "-" : nav.lastDigPath().steps().stream().map(st -> st.kind().name()).toList())
				.print();
		}
	}
}
