package dev.minevibe;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MineVibeModTest {
	@Test
	void idUsesTheMineVibeNamespace() {
		assertEquals("minevibe:pc/linux-1", MineVibeMod.id("pc/linux-1").toString());
	}
}
