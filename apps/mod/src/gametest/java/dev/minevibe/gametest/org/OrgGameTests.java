package dev.minevibe.gametest.org;

import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.calendar.WallCalendarBlock;
import dev.minevibe.org.codex.CodexBlock;
import dev.minevibe.org.codex.CodexBlockEntity;
import dev.minevibe.org.codex.CodexPart;
import dev.minevibe.org.meeting.MeetingSeats;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficePlan;
import dev.minevibe.org.office.OfficeService;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatEntity;
import dev.minevibe.world.seat.SeatKind;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ThreadLocalRandom;
import net.fabricmc.fabric.api.gametest.v1.GameTest;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.GameTestInfo;
import net.minecraft.gametest.framework.GameTestListener;
import net.minecraft.gametest.framework.GameTestRunner;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.AbstractBedBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * GameTests for the org blocks and the starter office (PLAN §7.5, §13.3): the office builds fully and the same way
 * every time, the meeting table seats 6 with single occupancy, the codex multiblock places and breaks as one, and a
 * wall calendar needs its wall.
 */
public final class OrgGameTests {
	private static final String OFFICE_SITE = "minevibe-gametest:office_site";
	private static final String ARENA = "minevibe-gametest:arena";
	/** The office origin inside the office_site structure (floor on top of its stone layer). */
	private static final BlockPos OFFICE_AT = new BlockPos(1, 1, 1);

	// ------------------------------------------------------------------ office

	@GameTest(structure = OFFICE_SITE, maxTicks = 40)
	public void officeBuildsFully(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(OFFICE_AT);
		OfficeLayout layout = OfficeBuilder.build(level, origin);

		// Shell: floor, walls, roof.
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z < OfficePlan.DEPTH; z++) {
				BlockState floor = level.getBlockState(origin.offset(x, 0, z));
				helper.assertTrue(!floor.isAir(), "floor at " + x + "," + z);
				helper.assertTrue(level.getBlockState(origin.offset(x, OfficePlan.ROOF, z)).equals(OfficeBuilder.ROOF), "roof at " + x + "," + z);
				if (OfficePlan.isWall(x, z)) {
					for (int y = 1; y <= OfficePlan.WALL_TOP; y++) {
						helper.assertTrue(!level.getBlockState(origin.offset(x, y, z)).isAir(), "wall at " + x + "," + y + "," + z);
					}
				}
			}
		}

		// Every piece of the plan is in place.
		for (OfficePlan.Piece piece : OfficePlan.PIECES) {
			BlockPos at = origin.offset(piece.x(), piece.y(), piece.z());
			BlockState state = level.getBlockState(at);
			String where = piece.kind() + " at " + piece.x() + "," + piece.y() + "," + piece.z();
			switch (piece.kind()) {
				case CODEX -> helper.assertTrue(CodexBlock.isComplete(level, at), where);
				case WALL_CALENDAR -> helper.assertTrue(state.is(OrgContent.WALL_CALENDAR) && state.canSurvive(level, at), where);
				case MEETING_TABLE -> helper.assertTrue(state.is(OrgContent.MEETING_TABLE), where);
				case MEETING_CHAIR -> helper.assertTrue(state.is(MvWorldContent.OFFICE_CHAIR) && state.getValue(OfficeChairBlock.KIND) == SeatKind.MEETING, where);
				case BED -> {
					helper.assertTrue(state.getBlock() instanceof AbstractBedBlock && state.getValue(AbstractBedBlock.PART) == BedPart.FOOT, where);
					BlockState head = level.getBlockState(at.relative(OfficeBuilder.direction(piece.facing())));
					helper.assertTrue(head.getBlock() instanceof AbstractBedBlock && head.getValue(AbstractBedBlock.PART) == BedPart.HEAD, where + " (head)");
				}
				case CHEST -> {
					helper.assertTrue(state.is(Blocks.CHEST), where);
					ChestBlockEntity chest = (ChestBlockEntity)level.getBlockEntity(at);
					helper.assertTrue(chest != null && count(chest, Items.BREAD) == OfficeBuilder.BREAD && count(chest, Items.TORCH) == OfficeBuilder.TORCHES,
						"the chest holds bread and torches");
				}
				case CRAFTING_TABLE -> helper.assertTrue(state.is(Blocks.CRAFTING_TABLE), where);
				case FURNACE -> helper.assertTrue(state.is(Blocks.FURNACE), where);
				case WORKSTATION -> {
					for (int[] cell : piece.cells()) {
						helper.assertTrue(level.getBlockState(origin.offset(cell[0], 0, cell[2])).equals(OfficeBuilder.SLOT_MARKER), where + " marker");
					}
				}
				case LANTERN -> helper.assertTrue(state.is(Blocks.LANTERN), where);
				case DOOR -> helper.assertTrue(state.getBlock() instanceof DoorBlock && state.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER
					&& level.getBlockState(at.above()).getBlock() instanceof DoorBlock, where);
				case WINDOW -> helper.assertTrue(state.is(Blocks.GLASS_PANE), where);
				case OUTDOOR_TORCH -> helper.assertTrue(state.is(Blocks.WALL_TORCH), where);
			}
		}

		// The meeting table links its 6 chairs; the codex has its book.
		BlockPos table = layout.firstSlot(OfficeLayout.MEETING_TABLE).pos();
		helper.assertValueEqual(MeetingTables.chairsOf(level, table).size(), 6, "meeting chairs");
		BlockPos codex = layout.firstSlot(OfficeLayout.CODEX).pos();
		helper.assertTrue(level.getBlockEntity(codex.offset(CodexPart.BOOK.offset(Direction.SOUTH))) instanceof CodexBlockEntity, "the codex book");

		// The spawn cell is free and stands on the floor.
		BlockPos spawn = layout.spawn();
		helper.assertTrue(level.getBlockState(spawn).isAir() && level.getBlockState(spawn.above()).isAir(), "room to stand at the spawn");
		helper.assertTrue(level.getBlockState(spawn.below()).equals(OfficeBuilder.FLOOR), "floor under the spawn");
		helper.assertValueEqual(spawn, origin.offset(OfficePlan.SPAWN_X, OfficePlan.SPAWN_Y, OfficePlan.SPAWN_Z), "spawn");

		// The layout Node gets.
		helper.assertValueEqual(layout.slotsOf(OfficeLayout.WORKSTATION).size(), 2, "workstation slots");
		helper.assertValueEqual(layout.slotsOf(OfficeLayout.BED).size(), 2, "bed slots");
		for (String kind : List.of(OfficeLayout.CODEX, OfficeLayout.WALL_CALENDAR, OfficeLayout.CHEST, OfficeLayout.DOOR, OfficeLayout.SPAWN)) {
			helper.assertTrue(layout.firstSlot(kind) != null, "slot " + kind);
		}
		helper.assertValueEqual(OfficeLayout.fromJson(layout.toJson()), layout, "layout survives office.json");
		JsonObject state = new JsonObject();
		state.addProperty("t", "world.state");
		state.addProperty("v", 1);
		state.addProperty("worldId", "w-test");
		state.addProperty("phase", "ready");
		state.add("office", layout.toWorldState());
		helper.assertValueEqual(Messages.WORLD_STATE.schema().validate(state), List.of(), "world.state.office matches the protocol");

		// Lit: the light engine catches up within a few ticks.
		helper.runAfterDelay(5, () -> {
			for (int x = 1; x < OfficePlan.WIDTH - 1; x++) {
				for (int z = 1; z < OfficePlan.DEPTH - 1; z++) {
					BlockPos at = origin.offset(x, 1, z);
					if (level.getBlockState(at).isAir()) {
						helper.assertTrue(level.getBrightness(LightLayer.BLOCK, at) > 0, "dark spot in the office at " + x + "," + z);
					}
				}
			}
			System.out.println("[T6] office built: " + layout.slots().size() + " slots, spawn at local " + spawn.subtract(origin).toShortString());
			helper.succeed();
		});
	}

	@GameTest(structure = OFFICE_SITE, maxTicks = 20)
	public void officeIsDeterministic(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos origin = helper.absolutePos(OFFICE_AT);
		OfficeLayout first = OfficeBuilder.build(level, origin);
		List<BlockState> before = snapshot(helper);
		// Wipe the site back to its stone floor and build again.
		for (int x = 0; x < 16; x++) {
			for (int z = 0; z < 13; z++) {
				for (int y = 9; y >= 1; y--) {
					level.setBlock(helper.absolutePos(new BlockPos(x, y, z)), Blocks.AIR.defaultBlockState(), Block.UPDATE_CLIENTS | Block.UPDATE_SUPPRESS_DROPS);
				}
			}
		}
		OfficeLayout second = OfficeBuilder.build(level, origin);
		helper.assertValueEqual(second, first, "layout");
		List<BlockState> after = snapshot(helper);
		for (int i = 0; i < before.size(); i++) {
			if (!before.get(i).equals(after.get(i))) {
				helper.fail(net.minecraft.network.chat.Component.literal("block " + i + " differs: " + before.get(i) + " vs " + after.get(i)), origin);
			}
		}
		helper.succeed();
	}

	@GameTest(structure = OFFICE_SITE, maxTicks = 20)
	public void officeStandsOnASolidFoundation(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		// Floor three blocks above the stone: two layers of foundation must fill the gap under every cell.
		BlockPos origin = helper.absolutePos(new BlockPos(1, 3, 1));
		OfficeBuilder.build(level, origin);
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z <= OfficePlan.PORCH_Z; z++) {
				if (!OfficePlan.inFootprint(x, z) && !OfficePlan.isPorch(x, z)) {
					continue;
				}
				for (int y = 1; y <= 2; y++) {
					helper.assertTrue(level.getBlockState(helper.absolutePos(new BlockPos(1 + x, y, 1 + z))).equals(OfficeBuilder.FOUNDATION),
						"foundation under " + x + "," + z);
				}
			}
		}
		// Nothing outside the footprint was touched.
		helper.assertTrue(level.getBlockState(helper.absolutePos(new BlockPos(0, 1, 1))).isAir(), "outside the footprint");
		helper.assertTrue(level.getBlockState(helper.absolutePos(new BlockPos(1 + OfficePlan.DOOR_X - 2, 2, 1 + OfficePlan.PORCH_Z))).isAir(), "beside the porch");
		helper.succeed();
	}

	@GameTest(structure = OFFICE_SITE, skyAccess = true)
	public void officeSitsOnTheGroundAroundTheSpawn(final GameTestHelper helper) {
		// The site's ground is its stone layer (y 0): the office floor replaces it, centred so the spawn cell is above.
		// (Sky access: no barrier ceiling over the site, which the heightmap would count as ground.)
		BlockPos spawn = helper.absolutePos(new BlockPos(7, 5, 7));
		BlockPos origin = OfficeBuilder.originForSpawn(helper.getLevel(), spawn);
		helper.assertValueEqual(origin, helper.absolutePos(new BlockPos(7 - OfficePlan.SPAWN_X, 0, 7 - OfficePlan.SPAWN_Z)), "origin");
		helper.assertValueEqual(OfficeBuilder.originForStanding(spawn), spawn.offset(-OfficePlan.SPAWN_X, -OfficePlan.SPAWN_Y, -OfficePlan.SPAWN_Z),
			"origin for a standing player");
		helper.succeed();
	}

	@GameTest
	public void officeIsNeverBuiltByItselfInGameTests(final GameTestHelper helper) {
		helper.assertFalse(OfficeService.autoBuildEnabled(), "GameTest worlds must never get an automatic office");
		helper.succeed();
	}

	// ------------------------------------------------------------------ meeting table

	@GameTest(structure = ARENA, maxTicks = 60)
	public void meetingTableSeatsSixWithSingleOccupancy(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos table = helper.absolutePos(new BlockPos(7, 1, 7));
		level.setBlockAndUpdate(table, OrgContent.MEETING_TABLE.defaultBlockState());
		level.setBlockAndUpdate(table.east(), OrgContent.MEETING_TABLE.defaultBlockState());
		List<BlockPos> chairs = List.of(table.north(), table.east().north(), table.south(), table.east().south(), table.west(), table.east().east());
		List<Direction> facing = List.of(Direction.SOUTH, Direction.SOUTH, Direction.NORTH, Direction.NORTH, Direction.EAST, Direction.WEST);
		for (int i = 0; i < chairs.size(); i++) {
			level.setBlockAndUpdate(chairs.get(i), MvWorldContent.OFFICE_CHAIR.defaultBlockState().setValue(OfficeChairBlock.FACING, facing.get(i)));
		}
		List<BlockPos> linked = MeetingTables.relink(level, table);
		helper.assertValueEqual(linked.size(), 6, "linked chairs");
		for (BlockPos chair : chairs) {
			helper.assertTrue(MeetingSeats.isMeetingChair(level.getBlockState(chair)), "chair " + chair.toShortString() + " is a meeting seat");
		}
		helper.assertValueEqual(MeetingSeats.nearestTable(level, table.above(3)), table, "the table is found");

		List<AgentPlayer> agents = new ArrayList<>();
		for (int i = 0; i < 7; i++) {
			agents.add(spawnAgent(helper, "Sitter", 1 + i * 2, 1, 2));
		}
		for (int i = 0; i < 6; i++) {
			AgentPlayer agent = agents.get(i);
			helper.assertTrue(OfficeChairBlock.trySit(level, chairs.get(i), agent), "agent " + i + " sits");
			helper.assertTrue(agent.getVehicle() instanceof SeatEntity seat && seat.kind() == SeatKind.MEETING, "agent " + i + " rides a meeting seat");
		}
		AgentPlayer seventh = agents.get(6);
		for (BlockPos chair : chairs) {
			helper.assertFalse(OfficeChairBlock.trySit(level, chair, seventh), "a seventh sitter is rejected at " + chair.toShortString());
		}
		helper.assertFalse(seventh.isPassenger(), "the seventh agent stands");
		helper.assertTrue(MeetingSeats.freeChairs(level, table).isEmpty(), "no free chair");
		// Other tests' tables share this world: a free chair may turn up there, never at this full table.
		BlockPos elsewhere = MeetingSeats.findFreeChair(level, table);
		helper.assertTrue(elsewhere == null || !chairs.contains(elsewhere), "findFreeChair skips the full table");
		for (BlockPos chair : chairs) {
			List<SeatEntity> seats = level.getEntitiesOfClass(SeatEntity.class, new AABB(chair).inflate(0.5), s -> chair.equals(s.chairPos()));
			helper.assertValueEqual(seats.size(), 1, "seat entities at " + chair.toShortString());
			helper.assertValueEqual(seats.getFirst().getPassengers().size(), 1, "passengers at " + chair.toShortString());
		}
		agents.getFirst().stopRiding();
		helper.assertValueEqual(MeetingSeats.findFreeChair(level, table), chairs.getFirst(), "the freed chair");
		helper.assertTrue(OfficeChairBlock.trySit(level, chairs.getFirst(), seventh), "the seventh agent takes the freed chair");
		System.out.println("[T6] meeting table: 6 seated, 7th rejected, freed chair re-used");
		helper.succeed();
	}

	@GameTest(structure = ARENA)
	public void meetingTableLinksAtMostEightAndLetsGoWhenBroken(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos a = helper.absolutePos(new BlockPos(7, 1, 7));
		BlockPos b = a.east();
		level.setBlockAndUpdate(a, OrgContent.MEETING_TABLE.defaultBlockState());
		level.setBlockAndUpdate(b, OrgContent.MEETING_TABLE.defaultBlockState());
		List<BlockPos> ring = new ArrayList<>();
		for (int dx = -1; dx <= 2; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				BlockPos p = a.offset(dx, 0, dz);
				if (!p.equals(a) && !p.equals(b)) {
					ring.add(p);
					level.setBlockAndUpdate(p, MvWorldContent.OFFICE_CHAIR.defaultBlockState());
				}
			}
		}
		helper.assertValueEqual(ring.size(), 10, "chairs around the table");
		List<BlockPos> linked = MeetingTables.relink(level, b);
		helper.assertValueEqual(linked.size(), MeetingTables.MAX_CHAIRS, "linked chairs");
		helper.assertValueEqual(ring.stream().filter(p -> MeetingSeats.isMeetingChair(level.getBlockState(p))).count(), (long)MeetingTables.MAX_CHAIRS, "meeting chairs");
		// The 6 side chairs always make it; 2 of the 4 corners do.
		for (BlockPos side : List.of(a.north(), b.north(), a.south(), b.south(), a.west(), b.east())) {
			helper.assertTrue(linked.contains(side), "side chair " + side.toShortString() + " is linked");
		}
		level.destroyBlock(a, false);
		helper.assertTrue(MeetingSeats.isMeetingChair(level.getBlockState(b.north())), "the rest of the table keeps its chairs");
		helper.assertFalse(MeetingSeats.isMeetingChair(level.getBlockState(a.west())), "a chair left without a table is a plain chair again");
		level.destroyBlock(b, false);
		for (BlockPos p : ring) {
			helper.assertFalse(MeetingSeats.isMeetingChair(level.getBlockState(p)), "chair " + p.toShortString() + " is released");
		}
		helper.succeed();
	}

	// ------------------------------------------------------------------ codex

	@GameTest(structure = ARENA, maxTicks = 40)
	public void codexMultiblockPlacesAndBreaksAsOne(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		ServerPlayer survival = (ServerPlayer)helper.makeMockServerPlayer(GameType.SURVIVAL);
		survival.snapTo(helper.absoluteVec(new Vec3(4.5, 1, 1.5)), 0.0F, 0.0F); // looking south

		BlockPos anchor = helper.absolutePos(new BlockPos(4, 1, 4));
		place(survival, new ItemStack(OrgContent.CODEX_ITEM), anchor);
		// Looking south places it facing north (toward the player); it grows to the player's right (west).
		for (CodexPart part : CodexPart.values()) {
			BlockState state = level.getBlockState(anchor.offset(part.offset(Direction.NORTH)));
			helper.assertTrue(state.is(OrgContent.CODEX) && state.getValue(CodexBlock.PART) == part && state.getValue(CodexBlock.FACING) == Direction.NORTH,
				"part " + part.getSerializedName());
		}
		helper.assertTrue(level.getBlockState(anchor.west()).getValue(CodexBlock.PART) == CodexPart.BOTTOM_RIGHT, "the right column is to the west");
		helper.assertTrue(level.getBlockEntity(anchor.above()) instanceof CodexBlockEntity, "the book part has its block entity");

		// A codex does not fit where any of its six cells is taken.
		BlockPos blockedAnchor = helper.absolutePos(new BlockPos(11, 1, 4));
		level.setBlockAndUpdate(blockedAnchor.offset(CodexPart.TOP_RIGHT.offset(Direction.NORTH)), Blocks.STONE.defaultBlockState());
		place(survival, new ItemStack(OrgContent.CODEX_ITEM), blockedAnchor);
		helper.assertTrue(level.getBlockState(blockedAnchor).isAir(), "no codex where it does not fit");

		// Breaking one part in survival takes the whole codex and drops one item.
		survival.gameMode.destroyBlock(anchor.offset(CodexPart.TOP_RIGHT.offset(Direction.NORTH)));
		for (CodexPart part : CodexPart.values()) {
			helper.assertTrue(level.getBlockState(anchor.offset(part.offset(Direction.NORTH))).isAir(), "part " + part.getSerializedName() + " is gone");
		}

		// In creative nothing drops.
		ServerPlayer creative = (ServerPlayer)helper.makeMockServerPlayer(GameType.CREATIVE);
		BlockPos second = helper.absolutePos(new BlockPos(4, 1, 11));
		helper.assertTrue(CodexBlock.placeAt(level, second, Direction.NORTH, Block.UPDATE_ALL), "placeAt");
		helper.assertTrue(CodexBlock.isComplete(level, second.above()), "placeAt builds the whole codex");
		creative.gameMode.destroyBlock(second.offset(CodexPart.MIDDLE_RIGHT.offset(Direction.NORTH)));
		helper.assertTrue(level.getBlockState(second).isAir(), "the creative break takes the anchor too");

		helper.runAfterDelay(2, () -> {
			helper.assertValueEqual(codexItemsNear(level, anchor), 1, "codex items dropped by the survival break");
			helper.assertValueEqual(codexItemsNear(level, second), 0, "codex items dropped by the creative break");
			helper.succeed();
		});
	}

	@GameTest(structure = ARENA)
	public void wallCalendarNeedsItsWall(final GameTestHelper helper) {
		ServerLevel level = helper.getLevel();
		BlockPos wall = helper.absolutePos(new BlockPos(5, 2, 5));
		BlockPos calendar = wall.north();
		level.setBlockAndUpdate(wall, Blocks.STONE.defaultBlockState());
		BlockState state = OrgContent.WALL_CALENDAR.defaultBlockState().setValue(WallCalendarBlock.FACING, Direction.NORTH);
		helper.assertTrue(state.canSurvive(level, calendar), "it hangs on the stone to its south");
		helper.assertFalse(state.setValue(WallCalendarBlock.FACING, Direction.SOUTH).canSurvive(level, calendar), "not facing the wall");
		level.setBlockAndUpdate(calendar, state);
		level.setBlockAndUpdate(wall, Blocks.AIR.defaultBlockState());
		helper.assertTrue(level.getBlockState(calendar).isAir(), "it falls when the wall goes");
		helper.succeed();
	}

	// ------------------------------------------------------------------ helpers

	private static void place(final ServerPlayer player, final ItemStack stack, final BlockPos target) {
		player.setItemInHand(InteractionHand.MAIN_HAND, stack);
		BlockPos ground = target.below();
		BlockHitResult hit = new BlockHitResult(Vec3.atCenterOf(ground).add(0, 0.5, 0), Direction.UP, ground, false);
		stack.useOn(new UseOnContext(player, InteractionHand.MAIN_HAND, hit));
	}

	private static int count(final ChestBlockEntity chest, final net.minecraft.world.item.Item item) {
		int total = 0;
		for (int i = 0; i < chest.getContainerSize(); i++) {
			if (chest.getItem(i).is(item)) {
				total += chest.getItem(i).getCount();
			}
		}
		return total;
	}

	private static int codexItemsNear(final ServerLevel level, final BlockPos pos) {
		return level.getEntitiesOfClass(ItemEntity.class, new AABB(pos).inflate(4), e -> e.getItem().is(OrgContent.CODEX_ITEM)).stream()
			.mapToInt(e -> e.getItem().getCount()).sum();
	}

	private static List<BlockState> snapshot(final GameTestHelper helper) {
		List<BlockState> states = new ArrayList<>();
		for (int x = 0; x < 16; x++) {
			for (int y = 0; y < 10; y++) {
				for (int z = 0; z < 13; z++) {
					states.add(helper.getLevel().getBlockState(helper.absolutePos(new BlockPos(x, y, z))));
				}
			}
		}
		return states;
	}

	private static AgentPlayer spawnAgent(final GameTestHelper helper, final String prefix, final double x, final double y, final double z) {
		String suffix = Long.toString(ThreadLocalRandom.current().nextLong(36L * 36 * 36 * 36), 36);
		String name = (prefix + "_" + suffix).substring(0, Math.min(16, prefix.length() + 1 + suffix.length()));
		ServerLevel level = helper.getLevel();
		AgentPlayer agent = AgentService.get(level.getServer())
			.spawn(name.toLowerCase(Locale.ROOT), name, AgentRole.ENGINEER, level, helper.absoluteVec(new Vec3(x + 0.5, y, z + 0.5)), 0.0F);
		onTestEnd(helper, () -> {
			AgentService service = AgentService.get(level.getServer());
			if (service.agent(agent.agentId()) == agent) {
				service.dismiss(agent);
			}
		});
		return agent;
	}

	private static void onTestEnd(final GameTestHelper helper, final Runnable action) {
		GameTestInfo info;
		try {
			Field field = GameTestHelper.class.getDeclaredField("testInfo");
			field.setAccessible(true);
			info = (GameTestInfo)field.get(helper);
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
