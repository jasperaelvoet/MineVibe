package dev.minevibe.client.org;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import dev.minevibe.bridge.protocol.Schema;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * {@link OrgBackend} over the bridge: each call is one request to Node, its {@code ok} result read into the T0 Java
 * record (checked against the reply schema where T0 has one; a reply that does not match fails with
 * {@code BAD_MESSAGE}).
 */
public final class BridgeOrgBackend implements OrgBackend {
	static final Duration TIMEOUT = Duration.ofSeconds(10);

	@Override
	public boolean online() {
		BridgeClient bridge = MineVibeBridge.get();
		return bridge != null && bridge.isHandshaken();
	}

	@Override
	public CompletableFuture<Org.CodexSearchResult> codexSearch(final Org.CodexSearch search) {
		return this.request(Org.CODEX_SEARCH, search, Org.CODEX_SEARCH_RESULT, Org.CodexSearchResult.class);
	}

	@Override
	public CompletableFuture<Org.CodexPage> codexGet(final String pageId) {
		return this.request(Org.CODEX_GET, new Org.CodexGet(pageId), null, Org.CodexGetResult.class).thenApply(Org.CodexGetResult::page);
	}

	@Override
	public CompletableFuture<Org.CodexPutResult> codexPut(final Org.CodexPut put) {
		return this.request(Org.CODEX_PUT, put, Org.CODEX_PUT_RESULT, Org.CodexPutResult.class);
	}

	@Override
	public CompletableFuture<Void> codexDelete(final Org.CodexDelete delete) {
		return this.request(Org.CODEX_DELETE, delete, null, JsonObject.class).thenApply(ok -> null);
	}

	@Override
	public CompletableFuture<Org.CalendarPutResult> calendarPut(final Org.CalendarPut put) {
		return this.request(Org.CALENDAR_PUT, put, Org.CALENDAR_PUT_RESULT, Org.CalendarPutResult.class);
	}

	@Override
	public CompletableFuture<Void> calendarCancel(final Org.CalendarCancel cancel) {
		return this.request(Org.CALENDAR_CANCEL, cancel, null, JsonObject.class).thenApply(ok -> null);
	}

	@Override
	public CompletableFuture<Org.MeetingStartResult> meetingStart(final Org.MeetingStart start) {
		return this.request(Org.MEETING_START, start, Org.MEETING_START_RESULT, Org.MeetingStartResult.class);
	}

	@Override
	public CompletableFuture<Void> meetingEnd(final String meetingId) {
		return this.request(Org.MEETING_END, new Org.MeetingEnd(meetingId), null, JsonObject.class).thenApply(ok -> null);
	}

	private <P, R> CompletableFuture<R> request(final MessageType<P> type, final P payload, final Schema.@Nullable Obj resultSchema, final Class<R> resultClass) {
		BridgeClient bridge = MineVibeBridge.get();
		if (bridge == null) {
			return CompletableFuture.failedFuture(new BridgeException(Codes.DISCONNECTED, "MineVibe is not connected"));
		}
		return bridge.request(type, payload, TIMEOUT).thenApply(result -> {
			if (resultSchema != null) {
				List<String> errors = resultSchema.validate(result);
				if (!errors.isEmpty()) {
					throw new BridgeException(Codes.BAD_MESSAGE, type + " reply: " + String.join("; ", errors));
				}
			}
			return ProtocolCodec.GSON.fromJson(result, resultClass);
		});
	}
}
