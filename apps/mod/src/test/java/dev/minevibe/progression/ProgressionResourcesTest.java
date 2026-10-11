package dev.minevibe.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
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
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The survival start's data (PLAN 7.5 "Agent Core"), checked without a world: every MineVibe item explains itself in a
 * tooltip, the Agent Core recipe, and the guide tree whose steps tell the player what to do.
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

	/** Every guide advancement ({@code data/minevibe/advancement/guide/<id>.json}), by id. */
	private static Map<String, JsonObject> guide() throws IOException, URISyntaxException {
		Path dir = Path.of(ProgressionResourcesTest.class.getResource("/data/minevibe/advancement/guide").toURI());
		Map<String, JsonObject> out = new TreeMap<>();
		try (Stream<Path> files = Files.list(dir)) {
			for (Path p : files.toList()) {
				String id = p.getFileName().toString().replace(".json", "");
				out.put(id, json("/data/minevibe/advancement/guide/" + id + ".json"));
			}
		}
		return out;
	}

	@Test
	void theSpineLeadsFromNothingToTheFirstCeo() {
		List<String> spine = List.of("root", "spark", "heart", "alive");
		String parent = null;
		for (String step : spine) {
			JsonObject adv = json("/data/minevibe/advancement/guide/" + step + ".json");
			assertEquals(parent, adv.has("parent") ? adv.get("parent").getAsString() : null, step + "'s parent");
			parent = "minevibe:guide/" + step;
		}
		JsonObject lang = json("/assets/minevibe/lang/en_us.json");
		assertEquals("Start with nothing", lang.get("advancements.minevibe.guide.root.description").getAsString());
		assertTrue(lang.get("advancements.minevibe.guide.alive.description").getAsString().contains("copper blocks"));
		assertEquals("minevibe:awakened_agent",
			json("/data/minevibe/advancement/guide/alive.json").getAsJsonObject("criteria").getAsJsonObject("awakened").get("trigger").getAsString());
		assertEquals("minevibe:approved_hire",
			json("/data/minevibe/advancement/guide/team.json").getAsJsonObject("criteria").getAsJsonObject("hired").get("trigger").getAsString());
	}

	@Test
	void theGuideIsOneTreeWhoseStepsTellThePlayerWhatToDo() throws IOException, URISyntaxException {
		JsonObject lang = json("/assets/minevibe/lang/en_us.json");
		Map<String, JsonObject> guide = guide();
		assertTrue(guide.size() >= 30, "a detailed guide: " + guide.keySet());
		Set<String> titles = new HashSet<>();
		for (Map.Entry<String, JsonObject> e : guide.entrySet()) {
			String id = e.getKey();
			JsonObject adv = e.getValue();
			// Every step hangs off the root, through steps that exist.
			String at = id;
			for (int hops = 0; !at.equals("root"); hops++) {
				assertTrue(hops < guide.size(), "no cycle above " + id);
				JsonObject step = guide.get(at);
				assertNotNull(step, "parent of a step under " + id + " exists: " + at);
				assertTrue(step.has("parent"), at + " has a parent");
				at = step.get("parent").getAsString().replace("minevibe:guide/", "");
			}
			JsonObject display = adv.getAsJsonObject("display");
			for (String field : List.of("title", "description")) {
				String key = display.getAsJsonObject(field).get("translate").getAsString();
				assertEquals("advancements.minevibe.guide." + id + "." + field, key);
				assertTrue(lang.has(key), field + " of " + id);
			}
			assertTrue(titles.add(lang.get("advancements.minevibe.guide." + id + ".title").getAsString()), "unique title of " + id);
			// Every criterion is required by some group, and every milestone criterion names a known milestone.
			JsonObject criteria = adv.getAsJsonObject("criteria");
			Set<String> required = new HashSet<>();
			for (JsonElement group : adv.getAsJsonArray("requirements")) {
				group.getAsJsonArray().forEach(c -> required.add(c.getAsString()));
			}
			assertEquals(criteria.keySet(), required, "requirements of " + id);
			for (String name : criteria.keySet()) {
				JsonObject c = criteria.getAsJsonObject(name);
				if ("minevibe:milestone".equals(c.get("trigger").getAsString())) {
					String milestone = c.getAsJsonObject("conditions").get("milestone").getAsString();
					assertTrue(Arrays.stream(Milestone.values()).anyMatch(m -> m.id().equals(milestone)), id + ": milestone " + milestone);
				}
			}
		}
	}

	@Test
	void everyCountedMilestoneIsANamedStatistic() {
		JsonObject lang = json("/assets/minevibe/lang/en_us.json");
		for (Milestone m : Milestone.values()) {
			assertEquals(m.counted(), lang.has("stat.minevibe." + m.id()), "statistic name of " + m.id());
		}
	}

	@Test
	void countedStepsShowAProgressBarUpToTheirGoal() {
		// Librarian: one criterion per page from 2 to 10, all required, so the screen shows "k/9".
		JsonObject librarian = json("/data/minevibe/advancement/guide/librarian.json");
		assertEquals(9, librarian.getAsJsonArray("requirements").size());
		JsonObject last = librarian.getAsJsonObject("criteria").getAsJsonObject("codex_written_10").getAsJsonObject("conditions");
		assertEquals("codex_written", last.get("milestone").getAsString());
		assertEquals(10, last.getAsJsonObject("value").get("min").getAsInt());
		assertEquals("challenge", json("/data/minevibe/advancement/guide/full_house.json").getAsJsonObject("display").get("frame").getAsString());
		assertTrue(json("/data/minevibe/advancement/guide/gone_not_forgotten.json").getAsJsonObject("display").get("hidden").getAsBoolean());
	}
}
