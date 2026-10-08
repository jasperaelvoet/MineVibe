package dev.minevibe.client.ui;

import dev.minevibe.bridge.msg.Ui;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The answer grammar's card order (PLAN §6.4), mirrored from Node's {@code answerGrammar.ts}: each agent has one
 * <b>front card</b>, the blocking question or plan first, then hires and calendar approvals, oldest first. A
 * multi-question AskUserQuestion card is asked one question at a time ("Q1/3").
 */
public final class FrontCards {
	private FrontCards() {}

	/** A question or plan blocks the agent's turn; hires and calendar approvals do not. */
	public static boolean blocking(Ui.PendingCard card) {
		return Ui.PendingCard.QUESTION.equals(card.kind()) || Ui.PendingCard.PLAN.equals(card.kind());
	}

	/** A question card whose questions are all answered is no longer answerable. */
	public static boolean complete(Ui.PendingCard card) {
		if (!Ui.PendingCard.QUESTION.equals(card.kind())) return false;
		int answered = card.answers() == null ? 0 : card.answers().size();
		int total = card.questions() == null ? 0 : card.questions().size();
		return answered >= total;
	}

	/** The front card of one agent's cards, or null. */
	public static Ui.@Nullable PendingCard front(List<Ui.PendingCard> cards) {
		Ui.PendingCard best = null;
		for (Ui.PendingCard card : cards) {
			if (complete(card)) continue;
			if (best == null) {
				best = card;
				continue;
			}
			boolean cardBlocking = blocking(card);
			if (cardBlocking != blocking(best)) {
				if (cardBlocking) best = card;
				continue;
			}
			if (card.createdAt() < best.createdAt()) best = card;
		}
		return best;
	}

	/** The question being asked on a question card (the first unanswered one), or null. */
	public static Ui.@Nullable CardQuestion currentQuestion(Ui.PendingCard card) {
		if (!Ui.PendingCard.QUESTION.equals(card.kind()) || card.questions() == null || card.questions().isEmpty()) return null;
		int index = Math.min(answered(card), card.questions().size() - 1);
		return card.questions().get(index);
	}

	/** 0-based index of the question being asked. */
	public static int questionIndex(Ui.PendingCard card) {
		int total = card.questions() == null ? 0 : card.questions().size();
		return Math.min(answered(card), Math.max(total - 1, 0));
	}

	/** "Q1/3" (empty for other kinds). */
	public static String progress(Ui.PendingCard card) {
		if (!Ui.PendingCard.QUESTION.equals(card.kind()) || card.questions() == null) return "";
		return "Q" + (questionIndex(card) + 1) + "/" + card.questions().size();
	}

	private static int answered(Ui.PendingCard card) {
		return card.answers() == null ? 0 : card.answers().size();
	}

	/** One-line description of a card for HUDs, toasts and the off-screen arrow. */
	public static String summary(Ui.PendingCard card) {
		return switch (card.kind()) {
			case Ui.PendingCard.QUESTION -> {
				Ui.CardQuestion q = currentQuestion(card);
				String text = q == null ? "Question" : q.question();
				yield card.questions() != null && card.questions().size() > 1 ? progress(card) + " " + text : text;
			}
			case Ui.PendingCard.PLAN -> "Plan ready for approval";
			case Ui.PendingCard.HIRE -> "Hire " + card.name() + " (" + card.role() + ")?";
			case Ui.PendingCard.CALENDAR -> card.summary() == null ? "Calendar approval" : card.summary();
			default -> card.kind();
		};
	}
}
