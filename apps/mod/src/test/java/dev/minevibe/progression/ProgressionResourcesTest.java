package dev.minevibe.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The survival start's data (PLAN 7.5 "Agent Core"), checked without a world: every MineVibe item explains itself in a
 * tooltip, the Agent Core recipe, and the guide chain whose steps tell the player what to do.
 */
class ProgressionResourcesTest {
	private static JsonObject json(final String resource) {
		try (InputStream in = ProgressionResourcesTest.class.getResourceAsStream(resource)) {
			assertNotNull(in, resource);
			return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	/** Every item MineVibe has a client definition for ({@code assets/minevibe/items/<id>.json}). */
	private static List<String> items() throws IOException, URISyntaxException {
		Path dir = Path.of(ProgressionResourcesTest.class.getResource("/assets/minevibe/items").toURI());
		try (Stream<Path> files = Files.list(dir)) {
			return files.map(p -> p.getFileName().toString().replace(".json", "")).sorted().toList();
		}
	}

	@Test
	void everyItemHasATooltipAndAShiftDetail() throws IOException, URISyntaxException {
		JsonObject lang = json("/assets/minevibe/lang/en_us.json");
		List<String> items = items();
		assertTrue(items.contains("agent_core"), "the Agent Core has an item definition: " + items);
		for (String id : items) {
			String prefix = lang.has("item.minevibe." + id) ? "item.minevibe." : "block.minevibe.";
			assertTrue(lang.has(prefix + id), "name of " + id);
			assertTrue(lang.has(prefix + id + ".tooltip"), "tooltip of " + id);
			assertTrue(lang.has(prefix + id + ".tooltip.detail"), "Shift detail of " + id);
		}
		assertTrue(lang.has("tooltip.minevibe.hold_shift"));
		assertTrue(lang.get("message.minevibe.guide.hint").getAsString().contains("%s"), "the hint names the bound key");
	}

	@Test
	void theAgentCoreRecipeIsAmethystRedstoneDiamondAndPearl() {
		JsonObject recipe = json("/data/minevibe/recipe/agent_core.json");
		JsonArray pattern = recipe.getAsJsonArray("pattern");
		assertEquals(List.of("ARA", "RDR", "AEA"), pattern.asList().stream().map(e -> e.getAsString()).toList());
		JsonObject key = recipe.getAsJsonObject("key");
		assertEquals("minecraft:amethyst_shard", key.get("A").getAsString());
		assertEquals("minecraft:redstone", key.get("R").getAsString());
		assertEquals("minecraft:diamond", key.get("D").getAsString());
		assertEquals("minecraft:ender_pearl", key.get("E").getAsString());
	}

	@Test
	void theGuideIsOneChainThatTellsThePlayerWhatToDo() {
		JsonObject lang = json("/assets/minevibe/lang/en_us.json");
		List<String> chain = List.of("root", "spark", "heart", "alive", "desk", "codex", "calendar", "meeting", "team");
		String parent = null;
		for (String step : chain) {
			JsonObject adv = json("/data/minevibe/advancement/guide/" + step + ".json");
			assertEquals(parent, adv.has("parent") ? adv.get("parent").getAsString() : null, step + "'s parent");
			JsonObject display = adv.getAsJsonObject("display");
			String desc = display.getAsJsonObject("description").get("translate").getAsString();
			assertTrue(lang.has(desc), "description of " + step);
			parent = "minevibe:guide/" + step;
		}
		assertEquals("Start with nothing", lang.get("advancements.minevibe.guide.root.description").getAsString());
		assertTrue(lang.get("advancements.minevibe.guide.alive.description").getAsString().contains("copper blocks"));
		assertEquals("minevibe:awakened_agent",
			json("/data/minevibe/advancement/guide/alive.json").getAsJsonObject("criteria").getAsJsonObject("awakened").get("trigger").getAsString());
		assertEquals("minevibe:approved_hire",
			json("/data/minevibe/advancement/guide/team.json").getAsJsonObject("criteria").getAsJsonObject("hired").get("trigger").getAsString());
	}
}
