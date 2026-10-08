package dev.minevibe.client.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages.Codes;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * UI requests hand their outcome to the client thread, failures included: a failed reply must not run screen or
 * {@link UiState} code on the bridge thread that failed it.
 */
class UiActionsTest {
	/** Replies are completed by the test, from whichever thread it likes. */
	static final class ManualTransport implements UiTransport {
		final List<CompletableFuture<JsonObject>> replies = new ArrayList<>();
		final List<Object> payloads = new ArrayList<>();

		@Override
		public boolean configured() {
			return true;
		}

		@Override
		public boolean connected() {
			return true;
		}

		@Override
		public <P> CompletableFuture<JsonObject> request(MessageType<P> type, P payload) {
			CompletableFuture<JsonObject> reply = new CompletableFuture<>();
			replies.add(reply);
			payloads.add(payload);
			return reply;
		}
	}

	private final ManualTransport transport = new ManualTransport();

	@BeforeEach
	void setUp() {
		UiActions.drainClientTasks();
		UiTransport.install(transport);
	}

	@AfterEach
	void tearDown() {
		UiTransport.install(null);
		UiActions.drainClientTasks();
	}

	private static Thread completeOn(String name, Runnable completion) throws InterruptedException {
		Thread t = new Thread(completion, name);
		t.start();
		t.join(TimeUnit.SECONDS.toMillis(5));
		return t;
	}

	@Test
	void aFailedReplyReachesTheCallerOnlyWhenTheClientThreadDrains() throws InterruptedException {
		AtomicReference<Thread> ranOn = new AtomicReference<>();
		AtomicReference<Throwable> error = new AtomicReference<>();
		UiActions.chatLine("@ada hello").whenComplete((echo, err) -> {
			ranOn.set(Thread.currentThread());
			error.set(err);
		});

		completeOn("mv-bridge-recv", () -> transport.replies.getFirst()
				.completeExceptionally(new BridgeException(Codes.CHAT_UNKNOWN, "Nobody is called @zed")));
		assertNull(ranOn.get(), "the failure ran on the bridge thread");

		assertEquals(1, UiActions.drainClientTasks());
		assertSame(Thread.currentThread(), ranOn.get());
		assertEquals("Nobody is called @zed", UiActions.errorText(error.get()));
	}

	@Test
	void aSuccessfulReplyIsHandedOverTheSameWay() throws InterruptedException {
		AtomicReference<Thread> ranOn = new AtomicReference<>();
		AtomicReference<String> echo = new AtomicReference<>();
		UiActions.command("ada", "follow", null, null).whenComplete((e, err) -> {
			ranOn.set(Thread.currentThread());
			echo.set(e);
		});
		JsonObject ok = new JsonObject();
		ok.addProperty("echo", "Ada follows you");
		completeOn("mv-bridge-recv", () -> transport.replies.getFirst().complete(ok));
		assertNull(ranOn.get());

		UiActions.drainClientTasks();
		assertSame(Thread.currentThread(), ranOn.get());
		assertEquals("Ada follows you", echo.get());
	}

	@Test
	void aHistoryFailureNeverTouchesTheTranscriptOffThread() throws InterruptedException {
		AtomicReference<Thread> ranOn = new AtomicReference<>();
		UiActions.history("ada", null, 50).whenComplete((page, err) -> ranOn.set(Thread.currentThread()));
		completeOn("mv-bridge-timer", () -> transport.replies.getFirst()
				.completeExceptionally(new BridgeException(Codes.TIMEOUT, "chat.history timed out")));
		assertNull(ranOn.get());
		UiActions.drainClientTasks();
		assertSame(Thread.currentThread(), ranOn.get());
	}

	@Test
	void runOnClientWaitsForTheNextDrain() {
		List<String> ran = new ArrayList<>();
		UiActions.runOnClient(() -> ran.add("open"));
		assertTrue(ran.isEmpty());
		UiActions.drainClientTasks();
		assertEquals(List.of("open"), ran);
	}

	@Test
	void declineNotesFitTheProtocol() {
		assertNull(UiActions.note(null));
		assertNull(UiActions.note("   "));
		assertEquals("too risky", UiActions.note("  too risky "));
		assertEquals(UiActions.NOTE_MAX_LENGTH, UiActions.note("x".repeat(2000)).length());

		UiActions.hire("h-1", false, "n".repeat(900));
		var decision = (dev.minevibe.bridge.msg.Ui.HireDecision) transport.payloads.getFirst();
		assertEquals(UiActions.NOTE_MAX_LENGTH, decision.note().length());
	}
}
