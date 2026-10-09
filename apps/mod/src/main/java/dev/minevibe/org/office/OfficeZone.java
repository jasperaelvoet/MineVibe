package dev.minevibe.org.office;

import dev.minevibe.world.provenance.Zones;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * The starter office as the protected {@code Base} zone (W1): the office's own box (foundation top below the floor
 * to the roof, porch included) plus {@value Zones#BASE_MARGIN} blocks on every side. The office is always in the
 * overworld.
 */
public final class OfficeZone {
	private static @Nullable OfficeLayout cachedFor;
	private static List<Zones.Zone> cached = List.of();

	private OfficeZone() {
	}

	/** {@link Zones.Provider}: the Base of {@code server}'s world, if it has an office. */
	public static synchronized List<Zones.Zone> zones(final MinecraftServer server) {
		OfficeLayout layout = OfficeService.layout(server);
		if (layout == null) {
			return List.of();
		}
		if (layout != cachedFor) {
			cachedFor = layout;
			cached = List.of(Zones.baseAround(Level.OVERWORLD, footprint(layout)));
		}
		return cached;
	}

	/** The office's own blocks: one below the floor (the foundation's top) up to the roof, walls and porch. */
	public static BoundingBox footprint(final OfficeLayout layout) {
		BlockPos o = layout.origin();
		return new BoundingBox(o.getX(), o.getY() - 1, o.getZ(), o.getX() + OfficePlan.WIDTH - 1, o.getY() + OfficePlan.ROOF, o.getZ() + OfficePlan.PORCH_Z);
	}
}
