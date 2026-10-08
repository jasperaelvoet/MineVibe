package dev.minevibe.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BridgeConfigTest {
	private static final String TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-xy";

	@Test
	void readsTheBridgeFileNodeWrites(@TempDir Path dir) throws IOException {
		Path file = dir.resolve("bridge.json");
		Files.writeString(file, "{\n  \"port\": 47800,\n  \"token\": \"" + TOKEN + "\",\n  \"pid\": 123\n}\n");
		BridgeConfig config = BridgeConfig.load(file);
		assertEquals(47800, config.port());
		assertEquals(TOKEN, config.token());
		assertEquals("ws://127.0.0.1:47800/v1", config.uri().toString());
	}

	@Test
	void neverPrintsTheToken() {
		BridgeConfig config = new BridgeConfig(1234, TOKEN);
		assertFalse(config.toString().contains(TOKEN));
	}

	@Test
	void rejectsBadFiles(@TempDir Path dir) throws IOException {
		Path file = dir.resolve("bridge.json");
		assertThrows(IOException.class, () -> BridgeConfig.load(file));
		Files.writeString(file, "{\"port\": 0, \"token\": \"" + TOKEN + "\"}");
		assertThrows(IOException.class, () -> BridgeConfig.load(file));
		Files.writeString(file, "{\"port\": 47800, \"token\": \"short\"}");
		IOException e = assertThrows(IOException.class, () -> BridgeConfig.load(file));
		assertFalse(e.getMessage().contains("short"), "the token is not echoed");
		Files.writeString(file, "not json");
		assertThrows(IOException.class, () -> BridgeConfig.load(file));
	}
}
