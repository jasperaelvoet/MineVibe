package dev.minevibe.world.provenance;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.MineVibeMod;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * Named protected zones: areas whose blocks agents never change without the player's consent, whoever placed them.
 *
 * <ul>
 *   <li><b>Base</b>: the starter office's bounding box (foundation top to roof, porch included) plus a
 *       {@value #BASE_MARGIN}-block margin, provided by the org module ({@code OrgModInit}) from the world's office.</li>
 *   <li><b>Providers</b> ({@link #addProvider}) can contribute more zones computed from the world.</li>
 *   <li><b>Named zones</b> ({@link #add}, {@code /mv zone add}) are kept in {@code <world>/minevibe/zones.json}.</li>
 * </ul>
 * Server thread.
 */
public final class Zones {
	public static final String BASE = "Base";
	public static final int BASE_MARGIN = 2;
	public static final Pattern NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 _'-]{0,31}");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/**
	 * A protected zone. {@code owner} is whose it is ("Steve"); null means the world's player (resolved when it is
	 * reported).
	 */
	public record Zone(String name, ResourceKey<Level> dim, BoundingBox box, @Nullable String owner) {
		public boolean contains(final ResourceKey<Level> d, final BlockPos p) {
			return this.dim == d && this.box.isInside(p);
		}

		/** Distance from {@code p} to the nearest block of the zone (0 inside). */
		public double distance(final BlockPos p) {
			double dx = Math.max(0, Math.max(this.box.minX() - p.getX(), p.getX() - this.box.maxX()));
			double dy = Math.max(0, Math.max(this.box.minY() - p.getY(), p.getY() - this.box.maxY()));
			double dz = Math.max(0, Math.max(this.box.minZ() - p.getZ(), p.getZ() - this.box.maxZ()));
			return Math.sqrt(dx * dx + dy * dy + dz * dz);
		}

		/** Horizontal distance to the zone, ignoring height (what "12m from Base" means). */
		public double horizontalDistance(final BlockPos p) {
			double dx = Math.max(0, Math.max(this.box.minX() - p.getX(), p.getX() - this.box.maxX()));
			double dz = Math.max(0, Math.max(this.box.minZ() - p.getZ(), p.getZ() - this.box.maxZ()));
			return Math.sqrt(dx * dx + dz * dz);
		}

		public BlockPos center() {
			return this.box.getCenter();
		}

		/** {@code 96 62 -43..110 70 -31} */
		public String describeBox() {
			return this.box.minX() + " " + this.box.minY() + " " + this.box.minZ() + ".." + this.box.maxX() + " " + this.box.maxY() + " " + this.box.maxZ();
		}
	}

	/** Computes zones from the world (the office). Called often: cache what you compute. */
	@FunctionalInterface
	public interface Provider {
		List<Zone> zones(MinecraftServer server);
	}

	private static final List<Provider> PROVIDERS = new CopyOnWriteArrayList<>();
	private static @Nullable Store store;

	private static final class Store {
		final MinecraftServer server;
		final Path file;
		final List<Zone> zones = new ArrayList<>();

		Store(final MinecraftServer server) {
			this.server = server;
			this.file = server.getWorldPath(LevelResource.ROOT).resolve("minevibe").resolve("zones.json");
		}
	}

	private Zones() {
	}

	public static void addProvider(final Provider provider) {
		PROVIDERS.add(provider);
	}

	/** Every zone of the running world. */
	public static List<Zone> all(final MinecraftServer server) {
		List<Zone> out = new ArrayList<>();
		for (Provider p : PROVIDERS) {
			try {
				out.addAll(p.zones(server));
			} catch (RuntimeException e) {
				MineVibeMod.LOGGER.warn("A zone provider failed", e);
			}
		}
		out.addAll(storeOf(server).zones);
		return out;
	}

	/** The zone {@code pos} lies in (the first one when zones overlap), or null. */
	public static @Nullable Zone at(final ServerLevel level, final BlockPos pos) {
		for (Zone z : all(level.getServer())) {
			if (z.contains(level.dimension(), pos)) {
				return z;
			}
		}
		return null;
	}

	/** The nearest zone in {@code level}'s dimension, or null when there is none. */
	public static @Nullable Zone nearest(final ServerLevel level, final BlockPos pos) {
		Zone best = null;
		double bestD = Double.MAX_VALUE;
		for (Zone z : all(level.getServer())) {
			if (z.dim() != level.dimension()) {
				continue;
			}
			double d = z.distance(pos);
			if (d < bestD) {
				bestD = d;
				best = z;
			}
		}
		return best;
	}

	/** A base zone around a building's own bounding box (the box plus {@value #BASE_MARGIN} blocks on every side). */
	public static Zone baseAround(final ResourceKey<Level> dim, final BoundingBox building) {
		return new Zone(BASE, dim, building.inflatedBy(BASE_MARGIN), null);
	}

	// ------------------------------------------------------------------ named zones

	public static List<Zone> named(final MinecraftServer server) {
		return List.copyOf(storeOf(server).zones);
	}

	/** Adds (or replaces, by name) a named zone and saves the list. */
	public static void add(final MinecraftServer server, final Zone zone) {
		if (!NAME.matcher(zone.name()).matches()) {
			throw new IllegalArgumentException("zone names are 1-32 letters, digits, spaces, _ ' -");
		}
		Store s = storeOf(server);
		s.zones.removeIf(z -> z.name().equalsIgnoreCase(zone.name()));
		s.zones.add(zone);
		save(s);
	}

	public static boolean remove(final MinecraftServer server, final String name) {
		Store s = storeOf(server);
		boolean removed = s.zones.removeIf(z -> z.name().equalsIgnoreCase(name));
		if (removed) {
			save(s);
		}
		return removed;
	}

	public static void serverStopped(final MinecraftServer server) {
		if (store != null && store.server == server) {
			store = null;
		}
	}

	private static Store storeOf(final MinecraftServer server) {
		Store s = store;
		if (s != null && s.server == server) {
			return s;
		}
		s = new Store(server);
		load(s);
		store = s;
		return s;
	}

	private static void load(final Store s) {
		if (!Files.isRegularFile(s.file)) {
			return;
		}
		try (Reader reader = Files.newBufferedReader(s.file, StandardCharsets.UTF_8)) {
			JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
			for (JsonElement e : json.getAsJsonArray("zones")) {
				JsonObject z = e.getAsJsonObject();
				Identifier dim = Identifier.tryParse(z.get("dim").getAsString());
				if (dim == null) {
					continue;
				}
				JsonArray b = z.getAsJsonArray("box");
				BoundingBox box = new BoundingBox(b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt());
				JsonElement owner = z.get("owner");
				s.zones.add(new Zone(z.get("name").getAsString(), ResourceKey.create(Registries.DIMENSION, dim), box,
					owner == null || owner.isJsonNull() ? null : owner.getAsString()));
			}
		} catch (IOException | RuntimeException e) {
			MineVibeMod.LOGGER.warn("Could not read {}", s.file, e);
		}
	}

	private static void save(final Store s) {
		JsonObject json = new JsonObject();
		json.addProperty("version", 1);
		JsonArray zones = new JsonArray();
		for (Zone z : s.zones) {
			JsonObject o = new JsonObject();
			o.addProperty("name", z.name());
			o.addProperty("dim", z.dim().identifier().toString());
			JsonArray b = new JsonArray();
			b.add(z.box().minX());
			b.add(z.box().minY());
			b.add(z.box().minZ());
			b.add(z.box().maxX());
			b.add(z.box().maxY());
			b.add(z.box().maxZ());
			o.add("box", b);
			if (z.owner() != null) {
				o.addProperty("owner", z.owner());
			}
			zones.add(o);
		}
		json.add("zones", zones);
		try {
			Files.createDirectories(s.file.getParent());
			Path tmp = s.file.resolveSibling(s.file.getFileName() + ".tmp");
			try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
				GSON.toJson(json, writer);
			}
			Files.move(tmp, s.file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			MineVibeMod.LOGGER.warn("Could not write {}", s.file, e);
		}
	}
}
