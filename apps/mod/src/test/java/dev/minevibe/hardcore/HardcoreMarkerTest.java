package dev.minevibe.hardcore;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Optional;
import net.minecraft.SharedConstants;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The dead marker's on-disk format, as BootScreen reads it without loading the world. */
class HardcoreMarkerTest {
	@BeforeAll
	static void version() {
		SharedConstants.tryDetectVersion();
	}

	@Test
	void livesWhereSavedDataStorageKeepsIt(@TempDir Path world) {
		assertEquals(world.resolve("data").resolve("minevibe").resolve("hardcore.dat"), HardcoreMarker.file(world));
	}

	@Test
	void aWorldWithoutAMarkerIsAlive(@TempDir Path world) throws IOException {
		assertEquals(Optional.empty(), HardcoreMarker.readFromWorldDir(world));
		HardcoreMarker.writeToWorldDir(world, new HardcoreMarker());
		assertEquals(Optional.empty(), HardcoreMarker.readFromWorldDir(world));
	}

	@Test
	void roundTripsTheDeath(@TempDir Path world) throws IOException {
		DeathRecord death = new DeathRecord("world-7", "Jordan was shot by Skeleton", "minecraft:skeleton", 5, 98765L, 1_760_000_000_000L);
		HardcoreMarker marker = new HardcoreMarker();
		marker.markDead(death);
		assertTrue(marker.isDirty());
		HardcoreMarker.writeToWorldDir(world, marker);
		assertEquals(Optional.of(death), HardcoreMarker.readFromWorldDir(world));
	}

	@Test
	void theFirstDeathWins() {
		HardcoreMarker marker = new HardcoreMarker();
		DeathRecord first = new DeathRecord("world-1", "fell", null, 1, 10, 1);
		marker.markDead(first);
		marker.markDead(new DeathRecord("world-1", "again", null, 2, 20, 2));
		assertEquals(Optional.of(first), marker.death());
	}
}
