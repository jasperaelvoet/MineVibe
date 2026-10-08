package dev.minevibe.agent;

import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * Agent roles (PLAN 7.3). The role picks the skin ({@code assets/minevibe/textures/entity/agent/<id>.png})
 * and will later tune reflex weights and barks.
 */
public enum AgentRole {
	CEO,
	ENGINEER,
	MINER,
	FARMER,
	GUARD,
	BUILDER;

	/** Lower-case id used in commands, skins and the role profile property. */
	public String id() {
		return this.name().toLowerCase(Locale.ROOT);
	}

	public static @Nullable AgentRole byId(final @Nullable String id) {
		if (id == null) {
			return null;
		}
		for (AgentRole role : values()) {
			if (role.id().equalsIgnoreCase(id)) {
				return role;
			}
		}
		return null;
	}

	public String displayName() {
		return this == CEO ? "CEO" : this.name().charAt(0) + this.name().substring(1).toLowerCase(Locale.ROOT);
	}
}
