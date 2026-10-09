package dev.minevibe.hardcore;

import org.jspecify.annotations.Nullable;

/**
 * How the local player died in a world: what {@code player.died} carries and what the Game Over screen shows.
 *
 * @param worldId the save folder name (also the protocol WorldId)
 * @param cause the vanilla death message, e.g. "Jordan was shot by Skeleton"
 * @param killer the killer's entity type id, if an entity killed the player
 * @param day the game day of death (1-based)
 * @param ticksAlive ticks played in this world
 * @param diedAtEpochMs wall clock time of death
 */
public record DeathRecord(String worldId, String cause, @Nullable String killer, int day, long ticksAlive, long diedAtEpochMs) {}
