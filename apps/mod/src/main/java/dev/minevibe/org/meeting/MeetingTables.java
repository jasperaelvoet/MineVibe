package dev.minevibe.org.meeting;

import dev.minevibe.MineVibeMod;
import dev.minevibe.org.OrgContent;
import dev.minevibe.world.MvWorldContent;
import dev.minevibe.world.seat.OfficeChairBlock;
import dev.minevibe.world.seat.SeatKind;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerBlockEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Meeting tables and the chairs they link (PLAN §6.6, §7.5).
 *
 * <ul>
 *   <li><b>Table.</b> {@code meeting_table} blocks that touch side by side (same height) are one table. Its
 *       <em>primary</em> block is the first in (y, x, z) order.</li>
 *   <li><b>Chairs.</b> A table links up to {@value #MAX_CHAIRS} {@code office_chair}s standing next to one of its
 *       blocks (sides and corners, same height), sides first, then by position. Linked chairs have
 *       {@code kind=meeting}. A chair next to a {@code pc_desk} is a PC chair and never linked; a meeting chair next to
 *       another table belongs to that table.</li>
 *   <li><b>Upkeep.</b> The primary's block entity relinks once a second, so chairs placed or broken around a table
 *       are picked up without hooks in the chair itself. When a table block is removed its neighbours relink at once
 *       and chairs left without any table turn back into {@code kind=pc}.</li>
 * </ul>
 * Everything here runs on the server thread.
 */
public final class MeetingTables {
	public static final int MAX_CHAIRS = 8;
	/** Flood-fill cap: a table bigger than this is cut off (its far blocks then form tables of their own). */
	public static final int MAX_TABLE_BLOCKS = 64;

	private static final Identifier PC_DESK = MineVibeMod.id("pc_desk");
	private static final Comparator<BlockPos> ORDER =
		Comparator.comparingInt((BlockPos p) -> p.getY()).thenComparingInt(p -> p.getX()).thenComparingInt(p -> p.getZ());
	private static final Direction[] SIDES = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};

	/** Loaded table blocks per dimension (server thread only). */
	private static final Map<ResourceKey<Level>, Set<BlockPos>> LOADED = new HashMap<>();

	private MeetingTables() {
	}

	public static void registerEvents() {
		ServerBlockEntityEvents.BLOCK_ENTITY_LOAD.register((blockEntity, level) -> {
			if (blockEntity instanceof MeetingTableBlockEntity) {
				LOADED.computeIfAbsent(level.dimension(), k -> new LinkedHashSet<>()).add(blockEntity.getBlockPos().immutable());
			}
		});
		ServerBlockEntityEvents.BLOCK_ENTITY_UNLOAD.register((blockEntity, level) -> {
			if (blockEntity instanceof MeetingTableBlockEntity) {
				Set<BlockPos> set = LOADED.get(level.dimension());
				if (set != null) {
					set.remove(blockEntity.getBlockPos());
				}
			}
		});
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> LOADED.clear());
	}

	public static boolean isTable(final BlockState state) {
		return OrgContent.MEETING_TABLE != null && state.is(OrgContent.MEETING_TABLE);
	}

	/** The table blocks connected to {@code pos} (side by side, same height), in (y, x, z) order. Empty if none. */
	public static List<BlockPos> group(final BlockGetter level, final BlockPos pos) {
		if (!isTable(level.getBlockState(pos))) {
			return List.of();
		}
		Set<BlockPos> seen = new LinkedHashSet<>();
		Deque<BlockPos> queue = new ArrayDeque<>();
		seen.add(pos.immutable());
		queue.add(pos.immutable());
		while (!queue.isEmpty() && seen.size() < MAX_TABLE_BLOCKS) {
			BlockPos at = queue.poll();
			for (Direction side : SIDES) {
				BlockPos next = at.relative(side);
				if (!seen.contains(next) && isTable(level.getBlockState(next)) && seen.size() < MAX_TABLE_BLOCKS) {
					seen.add(next);
					queue.add(next);
				}
			}
		}
		List<BlockPos> group = new ArrayList<>(seen);
		group.sort(ORDER);
		return group;
	}

	/** True when {@code pos} is the primary block of its table. */
	public static boolean isPrimary(final BlockGetter level, final BlockPos pos) {
		List<BlockPos> group = group(level, pos);
		return !group.isEmpty() && group.getFirst().equals(pos);
	}

	/** The chairs linked to the table at {@code tablePos} (any block of it), in link order. */
	public static List<BlockPos> chairsOf(final BlockGetter level, final BlockPos tablePos) {
		List<BlockPos> group = group(level, tablePos);
		if (group.isEmpty()) {
			return List.of();
		}
		List<BlockPos> linked = new ArrayList<>();
		for (BlockPos chair : candidates(level, group)) {
			if (isMeetingChair(level.getBlockState(chair)) && group.getFirst().equals(ownerPrimary(level, chair)) && linked.size() < MAX_CHAIRS) {
				linked.add(chair);
			}
		}
		return linked;
	}

	/**
	 * Recomputes which chairs the table at {@code tablePos} links: claims up to {@value #MAX_CHAIRS} eligible chairs
	 * ({@code kind=meeting}) and releases its other meeting chairs ({@code kind=pc}). Returns the linked chairs.
	 */
	public static List<BlockPos> relink(final ServerLevel level, final BlockPos tablePos) {
		List<BlockPos> group = group(level, tablePos);
		if (group.isEmpty()) {
			return List.of();
		}
		List<BlockPos> linked = new ArrayList<>();
		List<BlockPos> release = new ArrayList<>();
		for (BlockPos chair : candidates(level, group)) {
			if (!group.getFirst().equals(ownerPrimary(level, chair))) {
				continue; // next to another table that comes first: that table's chair
			}
			BlockState state = level.getBlockState(chair);
			if (!nextToPcDesk(level, chair) && linked.size() < MAX_CHAIRS) {
				linked.add(chair);
				if (state.getValue(OfficeChairBlock.KIND) != SeatKind.MEETING) {
					level.setBlock(chair, state.setValue(OfficeChairBlock.KIND, SeatKind.MEETING), Block.UPDATE_ALL);
				}
			} else if (state.getValue(OfficeChairBlock.KIND) == SeatKind.MEETING) {
				release.add(chair);
			}
		}
		for (BlockPos chair : release) {
			BlockState state = level.getBlockState(chair);
			level.setBlock(chair, state.setValue(OfficeChairBlock.KIND, SeatKind.PC), Block.UPDATE_ALL);
		}
		return linked;
	}

	/** After the table block at {@code removed} is gone: relink what is left, release chairs left without a table. */
	static void onTableRemoved(final ServerLevel level, final BlockPos removed) {
		for (Direction side : SIDES) {
			BlockPos next = removed.relative(side);
			if (isTable(level.getBlockState(next))) {
				relink(level, next);
			}
		}
		for (BlockPos chair : ring(removed)) {
			BlockState state = level.getBlockState(chair);
			if (isMeetingChair(state) && ring(chair).stream().noneMatch(p -> isTable(level.getBlockState(p)))) {
				level.setBlock(chair, state.setValue(OfficeChairBlock.KIND, SeatKind.PC), Block.UPDATE_ALL);
			}
		}
	}

	/** Loaded table primaries in {@code level}, nearest to {@code near} first, within {@code radius} blocks. */
	public static List<BlockPos> tablesNear(final ServerLevel level, final BlockPos near, final int radius) {
		Set<BlockPos> loaded = LOADED.getOrDefault(level.dimension(), Set.of());
		List<BlockPos> primaries = new ArrayList<>();
		long max = (long)radius * radius;
		for (BlockPos pos : List.copyOf(loaded)) {
			if (pos.distSqr(near) <= max && isPrimary(level, pos)) {
				primaries.add(pos);
			}
		}
		primaries.sort(Comparator.comparingDouble((BlockPos p) -> p.distSqr(near)).thenComparing(ORDER));
		return primaries;
	}

	public static boolean isMeetingChair(final BlockState state) {
		return MvWorldContent.OFFICE_CHAIR != null && state.is(MvWorldContent.OFFICE_CHAIR) && state.getValue(OfficeChairBlock.KIND) == SeatKind.MEETING;
	}

	/** Chairs next to the table, sides before corners, then in (y, x, z) order. */
	private static List<BlockPos> candidates(final BlockGetter level, final List<BlockPos> group) {
		Set<BlockPos> sides = new LinkedHashSet<>();
		Set<BlockPos> corners = new LinkedHashSet<>();
		for (BlockPos table : group) {
			for (int dx = -1; dx <= 1; dx++) {
				for (int dz = -1; dz <= 1; dz++) {
					if (dx == 0 && dz == 0) {
						continue;
					}
					BlockPos at = table.offset(dx, 0, dz);
					if (group.contains(at) || !isChair(level.getBlockState(at))) {
						continue;
					}
					(dx == 0 || dz == 0 ? sides : corners).add(at);
				}
			}
		}
		corners.removeAll(sides);
		List<BlockPos> sorted = new ArrayList<>(sides);
		sorted.sort(ORDER);
		List<BlockPos> sortedCorners = new ArrayList<>(corners);
		sortedCorners.sort(ORDER);
		sorted.addAll(sortedCorners);
		return sorted;
	}

	private static boolean isChair(final BlockState state) {
		return MvWorldContent.OFFICE_CHAIR != null && state.is(MvWorldContent.OFFICE_CHAIR);
	}

	private static boolean nextToPcDesk(final BlockGetter level, final BlockPos chair) {
		for (Direction side : SIDES) {
			if (PC_DESK.equals(BuiltInRegistries.BLOCK.getKey(level.getBlockState(chair.relative(side)).getBlock()))) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The primary block of the table a chair next to {@code chair} belongs to. A chair next to two tables belongs to
	 * the one whose primary comes first in (y, x, z) order, so two tables never fight over it.
	 */
	private static BlockPos ownerPrimary(final BlockGetter level, final BlockPos chair) {
		BlockPos best = null;
		for (BlockPos at : ring(chair)) {
			if (isTable(level.getBlockState(at))) {
				BlockPos primary = group(level, at).getFirst();
				if (best == null || ORDER.compare(primary, best) < 0) {
					best = primary;
				}
			}
		}
		return best;
	}

	/** The 8 positions around {@code pos} at the same height. */
	private static List<BlockPos> ring(final BlockPos pos) {
		List<BlockPos> ring = new ArrayList<>(8);
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				if (dx != 0 || dz != 0) {
					ring.add(pos.offset(dx, 0, dz));
				}
			}
		}
		return ring;
	}
}
