package dev.minevibe.client.ui;

import dev.minevibe.bridge.msg.Ui;

/**
 * The icon above an agent's head (PLAN §7.8): ? question waiting, ! plan or hire waiting, … thinking, hourglass queued
 * for a brain slot, Zz usage exhausted or bridge offline, monitor seated. Drawn as a font glyph (no texture), colored.
 */
public enum HeadIcon {
	NONE("", 0xFFFFFFFF),
	/** A question card is waiting for the player. */
	QUESTION("?", 0xFFFFD84A),
	/** A plan, hire or calendar approval is waiting. */
	ATTENTION("!", 0xFFFF9A3C),
	THINKING("…", 0xFFFFFFFF),
	/** Waiting for a brain slot. */
	QUEUED("⌛", 0xFF9AD0FF),
	/** Out of usage, brain offline, or MineVibe (Node) unreachable. */
	ASLEEP("Zz", 0xFFB0B0C8),
	/** Seated at a PC. */
	SEATED("▣", 0xFF7FE3A0);

	private final String glyph;
	private final int color;

	HeadIcon(String glyph, int color) {
		this.glyph = glyph;
		this.color = color;
	}

	public String glyph() {
		return glyph;
	}

	/** ARGB. */
	public int color() {
		return color;
	}

	/**
	 * Picks the icon by priority: offline or asleep beats everything (nothing else is happening), then waiting cards
	 * (the player is needed), then thinking and queued, then seated.
	 *
	 * @param seatedAtPc the body rides a PC seat
	 * @param bridgeOnline MineVibe (Node) is connected
	 */
	public static HeadIcon of(AgentView agent, boolean seatedAtPc, boolean bridgeOnline) {
		if (!agent.alive()) return NONE;
		if (!bridgeOnline || "asleep".equals(agent.brain()) || "offline".equals(agent.brain())) return ASLEEP;
		boolean question = false;
		boolean other = false;
		for (Ui.PendingCard card : agent.cards()) {
			if (FrontCards.complete(card)) continue;
			if (Ui.PendingCard.QUESTION.equals(card.kind())) question = true;
			else other = true;
		}
		if (question) return QUESTION;
		if (other) return ATTENTION;
		return switch (agent.brain()) {
			case "thinking" -> THINKING;
			case "queued" -> QUEUED;
			case "waiting_player" -> QUESTION;
			default -> seatedAtPc ? SEATED : NONE;
		};
	}
}
