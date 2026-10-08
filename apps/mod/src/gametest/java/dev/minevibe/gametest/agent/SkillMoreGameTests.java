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

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.brain.IdleMode;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.agent.skill.SkillService;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.agent.skill.seat.SimplePcRegistry;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Seats.AgentSeat;
import dev.minevibe.bridge.msg.Seats.AgentUnseat;
import dev.minevibe.bridge.msg.Seats.SeatTarget;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ThreadLocalRandom;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.vehicle.boat.Boat;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;

/** More skill GameTests: blueprints, riding, places, the attend / shelter / pickup / unseat reflexes, seat limits. */
public final class SkillMoreGameTests {
	private static final String ARENA = "minevibe-gametest:arena";
	private static final String DAY = "minevibe-gametest:day";
	private static final String DUSK = "minevibe-gametest:dusk";
	/** Batches of their own: seat tests share the seat cap, and the reconnect test detaches every waiting reply. */
	private static final String SEAT_SURVIVE = "minevibe-gametest:seat_survive";
	private static final String SEAT_FEED = "minevibe-gametest:seat_feed";
	private static final String RECONNECT = "minevibe-gametest:reconnect";

	private static void assertDone(final GameTestHelper helper, final CompletableFuture<Map<String, Object>> reply, final String what) {
		String s = status(reply);
		if ("failed".equals(s) || "cancelled".equals(s)) {
			helper.fail(what + " " + s + ": " + error(reply) + " " + result(reply));
		}
		helper.assertTrue("done".equals(s), what + " not done yet (" + s + ")");
	}

	private static String pcId() {
		return "pc-" + Long.toString(ThreadLocalRandom.current().nextLong(1_000_000_000L), 36);
	}

	@GameTest(structure = ARENA, maxTicks = 2500)
	public void skillBuildWallRing(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Waller", AgentRole.BUILDER, 8, 1, 8);
		agent.getInventory().setItem(0, new ItemStack(Items.COBBLESTONE, 64));
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("ring"), "build", "{\"blueprint\":\"wall_ring\",\"origin\":" + rel(helper, 8, 1, 8) + "}", 120_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "build wall_ring");
			int walls = 0;
			for (int y = 1; y <= 2; y++) {
				for (int x = 4; x <= 12; x++) {
					for (int z = 4; z <= 12; z++) {
						if ((x == 4 || x == 12 || z == 4 || z == 12) && helper.getBlockState(new BlockPos(x, y, z)).is(Blocks.COBBLESTONE)) {
							walls++;
						}
					}
				}
			}
			helper.assertValueEqual(walls, 64, "ring blocks");
			helper.assertValueEqual(Inv.count(agent, Items.COBBLESTONE), 0, "cobblestone used");
		});
	}

	@GameTest(maxTicks = 300)
	public void skillRideAndDismount(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Rider", AgentRole.ENGINEER, 1, 0, 1);
		Boat boat = helper.spawn(EntityTypes.OAK_BOAT, new BlockPos(5, 0, 5));
		CompletableFuture<Map<String, Object>> ride = run(helper, agent, jobId("ride"), "ride", "{\"entity\":\"minecraft:oak_boat\"}", 60_000);
		java.util.concurrent.atomic.AtomicReference<CompletableFuture<Map<String, Object>>> off = new java.util.concurrent.atomic.AtomicReference<>();
		helper.startSequence()
			.thenWaitUntil(() -> assertDone(helper, ride, "ride"))
			.thenExecute(() -> {
				helper.assertTrue(agent.getVehicle() == boat, "in the boat");
				off.set(run(helper, agent, jobId("off"), "dismount", "{}", 60_000));
			})
			.thenWaitUntil(() -> assertDone(helper, off.get(), "dismount"))
			.thenExecute(() -> helper.assertFalse(agent.isPassenger(), "out of the boat"))
			.thenSucceed();
	}

	@GameTest(structure = ARENA, maxTicks = 600)
	public void skillGotoNamedPlaces(final GameTestHelper helper) {
		helper.setBlock(new BlockPos(12, 1, 12), Blocks.CRAFTING_TABLE);
		AgentPlayer agent = spawnAgent(helper, "Visitor", AgentRole.ENGINEER, 3, 1, 3);
		CompletableFuture<Map<String, Object>> r = run(helper, agent, jobId("table"), "goto", "{\"entity\":\"crafting_table\",\"range\":2}", 60_000);
		CompletableFuture<Map<String, Object>> none = run(helper, spawnAgent(helper, "Lost", AgentRole.ENGINEER, 3, 1, 12), jobId("pc"), "goto", "{\"entity\":\"pc:no-such-pc\"}", 60_000);
		helper.succeedWhen(() -> {
			assertDone(helper, r, "goto crafting_table");
			helper.assertTrue(agent.position().distanceTo(helper.absoluteVec(new Vec3(12.5, 1, 12.5))) <= 3.0, "at the table");
			helper.assertTrue("failed".equals(status(none)) && error(none).contains("NOT_FOUND"), "an unknown pc fails: " + status(none));
		});
	}

	@GameTest(structure = ARENA, maxTicks = 600)
	public void reflexAttendsAScheduledTask(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Scheduled", AgentRole.FARMER, 2, 1, 2);
		agent.brain().setMode(IdleMode.STAY, null);
		BlockPos target = helper.absolutePos(new BlockPos(13, 1, 13));
		service(helper).calendarFired(new Org.CalendarFired("ev-1", 1, "task", "Farm wheat", List.of(agent.agentId()),
			new Types.Place(Refs.wire(target), helper.getLevel().dimension().identifier().toString()), List.of(agent.agentId())));
		helper.succeedWhen(() -> {
			helper.assertTrue(recorder(helper).events(agent.agentId(), "arrived").stream().anyMatch(e -> e.text().contains("Farm wheat")), "arrived at the task");
			helper.assertTrue(agent.brain().attend() == null, "the walk is over");
		});
	}

	@GameTest(environment = DUSK, structure = ARENA, maxTicks = 600)
	public void reflexSheltersAtDusk(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Homebody", AgentRole.MINER, 2, 1, 2);
		agent.brain().setMode(IdleMode.WANDER, null);
		agent.brain().setHome(helper.absolutePos(new BlockPos(13, 1, 13)));
		helper.succeedWhen(() -> helper.assertTrue(agent.position().distanceTo(helper.absoluteVec(new Vec3(13.5, 1, 13.5))) <= 3.0,
			"home for the night: " + agent.blockPosition() + " " + agent.brain().activeName()));
	}

	@GameTest(maxTicks = 300)
	public void reflexPicksUpLooseItems(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Tidy", AgentRole.FARMER, 2, 0, 2);
		ServerLevel level = helper.getLevel();
		Vec3 at = helper.absoluteVec(new Vec3(5.5, 0.2, 5.5));
		level.addFreshEntity(new ItemEntity(level, at.x, at.y, at.z, new ItemStack(Items.APPLE, 3)));
		helper.succeedWhen(() -> {
			helper.assertValueEqual(Inv.count(agent, Items.APPLE), 3, "apples picked up");
			helper.assertTrue(recorder(helper).events(agent.agentId(), "picked_up").size() >= 1, "agent.event picked_up");
		});
	}

	@GameTest(environment = SEAT_SURVIVE, maxTicks = 300)
	public void seatedAgentUnseatsToSurvive(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		SimplePcRegistry pcs = (SimplePcRegistry)Seats.pcs();
		String pcId = pcId();
		helper.setBlock(new BlockPos(3, 0, 3), MvWorldContent.OFFICE_CHAIR.defaultBlockState());
		pcs.register(pcId, level.dimension(), helper.absolutePos(new BlockPos(3, 0, 3)));
		AgentTestSupport.onTestEnd(helper, () -> pcs.unregister(pcId));
		AgentPlayer agent = spawnAgent(helper, "Starving", AgentRole.ENGINEER, 3, 0, 1);
		SkillService service = service(helper);
		service.seat(new AgentSeat(agent.agentId(), jobId("sit"), 1, SeatTarget.pc(pcId), null));
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(service.seated(agent.agentId()) != null, "seated"))
			.thenExecute(() -> agent.getFoodData().setFoodLevel(4))
			.thenWaitUntil(() -> {
				var unseats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, s -> s.pcId().equals(pcId));
				helper.assertTrue(!unseats.isEmpty(), "pc.unseat not sent");
				helper.assertValueEqual(unseats.getFirst().reason(), "survival", "reason");
				helper.assertFalse(agent.isPassenger(), "standing");
			})
			.thenSucceed();
	}

	/** Feeding the player (55) or a teammate (50) never pulls an agent off its PC chair; only survival (47) or a fight (45) do. */
	@GameTest(environment = SEAT_FEED, maxTicks = 300)
	public void seatedAgentDoesNotStandUpToFeedOthers(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		SimplePcRegistry pcs = (SimplePcRegistry)Seats.pcs();
		String pcId = pcId();
		helper.setBlock(new BlockPos(3, 0, 3), MvWorldContent.OFFICE_CHAIR.defaultBlockState());
		pcs.register(pcId, level.dimension(), helper.absolutePos(new BlockPos(3, 0, 3)));
		AgentTestSupport.onTestEnd(helper, () -> pcs.unregister(pcId));
		AgentPlayer agent = spawnAgent(helper, "Busy", AgentRole.ENGINEER, 3, 0, 1);
		agent.getInventory().setItem(0, new ItemStack(Items.BREAD, 8));
		ServerPlayer human = spawnHumanStandIn(helper, 6, 0, 6);
		agent.brain().setFollowTarget(human.getUUID());
		AgentPlayer hungry = spawnAgent(helper, "Starved", AgentRole.MINER, 1, 0, 6);
		SkillService service = service(helper);
		service.seat(new AgentSeat(agent.agentId(), jobId("sit"), 1, SeatTarget.pc(pcId), null));
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(service.seated(agent.agentId()) != null, "seated"))
			.thenExecute(() -> {
				human.getFoodData().setFoodLevel(6);
				hungry.getFoodData().setFoodLevel(3);
				hungry.getFoodData().setSaturation(0.0F);
			})
			.thenIdle(80)
			.thenExecute(() -> {
				helper.assertTrue(agent.isPassenger() && service.seated(agent.agentId()) != null, "still seated: " + agent.brain().activeName());
				helper.assertTrue(recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_UNSEAT, u -> u.pcId().equals(pcId)).isEmpty(), "no pc.unseat");
				helper.assertValueEqual(Inv.count(agent, Items.BREAD), 8, "no bread tossed from the chair");
			})
			.thenSucceed();
	}

	/**
	 * A bridge reconnect while {@code skill.run} waits: the reply can no longer reach Node, so the outcome follows as
	 * {@code skill.result}; a job that ends while Node is away is reported on the next handshake.
	 */
	@GameTest(environment = RECONNECT, maxTicks = 300)
	public void jobOutcomesSurviveABridgeReconnect(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Patient", AgentRole.ENGINEER, 2, 0, 2);
		SkillService service = service(helper);
		SkillTestSupport.Recorder recorder = recorder(helper);
		AgentTestSupport.onTestEnd(helper, () -> recorder.setConnected(true));
		String first = jobId("wave");
		CompletableFuture<Map<String, Object>> r1 = run(helper, agent, first, "emote", "{\"kind\":\"wave\"}", 60_000);
		java.util.concurrent.atomic.AtomicReference<String> second = new java.util.concurrent.atomic.AtomicReference<>();
		helper.assertTrue(status(r1) == null, "waiting for the emote");
		service.connectionLost();
		helper.assertValueEqual(status(r1), "running", "a waiting reply is released when the connection drops");
		helper.startSequence()
			.thenWaitUntil(() -> {
				List<Skills.SkillResult> done = recorder.results(first);
				helper.assertTrue(!done.isEmpty(), "skill.result for the first job");
				helper.assertValueEqual(done.getFirst().status(), "done", "first job");
			})
			.thenExecute(() -> {
				// Node is away while the next job ends.
				recorder.setConnected(false);
				second.set(jobId("nod"));
				run(helper, agent, second.get(), "emote", "{\"kind\":\"nod\"}", 0);
			})
			.thenWaitUntil(() -> helper.assertFalse(agent.jobs().hasJob(), "the nod is over"))
			.thenExecute(() -> {
				helper.assertTrue(recorder.results(second.get()).isEmpty(), "nothing sent while disconnected");
				recorder.setConnected(true);
				service.connectionRestored();
				List<Skills.SkillResult> done = recorder.results(second.get());
				helper.assertTrue(done.size() == 1 && "done".equals(done.getFirst().status()), "reported on the handshake: " + done);
			})
			.thenSucceed();
	}

	/** {@code BlockScan.nearest} (nearest sections first, early stop) finds what a brute-force search finds. */
	@GameTest(maxTicks = 40)
	public void blockScanMatchesABruteForceSearch(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		java.util.Random random = new java.util.Random(42);
		for (int i = 0; i < 60; i++) {
			helper.setBlock(new BlockPos(random.nextInt(8), random.nextInt(4), random.nextInt(8)), Blocks.COBBLESTONE);
		}
		BlockPos center = helper.absolutePos(new BlockPos(3, 1, 4));
		java.util.function.Predicate<net.minecraft.world.level.block.state.BlockState> cobble = st -> st.is(Blocks.COBBLESTONE);
		java.util.function.Predicate<BlockPos> evenX = q -> (q.getX() & 1) == 0;
		for (int radius : new int[] {2, 5, 9}) {
			for (int limit : new int[] {1, 4, 24}) {
				for (java.util.function.Predicate<BlockPos> extra : List.<java.util.function.Predicate<BlockPos>>of(q -> true, evenX)) {
					List<Long> brute = new java.util.ArrayList<>();
					for (BlockPos q : BlockPos.betweenClosed(center.offset(-radius, -radius, -radius), center.offset(radius, radius, radius))) {
						long d = (long)q.distSqr(center);
						if (d <= (long)radius * radius && cobble.test(level.getBlockState(q)) && extra.test(q)) {
							brute.add(d);
						}
					}
					java.util.Collections.sort(brute);
					List<Long> scan = new java.util.ArrayList<>();
					for (BlockPos q : dev.minevibe.agent.job.BlockScan.nearest(level, center, radius, cobble, extra, limit)) {
						helper.assertTrue(cobble.test(level.getBlockState(q)) && extra.test(q), "a match: " + q);
						scan.add((long)q.distSqr(center));
					}
					helper.assertValueEqual(scan, brute.subList(0, Math.min(limit, brute.size())), "radius " + radius + " limit " + limit);
				}
			}
		}
		helper.succeed();
	}

	/** Its own (daytime) batch: no other test seats agents while this one counts seats. */
	@GameTest(environment = DAY, maxTicks = 600)
	public void seatLimitsAndThePlayersChair(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		SimplePcRegistry pcs = (SimplePcRegistry)Seats.pcs();
		String[] ids = {pcId(), pcId(), pcId(), pcId()};
		BlockPos[] chairs = {new BlockPos(1, 0, 6), new BlockPos(3, 0, 6), new BlockPos(5, 0, 6), new BlockPos(7, 0, 6)};
		for (int i = 0; i < 4; i++) {
			helper.setBlock(chairs[i], MvWorldContent.OFFICE_CHAIR.defaultBlockState());
			pcs.register(ids[i], level.dimension(), helper.absolutePos(chairs[i]));
			pcs.setStatus(ids[i], "running");
		}
		AgentTestSupport.onTestEnd(helper, () -> {
			for (String id : ids) {
				pcs.unregister(id);
			}
		});
		AgentPlayer a = spawnAgent(helper, "First", AgentRole.ENGINEER, 1, 0, 1);
		AgentPlayer b = spawnAgent(helper, "Second", AgentRole.ENGINEER, 3, 0, 1);
		AgentPlayer c = spawnAgent(helper, "Third", AgentRole.ENGINEER, 5, 0, 1);
		ServerPlayer human = spawnHumanStandIn(helper, 7, 0, 4);
		SkillService service = service(helper);
		helper.assertTrue(OfficeChairBlock.trySit(level, helper.absolutePos(chairs[3]), human), "the player sits at the fourth PC");
		expect(helper, "OCCUPIED_BY_PLAYER", () -> service.seat(new AgentSeat(c.agentId(), jobId("x"), 1, SeatTarget.pc(ids[3]), null)));
		service.seat(new AgentSeat(a.agentId(), jobId("a"), 1, SeatTarget.pc(ids[0]), null));
		service.seat(new AgentSeat(b.agentId(), jobId("b"), 1, SeatTarget.pc(ids[1]), null));
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(service.seated(a.agentId()) != null && service.seated(b.agentId()) != null, "two agents seated"))
			.thenExecute(() -> {
				expect(helper, "SEAT_CAP", () -> service.seat(new AgentSeat(c.agentId(), jobId("x"), 1, SeatTarget.pc(ids[2]), null)));
				helper.assertTrue(pcs.reservation(ids[2]) == null, "a refused seat reserves nothing");
				var seats = recorder(helper).of(dev.minevibe.bridge.msg.Seats.PC_SEAT, s -> s.pcId().equals(ids[0]) || s.pcId().equals(ids[1]));
				helper.assertValueEqual(seats.size(), 2, "pc.seat for both");
				var obs = (com.google.gson.JsonObject)service.obs(new Skills.ObsQuery(c.agentId(), "list_pcs", new com.google.gson.JsonObject())).get("result");
				helper.assertTrue(obs.toString().contains(ids[3]) && obs.toString().contains("\"occupant\":\"player\""), "list_pcs: " + obs);
				// An agent away from its chair (asking the player) still holds it: the cap still counts it ...
				service.unseat(new AgentUnseat(a.agentId(), 1, "away", true));
				expect(helper, "SEAT_CAP", () -> service.seat(new AgentSeat(c.agentId(), jobId("x"), 2, SeatTarget.pc(ids[2]), null)));
				// ... and it can always come back to it.
				service.seat(new AgentSeat(a.agentId(), jobId("back"), 2, SeatTarget.pc(ids[0]), null));
			})
			.thenWaitUntil(() -> helper.assertTrue(service.seated(a.agentId()) != null, "back in its chair"))
			.thenSucceed();
	}

	private static void expect(final GameTestHelper helper, final String code, final Runnable call) {
		try {
			call.run();
		} catch (BridgeException e) {
			helper.assertValueEqual(e.code(), code, "error code (" + e.getMessage() + ")");
			return;
		}
		helper.fail("expected " + code);
	}
}
