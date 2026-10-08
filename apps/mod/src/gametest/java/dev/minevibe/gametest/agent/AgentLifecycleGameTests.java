package dev.minevibe.gametest.agent;

import static dev.minevibe.gametest.agent.AgentTestSupport.spawnAgent;
import static dev.minevibe.gametest.agent.AgentTestSupport.spawnHumanStandIn;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stat;
import net.minecraft.stats.Stats;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.portal.TeleportTransition;
import net.minecraft.world.phys.Vec3;

/**
 * Agents as real players, and the edges of their lives (review findings MAJOR 3, MAJOR 5, MINOR 15, MINOR 16 and
 * the "agents count as real players" decision, PLAN §7.1). Test ids are
 * {@code minevibe-gametest:agent_lifecycle_game_tests_<method_in_snake_case>}.
 */
public final class AgentLifecycleGameTests {
	/** Every game message the server broadcasts (agent advancement announcements must not be among them). */
	private static final List<String> BROADCASTS = new CopyOnWriteArrayList<>();

	static {
		ServerMessageEvents.GAME_MESSAGE.register((server, message, overlay) -> BROADCASTS.add(message.getString()));
	}

	// ------------------------------------------------------------------ dimensions (MAJOR 3)

	@GameTest(maxTicks = 100)
	public void agentChangesDimensionAndStaysVulnerable(final GameTestHelper helper) {
		ServerLevel overworld = helper.getLevel();
		ServerLevel nether = overworld.getServer().getLevel(Level.NETHER);
		helper.assertTrue(nether != null, "the GameTest world has a Nether");
		AgentPlayer agent = spawnAgent(helper, "Port", AgentRole.MINER, 2, 0, 2);
		agent.brain().setEnabled(false);
		Vec3 home = agent.position();
		// Flat Nether: bedrock plus three layers of basalt.
		Vec3 there = new Vec3(0.5, nether.getMinY() + 4, 0.5);
		ServerPlayer moved = agent.teleport(new TeleportTransition(nether, there, Vec3.ZERO, 0.0F, 0.0F, TeleportTransition.DO_NOTHING));
		helper.assertTrue(moved == agent, "the same body changes dimension");
		helper.assertTrue(agent.level() == nether, "agent is in the Nether");
		// A client would confirm the teleport; without this the agent stayed "changing dimension" for good.
		helper.assertFalse(agent.isChangingDimension(), "agent must not stay 'changing dimension'");
		helper.assertFalse(agent.isInvulnerableTo(nether, nether.damageSources().generic()), "agent can be hurt after the change");
		helper.startSequence()
			.thenIdle(5)
			.thenExecute(() -> {
				float before = agent.getHealth();
				agent.hurtServer(nether, nether.damageSources().generic(), 2.0F);
				helper.assertTrue(agent.getHealth() < before, "damage applies in the new dimension, hp " + before + " -> " + agent.getHealth());
				agent.teleport(new TeleportTransition(overworld, home, Vec3.ZERO, 0.0F, 0.0F, TeleportTransition.DO_NOTHING));
				helper.assertTrue(agent.level() == overworld, "and it can change dimension again");
				helper.assertFalse(agent.isChangingDimension(), "not stuck after the second change either");
			})
			.thenSucceed();
	}

	@GameTest(maxTicks = 200)
	public void agentLeavesTheEndThroughTheExitPortal(final GameTestHelper helper) {
		ServerLevel overworld = helper.getLevel();
		ServerLevel end = overworld.getServer().getLevel(Level.END);
		helper.assertTrue(end != null, "the GameTest world has an End");
		AgentPlayer agent = spawnAgent(helper, "Exit", AgentRole.GUARD, 2, 0, 2);
		agent.brain().setEnabled(false);
		// Far from the dragon fight around (0, 0). Flat End: bedrock plus three layers of end stone.
		BlockPos portal = new BlockPos(300, end.getMinY() + 4, 300);
		agent.teleport(new TeleportTransition(end, Vec3.atBottomCenterOf(portal), Vec3.ZERO, 0.0F, 0.0F, TeleportTransition.DO_NOTHING));
		helper.assertTrue(agent.level() == end, "agent is in the End");
		end.setBlock(portal, Blocks.END_PORTAL.defaultBlockState(), 3);
		// The first touch of the exit portal rolls the credits: vanilla removes the player until its client asks to
		// respawn, which an agent never does. The agent must come home instead.
		helper.startSequence()
			.thenWaitUntil(() -> helper.assertTrue(agent.level() == overworld, "agent should be back in the overworld, is in " + agent.level().dimension()))
			.thenExecute(() -> {
				end.setBlock(portal, Blocks.AIR.defaultBlockState(), 3);
				helper.assertTrue(agent.seenCredits, "the credits count as seen");
				helper.assertFalse(agent.isRemoved(), "the body is still in the world");
				helper.assertTrue(overworld.getServer().getPlayerList().getPlayer(agent.getUUID()) == agent, "same body in the player list");
				helper.assertTrue(AgentService.get(overworld.getServer()).agent(agent.agentId()) == agent, "the service still has it");
				helper.assertFalse(agent.isChangingDimension(), "not stuck changing dimension");
			})
			// Portal cooldown must run down again (it is skipped while "changing dimension"), or no portal works twice.
			.thenWaitUntil(() -> helper.assertFalse(agent.isOnPortalCooldown(), "portal cooldown should expire"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ phantoms (MAJOR 5)

	@GameTest(maxTicks = 40)
	public void agentNeverCallsPhantoms(final GameTestHelper helper) {
		AgentPlayer agent = spawnAgent(helper, "Awake", AgentRole.FARMER, 2, 0, 2);
		Stat<Identifier> sinceRest = Stats.CUSTOM.get(Stats.TIME_SINCE_REST);
		// Four days without sleep: PhantomSpawner (which iterates every player) would start spawning around it.
		agent.getStats().setValue(agent, sinceRest, 4 * 24000);
		helper.startSequence()
			.thenIdle(3)
			.thenExecute(() -> helper.assertTrue(
				agent.getStats().getValue(sinceRest) <= 1,
				"TIME_SINCE_REST must stay at zero for agents, is " + agent.getStats().getValue(sinceRest)))
			.thenIdle(20)
			.thenExecute(() -> helper.assertTrue(agent.getStats().getValue(sinceRest) <= 1, "and keep staying there"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ real players, quietly (PLAN 7.1)

	@GameTest(maxTicks = 20)
	public void agentAdvancementsAreNotAnnounced(final GameTestHelper helper) {
		MinecraftServer server = helper.getLevel().getServer();
		AdvancementHolder stoneAge = server.getAdvancements().get(Identifier.withDefaultNamespace("story/mine_stone"));
		helper.assertTrue(stoneAge != null, "vanilla advancement story/mine_stone");
		helper.assertTrue(stoneAge.value().display().map(d -> d.announceToChat()).orElse(false), "it is announced to chat");
		String criterion = stoneAge.value().criteria().keySet().iterator().next();
		AgentPlayer agent = spawnAgent(helper, "Miner", AgentRole.MINER, 2, 0, 2);
		ServerPlayer human = spawnHumanStandIn(helper, 5, 0, 5);
		String agentName = agent.getGameProfile().name();
		String humanName = human.getGameProfile().name();
		agent.getAdvancements().award(stoneAge, criterion);
		human.getAdvancements().award(stoneAge, criterion);
		helper.assertTrue(agent.getAdvancements().getOrStartProgress(stoneAge).isDone(), "agents still earn advancements");
		helper.assertTrue(BROADCASTS.stream().anyMatch(m -> m.contains(humanName)), "a human's advancement is announced (control)");
		helper.assertFalse(BROADCASTS.stream().anyMatch(m -> m.contains(agentName)), "an agent's advancement is not announced");
		helper.succeed();
	}

	@GameTest(maxTicks = 20)
	public void agentsStayOutOfTheUserCache(final GameTestHelper helper) {
		MinecraftServer server = helper.getLevel().getServer();
		AgentPlayer agent = spawnAgent(helper, "Cache", AgentRole.ENGINEER, 2, 0, 2);
		ServerPlayer human = spawnHumanStandIn(helper, 5, 0, 5);
		helper.assertTrue(server.services().nameToIdCache().get(human.getUUID()).isPresent(), "a human is cached (control)");
		helper.assertTrue(server.services().nameToIdCache().get(agent.getUUID()).isEmpty(), "an agent never goes into usercache.json");
		helper.succeed();
	}

	// ------------------------------------------------------------------ graves (MINOR 15)

	@GameTest
	public void graveNeverReplacesWaterloggedBlocks(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos feet = helper.absolutePos(new BlockPos(3, 1, 3));
		level.setBlock(feet, Blocks.OAK_STAIRS.defaultBlockState().setValue(StairBlock.WATERLOGGED, true), 3);
		BlockPos chosen = AgentService.findGravePos(level, feet);
		helper.assertTrue(chosen != null && !chosen.equals(feet), "waterlogged stairs are a block, not water: got " + chosen);
		level.setBlock(feet, Blocks.OAK_SLAB.defaultBlockState().setValue(BlockStateProperties.WATERLOGGED, true).setValue(SlabBlock.TYPE, net.minecraft.world.level.block.state.properties.SlabType.BOTTOM), 3);
		helper.assertFalse(feet.equals(AgentService.findGravePos(level, feet)), "nor are waterlogged slabs");
		level.setBlock(feet, Blocks.WATER.defaultBlockState(), 3);
		helper.assertTrue(feet.equals(AgentService.findGravePos(level, feet)), "plain water still takes a grave");
		level.setBlock(feet, Blocks.SHORT_GRASS.defaultBlockState(), 3);
		helper.assertTrue(feet.equals(AgentService.findGravePos(level, feet)), "so does a replaceable plant");
		helper.succeed();
	}

	// ------------------------------------------------------------------ dead bodies (MINOR 16)

	@GameTest(maxTicks = 40)
	public void deadAgentIsGoneAtOnceAndCleanedUpWhenTheServerStops(final GameTestHelper helper) throws IOException {
		ServerLevel level = helper.getLevel();
		MinecraftServer server = level.getServer();
		AgentService service = AgentService.get(server);
		AgentPlayer agent = spawnAgent(helper, "Gone", AgentRole.MINER, 3, 0, 3);
		String id = agent.agentId();
		String name = agent.getGameProfile().name();
		UUID uuid = agent.getUUID();
		server.getPlayerList().saveAll();
		Path data = AgentService.playerDataFile(server, uuid);
		helper.assertTrue(Files.exists(data), "playerdata exists before death");

		agent.kill(level);
		// Same tick: the body is still in the player list, waiting for next tick's removal.
		helper.assertTrue(service.agent(id) == null, "a dead body is never handed out as the agent");
		boolean refused;
		try {
			service.spawn(id, name, AgentRole.MINER, level, agent.position(), 0.0F);
			refused = false;
		} catch (IllegalStateException e) {
			refused = true;
		}
		helper.assertTrue(refused, "spawn must refuse a dead agent, not return its body");

		// The server stops in this very tick: SERVER_STOPPING runs the removal now instead of on a tick that never comes.
		service.runAllPending();
		helper.assertTrue(server.getPlayerList().getPlayer(uuid) == null, "dead body removed on stop");
		helper.assertFalse(Files.exists(data), "dead agent's playerdata deleted on stop");

		// A crash between death and removal leaves files behind: the next start sweeps them.
		Files.createDirectories(data.getParent());
		Files.writeString(data, "stale");
		service.sweepDeadPlayerFiles();
		helper.assertFalse(Files.exists(data), "leftover playerdata of a dead agent is swept");
		helper.succeed();
	}
}
