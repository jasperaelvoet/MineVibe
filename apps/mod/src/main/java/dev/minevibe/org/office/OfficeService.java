package dev.minevibe.org.office;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.MineVibeMod;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.hardcore.HardcoreHooks;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashSet;
import java.util.Set;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.GlobalPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelData;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The starter office of a world (PLAN §7.5, §7.9): opt-in since the survival start (a new world begins with nothing, and
 * the player earns the crew, the PCs and the Codex). With {@code -Dminevibe.office=true} it is built once, on a fresh
 * world, at its spawn; {@code /mv office build} builds one by hand in any world.
 *
 * <ul>
 *   <li><b>When.</b> With the opt-in, when the integrated server has started (or the first player joins, whichever
 *       comes first) and the world is fresh: no office recorded yet and the overworld younger than
 *       {@value #FRESH_TICKS} ticks. Worlds that predate the office are left alone.</li>
 *   <li><b>Where.</b> Centred on the world spawn, floor at the median ground height; the world spawn moves into the
 *       office, and a player joining for the first time is placed on the spawn cell (vanilla would put them on the
 *       roof: the spawn search starts at the top of the column).</li>
 *   <li><b>Record.</b> {@code <world>/minevibe/office.json} keeps the layout and who was welcomed, so a reload never
 *       rebuilds or re-teleports. The layout is also published for the client, which reports it to Node as
 *       {@code world.state.office}.</li>
 *   <li>Never automatic under server or client GameTests ({@code -Dfabric-api.gametest}, {@code -Dfabric.client.gametest})
 *       or without {@code -Dminevibe.office=true}.</li>
 * </ul>
 * Server thread, except {@link #published()}.
 */
public final class OfficeService {
	/** A world counts as fresh for this many ticks of overworld game time (30 s). */
	public static final long FRESH_TICKS = 600;
	public static final String OFFICE_PROPERTY = "minevibe.office";

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** The office of the running world, for the client thread. */
	public record Published(String levelId, OfficeLayout layout) {}

	private static volatile @Nullable Published published;

	/** Per running server. */
	private static @Nullable State state;

	private static final class State {
		final MinecraftServer server;
		final Path file;
		@Nullable OfficeLayout layout;
		/** The layout {@code office.json} holds: what {@link #save} writes, whatever a GameTest made {@link #layout}. */
		@Nullable OfficeLayout saved;
		final Set<String> welcomed = new LinkedHashSet<>();
		boolean attempted;

		State(final MinecraftServer server, final Path file) {
			this.server = server;
			this.file = file;
		}
	}

	private OfficeService() {
	}

	public static void registerEvents() {
		ServerLifecycleEvents.SERVER_STARTED.register(OfficeService::onServerStarted);
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			state = null;
			published = null;
		});
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> onJoin(server, handler.player));
	}

	/** The office of the running world (any thread), or null without one. */
	public static @Nullable Published published() {
		return published;
	}

	/** The office of {@code server}'s world, or null when it has none. */
	public static @Nullable OfficeLayout layout(final MinecraftServer server) {
		return stateOf(server).layout;
	}

	/** Whether {@code pos} in {@code level} belongs to the starter office ({@link OfficeLayout#covers}): agents leave it be. */
	public static boolean protects(final net.minecraft.server.level.ServerLevel level, final net.minecraft.core.BlockPos pos) {
		if (level.dimension() != net.minecraft.world.level.Level.OVERWORLD) {
			return false;
		}
		OfficeLayout layout = layout(level.getServer());
		return layout != null && layout.covers(pos);
	}

	/**
	 * GameTests: makes {@code layout} this running world's office (null: none again) without building, saving or moving
	 * the world spawn, so code that asks where the office is (the door agents spawn at, the meeting table) can be
	 * tested. Restore it before the test ends. Players who join meanwhile are not welcomed into it (tests running beside
	 * this one spawn player stand-ins where they need them), and it is never written to {@code office.json} (it would
	 * outlive the test in the GameTest world, which is kept from run to run).
	 */
	public static void overrideLayout(final MinecraftServer server, final @Nullable OfficeLayout layout) {
		State s = stateOf(server);
		s.layout = layout;
		published = layout != null ? new Published(HardcoreHooks.levelId(server), layout) : null;
	}

	/** True only with the {@code -Dminevibe.office=true} opt-in (and never under GameTests). */
	public static boolean autoBuildEnabled() {
		return System.getProperty("fabric-api.gametest") == null
			&& System.getProperty("fabric.client.gametest") == null
			&& "true".equalsIgnoreCase(System.getProperty(OFFICE_PROPERTY, "false").trim());
	}

	private static void onServerStarted(final MinecraftServer server) {
		ensureBuilt(server);
	}

	private static void onJoin(final MinecraftServer server, final ServerPlayer player) {
		if (player instanceof AgentPlayer) {
			return;
		}
		ensureBuilt(server);
		State s = stateOf(server);
		String uuid = player.getUUID().toString();
		if (s.layout == null || s.layout != s.saved || s.welcomed.contains(uuid)) {
			return;
		}
		s.welcomed.add(uuid);
		save(s);
		ServerLevel overworld = server.overworld();
		if (player.level() == overworld) {
			BlockPos spawn = s.layout.spawn();
			player.teleportTo(overworld, spawn.getX() + 0.5, spawn.getY(), spawn.getZ() + 0.5, Set.of(), s.layout.spawnYaw(), 0.0F, true);
			MineVibeMod.LOGGER.info("Welcomed {} into the office at {}", player.getGameProfile().name(), spawn.toShortString());
		}
	}

	/** Builds the office if this world is fresh and has none yet. */
	public static void ensureBuilt(final MinecraftServer server) {
		State s = stateOf(server);
		if (s.layout != null || s.attempted || !autoBuildEnabled()) {
			return;
		}
		s.attempted = true;
		ServerLevel overworld = server.overworld();
		if (overworld.getGameTime() >= FRESH_TICKS) {
			MineVibeMod.LOGGER.info("World {} has no starter office and is not fresh; leaving it as it is", HardcoreHooks.levelId(server));
			return;
		}
		BlockPos spawn = server.getRespawnData().pos();
		try {
			buildAt(overworld, OfficeBuilder.originForSpawn(overworld, spawn));
		} catch (RuntimeException e) {
			MineVibeMod.LOGGER.error("Could not build the starter office at {}", spawn.toShortString(), e);
		}
	}

	/**
	 * Builds an office with its origin at {@code origin}, makes it the world's office (spawn included) and records
	 * it. Also used by {@code /mv office build}.
	 */
	public static OfficeLayout buildAt(final ServerLevel level, final BlockPos origin) {
		long started = System.nanoTime();
		OfficeLayout layout = OfficeBuilder.build(level, origin);
		MinecraftServer server = level.getServer();
		server.setRespawnData(new LevelData.RespawnData(GlobalPos.of(level.dimension(), layout.spawn()), layout.spawnYaw(), 0.0F));
		State s = stateOf(server);
		s.layout = layout;
		s.saved = layout;
		s.attempted = true;
		save(s);
		published = new Published(HardcoreHooks.levelId(server), layout);
		MineVibeMod.LOGGER.info("Built the starter office at {} in {} ms", origin.toShortString(), (System.nanoTime() - started) / 1_000_000);
		return layout;
	}

	// ------------------------------------------------------------------ storage

	private static State stateOf(final MinecraftServer server) {
		State s = state;
		if (s != null && s.server == server) {
			return s;
		}
		s = new State(server, server.getWorldPath(LevelResource.ROOT).resolve("minevibe").resolve("office.json"));
		load(s);
		state = s;
		published = s.layout != null ? new Published(HardcoreHooks.levelId(server), s.layout) : null;
		return s;
	}

	private static void load(final State s) {
		if (!Files.isRegularFile(s.file)) {
			return;
		}
		try (Reader reader = Files.newBufferedReader(s.file, StandardCharsets.UTF_8)) {
			JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
			if (json.has("layout") && json.get("layout").isJsonObject()) {
				s.layout = OfficeLayout.fromJson(json.getAsJsonObject("layout"));
				s.saved = s.layout;
			}
			if (json.has("welcomed")) {
				for (JsonElement e : json.getAsJsonArray("welcomed")) {
					s.welcomed.add(e.getAsString());
				}
			}
			s.attempted = true;
		} catch (IOException | RuntimeException e) {
			MineVibeMod.LOGGER.warn("Could not read {}", s.file, e);
			s.attempted = true; // never rebuild over an office we merely failed to read
		}
	}

	private static void save(final State s) {
		JsonObject json = new JsonObject();
		json.addProperty("version", 1);
		if (s.saved != null) {
			json.add("layout", s.saved.toJson());
		}
		JsonArray welcomed = new JsonArray();
		s.welcomed.forEach(welcomed::add);
		json.add("welcomed", welcomed);
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
