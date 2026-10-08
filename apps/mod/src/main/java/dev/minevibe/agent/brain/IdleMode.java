package dev.minevibe.agent.brain;

import java.util.Locale;
import org.jspecify.annotations.Nullable;

/** What an agent does when nothing else wants control (priority 10; {@code agent.mode}, PLAN 7.3). */
public enum IdleMode {
	/** Stay within a few blocks of the player (default; how the CEO "listens"). */
	FOLLOW,
	/** Stand at the anchor and walk back to it when pushed away. */
	STAY,
	/** Keep the area around the anchor clear of hostiles. */
	GUARD,
	/** Stroll around the anchor. */
	WANDER;

	public String id() {
		return this.name().toLowerCase(Locale.ROOT);
	}

	public static @Nullable IdleMode byId(final @Nullable String id) {
		for (IdleMode m : values()) {
			if (m.id().equals(id)) {
				return m;
			}
		}
		return null;
	}
}
