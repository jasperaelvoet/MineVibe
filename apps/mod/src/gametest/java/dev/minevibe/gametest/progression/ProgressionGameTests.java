package dev.minevibe.gametest.progression;

import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.minevibe.MineVibeMod;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.progression.Awakening;
import dev.minevibe.progression.CorePayment;
import dev.minevibe.progression.ProgressionContent;
import io.netty.channel.embedded.EmbeddedChannel;
import java.lang.reflect.Field;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.Registries;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.GameTestInfo;
import net.minecraft.gametest.framework.GameTestListener;
import net.minecraft.gametest.framework.GameTestRunner;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.game.ServerboundPlayerLoadedPacket;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Server GameTests for the survival start (PLAN 7.5 "Agent Core"): the awakening ritual on two stacked copper blocks
 * (accepted: blocks and core spent, {@code agent.awaken} sent; refused: both given back; anything but a copper stack:
 * nothing happens), hires paid with a core, and every MineVibe placeable craftable in survival. Node is a stand-in
 * answering {@code agent.awaken} per player ({@link Awakening#setRequester}). Test ids are
 * {@code minevibe-gametest:progression_game_tests_<method>}.
 */
public final class ProgressionGameTests {
	/** How each stand-in player's ritual is answered, by player name (tests run side by side). */
	private static final Map<String, Function<Bodies.AgentAwaken, CompletableFuture<JsonObject>>> NODE = new ConcurrentHashMap<>();

	static {
		Awakening.setRequester(request -> {
			Function<Bodies.AgentAwaken, CompletableFuture<JsonObject>> answer = NODE.get(request.by());
			return answer != null
				? answer.apply(request)
				: CompletableFuture.failedFuture(new BridgeException(Awakening.OFFLINE, "no stand-in Node for " + request.by()));
		});
	}

	// ------------------------------------------------------------------ the ritual

	@GameTest(maxTicks = 40)
	public void anAcceptedRitualSpendsTheCoreAndTheCopper(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = standIn(helper, 1, 0, 2);
		BlockPos base = helper.absolutePos(new BlockPos(3, 0, 3));
		level.setBlockAndUpdate(base, copper("copper_block"));
		level.setBlockAndUpdate(base.above(), copper("waxed_weathered_copper"));
		ItemStack cores = new ItemStack(ProgressionContent.AGENT_CORE, 2);
		player.setItemInHand(InteractionHand.MAIN_HAND, cores);
		List<Bodies.AgentAwaken> sent = new java.util.concurrent.CopyOnWriteArrayList<>();
		NODE.put(name(player), request -> {
			sent.add(request);
			JsonObject ok = new JsonObject();
			ok.addProperty("agentId", "ada1234");
			ok.addProperty("name", "Ada");
			return CompletableFuture.completedFuture(ok);
		});
		onTestEnd(helper, () -> NODE.remove(name(player)));

		InteractionResult result = use(level, player, cores, base.above());
		helper.assertTrue(result.consumesAction(), "the core was used: " + result);
		helper.assertTrue(level.getBlockState(base).isAir() && level.getBlockState(base.above()).isAir(), "both copper blocks are gone");
		helper.assertTrue(cores.getCount() == 1, "one core spent: " + cores.getCount());
		helper.assertTrue(sent.size() == 1, "agent.awaken sent once: " + sent);
		Bodies.AgentAwaken request = sent.getFirst();
		helper.assertTrue(
			request.pos().x() == base.getX() && request.pos().y() == base.getY() && request.pos().z() == base.getZ(),
			"pos is the lower block: " + request.pos());
		helper.assertTrue("minecraft:overworld".equals(request.dim()), "dim: " + request.dim());
		helper.succeedWhen(() -> {
			helper.assertFalse(Awakening.pending(player.getUUID()), "Node answered");
			helper.assertTrue(cores.getCount() == 1 && count(player.getInventory()) == 1, "the core stays spent");
			helper.assertTrue(level.getBlockState(base).isAir() && level.getBlockState(base.above()).isAir(), "the copper stays spent");
		});
	}

	@GameTest(maxTicks = 40)
	public void aRefusedRitualGivesTheCoreAndTheCopperBack(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = standIn(helper, 1, 0, 2);
		BlockPos base = helper.absolutePos(new BlockPos(3, 0, 3));
		BlockState lower = copper("exposed_copper");
		BlockState upper = copper("oxidized_copper");
		level.setBlockAndUpdate(base, lower);
		level.setBlockAndUpdate(base.above(), upper);
		ItemStack cores = new ItemStack(ProgressionContent.AGENT_CORE, 1);
		player.setItemInHand(InteractionHand.MAIN_HAND, cores);
		NODE.put(name(player), request -> CompletableFuture.failedFuture(
			new BridgeException("CEO_EXISTS", "Ada is your CEO and hires the crew: approve a hire card to use a core.")));
		onTestEnd(helper, () -> NODE.remove(name(player)));

		InteractionResult result = use(level, player, cores, base.above());
		helper.assertTrue(result.consumesAction(), "the ritual started: " + result);
		helper.assertTrue(cores.isEmpty(), "the core is set aside while Node decides");
		helper.succeedWhen(() -> {
			helper.assertFalse(Awakening.pending(player.getUUID()), "Node answered");
			helper.assertTrue(count(player.getInventory()) == 1, "the core came back: " + count(player.getInventory()));
			helper.assertTrue(level.getBlockState(base) == lower, "the lower copper block is back: " + level.getBlockState(base));
			helper.assertTrue(level.getBlockState(base.above()) == upper, "the upper copper block is back");
		});
	}

	@GameTest(maxTicks = 40)
	public void withoutNodeTheRitualIsRefusedAndNothingIsSpent(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = standIn(helper, 1, 0, 2);
		BlockPos base = helper.absolutePos(new BlockPos(3, 0, 3));
		level.setBlockAndUpdate(base, copper("copper_block"));
		level.setBlockAndUpdate(base.above(), copper("copper_block"));
		ItemStack cores = new ItemStack(ProgressionContent.AGENT_CORE, 1);
		player.setItemInHand(InteractionHand.MAIN_HAND, cores);
		// No stand-in Node for this player: the requester fails at once, like a game without a bridge.
		use(level, player, cores, base.above());
		helper.succeedWhen(() -> {
			helper.assertFalse(Awakening.pending(player.getUUID()), "refused");
			helper.assertTrue(count(player.getInventory()) == 1, "the core came back");
			helper.assertTrue(level.getBlockState(base).is(Blocks.COPPER_BLOCK.weathering().unaffected()), "the copper is back");
		});
	}

	@GameTest(maxTicks = 20)
	public void onlyTwoStackedCopperBlocksMakeAnAltar(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = standIn(helper, 1, 0, 1);
		NODE.put(name(player), request -> {
			throw new AssertionError("no agent.awaken expected: " + request);
		});
		onTestEnd(helper, () -> NODE.remove(name(player)));
		ItemStack cores = new ItemStack(ProgressionContent.AGENT_CORE, 3);
		player.setItemInHand(InteractionHand.MAIN_HAND, cores);
		// A single copper block on the floor.
		BlockPos single = helper.absolutePos(new BlockPos(2, 0, 3));
		level.setBlockAndUpdate(single, copper("copper_block"));
		// Copper on stone.
		BlockPos onStone = helper.absolutePos(new BlockPos(4, 0, 3));
		level.setBlockAndUpdate(onStone, Blocks.STONE.defaultBlockState());
		level.setBlockAndUpdate(onStone.above(), copper("copper_block"));
		// Two cut copper blocks are not copper blocks.
		BlockPos cut = helper.absolutePos(new BlockPos(6, 0, 3));
		level.setBlockAndUpdate(cut, Blocks.CUT_COPPER.weathering().unaffected().defaultBlockState());
		level.setBlockAndUpdate(cut.above(), Blocks.CUT_COPPER.weathering().unaffected().defaultBlockState());
		for (BlockPos top : List.of(single, onStone.above(), cut.above())) {
			InteractionResult result = use(level, player, cores, top);
			helper.assertFalse(result.consumesAction(), "nothing happens at " + top.toShortString() + ": " + result);
			helper.assertFalse(level.getBlockState(top).isAir(), "the block stays at " + top.toShortString());
		}
		helper.assertTrue(cores.getCount() == 3, "no core spent");
		helper.assertFalse(Awakening.pending(player.getUUID()), "no ritual waits");
		helper.succeed();
	}

	// ------------------------------------------------------------------ paying for hires

	@GameTest(maxTicks = 20)
	public void aHireTakesOneCoreFromTheInventory(final GameTestHelper helper) {
		ServerPlayer player = standIn(helper, 1, 0, 1);
		Inventory inventory = player.getInventory();
		inventory.setItem(0, new ItemStack(Items.DIRT));
		inventory.setItem(5, new ItemStack(ProgressionContent.AGENT_CORE, 2));
		helper.assertTrue(CorePayment.takeOne(inventory), "the first core");
		helper.assertTrue(count(inventory) == 1, "one left");
		helper.assertTrue(CorePayment.takeOne(inventory), "the second core");
		helper.assertFalse(CorePayment.takeOne(inventory), "none left: the hire is refused (NO_CORE)");
		helper.assertTrue(inventory.getItem(0).is(Items.DIRT), "nothing else is taken");
		helper.succeed();
	}

	// ------------------------------------------------------------------ crafting

	@GameTest(maxTicks = 5)
	public void everyPlaceableIsCraftableAndHasItsRecipeUnlock(final GameTestHelper helper) {
		MinecraftServer server = helper.getLevel().getServer();
		for (String id : List.of(
			"agent_core", "codex", "linux_workstation", "mac_workstation", "calendar", "wall_calendar", "meeting_table", "office_chair")) {
			ResourceKey<net.minecraft.world.item.crafting.Recipe<?>> key = ResourceKey.create(Registries.RECIPE, MineVibeMod.id(id));
			helper.assertTrue(server.getRecipeManager().byKey(key).isPresent(), "recipe minevibe:" + id);
			helper.assertTrue(server.getAdvancements().get(MineVibeMod.id("recipes/misc/" + id)) != null, "recipe unlock for " + id);
		}
		ResourceKey<net.minecraft.world.item.crafting.Recipe<?>> grave = ResourceKey.create(Registries.RECIPE, MineVibeMod.id("grave"));
		helper.assertFalse(server.getRecipeManager().byKey(grave).isPresent(), "graves are never crafted");
		for (String step : List.of("root", "spark", "heart", "alive", "desk", "codex", "calendar", "meeting", "team")) {
			helper.assertTrue(server.getAdvancements().get(MineVibeMod.id("guide/" + step)) != null, "guide advancement " + step);
		}
		helper.succeed();
	}

	// ------------------------------------------------------------------ helpers

	private static InteractionResult use(final ServerLevel level, final ServerPlayer player, final ItemStack stack, final BlockPos top) {
		BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(top).add(0, 0.5, 0), Direction.UP, top, false);
		return stack.useOn(new UseOnContext(level, player, InteractionHand.MAIN_HAND, stack, hit));
	}

	private static BlockState copper(final String path) {
		Block block = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getValue(net.minecraft.resources.Identifier.withDefaultNamespace(path));
		return block.defaultBlockState();
	}

	private static int count(final Inventory inventory) {
		int n = 0;
		for (int i = 0; i < inventory.getContainerSize(); i++) {
			if (inventory.getItem(i).is(ProgressionContent.AGENT_CORE)) {
				n += inventory.getItem(i).getCount();
			}
		}
		return n;
	}

	private static String name(final ServerPlayer player) {
		return player.getGameProfile().name();
	}

	private static ServerPlayer standIn(final GameTestHelper helper, final double x, final double y, final double z) {
		ServerLevel level = helper.getLevel();
		GameProfile profile = new GameProfile(UUID.randomUUID(), "pg_" + Long.toString(System.nanoTime() % 1_000_000_000L, 36));
		CommonListenerCookie cookie = CommonListenerCookie.createInitial(profile, false);
		ServerPlayer player = new ServerPlayer(level.getServer(), level, profile, cookie.clientInformation());
		player.snapTo(helper.absoluteVec(new Vec3(x + 0.5, y, z + 0.5)), 0.0F, 0.0F);
		Connection connection = new Connection(PacketFlow.SERVERBOUND);
		new EmbeddedChannel(connection);
		level.getServer().getPlayerList().placeNewPlayer(connection, player, cookie);
		player.connection.handleAcceptPlayerLoad(new ServerboundPlayerLoadedPacket());
		player.setGameMode(GameType.SURVIVAL);
		onTestEnd(helper, () -> {
			if (!player.hasDisconnected()) {
				player.disconnect();
				level.getServer().getPlayerList().remove(player);
			}
		});
		return player;
	}

	private static void onTestEnd(final GameTestHelper helper, final Runnable action) {
		GameTestInfo info;
		try {
			Field field = GameTestHelper.class.getDeclaredField("testInfo");
			field.setAccessible(true);
			info = (GameTestInfo) field.get(helper);
		} catch (ReflectiveOperationException e) {
			throw new IllegalStateException("GameTestHelper.testInfo not accessible", e);
		}
		info.addListener(new GameTestListener() {
			@Override
			public void testStructureLoaded(final GameTestInfo testInfo) {
			}

			@Override
			public void testPassed(final GameTestInfo testInfo, final GameTestRunner runner) {
				action.run();
			}

			@Override
			public void testFailed(final GameTestInfo testInfo, final GameTestRunner runner) {
				action.run();
			}

			@Override
			public void testAddedForRerun(final GameTestInfo original, final GameTestInfo copy, final GameTestRunner runner) {
			}
		});
	}
}
