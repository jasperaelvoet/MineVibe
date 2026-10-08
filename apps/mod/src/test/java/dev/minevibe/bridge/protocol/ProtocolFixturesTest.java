package dev.minevibe.bridge.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The contract test (PLAN §13.2): every fixture in {@code packages/protocol/fixtures} is read with Gson exactly as
 * the TypeScript side reads it with zod. Valid fixtures parse into their records, invalid ones are rejected,
 * unknown types are ignored, and the messages the mod sends survive a round trip unchanged.
 */
class ProtocolFixturesTest {
	/** Types the mod encodes itself; their fixtures must re-encode to the same JSON. */
	private static final Set<String> MOD_ENCODES = Set.of("hello", "world.state", "player.died", "client.stopping", "chat.send", "ok", "err");

	private static Path fixtures() {
		String dir = System.getProperty("minevibe.protocolFixtures");
		assertNotNull(dir, "minevibe.protocolFixtures is not set (run through Gradle)");
		Path path = Path.of(dir);
		assertTrue(Files.isDirectory(path), "no fixtures at " + path);
		return path;
	}

	private static List<Path> jsonFiles(Path dir) {
		try (Stream<Path> files = Files.list(dir)) {
			return files.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static String read(Path file) {
		try {
			return Files.readString(file, StandardCharsets.UTF_8);
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	/** {@code <type>.json} or {@code <type>--<variant>.json}. */
	private static String typeOf(Path file) {
		String stem = file.getFileName().toString().replaceFirst("\\.json$", "");
		int i = stem.indexOf("--");
		return i < 0 ? stem : stem.substring(0, i);
	}

	@TestFactory
	Stream<DynamicTest> validFixturesParse() {
		List<Path> files = jsonFiles(fixtures());
		assertFalse(files.isEmpty());
		return files.stream().map(file -> DynamicTest.dynamicTest(file.getFileName().toString(), () -> {
			String text = read(file);
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(text);
			ProtocolCodec.Valid valid = assertInstanceOf(ProtocolCodec.Valid.class, parsed, () -> file + ": " + parsed);
			assertEquals(typeOf(file), valid.type().name());
			assertNotNull(valid.payload());
			if (MOD_ENCODES.contains(valid.type().name())) {
				String encoded = encodeAs(valid.type(), valid.payload(), valid.id(), valid.re());
				assertEquals(JsonParser.parseString(text), JsonParser.parseString(encoded), "round trip of " + file.getFileName());
			}
		}));
	}

	@SuppressWarnings("unchecked")
	private static <P> String encodeAs(MessageType<P> type, Object payload, String id, String re) {
		return ProtocolCodec.encode(type, (P) payload, id, re);
	}

	@TestFactory
	Stream<DynamicTest> invalidFixturesAreRejected() {
		List<Path> files = jsonFiles(fixtures().resolve("invalid"));
		assertFalse(files.isEmpty());
		return files.stream().map(file -> DynamicTest.dynamicTest(file.getFileName().toString(), () -> {
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(read(file));
			assertInstanceOf(ProtocolCodec.Invalid.class, parsed, () -> file + " was accepted: " + parsed);
		}));
	}

	@TestFactory
	Stream<DynamicTest> unknownTypesAreIgnored() {
		return jsonFiles(fixtures().resolve("unknown")).stream().map(file -> DynamicTest.dynamicTest(file.getFileName().toString(), () -> {
			ProtocolCodec.Parsed parsed = ProtocolCodec.parse(read(file));
			assertInstanceOf(ProtocolCodec.UnknownType.class, parsed, () -> file + ": " + parsed);
		}));
	}

	@Test
	void everyJavaCatalogTypeHasAFixture() {
		Set<String> covered = new TreeSet<>();
		for (Path f : jsonFiles(fixtures())) covered.add(typeOf(f));
		Set<String> missing = new TreeSet<>(Messages.catalog().keySet());
		missing.removeAll(covered);
		assertEquals(Set.of(), missing, "Java knows types that have no fixture");
		Set<String> unknownToJava = new TreeSet<>(covered);
		unknownToJava.removeAll(Messages.catalog().keySet());
		assertEquals(Set.of(), unknownToJava, "fixtures for types the Java catalog lacks");
	}

	@Test
	void readsNestedPayloads() {
		Messages.HelloOk ok = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixtures().resolve("hello.ok.json")))).payloadAs(Messages.HELLO_OK);
		assertEquals("world-7", ok.world().id());
		assertEquals(7, ok.world().gen());
		assertEquals(2, ok.crew().size());
		assertEquals("dead", ok.crew().get(1).status());
		assertTrue(ok.budget().isJsonNull());
		assertNull(ok.brains().utilization());

		Messages.WorldNext next = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixtures().resolve("world.next.json")))).payloadAs(Messages.WORLD_NEXT);
		assertEquals("world-8", next.worldId());
		assertEquals("world-7", next.summary().worldId());
		assertEquals("Fell into lava on Day 3", next.summary().crewFates().get(1).detail());
		assertEquals(14, next.summary().vaultCommits().get(0).commits());

		Messages.WorldOpen open = ((ProtocolCodec.Valid) ProtocolCodec.parse(read(fixtures().resolve("world.open.json")))).payloadAs(Messages.WORLD_OPEN);
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

	@Test
	void okRepliesKeepNullResultKeys() {
		java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
		result.put("screen", null);
		result.put("paused", false);
		String text = ProtocolCodec.encodeOk("n-4", result);
		assertEquals(JsonParser.parseString("{\"t\":\"ok\",\"v\":1,\"re\":\"n-4\",\"screen\":null,\"paused\":false}"), JsonParser.parseString(text));
	}
}
