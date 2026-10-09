package dev.minevibe.client.ui;

import static dev.minevibe.client.ui.UiTestCards.parse;
import static dev.minevibe.client.ui.UiTestCards.plan;
import static dev.minevibe.client.ui.UiTestCards.presenting;
import static dev.minevibe.client.ui.UiTestCards.question;
import static dev.minevibe.client.ui.UiTestCards.single;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The client mirror of the UI pushes, fed with the shared protocol fixtures. */
class UiStateTest {
	private final AtomicLong clock = new AtomicLong(1_000_000);
	private UiState state;

	@BeforeEach
	void setUp() {
		state = UiState.create(clock::get);
		state.applyCrew(parse(Bodies.CREW_STATE, "bodies", "crew.state.json"));
	}

	@Test
	void crewStateKeepsOrderIdentityAndBodyUuids() {
		assertEquals(List.of("ada", "bram", "cleo"), state.agents().stream().map(AgentView::handle).toList());
		assertEquals(List.of("ada", "bram"), state.living().stream().map(AgentView::handle).toList());
		AgentView ada = state.agent("ada");
		assertNotNull(ada);
		assertTrue(ada.ceo());
		assertEquals("Ada (CEO)", ada.title());
		assertSame(ada, state.ceo());
		assertSame(ada, state.byUuid(AgentService.uuidFor("ada")));
		assertSame(state.agent("bram"), state.byHandle("BRAM"));
		assertEquals("dead", state.agent("cleo").status());
		assertFalse(state.agent("cleo").alive());
	}

	@Test
	void aNewCrewListReplacesTheOldOneAndDropsItsBubbles() {
		state.applySay(new Messages.AgentSay("bram", "hi", null, "speech", 5000));
		state.applyCrew(new Bodies.CrewState(List.of(new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"))));
		assertEquals(List.of("ada"), state.agents().stream().map(AgentView::agentId).toList());
		assertNull(state.bubble("bram"));
		assertNull(state.byUuid(AgentService.uuidFor("bram")));
	}

	@Test
	void transcriptsOfAgentsNoLongerInTheCrewAreDropped() {
		state.applyChat(new Ui.ChatAppend("bram", new Ui.ChatEntry(1, 1, "agent", "hi", null, null)));
		state.applyChat(new Ui.ChatAppend("cleo", new Ui.ChatEntry(1, 1, "agent", "bye", null, null)));
		// A later crew list (same world): dead members stay listed and keep their lines.
		state.applyCrew(parse(Bodies.CREW_STATE, "bodies", "crew.state.json"));
		assertEquals(1, state.transcript("cleo").size());
		// The next world's crew: the old transcripts go with it.
		state.applyCrew(new Bodies.CrewState(List.of(new Messages.CrewMember("dora", "dora", "Dora", "ceo", true, "alive"))));
		assertTrue(state.crewLog().isEmpty());
		assertEquals(0, state.transcript("bram").size());
	}

	@Test
	void brainAndCardsFromFixtures() {
		long before = state.revision();
		state.applyBrain(parse(Ui.AGENT_BRAIN, "ui", "agent.brain.json"));
		state.applyPending(parse(Ui.AGENT_PENDING, "ui", "agent.pending.json"));
		assertTrue(state.revision() > before);
		AgentView ada = state.agent("ada");
		assertEquals(3, ada.cards().size());
		// card-7 is a question (blocking) with Q1 answered; it is the front card and is being presented.
		assertEquals("card-7", ada.frontCard().id());
		assertEquals("Q2/2", FrontCards.progress(ada.frontCard()));
		assertTrue(ada.presenting());
		assertSame(ada, state.presenter());
		assertEquals(List.of(ada), state.withCards());
	}

	@Test
	void pushesForUnknownAgentsAreIgnored() {
		long before = state.revision();
		state.applyBrain(new Ui.AgentBrain("zed", "opus", "thinking", null, "listen", false, false));
		state.applyPending(new Ui.AgentPending("zed", List.of()));
		assertEquals(before, state.revision());
	}

	@Test
	void thePresenterIsTheOldestPresentedUnparkedCard() {
		state.applyPending(new Ui.AgentPending("ada", List.of(presenting(plan("p1", "ada", 50, "x")))));
		state.applyPending(new Ui.AgentPending("bram", List.of(presenting(question("q1", "bram", 10, List.of(single("?", "a")), List.of())))));
		assertEquals("bram", state.presenter().agentId());
		state.applyPending(new Ui.AgentPending("bram", List.of(UiTestCards.parked(presenting(question("q1", "bram", 10, List.of(single("?", "a")), List.of()))))));
		assertEquals("ada", state.presenter().agentId());
	}

	@Test
	void bubblesComeFromTextOrTheBarkTableAndExpire() {
		Bubble say = state.applySay(parse(Messages.AGENT_SAY, "ui", "agent.say.json"));
		assertNotNull(say);
		assertTrue(say.addressedToPlayer() || !"speech".equals(say.style()));
		assertSame(say, state.bubble(say.agentId()));
		Bubble bark = state.applySay(new Messages.AgentSay("bram", null, "reporting_for_duty", "bark", 2000));
		assertEquals("Reporting for duty!", bark.text());
		assertEquals(2, state.liveBubbles().size());
		clock.addAndGet(2000);
		assertNull(state.bubble("bram"));
		assertNull(state.applySay(new Messages.AgentSay("bram", null, null, "speech", 2000)));
	}

	@Test
	void barkBubblesUseTheLocalPlayersName() {
		String[] name = {null};
		UiState named = UiState.create(clock::get, () -> name[0]);
		assertEquals("BRB, asking the player.", named.applySay(new Messages.AgentSay("bram", null, "brb", "bark", 2000)).text());
		name[0] = "Jordan";
		assertEquals("BRB, asking Jordan.", named.applySay(new Messages.AgentSay("bram", null, "brb", "bark", 2000)).text());
	}

	@Test
	void transcriptsAndTheCrewLog() {
		state.applyChat(new Ui.ChatAppend("bram", new Ui.ChatEntry(0, 300, "agent", "later line", null, null)));
		state.applyChat(new Ui.ChatAppend("ada", new Ui.ChatEntry(4, 100, "player", "first", null, null)));
		state.applyHistory("ada", new Ui.ChatHistoryResult(List.of(new Ui.ChatEntry(3, 50, "agent", "older", null, null)), false));
		List<String> log = state.crewLog().stream().map(l -> l.agentId() + ":" + l.entry().text()).toList();
		assertEquals(List.of("ada:older", "ada:first", "bram:later line"), log);
		assertFalse(state.transcript("ada").moreOlder());
	}

	@Test
	void toastsAreCappedAndExpire() {
		for (int i = 0; i < 7; i++) state.addToast("t" + i, "info", null, 1000);
		assertEquals(UiState.MAX_TOASTS, state.toasts().size());
		assertEquals("t2", state.toasts().getFirst().text());
		clock.addAndGet(1000);
		assertTrue(state.toasts().isEmpty());
		state.addToast("default ttl", "warn", "ada", 0);
		assertEquals(ToastEntry.DEFAULT_TTL_MS, state.toasts().getFirst().ttlMs());
	}

	@Test
	void brainsSummaryAndClearing() {
		state.applyBrains(parse(Ui.BRAINS_STATE, "ui", "brains.state.json"));
		assertNotNull(state.brains());
		state.applySay(new Messages.AgentSay("ada", "hello", null, "speech", 5000));
		state.addToast("x", "info", null, 5000);
		state.clearTransient();
		assertTrue(state.liveBubbles().isEmpty());
		assertTrue(state.toasts().isEmpty());
		assertEquals(3, state.agents().size());
		state.reset();
		assertTrue(state.agents().isEmpty());
		assertNull(state.brains());
	}
}
