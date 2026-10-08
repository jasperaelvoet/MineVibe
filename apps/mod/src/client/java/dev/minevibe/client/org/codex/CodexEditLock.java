package dev.minevibe.client.org.codex;

import dev.minevibe.bridge.msg.Org;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The soft lock CodexScreen holds while the player edits a page (PLAN §6.6). Nothing stops an agent from writing the
 * same page meanwhile; instead the lock notices and makes sure the player decides:
 *
 * <ul>
 *   <li>While editing, a {@code codex.index} with a newer {@code rev} of the page (or without the page) marks the edit
 *       {@link State#STALE}: the screen says who changed it.</li>
 *   <li>Saving sends {@code update} with the {@code baseRev} the edit started from. A {@code CODEX_CONFLICT} reply
 *       turns the lock {@link State#CONFLICT} with Node's current page: the player can overwrite it (save again on
 *       top of that rev) or reload it (drop the edit).</li>
 * </ul>
 * Client thread only.
 */
public final class CodexEditLock {
	public enum State {
		IDLE,
		EDITING,
		STALE,
		CONFLICT
	}

	private State state = State.IDLE;
	private @Nullable String pageId;
	private @Nullable String baseRev;
	private @Nullable String staleRev;
	private @Nullable String staleBy;
	private boolean staleDeleted;
	private Org.@Nullable CodexPage latest;

	public State state() {
		return this.state;
	}

	public boolean editing() {
		return this.state != State.IDLE;
	}

	/** Null while creating a new page. */
	public @Nullable String pageId() {
		return this.pageId;
	}

	public @Nullable String baseRev() {
		return this.baseRev;
	}

	/** Who changed the page under the edit (an author label), or null. */
	public @Nullable String staleBy() {
		return this.staleBy;
	}

	public boolean staleDeleted() {
		return this.staleDeleted;
	}

	/** Node's current page after a conflict. */
	public Org.@Nullable CodexPage latest() {
		return this.latest;
	}

	/** Starts editing {@code page} (or a new page when null). */
	public void begin(final Org.@Nullable CodexPage page) {
		this.state = State.EDITING;
		this.pageId = page == null ? null : page.id();
		this.baseRev = page == null ? null : page.rev();
		this.staleRev = null;
		this.staleBy = null;
		this.staleDeleted = false;
		this.latest = null;
	}

	public void end() {
		this.state = State.IDLE;
		this.pageId = null;
		this.baseRev = null;
		this.staleRev = null;
		this.staleBy = null;
		this.staleDeleted = false;
		this.latest = null;
	}

	/** A new index arrived: notice when the page under edit changed or went away. */
	public void onIndex(final List<Org.CodexPageMeta> pages) {
		if (this.pageId == null || this.state == State.IDLE || this.state == State.CONFLICT) {
			return;
		}
		Org.CodexPageMeta meta = null;
		for (Org.CodexPageMeta p : pages) {
			if (p.id().equals(this.pageId)) {
				meta = p;
				break;
			}
		}
		if (meta == null) {
			this.state = State.STALE;
			this.staleDeleted = true;
		} else if (!meta.rev().equals(this.baseRev)) {
			this.state = State.STALE;
			this.staleRev = meta.rev();
			this.staleBy = CodexBrowser.authorLabel(meta.author());
		}
	}

	/** The {@code codex.put} that saves the edit: {@code create} for a new page, else {@code update} on the base rev. */
	public Org.CodexPut save(final String title, final String body, final List<String> tags, final String category, final String scope, final @Nullable Boolean pinned) {
		if (this.pageId == null) {
			return new Org.CodexPut("create", null, null, title, body, tags, category, scope, pinned);
		}
		return new Org.CodexPut("update", this.pageId, this.baseRev, title, body, tags, category, scope, pinned);
	}

	/** Saving failed with {@code CODEX_CONFLICT}; {@code current} is Node's page now. */
	public void onConflict(final Org.CodexPage current) {
		this.state = State.CONFLICT;
		this.latest = current;
		this.staleBy = CodexBrowser.authorLabel(current.author());
	}

	/** Keep the player's text on top of the current page: the next save uses its rev. */
	public void overwrite() {
		if (this.latest != null) {
			this.baseRev = this.latest.rev();
		} else if (this.staleRev != null) {
			this.baseRev = this.staleRev;
		}
		this.state = State.EDITING;
		this.staleRev = null;
		this.staleBy = null;
		this.latest = null;
	}
}
