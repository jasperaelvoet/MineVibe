package dev.minevibe.client.org.codex;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Types;
import java.util.List;
import org.junit.jupiter.api.Test;

/** CodexScreen's browser, soft lock and Markdown subset. */
class CodexModelsTest {
	private static final Types.Author PLAYER = new Types.Author("player", "Jasper", null);
	private static final Types.Author BRAM = new Types.Author("agent", "Bram", "bram");

	private static Org.CodexPageMeta meta(final String id, final String title, final String category, final boolean pinned, final long updated, final String rev,
		final Types.Author author, final String... tags) {
		return new Org.CodexPageMeta(id, title, category, "lasting", List.of(tags), author, 0, updated, rev, pinned);
	}

	private static Org.CodexPage page(final Org.CodexPageMeta m, final String body) {
		return new Org.CodexPage(m.id(), m.title(), m.category(), m.scope(), m.tags(), m.author(), m.created(), m.updated(), m.rev(), m.pinned(), body,
			List.of(), List.of());
	}

	private static final List<Org.CodexPageMeta> PAGES = List.of(
		meta("iron-cave", "Iron cave", "places", false, 300, "aaaaaaa", BRAM, "iron", "cave"),
		meta("house-rules", "House rules", "rules", true, 100, "bbbbbbb", PLAYER),
		meta("smelting", "How to smelt", "howto", false, 500, "ccccccc", BRAM, "furnace"),
		meta("old-notes", "Old notes", "log", true, 50, "ddddddd", BRAM));

	@Test
	void pinnedFirstThenNewest() {
		List<String> ids = CodexBrowser.filter(PAGES, CodexBrowser.ALL, "").stream().map(Org.CodexPageMeta::id).toList();
		assertEquals(List.of("house-rules", "old-notes", "smelting", "iron-cave"), ids);
	}

	@Test
	void tabsAndTitleFilters() {
		assertEquals(List.of("iron-cave"), CodexBrowser.filter(PAGES, "places", "").stream().map(Org.CodexPageMeta::id).toList());
		assertEquals(List.of("house-rules", "old-notes"), CodexBrowser.filter(PAGES, CodexBrowser.PINNED, "").stream().map(Org.CodexPageMeta::id).toList());
		assertEquals(List.of("iron-cave"), CodexBrowser.filter(PAGES, CodexBrowser.ALL, "IRON").stream().map(Org.CodexPageMeta::id).toList());
		assertEquals(List.of("smelting"), CodexBrowser.filter(PAGES, CodexBrowser.ALL, "furnace how").stream().map(Org.CodexPageMeta::id).toList(),
			"every word must match the title or a tag");
		assertTrue(CodexBrowser.filter(PAGES, "minutes", "").isEmpty());
		assertEquals(2 + Org.CODEX_CATEGORIES.size(), CodexBrowser.TABS.size());
	}

	@Test
	void onlyThePlayersRulesBind() {
		assertTrue(CodexBrowser.isBindingRule("rules", PLAYER));
		assertFalse(CodexBrowser.isBindingRule("rules", BRAM));
		assertFalse(CodexBrowser.isBindingRule("howto", PLAYER));
		assertEquals("You", CodexBrowser.authorLabel(PLAYER));
		assertEquals("Bram", CodexBrowser.authorLabel(BRAM));
		assertEquals("MineVibe", CodexBrowser.authorLabel(new Types.Author("system", "node", null)));
	}

	@Test
	void tagsAreCleanedToWhatTheSchemaTakes() {
		assertEquals(List.of("iron", "cave", "deep-dark"), CodexBrowser.parseTags(" Iron, cave  Deep-Dark,iron, "));
		assertEquals(List.of("ok"), CodexBrowser.parseTags("--, ok, ###"));
		assertEquals(16, CodexBrowser.parseTags("a b c d e f g h i j k l m n o p q r s").size());
	}

	@Test
	void theSoftLockNoticesChangesUnderTheEdit() {
		CodexEditLock lock = new CodexEditLock();
		Org.CodexPage iron = page(PAGES.getFirst(), "Iron at 120 40 -80");
		lock.begin(iron);
		assertEquals(CodexEditLock.State.EDITING, lock.state());
		lock.onIndex(PAGES);
		assertEquals(CodexEditLock.State.EDITING, lock.state(), "same rev: nothing changed");
		Org.CodexPut put = lock.save("Iron cave", "new text", List.of("iron"), "places", "world", null);
		assertEquals("update", put.mode());
		assertEquals("aaaaaaa", put.baseRev());

		lock.onIndex(List.of(meta("iron-cave", "Iron cave", "places", false, 900, "eeeeeee", BRAM)));
		assertEquals(CodexEditLock.State.STALE, lock.state());
		assertEquals("Bram", lock.staleBy());
		lock.overwrite();
		assertEquals(CodexEditLock.State.EDITING, lock.state());
		assertEquals("eeeeeee", lock.baseRev(), "overwriting builds on the rev the player was shown");

		lock.onIndex(List.of());
		assertEquals(CodexEditLock.State.STALE, lock.state());
		assertTrue(lock.staleDeleted());
	}

	@Test
	void aConflictLetsThePlayerOverwriteOnTheCurrentRev() {
		CodexEditLock lock = new CodexEditLock();
		lock.begin(page(PAGES.getFirst(), "old"));
		Org.CodexPage theirs = page(meta("iron-cave", "Iron cave", "places", false, 999, "fffffff", BRAM), "theirs");
		lock.onConflict(theirs);
		assertEquals(CodexEditLock.State.CONFLICT, lock.state());
		assertEquals(theirs, lock.latest());
		lock.onIndex(List.of(meta("iron-cave", "Iron cave", "places", false, 1000, "1234567", BRAM)));
		assertEquals(CodexEditLock.State.CONFLICT, lock.state(), "a conflict waits for the player");
		lock.overwrite();
		assertEquals("fffffff", lock.save("t", "b", List.of(), "places", "world", null).baseRev());
		lock.end();
		assertFalse(lock.editing());
	}

	@Test
	void aNewPageIsACreate() {
		CodexEditLock lock = new CodexEditLock();
		lock.begin(null);
		Org.CodexPut put = lock.save("House rules", "- Be nice", List.of(), "rules", "lasting", Boolean.TRUE);
		assertEquals("create", put.mode());
		assertNull(put.pageId());
		assertNull(put.baseRev());
		lock.onIndex(PAGES);
		assertEquals(CodexEditLock.State.EDITING, lock.state(), "a page that does not exist yet cannot go stale");
	}

	@Test
	void theMarkdownSubset() {
		List<CodexText.Line> lines = CodexText.parse("# Iron\r\n\n- lava east\n* torches\n> note\n```\ncode # not a heading\n```\nplain\n\n\n");
		assertEquals(List.of(
			new CodexText.Line(CodexText.Style.HEADING, "Iron"),
			new CodexText.Line(CodexText.Style.BLANK, ""),
			new CodexText.Line(CodexText.Style.BULLET, "lava east"),
			new CodexText.Line(CodexText.Style.BULLET, "torches"),
			new CodexText.Line(CodexText.Style.QUOTE, "note"),
			new CodexText.Line(CodexText.Style.CODE, "code # not a heading"),
			new CodexText.Line(CodexText.Style.TEXT, "plain")), lines);
	}
}
