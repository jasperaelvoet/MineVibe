package dev.minevibe.client.org.codex;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.protocol.Messages.Codes;
import dev.minevibe.client.org.OrgBackend;
import dev.minevibe.client.org.OrgClient;
import dev.minevibe.client.org.OrgClientState;
import dev.minevibe.client.org.OrgUi;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.CycleButton;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.MultiLineEditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.util.FormattedCharSequence;
import org.jspecify.annotations.Nullable;

/**
 * CodexScreen (PLAN §6.6, §7.8): the shared Codex as an open book. The left page browses (category tabs, search,
 * the page list); the right page reads a page (author, history, tags, body), and edits, pins or deletes it. Writes go
 * to Node as {@code codex.put} / {@code codex.delete}, stamped as the player's.
 *
 * <ul>
 *   <li><b>Rules.</b> Only {@code rules} pages the player wrote are binding house rules; the screen says so on every
 *       rules page, and a rules page is always lasting.</li>
 *   <li><b>Soft lock.</b> While editing, a newer version of the page in {@code codex.index} is flagged; a stale save
 *       comes back {@code CODEX_CONFLICT} and the player chooses to overwrite or reload ({@link CodexEditLock}).</li>
 *   <li>Never pauses the game.</li>
 * </ul>
 */
public final class CodexScreen extends Screen {
	private static final int COVER = 0xFF4A2E1C;
	private static final int COVER_EDGE = 0xFF2A190E;
	private static final int PAGE = 0xFFF3E9D2;
	private static final int PAGE_SHADE = 0xFFE2D3B1;
	private static final int INK = 0xFF2B2118;
	private static final int INK_FAINT = 0xFF7A6A55;
	private static final int INK_RED = 0xFFA02828;
	private static final int CODE_INK = 0xFF3A4A3A;
	private static final int TAB = 0xFFE9DCBF;
	private static final int TAB_ON = 0xFF8C5A2B;
	private static final int ROW_ON = 0x40A0662A;
	private static final int ROW_HOVER = 0x20A0662A;
	private static final int LINE = 12;
	private static final long SEARCH_DEBOUNCE_MS = 250;

	private enum Mode {
		BROWSE,
		EDIT
	}

	private final OrgClientState state = OrgClientState.get();
	private final OrgBackend backend = OrgClient.backend();
	private final CodexEditLock lock = new CodexEditLock();
	private final OrgUi.Hits hits = new OrgUi.Hits();

	private Mode mode = Mode.BROWSE;
	private String tab = CodexBrowser.ALL;
	private String query = "";
	private @Nullable List<Org.CodexHit> searchHits;
	private long searchDueAt;
	private int searchSeq;
	private @Nullable String selectedId;
	private Org.@Nullable CodexPage page;
	private boolean showHistory;
	private boolean confirmDelete;
	private boolean busy;
	private int listScroll;
	private int bodyScroll;
	private String status = "";
	private int statusColour = INK_FAINT;
	private int seenVersion = -1;

	private String editTitle = "";
	private String editBody = "";
	private String editTags = "";
	private String editCategory = "howto";
	private String editScope = "lasting";
	private boolean editPinned;

	private int bx0;
	private int by0;
	private int bx1;
	private int by1;
	private int lx0;
	private int lx1;
	private int rx0;
	private int rx1;
	private int py0;
	private int py1;
	private int listTop;
	private int listBottom;
	private int bodyTop;
	private int bodyBottom;

	public CodexScreen() {
		super(Component.literal("Codex"));
	}

	/** Opens the Codex on {@code pageId}. */
	public CodexScreen(final String pageId) {
		this();
		this.select(pageId);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	protected void init() {
		int bw = Math.min(this.width - 16, 460);
		int bh = Math.min(this.height - 16, 280);
		this.bx0 = (this.width - bw) / 2;
		this.by0 = (this.height - bh) / 2;
		this.bx1 = this.bx0 + bw;
		this.by1 = this.by0 + bh;
		int mid = (this.bx0 + this.bx1) / 2;
		this.lx0 = this.bx0 + 10;
		this.lx1 = mid - 6;
		this.rx0 = mid + 6;
		this.rx1 = this.bx1 - 10;
		this.py0 = this.by0 + 8;
		this.py1 = this.by1 - 8;

		EditBox search = new EditBox(this.font, this.lx0, this.py0 + 14, this.lx1 - this.lx0, 14, Component.literal("Search"));
		search.setHint(Component.literal("Search the Codex").withStyle(ChatFormatting.GRAY));
		search.setMaxLength(200);
		search.setValue(this.query);
		search.setResponder(text -> {
			if (!text.equals(this.query)) {
				this.query = text;
				this.listScroll = 0;
				this.searchDueAt = System.currentTimeMillis() + SEARCH_DEBOUNCE_MS;
				if (text.isBlank()) {
					this.searchHits = null;
				}
			}
		});
		this.addRenderableWidget(search);
		this.addRenderableWidget(Button.builder(Component.literal("+ New page"), b -> this.newPage())
			.bounds(this.lx0, this.py1 - 18, this.lx1 - this.lx0, 18)
			.build()).active = this.mode == Mode.BROWSE;

		if (this.mode == Mode.EDIT) {
			this.initEditor();
		} else if (this.page != null) {
			this.initReaderButtons();
		}
	}

	private void initReaderButtons() {
		Org.CodexPage p = this.page;
		int w = (this.rx1 - this.rx0 - 6) / 4;
		int y = this.py1 - 18;
		this.addRenderableWidget(Button.builder(Component.literal("Edit"), b -> this.edit()).bounds(this.rx0, y, w, 18).build()).active = !this.busy;
		this.addRenderableWidget(Button.builder(Component.literal(p.pinned() ? "Unpin" : "Pin"), b -> this.togglePin())
			.bounds(this.rx0 + w + 2, y, w, 18).build()).active = !this.busy;
		this.addRenderableWidget(Button.builder(Component.literal(this.showHistory ? "Page" : "History"), b -> {
			this.showHistory = !this.showHistory;
			this.bodyScroll = 0;
			this.rebuildWidgets();
		}).bounds(this.rx0 + 2 * (w + 2), y, w, 18).build());
		Button delete = this.addRenderableWidget(Button.builder(
			Component.literal(this.confirmDelete ? "Really?" : "Delete").withStyle(this.confirmDelete ? ChatFormatting.RED : ChatFormatting.RESET),
			b -> this.delete()).bounds(this.rx0 + 3 * (w + 2), y, this.rx1 - this.rx0 - 3 * (w + 2), 18).build());
		delete.active = !this.busy;
	}

	private void initEditor() {
		int w = this.rx1 - this.rx0;
		int y = this.py0 + 12;
		EditBox title = new EditBox(this.font, this.rx0, y, w, 14, Component.literal("Title"));
		title.setHint(Component.literal("Title").withStyle(ChatFormatting.GRAY));
		title.setMaxLength(80);
		title.setValue(this.editTitle);
		title.setResponder(t -> this.editTitle = t);
		this.addRenderableWidget(title);
		y += 17;
		int half = (w - 2) / 2;
		this.addRenderableWidget(CycleButton.builder((String c) -> Component.literal(CodexBrowser.tabLabel(c)), this.editCategory)
			.withValues(Org.CODEX_CATEGORIES)
			.create(this.rx0, y, half, 16, Component.literal("Kind"), (b, value) -> {
				this.editCategory = value;
				if ("rules".equals(value)) {
					this.editScope = "lasting";
				}
				this.rebuildWidgets();
			}));
		CycleButton<String> scope = this.addRenderableWidget(CycleButton.builder((String s) -> Component.literal("lasting".equals(s) ? "Lasting" : "This world"), this.editScope)
			.withValues(List.of("lasting", "world"))
			.create(this.rx0 + half + 2, y, w - half - 2, 16, Component.literal("Keep"), (b, value) -> this.editScope = value));
		scope.active = !"rules".equals(this.editCategory);
		y += 19;
		EditBox tags = new EditBox(this.font, this.rx0, y, w, 14, Component.literal("Tags"));
		tags.setHint(Component.literal("tags, comma separated").withStyle(ChatFormatting.GRAY));
		tags.setMaxLength(300);
		tags.setValue(this.editTags);
		tags.setResponder(t -> this.editTags = t);
		this.addRenderableWidget(tags);
		y += 17;
		int bodyBottom = this.py1 - 34;
		MultiLineEditBox body = MultiLineEditBox.builder()
			.setX(this.rx0)
			.setY(y)
			.setPlaceholder(Component.literal("Write the page. # headings and - bullets work.").withStyle(ChatFormatting.GRAY))
			.build(this.font, w, Math.max(30, bodyBottom - y), Component.literal("Page"));
		body.setCharacterLimit(Org.CODEX_BODY_MAX);
		body.setValue(this.editBody);
		body.setValueListener(t -> this.editBody = t);
		this.addRenderableWidget(body);

		int by = this.py1 - 18;
		if (this.lock.state() == CodexEditLock.State.CONFLICT) {
			int third = (w - 4) / 3;
			this.addRenderableWidget(Button.builder(Component.literal("Overwrite"), b -> {
				this.lock.overwrite();
				this.save();
			}).bounds(this.rx0, by, third, 18).build()).active = !this.busy;
			this.addRenderableWidget(Button.builder(Component.literal("Reload"), b -> this.reload()).bounds(this.rx0 + third + 2, by, third, 18).build());
			this.addRenderableWidget(Button.builder(Component.literal("Cancel"), b -> this.cancelEdit()).bounds(this.rx0 + 2 * (third + 2), by, w - 2 * (third + 2), 18).build());
		} else {
			this.addRenderableWidget(Button.builder(Component.literal("Save"), b -> this.save()).bounds(this.rx0, by, half, 18).build()).active = !this.busy;
			this.addRenderableWidget(Button.builder(Component.literal("Cancel"), b -> this.cancelEdit()).bounds(this.rx0 + half + 2, by, w - half - 2, 18).build());
		}
	}

	// ------------------------------------------------------------------ actions

	/** The soft lock's state (IDLE when not editing). */
	public CodexEditLock.State editState() {
		return this.lock.state();
	}

	/** Shows {@code pageId} on the right page (unless an edit is open). */
	public void select(final String pageId) {
		if (this.mode == Mode.EDIT) {
			this.setStatus("Save or cancel the edit first", INK_RED);
			return;
		}
		this.selectedId = pageId;
		this.showHistory = false;
		this.confirmDelete = false;
		this.bodyScroll = 0;
		this.load(pageId);
	}

	private void load(final String pageId) {
		OrgClient.whenDone(this.backend.codexGet(pageId), loaded -> {
			if (pageId.equals(this.selectedId)) {
				this.page = loaded;
				this.rebuildIfOpen();
			}
		}, error -> {
			if (pageId.equals(this.selectedId)) {
				this.page = null;
				this.setStatus(OrgClient.describe(error), INK_RED);
				this.rebuildIfOpen();
			}
		});
	}

	/** Starts writing a new page. */
	public void newPage() {
		this.lock.begin(null);
		this.editTitle = this.query.isBlank() || this.searchHits != null && !this.searchHits.isEmpty() ? "" : this.query.trim();
		this.editBody = "";
		this.editTags = "";
		this.editCategory = Org.CODEX_CATEGORIES.contains(this.tab) ? this.tab : "howto";
		this.editScope = "rules".equals(this.editCategory) || !"places".equals(this.editCategory) ? "lasting" : "world";
		this.editPinned = false;
		this.mode = Mode.EDIT;
		this.setStatus("New page", INK_FAINT);
		this.rebuildWidgets();
	}

	/** Starts editing the page on the right. */
	public void edit() {
		Org.CodexPage p = this.page;
		if (p == null) {
			return;
		}
		this.lock.begin(p);
		this.editTitle = p.title();
		this.editBody = p.body();
		this.editTags = String.join(", ", p.tags());
		this.editCategory = p.category();
		this.editScope = p.scope();
		this.editPinned = p.pinned();
		this.mode = Mode.EDIT;
		this.setStatus("Editing; agents see your changes once you save", INK_FAINT);
		this.rebuildWidgets();
	}

	/** Saves the edit (as the Save button does). */
	public void save() {
		String title = this.editTitle.trim();
		if (title.isEmpty()) {
			this.setStatus("Give the page a title", INK_RED);
			return;
		}
		if (this.editBody.isBlank()) {
			this.setStatus("The page is empty", INK_RED);
			return;
		}
		String scope = "rules".equals(this.editCategory) ? "lasting" : this.editScope;
		Org.CodexPut put = this.lock.save(title, this.editBody, CodexBrowser.parseTags(this.editTags), this.editCategory, scope, this.editPinned ? Boolean.TRUE : null);
		this.busy = true;
		this.setStatus("Saving…", INK_FAINT);
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.codexPut(put), result -> {
			this.busy = false;
			this.lock.end();
			this.mode = Mode.BROWSE;
			this.setStatus("Saved", INK_FAINT);
			this.selectedId = result.pageId();
			this.load(result.pageId());
			this.rebuildIfOpen();
		}, error -> {
			this.busy = false;
			String pageId = this.lock.pageId();
			if (Codes.CODEX_CONFLICT.equals(OrgClient.code(error)) && pageId != null) {
				OrgClient.whenDone(this.backend.codexGet(pageId), current -> {
					this.lock.onConflict(current);
					this.setStatus(current.author().name() + " changed this page while you were editing", INK_RED);
					this.rebuildIfOpen();
				}, again -> {
					this.setStatus(OrgClient.describe(again), INK_RED);
					this.rebuildIfOpen();
				});
			} else {
				this.setStatus(OrgClient.describe(error), INK_RED);
				this.rebuildIfOpen();
			}
		});
	}

	private void reload() {
		String pageId = this.lock.pageId();
		this.lock.end();
		this.mode = Mode.BROWSE;
		if (pageId != null) {
			this.select(pageId);
		}
		this.rebuildWidgets();
	}

	private void cancelEdit() {
		this.lock.end();
		this.mode = Mode.BROWSE;
		this.setStatus("", INK_FAINT);
		this.rebuildWidgets();
	}

	private void togglePin() {
		Org.CodexPage p = this.page;
		if (p == null) {
			return;
		}
		Org.CodexPut put = new Org.CodexPut("update", p.id(), p.rev(), p.title(), p.body(), p.tags(), p.category(), p.scope(), !p.pinned());
		this.busy = true;
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.codexPut(put), result -> {
			this.busy = false;
			this.setStatus(p.pinned() ? "Unpinned" : "Pinned: agents see it in their Codex digest", INK_FAINT);
			this.load(result.pageId());
		}, error -> {
			this.busy = false;
			this.setStatus(OrgClient.describe(error), INK_RED);
			this.load(p.id());
		});
	}

	private void delete() {
		Org.CodexPage p = this.page;
		if (p == null) {
			return;
		}
		if (!this.confirmDelete) {
			this.confirmDelete = true;
			this.rebuildWidgets();
			return;
		}
		this.busy = true;
		this.rebuildWidgets();
		OrgClient.whenDone(this.backend.codexDelete(new Org.CodexDelete(p.id(), p.rev())), ok -> {
			this.busy = false;
			this.confirmDelete = false;
			this.selectedId = null;
			this.page = null;
			this.setStatus("Deleted \"" + p.title() + "\"", INK_FAINT);
			this.rebuildIfOpen();
		}, error -> {
			this.busy = false;
			this.confirmDelete = false;
			this.setStatus(OrgClient.describe(error), INK_RED);
			this.rebuildIfOpen();
		});
	}

	private void runSearch() {
		String q = this.query.trim();
		if (q.isEmpty()) {
			this.searchHits = null;
			return;
		}
		if (!this.backend.online()) {
			this.searchHits = null;
			this.setStatus("Offline: matching titles only", INK_FAINT);
			return;
		}
		int seq = ++this.searchSeq;
		String category = Org.CODEX_CATEGORIES.contains(this.tab) ? this.tab : null;
		OrgClient.whenDone(this.backend.codexSearch(new Org.CodexSearch(q, null, category, null, 30)), result -> {
			if (seq == this.searchSeq) {
				this.searchHits = result.hits();
				this.listScroll = 0;
			}
		}, error -> {
			if (seq == this.searchSeq) {
				this.searchHits = null;
				this.setStatus(OrgClient.describe(error), INK_RED);
			}
		});
	}

	private void setStatus(final String text, final int colour) {
		this.status = text;
		this.statusColour = colour;
	}

	private void rebuildIfOpen() {
		if (this.minecraft != null && this.minecraft.gui.screen() == this) {
			this.rebuildWidgets();
		}
	}

	@Override
	public void tick() {
		super.tick();
		if (this.searchDueAt > 0 && System.currentTimeMillis() >= this.searchDueAt) {
			this.searchDueAt = 0;
			this.runSearch();
		}
		if (this.seenVersion != this.state.version()) {
			this.seenVersion = this.state.version();
			CodexEditLock.State before = this.lock.state();
			this.lock.onIndex(this.state.codexPages(), this.state.codexTruncated());
			if (before != this.lock.state() && this.lock.state() == CodexEditLock.State.STALE) {
				this.setStatus(this.lock.staleDeleted() ? "This page was deleted while you were editing"
					: this.lock.staleBy() + " changed this page; saving will ask you", INK_RED);
			}
			Org.CodexPage p = this.page;
			if (this.mode == Mode.BROWSE && p != null) {
				Org.CodexPageMeta meta = this.state.codexPages().stream().filter(m -> m.id().equals(p.id())).findFirst().orElse(null);
				// A truncated index (over 1000 pages) leaves pages out: only a complete one says the page is gone.
				if (meta == null && this.state.codexKnown() && !this.state.codexTruncated()) {
					this.page = null;
					this.selectedId = null;
					this.rebuildWidgets();
				} else if (meta != null && !meta.rev().equals(p.rev())) {
					this.load(p.id());
				}
			}
		}
	}

	// ------------------------------------------------------------------ input

	@Override
	public boolean mouseClicked(final MouseButtonEvent event, final boolean doubleClick) {
		if (super.mouseClicked(event, doubleClick)) {
			return true;
		}
		return this.hits.click(event.x(), event.y());
	}

	@Override
	public boolean mouseScrolled(final double x, final double y, final double scrollX, final double scrollY) {
		if (OrgUi.inside(x, y, this.lx0, this.listTop, this.lx1, this.listBottom)) {
			this.listScroll = Math.max(0, this.listScroll - (int)Math.signum(scrollY) * LINE);
			return true;
		}
		if (this.mode == Mode.BROWSE && OrgUi.inside(x, y, this.rx0, this.bodyTop, this.rx1, this.bodyBottom)) {
			this.bodyScroll = Math.max(0, this.bodyScroll - (int)Math.signum(scrollY) * LINE);
			return true;
		}
		return super.mouseScrolled(x, y, scrollX, scrollY);
	}

	// ------------------------------------------------------------------ drawing

	@Override
	public void extractRenderState(final GuiGraphicsExtractor g, final int mouseX, final int mouseY, final float a) {
		this.hits.clear();
		this.drawBook(g);
		this.drawLeftPage(g, mouseX, mouseY);
		if (this.mode == Mode.EDIT) {
			this.drawEditorPage(g);
		} else {
			this.drawReaderPage(g);
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	private void drawBook(final GuiGraphicsExtractor g) {
		g.fill(this.bx0 - 3, this.by0 - 3, this.bx1 + 3, this.by1 + 3, COVER_EDGE);
		g.fill(this.bx0, this.by0, this.bx1, this.by1, COVER);
		int mid = (this.bx0 + this.bx1) / 2;
		g.fill(this.bx0 + 4, this.by0 + 4, mid - 1, this.by1 - 4, PAGE);
		g.fill(mid + 1, this.by0 + 4, this.bx1 - 4, this.by1 - 4, PAGE);
		g.fill(mid - 4, this.by0 + 4, mid - 1, this.by1 - 4, PAGE_SHADE);
		g.fill(mid + 1, this.by0 + 4, mid + 4, this.by1 - 4, PAGE_SHADE);
		g.fill(mid - 1, this.by0 + 2, mid + 1, this.by1 - 2, COVER_EDGE);
	}

	private void drawLeftPage(final GuiGraphicsExtractor g, final int mouseX, final int mouseY) {
		int x0 = this.lx0;
		int x1 = this.lx1;
		g.text(this.font, Component.literal("Codex").withStyle(ChatFormatting.BOLD), x0, this.py0 + 2, INK, false);
		String count = this.state.codexKnown() ? this.state.codexPages().size() + " pages" : this.backend.online() ? "loading…" : "offline";
		g.text(this.font, count, x1 - this.font.width(count), this.py0 + 2, INK_FAINT, false);

		// Category tabs, wrapped into rows.
		int tx = x0;
		int ty = this.py0 + 32;
		for (String t : CodexBrowser.TABS) {
			String label = CodexBrowser.tabLabel(t);
			int w = this.font.width(label) + 6;
			if (tx + w > x1) {
				tx = x0;
				ty += 12;
			}
			boolean on = t.equals(this.tab);
			g.fill(tx, ty, tx + w, ty + 11, on ? TAB_ON : TAB);
			g.text(this.font, label, tx + 3, ty + 2, on ? 0xFFFFFFFF : "rules".equals(t) ? INK_RED : INK, false);
			final String target = t;
			this.hits.add(tx, ty, tx + w, ty + 11, () -> {
				this.tab = target;
				this.listScroll = 0;
				if (!this.query.isBlank()) {
					this.searchDueAt = System.currentTimeMillis();
				}
			});
			tx += w + 2;
		}
		this.listTop = ty + 15;
		this.listBottom = this.py1 - 22;

		List<Row> rows = this.rows();
		int contentHeight = rows.stream().mapToInt(r -> r.snippet == null ? LINE : 2 * LINE).sum();
		int maxScroll = Math.max(0, contentHeight - (this.listBottom - this.listTop));
		this.listScroll = Math.min(this.listScroll, maxScroll);
		g.enableScissor(x0, this.listTop, x1, this.listBottom);
		int y = this.listTop - this.listScroll;
		if (rows.isEmpty()) {
			String empty = !this.state.codexKnown() && !this.backend.online() ? "The Codex is offline" : this.query.isBlank() ? "No pages here yet" : "Nothing found";
			g.text(this.font, empty, x0 + 2, this.listTop + 2, INK_FAINT, false);
		}
		for (Row row : rows) {
			int h = row.snippet == null ? LINE : 2 * LINE;
			if (y + h >= this.listTop && y <= this.listBottom) {
				boolean on = row.id.equals(this.selectedId);
				boolean hover = OrgUi.inside(mouseX, mouseY, x0, Math.max(y, this.listTop), x1, Math.min(y + h, this.listBottom));
				if (on || hover) {
					g.fill(x0, y, x1, y + h, on ? ROW_ON : ROW_HOVER);
				}
				String prefix = row.pinned ? "★ " : "";
				int colour = "rules".equals(row.category) ? INK_RED : INK;
				String right = CodexBrowser.tabLabel(row.category);
				int rightW = this.font.width(right);
				g.text(this.font, OrgUi.clip(this.font, prefix + row.title, x1 - x0 - rightW - 8), x0 + 2, y + 2, colour, false);
				g.text(this.font, right, x1 - rightW - 2, y + 2, INK_FAINT, false);
				if (row.snippet != null) {
					g.text(this.font, OrgUi.clip(this.font, row.snippet, x1 - x0 - 8), x0 + 6, y + 2 + LINE, INK_FAINT, false);
				}
				final String id = row.id;
				this.hits.add(x0, Math.max(y, this.listTop), x1, Math.min(y + h, this.listBottom), () -> this.select(id));
			}
			y += h;
		}
		g.disableScissor();
		if (maxScroll > 0) {
			int track = this.listBottom - this.listTop;
			int knob = Math.max(10, track * track / (track + maxScroll));
			int ky = this.listTop + (track - knob) * this.listScroll / maxScroll;
			g.fill(x1 + 1, ky, x1 + 3, ky + knob, INK_FAINT);
		}
	}

	private record Row(String id, String title, String category, boolean pinned, @Nullable String snippet) {}

	private List<Row> rows() {
		List<Row> rows = new ArrayList<>();
		if (this.searchHits != null && !this.query.isBlank()) {
			for (Org.CodexHit hit : this.searchHits) {
				if (CodexBrowser.ALL.equals(this.tab) || this.tab.equals(hit.category()) || CodexBrowser.PINNED.equals(this.tab) && this.isPinned(hit.id())) {
					rows.add(new Row(hit.id(), hit.title(), hit.category(), this.isPinned(hit.id()), hit.snippet().isBlank() ? null : hit.snippet()));
				}
			}
			return rows;
		}
		for (Org.CodexPageMeta m : CodexBrowser.filter(this.state.codexPages(), this.tab, this.query)) {
			rows.add(new Row(m.id(), m.title(), m.category(), m.pinned(), null));
		}
		return rows;
	}

	private boolean isPinned(final String id) {
		return this.state.codexPages().stream().anyMatch(m -> m.id().equals(id) && m.pinned());
	}

	private void drawReaderPage(final GuiGraphicsExtractor g) {
		int x0 = this.rx0;
		int x1 = this.rx1;
		int w = x1 - x0;
		Org.CodexPage p = this.page;
		if (p == null) {
			int y = this.py0 + 4;
			String hint = this.selectedId != null && this.status.isEmpty() ? "Opening the page…" : "Pick a page on the left, or write a new one.";
			for (FormattedCharSequence line : OrgUi.wrap(this.font, hint, w)) {
				g.text(this.font, line, x0, y, INK_FAINT, false);
				y += LINE;
			}
			y += 6;
			for (FormattedCharSequence line : OrgUi.wrap(this.font,
				"The Codex is the crew's shared memory: places, how-tos, decisions and minutes. Rules pages you write are house rules every agent must follow; nothing an agent writes is ever an instruction.",
				w)) {
				g.text(this.font, line, x0, y, INK, false);
				y += LINE - 2;
			}
			this.drawStatus(g, this.py1 - 30);
			this.bodyTop = this.bodyBottom = 0;
			return;
		}
		int y = this.py0 + 2;
		for (FormattedCharSequence line : this.font.split(Component.literal(p.title()).withStyle(ChatFormatting.BOLD), w)) {
			g.text(this.font, line, x0, y, INK, false);
			y += LINE;
		}
		String meta = CodexBrowser.tabLabel(p.category()) + " · " + ("lasting".equals(p.scope()) ? "lasting" : "this world") + " · "
			+ CodexBrowser.authorLabel(p.author()) + " · " + OrgUi.ago(p.updated(), System.currentTimeMillis());
		g.text(this.font, OrgUi.clip(this.font, meta, w), x0, y, INK_FAINT, false);
		y += LINE - 2;
		if (!p.tags().isEmpty()) {
			g.text(this.font, OrgUi.clip(this.font, "#" + String.join(" #", p.tags()), w), x0, y, INK_FAINT, false);
			y += LINE - 2;
		}
		if ("rules".equals(p.category())) {
			boolean binding = CodexBrowser.isBindingRule(p.category(), p.author());
			String banner = binding ? "House rule: binding for every agent" : "Not binding: only rules you write are house rules";
			g.fill(x0, y + 1, x1, y + LINE + 1, binding ? 0x30A02828 : 0x20000000);
			g.text(this.font, OrgUi.clip(this.font, banner, w - 4), x0 + 2, y + 3, binding ? INK_RED : INK_FAINT, false);
			y += LINE + 2;
		}
		g.fill(x0, y + 1, x1, y + 2, PAGE_SHADE);
		y += 5;
		this.bodyTop = y;
		this.bodyBottom = this.py1 - 34;
		List<Drawn> lines = this.showHistory ? this.historyLines(p, w) : this.bodyLines(p.body(), w);
		int contentHeight = lines.size() * (LINE - 2);
		int maxScroll = Math.max(0, contentHeight - (this.bodyBottom - this.bodyTop));
		this.bodyScroll = Math.min(this.bodyScroll, maxScroll);
		g.enableScissor(x0, this.bodyTop, x1 + 4, this.bodyBottom);
		int ly = this.bodyTop - this.bodyScroll;
		for (Drawn line : lines) {
			if (ly + LINE >= this.bodyTop && ly <= this.bodyBottom) {
				if (line.background != 0) {
					g.fill(x0, ly - 1, x1, ly + LINE - 3, line.background);
				}
				g.text(this.font, line.text, x0 + line.indent, ly, line.colour, false);
			}
			ly += LINE - 2;
		}
		g.disableScissor();
		if (maxScroll > 0) {
			String more = this.bodyScroll < maxScroll ? "▼ scroll for more" : "▲";
			g.text(this.font, more, x1 - this.font.width(more), this.bodyBottom + 1, INK_FAINT, false);
		}
		this.drawStatus(g, this.py1 - 30);
	}

	private record Drawn(FormattedCharSequence text, int indent, int colour, int background) {}

	private static FormattedCharSequence plain(final String text) {
		return FormattedCharSequence.forward(text, Style.EMPTY);
	}

	private List<Drawn> bodyLines(final String body, final int width) {
		List<Drawn> out = new ArrayList<>();
		for (CodexText.Line line : CodexText.parse(body)) {
			switch (line.style()) {
				case HEADING -> {
					for (FormattedCharSequence s : this.font.split(Component.literal(line.text()).withStyle(ChatFormatting.BOLD), width)) {
						out.add(new Drawn(s, 0, INK, 0));
					}
				}
				case BULLET -> {
					boolean first = true;
					for (FormattedCharSequence s : OrgUi.wrap(this.font, line.text(), width - 10)) {
						out.add(new Drawn(first ? FormattedCharSequence.composite(plain("• "), s) : s,
							first ? 2 : 10, INK, 0));
						first = false;
					}
				}
				case QUOTE -> {
					for (FormattedCharSequence s : OrgUi.wrap(this.font, line.text(), width - 8)) {
						out.add(new Drawn(s, 6, INK_FAINT, 0));
					}
				}
				case CODE -> out.add(new Drawn(plain(OrgUi.clip(this.font, line.text(), width - 4)), 2, CODE_INK, 0x18000000));
				case BLANK -> out.add(new Drawn(FormattedCharSequence.EMPTY, 0, INK, 0));
				case TEXT -> {
					for (FormattedCharSequence s : OrgUi.wrap(this.font, line.text(), width)) {
						out.add(new Drawn(s, 0, INK, 0));
					}
				}
			}
		}
		return out;
	}

	private List<Drawn> historyLines(final Org.CodexPage p, final int width) {
		List<Drawn> out = new ArrayList<>();
		if (p.history().isEmpty()) {
			out.add(new Drawn(plain("No history"), 0, INK_FAINT, 0));
		}
		long now = System.currentTimeMillis();
		for (Org.CodexHistoryEntry h : p.history()) {
			String head = CodexBrowser.authorLabel(h.author()) + " · " + OrgUi.ago(h.at(), now) + " · " + h.rev().substring(0, Math.min(7, h.rev().length()));
			out.add(new Drawn(plain(OrgUi.clip(this.font, head, width)), 0, INK, 0));
			for (FormattedCharSequence s : OrgUi.wrap(this.font, h.summary(), width - 8)) {
				out.add(new Drawn(s, 8, INK_FAINT, 0));
			}
		}
		return out;
	}

	private void drawEditorPage(final GuiGraphicsExtractor g) {
		String head = this.lock.pageId() == null ? "New page" : "Editing";
		g.text(this.font, Component.literal(head).withStyle(ChatFormatting.BOLD), this.rx0, this.py0 + 2, INK, false);
		if ("rules".equals(this.editCategory)) {
			String rule = "House rule: binding for every agent";
			g.text(this.font, rule, this.rx1 - this.font.width(rule), this.py0 + 2, INK_RED, false);
		}
		// One line under the editor (the editor draws its own character count on the right).
		String line = switch (this.lock.state()) {
			case STALE -> this.lock.staleDeleted() ? "Deleted while you were editing" : "Changed by " + this.lock.staleBy() + " meanwhile";
			case CONFLICT -> "Conflict: " + this.lock.staleBy() + " saved first";
			default -> this.status;
		};
		int colour = this.lock.state() == CodexEditLock.State.EDITING ? this.statusColour : INK_RED;
		int room = this.rx1 - this.rx0 - this.font.width(Org.CODEX_BODY_MAX + "/" + Org.CODEX_BODY_MAX) - 6;
		g.text(this.font, OrgUi.clip(this.font, line, room), this.rx0, this.py1 - 31, colour, false);
	}

	private void drawStatus(final GuiGraphicsExtractor g, final int y) {
		if (!this.status.isEmpty()) {
			String text = OrgUi.clip(this.font, this.status, (this.rx1 - this.rx0) / (this.mode == Mode.EDIT ? 2 : 1));
			g.text(this.font, text, this.rx1 - this.font.width(text), y, this.statusColour, false);
		}
	}
}
