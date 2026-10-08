package dev.minevibe.org.office;

import dev.minevibe.MineVibeMod;
import dev.minevibe.org.OrgContent;
import dev.minevibe.org.calendar.WallCalendarBlock;
import dev.minevibe.org.codex.CodexBlock;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficePlan.Facing;
import dev.minevibe.org.office.OfficePlan.Kind;
import dev.minevibe.org.office.OfficePlan.Piece;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatKind;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.DyeColor;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.AbstractBedBlock;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.RotatedPillarBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoorHingeSide;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * Builds the starter office of {@link OfficePlan} (PLAN §7.5): a lit 13x9 room with beds, a chest of bread and
 * torches, a crafting table, a furnace, two workstation slots, a meeting table with 6 chairs, a Codex and a wall
 * calendar.
 *
 * <ul>
 *   <li><b>Deterministic.</b> The same origin and terrain always give the same blocks; the orientation is fixed.</li>
 *   <li><b>Safe.</b> It only touches its own footprint (and the porch in front of the door): a solid foundation is
 *       filled down to the ground (at most {@value OfficePlan#MAX_FOUNDATION_DEPTH} blocks) under every cell, and
 *       only the room inside the walls is cleared. Blocks are set without neighbour updates, so nothing outside reacts
 *       (no redstone, no falling sand), but shapes still connect (panes, doors, beds).</li>
 *   <li><b>Workstations.</b> When a {@code minevibe:pc_desk} block exists, slot 1 gets one (placed like a player
 *       would, so a multiblock desk completes itself). Otherwise both slots are marked with polished andesite on the
 *       floor and reported as {@code workstation} slots for whoever places PCs later.</li>
 * </ul>
 */
public final class OfficeBuilder {
	/** Flags for every block: tell clients, keep shapes connected, no neighbour updates, no drops. */
	private static final @Block.UpdateFlags int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SUPPRESS_DROPS;

	public static final BlockState FOUNDATION = Blocks.COBBLESTONE.defaultBlockState();
	public static final BlockState FLOOR = Blocks.SPRUCE_PLANKS.defaultBlockState();
	public static final BlockState SLOT_MARKER = Blocks.POLISHED_ANDESITE.defaultBlockState();
	public static final BlockState WALL_BASE = Blocks.STONE_BRICKS.defaultBlockState();
	public static final BlockState WALL = Blocks.OAK_PLANKS.defaultBlockState();
	public static final BlockState ROOF = Blocks.SPRUCE_PLANKS.defaultBlockState();

	public static final int BREAD = 16;
	public static final int TORCHES = 32;

	private static final net.minecraft.resources.Identifier PC_DESK = MineVibeMod.id("pc_desk");

	private OfficeBuilder() {
	}

	/**
	 * The origin (local 0,0,0) of an office whose spawn cell lands on {@code spawn}'s column, with the floor at the
	 * median ground height of the footprint (so it neither floats on a tree nor sinks into a hill).
	 */
	public static BlockPos originForSpawn(final ServerLevel level, final BlockPos spawn) {
		int x0 = spawn.getX() - OfficePlan.SPAWN_X;
		int z0 = spawn.getZ() - OfficePlan.SPAWN_Z;
		int[] xs = {0, OfficePlan.WIDTH / 2, OfficePlan.WIDTH - 1};
		int[] zs = {0, OfficePlan.DEPTH / 2, OfficePlan.DEPTH - 1};
		int[] heights = new int[xs.length * zs.length];
		int i = 0;
		for (int x : xs) {
			for (int z : zs) {
				// Level#getHeight answers minY for a chunk that is not loaded; load it (this runs before anyone joins).
				LevelChunk chunk = level.getChunk(SectionPos.blockToSectionCoord(x0 + x), SectionPos.blockToSectionCoord(z0 + z));
				heights[i++] = chunk.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, (x0 + x) & 15, (z0 + z) & 15) + 1;
			}
		}
		Arrays.sort(heights);
		int floorY = heights[heights.length / 2] - 1;
		int min = level.getMinY() + 1;
		int max = level.getMaxY() - OfficePlan.ROOF - 2;
		return new BlockPos(x0, Math.clamp(floorY, min, max), z0);
	}

	/** The origin of an office whose spawn cell is exactly where {@code standing} is (its floor right below). */
	public static BlockPos originForStanding(final BlockPos standing) {
		return new BlockPos(standing.getX() - OfficePlan.SPAWN_X, standing.getY() - OfficePlan.SPAWN_Y, standing.getZ() - OfficePlan.SPAWN_Z);
	}

	/** Builds the office with its north-west floor corner at {@code origin} and returns where everything ended up. */
	public static OfficeLayout build(final ServerLevel level, final BlockPos origin) {
		// 1. Foundation, floor, walls, roof. The roof goes on before the room is cleared, so nothing falls in.
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z <= OfficePlan.PORCH_Z; z++) {
				if (OfficePlan.inFootprint(x, z) || OfficePlan.isPorch(x, z)) {
					foundation(level, at(origin, x, 0, z));
				}
			}
		}
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z < OfficePlan.DEPTH; z++) {
				set(level, at(origin, x, 0, z), OfficePlan.isWall(x, z) ? WALL_BASE : FLOOR);
				for (int y = 1; y <= OfficePlan.WALL_TOP; y++) {
					if (OfficePlan.isWall(x, z)) {
						set(level, at(origin, x, y, z), OfficePlan.isCorner(x, z)
							? Blocks.STRIPPED_SPRUCE_LOG.defaultBlockState().setValue(RotatedPillarBlock.AXIS, Direction.Axis.Y)
							: WALL);
					}
				}
				set(level, at(origin, x, OfficePlan.ROOF, z), ROOF);
			}
		}
		// 2. The room and the porch.
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z <= OfficePlan.PORCH_Z; z++) {
				if (OfficePlan.isInterior(x, z)) {
					for (int y = 1; y <= OfficePlan.WALL_TOP; y++) {
						set(level, at(origin, x, y, z), Blocks.AIR.defaultBlockState());
					}
				} else if (OfficePlan.isPorch(x, z)) {
					set(level, at(origin, x, 0, z), FLOOR);
					for (int y = 1; y <= OfficePlan.PORCH_HEIGHT; y++) {
						set(level, at(origin, x, y, z), Blocks.AIR.defaultBlockState());
					}
				}
			}
		}
		// 3. Furniture, then what hangs on walls and the roof.
		List<OfficeLayout.Slot> slots = new ArrayList<>();
		for (Kind pass : List.of(Kind.DOOR, Kind.WINDOW, Kind.MEETING_TABLE, Kind.MEETING_CHAIR, Kind.BED, Kind.FURNACE, Kind.CRAFTING_TABLE,
			Kind.CHEST, Kind.CODEX, Kind.WORKSTATION, Kind.WALL_CALENDAR, Kind.LANTERN, Kind.OUTDOOR_TORCH)) {
			int index = 0;
			for (Piece piece : OfficePlan.piecesOf(pass)) {
				place(level, origin, piece, index++, slots);
			}
		}
		Piece firstTable = OfficePlan.piecesOf(Kind.MEETING_TABLE).getFirst();
		BlockPos tablePos = at(origin, firstTable.x(), firstTable.y(), firstTable.z());
		MeetingTables.relink(level, tablePos);
		slots.add(new OfficeLayout.Slot(OfficeLayout.MEETING_TABLE, tablePos, null));
		BlockPos spawn = at(origin, OfficePlan.SPAWN_X, OfficePlan.SPAWN_Y, OfficePlan.SPAWN_Z);
		slots.add(new OfficeLayout.Slot(OfficeLayout.DOOR, at(origin, OfficePlan.DOOR_X, 1, OfficePlan.PORCH_Z), null));
		slots.add(new OfficeLayout.Slot(OfficeLayout.SPAWN, spawn, null));
		return new OfficeLayout(origin, spawn, direction(OfficePlan.SPAWN_FACING).toYRot(), slots);
	}

	private static void place(final ServerLevel level, final BlockPos origin, final Piece piece, final int index, final List<OfficeLayout.Slot> slots) {
		BlockPos pos = at(origin, piece.x(), piece.y(), piece.z());
		Direction facing = direction(piece.facing());
		switch (piece.kind()) {
			case DOOR -> {
				BlockState door = Blocks.SPRUCE_DOOR.defaultBlockState()
					.setValue(DoorBlock.FACING, facing)
					.setValue(DoorBlock.HINGE, DoorHingeSide.LEFT)
					.setValue(DoorBlock.OPEN, false);
				set(level, pos, door.setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER));
				set(level, pos.above(), door.setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER));
			}
			case WINDOW -> set(level, pos, Block.updateFromNeighbourShapes(Blocks.GLASS_PANE.defaultBlockState(), level, pos));
			case MEETING_TABLE -> set(level, pos, OrgContent.MEETING_TABLE.defaultBlockState());
			case MEETING_CHAIR -> set(level, pos, MvWorldContent.OFFICE_CHAIR.defaultBlockState()
				.setValue(OfficeChairBlock.FACING, facing)
				.setValue(OfficeChairBlock.KIND, SeatKind.MEETING));
			case BED -> {
				Block bed = Blocks.BED.pick(index == 0 ? DyeColor.RED : DyeColor.BLUE);
				BlockState foot = bed.defaultBlockState().setValue(HorizontalDirectionalBlock.FACING, facing).setValue(AbstractBedBlock.PART, BedPart.FOOT);
				set(level, pos, foot);
				set(level, pos.relative(facing), foot.setValue(AbstractBedBlock.PART, BedPart.HEAD));
				slots.add(new OfficeLayout.Slot(OfficeLayout.BED, pos, null));
			}
			case FURNACE -> set(level, pos, Blocks.FURNACE.defaultBlockState().setValue(AbstractFurnaceBlock.FACING, facing));
			case CRAFTING_TABLE -> set(level, pos, Blocks.CRAFTING_TABLE.defaultBlockState());
			case CHEST -> {
				set(level, pos, Blocks.CHEST.defaultBlockState().setValue(ChestBlock.FACING, facing));
				if (level.getBlockEntity(pos) instanceof ChestBlockEntity chest) {
					chest.setItem(0, new ItemStack(Items.BREAD, BREAD));
					chest.setItem(1, new ItemStack(Items.TORCH, TORCHES));
					chest.setChanged();
				}
				slots.add(new OfficeLayout.Slot(OfficeLayout.CHEST, pos, null));
			}
			case CODEX -> {
				if (CodexBlock.placeAt(level, pos, facing, FLAGS)) {
					slots.add(new OfficeLayout.Slot(OfficeLayout.CODEX, pos, null));
				}
			}
			case WORKSTATION -> {
				for (int[] cell : piece.cells()) {
					set(level, at(origin, cell[0], 0, cell[2]), SLOT_MARKER);
				}
				if (index == 0) {
					placeDesk(level, pos, facing);
				}
				slots.add(new OfficeLayout.Slot(OfficeLayout.WORKSTATION, pos, null));
			}
			case WALL_CALENDAR -> {
				set(level, pos, OrgContent.WALL_CALENDAR.defaultBlockState().setValue(WallCalendarBlock.FACING, facing));
				slots.add(new OfficeLayout.Slot(OfficeLayout.WALL_CALENDAR, pos, null));
			}
			case LANTERN -> set(level, pos, Blocks.LANTERN.defaultBlockState().setValue(LanternBlock.HANGING, true));
			case OUTDOOR_TORCH -> set(level, pos, Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, facing));
		}
	}

	/**
	 * Puts a {@code minevibe:pc_desk} into a workstation slot when that block exists (the PC track registers it):
	 * the default state, turned to face the room when it has a facing, then its {@code setPlacedBy} so a desk that
	 * builds the rest of itself on placement does so. Without the block the slot stays marked and empty.
	 */
	private static void placeDesk(final ServerLevel level, final BlockPos pos, final Direction facing) {
		Optional<Block> desk = BuiltInRegistries.BLOCK.getOptional(PC_DESK);
		if (desk.isEmpty()) {
			return;
		}
		BlockState state = desk.get().defaultBlockState();
		if (state.hasProperty(HorizontalDirectionalBlock.FACING)) {
			state = state.setValue(HorizontalDirectionalBlock.FACING, facing);
		}
		try {
			level.setBlock(pos, state, Block.UPDATE_ALL);
			state.getBlock().setPlacedBy(level, pos, level.getBlockState(pos), null, new ItemStack(state.getBlock()));
		} catch (RuntimeException e) {
			MineVibeMod.LOGGER.warn("Could not place a pc_desk in the office at {}; leaving the slot marked", pos, e);
		}
	}

	/** Fills the column under {@code floor} with cobblestone down to the first solid block. */
	private static void foundation(final ServerLevel level, final BlockPos floor) {
		BlockPos.MutableBlockPos at = floor.mutable();
		for (int depth = 1; depth <= OfficePlan.MAX_FOUNDATION_DEPTH; depth++) {
			at.move(Direction.DOWN);
			if (at.getY() < level.getMinY()) {
				return;
			}
			BlockState state = level.getBlockState(at);
			boolean soft = state.canBeReplaced() || !state.getFluidState().isEmpty() || state.is(BlockTags.LEAVES);
			if (!soft) {
				return;
			}
			set(level, at.immutable(), FOUNDATION);
		}
	}

	private static void set(final ServerLevel level, final BlockPos pos, final BlockState state) {
		level.setBlock(pos, state, FLAGS);
	}

	public static BlockPos at(final BlockPos origin, final int x, final int y, final int z) {
		return origin.offset(x, y, z);
	}

	public static Direction direction(final Facing facing) {
		return switch (facing) {
			case NORTH -> Direction.NORTH;
			case EAST -> Direction.EAST;
			case SOUTH -> Direction.SOUTH;
			case WEST -> Direction.WEST;
		};
	}
}
