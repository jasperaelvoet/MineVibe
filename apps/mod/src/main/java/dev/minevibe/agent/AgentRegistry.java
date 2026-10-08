package dev.minevibe.agent;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import dev.minevibe.MineVibeMod;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The world's crew list, {@code <world>/minevibe/agents.json}: which agents exist, their names and roles,
 * and which are dead. Bodies themselves (position, health, inventory) live in vanilla playerdata.
 * Used to restore agents when the world loads.
 */
final class AgentRegistry {
	record Entry(String id, String name, String role, boolean alive, int diedOnDay) {
	}

	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

	private final Path file;
	private final Map<String, Entry> entries = new LinkedHashMap<>();

	private AgentRegistry(final Path file) {
		this.file = file;
	}

	static AgentRegistry load(final MinecraftServer server) {
		Path file = server.getWorldPath(LevelResource.ROOT).resolve("minevibe").resolve("agents.json");
		AgentRegistry registry = new AgentRegistry(file);
		if (Files.isRegularFile(file)) {
			try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
				List<Entry> list = GSON.fromJson(reader, new TypeToken<List<Entry>>() {}.getType());
				if (list != null) {
					for (Entry e : list) {
						if (e != null && e.id() != null) {
							registry.entries.put(e.id(), e);
						}
					}
				}
			} catch (IOException | RuntimeException e) {
				MineVibeMod.LOGGER.warn("Could not read {}", file, e);
			}
		}
		return registry;
	}

	void save() {
		try {
			Files.createDirectories(this.file.getParent());
			Path tmp = this.file.resolveSibling(this.file.getFileName() + ".tmp");
			try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
				GSON.toJson(new ArrayList<>(this.entries.values()), writer);
			}
			Files.move(tmp, this.file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			MineVibeMod.LOGGER.warn("Could not write {}", this.file, e);
		}
	}

	@Nullable Entry get(final String id) {
		return this.entries.get(id);
	}

	void put(final Entry entry) {
		this.entries.put(entry.id(), entry);
	}

	void remove(final String id) {
		this.entries.remove(id);
	}

	Collection<Entry> all() {
		return this.entries.values();
	}
}
