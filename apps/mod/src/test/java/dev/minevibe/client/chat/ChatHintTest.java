package dev.minevibe.client.chat;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** The inline hint belongs to the refused line, compared the way the chat box normalises it before sending. */
class ChatHintTest {
	@AfterEach
	void tearDown() {
		ChatHint.clear();
	}

	@Test
	void theHintStaysWhileTheBoxHoldsTheRefusedLineAsTyped() {
		// ChatScreen sends "@zed hello" (normalizeSpace) while the box still holds what was typed.
		ChatHint.show("@zed hello", "Nobody is called @zed. Crew: @ada");
		assertEquals("Nobody is called @zed. Crew: @ada", ChatHint.current("  @zed   hello "));
		assertEquals("Nobody is called @zed. Crew: @ada", ChatHint.current("@zed\thello"));
	}

	@Test
	void editingTheLineAwayClearsTheHint() {
		ChatHint.show("@zed hello", "Nobody is called @zed");
		assertNull(ChatHint.current("@ada hello"));
		assertNull(ChatHint.current("@zed hello"), "a cleared hint does not come back");
	}
}
