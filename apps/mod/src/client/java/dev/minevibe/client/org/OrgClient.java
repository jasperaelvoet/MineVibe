package dev.minevibe.client.org;

import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.protocol.Messages.Codes;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;

/**
 * The org screens' way to Node: which {@link OrgBackend} is in use, delivery of request results on the client thread,
 * and player-facing wording for request errors.
 */
public final class OrgClient {
	/**
	 * {@code -Dminevibe.org.fake=true} (or {@code MINEVIBE_ORG_FAKE=1} in the game's environment): answer the org
	 * screens from {@link FakeOrgBackend} instead of Node, to try them without a server.
	 */
	public static final String FAKE_PROPERTY = "minevibe.org.fake";
	public static final String FAKE_ENV = "MINEVIBE_ORG_FAKE";

	private static volatile OrgBackend backend = new BridgeOrgBackend();

	private OrgClient() {
	}

	public static OrgBackend backend() {
		return backend;
	}

	/** Replaces the backend (the fake for dev runs and client GameTests). */
	public static void useBackend(final OrgBackend replacement) {
		backend = replacement;
	}

	public static boolean fakeRequested() {
		String env = System.getenv(FAKE_ENV);
		return Boolean.getBoolean(FAKE_PROPERTY) || env != null && (env.equals("1") || env.equalsIgnoreCase("true"));
	}

	/** Runs {@code ok} or {@code failed} on the client thread when {@code future} completes. */
	public static <T> void whenDone(final CompletableFuture<T> future, final Consumer<T> ok, final Consumer<Throwable> failed) {
		future.whenComplete((value, error) -> Minecraft.getInstance().execute(() -> {
			if (error == null) {
				ok.accept(value);
			} else {
				failed.accept(unwrap(error));
			}
		}));
	}

	public static Throwable unwrap(final Throwable error) {
		Throwable t = error;
		while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
			t = t.getCause();
		}
		return t;
	}

	/** The protocol error code of a failed request, or null. */
	public static String code(final Throwable error) {
		return unwrap(error) instanceof BridgeException b ? b.code() : null;
	}

	/** What to tell the player about a failed request. */
	public static String describe(final Throwable error) {
		Throwable t = unwrap(error);
		String code = t instanceof BridgeException b ? b.code() : "";
		return switch (code) {
			case Codes.DISCONNECTED -> "MineVibe is offline; try again in a moment";
			case Codes.TIMEOUT -> "MineVibe did not answer in time";
			case Codes.CODEX_CONFLICT -> "Someone changed this page while you were editing";
			case Codes.CODEX_SIMILAR -> "A page like this exists already: " + t.getMessage();
			case Codes.CODEX_TOO_LARGE -> "Too long: a page holds at most 8 KB";
			case Codes.CODEX_SECRET -> "That looks like a password or key; the Codex will not store it";
			case Codes.CODEX_NOT_FOUND -> "That page is gone";
			case Codes.CODEX_INVALID -> "The Codex refused it: " + t.getMessage();
			case Codes.CODEX_BUDGET -> "The Codex write budget is used up for today";
			case Codes.CALENDAR_NOT_FOUND -> "That event is gone";
			case Codes.CALENDAR_INVALID -> "The calendar refused it: " + t.getMessage();
			case Codes.CALENDAR_LIMIT -> "Too many events: " + t.getMessage();
			case Codes.MEETING_BUSY -> "A meeting is already running";
			case Codes.MEETING_NOT_FOUND -> "That meeting is over";
			case Codes.NO_QUORUM -> "Not enough of the crew can come (the CEO and one more are needed)";
			case Codes.FORBIDDEN -> "Not allowed: " + t.getMessage();
			default -> t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
		};
	}
}
