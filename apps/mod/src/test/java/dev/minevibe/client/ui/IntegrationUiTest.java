package dev.minevibe.client.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.chat.ChatCompletions;
import dev.minevibe.client.chat.MentionCheck;
import dev.minevibe.client.ui.input.UiKeys;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * UI pieces of the integration track (I2): {@code @meeting end} gets past the chat pre-check and is offered as a
 * completion while a meeting runs, and the G key takes over vanilla's Quick Actions only once, only from its default.
 */
class IntegrationUiTest {
	private static UiState crew() {
		UiState state = UiState.create(() -> 0);
		state.applyCrew(new Bodies.CrewState(List.of(
			new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
			new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"))));
		return state;
	}

	@Test
	void meetingEndPassesTheChatPreCheck() {
		UiState state = crew();
		assertEquals(null, MentionCheck.check("@meeting end", state.agents()), "@meeting end goes to Node (ChatRouter ends the meeting)");
		assertEquals(null, MentionCheck.check("@meeting where are we?", state.agents()));
		assertEquals(null, MentionCheck.check("@meeting end", List.of()), "also with no crew yet");
		assertTrue(MentionCheck.check("@meeting @ada end", state.agents()) != null, "@meeting cannot be mixed with names");
	}

	@Test
	void meetingCompletionComesAndGoesWithTheMeeting() {
		UiState state = crew();
		List<String> idle = ChatCompletions.entriesFor(state.agents(), false);
		assertFalse(idle.contains("@meeting"));
		List<String> during = ChatCompletions.entriesFor(state.agents(), true);
		assertTrue(during.containsAll(List.of("@ada", "@bram", "@ceo", "@all", "@everyone", "@meeting")), during.toString());
	}

	@Test
	void quickActionsIsUnboundOnlyOnceAndOnlyFromItsDefault() {
		assertTrue(UiKeys.shouldUnbindQuickActions("key.keyboard.g", "key.keyboard.g", true, false), "both on G, untouched: unbind");
		assertFalse(UiKeys.shouldUnbindQuickActions("key.keyboard.g", "key.keyboard.g", true, true), "done before: the player re-bound it");
		assertFalse(UiKeys.shouldUnbindQuickActions("key.keyboard.g", "key.keyboard.g", false, false), "the player chose it: keep");
		assertFalse(UiKeys.shouldUnbindQuickActions("key.keyboard.k", "key.keyboard.g", true, false), "the card key moved: no conflict");
		assertFalse(UiKeys.shouldUnbindQuickActions("key.keyboard.unknown", "key.keyboard.unknown", true, false), "unbound keys never conflict");
	}
}
