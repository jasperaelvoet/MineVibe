package dev.minevibe.bridge;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.bridge.protocol.ProtocolException;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The mod's end of the single WebSocket to Node (PLAN §5, protocol.md).
 *
 * <ul>
 *   <li><b>Connect.</b> Reads {@link BridgeConfig} (port + token from {@code run/bridge.json}) on every attempt,
 *       connects to {@code ws://127.0.0.1:<port>/v1} with {@code Authorization: Bearer} and subprotocol
 *       {@code minevibe.v1}, and reconnects with backoff from 0.5 s to 5 s. {@code hello} is the first message on
 *       every connection.</li>
 *   <li><b>Receive.</b> {@code request(1)} is called on <em>every</em> {@code onText}/{@code onBinary} invocation,
 *       partial fragments included. Text parts accumulate into one builder per connection; binary parts into a
 *       pooled direct buffer that is handed to the {@link FrameSink} when the message is complete.</li>
 *   <li><b>Route.</b> Each handler runs on its {@link Route}: the client thread (the game drains a queue of its own
 *       every client tick, because {@code Minecraft#disconnect} drops vanilla's task queue), the integrated server
 *       thread ({@code server.execute}, or {@code err NO_SERVER} when none is running or the task would run inline
 *       because it stopped), or directly on the listener thread.</li>
 *   <li><b>Send.</b> One {@code mv-bridge-send} thread drains a queue and waits for each send to finish, because
 *       {@link WebSocket} allows only one outstanding send. A frame the JDK refuses to encode fails only that message;
 *       any other send failure drops the connection.</li>
 *   <li><b>Stale bridge files.</b> A bridge file whose owner pid is not running is never connected to (no token is
 *       sent to whatever listens on that port now).</li>
 * </ul>
 */
public final class BridgeClient {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Bridge");

	/** Largest accepted binary message: an MVF1 header plus a 64 MiB payload. */
	public static final int MAX_BINARY_MESSAGE_BYTES = 32 + 64 * 1024 * 1024;

	static final Duration SEND_TIMEOUT = Duration.ofSeconds(10);

	/** java.net.http's default text encoding buffer ({@code jdk.httpclient.websocket.intermediateBufferSize}). */
	static final int SINGLE_FRAGMENT_BYTES = 16 * 1024;

	/** Close code for an oversize message from Node. */
	static final int POLICY_VIOLATION = 1008;

	/** Which thread a handler runs on. */
	public enum Route {
		/** The game client's render thread ({@code Minecraft.getInstance().execute}): world and UI messages. */
		CLIENT,
		/** The integrated server thread ({@code server.execute}); requests get {@code err NO_SERVER} without one. */
		SERVER,
		/** The WebSocket listener thread itself; only for cheap, thread-safe work. */
		BRIDGE
	}

	/** Handles one incoming message. The returned map becomes the {@code ok} reply when the message had an id. */
	@FunctionalInterface
	public interface Handler<P> {
		@Nullable Map<String, ?> handle(P payload) throws Exception;
	}

	/** Connection lifecycle callbacks (called on bridge threads). */
	public interface ConnectionListener {
		default void onConnected() {}

		/** After {@code hello.ok}. */
		default void onHandshake(Messages.HelloOk helloOk) {}

		default void onDisconnected(String reason) {}
	}

	/** Loads the bridge address and token; called before every connection attempt. */
	@FunctionalInterface
	public interface ConfigSource {
		BridgeConfig load() throws IOException;
	}

	/**
	 * Like {@link Handler}, but the {@code ok} reply is sent when the returned stage completes (on whichever thread
	 * completes it). A stage that fails with a {@link BridgeException} replies {@code err} with its code.
	 */
	@FunctionalInterface
	public interface AsyncHandler<P> {
		CompletionStage<? extends @Nullable Map<String, ?>> handle(P payload) throws Exception;
	}

	/** {@code async} is set for {@link #handleAsync} registrations ({@code handler} is then unused). */
	private record Registration<P>(MessageType<P> type, Route route, Handler<P> handler, @Nullable AsyncHandler<P> async) {
		Registration(MessageType<P> type, Route route, Handler<P> handler) {
			this(type, route, handler, null);
		}
	}

	private record Observer<P>(Route route, Consumer<P> consumer) {}

	private record Pending(String type, CompletableFuture<JsonObject> future) {}

	/** A queued text frame; {@code requestId} is set for requests, so a frame that cannot be sent fails just that one. */
	private record Outgoing(String text, Conn conn, @Nullable String requestId) {}

	private final ConfigSource configSource;
	private final Executor clientExecutor;
	private final Supplier<@Nullable Executor> serverExecutor;
	private final FrameSink frameSink;
	private final Supplier<Messages.Hello> helloSupplier;
	private final long minBackoffMs;
	private final long maxBackoffMs;
	private final HttpClient http;
	private final BufferPool pool = new BufferPool();

	private final Map<String, Registration<?>> handlers = new ConcurrentHashMap<>();
	private final Map<String, List<Observer<?>>> observers = new ConcurrentHashMap<>();
	private final Map<String, Pending> pending = new ConcurrentHashMap<>();
	private final List<ConnectionListener> listeners = new CopyOnWriteArrayList<>();
	private final AtomicLong requestSeq = new AtomicLong();
	private final LinkedBlockingQueue<Outgoing> outbox = new LinkedBlockingQueue<>();
	private final ScheduledExecutorService scheduler;
	private final Thread sender;

	private final Object lock = new Object();
	/** The open connection, or null. Guarded by {@link #lock}. */
	private @Nullable Conn current;
	/** True while a connection attempt is in flight or scheduled. Guarded by {@link #lock}. */
	private boolean connecting;

	private volatile boolean handshaken;
	private volatile boolean started;
	private volatile boolean closed;
	/** Next reconnect delay; reset to the minimum by {@code hello.ok}. Only one connect attempt runs at a time. */
	private volatile long backoffMs;
	private volatile int failuresSinceConnected;

	private BridgeClient(Builder b) {
		this.configSource = Objects.requireNonNull(b.configSource, "configSource");
		this.clientExecutor = b.clientExecutor;
		this.serverExecutor = b.serverExecutor;
		this.frameSink = b.frameSink;
		this.helloSupplier = Objects.requireNonNull(b.helloSupplier, "hello");
		this.minBackoffMs = b.minBackoff.toMillis();
		this.maxBackoffMs = b.maxBackoff.toMillis();
		this.backoffMs = minBackoffMs;
		this.http = HttpClient.newBuilder()
				.proxy(HttpClient.Builder.NO_PROXY)
				.connectTimeout(Duration.ofSeconds(5))
				.executor(Executors.newSingleThreadExecutor(daemon("mv-bridge-io")))
				.build();
		this.scheduler = Executors.newSingleThreadScheduledExecutor(daemon("mv-bridge"));
		this.sender = daemon("mv-bridge-send").newThread(this::sendLoop);
	}

	public static Builder builder() {
		return new Builder();
	}

	private static java.util.concurrent.ThreadFactory daemon(String name) {
		return r -> {
			Thread t = new Thread(r, name);
			t.setDaemon(true);
			return t;
		};
	}

	// -----------------------------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------------------------

	/** Starts connecting (and reconnecting) in the background. */
	public void start() {
		if (started) return;
		started = true;
		sender.start();
		scheduleConnect(0);
	}

	/** An open connection exists (messages can be sent). */
	public boolean isConnected() {
		synchronized (lock) {
			return current != null;
		}
	}

	/** {@code hello.ok} arrived on the current connection. */
	public boolean isHandshaken() {
		return handshaken && isConnected();
	}

	public void addListener(ConnectionListener listener) {
		listeners.add(listener);
	}

	/** Registers the handler for {@code type} (one per type); its return value is the {@code ok} reply. */
	public <P> void handle(MessageType<P> type, Route route, Handler<P> handler) {
		if (!type.direction().nodeSends()) throw new IllegalArgumentException(type + " is never sent by Node");
		if (handlers.putIfAbsent(type.name(), new Registration<>(type, route, handler)) != null) {
			throw new IllegalStateException("handler for " + type + " already registered");
		}
	}

	/**
	 * Registers the handler for {@code type} (one per type, shared with {@link #handle}) whose {@code ok} reply is sent
	 * when the returned stage completes, so a server-thread handler can answer later (e.g. {@code skill.run} waits for
	 * its job up to {@code waitMs}) without blocking any thread.
	 */
	public <P> void handleAsync(MessageType<P> type, Route route, AsyncHandler<P> handler) {
		if (!type.direction().nodeSends()) throw new IllegalArgumentException(type + " is never sent by Node");
		Objects.requireNonNull(handler, "handler");
		Handler<P> unused = payload -> {
			throw new IllegalStateException("async handler");
		};
		if (handlers.putIfAbsent(type.name(), new Registration<>(type, route, unused, handler)) != null) {
			throw new IllegalStateException("handler for " + type + " already registered");
		}
	}

	/**
	 * Adds an observer of {@code type}: it runs on {@code route} for every such message, besides the type's handler (if
	 * any), and never replies. Several modules can observe the same push (for example {@code agent.approach}: the body
	 * walks on the server, the client shows the card).
	 */
	public <P> void observe(MessageType<P> type, Route route, Consumer<P> observer) {
		if (!type.direction().nodeSends()) throw new IllegalArgumentException(type + " is never sent by Node");
		observers.computeIfAbsent(type.name(), k -> new CopyOnWriteArrayList<>()).add(new Observer<>(route, Objects.requireNonNull(observer)));
	}

	/**
	 * The message types that have a handler (one per type). Pushes other modules need too are read from the owner's
	 * state ({@code UiState}, {@code PcStates}, {@code OrgClientState}) or {@link #observe}d, never registered twice.
	 */
	public java.util.Set<String> handledTypes() {
		return java.util.Set.copyOf(handlers.keySet());
	}

	/** Registers a handler for a message that needs no result. */
	public <P> void on(MessageType<P> type, Route route, Consumer<P> consumer) {
		handle(type, route, payload -> {
			consumer.accept(payload);
			return null;
		});
	}

	/**
	 * Sends a message without waiting for a reply. Returns false (and drops it) when not connected: Node re-syncs
	 * everything after the next {@code hello}, so nothing is queued across connections.
	 *
	 * @throws ProtocolException if the payload does not match the schema
	 */
	public <P> boolean send(MessageType<P> type, P payload) {
		if (!type.direction().modSends()) throw new IllegalArgumentException(type + " is never sent by the mod");
		return enqueue(ProtocolCodec.encode(type, payload, null, null));
	}

	/**
	 * Sends a request ({@code id} = {@code m-<seq>}) and completes with the {@code ok} reply's result keys. Fails
	 * with {@link BridgeException}: the peer's {@code err} code, {@code TIMEOUT} or {@code DISCONNECTED}.
	 */
	public <P> CompletableFuture<JsonObject> request(MessageType<P> type, P payload, Duration timeout) {
		String id = "m-" + requestSeq.incrementAndGet();
		String text;
		try {
			text = ProtocolCodec.encode(type, payload, id, null);
		} catch (ProtocolException e) {
			return CompletableFuture.failedFuture(e);
		}
		CompletableFuture<JsonObject> future = new CompletableFuture<>();
		synchronized (lock) {
			if (current == null) {
				return CompletableFuture.failedFuture(new BridgeException(Codes.DISCONNECTED, "cannot send " + type + ": not connected"));
			}
			pending.put(id, new Pending(type.name(), future));
			outbox.add(new Outgoing(text, current, id));
		}
		var timer = scheduler.schedule(() -> {
			if (pending.remove(id) != null) {
				future.completeExceptionally(new BridgeException(Codes.TIMEOUT, type + " timed out after " + timeout.toMillis() + " ms"));
			}
		}, timeout.toMillis(), TimeUnit.MILLISECONDS);
		future.whenComplete((r, e) -> timer.cancel(false));
		return future;
	}

	/**
	 * Sends a request until Node acknowledges it: each attempt waits {@code timeout}, failures (timeouts,
	 * disconnects, errors other than {@code BAD_MESSAGE}) retry after {@code retryEvery}, reconnects included. The
	 * payload is rebuilt for every attempt. Cancel the returned future to stop.
	 */
	public <P> CompletableFuture<JsonObject> requestUntilAcked(
			MessageType<P> type, Supplier<P> payload, Duration timeout, Duration retryEvery) {
		CompletableFuture<JsonObject> result = new CompletableFuture<>();
		attempt(type, payload, timeout, retryEvery, result, 1);
		return result;
	}

	private <P> void attempt(
			MessageType<P> type, Supplier<P> payload, Duration timeout, Duration retryEvery, CompletableFuture<JsonObject> result, int n) {
		if (result.isDone() || closed) return;
		request(type, payload.get(), timeout).whenComplete((ok, err) -> {
			if (err == null) {
				result.complete(ok);
				return;
			}
			BridgeException be = unwrap(err);
			if (be != null && Codes.BAD_MESSAGE.equals(be.code())) {
				LOG.error("{} was rejected by Node: {}", type, be.getMessage());
				result.completeExceptionally(be);
				return;
			}
			if (n == 1 || n % 10 == 0) {
				LOG.info("{} not acknowledged yet ({}); retrying every {} ms", type, err.getMessage(), retryEvery.toMillis());
			}
			try {
				scheduler.schedule(() -> attempt(type, payload, timeout, retryEvery, result, n + 1), retryEvery.toMillis(), TimeUnit.MILLISECONDS);
			} catch (RejectedExecutionException e) {
				result.completeExceptionally(new BridgeException(Codes.DISCONNECTED, "bridge closed"));
			}
		});
	}

	/**
	 * Sends {@code client.stopping}, closes the socket and stops reconnecting. Waits up to about two seconds for the
	 * goodbye to be flushed.
	 */
	public void close(String reason) {
		if (closed) return;
		Conn conn;
		synchronized (lock) {
			conn = current;
		}
		if (conn != null) {
			try {
				enqueue(ProtocolCodec.encode(Messages.CLIENT_STOPPING, new Messages.ClientStopping(reason), null, null));
				long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
				while (!outbox.isEmpty() && System.nanoTime() < deadline) Thread.sleep(10);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			} catch (RuntimeException e) {
				LOG.debug("client.stopping not sent", e);
			}
		}
		closed = true;
		if (conn != null) {
			try {
				conn.ws().sendClose(WebSocket.NORMAL_CLOSURE, "client stopping").get(1, TimeUnit.SECONDS);
			} catch (Exception e) {
				conn.ws().abort();
			}
		}
		scheduler.shutdownNow();
		sender.interrupt();
		failPending(Codes.DISCONNECTED, "bridge closed");
	}

	// -----------------------------------------------------------------------------------------
	// Connecting
	// -----------------------------------------------------------------------------------------

	private void scheduleConnect(long delayMs) {
		synchronized (lock) {
			if (closed || current != null || connecting) return;
			connecting = true;
		}
		try {
			scheduler.schedule(this::connect, delayMs, TimeUnit.MILLISECONDS);
		} catch (RejectedExecutionException e) {
			synchronized (lock) {
				connecting = false;
			}
		}
	}

	private void connectFailed(String why) {
		synchronized (lock) {
			connecting = false;
		}
		if (closed) return;
		long delay = backoffMs;
		backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
		failuresSinceConnected++;
		if (failuresSinceConnected == 1 || failuresSinceConnected % 24 == 0) {
			LOG.info("Bridge not reachable ({}); retrying (attempt {})", why, failuresSinceConnected);
		} else {
			LOG.debug("Bridge not reachable ({}); retrying in {} ms", why, delay);
		}
		scheduleConnect(delay);
	}

	private void connect() {
		if (closed) return;
		BridgeConfig config;
		try {
			config = configSource.load();
		} catch (IOException | RuntimeException e) {
			connectFailed("bridge file: " + e.getMessage());
			return;
		}
		if (!config.ownerAlive()) {
			// A bridge file left behind by a Node that is gone (killed, crashed). Whoever listens on that port now
			// is not MineVibe: never present the token to it. Node writes a fresh file when it starts.
			connectFailed("bridge file is stale (owner pid " + config.pid() + " is not running)");
			return;
		}
		Conn conn = new Conn();
		try {
			http.newWebSocketBuilder()
					.header("Authorization", "Bearer " + config.token())
					.subprotocols(Messages.SUBPROTOCOL)
					.connectTimeout(Duration.ofSeconds(5))
					.buildAsync(config.uri(), conn)
					.whenComplete((ws, err) -> {
						if (err != null) connectFailed(describe(err));
					});
		} catch (RuntimeException e) {
			connectFailed(describe(e));
		}
	}

	private static String describe(Throwable err) {
		Throwable t = err;
		while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) t = t.getCause();
		if (t instanceof WebSocketHandshakeException h) return "handshake refused: HTTP " + h.getResponse().statusCode();
		String msg = t.getMessage();
		return t.getClass().getSimpleName() + (msg != null ? ": " + msg : "");
	}

	private void opened(Conn conn) {
		if (closed) {
			conn.ws().abort();
			return;
		}
		Messages.Hello hello;
		String helloId = "m-" + requestSeq.incrementAndGet();
		String helloText;
		try {
			hello = helloSupplier.get();
			helloText = ProtocolCodec.encode(Messages.HELLO, hello, helloId, null);
		} catch (RuntimeException e) {
			// Building or encoding hello failed (e.g. a value outside the schema): drop this connection and try again
			// later. Leaving it half-open would keep `connecting` set, and no reconnect would ever be scheduled.
			LOG.error("Could not build hello; closing", e);
			conn.ws().abort();
			connectFailed("hello failed");
			return;
		}
		synchronized (lock) {
			current = conn;
			connecting = false;
			// hello is queued under the same lock that publishes the connection, so it is always sent first.
			outbox.add(new Outgoing(helloText, conn, null));
		}
		failuresSinceConnected = 0;
		LOG.info("Bridge connected (phase {})", hello.phase());
		for (ConnectionListener l : listeners) {
			try {
				l.onConnected();
			} catch (RuntimeException e) {
				LOG.error("Bridge listener failed", e);
			}
		}
	}

	private void lost(Conn conn, String reason) {
		synchronized (lock) {
			if (current != conn) return;
			current = null;
		}
		handshaken = false;
		failPending(Codes.DISCONNECTED, "connection closed");
		LOG.info("Bridge disconnected: {}", reason);
		for (ConnectionListener l : listeners) {
			try {
				l.onDisconnected(reason);
			} catch (RuntimeException e) {
				LOG.error("Bridge listener failed", e);
			}
		}
		if (!closed) {
			long delay = backoffMs;
			backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
			scheduleConnect(delay);
		}
	}

	private void failPending(String code, String msg) {
		for (Map.Entry<String, Pending> e : pending.entrySet()) {
			if (pending.remove(e.getKey()) != null) {
				e.getValue().future().completeExceptionally(new BridgeException(code, e.getValue().type() + ": " + msg));
			}
		}
	}

	// -----------------------------------------------------------------------------------------
	// Sending
	// -----------------------------------------------------------------------------------------

	private boolean enqueue(String text) {
		synchronized (lock) {
			if (current == null) return false;
			outbox.add(new Outgoing(text, current, null));
			return true;
		}
	}

	/** Queues an already-encoded frame as is (tests: frames the encoder would never produce). */
	boolean enqueueRaw(String text) {
		return enqueue(text);
	}

	private void reply(Conn conn, String text) {
		synchronized (lock) {
			// A reply belongs to the connection the request came on; after a reconnect it is dropped.
			if (current != conn) return;
			outbox.add(new Outgoing(text, conn, null));
		}
	}

	private void sendLoop() {
		while (!closed) {
			Outgoing o;
			try {
				o = outbox.take();
			} catch (InterruptedException e) {
				return;
			}
			synchronized (lock) {
				if (current != o.conn()) continue; // queued for a connection that is gone
			}
			try {
				o.conn().ws().sendText(o.text(), true).get(SEND_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
			} catch (InterruptedException e) {
				return;
			} catch (ExecutionException | TimeoutException | RuntimeException e) {
				if (isMalformedText(e)) {
					unsendable(o, e);
				} else {
					sendFailed(o, e);
				}
			}
		}
	}

	/**
	 * java.net.http refused the text itself: not well-formed UTF-16. The API documents an IllegalArgumentException;
	 * JDK 25 reports {@code IOException("Malformed text message")} caused by a {@code CharacterCodingException}.
	 */
	static boolean isMalformedText(Throwable e) {
		for (Throwable t = e; t != null; t = t.getCause()) {
			if (t instanceof IllegalArgumentException || t instanceof CharacterCodingException) return true;
		}
		return false;
	}

	/** The connection is broken: drop it and reconnect. */
	private void sendFailed(Outgoing o, Exception e) {
		LOG.warn("Bridge send failed ({}); reconnecting", describe(e));
		o.conn().ws().abort();
		lost(o.conn(), "send failed");
	}

	/**
	 * This one frame cannot be sent: its text is not well-formed UTF-16 (the encoder sanitises what it builds, so this
	 * is a bug). It is a fault of the message, not of the connection, so only this message fails: a request fails
	 * with BAD_MESSAGE, which retry loops treat as final (before, the same frame was re-sent after every reconnect,
	 * forever). The JDK encodes up to 16 KiB before it writes anything, so a shorter frame left nothing on the wire
	 * and the connection stays; a longer one may have left a partial fragment, so that connection is replaced.
	 */
	private void unsendable(Outgoing o, Exception e) {
		LOG.error("Bridge message could not be sent and was dropped: {}", describe(e));
		if (o.requestId() != null) {
			Pending p = pending.remove(o.requestId());
			if (p != null) {
				p.future().completeExceptionally(new BridgeException(Codes.BAD_MESSAGE, p.type() + " could not be sent: malformed text"));
			}
		}
		if ((long) o.text().length() * 3 > SINGLE_FRAGMENT_BYTES) {
			o.conn().ws().abort();
			lost(o.conn(), "partial frame");
		}
	}

	// -----------------------------------------------------------------------------------------
	// Receiving
	// -----------------------------------------------------------------------------------------

	private void onTextMessage(Conn conn, String text) {
		switch (ProtocolCodec.parse(text)) {
			case ProtocolCodec.Invalid inv -> {
				LOG.warn("Invalid message from Node: {}", inv.error());
				if (inv.id() != null && !"ok".equals(inv.t()) && !"err".equals(inv.t())) {
					reply(conn, ProtocolCodec.encodeErr(inv.id(), Codes.BAD_MESSAGE, inv.error()));
				}
			}
			case ProtocolCodec.UnknownType u -> {
				LOG.debug("Ignoring unknown message type {}", u.t());
				if (u.id() != null) reply(conn, ProtocolCodec.encodeErr(u.id(), Codes.UNKNOWN_TYPE, "unknown type " + u.t()));
			}
			case ProtocolCodec.Valid v -> dispatch(conn, v);
		}
	}

	private void dispatch(Conn conn, ProtocolCodec.Valid msg) {
		MessageType<?> type = msg.type();
		if (type == Messages.OK || type == Messages.ERR) {
			settle(msg);
			return;
		}
		if (!type.direction().nodeSends()) {
			LOG.warn("Node sent a mod-to-node message type: {}", type);
			if (msg.id() != null) reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.BAD_MESSAGE, type + " is not accepted from Node"));
			return;
		}
		if (type == Messages.HELLO_OK) {
			handshaken = true;
			backoffMs = minBackoffMs;
			Messages.HelloOk ok = msg.payloadAs(Messages.HELLO_OK);
			for (ConnectionListener l : listeners) {
				try {
					l.onHandshake(ok);
				} catch (RuntimeException e) {
					LOG.error("Bridge listener failed", e);
				}
			}
		}
		List<Observer<?>> watching = observers.get(type.name());
		if (watching != null) {
			for (Observer<?> o : watching) notify(o, msg);
		}
		Registration<?> reg = handlers.get(type.name());
		if (reg == null) {
			if (watching != null && msg.id() == null) {
				return;
			}
			if (msg.id() != null) {
				reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.NOT_HANDLED, "no handler for " + type));
			} else if (type != Messages.HELLO_OK) {
				LOG.debug("No handler for {}", type);
			}
			return;
		}
		Runnable task = () -> run(conn, reg, msg);
		try {
			switch (reg.route()) {
				case CLIENT -> clientExecutor.execute(task);
				case SERVER -> {
					Executor server = serverExecutor.get();
					if (server == null) {
						noServer(conn, msg);
					} else {
						// MinecraftServer#execute runs the task inline on the calling thread once the server has
						// stopped. A task that runs on this listener thread therefore never reached the server
						// thread: answer NO_SERVER instead of running server code here.
						Thread listener = Thread.currentThread();
						server.execute(() -> {
							if (Thread.currentThread() == listener) {
								noServer(conn, msg);
							} else {
								task.run();
							}
						});
					}
				}
				case BRIDGE -> task.run();
			}
		} catch (RejectedExecutionException e) {
			if (reg.route() == Route.SERVER) {
				noServer(conn, msg);
			} else if (msg.id() != null) {
				reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.INTERNAL, "client is shutting down"));
			}
		}
	}

	private void noServer(Conn conn, ProtocolCodec.Valid msg) {
		if (msg.id() != null) {
			reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.NO_SERVER, "no integrated server is running"));
		} else {
			LOG.debug("Dropping {}: no integrated server", msg.type());
		}
	}

	/** Runs one observer on its route; failures are logged, never replied (observers do not answer). */
	@SuppressWarnings("unchecked")
	private <P> void notify(Observer<P> o, ProtocolCodec.Valid msg) {
		Runnable task = () -> {
			try {
				o.consumer().accept((P) msg.payload());
			} catch (RuntimeException e) {
				LOG.error("Bridge observer of {} failed", msg.type(), e);
			}
		};
		try {
			switch (o.route()) {
				case CLIENT -> clientExecutor.execute(task);
				case SERVER -> {
					Executor server = serverExecutor.get();
					if (server == null) {
						LOG.debug("Dropping {} for an observer: no integrated server", msg.type());
					} else {
						Thread listener = Thread.currentThread();
						server.execute(() -> {
							if (Thread.currentThread() != listener) task.run();
						});
					}
				}
				case BRIDGE -> task.run();
			}
		} catch (RejectedExecutionException e) {
			LOG.debug("Dropping {} for an observer: executor is shutting down", msg.type());
		}
	}

	@SuppressWarnings("unchecked")
	private <P> void run(Conn conn, Registration<P> reg, ProtocolCodec.Valid msg) {
		if (reg.async() != null) {
			runAsync(conn, reg, reg.async(), msg);
			return;
		}
		Map<String, ?> result;
		try {
			result = reg.handler().handle((P) msg.payload());
		} catch (BridgeException e) {
			if (msg.id() != null) reply(conn, ProtocolCodec.encodeErr(msg.id(), e.code(), e.getMessage()));
			return;
		} catch (Exception e) {
			LOG.error("Bridge handler for {} failed", reg.type(), e);
			if (msg.id() != null) {
				String m = e.getMessage();
				reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.INTERNAL, m != null ? m : e.getClass().getSimpleName()));
			}
			return;
		}
		if (msg.id() != null) {
			try {
				reply(conn, ProtocolCodec.encodeOk(msg.id(), result));
			} catch (ProtocolException e) {
				LOG.error("Reply to {} could not be encoded", reg.type(), e);
				reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.INTERNAL, "reply encoding failed"));
			}
		}
	}

	@SuppressWarnings("unchecked")
	private <P> void runAsync(Conn conn, Registration<P> reg, AsyncHandler<P> handler, ProtocolCodec.Valid msg) {
		CompletionStage<? extends @Nullable Map<String, ?>> stage;
		try {
			stage = Objects.requireNonNull(handler.handle((P) msg.payload()), "async handler returned null");
		} catch (Exception e) {
			stage = CompletableFuture.failedFuture(e);
		}
		stage.whenComplete((result, err) -> {
			if (msg.id() == null) {
				if (err != null) LOG.error("Bridge handler for {} failed", reg.type(), err);
				return;
			}
			if (err != null) {
				BridgeException be = unwrap(err);
				if (be != null) {
					reply(conn, ProtocolCodec.encodeErr(msg.id(), be.code(), String.valueOf(be.getMessage())));
				} else {
					Throwable cause = err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
					LOG.error("Bridge handler for {} failed", reg.type(), cause);
					String m = cause.getMessage();
					reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.INTERNAL, m != null ? m : cause.getClass().getSimpleName()));
				}
				return;
			}
			try {
				reply(conn, ProtocolCodec.encodeOk(msg.id(), result));
			} catch (ProtocolException e) {
				LOG.error("Reply to {} could not be encoded", reg.type(), e);
				reply(conn, ProtocolCodec.encodeErr(msg.id(), Codes.INTERNAL, "reply encoding failed"));
			}
		});
	}

	private void settle(ProtocolCodec.Valid msg) {
		String re = msg.re();
		Pending p = re == null ? null : pending.remove(re);
		if (p == null) {
			LOG.debug("Reply for an unknown or expired request: {}", re);
			return;
		}
		if (msg.payload() instanceof Messages.Ok ok) {
			p.future().complete(ok.result());
		} else if (msg.payload() instanceof Messages.Err err) {
			p.future().completeExceptionally(new BridgeException(err.code(), err.msg()));
		}
	}

	private void onFrame(BufferPool.PooledBuffer frame) {
		try {
			frameSink.onFrame(frame);
		} catch (RuntimeException e) {
			LOG.error("Frame sink failed", e);
			frame.release();
		}
	}

	/** The cause chain's {@link BridgeException}, if any. */
	public static @Nullable BridgeException unwrap(Throwable err) {
		for (Throwable t = err; t != null; t = t.getCause()) {
			if (t instanceof BridgeException be) return be;
		}
		return null;
	}

	/** One WebSocket connection and its receive state. Listener methods are never called concurrently. */
	private final class Conn implements WebSocket.Listener {
		private volatile @Nullable WebSocket ws;
		private final StringBuilder text = new StringBuilder();
		private BufferPool.@Nullable PooledBuffer binary;
		private boolean overflow;

		WebSocket ws() {
			return Objects.requireNonNull(ws, "not open");
		}

		@Override
		public void onOpen(WebSocket webSocket) {
			this.ws = webSocket;
			webSocket.request(1);
			opened(this);
		}

		@Override
		public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
			try {
				if (!overflow) {
					text.append(data);
					if (text.length() > Messages.MAX_TEXT_FRAME_BYTES) tooBig(webSocket, "text message over 256 KiB");
				}
				if (last) {
					if (!overflow) {
						String message = text.toString();
						text.setLength(0);
						if (text.capacity() > 64 * 1024) text.trimToSize();
						onTextMessage(this, message);
					}
					overflow = false;
					text.setLength(0);
				}
			} catch (RuntimeException e) {
				LOG.error("Bridge text handling failed", e);
			} finally {
				webSocket.request(1);
			}
			return null;
		}

		@Override
		public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
			try {
				if (!overflow) appendBinary(webSocket, data);
				if (last) {
					if (!overflow && binary != null) {
						BufferPool.PooledBuffer frame = binary;
						binary = null;
						frame.buffer().flip();
						onFrame(frame);
					}
					overflow = false;
				}
			} catch (RuntimeException e) {
				LOG.error("Bridge binary handling failed", e);
			} finally {
				webSocket.request(1);
			}
			return null;
		}

		private void appendBinary(WebSocket webSocket, ByteBuffer data) {
			int incoming = data.remaining();
			if (binary == null) binary = pool.acquire(Math.max(incoming, BufferPool.MIN_CAPACITY));
			ByteBuffer b = binary.buffer();
			if (b.remaining() < incoming) {
				long needed = (long) b.position() + incoming;
				if (needed > MAX_BINARY_MESSAGE_BYTES) {
					tooBig(webSocket, "binary message over " + MAX_BINARY_MESSAGE_BYTES + " bytes");
					return;
				}
				BufferPool.PooledBuffer bigger = pool.acquire((int) Math.min(BufferPool.MAX_CAPACITY, Math.max(needed, b.capacity() * 2L)));
				b.flip();
				bigger.buffer().put(b);
				binary.release();
				binary = bigger;
				b = bigger.buffer();
			}
			b.put(data);
		}

		private void tooBig(WebSocket webSocket, String why) {
			LOG.warn("Closing bridge: {}", why);
			overflow = true;
			text.setLength(0);
			if (binary != null) {
				binary.release();
				binary = null;
			}
			// 1009 (message too big) is what Node uses, but java.net.http refuses to send it from a client; 1008
			// (policy violation) is the closest code a client may send.
			webSocket.sendClose(POLICY_VIOLATION, "message too big");
		}

		@Override
		public CompletionStage<?> onPing(WebSocket webSocket, ByteBuffer message) {
			// The JDK answers the ping with a pong itself; keep the receive window open.
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onPong(WebSocket webSocket, ByteBuffer message) {
			webSocket.request(1);
			return null;
		}

		@Override
		public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
			dispose();
			lost(this, "closed " + statusCode + (reason.isEmpty() ? "" : " " + reason));
			return null;
		}

		@Override
		public void onError(WebSocket webSocket, Throwable error) {
			dispose();
			lost(this, describe(error));
		}

		/** Releases receive buffers; listener thread only. */
		private void dispose() {
			text.setLength(0);
			if (binary != null) {
				binary.release();
				binary = null;
			}
		}
	}

	/** Builds a {@link BridgeClient}. */
	public static final class Builder {
		private @Nullable ConfigSource configSource;
		private Executor clientExecutor = Runnable::run;
		private Supplier<@Nullable Executor> serverExecutor = () -> null;
		private FrameSink frameSink = FrameSink.DISCARD;
		private @Nullable Supplier<Messages.Hello> helloSupplier;
		private Duration minBackoff = Duration.ofMillis(500);
		private Duration maxBackoff = Duration.ofSeconds(5);

		private Builder() {}

		public Builder config(ConfigSource source) {
			this.configSource = source;
			return this;
		}

		/** Where {@link Route#CLIENT} handlers run ({@code Minecraft.getInstance()} in the game). */
		public Builder clientExecutor(Executor executor) {
			this.clientExecutor = executor;
			return this;
		}

		/** The integrated server to run {@link Route#SERVER} handlers on, or null when none is running. */
		public Builder serverExecutor(Supplier<@Nullable Executor> executor) {
			this.serverExecutor = executor;
			return this;
		}

		public Builder frameSink(FrameSink sink) {
			this.frameSink = sink;
			return this;
		}

		/** Builds the {@code hello} sent first on every connection. */
		public Builder hello(Supplier<Messages.Hello> hello) {
			this.helloSupplier = hello;
			return this;
		}

		public Builder backoff(Duration min, Duration max) {
			this.minBackoff = min;
			this.maxBackoff = max;
			return this;
		}

		public BridgeClient build() {
			return new BridgeClient(this);
		}
	}
}
