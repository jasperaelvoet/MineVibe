package dev.minevibe.bridge.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.ToNumberPolicy;
import com.google.gson.reflect.TypeToken;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.jspecify.annotations.Nullable;

/**
 * The contract test (PLAN §13.2): every fixture in {@code packages/protocol/fixtures/<group>/} is read with Gson exactly
 * as the TypeScript side reads it with zod. Valid fixtures parse into their records (and every JSON key maps to a record
 * component, so no field is silently dropped), invalid ones are rejected, unknown types are ignored, and every message
 * the mod sends survives a round trip unchanged.
 */
class ProtocolFixturesTest {
	private static Path fixtures() {
		String dir = System.getProperty("minevibe.protocolFixtures");
		assertNotNull(dir, "minevibe.protocolFixtures is not set (run through Gradle)");
		Path path = Path.of(dir);
		assertTrue(Files.isDirectory(path), "no fixtures at " + path);
		return path;
	}

	/** Every {@code .json} under {@code dir}, recursively, sorted. */
	private static List<Path> jsonFiles(Path dir) {
		try (Stream<Path> files = Files.walk(dir)) {
			return files.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static boolean under(Path file, String dirName) {
		for (Path part : fixtures().relativize(file)) {
			if (part.toString().equals(dirName)) return true;
		}
		return false;
	}

	/** {@code <group>/<type>[--variant].json}: neither under an {@code invalid} nor an {@code unknown} directory. */
	private static List<Path> validFiles() {
		return jsonFiles(fixtures()).stream().filter(f -> !under(f, "invalid") && !under(f, "unknown")).toList();
	}

	private static List<Path> invalidFiles() {
		return jsonFiles(fixtures()).stream().filter(f -> under(f, "invalid")).toList();
	}

	private static Path fixture(String group, String name) {
		return fixtures().resolve(group).resolve(name);
	}

	private static String read(Path file) {
		try {
			return Files.readString(file, StandardCharsets.UTF_8);
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static String name(Path file) {
		return fixtures().relativize(file).toString();
	}

	/** {@code <type>.json} or {@code <type>--<variant>.json}. */
	private static String typeOf(Path file) {
		String stem = file.getFileName().toString().replaceFirst("\\.json$", "");
		int i = stem.indexOf("--");
		return i < 0 ? stem : stem.substring(0, i);
	}

	@TestFactory
	Stream<DynamicTest> validFixturesParse() {
		List<Path> files = validFiles();
		assertFalse(files.isEmpty());
		return files.stream().map(file -> DynamicTest.dynamicTest(name(file), () -> {
			String text = read(file);
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(text);
			ProtocolCodec.Valid valid = assertInstanceOf(ProtocolCodec.Valid.class, parsed, () -> file + ": " + parsed);
			assertEquals(typeOf(file), valid.type().name());
			assertNotNull(valid.payload());
			if (valid.type() != Messages.OK) {
				List<String> unmapped = new ArrayList<>();
				JsonObject json = JsonParser.parseString(text).getAsJsonObject();
				for (String key : List.of("t", "v", "id", "re")) json.remove(key);
				unmappedKeys(json, valid.type().payloadClass(), "", unmapped);
				assertEquals(List.of(), unmapped, "JSON keys without a record component in " + valid.type().payloadClass().getName());
			}
			if (valid.type().direction().modSends()) {
				String encoded = encodeAs(valid.type(), valid.payload(), valid.id(), valid.re());
				assertEquals(JsonParser.parseString(text), JsonParser.parseString(encoded), "round trip of " + name(file));
			}
		}));
	}

	/** Collects the JSON object keys under {@code json} that have no matching component in the record type {@code type}. */
	private static void unmappedKeys(JsonElement json, Type type, String path, List<String> out) {
		Class<?> raw = type instanceof ParameterizedType p ? (Class<?>) p.getRawType() : type instanceof Class<?> c ? c : null;
		if (raw == null) return;
		if (List.class.isAssignableFrom(raw) && json instanceof JsonArray array && type instanceof ParameterizedType p) {
			for (int i = 0; i < array.size(); i++) unmappedKeys(array.get(i), p.getActualTypeArguments()[0], path + "." + i, out);
			return;
		}
		if (!raw.isRecord() || !(json instanceof JsonObject obj)) return;
		RecordComponent[] components = raw.getRecordComponents();
		for (Map.Entry<String, JsonElement> e : obj.entrySet()) {
			RecordComponent match = null;
			for (RecordComponent c : components) {
				if (c.getName().equals(e.getKey())) match = c;
			}
			if (match == null) {
				out.add(path + "." + e.getKey());
			} else {
				unmappedKeys(e.getValue(), match.getGenericType(), path + "." + e.getKey(), out);
			}
		}
	}

	@SuppressWarnings("unchecked")
	private static <P> String encodeAs(MessageType<P> type, Object payload, String id, String re) {
		return ProtocolCodec.encode(type, (P) payload, id, re);
	}

	@TestFactory
	Stream<DynamicTest> invalidFixturesAreRejected() {
		List<Path> files = invalidFiles();
		assertFalse(files.isEmpty());
		return files.stream().map(file -> DynamicTest.dynamicTest(name(file), () -> {
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(read(file));
			assertInstanceOf(ProtocolCodec.Invalid.class, parsed, () -> file + " was accepted: " + parsed);
		}));
	}

	@TestFactory
	Stream<DynamicTest> unknownTypesAreIgnored() {
		return jsonFiles(fixtures().resolve("unknown")).stream().map(file -> DynamicTest.dynamicTest(name(file), () -> {
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(read(file));
			assertInstanceOf(ProtocolCodec.UnknownType.class, parsed, () -> file + ": " + parsed);
		}));
	}

	@Test
	void everyJavaCatalogTypeHasAFixture() {
		Set<String> covered = new TreeSet<>();
		for (Path f : validFiles()) covered.add(typeOf(f));
		Set<String> missing = new TreeSet<>(Messages.catalog().keySet());
		missing.removeAll(covered);
		assertEquals(Set.of(), missing, "Java knows types that have no fixture");
		Set<String> unknownToJava = new TreeSet<>(covered);
		unknownToJava.removeAll(Messages.catalog().keySet());
		assertEquals(Set.of(), unknownToJava, "fixtures for types the Java catalog lacks");
	}

	@Test
	void readsNestedPayloads() {
		Messages.HelloOk ok = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixture("world", "hello.ok.json")))).payloadAs(Messages.HELLO_OK);
		assertEquals("world-7", ok.world().id());
		assertEquals(7, ok.world().gen());
		assertEquals(2, ok.crew().size());
		assertEquals("dead", ok.crew().get(1).status());
		assertNull(ok.budget());
		assertNull(ok.brains().utilization());

		Messages.WorldNext next = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixture("world", "world.next.json")))).payloadAs(Messages.WORLD_NEXT);
		assertEquals("world-8", next.worldId());
		assertEquals("world-7", next.summary().worldId());
		assertEquals("Fell into lava on Day 3", next.summary().crewFates().get(1).detail());
		assertEquals(14, next.summary().vaultCommits().get(0).commits());

		Messages.WorldOpen open = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixture("world", "world.open.json")))).payloadAs(Messages.WORLD_OPEN);
		assertTrue(open.hardcore());
		assertNull(open.seed());
	}

	@Test
	void keepsTheEnvelopeOfInvalidRequests() {
		ProtocolCodec.Parsed parsed = ProtocolCodec.parse("{\"t\":\"world.open\",\"v\":1,\"id\":\"n-5\",\"worldId\":\"x\"}");
		ProtocolCodec.Invalid invalid = assertInstanceOf(ProtocolCodec.Invalid.class, parsed);
		assertEquals("n-5", invalid.id());
		assertEquals("world.open", invalid.t());
	}

	@Test
	void rejectsMalformedText() {
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse("{nope"));
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse("{\"t\":\"ok\",\"v\":1,\"re\":\"a\"} trailing"));
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse("[]"));
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse("{\"t\":\"hello\",\"v\":1,\"id\":\"a b\",\"mod\":\"1\",\"mc\":\"26.3\",\"phase\":\"boot\"}"));
		String big = "{\"t\":\"ok\",\"v\":1,\"re\":\"x\",\"blob\":\"" + "é".repeat(Messages.MAX_TEXT_FRAME_BYTES / 2) + "\"}";
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse(big));
	}

	@Test
	void optionalKeysMustNotBeNull() {
		String withNullSeed = "{\"t\":\"world.open\",\"v\":1,\"worldId\":\"world-1\",\"gen\":1,\"fresh\":true,\"hardcore\":true,\"difficulty\":\"hard\",\"seed\":null}";
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse(withNullSeed));
	}

	@Test
	void integersMustBeWholeAndInRange() {
		String fractional = "{\"t\":\"world.open\",\"v\":1,\"worldId\":\"world-1\",\"gen\":1.5,\"fresh\":true,\"hardcore\":true,\"difficulty\":\"hard\"}";
		assertInstanceOf(ProtocolCodec.Invalid.class, ProtocolCodec.parse(fractional));
		String wholeAsDecimal = "{\"t\":\"world.open\",\"v\":1,\"worldId\":\"world-1\",\"gen\":2.0,\"fresh\":true,\"hardcore\":true,\"difficulty\":\"hard\"}";
		assertEquals(2, ((ProtocolCodec.Valid) ProtocolCodec.parse(wholeAsDecimal)).payloadAs(Messages.WORLD_OPEN).gen());
	}

	@Test
	void encodingValidatesBeforeTheWire() {
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Messages.WORLD_STATE, Messages.WorldState.phase("World 7", Messages.WorldState.READY), null, null));
		assertThrows(ProtocolException.class, () -> ProtocolCodec.encode(
				Messages.PLAYER_DIED, new Messages.PlayerDied("world-1", "", null, 1, 0), "m-1", null));
		String ok = ProtocolCodec.encode(Messages.PLAYER_DIED, new Messages.PlayerDied("world-1", "fell", null, 1, 0), "m-1", null);
		JsonElement json = JsonParser.parseString(ok);
		assertFalse(json.getAsJsonObject().has("killer"), "null optional keys are omitted");
	}

	/**
	 * Every {@code reply/ok*.json} fixture, read into plain Java maps and lists (nulls included, as a handler builds its
	 * result) and encoded with {@link ProtocolCodec#encodeOk}, comes out identical: nested nulls survive, so Node's
	 * reply schemas (vitest checks the same fixtures against them) see what the mod sends. The old encoder dropped
	 * {@code ok--debug-state-crew.json}'s {@code agents[].bubble} and {@code monitors[].hash}.
	 */
	@TestFactory
	Stream<DynamicTest> okReplyFixturesReencodeThroughEncodeOk() {
		Gson plain = new GsonBuilder().setObjectToNumberStrategy(ToNumberPolicy.LAZILY_PARSED_NUMBER).create();
		List<Path> files = jsonFiles(fixtures().resolve("reply")).stream()
				.filter(f -> !under(f, "invalid") && f.getFileName().toString().startsWith("ok"))
				.toList();
		assertTrue(files.size() >= 2);
		return files.stream().map(file -> DynamicTest.dynamicTest(name(file), () -> {
			JsonObject json = JsonParser.parseString(read(file)).getAsJsonObject();
			String re = json.get("re").getAsString();
			JsonObject result = json.deepCopy();
			for (String key : List.of("t", "v", "id", "re")) result.remove(key);
			Map<String, Object> asJava = plain.fromJson(result, new TypeToken<LinkedHashMap<String, Object>>() {}.getType());
			assertEquals(json, JsonParser.parseString(ProtocolCodec.encodeOk(re, asJava)), "re-encoding " + name(file));
		}));
	}

	/** A record inside an {@code ok} result, with a nullable component. */
	record NestedResult(String jobId, @Nullable String note) {}

	@Test
	void okRepliesKeepNestedNulls() {
		Map<String, Object> agent = new LinkedHashMap<>();
		agent.put("bubble", null);
		agent.put("pos", null);
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("agents", List.of(agent));
		result.put("job", new NestedResult("j-1", null));
		result.put("none", JsonNull.INSTANCE);
		String text = ProtocolCodec.encodeOk("n-4", result);
		assertEquals(
				JsonParser.parseString("{\"t\":\"ok\",\"v\":1,\"re\":\"n-4\",\"agents\":[{\"bubble\":null,\"pos\":null}],"
						+ "\"job\":{\"jobId\":\"j-1\",\"note\":null},\"none\":null}"),
				JsonParser.parseString(text));
	}

	/**
	 * A JSON tree in an {@code ok} result (a job's {@code result}, an observation) goes out as a push writes it: the
	 * {@code JsonNull} members of its objects are left out, so a job result reads the same in the {@code skill.run}
	 * reply and in a later {@code skill.result}.
	 */
	@Test
	void okReplyJsonTreesReadAsInAPush() {
		JsonObject job = new JsonObject();
		job.addProperty("item", "minecraft:oak_log");
		job.add("place", JsonNull.INSTANCE);
		JsonObject pos = new JsonObject();
		pos.addProperty("x", 1);
		pos.add("dim", JsonNull.INSTANCE);
		job.add("pos", pos);
		JsonArray list = new JsonArray();
		list.add(JsonNull.INSTANCE);
		job.add("list", list);
		Map<String, Object> reply = new LinkedHashMap<>();
		reply.put("jobId", "j-1");
		reply.put("status", "done");
		reply.put("result", job);
		JsonObject ok = JsonParser.parseString(ProtocolCodec.encodeOk("n-5", reply)).getAsJsonObject();
		JsonObject push = JsonParser.parseString(ProtocolCodec.encode(dev.minevibe.bridge.msg.Skills.SKILL_RESULT,
				new dev.minevibe.bridge.msg.Skills.SkillResult("j-1", "ada1a2b", "done", job, null, 5L), null, null))
				.getAsJsonObject();
		assertEquals(push.get("result"), ok.get("result"));
		assertEquals(JsonParser.parseString("{\"item\":\"minecraft:oak_log\",\"pos\":{\"x\":1},\"list\":[null]}"), ok.get("result"));
		// The handler's tree itself is left as it was.
		assertTrue(job.has("place"));
	}

	@Test
	void okRepliesKeepNullResultKeys() {
		java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
		result.put("screen", null);
		result.put("paused", false);
		String text = ProtocolCodec.encodeOk("n-4", result);
		assertEquals(JsonParser.parseString("{\"t\":\"ok\",\"v\":1,\"re\":\"n-4\",\"screen\":null,\"paused\":false}"), JsonParser.parseString(text));
	}
}
