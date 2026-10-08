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

	@GameTest(maxTicks = 300)
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
			})
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
