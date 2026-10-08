package dev.minevibe.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Where the bridge listens and the token it expects, read from {@code run/bridge.json}
 * ({@code {"port":…, "token":…, "pid":…}}, written 0600 by Node). The JVM only ever receives the file's path
 * ({@code -Dminevibe.bridgeFile}); the token never appears on a command line or in a log, and
 * {@link #toString()} redacts it.
 *
 * @param pid the Node process that wrote the file; 0 when unknown (configs built in code, not read from a file)
 */
public record BridgeConfig(int port, String token, long pid) {
	/** System property naming the bridge file. */
	public static final String BRIDGE_FILE_PROPERTY = "minevibe.bridgeFile";

	private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{32,256}");

	public BridgeConfig {
		if (port < 1 || port > 65535) throw new IllegalArgumentException("bridge port out of range: " + port);
		if (token == null || !TOKEN.matcher(token).matches()) {
			throw new IllegalArgumentException("bridge token is missing or malformed");
		}
		if (pid < 0) throw new IllegalArgumentException("bridge pid out of range: " + pid);
	}

	/** A config without an owner pid (tests, code). */
	public BridgeConfig(int port, String token) {
		this(port, token, 0);
	}

	/**
	 * The Node process that wrote the bridge file is still running (always true without a pid). A stale file (Node
	 * was killed) must not be connected to: the port may belong to someone else by now.
	 */
	public boolean ownerAlive() {
		return pid == 0 || ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
	}

	/** {@code ws://127.0.0.1:<port>/v1}. The bridge only ever listens on IPv4 loopback. */
	public URI uri() {
		return URI.create("ws://127.0.0.1:" + port + "/v1");
	}

	/** Reads and validates a bridge file. */
	public static BridgeConfig load(Path file) throws IOException {
		String text = Files.readString(file, StandardCharsets.UTF_8);
		JsonElement json;
		try {
			json = JsonParser.parseString(text);
		} catch (JsonParseException e) {
			throw new IOException("bridge file " + file + " is not valid JSON");
		}
		if (!(json instanceof JsonObject obj)) throw new IOException("bridge file " + file + " is not a JSON object");
		if (!(obj.get("port") instanceof JsonPrimitive port) || !port.isNumber()) {
			throw new IOException("bridge file " + file + " has no port");
		}
		if (!(obj.get("token") instanceof JsonPrimitive token) || !token.isString()) {
			throw new IOException("bridge file " + file + " has no token");
		}
		if (!(obj.get("pid") instanceof JsonPrimitive pid) || !pid.isNumber() || pid.getAsLong() < 1) {
			throw new IOException("bridge file " + file + " has no pid");
		}
		try {
			return new BridgeConfig(port.getAsInt(), token.getAsString(), pid.getAsLong());
		} catch (IllegalArgumentException e) {
			throw new IOException("bridge file " + file + ": " + e.getMessage());
		}
	}

	/** The path from {@code -Dminevibe.bridgeFile}, or null when the property is unset or blank. */
	public static @Nullable Path fileFromSystemProperties() {
		String value = System.getProperty(BRIDGE_FILE_PROPERTY);
		return value == null || value.isBlank() ? null : Path.of(value.trim());
	}

	@Override
	public String toString() {
		return "BridgeConfig[port=" + port + ", token=<redacted>, pid=" + pid + "]";
	}
}
