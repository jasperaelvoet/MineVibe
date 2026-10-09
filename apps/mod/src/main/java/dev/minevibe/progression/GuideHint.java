package dev.minevibe.progression;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.agent.AgentPlayer;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The first-join hint of a fresh world (PLAN 7.5 "Agent Core"): a few seconds after the player first joins a world
 * that is younger than {@value #FRESH_TICKS} ticks, one chat line says that they start with nothing and which key
 * opens the guide (the advancements screen; {@link Component#keybind} shows the key the player actually bound). Once
 * per world and player: {@code <world>/minevibe/guide.json} remembers who was told. Server thread.
 */
public final class GuideHint {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Guide");

	/** A world counts as fresh for this many ticks of overworld game time (5 minutes). */
	public static final long FRESH_TICKS = 6_000;
	/** How long after joining the hint appears (the join messages settle first). */
	public static final int DELAY_TICKS = 80;

	private static @Nullable State state;

	private static final class State {
		final MinecraftServer server;
		final Path file;
		final Set<String> hinted = new LinkedHashSet<>();
		/** Players waiting for their hint: UUID to the server tick it is due. */
		final Map<UUID, Integer> due = new HashMap<>();

		State(final MinecraftServer server) {
			this.server = server;
			this.file = server.getWorldPath(LevelResource.ROOT).resolve("minevibe").resolve("guide.json");
		}
	}

	private GuideHint() {
	}

	public static void registerEvents() {
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> state = null);
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> onJoin(server, handler.player));
		ServerTickEvents.END_SERVER_TICK.register(GuideHint::tick);
	}

	private static void onJoin(final MinecraftServer server, final ServerPlayer player) {
		if (player instanceof AgentPlayer || server.overworld().getGameTime() >= FRESH_TICKS || System.getProperty("fabric-api.gametest") != null) {
			return;
		}
		State s = stateOf(server);
		if (!s.hinted.contains(player.getUUID().toString())) {
			s.due.put(player.getUUID(), server.getTickCount() + DELAY_TICKS);
		}
	}

	private static void tick(final MinecraftServer server) {
		State s = state;
		if (s == null || s.server != server || s.due.isEmpty()) {
			return;
		}
		int now = server.getTickCount();
		s.due.entrySet().removeIf(e -> {
			if (e.getValue() > now) {
				return false;
			}
			ServerPlayer player = server.getPlayerList().getPlayer(e.getKey());
			if (player != null) {
				player.sendSystemMessage(message().withStyle(ChatFormatting.GOLD));
				s.hinted.add(e.getKey().toString());
				save(s);
			}
			return true;
		});
	}

	/** "You start with nothing. Press [L] to see how to awaken your first agent." */
	public static MutableComponent message() {
		return Component.translatable("message.minevibe.guide.hint", Component.keybind("key.advancements"));
	}

	private static State stateOf(final MinecraftServer server) {
		State s = state;
		if (s != null && s.server == server) {
			return s;
		}
		s = new State(server);
		load(s);
		state = s;
		return s;
	}

	private static void load(final State s) {
		if (!Files.isRegularFile(s.file)) {
			return;
		}
		try (Reader reader = Files.newBufferedReader(s.file, StandardCharsets.UTF_8)) {
			JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
			if (json.has("hinted")) {
				for (JsonElement e : json.getAsJsonArray("hinted")) {
					s.hinted.add(e.getAsString());
				}
			}
		} catch (IOException | RuntimeException e) {
			LOG.warn("Could not read {}", s.file, e);
		}
	}

	private static void save(final State s) {
		JsonObject json = new JsonObject();
		json.addProperty("version", 1);
		JsonArray hinted = new JsonArray();
		s.hinted.forEach(hinted::add);
		json.add("hinted", hinted);
		try {
			Files.createDirectories(s.file.getParent());
			Path tmp = s.file.resolveSibling(s.file.getFileName() + ".tmp");
			try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
				writer.write(json.toString());
			}
			Files.move(tmp, s.file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			LOG.warn("Could not write {}", s.file, e);
		}
	}
}
