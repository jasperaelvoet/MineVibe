package dev.minevibe.bridge;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.minevibe.bridge.BridgeClient.Route;
import dev.minevibe.bridge.protocol.Messages;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.enums.Opcode;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.protocols.Protocol;
import org.java_websocket.server.WebSocketServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * {@link BridgeClient} against a real local WebSocket server (Java-WebSocket, test scope only): auth header and
 * subprotocol, hello first, a 4 MB binary message sent in 64 fragments (which only arrives if {@code request(1)}
 * is called for every partial part), fragmented text, request routing and replies, retries and reconnects.
 */
class BridgeClientTest {
	private static final String TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv";
	private static final Duration WAIT = Duration.ofSeconds(10);

	private TestServer server;
	private BridgeClient client;

	static final class TestServer extends WebSocketServer {
		final BlockingQueue<WebSocket> opened = new LinkedBlockingQueue<>();
		final BlockingQueue<JsonObject> received = new LinkedBlockingQueue<>();
		final BlockingQueue<Integer> closeCodes = new LinkedBlockingQueue<>();
		final CountDownLatch started = new CountDownLatch(1);
		volatile String authorization;
		volatile String protocols;
		volatile String origin;

		TestServer() {
			super(new InetSocketAddress("127.0.0.1", 0), List.of(new Draft_6455(List.of(), List.of(new Protocol(Messages.SUBPROTOCOL)))));
			setReuseAddr(true);
		}

		@Override
		public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket conn, Draft draft, ClientHandshake request)
				throws InvalidDataException {
			authorization = request.getFieldValue("Authorization");
			protocols = request.getFieldValue("Sec-WebSocket-Protocol");
			origin = request.hasFieldValue("Origin") ? request.getFieldValue("Origin") : null;
			if (!("Bearer " + TOKEN).equals(authorization)) throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "bad token");
			return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
		}

		@Override
		public void onOpen(WebSocket conn, ClientHandshake handshake) {
			opened.add(conn);
		}

		@Override
		public void onClose(WebSocket conn, int code, String reason, boolean remote) {
			closeCodes.add(code);
		}

		@Override
		public void onMessage(WebSocket conn, String message) {
			received.add(JsonParser.parseString(message).getAsJsonObject());
		}

		@Override
		public void onError(WebSocket conn, Exception ex) {}

		@Override
		public void onStart() {
			started.countDown();
		}

		/** The next message of type {@code t}, skipping others. */
		JsonObject next(String t) throws InterruptedException {
			long deadline = System.nanoTime() + WAIT.toNanos();
			while (System.nanoTime() < deadline) {
				JsonObject m = received.poll(100, TimeUnit.MILLISECONDS);
				if (m != null && t.equals(m.get("t").getAsString())) return m;
			}
			throw new AssertionError("timed out waiting for " + t);
		}
	}

	@BeforeEach
	void startServer() throws InterruptedException {
		server = new TestServer();
		server.start();
		assertTrue(server.started.await(10, TimeUnit.SECONDS), "server did not start");
	}

	@AfterEach
	void stop() throws InterruptedException {
		if (client != null) client.close("test over");
		server.stop(1000);
	}

	private BridgeClient.Builder builder(int port) {
		return BridgeClient.builder()
				.config(() -> new BridgeConfig(port, TOKEN))
				.hello(() -> new Messages.Hello("0.1.0", "26.3", Messages.Hello.PHASE_BOOT, null, "Jasper"))
				.backoff(Duration.ofMillis(50), Duration.ofMillis(200));
	}

	private WebSocket connect(BridgeClient.Builder b) throws InterruptedException {
		client = b.build();
		client.start();
		WebSocket conn = server.opened.poll(WAIT.toMillis(), TimeUnit.MILLISECONDS);
		assertNotNull(conn, "client did not connect");
		return conn;
	}

	@Test
	void authenticatesAndSaysHelloFirst() throws Exception {
		connect(builder(server.getPort()));
		JsonObject hello = server.received.poll(WAIT.toMillis(), TimeUnit.MILLISECONDS);
		assertNotNull(hello);
		assertEquals("hello", hello.get("t").getAsString());
		assertEquals("boot", hello.get("phase").getAsString());
		assertTrue(hello.get("id").getAsString().startsWith("m-"));
		assertEquals("Bearer " + TOKEN, server.authorization);
		assertTrue(server.protocols.contains(Messages.SUBPROTOCOL));
		assertEquals(null, server.origin, "the bridge refuses any Origin header");
		assertTrue(client.isConnected());
	}

	@Test
	void receivesAFragmented4MbBinaryMessage() throws Exception {
		CompletableFuture<byte[]> frame = new CompletableFuture<>();
		WebSocket conn = connect(builder(server.getPort()).frameSink(buf -> {
			ByteBuffer b = buf.buffer();
			byte[] copy = new byte[b.remaining()];
			b.get(copy);
			buf.release();
			frame.complete(copy);
		}));
		server.next("hello");

		byte[] data = new byte[4 * 1024 * 1024];
		new Random(42).nextBytes(data);
		int chunk = 64 * 1024;
		for (int off = 0; off < data.length; off += chunk) {
			int len = Math.min(chunk, data.length - off);
			conn.sendFragmentedFrame(Opcode.BINARY, ByteBuffer.wrap(data, off, len), off + len == data.length);
		}
		byte[] got = frame.get(30, TimeUnit.SECONDS);
		assertEquals(data.length, got.length);
		assertArrayEquals(data, got);

		// The connection is still healthy afterwards (the receive window kept moving).
		conn.send("{\"t\":\"debug.state\",\"v\":1,\"id\":\"n-1\"}");
		JsonObject err = server.next("err");
		assertEquals("NOT_HANDLED", err.get("code").getAsString());
	}

	@Test
	void reassemblesFragmentedTextAndRoutesHandlers() throws Exception {
		CompletableFuture<Messages.WorldOpen> opened = new CompletableFuture<>();
		BridgeClient.Builder b = builder(server.getPort());
		WebSocket conn = connect(b);
		client.on(Messages.WORLD_OPEN, Route.CLIENT, opened::complete);
		client.handle(Messages.DEBUG_STATE, Route.BRIDGE, req -> {
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("screen", null);
			m.put("paused", false);
			return m;
		});
		client.handle(Messages.DEBUG_KILL_PLAYER, Route.SERVER, req -> Map.of());
		server.next("hello");

		byte[] text = "{\"t\":\"world.open\",\"v\":1,\"worldId\":\"world-3\",\"gen\":3,\"fresh\":true,\"hardcore\":true,\"difficulty\":\"hard\"}"
				.getBytes(StandardCharsets.UTF_8);
		for (int off = 0; off < text.length; off += 7) {
			int len = Math.min(7, text.length - off);
			conn.sendFragmentedFrame(Opcode.TEXT, ByteBuffer.wrap(text, off, len), off + len == text.length);
		}
		Messages.WorldOpen open = opened.get(10, TimeUnit.SECONDS);
		assertEquals("world-3", open.worldId());
		assertEquals(3, open.gen());

		conn.send("{\"t\":\"debug.state\",\"v\":1,\"id\":\"n-1\"}");
		JsonObject ok = server.next("ok");
		assertEquals("n-1", ok.get("re").getAsString());
		assertTrue(ok.has("screen") && ok.get("screen").isJsonNull(), "nullable result keys are sent as null");

		conn.send("{\"t\":\"debug.kill_player\",\"v\":1,\"id\":\"n-2\"}");
		assertEquals("NO_SERVER", server.next("err").get("code").getAsString());

		conn.send("{\"t\":\"later.feature\",\"v\":1,\"id\":\"n-3\"}");
		JsonObject unknown = server.next("err");
		assertEquals("n-3", unknown.get("re").getAsString());
		assertEquals("UNKNOWN_TYPE", unknown.get("code").getAsString());

		conn.send("{\"t\":\"world.open\",\"v\":1,\"id\":\"n-4\",\"worldId\":\"../saves\",\"gen\":1,\"fresh\":true,\"hardcore\":true,\"difficulty\":\"hard\"}");
		JsonObject bad = server.next("err");
		assertEquals("n-4", bad.get("re").getAsString());
		assertEquals("BAD_MESSAGE", bad.get("code").getAsString());

		conn.send("{\"t\":\"hello\",\"v\":1,\"id\":\"n-5\",\"mod\":\"x\",\"mc\":\"26.3\",\"phase\":\"boot\"}");
		assertEquals("BAD_MESSAGE", server.next("err").get("code").getAsString(), "mod-to-node types are refused");
	}

	@Test
	void requestsCompleteWithTheReplyAndRetryUntilAcked() throws Exception {
		WebSocket conn = connect(builder(server.getPort()));
		server.next("hello");

		CompletableFuture<JsonObject> reply = client.request(
				Messages.PLAYER_DIED, new Messages.PlayerDied("world-1", "fell", null, 2, 100), Duration.ofSeconds(5));
		JsonObject died = server.next("player.died");
		conn.send("{\"t\":\"ok\",\"v\":1,\"re\":\"" + died.get("id").getAsString() + "\",\"echo\":\"x\"}");
		assertEquals("x", reply.get(5, TimeUnit.SECONDS).get("echo").getAsString());

		CompletableFuture<JsonObject> refused = client.request(Messages.CHAT_SEND, new Messages.ChatSend(new com.google.gson.JsonPrimitive("all"), "@a hi"), Duration.ofSeconds(5));
		JsonObject chat = server.next("chat.send");
		conn.send("{\"t\":\"err\",\"v\":1,\"re\":\"" + chat.get("id").getAsString() + "\",\"code\":\"CHAT_AMBIGUOUS\",\"msg\":\"@a matches Ada, Abe\"}");
		ExecutionException ex = org.junit.jupiter.api.Assertions.assertThrows(ExecutionException.class, () -> refused.get(5, TimeUnit.SECONDS));
		assertEquals("CHAT_AMBIGUOUS", BridgeClient.unwrap(ex).code());

		AtomicInteger attempts = new AtomicInteger();
		CompletableFuture<JsonObject> acked = client.requestUntilAcked(
				Messages.PLAYER_DIED,
				() -> {
					attempts.incrementAndGet();
					return new Messages.PlayerDied("world-2", "burned", "minecraft:blaze", 3, 200);
				},
				Duration.ofMillis(300),
				Duration.ofMillis(100));
		server.next("player.died"); // first attempt: no answer, it times out
		JsonObject second = server.next("player.died");
		conn.send("{\"t\":\"ok\",\"v\":1,\"re\":\"" + second.get("id").getAsString() + "\"}");
		acked.get(5, TimeUnit.SECONDS);
		assertTrue(attempts.get() >= 2);
	}

	@Test
	void reconnectsAndSaysHelloAgain() throws Exception {
		WebSocket conn = connect(builder(server.getPort()));
		server.next("hello");
		CompletableFuture<JsonObject> pending = client.request(
				Messages.PLAYER_DIED, new Messages.PlayerDied("world-1", "fell", null, 1, 1), Duration.ofSeconds(10));
		server.next("player.died");

		conn.close(CloseFrame.GOING_AWAY, "server restarting");
		ExecutionException ex = org.junit.jupiter.api.Assertions.assertThrows(ExecutionException.class, () -> pending.get(5, TimeUnit.SECONDS));
		assertEquals("DISCONNECTED", BridgeClient.unwrap(ex).code());

		WebSocket again = server.opened.poll(WAIT.toMillis(), TimeUnit.MILLISECONDS);
		assertNotNull(again, "client did not reconnect");
		server.next("hello");
		assertTrue(client.isConnected());
	}

	@Test
	void requestsFailFastWhileDisconnected() {
		client = BridgeClient.builder()
				.config(() -> {
					throw new java.io.IOException("no bridge file yet");
				})
				.hello(() -> new Messages.Hello("0.1.0", "26.3", "boot", null, null))
				.build();
		client.start();
		CompletableFuture<JsonObject> f = client.request(Messages.CLIENT_STOPPING, new Messages.ClientStopping("x"), Duration.ofSeconds(1));
		ExecutionException ex = org.junit.jupiter.api.Assertions.assertThrows(ExecutionException.class, () -> f.get(1, TimeUnit.SECONDS));
		assertEquals("DISCONNECTED", BridgeClient.unwrap(ex).code());
		assertEquals(false, client.send(Messages.CLIENT_STOPPING, new Messages.ClientStopping("x")));
	}

	@Test
	void closesOnOversizeText() throws Exception {
		WebSocket conn = connect(builder(server.getPort()));
		server.next("hello");
		conn.send("{\"t\":\"ok\",\"v\":1,\"re\":\"x\",\"blob\":\"" + "x".repeat(300 * 1024) + "\"}");
		Integer code = server.closeCodes.poll(WAIT.toMillis(), TimeUnit.MILLISECONDS);
		assertEquals(BridgeClient.POLICY_VIOLATION, code);
		assertNotNull(server.opened.poll(WAIT.toMillis(), TimeUnit.MILLISECONDS), "reconnects afterwards");
	}
}
