package dev.minevibe.gametest.pc;

import com.mojang.authlib.GameProfile;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.pc.PcBlockEntity;
import dev.minevibe.pc.PcContent;
import dev.minevibe.pc.PcDeskBlock;
import dev.minevibe.pc.PcDeskPart;
import dev.minevibe.pc.PcLed;
import dev.minevibe.pc.PcRegistry;
import dev.minevibe.pc.PcStates;
import dev.minevibe.pc.PcWorkstation;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatKind;
import io.netty.channel.embedded.EmbeddedChannel;
import java.lang.reflect.Field;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.GameTestInfo;
import net.minecraft.gametest.framework.GameTestListener;
import net.minecraft.gametest.framework.GameTestRunner;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.game.ServerboundPlayerLoadedPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Server GameTests for PCs in the world (PLAN 7.5, 7.7; track T2): the workstation's blocks, create-on-place without
 * Node, unplug-on-break with the bound item dropped, the LED following {@code pc.state}, and the human player at a PC
 * reported as {@code pc.seat} / {@code pc.unseat}. Test ids are {@code minevibe-gametest:pc_game_tests_<method>}.
 */
public final class PcGameTests {
	// ------------------------------------------------------------------ placement

	@GameTest(maxTicks = 20)
	public void workstationPlacesFourDeskBlocksAndAFacingChair(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(2, 0, 3));
		Direction facing = Direction.NORTH;
		helper.assertTrue(PcWorkstation.canPlace(level, origin, facing), "an empty structure has room");
		PcBlockEntity be = PcWorkstation.place(level, origin, facing, "linux", "gt-place");
		helper.assertTrue(be != null, "the monitor block holds the block entity");
		Direction side = PcDeskBlock.sideDirection(facing);
		assertPart(helper, level.getBlockState(origin), PcDeskPart.MAIN, DoubleBlockHalf.LOWER, facing);
		assertPart(helper, level.getBlockState(origin.relative(side)), PcDeskPart.SIDE, DoubleBlockHalf.LOWER, facing);
		assertPart(helper, level.getBlockState(origin.above()), PcDeskPart.MAIN, DoubleBlockHalf.UPPER, facing);
		assertPart(helper, level.getBlockState(origin.relative(side).above()), PcDeskPart.SIDE, DoubleBlockHalf.UPPER, facing);
		BlockPos chair = PcDeskBlock.chairPos(origin, facing);
		BlockState chairState = level.getBlockState(chair);
		helper.assertTrue(chairState.is(MvWorldContent.OFFICE_CHAIR), "a chair stands in front of the desk");
		helper.assertTrue(chairState.getValue(OfficeChairBlock.FACING) == facing.getOpposite(), "the chair faces the desk");
		helper.assertTrue(chairState.getValue(OfficeChairBlock.KIND) == SeatKind.PC, "a PC chair");
		helper.assertTrue(chair.equals(be.seatPos()), "the block entity knows its chair");
		helper.assertTrue("gt-place".equals(be.pcId()) && "linux".equals(be.type()), "bound to the PC");
		helper.assertTrue(origin.above().equals(PcRegistry.deskOf("gt-place").pos()), "the registry knows the desk");
		helper.assertTrue("gt-place".equals(PcRegistry.pcAtChair(level, chair)), "and the chair");
		helper.assertFalse(PcWorkstation.canPlace(level, origin, facing), "the footprint is now taken");
		helper.succeed();
	}

	@GameTest(maxTicks = 20)
	public void aWorkstationNeedsRoomForTheChair(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(3, 0, 4));
		level.setBlockAndUpdate(PcDeskBlock.chairPos(origin, Direction.NORTH), Blocks.STONE.defaultBlockState());
		helper.assertFalse(PcWorkstation.canPlace(level, origin, Direction.NORTH), "the chair's block is stone");
		helper.assertTrue(PcWorkstation.canPlace(level, origin, Direction.SOUTH), "facing the other way it fits");
		helper.succeed();
	}

	@GameTest(maxTicks = 40)
	public void placingAnUnboundItemWithoutNodeLeavesARefusedDesk(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer player = standIn(helper, 4, 0, 1);
		ItemStack stack = new ItemStack(PcContent.LINUX_WORKSTATION);
		player.setItemInHand(InteractionHand.MAIN_HAND, stack);
		// The player looks south (yaw 0): the desk faces north, towards the player.
		BlockPos floor = helper.absolutePos(new BlockPos(4, -1, 4));
		BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(floor), Direction.UP, floor, false);
		InteractionResult result = stack.useOn(new UseOnContext(level, player, InteractionHand.MAIN_HAND, stack, hit));
		helper.assertTrue(result.consumesAction(), "the item placed a workstation: " + result);
		helper.assertTrue(stack.isEmpty(), "a survival player's item is used up");
		BlockPos origin = floor.above();
		helper.succeedWhen(() -> {
			helper.assertTrue(level.getBlockEntity(origin.above()) instanceof PcBlockEntity, "desk placed");
			PcBlockEntity be = (PcBlockEntity) level.getBlockEntity(origin.above());
			helper.assertTrue(be.pcId() == null, "no PC without Node");
			helper.assertFalse(be.isCreating(), "the create request has failed");
			helper.assertTrue("OFFLINE".equals(be.createError()), "refusal kept for the monitor: " + be.createError());
			helper.assertTrue(level.getBlockState(origin.above()).getValue(PcDeskBlock.LED) == PcLed.RED, "LED red");
			helper.assertTrue(level.getBlockState(origin).getValue(PcDeskBlock.FACING) == Direction.NORTH, "the desk faces the player");
		});
	}

	@GameTest(maxTicks = 20)
	public void aPcIsNotPlacedTwice(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		PcWorkstation.place(level, helper.absolutePos(new BlockPos(1, 0, 5)), Direction.NORTH, "linux", "gt-twice");
		ServerPlayer player = standIn(helper, 5, 0, 1);
		ItemStack stack = new ItemStack(PcContent.LINUX_WORKSTATION);
		stack.set(PcContent.PC_ID, "gt-twice");
		player.setItemInHand(InteractionHand.MAIN_HAND, stack);
		BlockPos floor = helper.absolutePos(new BlockPos(5, -1, 4));
		InteractionResult result = stack.useOn(new UseOnContext(level, player, InteractionHand.MAIN_HAND, stack,
			new BlockHitResult(Vec3.atCenterOf(floor), Direction.UP, floor, false)));
		helper.assertFalse(result.consumesAction(), "refused");
		helper.assertTrue(level.getBlockState(floor.above()).isAir(), "nothing placed");
		helper.assertTrue(stack.getCount() == 1, "the item is kept");
		helper.succeed();
	}

	// ------------------------------------------------------------------ breaking

	@GameTest(maxTicks = 20)
	public void breakingAnyPartRemovesTheDeskAndDropsTheBoundItem(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(2, 0, 3));
		Direction facing = Direction.EAST;
		PcWorkstation.place(level, origin, facing, "linux", "gt-break");
		BlockPos sideLower = origin.relative(PcDeskBlock.sideDirection(facing));
		level.destroyBlock(sideLower, true);
		for (BlockPos p : PcWorkstation.footprint(origin, facing).subList(0, 4)) {
			helper.assertTrue(level.getBlockState(p).isAir(), "every desk block is gone: " + p);
		}
		List<ItemEntity> drops = level.getEntitiesOfClass(ItemEntity.class, new AABB(origin).inflate(3));
		long bound = drops.stream()
			.filter(e -> e.getItem().is(PcContent.LINUX_WORKSTATION) && "gt-break".equals(e.getItem().get(PcContent.PC_ID)))
			.count();
		helper.assertTrue(bound == 1, "exactly one workstation item, bound to gt-break (found " + bound + " of " + drops.size() + ")");
		helper.assertTrue(PcRegistry.deskOf("gt-break") == null, "the registry forgot the desk");
		drops.forEach(ItemEntity::discard);
		helper.succeed();
	}

	// ------------------------------------------------------------------ LED

	@GameTest(maxTicks = 40)
	public void theLedFollowsPcState(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(2, 0, 3));
		PcWorkstation.place(level, origin, Direction.SOUTH, "linux", "gt-led");
		BlockPos monitor = origin.above();
		helper.startSequence()
			.thenExecute(() -> PcStates.put(info("gt-led", 901, "booting")))
			.thenWaitUntil(() -> helper.assertTrue(level.getBlockState(monitor).getValue(PcDeskBlock.LED) == PcLed.AMBER, "booting is amber"))
			.thenExecute(() -> PcStates.put(info("gt-led", 901, "running")))
			.thenWaitUntil(() -> helper.assertTrue(level.getBlockState(monitor).getValue(PcDeskBlock.LED) == PcLed.GREEN, "running is green"))
			.thenExecute(() -> PcStates.put(info("gt-led", 901, "no_capacity")))
			.thenWaitUntil(() -> helper.assertTrue(level.getBlockState(monitor).getValue(PcDeskBlock.LED) == PcLed.RED, "no capacity is red"))
			.thenExecute(() -> helper.assertTrue(
				level.getBlockEntity(monitor) instanceof PcBlockEntity be && "gt-led".equals(be.pcId()), "an LED change keeps the block entity"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ the player at a PC

	@GameTest(maxTicks = 60)
	public void sittingAtAPcChairReportsSeatAndStandingReportsUnseat(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(new BlockPos(4, 0, 5));
		PcWorkstation.place(level, origin, Direction.NORTH, "linux", "gt-seat");
		BlockPos chair = PcDeskBlock.chairPos(origin, Direction.NORTH);
		ServerPlayer player = standIn(helper, 1, 0, 1);
		List<String> events = new CopyOnWriteArrayList<>();
		PcRegistry.setSeatSink(new PcRegistry.SeatSink() {
			@Override
			public void seat(final String pcId, final Types.Occupant occupant) {
				events.add("seat " + pcId + " " + occupant.kind());
			}

			@Override
			public void unseat(final String pcId, final Types.Occupant occupant, final String reason) {
				events.add("unseat " + pcId + " " + occupant.kind() + " " + reason);
			}
		});
		onTestEnd(helper, () -> PcRegistry.setSeatSink(null));
		helper.startSequence()
			.thenExecute(() -> helper.assertTrue(OfficeChairBlock.trySit(level, chair, player), "the player sits"))
			.thenWaitUntil(() -> helper.assertTrue(events.contains("seat gt-seat player"), "pc.seat sent: " + events))
			.thenExecute(() -> helper.assertTrue("gt-seat".equals(PcRegistry.seatedPc(player.getUUID())), "registry knows the seat"))
			.thenExecute(() -> PcRegistry.standUp(player, "stand"))
			.thenWaitUntil(() -> helper.assertTrue(events.contains("unseat gt-seat player stand"), "pc.unseat sent: " + events))
			.thenExecute(() -> helper.assertFalse(player.isPassenger(), "the player stood up"))
			.thenSucceed();
	}

	// ------------------------------------------------------------------ helpers

	private static void assertPart(final GameTestHelper helper, final BlockState state, final PcDeskPart part, final DoubleBlockHalf half, final Direction facing) {
		helper.assertTrue(state.getBlock() instanceof PcDeskBlock, "a desk block: " + state);
		helper.assertTrue(state.getValue(PcDeskBlock.PART) == part && state.getValue(PcDeskBlock.HALF) == half, "part " + part + "/" + half + ": " + state);
		helper.assertTrue(state.getValue(PcDeskBlock.FACING) == facing, "facing " + facing + ": " + state);
	}

	private static Pc.PcInfo info(final String pcId, final long slot, final String status) {
		return new Pc.PcInfo(pcId, "linux", pcId, status, null, null, slot, 2, 4096, 64, true, false, false, List.of(), null, null, null, null, null);
	}

	/** A plain survival ServerPlayer (the human player's stand-in), removed when the test ends. */
	private static ServerPlayer standIn(final GameTestHelper helper, final double x, final double y, final double z) {
		ServerLevel level = helper.getLevel();
		GameProfile profile = new GameProfile(UUID.randomUUID(), "pc_" + Long.toString(System.nanoTime() % 1_000_000_000L, 36));
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
