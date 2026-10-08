package dev.minevibe.world.provenance;

import java.util.Locale;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Who put a block where it is: the human player (by UUID, with the name they had then), an agent (by agent id), or
 * the base itself (blocks the starter office was built from, by zone name). Natural blocks have no owner.
 *
 * <p>Stored per chunk as a short string ({@link #encode()}): {@code p|<uuid>|<name>}, {@code a|<agentId>|<name>} or
 * {@code b|<zone>|<zone>}.
 */
public record Owner(Kind kind, String id, String name) {
	public enum Kind {
		PLAYER('p'),
		AGENT('a'),
		BASE('b');

		final char tag;

		Kind(final char tag) {
			this.tag = tag;
		}
	}

	public static Owner player(final UUID uuid, final String name) {
		return new Owner(Kind.PLAYER, uuid.toString(), name);
	}

	public static Owner agent(final String agentId, final String name) {
		return new Owner(Kind.AGENT, agentId.toLowerCase(Locale.ROOT), name);
	}

	/** Blocks of a named zone's own building (the starter office: zone {@code Base}). */
	public static Owner base(final String zone) {
		return new Owner(Kind.BASE, zone, zone);
	}

	public boolean isAgent() {
		return this.kind == Kind.AGENT;
	}

	public boolean isPlayer() {
		return this.kind == Kind.PLAYER;
	}

	public boolean isBase() {
		return this.kind == Kind.BASE;
	}

	public String encode() {
		return this.kind.tag + "|" + clean(this.id) + "|" + clean(this.name);
	}

	/** The inverse of {@link #encode()}, or null for anything malformed (a hand-edited save, a future kind). */
	public static @Nullable Owner decode(final String s) {
		if (s.length() < 4 || s.charAt(1) != '|') {
			return null;
		}
		int bar = s.indexOf('|', 2);
		if (bar < 0) {
			return null;
		}
		String id = s.substring(2, bar);
		String name = s.substring(bar + 1);
		if (id.isEmpty() || name.isEmpty()) {
			return null;
		}
		return switch (s.charAt(0)) {
			case 'p' -> new Owner(Kind.PLAYER, id, name);
			case 'a' -> new Owner(Kind.AGENT, id, name);
			case 'b' -> new Owner(Kind.BASE, id, name);
			default -> null;
		};
	}

	private static String clean(final String s) {
		String c = s.replace('|', '_');
		return c.length() > 64 ? c.substring(0, 64) : c;
	}
}
