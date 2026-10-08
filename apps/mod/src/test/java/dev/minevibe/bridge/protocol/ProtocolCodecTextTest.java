package dev.minevibe.bridge.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

import org.junit.jupiter.api.Test;

/** Clipping and surrogate safety for strings that go on the wire (review finding MINOR 9). */
class ProtocolCodecTextTest {
	@Test
	void clipNeverSplitsASurrogatePair() {
		String s = "ab😀cd"; // "ab😀cd": the emoji is two UTF-16 units at 2..3
		assertEquals("ab", ProtocolCodec.clip(s, 3), "a pair across the cut is dropped whole");
		assertEquals("ab😀", ProtocolCodec.clip(s, 4));
		assertEquals("ab", ProtocolCodec.clip(s, 2));
		assertSame(s, ProtocolCodec.clip(s, 10));
		assertEquals("", ProtocolCodec.clip(s, 0));
	}

	@Test
	void wellFormedReplacesOnlyLoneSurrogates() {
		assertSame("plain", ProtocolCodec.wellFormed("plain"));
		String pair = "x😀y";
		assertSame(pair, ProtocolCodec.wellFormed(pair));
		assertEquals("x�y", ProtocolCodec.wellFormed("x\uD83Dy"));
		assertEquals("x�", ProtocolCodec.wellFormed("x\uD83D"));
		assertEquals("�x", ProtocolCodec.wellFormed("\uDE00x"));
		assertEquals("😀�", ProtocolCodec.wellFormed("😀\uDE00"));
	}

	@Test
	void encodeAndErrRepliesAreWellFormed() {
		String text = ProtocolCodec.encode(Messages.PLAYER_DIED, new Messages.PlayerDied("world-1", "boom \uD83D", null, 1, 0), "m-1", null);
		assertEquals(-1, text.indexOf('\uD83D'));
		String err = ProtocolCodec.encodeErr("n-1", "INTERNAL", "x".repeat(1999) + "😀");
		assertEquals(-1, err.indexOf('\uD83D'), "the pair at the 2000-unit cut is dropped, not split");
	}
}
