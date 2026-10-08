package dev.minevibe.client.org;

import dev.minevibe.bridge.msg.Org;
import java.util.concurrent.CompletableFuture;

/**
 * The requests the org screens make (protocol §7.8). {@link BridgeOrgBackend} sends them to Node over the bridge;
 * {@link FakeOrgBackend} answers them in memory (dev without Node, client GameTests). Futures fail with a
 * {@link dev.minevibe.bridge.BridgeException} carrying the protocol error code, and may complete on any thread.
 */
public interface OrgBackend {
	/** False while the requests cannot reach anyone (no bridge, or not connected). */
	boolean online();

	CompletableFuture<Org.CodexSearchResult> codexSearch(Org.CodexSearch search);

	CompletableFuture<Org.CodexPage> codexGet(String pageId);

	CompletableFuture<Org.CodexPutResult> codexPut(Org.CodexPut put);

	CompletableFuture<Void> codexDelete(Org.CodexDelete delete);

	CompletableFuture<Org.CalendarPutResult> calendarPut(Org.CalendarPut put);

	CompletableFuture<Void> calendarCancel(Org.CalendarCancel cancel);

	CompletableFuture<Org.MeetingStartResult> meetingStart(Org.MeetingStart start);

	CompletableFuture<Void> meetingEnd(String meetingId);
}
