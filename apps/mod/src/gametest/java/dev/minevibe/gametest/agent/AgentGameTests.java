package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentNetHandler;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.job.GotoJob;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.MineJob;
import dev.minevibe.agent.job.SitJob;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.grave.GraveBlockEntity;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.SleepStatus;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.zombie.Zombie;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.scores.PlayerTeam;
import net.minecraft.world.scores.Team;

/**
 * Server GameTests for agent bodies (spike S1). Test ids are
 * {@code minevibe-gametest:agent_game_tests_<method_in_snake_case>}. Each test prints its numbers on one
 * line starting with {@code [S1]}.
 */
public final class AgentGameTests {
	private static final String PATH_COURSE = "minevibe-gametest:path_course";
	private static final String ARENA = "minevibe-gametest:arena";

	// ------------------------------------------------------------------ bodies

	@GameTest(maxTicks = 40)
	public void agentSpawnsHiddenFromTablist(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Tab", AgentRole.CEO, 2, 0, 2);
		ServerPlayer human = spawnHumanStandIn(helper, 5, 0, 5);
		ServerLevel level = helper.getLevel();

		ClientboundPlayerInfoUpdatePacket init = ClientboundPlayerInfoUpdatePacket.createPlayerInitializing(List.of(agent, human));
		ClientboundPlayerInfoUpdatePacket.Entry agentEntry = entry(init, agent.getUUID());
		ClientboundPlayerInfoUpdatePacket.Entry humanEntry = entry(init, human.getUUID());
		helper.assertTrue(init.actions().contains(ClientboundPlayerInfoUpdatePacket.Action.ADD_PLAYER), "ADD_PLAYER expected");
		helper.assertTrue(agentEntry != null && agentEntry.profile() != null, "agent entry (with profile) must still be sent");
		helper.assertFalse(agentEntry.listed(), "agent must be unlisted (hidden from the tab list)");
		helper.assertTrue(humanEntry != null && humanEntry.listed(), "a human must stay listed");
		ClientboundPlayerInfoUpdatePacket listed = new ClientboundPlayerInfoUpdatePacket(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED, agent);
		helper.assertFalse(listed.entries().getFirst().listed(), "UPDATE_LISTED for an agent must say unlisted");
		helper.assertTrue(AgentService.roleOf(agentEntry.profile()) == AgentRole.CEO, "profile must carry the role property (skin)");

		helper.assertTrue(level.getServer().getPlayerList().getPlayer(agent.getUUID()) == agent, "agent is in the player list");
		helper.assertTrue(agent.connection instanceof AgentNetHandler, "agent uses AgentNetHandler");
		helper.assertTrue(agent.getUUID().equals(AgentService.uuidFor(agent.agentId())), "stable offline UUID");
		helper.assertTrue(
			agent.getUUID().equals(UUID.nameUUIDFromBytes(("mv-agent:" + agent.agentId()).getBytes(java.nio.charset.StandardCharsets.UTF_8))),
			"UUID derives from mv-agent:<id>"
		);
		helper.assertFalse(agent.allowsListing(), "agent hidden from the server list sample");
		helper.assertTrue(agent.gameMode() == GameType.SURVIVAL, "agents are survival players");
		helper.assertTrue(agent.getTeam() instanceof PlayerTeam team && team.getName().equals(AgentService.TEAM), "agent is on the agent team");
		helper.assertTrue(agent.getTeam().getCollisionRule() == Team.CollisionRule.NEVER, "agent team never collides");

		SleepStatus sleep = new SleepStatus();
		sleep.update(List.of(agent, human));
		helper.assertValueEqual(sleep.sleepersNeeded(100), 1, "sleepers needed (1 human + 1 agent)");
		new AgentTestSupport.Report("tablist").add("listed", agentEntry.listed()).add("uuid", agent.getUUID()).print();
		helper.succeed();
	}

	private static ClientboundPlayerInfoUpdatePacket.Entry entry(final ClientboundPlayerInfoUpdatePacket packet, final UUID id) {
		for (ClientboundPlayerInfoUpdatePacket.Entry e : packet.entries()) {
			if (e.profileId().equals(id)) {
				return e;
			}
		}
		return null;
	}

	@GameTest(maxTicks = 40)
	public void agentRestoresFromPlayerdata(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		AgentService service = AgentService.get(level.getServer());
		AgentPlayer agent = spawnAgent(helper, "Saved", AgentRole.FARMER, 2, 0, 2);
		agent.getInventory().setItem(4, new ItemStack(Items.WHEAT_SEEDS, 7));
		agent.setHealth(13.0F);
		agent.getFoodData().setFoodLevel(11);
		agent.teleportTo(agent.getX() + 2.0, agent.getY(), agent.getZ() + 1.0);
		Vec3 savedPos = agent.position();
		String id = agent.agentId();
		String name = agent.getGameProfile().name();
		// World unload: body leaves, playerdata and crew entry stay.
		service.despawn(agent, true);
		helper.assertTrue(level.getServer().getPlayerList().getPlayer(agent.getUUID()) == null, "despawned");
		helper.assertTrue(service.isKnown(id) && !service.isDead(id), "still in the crew list");
		// World load: spawn at some other place; the saved body wins.
		AgentPlayer back = service.spawn(id, name, AgentRole.FARMER, level, helper.absoluteVec(new Vec3(6.5, 0, 6.5)), 0.0F);
		AgentTestSupport.onTestEnd(helper, () -> {
			if (service.agent(id) == back) {
				service.dismiss(back);
			}
		});
		helper.assertTrue(back != agent, "a new body object");
		helper.assertTrue(back.position().distanceTo(savedPos) < 0.01, "restored position " + back.position() + " vs " + savedPos);
		helper.assertValueEqual(back.getHealth(), 13.0F, "restored health");
		helper.assertValueEqual(back.getFoodData().getFoodLevel(), 11, "restored food");
		helper.assertValueEqual(back.getInventory().getItem(4).getCount(), 7, "restored inventory");
		helper.assertTrue(back.getUUID().equals(agent.getUUID()), "same UUID");
		new AgentTestSupport.Report("restore").add("pos", back.blockPosition().toShortString()).add("hp", back.getHealth()).print();
		helper.succeed();
	}

	// ------------------------------------------------------------------ navigation

	@GameTest(structure = PATH_COURSE, maxTicks = 1600)
	public void agentPaths50Blocks(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Walker", AgentRole.ENGINEER, 1, 1, 5);
		Vec3 goal = helper.absoluteVec(new Vec3(52.5, 2.0, 5.5));
		double straight = agent.position().distanceTo(goal);
		long start = helper.getTick();
		AtomicBoolean swam = new AtomicBoolean();
		AtomicInteger sprintTicks = new AtomicInteger();
		AtomicBoolean reported = new AtomicBoolean();
		agent.jobs().start(new GotoJob(goal, 1.0));
		helper.startSequence().thenExecuteFor(1600, () -> {
			if (agent.isInWater()) {
				swam.set(true);
			}
			if (agent.isSprinting()) {
				sprintTicks.incrementAndGet();
			}
		});
		helper.succeedWhen(() -> {
			if (agent.jobs().lastStatus() == Job.Status.FAILED) {
				throw new IllegalStateException("goto failed: " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue(agent.jobs().lastStatus() == Job.Status.DONE, "still walking, at " + agent.blockPosition());
			helper.assertTrue(agent.position().distanceTo(goal) < 2.0, "arrived too far from the goal");
			long ticks = helper.getTick() - start;
			if (reported.getAndSet(true)) {
				helper.assertTrue(swam.get(), "the course has a pool across it; the agent should have swum");
				return;
			}
			new AgentTestSupport.Report("path")
				.add("straight_blocks", String.format(Locale.ROOT, "%.1f", straight))
				.add("ticks", ticks)
				.add("blocks_per_s", String.format(Locale.ROOT, "%.2f", straight / (ticks / 20.0)))
				.add("plans", agent.navigator().plans())
				.add("plan_ms_avg", String.format(Locale.ROOT, "%.3f", agent.navigator().avgPlanMillis()))
				.add("plan_ms_max", String.format(Locale.ROOT, "%.3f", agent.navigator().maxPlanMillis()))
				.add("poofs", agent.navigator().poofs())
				.add("swam", swam.get())
				.add("sprint_ticks", sprintTicks.get())
				.add("hp", agent.getHealth())
				.print();
			helper.assertTrue(swam.get(), "the course has a pool across it; the agent should have swum");
		});
	}

	@GameTest(maxTicks = 400)
	public void agentOpensDoor(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		// A stone wall across z=4 with an oak door at x=3.
		for (int x = 0; x < 8; x++) {
			for (int y = 0; y < 3; y++) {
				if (x == 3 && y < 2) {
					continue;
				}
				helper.setBlock(new BlockPos(x, y, 4), Blocks.STONE);
			}
		}
		BlockPos doorLower = helper.absolutePos(new BlockPos(3, 0, 4));
		BlockState door = Blocks.OAK_DOOR.defaultBlockState().setValue(DoorBlock.FACING, Direction.NORTH).setValue(DoorBlock.OPEN, false);
		level.setBlock(doorLower.above(), door.setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER), Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
		level.setBlock(doorLower, door.setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER), Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);

		AgentPlayer agent = spawnAgent(helper, "Door", AgentRole.BUILDER, 3, 0, 1);
		Vec3 goal = helper.absoluteVec(new Vec3(3.5, 0.0, 6.5));
		AtomicBoolean opened = new AtomicBoolean();
		agent.jobs().start(new GotoJob(goal, 0.8));
		helper.startSequence().thenExecuteFor(400, () -> {
			BlockState s = level.getBlockState(doorLower);
			if (s.getBlock() instanceof DoorBlock && s.getValue(DoorBlock.OPEN)) {
				opened.set(true);
			}
		});
		helper.succeedWhen(() -> {
			if (agent.jobs().lastStatus() == Job.Status.FAILED) {
				throw new IllegalStateException("goto failed: " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue(agent.jobs().lastStatus() == Job.Status.DONE, "not through the door yet");
			helper.assertTrue(opened.get(), "the door was never opened");
			helper.assertTrue(agent.getZ() > doorLower.getZ() + 1.0, "agent is not past the door");
			BlockState s = level.getBlockState(doorLower);
			helper.assertTrue(s.getBlock() instanceof DoorBlock, "door was broken instead of opened");
			helper.assertFalse(s.getValue(DoorBlock.OPEN), "door left open behind the agent");
			new AgentTestSupport.Report("door").add("opened", opened.get()).add("closed_behind", !s.getValue(DoorBlock.OPEN)).print();
		});
	}

	@GameTest(maxTicks = 400)
	public void agentStuckLadderPoof(final GameTestHelper helper) {
		// A 1-wide, 2-high corridor along z at x=3, blocked by a shulker that A* does not see.
		for (int z = 0; z < 8; z++) {
			for (int y = 0; y < 2; y++) {
				helper.setBlock(new BlockPos(2, y, z), Blocks.STONE);
				helper.setBlock(new BlockPos(4, y, z), Blocks.STONE);
			}
			helper.setBlock(new BlockPos(3, 2, z), Blocks.STONE);
		}
		var shulker = helper.spawn(EntityTypes.SHULKER, new BlockPos(3, 0, 4));
		shulker.setNoAi(true);
		AgentPlayer agent = spawnAgent(helper, "Stuck", AgentRole.ENGINEER, 3, 0, 1);
		Vec3 goal = helper.absoluteVec(new Vec3(3.5, 0.0, 7.5));
		long start = helper.getTick();
		agent.jobs().start(new GotoJob(goal, 0.8));
		helper.succeedWhen(() -> {
			if (agent.jobs().lastStatus() == Job.Status.FAILED) {
				throw new IllegalStateException("goto failed: " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue(agent.jobs().lastStatus() == Job.Status.DONE, "not past the obstacle yet");
			helper.assertTrue(agent.navigator().poofs() >= 1, "expected a poof unstuck");
			helper.assertTrue(AgentEvents.recent(agent.agentId()).stream().anyMatch(e -> e.type().equals("nav.poof")), "nav.poof event");
			new AgentTestSupport.Report("stuck").add("ticks", helper.getTick() - start).add("poofs", agent.navigator().poofs()).print();
		});
	}

	@GameTest(maxTicks = 300)
	public void agentStuckLadderFails(final GameTestHelper helper) {
		// Same corridor, but closed at the far end and the agent cannot get past: the ladder ends in nav.failed.
		for (int z = 0; z < 8; z++) {
			for (int y = 0; y < 2; y++) {
				helper.setBlock(new BlockPos(2, y, z), Blocks.STONE);
				helper.setBlock(new BlockPos(4, y, z), Blocks.STONE);
			}
			helper.setBlock(new BlockPos(3, 2, z), Blocks.STONE);
		}
		// Shulkers fill z=2..6: every path node within 3 blocks is occupied (A* does not see entities) and
		// the corridor walls block any off-path hop, so jump -> replan -> poof finds nothing -> nav.failed.
		for (int z = 2; z <= 6; z++) {
			helper.spawn(EntityTypes.SHULKER, new BlockPos(3, 0, z)).setNoAi(true);
		}
		AgentPlayer agent = spawnAgent(helper, "Boxed", AgentRole.ENGINEER, 3, 0, 1);
		agent.jobs().start(new GotoJob(helper.absoluteVec(new Vec3(3.5, 0.0, 7.5)), 0.8));
		helper.succeedWhen(() -> {
			helper.assertTrue(agent.jobs().lastStatus() == Job.Status.FAILED, "the goto should fail");
			helper.assertTrue(
				AgentEvents.recent(agent.agentId()).stream().anyMatch(e -> e.type().equals("nav.failed") && "stuck".equals(e.data().get("reason"))),
				"nav.failed{reason=stuck} event"
			);
			new AgentTestSupport.Report("stuck_fail")
				.add("reason", agent.navigator().failureReason())
				.add("poofs", agent.navigator().poofs())
				.add("events", AgentEvents.recent(agent.agentId()).stream().map(AgentEvents.Event::type).toList())
				.print();
		});
	}

	// ------------------------------------------------------------------ jobs

	@GameTest(maxTicks = 300)
	public void agentMinesLogSurvivalSpeed(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos logRel = new BlockPos(4, 0, 4);
		helper.setBlock(logRel, Blocks.OAK_LOG);
		BlockPos logPos = helper.absolutePos(logRel);
		AgentPlayer agent = spawnAgent(helper, "Miner", AgentRole.MINER, 1, 0, 1);
		agent.getInventory().setItem(0, new ItemStack(Items.DIRT, 16));
		agent.getInventory().setItem(5, new ItemStack(Items.IRON_AXE));
		agent.getInventory().setItem(7, new ItemStack(Items.WOODEN_PICKAXE));
		agent.getInventory().setSelectedSlot(0);

		BlockState log = level.getBlockState(logPos);
		ItemStack probe = new ItemStack(Items.IRON_AXE);
		float perTick = probe.getDestroySpeed(log) / log.getDestroySpeed(level, logPos) / 30.0F;
		int expected = (int)Math.ceil(1.0F / perTick);
		float handPerTick = 1.0F / log.getDestroySpeed(level, logPos) / 30.0F;
		int expectedByHand = (int)Math.ceil(1.0F / handPerTick);

		MineJob job = new MineJob(logPos, true);
		agent.jobs().start(job);
		helper.succeedWhen(() -> {
			if (agent.jobs().lastStatus() == Job.Status.FAILED) {
				throw new IllegalStateException("mine failed: " + AgentEvents.recent(agent.agentId()));
			}
			helper.assertTrue(agent.jobs().lastStatus() == Job.Status.DONE, "still mining");
			int ticks = job.miningTicks();
			new AgentTestSupport.Report("mine")
				.add("ticks", ticks)
				.add("expected_ticks", expected)
				.add("expected_by_hand", expectedByHand)
				.add("tool", agent.getMainHandItem().getItem())
				.add("picked_up", agent.getInventory().contains(new ItemStack(Items.OAK_LOG)))
				.print();
			helper.assertTrue(level.getBlockState(logPos).isAir(), "log still there");
			helper.assertTrue(agent.getMainHandItem().is(Items.IRON_AXE), "should mine with the best tool (iron axe), held " + agent.getMainHandItem());
			helper.assertTrue(ticks >= expected - 2 && ticks <= expected + 3, "mining took " + ticks + " ticks, survival speed is ~" + expected);
			helper.assertTrue(agent.getInventory().contains(new ItemStack(Items.OAK_LOG)), "agent should have picked up the log");
		});
	}

	@GameTest(maxTicks = 40)
	public void agentPlacesBlock(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		helper.setBlock(new BlockPos(3, 0, 3), Blocks.STONE);
		BlockPos stone = helper.absolutePos(new BlockPos(3, 0, 3));
		AgentPlayer agent = spawnAgent(helper, "Placer", AgentRole.BUILDER, 1, 0, 1);
		agent.brain().setEnabled(false);
		agent.getInventory().setItem(0, new ItemStack(Items.COBBLESTONE, 3));
		agent.getInventory().setSelectedSlot(0);
		agent.controls().lookAt(Vec3.atCenterOf(stone).add(0.0, 0.5, 0.0));
		var result = agent.controls().useBlock(stone, Direction.UP);
		helper.assertTrue(result.consumesAction(), "placing should consume the click, got " + result);
		helper.assertTrue(level.getBlockState(stone.above()).is(Blocks.COBBLESTONE), "cobblestone placed on top of the stone");
		helper.assertValueEqual(agent.getInventory().getItem(0).getCount(), 2, "one cobblestone used (survival)");
		new AgentTestSupport.Report("place").add("placed", level.getBlockState(stone.above()).getBlock()).print();
		helper.succeed();
	}

	@GameTest(structure = PATH_COURSE, maxTicks = 100)
	public void navPlanBenchmark(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Planner", AgentRole.ENGINEER, 1, 1, 5);
		agent.brain().setEnabled(false);
		BlockPos target = helper.absolutePos(new BlockPos(40, 4, 5));
		helper.startSequence().thenIdle(5).thenExecute(() -> {
			int runs = 40;
			int warmup = 10;
			long total = 0L;
			long max = 0L;
			int nodes = 0;
			for (int i = 0; i < runs; i++) {
				long t0 = System.nanoTime();
				var path = agent.navigator().findPath(target, 2);
				long dt = System.nanoTime() - t0;
				helper.assertTrue(path != null && path.getNodeCount() > 30, "no 40-block path from the proxy mob");
				nodes = path.getNodeCount();
				if (i >= warmup) {
					total += dt;
					max = Math.max(max, dt);
				}
			}
			new AgentTestSupport.Report("nav_plan")
				.add("blocks", 39)
				.add("nodes", nodes)
				.add("avg_ms_warm", String.format(Locale.ROOT, "%.3f", total / 1.0E6 / (runs - warmup)))
				.add("max_ms_warm", String.format(Locale.ROOT, "%.3f", max / 1.0E6))
				.print();
		}).thenSucceed();
	}

	@GameTest(maxTicks = 200)
	public void agentEatsWhenHungry(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Eater", AgentRole.FARMER, 3, 0, 3);
		agent.getFoodData().setFoodLevel(4);
		agent.getFoodData().setSaturation(0.0F);
		agent.getInventory().setItem(0, new ItemStack(Items.ROTTEN_FLESH, 4));
		agent.getInventory().setItem(1, new ItemStack(Items.BREAD, 2));
		agent.getInventory().setItem(20, new ItemStack(Items.COOKED_BEEF, 2));
		helper.succeedWhen(() -> {
			int food = agent.getFoodData().getFoodLevel();
			helper.assertTrue(food >= 18, "food is " + food);
			helper.assertFalse(agent.isUsingItem(), "still eating");
			helper.assertValueEqual(count(agent, Items.COOKED_BEEF), 0, "cooked beef (best food) eaten");
			helper.assertValueEqual(count(agent, Items.ROTTEN_FLESH), 4, "rotten flesh untouched");
			helper.assertValueEqual(count(agent, Items.BREAD), 2, "bread untouched (beef is better)");
			new AgentTestSupport.Report("eat").add("food", food).add("saturation", agent.getFoodData().getSaturationLevel()).print();
		});
	}

	private static int count(final AgentPlayer agent, final net.minecraft.world.item.Item item) {
		int n = 0;
		for (int i = 0; i < agent.getInventory().getContainerSize(); i++) {
			ItemStack s = agent.getInventory().getItem(i);
			if (s.is(item)) {
				n += s.getCount();
			}
		}
		return n;
	}

	// ------------------------------------------------------------------ reflexes

	@GameTest(maxTicks = 600)
	public void agentDefendsPlayer(final GameTestHelper helper) {
		ServerPlayer human = spawnHumanStandIn(helper, 1, 0, 1);
		AgentPlayer agent = spawnAgent(helper, "Guard", AgentRole.GUARD, 2, 0, 3);
		agent.getInventory().setItem(3, new ItemStack(Items.IRON_SWORD));
		agent.brain().setFollowTarget(human.getUUID());
		Zombie zombie = helper.spawn(EntityTypes.ZOMBIE, new BlockPos(6, 0, 6));
		zombie.setBaby(false);
		zombie.setItemSlot(EquipmentSlot.HEAD, new ItemStack(Items.LEATHER_HELMET));
		zombie.setItemSlot(EquipmentSlot.MAINHAND, ItemStack.EMPTY);
		zombie.setTarget(human);
		long start = helper.getTick();
		helper.succeedWhen(() -> {
			helper.assertFalse(zombie.isAlive(), "zombie still alive (hp " + zombie.getHealth() + ")");
			helper.assertTrue(zombie.getLastHurtByMob() == agent, "the agent should have killed the zombie");
			helper.assertTrue(agent.isAlive(), "agent died");
			new AgentTestSupport.Report("defend")
				.add("ticks", helper.getTick() - start)
				.add("agent_hp", agent.getHealth())
				.add("human_hp", human.getHealth())
				.add("weapon", agent.getMainHandItem().getItem())
				.print();
		});
	}

	@GameTest(structure = ARENA, maxTicks = 200)
	public void agentBacksOffFromCreeper(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Runner", AgentRole.ENGINEER, 5, 1, 8);
		Creeper creeper = helper.spawn(EntityTypes.CREEPER, new BlockPos(3, 1, 8));
		Vec3 blast = creeper.position();
		creeper.ignite();
		AtomicBoolean reacted = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(200, () -> {
			if ("creeper_backoff".equals(agent.brain().activeName())) {
				reacted.set(true);
			}
		});
		helper.succeedWhen(() -> {
			helper.assertFalse(creeper.isAlive(), "creeper has not exploded yet");
			helper.assertTrue(reacted.get(), "creeper backoff reflex never fired");
			helper.assertTrue(agent.isAlive(), "agent died in the blast");
			double distance = agent.position().distanceTo(blast);
			new AgentTestSupport.Report("creeper").add("distance_at_blast", String.format(Locale.ROOT, "%.1f", distance)).add("hp", agent.getHealth()).print();
			helper.assertTrue(distance > 5.0, "agent only got " + distance + " blocks away");
		});
	}

	@GameTest(maxTicks = 200)
	public void agentEscapesLava(final GameTestHelper helper) {
		// A stone floor with a 1-deep lava pit (agent starts in it) and a 1-deep water pit 3 blocks away.
		for (int x = 0; x < 8; x++) {
			for (int z = 0; z < 8; z++) {
				helper.setBlock(new BlockPos(x, 0, z), Blocks.STONE);
			}
		}
		helper.setBlock(new BlockPos(2, 0, 3), Blocks.LAVA);
		helper.setBlock(new BlockPos(5, 0, 3), Blocks.WATER);
		AgentPlayer agent = spawnAgent(helper, "Hot", AgentRole.MINER, 2, 0, 3);
		AtomicBoolean wasInLava = new AtomicBoolean();
		helper.startSequence().thenExecuteFor(200, () -> {
			if (agent.isInLava()) {
				wasInLava.set(true);
			}
		});
		helper.succeedWhen(() -> {
			helper.assertTrue(wasInLava.get(), "agent never stood in the lava");
			helper.assertTrue(agent.isAlive(), "agent died");
			helper.assertFalse(agent.isInLava(), "still in lava");
			helper.assertFalse(agent.isOnFire(), "still burning");
			new AgentTestSupport.Report("lava").add("hp", agent.getHealth()).add("in_water", agent.isInWater()).print();
		});
	}

	@GameTest(maxTicks = 60)
	public void friendlyFireCancelled(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		AgentPlayer a = spawnAgent(helper, "Ally", AgentRole.ENGINEER, 2, 0, 2);
		AgentPlayer b = spawnAgent(helper, "Buddy", AgentRole.BUILDER, 3, 0, 2);
		ServerPlayer human = spawnHumanStandIn(helper, 2, 0, 4);
		b.brain().setEnabled(false);
		a.brain().setEnabled(false);
		float hpA = a.getHealth();
		float hpHuman = human.getHealth();
		helper.assertFalse(a.hurtServer(level, level.damageSources().playerAttack(human), 5.0F), "player -> agent damage must be cancelled");
		helper.assertFalse(a.hurtServer(level, level.damageSources().playerAttack(b), 5.0F), "agent -> agent damage must be cancelled");
		b.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, a.getEyePosition());
		b.attack(a);
		helper.assertValueEqual(a.getHealth(), hpA, "agent health after friendly hits");
		helper.assertFalse(human.hurtServer(level, level.damageSources().playerAttack(a), 5.0F), "agent -> player damage must be cancelled");
		helper.assertValueEqual(human.getHealth(), hpHuman, "player health after an agent hit");
		// Real damage still applies.
		helper.assertTrue(a.hurtServer(level, level.damageSources().generic(), 2.0F), "generic damage must apply");
		helper.assertTrue(a.getHealth() < hpA, "agent took no real damage");
		new AgentTestSupport.Report("friendly_fire").add("hp_after_generic", a.getHealth()).print();
		helper.succeed();
	}

	// ------------------------------------------------------------------ seats

	@GameTest(maxTicks = 300)
	public void seatSingleOccupancy(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos chairRel = new BlockPos(4, 0, 4);
		helper.setBlock(chairRel, MvWorldContent.OFFICE_CHAIR.defaultBlockState());
		BlockPos chair = helper.absolutePos(chairRel);
		AgentPlayer first = spawnAgent(helper, "Sitter", AgentRole.ENGINEER, 4, 0, 1);
		AgentPlayer second = spawnAgent(helper, "Second", AgentRole.ENGINEER, 1, 0, 4);
		first.jobs().start(new SitJob(chair));
		helper.startSequence()
			.thenWaitUntil(() -> {
				if (first.jobs().lastStatus() == Job.Status.FAILED) {
					throw new IllegalStateException("sit failed: " + AgentEvents.recent(first.agentId()));
				}
				helper.assertTrue(first.jobs().lastStatus() == Job.Status.DONE, "first agent not seated yet");
			})
			.thenExecute(() -> {
				helper.assertTrue(first.getVehicle() instanceof SeatEntity, "first agent rides a seat");
				SeatEntity seat = (SeatEntity)first.getVehicle();
				helper.assertFalse(OfficeChairBlock.trySit(level, chair, second), "second sitter must be rejected");
				helper.assertFalse(second.isPassenger(), "second agent must not be seated");
				helper.assertValueEqual(seat.getPassengers().size(), 1, "passengers");
				List<SeatEntity> seats = level.getEntitiesOfClass(SeatEntity.class, new AABB(chair).inflate(2.0));
				helper.assertValueEqual(seats.size(), 1, "seat entities at the chair");
				// After the first stands up, the chair is free again.
				first.stopRiding();
				helper.assertTrue(OfficeChairBlock.trySit(level, chair, second), "second agent should sit once the chair is free");
				helper.assertTrue(second.getVehicle() == seat, "second agent reuses the same seat");
				new AgentTestSupport.Report("seat").add("seats", seats.size()).add("kind", seat.kind().getSerializedName()).print();
			})
			.thenIdle(40)
			.thenExecute(() -> {
				helper.assertTrue(second.getVehicle() instanceof SeatEntity, "seated agent should stay seated");
				helper.assertFalse(first.isPassenger(), "first agent stays standing");
			})
			.thenSucceed();
	}

	// ------------------------------------------------------------------ death

	@GameTest(maxTicks = 80)
	public void agentDeathGraveNoRespawn(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		AgentPlayer agent = spawnAgent(helper, "Doomed", AgentRole.MINER, 3, 0, 3);
		agent.getInventory().setItem(0, new ItemStack(Items.DIRT, 5));
		agent.getInventory().setItem(1, new ItemStack(Items.IRON_SWORD));
		agent.getInventory().setItem(30, new ItemStack(Items.COOKED_BEEF, 3));
		AgentService service = AgentService.get(level.getServer());
		UUID uuid = agent.getUUID();
		String id = agent.agentId();
		String name = agent.getGameProfile().name();
		// Make sure there is playerdata to delete.
		level.getServer().getPlayerList().saveAll();
		helper.assertTrue(Files.exists(AgentService.playerDataFile(level.getServer(), uuid)), "playerdata should exist before death");
		BlockPos feet = agent.blockPosition();
		agent.kill(level);
		helper.assertTrue(agent.isAgentDead(), "agent should be dead");
		helper.startSequence()
			.thenIdle(3)
			.thenExecute(() -> {
				BlockPos gravePos = service.gravePos(id);
				helper.assertTrue(gravePos != null && gravePos.equals(feet), "grave at the death spot, got " + gravePos);
				helper.assertTrue(level.getBlockState(gravePos).is(MvWorldContent.GRAVE), "grave block");
				GraveBlockEntity grave = (GraveBlockEntity)level.getBlockEntity(gravePos);
				helper.assertTrue(grave != null, "grave block entity");
				helper.assertValueEqual(grave.itemCount(), 9, "items in the grave");
				helper.assertValueEqual(grave.name(), name, "grave name");
				helper.assertValueEqual(grave.role(), "Miner", "grave role");
				SignBlockEntity sign = (SignBlockEntity)level.getBlockEntity(gravePos.above());
				helper.assertTrue(sign != null, "sign above the grave");
				String line1 = sign.getText(SignTextSlot.FRONT).getMessages(false).get(0).getString();
				String line3 = sign.getText(SignTextSlot.FRONT).getMessages(false).get(2).getString();
				helper.assertValueEqual(line1, name, "sign line 1");
				helper.assertTrue(line3.startsWith("Day "), "sign line 3 is the day");
				helper.assertTrue(level.getServer().getPlayerList().getPlayer(uuid) == null, "dead agent must leave the player list");
				helper.assertTrue(agent.isRemoved(), "body removed");
				helper.assertFalse(Files.exists(AgentService.playerDataFile(level.getServer(), uuid)), "playerdata must be deleted");
				helper.assertTrue(service.isDead(id), "registry marks the agent dead");
				boolean refused;
				try {
					service.spawn(id, name, AgentRole.MINER, level, agent.position(), 0.0F);
					refused = false;
				} catch (IllegalStateException e) {
					refused = true;
				}
				helper.assertTrue(refused, "a dead agent must never respawn");
				new AgentTestSupport.Report("death").add("grave", gravePos.toShortString()).add("items", grave.itemCount()).add("sign", line1 + "/" + line3).print();
			})
			.thenIdle(40)
			.thenExecute(() -> helper.assertTrue(level.getServer().getPlayerList().getPlayer(uuid) == null, "agent came back"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ perf

	@GameTest(structure = ARENA, maxTicks = 500)
	public void agentPerfFourAgents(final GameTestHelper helper) {
		int[][] corners = {{2, 13}, {13, 2}, {13, 13}, {2, 2}};
		List<AgentPlayer> agents = new ArrayList<>();
		List<Vec3[]> routes = new ArrayList<>();
		for (int i = 0; i < 4; i++) {
			int[] from = corners[i];
			int[] to = corners[(i + 2) % 4];
			AgentPlayer agent = spawnAgent(helper, "Perf" + i, AgentRole.values()[i], from[0], 1, from[1]);
			agents.add(agent);
			routes.add(new Vec3[] {helper.absoluteVec(new Vec3(to[0] + 0.5, 1, to[1] + 0.5)), helper.absoluteVec(new Vec3(from[0] + 0.5, 1, from[1] + 0.5))});
		}
		int[] leg = new int[agents.size()];
		AtomicInteger legs = new AtomicInteger();
		AtomicLong measuredTicks = new AtomicLong();
		Runnable patrol = () -> {
			for (int i = 0; i < agents.size(); i++) {
				AgentPlayer agent = agents.get(i);
				if (!agent.jobs().hasJob()) {
					// Walk to the opposite corner, then back, and so on.
					Vec3 next = routes.get(i)[leg[i]];
					leg[i] = 1 - leg[i];
					agent.jobs().start(new GotoJob(next, 1.0));
					legs.incrementAndGet();
				}
			}
		};
		helper.startSequence()
			.thenExecuteFor(100, patrol)
			.thenExecute(() -> agents.forEach(AgentPlayer::resetTickStats))
			.thenExecuteFor(300, () -> {
				patrol.run();
				measuredTicks.incrementAndGet();
			})
			.thenExecute(() -> {
				double sum = 0.0;
				double max = 0.0;
				StringBuilder per = new StringBuilder();
				for (AgentPlayer agent : agents) {
					sum += agent.avgTickMillis();
					max = Math.max(max, agent.maxTickMillis());
					per.append(String.format(Locale.ROOT, "%.4f,", agent.avgTickMillis()));
				}
				double avg = sum / agents.size();
				new AgentTestSupport.Report("perf")
					.add("agents", agents.size())
					.add("measured_ticks", measuredTicks.get())
					.add("avg_ms_per_agent_tick", String.format(Locale.ROOT, "%.4f", avg))
					.add("per_agent_ms", per)
					.add("max_single_tick_ms", String.format(Locale.ROOT, "%.3f", max))
					.add("legs", legs.get())
					.add("plan_ms_avg", String.format(Locale.ROOT, "%.3f", agents.stream().mapToDouble(a -> a.navigator().avgPlanMillis()).average().orElse(0)))
					.add("plan_ms_max", String.format(Locale.ROOT, "%.3f", agents.stream().mapToDouble(a -> a.navigator().maxPlanMillis()).max().orElse(0)))
					.print();
				helper.assertTrue(avg < 0.5, String.format(Locale.ROOT, "avg %.4f ms/tick per agent exceeds 0.5 ms", avg));
			})
			.thenSucceed();
	}
}
