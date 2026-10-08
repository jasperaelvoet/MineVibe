package dev.minevibe.client.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.UiState;
import java.util.Collection;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The client-side pre-check uses Node's ChatRouter hint texts (apps/server/src/agents/chat). */
class MentionCheckTest {
	private UiState state;

	@BeforeEach
	void setUp() {
		state = UiState.create(() -> 0);
		state.applyCrew(new Bodies.CrewState(List.of(
				new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
				new Messages.CrewMember("abe", "abe", "Abe", "miner", false, "alive"),
				new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"),
				new Messages.CrewMember("cleo", "cleo", "Cleo", "farmer", false, "dead"))));
	}

	private Collection<AgentView> crew() {
		return state.agents();
	}

	private static Ui.CardQuestion q(boolean multi, String... labels) {
		return new Ui.CardQuestion("Pick?", null, java.util.Arrays.stream(labels).map(l -> new Ui.QuestionOption(l, null)).toList(), multi);
	}

	private void cardFor(String agentId, Ui.CardQuestion question) {
		state.applyPending(new Ui.AgentPending(agentId, List.of(new Ui.PendingCard(
				"q-" + agentId, agentId, 1, false, true, "question", List.of(question), List.of(), null, null, null, null, null, null, null, null))));
	}

	@Test
	void plainLinesAndKnownNamesPass() {
		assertNull(MentionCheck.check("good morning everyone", crew()));
		assertNull(MentionCheck.check("@ada build a house", crew()));
		assertNull(MentionCheck.check("@br hi", crew()));
		assertNull(MentionCheck.check("@ada @bram meet at the farm", crew()));
		assertNull(MentionCheck.check("@all! stop", crew()));
		assertNull(MentionCheck.check("@ceo status?", crew()));
		assertNull(MentionCheck.check("@meeting end", crew()));
		assertNull(MentionCheck.check("tell @zed later", crew()), "only leading mentions route");
	}

	@Test
	void emptyAndTooLongLines() {
		assertEquals("Type a message first", MentionCheck.check("   ", crew()));
		assertEquals("Messages are limited to 2000 characters", MentionCheck.check("x".repeat(2001), crew()));
	}

	@Test
	void malformedUnknownAmbiguousAndShortNames() {
		assertEquals("Put a space after each @name (@ada,@bram)", MentionCheck.check("@ada,@bram hi", crew()));
		assertEquals("Nobody is called @zed. Crew: @ada, @abe, @bram", MentionCheck.check("@zed hi", crew()));
		assertEquals("@a matches @all, Ada, Abe: type at least 2 letters", MentionCheck.check("@a hi", crew()));
		state.applyCrew(new Bodies.CrewState(List.of(
				new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
				new Messages.CrewMember("adam", "adamx", "Adam", "miner", false, "alive"))));
		assertEquals("@ad matches Ada, Adam", MentionCheck.check("@ad hi", crew()));
	}

	@Test
	void mixingBroadcastWithNamesAndEmptyBodies() {
		assertEquals("@all and @meeting cannot be combined with other names", MentionCheck.check("@all @ada hi", crew()));
		assertEquals("Say something after @ada", MentionCheck.check("@ada", crew()));
		assertEquals("Say something after @ada", MentionCheck.check("@ada:", crew()));
	}

	@Test
	void deadNamesAreLeftToNode() {
		assertNull(MentionCheck.check("@cleo hi", crew()));
	}

	@Test
	void noCeo() {
		state.applyCrew(new Bodies.CrewState(List.of(new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"))));
		assertEquals("There is no CEO right now", MentionCheck.check("@ceo hi", crew()));
	}

	@Test
	void optionNumbersAreCheckedAgainstTheFrontQuestion() {
		cardFor("ada", q(false, "Oak", "Spruce", "Birch"));
		assertNull(MentionCheck.check("@ada 2", crew()));
		assertNull(MentionCheck.check("@ada oak", crew()));
		assertEquals("Q1 has options 1-3; 7 is not one of them", MentionCheck.check("@ada 7", crew()));
		assertEquals("Q1 has options 1-3; 0, 9 is not one of them", MentionCheck.check("@ada 9, 0", crew()));
		assertEquals("Q1 takes one answer: pick a single number (1-3)", MentionCheck.check("@ada 1,2", crew()));
		cardFor("bram", q(true, "Wheat", "Carrots"));
		assertNull(MentionCheck.check("@bram 1, 2", crew()));
		assertEquals("Q1 has options 1-2; 3 is not one of them", MentionCheck.check("@bram 1,3", crew()));
		assertNull(MentionCheck.check("@ada @bram 7", crew()), "several recipients never answer a card");
		assertNull(MentionCheck.check("7", crew()), "a broadcast never answers a card");
	}

	@Test
	void anEmptyCrewLeavesEverythingToNode() {
		state.reset();
		assertNull(MentionCheck.check("@zed hi", crew()));
	}
}
