package dev.minevibe.client.ui.screen;

import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.client.chat.ChatInterceptor;
import dev.minevibe.client.ui.AgentEntities;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.FrontCards;
import dev.minevibe.client.ui.Transcript;
import dev.minevibe.client.ui.UiActions;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.util.FormattedCharSequence;
import net.minecraft.world.entity.player.Player;
import org.jspecify.annotations.Nullable;

/**
 * AgentScreen (PLAN §7.8): one agent's chat, opened by right-clicking its body or with G.
 *
 * <ul>
 *   <li><b>Transcript</b> (left): the agent's lines, the player's lines, activity and card notes. Older pages are
 *       fetched with {@code chat.history} ("Load older", or scrolling to the top).</li>
 *   <li><b>Card</b> (right, when the agent waits for the player): the front card first. Questions: option buttons
 *       (single select), toggles plus Submit (multi select), and a free-text answer. Plans: Approve / Revise (with
 *       feedback). Hires: Hire / Decline. Calendar approvals: Approve / Decline. Every card has Later.</li>
 *   <li><b>Message box</b> (bottom): Reply, New task, Interrupt ({@code chat.send} to this agent with that mode;
 *       Interrupt with an empty box just interrupts).</li>
 *   <li><b>Commands</b> (top): Follow, Stay, Stop, Kick (seated agents, with a confirmation), Plan-first, Dismiss
 *       (with a confirmation).</li>
 * </ul>
 * The game keeps running underneath (non-pausing). Text and the transcript are drawn from {@link UiState} every
 * frame; the widgets are rebuilt only when what they show changes (another card or question, the Plan-first toggle,
 * Kick appearing), so pushes about other agents never take the focus or the cursor out of a box being typed in. The
 * card on show stays the same card across pushes until it is resolved, so picks and drafts always go to the card they
 * were made for.
 */
public final class AgentScreen extends Screen {
	private static final int PAD = 8;
	private static final int ROW = 14;
	private static final int HISTORY_PAGE = 50;

	private final String agentId;
	/** The card on show (null: the front card). */
	private @Nullable String shownCardId;
	/** Card id and question index the picks and the card draft belong to. */
	private @Nullable String draftCardKey;
	/** What the current widgets were built for ({@link #layoutKey()}). */
	private String builtKey = "";
	/** The first history page was asked for (once per screen: a failure must not turn into a request loop). */
	private boolean historyRequested;
	/** Keep the focus in the card's text box across a rebuild. */
	private boolean focusCardBox;
	private final TreeSet<Integer> multiPicks = new TreeSet<>();
	private int transcriptScroll;
	private int cardScroll;
	private boolean loadingHistory;
	private String status = "";
	private int statusColor = 0xFFB0B0B0;
	private String messageDraft = "";
	private String cardDraft = "";
	private @Nullable EditBox message;
	private @Nullable EditBox cardText;

	// Layout, recomputed in init().
	private int split;
	private int contentTop;
	private int contentBottom;
	private int cardWidgetsTop;
	private @Nullable List<Line> lineCache;
	private long lineCacheRevision = -1;
	private int lineCacheWidth = -1;

	private record Line(FormattedCharSequence text, int color) {}

	public AgentScreen(String agentId, @Nullable String focusCardId) {
		super(Component.literal("Agent"));
		this.agentId = agentId;
		this.shownCardId = focusCardId;
	}

	public String agentId() {
		return agentId;
	}

	private @Nullable AgentView agent() {
		return UiState.get().agent(agentId);
	}

	/** The agent's cards with the front card first, then the rest oldest first. */
	List<Ui.PendingCard> orderedCards() {
		AgentView a = agent();
		if (a == null) return List.of();
		Ui.PendingCard front = a.frontCard();
		List<Ui.PendingCard> out = new ArrayList<>();
		if (front != null) out.add(front);
		a.cards().stream()
				.filter(c -> c != front && !FrontCards.complete(c))
				.sorted(Comparator.comparingLong(Ui.PendingCard::createdAt))
				.forEach(out::add);
		return out;
	}

	/**
	 * The card on show: the same card as before while it is pending (pushes may reorder the cards), else the front card.
	 * When the card or its current question changes, the picks and the card draft are dropped: they were made for the
	 * previous one.
	 */
	Ui.@Nullable PendingCard shownCard() {
		List<Ui.PendingCard> cards = orderedCards();
		Ui.PendingCard card = cards.isEmpty() ? null : cards.get(Math.max(0, indexOf(cards, shownCardId)));
		shownCardId = card == null ? null : card.id();
		String key = card == null ? null : card.id() + "#" + FrontCards.questionIndex(card);
		if (draftCardKey != null && !draftCardKey.equals(key)) {
			multiPicks.clear();
			cardDraft = "";
			if (cardText != null) cardText.setValue("");
		}
		draftCardKey = key;
		return card;
	}

	private static int indexOf(List<Ui.PendingCard> cards, @Nullable String id) {
		if (id == null) return -1;
		for (int i = 0; i < cards.size(); i++) {
			if (cards.get(i).id().equals(id)) return i;
		}
		return -1;
	}

	/** The position (0-based) of the card on show among the agent's cards. */
	private int shownIndex(List<Ui.PendingCard> cards) {
		return Math.max(0, indexOf(cards, shownCardId));
	}

	/**
	 * Everything the widgets depend on. Another agent's push, a bubble or a toast leaves it unchanged, so the screen
	 * does not rebuild (and the box being typed in keeps its focus and cursor).
	 */
	String layoutKey() {
		AgentView a = agent();
		Ui.PendingCard card = shownCard();
		Transcript t = UiState.get().transcript(agentId);
		Player body = minecraft != null && minecraft.level != null && a != null ? AgentEntities.body(minecraft.level, a) : null;
		return (a == null ? "?" : a.name() + "|" + a.planFirst())
				+ "|" + (body != null && AgentEntities.onPcSeat(body))
				+ "|" + (card == null ? "-" : card.id() + "#" + FrontCards.questionIndex(card) + "#" + card.parked())
				+ "|" + orderedCards().size()
				+ "|" + (t.moreOlder() && t.historyLoaded())
				+ "|" + multiPicks;
	}

	@Override
	protected void init() {
		AgentView a = agent();
		Ui.PendingCard card = shownCard();
		split = card != null ? (int) (width * 0.56) : width - PAD;
		contentTop = 38;
		contentBottom = height - 36;

		// Commands.
		int x = PAD;
		int y = 20;
		x = commandButton(x, y, "Follow", "follow");
		x = commandButton(x, y, "Stay", "stay");
		x = commandButton(x, y, "Stop", "stop");
		Player body = minecraft.level != null && a != null ? AgentEntities.body(minecraft.level, a) : null;
		if (body != null && AgentEntities.onPcSeat(body)) {
			x = button(x, y, 34, "Kick", b -> confirmKick());
		}
		boolean planFirst = a != null && a.planFirst();
		x = button(x, y, 76, "Plan-first: " + (planFirst ? "on" : "off"), b -> command("plan_first", !planFirst));
		button(x, y, 46, "Dismiss", b -> confirmDismiss());

		// Message box and send buttons.
		int buttonW = 52;
		int boxW = width - 2 * PAD - 3 * (buttonW + 2);
		message = new EditBox(font, PAD, height - 22, boxW, 16, Component.literal("Message"));
		message.setMaxLength(Ui.CHAT_MAX_LENGTH);
		message.setHint(Component.literal(a != null ? "Message " + a.name() + "…" : "Message…").withStyle(ChatFormatting.DARK_GRAY));
		message.setValue(messageDraft);
		message.setResponder(v -> messageDraft = v);
		addRenderableWidget(message);
		int bx = PAD + boxW + 2;
		addRenderableWidget(Button.builder(Component.literal("Reply"), b -> send("reply")).bounds(bx, height - 23, buttonW, 18).build());
		addRenderableWidget(Button.builder(Component.literal("New task"), b -> send("task")).bounds(bx + buttonW + 2, height - 23, buttonW, 18).build());
		addRenderableWidget(Button.builder(Component.literal("Interrupt"), b -> send("interrupt"))
				.bounds(bx + 2 * (buttonW + 2), height - 23, buttonW, 18)
				.build());

		// Older transcript lines.
		Transcript transcript = UiState.get().transcript(agentId);
		if (transcript.moreOlder() && transcript.historyLoaded()) {
			addRenderableWidget(Button.builder(Component.literal("Load older"), b -> loadOlder())
					.bounds(PAD, contentTop, 70, 12)
					.build());
		}

		cardText = null;
		if (card != null) initCard(card);
		builtKey = layoutKey();
		requestHistoryOnce();
	}

	/** Asks for the newest history page once per screen, as soon as MineVibe is connected. */
	private void requestHistoryOnce() {
		if (historyRequested || UiState.get().transcript(agentId).historyLoaded() || !UiTransport.current().connected()) return;
		historyRequested = true;
		loadHistory(null);
	}

	/** The message box, or the card's text box when that one had the focus before a rebuild. */
	@Override
	protected void setInitialFocus() {
		EditBox box = focusCardBox && cardText != null ? cardText : message;
		focusCardBox = false;
		if (box != null) setInitialFocus(box);
	}

	private int commandButton(int x, int y, String label, String cmd) {
		return button(x, y, font.width(label) + 12, label, b -> command(cmd, null));
	}

	private int button(int x, int y, int w, String label, Button.OnPress onPress) {
		addRenderableWidget(Button.builder(Component.literal(label), onPress).bounds(x, y, w, ROW).build());
		return x + w + 2;
	}

	private void initCard(Ui.PendingCard card) {
		int px = split + 4;
		int pw = width - PAD - px;
		int y;
		// Bottom-up: the last row (Later, paging) sits at contentBottom.
		int bottom = contentBottom;
		List<Ui.PendingCard> cards = orderedCards();
		int laterY = bottom - ROW;
		int lx = px;
		lx = button(lx, laterY, 44, "Later", b -> answer(card, new Ui.CardAnswer("later", null, null, null)));
		if (cards.size() > 1) {
			lx = button(lx, laterY, 16, "◀", b -> pageCard(-1));
			lx = button(lx + font.width(cards.size() + "/" + cards.size()) + 6, laterY, 16, "▶", b -> pageCard(1));
		}
		y = laterY - ROW - 2;
		switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> {
				Ui.CardQuestion q = FrontCards.currentQuestion(card);
				// Free text.
				cardText = textBox(px, y, pw - 50, "Or type an answer…");
				button(px + pw - 48, y, 48, "Answer", b -> {
					String t = cardDraft.trim();
					if (!t.isEmpty()) answer(card, Ui.CardAnswer.text(t));
				});
				y -= ROW + 2;
				if (q != null) {
					if (q.multiSelect()) {
						button(px, y, pw, "Submit " + (multiPicks.isEmpty() ? "(pick options)" : multiPicks), b -> {
							if (!multiPicks.isEmpty()) answer(card, Ui.CardAnswer.options(List.copyOf(multiPicks)));
						});
						y -= ROW + 2;
					}
					int n = q.options().size();
					int cols = n > 4 ? 2 : 1;
					int rowsNeeded = (n + cols - 1) / cols;
					int ow = (pw - (cols - 1) * 2) / cols;
					int top = y - (rowsNeeded - 1) * (ROW + 2);
					for (int i = 0; i < n; i++) {
						int opt = i + 1;
						String label = opt + " " + q.options().get(i).label();
						if (q.multiSelect()) label = (multiPicks.contains(opt) ? "☑ " : "☐ ") + label;
						int ox = px + (i % cols) * (ow + 2);
						int oy = top + (i / cols) * (ROW + 2);
						Button b = Button.builder(Component.literal(clipTo(label, ow - 8)), btn -> pick(card, q, opt)).bounds(ox, oy, ow, ROW).build();
						if (q.options().get(i).description() != null) {
							b.setTooltip(net.minecraft.client.gui.components.Tooltip.create(Component.literal(q.options().get(i).description())));
						}
						addRenderableWidget(b);
					}
					y = top - 2;
				}
			}
			case Ui.PendingCard.PLAN -> {
				int bw = (pw - 2) / 2;
				button(px, y, bw, "Approve", b -> decidePlan(card, true));
				button(px + bw + 2, y, bw, "Revise", b -> decidePlan(card, false));
				y -= ROW + 2;
				cardText = textBox(px, y, pw, "What should change?");
				y -= 2;
			}
			case Ui.PendingCard.HIRE -> {
				int bw = (pw - 2) / 2;
				button(px, y, bw, "Hire " + card.name(), b -> decideHire(card, true));
				button(px + bw + 2, y, bw, "Decline", b -> decideHire(card, false));
				y -= ROW + 2;
				cardText = textBox(px, y, pw, "Note (optional)…", UiActions.NOTE_MAX_LENGTH);
				y -= 2;
			}
			case Ui.PendingCard.CALENDAR -> {
				int bw = (pw - 2) / 2;
				button(px, y, bw, "Approve", b -> answer(card, new Ui.CardAnswer("approve", null, null, null)));
				button(px + bw + 2, y, bw, "Decline", b -> answer(card, new Ui.CardAnswer("decline", null, null, UiActions.note(cardDraft))));
				y -= ROW + 2;
				cardText = textBox(px, y, pw, "Note (optional)…", UiActions.NOTE_MAX_LENGTH);
				y -= 2;
			}
			default -> {
			}
		}
		cardWidgetsTop = y;
	}

	private EditBox textBox(int x, int y, int w, String hint) {
		return textBox(x, y, w, hint, Ui.CHAT_MAX_LENGTH);
	}

	private EditBox textBox(int x, int y, int w, String hint, int maxLength) {
		EditBox box = new EditBox(font, x, y, w, ROW, Component.literal(hint));
		box.setMaxLength(maxLength);
		box.setHint(Component.literal(hint).withStyle(ChatFormatting.DARK_GRAY));
		box.setValue(cardDraft);
		box.setResponder(v -> cardDraft = v);
		addRenderableWidget(box);
		return box;
	}

	private String clipTo(String text, int px) {
		return font.width(text) <= px ? text : font.plainSubstrByWidth(text, px - font.width("…")) + "…";
	}

	// ---------------------------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------------------------

	private void pick(Ui.PendingCard card, Ui.CardQuestion q, int option) {
		if (q.multiSelect()) {
			if (!multiPicks.remove(option)) multiPicks.add(option);
			rebuild();
			return;
		}
		answer(card, Ui.CardAnswer.options(List.of(option)));
	}

	private void pageCard(int delta) {
		List<Ui.PendingCard> cards = orderedCards();
		if (cards.isEmpty()) return;
		shownCardId = cards.get(Math.floorMod(shownIndex(cards) + delta, cards.size())).id();
		rebuild();
	}

	private void answer(Ui.PendingCard card, Ui.CardAnswer answer) {
		track(UiActions.answer(agentId, card.id(), answer), true);
	}

	private void decidePlan(Ui.PendingCard card, boolean approve) {
		String feedback = cardDraft.trim();
		if (!approve && feedback.isEmpty()) {
			setStatus("Type what should change, then press Revise", 0xFFFFB13B);
			return;
		}
		track(UiActions.plan(agentId, card.id(), approve, approve ? null : feedback), true);
	}

	private void decideHire(Ui.PendingCard card, boolean approve) {
		track(UiActions.hire(card.id(), approve, approve ? null : cardDraft), true);
	}

	private void command(String cmd, @Nullable Boolean on) {
		track(UiActions.command(agentId, cmd, on, null), false);
	}

	private void send(String mode) {
		String text = messageDraft.trim();
		if (text.isEmpty()) {
			if ("interrupt".equals(mode)) command("interrupt", null);
			else setStatus("Type a message first", 0xFFFFB13B);
			return;
		}
		CompletableFuture<String> f = UiActions.chatTo(agentId, text, mode);
		setStatus("Sending…", 0xFFB0B0B0);
		f.whenComplete((echo, err) -> {
			if (err == null) {
				messageDraft = "";
				if (message != null) message.setValue("");
				setStatus(echo, 0xFF8FE39A);
				if (!echo.isEmpty()) ChatInterceptor.echo(echo);
			} else {
				setStatus(UiActions.errorText(err), 0xFFFF6B6B);
			}
		});
	}

	private void track(CompletableFuture<String> future, boolean clearCard) {
		setStatus("Sending…", 0xFFB0B0B0);
		future.whenComplete((echo, err) -> {
			if (err == null) {
				if (clearCard) {
					cardDraft = "";
					multiPicks.clear();
				}
				setStatus(echo.isEmpty() ? "Done" : echo, 0xFF8FE39A);
				if (clearCard && !echo.isEmpty()) ChatInterceptor.echo(echo);
			} else {
				setStatus(UiActions.errorText(err), 0xFFFF6B6B);
			}
			rebuild();
		});
	}

	private void confirmKick() {
		AgentView a = agent();
		String name = a != null ? a.name() : agentId;
		minecraft.gui.setScreen(new ConfirmScreen(
				yes -> {
					if (yes) command("kick", null);
					minecraft.gui.setScreen(this);
				},
				Component.literal("Kick " + name + " off the PC?"),
				Component.literal(name + " stands up and stops what it is doing at the PC.")));
	}

	private void confirmDismiss() {
		AgentView a = agent();
		String name = a != null ? a.name() : agentId;
		minecraft.gui.setScreen(new ConfirmScreen(
				yes -> {
					if (yes) {
						command("dismiss", null);
						minecraft.gui.setScreen(null);
					} else {
						minecraft.gui.setScreen(this);
					}
				},
				Component.literal("Dismiss " + name + "?"),
				Component.literal(name + " leaves the crew for good.")));
	}

	private void loadHistory(@Nullable Long beforeSeq) {
		if (!UiTransport.current().connected()) return;
		loadingHistory = true;
		UiActions.history(agentId, beforeSeq, HISTORY_PAGE).whenComplete((page, err) -> {
			loadingHistory = false;
			if (err != null) setStatus("History: " + UiActions.errorText(err), 0xFFFF6B6B);
			rebuild();
		});
	}

	private void loadOlder() {
		Transcript transcript = UiState.get().transcript(agentId);
		Long oldest = transcript.oldestSeq();
		if (oldest != null && transcript.moreOlder() && !loadingHistory) loadHistory(oldest);
	}

	private void setStatus(String text, int color) {
		status = text;
		statusColor = color;
	}

	private void rebuild() {
		if (minecraft.gui.screen() != this) return;
		focusCardBox = cardText != null && cardText.isFocused();
		rebuildWidgets();
	}

	// ---------------------------------------------------------------------------------------------
	// Screen
	// ---------------------------------------------------------------------------------------------

	@Override
	public void tick() {
		if (!layoutKey().equals(builtKey)) rebuild();
		requestHistoryOnce();
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (event.isConfirmation()) {
			if (message != null && message.isFocused()) {
				send("reply");
				return true;
			}
			if (cardText != null && cardText.isFocused()) {
				Ui.PendingCard card = shownCard();
				if (card != null && Ui.PendingCard.QUESTION.equals(card.kind()) && !cardDraft.isBlank()) {
					answer(card, Ui.CardAnswer.text(cardDraft.trim()));
					return true;
				}
			}
		}
		return super.keyPressed(event);
	}

	@Override
	public boolean mouseScrolled(double x, double y, double scrollX, double scrollY) {
		if (x < split) {
			transcriptScroll = Math.max(0, transcriptScroll + (int) Math.signum(scrollY) * 3);
			if (transcriptScroll > 0 && scrollY > 0 && atTranscriptTop()) loadOlder();
		} else {
			cardScroll = Math.max(0, cardScroll - (int) Math.signum(scrollY) * 2);
		}
		return true;
	}

	private boolean atTranscriptTop() {
		List<Line> lines = transcriptLines(split - PAD - 4);
		int visible = Math.max(1, (contentBottom - transcriptTop()) / 10);
		return transcriptScroll >= Math.max(0, lines.size() - visible);
	}

	private int transcriptTop() {
		Transcript t = UiState.get().transcript(agentId);
		return contentTop + (t.moreOlder() && t.historyLoaded() ? 14 : 0);
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		AgentView agent = agent();
		// Header.
		String title = agent == null ? agentId + " (unknown)" : agent.title() + " " + agent.modelSuffix();
		g.text(font, title, PAD, 6, 0xFFFFFFFF, true);
		String state = headerState(agent);
		g.text(font, state, width - PAD - font.width(state), 6, 0xFFB0B0B0, true);

		// Transcript.
		int tTop = transcriptTop();
		g.fill(PAD - 2, contentTop - 2, split - 2, contentBottom + 2, 0x70000000);
		List<Line> lines = transcriptLines(split - PAD - 4);
		int visible = Math.max(1, (contentBottom - tTop) / 10);
		transcriptScroll = Math.min(transcriptScroll, Math.max(0, lines.size() - visible));
		int end = lines.size() - transcriptScroll;
		int start = Math.max(0, end - visible);
		int y = contentBottom - (end - start) * 10;
		if (lines.isEmpty()) {
			String empty = loadingHistory ? "Loading…" : UiTransport.current().connected() ? "No messages yet." : "MineVibe is offline.";
			g.text(font, empty, PAD + 2, tTop + 2, 0xFF808080, false);
		}
		for (int i = start; i < end; i++) {
			Line line = lines.get(i);
			g.text(font, line.text(), PAD + 2, y, line.color(), false);
			y += 10;
		}

		// Card.
		Ui.PendingCard card = shownCard();
		if (card != null) {
			int px = split + 2;
			g.fill(px - 2, contentTop - 2, width - PAD + 2, contentBottom + 2, 0x90201810);
			List<Ui.PendingCard> cards = orderedCards();
			int cardIndex = shownIndex(cards);
			String head = cardHeading(card) + (cards.size() > 1 ? "  (" + (cardIndex + 1) + "/" + cards.size() + ")" : "");
			g.text(font, head, px + 2, contentTop, 0xFFFFD84A, true);
			List<FormattedCharSequence> body = font.split(Component.literal(cardBody(card)), width - PAD - px - 6);
			int maxLines = Math.max(1, (cardWidgetsTop - contentTop - 14) / 10);
			cardScroll = Math.min(cardScroll, Math.max(0, body.size() - maxLines));
			int by = contentTop + 13;
			for (int i = cardScroll; i < Math.min(body.size(), cardScroll + maxLines); i++) {
				g.text(font, body.get(i), px + 2, by, 0xFFFFF4C2, false);
				by += 10;
			}
			if (cards.size() > 1) {
				String page = (cardIndex + 1) + "/" + cards.size();
				g.text(font, page, px + 2 + 44 + 2 + 16 + 4, contentBottom - ROW + 3, 0xFFFFFFFF, false);
			}
		}

		// Status line.
		if (!status.isEmpty()) {
			String s = font.plainSubstrByWidth(status, width - 2 * PAD);
			g.text(font, s, PAD, height - 33, statusColor, true);
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}

	private String headerState(@Nullable AgentView agent) {
		if (!UiTransport.current().connected()) return "MineVibe offline";
		if (agent == null) return "";
		if (!agent.alive()) return agent.status();
		String brain = switch (agent.brain()) {
			case "thinking" -> "thinking";
			case "queued" -> "waiting for a brain slot";
			case "waiting_player" -> "waiting for you";
			case "asleep" -> "out of usage (Zz)";
			case "offline" -> "brain offline";
			default -> "idle";
		};
		String activity = agent.activity();
		return activity != null ? brain + " · " + font.plainSubstrByWidth(activity, width / 3) : brain;
	}

	private static String cardHeading(Ui.PendingCard card) {
		return switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> {
				Ui.CardQuestion q = FrontCards.currentQuestion(card);
				String chip = q != null && q.header() != null ? " · " + q.header() : "";
				String progress = card.questions() != null && card.questions().size() > 1 ? " " + FrontCards.progress(card) : "";
				yield "Question" + progress + chip + (card.parked() ? " (parked)" : "");
			}
			case Ui.PendingCard.PLAN -> "Plan" + (card.parked() ? " (parked)" : "");
			case Ui.PendingCard.HIRE -> "Hire request";
			case Ui.PendingCard.CALENDAR -> "Calendar approval";
			default -> card.kind();
		};
	}

	private static String cardBody(Ui.PendingCard card) {
		return switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> {
				Ui.CardQuestion q = FrontCards.currentQuestion(card);
				String text = q == null ? "" : q.question();
				if (q != null && q.multiSelect()) text += "\n(pick one or more, then Submit)";
				yield text;
			}
			case Ui.PendingCard.PLAN -> card.plan() == null ? "" : card.plan();
			case Ui.PendingCard.HIRE -> card.name() + " (" + card.role() + ", @" + card.handle() + ")\n\nWhy: " + card.reason()
					+ "\n\nFirst task: " + card.firstTask();
			case Ui.PendingCard.CALENDAR -> card.summary() == null ? "" : card.summary();
			default -> "";
		};
	}

	private List<Line> transcriptLines(int widthPx) {
		long revision = UiState.get().revision();
		if (lineCache != null && lineCacheRevision == revision && lineCacheWidth == widthPx) return lineCache;
		List<Line> out = new ArrayList<>();
		AgentView agent = agent();
		String name = agent != null ? agent.name() : agentId;
		for (Ui.ChatEntry e : UiState.get().transcript(agentId).entries()) {
			String prefix;
			int color;
			switch (e.kind()) {
				case "player" -> {
					prefix = "You: ";
					color = 0xFF9AD0FF;
				}
				case "agent" -> {
					prefix = name + ": ";
					color = 0xFFFFFFFF;
				}
				case "activity" -> {
					prefix = "· ";
					color = 0xFF909090;
				}
				case "card" -> {
					prefix = "? ";
					color = 0xFFFFD84A;
				}
				case "answer" -> {
					prefix = "→ ";
					color = 0xFF8FE39A;
				}
				case "tell" -> {
					prefix = (e.fromAgentId() != null ? UiState.get().nameOf(e.fromAgentId()) : "?") + " → " + name + ": ";
					color = 0xFFD7B5FF;
				}
				default -> {
					prefix = "[MineVibe] ";
					color = 0xFFB0B0B0;
				}
			}
			for (FormattedCharSequence part : font.split(Component.literal(prefix + e.text()), widthPx)) {
				out.add(new Line(part, color));
			}
		}
		lineCache = out;
		lineCacheRevision = revision;
		lineCacheWidth = widthPx;
		return out;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}
}
