package dev.minevibe.client.org.codex;

import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Types;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * What CodexScreen lists (PLAN §6.6): the index filtered by a category tab and a title filter, pinned pages first,
 * then the most recently updated. Full-text search goes to Node ({@code codex.search}); this is the instant part.
 */
public final class CodexBrowser {
	public static final String ALL = "all";
	public static final String PINNED = "pinned";

	/** The tabs, in order: everything, pinned, then every category. */
	public static final List<String> TABS;

	static {
		List<String> tabs = new ArrayList<>();
		tabs.add(ALL);
		tabs.add(PINNED);
		tabs.addAll(Org.CODEX_CATEGORIES);
		TABS = List.copyOf(tabs);
	}

	public static final Comparator<Org.CodexPageMeta> ORDER = Comparator
		.comparing((Org.CodexPageMeta p) -> !p.pinned())
		.thenComparing(Comparator.comparingLong(Org.CodexPageMeta::updated).reversed())
		.thenComparing(p -> p.title().toLowerCase(Locale.ROOT));

	private CodexBrowser() {
	}

	/** The pages of {@code tab} whose title or tags contain every word of {@code text}, in {@link #ORDER}. */
	public static List<Org.CodexPageMeta> filter(final List<Org.CodexPageMeta> pages, final String tab, final String text) {
		String[] words = text.toLowerCase(Locale.ROOT).trim().split("\\s+");
		List<Org.CodexPageMeta> out = new ArrayList<>();
		for (Org.CodexPageMeta page : pages) {
			if (inTab(page, tab) && matches(page, words)) {
				out.add(page);
			}
		}
		out.sort(ORDER);
		return out;
	}

	public static boolean inTab(final Org.CodexPageMeta page, final String tab) {
		return switch (tab) {
			case ALL -> true;
			case PINNED -> page.pinned();
			default -> tab.equals(page.category());
		};
	}

	private static boolean matches(final Org.CodexPageMeta page, final String[] words) {
		String haystack = (page.title() + " " + String.join(" ", page.tags())).toLowerCase(Locale.ROOT);
		for (String word : words) {
			if (!word.isEmpty() && !haystack.contains(word)) {
				return false;
			}
		}
		return true;
	}

	/** {@code rules} pages bind the crew only when the player wrote them (principle 6). */
	public static boolean isBindingRule(final String category, final Types.Author author) {
		return "rules".equals(category) && "player".equals(author.kind());
	}

	/** How an author reads in the Codex: "You", the agent's name, or "MineVibe". */
	public static String authorLabel(final Types.Author author) {
		return switch (author.kind()) {
			case "player" -> "You";
			case "system" -> "MineVibe";
			default -> author.name();
		};
	}

	/** The tab label: "All", "Pinned", "Places", ... */
	public static String tabLabel(final String tab) {
		return tab.isEmpty() ? tab : Character.toUpperCase(tab.charAt(0)) + tab.substring(1);
	}

	/** Parses the tags field ("iron, cave  mining") into valid tags, dropping what the schema would reject. */
	public static List<String> parseTags(final String text) {
		List<String> tags = new ArrayList<>();
		for (String raw : text.toLowerCase(Locale.ROOT).split("[,\\s]+")) {
			String tag = raw.replaceAll("[^a-z0-9-]", "");
			while (tag.startsWith("-")) {
				tag = tag.substring(1);
			}
			if (!tag.isEmpty() && tag.length() <= 32 && !tags.contains(tag) && tags.size() < 16) {
				tags.add(tag);
			}
		}
		return tags;
	}
}
