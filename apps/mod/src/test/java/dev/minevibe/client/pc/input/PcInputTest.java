package dev.minevibe.client.pc.input;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The SDL key table, the input translator (text vs keys, modifiers, chords) and the batcher (PLAN 7.7). */
class PcInputTest {
	private static String describe(final Pc.InputEvent e) {
		return switch (e.k()) {
			case "key" -> (e.down() ? "+" : "-") + e.key();
			case "text" -> "'" + e.text() + "'";
			case "move" -> "move " + e.x() + "," + e.y();
			case "button" -> (e.down() ? "+" : "-") + e.button() + "@" + e.x() + "," + e.y();
			case "scroll" -> "scroll " + e.dx() + "," + e.dy();
			default -> e.k();
		};
	}

	private static List<String> events(final PcInputBatcher batcher) {
		List<String> out = new ArrayList<>();
		for (Pc.PcInput batch : batcher.drain("linux-1")) {
			for (Pc.InputEvent e : batch.events()) {
				out.add(describe(e));
			}
		}
		return out;
	}

	@Test
	void specialKeysByScancode() {
		assertEquals("KEY_ENTER", SdlKeyMap.special(SdlKeyMap.SC_RETURN));
		assertEquals("KEY_ESCAPE", SdlKeyMap.special(SdlKeyMap.SC_ESCAPE));
		assertEquals("KEY_TAB", SdlKeyMap.special(SdlKeyMap.SC_TAB));
		assertEquals("KEY_BACKSPACE", SdlKeyMap.special(42));
		assertEquals("KEY_ARROW_UP", SdlKeyMap.special(82));
		assertEquals("KEY_ARROW_LEFT", SdlKeyMap.special(80));
		assertEquals("KEY_F1", SdlKeyMap.special(58));
		assertEquals("KEY_F12", SdlKeyMap.special(69));
		assertEquals("KEY_F13", SdlKeyMap.special(104));
		assertEquals("KEY_DELETE", SdlKeyMap.special(76));
		assertEquals("KEY_PAGE_DOWN", SdlKeyMap.special(78));
		assertNull(SdlKeyMap.special(4), "letters are not special");
		assertNull(SdlKeyMap.special(SdlKeyMap.SC_SPACE), "space is text");
	}

	@Test
	void chordKeysFollowTheLayoutNotThePosition() {
		// AZERTY: the key at QWERTY's Q position types 'a'; Ctrl+A must be the guest's Ctrl+A.
		assertEquals("KEY_A", SdlKeyMap.printable(20, 'a'));
		assertEquals("KEY_Q", SdlKeyMap.printable(20, 'q'));
		assertEquals("KEY_DIGIT_7", SdlKeyMap.printable(36, '7'));
		assertEquals("KEY_SLASH", SdlKeyMap.printable(56, '/'));
		// A layout symbol with no US key falls back to the physical position.
		assertEquals("KEY_DIGIT_2", SdlKeyMap.printable(31, 0xE9));
		assertEquals("KEY_NUMPAD_5", SdlKeyMap.printable(93, 0x40000000 | 93));
	}

	@Test
	void cmdIsCtrlOnLinuxAndMetaOnMac() {
		assertEquals("KEY_CONTROL", SdlKeyMap.modifier(SdlKeyMap.SC_LGUI, false));
		assertEquals("KEY_META", SdlKeyMap.modifier(SdlKeyMap.SC_LGUI, true));
		assertEquals("KEY_CONTROL", SdlKeyMap.modifier(SdlKeyMap.SC_RCTRL, true));
		assertEquals("KEY_SHIFT", SdlKeyMap.modifier(SdlKeyMap.SC_RSHIFT, false));
		assertNull(SdlKeyMap.modifier(4, false));
	}

	@Test
	void textTravelsAsTextAndSpecialKeysAsKeys() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator in = new PcInputTranslator(batcher, false);
		assertFalse(in.keyPressed(4, 'a', 0, false), "a letter waits for its text");
		in.charTyped('a', 0);
		in.keyReleased(4, 0);
		in.charTyped(0xE9, 0);
		assertTrue(in.keyPressed(SdlKeyMap.SC_TAB, '\t', 0, false));
		assertTrue(in.keyPressed(SdlKeyMap.SC_TAB, '\t', 0, true), "a repeat is swallowed");
		in.keyReleased(SdlKeyMap.SC_TAB, 0);
		in.charTyped('\r', 0);
		assertEquals(List.of("'aé'", "+KEY_TAB", "-KEY_TAB"), events(batcher));
	}

	@Test
	void aMacGuestGetsEveryRepeatOfAHeldKey() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator mac = new PcInputTranslator(batcher, true);
		assertTrue(mac.keyPressed(SdlKeyMap.SC_BACKSPACE, '\b', 0, false));
		assertTrue(mac.keyPressed(SdlKeyMap.SC_BACKSPACE, '\b', 0, false));
		assertTrue(mac.keyPressed(SdlKeyMap.SC_BACKSPACE, '\b', 0, false));
		mac.keyReleased(SdlKeyMap.SC_BACKSPACE, 0);
		assertEquals(List.of("+KEY_BACKSPACE", "+KEY_BACKSPACE", "+KEY_BACKSPACE", "-KEY_BACKSPACE"), events(batcher));
	}

	@Test
	void ctrlAndCmdChordsAreKeysWithTheirModifier() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator in = new PcInputTranslator(batcher, false);
		int cmd = SdlKeyMap.MOD_GUI & 0x0400;
		assertTrue(in.keyPressed(SdlKeyMap.SC_LGUI, 0x400000E3, cmd, false));
		assertTrue(in.keyPressed(6, 'c', cmd, false));
		in.charTyped('c', cmd);
		in.keyReleased(6, cmd);
		in.keyReleased(SdlKeyMap.SC_LGUI, cmd);
		assertEquals(List.of("+KEY_CONTROL", "+KEY_C", "-KEY_C", "-KEY_CONTROL"), events(batcher), "Cmd+C is Ctrl+C on Linux");

		PcInputTranslator mac = new PcInputTranslator(batcher, true);
		mac.keyPressed(6, 'c', cmd, false);
		mac.keyReleased(6, cmd);
		mac.keyReleased(SdlKeyMap.SC_LGUI, 0);
		assertEquals(List.of("+KEY_META", "+KEY_C", "-KEY_C", "-KEY_META"), events(batcher), "Cmd+C stays Cmd+C on macOS");
	}

	@Test
	void shiftIsSyncedForKeysAndButtonsButReleasedBeforeText() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator in = new PcInputTranslator(batcher, false);
		int shift = 0x0001;
		in.keyPressed(SdlKeyMap.SC_LSHIFT, 0x400000E1, shift, false);
		in.keyPressed(79, 0x4000004F, shift, false);
		in.keyReleased(79, shift);
		in.charTyped('A', shift);
		in.mouseButton("left", true, 10, 20, shift);
		in.mouseButton("left", false, 10, 20, shift);
		in.keyReleased(SdlKeyMap.SC_LSHIFT, shift);
		assertEquals(
			List.of("+KEY_SHIFT", "+KEY_ARROW_RIGHT", "-KEY_ARROW_RIGHT", "-KEY_SHIFT", "'A'", "+KEY_SHIFT", "+left@10,20", "-left@10,20", "-KEY_SHIFT"),
			events(batcher)
		);
	}

	@Test
	void releaseAllForgetsHeldState() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator in = new PcInputTranslator(batcher, false);
		in.keyPressed(SdlKeyMap.SC_RETURN, '\r', 0, false);
		in.mouseButton("right", true, 1, 1, 0);
		assertTrue(in.anythingDown());
		in.releaseAll();
		assertFalse(in.anythingDown());
		in.keyReleased(SdlKeyMap.SC_RETURN, 0);
		in.mouseButton("right", false, 1, 1, 0);
		assertEquals(List.of("+KEY_ENTER", "+right@1,1", "release_all"), events(batcher), "nothing is released twice");
	}

	@Test
	void batcherCoalescesMovesAndTextAndSplitsBigBatches() {
		PcInputBatcher batcher = new PcInputBatcher();
		batcher.add(Pc.InputEvent.move(1, 1));
		batcher.add(Pc.InputEvent.move(2, 2));
		batcher.add(Pc.InputEvent.text("ab"));
		batcher.add(Pc.InputEvent.text("c"));
		batcher.add(Pc.InputEvent.move(3, 3));
		List<Pc.PcInput> batches = batcher.drain("linux-1");
		assertEquals(1, batches.size());
		assertEquals(List.of("move 2,2", "'abc'", "move 3,3"), batches.getFirst().events().stream().map(PcInputTest::describe).toList());
		assertEquals(1, batches.getFirst().seq());

		for (int i = 0; i < 300; i++) {
			batcher.add(Pc.InputEvent.key("KEY_A", i % 2 == 0));
		}
		List<Pc.PcInput> split = batcher.drain("linux-1");
		assertEquals(2, split.size());
		assertEquals(PcInputBatcher.MAX_EVENTS, split.getFirst().events().size());
		assertEquals(2, split.get(0).seq());
		assertEquals(3, split.get(1).seq());
		assertTrue(batcher.isEmpty());
	}

	@Test
	void theSequenceIsPerPcAndSurvivesAReopenedScreen() {
		// Each PcControlScreen has its own batcher; reopening it (after the overlay, a stand-up) must not restart seq.
		PcInputBatcher first = PcInputBatcher.forPc("seq-test-a");
		first.add(Pc.InputEvent.releaseAll());
		long s1 = first.drain("seq-test-a").getFirst().seq();
		PcInputBatcher reopened = PcInputBatcher.forPc("seq-test-a");
		reopened.add(Pc.InputEvent.releaseAll());
		long s2 = reopened.drain("seq-test-a").getFirst().seq();
		assertEquals(s1 + 1, s2, "the reopened screen continues the PC's sequence");
		PcInputBatcher other = PcInputBatcher.forPc("seq-test-b");
		other.add(Pc.InputEvent.releaseAll());
		assertEquals(1, other.drain("seq-test-b").getFirst().seq(), "another PC has its own sequence");
	}

	@Test
	void batchesMatchTheWireSchema() {
		PcInputBatcher batcher = new PcInputBatcher();
		PcInputTranslator in = new PcInputTranslator(batcher, false);
		in.mouseMove(1279, 799);
		in.charTyped('x', 0);
		in.keyPressed(SdlKeyMap.SC_ESCAPE, 27, 0, false);
		in.keyReleased(SdlKeyMap.SC_ESCAPE, 0);
		in.scroll(0, -3, 5, 5);
		in.releaseAll();
		for (Pc.PcInput batch : batcher.drain("linux-1")) {
			String json = ProtocolCodec.encode(Pc.PC_INPUT, batch, null, null);
			assertTrue(json.contains("\"t\":\"pc.input\""), json);
		}
	}
}
