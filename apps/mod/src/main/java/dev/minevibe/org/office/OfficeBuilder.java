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
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Provenance;
import dev.minevibe.world.provenance.Zones;
import dev.minevibe.world.seat.SeatKind;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Predicate;
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
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.HorizontalDirectionalBlock;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.RotatedPillarBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.DoorHingeSide;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import org.jspecify.annotations.Nullable;

/**
 * Builds the starter office of {@link OfficePlan} (PLAN §7.5): a lit 13x9 room with beds, a chest of bread and
 * torches, a crafting table, a furnace, two workstation slots, a meeting table with 6 chairs, a Codex and a wall
 * calendar.
 *
 * <ul>
 *   <li><b>Deterministic.</b> The same origin and terrain always give the same blocks; the orientation is fixed.</li>
 *   <li><b>Safe.</b> It only touches its own footprint (and the porch in front of the door): a solid foundation is
 *       filled down to the ground (at most {@value OfficePlan#MAX_FOUNDATION_DEPTH} blocks) under every cell, and
 *       only the room inside the walls is cleared. The one exception: when the ground in front of the porch stands
 *       higher than a step, stairs are cut up through it (natural blocks only; water, lava, sand and gravel the cut
 *       would expose are sealed with cobblestone first), and when it lies lower than a step (a cliff side), stairs
 *       are built down to it on cobblestone treads, so the office always has a way out. Blocks are set without
 *       neighbour updates, so nothing outside reacts (no redstone), but shapes still connect (panes, doors, beds).</li>
 *   <li><b>Workstations.</b> Both slots are marked with polished andesite on the floor and reported as
 *       {@code workstation} slots. The PC blocks install a {@link WorkstationPlacer} ({@code PcModInit}) that puts
 *       the first PC's desk and chair into slot 1, bound to {@code linux-1} (PLAN §7.5), and that slot then carries
 *       the {@code pcId}; without a placer the slots stay empty for whoever places PCs later.</li>
 *   <li><b>Desks in the way.</b> A {@code pc_desk} inside the footprint (rebuilding with {@code /mv office build})
 *       is cleared through the placer first ({@link WorkstationPlacer#clearDesk}), never overwritten like any other
 *       block: the desk of the PC that goes back into slot 1 leaves quietly (no item drop, its PC stays plugged), any
 *       other desk as if the player broke it (its item drops and its PC is unplugged), so no PC loses its desk without
 *       a trace.</li>
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

	/**
	 * Puts a PC workstation into an office slot and clears desks out of the office's way. The PC blocks install one
	 * ({@link #installWorkstationPlacer}); the desk is a multiblock with its own placement code, so the office never
	 * places or removes {@code pc_desk} blocks itself.
	 */
	@FunctionalInterface
	public interface WorkstationPlacer {
		/**
		 * Places a workstation whose desk main column stands at {@code origin}, its screen facing {@code facing}, its
		 * side column at {@code origin.relative(facing.getClockWise())} and its chair at {@code origin.relative(facing)}.
		 * Those four cells (and the two above the desk) are free when this runs. Returns the id of the PC the new desk
		 * shows (the slot's {@code pcId}), or null when it placed nothing (or a desk bound to no PC yet).
		 */
		@Nullable String place(ServerLevel level, BlockPos origin, Direction facing);

		/**
		 * Clears the desk a block at {@code pos} belongs to out of the office's way. Returns false when {@code pos} is
		 * not part of a desk. The office calls it for every cell it is about to overwrite, before building. The desk of
		 * the PC {@link #place} puts back should leave quietly (no item drop, no unplug: it is back in a moment); any
		 * other desk should go as if broken, so its PC's item is not lost.
		 */
		default boolean clearDesk(final ServerLevel level, final BlockPos pos) {
			return false;
		}
	}

	private static volatile @Nullable WorkstationPlacer workstationPlacer;

	private OfficeBuilder() {
	}

	/** Installs (or with null removes) the placer for the first workstation slot. */
	public static void installWorkstationPlacer(final @Nullable WorkstationPlacer placer) {
		workstationPlacer = placer;
	}

	/** The installed placer ({@code PcModInit}'s), or null. */
	public static @Nullable WorkstationPlacer workstationPlacer() {
		return workstationPlacer;
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
		return build(level, origin, workstationPlacer);
	}

	/**
	 * Builds the office with {@code placer} for its workstation slot and desks in the way (null: none) instead of the
	 * installed one. GameTests that run side by side use it, so no test swaps the global placer under another.
	 */
	public static OfficeLayout build(final ServerLevel level, final BlockPos origin, final @Nullable WorkstationPlacer placer) {
		// Every block the office sets (workstation and Codex included) is recorded as the Base's own (W1 provenance).
		return Provenance.placingAs(Owner.base(Zones.BASE), () -> buildMarked(level, origin, placer));
	}

	private static OfficeLayout buildMarked(final ServerLevel level, final BlockPos origin, final @Nullable WorkstationPlacer placer) {
		// 0. Desks in the footprint go first, through the placer (overwriting a desk part would break it uncontrolled).
		clearDesks(level, origin, placer);
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
		// 2b. A way out when the ground in front of the porch stands higher than a step, or lower (a cliff side).
		if (cutExit(level, origin) == 0) {
			stairsDown(level, origin);
		}
		// 3. Furniture, then what hangs on walls and the roof.
		List<OfficeLayout.Slot> slots = new ArrayList<>();
		for (Kind pass : List.of(Kind.DOOR, Kind.WINDOW, Kind.MEETING_TABLE, Kind.MEETING_CHAIR, Kind.BED, Kind.FURNACE, Kind.CRAFTING_TABLE,
			Kind.CHEST, Kind.CODEX, Kind.WORKSTATION, Kind.WALL_CALENDAR, Kind.LANTERN, Kind.OUTDOOR_TORCH)) {
			int index = 0;
			for (Piece piece : OfficePlan.piecesOf(pass)) {
				place(level, origin, piece, index++, slots, placer);
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

	private static void place(
		final ServerLevel level, final BlockPos origin, final Piece piece, final int index, final List<OfficeLayout.Slot> slots,
		final @Nullable WorkstationPlacer placer
	) {
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
				String pcId = index == 0 ? placeWorkstation(level, pos, facing, placer) : null;
				slots.add(new OfficeLayout.Slot(OfficeLayout.WORKSTATION, pos, pcId));
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
	 * Lets the PC blocks' placer fill a workstation slot; without one the slot stays marked and empty. Returns the PC
	 * the slot shows now, or null.
	 */
	private static @Nullable String placeWorkstation(final ServerLevel level, final BlockPos pos, final Direction facing, final @Nullable WorkstationPlacer placer) {
		if (placer == null) {
			return null;
		}
		try {
			String pcId = placer.place(level, pos, facing);
			if (pcId == null) {
				MineVibeMod.LOGGER.info("No PC's workstation placed in the office at {}; leaving the slot marked", pos.toShortString());
			}
			return pcId;
		} catch (RuntimeException e) {
			MineVibeMod.LOGGER.warn("Could not place a workstation in the office at {}; leaving the slot marked", pos.toShortString(), e);
			return null;
		}
	}

	/** Clears every desk with a block in the office's footprint or porch (any height up to the roof) through the placer. */
	private static void clearDesks(final ServerLevel level, final BlockPos origin, final @Nullable WorkstationPlacer placer) {
		if (placer == null) {
			return;
		}
		int removed = 0;
		for (int x = 0; x < OfficePlan.WIDTH; x++) {
			for (int z = 0; z <= OfficePlan.PORCH_Z; z++) {
				if (!OfficePlan.inFootprint(x, z) && !OfficePlan.isPorch(x, z)) {
					continue;
				}
				for (int y = 0; y <= OfficePlan.ROOF; y++) {
					try {
						if (placer.clearDesk(level, at(origin, x, y, z))) {
							removed++;
						}
					} catch (RuntimeException e) {
						MineVibeMod.LOGGER.warn("Could not clear a desk at {}", at(origin, x, y, z).toShortString(), e);
					}
				}
			}
		}
		if (removed > 0) {
			MineVibeMod.LOGGER.info("Cleared {} desk(s) out of the office's way at {}", removed, origin.toShortString());
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

	/** At most this many steps of exit stairs are cut (or built) in front of the porch. */
	static final int MAX_EXIT_STEPS = 12;

	/**
	 * Cuts stairs from the porch up to the ground in front of it when the office stands lower than its surroundings: the
	 * floor sits at the median of the terrain samples, so a lake or a slope on one side can sink it under a hillside
	 * (seeds 42 and minevibe-e2e: 3 to 7 blocks), and the porch then opened into the hill with no way out for the player
	 * or the crew (who may not dig in the Base). One step up per block outward, 3 wide and 3 high, a cobblestone tread
	 * where the ground has a hole. Only natural ground, stone, plants and trees nobody placed are cut; anything else ends
	 * the stairs. What a cut would let in is sealed with cobblestone first: water or lava beside or above a cut block
	 * (the blocks are set with shape updates, so a lake would pour down the stairs onto the porch at once), and sand or
	 * gravel resting on one (it would fall onto the steps, or onto whoever climbs them). Returns the steps cut.
	 */
	private static int cutExit(final ServerLevel level, final BlockPos origin) {
		int feet = origin.getY() + 1;
		int doorX = origin.getX() + OfficePlan.DOOR_X;
		for (int i = 1; i <= MAX_EXIT_STEPS; i++) {
			int z = OfficePlan.PORCH_Z + i;
			int ground = Integer.MIN_VALUE;
			for (int dx = -1; dx <= 1; dx++) {
				ground = Math.max(ground, standingHeight(level, at(origin, OfficePlan.DOOR_X + dx, 0, z), feet));
			}
			if (ground <= feet + 1) {
				// At most a step up from here: the way out is open.
				return i - 1;
			}
			feet++;
			int stepZ = origin.getZ() + z;
			int stepFeet = feet;
			List<BlockPos> cut = new ArrayList<>();
			List<BlockPos> treads = new ArrayList<>();
			for (int dx = -1; dx <= 1; dx++) {
				BlockPos column = new BlockPos(doorX + dx, feet, stepZ);
				for (int y = 0; y < 3; y++) {
					BlockPos p = column.above(y);
					BlockState s = level.getBlockState(p);
					if (s.isAir()) {
						continue;
					}
					if (!cuttable(level, p, s)) {
						return i - 1;
					}
					cut.add(p);
				}
				BlockPos tread = column.below();
				BlockState t = level.getBlockState(tread);
				if (t.getCollisionShape(level, tread).isEmpty()) {
					if (!t.isAir() && !cuttable(level, tread, t) && !fillable(t)) {
						return i - 1;
					}
					treads.add(tread);
				}
			}
			Predicate<BlockPos> inStep = n -> n.getZ() == stepZ && Math.abs(n.getX() - doorX) <= 1 && n.getY() >= stepFeet
				&& n.getY() <= stepFeet + 2;
			List<BlockPos> seal = new ArrayList<>();
			for (BlockPos p : cut) {
				for (Direction d : new Direction[] {Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP}) {
					BlockPos n = p.relative(d);
					if (inStep.test(n)) {
						continue;
					}
					BlockState ns = level.getBlockState(n);
					if (!ns.getFluidState().isEmpty()) {
						if (!fillable(ns)) {
							// Waterlogged leaves or the like: no sealing that, so no stairs here.
							return i - 1;
						}
						seal.add(n);
					} else if (d == Direction.UP && ns.getBlock() instanceof FallingBlock) {
						seal.add(n);
					}
				}
			}
			for (BlockPos n : seal) {
				set(level, n, FOUNDATION);
			}
			for (BlockPos t : treads) {
				set(level, t, FOUNDATION);
			}
			for (BlockPos p : cut) {
				set(level, p, Blocks.AIR.defaultBlockState());
			}
		}
		return MAX_EXIT_STEPS;
	}

	/**
	 * The mirror of {@link #cutExit}: stairs down from a porch that stands high above the ground in front (a cliff side:
	 * the floor follows the median of the terrain samples, so a slope falling away in front leaves the porch over a
	 * drop that hurts at more than 3 blocks, and no walk ever comes back up a 2-block step). One step down per block
	 * outward, 3 wide, on cobblestone treads filled down to the ground like the foundation, until the ground in front
	 * is at most a step below, at most {@value #MAX_EXIT_STEPS} steps. Only air, plants, snow and natural leaves are
	 * cleared over the treads; a fluid, a block somebody placed or anything else in the way ends the stairs.
	 */
	private static void stairsDown(final ServerLevel level, final BlockPos origin) {
		int feet = origin.getY() + 1;
		for (int i = 1; i <= MAX_EXIT_STEPS; i++) {
			int z = OfficePlan.PORCH_Z + i;
			int landing = Integer.MIN_VALUE;
			for (int dx = -1; dx <= 1; dx++) {
				landing = Math.max(landing, landingHeight(level, at(origin, OfficePlan.DOOR_X + dx, 0, z), feet));
			}
			if (landing >= feet - 1) {
				// At most a step down from here: the way out is open.
				return;
			}
			int step = feet - 1;
			List<BlockPos> treads = new ArrayList<>();
			List<BlockPos> clear = new ArrayList<>();
			for (int dx = -1; dx <= 1; dx++) {
				BlockPos tread = at(origin, OfficePlan.DOOR_X + dx, step - 1 - origin.getY(), z);
				BlockState t = level.getBlockState(tread);
				if (!t.getCollisionShape(level, tread).isEmpty()) {
					if (t.hasBlockEntity() || Provenance.ownerAt(level, tread) != null) {
						return;
					}
				} else if (!t.isAir() && !fillable(t) && !cuttable(level, tread, t)) {
					return;
				} else {
					treads.add(tread);
				}
				for (int y = 0; y < 3; y++) {
					BlockPos p = tread.above(1 + y);
					BlockState s = level.getBlockState(p);
					if (s.isAir()) {
						continue;
					}
					if (!s.getFluidState().isEmpty() || !(s.canBeReplaced() || s.is(BlockTags.LEAVES) || s.is(BlockTags.SNOW)) || !cuttable(level, p, s)) {
						return;
					}
					clear.add(p);
				}
			}
			for (BlockPos t : treads) {
				set(level, t, FOUNDATION);
				foundation(level, t);
			}
			for (BlockPos p : clear) {
				set(level, p, Blocks.AIR.defaultBlockState());
			}
			feet = step;
		}
	}

	/**
	 * Where a body stepping off at the column of {@code at} from feet height {@code from} lands: the first height at or
	 * below {@code from} whose block below is solid or a fluid ({@code from} itself when the cell is not free).
	 */
	private static int landingHeight(final ServerLevel level, final BlockPos at, final int from) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		if (!free(level, p.set(at.getX(), from, at.getZ()))) {
			return from;
		}
		for (int y = from; y > from - 40 && y > level.getMinY(); y--) {
			BlockState below = level.getBlockState(p.set(at.getX(), y - 1, at.getZ()));
			if (!below.getCollisionShape(level, p).isEmpty() || !below.getFluidState().isEmpty()) {
				return y;
			}
		}
		return from - 40;
	}

	/** Plain water or lava (source or flowing), or a plant growing in it: cobblestone may take its place. */
	private static boolean fillable(final BlockState s) {
		return !s.getFluidState().isEmpty() && (s.getBlock() instanceof LiquidBlock || s.canBeReplaced());
	}

	/** The lowest height from {@code from} up where a body fits in the column of {@code at}: two free cells. */
	private static int standingHeight(final ServerLevel level, final BlockPos at, final int from) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int y = from; y < from + 32; y++) {
			if (free(level, p.set(at.getX(), y, at.getZ())) && free(level, p.set(at.getX(), y + 1, at.getZ()))) {
				return y;
			}
		}
		return from + 32;
	}

	private static boolean free(final ServerLevel level, final BlockPos p) {
		BlockState s = level.getBlockState(p);
		return s.getCollisionShape(level, p).isEmpty() && s.getFluidState().isEmpty();
	}

	/** Natural blocks nobody placed: ground, stone, sand and gravel, plants, and the trees that grow on them. */
	private static boolean cuttable(final ServerLevel level, final BlockPos p, final BlockState s) {
		if (s.hasBlockEntity() || !s.getFluidState().isEmpty() || Provenance.ownerAt(level, p) != null) {
			return false;
		}
		return s.canBeReplaced() || s.is(BlockTags.SUBSTRATE_OVERWORLD) || s.is(BlockTags.BASE_STONE_OVERWORLD) || s.is(BlockTags.SAND)
			|| s.is(Blocks.GRAVEL) || s.is(Blocks.CLAY) || s.is(BlockTags.LEAVES) || s.is(BlockTags.LOGS) || s.is(BlockTags.SNOW)
			|| BuiltInRegistries.BLOCK.getKey(s.getBlock()).getPath().endsWith("_ore");
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
