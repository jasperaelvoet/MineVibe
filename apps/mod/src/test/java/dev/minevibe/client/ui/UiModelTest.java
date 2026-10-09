package dev.minevibe.client.ui;

import static dev.minevibe.client.ui.UiTestCards.hire;
import static dev.minevibe.client.ui.UiTestCards.question;
import static dev.minevibe.client.ui.UiTestCards.single;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.chat.ChatCompletions;
import dev.minevibe.client.ui.hud.OffscreenArrows;
import java.util.List;
import net.minecraft.world.phys.Vec3;
import org.junit.jupiter.api.Test;

/** Head icons, bubbles over time, transcripts, barks, completions and the off-screen arrow math. */
class UiModelTest {
	private static UiState crew(String... members) {
		UiState state = UiState.create(() -> 0);
		state.applyCrew(new Bodies.CrewState(java.util.Arrays.stream(members)
				.map(m -> {
					String[] p = m.split(":");
					return new Messages.CrewMember(p[0], p[0], p[0].substring(0, 1).toUpperCase() + p[0].substring(1), "engineer",
							p.length > 2 && p[2].equals("ceo"), p.length > 1 ? p[1] : "alive");
				})
				.toList()));
		return state;
	}

	private static Ui.AgentBrain brain(String id, String model, String status) {
		return new Ui.AgentBrain(id, model, status, null, "listen", false, false);
	}

	@Test
	void headIconsFollowThePlanPriorities() {
		UiState state = crew("ada", "bram:dead");
		AgentView ada = state.agent("ada");
		assertEquals(HeadIcon.NONE, HeadIcon.of(ada, false, true));
		assertEquals(HeadIcon.SEATED, HeadIcon.of(ada, true, true));
		state.applyBrain(brain("ada", "opus", "thinking"));
		assertEquals(HeadIcon.THINKING, HeadIcon.of(ada, true, true));
		state.applyBrain(brain("ada", "opus", "queued"));
		assertEquals(HeadIcon.QUEUED, HeadIcon.of(ada, false, true));
		state.applyPending(new Ui.AgentPending("ada", List.of(hire("h", "ada", 1))));
		assertEquals(HeadIcon.ATTENTION, HeadIcon.of(ada, false, true));
		state.applyPending(new Ui.AgentPending("ada", List.of(hire("h", "ada", 1), question("q", "ada", 2, List.of(single("?", "a")), List.of()))));
		assertEquals(HeadIcon.QUESTION, HeadIcon.of(ada, false, true));
		assertEquals(HeadIcon.ASLEEP, HeadIcon.of(ada, false, false), "bridge offline");
		state.applyBrain(brain("ada", "haiku", "asleep"));
		assertEquals(HeadIcon.ASLEEP, HeadIcon.of(ada, false, true));
		assertEquals(HeadIcon.NONE, HeadIcon.of(state.agent("bram"), false, true), "dead agents show nothing");
		state.applyPending(new Ui.AgentPending("ada", List.of()));
		state.applyBrain(brain("ada", "haiku", "waiting_player"));
		assertEquals(HeadIcon.QUESTION, HeadIcon.of(ada, false, true));
		assertEquals("[H]", ada.modelSuffix());
		state.applyBrain(brain("ada", "opus", "idle"));
		assertEquals("[O]", ada.modelSuffix());
	}

	@Test
	void bubblesFadeInAndOutAndWithDistance() {
		Bubble b = new Bubble("ada", "hi", "speech", 1000, 4000);
		assertEquals(0f, b.alpha(999));
		assertTrue(b.alpha(1010) < 0.2f);
		assertEquals(1f, b.alpha(2500));
		assertTrue(b.alpha(4800) < 0.5f);
		assertEquals(0f, b.alpha(5000));
		assertFalse(b.alive(5000));
		assertEquals(1f, Bubble.distanceAlpha(10));
		assertEquals(0.5f, Bubble.distanceAlpha(24), 1e-6);
		assertEquals(0f, Bubble.distanceAlpha(32));
		assertFalse(new Bubble("ada", "x", "bark", 0, 1).addressedToPlayer());
	}

	@Test
	void transcriptPagesMergeBySequence() {
		Transcript t = new Transcript();
		assertTrue(t.moreOlder());
		assertFalse(t.historyLoaded());
		t.add(new Ui.ChatEntry(10, 1, "agent", "live", null, null));
		t.addPage(List.of(new Ui.ChatEntry(8, 1, "player", "a", null, null), new Ui.ChatEntry(9, 1, "agent", "b", null, null),
				new Ui.ChatEntry(10, 1, "agent", "live", null, null)), true);
		assertEquals(List.of(8L, 9L, 10L), t.entries().stream().map(Ui.ChatEntry::seq).toList());
		assertTrue(t.moreOlder());
		assertEquals(8L, t.oldestSeq());
		// A newer page does not decide what lies below the oldest entry.
		t.addPage(List.of(new Ui.ChatEntry(11, 1, "agent", "c", null, null)), false);
		assertTrue(t.moreOlder());
		t.addPage(List.of(), false);
		assertFalse(t.moreOlder());
		for (int i = 0; i < Transcript.MAX_ENTRIES + 5; i++) t.add(new Ui.ChatEntry(100 + i, 1, "agent", "x", null, null));
		assertEquals(Transcript.MAX_ENTRIES, t.size());
		assertTrue(t.moreOlder());
	}

	@Test
	void transcriptLinesCarryTheirSessionTag() {
		// Dual sessions (PLAN §6.1): one merged history, desk lines tagged with their PC.
		Ui.ChatEntry body = new Ui.ChatEntry(1, 1, "agent", "On my way.", null, null, "body", null);
		Ui.ChatEntry desk = new Ui.ChatEntry(2, 1, "agent", "Tests pass.", null, null, "desk", "linux-1");
		Ui.ChatEntry old = new Ui.ChatEntry(3, 1, "agent", "Hi.", null, null);
		Ui.ChatEntry noPc = new Ui.ChatEntry(4, 1, "activity", "bash", null, null, "desk", null);
		assertEquals("", body.sessionTag());
		assertEquals(" @linux-1", desk.sessionTag());
		assertEquals("linux-1", desk.deskPc());
		assertEquals("", old.sessionTag());
		assertEquals(" @PC", noPc.sessionTag());
		Transcript t = new Transcript();
		t.addPage(List.of(body, desk, old), false);
		assertEquals(List.of("", " @linux-1", ""), t.entries().stream().map(Ui.ChatEntry::sessionTag).toList());
	}

	@Test
	void barksComeFromTheTableOrAreHumanised() {
		assertEquals("Hmm, one sec…", Barks.text("thinking"));
		assertEquals("Found iron", Barks.text("found_iron"));
		assertEquals("…", Barks.text("_"));
		// The body's urgency-2 "stuck" events (Node says the bark key the event carries).
		assertEquals("I'm stuck in water — can you help or should I dig out?", Barks.text("stuck_in_water"));
		assertEquals("I'm stuck, I can't find a way there. Can you help?", Barks.text("stuck"));
	}

	@Test
	void barksNameTheActualPlayer() {
		assertEquals("BRB, asking Jordan.", Barks.text("brb", "Jordan"));
		assertEquals("BRB, asking the player.", Barks.text("brb", null));
		assertEquals("BRB, asking the player.", Barks.text("brb", " "));
		assertEquals("BRB, asking the player.", Barks.text("brb"));
		assertEquals("On it!", Barks.text("on_it", "Jordan"));
	}

	@Test
	void chatCompletionsListLivingHandlesTheCeoAliasAndBroadcastWords() {
		UiState state = crew("ada:alive:ceo", "bram", "cleo:dead");
		assertEquals(List.of("@ada", "@bram", "@ceo", "@all", "@everyone"), ChatCompletions.entriesFor(state.agents()));
		assertEquals(List.of("@all", "@everyone"), ChatCompletions.entriesFor(List.of()));
	}

	@Test
	void offscreenArrowAngles() {
		Vec3 eye = Vec3.ZERO;
		// Minecraft yaw 0 looks towards +Z; facing south, west (-X) is on the right.
		assertEquals(0, OffscreenArrows.relativeYaw(0, eye, new Vec3(0, 0, 10)), 1e-6);
		assertEquals(90, OffscreenArrows.relativeYaw(0, eye, new Vec3(-10, 0, 0)), 1e-6);
		assertEquals(-90, OffscreenArrows.relativeYaw(0, eye, new Vec3(10, 0, 0)), 1e-6);
		assertEquals(180, Math.abs(OffscreenArrows.relativeYaw(0, eye, new Vec3(0, 0, -10))), 1e-6);
		assertEquals(0, OffscreenArrows.relativeYaw(90, eye, new Vec3(-10, 0, 0)), 1e-6);
		assertEquals(45, OffscreenArrows.relativePitch(0, eye, new Vec3(0, 10, 10)), 1e-6);
		assertTrue(OffscreenArrows.onScreen(10, 5, 70, 16 / 9.0));
		assertFalse(OffscreenArrows.onScreen(80, 0, 70, 16 / 9.0));
		assertFalse(OffscreenArrows.onScreen(0, 50, 70, 16 / 9.0));
	}
}
